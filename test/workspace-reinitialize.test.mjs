import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REINITIALIZATION_SCHEMA_POLICY, reinitializeWorkspaces
} from '../src/workspace-reinitialize.mjs';

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
const authorityAfter = 'a'.repeat(40);

function services(overrides = {}) {
  return {
    observeLeadConfiguration: async () => ({ status: 'current', commit: authorityBefore }),
    ...overrides
  };
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

test('preview binds a compound plan, stays read-only, and reports read-time migration', async (t) => {
  const { registryFile } = await fixture(t);
  let capabilityPublications = 0;
  const result = await reinitializeWorkspaces({ registryFile, dryRun: true }, services({
    refreshWorkspaceConfigurations: async (options) => {
      assert.equal(options.dryRun, true);
      return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
    },
    publishOrganisationCapabilityMap: async () => { capabilityPublications += 1; }
  }));
  assert.equal(result.status, 'preview');
  assert.match(result.planId, /^wrip-1234567890abcdef12345678-[a-f0-9]{64}$/);
  assert.equal(result.configurationPlanId, 'cfgp-1234567890abcdef12345678');
  assert.equal(capabilityPublications, 0, 'preview cannot publish configuration or capability locators');
  assert.equal(result.capabilityPortability.status, 'not-run-during-preview');
  assert.deepEqual(result.capabilityPortability.plannedLeads.map((entry) => entry.lead),
    ['https://example.test/application.git']);
  assert.equal(result.capabilityPortability.plannedLeads[0].authority.commit, authorityBefore);
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

test('confirmed compound plan applies exact cfgp and repairs capability portability', async (t) => {
  const { registryFile } = await fixture(t);
  const calls = [];
  let applied = false;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        assert.equal(options.confirmPlan, null);
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      assert.equal(options.confirmPlan, 'cfgp-1234567890abcdef12345678');
      applied = true;
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => ({
      status: 'current', commit: applied ? authorityAfter : authorityBefore
    }),
    publishOrganisationCapabilityMap: async (remote, options) => {
      calls.push(remote);
      assert.equal(options.expectedConfigurationCommit, authorityAfter);
      return {
        status: 'current', published: false,
        reason: 'it is already current there',
        portability: { status: 'current', portable: true, outcomes: [], failures: [] }
      };
    }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({
    registryFile, confirmPlan: preview.planId
  }, service);
  assert.equal(result.status, 'complete');
  assert.deepEqual(calls, ['https://example.test/application.git']);
  assert.equal(result.capabilityPortability.results[0].status, 'current');
  assert.equal(result.nextAction, null);
});

test('policy-disabled capability publication with portable locators completes', async (t) => {
  const { registryFile } = await fixture(t);
  let applied = false;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      applied = true;
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => ({
      status: 'current', commit: applied ? authorityAfter : authorityBefore
    }),
    publishOrganisationCapabilityMap: async () => ({
      status: 'policy-disabled', published: false,
      portability: { status: 'current', portable: true, outcomes: [], failures: [] }
    })
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'complete');
  assert.equal(result.capabilityPortability.status, 'complete');
  assert.equal(result.capabilityPortability.results[0].status, 'current');
  assert.equal(result.capabilityPortability.results[0].stateStatus, 'policy-disabled');
});

test('filtered delivery cannot publish from an unbound lead', async (t) => {
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
    observeLeadConfiguration: async () => ({ status: 'current', commit: authorityBefore }),
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const input = { registryFile, repositories: ['delivery'] };
  const preview = await reinitializeWorkspaces({ ...input, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ ...input, confirmPlan: preview.planId }, service);
  assert.equal(applied, true);
  assert.equal(publications, 0);
  assert.equal(result.status, 'partial');
  assert.equal(result.capabilityPortability.results[0].code,
    'CAPABILITY_REINITIALIZE_LEAD_NOT_BOUND');
  assert.deepEqual(result.capabilityPortability.results[0].nextAction.argv, [
    'singularity-flow', 'workspace', 'reinitialize', 'demo-workspace',
    '--repository', 'application', '--dry-run', '--json'
  ]);
});

test('filtered delivery plan becomes stale if its unselected lead advances', async (t) => {
  const { registryFile } = await fixture(t);
  let leadCommit = authorityBefore;
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
    observeLeadConfiguration: async () => ({ status: 'current', commit: leadCommit }),
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const input = { registryFile, repositories: ['delivery'] };
  const preview = await reinitializeWorkspaces({ ...input, dryRun: true }, service);
  leadCommit = 'd'.repeat(40);
  const result = await reinitializeWorkspaces({ ...input, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'blocked');
  assert.equal(result.topologyStatus, 'stale-plan');
  assert.equal(refreshMutations, 0, 'stale topology must be refused before configuration mutation');
  assert.equal(publications, 0, 'stale topology must never publish capability locators');
  assert.equal(result.capabilityPortability.status, 'not-run-stale-plan');
  assert.deepEqual(result.nextAction.argv.slice(-2), ['--dry-run', '--json']);
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

test('post-refresh lead revalidation prevents locator mutation on a concurrent advance', async (t) => {
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
    observeLeadConfiguration: async () => ({
      status: 'current',
      // The expected post-refresh commit is `authorityAfter`; this different exact SHA models a
      // remote update in the gap between configuration publication and locator publication.
      commit: applied ? 'e'.repeat(40) : authorityBefore
    }),
    publishOrganisationCapabilityMap: async () => { publications += 1; }
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'partial');
  assert.equal(result.topologyStatus, 'stale-plan');
  assert.equal(result.capabilityPortability.status, 'not-run-stale-plan');
  assert.equal(publications, 0);
  assert.deepEqual(result.nextAction.argv.slice(-2), ['--dry-run', '--json']);
});

test('pending portability has an exact structured resumable action', async (t) => {
  const { registryFile } = await fixture(t);
  let applied = false;
  const service = services({
    refreshWorkspaceConfigurations: async (options) => {
      if (options.dryRun) {
        return refreshResult('preview', { dryRun: true, itemStatus: 'would-update' });
      }
      applied = true;
      return refreshResult('complete', { dryRun: false, itemStatus: 'updated' });
    },
    observeLeadConfiguration: async () => ({
      status: 'current', commit: applied ? authorityAfter : authorityBefore
    }),
    publishOrganisationCapabilityMap: async () => ({
      status: 'pending', published: false,
      reason: 'capability state branch was rejected by remote policy',
      portability: { status: 'pending', portable: false, outcomes: [], failures: [{}] }
    })
  });
  const preview = await reinitializeWorkspaces({ registryFile, dryRun: true }, service);
  const result = await reinitializeWorkspaces({ registryFile, confirmPlan: preview.planId }, service);
  assert.equal(result.status, 'partial');
  const nextAction = result.capabilityPortability.results[0].nextAction;
  assert.deepEqual(nextAction.argv, [
    'singularity-flow', 'capability', 'publish', '--lead',
    'https://example.test/application.git', '--json'
  ]);
  assert.equal(nextAction.command,
    'singularity-flow capability publish --lead https://example.test/application.git --json');
});
