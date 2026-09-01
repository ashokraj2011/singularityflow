import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { verifyGroundingRecord } from '../src/grounding.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { worldModelCommand } from '../src/worldmodel.mjs';
import {
  configuredWorldModelV4MaximumWorkers, configuredWorldModelV4ViewIds,
  WORLD_MODEL_V4_COMMANDS
} from '../src/world-model/commands.mjs';

const executable = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function quiet(operation) {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.error = () => {};
  console.warn = () => {};
  try { return await operation(); }
  finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }
}

test('registered-v4 honors disabled configuration parallelism while allowing an explicit worker override', () => {
  const config = {
    generation: { parallel: false, maxWorkers: 8 },
    definition: { worldModel: { generation: { parallel: false, maxWorkers: 8 } } }
  };
  assert.equal(configuredWorldModelV4MaximumWorkers(config), 1);
  assert.equal(configuredWorldModelV4MaximumWorkers(config, { workers: 3 }), 3);
  assert.equal(configuredWorldModelV4MaximumWorkers({
    generation: { parallel: true, maxWorkers: 6 }, definition: { worldModel: {} }
  }), 6);
});

test('every public registered-v4 command is admitted and deterministic execution is model-free', () => {
  const catalog = new Map(operationCatalog().map((entry) => [entry.id, entry]));
  for (const subcommand of WORLD_MODEL_V4_COMMANDS) {
    const resolved = resolveOperation({
      requestedCommand: 'wm',
      positionals: ['wm', subcommand],
      options: { format: 'registered-v4', composer: 'deterministic' }
    });
    assert.ok(resolved.id === `wm.${subcommand}` || resolved.id.startsWith(`wm.${subcommand}.`),
      `wm ${subcommand} resolved as ${resolved.id}`);
    assert.ok(catalog.has(resolved.id), `${resolved.id} is absent from the operation catalog`);
    assert.equal(resolved.modelPolicy, 'never', `wm ${subcommand} is deterministic/read-only`);
  }

  const configured = {
    worldModel: { format: 'registered-v4', composer: 'deterministic' }
  };
  assert.equal(resolveOperation({
    requestedCommand: 'wm', positionals: ['wm', 'build'], context: configured
  }).id, 'wm.build.deterministic');
  assert.equal(resolveOperation({
    requestedCommand: 'wm', positionals: ['wm', 'ensure'], context: configured
  }).id, 'wm.ensure.registered-v4');
  assert.equal(resolveOperation({
    requestedCommand: 'wm', positionals: ['wm', 'build'],
    options: { format: 'registered-v4', composer: 'model-required' }
  }).modelPolicy, 'required');
});

test('registered-v4 view configuration fails closed instead of broadening an unknown name to all views', () => {
  assert.throws(
    () => configuredWorldModelV4ViewIds({
      definition: { worldModel: { views: ['dev.imapct'] } }, phases: {}
    }),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
      && error.details.views.includes('dev.imapct')
  );
  assert.throws(
    () => configuredWorldModelV4ViewIds({ definition: { worldModel: {} }, phases: {} }, {
      views: 'dev.impact,arch.typo'
    }),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
  );
  assert.throws(
    () => configuredWorldModelV4ViewIds({
      definition: { worldModel: { views: ['dev.impact', 'development'] } }, phases: {}
    }),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
      && error.details.views.includes('development')
  );
  assert.throws(
    () => configuredWorldModelV4ViewIds({
      definition: { worldModel: { views: ['dev.impact'] } },
      phases: { implementation: { declaredViews: ['dev.impact', 'arch.contracts@3'] } }
    }, {}, 'implementation'),
    (error) => error.code === 'WMB_VIEW_UNKNOWN'
      && error.details.views.includes('arch.contracts@3')
  );
  assert.deepEqual(configuredWorldModelV4ViewIds({ definition: { worldModel: {} }, phases: {} }, {
    views: 'all'
  }), ['arch.contracts', 'biz.rules', 'dev.hotspots', 'dev.impact']);
});

