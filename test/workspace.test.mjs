import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import {
  adoptWorkspaceConfiguration, archiveWorkspace, changeWorkspaceCapability, createWorkspace, createWorkspaceConfiguration, fetchWorkspace, forgetWorkspace, gitValueAsync, listWorkspaceDocuments,
  normalizeWorkspaceAnchor, previewWorkspace, previewWorkspaceCapabilityChange, previewWorkspaceConfiguration, readWorkspace, readWorkspaceRegistry,
  rememberWorkspace, repairWorkspace, resolveWorkspaceDocument, restoreWorkspace, saveWorkspaceConfiguration, stageWorkspaceDocuments,
  updateWorkspaceConfiguration, validateWorkspaceCapabilityRegistration, validateWorkspaceManifest, workspaceArchiveReadiness, workspaceRepositoryPath,
  workspaceRepositoryDefaults, workspaceStatus, withRegistryFileLease
} from '../src/workspace.mjs';
import {
  activateWorkspaceContext, activateWorkspaceStoryContext, buildWorkspaceContext,
  discardUnsupportedWorkflowWorkspaces, readActiveWorkspaceContext,
  resolveWorkspaceExecutionContext, resolveWorkspaceReference, workspacePromptLabel
} from '../src/workspace-context.mjs';
import {
  activeWorkspaceRepositoryRoot, ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS, hasLocalGovernanceAuthority
} from '../src/cli-entry.mjs';
import { run } from '../src/util.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { writeV3Manifest } from '../src/world-model-materialization.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

test('repository commands can route through the explicitly selected workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-selected-command-root-'));
  const repository = path.join(root, 'repository');
  const workspace = path.join(root, 'workspace');
  const selection = path.join(root, 'active-workspace.json');
  const registry = path.join(root, 'workspaces.json');
  const remote = path.join(root, 'payments-api.git');
  run('git', ['init', '--bare', remote], { cwd: root });
  await mkdir(repository);
  run('git', ['init', '-b', 'main'], { cwd: repository });
  run('git', ['config', 'user.name', 'Workspace Router'], { cwd: repository });
  run('git', ['config', 'user.email', 'router@example.com'], { cwd: repository });
  const initialized = spawnSync(process.execPath, [cli, 'init'], { cwd: repository, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  run('git', ['remote', 'add', 'origin', remote], { cwd: repository });
  run('git', ['add', '-A'], { cwd: repository });
  run('git', ['commit', '-m', 'initialize'], { cwd: repository });
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'payments',
    name: 'Payments',
    anchor: { provider: 'workspace', key: 'payments', title: 'Payments' },
    leadRepository: 'api',
    capabilities: [],
    repositories: {
      api: {
        url: remote,
        defaultBranch: 'main',
        path: 'repos/api',
        capabilities: [],
        adoption: {
          mode: 'existing-clone',
          canonicalPath: repository,
          proofHash: `sha256:${'0'.repeat(64)}`,
          reviewedAt: '2026-08-15T00:00:00.000Z'
        }
      }
    }
  }, null, 2)}\n`);
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath: workspace,
    repositoryId: 'api',
    repositoryPath: repository,
    repositoryState: 'ready',
    branch: 'main',
    capabilities: [],
    repositoryCapabilities: [],
    storyId: null,
    selectedAt: '2026-08-15T00:00:00.000Z'
  }, null, 2)}\n`);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry
  };

  assert.equal(await activeWorkspaceRepositoryRoot('status', { env }), await realpath(repository));
  assert.equal(await activeWorkspaceRepositoryRoot('workspace', { env }), null,
    'workspace administration must not be redirected into its current selection');
  assert.equal(await activeWorkspaceRepositoryRoot('capability', { env, subcommand: 'map' }), null,
    'organisation capability onboarding must work before a workspace exists');
  assert.equal(await activeWorkspaceRepositoryRoot('capability', { env, subcommand: 'tree' }), await realpath(repository),
    'repository-local capability reads still use the explicitly selected workspace');
  assert.equal(await activeWorkspaceRepositoryRoot('doctor', { env }), await realpath(repository),
    'ordinary doctor remains repository-scoped and follows the selected workspace');
  assert.equal(await activeWorkspaceRepositoryRoot('doctor', {
    env, options: { performance: true }
  }), null, 'doctor --performance deliberately measures the invoking checkout');
  assert.ok(ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS.has('factory-reset'),
    'destructive repository reset must always require an explicit working directory');

  const outside = path.join(root, 'outside-every-repository');
  await mkdir(outside);
  const routed = spawnSync(process.execPath, [cli, 'wm', 'status', '--json'], {
    cwd: outside,
    env,
    encoding: 'utf8'
  });
  assert.equal(routed.status, 0, routed.stderr);
  const worldModelStatus = JSON.parse(routed.stdout);
  assert.equal(worldModelStatus.status, 'conflict',
    'a configured remote without a state branch remains an explicit authority conflict');
  assert.equal(worldModelStatus.conflicts[0].code, 'world_model.state_branch_absent');
  assert.equal(worldModelStatus.candidates[0].directory,
    path.join(await realpath(repository), 'singularity/world-model'),
    'the repository-scoped command ran against the selected workspace repository');
});

test('a tracked lifecycle aggregate keeps recovery and approval reads in the current repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lifecycle-routing-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: root });
  const state = path.join(root, 'singularity/work-items/ROUTE-1/workflow.json');
  await mkdir(path.dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify({ schemaVersion: 2, workItem: { id: 'ROUTE-1' }, phaseOrder: [], phases: {} }));
  run('git', ['add', state], { cwd: root });
  run('git', ['commit', '-m', 'tracked lifecycle state'], { cwd: root });

  assert.equal(hasLocalGovernanceAuthority(root), true);
});

test('a tracked lifecycle aggregate under a custom root retains repository routing when configuration is damaged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-custom-lifecycle-routing-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: root });
  const state = path.join(root, 'governed/story-state/ROUTE-CUSTOM/workflow.json');
  await mkdir(path.dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify({ schemaVersion: 2, workItem: { id: 'ROUTE-CUSTOM' }, phaseOrder: [], phases: {} }));
  run('git', ['add', state], { cwd: root });
  run('git', ['commit', '-m', 'tracked custom lifecycle state'], { cwd: root });

  assert.equal(hasLocalGovernanceAuthority(root), true);
});

test('selected workspace routing reports a stale repository path before dispatch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stale-command-root-'));
  const selection = path.join(root, 'active-workspace.json');
  const missing = path.join(root, 'missing-repository');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath: path.join(root, 'workspace'),
    repositoryId: 'api',
    repositoryPath: missing,
    repositoryState: 'missing',
    selectedAt: '2026-08-15T00:00:00.000Z'
  })}\n`);
  await assert.rejects(() => activeWorkspaceRepositoryRoot('status', {
    env: {
      ...process.env,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'workspaces.json')
    }
  }), (error) => error.code === 'ACTIVE_WORKSPACE_REPOSITORY_UNAVAILABLE'
    && /Repair the workspace/.test(error.message));
});

async function remoteRepository(base, name) {
  const source = path.join(base, `${name}-source`);
  const bare = path.join(base, `${name}.git`);
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), `# ${name}\n`);
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initial'], { cwd: source });
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  return bare;
}

async function approveCapabilityAuthority(base, leadRemote, capabilities, repositories) {
  await ensureConfigurationBranch(leadRemote);
  const checkout = await mkdtemp(path.join(base, 'capability-authority-'));
  run('git', ['clone', '--quiet', '--branch', 'sflow/config', leadRemote, checkout], { cwd: base });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: checkout });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: checkout });
  const portfolioFile = path.join(checkout, 'singularity', 'portfolio.yml');
  const portfolio = YAML.parseDocument(await readFile(portfolioFile, 'utf8'));
  for (const [id, repository] of Object.entries(repositories)) {
    portfolio.setIn(['repositories', id], portfolio.createNode({
      url: repository.url, defaultBranch: repository.defaultBranch ?? 'main', required: true
    }));
  }
  await writeFile(portfolioFile, portfolio.toString(), 'utf8');
  const capabilityFile = path.join(checkout, 'singularity', 'capabilities.yml');
  await writeFile(capabilityFile, YAML.stringify({ version: 1, capabilities }), 'utf8');
  run('git', ['add', 'singularity/portfolio.yml', 'singularity/capabilities.yml'], { cwd: checkout });
  run('git', ['commit', '-m', 'approve workspace capability fixture'], { cwd: checkout });
  run('git', ['push', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: checkout });
  return run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();
}

function stableFixtureValue(value) {
  if (Array.isArray(value)) return value.map(stableFixtureValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stableFixtureValue(value[key])]));
}

