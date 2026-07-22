import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  globToRegExp,
  injectPersonaPrompt,
  recordInjection,
  renderInjection,
  resolveInjection,
  ruleMatches,
  validateInjectionDefinition
} from '../src/inject.mjs';
import { readJson } from '../src/util.mjs';

async function fixtureRoot({ placeholder = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-inject-'));
  await mkdir(path.join(root, '.singularity/world-model/architecture'), { recursive: true });
  await mkdir(path.join(root, '.singularity/world-model/domains'), { recursive: true });
  await mkdir(path.join(root, '.singularity/world-model/evidence'), { recursive: true });
  await mkdir(path.join(root, '.singularity/personas'), { recursive: true });
  await writeFile(path.join(root, '.singularity/world-model/architecture/overview.md'), '# Architecture\n\nHexagonal, event-driven.\n');
  await writeFile(path.join(root, '.singularity/world-model/domains/payments.md'), '# Payments domain\n\nPCI boundaries live here.\n');
  await writeFile(path.join(root, '.singularity/world-model/evidence/evidence.jsonl'), `${JSON.stringify({ id: 'E-1', claim: 'Observed architecture' })}\n`);
  await writeFile(path.join(root, '.singularity/world-model/manifest.json'), JSON.stringify({ schema_version: '1.0', repository_commit: 'a'.repeat(40), evidence: { path: 'evidence/evidence.jsonl' } }));
  await writeFile(path.join(root, '.singularity/personas/architect.md'), placeholder ? '# Architect\n\nDesign carefully.\n\n{{WORLD_MODEL}}\n' : '# Architect\n\nDesign carefully.\n');
  return root;
}

function definition(rules, mode = 'append') {
  return {
    personaPromptsRoot: '.singularity/personas',
    personas: { architect: { label: 'Architect', prompt: 'architect.md' } },
    phases: { design: {} },
    workTypes: { feature: {} },
    worldModel: { outputDir: '.singularity/world-model', injection: { mode, maxBytes: 32768, rules } }
  };
}

test('globToRegExp supports * and ** semantics', () => {
  assert.ok(globToRegExp('architecture/*').test('architecture/overview.md'));
  assert.ok(!globToRegExp('architecture/*').test('architecture/deep/file.md'));
  assert.ok(globToRegExp('src/api/**').test('src/api/v2/routes.mjs'));
  assert.ok(globToRegExp('**/payments.md').test('domains/payments.md'));
  assert.ok(!globToRegExp('domains/*.md').test('domains/payments.txt'));
});

test('ruleMatches evaluates persona, phase, workType, changedPaths, and labels', () => {
  const signals = { persona: 'architect', phase: 'design', workType: 'feature', changedPaths: ['src/api/routes.mjs'], labels: ['Payments'] };
  assert.ok(ruleMatches({ persona: 'architect' }, signals));
  assert.ok(!ruleMatches({ persona: 'developer' }, signals));
  assert.ok(ruleMatches({ phase: ['design', 'implementation'] }, signals));
  assert.ok(ruleMatches({ changedPaths: 'src/api/**' }, signals));
  assert.ok(!ruleMatches({ changedPaths: 'src/ui/**' }, signals));
  assert.ok(ruleMatches({ labels: ['payments'] }, signals));
  assert.ok(ruleMatches({}, signals));
});

test('resolveInjection unions includes across matched rules', () => {
  const config = definition([
    { when: { persona: 'architect' }, include: ['architecture/*'] },
    { when: { labels: ['payments'] }, include: ['domains/payments.md'], evidence: true, depth: 'deep' },
    { when: { persona: 'developer' }, include: ['development/*'] }
  ]);
  const resolved = resolveInjection(config, { persona: 'architect', labels: ['payments'] });
  assert.equal(resolved.matchedRules, 2);
  assert.deepEqual(resolved.includes.sort(), ['architecture/*', 'domains/payments.md']);
  assert.equal(resolved.evidence, true);
  assert.equal(resolved.depth, 'deep');
});

test('injection configuration validates references and safe includes', () => {
  const config = definition([{ when: { persona: 'architect', phase: 'design', workType: 'feature' }, include: ['domains/*.md'] }]);
  assert.equal(validateInjectionDefinition(config).rules.length, 1);
  config.worldModel.injection.rules[0].when.phase = 'missing';
  assert.throws(() => validateInjectionDefinition(config), /unknown phase 'missing'/);
  config.worldModel.injection.rules[0].when.phase = 'design';
  config.worldModel.injection.rules[0].include = ['../secret.md'];
  assert.throws(() => validateInjectionDefinition(config), /stay inside the world-model directory/);
});

test('renderInjection assembles matching model files with hashes and header', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: { persona: 'architect' }, include: ['architecture/*', 'domains/payments.md'] }]);
  const rendered = await renderInjection(root, config, { persona: 'architect' });
  assert.equal(rendered.sections.length, 2);
  assert.match(rendered.text, /Hexagonal/);
  assert.match(rendered.text, /PCI boundaries/);
  assert.match(rendered.text, /commit=aaaaaaaaaa/);
  assert.ok(rendered.sections.every((section) => /^[0-9a-f]{64}$/.test(section.sha256)));
});

