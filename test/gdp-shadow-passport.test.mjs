import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveOperation } from '../src/command-registry.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { projectLegacyGdpCompatibility } from '../src/delivery-modes/compatibility-projection.mjs';
import {
  buildShadowChangePassport, summarizeShadowComparisons
} from '../src/delivery-modes/shadow-passport.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  currentSchemaVersion, migrationRegistrySnapshot, readRecord
} from '../src/schema-migrations.mjs';
import { createWorkflow, workflowPath } from '../src/state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidateSha256 = `sha256:${'a'.repeat(64)}`;
const worldModelSha256 = `sha256:${'e'.repeat(64)}`;
const policySha256 = `sha256:${'1'.repeat(64)}`;
const bin = path.join(root, 'bin', 'singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

function shadowInput(fixture) {
  const record = structuredClone(fixture.record);
  record.candidate = { candidateSha256 };
  record.worldModelReference = { manifestSha256: worldModelSha256 };
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: fixture.sourceKind, record, recovery: fixture.recovery ?? null
  });
  return buildShadowChangePassport({ compatibility, sourcePolicySha256: policySha256 });
}

function selfHash(record, field) {
  const core = structuredClone(record);
  delete core[field];
  return `sha256:${recordSha256(core)}`;
}

test('GDP M2 shadow Passports reproduce the reviewed lifecycle corpus exactly', async () => {
  const legacy = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const goldens = await json('test/fixtures/gdp-shadow/passports.json');
  const diagnostics = [];
  for (const expected of goldens.cases) {
    const fixture = legacy.cases.find((entry) => entry.id === expected.id);
    const first = shadowInput(fixture);
    const second = shadowInput(structuredClone(fixture));
    diagnostics.push(first);
    assert.deepEqual(first, second, expected.id);
    assert.equal(first.status, expected.status, expected.id);
    assert.equal(first.records.proofSubject.proofSubjectSha256, expected.proofSubjectSha256, expected.id);
    assert.equal(first.records.passport.passportSha256, expected.passportSha256, expected.id);
    assert.equal(first.comparison.category, expected.comparisonCategory, expected.id);
    assert.equal(first.records.proofSubject.proofSubjectSha256,
      selfHash(first.records.proofSubject, 'proofSubjectSha256'), expected.id);
    assert.equal(first.records.passport.passportSha256,
      selfHash(first.records.passport, 'passportSha256'), expected.id);
    assert.equal(first.authority, 'none');
    assert.equal(first.guarantees.consumedByLifecycle, false);
    assert.equal(first.guarantees.noWrites, true);
    assert.equal(first.guarantees.noModel, true);
    assert.ok(Object.isFrozen(first));
  }
  assert.deepEqual(summarizeShadowComparisons(diagnostics), {
    schemaVersion: 1,
    kind: 'gdp-shadow-comparison-summary',
    total: goldens.cases.length,
    categories: { aligned: goldens.cases.length }
  });
});

test('GDP M2 hashes survive a process restart and checkout-directory change', async () => {
  const legacy = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const fixture = legacy.cases[0];
  const compatibilityUrl = new URL('../src/delivery-modes/compatibility-projection.mjs', import.meta.url).href;
  const shadowUrl = new URL('../src/delivery-modes/shadow-passport.mjs', import.meta.url).href;
  const script = `
    import { projectLegacyGdpCompatibility } from ${JSON.stringify(compatibilityUrl)};
    import { buildShadowChangePassport } from ${JSON.stringify(shadowUrl)};
    const fixture = ${JSON.stringify(fixture)};
    fixture.record.candidate = { candidateSha256: ${JSON.stringify(candidateSha256)} };
    fixture.record.worldModelReference = { manifestSha256: ${JSON.stringify(worldModelSha256)} };
    const compatibility = projectLegacyGdpCompatibility({ sourceKind: fixture.sourceKind, record: fixture.record });
    const diagnostic = buildShadowChangePassport({ compatibility, sourcePolicySha256: ${JSON.stringify(policySha256)} });
    process.stdout.write(JSON.stringify({ proof: diagnostic.records.proofSubject.proofSubjectSha256, passport: diagnostic.records.passport.passportSha256 }));
  `;
  const outputs = [root, path.dirname(root)].map((cwd) => spawnSync(
    process.execPath, ['--input-type=module', '--eval', script], { cwd, encoding: 'utf8' }
  ));
  for (const result of outputs) assert.equal(result.status, 0, result.stderr);
  assert.equal(outputs[0].stdout, outputs[1].stdout);
});

test('GDP M2 production schemas are closed and match emitted v1 records', async () => {
  const legacy = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const diagnostic = shadowInput(legacy.cases[0]);
  for (const [schemaFile, record] of [
    ['schemas/gdp-proof-subject.schema.json', diagnostic.records.proofSubject],
    ['schemas/gdp-change-passport.schema.json', diagnostic.records.passport]
  ]) {
    const schema = await json(schemaFile);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort(), schemaFile);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record[schema['x-sflow-selfHash']], selfHash(record, schema['x-sflow-selfHash']));
  }
});

