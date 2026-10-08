import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import {
  REINITIALIZATION_SCHEMA_POLICY, reinitializeWorkspaces
} from '../src/workspace-reinitialize.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-reinitialize-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, 'workspace');
  const repositoryRoot = path.join(workspaceRoot, 'repos', 'application');
  await mkdir(repositoryRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repositoryRoot });
  await mkdir(path.join(repositoryRoot, '.git', 'singularity-flow'), { recursive: true });
  // session-registry v1 remains byte-for-byte historical; its reader deterministically presents v2.
  await writeFile(path.join(repositoryRoot, '.git', 'singularity-flow', 'session.json'),
    '{"schemaVersion":1,"sessions":{}}\n');
  const manifest = {
    version: 1,
    id: 'demo-workspace',
    name: 'Demo workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'demo-workspace', title: 'Demo workspace' },
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
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const registryFile = path.join(root, 'workspaces.json');
  await writeFile(registryFile, `${JSON.stringify([{
    id: manifest.id,
    path: workspaceRoot,
    name: manifest.name,
    openedAt: '2026-09-01T00:00:00.000Z'
  }], null, 2)}\n`);
  return { registryFile, workspaceRoot, repositoryRoot };
}

function refreshResult(status, { dryRun, itemStatus }) {
  return {
    status,
    dryRun,
    planId: 'cfgp-1234567890abcdef12345678',
    total: 1,
    updated: itemStatus === 'updated' ? 1 : 0,
    failed: 0,
    results: [{
      status: itemStatus,
      repository: 'application',
      remote: 'https://example.test/application.git',
      memberships: [{
        workspaceId: 'demo-workspace',
        workspaceName: 'Demo workspace',
        repositoryId: 'application'
      }],
      configurationChanged: itemStatus === 'updated' || itemStatus === 'would-update',
      stateChanged: itemStatus === 'updated' || itemStatus === 'would-update',
      ...(!dryRun && ['current', 'updated'].includes(itemStatus)
        ? { configurationCommit: 'a'.repeat(40) } : {})
    }]
  };
}

const authorityBefore = 'c'.repeat(40);

function services(overrides = {}) {
  return { ...overrides };
}

async function installMovableLifecycleRef(repositoryRoot, branch = 'lifecycle-plan') {
  execFileSync('git', ['config', 'user.name', 'Reinitialize Test'], { cwd: repositoryRoot });
  execFileSync('git', ['config', 'user.email', 'reinitialize@example.test'], {
    cwd: repositoryRoot
  });
  await writeFile(path.join(repositoryRoot, 'application.txt'), 'application source\n');
  execFileSync('git', ['add', 'application.txt'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'application baseline'], { cwd: repositoryRoot });
  execFileSync('git', ['switch', '-q', '-c', branch], { cwd: repositoryRoot });
  const probe = path.join(repositoryRoot, 'singularity', 'migration-probe.json');
  await mkdir(path.dirname(probe), { recursive: true });
  await writeFile(probe, '{"schemaVersion":1,"kind":"migration-probe"}\n');
  execFileSync('git', ['add', 'singularity/migration-probe.json'], { cwd: repositoryRoot });
  execFileSync('git', ['commit', '-qm', 'lifecycle schema probe'], { cwd: repositoryRoot });
  const reviewed = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8'
  }).trim();
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'advance lifecycle ref'], {
    cwd: repositoryRoot
  });
  const advanced = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8'
  }).trim();
  execFileSync('git', ['switch', '-q', 'main'], { cwd: repositoryRoot });
  execFileSync('git', ['update-ref', `refs/heads/${branch}`, reviewed], {
    cwd: repositoryRoot
  });
  return { branch, reviewed, advanced };
}

function deliveryRefreshResult(status, { dryRun, itemStatus }) {
  return {
    ...refreshResult(status, { dryRun, itemStatus }),
    results: [{
      status: itemStatus,
      repository: 'delivery',
      remote: 'https://example.test/delivery.git',
      memberships: [{
        workspaceId: 'demo-workspace', workspaceName: 'Demo workspace',
        repositoryId: 'delivery'
      }],
      ...(!dryRun ? { configurationCommit: 'b'.repeat(40) } : {}),
      configurationChanged: itemStatus === 'updated' || itemStatus === 'would-update',
      stateChanged: itemStatus === 'updated' || itemStatus === 'would-update'
    }]
  };
}

