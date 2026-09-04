import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { operationCatalog, resolveOperation } from '../src/command-registry.mjs';
import { resolveCapabilityWorldModelCandidate } from '../src/capability-context.mjs';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { composeContextBrief } from '../src/context-broker.mjs';
import { compileEvidencePacket } from '../src/evidence-packet.mjs';
import { verifyGroundingRecord } from '../src/grounding.mjs';
import { repositorySnapshot } from '../src/editor.mjs';
import { composeInitiativeContext } from '../src/initiative-context.mjs';
import { createInitiative } from '../src/initiative-state.mjs';
import { createPlanningContext } from '../src/planning.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import {
  composePhasePrompt, inspectConfiguredGrounding, inspectWorkflowGrounding, loadWorldModelConfig,
  workflowGroundingMaterializationPlan, worldModelCommand
} from '../src/worldmodel.mjs';
import {
  configuredWorldModelV4MaximumWorkers, configuredWorldModelV4ViewIds,
  configuredWorldModelV4ViewSelections,
  resolveWorldModelV4Grounding, worldModelV4GatewayDefaults, WORLD_MODEL_V4_COMMANDS
} from '../src/world-model/commands.mjs';
import { sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import { runDeterministicRegistration } from '../src/world-model/extract/runner.mjs';
import { automaticMaterializationDecision } from '../src/world-model-materialization.mjs';

const executable = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const originalSharedCache = process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE;
const isolatedSharedCacheRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-command-cache-'));
process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE = path.join(isolatedSharedCacheRoot, 'cache');
after(async () => {
  if (originalSharedCache == null) delete process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE;
  else process.env.SINGULARITY_FLOW_WMB_SHARED_CACHE = originalSharedCache;
  await rm(isolatedSharedCacheRoot, { recursive: true, force: true });
});

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

async function captureStandardOutput(operation) {
  const original = console.log;
  const output = [];
  console.log = (...values) => output.push(values.join(' '));
  try { return { result: await operation(), output }; }
  finally { console.log = original; }
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

test('registered-v4 lifecycle materialization builds explicitly and automatic absence is preserved', () => {
  const readiness = {
    format: 'registered-v4',
    config: {
      definition: { worldModel: { v4: { composer: 'deterministic' } } },
      repositoryCapability: { id: 'payments-api' }
    },
    plan: { phase: 'intake' },
    availability: { status: 'unavailable' },
    command: 'singularity-flow wm build --format registered-v4 --phase intake'
  };
  const confirmed = workflowGroundingMaterializationPlan(readiness, {
    phaseId: 'intake', automatic: false
  });
  assert.equal(confirmed.operationId, 'wm.build.deterministic');
  assert.deepEqual(confirmed.positionals, ['wm', 'build']);
  assert.match(confirmed.command, /wm build --format registered-v4 --phase intake/);
  assert.match(confirmed.command, /--capability payments-api/);
  assert.equal(confirmed.options.capability, 'payments-api');
  assert.deepEqual(confirmed.argv.slice(-2), ['--capability', 'payments-api']);
  assert.doesNotMatch(confirmed.command, /wm ensure/);

  const missing = workflowGroundingMaterializationPlan({
    ...readiness, availability: { status: 'missing' }
  }, { phaseId: 'intake', automatic: true });
  assert.equal(missing.allowed, false);
  assert.match(missing.reason, /intentionally removed|unavailable offline/);

  const modelComposer = workflowGroundingMaterializationPlan({
    ...readiness,
    config: { definition: { worldModel: { v4: { composer: 'model-required' } } } }
  }, { phaseId: 'intake', automatic: true });
  assert.equal(modelComposer.allowed, false);
  assert.match(modelComposer.reason, /may invoke a model/);

  const localOnly = workflowGroundingMaterializationPlan(readiness, {
    phaseId: 'intake', automatic: true, publication: 'local'
  });
  assert.deepEqual({
    allowed: localOnly.allowed,
    modelFree: localOnly.modelFree,
    publication: localOnly.publication
  }, { allowed: false, modelFree: true, publication: 'local' });
  assert.match(localOnly.reason, /reusable governed publication/);
  assert.match(localOnly.reason, /local rehearsal only/);
  assert.equal(localOnly.argv, undefined, 'a local-only policy must not produce executable lifecycle argv');
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
    (error) => error.code === 'WMB_VIEW_VERSION_UNSUPPORTED'
      && error.details.views.includes('arch.contracts@3')
  );
  assert.deepEqual(configuredWorldModelV4ViewIds({ definition: { worldModel: {} }, phases: {} }, {
    views: 'all'
  }), ['arch.contracts', 'biz.rules', 'dev.hotspots', 'dev.impact']);
  assert.deepEqual(configuredWorldModelV4ViewIds({
    definition: { worldModel: { views: ['dev.impact'] } }, phases: {}
  }, { views: 'dev.impact@4' }), ['dev.impact']);
});

test('version-qualified configured views resolve the exact published manifest entry', () => {
  const config = { definition: { worldModel: { views: ['dev.impact'] } }, phases: {}, staleness: 'warn' };
  const resolved = resolveWorldModelV4Grounding('/unused', config, {
    options: { views: 'dev.impact@4' },
    store: {
      ref: 'refs/heads/state', commit: 'a'.repeat(40),
      sourceSnapshot: { sourceManifestSha256: `sha256:${'b'.repeat(64)}` },
      freshness: { fresh: true },
      manifest: { manifestSha256: `sha256:${'a'.repeat(64)}` },
      views: [{
        viewId: 'dev.impact', viewVersion: 4, status: 'available',
        path: 'singularity/world-model/views/dev.impact.md', markdown: '# Impact\n'
      }]
    }
  });
  assert.deepEqual(resolved.selections.map((entry) => `${entry.view}@${entry.version}`), ['dev.impact@4']);
  assert.throws(() => resolveWorldModelV4Grounding('/unused', config, {
    options: { views: 'dev.impact@4' },
    store: {
      ref: 'refs/heads/state', commit: 'a'.repeat(40),
      sourceSnapshot: { sourceManifestSha256: `sha256:${'b'.repeat(64)}` },
      freshness: { fresh: true }, manifest: {},
      views: [{ viewId: 'dev.impact', viewVersion: 5, status: 'available', path: 'x', markdown: 'x' }]
    }
  }), (error) => error.code === 'WMB_VIEW_VERSION_UNSUPPORTED');
});

test('the canonical configuration loader accepts and normalizes exact @4 view references', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.views = ['dev.impact@4'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  const config = await loadWorldModelConfig(root);
  assert.deepEqual(configuredWorldModelV4ViewSelections(config).map(({ viewId, version, reference }) => ({
    viewId, version, reference
  })), [{ viewId: 'dev.impact', version: 4, reference: 'dev.impact@4' }]);
  assert.deepEqual(configuredWorldModelV4ViewIds(config), ['dev.impact']);
  assert.deepEqual(worldModelV4GatewayDefaults(root, config).views, ['dev.impact']);
});

test('omitted registered-v4 catalog means every active contract across canonical loading and prompt validation', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  delete workflow.worldModel.views;
  await writeFile(workflowPath, YAML.stringify(workflow));
  const config = await loadWorldModelConfig(root);
  assert.deepEqual(configuredWorldModelV4ViewSelections(config).map((entry) => entry.reference), [
    'arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4'
  ]);

  const promptDirectory = path.join(root, 'singularity', 'prompts');
  await mkdir(promptDirectory, { recursive: true });
  await writeFile(path.join(promptDirectory, 'invalid-v4.md'), [
    '# Invalid registered view', '', 'Load views/not.registered.md before authoring.', ''
  ].join('\n'));
  workflow.worldModel.promptSource = 'singularity/prompts/invalid-v4.md';
  await writeFile(workflowPath, YAML.stringify(workflow));
  await assert.rejects(
    () => loadWorldModelConfig(root),
    (error) => error.code === 'WMB_VIEW_UNKNOWN' && /not\.registered/.test(error.message)
  );
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

test('the canonical World-Model config loader preserves every CLI and VS Code build input', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.sourceRoots = ['src'];
  workflow.worldModel.sharedRoots = ['shared'];
  workflow.worldModel.excludedRoots = ['generated'];
  workflow.worldModel.allowedSubjects = ['symbol', 'file'];
  workflow.worldModel.maximumTraversalDepth = 5;
  workflow.worldModel.outputDir = 'singularity/custom-world-model';
  workflow.worldModel.generation = { ...workflow.worldModel.generation, parallel: false, maxWorkers: 7 };
  workflow.worldModel.v4 = {
    composer: 'model-required', consumer: 'architect', cachePolicy: 'rebuild',
    totalMaximumOutputTokens: 1400
  };
  workflow.models.providers['copilot-cli'] = {
    ...workflow.models.providers['copilot-cli'], promptTransport: 'acp-stdio', arguments: ['--log-level=error']
  };
  workflow.ledger.branch = 'wm-state';
  workflow.ledger.remote = 'state-authority';
  workflow.git.remote = 'upstream';
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'configure exact world model inputs']);

  const config = await loadWorldModelConfig(root);
  const pinned = {
    ...config,
    workflow: { resolution: { capability: { id: 'payments-capability' } } }
  };
  const defaults = worldModelV4GatewayDefaults(root, pinned);
  assert.deepEqual(defaults.views, ['dev.impact']);
  assert.deepEqual(defaults.allowedPaths, ['src']);
  assert.deepEqual(defaults.sharedPaths, ['shared']);
  assert.ok(defaults.excludedPaths.includes('generated'));
  assert.deepEqual(defaults.allowedSubjects, ['file', 'symbol']);
  assert.equal(defaults.maximumTraversalDepth, 5);
  assert.equal(defaults.capabilityId, 'payments-capability');
  assert.equal(defaults.composer, 'model');
  assert.equal(defaults.consumer, 'architect');
  assert.equal(defaults.cachePolicy, 'rebuild');
  assert.equal(defaults.totalMaximumOutputTokens, 1400);
  assert.equal(defaults.provider, 'copilot-cli');
  assert.equal(defaults.providerConfig.promptTransport, 'acp-stdio');
  assert.deepEqual(defaults.providerConfig.arguments, ['--log-level=error']);
  assert.equal(defaults.maximumWorkers, 1, 'disabled parallelism overrides the configured worker count');
  assert.equal(defaults.outputDir, 'singularity/custom-world-model');
  assert.equal(defaults.ledgerConfig.branch, 'wm-state');
  assert.equal(defaults.ledgerConfig.remote, 'state-authority',
    'state publication follows ledger.remote rather than the application Git remote');
});