function workspaceFixtureSha256(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableFixtureValue(value))).digest('hex')}`;
}

function resealWorkspaceDropFixture(transaction) {
  const unsigned = structuredClone(transaction);
  delete unsigned.transactionSha256;
  return { ...unsigned, transactionSha256: workspaceFixtureSha256(unsigned) };
}

async function attachedCapabilityWorkspace(root, workspaceId) {
  const platformRemote = await remoteRepository(root, `${workspaceId}-platform`);
  const apiRemote = await remoteRepository(root, `${workspaceId}-api`);
  await approveCapabilityAuthority(root, platformRemote, {
    api: { name: 'API', kind: 'delivery', parent: null, repository: 'api' }
  }, {
    platform: { url: platformRemote }, api: { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: workspaceId, name: workspaceId,
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] }
    }
  }, { confirmation: workspaceId, clone: true });
  const attach = await previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
    action: 'attach'
  });
  await changeWorkspaceCapability(created.workspace.path, 'api', { action: 'attach' }, {
    confirmation: attach.planId
  });
  return {
    ...created,
    platformRemote,
    apiRemote,
    apiCheckout: path.join(created.workspace.path, 'repos', 'api')
  };
}

async function stagedCapabilityDropFixture(root, workspaceId) {
  const fixture = await attachedCapabilityWorkspace(root, workspaceId);
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const sourceManifest = await readWorkspace(fixture.workspace.path);
  const drop = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  });
  const [proof] = drop.dropRepositories;
  const sourceManifestSha256 = drop.sourceManifestSha256;
  const targetManifest = drop.manifest;
  const targetManifestSha256 = drop.plan.targetManifestSha256;
  const plan = drop.plan;
  const planId = drop.planId;
  const transactionRoot = path.join(
    fixture.workspace.path, '.singularity-flow', 'workspace-capability-drop', planId
  );
  const staged = path.join(transactionRoot, 'api');
  await mkdir(transactionRoot, { recursive: true });
  await rename(fixture.apiCheckout, staged);
  const stagedInfo = await stat(staged);
  const unsigned = {
    schemaVersion: 1,
    format: 'workspace-capability-drop-v1',
    planId,
    phase: 'staged',
    workspace: fixture.workspace.path,
    sourceManifestSha256,
    targetManifestSha256,
    plan,
    repositories: [{
      id: 'api', relativePath: 'repos/api', source: fixture.apiCheckout,
      staged,
      url: sourceManifest.repositories.api.url,
      defaultBranch: sourceManifest.repositories.api.defaultBranch,
      state: proof.state,
      removable: proof.removable,
      head: proof.head,
      worktreeSha256: proof.worktreeSha256,
      refsSha256: proof.refsSha256,
      directoryIdentity: proof.directoryIdentity,
      stagedIdentity: { device: String(stagedInfo.dev), inode: String(stagedInfo.ino) }
    }]
  };
  return {
    ...fixture,
    manifestFile,
    sourceManifest,
    targetManifest,
    transactionRoot,
    transactionFile: path.join(transactionRoot, 'transaction.json'),
    staged,
    transaction: { ...unsigned, transactionSha256: workspaceFixtureSha256(unsigned) }
  };
}

async function capabilityDropBoundaryFixture(root, {
  candidateIds = ['candidate'],
  paths = {},
  leadAdoption = null
} = {}) {
  const workspacePath = path.join(root, 'workspace');
  const authority = path.join(root, 'authority.git');
  await mkdir(workspacePath, { recursive: true });
  const repositories = {
    platform: {
      url: authority,
      defaultBranch: 'main',
      path: paths.platform ?? 'repos/platform',
      capabilities: [],
      ...(leadAdoption ? { adoption: leadAdoption } : {})
    },
    ...Object.fromEntries(candidateIds.map((id) => [id, {
      url: path.join(root, `${id}.git`),
      defaultBranch: 'main',
      path: paths[id] ?? `repos/${id}`,
      capabilities: ['retire']
    }]))
  };
  const manifestFile = path.join(workspacePath, 'workspace.json');
  await writeFile(manifestFile, `${JSON.stringify({
    version: 1,
    id: 'drop-boundary',
    name: 'Drop boundary',
    anchor: { provider: 'workspace', key: 'drop-boundary', title: 'Drop boundary' },
    leadRepository: 'platform',
    capabilities: ['retire'],
    capabilityAuthority: { url: authority },
    repositories
  }, null, 2)}\n`);
  const organisation = {
    url: authority,
    configurationBranch: 'sflow/config',
    configurationCommit: 'a'.repeat(40),
    sourceBranch: 'sflow/config',
    sourceCommit: 'a'.repeat(40),
    capabilities: [{ id: 'retire', children: [] }]
  };
  const options = {
    action: 'detach',
    dropLocal: true,
    organisation,
    resolveWorkspacePlanOperation: (_organisation, { capabilities = [] } = {}) => ({
      repositories: capabilities.includes('retire')
        ? Object.fromEntries(candidateIds.map((id) => [id, repositories[id]]))
        : {}
    })
  };
  return {
    workspacePath,
    manifestFile,
    preview: () => previewWorkspaceCapabilityChange(
      workspacePath, 'retire', options
    )
  };
}

test('workspace capability registration is approved before any workspace byte is persisted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-boundary-'));
  const remote = await remoteRepository(root, 'platform');
  await ensureConfigurationBranch(remote, {
    capability: {
      capabilityId: 'declared-capability',
      capabilityName: 'Declared capability',
      kind: 'delivery',
      repositoryId: 'platform',
      jiraProject: null,
      teams: []
    }
  });
  const baseDirectory = path.join(root, 'workspaces');
  const input = (id, capability) => ({
    baseDirectory,
    id,
    name: id,
    leadRepository: 'platform',
    capabilities: [capability],
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        capabilities: [capability]
      }
    }
  });

  await assert.rejects(
    () => createWorkspaceConfiguration(input('invalid-capability', 'missing-capability'), {
      confirmation: 'invalid-capability', clone: false
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_UNKNOWN'
      && /Nothing was changed/.test(error.message)
  );
  assert.equal(await stat(path.join(baseDirectory, 'invalid-capability')).catch(() => null), null,
    'an unapproved capability must not leave a workspace shell or manifest');

  const created = await createWorkspaceConfiguration(
    input('valid-capability', 'declared-capability'),
    { confirmation: 'valid-capability', clone: false }
  );
  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  await assert.rejects(
    () => updateWorkspaceConfiguration(created.workspace.path, {
      capabilities: ['missing-capability']
    }, { confirmation: 'valid-capability' }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_TRANSITION_REQUIRED'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before,
    'an invalid capability edit must preserve the last approved manifest exactly');

  const rogue = await remoteRepository(root, 'rogue');
  await assert.rejects(
    () => createWorkspaceConfiguration({
      ...input('wrong-delivery-binding', 'declared-capability'),
      repositories: {
        ...input('wrong-delivery-binding', 'declared-capability').repositories,
        rogue: {
          url: rogue,
          defaultBranch: 'main',
          capabilities: ['declared-capability']
        }
      }
    }, { confirmation: 'wrong-delivery-binding', clone: false }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_REPOSITORY_MISMATCH'
      && /without an approved delivery binding/.test(error.message)
  );
  assert.equal(await stat(path.join(baseDirectory, 'wrong-delivery-binding')).catch(() => null), null,
    'a stale or forged repository binding must not leave a workspace shell');
});

test('a commit-bound capability receipt avoids a second catalog clone without widening its authority', async () => {
  const commit = 'a'.repeat(40);
  const remote = 'https://example.test/platform.git';
  const manifest = {
    leadRepository: 'platform',
    capabilities: ['payments'],
    repositories: {
      platform: {
        id: 'platform', url: remote, defaultBranch: 'main', capabilities: ['payments']
      }
    }
  };
  let catalogReads = 0;
  let observations = 0;
  const readCapabilities = async () => {
    catalogReads += 1;
    return {
      capabilities: [{ id: 'payments', children: [] }],
      deliveries: [{
        id: 'payments', repository: 'platform', url: remote, defaultBranch: 'main', ancestors: []
      }],
      branch: 'sflow/config', path: 'singularity/capabilities.yml', commit
    };
  };
  const first = await validateWorkspaceCapabilityRegistration(manifest, { readCapabilities });
  assert.equal(first.reused, false);
  const second = await validateWorkspaceCapabilityRegistration(manifest, {
    readCapabilities,
    receipt: first,
    observeAuthority: async () => { observations += 1; return commit; }
  });
  assert.equal(second.reused, true);
  assert.equal(catalogReads, 1, 'the confirmed materialization does not clone the catalog again');
  assert.equal(observations, 1, 'reuse is still bound to one exact remote ref observation');

  const copied = await validateWorkspaceCapabilityRegistration(manifest, {
    readCapabilities,
    receipt: structuredClone(first),
    observeAuthority: async () => { observations += 1; return commit; }
  });
  assert.equal(copied.reused, false, 'serialized or caller-forged receipt fields are not authority');
  assert.equal(catalogReads, 2, 'a copied receipt must re-read the approved capability catalog');
  assert.equal(observations, 1, 'an unbranded receipt is rejected before its claimed ref is observed');

  const moved = await validateWorkspaceCapabilityRegistration(manifest, {
    readCapabilities,
    receipt: first,
    observeAuthority: async () => 'b'.repeat(40)
  });
  assert.equal(moved.reused, false);
  assert.equal(catalogReads, 3, 'a moved authority is read and validated again');

  await assert.rejects(() => validateWorkspaceCapabilityRegistration({
    ...manifest,
    repositories: {
      platform: { ...manifest.repositories.platform, defaultBranch: 'release' }
    }
  }, {
    readCapabilities,
    receipt: first,
    observeAuthority: async () => commit
  }), /base branch must be 'main'/);
  assert.equal(observations, 1, 'a receipt for a different materialization plan is never observed');

  const alternateManifest = {
    ...manifest,
    capabilities: ['refunds'],
    repositories: {
      platform: { ...manifest.repositories.platform, capabilities: ['refunds'] }
    }
  };
  const alternate = await validateWorkspaceCapabilityRegistration(alternateManifest, {
    readCapabilities: async () => ({
      capabilities: [{ id: 'refunds', children: [] }],
      deliveries: [{
        id: 'refunds', repository: 'platform', url: remote, defaultBranch: 'main', ancestors: []
      }],
      branch: 'sflow/config', path: 'singularity/capabilities.yml', commit: 'b'.repeat(40)
    })
  });
  first.requested.splice(0, first.requested.length, ...alternate.requested);
  first.known.splice(0, first.known.length, ...alternate.known);
  first.branch = alternate.branch;
  first.path = alternate.path;
  first.commit = alternate.commit;
  first.bindingSha256 = alternate.bindingSha256;
  let bypassCatalogReads = 0;
  let bypassObservations = 0;
  await assert.rejects(() => validateWorkspaceCapabilityRegistration(alternateManifest, {
    receipt: first,
    observeAuthority: async () => { bypassObservations += 1; return alternate.commit; },
    readCapabilities: async () => {
      bypassCatalogReads += 1;
      return {
        capabilities: [{ id: 'payments', children: [] }],
        deliveries: [{
          id: 'payments', repository: 'platform', url: remote, defaultBranch: 'main', ancestors: []
        }],
        branch: 'sflow/config', path: 'singularity/capabilities.yml', commit: alternate.commit
      };
    }
  }), (error) => error?.code === 'WORKSPACE_CAPABILITY_UNKNOWN');
  assert.equal(bypassObservations, 0,
    'mutating a branded receipt cannot authorize observing claims from a different plan');
  assert.equal(bypassCatalogReads, 1,
    'mutating a branded receipt falls back to the approved catalog instead of bypassing it');
});

test('workspace capability detach preserves checkouts, drop is bounded, and attach restores from the approved map', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-attachment-'));
  const platformRemote = await remoteRepository(root, 'platform');
  const apiRemote = await remoteRepository(root, 'payments-api');
  await approveCapabilityAuthority(root, platformRemote, {
    'payments-api': {
      name: 'Payments API', kind: 'delivery', parent: null, repository: 'payments-api'
    }
  }, {
    platform: { url: platformRemote },
    'payments-api': { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'commerce',
    name: 'Commerce',
    leadRepository: 'platform',
    capabilities: [],
    capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: {
        url: platformRemote, defaultBranch: 'main', required: true,
        path: 'repos/platform', capabilities: []
      }
    }
  }, { confirmation: 'commerce', clone: true });
  const attach = await previewWorkspaceCapabilityChange(
    created.workspace.path, 'payments-api', { action: 'attach' }
  );
  assert.deepEqual(attach.addedRepositories, ['payments-api']);
  const attached = await changeWorkspaceCapability(
    created.workspace.path, 'payments-api', { action: 'attach' },
    { confirmation: attach.planId }
  );
  assert.deepEqual(attached.workspace.capabilities, ['payments-api']);
  assert.deepEqual(attached.workspace.repositories['payments-api'].capabilities, ['payments-api']);
  const checkout = path.join(created.workspace.path, 'repos', 'payments-api');
  assert.ok(await stat(path.join(checkout, '.git')));
  const firstHead = run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim();

  const detach = await previewWorkspaceCapabilityChange(
    created.workspace.path, 'payments-api', { action: 'detach' }
  );
  assert.deepEqual(detach.dropRepositories, []);
  const detached = await changeWorkspaceCapability(
    created.workspace.path, 'payments-api', { action: 'detach' },
    { confirmation: detach.planId }
  );
  assert.deepEqual(detached.workspace.capabilities, []);
  assert.deepEqual(detached.workspace.repositories['payments-api'].capabilities, []);
  assert.ok(await stat(path.join(checkout, '.git')), 'plain detach keeps the checkout');

  const reuse = await previewWorkspaceCapabilityChange(
    created.workspace.path, 'payments-api', { action: 'attach' }
  );
  assert.deepEqual(reuse.addedRepositories, [], 'a detached checkout remains registered for reuse');
  await changeWorkspaceCapability(
    created.workspace.path, 'payments-api', { action: 'attach' },
    { confirmation: reuse.planId }
  );
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: checkout }).stdout.trim(), firstHead);

  const drop = await previewWorkspaceCapabilityChange(
    created.workspace.path, 'payments-api', { action: 'detach', dropLocal: true }
  );
  assert.deepEqual(drop.dropRepositories.map((repository) => repository.id), ['payments-api']);
  const dropped = await changeWorkspaceCapability(
    created.workspace.path, 'payments-api', { action: 'detach', dropLocal: true },
    { confirmation: drop.planId }
  );
  assert.deepEqual(dropped.dropped.map((repository) => repository.id), ['payments-api']);
  assert.equal(await stat(checkout).catch(() => null), null);
  assert.equal(dropped.workspace.repositories['payments-api'], undefined);
  assert.ok(dropped.workspace.repositories.platform, 'the lead repository is always preserved');

  const restore = await previewWorkspaceCapabilityChange(
    created.workspace.path, 'payments-api', { action: 'attach' }
  );
  assert.deepEqual(restore.addedRepositories, ['payments-api']);
  const restored = await changeWorkspaceCapability(
    created.workspace.path, 'payments-api', { action: 'attach' },
    { confirmation: restore.planId }
  );
  assert.equal(restored.status.repositories.find((repository) => repository.id === 'payments-api').state, 'ready');
  assert.ok(await stat(path.join(checkout, '.git')), 'reattach reclones only the missing checkout');
});

test('workspace capability drop refuses dirty and adopted repositories without changing the manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-drop-safety-'));
  const platformRemote = await remoteRepository(root, 'platform');
  const apiRemote = await remoteRepository(root, 'api');
  await approveCapabilityAuthority(root, platformRemote, {
    api: { name: 'API', kind: 'delivery', parent: null, repository: 'api' }
  }, {
    platform: { url: platformRemote }, api: { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'safe-drop', name: 'Safe drop',
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] }
    }
  }, { confirmation: 'safe-drop', clone: true });
  const attach = await previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
    action: 'attach'
  });
  await changeWorkspaceCapability(created.workspace.path, 'api', {
    action: 'attach'
  }, { confirmation: attach.planId });
  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  await writeFile(path.join(created.workspace.path, 'repos', 'api', 'local.txt'), 'keep me\n');
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);

  const adoptedManifest = JSON.parse(before);
  const adoptedPath = path.join(created.workspace.path, 'repos', 'api');
  adoptedManifest.repositories.api.adoption = {
    mode: 'existing-clone', canonicalPath: adoptedPath,
    proofHash: `sha256:${'0'.repeat(64)}`, reviewedAt: new Date().toISOString()
  };
  await writeFile(manifestFile, `${JSON.stringify(adoptedManifest, null, 2)}\n`);
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_ADOPTED'
  );
});

test('workspace capability drop refuses paths that overlap a retained repository', async (t) => {
  for (const scenario of [
    {
      name: 'candidate contains the retained lead',
      paths: { candidate: 'repos/bundle', platform: 'repos/bundle/platform' }
    },
    {
      name: 'candidate is contained by the retained lead',
      paths: { candidate: 'repos/platform/candidate', platform: 'repos/platform' }
    }
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drop-overlap-'));
      const fixture = await capabilityDropBoundaryFixture(root, { paths: scenario.paths });
      const before = await readFile(fixture.manifestFile, 'utf8');

      await assert.rejects(
        fixture.preview,
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH'
          && /overlaps retained repository 'platform'/i.test(error.message)
      );
      assert.equal(await readFile(fixture.manifestFile, 'utf8'), before);
    });
  }

  await t.test('two drop candidates cannot contain one another', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drop-candidate-overlap-'));
    const fixture = await capabilityDropBoundaryFixture(root, {
      candidateIds: ['bundle', 'nested'],
      paths: { bundle: 'repos/bundle', nested: 'repos/bundle/nested' }
    });
    const before = await readFile(fixture.manifestFile, 'utf8');

    await assert.rejects(
      fixture.preview,
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH'
        && /'bundle' and 'nested'.*paths overlap/i.test(error.message)
    );
    assert.equal(await readFile(fixture.manifestFile, 'utf8'), before);
  });

  await t.test('a retained adopted path aliases the candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drop-alias-'));
    const candidate = path.join(root, 'workspace', 'repos', 'candidate');
    const retainedAlias = path.join(root, 'retained-platform-alias');
    const fixture = await capabilityDropBoundaryFixture(root, {
      paths: { candidate: 'repos/candidate', platform: 'repos/platform' },
      leadAdoption: {
        mode: 'existing-clone',
        canonicalPath: retainedAlias,
        proofHash: `sha256:${'0'.repeat(64)}`,
        reviewedAt: '2026-08-15T00:00:00.000Z'
      }
    });
    await mkdir(candidate, { recursive: true });
    await symlink(candidate, retainedAlias, 'dir');
    const before = await readFile(fixture.manifestFile, 'utf8');

    await assert.rejects(
      fixture.preview,
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNSAFE_PATH'
        && /overlaps retained repository 'platform'/i.test(error.message)
    );
    assert.equal(await readFile(fixture.manifestFile, 'utf8'), before);
    assert.equal(await realpath(retainedAlias), await realpath(candidate));
  });
});

test('workspace capability drop rejects colliding recovery namespace names before staging', async (t) => {
  for (const scenario of [
    { name: 'transaction receipt collision', candidateIds: ['transaction.json'] },
    { name: 'case-variant transaction receipt collision', candidateIds: ['Transaction.json'] },
    { name: 'staging and quarantine collision', candidateIds: ['foo', 'foo.deleting'] },
    { name: 'case-variant staging and quarantine collision', candidateIds: ['foo', 'FOO.deleting'] }
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drop-namespace-'));
      const fixture = await capabilityDropBoundaryFixture(root, {
        candidateIds: scenario.candidateIds
      });
      const before = await readFile(fixture.manifestFile, 'utf8');

      await assert.rejects(
        fixture.preview,
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNSAFE_NAMESPACE'
          && /recovery namespace collision/i.test(error.message)
      );
      assert.equal(await readFile(fixture.manifestFile, 'utf8'), before);
      assert.equal(await stat(path.join(
        fixture.workspacePath, '.singularity-flow', 'workspace-capability-drop'
      )).catch(() => null), null);
    });
  }
});

test('workspace capability drop refuses ignored files and commits retained only by reflog', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-hidden-drop-'));
  const fixture = await attachedCapabilityWorkspace(root, 'hidden-drop');
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');

  await writeFile(path.join(fixture.apiCheckout, '.git', 'info', 'exclude'), 'local-cache.bin\n');
  await writeFile(path.join(fixture.apiCheckout, 'local-cache.bin'), 'irreplaceable cache\n');
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_IGNORED'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);

  await rm(path.join(fixture.apiCheckout, 'local-cache.bin'));
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: fixture.apiCheckout });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: fixture.apiCheckout });
  await writeFile(path.join(fixture.apiCheckout, 'reflog-only.txt'), 'retain this commit\n');
  run('git', ['add', 'reflog-only.txt'], { cwd: fixture.apiCheckout });
  run('git', ['commit', '-m', 'local commit retained only by reflog'], { cwd: fixture.apiCheckout });
  const reflogOnlyCommit = run('git', ['rev-parse', 'HEAD'], { cwd: fixture.apiCheckout }).stdout.trim();
  run('git', ['reset', '--hard', 'origin/main'], { cwd: fixture.apiCheckout });
  assert.notEqual(reflogOnlyCommit,
    run('git', ['rev-parse', 'HEAD'], { cwd: fixture.apiCheckout }).stdout.trim());
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNPUSHED'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);
});

test('workspace capability drop refuses retained submodule metadata and local Git LFS objects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-git-data-drop-'));
  const fixture = await attachedCapabilityWorkspace(root, 'git-data-drop');
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  const gitDirectory = path.join(fixture.apiCheckout, '.git');

  const retainedModule = path.join(gitDirectory, 'modules', 'retired-submodule');
  await mkdir(retainedModule, { recursive: true });
  await writeFile(path.join(retainedModule, 'config'), 'locally retained submodule metadata\n');
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_SUBMODULE'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);
  assert.equal(await readFile(path.join(retainedModule, 'config'), 'utf8'),
    'locally retained submodule metadata\n');

  await rm(path.join(gitDirectory, 'modules'), { recursive: true, force: true });
  const lfsObject = path.join(gitDirectory, 'lfs', 'objects', 'ab', 'cd', 'local-object');
  await mkdir(path.dirname(lfsObject), { recursive: true });
  await writeFile(lfsObject, 'local LFS payload\n');
  await assert.rejects(
    () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_LFS_UNVERIFIED'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);
  assert.equal(await readFile(lfsObject, 'utf8'), 'local LFS payload\n');
});

test('workspace capability drop isolates Git evidence and retains non-ref local data', async (t) => {
  await t.test('an ambient GIT_INDEX_FILE cannot hide index-only staged data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-ambient-index-'));
    const fixture = await attachedCapabilityWorkspace(root, 'ambient-index');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const readme = path.join(fixture.apiCheckout, 'README.md');
    const original = await readFile(readme, 'utf8');

    await writeFile(readme, `${original}\nindex-only staged payload\n`);
    run('git', ['add', 'README.md'], { cwd: fixture.apiCheckout });
    await writeFile(readme, original);
    assert.match(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, /^MM README\.md$/m, 'the real repository index retains staged data');

    const alternateIndex = path.join(root, 'clean-ambient-index');
    run('git', ['read-tree', 'HEAD'], {
      cwd: fixture.apiCheckout,
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex }
    });
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout,
      env: { ...process.env, GIT_INDEX_FILE: alternateIndex }
    }).stdout, '', 'the attacker-selected ambient index makes the checkout appear clean');

    const previousIndex = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = alternateIndex;
    try {
      await assert.rejects(
        () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
          action: 'detach', dropLocal: true
        }),
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
      );
    } finally {
      if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previousIndex;
    }
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.match(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, /^MM README\.md$/m, 'the hidden staged data remains untouched');
  });

  await t.test('repository-local core.fsmonitor cannot hide modified tracked bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-fsmonitor-'));
    const fixture = await attachedCapabilityWorkspace(root, 'fsmonitor');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const hook = path.join(root, 'hide-all-fsmonitor.sh');
    await writeFile(hook, "#!/bin/sh\nprintf 'sflow-token\\0'\n", { mode: 0o700 });
    run('git', ['config', 'core.fsmonitor', hook], { cwd: fixture.apiCheckout });
    run('git', ['config', 'core.fsmonitorHookVersion', '2'], { cwd: fixture.apiCheckout });
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'the malicious filesystem monitor is primed against a clean checkout');
    run('git', ['update-index', '--fsmonitor-valid', 'README.md'], {
      cwd: fixture.apiCheckout
    });
    const readme = path.join(fixture.apiCheckout, 'README.md');
    const original = await readFile(readme, 'utf8');
    const modified = original.replace(/^./, (character) => character === '#' ? '!' : '#');
    assert.equal(Buffer.byteLength(modified), Buffer.byteLength(original));
    await writeFile(readme, modified);
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'the configured executable incorrectly hides the tracked modification');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(readme, 'utf8'), modified,
      'the tracked bytes hidden by the repository-local monitor remain untouched');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout is retained after the destructive proof refuses it');
  });

  await t.test('core.filemode=false cannot hide an executable-bit change', async (subtest) => {
    if (process.platform === 'win32') {
      subtest.skip('Windows filesystems do not reliably expose Git executable-bit changes');
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-filemode-'));
    const fixture = await attachedCapabilityWorkspace(root, 'filemode');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const readme = path.join(fixture.apiCheckout, 'README.md');
    const originalMode = (await stat(readme)).mode;
    run('git', ['config', 'core.filemode', 'false'], { cwd: fixture.apiCheckout });
    await chmod(readme, originalMode | 0o111);
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'repository-local core.filemode=false hides the mode-only change');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.notEqual((await stat(readme)).mode & 0o111, 0,
      'the executable-bit change remains intact after refusal');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout containing the hidden mode change is retained');
  });

  await t.test('core.ignorecase=true cannot hide a distinct case-colliding path', async (subtest) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-ignorecase-'));
    const probe = path.join(root, 'case-sensitivity-probe');
    await mkdir(probe);
    await writeFile(path.join(probe, 'foo'), 'lowercase probe\n');
    await writeFile(path.join(probe, 'FOO'), 'uppercase probe\n');
    const probeEntries = await readdir(probe);
    if (!probeEntries.includes('foo') || !probeEntries.includes('FOO')) {
      subtest.skip('the checkout filesystem cannot represent distinct case-colliding paths');
      return;
    }

    const fixture = await attachedCapabilityWorkspace(root, 'ignorecase');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: fixture.apiCheckout });
    run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: fixture.apiCheckout });
    await writeFile(path.join(fixture.apiCheckout, 'foo'), 'tracked lowercase path\n');
    run('git', ['add', 'foo'], { cwd: fixture.apiCheckout });
    run('git', ['commit', '-m', 'publish lowercase path'], { cwd: fixture.apiCheckout });
    run('git', ['push', 'origin', 'main'], { cwd: fixture.apiCheckout });
    const before = await readFile(manifestFile, 'utf8');
    run('git', ['config', 'core.ignorecase', 'true'], { cwd: fixture.apiCheckout });
    const retained = path.join(fixture.apiCheckout, 'FOO');
    await writeFile(retained, 'distinct uppercase local path\n');
    assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'repository-local core.ignorecase=true hides the distinct uppercase path');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(retained, 'utf8'), 'distinct uppercase local path\n');
    assert.equal(await readFile(path.join(fixture.apiCheckout, 'foo'), 'utf8'),
      'tracked lowercase path\n');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'both case-distinct paths remain in the retained checkout');
  });

  await t.test('restored stat-cache metadata cannot hide a same-size content mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-stat-cache-'));
    const fixture = await attachedCapabilityWorkspace(root, 'stat-cache');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const readme = path.join(fixture.apiCheckout, 'README.md');
    const original = await readFile(readme, 'utf8');
    const modified = original.replace(/^./, (character) => character === '#' ? '!' : '#');
    assert.equal(Buffer.byteLength(modified), Buffer.byteLength(original));
    const stableTimestamp = 1_700_000_000;
    run('git', ['config', 'core.trustctime', 'false'], { cwd: fixture.apiCheckout });
    run('git', ['config', 'core.checkStat', 'minimal'], { cwd: fixture.apiCheckout });
    await utimes(readme, stableTimestamp, stableTimestamp);
    run('git', ['update-index', '--refresh'], { cwd: fixture.apiCheckout });
    await writeFile(readme, modified);
    await utimes(readme, stableTimestamp, stableTimestamp);
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'Git stat-cache hints hide the same-size, restored-mtime mutation');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_DIRTY'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(readme, 'utf8'), modified,
      'the content mutation hidden by stat metadata remains intact');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout containing the hidden content mutation is retained');
  });

  await t.test('configured LFS storage retained inside the checkout is refused', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-lfs-storage-'));
    const fixture = await attachedCapabilityWorkspace(root, 'configured-lfs-storage');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const storage = path.join(fixture.apiCheckout, '.git', 'private-lfs-storage');
    const retained = path.join(storage, 'objects', 'local-lfs-object');
    run('git', ['config', 'lfs.storage', 'private-lfs-storage'], { cwd: fixture.apiCheckout });
    await mkdir(path.dirname(retained), { recursive: true });
    await writeFile(retained, 'locally retained configured LFS payload\n');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_LFS_UNVERIFIED'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(retained, 'utf8'), 'locally retained configured LFS payload\n');
  });

  await t.test('an unreachable Git object is treated as retained local work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-unreachable-object-'));
    const fixture = await attachedCapabilityWorkspace(root, 'unreachable-object');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const payload = path.join(root, 'unreachable-payload.txt');
    await writeFile(payload, 'Git object not named by any reference\n');
    const objectId = run('git', ['hash-object', '-w', payload], {
      cwd: fixture.apiCheckout
    }).stdout.trim();
    assert.match(run('git', [
      'fsck', '--unreachable', '--no-reflogs', '--no-progress', '--no-dangling'
    ], { cwd: fixture.apiCheckout }).stdout, new RegExp(`unreachable blob ${objectId}`));

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNPUSHED'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git', 'objects')),
      'the object database containing the unreachable object remains');
  });

  await t.test('an active Git operation marker blocks local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-git-operation-'));
    const fixture = await attachedCapabilityWorkspace(root, 'git-operation');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const marker = path.join(fixture.apiCheckout, '.git', 'MERGE_HEAD');
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: fixture.apiCheckout }).stdout.trim();
    await writeFile(marker, `${head}\n`);

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_OPERATION'
        && /MERGE_HEAD/.test(error.message)
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(marker, 'utf8'), `${head}\n`);
  });

  await t.test('a nonempty Git graft map blocks local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-grafts-'));
    const fixture = await attachedCapabilityWorkspace(root, 'grafts');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const grafts = path.join(fixture.apiCheckout, '.git', 'info', 'grafts');
    const head = run('git', ['rev-parse', 'HEAD'], { cwd: fixture.apiCheckout }).stdout.trim();
    await writeFile(grafts, `${head}\n`);

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_GRAPH_OVERRIDE'
        && /graft map/i.test(error.message)
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(grafts, 'utf8'), `${head}\n`);
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout carrying the graph override remains untouched');
  });

  await t.test('repository-local core.worktree cannot redirect proof away from managed bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-core-worktree-'));
    const fixture = await attachedCapabilityWorkspace(root, 'core-worktree');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const externalWorktree = path.join(root, 'clean-external-worktree');
    await mkdir(externalWorktree);
    await writeFile(path.join(externalWorktree, 'README.md'),
      await readFile(path.join(fixture.apiCheckout, 'README.md'), 'utf8'));
    run('git', ['config', 'core.worktree', externalWorktree], { cwd: fixture.apiCheckout });
    assert.equal(run('git', ['status', '--porcelain=v1'], {
      cwd: fixture.apiCheckout
    }).stdout, '', 'Git itself now reports only the redirected clean worktree');
    const retained = path.join(fixture.apiCheckout, 'managed-checkout-only.txt');
    await writeFile(retained, 'unique bytes Git cannot see through redirected core.worktree\n');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_EXTERNAL_GIT_DIR'
        && /worktree resolves outside/i.test(error.message)
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(retained, 'utf8'),
      'unique bytes Git cannot see through redirected core.worktree\n');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the managed checkout and its local Git configuration remain intact');
  });

  await t.test('an active Git writer lock blocks local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-git-lock-'));
    const fixture = await attachedCapabilityWorkspace(root, 'git-lock');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const lock = path.join(fixture.apiCheckout, '.git', 'index.lock');
    await writeFile(lock, 'active writer owns this lock\n');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_BUSY'
        && /index\.lock/.test(error.message)
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(lock, 'utf8'), 'active writer owns this lock\n');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'a checkout with an active writer lock remains untouched');
  });

  await t.test('a nested reflog writer lock blocks local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-reflog-lock-'));
    const fixture = await attachedCapabilityWorkspace(root, 'reflog-lock');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const lock = path.join(fixture.apiCheckout, '.git', 'logs', 'refs', 'heads', 'main.lock');
    await writeFile(lock, 'active reflog writer owns this lock\n');

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_BUSY'
        && /logs[/\\]refs[/\\]heads[/\\]main\.lock/.test(error.message)
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(await readFile(lock, 'utf8'), 'active reflog writer owns this lock\n');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'a checkout with a nested reflog lock remains untouched');
  });
});

test('workspace capability drop rejects repository-local transport configuration before remote access', async (t) => {
  await t.test('http.sslVerify=false is refused before an unavailable origin is contacted', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-local-http-config-'));
    const fixture = await attachedCapabilityWorkspace(root, 'local-http-config');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    run('git', ['config', '--local', 'http.sslVerify', 'false'], { cwd: fixture.apiCheckout });
    const unavailableRemote = `${fixture.apiRemote}.offline`;
    await rename(fixture.apiRemote, unavailableRemote);
    try {
      await assert.rejects(
        () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
          action: 'detach', dropLocal: true
        }),
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_CONFIG'
          && error?.details?.keys?.includes('http.sslverify')
      );
    } finally {
      await rename(unavailableRemote, fixture.apiRemote);
    }
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(run('git', ['config', '--local', '--get', 'http.sslVerify'], {
      cwd: fixture.apiCheckout
    }).stdout.trim(), 'false');
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout remains even though the origin would have failed if contacted');
  });

  await t.test('a credential.helper executable is refused without invocation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-local-helper-'));
    const fixture = await attachedCapabilityWorkspace(root, 'local-helper');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const marker = path.join(root, 'credential-helper-invoked.txt');
    const helper = path.join(root, 'credential-helper.sh');
    await writeFile(helper, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 1\n`, {
      mode: 0o700
    });
    run('git', ['config', '--local', 'credential.helper', helper], {
      cwd: fixture.apiCheckout
    });

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_CONFIG'
        && error?.details?.keys?.includes('credential.helper')
    );
    assert.equal(await stat(marker).catch(() => null), null,
      'local Git configuration is inspected as data and the helper is never executed');
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout carrying executable credential configuration is retained');
  });

  await t.test('unsafe worktree-scoped configuration is refused even when local scope is clean', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-worktree-config-'));
    const fixture = await attachedCapabilityWorkspace(root, 'worktree-config');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    run('git', ['config', '--local', 'extensions.worktreeConfig', 'true'], {
      cwd: fixture.apiCheckout
    });
    run('git', ['config', '--worktree', 'http.https://office.example/.sslVerify', 'false'], {
      cwd: fixture.apiCheckout
    });
    assert.equal(run('git', ['config', '--local', '--get',
      'http.https://office.example/.sslVerify'], {
      cwd: fixture.apiCheckout, allowFailure: true
    }).status, 1, 'the unsafe key is absent from the ordinary local scope');
    assert.equal(run('git', ['config', '--worktree', '--get',
      'http.https://office.example/.sslVerify'], {
      cwd: fixture.apiCheckout
    }).stdout.trim(), 'false');

    const unavailableRemote = `${fixture.apiRemote}.offline`;
    await rename(fixture.apiRemote, unavailableRemote);
    try {
      await assert.rejects(
        () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
          action: 'detach', dropLocal: true
        }),
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_GIT_CONFIG'
          && error?.details?.keys?.includes('http.https://office.example/.sslverify')
      );
    } finally {
      await rename(unavailableRemote, fixture.apiRemote);
    }
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
      'the checkout carrying worktree-scoped transport configuration is retained');
  });
});