function deliveryWorkspace(workspaceRoot) {
  return {
    version: 1, id: 'demo-workspace', name: 'Demo workspace', path: workspaceRoot,
    leadRepository: 'application',
    repositories: {
      application: {
        id: 'application', url: 'https://example.test/application.git',
        path: 'repos/application', role: 'lead'
      },
      delivery: {
        id: 'delivery', url: 'https://example.test/delivery.git',
        // Reusing the fixture checkout is sufficient here: topology binds both the selected
        // remote identity and the exact registered path, while avoiding an unrelated Git setup.
        path: 'repos/application', role: 'delivery'
      }
    }
  };
}

test('workspace reinitialize is plan-first with structured shell-safe recovery', async (t) => {
  const { registryFile } = await fixture(t);
  await assert.rejects(
    reinitializeWorkspaces({ registryFile, workspace: "team's demo" }),
    (error) => {
      assert.equal(error.code, 'WORKSPACE_REINITIALIZE_CONFIRMATION_REQUIRED');
      assert.deepEqual(error.details.nextAction.argv, [
        'singularity-flow', 'workspace', 'reinitialize', "team's demo", '--dry-run', '--json'
      ]);
      assert.equal(error.details.nextAction.shell,
        process.platform === 'win32' ? 'powershell' : 'posix');
      if (process.platform === 'win32') {
        assert.match(error.details.nextAction.command, /'team''s demo'/);
      } else {
        assert.match(error.details.nextAction.command, /'team'"'"'s demo'/);
      }
      const guidance = safeCommandGuidance(error.details.nextAction);
      assert.ok(guidance, 'workspace reinitialize recovery must be presentable');
      assert.equal(guidance.skill, '/sf-admin');
      assert.equal(guidance.copilotCommand, '/sf-admin');
      return true;
    }
  );
  await assert.rejects(
    reinitializeWorkspaces({ registryFile, dryRun: true, confirmPlan: 'cfgp-old' }),
    (error) => error.code === 'WORKSPACE_REINITIALIZE_MODE_CONFLICT'
  );
  await assert.rejects(
    reinitializeWorkspaces({ registryFile, confirmPlan: 'cfgp-1234567890abcdef12345678' }),
    (error) => error.code === 'WORKSPACE_REINITIALIZE_PLAN_INVALID'
  );
});

test('workspace reinitialize refuses every packaged ownership-transfer shortcut before preview', async (t) => {
  const { registryFile } = await fixture(t);
  let refreshCalls = 0;
  const refreshWorkspaceConfigurations = async () => {
    refreshCalls += 1;
    throw new Error('refresh must not run');
  };

  for (const input of [
    { acceptBundledConflicts: true },
    { resolutions: { '.github/agents/developer.agent.md': 'bundled' } },
    { resolutions: { 'workflow.workTypes.feature': 'merge' } }
  ]) {
    await assert.rejects(
      reinitializeWorkspaces({ registryFile, dryRun: true, ...input }, {
        refreshWorkspaceConfigurations
      }),
      (error) => error?.code === 'WORKSPACE_REINITIALIZE_OWNERSHIP_TRANSFER_UNSUPPORTED'
    );
  }
  assert.equal(refreshCalls, 0, 'ownership transfer must be rejected before any authority preview');
});

test('workspace reinitialize refuses a corrupt registry instead of issuing a zero-target plan', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-reinitialize-invalid-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryFile = path.join(root, 'workspaces.json');
  await writeFile(registryFile, '{"schemaVersion":1,"workspaces":[');

  await assert.rejects(
    () => reinitializeWorkspaces({ registryFile, dryRun: true }),
    (error) => error?.name === 'SingularityFlowError'
      && error.code === 'WORKSPACE_REGISTRY_INVALID'
  );
});