test('semantically equivalent source-scope spellings keep one reusable policy identity', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.sourceRoots = ['./src/'];
  workflow.worldModel.sharedRoots = ['./shared/'];
  workflow.worldModel.excludedRoots = ['./generated/'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  const first = worldModelV4GatewayDefaults(root, await loadWorldModelConfig(root));

  workflow.worldModel.sourceRoots = ['src'];
  workflow.worldModel.sharedRoots = ['shared'];
  workflow.worldModel.excludedRoots = ['generated'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  const second = worldModelV4GatewayDefaults(root, await loadWorldModelConfig(root));
  assert.equal(second.policySnapshotSha256, first.policySnapshotSha256);
  assert.deepEqual(second.allowedPaths, first.allowedPaths);
  assert.deepEqual(second.sharedPaths, first.sharedPaths);
  assert.deepEqual(second.excludedPaths, first.excludedPaths);
});

test('registered world-model reuse binds the exact effective capability resolution', async (t) => {
  const root = await registeredRepository(t);
  const config = await loadWorldModelConfig(root);
  const first = worldModelV4GatewayDefaults(root, config);
  const changed = worldModelV4GatewayDefaults(root, {
    ...config,
    repositoryCapability: {
      ...config.repositoryCapability,
      effectiveResolution: {
        ...config.repositoryCapability.effectiveResolution,
        dependencyContractSha256: `sha256:${'9'.repeat(64)}`
      }
    }
  });
  assert.notEqual(changed.policySnapshotSha256, first.policySnapshotSha256,
    'ownership, approval, or dependency changes invalidate reuse even when path prefixes are unchanged');
});

test('a storyless registered build reuses the repository capability scope in a later Story', async (t) => {
  const root = await registeredRepository(t);
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  mapped-payments: { name: Mapped Payments, kind: delivery, parent: null, repository: app }',
    ''
  ].join('\n'));
  await writeFile(path.join(root, 'singularity', 'portfolio.yml'), [
    'version: 1',
    'repositories:',
    '  app: { url: "https://example.invalid/payments.git", defaultBranch: main }',
    ''
  ].join('\n'));
  git(root, ['add', 'singularity/capabilities.yml', 'singularity/portfolio.yml']);
  git(root, ['commit', '-q', '-m', 'map repository capability']);

  const storyless = await loadWorldModelConfig(root);
  assert.equal(storyless.repositoryCapability.id, 'mapped-payments');
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic'
  }));
  const story = {
    ...storyless,
    workflow: { resolution: { capability: { id: 'mapped-payments' } } }
  };
  const consumed = resolveWorldModelV4Grounding(root, story, {
    options: { views: 'dev.impact' }
  });
  assert.equal(consumed.freshness.fresh, true);
  assert.equal(consumed.views[0].viewId, 'dev.impact');
});

