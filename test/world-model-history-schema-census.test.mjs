import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { schemaCensus } from '../src/schema-census.mjs';
import { familyForStoredPath } from '../src/schema-migrations.mjs';
import { reinitializeWorkspaces } from '../src/workspace-reinitialize.mjs';

const digestHex = 'a'.repeat(64);
const retainedObjectDigestHex = 'b'.repeat(64);
const unreadableBindingDigestHex = 'c'.repeat(64);
const checkoutOnlyBindingDigestHex = 'd'.repeat(64);
const customHistoryDir = '.sflow/immutable-world-models';

async function repositoryFixture(t, { historyDir = customHistoryDir } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmp-custom-history-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const workspaceRoot = path.join(temporary, 'workspace');
  const repositoryRoot = path.join(workspaceRoot, 'repos', 'application');
  await mkdir(repositoryRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.name', 'WMP Test'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'wmp@example.test'], { cwd: repositoryRoot });
  await initializeDefinition(repositoryRoot);
  const definition = await loadDefinition(repositoryRoot);
  definition.worldModel.historyDir = historyDir;
  await writeFile(
    path.join(repositoryRoot, 'singularity', 'workflow.yml'),
    YAML.stringify(definition)
  );
  const modelDirectory = path.join(repositoryRoot, historyDir, 'models');
  await mkdir(modelDirectory, { recursive: true });
  await writeFile(
    path.join(modelDirectory, `${digestHex}.json`),
    '{"schemaVersion":1}\n'
  );
  const retainedObjectDirectory = path.join(
    repositoryRoot, historyDir, 'objects', 'sha256', 'bb'
  );
  await mkdir(retainedObjectDirectory, { recursive: true });
  await writeFile(
    path.join(retainedObjectDirectory, retainedObjectDigestHex),
    '{"schemaVersion":1,"kind":"world-model-view-inputs"}\n'
  );
  await writeFile(
    path.join(retainedObjectDirectory, 'must-not-be-generically-read.json'),
    '{"schemaVersion":\n'
  );

  const workspace = {
    version: 1,
    id: 'custom-history-workspace',
    name: 'Custom history workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'custom-history-workspace', title: 'Custom history workspace' },
    leadRepository: 'application',
    repositories: {
      application: {
        id: 'application',
        url: 'https://example.test/application.git',
        defaultBranch: 'main',
        required: true,
        path: 'repos/application',
        role: 'lead',
        capabilities: []
      }
    }
  };
  await writeFile(
    path.join(workspaceRoot, 'workspace.json'),
    `${JSON.stringify(workspace, null, 2)}\n`
  );
  const registryFile = path.join(temporary, 'workspaces.json');
  await writeFile(registryFile, `${JSON.stringify([{
    id: workspace.id,
    path: workspaceRoot,
    name: workspace.name,
    openedAt: '2026-09-12T00:00:00.000Z'
  }], null, 2)}\n`);
  return { historyDir, registryFile, repositoryRoot };
}

async function installUnreadableRemoteStateBinding(repositoryRoot, historyDir = customHistoryDir) {
  execFileSync('git', ['add', '.'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'application fixture'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'state-fixture'], { cwd: repositoryRoot });
  const binding = path.join(
    repositoryRoot, historyDir, 'models', `${unreadableBindingDigestHex}.json`
  );
  await writeFile(binding, '{"schemaVersion":1,"privateMaterial":\n');
  execFileSync('git', ['add', historyDir], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'unreadable state-only WMP binding'], {
    cwd: repositoryRoot
  });
  const stateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8'
  }).trim();
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });
  execFileSync('git', ['branch', '-D', 'state-fixture'], {
    cwd: repositoryRoot, stdio: 'ignore'
  });
  execFileSync('git', [
    'remote', 'add', 'origin', 'https://network-must-not-be-used.invalid/application.git'
  ], { cwd: repositoryRoot });
  execFileSync('git', ['update-ref', 'refs/heads/state', 'refs/heads/main'], {
    cwd: repositoryRoot
  });
  execFileSync('git', [
    'update-ref', 'refs/remotes/origin/state', stateCommit
  ], { cwd: repositoryRoot });
  return stateCommit;
}

