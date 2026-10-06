import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordInjection } from '../src/inject.mjs';
import { recordClarificationResponses } from '../src/clarifications.mjs';
import { expectedPreparationContextPaths } from '../src/recovery-preparation-context.mjs';
import { run } from '../src/util.mjs';

async function fixture(t, phaseId = 'custom-specification') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-recovery-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  const phase = { id: phaseId, generation: 0, clarification: { mode: 'required', maxQuestions: 5 } };
  const config = { workItemRoot: 'governed/items', agents: { architect: {} } };
  const workflow = { workItem: { id: 'CTX-1' }, resolution: {
    agents: config.agents, phases: [{ id: phaseId, clarification: phase.clarification }]
  } };
  const itemRoot = `${config.workItemRoot}/${workflow.workItem.id}`;
  const recorded = await recordInjection(root, workflow, phase, {
    agent: 'architect', sections: [], renderedText: '# Governed phase prompt\n',
    groundingAvailability: { status: 'unavailable', reasonCode: 'WORLD_MODEL_UNAVAILABLE' },
    sourceComparison: { status: 'unavailable', reasonCode: 'WORLD_MODEL_UNAVAILABLE' }
  }, { workDir: path.join(root, itemRoot) });
  const clarification = await recordClarificationResponses(root, config, workflow, phase, {
    responses: [{ id: 'scope', question: 'What is in scope?', answer: 'The approved scope.' }],
    actor: { name: 'Human Reviewer' }, agent: 'architect'
  });
  const changedPaths = [recorded.file, recorded.promptFile, clarification.path];
  const options = { itemRoot, generation: 1, changedPaths };
  const inspect = overrides => expectedPreparationContextPaths(root, config, workflow, phase, {
    ...options, ...overrides
  });
  return { root, phase, config, workflow, itemRoot, recorded, clarification, changedPaths, inspect };
}

test('recovery recognizes validated generated context for built-in and custom phases and roots', async t => {
  for (const id of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-signoff']) {
    await t.test(id, async t => {
      const value = await fixture(t, id);
      const before = await Promise.all(value.changedPaths.map(relative => readFile(path.join(value.root, relative))));
      assert.deepEqual(await value.inspect(), value.changedPaths);
      assert.deepEqual(await Promise.all(value.changedPaths.map(relative => readFile(path.join(value.root, relative)))), before);
    });
  }
});

test('recovery never admits wrong Story, phase, generation, agent, schema, or snapshot identity', async t => {
  for (const [label, mutate] of [
    ['Story', record => { record.workId = 'OTHER'; }],
    ['phase', record => { record.phase = 'other-phase'; }],
    ['generation', record => { record.generation = 2; }],
    ['agent', record => { record.agent = 'unknown'; }],
    ['schema', record => { record.schemaVersion = 999; }],
    ['snapshot path', record => { record.promptPath = 'outside.md'; }],
    ['snapshot digest', record => { record.renderedSha256 = '0'.repeat(64); }]
  ]) await t.test(label, async t => {
    const value = await fixture(t);
    const record = structuredClone(value.recorded.record);
    mutate(record);
    await writeFile(path.join(value.root, value.recorded.file), JSON.stringify(record));
    assert.deepEqual(await value.inspect(), []);
  });
});

test('recovery leaves a tampered or incomplete prompt pair manual', async t => {
  const value = await fixture(t);
  await writeFile(path.join(value.root, value.recorded.promptFile), '# Tampered prompt\n');
  assert.deepEqual(await value.inspect(), []);
  await unlink(path.join(value.root, value.recorded.promptFile));
  assert.deepEqual(await value.inspect(), []);
  await writeFile(path.join(value.root, value.recorded.promptFile), value.recorded.text);
  await writeFile(path.join(value.root, value.recorded.file), '{invalid JSON');
  assert.deepEqual(await value.inspect(), []);
});

test('invalid clarification does not acquire authority from a valid composed prompt', async t => {
  for (const [label, mutate] of [
    ['Story', record => { record.workId = 'OTHER'; }],
    ['phase', record => { record.phase = 'other-phase'; }],
    ['generation', record => { record.generation = 2; }],
    ['mode', record => { record.mode = 'off'; }],
    ['actor', record => { record.recordedBy = null; }],
    ['agent', record => { record.agent = 'other-agent'; }],
    ['grounding hash', record => { record.groundingRecordSha256 = '0'.repeat(64); }],
    ['prompt hash', record => { record.promptSha256 = '0'.repeat(64); }],
    ['prompt path', record => { record.promptPath = 'outside.md'; }],
    ['completion', record => { record.completed = false; }]
  ]) await t.test(label, async t => {
    const value = await fixture(t);
    const record = structuredClone(value.clarification.record);
    mutate(record);
    await writeFile(path.join(value.root, value.clarification.path), JSON.stringify(record));
    assert.deepEqual(await value.inspect(), [value.recorded.file, value.recorded.promptFile]);
  });
});

test('recovery never sweeps in older generations, another Story, or arbitrary context files', async t => {
  const value = await fixture(t);
  assert.deepEqual(await value.inspect({ generation: 2 }), []);
  assert.deepEqual(await value.inspect({ changedPaths: [
    `${value.itemRoot}/context/custom-specification-gen0.json`,
    'governed/items/OTHER/context/custom-specification-gen1.json',
    `${value.itemRoot}/context/notes.json`
  ] }), []);
});

test('recovery refuses linked or oversized generated records without discarding them', async t => {
  const value = await fixture(t);
  const target = path.join(value.root, value.recorded.file);
  const original = await readFile(target);
  const linkTarget = path.join(value.root, 'linked-record.json');
  await writeFile(linkTarget, original);
  await unlink(target);
  try { await symlink(linkTarget, target); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows host does not permit symlink fixtures'); return;
    }
    throw error;
  }
  assert.deepEqual(await value.inspect(), []);
  assert.deepEqual(await readFile(target), original);
  await unlink(target);
  await writeFile(target, Buffer.alloc(32 * 1024 * 1024 + 1));
  assert.deepEqual(await value.inspect(), []);
});

test('recovery refuses preparation context under a linked parent directory', async t => {
  const value = await fixture(t);
  const context = path.join(value.root, value.itemRoot, 'context');
  const relocated = path.join(value.root, 'relocated-context');
  await rename(context, relocated);
  try { await symlink(relocated, context, 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows host does not permit symlink fixtures'); return;
    }
    throw error;
  }
  assert.deepEqual(await value.inspect(), []);
  assert.equal(await readFile(path.join(relocated, 'prompts', `${value.phase.id}-gen1.md`), 'utf8'),
    value.recorded.text);
});