test('a storyless registered build requires an explicit capability when repository ownership is ambiguous', async (t) => {
  const root = await registeredRepository(t);
  await writeFile(path.join(root, 'singularity', 'capabilities.yml'), [
    'version: 1', 'capabilities:',
    '  alpha: { kind: delivery, parent: null, repository: alpha-repo }',
    '  beta: { kind: delivery, parent: null, repository: beta-repo }', ''
  ].join('\n'));
  await writeFile(path.join(root, 'singularity', 'portfolio.yml'), [
    'version: 1', 'repositories:',
    '  alpha-repo: { url: "https://example.invalid/alpha.git", defaultBranch: main }',
    '  beta-repo: { url: "https://example.invalid/beta.git", defaultBranch: main }', ''
  ].join('\n'));
  await assert.rejects(() => loadWorldModelConfig(root),
    (error) => error.code === 'WMB_CAPABILITY_SELECTION_REQUIRED'
      && error.details?.option === '--capability <id>');
  const selected = await loadWorldModelConfig(root, { capabilityId: 'alpha' });
  assert.equal(selected.repositoryCapability.id, 'alpha');
});

test('registered-v4 configuration refuses legacy view IDs during format transition', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-transition-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'WMB Test']);
  git(root, ['config', 'user.email', 'wmb@example.invalid']);
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.format = 'registered-v4';
  await writeFile(workflowPath, YAML.stringify(workflow));
  await assert.rejects(
    () => loadWorldModelConfig(root),
    (error) => error.code === 'WMB_VIEW_UNKNOWN' && /business/.test(error.message)
  );
});

test('non-scope World-Model controls do not invalidate an unchanged registered-v4 projection', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact'
  }));
  const before = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(before.fresh, true);

  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.grounding = 'enforce';
  workflow.worldModel.staleness = 'ignore';
  workflow.worldModel.stateFetchTimeoutMs = 1250;
  workflow.worldModel.materialization.confirmation = 'automatic';
  workflow.worldModel.materialization.depth = 'light';
  workflow.worldModel.injection.maxBytes += 1024;
  workflow.worldModel.generation.parallel = false;
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'change read and execution controls only']);

  const after = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(after.fresh, true);
  assert.deepEqual(after.freshness.changes, []);
});

test('production monorepo scope admits canonical trusted inputs but excludes Story state', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.sourceRoots = ['payments.mjs', 'world-model-inputs'];
  await writeFile(workflowPath, YAML.stringify(workflow));

  await mkdir(path.join(root, 'world-model-inputs'), { recursive: true });
  const runtimeRecord = sealRecord({
    schemaVersion: 1,
    kind: 'world-model-runtime-observation',
    id: 'payment-frequency',
    metric: 'frequency',
    subjectId: 'calculate-payment',
    count: 7,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-01-02T00:00:00.000Z',
    producerId: 'approved-runtime-exporter',
    producerVersion: '1.0.0',
    receiptSha256: sha256('runtime receipt')
  }, 'recordSha256');
  await writeFile(path.join(root, 'world-model-inputs', 'runtime-observations.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'world-model-runtime-observation-import',
    records: [runtimeRecord]
  }));
  const knowledgeRecord = sealRecord({
    schemaVersion: 1,
    kind: 'world-model-human-confirmed-knowledge',
    id: 'payment-term',
    factType: 'business-glossary',
    term: 'Payment',
    statement: 'A governed amount processed by the payment calculation.',
    confirmation: {
      status: 'confirmed',
      authorityId: 'product-approvers',
      identitySha256: sha256('reviewer identity'),
      confirmedAt: '2026-01-01T00:00:00.000Z',
      receiptSha256: sha256('approval receipt')
    }
  }, 'recordSha256');
  await writeFile(path.join(root, 'world-model-inputs', 'human-confirmed-knowledge.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'world-model-human-confirmed-knowledge-import',
    records: [knowledgeRecord]
  }));
  await mkdir(path.join(root, 'singularity', 'work-items', 'WRK-DECOY'), { recursive: true });
  await writeFile(
    path.join(root, 'singularity', 'work-items', 'WRK-DECOY', 'runtime-observations.json'),
    JSON.stringify({ unsafe: 'Story-local state must never enter the repository model.' })
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'add approved repository model inputs']);

  const planned = await quiet(() => worldModelCommand(root, ['wm', 'plan'], {
    format: 'registered-v4', views: 'dev.impact', json: true
  }));
  const plannedPaths = planned.sourceSnapshot.files.map((file) => file.path);
  assert.ok(plannedPaths.includes('world-model-inputs/runtime-observations.json'));
  assert.ok(plannedPaths.includes('world-model-inputs/human-confirmed-knowledge.json'));
  assert.equal(plannedPaths.some((relative) => relative.startsWith('singularity/work-items/')), false);
  assert.ok(planned.scopeManifest.excludedPaths.includes('singularity/**'));

  const registration = runDeterministicRegistration({
    root,
    sourceSnapshot: planned.sourceSnapshot,
    scopeManifest: planned.scopeManifest,
    requestedViews: ['dev.impact@4']
  });
  assert.ok(registration.factLedger.facts.some((fact) => (
    fact.factType === 'runtime-frequency' && fact.assurance === 'runtime-observed'
  )));
  assert.ok(registration.factLedger.facts.some((fact) => (
    fact.factType === 'business-glossary' && fact.assurance === 'human-confirmed'
  )));
});

test('registered-v4 CLI plans, publishes, verifies, and reuses state without invoking a model', async (t) => {
  const root = await registeredRepository(t);
  const planned = await quiet(() => worldModelCommand(root, ['wm', 'plan'], {
    format: 'registered-v4', views: 'dev.impact', json: true
  }));
  assert.deepEqual(planned.plan.views.map((entry) => entry.viewId), ['dev.impact']);
  assert.equal(planned.plan.estimatedWork.maximumCompositionCalls, 1);
  assert.equal(planned.scopeManifest.policySourceSha256,
    planned.request.policySnapshotSha256);

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

test('automatic light materialization extends an exact registered-v4 projection without changing existing view bytes', async (t) => {
  const root = await registeredRepository(t, { staleness: 'fail' });
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.views = ['dev.impact', 'biz.rules'];
  workflow.worldModel.v4.totalMaximumOutputTokens = 2800;
  workflow.worldModel.materialization = {
    mode: 'on-demand', publish: 'governed', lookahead: 'none',
    depth: 'light', confirmation: 'automatic'
  };
  workflow.phases.intake.worldModel.views = ['biz.rules'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'configure progressive registered grounding']);

  const first = await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic', depth: 'quick'
  }));
  assert.equal(first.runtime.availableViews[0].usageObservation.providerInputTokens, null);
  const config = await loadWorldModelConfig(root);
  const before = resolveWorldModelV4Grounding(root, config, {
    options: { views: 'dev.impact', depth: 'quick' }
  });
  const developmentBytes = before.views[0].markdown;

  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.availability.error.code, 'WMB_VIEW_UNAVAILABLE');
  assert.equal(readiness.availability.extensionBase.commit, git(root, ['rev-parse', 'state']));
  assert.equal(
    readiness.availability.extensionBase.sourceManifestSha256,
    before.store.sourceSnapshot.sourceManifestSha256
  );
  assert.equal(automaticMaterializationDecision(readiness.availability).mode,
    'same-source-extension');

  const materialization = workflowGroundingMaterializationPlan(readiness, {
    phaseId: 'intake', automatic: true
  });
  assert.equal(materialization.allowed, true);
  assert.equal(materialization.modelFree, true);
  assert.equal(materialization.options.depth, 'quick');
  assert.equal(materialization.argv[materialization.argv.indexOf('--depth') + 1], 'quick');
  assert.equal(
    materialization.options['expected-preservation-commit'],
    readiness.availability.extensionBase.commit
  );

  const extended = await quiet(() => worldModelCommand(
    root, materialization.positionals, materialization.options
  ));
  assert.equal(extended.status, 'completed');
  assert.equal(extended.runtime.planned.consumerProfile.depth, 'quick');
  assert.ok(extended.runtime.availableViews.every((entry) => (
    entry.usageObservation.providerInputTokens == null
      && entry.usageObservation.providerOutputTokens == null
  )), 'deterministic automatic extension must consume zero provider tokens');

  const after = resolveWorldModelV4Grounding(root, config, {
    options: { views: 'dev.impact,biz.rules', depth: 'quick' }
  });
  assert.deepEqual(after.views.map((entry) => entry.viewId).sort(), ['biz.rules', 'dev.impact']);
  assert.equal(after.views.find((entry) => entry.viewId === 'dev.impact').markdown,
    developmentBytes, 'the previously published view bytes must be retained exactly');
});