test('custom WMP history roots route immutable bindings to their registered families', () => {
  const roots = { worldModelHistoryDir: customHistoryDir };
  assert.equal(
    familyForStoredPath(`${customHistoryDir}/models/${digestHex}.json`, roots)?.id,
    'world-model-model-binding'
  );
  assert.equal(
    familyForStoredPath(`${customHistoryDir}/views/${digestHex}.json`, roots)?.id,
    'world-model-view-binding'
  );
  assert.equal(
    familyForStoredPath(`${customHistoryDir}/handoffs/${digestHex}.json`, roots)?.id,
    'world-model-handoff'
  );
  assert.equal(familyForStoredPath(`${customHistoryDir}-other/models/${digestHex}.json`, roots), null);
});

test('schema census scans and validates a configured WMP history root outside singularity', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  const census = await schemaCensus(repositoryRoot);
  const modelBindings = census.families.find((entry) =>
    entry.family === 'world-model-model-binding');
  assert.equal(modelBindings.records, 1);
  assert.equal(modelBindings.validatedRecords, 1);
  assert.equal(census.unregistered.some((entry) =>
    entry.path.endsWith(`/models/${digestHex}.json`)), false);
  assert.equal(census.totals.unregistered, 0);
  assert.equal(census.scanned, 1,
    'extensionless retained objects are validated through their owning ObjectRef, not guessed by census');
});

test('legacy v3 World Model manifests are migration advisories, not corrupt v4 records', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  const manifest = path.join(repositoryRoot, 'singularity', 'world-model', 'manifest.json');
  await mkdir(path.dirname(manifest), { recursive: true });
  await writeFile(manifest, JSON.stringify({
    schema_version: '2.0',
    repository_commit: 'a'.repeat(40),
    views_generated: ['architecture']
  }));

  const legacy = await schemaCensus(repositoryRoot);
  assert.equal(legacy.healthy, true, JSON.stringify(legacy.unreadable));
  assert.ok(legacy.unregistered.some((entry) =>
    entry.path === 'singularity/world-model/manifest.json'
      && entry.code === 'WMB_LEGACY_MANIFEST'));

  await writeFile(manifest, JSON.stringify({
    kind: 'world-model-manifest',
    format: 'wmb-v4'
  }));
  const malformedV4 = await schemaCensus(repositoryRoot);
  assert.equal(malformedV4.healthy, false);
  assert.ok(malformedV4.unreadable.some((entry) =>
    entry.path === 'singularity/world-model/manifest.json'
      && entry.code === 'SCHEMA_VERSION_MISSING'));
});

test('schema census can bind configuration and state to an exact approved checkout', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  const authorityRoot = path.resolve(repositoryRoot, '../../../approved-authority');
  const approvedHistoryDir = '.approved/world-model-history';
  await mkdir(authorityRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: authorityRoot });
  execFileSync('git', ['config', 'user.name', 'WMP Authority Test'], { cwd: authorityRoot });
  execFileSync('git', ['config', 'user.email', 'authority@example.test'], { cwd: authorityRoot });
  await initializeDefinition(authorityRoot);
  const approved = await loadDefinition(authorityRoot);
  approved.worldModel.historyDir = approvedHistoryDir;
  await writeFile(
    path.join(authorityRoot, 'singularity', 'workflow.yml'), YAML.stringify(approved)
  );
  await mkdir(path.join(authorityRoot, approvedHistoryDir, 'models'), { recursive: true });
  await installUnreadableRemoteStateBinding(authorityRoot, approvedHistoryDir);

  const census = await schemaCensus(repositoryRoot, {
    configurationRoot: authorityRoot,
    stateAuthorityRoot: authorityRoot
  });
  assert.equal(census.healthy, false);
  assert.equal(census.totals.unreadable, 1);
  assert.equal(census.unreadable[0].path,
    `$state/${approvedHistoryDir}/models/${unreadableBindingDigestHex}.json`);
  assert.ok(census.roots.includes(`$state/${approvedHistoryDir}/`));
  assert.equal(census.roots.includes(`$state/${customHistoryDir}/`), false);
});

