import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { scopedCatalogRead } from '../src/catalog-read-scope.mjs';
import { discoverAgents, validateAgentCatalog } from '../src/agents.mjs';
import { withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { instructionText, loadInstructionLibrary, readInstruction } from '../src/instruction-library.mjs';
import { librarySkillText, loadSkillLibrary } from '../src/skill-library.mjs';
import { withFreshReadScope, withReadScope, withoutReadScope } from '../src/read-scope.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-catalog-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skill = path.join(root, 'singularity/skill-library/custom/SKILL.md');
  const instruction = path.join(root, 'singularity/instruction-library/standards/INSTRUCTIONS.md');
  await mkdir(path.dirname(skill), { recursive: true });
  await mkdir(path.dirname(instruction), { recursive: true });
  await writeFile(skill, librarySkillText({ id: 'custom', description: 'Check scoped code.', instructions: 'Inspect the scoped code.' }));
  await writeFile(instruction, instructionText({ id: 'standards', description: 'Coding standards.', instructions: 'Use clear names.' }));
  return { root, skill, instruction };
}

test('parallel catalog readers share a scan but receive independent maps and frozen records', async () => {
  let scans = 0;
  const counters = {};
  const timer = { increment(name, amount) { counters[name] = (counters[name] ?? 0) + amount; } };
  await withCommandTiming(timer, () => withReadScope(async () => {
    const compute = async () => { scans++; await Promise.resolve(); return { items: new Map([['one', Object.freeze({ values: Object.freeze(['a']) })]]), problems: [] }; };
    const [first, second] = await Promise.all([scopedCatalogRead('test', compute), scopedCatalogRead('test', compute)]);
    first.items.delete('one'); first.problems.push('not shared');
    assert.equal(second.items.size, 1);
    assert.deepEqual(second.problems, []);
    assert.ok(Object.isFrozen(second.items.get('one')));
    assert.ok(Object.isFrozen(second.items.get('one').values));
    assert.equal(scans, 1);
  }));
  assert.deepEqual(counters, { 'catalog.reads': 2, 'catalog.scans': 1, 'catalog.cache-hits': 1 });
});

test('catalog retention has count/byte ceilings, and failed scans never become a cached empty result', async () => {
  await withReadScope(async () => {
    for (let index = 0; index < 32; index++) await scopedCatalogRead(`small-${index}`, () => ({ value: index }));
    let scans = 0;
    for (let index = 0; index < 2; index++) await scopedCatalogRead('over-count', () => ({ value: ++scans }));
    assert.equal(scans, 2);
  });
  await withReadScope(async () => {
    let scans = 0;
    const large = 'x'.repeat(8 * 1024 * 1024 + 1);
    for (let index = 0; index < 2; index++) await scopedCatalogRead('over-bytes', () => ({ text: large, scan: ++scans }));
    assert.equal(scans, 2);
    await assert.rejects(scopedCatalogRead('failure', () => { throw new Error('unreadable catalog'); }), /unreadable/u);
    assert.deepEqual(await scopedCatalogRead('failure', () => ({ restored: true })), { restored: true });
  });
});

test('real catalogs reuse only the current read snapshot; fresh scopes and writers see edits', async t => {
  const f = await fixture(t);
  await withReadScope(async () => {
    const first = await loadSkillLibrary(f.root);
    const instructions = await loadInstructionLibrary(f.root);
    first.skills.clear(); instructions.instructions.clear();
    assert.equal((await loadSkillLibrary(f.root)).skills.size, 1);
    assert.equal((await loadInstructionLibrary(f.root)).instructions.size, 1);
    await writeFile(f.skill, librarySkillText({ id: 'custom', description: 'New description.', instructions: 'Inspect changed code.' }));
    await writeFile(f.instruction, instructionText({ id: 'standards', description: 'New standards.', instructions: 'Use precise names.' }));
    assert.equal((await loadSkillLibrary(f.root)).skills.get('custom').description, 'Check scoped code.');
    assert.equal((await readInstruction(f.root, 'standards')).instructions, 'Use precise names.', 'direct security-sensitive reads are never catalog cached');
    assert.equal((await withoutReadScope(() => loadSkillLibrary(f.root))).skills.get('custom').description, 'New description.');
    assert.equal((await withFreshReadScope(() => loadInstructionLibrary(f.root))).instructions.get('standards').description, 'New standards.');
  });
  assert.equal((await loadSkillLibrary(f.root)).skills.get('custom').description, 'New description.');
});

test('agent snapshots preserve exact packaged provenance without trusting modified copies', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, '.github/agents');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'developer.agent.md');
  await copyFile(new URL('../templates/agents/developer.agent.md', import.meta.url), file);
  const definition = { phases: { implementation: {} }, worldModel: { views: ['development'] } };
  await withReadScope(async () => {
    const first = (await discoverAgents(f.root)).find(agent => agent.id === 'developer');
    const second = (await discoverAgents(f.root)).find(agent => agent.id === 'developer');
    assert.notEqual(first, second);
    assert.equal(second.scope, 'repository');
    assert.doesNotThrow(() => validateAgentCatalog([second], definition));
    first.phases.length = 0;
    assert.ok((await discoverAgents(f.root)).find(agent => agent.id === 'developer').phases.length);
  });
  await writeFile(file, '---\nname: developer\ndescription: Modified copy.\nmetadata:\n  sflow-phases: implement,implementation\n---\nChanged author.\n');
  const changed = (await discoverAgents(f.root)).find(agent => agent.id === 'developer');
  assert.throws(() => validateAgentCatalog([changed], definition), { code: 'AGENT_PHASE_UNKNOWN' });
});

test('one application root cannot reuse a catalog from a different approved configuration overlay', async t => {
  const first = await fixture(t); const second = await fixture(t);
  await writeFile(path.join(second.root, '.keep'), 'second');
  await mkdir(path.join(second.root, '.github/agents'), { recursive: true });
  await writeFile(path.join(second.root, '.github/agents/overlay.agent.md'), '---\nname: overlay\ndescription: Overlay author.\n---\nUse the overlay.\n');
  await withReadScope(async () => {
    const a = await withConfigurationReadRoot(first.root, first.root, null, () => discoverAgents(first.root));
    const b = await withConfigurationReadRoot(first.root, second.root, null, () => discoverAgents(first.root));
    assert.equal(a.some(agent => agent.id === 'overlay'), false);
    assert.equal(b.some(agent => agent.id === 'overlay'), true);
  });
});