test('automatic registered-v4 extension refuses an authority removal after readiness', async (t) => {
  const root = await registeredRepository(t, { staleness: 'fail' });
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.views = ['dev.impact', 'biz.rules'];
  workflow.worldModel.v4.totalMaximumOutputTokens = 2800;
  workflow.worldModel.materialization = {
    mode: 'on-demand', publish: 'governed', lookahead: 'none',
    depth: 'light', confirmation: 'automatic'
  };
  workflow.phases.intake.worldModel.views = ['biz.rules'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'configure authority-bound automatic extension']);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic', depth: 'quick'
  }));

  const config = await loadWorldModelConfig(root);
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  const materialization = workflowGroundingMaterializationPlan(readiness, {
    phaseId: 'intake', automatic: true
  });
  assert.equal(materialization.allowed, true);

  const worktree = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-remove-race-'));
  t.after(async () => {
    run('git', ['worktree', 'remove', '--force', worktree], { cwd: root, allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
  });
  git(root, ['worktree', 'add', '-q', '--detach', worktree, 'state']);
  await rm(path.join(worktree, 'singularity', 'world-model'), { recursive: true });
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-q', '-m', 'remove projection after automatic readiness']);
  const removedCommit = git(worktree, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/heads/state', removedCommit]);

  await assert.rejects(
    () => quiet(() => worldModelCommand(
      root, materialization.positionals, materialization.options
    )),
    (error) => error.code === 'WMB_AUTOMATIC_EXTENSION_BASE_CHANGED'
      && error.details?.expectedCommit === readiness.availability.extensionBase.commit
      && error.details?.currentCommit === removedCommit
      && error.details?.currentManifestSha256 === null
  );
  assert.equal(git(root, ['rev-parse', 'state']), removedCommit);
  assert.notEqual(run('git', [
    'cat-file', '-e', 'state:singularity/world-model/manifest.json'
  ], { cwd: root, allowFailure: true }).status, 0,
  'the removed state projection must remain removed after the automatic race refusal');
});

test('a corrupt registered-v4 projection is never exposed as an automatic extension base', async (t) => {
  const root = await registeredRepository(t, { staleness: 'fail' });
  const built = await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic'
  }));
  assert.equal(built.status, 'completed');
  const relative = resolveWorldModelV4Grounding(root, await loadWorldModelConfig(root), {
    options: { views: 'dev.impact' }
  }).views[0].path;
  const worktree = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-corrupt-state-'));
  t.after(async () => {
    run('git', ['worktree', 'remove', '--force', worktree], { cwd: root, allowFailure: true });
    await rm(worktree, { recursive: true, force: true });
  });
  git(root, ['worktree', 'add', '-q', '--detach', worktree, 'state']);
  await writeFile(path.join(worktree, 'singularity', 'world-model', relative),
    '# corrupt view bytes\n');
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-q', '-m', 'corrupt registered view']);
  const corruptCommit = git(worktree, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/heads/state', corruptCommit]);

  const readiness = await inspectConfiguredGrounding(
    root, await loadWorldModelConfig(root), 'intake', { refreshRemote: false }
  );
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.extensionBase ?? null, null);
  assert.equal(automaticMaterializationDecision(readiness.availability).allowed, false);
});

test('registered-v4 ensure detects stale remote authority without changing refs and explicit refresh recovers it', async (t) => {
  const root = await registeredRepository(t);
  const transport = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-authority-'));
  t.after(() => rm(transport, { recursive: true, force: true }));
  const remote = path.join(transport, 'remote.git');
  run('git', ['init', '--bare', '-q', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', '-u', 'origin', 'main']);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.v4.totalMaximumOutputTokens = 5600;
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'raise exact multi-view output budget']);
  git(root, ['push', '-q', 'origin', 'main']);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    views: 'dev.impact', json: true
  }));

  const clone = path.join(transport, 'clone');
  run('git', ['clone', '-q', '--branch', 'main', remote, clone]);
  git(clone, ['config', 'user.name', 'WMB Authority Reader']);
  git(clone, ['config', 'user.email', 'reader@example.invalid']);
  const cachedBefore = git(clone, ['rev-parse', 'refs/remotes/origin/state']);

  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    views: 'biz.rules', json: true
  }));
  const remoteAfter = git(root, ['ls-remote', '--heads', 'origin', 'refs/heads/state'])
    .split(/\s+/)[0];
  assert.notEqual(cachedBefore, remoteAfter);
  const refsBeforeEnsure = git(clone, ['for-each-ref', '--format=%(refname) %(objectname)']);
  await assert.rejects(
    () => quiet(() => worldModelCommand(clone, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED'
      && error.details?.command === 'singularity-flow wm refresh-authority --format registered-v4'
  );
  assert.equal(git(clone, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBeforeEnsure,
    'read-only ensure may probe but must not advance a tracking ref');

  const refreshed = await quiet(() => worldModelCommand(
    clone, ['wm', 'refresh-authority'], { format: 'registered-v4', json: true }
  ));
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(git(clone, ['rev-parse', 'refs/remotes/origin/state']), remoteAfter);
  const ensured = await quiet(() => worldModelCommand(
    clone, ['wm', 'ensure', 'intake'], { json: true }
  ));
  assert.equal(ensured.status, 'ready');

  git(root, ['push', '-q', 'origin', ':refs/heads/state']);
  const absent = await quiet(() => worldModelCommand(
    clone, ['wm', 'refresh-authority'], { format: 'registered-v4', json: true }
  ));
  assert.equal(absent.status, 'remote-absent');
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'], {
    cwd: clone, allowFailure: true
  }).status, 1, 'authoritative removal clears only the stale state tracking ref');
  await assert.rejects(
    () => quiet(() => worldModelCommand(clone, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_MANIFEST_MISSING'
      && error.details?.remoteModelRemoved === true
  );
});