test('schema census fails closed when an explicit approved configuration cannot be loaded', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  const authorityRoot = path.resolve(repositoryRoot, '../../../invalid-approved-authority');
  await mkdir(authorityRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: authorityRoot });
  await initializeDefinition(authorityRoot);
  await writeFile(path.join(authorityRoot, 'singularity', 'portfolio.yml'), 'version: [invalid\n');

  await assert.rejects(
    () => schemaCensus(repositoryRoot, {
      configurationRoot: authorityRoot,
      stateAuthorityRoot: authorityRoot
    }),
    /portfolio|unexpected|flow|collection/i
  );
});

test('workspace reinitialize includes configured WMP history in its schema-readiness census', async (t) => {
  const { registryFile } = await repositoryFixture(t);
  let customHistoryObserved = false;
  const refreshWorkspaceConfigurations = async ({ dryRun }) => ({
    status: 'preview',
    dryRun,
    planId: 'cfgp-1234567890abcdef12345678',
    total: 1,
    updated: 0,
    failed: 0,
    results: [{
      status: 'current',
      repository: 'application',
      remote: 'https://example.test/application.git',
      memberships: [{
        workspaceId: 'custom-history-workspace',
        workspaceName: 'Custom history workspace',
        repositoryId: 'application'
      }],
      configurationChanged: false,
      stateChanged: false
    }]
  });

  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, {
    refreshWorkspaceConfigurations,
    observeLeadConfiguration: async () => ({ status: 'current', commit: 'b'.repeat(40) }),
    schemaCensus: async (root) => {
      const census = await schemaCensus(root);
      customHistoryObserved = census.families.some((entry) =>
        entry.family === 'world-model-model-binding'
          && entry.records === 1
          && entry.validatedRecords === 1);
      return census;
    }
  });
  assert.ok(preview.schemaCensuses?.length, JSON.stringify(preview));
  assert.equal(preview.status, 'preview');
  assert.equal(customHistoryObserved, true);
  assert.equal(preview.schemaCensuses[0].records >= 1, true);
  assert.equal(preview.schemaCensuses[0].unregistered, 0);
});

test('state-authority WMP bindings participate in census and block reinitialize when unreadable', async (t) => {
  const { registryFile, repositoryRoot } = await repositoryFixture(t);
  const stateCommit = await installUnreadableRemoteStateBinding(repositoryRoot);
  await writeFile(path.join(
    repositoryRoot, customHistoryDir, 'models', `${checkoutOnlyBindingDigestHex}.json`
  ), '{"schemaVersion":\n');
  const before = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim(),
    status: execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }),
    state: execFileSync('git', ['rev-parse', 'refs/remotes/origin/state'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim(),
    localState: execFileSync('git', ['rev-parse', 'refs/heads/state'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim()
  };

  const census = await schemaCensus(repositoryRoot);
  assert.equal(census.healthy, false);
  assert.equal(census.totals.unreadable, 1);
  assert.equal(census.totals.unregistered, 0,
    'extensionless retained objects stay inert without an owning ObjectRef');
  assert.deepEqual(census.unreadable[0], {
    path: `$state/${customHistoryDir}/models/${unreadableBindingDigestHex}.json`,
    code: 'SCHEMA_CENSUS_JSON_INVALID',
    reason: 'record is not valid JSON'
  });
  assert.ok(census.roots.includes(`$state/${customHistoryDir}/`));
  const modelBindings = census.families.find((entry) =>
    entry.family === 'world-model-model-binding');
  assert.equal(modelBindings.records, 1,
    'the authoritative state binding is counted once and checkout history is not substituted');

  const refreshWorkspaceConfigurations = async ({ dryRun }) => ({
    status: 'preview',
    dryRun,
    planId: 'cfgp-1234567890abcdef12345678',
    total: 1,
    updated: 0,
    failed: 0,
    results: [{
      status: 'current',
      repository: 'application',
      remote: 'https://example.test/application.git',
      memberships: [{
        workspaceId: 'custom-history-workspace',
        workspaceName: 'Custom history workspace',
        repositoryId: 'application'
      }],
      configurationChanged: false,
      stateChanged: false
    }]
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, {
    refreshWorkspaceConfigurations,
    observeLeadConfiguration: async () => ({ status: 'current', commit: 'b'.repeat(40) })
  });
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.planId, null);
  assert.equal(preview.schemaCensuses[0].status, 'attention-required');
  assert.equal(preview.schemaCensuses[0].unreadable, 1);

  const after = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim(),
    status: execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }),
    state: execFileSync('git', ['rev-parse', 'refs/remotes/origin/state'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim(),
    localState: execFileSync('git', ['rev-parse', 'refs/heads/state'], {
      cwd: repositoryRoot, encoding: 'utf8'
    }).trim()
  };
  assert.deepEqual(after, before, 'census and reinitialize preview must not mutate the checkout or authority ref');
  assert.equal(after.state, stateCommit);
});

