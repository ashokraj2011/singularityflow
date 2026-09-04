import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  buildOutcomeSelectionBundle, M5_RECORD_FAMILIES,
  recommendDelivery, validateDeliveryRecord, validateOutcomeSelectionBundle
} from '../src/delivery-modes/delivery-kernel.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot, readRecord
} from '../src/schema-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;

function request(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'delivery-request', workId: 'GDP-M5',
    outcome: {
      statement: 'Change the exported value',
      observablePredicate: 'The module exports value 2'
    },
    acceptanceClauses: [{
      clauseId: 'GDP-M5:AC-001', bodySha256: digest('a'), required: true,
      witnessPolicy: 'module-test'
    }],
    nonGoals: ['Do not change the public API'],
    predicted: {
      repositories: 1, touchedResources: 2, protectedPaths: false,
      externalEffects: false, credentialUse: false, architectureDecision: false,
      publicContractChange: false, databaseMigration: false
    },
    riskClass: 'medium', executionProvider: 'copilot', executionPace: 'assisted',
    autonomyCeiling: 'A2', proofProfile: 'standard', workflowProfile: 'feature',
    allowedEffects: ['repository-file-write'],
    forbiddenEffects: ['credential-read', 'external-network'],
    ...overrides
  };
}

function recommendation(input = request()) {
  return recommendDelivery({
    request: input, repositoryRevisionSha256: digest('b'), configurationSha256: digest('c')
  });
}

function selectionBundle(input = request(), plan = recommendation(input)) {
  return buildOutcomeSelectionBundle({
    request: input, recommendation: plan, proofPolicySha256: digest('d'),
    policySnapshotSha256: digest('c'), gapAcceptancePolicySha256: digest('e'),
    promotionPolicySha256: digest('f'),
    selectedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null }
  });
}

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP M5 Tester'
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('M5 recommends bounded Outcome mode and forces risky work into Workflow mode', () => {
  const first = recommendation();
  assert.equal(first.outcome, 'outcome-recommended');
  assert.equal(first.requiredMode, null);
  assert.deepEqual(first, recommendation());

  const riskyRequest = request({
    predicted: { ...request().predicted, repositories: 2, protectedPaths: true },
    riskClass: 'high'
  });
  const risky = recommendation(riskyRequest);
  assert.equal(risky.outcome, 'workflow-required');
  assert.equal(risky.requiredMode, 'workflow');
  assert.throws(() => selectionBundle(riskyRequest, risky), /requires 'workflow' mode/);
  assert.throws(() => recommendDelivery({
    request: request(), repositoryRevisionSha256: digest('b'),
    configurationSha256: digest('c'), allowedModes: []
  }), /At least one delivery mode/);
});

test('M5 selection bundle is closed, linked, deterministic, and rejects changed references', () => {
  const bundle = selectionBundle();
  assert.deepEqual(bundle, selectionBundle());
  assert.equal(validateOutcomeSelectionBundle(bundle).bundleSha256, bundle.bundleSha256);
  assert.equal(bundle.runtime.publication, 'existing-publication-uow');
  const changed = structuredClone(bundle);
  changed.completionContract.effectPolicySha256 = digest('0');
  const contractCore = structuredClone(changed.completionContract);
  delete contractCore.contractSha256;
  changed.completionContract.contractSha256 = `sha256:${recordSha256(contractCore)}`;
  const core = structuredClone(changed); delete core.bundleSha256;
  changed.bundleSha256 = `sha256:${recordSha256(core)}`;
  assert.throws(() => validateOutcomeSelectionBundle(changed), /references are inconsistent/);
});

test('all M5 families have closed schemas and immutable migration identities', async () => {
  const bundle = selectionBundle();
  const records = {
    'delivery-recommendation': bundle.recommendation,
    'delivery-selection': bundle.selection,
    'completion-contract': bundle.completionContract,
    'effect-policy': bundle.effectPolicy,
    'effect-policy-compilation': bundle.effectPolicyCompilation,
    'change-risk-assessment': bundle.riskAssessment,
    'autonomy-decision': bundle.autonomyDecision
  };
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const [family, record] of Object.entries(records)) {
    assert.equal(currentSchemaVersion(family), 1, family);
    assert.equal(registry.get(family).immutable, true, family);
    assert.deepEqual(validateDeliveryRecord(family, record), record, family);
    assert.equal(readRecord(family, record).storedVersion, 1, family);
    const schema = JSON.parse(await readFile(path.join(
      repositoryRoot, `schemas/gdp-${family}.schema.json`
    ), 'utf8'));
    assert.equal(schema.additionalProperties, false, family);
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort(), family);
  }
  assert.equal(Object.keys(M5_RECORD_FAMILIES).length, 7);
  assert.equal(familyForStoredPath(
    `singularity/work-items/GDP-M5/gdp/projections/delivery-recommendation/${'a'.repeat(64)}.json`
  )?.id, 'delivery-recommendation');
  assert.equal(familyForStoredPath(
    `singularity/work-items/GDP-M5/gdp/projections/effect-policy-compilation/${'b'.repeat(64)}.json`
  )?.id, 'effect-policy-compilation');
});