test('a configured remote without a materialized state ref never falls through to local registered-v4 state', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    views: 'dev.impact', json: true
  }));
  const localState = git(root, ['rev-parse', 'refs/heads/state']);
  const transport = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-unmaterialized-authority-'));
  t.after(() => rm(transport, { recursive: true, force: true }));
  const remote = path.join(transport, 'remote.git');
  run('git', ['init', '--bare', '-q', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', 'origin', 'main']);
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'
  ], { cwd: root, allowFailure: true }).status, 1);

  const config = await loadWorldModelConfig(root);
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.refresh, 'refresh-required');
  assert.equal(readiness.availability.error.code, 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED');
  assert.match(readiness.command, /wm refresh-authority/);
  assert.throws(
    () => resolveWorldModelV4Grounding(root, config, {
      options: { views: 'dev.impact' }
    }),
    (error) => error.code === 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED'
  );
  assert.equal(git(root, ['rev-parse', 'refs/heads/state']), localState,
    'the unpublished local state remains reachable but is not selected as remote authority');
});

test('registered-v4 CLI captures and explicitly builds one immutable dirty Candidate Snapshot', async (t) => {
  const root = await registeredRepository(t);
  await writeFile(path.join(root, 'payments.mjs'), [
    'export function calculatePayment(total) {',
    '  return Number(total) + 7;',
    '}',
    ''
  ].join('\n'));

  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'plan'], {
      format: 'registered-v4', views: 'dev.impact', json: true
    })),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_REQUIRED'
  );
  const captured = await quiet(() => worldModelCommand(root, ['wm', 'snapshot'], {
    format: 'registered-v4', json: true
  }));
  assert.equal(captured.status, 'captured');
  assert.match(captured.reference, /^sha256:[a-f0-9]{64}$/);
  assert.equal(captured.sourceSnapshot.authority.kind, 'candidate-snapshot');
  assert.match(captured.next, /--candidate-snapshot sha256:[a-f0-9]{64} --local$/);

  const planned = await quiet(() => worldModelCommand(root, ['wm', 'plan'], {
    format: 'registered-v4', views: 'dev.impact',
    'candidate-snapshot': captured.reference, json: true
  }));
  assert.equal(planned.sourceSnapshot.sourceManifestSha256, captured.reference);
  assert.equal(planned.sourceSnapshot.authority.baseRevision.commit, git(root, ['rev-parse', 'HEAD']));
  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'build'], {
      format: 'registered-v4', views: 'dev.impact',
      'candidate-snapshot': captured.reference, json: true
    })),
    (error) => error.code === 'WMB_CANDIDATE_SNAPSHOT_LOCAL_ONLY'
  );
  const local = await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', local: true,
    'candidate-snapshot': captured.reference, json: true
  }));
  assert.equal(local.status, 'completed');
  assert.equal(local.publication, null);
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
  const config = {
    ...await loadWorldModelConfig(root), repositoryCapability: { id: 'orders-api' }
  };
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.format, 'registered-v4');
  assert.equal(readiness.availability.status, 'missing');
  assert.equal(readiness.availability.ready, false);
  assert.match(readiness.command, /wm build --format registered-v4 --phase intake/);
  assert.match(readiness.command, /--capability orders-api$/);
  assert.doesNotMatch(readiness.reason, /schema_version must be/);
  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_MANIFEST_MISSING'
  );
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/state'], {
    cwd: root, allowFailure: true
  }).status, 1);
  assert.equal(git(root, ['status', '--short']), '');
});

test('registered-v4 lifecycle reports a runnable diagnosis for legacy migration', async (t) => {
  const root = await registeredRepository(t);
  const modelRoot = path.join(root, 'singularity', 'world-model');
  await mkdir(modelRoot, { recursive: true });
  await writeFile(path.join(modelRoot, 'manifest.json'), `${JSON.stringify({
    schema_version: '3.0', source_tree_sha256: `sha256:${'a'.repeat(64)}`,
    core: { tiers: {} }, views: {}
  }, null, 2)}\n`);
  git(root, ['add', 'singularity/world-model/manifest.json']);
  git(root, ['commit', '-q', '-m', 'retain legacy model for explicit migration']);

  const config = {
    ...await loadWorldModelConfig(root), repositoryCapability: { id: 'payments-api' }
  };
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.error.code, 'WMB_MIGRATION_REQUIRED');
  assert.equal(
    readiness.command,
    'singularity-flow wm doctor --format registered-v4 --capability payments-api'
  );
  assert.doesNotMatch(readiness.command, /wm migrate/,
    'the lifecycle must not emit migrate without its required legacy and target view arguments');
  assert.match(
    readiness.reason,
    /wm migrate <legacy-view\.md> --view <registered-view> --capability payments-api/
  );
});