test('GDP M2 registers exactly Proof Subject and Change Passport as immutable v1 families', () => {
  const registrations = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const family of ['proof-subject', 'change-passport']) {
    assert.equal(currentSchemaVersion(family), 1);
    assert.equal(registrations.get(family).immutable, true);
  }
  const diagnostic = buildShadowChangePassport({
    compatibility: projectLegacyGdpCompatibility({
      sourceKind: 'workflow-story',
      record: { workItem: { id: 'WRK-READ' }, status: 'in_progress', candidate: { candidateSha256 } }
    }),
    sourcePolicySha256: policySha256
  });
  assert.equal(readRecord('proof-subject', diagnostic.records.proofSubject).storedVersion, 1);
  assert.equal(readRecord('change-passport', diagnostic.records.passport).storedVersion, 1);
  assert.throws(() => readRecord('change-passport', {
    ...diagnostic.records.passport, schemaVersion: 2
  }), /above this build's readable range/);
});

test('GDP M2 makes unavailable Candidate and World Model explicit without blocking', async () => {
  const legacy = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: legacy.cases[0].sourceKind,
    record: { ...legacy.cases[0].record, localCheckout: '/Users/private/secret/repository' }
  });
  const diagnostic = buildShadowChangePassport({ compatibility, sourcePolicySha256: policySha256 });
  assert.equal(diagnostic.status, 'unavailable');
  assert.equal(diagnostic.records, null);
  assert.equal(diagnostic.worldModel.status, 'unavailable');
  assert.equal(diagnostic.guarantees.worldModelRequired, false);
  assert.ok(diagnostic.gaps.some((gap) => gap.code === 'GDP_CANDIDATE_UNAVAILABLE'));
  assert.ok(diagnostic.gaps.some((gap) => gap.code === 'GDP_WORLD_MODEL_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(diagnostic), /Users|private|secret|repository/);
});

test('GDP M2 is bounded and rejects malformed or oversized inputs', async () => {
  const legacy = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: legacy.cases[0].sourceKind,
    record: { ...legacy.cases[0].record, candidate: { candidateSha256 } }
  });
  assert.throws(() => buildShadowChangePassport({ compatibility, proofProfile: 'invented' }),
    /unsupported proof profile/);
  assert.throws(() => buildShadowChangePassport({
    compatibility,
    decisionRefs: Array.from({ length: 257 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`)
  }), /exceeds 256/);
  assert.throws(() => buildShadowChangePassport({ compatibility: {} }), /verified GDP M1/);
});

test('GDP M2 surface is explicit, read-only, model-free, and secondary in VS Code', async () => {
  const operation = resolveOperation({
    requestedCommand: 'change', positionals: ['change', 'show'], options: { shadow: true }
  });
  assert.equal(operation.id, 'change.show.shadow');
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
  const command = await readFile(path.join(root, 'src/commands/change.mjs'), 'utf8');
  assert.match(command, /GDP_SHADOW_FLAG_REQUIRED/);
  assert.doesNotMatch(command, /\b(?:commitAndPublish|transactStory|saveStoryDraft|writeFile|runModel)\b/u);
  for (const relative of [
    'src/state.mjs', 'src/governance.mjs', 'src/approval-authority.mjs',
    'src/publication-unit-of-work.mjs', 'src/story-lineage.mjs'
  ]) {
    assert.doesNotMatch(await readFile(path.join(root, relative), 'utf8'), /shadow-passport\.mjs/u, relative);
  }
  const diagnostics = await readFile(path.join(root, 'apps/vscode/src/views/diagnostics.ts'), 'utf8');
  assert.match(diagnostics, /\['passport', 'Shadow Passport'\]/);
  assert.match(diagnostics, /change', 'show', '--shadow', '--json/);
  assert.ok(diagnostics.indexOf("['schema', 'Schema Health']")
    < diagnostics.indexOf("['passport', 'Shadow Passport']"));
});

test('GDP M2 CLI renders a structured shadow Passport without changing the checkout', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m2-cli-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'GDP M2 Tester');
  git(repository, 'config', 'user.email', 'gdp-m2@example.test');
  await writeFile(path.join(repository, 'README.md'), '# GDP M2 CLI\n');
  await initializeDefinition(repository);
  git(repository, 'add', '-A');
  git(repository, 'commit', '-qm', 'initialize');
  git(repository, 'switch', '-qc', 'GDP-M2-CLI');
  const definition = await loadDefinition(repository);
  const workflow = await createWorkflow(repository, definition, {
    id: 'GDP-M2-CLI', title: 'Inspect a shadow Passport',
    source: {
      type: 'manual', key: 'GDP-M2-CLI', title: 'Inspect a shadow Passport',
      description: 'Verify the advanced read-only M2 surface without changing lifecycle state.',
      acceptanceCriteria: ['The command returns a deterministic shadow Passport.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'developer'
  });
  const file = workflowPath(repository, definition, workflow.workItem.id);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.candidate = { candidateSha256 };
  stored.worldModelReference = { manifestSha256: worldModelSha256 };
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  const before = git(repository, 'status', '--porcelain=v1');
  const result = spawnSync(process.execPath, [
    bin, '--no-model', 'change', 'show', 'GDP-M2-CLI', '--shadow', '--json'
  ], { cwd: repository, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'change.show.shadow');
  assert.equal(response.operation.classification, 'read');
  assert.equal(response.data.mode, 'shadow');
  assert.equal(response.data.authority, 'none');
  assert.equal(response.data.records.passport.status, 'candidate-ready');
  assert.deepEqual(response.effects, {
    stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false
  });
  assert.equal(git(repository, 'status', '--porcelain=v1'), before);

  const refused = spawnSync(process.execPath, [bin, 'change', 'show', 'GDP-M2-CLI'], {
    cwd: repository, encoding: 'utf8'
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Re-run with --shadow/);
  assert.equal(git(repository, 'status', '--porcelain=v1'), before);
});