test('an authoritative state ref excludes a checkout history root selected as .sdlc', async (t) => {
  const historyDir = '.sdlc';
  const { repositoryRoot } = await repositoryFixture(t, { historyDir });
  await installUnreadableRemoteStateBinding(repositoryRoot, historyDir);
  await writeFile(path.join(
    repositoryRoot, historyDir, 'models', `${checkoutOnlyBindingDigestHex}.json`
  ), '{"schemaVersion":\n');
  const lifecycleDirectory = path.join(repositoryRoot, '.sdlc', 'work-items', 'WMP-CENSUS');
  await mkdir(lifecycleDirectory, { recursive: true });
  await writeFile(
    path.join(lifecycleDirectory, 'workflow.json'),
    '{"schemaVersion":99}\n'
  );

  const census = await schemaCensus(repositoryRoot);
  assert.equal(census.totals.unreadable, 1);
  assert.equal(census.totals.outsideRange, 1,
    'unrelated .sdlc lifecycle records must remain in migration readiness');
  assert.equal(census.unreadable[0].path,
    `$state/${historyDir}/models/${unreadableBindingDigestHex}.json`);
  assert.equal(census.families.find((entry) =>
    entry.family === 'world-model-model-binding').records, 1,
    'the selected .sdlc scan root must not re-enter checkout history beneath state authority');
  assert.equal(census.families.find((entry) =>
    entry.family === 'story-workflow').outsideRange.length, 1);
});

test('configured remote authority never falls back to an unpublished local state branch', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '.'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'application fixture'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'state'], { cwd: repositoryRoot });
  await writeFile(path.join(
    repositoryRoot, customHistoryDir, 'models', `${unreadableBindingDigestHex}.json`
  ), '{"schemaVersion":\n');
  execFileSync('git', ['add', customHistoryDir], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'unpublished unreadable local binding'], {
    cwd: repositoryRoot
  });
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });
  execFileSync('git', [
    'remote', 'add', 'origin', 'https://network-must-not-be-used.invalid/application.git'
  ], { cwd: repositoryRoot });

  const census = await schemaCensus(repositoryRoot);
  assert.equal(census.healthy, true);
  assert.equal(census.totals.unreadable, 0);
  assert.equal(census.roots.includes(`$state/${customHistoryDir}/`), false);
  assert.equal(census.families.find((entry) =>
    entry.family === 'world-model-model-binding').records, 1,
    'the legacy checkout record remains visible while unpublished local state is not authority');
});