test('registered-v4 lifecycle refreshes remote state and honors an intentional remote removal', async (t) => {
  const source = await registeredRepository(t);
  const transportRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-v4-remote-'));
  t.after(() => rm(transportRoot, { recursive: true, force: true }));
  const remote = path.join(transportRoot, 'repository.git');
  const consumer = path.join(transportRoot, 'consumer');
  run('git', ['init', '--bare', '-q', '-b', 'main', remote], { cwd: transportRoot });
  git(source, ['remote', 'add', 'origin', remote]);
  git(source, ['push', '-q', '-u', 'origin', 'main']);
  run('git', ['clone', '-q', '--single-branch', '--branch', 'main', remote, consumer], {
    cwd: transportRoot
  });
  git(consumer, ['config', 'user.name', 'WMB Consumer']);
  git(consumer, ['config', 'user.email', 'consumer@example.invalid']);
  const consumerConfig = await loadWorldModelConfig(consumer);
  const before = await inspectConfiguredGrounding(consumer, consumerConfig, 'intake', {
    refreshRemote: false
  });
  assert.equal(before.availability.ready, false);
  assert.equal(before.availability.refresh, 'refresh-required');
  assert.equal(before.availability.error.code, 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED');

  await quiet(() => worldModelCommand(source, ['wm', 'build'], {
    format: 'registered-v4', phase: 'intake', composer: 'deterministic'
  }));
  const refreshed = await inspectConfiguredGrounding(consumer, consumerConfig, 'intake', {
    refreshRemote: true
  });
  assert.equal(refreshed.availability.ready, true);
  assert.equal(refreshed.availability.refresh, 'refreshed');
  assert.equal(refreshed.availability.source, 'state-branch');
  git(consumer, ['branch', 'state', 'refs/remotes/origin/state']);

  git(source, ['push', '-q', 'origin', '--delete', 'state']);
  assert.equal(run('git', [
    'cat-file', '-e', 'refs/remotes/origin/state:singularity/world-model/manifest.json'
  ], { cwd: consumer, allowFailure: true }).status, 0,
  'the consumer retains a stale remote-tracking cache before the authoritative refresh');
  const removed = await inspectConfiguredGrounding(consumer, consumerConfig, 'intake', {
    refreshRemote: true
  });
  assert.equal(removed.availability.ready, false);
  assert.equal(removed.availability.status, 'missing');
  assert.equal(removed.availability.refresh, 'remote-absent');
  assert.equal(removed.availability.extensionBase ?? null, null);
  assert.equal(workflowGroundingMaterializationPlan(removed, {
    phaseId: 'intake', automatic: true
  }).allowed, false, 'an intentionally removed authority must not be recreated automatically');
  assert.match(removed.reason, /cached copy will not override that authority/);
  const cachedRead = await inspectConfiguredGrounding(consumer, consumerConfig, 'intake', {
    refreshRemote: false
  });
  assert.equal(cachedRead.availability.ready, false);
  assert.equal(cachedRead.availability.refresh, 'refresh-required');
  assert.equal(cachedRead.availability.error.code, 'WMB_STATE_AUTHORITY_REFRESH_REQUIRED');
  assert.equal(run('git', [
    'cat-file', '-e', 'state:singularity/world-model/manifest.json'
  ], { cwd: consumer, allowFailure: true }).status, 0,
  'the old local projection remains present and must still not override the removed remote model');
});

test('a repository with no configured remote continues to use its local registered-v4 authority', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    views: 'dev.impact', json: true
  }));
  const config = await loadWorldModelConfig(root);
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.availability.ready, true);
  assert.equal(readiness.availability.refresh, 'no-remote');
  assert.equal(readiness.availability.located.ref, 'refs/heads/state');
  assert.equal(readiness.availability.located.commit, git(root, ['rev-parse', 'state']));
});

test('registered-v4 authority refresh fails closed for non-network Git failures', async (t) => {
  const root = await registeredRepository(t);
  const invalidRemote = path.join(root, 'not-a-git-repository');
  await writeFile(invalidRemote, 'not a repository\n');
  git(root, ['remote', 'add', 'origin', invalidRemote]);
  const config = await loadWorldModelConfig(root);

  const malformed = structuredClone(config);
  malformed.phases.intake.views = ['dev.imapct'];
  malformed.phases.intake.declaredViews = ['dev.imapct'];
  const malformedReadiness = await inspectConfiguredGrounding(root, malformed, 'intake', {
    refreshRemote: true
  });
  assert.equal(malformedReadiness.availability.error.code, 'WMB_VIEW_UNKNOWN',
    'approved local view policy is validated before a remote refresh is attempted');

  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: true
  });
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.status, 'unavailable');
  assert.equal(readiness.availability.error.code, 'WMB_STATE_AUTHORITY_REFRESH_FAILED');
  assert.match(readiness.reason, /could not be (?:observed|refreshed) safely/);
  assert.doesNotMatch(readiness.reason, /not-a-git-repository/,
    'provider diagnostics and repository paths must not escape the refresh boundary');
});

test('confirmed on-demand next uses registered-v4 build rather than the read-only ensure command', async (t) => {
  const root = await registeredRepository(t);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.worldModel.grounding = 'enforce';
  definition.worldModel.materialization = {
    mode: 'on-demand', publish: 'governed', lookahead: 'none',
    depth: 'phase', confirmation: 'prompt'
  };
  await writeFile(workflowPath, YAML.stringify(definition));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'enable confirmed v4 lifecycle build']);
  git(root, ['switch', '-q', '-c', 'WMB-V4-ON-DEMAND']);
  const config = await loadConfig(root);
  config.git.publish = 'off';
  await setAgentSession(root, config, {
    name: 'WMB Test', email: 'wmb@example.invalid', login: null
  }, 'product-owner', 'WMB-V4-ON-DEMAND', { phaseId: 'intake', source: 'test' });
  await createWorkflow(root, config, {
    id: 'WMB-V4-ON-DEMAND', title: 'Build registered grounding on demand',
    source: {
      type: 'manual', key: 'WMB-V4-ON-DEMAND', title: 'Build registered grounding on demand',
      description: 'A confirmed lifecycle action must invoke the registered builder, not ensure.',
      acceptanceCriteria: ['The explicit build publishes a reusable exact state projection.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });

  const next = spawnSync(process.execPath, [executable, '--no-model', 'next', '--yes'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WMB Test' }
  });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /Building the deterministic world model/);
  assert.match(next.stdout, /Next step prepared: generate 'intake'/);
  assert.doesNotMatch(next.stderr, /wm ensure.*read-only|WMB_MANIFEST_MISSING/);
  assert.equal(run('git', [
    'cat-file', '-e', 'state:singularity/world-model/manifest.json'
  ], { cwd: root, allowFailure: true }).status, 0);
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

  const config = await loadWorldModelConfig(root);
  const readiness = await inspectConfiguredGrounding(root, config, 'intake', {
    refreshRemote: false
  });
  assert.equal(readiness.availability.status, 'stale');
  assert.equal(readiness.availability.ready, false);
  assert.equal(readiness.availability.staleness.blocks, true);
  assert.equal(readiness.availability.extensionBase ?? null, null);
  assert.equal(automaticMaterializationDecision(readiness.availability).allowed, false,
    'a stale registered projection must never become an automatic extension base');
  assert.match(readiness.command, /wm build --format registered-v4 --phase intake/);

  await assert.rejects(
    () => quiet(() => worldModelCommand(root, ['wm', 'ensure', 'intake'], { json: true })),
    (error) => error.code === 'WMB_SOURCE_SNAPSHOT_STALE'
      && error.details?.implicitRebuild === false
  );
  assert.equal(git(root, ['rev-parse', 'state']), stateBefore);
});

test('a phase-scoped registered-v4 build remains exact for that phase when the repository catalog is broader', async (t) => {
  const root = await registeredRepository(t, { staleness: 'fail' });
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.views = ['dev.impact', 'biz.rules'];
  workflow.phases.intake.worldModel.views = ['dev.impact'];
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'configure broader registered view catalog']);

  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', phase: 'intake'
  }));
  const config = await loadWorldModelConfig(root);
  const resolved = resolveWorldModelV4Grounding(root, config, { phase: 'intake' });
  assert.equal(resolved.freshness.fresh, true);
  assert.deepEqual(resolved.views.map((entry) => entry.viewId), ['dev.impact']);
});