test('renderInjection enforces the UTF-8 source-byte budget with truncation', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: {}, include: ['**/*.md'] }]);
  config.worldModel.injection.maxBytes = 40;
  const rendered = await renderInjection(root, config, { persona: 'architect' });
  assert.ok(rendered.sections.some((section) => section.truncated));
  assert.equal(rendered.sections.reduce((sum, section) => sum + section.injectedBytes, 0), 40);
  assert.match(rendered.text, /truncated by injection budget/);
});

test('injectPersonaPrompt replaces the placeholder', async () => {
  const root = await fixtureRoot();
  const config = definition([{ when: { persona: 'architect' }, include: ['architecture/*'] }], 'replace');
  const { text, injection } = await injectPersonaPrompt(root, config, 'architect', {});
  assert.ok(injection.applied);
  assert.match(text, /Design carefully/);
  assert.match(text, /Hexagonal/);
  assert.ok(!text.includes('{{WORLD_MODEL}}'));
});

test('injectPersonaPrompt appends without a placeholder and respects off mode', async () => {
  const root = await fixtureRoot({ placeholder: false });
  const appended = await injectPersonaPrompt(root, definition([{ when: {}, include: ['architecture/*'] }], 'append'), 'architect', {});
  assert.match(appended.text, /Design carefully[\s\S]*Hexagonal/);
  const off = await injectPersonaPrompt(root, definition([{ when: {}, include: ['architecture/*'] }], 'off'), 'architect', {});
  assert.equal(off.text.includes('Hexagonal'), false);
});

test('non-matching signals leave the persona prompt untouched', async () => {
  const root = await fixtureRoot();
  const { text, injection } = await injectPersonaPrompt(root, definition([{ when: { persona: 'developer' }, include: ['architecture/*'] }]), 'architect', {});
  assert.equal(injection.sections.length, 0);
  assert.equal(injection.applied, false);
  assert.ok(!text.includes('{{WORLD_MODEL}}'));
});

test('evidence rules use the manifest evidence path', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'], evidence: true }]), { persona: 'architect' });
  assert.ok(rendered.sections.some((section) => section.path.endsWith('evidence/evidence.jsonl')));
});

test('recordInjection writes an auditable generation context record', async () => {
  const root = await fixtureRoot();
  const rendered = await renderInjection(root, definition([{ when: {}, include: ['architecture/*'] }]), { persona: 'architect' });
  const workflow = { workItem: { id: 'ENG-9' } };
  const phase = { id: 'design', generation: 1 };
  const workDir = path.join(root, '.singularity/work-items/ENG-9');
  const { record, file } = await recordInjection(root, workflow, phase, { ...rendered, persona: 'architect' }, { workDir });
  assert.equal(record.generation, 2);
  assert.equal(file, '.singularity/work-items/ENG-9/context/design-gen2.json');
  const written = await readJson(path.join(root, file));
  assert.equal(written.workId, 'ENG-9');
  assert.equal(written.files.length, 1);
  assert.match(written.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(written.modelCommit, 'a'.repeat(40));
});