test('registered-v4 census requires its configured state authority to be materialized', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  const definition = await loadDefinition(repositoryRoot);
  definition.worldModel.format = 'registered-v4';
  definition.worldModel.views = ['dev.impact@4'];
  definition.worldModel.promptSource = 'builtin';
  await writeFile(
    path.join(repositoryRoot, 'singularity', 'prompts', 'worldmodel-builder.md'),
    '# Registered-v4 census fixture\n'
  );
  const agentViewPattern = /sflow-world-model-views:\s*(?:"[^"\r\n]*"|[^\r\n]*)/g;
  for (const phase of Object.values(definition.phases ?? {})) {
    if (phase.worldModel?.views) phase.worldModel.views = ['dev.impact'];
  }
  for (const agent of Object.values(definition.agents ?? {})) {
    if (agent.worldModelViews) agent.worldModelViews = ['dev.impact'];
    if (agent.file && agent.text) {
      const relativeAgentFile = path.relative(repositoryRoot, agent.file);
      const fixtureOwned = relativeAgentFile !== '..'
        && !relativeAgentFile.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativeAgentFile);
      if (fixtureOwned) {
        await writeFile(agent.file, agent.text.replace(
          agentViewPattern, 'sflow-world-model-views: dev.impact'
        ));
      }
    }
  }
  for (const workType of Object.values(definition.workTypes ?? {})) {
    for (const override of Object.values(workType.phaseOverrides ?? {})) {
      if (override.worldModel?.views) override.worldModel.views = ['dev.impact'];
    }
  }
  const rewriteEmbeddedAgentViews = (value) => {
    if (Array.isArray(value)) {
      value.forEach(rewriteEmbeddedAgentViews);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'worldModelViews') value[key] = ['dev.impact'];
      else if (key === 'sflow-world-model-views') value[key] = 'dev.impact';
      else rewriteEmbeddedAgentViews(nested);
    }
  };
  rewriteEmbeddedAgentViews(definition.agents);
  if (definition.worldModel.injection?.rules) definition.worldModel.injection.rules = [];
  const registeredDefinition = YAML.stringify(definition).replace(
    agentViewPattern,
    'sflow-world-model-views: dev.impact'
  );
  await writeFile(
    path.join(repositoryRoot, 'singularity', 'workflow.yml'),
    registeredDefinition
  );
  execFileSync('git', [
    'remote', 'add', 'origin', 'https://network-must-not-be-used.invalid/application.git'
  ], { cwd: repositoryRoot });
  assert.equal((await loadDefinition(repositoryRoot)).worldModel.format, 'registered-v4');

  const census = await schemaCensus(repositoryRoot);
  assert.equal(census.healthy, false);
  assert.equal(census.totals.unreadable, 1);
  assert.deepEqual(census.unreadable[0], {
    path: `$state/${customHistoryDir}/`,
    code: 'SCHEMA_CENSUS_STATE_AUTHORITY_REFRESH_REQUIRED',
    reason: 'registered-v4 state authority is not materialized locally; refresh it before migration readiness is evaluated'
  });
  assert.equal(census.families.some((entry) =>
    entry.family === 'world-model-model-binding'), false,
  'checkout history must not substitute for missing registered-v4 authority');
});

test('reinitialization census finds non-current local and remote-tracking lifecycle records once', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'lifecycle-future'], { cwd: repositoryRoot });
  const record = path.join(
    repositoryRoot, 'singularity', 'work-items', 'REF-FUTURE', 'workflow.json'
  );
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, '{"schemaVersion":99}\n');
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'future lifecycle record'], { cwd: repositoryRoot });
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8'
  }).trim();
  execFileSync('git', [
    'update-ref', 'refs/remotes/origin/lifecycle-future', commit
  ], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });

  const census = await schemaCensus(repositoryRoot, { includeLifecycleRefs: true });
  const story = census.families.find((entry) => entry.family === 'story-workflow');
  assert.equal(census.healthy, false);
  assert.equal(story.outsideRange.length, 1,
    'the same path/blob shared by local and remote-tracking refs is counted once');
  assert.deepEqual(census.lifecycleRefs, [
    { ref: 'refs/heads/lifecycle-future', commit },
    { ref: 'refs/remotes/origin/lifecycle-future', commit }
  ]);

  execFileSync('git', ['branch', '-D', 'lifecycle-future'], {
    cwd: repositoryRoot, stdio: 'ignore'
  });
  const remoteOnly = await schemaCensus(repositoryRoot, { includeLifecycleRefs: true });
  assert.equal(remoteOnly.families.find((entry) =>
    entry.family === 'story-workflow').outsideRange.length, 1);
  assert.deepEqual(remoteOnly.lifecycleRefs, [
    { ref: 'refs/remotes/origin/lifecycle-future', commit }
  ]);
});