test('preview binds a compound plan, stays read-only, and reports read-time migration', async (t) => {
  const { registryFile } = await fixture(t);
  let capabilityPublications = 0;
  const result = await reinitializeWorkspaces({ registryFile, dryRun: true }, services({
    refreshWorkspaceConfigurations: async (options) => {
      assert.equal(options.dryRun, true);
      assert.equal(options.restorePackagedSeeds, true,
        'workspace reinitialize explicitly restores framework seeds');
      return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
    },
    publishOrganisationCapabilityMap: async () => { capabilityPublications += 1; }
  }));
  assert.equal(result.status, 'preview');
  assert.match(result.planId, /^wrip-1234567890abcdef12345678-[a-f0-9]{64}$/);
  assert.equal(result.configurationPlanId, 'cfgp-1234567890abcdef12345678');
  assert.equal(capabilityPublications, 0, 'preview cannot publish capability maps or locators');
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.equal(result.capabilityPortability.changed, false);
  assert.match(result.capabilityPortability.statement, /User-owned capability definitions remain unchanged/);
  assert.deepEqual(result.capabilityPortability.plannedLeads, []);
  assert.deepEqual(result.capabilityPortability.results, []);
  assert.equal(result.schemaCensuses[0].status, 'read-time-compatible');
  assert.equal(result.schemaCensuses[0].readTimeMigrationRecords, 1);
  assert.equal(result.schemaCensuses[0].readTimeMigrationSteps, 1);
  assert.deepEqual(result.schemaCensuses[0].migrations, [{
    family: 'session-registry', currentVersion: 2, storedVersions: [1], records: 1, steps: 1
  }]);
  assert.equal(result.schemaMigrationPolicy, REINITIALIZATION_SCHEMA_POLICY);
  assert.equal(result.schemaMigrationPolicy.immutableRecordsRewritten, false);
  assert.deepEqual(result.nextAction.argv.slice(-3), ['--confirm-plan', result.planId, '--json']);
});

test('preview derives schema roots from the exact approved configuration candidate', async (t) => {
  const { registryFile, repositoryRoot } = await fixture(t);
  const authorityRoot = path.join(path.dirname(registryFile), 'approved-configuration');
  await mkdir(authorityRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'sflow/config'], { cwd: authorityRoot });
  await initializeDefinition(authorityRoot);
  const approved = await loadDefinition(authorityRoot);
  approved.workItemRoot = 'approved/work-items';
  await writeFile(
    path.join(authorityRoot, 'singularity', 'workflow.yml'), YAML.stringify(approved)
  );
  const futureRecord = path.join(
    repositoryRoot, 'approved', 'work-items', 'FUTURE-1', 'workflow.json'
  );
  await mkdir(path.dirname(futureRecord), { recursive: true });
  await writeFile(futureRecord, '{"schemaVersion":99}\n');

  const refreshWorkspaceConfigurations = async (options) => {
    let blocked = false;
    try {
      await options.inspectCandidate?.({
        root: authorityRoot,
        sourceCommit: 'd'.repeat(40),
        stateBefore: { stateCommit: null },
        repository: {
          localPath: repositoryRoot,
          localPaths: [repositoryRoot]
        }
      });
    } catch (error) {
      assert.equal(error.code, 'WORKSPACE_REINITIALIZE_SCHEMA_BLOCKED');
      blocked = true;
    }
    const refresh = refreshResult(blocked ? 'blocked' : 'preview', {
      dryRun: true, itemStatus: blocked ? 'blocked' : 'current'
    });
    if (blocked) refresh.planId = null;
    return refresh;
  };
  const result = await reinitializeWorkspaces({ registryFile, dryRun: true }, services({
    refreshWorkspaceConfigurations
  }));

  assert.equal(result.status, 'blocked', JSON.stringify(result.schemaCensuses));
  assert.equal(result.planId, null);
  assert.equal(result.schemaCensuses[0].outsideReadableRange, 1);
  assert.deepEqual(result.schemaCensuses[0].schemaAuthority, {
    source: 'approved-configuration-candidate',
    configurationSourceCommit: 'd'.repeat(40),
    stateAuthorityCommit: null
  });
});