async function registeredRepository(t, { staleness = 'warn' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'WMB Test']);
  git(root, ['config', 'user.email', 'wmb@example.invalid']);
  await writeFile(path.join(root, 'payments.mjs'), [
    'export function calculatePayment(total) {',
    '  return Number(total);',
    '}',
    ''
  ].join('\n'));
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.format = 'registered-v4';
  workflow.worldModel.staleness = staleness;
  workflow.worldModel.promptSource = 'builtin';
  workflow.worldModel.views = ['dev.impact'];
  for (const phase of Object.values(workflow.phases)) {
    if (phase.worldModel?.views?.length) phase.worldModel.views = ['dev.impact'];
  }
  workflow.worldModel.v4 = {
    composer: 'deterministic', consumer: 'developer', cachePolicy: 'reuse-valid',
    totalMaximumOutputTokens: 1400
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  const agentsRoot = path.join(root, '.github', 'agents');
  for (const name of await readdir(agentsRoot)) {
    if (!name.endsWith('.agent.md')) continue;
    const agentPath = path.join(agentsRoot, name);
    const agent = await readFile(agentPath, 'utf8');
    await writeFile(agentPath, agent.replace(
      /sflow-world-model-views: "[^"]*"/,
      'sflow-world-model-views: "dev.impact"'
    ));
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initialize registered WMB v4 fixture']);
  return root;
}

test('registered-v4 CLI plans, publishes, verifies, and reuses state without invoking a model', async (t) => {
  const root = await registeredRepository(t);
  const planned = await quiet(() => worldModelCommand(root, ['wm', 'plan'], {
    format: 'registered-v4', views: 'dev.impact', json: true
  }));
  assert.deepEqual(planned.plan.views.map((entry) => entry.viewId), ['dev.impact']);
  assert.equal(planned.plan.estimatedWork.maximumCompositionCalls, 1);

  const built = await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    views: 'dev.impact', json: true
  }));
  assert.equal(built.status, 'completed');
  assert.equal(built.runtime.availableViews[0].usageObservation.promptBytes, 0);
  assert.equal(built.runtime.availableViews[0].usageObservation.providerInputTokens, null);
  assert.equal(built.publication.branch, 'state');
  assert.equal(git(root, ['status', '--short']), '');

  const stateBefore = git(root, ['rev-parse', 'state']);
  const ensured = await quiet(() => worldModelCommand(root, ['wm', 'ensure', 'intake'], {
    json: true
  }));
  assert.equal(ensured.status, 'ready');
  assert.equal(ensured.modelInvoked, false);
  assert.equal(ensured.rebuilt, false);
  assert.equal(git(root, ['rev-parse', 'state']), stateBefore);

  const status = await quiet(() => worldModelCommand(root, ['wm', 'status'], {
    json: true
  }));
  assert.equal(status.format, 'wmb-v4');
  assert.equal(status.fresh, true);
  assert.deepEqual(status.views.map((entry) => entry.viewId), ['dev.impact']);
  const cache = await quiet(() => worldModelCommand(root, ['wm', 'verify-cache'], {
    json: true
  }));
  assert.deepEqual(cache.map((entry) => ({ viewId: entry.viewId, status: entry.status })), [
    { viewId: 'dev.impact', status: 'verified' }
  ]);
  assert.equal(cache[0].executionProfileSha256, null);
});

test('the public CLI loads approved registered-v4 policy before enforcing --no-model', async (t) => {
  const root = await registeredRepository(t);
  const planned = spawnSync(process.execPath, [
    executable, '--no-model', 'world-model', 'plan', '--views', 'dev.impact', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).plan.views[0].viewId, 'dev.impact');

  // No --format/--composer hint: dispatch must read the approved repository definition and admit
  // the configured deterministic v4 build instead of rejecting it as legacy model-required work.
  const built = spawnSync(process.execPath, [
    executable, '--no-model', 'world-model', 'build', '--views', 'dev.impact', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const result = JSON.parse(built.stdout);
  assert.equal(result.status, 'completed');
  assert.equal(result.views[0].status, 'available');
  assert.match(git(root, ['rev-parse', 'state']), /^[0-9a-f]{40}$/);
});

test('registered-v4 ensure refuses a missing store without starting or publishing a build', async (t) => {
  const root = await registeredRepository(t);
  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_MANIFEST_MISSING'
  );
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: root, allowFailure: true
  }).status, 1);
  assert.equal(git(root, ['status', '--short']), '');
});

test('registered-v4 fail staleness policy blocks reuse without replacing state', async (t) => {
  const root = await registeredRepository(t, { staleness: 'fail' });
  await quiet(() => worldModelCommand(root, ['wm', 'build'], { views: 'dev.impact' }));
  const stateBefore = git(root, ['rev-parse', 'state']);
  await writeFile(path.join(root, 'payments.mjs'), [
    'export function calculatePayment(total) {',
    '  return Number(total) + 1;',
    '}',
    ''
  ].join('\n'));
  git(root, ['add', 'payments.mjs']);
  git(root, ['commit', '-q', '-m', 'change registered source']);

  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_STALE'
      && error.details?.implicitRebuild === false
  );
  assert.equal(git(root, ['rev-parse', 'state']), stateBefore);
});