test('lifecycle census uses each branch configuration to classify a historical custom root', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'custom-lifecycle-root'], {
    cwd: repositoryRoot
  });
  const definition = await loadDefinition(repositoryRoot);
  definition.workItemRoot = 'legacy/work-items';
  await writeFile(
    path.join(repositoryRoot, 'singularity', 'workflow.yml'), YAML.stringify(definition)
  );
  const record = path.join(repositoryRoot, 'legacy', 'work-items', 'CUSTOM-1', 'workflow.json');
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, '{"schemaVersion":99}\n');
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'custom-root lifecycle record'], {
    cwd: repositoryRoot
  });
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });

  const census = await schemaCensus(repositoryRoot, { includeLifecycleRefs: true });
  const story = census.families.find((entry) => entry.family === 'story-workflow');
  assert.equal(census.healthy, false);
  assert.deepEqual(story.outsideRange, [{
    path: '$ref/refs/heads/custom-lifecycle-root/legacy/work-items/CUSTOM-1/workflow.json',
    storedVersion: 99
  }]);
});

test('lifecycle census fails closed when an advertised ref object is missing locally', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'missing-lifecycle-object'], {
    cwd: repositoryRoot
  });
  const record = path.join(
    repositoryRoot, 'singularity', 'work-items', 'MISSING-1', 'workflow.json'
  );
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, '{"schemaVersion":98,"missingObjectFixture":true}\n');
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'record whose blob will be absent'], {
    cwd: repositoryRoot
  });
  const blob = execFileSync('git', [
    'rev-parse', 'HEAD:singularity/work-items/MISSING-1/workflow.json'
  ], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });
  await rm(path.join(repositoryRoot, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), {
    force: true
  });

  const census = await schemaCensus(repositoryRoot, { includeLifecycleRefs: true });
  assert.equal(census.healthy, false);
  assert.ok(census.unreadable.some((entry) =>
    entry.path.startsWith('$ref/refs/heads/missing-lifecycle-object/')
      && ['SCHEMA_CENSUS_LIFECYCLE_REF_OBJECT_MISSING',
        'SCHEMA_CENSUS_LIFECYCLE_REF_UNAVAILABLE'].includes(entry.code)),
  JSON.stringify(census.unreadable));
});

test('lifecycle-ref scan is explicit and its ref bound is fail-closed', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['branch', 'another-local-ref'], { cwd: repositoryRoot });

  const ordinary = await schemaCensus(repositoryRoot, { maximumRefs: 1 });
  assert.equal(ordinary.truncated, false);
  assert.deepEqual(ordinary.lifecycleRefs, []);
  assert.equal(ordinary.roots.includes('$refs/'), false,
    'ordinary diagnostics do not enumerate lifecycle refs');

  const migration = await schemaCensus(repositoryRoot, {
    includeLifecycleRefs: true,
    maximumRefs: 1
  });
  assert.equal(migration.truncated, true);
  assert.ok(migration.roots.includes('$refs/'));
});

test('one lifecycle ref cannot exceed the aggregate byte admission ceiling', async (t) => {
  const { repositoryRoot } = await repositoryFixture(t);
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', 'aggregate-lifecycle-bytes'], {
    cwd: repositoryRoot
  });
  for (let index = 1; index <= 3; index += 1) {
    const record = JSON.stringify({ schemaVersion: 99, fixture: index });
    const contents = `${record}${' '.repeat(1024 - record.length - 1)}\n`;
    const target = path.join(
      repositoryRoot, 'singularity', 'work-items', `AGGREGATE-${index}`, 'workflow.json'
    );
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  execFileSync('git', ['add', '-A'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'aggregate lifecycle fixtures'], {
    cwd: repositoryRoot
  });
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });

  const census = await schemaCensus(repositoryRoot, {
    includeLifecycleRefs: true,
    maximumLifecycleBytes: 2048
  });
  const branchRecords = census.families
    .find((entry) => entry.family === 'story-workflow')
    ?.outsideRange.filter((entry) => entry.path.includes('/aggregate-lifecycle-bytes/')) ?? [];
  assert.equal(census.truncated, true);
  assert.equal(branchRecords.length, 2,
    'the third individually valid 1 KiB record is not materialized after the 2 KiB aggregate cap');
});
