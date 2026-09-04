import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { startAdhocSession } from '../src/adhoc/session.mjs';
import { loadDefinition } from '../src/config.mjs';
import { buildOutcomeSelectionBundle, recommendDelivery } from '../src/delivery-modes/delivery-kernel.mjs';
import { applyPromotionPlan, buildPromotionPlan, validateDeliveryModeTransition } from '../src/delivery-modes/promotion.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;

function outcomeBundle() {
  const request = {
    schemaVersion: 1, kind: 'delivery-request', workId: 'GDP-M8-SOURCE',
    outcome: { statement: 'Deliver bounded work', observablePredicate: 'The exact test passes' },
    acceptanceClauses: [{ clauseId: 'GDP-M8:AC-001', bodySha256: digest('a'), required: true, witnessPolicy: 'exact' }],
    nonGoals: [], predicted: {
      repositories: 1, touchedResources: 1, protectedPaths: false, externalEffects: false,
      credentialUse: false, architectureDecision: false, publicContractChange: false,
      databaseMigration: false
    },
    riskClass: 'low', executionProvider: 'copilot', executionPace: 'assisted',
    autonomyCeiling: 'A2', proofProfile: 'standard', workflowProfile: 'feature',
    allowedEffects: ['repository-file-write'], forbiddenEffects: ['external-network']
  };
  const recommendation = recommendDelivery({
    request, repositoryRevisionSha256: digest('b'), configurationSha256: digest('c')
  });
  return buildOutcomeSelectionBundle({
    request, recommendation, proofPolicySha256: digest('d'), policySnapshotSha256: digest('c'),
    gapAcceptancePolicySha256: digest('e'), promotionPolicySha256: digest('f'),
    selectedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null }
  });
}

function session() {
  return {
    kind: 'adhoc-session', sessionId: 'AHS-20260904000000-ABCDEF12', branch: 'feature/outcome',
    baseline: { baselineSha256: digest('1') }, gdp: outcomeBundle()
  };
}

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP M8 Tester'
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}
function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('M8 promotion is deterministic, exact-confirmed, and stale on any bound change', () => {
  const plan = buildPromotionPlan({
    session: session(), targetWorkId: 'GDP-M8-TARGET', targetWorkflowProfile: 'feature',
    expectedHead: 'a'.repeat(40), changeSetSha256: digest('2')
  });
  assert.deepEqual(validateDeliveryModeTransition(plan), plan);
  const applied = applyPromotionPlan({
    plan, session: session(), expectedHead: 'a'.repeat(40), changeSetSha256: digest('2')
  });
  assert.equal(applied.status, 'handoff-ready');
  assert.equal(applied.sourceTransitionSha256, plan.transitionSha256);
  assert.deepEqual(applied.targetArgv, [
    'singularity-flow', 'start', 'GDP-M8-TARGET', '--workflow', 'feature',
    '--from-branch', 'feature/outcome', '--allow-dirty'
  ]);
  assert.throws(() => applyPromotionPlan({
    plan, session: session(), expectedHead: 'b'.repeat(40), changeSetSha256: digest('2')
  }), /changed after preview/);
});

test('M8 CLI records only a recoverable local handoff and does not commit or start a Story', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m8-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP M8 Tester');
  git(root, 'config', 'user.email', 'gdp-m8@example.com');
  sflow(root, 'init');
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  await writeFile(path.join(root, '.gitignore'), '.gdp-promotion.json\n');
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize GDP M8 fixture');
  git(root, 'switch', '-c', 'feature/outcome');
  const loaded = await loadDefinition(root);
  const started = await startAdhocSession(root, loaded, {
    note: 'Bounded Outcome work', mode: 'in-place', gdp: outcomeBundle()
  });
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim();

  const preview = JSON.parse(sflow(
    root, 'delivery', 'promotion-preview', started.session.sessionId,
    '--workflow', 'feature', '--work-id', 'GDP-M8-TARGET', '--json'
  ).stdout);
  await writeFile(path.join(root, '.gdp-promotion.json'), `${JSON.stringify(preview, null, 2)}\n`);
  const wrong = execute(process.execPath, [
    cli, 'delivery', 'promotion-apply', '--plan', '.gdp-promotion.json',
    '--confirm-plan', digest('0'), '--json'
  ], root, { allowFailure: true });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Promotion requires --confirm-plan/);
  const applied = JSON.parse(sflow(
    root, 'delivery', 'promotion-apply', '--plan', '.gdp-promotion.json',
    '--confirm-plan', preview.data.plan.transitionSha256, '--json'
  ).stdout);
  assert.equal(applied.data.transition.status, 'handoff-ready');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), before);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
  const status = JSON.parse(sflow(
    root, 'delivery', 'promotion-status', started.session.sessionId, '--json'
  ).stdout);
  assert.equal(status.data.transition.transitionSha256,
    applied.data.transition.transitionSha256);
  assert.deepEqual(status.data.recover, applied.data.transition.targetArgv);
});

test('M8 transition family is closed, immutable, and operationally scoped', async () => {
  const plan = buildPromotionPlan({
    session: session(), targetWorkId: 'GDP-M8-TARGET', targetWorkflowProfile: 'bugfix',
    expectedHead: 'a'.repeat(40)
  });
  assert.equal(currentSchemaVersion('delivery-mode-transition'), 1);
  assert.equal(new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]))
    .get('delivery-mode-transition').immutable, true);
  assert.equal(familyForStoredPath(
    '$git/singularity-flow/adhoc/AHS-20260904000000-ABCDEF12/delivery-transition.json'
  )?.id, 'delivery-mode-transition');
  const schema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas/gdp-delivery-mode-transition.schema.json'
  ), 'utf8'));
  assert.deepEqual(Object.keys(plan).sort(), [...schema.required].sort());
  assert.equal(plan.transitionSha256, `sha256:${recordSha256(Object.fromEntries(
    Object.entries(plan).filter(([key]) => key !== 'transitionSha256')
  ))}`);
});