test('workspace capability drop refreshes remote evidence and refuses deleted or unavailable remotes', async (t) => {
  await t.test('a remote branch deleted after attach leaves the local commit protected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-remote-delete-'));
    const fixture = await attachedCapabilityWorkspace(root, 'remote-delete');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    run('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: fixture.apiRemote });

    await assert.rejects(
      () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
        action: 'detach', dropLocal: true
      }),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNPUSHED'
    );
    assert.equal(await readFile(manifestFile, 'utf8'), before);
    assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], {
      cwd: fixture.apiCheckout, allowFailure: true
    }).status, 1, 'drop preview must fetch with prune instead of trusting stale remote-tracking refs');
  });

  await t.test('an unavailable remote cannot authorize local deletion', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-remote-offline-'));
    const fixture = await attachedCapabilityWorkspace(root, 'remote-offline');
    const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
    const before = await readFile(manifestFile, 'utf8');
    const unavailableRemote = `${fixture.apiRemote}.offline`;
    await rename(fixture.apiRemote, unavailableRemote);
    try {
      await assert.rejects(
        () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
          action: 'detach', dropLocal: true
        }),
        (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNVERIFIED'
          && /could not refresh origin/i.test(error.message)
      );
      assert.equal(await readFile(manifestFile, 'utf8'), before);
    } finally {
      await rename(unavailableRemote, fixture.apiRemote);
    }
  });
});

test('workspace capability attach refuses a pre-existing unregistered checkout without changing the manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-unregistered-'));
  const platformRemote = await remoteRepository(root, 'unregistered-platform');
  const apiRemote = await remoteRepository(root, 'unregistered-api');
  await approveCapabilityAuthority(root, platformRemote, {
    api: { name: 'API', kind: 'delivery', parent: null, repository: 'api' }
  }, {
    platform: { url: platformRemote }, api: { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'unregistered', name: 'Unregistered',
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] }
    }
  }, { confirmation: 'unregistered', clone: true });
  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  const unregistered = path.join(created.workspace.path, 'repos', 'api');
  run('git', ['clone', '--quiet', apiRemote, unregistered], {
    cwd: path.join(created.workspace.path, 'repos')
  });

  await assert.rejects(
    () => previewWorkspaceCapabilityChange(created.workspace.path, 'api', { action: 'attach' }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_TARGET_EXISTS'
      && error.message.includes(unregistered)
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);
  assert.ok(await stat(path.join(unregistered, '.git')), 'the unregistered checkout remains untouched');
});

test('workspace capability attach repairs only repositories in the requested capability closure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-scoped-repair-'));
  const platformRemote = await remoteRepository(root, 'scoped-platform');
  const apiRemote = await remoteRepository(root, 'scoped-api');
  const analyticsRemote = await remoteRepository(root, 'scoped-analytics');
  await approveCapabilityAuthority(root, platformRemote, {
    api: { name: 'API', kind: 'delivery', parent: null, repository: 'api' },
    analytics: { name: 'Analytics', kind: 'delivery', parent: null, repository: 'analytics' }
  }, {
    platform: { url: platformRemote },
    api: { url: apiRemote },
    analytics: { url: analyticsRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'scoped-repair', name: 'Scoped repair',
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] },
      api: { url: apiRemote, defaultBranch: 'main', path: 'repos/api', capabilities: [] },
      analytics: {
        url: analyticsRemote, defaultBranch: 'main', path: 'repos/analytics', capabilities: []
      }
    }
  }, { confirmation: 'scoped-repair', clone: true });
  const apiCheckout = path.join(created.workspace.path, 'repos', 'api');
  const analyticsCheckout = path.join(created.workspace.path, 'repos', 'analytics');
  await rm(apiCheckout, { recursive: true, force: true });
  await rm(analyticsCheckout, { recursive: true, force: true });

  const attach = await previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
    action: 'attach'
  });
  assert.deepEqual(attach.requestedRepositoryIds, ['api']);
  assert.deepEqual(attach.materializeRepositories, ['api']);
  const attached = await changeWorkspaceCapability(created.workspace.path, 'api', {
    action: 'attach'
  }, { confirmation: attach.planId });
  assert.deepEqual(attached.repair.map((entry) => entry.repository), ['api']);
  assert.ok(await stat(path.join(apiCheckout, '.git')), 'the requested missing checkout is repaired');
  assert.equal(await stat(analyticsCheckout).catch(() => null), null,
    'an unrelated missing checkout is not cloned as a side effect');
  assert.equal(attached.status.repositories.find((repository) => repository.id === 'analytics').state,
    'missing');
});

test('workspace capability reattach refuses a concurrent checkout at a registered missing target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-reattach-target-'));
  const fixture = await attachedCapabilityWorkspace(root, 'reattach-target');
  const detach = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach'
  });
  await changeWorkspaceCapability(fixture.workspace.path, 'api', { action: 'detach' }, {
    confirmation: detach.planId
  });
  await rm(fixture.apiCheckout, { recursive: true, force: true });
  const reattach = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'attach'
  });
  assert.deepEqual(reattach.addedRepositories, [], 'the missing repository remains registered');
  assert.deepEqual(reattach.materializeRepositories, ['api']);
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');

  run('git', ['clone', '--quiet', fixture.apiRemote, fixture.apiCheckout], {
    cwd: path.dirname(fixture.apiCheckout)
  });
  await assert.rejects(
    () => changeWorkspaceCapability(fixture.workspace.path, 'api', { action: 'attach' }, {
      confirmation: reattach.planId
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_CONFIRMATION_REQUIRED'
      && error?.details?.plan?.materializeRepositories?.length === 0
  );
  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path, {
      repositoryIds: reattach.requestedRepositoryIds,
      expectedMissingRepositoryIds: reattach.materializeRepositories
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_TARGET_EXISTS'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before,
    'the detached capability remains detached when another process creates its target');
  assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
    'the concurrent checkout is never adopted or removed');
});

test('a capability retired from the approved map remains detachable but cannot authorize local deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-retired-'));
  const fixture = await attachedCapabilityWorkspace(root, 'retired-capability');
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  await approveCapabilityAuthority(root, fixture.platformRemote, {
    'platform-core': {
      name: 'Platform core', kind: 'delivery', parent: null, repository: 'platform'
    }
  }, {
    platform: { url: fixture.platformRemote }, api: { url: fixture.apiRemote }
  });

  await assert.rejects(
    () => previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_RETIRED_DROP_REFUSED'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);

  const detach = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach'
  });
  const detached = await changeWorkspaceCapability(fixture.workspace.path, 'api', {
    action: 'detach'
  }, { confirmation: detach.planId });
  assert.deepEqual(detached.workspace.capabilities, []);
  assert.deepEqual(detached.workspace.repositories.api.capabilities, []);
  assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
    'non-destructive detach keeps the retired capability checkout available for inspection');
});

test('workspace capability drop permits a manifest-only detach when its owned checkout is already missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-missing-drop-'));
  const fixture = await attachedCapabilityWorkspace(root, 'missing-drop');
  await rm(fixture.apiCheckout, { recursive: true, force: true });
  const drop = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  });
  assert.deepEqual(drop.dropRepositories.map((repository) => ({
    id: repository.id, state: repository.state, removable: repository.removable
  })), [{ id: 'api', state: 'missing', removable: false }]);

  const detached = await changeWorkspaceCapability(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  }, { confirmation: drop.planId });
  assert.deepEqual(detached.workspace.capabilities, []);
  assert.equal(detached.workspace.repositories.api, undefined);
  assert.deepEqual(detached.dropped, []);
  assert.deepEqual(detached.removedRepositoryIds, ['api']);
  assert.equal(await stat(fixture.apiCheckout).catch(() => null), null);
});

test('a manifest-only capability drop becomes stale when its checkout appears before apply', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-missing-race-'));
  const fixture = await attachedCapabilityWorkspace(root, 'missing-race');
  await rm(fixture.apiCheckout, { recursive: true, force: true });
  const manifestFile = path.join(fixture.workspace.path, 'workspace.json');
  const before = await readFile(manifestFile, 'utf8');
  const drop = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  });
  assert.deepEqual(drop.dropRepositories.map(({ state, removable }) => ({ state, removable })), [
    { state: 'missing', removable: false }
  ]);

  run('git', ['clone', '--quiet', fixture.apiRemote, fixture.apiCheckout], {
    cwd: path.dirname(fixture.apiCheckout)
  });
  await assert.rejects(
    () => changeWorkspaceCapability(fixture.workspace.path, 'api', {
      action: 'detach', dropLocal: true
    }, { confirmation: drop.planId }),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_CONFIRMATION_REQUIRED'
      && /Preview again/.test(error.message)
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before);
  assert.ok(await stat(path.join(fixture.apiCheckout, '.git')),
    'the checkout that appeared after preview is never removed or adopted');
});