test('a schema blocker appearing after preview stops configuration publication', async (t) => {
  const { registryFile, repositoryRoot } = await fixture(t);
  const authorityRoot = path.join(path.dirname(registryFile), 'race-authority');
  await mkdir(authorityRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'sflow/config'], { cwd: authorityRoot });
  await initializeDefinition(authorityRoot);
  let published = false;
  const refreshWorkspaceConfigurations = async (options) => {
    if (!options.dryRun) {
      const futureRecord = path.join(
        repositoryRoot, 'singularity', 'work-items', 'RACE-1', 'workflow.json'
      );
      await mkdir(path.dirname(futureRecord), { recursive: true });
      await writeFile(futureRecord, '{"schemaVersion":99}\n');
    }
    try {
      await options.inspectCandidate?.({
        root: authorityRoot,
        sourceCommit: authorityBefore,
        stateBefore: { stateCommit: null },
        repository: { localPath: repositoryRoot, localPaths: [repositoryRoot] }
      });
    } catch (error) {
      assert.equal(error.code, 'WORKSPACE_REINITIALIZE_SCHEMA_BLOCKED');
      return refreshResult('blocked', { dryRun: options.dryRun, itemStatus: 'failed' });
    }
    if (!options.dryRun) published = true;
    return refreshResult(options.dryRun ? 'preview' : 'complete', {
      dryRun: options.dryRun,
      itemStatus: options.dryRun ? 'current' : 'updated'
    });
  };
  const service = services({ refreshWorkspaceConfigurations });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.equal(preview.status, 'preview');

  const result = await reinitializeWorkspaces({
    registryFile, confirmPlan: preview.planId
  }, service);
  assert.equal(result.status, 'blocked');
  assert.equal(published, false,
    'the second authority-bound census must finish before configuration publication');
  assert.equal(result.schemaCensuses[0].outsideReadableRange, 1);
});

test('compound plan binds lifecycle-ref SHAs before any configuration mutation', async (t) => {
  const { registryFile, repositoryRoot } = await fixture(t);
  const lifecycle = await installMovableLifecycleRef(repositoryRoot);
  let refreshMutations = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (!options.dryRun) refreshMutations += 1;
      return refreshResult(options.dryRun ? 'preview' : 'complete', {
        dryRun: options.dryRun,
        itemStatus: options.dryRun ? 'current' : 'updated'
      });
    }
  });

  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.equal(preview.status, 'preview');
  assert.deepEqual(preview.schemaCensuses[0].lifecycleRefs, [{
    ref: `refs/heads/${lifecycle.branch}`,
    commit: lifecycle.reviewed
  }]);

  execFileSync('git', [
    'update-ref', `refs/heads/${lifecycle.branch}`, lifecycle.advanced, lifecycle.reviewed
  ], { cwd: repositoryRoot });
  const result = await reinitializeWorkspaces({
    registryFile,
    confirmPlan: preview.planId
  }, service);
  assert.equal(result.status, 'blocked');
  assert.equal(result.topologyStatus, 'stale-plan');
  assert.equal(refreshMutations, 0,
    'a lifecycle ref that moved after review must invalidate wrip before apply begins');
});