test('Initiative composition consumes the exact registered-v4 state projection', async (t) => {
  const root = await registeredRepository(t);
  const portfolioPath = path.join(root, 'singularity', 'portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities ?? {})) {
    authority.members = [{ name: 'WMB Test', email: 'wmb@example.invalid' }];
  }
  for (const phase of Object.values(portfolio.initiativePhases ?? {})) {
    if (phase.worldModelViews?.length) phase.worldModelViews = ['dev.impact'];
  }
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  git(root, ['add', 'singularity/portfolio.yml']);
  git(root, ['commit', '-q', '-m', 'configure registered views for Initiatives']);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic'
  }));

  git(root, ['switch', '-q', '-c', 'WMB-V4-INIT']);
  await createInitiative(root, {
    id: 'WMB-V4-INIT', title: 'Consume exact Initiative grounding',
    profile: 'initiative-lite', agent: 'product-owner'
  });
  const composed = await composeInitiativeContext(root, 'WMB-V4-INIT', 'define', {
    agent: 'product-owner'
  });
  assert.equal(composed.record.worldModel.available, true);
  assert.equal(composed.record.worldModel.format, 'registered-v4');
  assert.match(composed.rendered, /SFlow World-Model View/);
  assert.deepEqual(
    composed.record.worldModelFiles.map((entry) => entry.path),
    ['singularity/world-model/views/dev.impact.md']
  );
});

test('Capability context resolves exact registered-v4 sibling views without legacy parsing', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic'
  }));
  const config = await loadWorldModelConfig(root);
  const resolved = await resolveCapabilityWorldModelCandidate(root, config.definition, {
    views: ['dev.impact']
  });
  assert.equal(resolved.format, 'registered-v4');
  assert.equal(resolved.located.source, 'state-branch');
  assert.equal(resolved.resolved.selected.length, 1);
  assert.match(resolved.resolved.selected[0].body, /SFlow World-Model View/);
  assert.equal(resolved.manifestPath, null);
  assert.equal(resolved.sourceState.commit, git(root, ['rev-parse', 'HEAD']),
    'capability provenance binds the application source commit, not the state publication commit');
  assert.notEqual(resolved.sourceState.commit, resolved.located.commit);
});

test('the editor visualizes registered-v4 state even when no Story is active', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], {
    format: 'registered-v4', views: 'dev.impact', composer: 'deterministic'
  }));
  const snapshot = await repositorySnapshot(root);
  assert.deepEqual(
    { ready: snapshot.worldModel.readiness.ready, source: snapshot.worldModel.readiness.source },
    { ready: true, source: 'state-branch' }
  );
  const view = snapshot.worldModel.files.find((entry) => (
    entry.path === 'singularity/world-model/views/dev.impact.md'
  ));
  assert.ok(view);
  assert.match(view.content, /SFlow World-Model View/);
});