test('an active workspace selection is cleared after a direct backend capability drop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-selection-heal-'));
  const fixture = await attachedCapabilityWorkspace(root, 'selection-heal');
  const registry = path.join(root, 'workspaces.json');
  const selection = path.join(root, 'active-workspace.json');
  await rememberWorkspace(registry, fixture.workspace, await workspaceStatus(fixture.workspace.path));
  const selected = await activateWorkspaceContext(registry, selection, fixture.workspace.id, {
    repositoryId: 'api', detectStory: false
  });
  assert.equal(selected.repositoryId, 'api');

  const drop = await previewWorkspaceCapabilityChange(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  });
  await changeWorkspaceCapability(fixture.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  }, { confirmation: drop.planId });

  assert.equal(await readActiveWorkspaceContext(selection, registry), null,
    'crash recovery must not silently change the user selection to another repository');
  await assert.rejects(() => readFile(selection, 'utf8'), /ENOENT/,
    'the stale machine-local navigation cursor is removed');
});

test('workspace capability detach preserves shared and lead repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-shared-'));
  const platformRemote = await remoteRepository(root, 'platform');
  const apiRemote = await remoteRepository(root, 'api');
  await approveCapabilityAuthority(root, platformRemote, {
    'api-read': { name: 'API read', kind: 'delivery', parent: null, repository: 'api' },
    'api-write': { name: 'API write', kind: 'delivery', parent: null, repository: 'api' },
    platform: { name: 'Platform', kind: 'delivery', parent: null, repository: 'platform' }
  }, {
    platform: { url: platformRemote }, api: { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'shared', name: 'Shared',
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] }
    }
  }, { confirmation: 'shared', clone: true });
  for (const capabilityId of ['api-read', 'api-write', 'platform']) {
    const preview = await previewWorkspaceCapabilityChange(created.workspace.path, capabilityId, {
      action: 'attach'
    });
    await changeWorkspaceCapability(created.workspace.path, capabilityId, { action: 'attach' }, {
      confirmation: preview.planId
    });
  }
  const apiCheckout = path.join(created.workspace.path, 'repos', 'api');
  const shared = await previewWorkspaceCapabilityChange(created.workspace.path, 'api-read', {
    action: 'detach', dropLocal: true
  });
  assert.deepEqual(shared.dropRepositories, []);
  const detachedShared = await changeWorkspaceCapability(
    created.workspace.path, 'api-read', { action: 'detach', dropLocal: true },
    { confirmation: shared.planId }
  );
  assert.deepEqual(detachedShared.workspace.repositories.api.capabilities, ['api-write']);
  assert.ok(await stat(path.join(apiCheckout, '.git')), 'a repository shared by another capability remains');

  const lead = await previewWorkspaceCapabilityChange(created.workspace.path, 'platform', {
    action: 'detach', dropLocal: true
  });
  assert.equal(lead.preservedLeadRepository, 'platform');
  assert.deepEqual(lead.dropRepositories, []);
  const detachedLead = await changeWorkspaceCapability(
    created.workspace.path, 'platform', { action: 'detach', dropLocal: true },
    { confirmation: lead.planId }
  );
  assert.ok(await stat(path.join(created.workspace.path, 'repos', 'platform', '.git')),
    'the lead checkout remains even when its only capability is detached');
  assert.deepEqual(detachedLead.workspace.repositories.platform.capabilities, []);
});

test('workspace repair resolves only exact interrupted capability-drop transactions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-drop-recovery-'));
  const platformRemote = await remoteRepository(root, 'platform');
  const apiRemote = await remoteRepository(root, 'api');
  await approveCapabilityAuthority(root, platformRemote, {
    api: { name: 'API', kind: 'delivery', parent: null, repository: 'api' }
  }, {
    platform: { url: platformRemote }, api: { url: apiRemote }
  });
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'recover-drop', name: 'Recover drop',
    leadRepository: 'platform', capabilities: [], capabilityAuthority: { url: platformRemote },
    repositories: {
      platform: { url: platformRemote, defaultBranch: 'main', path: 'repos/platform', capabilities: [] }
    }
  }, { confirmation: 'recover-drop', clone: true });
  const attach = await previewWorkspaceCapabilityChange(created.workspace.path, 'api', { action: 'attach' });
  await changeWorkspaceCapability(created.workspace.path, 'api', { action: 'attach' }, {
    confirmation: attach.planId
  });

  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const sourceManifest = await readWorkspace(created.workspace.path);
  const checkout = path.join(created.workspace.path, 'repos', 'api');
  const drop = await previewWorkspaceCapabilityChange(created.workspace.path, 'api', {
    action: 'detach', dropLocal: true
  });
  const sourceManifestSha256 = drop.sourceManifestSha256;
  const targetManifest = drop.manifest;
  const targetManifestSha256 = drop.plan.targetManifestSha256;
  const [proof] = drop.dropRepositories;
  const plan = drop.plan;
  const restorePlan = drop.planId;
  const transaction = async (staged) => {
    const stagedInfo = await stat(staged);
    const unsigned = {
      schemaVersion: 1,
      format: 'workspace-capability-drop-v1',
      planId: restorePlan,
      phase: 'staged',
      workspace: created.workspace.path,
      sourceManifestSha256,
      targetManifestSha256,
      plan,
      repositories: [{
        id: 'api', relativePath: 'repos/api', source: checkout, staged,
        url: sourceManifest.repositories.api.url,
        defaultBranch: sourceManifest.repositories.api.defaultBranch,
        state: proof.state,
        removable: proof.removable,
        head: proof.head,
        worktreeSha256: proof.worktreeSha256,
        refsSha256: proof.refsSha256,
        directoryIdentity: proof.directoryIdentity,
        stagedIdentity: { device: String(stagedInfo.dev), inode: String(stagedInfo.ino) }
      }]
    };
    return { ...unsigned, transactionSha256: workspaceFixtureSha256(unsigned) };
  };

  const restoreRoot = path.join(
    created.workspace.path, '.singularity-flow', 'workspace-capability-drop', restorePlan
  );
  const restoreStaged = path.join(restoreRoot, 'api');
  await mkdir(restoreRoot, { recursive: true });
  await rename(checkout, restoreStaged);
  await writeFile(path.join(restoreRoot, 'transaction.json'),
    `${JSON.stringify(await transaction(restoreStaged), null, 2)}\n`);
  await repairWorkspace(created.workspace.path);
  assert.ok(await stat(path.join(checkout, '.git')), 'source-manifest recovery restores the checkout');
  assert.equal(await stat(restoreRoot).catch(() => null), null);

  const discardPlan = restorePlan;
  const discardRoot = path.join(
    created.workspace.path, '.singularity-flow', 'workspace-capability-drop', discardPlan
  );
  const discardStaged = path.join(discardRoot, 'api');
  await mkdir(discardRoot, { recursive: true });
  await rename(checkout, discardStaged);
  await writeFile(path.join(discardRoot, 'transaction.json'),
    `${JSON.stringify(await transaction(discardStaged), null, 2)}\n`);
  await writeFile(manifestFile, `${JSON.stringify(targetManifest, null, 2)}\n`);
  await repairWorkspace(created.workspace.path);
  assert.equal(await stat(discardStaged).catch(() => null), null,
    'target-manifest recovery deletes only the exact staged checkout');
  assert.equal(await stat(discardRoot).catch(() => null), null);
  assert.equal((await readWorkspace(created.workspace.path)).repositories.api, undefined);
});

test('workspace repair retains malformed, tampered, and third-state capability-drop transactions', async (t) => {
  await t.test('malformed transaction receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-recovery-malformed-'));
    const fixture = await stagedCapabilityDropFixture(root, 'recovery-malformed');
    await writeFile(fixture.transactionFile, '{ malformed receipt\n');

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
    );
    assert.ok(await stat(path.join(fixture.staged, '.git')),
      'malformed recovery evidence must never authorize deleting or restoring staged bytes');
    assert.ok(await stat(fixture.transactionFile), 'the malformed receipt remains for inspection');
  });

  await t.test('tampered sealed transaction receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-recovery-tampered-'));
    const fixture = await stagedCapabilityDropFixture(root, 'recovery-tampered');
    const tampered = structuredClone(fixture.transaction);
    tampered.repositories[0].head = 'f'.repeat(40);
    await writeFile(fixture.transactionFile, `${JSON.stringify(tampered, null, 2)}\n`);

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
        && /identity or digest is invalid/i.test(error.message)
    );
    assert.ok(await stat(path.join(fixture.staged, '.git')),
      'a broken transaction seal must retain the staged checkout');
    assert.ok(await stat(fixture.transactionFile), 'the tampered receipt remains for inspection');
  });

  await t.test('workspace manifest in a third state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-recovery-third-'));
    const fixture = await stagedCapabilityDropFixture(root, 'recovery-third-state');
    await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
    await writeFile(fixture.manifestFile, `${JSON.stringify({
      ...fixture.sourceManifest,
      name: 'Concurrent workspace edit',
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
        && /matches neither the recorded source nor target/i.test(error.message)
    );
    assert.ok(await stat(path.join(fixture.staged, '.git')),
      'an unrelated manifest state must retain the staged checkout');
    assert.ok(await stat(fixture.transactionFile), 'the exact receipt remains for manual recovery');
  });
});

test('workspace repair requires post-rename staged identity to equal the previewed checkout identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-staged-identity-'));
  const fixture = await stagedCapabilityDropFixture(root, 'staged-identity');
  assert.deepEqual(fixture.transaction.repositories[0].stagedIdentity,
    fixture.transaction.repositories[0].directoryIdentity,
    'a plain atomic rename retains the exact previewed directory identity');
  const changedIdentity = structuredClone(fixture.transaction);
  changedIdentity.repositories[0].stagedIdentity = {
    ...changedIdentity.repositories[0].stagedIdentity,
    inode: String(BigInt(changedIdentity.repositories[0].stagedIdentity.inode) + 1n)
  };
  const resealed = resealWorkspaceDropFixture(changedIdentity);
  await writeFile(fixture.transactionFile, `${JSON.stringify(resealed, null, 2)}\n`);

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
  );
  assert.ok(await stat(path.join(fixture.staged, '.git')),
    'a receipt claiming a different post-rename identity cannot move or delete the checkout');
  assert.ok(await stat(fixture.transactionFile));
});

test('workspace repair never deletes a replacement at the final quarantine path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-quarantine-replacement-'));
  const fixture = await stagedCapabilityDropFixture(root, 'quarantine-replacement');
  await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
  await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.targetManifest, null, 2)}\n`);
  const quarantine = `${fixture.staged}.deleting`;
  const preservedOriginal = path.join(root, 'preserved-original-checkout');
  await rename(fixture.staged, quarantine);
  await rename(quarantine, preservedOriginal);
  await mkdir(quarantine);
  const replacementMarker = path.join(quarantine, 'replacement-local-data.txt');
  await writeFile(replacementMarker, 'replacement with a different directory identity\n');

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
      && /final quarantine identity changed/i.test(error.message)
  );
  assert.equal(await readFile(replacementMarker, 'utf8'),
    'replacement with a different directory identity\n');
  assert.ok(await stat(path.join(preservedOriginal, '.git')),
    'the originally staged checkout is also retained outside the transaction path');
  assert.ok(await stat(fixture.transactionFile),
    'the transaction remains visible for manual inspection');
});

test('workspace repair retains drop staging when local work appears after the checkout rename', async (t) => {
  await t.test('ignored local file appears after staging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-staged-ignore-'));
    const fixture = await stagedCapabilityDropFixture(root, 'staged-ignore');
    await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
    await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.targetManifest, null, 2)}\n`);
    await writeFile(path.join(fixture.staged, '.git', 'info', 'exclude'), 'late-cache.bin\n');
    await writeFile(path.join(fixture.staged, 'late-cache.bin'), 'created after rename\n');

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_IGNORED'
    );
    assert.ok(await stat(path.join(fixture.staged, 'late-cache.bin')),
      'ignored bytes created after staging must be retained');
    assert.ok(await stat(fixture.transactionFile), 'the transaction remains available for inspection');
  });

  await t.test('an unpublished local ref appears after staging', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-staged-ref-'));
    const fixture = await stagedCapabilityDropFixture(root, 'staged-local-ref');
    await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
    await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.targetManifest, null, 2)}\n`);
    run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: fixture.staged });
    run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: fixture.staged });
    await writeFile(path.join(fixture.staged, 'late-commit.txt'), 'local-only commit\n');
    run('git', ['add', 'late-commit.txt'], { cwd: fixture.staged });
    run('git', ['commit', '-m', 'retain after staging'], { cwd: fixture.staged });
    run('git', ['branch', 'retain-local-only'], { cwd: fixture.staged });
    run('git', ['reset', '--hard', fixture.transaction.repositories[0].head], { cwd: fixture.staged });

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_UNPUSHED'
    );
    assert.ok(await stat(path.join(fixture.staged, '.git')),
      'a staged checkout with an unpublished ref must be retained');
    assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/retain-local-only'], {
      cwd: fixture.staged, allowFailure: true
    }).status, 0);
  });
});

test('workspace repair refuses a capability-drop transaction root containing unknown children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-recovery-extra-child-'));
  const fixture = await stagedCapabilityDropFixture(root, 'recovery-extra-child');
  await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
  const unknown = path.join(fixture.transactionRoot, 'unknown-local-data.txt');
  await writeFile(unknown, 'not covered by the sealed transaction\n');

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
  );
  assert.ok(await stat(path.join(fixture.staged, '.git')),
    'the staged checkout remains when its transaction directory has unknown content');
  assert.equal(await readFile(unknown, 'utf8'), 'not covered by the sealed transaction\n');
  assert.ok(await stat(fixture.transactionFile));
});

test('workspace repair rejects repository IDs that collide in the recovery namespace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-recovery-namespace-'));
  const fixture = await stagedCapabilityDropFixture(root, 'recovery-namespace');
  const receiptCollision = structuredClone(fixture.transaction);
  receiptCollision.repositories[0].id = 'transaction.json';
  await writeFile(fixture.transactionFile,
    `${JSON.stringify(resealWorkspaceDropFixture(receiptCollision), null, 2)}\n`);

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
      && /recovery namespace collision at 'transaction\.json'/i.test(error.message)
  );
  assert.ok(await stat(path.join(fixture.staged, '.git')));

  const quarantineCollision = structuredClone(fixture.transaction);
  quarantineCollision.repositories.push({
    ...structuredClone(quarantineCollision.repositories[0]),
    id: 'api.deleting'
  });
  await writeFile(fixture.transactionFile,
    `${JSON.stringify(resealWorkspaceDropFixture(quarantineCollision), null, 2)}\n`);

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
      && /recovery namespace collision at 'api\.deleting'/i.test(error.message)
  );
  assert.ok(await stat(path.join(fixture.staged, '.git')),
    'colliding transaction names must never authorize recovery of the staged checkout');
  assert.ok(await stat(fixture.transactionFile));
});