test('lifecycle refs are rechecked in the final candidate preflight before publication', async (t) => {
  const { registryFile, repositoryRoot } = await fixture(t);
  const lifecycle = await installMovableLifecycleRef(repositoryRoot, 'lifecycle-apply-race');
  const authorityRoot = path.join(path.dirname(registryFile), 'candidate-authority');
  await mkdir(authorityRoot, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'sflow/config'], { cwd: authorityRoot });
  await initializeDefinition(authorityRoot);
  let publicationStarted = false;
  let applyRaceInjected = false;
  let observedFailure = null;
  const refreshWorkspaceConfigurations = async (options) => {
    if (!options.dryRun && !applyRaceInjected) {
      execFileSync('git', [
        'update-ref', `refs/heads/${lifecycle.branch}`,
        lifecycle.advanced, lifecycle.reviewed
      ], { cwd: repositoryRoot });
      applyRaceInjected = true;
    }
    try {
      await options.inspectCandidate?.({
        root: authorityRoot,
        sourceCommit: authorityBefore,
        stateBefore: { stateCommit: null },
        repository: { localPath: repositoryRoot, localPaths: [repositoryRoot] }
      });
    } catch (error) {
      observedFailure = error.code;
      return refreshResult('blocked', {
        dryRun: options.dryRun,
        itemStatus: 'failed'
      });
    }
    if (!options.dryRun) publicationStarted = true;
    return refreshResult(options.dryRun ? 'preview' : 'complete', {
      dryRun: options.dryRun,
      itemStatus: options.dryRun ? 'current' : 'updated'
    });
  };
  const service = services({ refreshWorkspaceConfigurations });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.equal(preview.status, 'preview');

  const result = await reinitializeWorkspaces({
    registryFile,
    confirmPlan: preview.planId
  }, service);
  assert.equal(result.status, 'blocked');
  assert.equal(observedFailure, 'WORKSPACE_REINITIALIZE_SCHEMA_AUTHORITY_CHANGED');
  assert.equal(publicationStarted, false,
    'candidate inspection must finish before configuration publication can start');
});

test('confirmed compound plan applies exact cfgp without reading or publishing capability state', async (t) => {
  const { registryFile } = await fixture(t);
  const calls = [];
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        assert.equal(options.confirmPlan, null);
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      assert.equal(options.confirmPlan, 'cfgp-1234567890abcdef12345678');
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => { throw new Error('must not read capability authority'); },
    publishOrganisationCapabilityMap: async (remote) => {
      calls.push(remote);
    }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({
    registryFile, confirmPlan: preview.planId
  }, service);
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls, []);
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.equal(result.capabilityPortability.changed, false);
  assert.deepEqual(result.capabilityPortability.results, []);
  assert.equal(result.nextAction, null);
});

test('capability publication policy cannot affect safe reinitialization', async (t) => {
  const { registryFile } = await fixture(t);
  let capabilityCalls = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => { capabilityCalls += 1; },
    publishOrganisationCapabilityMap: async () => { capabilityCalls += 1; }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'complete');
  assert.equal(capabilityCalls, 0);
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.equal(result.capabilityPortability.changed, false);
});

test('partial configuration refresh never invokes capability publication', async (t) => {
  const { registryFile } = await fixture(t);
  let publications = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      return {
        ...refreshResult('partial', { dryRun: false, itemStatus: 'updated' }),
        failed: 1
      };
    },
    observeLeadConfiguration: async () => { throw new Error('must not read capability authority'); },
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'partial');
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.equal(publications, 0, 'safe reinitialize must never publish capability locators');
  assert.deepEqual(result.nextAction.argv.slice(-2), ['--dry-run', '--json']);
});

test('filtered delivery reinitializes without binding or publishing its capability lead', async (t) => {
  const { registryFile } = await fixture(t);
  let applied = false;
  let publications = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return deliveryRefreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      applied = true;
      return deliveryRefreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    readWorkspace: async (workspaceRoot) => deliveryWorkspace(workspaceRoot),
    observeLeadConfiguration: async () => { throw new Error('must not read capability authority'); },
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const input = { registryFile, repositories: ['delivery'] };
  const preview = await reinitializeWorkspaces({ ...input, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ ...input, confirmPlan: preview.planId }, service);
  assert.equal(applied, true);
  assert.equal(publications, 0);
  assert.equal(result.status, 'complete');
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.deepEqual(result.capabilityPortability.results, []);
});