test('registered-v4 approved identity changes stale the store and --stale rebuilds the current policy', async (t) => {
  const root = await registeredRepository(t);
  await quiet(() => worldModelCommand(root, ['wm', 'build'], { views: 'dev.impact' }));

  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  let workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.maximumTraversalDepth = 7;
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'change approved WMB scope policy']);

  let status = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(status.fresh, false);
  assert.equal(status.freshness.reason, 'scope-manifest-changed');
  assert.ok(status.freshness.changes.some((entry) => entry.reason === 'policy-snapshot-changed'));

  let rebuilt = await quiet(() => worldModelCommand(root, ['wm', 'regenerate'], {
    stale: true, json: true
  }));
  assert.equal(rebuilt.status, 'completed');
  status = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(status.fresh, true);
  assert.equal(status.freshness.reason, null);

  workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.views = ['dev.impact', 'biz.rules'];
  workflow.worldModel.v4.consumer = 'architect';
  workflow.worldModel.v4.totalMaximumOutputTokens = 3000;
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, ['add', 'singularity/workflow.yml']);
  git(root, ['commit', '-q', '-m', 'change approved WMB reusable identity']);

  status = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(status.fresh, false);
  assert.ok(status.freshness.changes.some((entry) => entry.reason === 'view-selection-changed'));
  assert.ok(status.freshness.changes.some((entry) => entry.reason === 'consumer-profile-changed'));
  assert.ok(status.freshness.changes.some((entry) => entry.reason === 'output-budget-changed'));

  rebuilt = await quiet(() => worldModelCommand(root, ['wm', 'regenerate'], {
    stale: true, json: true
  }));
  assert.equal(rebuilt.status, 'completed');
  assert.deepEqual(rebuilt.views.map((entry) => entry.viewId), ['biz.rules', 'dev.impact']);
  status = await quiet(() => worldModelCommand(root, ['wm', 'status'], { json: true }));
  assert.equal(status.fresh, true);
  assert.deepEqual(status.views.map((entry) => entry.viewId), ['biz.rules', 'dev.impact']);
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

  const readiness = await inspectWorkflowGrounding(root, workflow, 'intake', {
    agent: 'product-owner', refreshRemote: false
  });
  assert.equal(readiness.format, 'registered-v4');
  assert.equal(readiness.availability.ready, true);
  assert.equal(readiness.availability.source, 'state-branch');
  assert.equal(readiness.availability.selected.manifest.format, 'wmb-v4');

  const nextsteps = spawnSync(process.execPath, [
    executable, 'nextsteps', 'WMB-V4-STORY', '--json'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(nextsteps.status, 0, nextsteps.stderr);
  assert.doesNotMatch(nextsteps.stderr, /schema_version must be/);
  assert.equal(JSON.parse(nextsteps.stdout).actions.some((action) => (
    action.command.includes('wm build') && action.timing === 'now'
  )), false, 'exact registered-v4 state is not reported as a missing legacy model');

  const editor = await repositorySnapshot(root, 'WMB-V4-STORY');
  assert.deepEqual(
    { ready: editor.worldModel.readiness.ready, source: editor.worldModel.readiness.source },
    { ready: true, source: 'state-branch' }
  );
  const editorView = editor.worldModel.files.find((entry) => (
    entry.path === 'singularity/world-model/views/dev.impact.md'
  ));
  assert.ok(editorView, 'the UI snapshot keeps an exact clickable registered-view path');
  assert.match(editorView.content, /SFlow World-Model View/);

  const planning = await createPlanningContext(root, {
    scope: 'work-item', id: 'WMB-V4-STORY', phase: 'intake',
    agent: 'product-owner', target: 'artifact'
  });
  assert.match(planning.context, /SFlow World-Model View/);
  assert.ok(planning.manifest.sources.some((entry) => (
    entry.kind === 'world-model'
      && entry.path === 'singularity/world-model/views/dev.impact.md'
  )), 'Plan mode consumes the exact registered view instead of parsing a legacy manifest');

  const brief = await composeContextBrief(root, {
    workId: 'WMB-V4-STORY', slice: 'world-model', maxOutputBytes: 24 * 1024
  });
  assert.equal(brief.payload.status, 'exact');
  assert.match(brief.payload.selections[0].content, /SFlow World-Model View/);
  const packet = await compileEvidencePacket(root, {
    workId: 'WMB-V4-STORY', phase: 'intake', requestedSlices: ['world-model'],
    maxOutputBytes: 24 * 1024
  });
  assert.match(JSON.stringify(packet), /SFlow World-Model View/);
  assert.doesNotMatch(JSON.stringify(packet), /schema_version must be/);

  const next = spawnSync(process.execPath, [executable, '--no-model', 'next'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WMB Test' }
  });
  assert.equal(next.status, 0, next.stderr);
  assert.match(next.stdout, /Next step prepared: generate 'intake'/);
  assert.doesNotMatch(next.stderr, /schema_version must be/);
  const verified = await verifyGroundingRecord(
    root, config, workflow, workflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.deepEqual(verified.errors, []);
  assert.deepEqual(verified.warnings, []);
  const prompt = await readFile(path.join(root, verified.record.promptPath), 'utf8');
  assert.match(prompt, /required repository world-model grounding/i);
  assert.match(prompt, /Repository grounding: singularity\/world-model\/views\/dev\.impact\.md/);
  assert.match(prompt, /SFlow World-Model View/);
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

test('advisory registered-v4 absence records a verifiable prompt without inventing world-model authority', async (t) => {
  const root = await registeredRepository(t);
  git(root, ['switch', '-q', '-c', 'WMB-V4-WARN']);
  const config = await loadConfig(root);
  config.git.publish = 'off';
  await setAgentSession(root, config, {
    name: 'WMB Test', email: 'wmb@example.invalid', login: null
  }, 'product-owner', 'WMB-V4-WARN', { phaseId: 'intake', source: 'test' });
  const workflow = await createWorkflow(root, config, {
    id: 'WMB-V4-WARN', title: 'Continue with advisory grounding absent',
    source: {
      type: 'manual', key: 'WMB-V4-WARN', title: 'Continue with advisory grounding absent',
      description: 'Prove advisory WMB absence remains verifiable without fabricating model evidence.',
      acceptanceCriteria: ['The governed prompt records an explicit advisory grounding absence.']
    },
    baseBranch: 'main', workType: 'feature', agent: 'product-owner',
    resolved: resolveWorkType(config, 'feature')
  });

  const composed = await composePhasePrompt(root, {
    workId: 'WMB-V4-WARN', phase: 'intake', agent: 'product-owner'
  });
  assert.match(composed, /Active Story phase contract/);

  const verified = await verifyGroundingRecord(
    root, config, workflow, workflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.deepEqual(verified.errors, []);
  assert.match(verified.warnings.join('\n'), /repository world-model grounding was unavailable/);
  assert.doesNotMatch(
    verified.warnings.join('\n'),
    /no committed world-model revision|invalid manifestSha256|contains no world-model files/
  );
  assert.deepEqual(verified.record.groundingAvailability, {
    status: 'unavailable', reasonCode: 'WMB_MANIFEST_MISSING'
  });
  assert.deepEqual(verified.record.requiredViews, ['dev.impact']);
  assert.deepEqual(
    verified.record.requiredSelections.map((entry) => `${entry.view}@${entry.version}`),
    ['dev.impact@4']
  );
  assert.equal(verified.record.worldModelCommit, null);
  assert.equal(verified.record.manifestSha256, null);
  assert.deepEqual(
    verified.record.files.filter((entry) => ['required', 'rule'].includes(entry.category)),
    []
  );

  const promptPath = path.join(root, verified.record.promptPath);
  await writeFile(promptPath, 'tampered governed prompt\n');
  const tampered = await verifyGroundingRecord(
    root, config, workflow, workflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.match(tampered.warnings.join('\n'), /prompt snapshot hash differs/);

  await writeFile(
    path.join(root, 'singularity/work-items/WMB-V4-WARN/source.json'),
    '{"changed":true}\n'
  );
  const sourceTampered = await verifyGroundingRecord(
    root, config, workflow, workflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.match(sourceTampered.warnings.join('\n'), /not bound to the current pinned Story source/);

  const enforcedWorkflow = structuredClone(workflow);
  enforcedWorkflow.resolution.worldModelGrounding = 'enforce';
  const enforced = await verifyGroundingRecord(
    root, config, enforcedWorkflow, enforcedWorkflow.phases.intake,
    { generation: 1, agent: 'product-owner' }
  );
  assert.doesNotMatch(enforced.errors.join('\n'), /repository world-model grounding was unavailable/);
  assert.match(enforced.warnings.join('\n'), /repository world-model grounding was unavailable/);
  assert.match(enforced.errors.join('\n'), /prompt snapshot hash differs/);
  assert.match(enforced.errors.join('\n'), /not bound to the current pinned Story source/);
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

  const captured = await captureStandardOutput(() => worldModelCommand(
    root, ['wm', 'migrate', 'legacy-impact.md'], { view: 'dev.impact', json: true }
  ));
  const migrated = captured.result;
  assert.equal(captured.output.length, 1, 'JSON migration writes exactly one stdout document');
  assert.equal(JSON.parse(captured.output[0]).receipt.receiptSha256,
    migrated.receipt.receiptSha256);
  const commit = migrated.publication.commit;
  assert.match(commit, /^[0-9a-f]{40}$/);
  const receiptPath = `singularity/world-model/migrations/${migrated.receipt.sourceViewSha256.replace(/^sha256:/, '')}.json`;
  const manifest = JSON.parse(git(root, ['show', `${commit}:singularity/world-model/manifest.json`]));
  const receipt = JSON.parse(git(root, ['show', `${commit}:${receiptPath}`]));
  const factLedger = JSON.parse(git(root, [
    'show', `${commit}:singularity/world-model/catalogs/facts.json`
  ]));
  const migratedUnavailable = factLedger.facts.find((fact) => (
    fact.status === 'unavailable'
      && fact.reason?.attemptedProducer === 'legacy-migration-resolution'
  ));
  assert.ok(migratedUnavailable, 'unresolved legacy claim becomes a registered unavailable Fact');
  const migratedView = git(root, [
    'show', `${commit}:singularity/world-model/views/dev.impact.md`
  ]);
  assert.match(migratedView, new RegExp(`\\[F:${migratedUnavailable.id}\\]`));
  assert.equal(manifest.format, 'wmb-v4');
  assert.equal(manifest.views.find((entry) => entry.viewId === 'dev.impact')?.viewSha256,
    migrated.receipt.targetViewSha256);
  assert.equal(receipt.receiptSha256, migrated.receipt.receiptSha256);
  assert.equal(receipt.targetViewSha256, migrated.receipt.targetViewSha256);
  assert.equal(receipt.factLedgerSha256, factLedger.ledgerSha256);
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