test('workspace repair does not delete a staged checkout aliased by a retained lead path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-recovery-retained-alias-'));
  const fixture = await stagedCapabilityDropFixture(root, 'recovery-retained-alias');
  await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
  await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.targetManifest, null, 2)}\n`);
  const lead = path.join(fixture.workspace.path, 'repos', 'platform');
  const preservedLead = path.join(root, 'preserved-platform');
  await rename(lead, preservedLead);
  await symlink(fixture.staged, lead, 'dir');

  await assert.rejects(
    () => repairWorkspace(fixture.workspace.path),
    (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
      && /overlaps retained repository 'platform'/i.test(error.message)
  );
  assert.ok(await stat(path.join(fixture.staged, '.git')),
    'recursive recovery deletion must not remove bytes visible through a retained repository path');
  assert.equal(await realpath(lead), await realpath(fixture.staged));
  assert.ok(await stat(path.join(preservedLead, '.git')));
  assert.ok(await stat(fixture.transactionFile));
});

test('workspace capability-drop recovery refuses symlinked roots and ancestors without touching outside data', async (t) => {
  await t.test('the recovery root itself is a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-root-symlink-'));
    const fixture = await attachedCapabilityWorkspace(root, 'root-symlink');
    const recoveryRoot = path.join(
      fixture.workspace.path, '.singularity-flow', 'workspace-capability-drop'
    );
    const outside = path.join(root, 'outside-recovery-root');
    const marker = path.join(outside, 'do-not-touch.txt');
    await mkdir(outside);
    await writeFile(marker, 'outside root data\n');
    await mkdir(path.dirname(recoveryRoot), { recursive: true });
    await rm(recoveryRoot, { recursive: true, force: true });
    await symlink(outside, recoveryRoot, 'dir');

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
    );
    assert.equal(await readFile(marker, 'utf8'), 'outside root data\n');
    assert.equal((await stat(outside)).isDirectory(), true);
  });

  await t.test('a symlinked recovery-root ancestor is rejected', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-ancestor-symlink-'));
    const fixture = await attachedCapabilityWorkspace(root, 'ancestor-symlink');
    const sflowDirectory = path.join(fixture.workspace.path, '.singularity-flow');
    const outside = path.join(root, 'outside-sflow-directory');
    const marker = path.join(outside, 'do-not-touch.txt');
    await rm(sflowDirectory, { recursive: true, force: true });
    await mkdir(path.join(outside, 'workspace-capability-drop'), { recursive: true });
    await writeFile(marker, 'outside ancestor data\n');
    await symlink(outside, sflowDirectory, 'dir');

    await assert.rejects(
      () => repairWorkspace(fixture.workspace.path),
      (error) => error?.code === 'WORKSPACE_CAPABILITY_DROP_RECOVERY_BLOCKED'
    );
    assert.equal(await readFile(marker, 'utf8'), 'outside ancestor data\n');
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});

test('workspace capability-drop recovery tolerates an unrelated origin branch advancing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-capability-unrelated-origin-'));
  const fixture = await stagedCapabilityDropFixture(root, 'unrelated-origin');
  await writeFile(fixture.transactionFile, `${JSON.stringify(fixture.transaction, null, 2)}\n`);
  await writeFile(fixture.manifestFile, `${JSON.stringify(fixture.targetManifest, null, 2)}\n`);

  const originalHead = fixture.transaction.repositories[0].head;
  run('git', ['update-ref', 'refs/heads/unrelated', originalHead], { cwd: fixture.apiRemote });
  const publisher = path.join(root, 'unrelated-publisher');
  run('git', ['clone', '--quiet', fixture.apiRemote, publisher], { cwd: root });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: publisher });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: publisher });
  run('git', ['checkout', '-b', 'unrelated', 'origin/unrelated'], { cwd: publisher });
  await writeFile(path.join(publisher, 'unrelated.txt'), 'advance only the unrelated branch\n');
  run('git', ['add', 'unrelated.txt'], { cwd: publisher });
  run('git', ['commit', '-m', 'advance unrelated branch'], { cwd: publisher });
  run('git', ['push', 'origin', 'unrelated'], { cwd: publisher });

  await repairWorkspace(fixture.workspace.path);
  assert.equal(await stat(fixture.staged).catch(() => null), null,
    'fresh unrelated remote-tracking evidence does not make the sealed checkout itself stale');
  assert.equal(await stat(fixture.transactionRoot).catch(() => null), null);
  assert.equal((await readWorkspace(fixture.workspace.path)).repositories.api, undefined);
});

test('local Git value reads are bounded and terminate a stalled child', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    // A cooperative wrapper may report success while exiting in response to SIGTERM. Once the
    // operation deadline fired, that late exit must not turn partial output into a valid Git fact.
    queueMicrotask(() => child.emit('close', 0));
    return true;
  };
  const value = await gitValueAsync('/repository', ['status', '--porcelain'], {
    timeoutMs: 5,
    spawnCommand: () => child
  });
  assert.equal(value, null);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('the first capability can be onboarded outside every repository and without a workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-first-capability-'));
  const lead = await remoteRepository(root, 'platform');
  const outside = path.join(root, 'empty-window');
  const activeWorkspace = path.join(root, 'active-workspace.json');
  const workspaceRegistry = path.join(root, 'workspaces.json');
  const leadRegistry = path.join(root, 'leads.json');
  await mkdir(outside);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: workspaceRegistry,
    SINGULARITY_FLOW_LEAD_REGISTRY: leadRegistry
  };

  const empty = spawnSync(process.execPath, [cli, 'capability', 'leads', '--json'], {
    cwd: outside, env, encoding: 'utf8'
  });
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), []);

  const missingLead = spawnSync(process.execPath, [cli,
    'capability', 'map', 'platform-api', '--kind', 'delivery', '--json'
  ], { cwd: outside, env, encoding: 'utf8' });
  assert.notEqual(missingLead.status, 0);
  assert.match(missingLead.stderr, /no workspace or prior bootstrap is required/i,
    'first-run guidance must not send the user into the workspace/bootstrap deadlock');

  const mapped = spawnSync(process.execPath, [cli,
    'capability', 'map', 'platform-api',
    '--lead', lead,
    '--kind', 'delivery',
    '--name', 'Platform API',
    '--repository', lead,
    '--source-roots', 'apps/platform',
    '--shared-roots', 'packages/contracts',
    '--clone-mode', 'blobless-sparse',
    '--sparse-cone', 'apps/platform,packages/contracts',
    '--clone-fallback', 'refuse',
    '--json'
  ], { cwd: outside, env, encoding: 'utf8' });
  assert.equal(mapped.status, 0, mapped.stderr);
  const result = JSON.parse(mapped.stdout);
  assert.equal(result.capabilityId, 'platform-api');
  assert.equal(result.lead, lead);
  assert.equal(result.reviewRequired, true);
  assert.match(result.branch, /^sflow\/config-change\/capability\/map-platform-api-/);
  const proposedCapabilities = run('git', ['show', `${result.branch}:singularity/capabilities.yml`], { cwd: lead }).stdout;
  const proposedPortfolio = run('git', ['show', `${result.branch}:singularity/portfolio.yml`], { cwd: lead }).stdout;
  assert.match(proposedCapabilities, /sourceRoots:\s*\n\s*- apps\/platform/);
  assert.match(proposedCapabilities, /sharedRoots:\s*\n\s*- packages\/contracts/);
  assert.match(proposedPortfolio, /mode: blobless-sparse/);
  assert.match(proposedPortfolio,
    /sparseCone: \[\.github\/agents, apps\/platform, packages\/contracts, singularity\]/);
  assert.match(proposedPortfolio, /fallback: refuse/);
  assert.equal(run('git', ['show', 'main:README.md'], { cwd: lead }).stdout, '# platform\n',
    'first capability onboarding never changes the application base branch');
  await assert.rejects(readFile(activeWorkspace), { code: 'ENOENT' });
  await assert.rejects(readFile(workspaceRegistry), { code: 'ENOENT' });
});

/**
 * The same remote, but actually a Singularity Flow repository.
 *
 * `remoteRepository` produces a clone holding a README, which is enough for every test about
 * cloning and registry bookkeeping and is not enough to ask a session question of. Anything
 * asserting that a session resolves through a workspace needs a repository the engine will load.
 */
async function governedRemoteRepository(base, name) {
  const source = path.join(base, `${name}-source`);
  const bare = path.join(base, `${name}.git`);
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), `# ${name}\n`);
  await mkdir(path.join(source, 'singularity/templates/chore'), { recursive: true });
  await writeFile(path.join(source, 'singularity/templates/chore/intake.md'), '# Intake\n\nWhat is being asked for.\n');
  await writeFile(path.join(source, 'singularity/workflow.yml'), [
    'version: 2',
    'defaultBaseBranch: main',
    'workItemRoot: singularity/work-items',
    'templatesRoot: singularity/templates',
    'worldModel:',
    '  views: [business, architecture, development, testing, release, operations, security]',
    '  outputDir: singularity/world-model',
    'phases:',
    '  intake:',
    '    id: intake',
    '    label: Intake',
    '    writeScope: artifact-only',
    '    defaultTemplate: chore/intake.md',
    '    artifact:',
    '      path: artifacts/intake/intake.md',
    'workTypes:',
    '  chore:',
    '    label: Chore',
    '    phases: [intake]',
    ''
  ].join('\n'));
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initial'], { cwd: source });
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  return bare;
}

function workspaceInput(baseDirectory, repositories) {
  return {
    baseDirectory,
    anchor: {
      provider: 'jira',
      baseUrl: 'https://office.atlassian.net',
      key: 'PAY-100',
      issueTypeId: '10000',
      issueTypeName: 'Business Initiative',
      hierarchyLevel: 2,
      title: 'Payments modernization'
    },
    leadRepository: 'platform',
    repositories
  };
}

test('workspace anchors follow Jira hierarchy levels without hard-coded Initiative naming', () => {
  const anchor = normalizeWorkspaceAnchor({
    baseUrl: 'https://office.atlassian.net',
    key: 'pay-100',
    issueTypeName: 'Portfolio Goal',
    hierarchyLevel: 3,
    title: 'Payments'
  });
  assert.equal(anchor.key, 'PAY-100');
  assert.equal(anchor.siteId, 'office.atlassian.net');
  assert.equal(anchor.issueTypeName, 'Portfolio Goal');
  assert.throws(() => normalizeWorkspaceAnchor({
    baseUrl: 'https://office.atlassian.net',
    key: 'PAY-101',
    issueTypeName: 'Story',
    hierarchyLevel: 0
  }), /below Epic/);
});

test('workspace configuration is independent from Jira hierarchy and pins repository routing metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-config-'));
  const preview = previewWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'experience',
    repositories: {
      experience: {
        url: path.join(root, 'experience.git'),
        defaultBranch: 'main',
        role: 'participant',
        jira: { board: 'PAY Experience' },
        metadata: { appId: 'APP-1001', name: 'Customer experience', owner: 'Digital' }
      },
      services: {
        url: path.join(root, 'services.git'),
        defaultBranch: 'main',
        role: 'lead',
        jira: { board: 'PAY-SVC' },
        metadata: { appId: 'APP-1002', name: 'Payment services' }
      }
    }
  });
  assert.equal(preview.manifest.anchor.provider, 'workspace');
  assert.equal(preview.manifest.anchor.issueTypeName, 'Workspace');
  assert.equal(preview.manifest.repositories.experience.role, 'lead');
  assert.equal(preview.manifest.repositories.services.role, 'participant');
  assert.equal(preview.manifest.repositories.experience.jira.board, 'PAY Experience');
  assert.equal(preview.manifest.repositories.experience.metadata.appId, 'APP-1001');
  await assert.rejects(
    () => createWorkspaceConfiguration({
      baseDirectory: path.join(root, 'workspaces'),
      id: 'payments-platform',
      name: 'Payments platform',
      leadRepository: 'experience',
      repositories: preview.manifest.repositories
    }, { confirmation: 'wrong', clone: false }),
    /exact workspace-ID confirmation/
  );
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'experience',
    repositories: preview.manifest.repositories
  }, { confirmation: 'payments-platform', clone: false });
  assert.equal(created.workspace.name, 'Payments platform');
  assert.equal(created.workspace.leadRepository, 'experience');
  assert.equal(created.workspace.repositories.services.jira.board, 'PAY-SVC');
});

test('a clean existing clone can be adopted without changing its Git state or bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-adopt-clean-'));
  const remote = await remoteRepository(root, 'platform');
  const clone = path.join(root, 'existing-clone');
  run('git', ['clone', remote, clone], { cwd: root });
  const before = {
    head: run('git', ['rev-parse', 'HEAD'], { cwd: clone }).stdout.trim(),
    branch: run('git', ['branch', '--show-current'], { cwd: clone }).stdout.trim(),
    status: run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: clone }).stdout,
    origin: run('git', ['remote', 'get-url', 'origin'], { cwd: clone }).stdout.trim(),
    readme: await readFile(path.join(clone, 'README.md'), 'utf8')
  };
  const adopted = await adoptWorkspaceConfiguration({
    cloneDirectory: clone,
    id: 'adopted-platform',
    name: 'Adopted platform',
    baseDirectory: path.join(root, 'workspaces')
  }, { confirmation: 'adopted-platform' });

  const configured = adopted.workspace.repositories[adopted.workspace.leadRepository];
  assert.equal(workspaceRepositoryPath(adopted.workspace, configured), await realpath(clone));
  assert.equal(adopted.status.healthy, true);
  assert.equal(adopted.materialization[0].actual.mode, 'adopted-existing-clone');
  assert.deepEqual({
    head: run('git', ['rev-parse', 'HEAD'], { cwd: clone }).stdout.trim(),
    branch: run('git', ['branch', '--show-current'], { cwd: clone }).stdout.trim(),
    status: run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: clone }).stdout,
    origin: run('git', ['remote', 'get-url', 'origin'], { cwd: clone }).stdout.trim(),
    readme: await readFile(path.join(clone, 'README.md'), 'utf8')
  }, before);
});

test('workspace adoption never persists credentials embedded in an origin URL', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-adopt-credentials-'));
  const repository = path.join(root, 'repository');
  await mkdir(repository);
  run('git', ['init', '-b', 'main'], { cwd: repository });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: repository });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), '# repository\n');
  run('git', ['add', '.'], { cwd: repository });
  run('git', ['commit', '-m', 'initial'], { cwd: repository });
  run('git', ['remote', 'add', 'origin', 'https://alice:office-token@example.com/acme/repository.git'], {
    cwd: repository
  });

  const defaults = await workspaceRepositoryDefaults(repository);
  assert.equal(defaults.url, 'https://example.com/acme/repository.git');
  assert.equal(defaults.adoption.origin, defaults.url);
  assert.doesNotMatch(JSON.stringify(defaults), /alice|office-token/);
  const adopted = await adoptWorkspaceConfiguration({
    cloneDirectory: repository,
    id: 'credential-safe',
    name: 'Credential safe',
    baseDirectory: path.join(root, 'workspaces')
  }, { confirmation: 'credential-safe' });
  assert.doesNotMatch(JSON.stringify(adopted), /alice|office-token/);
  assert.doesNotMatch(await readFile(path.join(adopted.workspace.path, 'workspace.json'), 'utf8'),
    /alice|office-token/);
});

test('workspace adoption preserves literal query characters in a local Git authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-adopt-literal-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = await remoteRepository(root, 'authority?blue');
  const clone = path.join(root, 'existing-clone');
  run('git', ['clone', remote, clone], { cwd: root });

  const defaults = await workspaceRepositoryDefaults(clone);
  assert.equal(defaults.url, remote,
    'diagnostic sanitization must not change the operational local-path authority');
  const adopted = await adoptWorkspaceConfiguration({
    cloneDirectory: clone,
    id: 'literal-authority',
    name: 'Literal authority',
    baseDirectory: path.join(root, 'workspaces')
  }, { confirmation: 'literal-authority' });
  assert.equal(adopted.workspace.repositories[adopted.workspace.leadRepository].url, remote);
  assert.equal(adopted.status.repositories[0].state, 'ready');
});

test('dirty-clone adoption requires a content-bound confirmation and never cleans the clone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-adopt-dirty-'));
  const remote = await remoteRepository(root, 'platform');
  const clone = path.join(root, 'dirty-clone');
  run('git', ['clone', remote, clone], { cwd: root });
  await writeFile(path.join(clone, 'README.md'), '# locally edited platform\n');
  await writeFile(path.join(clone, 'notes.txt'), 'do not remove\n');

  const dryRun = await adoptWorkspaceConfiguration({
    cloneDirectory: clone, id: 'dirty-platform', baseDirectory: path.join(root, 'workspaces')
  }, { dryRun: true });
  const dirtyHash = dryRun.plan.dirtyConfirmationRequired;
  assert.match(dirtyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await stat(dryRun.plan.workspace.path).catch(() => null), null, 'dry-run created a workspace shell');
  await assert.rejects(() => adoptWorkspaceConfiguration({
    cloneDirectory: clone, id: 'dirty-platform', baseDirectory: path.join(root, 'workspaces')
  }, { confirmation: 'dirty-platform' }), (error) => error.code === 'WORKSPACE_ADOPTION_DIRTY_CONFIRMATION_REQUIRED');

  // The confirmation binds bytes, not merely the unchanged Git status row.
  await writeFile(path.join(clone, 'README.md'), '# a different local edit\n');
  await assert.rejects(() => adoptWorkspaceConfiguration({
    cloneDirectory: clone, id: 'dirty-platform', baseDirectory: path.join(root, 'workspaces'),
    dirtyConfirmation: dirtyHash
  }, { confirmation: 'dirty-platform' }), (error) => error.code === 'WORKSPACE_ADOPTION_DIRTY_CONFIRMATION_REQUIRED');
  const refreshed = await adoptWorkspaceConfiguration({
    cloneDirectory: clone, id: 'dirty-platform', baseDirectory: path.join(root, 'workspaces')
  }, { dryRun: true });
  const created = await adoptWorkspaceConfiguration({
    cloneDirectory: clone, id: 'dirty-platform', baseDirectory: path.join(root, 'workspaces'),
    dirtyConfirmation: refreshed.plan.dirtyConfirmationRequired
  }, { confirmation: 'dirty-platform' });
  assert.equal(created.status.repositories[0].dirty, true);
  assert.equal(await readFile(path.join(clone, 'README.md'), 'utf8'), '# a different local edit\n');
  assert.equal(await readFile(path.join(clone, 'notes.txt'), 'utf8'), 'do not remove\n');
});

test('workspace Jira project routing is optional and can be added later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-optional-jira-'));
  const remote = await remoteRepository(root, 'platform');
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'optional-jira',
    name: 'Optional Jira',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        jira: {},
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  }, { confirmation: 'optional-jira' });
  assert.equal(created.workspace.repositories.platform.jira.board, null);

  const updated = await updateWorkspaceConfiguration(created.workspace.path, {
    name: created.workspace.name,
    leadRepository: 'platform',
    repositories: {
      platform: {
        ...created.workspace.repositories.platform,
        jira: { board: 'KAN' }
      }
    }
  }, { confirmation: 'optional-jira' });
  assert.equal(updated.workspace.repositories.platform.jira.board, 'KAN');
});

test('workspace creation claims an empty repository folder and clones the configured branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-empty-clone-'));
  const remote = await remoteRepository(root, 'platform');
  const source = path.join(root, 'platform-source');
  run('git', ['switch', '-c', 'release/2026.07'], { cwd: source });
  await writeFile(path.join(source, 'BRANCH.txt'), 'configured branch\n');
  run('git', ['add', 'BRANCH.txt'], { cwd: source });
  run('git', ['commit', '-m', 'add release branch marker'], { cwd: source });
  run('git', ['push', remote, 'release/2026.07'], { cwd: source });

  const options = {
    baseDirectory: path.join(root, 'workspaces'),
    id: 'branch-workspace',
    name: 'Branch workspace',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'release/2026.07',
        required: true,
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  };
  const reserved = await createWorkspaceConfiguration(options, {
    confirmation: 'branch-workspace',
    clone: false
  });
  const target = path.join(reserved.workspace.path, 'repos/platform');
  await mkdir(target);

  const saved = await saveWorkspaceConfiguration(options, { confirmation: 'branch-workspace' });
  assert.equal(saved.status.healthy, true);
  assert.equal(saved.status.repositories[0].branch, 'release/2026.07');
  assert.equal(await readFile(path.join(target, 'BRANCH.txt'), 'utf8'), 'configured branch\n');
  assert.equal(saved.status.repositories[0].worldModel.state, 'missing');
  assert.equal(saved.status.repositories[0].worldModel.projectionStatus, 'not-projected');
  assert.equal(saved.status.warnings[0].code, 'world-model-missing');
  assert.match(saved.status.warnings[0].message, /No world model is projected into the checked-out application branch/);
});