test('M5 uses exact plan confirmation and the existing Ad Hoc publication transaction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m5-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP M5 Tester');
  git(root, 'config', 'user.email', 'gdp-m5@example.com');
  sflow(root, 'init');
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  definition.spec.testCommands = {
    'gdp-m5-test': [process.execPath, '-e', "const fs=require('node:fs');if(!fs.readFileSync('app.mjs','utf8').includes('value = 2'))process.exit(1)"]
  };
  await writeFile(workflowPath, YAML.stringify(definition));
  await writeFile(path.join(root, '.gitignore'), '.gdp-plan.json\n');
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'delivery-request.json'), `${JSON.stringify(request(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize GDP M5 fixture');
  git(root, 'switch', '-c', 'feature/gdp-m5');

  const recommendationResult = JSON.parse(sflow(
    root, 'delivery', 'recommend', '--request-file', 'delivery-request.json', '--json'
  ).stdout);
  assert.equal(recommendationResult.operation.id, 'delivery.recommend');
  assert.equal(recommendationResult.data.plan.outcome, 'outcome-recommended');
  await writeFile(path.join(root, '.gdp-plan.json'), `${JSON.stringify(recommendationResult, null, 2)}\n`);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');

  const wrong = execute(process.execPath, [
    cli, 'delivery', 'select', '--plan', '.gdp-plan.json', '--mode', 'outcome',
    '--confirm-plan', digest('0'), '--json'
  ], root, { allowFailure: true });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /requires --confirm-plan/);

  const planSha = recommendationResult.data.plan.recommendationSha256;
  const selected = JSON.parse(sflow(
    root, 'delivery', 'select', '--plan', '.gdp-plan.json', '--mode', 'outcome',
    '--confirm-plan', planSha, '--json'
  ).stdout);
  assert.equal(selected.data.selection.deliveryMode, 'outcome');
  assert.equal(git(root, 'status', '--porcelain').stdout, '');

  await writeFile(path.join(root, 'app.mjs'), 'export const value = 2;\n');
  const landing = JSON.parse(sflow(root, 'land', '--json').stdout);
  sflow(
    root, 'adhoc', 'intent', 'confirm', landing.sessionId,
    '--objective', 'Change the exported value', '--success', 'The module exports value 2',
    '--confirm', landing.changeSetSha256, '--json'
  );
  sflow(root, 'adhoc', 'claim', '--all', '--clause', 'ADH-INTENT:SC-001', '--json');
  const preview = JSON.parse(sflow(
    root, 'adhoc', 'landing', 'preview', landing.sessionId, '--json'
  ).stdout);
  const published = JSON.parse(sflow(
    root, 'adhoc', 'publish', landing.sessionId, '--confirm', preview.packet.packetSha256, '--json'
  ).stdout);
  assert.equal(published.workId, 'GDP-M5');
  assert.match(published.commit, /^[a-f0-9]{40,64}$/);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
  for (const [plane, family, hashField, member] of [
    ['projections', 'delivery-recommendation', 'recommendationSha256', 'recommendation'],
    ['decisions', 'delivery-selection', 'selectionSha256', 'selection'],
    ['decisions', 'autonomy-decision', 'autonomyDecisionSha256', 'autonomyDecision'],
    ['subjects', 'completion-contract', 'contractSha256', 'completionContract'],
    ['subjects', 'effect-policy', 'effectPolicySha256', 'effectPolicy'],
    ['projections', 'effect-policy-compilation', 'compilationSha256', 'effectPolicyCompilation'],
    ['subjects', 'change-risk-assessment', 'riskAssessmentSha256', 'riskAssessment']
  ]) {
    const expected = selected.data.session.gdp[member];
    const relative = `singularity/work-items/GDP-M5/gdp/${plane}/${family}/${expected[hashField].slice(7)}.json`;
    const stored = JSON.parse(git(root, 'show', `HEAD:${relative}`).stdout);
    assert.deepEqual(validateDeliveryRecord(family, stored), expected, family);
  }
});