test('phase composition reads exact state-backed registered views and never rebuilds them', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  }));
  const stateBefore = git(root, ['rev-parse', 'state']);
  git(root, ['switch', '-q', '-c', 'WMB-V4-STORY']);
  const config = await loadConfig(root);
  config.git.publish = 'off';
  await setAgentSession(root, config, {
    name: 'WMB Test', email: 'wmb@example.invalid', login: null
  }, 'product-owner', 'WMB-V4-STORY', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'WMB-V4-STORY', title: 'Consume registered grounding',
    source: {
      type: 'manual', key: 'WMB-V4-STORY', title: 'Consume registered grounding',
      description: 'Prove phase composition consumes immutable state-backed WMB v4 views.',
      acceptanceCriteria: ['The phase prompt contains the exact registered development impact view.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });

  const prompt = await quiet(() => worldModelCommand(root, ['wm', 'compose'], {
    phase: 'intake', agent: 'product-owner', 'return-only': true
  }));
  assert.match(prompt, /required repository world-model grounding/i);
  assert.match(prompt, /Repository grounding: singularity\/world-model\/views\/dev\.impact\.md/);
  assert.match(prompt, /SFlow World-Model View/);
  const verified = await verifyGroundingRecord(
    root, config, workflow, workflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.deepEqual(verified.errors, []);
  assert.deepEqual(verified.warnings, []);
  await t.test('grounding verification uses recorded exact selections after current view policy changes', async () => {
    const changedDefinition = structuredClone(config);
    changedDefinition.worldModel.views = ['biz.rules'];
    const changedPhase = structuredClone(workflow.phases.intake);
    changedPhase.worldModel = { ...changedPhase.worldModel, views: ['biz.rules'] };
    const historical = await verifyGroundingRecord(
      root, changedDefinition, workflow, changedPhase,
      { generation: 1, agent: 'product-owner' }
    );
    assert.deepEqual(historical.errors, []);
    assert.deepEqual(historical.warnings, []);
    assert.deepEqual(
      historical.record.requiredSelections.map((entry) => `${entry.view}@${entry.version}`),
      ['dev.impact@4']
    );
  });
  assert.equal(git(root, ['rev-parse', 'state']), stateBefore);
  assert.equal(git(root, ['ls-tree', '-r', '--name-only', 'HEAD', 'singularity/world-model']).trim(), '');
});

test('v3 migration publishes the target projection and receipt in one state commit', async (t) => {
  const root = await registeredRepository(t);
  await writeFile(path.join(root, 'legacy-impact.md'), [
    '# Legacy impact',
    '',
    '- A historical claim that must remain unavailable unless a registered fact proves it.',
    ''
  ].join('\n'));
  git(root, ['add', 'legacy-impact.md']);
  git(root, ['commit', '-q', '-m', 'add legacy world-model view']);

  const migrated = await quiet(() => worldModelCommand(root, ['wm', 'migrate', 'legacy-impact.md'], {
    view: 'dev.impact', json: true
  }));
  const commit = migrated.publication.commit;
  assert.match(commit, /^[0-9a-f]{40}$/);
  const receiptPath = `singularity/world-model/migrations/${migrated.receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
  const manifest = JSON.parse(git(root, ['show', `${commit}:singularity/world-model/manifest.json`]));
  const receipt = JSON.parse(git(root, ['show', `${commit}:${receiptPath}`]));
  assert.equal(manifest.format, 'wmb-v4');
  assert.equal(manifest.views.find((entry) => entry.viewId === 'dev.impact')?.viewSha256,
    migrated.receipt.targetViewSha256);
  assert.equal(receipt.receiptSha256, migrated.receipt.receiptSha256);
  assert.equal(receipt.targetViewSha256, migrated.receipt.targetViewSha256);
  assert.equal(
    git(root, ['log', '--format=%H', 'state', '--', 'singularity/world-model/manifest.json']).split('\n').filter(Boolean)[0],
    commit
  );
  assert.equal(
    git(root, ['log', '--format=%H', 'state', '--', receiptPath]).split('\n').filter(Boolean)[0],
    commit
  );
  const status = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(status.manifestSha256, manifest.manifestSha256);
  assert.equal(status.fresh, true);
  const parent = `${commit}^`;
  assert.equal(run('git', ['cat-file', '-e', `${parent}:singularity/world-model/manifest.json`], {
    cwd: root, allowFailure: true
  }).status, 128);
  assert.equal(run('git', ['cat-file', '-e', `${parent}:${receiptPath}`], {
    cwd: root, allowFailure: true
  }).status, 128);
});