test('workspace health recognizes an existing repository world model without warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-world-model-'));
  const remote = await remoteRepository(root, 'platform');
  const source = path.join(root, 'platform-source');
  await mkdir(path.join(source, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(source, 'singularity/world-model/manifest.json'), JSON.stringify({
    generated_at: '2026-07-28T04:30:00.000Z'
  }));
  run('git', ['add', 'singularity/world-model/manifest.json'], { cwd: source });
  run('git', ['commit', '-m', 'add repository world model'], { cwd: source });
  run('git', ['push', remote, 'main'], { cwd: source });

  const saved = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'grounded-workspace',
    name: 'Grounded workspace',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  }, { confirmation: 'grounded-workspace' });

  assert.equal(saved.status.repositories[0].worldModel.state, 'available');
  assert.equal(saved.status.repositories[0].worldModel.generatedAt, '2026-07-28T04:30:00.000Z');
  assert.equal(saved.status.counts.worldModels, 1);
  assert.deepEqual(saved.status.warnings, []);
});

test('workspace health resolves a validated custom-output model from governed state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-state-world-model-'));
  const source = path.join(root, 'source');
  run('git', ['init', '-b', 'main', source], { cwd: root });
  run('git', ['config', 'user.name', 'Workspace Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'workspace@example.com'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# state model\n');
  await initializeDefinition(source);
  const workflowPath = path.join(source, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.worldModel.outputDir = 'governed/repository-model';
  await writeFile(workflowPath, YAML.stringify(workflow));
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initialize custom model output'], { cwd: source });
  const mainCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  const sourceState = await worldModelSourceSnapshot(source, workflow);

  run('git', ['switch', '-c', 'state'], { cwd: source });
  const directory = path.join(source, 'governed/repository-model');
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), '# Brief\n');
  await writeFile(path.join(directory, 'core/summary.md'), '# Full\n');
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), '{}\n');
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeV3Manifest(directory, {
    schema_version: '3.0', generated_at: '2026-08-31T00:00:00.000Z',
    generated_date: '31 August 2026', builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64), analysis_depth: 'standard',
    repository_commit: mainCommit, repository_branch: 'main', working_tree_clean: true,
    source_tree_sha256: sourceState.sha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      },
      model: { path: 'core/model.json' }
    },
    views: {}, domains: [], task_guides: [],
    path_index: { path: 'path-index.json' }, evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  });
  run('git', ['add', 'governed/repository-model'], { cwd: source });
  run('git', ['commit', '-m', 'publish governed state model'], { cwd: source });
  run('git', ['switch', 'main'], { cwd: source });
  const remote = path.join(root, 'platform.git');
  run('git', ['clone', '--bare', source, remote], { cwd: root });

  const saved = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'state-grounded', name: 'State grounded', leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote, defaultBranch: 'main', required: true,
        metadata: { appId: 'APP-PLATFORM', name: 'Platform' }
      }
    }
  }, { confirmation: 'state-grounded' });
  const model = saved.status.repositories[0].worldModel;
  assert.equal(model.state, 'available');
  assert.equal(model.source, 'state-branch');
  assert.equal(model.outputDirectory, 'governed/repository-model');
  assert.equal(model.generatedAt, '2026-08-31T00:00:00.000Z');
  assert.deepEqual(saved.status.warnings, []);
});

test('workspace manifest keeps repositories isolated below repos and requires a lead', () => {
  const base = {
    version: 1,
    id: 'office--PAY-100',
    anchor: {
      siteId: 'office',
      key: 'PAY-100',
      issueTypeName: 'Epic',
      hierarchyLevel: 1
    },
    leadRepository: 'mobile',
    repositories: {
      mobile: { url: 'git@example/mobile.git', path: 'repos/mobile', defaultBranch: 'main' }
    }
  };
  assert.equal(validateWorkspaceManifest(base).repositories.mobile.role, 'lead');
  const escaped = structuredClone(base);
  escaped.repositories.mobile.path = '../mobile';
  assert.throws(() => validateWorkspaceManifest(escaped), /inside the workspace/);
  const missing = structuredClone(base);
  missing.leadRepository = 'api';
  assert.throws(() => validateWorkspaceManifest(missing), /not in the workspace registry/);
  const unsafeLogs = structuredClone(base);
  unsafeLogs.directories = { logs: 'documents/logs' };
  assert.throws(() => validateWorkspaceManifest(unsafeLogs), /must be logs/);
  const unsafeClone = structuredClone(base);
  unsafeClone.repositories.mobile.url = '--upload-pack=malicious';
  assert.throws(() => validateWorkspaceManifest(unsafeClone), /unsafe clone URL/);
});

test('workspace creates isolated clones, stages ungoverned documents, and can be reconstructed from its manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-'));
  const mobile = await remoteRepository(root, 'mobile');
  const platform = await remoteRepository(root, 'platform');
  const platformSource = path.join(root, 'platform-source');
  run('git', ['switch', '-c', 'KAN-8'], { cwd: platformSource });
  await writeFile(path.join(platformSource, 'KAN-8.md'), '# Governed Epic\n');
  run('git', ['add', '.'], { cwd: platformSource });
  run('git', ['commit', '-m', 'Add governed Epic branch'], { cwd: platformSource });
  run('git', ['push', platform, 'KAN-8'], { cwd: platformSource });
  run('git', ['switch', 'main'], { cwd: platformSource });
  const baseDirectory = path.join(root, 'workspaces');
  const input = workspaceInput(baseDirectory, {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform', metadata: { appId: 'APP-PLATFORM', name: 'Shared platform' } },
    mobile: { url: mobile, defaultBranch: 'main', required: true, path: 'repos/mobile', metadata: { appId: 'APP-MOBILE', owner: 'Digital' } }
  });
  const preview = previewWorkspace(input);
  assert.match(preview.root, /PAY-100--payments-modernization$/);
  assert.equal(preview.operations.length, 2);
  await assert.rejects(() => createWorkspace(input, { confirmation: 'WRONG' }), /exact Jira-key confirmation/);

  const created = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(created.created, true);
  assert.equal(created.status.healthy, true);
  assert.equal(created.status.level, 'full');
  assert.notEqual(created.status.repositories[0].absolutePath, created.status.repositories[1].absolutePath);
  const loaded = await readWorkspace(created.workspace.path);
  assert.equal(loaded.anchor.issueTypeName, 'Business Initiative');
  assert.equal(loaded.localOnly, true);
  assert.deepEqual(loaded.repositories.platform.metadata, { appId: 'APP-PLATFORM', name: 'Shared platform' });
  assert.deepEqual(loaded.repositories.mobile.metadata, { appId: 'APP-MOBILE', owner: 'Digital' });

  const readiness = await workspaceStatus(created.workspace.path, { level: 'readiness' });
  assert.equal(readiness.healthy, true);
  assert.equal(readiness.level, 'readiness');
  assert.equal(readiness.stagedDocuments.length, 0);
  assert.ok(readiness.repositories.every((repository) => repository.worldModel === null));
  await assert.rejects(
    () => workspaceStatus(created.workspace.path, { level: 'expensive-and-unknown' }),
    /Unknown workspace status level/
  );

  const requirement = path.join(root, 'requirement.pdf');
  await writeFile(requirement, 'pinned requirement');
  const staged = await stageWorkspaceDocuments(created.workspace.path, [requirement]);
  assert.equal(staged.added[0].status, 'staged-not-governed');
  assert.match(staged.warning, /not governed/);
  assert.equal((await listWorkspaceDocuments(created.workspace.path)).length, 1);
  const resolved = await resolveWorkspaceDocument(created.workspace.path, staged.added[0].path);
  assert.equal(resolved.absolutePath, path.join(created.workspace.path, staged.added[0].path));
  await assert.rejects(
    () => resolveWorkspaceDocument(created.workspace.path, 'documents/inbox/missing.pdf'),
    /not in the staged-document inbox/
  );

  const lead = created.status.leadRepositoryPath;
  assert.equal(
    run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/KAN-8'], { cwd: lead, allowFailure: true }).status,
    0,
    'workspace clones must retain remote governed branches'
  );
  await writeFile(path.join(lead, 'local.txt'), 'dirty');
  const fetched = await fetchWorkspace(created.workspace.path);
  assert.equal(fetched.results.find((item) => item.repository === 'platform').reason, 'dirty');
});

test('workspace registry is local, bounded, and forget never deletes workspace files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-registry-'));
  const registry = path.join(root, 'registry.json');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'uncloned.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  await rememberWorkspace(registry, created.workspace, created.status);
  let entries = await readWorkspaceRegistry(registry);
  assert.equal(entries[0].anchorKey, 'PAY-100');
  await forgetWorkspace(registry, created.workspace.path);
  entries = await readWorkspaceRegistry(registry);
  assert.deepEqual(entries, []);
  assert.equal(JSON.parse(await readFile(path.join(created.workspace.path, 'workspace.json'), 'utf8')).anchor.key, 'PAY-100');
});

test('the registry caps active recency without deleting archived workspace history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-registry-archive-cap-'));
  const registry = path.join(root, 'registry.json');
  const make = async (index) => createWorkspace({
    ...workspaceInput(path.join(root, 'workspaces'), {
      platform: { url: path.join(root, `${index}.git`), defaultBranch: 'main', required: true, path: 'repos/platform' }
    }),
    anchor: { ...workspaceInput(path.join(root, 'unused'), {}).anchor, key: `PAY-${index}`, title: `Workspace ${index}` }
  }, { confirmation: `PAY-${index}`, clone: false });

  const archived = await make(0);
  await rememberWorkspace(registry, archived.workspace, archived.status);
  const persisted = JSON.parse(await readFile(registry, 'utf8'));
  persisted.workspaces[0].archivedAt = '2026-08-01T00:00:00.000Z';
  await writeFile(registry, `${JSON.stringify(persisted, null, 2)}\n`);
  for (let index = 1; index <= 21; index += 1) {
    const created = await make(index);
    await rememberWorkspace(registry, created.workspace, created.status);
  }

  const entries = await readWorkspaceRegistry(registry);
  assert.equal(entries.filter((entry) => !entry.archivedAt).length, 20);
  assert.equal(entries.filter((entry) => entry.archivedAt).length, 1);
  assert.ok(entries.some((entry) => entry.anchorKey === 'PAY-0'));
});