test('an unrelated capability lead advance cannot stale a safe reinitialize plan', async (t) => {
  const { registryFile } = await fixture(t);
  let authorityReads = 0;
  let refreshMutations = 0;
  let publications = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (!options.dryRun) refreshMutations += 1;
      return deliveryRefreshResult(options.dryRun ? 'preview' : 'complete', {
        dryRun: options.dryRun,
        itemStatus: options.dryRun ? 'would-update' : 'updated'
      });
    },
    readWorkspace: async (workspaceRoot) => deliveryWorkspace(workspaceRoot),
    observeLeadConfiguration: async () => { authorityReads += 1; },
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const input = { registryFile, repositories: ['delivery'] };
  const preview = await reinitializeWorkspaces({ ...input, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ ...input, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'complete');
  assert.equal(result.topologyStatus, 'current');
  assert.equal(refreshMutations, 1);
  assert.equal(authorityReads, 0);
  assert.equal(publications, 0);
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
});

test('schema census blocker prevents plan issuance and confirmed mutation', async (t) => {
  const { registryFile } = await fixture(t);
  let truncated = false;
  let refreshMutations = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (!options.dryRun) refreshMutations += 1;
      return refreshResult(options.dryRun ? 'preview' : 'complete', {
        dryRun: options.dryRun,
        itemStatus: options.dryRun ? 'would-update' : 'updated'
      });
    },
    schemaCensus: async () => ({
      families: [], scannedFiles: 1, truncated,
      totals: {
        registeredRecords: 0, observedFamilies: 0, outsideRange: 0,
        unregistered: 0, unreadable: 0
      }
    })
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.match(preview.planId, /^wrip-/);
  truncated = true;
  const refused = await reinitializeWorkspaces({
    registryFile, confirmPlan: preview.planId
  }, service);
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.schemaCensuses[0].truncated, true);
  assert.equal(refreshMutations, 0);

  const blockedPreview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.equal(blockedPreview.status, 'blocked');
  assert.equal(blockedPreview.planId, null);
  assert.equal(blockedPreview.nextAction, null);
});

test('corrupt in-range legacy records are blockers and never reported as successful migrations', async (t) => {
  const { registryFile } = await fixture(t);
  let refreshMutations = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (!options.dryRun) refreshMutations += 1;
      return refreshResult(options.dryRun ? 'preview' : 'complete', {
        dryRun: options.dryRun,
        itemStatus: options.dryRun ? 'would-update' : 'updated'
      });
    },
    schemaCensus: async () => ({
      families: [{
        family: 'session-registry', currentVersion: 2,
        readable: { minimum: 1, maximum: 2 }, versions: { 1: 1 },
        readTimeMigrationRecords: 0, readTimeMigrationSteps: 0
      }],
      scannedFiles: 1,
      truncated: false,
      totals: {
        registeredRecords: 1, observedFamilies: 1, validatedRecords: 0,
        readTimeMigrationRecords: 0, readTimeMigrationSteps: 0,
        outsideRange: 0, unregistered: 0, unreadable: 1
      }
    })
  });

  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  assert.equal(preview.status, 'blocked');
  assert.equal(preview.planId, null);
  assert.equal(preview.schemaCensuses[0].status, 'attention-required');
  assert.equal(preview.schemaCensuses[0].readTimeMigrationRecords, 0);
  assert.equal(preview.schemaCensuses[0].readTimeMigrationSteps, 0);
  assert.deepEqual(preview.schemaCensuses[0].migrations, []);
  assert.equal(refreshMutations, 0);
});

test('post-refresh does not inspect or mutate capability authority', async (t) => {
  const { registryFile } = await fixture(t);
  let applied = false;
  let publications = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      applied = true;
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => { publications += 100; },
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(applied, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.topologyStatus, 'current');
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.equal(publications, 0);
  assert.equal(result.nextAction, null);
});

test('capability publication failures are outside safe reinitialize', async (t) => {
  const { registryFile } = await fixture(t);
  let capabilityCalls = 0;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => { capabilityCalls += 1; },
    publishOrganisationCapabilityMap: async () => {
      capabilityCalls += 1;
      throw new Error('capability state branch was rejected by remote policy');
    }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'complete');
  assert.equal(capabilityCalls, 0);
  assert.equal(result.capabilityPortability.status, 'outside-scope-unchanged');
  assert.deepEqual(result.capabilityPortability.results, []);
});