test('workspace registry discards explicit non-v2 workflows without deleting workspace files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-v2-only-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const lead = created.status.leadRepositoryPath;
  await mkdir(path.join(lead, 'singularity'), { recursive: true });
  await writeFile(path.join(lead, 'singularity', 'workflow.yml'), 'version: 1\nworkTypes: {}\n');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: created.workspace.id,
    workspacePath: created.workspace.path
  })}\n`);

  const result = await discardUnsupportedWorkflowWorkspaces(registry, selection);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].version, 1);
  assert.deepEqual(await readWorkspaceRegistry(registry), []);
  await assert.rejects(() => readFile(selection, 'utf8'), /ENOENT/);
  assert.equal(JSON.parse(await readFile(path.join(created.workspace.path, 'workspace.json'), 'utf8')).anchor.key, 'PAY-100');
  assert.equal((await readFile(path.join(lead, 'singularity', 'workflow.yml'), 'utf8')).startsWith('version: 1'), true,
    'forgetting a registration must not delete or rewrite the repository');
});

test('workspace registry retains uninitialized and repairable malformed workflow repositories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-v2-repair-'));
  const registry = path.join(root, 'registry.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);

  assert.equal((await discardUnsupportedWorkflowWorkspaces(registry)).removed.length, 0,
    'a clone awaiting initialization remains selectable');
  const lead = created.status.leadRepositoryPath;
  await mkdir(path.join(lead, 'singularity'), { recursive: true });
  await writeFile(path.join(lead, 'singularity', 'workflow.yml'), 'version: [broken\n');
  assert.equal((await discardUnsupportedWorkflowWorkspaces(registry)).removed.length, 0,
    'a parse error remains visible for repair instead of being silently forgotten');
});

test('active workspace context resolves friendly references and adds governed Story identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-context-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);

  const lead = created.status.leadRepositoryPath;
  run('git', ['checkout', '-b', 'feature/mobile-ui'], { cwd: lead });
  await mkdir(path.join(lead, 'singularity', 'work-items', 'MOB-123'), { recursive: true });
  await writeFile(path.join(lead, 'singularity', 'work-items', 'MOB-123', 'workflow.json'), JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'MOB-123', branch: 'MOB-123-mobile', title: 'Mobile Story' },
    lineage: { canonicalBranch: 'MOB-123-mobile', childBranches: [{ name: 'feature/mobile-ui' }] },
    phaseOrder: [],
    phases: {}
  }));

  const byKey = await resolveWorkspaceReference(registry, 'pay-100');
  assert.equal(byKey.id, created.workspace.id);
  const preview = await buildWorkspaceContext(registry, created.workspace.name);
  assert.equal(preview.repositoryId, 'platform');
  assert.equal(preview.storyId, 'MOB-123');
  assert.equal(workspacePromptLabel(preview), `${created.workspace.name} / MOB-123 >`);

  const active = await activateWorkspaceContext(registry, selection, created.workspace.id, { storyId: 'MOB-999' });
  assert.equal(active.storyId, 'MOB-999');
  assert.equal((await readActiveWorkspaceContext(selection, registry)).prompt, `${created.workspace.name} / MOB-999 >`);

  run('git', ['add', '.'], { cwd: lead });
  run('git', ['commit', '-m', 'add first Story'], { cwd: lead });
  const storyCheckout = path.join(root, 'MOB-999-checkout');
  run('git', ['worktree', 'add', '-b', 'MOB-999', storyCheckout, 'HEAD'], { cwd: lead });
  await mkdir(path.join(storyCheckout, 'singularity', 'work-items', 'MOB-999'), { recursive: true });
  await writeFile(path.join(storyCheckout, 'singularity', 'work-items', 'MOB-999', 'workflow.json'), JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'MOB-999', branch: 'MOB-999', title: 'Selected isolated Story' },
    lineage: { canonicalBranch: 'MOB-999', childBranches: [] },
    currentPhase: 'intake', status: 'in_progress', phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'in_progress' } }
  }));
  run('git', ['add', '.'], { cwd: storyCheckout });
  run('git', ['commit', '-m', 'start selected Story'], { cwd: storyCheckout });

  const selectedStory = await activateWorkspaceStoryContext(selection, registry, storyCheckout, {
    storyId: 'MOB-999', selectionSource: 'test-attach'
  });
  assert.equal(selectedStory.repositoryPath, await realpath(storyCheckout));
  assert.equal(selectedStory.canonicalRepositoryPath, await realpath(lead));
  assert.equal(selectedStory.storyWorktree, true);
  const execution = await resolveWorkspaceExecutionContext(selection, registry, { cwd: lead });
  assert.equal(execution.storyId, 'MOB-999');
  assert.equal(execution.repositoryPath, await realpath(storyCheckout),
    'the selected Story checkout wins over the canonical clone in the next Copilot turn');
  assert.equal(execution.selectionStatus, 'ready');
  await assert.rejects(() => buildWorkspaceContext(registry, created.workspace.id, { repositoryId: 'missing' }), /not part of workspace/);
});

test('workspace Copilot launcher dry-run uses the selected repository and session name', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-copilot-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await remoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_TELEMETRY_PREFERENCES: path.join(root, 'telemetry-preferences.json')
  };

  let result = spawnSync(process.execPath, [cli, 'workspace', 'use', 'PAY-100', '--story', 'MOB-321', '--json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).storyId, 'MOB-321');

  result = spawnSync(process.execPath, [cli, '--no-model', 'workspace', 'copilot', '--mode', 'plan', '--dry-run'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const launch = JSON.parse(result.stdout);
  assert.equal(launch.cwd, created.status.leadRepositoryPath);
  assert.deepEqual(launch.args.slice(0, 2), ['-C', created.status.leadRepositoryPath]);
  assert.ok(launch.args.includes('--name'));
  assert.deepEqual(launch.args.slice(-2), ['--mode', 'plan']);
  assert.equal(launch.prompt, `${created.workspace.name} / MOB-321 >`);
  assert.equal(launch.telemetry.captureStatus, 'disclosure-required');

  result = spawnSync(process.execPath, [cli, '--no-model', 'copilot', '--mode', 'plan', '--dry-run'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const alias = JSON.parse(result.stdout);
  assert.equal(alias.cwd, created.status.leadRepositoryPath);
  assert.deepEqual(alias.args.slice(-2), ['--mode', 'plan']);
  assert.equal(alias.telemetry.provisioningMode, 'launch-injection');
});

test('a session can attach to a saved workspace from outside every repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-workspace-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await governedRemoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const unrelated = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-unrelated-'));
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection
  };

  const result = spawnSync(process.execPath, [cli, 'session', 'workspace', created.workspace.id,
    '--story', 'MOB-321', '--json'], { cwd: unrelated, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const attached = JSON.parse(result.stdout);
  assert.equal(attached.attached, true);
  assert.equal(attached.workspaceId, created.workspace.id);
  assert.equal(attached.repositoryPath, created.status.leadRepositoryPath);
  assert.equal(attached.storyId, 'MOB-321');
  /**
   * Attached means attached — the title of this test used to be contradicted by its own assertion.
   *
   * `hostAction` was `reopen-repository` whenever the caller was not already rooted in the clone,
   * and Copilot, which never is, read that as a refusal: it would not select a Story until someone
   * opened the repository again, though the selection had named the absolute path all along.
   */
  assert.equal(attached.hostAction, 'ready');
  // Where the shell happens to be is still reported. It is information for editing files by hand,
  // not a preconditon for governed work.
  assert.equal(attached.editorRooted, false);
  assert.match(attached.commands.openCopilot, /workspace copilot/);
  assert.match(attached.commands.attachStory, /session attach.*MOB-321/);
  assert.equal(JSON.parse(await readFile(selection, 'utf8')).storyId, 'MOB-321');

  // And the session is genuinely usable from here: `status` resolves the repository through the
  // selection rather than reporting an uninitialized world because the working directory is elsewhere.
  const status = spawnSync(process.execPath, [cli, 'session', 'status', '--json'], { cwd: unrelated, env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const session = JSON.parse(status.stdout);
  assert.equal(session.resolvedFrom, 'active-workspace');
  assert.equal(session.repositoryPath, created.status.leadRepositoryPath);
  assert.equal(session.workspaceId, created.workspace.id);
  // The caller is told which repository answered, so an answer about a workspace selected in another
  // window is never mistaken for an answer about the directory the caller is standing in.
  assert.notEqual(session.initialized, false);
});

test('a workspace-only session does not adopt the Story checked out in its repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-workspace-explicit-story-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await governedRemoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);

  const lead = created.status.leadRepositoryPath;
  run('git', ['checkout', '-b', 'MOB-321'], { cwd: lead });
  await mkdir(path.join(lead, 'singularity', 'work-items', 'MOB-321'), { recursive: true });
  await writeFile(path.join(lead, 'singularity', 'work-items', 'MOB-321', 'workflow.json'), JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'MOB-321', branch: 'MOB-321', title: 'Checked-out candidate' },
    lineage: { canonicalBranch: 'MOB-321', childBranches: [] },
    currentPhase: 'intake',
    status: 'active',
    phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: 'active' } }
  }));

  const detected = await buildWorkspaceContext(registry, created.workspace.id);
  assert.equal(detected.storyId, 'MOB-321', 'the fixture proves the branch is a detectable Story candidate');

  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection
  };
  const attached = spawnSync(process.execPath, [cli, 'session', 'workspace', created.workspace.id, '--json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(JSON.parse(attached.stdout).storyId, null,
    'choosing only a workspace does not count as choosing its checked-out Story');

  const status = spawnSync(process.execPath, [cli, 'session', 'status', '--json'], {
    cwd: root, env, encoding: 'utf8'
  });
  assert.equal(status.status, 0, status.stderr);
  const session = JSON.parse(status.stdout);
  assert.equal(session.workItemSelectionRequired, true);
  assert.equal(session.workId, null);
});

test('the working directory still wins over a workspace selected somewhere else', async () => {
  /**
   * The fallback must never override an explicit position. Someone standing inside repository A,
   * with workspace B selected in another window, has to be answered about A — silently answering
   * about B would let a governed write land in a repository nobody was looking at.
   */
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-cwd-wins-'));
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'active.json');
  const platform = await governedRemoteRepository(root, 'platform');
  const created = await createWorkspace(workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' }
  }), { confirmation: 'PAY-100' });
  await rememberWorkspace(registry, created.workspace, created.status);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection
  };
  const select = spawnSync(process.execPath, [cli, 'session', 'workspace', created.workspace.id, '--json'],
    { cwd: root, env, encoding: 'utf8' });
  assert.equal(select.status, 0, select.stderr);

  // Now ask from inside the governed clone itself. Same selection, and it must not be consulted.
  const status = spawnSync(process.execPath, [cli, 'session', 'status', '--json'],
    { cwd: created.status.leadRepositoryPath, env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const session = JSON.parse(status.stdout);
  assert.equal(session.resolvedFrom, 'working-directory');
  assert.equal(session.workspaceId, null);
});

test('workspace editing updates Jira routing and metadata while archive remains recoverable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-edit-'));
  const registry = path.join(root, 'registry.json');
  const remote = await remoteRepository(root, 'platform');
  const created = await saveWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: remote,
        defaultBranch: 'main',
        required: true,
        path: 'repos/platform',
        jira: { board: 'PAY' },
        metadata: { appId: 'APP-1', name: 'Payments platform' }
      }
    }
  }, { confirmation: 'payments-platform', clone: true });
  await rememberWorkspace(registry, created.workspace, created.status);
  const updated = await updateWorkspaceConfiguration(created.workspace.path, {
    name: 'Payments delivery',
    leadRepository: 'platform',
    repositories: {
      platform: {
        ...created.workspace.repositories.platform,
        jira: { board: 'KAN' },
        metadata: { appId: 'APP-2', name: 'Payments API', owner: 'Digital' }
      }
    }
  }, { confirmation: 'payments-platform' });
  assert.equal(updated.workspace.name, 'Payments delivery');
  assert.equal(updated.workspace.repositories.platform.jira.board, 'KAN');
  assert.equal(updated.workspace.repositories.platform.metadata.owner, 'Digital');
  await assert.rejects(() => updateWorkspaceConfiguration(created.workspace.path, {
    name: 'Invalid',
    leadRepository: 'platform',
    repositories: {
      platform: { ...created.workspace.repositories.platform, url: 'https://example.com/replacement.git' }
    }
  }, { confirmation: 'payments-platform' }), /cannot change url/);

  const storyDirectory = path.join(created.status.leadRepositoryPath, 'singularity', 'work-items', 'PAY-123');
  await mkdir(storyDirectory, { recursive: true });
  const story = {
    workItem: { id: 'PAY-123', title: 'Finish the payment route', branch: 'PAY-123' },
    status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['implementation'], phases: { implementation: { status: 'in_progress' } }
  };
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify(story, null, 2)}\n`);
  const blocked = await workspaceArchiveReadiness(created.workspace.path, { fetch: false });
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.activeStories[0].id, 'PAY-123');
  await assert.rejects(
    () => archiveWorkspace(registry, created.workspace.path, {
      confirmation: 'payments-platform', fetch: false
    }),
    /PAY-123.*in_progress/
  );

  story.status = 'cancelled';
  story.currentPhase = null;
  story.phases.implementation.status = 'cancelled';
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify(story, null, 2)}\n`);
  await archiveWorkspace(registry, created.workspace.path, {
    confirmation: 'payments-platform', fetch: false
  });
  assert.ok((await readWorkspaceRegistry(registry))[0].archivedAt);
  assert.equal(await stat(path.join(created.workspace.path, 'workspace.json')).then(() => true), true);
  await restoreWorkspace(registry, created.workspace.path);
  assert.equal((await readWorkspaceRegistry(registry))[0].archivedAt, null);
});

test('stale workspace-manifest lease recovery cannot retire its live successor', {
  timeout: 15_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-reclaim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const lock = `${manifest}.lock`;
  const guard = path.join(root, 'inside-operation');
  const events = path.join(root, 'events.log');
  const firstObserved = path.join(root, 'first-observed-stale');
  const releaseFirst = path.join(root, 'release-first-reaper');
  const firstAttempted = path.join(root, 'first-reclaim-attempted');
  const secondEntered = path.join(root, 'second-entered');
  const releaseSecond = path.join(root, 'release-second-owner');
  await writeFile(manifest, '{}\n');
  await writeFile(lock, `${JSON.stringify({
    pid: 2_147_483_647,
    token: '00000000-0000-4000-8000-000000000001',
    createdAt: '2000-01-01T00:00:00.000Z'
  })}\n`, { mode: 0o600 });
  const staleTime = new Date(Date.now() - (16 * 60_000));
  await utimes(lock, staleTime, staleTime);

  const workspaceModule = pathToFileURL(path.join(packageRoot, 'src', 'workspace.mjs')).href;
  const childSource = `
    import { appendFile, open, readFile, rm, writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { withRegistryFileLease } from ${JSON.stringify(workspaceModule)};
    const required = (name) => {
      const value = process.env[name];
      if (!value) throw new Error('missing ' + name);
      return value;
    };
    const manifest = required('SFLOW_LEASE_TEST_MANIFEST');
    const role = required('SFLOW_LEASE_TEST_ROLE');
    const ready = required('SFLOW_LEASE_TEST_READY');
    const guard = required('SFLOW_LEASE_TEST_GUARD');
    const events = required('SFLOW_LEASE_TEST_EVENTS');
    const firstObserved = required('SFLOW_LEASE_TEST_FIRST_OBSERVED');
    const releaseFirst = required('SFLOW_LEASE_TEST_RELEASE_FIRST');
    const firstAttempted = required('SFLOW_LEASE_TEST_FIRST_ATTEMPTED');
    const secondEntered = required('SFLOW_LEASE_TEST_SECOND_ENTERED');
    const releaseSecond = required('SFLOW_LEASE_TEST_RELEASE_SECOND');
    const waitFor = async (file) => {
      while (true) {
        try { await readFile(file); return; }
        catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await delay(5);
      }
    };
    await writeFile(ready, String(process.pid));
    let paused = false;
    let attempted = false;
    await withRegistryFileLease(manifest, async () => {
      let handle;
      try {
        handle = await open(guard, 'wx', 0o600);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error('registry lease operations overlapped');
        throw error;
      }
      try {
        await appendFile(events, 'enter:' + role + ':' + process.pid + '\\n');
        if (role === 'second') {
          await writeFile(secondEntered, String(process.pid));
          await waitFor(releaseSecond);
        } else {
          await delay(25);
        }
        await appendFile(events, 'exit:' + role + ':' + process.pid + '\\n');
      } finally {
        await handle.close();
        await rm(guard, { force: true });
      }
    }, {
      hooks: {
        afterStaleObserved: async () => {
          if (role !== 'first' || paused) return;
          paused = true;
          await writeFile(firstObserved, String(process.pid));
          await waitFor(releaseFirst);
        },
        afterReclaimAttempt: async () => {
          if (role !== 'first' || attempted) return;
          attempted = true;
          await writeFile(firstAttempted, String(process.pid));
        }
      }
    });
  `;
  const children = [];
  const startChild = (role) => {
    const ready = path.join(root, `ready-${role}`);
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: packageRoot,
      env: {
        ...process.env,
        SFLOW_LEASE_TEST_MANIFEST: manifest,
        SFLOW_LEASE_TEST_ROLE: role,
        SFLOW_LEASE_TEST_READY: ready,
        SFLOW_LEASE_TEST_GUARD: guard,
        SFLOW_LEASE_TEST_EVENTS: events,
        SFLOW_LEASE_TEST_FIRST_OBSERVED: firstObserved,
        SFLOW_LEASE_TEST_RELEASE_FIRST: releaseFirst,
        SFLOW_LEASE_TEST_FIRST_ATTEMPTED: firstAttempted,
        SFLOW_LEASE_TEST_SECOND_ENTERED: secondEntered,
        SFLOW_LEASE_TEST_RELEASE_SECOND: releaseSecond
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
    });
    const result = { ready, child, completed };
    children.push(result);
    return result;
  };
  t.after(() => children.forEach(({ child }) => { if (child.exitCode === null) child.kill('SIGKILL'); }));

  const waitForPath = async (file, message) => {
    const deadline = Date.now() + 10_000;
    while (!await stat(file).then(() => true).catch(() => false)) {
      assert.ok(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const first = startChild('first');
  await waitForPath(first.ready, 'first child did not start');
  await waitForPath(firstObserved, 'first child did not pause after observing the stale inode');
  const second = startChild('second');
  await waitForPath(second.ready, 'second child did not start');
  await waitForPath(secondEntered, 'second child did not acquire the successor lease');
  await writeFile(releaseFirst, 'resume\n');
  await waitForPath(firstAttempted,
    'the paused first reaper did not attempt its old reclaim while the successor was held');
  assert.deepEqual((await readFile(events, 'utf8')).trim().split(/\r?\n/).map((line) =>
    line.split(':').slice(0, 2).join(':')), ['enter:second'],
  'the first reaper cannot enter while the second process holds the successor lease');
  await writeFile(releaseSecond, 'exit\n');
  const results = await Promise.all(children.map(({ completed }) => completed));
  results.forEach((result) => assert.equal(result.status, 0,
    `child lease process failed (${result.signal ?? 'no signal'}): ${result.stderr || result.stdout}`));

  const observedEvents = (await readFile(events, 'utf8')).trim().split(/\r?\n/);
  assert.deepEqual(observedEvents.map((line) => line.replace(/:\d+$/, '')), [
    'enter:second', 'exit:second', 'enter:first', 'exit:first'
  ]);
  assert.equal(await stat(lock).then(() => true).catch(() => false), false,
    'the final live lease is released');
  const tombstones = (await readdir(root)).filter((entry) =>
    entry.startsWith(`${path.basename(lock)}.reclaimed-`));
  assert.equal(tombstones.length, 1,
    'all contenders for one stale inode share one completed reaping generation');
  assert.equal((await stat(path.join(root, tombstones[0], 'retired.lock'))).isFile(), true);
});

test('workspace-manifest lease expiry is not preserved by a recycled PID', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-pid-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const lock = `${manifest}.lock`;
  await writeFile(manifest, '{}\n');
  await writeFile(lock, `${JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    processStartedAt: 0,
    processToken: 'old-process-instance',
    token: '00000000-0000-4000-8000-000000000002',
    createdAt: '2000-01-01T00:00:00.000Z'
  })}\n`, { mode: 0o600 });
  const staleTime = new Date(Date.now() - (16 * 60_000));
  await utimes(lock, staleTime, staleTime);

  let entered = false;
  await withRegistryFileLease(manifest, async () => { entered = true; });
  assert.equal(entered, true);
  assert.equal(await stat(lock).then(() => true).catch(() => false), false);
});

test('workspace-manifest lease fences and advances past an interrupted reclaim claim', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-interrupted-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const lock = `${manifest}.lock`;
  const ownerBytes = `${JSON.stringify({
    pid: 2_147_483_647,
    token: '00000000-0000-4000-8000-000000000003',
    createdAt: '2000-01-01T00:00:00.000Z'
  })}\n`;
  await writeFile(manifest, '{}\n');
  await writeFile(lock, ownerBytes, { mode: 0o600 });
  const staleTime = new Date(Date.now() - (16 * 60_000));
  await utimes(lock, staleTime, staleTime);
  const info = await stat(lock, { bigint: true });
  const identity = createHash('sha256').update(JSON.stringify({
    ownerBytes,
    device: String(info.dev),
    inode: String(info.ino),
    birthtimeMs: Number(info.birthtimeMs),
    mtimeMs: Number(info.mtimeMs)
  })).digest('hex').slice(0, 32);
  const interruptedClaim = `${lock}.reclaimed-${identity}-0000`;
  await mkdir(interruptedClaim);
  await writeFile(path.join(interruptedClaim, 'claim.json'), `${JSON.stringify({
    pid: 2_147_483_647,
    host: os.hostname(),
    processStartedAt: 0,
    processToken: 'crashed-reaper',
    claimToken: 'crashed-claim',
    reclaimIdentity: identity,
    createdAt: '2000-01-01T00:00:00.000Z'
  })}\n`);
  const abandonedTime = new Date(Date.now() - 31_000);
  await utimes(interruptedClaim, abandonedTime, abandonedTime);

  let entered = false;
  await withRegistryFileLease(manifest, async () => { entered = true; });
  assert.equal(entered, true);
  assert.equal((await stat(path.join(interruptedClaim, 'retired.lock'))).isDirectory(), true,
    'an atomic directory fence prevents the interrupted reaper from moving a successor');
  assert.equal(await readFile(path.join(interruptedClaim, 'retired.lock', 'fenced.claim'), 'utf8'),
    `${identity}\n`);
  const nextClaim = `${lock}.reclaimed-${identity}-0001`;
  assert.equal((await stat(path.join(nextClaim, 'retired.lock'))).isFile(), true,
    'the next immutable claim generation retires the original stale inode');
  assert.equal(await stat(lock).then(() => true).catch(() => false), false);
});

test('workspace-manifest lease removes its exact candidate after owner write failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-owner-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const lock = `${manifest}.lock`;
  await writeFile(manifest, '{}\n');
  await assert.rejects(
    () => withRegistryFileLease(manifest, async () => {}, {
      hooks: { afterLockOpened: () => { throw new Error('injected owner write failure'); } }
    }),
    /injected owner write failure/
  );
  assert.equal(await stat(lock).then(() => true).catch(() => false), false,
    'the failed candidate is removed after its exact inode is rechecked');
  let entered = false;
  await withRegistryFileLease(manifest, async () => { entered = true; });
  assert.equal(entered, true, 'the failure leaves no held descriptor or stale lease');
});

test('workspace-manifest lease heartbeat protects the unpublished acquisition inode', {
  timeout: 10_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-acquiring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const opened = path.join(root, 'opened');
  const entered = path.join(root, 'entered');
  const lock = `${manifest}.lock`;
  await writeFile(manifest, '{}\n');
  const workspaceModule = pathToFileURL(path.join(packageRoot, 'src', 'workspace.mjs')).href;
  const childSource = `
    import { writeFile } from 'node:fs/promises';
    import { withRegistryFileLease } from ${JSON.stringify(workspaceModule)};
    await withRegistryFileLease(process.env.SFLOW_LEASE_TEST_MANIFEST, async () => {
      await writeFile(process.env.SFLOW_LEASE_TEST_ENTERED, String(process.pid));
    }, {
      staleMs: 1_000,
      acquisitionGraceMs: 200,
      timeoutMs: 3_000,
      hooks: {
        afterLockOpened: async () => {
          await writeFile(process.env.SFLOW_LEASE_TEST_OPENED, String(process.pid));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
        }
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    cwd: packageRoot,
    env: {
      ...process.env,
      SFLOW_LEASE_TEST_MANIFEST: manifest,
      SFLOW_LEASE_TEST_OPENED: opened,
      SFLOW_LEASE_TEST_ENTERED: entered
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5_000;
  while (!await stat(opened).then(() => true).catch(() => false)) {
    assert.ok(Date.now() < deadline, 'child did not pause before publishing its owner record');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(lock, 'utf8'), '',
    'the acquisition hook runs while the newly created lease inode is still unpublished');
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(
    () => withRegistryFileLease(manifest, async () => {
      throw new Error('an unpublished but live acquisition inode must not be reclaimed');
    }, { staleMs: 1_000, acquisitionGraceMs: 200, timeoutMs: 300 }),
    (error) => error?.code === 'WORKSPACE_REGISTRY_BUSY'
  );
  assert.equal(await stat(entered).then(() => true).catch(() => false), false,
    'the original owner remains paused until after the competing acquisition times out');
  const result = await completed;
  assert.equal(result.status, 0,
    `acquisition heartbeat child failed (${result.signal ?? 'no signal'}): ${stderr}`);
  assert.equal(await stat(entered).then(() => true).catch(() => false), true,
    'the original owner publishes its record and enters after the acquisition stall');
  assert.equal(await stat(lock).then(() => true).catch(() => false), false,
    'the original owner releases the exact acquisition inode');
});

test('workspace-manifest lease heartbeat survives a blocked owner event loop', {
  timeout: 10_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-lease-heartbeat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const entered = path.join(root, 'entered');
  await writeFile(manifest, '{}\n');
  const workspaceModule = pathToFileURL(path.join(packageRoot, 'src', 'workspace.mjs')).href;
  const childSource = `
    import { writeFile } from 'node:fs/promises';
    import { withRegistryFileLease } from ${JSON.stringify(workspaceModule)};
    await withRegistryFileLease(process.env.SFLOW_LEASE_TEST_MANIFEST, async () => {
      await writeFile(process.env.SFLOW_LEASE_TEST_ENTERED, String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_800);
    }, { staleMs: 600, timeoutMs: 3_000 });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    cwd: packageRoot,
    env: {
      ...process.env,
      SFLOW_LEASE_TEST_MANIFEST: manifest,
      SFLOW_LEASE_TEST_ENTERED: entered
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const deadline = Date.now() + 5_000;
  while (!await stat(entered).then(() => true).catch(() => false)) {
    assert.ok(Date.now() < deadline, 'blocked owner did not enter its leased operation');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  await assert.rejects(
    () => withRegistryFileLease(manifest, async () => {
      throw new Error('a live heartbeat must prevent successor entry');
    }, { staleMs: 600, timeoutMs: 300 }),
    (error) => error?.code === 'WORKSPACE_REGISTRY_BUSY'
  );
  const result = await completed;
  assert.equal(result.status, 0,
    `blocked heartbeat child failed (${result.signal ?? 'no signal'}): ${stderr}`);
  let acquiredAfterRelease = false;
  await withRegistryFileLease(manifest, async () => { acquiredAfterRelease = true; });
  assert.equal(acquiredAfterRelease, true);
});

test('concurrent workspace registry updates preserve every workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-registry-concurrent-'));
  const registry = path.join(root, 'registry.json');
  const firstInput = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'first.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const secondInput = structuredClone(firstInput);
  secondInput.anchor.key = 'PAY-200';
  secondInput.anchor.title = 'Merchant modernization';
  const [first, second] = await Promise.all([
    createWorkspace(firstInput, { confirmation: 'PAY-100', clone: false }),
    createWorkspace(secondInput, { confirmation: 'PAY-200', clone: false })
  ]);

  await Promise.all([
    rememberWorkspace(registry, first.workspace, first.status),
    rememberWorkspace(registry, second.workspace, second.status)
  ]);

  const entries = await readWorkspaceRegistry(registry);
  assert.deepEqual(new Set(entries.map((entry) => entry.anchorKey)), new Set(['PAY-100', 'PAY-200']));
});

test('reopening an incomplete workspace resumes missing clones and refreshes its materialization journal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-resume-'));
  const platform = await remoteRepository(root, 'platform');
  const mobile = await remoteRepository(root, 'mobile');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: platform, defaultBranch: 'main', required: true, path: 'repos/platform' },
    mobile: { url: mobile, defaultBranch: 'main', required: true, path: 'repos/mobile' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  assert.equal(created.status.healthy, false);
  const planned = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.deepEqual(planned.operations.map((operation) => operation.status), ['planned', 'planned']);

  const resumed = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(resumed.created, false);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
  assert.deepEqual(resumed.repair.map((operation) => operation.status), ['cloned', 'cloned']);

  const journal = JSON.parse(await readFile(path.join(created.workspace.path, 'logs', 'workspace-materialization.json'), 'utf8'));
  assert.ok(journal.completedAt);
  assert.deepEqual(journal.operations.map((operation) => operation.status), ['complete', 'complete']);
  assert.ok(journal.operations.every((operation) => operation.completedAt));
});

test('reopening an incomplete workspace retains explicit clone-wave execution options', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-resume-options-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    }
  });
  await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  let calls = 0;
  const cloneOperation = async () => {
    calls += 1;
    throw new Error('forwarded clone operation');
  };

  await assert.rejects(() => createWorkspace(input, {
    confirmation: 'PAY-100', workers: 1, cloneOperation
  }), /forwarded clone operation/);
  assert.equal(calls, 1, 'resume delegates through the caller-selected bounded clone operation');
});

test('workspace repair stages independent repositories concurrently before any claim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-repair-wave-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    },
    mobile: {
      url: path.join(root, 'mobile.git'), defaultBranch: 'main', required: true,
      path: 'repos/mobile'
    }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  let active = 0;
  let maximumActive = 0;
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const cloneOperation = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) release();
    await bothStarted;
    active -= 1;
    return { status: 1, error: 'fixture unavailable' };
  };
  await assert.rejects(() => repairWorkspace(created.workspace.path, {
    workers: 2, cloneOperation
  }), /could not be repaired/);
  assert.equal(maximumActive, 2,
    'repair probes every independent repository in one bounded staging wave');
  assert.deepEqual(await readdir(path.join(created.workspace.path, 'repos')), [],
    'a failed wave claims no repository directory');
});

test('workspace repair discards a staged clone when the manifest changes before final claim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-repair-manifest-race-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const target = path.join(created.workspace.path, 'repos', 'platform');
  const staging = path.join(created.workspace.path, 'repos', '.private-platform-staging');
  let claimCalls = 0;
  let discardCalls = 0;
  const cloneOperation = async () => {
    await mkdir(staging);
    await writeFile(path.join(staging, 'README.md'), '# privately staged clone\n');
    const current = await readWorkspace(created.workspace.path);
    await writeFile(path.join(created.workspace.path, 'workspace.json'), `${JSON.stringify({
      ...current,
      name: 'Concurrent manifest edit',
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
    return {
      status: 0,
      clone: { mode: 'full' },
      fallbackUsed: false,
      staging: { path: staging },
      claim: async () => {
        claimCalls += 1;
        await rename(staging, target);
        return { status: 0, clone: { mode: 'full' }, fallbackUsed: false };
      },
      discard: async () => {
        discardCalls += 1;
        await rm(staging, { recursive: true, force: true });
        return { removed: true, path: staging };
      }
    };
  };

  await assert.rejects(
    () => repairWorkspace(created.workspace.path, { cloneOperation }),
    /Workspace configuration changed while repository 'platform' was cloning/
  );
  assert.equal(claimCalls, 0, 'a staged clone is never claimed under a different manifest');
  assert.equal(discardCalls, 1, 'the still-private staging directory is discarded exactly once');
  assert.equal(await stat(staging).catch(() => null), null);
  assert.equal(await stat(target).catch(() => null), null);
  assert.equal((await readWorkspace(created.workspace.path)).name, 'Concurrent manifest edit');
});

test('workspace repair stops when a required staged clone loses its final claim race', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-repair-claim-race-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    },
    mobile: {
      url: path.join(root, 'mobile.git'), defaultBranch: 'main', required: false,
      path: 'repos/mobile'
    }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  let staged = 0;
  let optionalClaimed = false;
  let optionalDiscarded = false;
  const cloneOperation = async () => {
    const index = staged++;
    return {
      status: 0,
      error: null,
      claim: async () => index === 0
        ? { status: 1, error: 'target appeared before the atomic claim' }
        : (optionalClaimed = true, { status: 0, error: null }),
      discard: async () => {
        if (index === 1) optionalDiscarded = true;
        return { removed: true };
      }
    };
  };

  await assert.rejects(() => repairWorkspace(created.workspace.path, {
    workers: 2, cloneOperation
  }), /Required repository 'platform' could not be repaired: target appeared/);
  assert.equal(optionalClaimed, false, 'later staged repositories are not claimed after a required failure');
  assert.equal(optionalDiscarded, true, 'later owned staging is discarded after a required failure');
});

test('workspace repair discards every unclaimed staging directory when a claim callback throws', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-repair-claim-throw-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    },
    mobile: {
      url: path.join(root, 'mobile.git'), defaultBranch: 'main', required: false,
      path: 'repos/mobile'
    }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const discarded = [];
  let staged = 0;
  const cloneOperation = async () => {
    const index = staged++;
    return {
      status: 0,
      claim: async () => {
        if (index === 0) throw new Error('claim callback exploded');
        return { status: 0, error: null };
      },
      discard: async () => {
        discarded.push(index);
        return { removed: true };
      }
    };
  };

  await assert.rejects(() => repairWorkspace(created.workspace.path, {
    workers: 2, cloneOperation
  }), /claim callback exploded/);
  assert.deepEqual(discarded.sort(), [0, 1],
    'the throwing entry and every later private staging result are released');
});

test('workspace creation discards every unclaimed staging directory when finalization throws', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-create-claim-throw-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true,
      path: 'repos/platform'
    },
    mobile: {
      url: path.join(root, 'mobile.git'), defaultBranch: 'main', required: false,
      path: 'repos/mobile'
    }
  });
  const discarded = [];
  let staged = 0;
  const cloneOperation = async () => {
    const index = staged++;
    return {
      status: 0,
      claim: async () => {
        if (index === 0) throw new Error('create claim callback exploded');
        return { status: 0, error: null };
      },
      discard: async () => {
        discarded.push(index);
        return { removed: true };
      }
    };
  };

  await assert.rejects(() => createWorkspace(input, {
    confirmation: 'PAY-100', workers: 2, cloneOperation
  }), /create claim callback exploded/);
  assert.deepEqual(discarded.sort(), [0, 1],
    'creation releases the entire still-private staging wave');
});

test('workspace recovery rejects a different repository materialization plan at the same target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-drift-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: {
      url: path.join(root, 'platform.git'),
      defaultBranch: 'main',
      required: true,
      path: 'repos/platform',
      metadata: { appId: 'APP-1' }
    }
  });
  await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const changed = structuredClone(input);
  changed.repositories.platform.url = path.join(root, 'replacement.git');
  await assert.rejects(
    () => createWorkspace(changed, { confirmation: 'PAY-100', clone: false }),
    /different repository materialization plan/
  );
});

test('a failed clone leaves no partial repository and can resume when the remote becomes available', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-clone-retry-'));
  const futureRemote = path.join(root, 'later.git');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: futureRemote, defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const preview = previewWorkspace(input);
  await assert.rejects(
    () => createWorkspace(input, { confirmation: 'PAY-100' }),
    /retained for repair/
  );
  assert.deepEqual(await readdir(path.join(preview.root, 'repos')), []);

  assert.equal(await remoteRepository(root, 'later'), futureRemote);
  const resumed = await createWorkspace(input, { confirmation: 'PAY-100' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
});

test('parallel workspace staging claims no repository when any required clone fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-clone-wave-'));
  const available = await remoteRepository(root, 'available');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: available, defaultBranch: 'main', required: true, path: 'repos/platform' },
    missing: { url: path.join(root, 'missing.git'), defaultBranch: 'main', required: true, path: 'repos/missing' }
  });
  const preview = previewWorkspace(input);
  await assert.rejects(
    () => createWorkspace(input, { confirmation: 'PAY-100', workers: 2 }),
    /retained for repair/
  );
  assert.deepEqual(await readdir(path.join(preview.root, 'repos')), [],
    'a successful sibling remains private staging and is discarded before coordinator claim');
});

test('workspace repair names a configured branch that the remote does not have', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-missing-branch-'));
  const empty = path.join(root, 'empty.git');
  run('git', ['init', '--bare', '--initial-branch', 'main', empty], { cwd: root });
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: empty, defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  await createWorkspace(input, { confirmation: 'PAY-100', clone: false });

  await assert.rejects(() => createWorkspace(input, { confirmation: 'PAY-100' }), (error) => {
    assert.match(error.message, /remote does not have that branch/);
    assert.match(error.message, /Configure a valid default branch or create 'main'/);
    assert.doesNotMatch(error.message, /Cloning into/);
    assert.doesNotMatch(error.message, /\.sflow-clone-/);
    return true;
  });
});

test('workspace configuration stays saved when repository materialization fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-save-before-clone-'));
  const baseDirectory = path.join(root, 'workspaces');
  const unavailableRemote = path.join(root, 'unavailable.git');
  const options = {
    baseDirectory,
    id: 'payments-platform',
    name: 'Payments platform',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: unavailableRemote,
        defaultBranch: 'main',
        required: true,
        path: 'repos/platform',
        jira: { board: 'PAY' },
        metadata: { appId: 'APP-1', name: 'Payments platform' }
      }
    }
  };

  const saved = await saveWorkspaceConfiguration(options, { confirmation: 'payments-platform' });
  assert.equal(saved.created, true);
  assert.equal(saved.status.healthy, false);
  assert.equal(saved.status.repositories[0].state, 'missing');
  assert.match(saved.materializationError, /could not be repaired/);
  assert.equal((await readWorkspace(saved.workspace.path)).name, 'Payments platform');

  await remoteRepository(root, 'unavailable');
  const resumed = await saveWorkspaceConfiguration(options, { confirmation: 'payments-platform' });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.status.healthy, true);
  assert.equal(resumed.materializationError, null);
});

test('workspace paths are canonicalized and linked manifests are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-canonical-'));
  const registry = path.join(root, 'registry.json');
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'platform.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const alias = path.join(root, 'workspace-alias');
  await symlink(created.workspace.path, alias, 'dir');

  const loaded = await readWorkspace(alias);
  assert.equal(loaded.path, created.workspace.path);
  await rememberWorkspace(registry, { ...loaded, path: alias });
  assert.equal((await readWorkspaceRegistry(registry))[0].path, created.workspace.path);
  await forgetWorkspace(registry, alias);
  assert.deepEqual(await readWorkspaceRegistry(registry), []);

  const manifestFile = path.join(created.workspace.path, 'workspace.json');
  const outsideManifest = path.join(root, 'outside-workspace.json');
  await writeFile(outsideManifest, await readFile(manifestFile));
  await rm(manifestFile);
  await symlink(outsideManifest, manifestFile);
  await assert.rejects(() => readWorkspace(created.workspace.path), /symbolic link/);
});

test('workspace repository and document roots cannot escape through symlinked directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-boundary-'));
  const input = workspaceInput(path.join(root, 'workspaces'), {
    platform: { url: path.join(root, 'outside.git'), defaultBranch: 'main', required: true, path: 'repos/platform' }
  });
  const created = await createWorkspace(input, { confirmation: 'PAY-100', clone: false });
  const outsideRepositories = path.join(root, 'outside-repositories');
  const outsideDocuments = path.join(root, 'outside-documents');
  await mkdir(path.join(outsideRepositories, 'platform', '.git'), { recursive: true });
  await mkdir(outsideDocuments, { recursive: true });
  await writeFile(path.join(outsideDocuments, 'secret.md'), '# outside\n');

  await rm(path.join(created.workspace.path, 'repos'), { recursive: true });
  await symlink(outsideRepositories, path.join(created.workspace.path, 'repos'), 'dir');
  const status = await workspaceStatus(created.workspace.path);
  assert.equal(status.healthy, false);
  assert.equal(status.repositories[0].state, 'invalid-path');
  assert.match(status.repositories[0].error, /outside its configured root/);
  const fetched = await fetchWorkspace(created.workspace.path);
  assert.deepEqual(fetched.results, [{ repository: 'platform', status: 'skipped', reason: 'invalid-path' }]);

  const inbox = path.join(created.workspace.path, 'documents', 'inbox');
  await rm(inbox, { recursive: true });
  await symlink(outsideDocuments, inbox, 'dir');
  await assert.rejects(() => listWorkspaceDocuments(created.workspace.path), /outside its configured root/);
  const source = path.join(root, 'new-requirement.md');
  await writeFile(source, '# new\n');
  await assert.rejects(() => stageWorkspaceDocuments(created.workspace.path, [source]), /outside its configured root/);
  assert.equal(await readFile(path.join(outsideDocuments, 'secret.md'), 'utf8'), '# outside\n');
});

test('workspace CLI can provision an approved offline clone plan outside a Git repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-cli-'));
  const registry = path.join(root, 'registry.json');
  const result = spawnSync(process.execPath, [
    cli, 'workspace', 'create',
    '--jira', 'APP-42',
    '--jira-url', 'https://office.atlassian.net',
    '--hierarchy-level', '1',
    '--issue-type', 'Epic',
    '--title', 'Offline workspace',
    '--base', path.join(root, 'workspaces'),
    '--lead', 'lead',
    '--repository', `lead=${path.join(root, 'lead.git')}`,
    '--confirm', 'APP-42',
    '--no-clone',
    '--json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout);
  assert.equal(created.workspace.anchor.key, 'APP-42');
  assert.equal(created.status.repositories[0].state, 'missing');
  const listed = spawnSync(process.execPath, [cli, 'workspace', 'list', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(JSON.parse(listed.stdout)[0].anchorKey, 'APP-42');
  const status = spawnSync(process.execPath, [cli, 'workspace', 'status', created.workspace.path], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`Lead repository: ${created.status.leadRepositoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(status.stdout, /Lead repository: undefined/);
  const aggregate = spawnSync(process.execPath, [
    cli, 'workspace', 'status', created.workspace.path,
    '--archive-readiness', '--no-fetch', '--json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }
  });
  assert.equal(aggregate.status, 0, aggregate.stderr);
  const aggregateStatus = JSON.parse(aggregate.stdout);
  assert.equal(aggregateStatus.archiveReadiness.eligible, false);
  assert.match(aggregateStatus.archiveReadiness.blockers[0], /missing/);
});
