import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import {
  resolveLifecycleCapability, setCapabilityMapReadObserverForTests
} from '../src/capability-context.mjs';
import {
  assertApprovedCapabilityRepositoryPlan, storyBaseCatalog
} from '../src/capability-start.mjs';
import {
  CONFIGURATION_BRANCH, configurationAssetPaths, ensureConfigurationBranch,
  loadStoryConfigurationSnapshot, materializeConfigurationSnapshot,
  resolveStoryConfigurationAuthority, retainStateConfigurationHistory,
  STATE_CONFIGURATION_MANIFEST
} from '../src/configuration-branch.mjs';
import { configurationReadSnapshot } from '../src/configuration-read-scope.mjs';
import { helpMetricsStatus, recordHelpMetric } from '../src/help-metrics.mjs';
import { captureCommandOutcome, readJournalEvents } from '../src/local-work-journal.mjs';
import { promptAuditStatus, recordPromptAudit, setPromptAudit } from '../src/prompt-audit.mjs';
import { writeReturnLocator } from '../src/return-locator.mjs';
import { withTrustedSgosConfigurationRead } from '../src/sgos/authority-trust.mjs';
import { loadApprovedPlatformMutationAuthority } from '../src/sgos/platform/authority.mjs';
import { storyWorktreePath } from '../src/story-worktree.mjs';
import { workspaceMemberContextForRepository } from '../src/workspace-context.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function command(commandName, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  if (!allowFailure) assert.equal(result.status, 0, `${commandName} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) {
  return command('git', args, root).stdout.trim();
}

async function initializeRepository(root, { singularity = false } = {}) {
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Capability Authority Tester');
  git(root, 'config', 'user.email', 'capability-authority@example.test');
  await writeFile(path.join(root, 'README.md'), `# ${path.basename(root)}\n`);
  if (singularity) command(process.execPath, [cli, 'init'], root, { env: {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-no-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-no-workspaces.json')
  } });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initialize repository');
}

async function publishRepository(root, remote) {
  git(path.dirname(remote), 'init', '--bare', '-q', '-b', 'main', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
}

async function publishStateConfigurationMirror(base, remote) {
  const approved = path.join(base, 'state-mirror-source');
  const publisher = path.join(base, 'state-mirror-publisher');
  command('git', ['clone', '-q', '-b', CONFIGURATION_BRANCH, remote, approved], base);
  await mkdir(publisher, { recursive: true });
  git(publisher, 'init', '-q', '-b', 'state');
  git(publisher, 'config', 'user.name', 'Capability Authority Mirror');
  git(publisher, 'config', 'user.email', 'capability-mirror@example.test');
  await cp(path.join(approved, 'singularity'), path.join(publisher, 'singularity'), {
    recursive: true
  });
  await cp(path.join(approved, '.github'), path.join(publisher, '.github'), { recursive: true });
  const sourceCommit = git(approved, 'rev-parse', 'HEAD');
  const history = await retainStateConfigurationHistory(approved, 'origin', sourceCommit);
  const sourceEntries = new Map(git(
    approved,
    'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', 'HEAD', '--',
    'singularity', '.github/agents'
  ).split('\0').filter(Boolean).map((line) => {
    const first = line.indexOf(' ');
    const second = line.indexOf(' ', first + 1);
    return [line.slice(second + 1), {
      mode: line.slice(0, first), object: line.slice(first + 1, second)
    }];
  }));
  const files = {};
  const assets = {};
  for (const relative of await configurationAssetPaths(publisher)) {
    files[relative] = createHash('sha256')
      .update(await readFile(path.join(publisher, relative))).digest('hex');
    assets[relative] = { sha256: files[relative], ...sourceEntries.get(relative) };
  }
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, STATE_CONFIGURATION_MANIFEST), `${JSON.stringify({
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: CONFIGURATION_BRANCH, commit: sourceCommit },
    history,
    product: { version: 'test', revision: 'test' },
    files,
    assets
  }, null, 2)}\n`);
  git(publisher, 'add', '-A');
  git(publisher, 'commit', '-qm', 'Mirror approved capability authority');
  git(publisher, 'remote', 'add', 'origin', remote);
  git(publisher, 'push', '-q', 'origin', 'state');
  return { sourceCommit, stateCommit: git(publisher, 'rev-parse', 'HEAD'), history };
}

async function withMachineFiles(selection, registry, operation) {
  const keys = {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry
  };
  const previous = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
  Object.assign(process.env, keys);
  try { return await operation(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function capabilityMap(name = 'Member Capability') {
  return YAML.stringify({
    version: 1,
    capabilities: {
      product: { kind: 'collection', parent: null, policy: {} },
      'member-capability': {
        name,
        kind: 'delivery',
        parent: 'product',
        repository: 'member',
        policy: { gitPublication: 'off' }
      }
    }
  });
}

function workspaceRecord({ remote, capabilityAuthority = remote }) {
  return {
    version: 1,
    id: 'local--identity-boundary',
    name: 'Identity Boundary',
    anchor: {
      provider: 'workspace', siteId: 'local', key: 'identity-boundary',
      title: 'Identity Boundary'
    },
    leadRepository: 'member',
    capabilityAuthority: { url: capabilityAuthority },
    repositories: {
      member: {
        id: 'member', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/member', capabilities: ['member-capability'],
        clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
      }
    },
    capabilities: ['member-capability'],
    directories: {
      repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira'
    },
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
}

function activeWorkspaceRecord(workspace, repositoryPath) {
  return {
    schemaVersion: 1,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    anchorKey: workspace.anchor.key,
    repositoryId: 'member',
    repositoryPath,
    canonicalRepositoryPath: repositoryPath,
    checkoutPath: repositoryPath,
    repositoryState: 'ready',
    branch: 'main',
    capabilities: ['member-capability'],
    repositoryCapabilities: ['member-capability'],
    storyId: null,
    selectedAt: '2026-08-31T00:00:00.000Z'
  };
}

test('strict workspace membership rejects exact-path reuse by a different Git origin', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-path-reuse-'));
  try {
    const member = path.join(base, 'repos/member');
    const reviewedRemote = path.join(base, 'remotes/reviewed.git');
    const replacementRemote = path.join(base, 'remotes/replacement.git');
    await initializeRepository(member);
    await mkdir(path.dirname(reviewedRemote), { recursive: true });
    await publishRepository(member, reviewedRemote);

    const workspace = workspaceRecord({ remote: reviewedRemote });
    workspace.path = base;
    const selection = path.join(base, 'active-workspace.json');
    const registry = path.join(base, 'workspaces.json');
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    await writeFile(selection,
      `${JSON.stringify(activeWorkspaceRecord(workspace, member), null, 2)}\n`);
    await writeFile(registry, `${JSON.stringify({
      schemaVersion: 1,
      workspaces: [{
        id: workspace.id, path: base, name: workspace.name,
        anchorKey: workspace.anchor.key, anchorType: 'Workspace', siteId: 'local',
        leadRepositoryPath: member, openedAt: '2026-08-31T00:00:00.000Z', archivedAt: null
      }]
    }, null, 2)}\n`);

    const reviewed = await workspaceMemberContextForRepository(member, selection, registry, {
      strict: true
    });
    assert.equal(reviewed.repositoryId, 'member');

    // Reusing the same machine path must not inherit the old workspace's authority. This models a
    // checkout being deleted/replaced while active-workspace.json and workspace.json remain.
    await rm(member, { recursive: true, force: true });
    await initializeRepository(member);
    await publishRepository(member, replacementRemote);
    await assert.rejects(
      () => workspaceMemberContextForRepository(member, selection, registry, { strict: true }),
      (error) => {
        assert.equal(error?.code, 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH', error?.stack);
        assert.equal(error?.details?.repositoryId, 'member');
        assert.equal(error?.details?.expectedRemote, reviewedRemote);
        assert.equal(error?.details?.actualRemote, replacementRemote);
        return true;
      }
    );
    assert.equal(
      await workspaceMemberContextForRepository(member, selection, registry),
      null,
      'best-effort consumers must fall back instead of inheriting authority from the reused path'
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('workspace identity compares the reviewed raw origin before url rewrite rules', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-raw-origin-'));
  try {
    const member = path.join(base, 'repos/member');
    const remoteDirectory = path.join(base, 'remotes');
    const transportRemote = path.join(remoteDirectory, 'member.git');
    const reviewedRemote = 'reviewed-workspace:member.git';
    await initializeRepository(member);
    await mkdir(remoteDirectory, { recursive: true });
    git(remoteDirectory, 'init', '--bare', '-q', '-b', 'main', transportRemote);
    git(member, 'config', `url.${remoteDirectory}/.insteadOf`, 'reviewed-workspace:');
    git(member, 'remote', 'add', 'origin', reviewedRemote);
    git(member, 'push', '-q', '-u', 'origin', 'main');
    assert.equal(git(member, 'config', '--local', '--get', 'remote.origin.url'), reviewedRemote);
    assert.equal(git(member, 'remote', 'get-url', 'origin'), transportRemote,
      'Git transport selection expands the machine rewrite');

    const workspace = workspaceRecord({ remote: reviewedRemote });
    workspace.path = base;
    const selection = path.join(base, 'active-workspace.json');
    const registry = path.join(base, 'workspaces.json');
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    await writeFile(selection,
      `${JSON.stringify(activeWorkspaceRecord(workspace, member), null, 2)}\n`);
    await writeFile(registry, `${JSON.stringify({
      schemaVersion: 1,
      workspaces: [{
        id: workspace.id, path: base, name: workspace.name,
        anchorKey: workspace.anchor.key, anchorType: 'Workspace', siteId: 'local',
        leadRepositoryPath: member, openedAt: '2026-08-31T00:00:00.000Z', archivedAt: null
      }]
    }, null, 2)}\n`);

    const context = await workspaceMemberContextForRepository(member, selection, registry, {
      strict: true
    });
    assert.equal(context.repositoryId, 'member');
    assert.equal(context.workspace.repositories.member.url, reviewedRemote,
      'the manifest and raw local origin are the identity proof');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resolved workspace membership retains one deeply immutable manifest snapshot', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-snapshot-'));
  try {
    const member = path.join(base, 'repos/member');
    const remote = path.join(base, 'remotes/member.git');
    await initializeRepository(member);
    await mkdir(path.dirname(remote), { recursive: true });
    await publishRepository(member, remote);

    const workspace = workspaceRecord({ remote });
    workspace.path = base;
    const selection = path.join(base, 'active-workspace.json');
    const registry = path.join(base, 'workspaces.json');
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    await writeFile(selection,
      `${JSON.stringify(activeWorkspaceRecord(workspace, member), null, 2)}\n`);
    await writeFile(registry, `${JSON.stringify({
      schemaVersion: 1,
      workspaces: [{
        id: workspace.id, path: base, name: workspace.name,
        anchorKey: workspace.anchor.key, anchorType: 'Workspace', siteId: 'local',
        leadRepositoryPath: member, openedAt: '2026-08-31T00:00:00.000Z', archivedAt: null
      }]
    }, null, 2)}\n`);

    const retained = await workspaceMemberContextForRepository(member, selection, registry, {
      strict: true
    });
    const retainedBytes = JSON.stringify(retained.workspace);
    const retainedDigest = retained.workspaceManifestSha256;
    assert.equal(Object.isFrozen(retained.workspace), true);
    assert.equal(Object.isFrozen(retained.workspace.repositories), true);
    assert.equal(Object.isFrozen(retained.workspace.repositories.member), true);
    assert.throws(
      () => { retained.workspace.repositories.member.url = 'https://attacker.invalid/member.git'; },
      TypeError
    );

    const rewritten = structuredClone(workspace);
    rewritten.name = 'Rewritten Workspace';
    rewritten.capabilityAuthority.url = 'https://authority.example.test/rewritten.git';
    rewritten.capabilities = ['replacement-capability'];
    rewritten.updatedAt = '2026-08-31T00:01:00.000Z';
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(rewritten, null, 2)}\n`);

    assert.equal(JSON.stringify(retained.workspace), retainedBytes,
      'a later manifest rewrite cannot change the operation snapshot');
    assert.equal(retained.workspaceManifestSha256, retainedDigest,
      'the retained digest continues to identify those exact reviewed bytes');
    assert.equal(retained.workspace.name, 'Identity Boundary');
    assert.equal(retained.workspace.capabilityAuthority.url, remote);

    const next = await workspaceMemberContextForRepository(member, selection, registry, {
      strict: true
    });
    assert.notEqual(next.workspaceManifestSha256, retainedDigest);
    assert.equal(next.workspace.name, 'Rewritten Workspace');
    assert.equal(next.workspace.capabilityAuthority.url,
      'https://authority.example.test/rewritten.git');
    assert.equal(retained.workspace.name, 'Identity Boundary',
      'new operations may observe the rewrite without retroactively changing the old operation');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('capability resolution refuses a map replaced after secure path validation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-map-race-'));
  const root = path.join(base, 'repository');
  const selection = path.join(base, 'no-active-workspace.json');
  const registry = path.join(base, 'no-workspaces.json');
  try {
    await initializeRepository(root, { singularity: true });
    const mapPath = path.join(root, 'singularity/capabilities.yml');
    const retainedPath = `${mapPath}.retained`;
    await writeFile(mapPath, capabilityMap('Original Capability'));
    let replaced = false;
    setCapabilityMapReadObserverForTests(async ({ stage, path: observedPath }) => {
      if (stage !== 'located' || replaced) return;
      replaced = true;
      assert.equal(observedPath, await realpath(mapPath));
      await rename(mapPath, retainedPath);
      await writeFile(mapPath, capabilityMap('Replacement Capability'));
    });
    await withMachineFiles(selection, registry, async () => {
      await assert.rejects(
        () => resolveLifecycleCapability(root, {
          capabilityId: 'member-capability', required: true, offline: true
        }),
        (error) => {
          assert.equal(error?.code, 'CAPABILITY_MAP_UNSAFE', error?.stack);
          assert.equal(error?.details?.reason, 'descriptor-identity-changed');
          return true;
        }
      );
    });
    assert.equal(replaced, true, 'the test replaced the file in the validation/open window');
  } finally {
    setCapabilityMapReadObserverForTests(null);
    await rm(base, { recursive: true, force: true });
  }
});

test('approved capability repository-plan mismatches fail before remote inventory', () => {
  const capability = {
    id: 'member-capability',
    deliveries: [{ repositories: ['member', 'companion'] }]
  };
  const repositories = [
    {
      id: 'member', url: 'https://git.example.test/member.git',
      defaultBranch: 'main', required: true
    },
    {
      id: 'companion', url: 'https://git.example.test/companion.git',
      defaultBranch: 'develop', required: false
    }
  ];
  const snapshot = (portfolio) => ({
    assets: [(() => {
      const contents = Buffer.from(YAML.stringify({ version: 1, repositories: portfolio }));
      return {
        relative: 'singularity/portfolio.yml',
        contents,
        sha256: createHash('sha256').update(contents).digest('hex')
      };
    })()]
  });
  const approved = snapshot({
    member: {
      url: repositories[0].url, defaultBranch: 'main', required: true
    },
    companion: {
      url: repositories[1].url, defaultBranch: 'develop', required: false
    }
  });
  assert.deepEqual(
    assertApprovedCapabilityRepositoryPlan(repositories, capability, approved),
    { expectedRepositories: ['companion', 'member'], identityChecked: true }
  );

  const tampered = snapshot({
    member: {
      url: repositories[0].url, defaultBranch: 'main', required: true
    },
    companion: {
      url: repositories[1].url, defaultBranch: 'develop', required: false
    }
  });
  tampered.assets[0].contents[0] ^= 1;
  assert.throws(
    () => assertApprovedCapabilityRepositoryPlan(repositories, capability, tampered),
    (error) => error?.code === 'STORY_CONFIGURATION_SNAPSHOT_INVALID'
  );

  const rejectsStalePlan = (planned, approvedSnapshot, expectedDetails = {}) => {
    assert.throws(
      () => assertApprovedCapabilityRepositoryPlan(planned, capability, approvedSnapshot),
      (error) => {
        assert.equal(error?.code, 'CAPABILITY_WORKSPACE_BINDING_STALE', error?.stack);
        for (const [key, value] of Object.entries(expectedDetails)) {
          assert.deepEqual(error?.details?.[key], value);
        }
        return true;
      }
    );
  };
  rejectsStalePlan(repositories.slice(0, 1), approved, {
    expectedRepositories: ['companion', 'member'], plannedRepositories: ['member']
  });
  rejectsStalePlan([...repositories, {
    id: 'unreviewed', url: 'https://git.example.test/unreviewed.git',
    defaultBranch: 'main', required: true
  }], approved, {
    expectedRepositories: ['companion', 'member'],
    plannedRepositories: ['companion', 'member', 'unreviewed']
  });

  const mismatched = (repositoryId, field, value) => repositories.map((repository) => (
    repository.id === repositoryId ? { ...repository, [field]: value } : { ...repository }
  ));
  rejectsStalePlan(mismatched('member', 'url', 'https://evil.example.test/member.git'), approved, {
    repositoryId: 'member', mismatches: ['remote']
  });
  rejectsStalePlan(mismatched('companion', 'defaultBranch', 'main'), approved, {
    repositoryId: 'companion', mismatches: ['default branch']
  });
  rejectsStalePlan(mismatched('companion', 'required', true), approved, {
    repositoryId: 'companion', mismatches: ['required flag']
  });
});

test('non-selected members, linked worktrees, and SGOS use the external workspace authority', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-member-context-'));
  const unrelatedBase = await mkdtemp(path.join(os.tmpdir(), 'sflow-unrelated-member-context-'));
  try {
    const lead = path.join(base, 'repos/lead');
    const member = path.join(base, 'repos/member');
    const leadRemote = path.join(base, 'remotes/lead.git');
    const memberRemote = path.join(base, 'remotes/member.git');
    await initializeRepository(lead, { singularity: true });
    await writeFile(path.join(lead, 'singularity/capabilities.yml'), capabilityMap());
    git(lead, 'add', 'singularity/capabilities.yml');
    git(lead, 'commit', '-qm', 'map member capability');
    await initializeRepository(member, { singularity: true });
    await writeFile(path.join(member, 'singularity/capabilities.yml'),
      capabilityMap('Wrong Member-Origin Capability'));
    git(member, 'add', 'singularity/capabilities.yml');
    git(member, 'commit', '-qm', 'publish different member-origin capability');
    await mkdir(path.dirname(leadRemote), { recursive: true });
    await publishRepository(lead, leadRemote);
    await publishRepository(member, memberRemote);
    await ensureConfigurationBranch(leadRemote);
    await ensureConfigurationBranch(memberRemote);

    const authorityPublisher = path.join(base, 'authority-publisher');
    command('git', [
      'clone', '-q', '-b', CONFIGURATION_BRANCH, leadRemote, authorityPublisher
    ], base);
    git(authorityPublisher, 'config', 'user.name', 'Capability Authority Publisher');
    git(authorityPublisher, 'config', 'user.email', 'capability-authority@example.test');
    const authorizedWorkflowPath = path.join(authorityPublisher, 'singularity/workflow.yml');
    const authorizedWorkflow = YAML.parse(await readFile(authorizedWorkflowPath, 'utf8'));
    authorizedWorkflow.approvalAuthorities ??= {};
    authorizedWorkflow.approvalAuthorities['architecture-reviewers'] ??= { members: [] };
    authorizedWorkflow.approvalAuthorities['architecture-reviewers'].members = [
      { email: 'capability-authority@example.test' }
    ];
    await writeFile(authorizedWorkflowPath, YAML.stringify(authorizedWorkflow));
    git(authorityPublisher, 'add', 'singularity/workflow.yml');
    git(authorityPublisher, 'commit', '-qm', 'Authorize SGOS platform actor');
    const historicalAuthorityCommit = git(authorityPublisher, 'rev-parse', 'HEAD');
    const historicalWorkflowBytes = await readFile(authorizedWorkflowPath);
    await writeFile(
      authorizedWorkflowPath,
      Buffer.concat([historicalWorkflowBytes, Buffer.from('# current external authority\n')])
    );
    git(authorityPublisher, 'add', 'singularity/workflow.yml');
    git(authorityPublisher, 'commit', '-qm', 'Advance external workspace authority');
    const currentAuthorityCommit = git(authorityPublisher, 'rev-parse', 'HEAD');
    const currentWorkflowBytes = await readFile(authorizedWorkflowPath);
    git(authorityPublisher, 'push', '-q', 'origin', CONFIGURATION_BRANCH);

    // Delivery application B is intentionally configuration-free. Its remote still carries a
    // conflicting sflow/config authority, but protected application bytes cannot interfere with
    // the SGOS boundary comparison below.
    await rm(path.join(member, 'singularity'), { recursive: true, force: true });
    await rm(path.join(member, '.github'), { recursive: true, force: true });
    git(member, 'add', '-A');
    git(member, 'commit', '-qm', 'Keep the delivery application configuration-free');
    git(member, 'push', '-q', 'origin', 'main');
    const forgedMemberRevision = git(member, 'rev-parse', 'HEAD');

    const linked = path.join(base, 'linked-member');
    git(member, 'branch', 'MEMBER-WORK');
    git(member, 'worktree', 'add', '-q', linked, 'MEMBER-WORK');

    const workspace = {
      version: 1,
      id: 'local--multi-member',
      name: 'Multi Member',
      anchor: {
        provider: 'workspace', siteId: 'local', key: 'multi-member', title: 'Multi Member'
      },
      leadRepository: 'lead',
      capabilityAuthority: { url: leadRemote },
      repositories: {
        lead: {
          id: 'lead', url: leadRemote, defaultBranch: 'main', required: true,
          path: 'repos/lead', capabilities: [],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        },
        member: {
          id: 'member', url: memberRemote, defaultBranch: 'main', required: true,
          path: 'repos/member', capabilities: ['member-capability'],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        }
      },
      capabilities: ['member-capability'],
      directories: {
        repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira'
      },
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z'
    };
    const selection = path.join(base, 'active-workspace.json');
    const registry = path.join(base, 'workspaces.json');
    await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
    const leadSelection = {
      schemaVersion: 1,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: base,
      anchorKey: workspace.anchor.key,
      repositoryId: 'lead',
      repositoryPath: lead,
      canonicalRepositoryPath: lead,
      checkoutPath: lead,
      repositoryState: 'ready',
      branch: 'main',
      capabilities: ['member-capability'],
      repositoryCapabilities: [],
      storyId: null,
      selectedAt: '2026-08-31T00:00:00.000Z'
    };
    await writeFile(selection, `${JSON.stringify(leadSelection, null, 2)}\n`);
    const workspaceRegistry = {
      schemaVersion: 1,
      workspaces: [{
        id: workspace.id,
        path: base,
        name: workspace.name,
        anchorKey: workspace.anchor.key,
        anchorType: 'Workspace',
        siteId: 'local',
        leadRepositoryPath: lead,
        openedAt: '2026-08-31T00:00:00.000Z',
        archivedAt: null
      }]
    };
    await writeFile(registry, `${JSON.stringify(workspaceRegistry, null, 2)}\n`);

    await withMachineFiles(selection, registry, async () => {
      const newWorkRead = await withApprovedConfigurationRead(member, async (authority) => {
        const configurationSnapshot = configurationReadSnapshot(member);
        return {
          authority,
          configurationSnapshot,
          capability: await resolveLifecycleCapability(member, {
            capabilityId: 'member-capability', required: true, offline: true
          })
        };
      }, {
        preferAuthority: true,
        refreshAuthority: true,
        requireAuthorityRefresh: true
      });
      assert.equal(newWorkRead.authority.remote, leadRemote);
      assert.ok(newWorkRead.configurationSnapshot,
        'new-work inventory receives the exact retained authority snapshot');
      assert.equal(newWorkRead.capability.name, 'Member Capability');
      assert.equal(newWorkRead.capability.map.repository, leadRemote,
        'new-work reads must use workspace capabilityAuthority A, not member origin B');
      assert.notEqual(newWorkRead.capability.name, 'Wrong Member-Origin Capability');

      const sgosConfigurationRead = await withTrustedSgosConfigurationRead(
        linked,
        async (authority, trust) => ({
          authority,
          trust,
          capability: await resolveLifecycleCapability(linked, {
            capabilityId: 'member-capability', required: true, offline: true
          })
        })
      );
      assert.equal(sgosConfigurationRead.authority.kind, 'approved-configuration-ref');
      assert.equal(sgosConfigurationRead.authority.ref, CONFIGURATION_BRANCH);
      assert.equal(sgosConfigurationRead.authority.remote, leadRemote);
      assert.equal(sgosConfigurationRead.trust.mode, 'workspace-capability-authority');
      assert.equal(sgosConfigurationRead.trust.repository, leadRemote);
      assert.equal(sgosConfigurationRead.capability.name, 'Member Capability');
      assert.notEqual(sgosConfigurationRead.capability.name, 'Wrong Member-Origin Capability',
        'SGOS must not pin member origin B when the workspace explicitly declares authority A');
      const currentPlatformAuthority = await loadApprovedPlatformMutationAuthority(
        member, 'pack.activate', { policyAuthorityRevision: currentAuthorityCommit }
      );
      assert.equal(currentPlatformAuthority.configurationCommit, currentAuthorityCommit);
      assert.equal(
        currentPlatformAuthority.workflowSha256,
        `sha256:${createHash('sha256').update(currentWorkflowBytes).digest('hex')}`,
        'an equal current revision uses the mounted verified A overlay, never B objects'
      );
      const historicalPlatformAuthority = await loadApprovedPlatformMutationAuthority(
        member, 'pack.activate', { policyAuthorityRevision: historicalAuthorityCommit }
      );
      assert.equal(historicalPlatformAuthority.configurationCommit, historicalAuthorityCommit);
      assert.equal(
        historicalPlatformAuthority.workflowSha256,
        `sha256:${createHash('sha256').update(historicalWorkflowBytes).digest('hex')}`,
        'a historical revision is ancestry-checked and read from authority A object storage'
      );
      await assert.rejects(
        () => loadApprovedPlatformMutationAuthority(member, 'pack.activate', {
          policyAuthorityRevision: forgedMemberRevision
        }),
        (error) => {
          assert.equal(error?.code, 'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', error?.stack);
          return true;
        },
        'a commit that exists only in application B cannot become an A policy revision'
      );
      const offlineSgosRead = await withTrustedSgosConfigurationRead(
        member, async (authority, trust) => ({ authority, trust }), { refreshAuthority: false }
      );
      assert.deepEqual(offlineSgosRead, { authority: null, trust: null },
        'an offline SGOS read cannot substitute cached member-origin B for external authority A');

      const mirrored = await publishStateConfigurationMirror(base, leadRemote);
      assert.equal(
        git(base, '--git-dir', leadRemote, 'rev-parse', `refs/heads/${mirrored.history.branch}`),
        mirrored.sourceCommit,
        'the state mirror retains source ancestry behind an immutable advertised ref'
      );
      git(base, '--git-dir', leadRemote, 'update-ref',
        `refs/heads/${mirrored.history.branch}`, historicalAuthorityCommit);
      await assert.rejects(
        () => retainStateConfigurationHistory(
          authorityPublisher, 'origin', mirrored.sourceCommit
        ),
        (error) => {
          assert.equal(error?.code, 'STATE_CONFIGURATION_HISTORY_COLLISION', error?.stack);
          assert.equal(error?.details?.actualCommit, historicalAuthorityCommit);
          return true;
        },
        'an immutable source-specific history ref can never be retargeted'
      );
      git(base, '--git-dir', leadRemote, 'update-ref',
        `refs/heads/${mirrored.history.branch}`, mirrored.sourceCommit);
      // Model a hosted service that refuses raw/unadvertised object wants. The configuration ref is
      // then removed, leaving only state plus the immutable history receipt as portable authority.
      git(base, '--git-dir', leadRemote, 'config', 'uploadpack.allowAnySHA1InWant', 'false');
      git(base, '--git-dir', leadRemote, 'config', 'uploadpack.allowReachableSHA1InWant', 'false');
      git(base, '--git-dir', leadRemote, 'config', 'uploadpack.allowTipSHA1InWant', 'false');
      git(base, '--git-dir', leadRemote, 'update-ref', '-d', `refs/heads/${CONFIGURATION_BRANCH}`);
      const sgosStateRead = await withTrustedSgosConfigurationRead(
        member,
        async (authority, trust) => ({
          authority,
          trust,
          capability: await resolveLifecycleCapability(member, {
            capabilityId: 'member-capability', required: true, offline: true
          })
        })
      );
      assert.equal(sgosStateRead.authority.kind, 'verified-state-mirror');
      assert.equal(sgosStateRead.authority.ref, 'state');
      assert.equal(sgosStateRead.authority.commit, mirrored.stateCommit);
      assert.equal(sgosStateRead.authority.manifest.source.commit, mirrored.sourceCommit);
      assert.equal(sgosStateRead.trust.mode, 'workspace-capability-authority');
      assert.equal(sgosStateRead.trust.branch, 'state');
      assert.equal(sgosStateRead.capability.name, 'Member Capability',
        'SGOS accepts only the fully verified state mirror of workspace authority A');
      const currentStatePlatformAuthority = await loadApprovedPlatformMutationAuthority(
        member, 'pack.activate', { policyAuthorityRevision: currentAuthorityCommit }
      );
      assert.equal(currentStatePlatformAuthority.configurationRef, 'state');
      assert.equal(currentStatePlatformAuthority.configurationCommit, currentAuthorityCommit);
      assert.equal(
        currentStatePlatformAuthority.workflowSha256,
        `sha256:${createHash('sha256').update(currentWorkflowBytes).digest('hex')}`,
        'the state transport retains the mounted source bytes for the current revision'
      );
      const historicalStatePlatformAuthority = await loadApprovedPlatformMutationAuthority(
        member, 'pack.activate', { policyAuthorityRevision: historicalAuthorityCommit }
      );
      assert.equal(historicalStatePlatformAuthority.configurationRef, 'state');
      assert.equal(
        historicalStatePlatformAuthority.workflowSha256,
        `sha256:${createHash('sha256').update(historicalWorkflowBytes).digest('hex')}`,
        'state-backed historical policy is read through A history ref, not a raw SHA or application B'
      );

      // A new-format mirror must never silently fall back to a dangling raw object if its retained
      // branch disappears. This also proves the successful read above actually depended on the
      // advertised receipt rather than the permissive behavior of a local test remote.
      git(base, '--git-dir', leadRemote, 'update-ref', '-d',
        `refs/heads/${mirrored.history.branch}`);
      await assert.rejects(
        () => loadApprovedPlatformMutationAuthority(member, 'pack.activate', {
          policyAuthorityRevision: historicalAuthorityCommit
        }),
        (error) => {
          assert.equal(error?.code, 'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED', error?.stack);
          assert.equal(error?.details?.configurationHistoryBranch, mirrored.history.branch);
          assert.equal(error?.details?.legacyStateMirror, false);
          return true;
        },
        'missing immutable history is refused even while the raw source object remains dangling'
      );
      git(base, '--git-dir', leadRemote, 'update-ref',
        `refs/heads/${mirrored.history.branch}`, mirrored.sourceCommit);

      const corruptState = path.join(base, 'state-mirror-corruptor');
      command('git', ['clone', '-q', '-b', 'state', leadRemote, corruptState], base);
      git(corruptState, 'config', 'user.name', 'State Corruptor');
      git(corruptState, 'config', 'user.email', 'state-corruptor@example.test');
      const corruptManifestPath = path.join(corruptState, STATE_CONFIGURATION_MANIFEST);
      const corruptManifest = JSON.parse(await readFile(corruptManifestPath, 'utf8'));
      corruptManifest.files['singularity/capabilities.yml'] = '0'.repeat(64);
      await writeFile(corruptManifestPath, `${JSON.stringify(corruptManifest, null, 2)}\n`);
      git(corruptState, 'add', STATE_CONFIGURATION_MANIFEST);
      git(corruptState, 'commit', '-qm', 'Corrupt state mirror digest');
      git(corruptState, 'push', '-q', 'origin', 'state');
      await assert.rejects(
        () => withTrustedSgosConfigurationRead(member, async () => null),
        (error) => {
          assert.equal(error?.code, 'STATE_CONFIGURATION_MIRROR_INVALID', error?.stack);
          return true;
        },
        'a corrupt workspace authority A mirror must fail closed instead of falling back to B'
      );

      for (const repositoryRoot of [member, linked]) {
        const context = await workspaceMemberContextForRepository(repositoryRoot, selection, registry);
        assert.equal(context.repositoryId, 'member');
        assert.deepEqual(context.repositoryCapabilities, ['member-capability']);
        assert.equal(context.storyWorktree, repositoryRoot === linked);

        const capability = await resolveLifecycleCapability(repositoryRoot, {
          required: true, offline: true
        });
        assert.equal(capability.id, 'member-capability');
        assert.equal(capability.repositoryId, 'member');

        const catalog = await storyBaseCatalog(repositoryRoot, { defaultBranch: 'main' });
        assert.equal(catalog.scope, 'capability');
        assert.equal(catalog.capability, 'member-capability');
        assert.equal(catalog.repositoryId, 'member');

        assert.equal(
          await storyWorktreePath(repositoryRoot, 'MEMBER-STORY'),
          path.join(base, '.singularity-flow/story-worktrees/MEMBER-STORY/repos/member')
        );

        const workId = repositoryRoot === linked ? 'MEMBER-LINKED-LOCATOR' : 'MEMBER-LOCATOR';
        const written = await writeReturnLocator(repositoryRoot, {
          git: { remote: 'origin' }, workItemRoot: 'singularity/work-items'
        }, {
          workItem: { id: workId, branch: workId },
          lineage: { canonicalBranch: workId },
          resolution: {
            configSha256: 'a'.repeat(64),
            capability: { id: 'member-capability', repositoryId: 'member' }
          }
        });
        assert.equal(written.locator.originRepositoryId, 'member');
        assert.deepEqual(written.locator.repositories.map((entry) => entry.id), ['lead', 'member']);
      }

      const unrelated = path.join(unrelatedBase, 'repository');
      await initializeRepository(unrelated);
      assert.equal(await workspaceMemberContextForRepository(unrelated, selection, registry), null);
      const standalone = await writeReturnLocator(unrelated, {
        git: { remote: 'origin' }, workItemRoot: 'singularity/work-items'
      }, {
        workItem: { id: 'STANDALONE-LOCATOR', branch: 'STANDALONE-LOCATOR' },
        lineage: { canonicalBranch: 'STANDALONE-LOCATOR' },
        resolution: { configSha256: 'b'.repeat(64), capability: null }
      });
      assert.deepEqual(standalone.locator.repositories.map((entry) => entry.id), ['repository']);

      const journalEnv = {
        ...process.env,
        SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(base, 'machine-journal')
      };
      const captured = await captureCommandOutcome({
        root: linked,
        operationId: 'submit',
        positionals: ['submit', 'verification'],
        result: {
          subject: { id: 'MEMBER-WORK' }, outcome: { status: 'succeeded' }
        },
        startedAt: '2026-08-31T08:00:00.000Z',
        env: journalEnv
      });
      assert.equal(captured.stored, true);
      const events = await readJournalEvents(workspace.id, '2026-08-31', { env: journalEnv });
      assert.equal(events.events[0].repositoryId, undefined,
        'the private event stores only a one-way repository key');
      assert.equal(events.events[0].kind, 'submitted');

      const audit = await setPromptAudit(member, true);
      assert.equal(audit.scope, 'workspace');
      assert.equal(audit.logFile, path.join(base, '.singularity-flow/prompt-audit/prompts.jsonl'));
      await recordPromptAudit(linked, {
        agent: 'developer', phase: 'implementation', workId: 'MEMBER-WORK',
        prompt: 'member-scoped prompt'
      });
      assert.equal((await promptAuditStatus(linked)).scope, 'workspace');

      await recordHelpMetric(linked, {
        surface: 'chat', intent: 'concept', outcome: 'resolved',
        topicId: 'project-binding', matchedBy: 'authored-question',
        latencyMs: 1, answerBytes: 64, actionCategory: null
      });
      const help = await helpMetricsStatus(member);
      assert.equal(help.scope, 'workspace');
      assert.equal(help.logFile, path.join(base, '.singularity-flow/help-metrics/events.jsonl'));

      await writeFile(selection, `${JSON.stringify({
        ...leadSelection,
        repositoryId: 'member',
        repositoryPath: member,
        canonicalRepositoryPath: member,
        checkoutPath: member,
        repositoryCapabilities: ['obsolete-cached-capability']
      }, null, 2)}\n`);
      const refreshedMember = await workspaceMemberContextForRepository(member, selection, registry, {
        strict: true
      });
      assert.deepEqual(refreshedMember.repositoryCapabilities, ['member-capability'],
        'member capabilities come from the current workspace manifest, not the selection cache');

      const legacySelection = { ...leadSelection };
      delete legacySelection.workspacePath;
      legacySelection.repositoryId = 'member';
      legacySelection.repositoryPath = member;
      legacySelection.canonicalRepositoryPath = member;
      legacySelection.checkoutPath = member;
      legacySelection.repositoryCapabilities = ['obsolete-cached-capability'];
      await writeFile(selection, `${JSON.stringify(legacySelection, null, 2)}\n`);
      const recoveredLegacyMember = await workspaceMemberContextForRepository(
        member, selection, registry, { strict: true }
      );
      assert.deepEqual(recoveredLegacyMember.repositoryCapabilities, ['member-capability'],
        'strict legacy selections revalidate capabilities through the registered workspace manifest');
      assert.equal(recoveredLegacyMember.workspacePath, await realpath(base),
        'the recovered manifest path is retained for downstream authority readers');
      await writeFile(registry, `${JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2)}\n`);
      await assert.rejects(
        () => workspaceMemberContextForRepository(member, selection, registry, { strict: true }),
        /cannot be revalidated/
      );
      await writeFile(registry, `${JSON.stringify(workspaceRegistry, null, 2)}\n`);

      await writeFile(selection, '{not-json\n');
      await assert.rejects(
        () => resolveLifecycleCapability(member, { required: true, offline: true }),
        /Unable to read active workspace selection/
      );
      const corruptSelectionJournal = await captureCommandOutcome({
        root: member,
        operationId: 'submit',
        positionals: ['submit', 'verification'],
        result: { subject: { id: 'MEMBER-WORK' }, outcome: { status: 'succeeded' } },
        startedAt: '2026-08-31T08:01:00.000Z',
        env: journalEnv
      });
      assert.deepEqual(corruptSelectionJournal, {
        stored: false, reason: 'repository-not-active'
      }, 'a corrupt navigation selection cannot fail an already-completed governed command');
      assert.equal((await helpMetricsStatus(member)).scope, 'repository',
        'help metrics fall back to repository scope when navigation selection is corrupt');
      await writeFile(selection, `${JSON.stringify(leadSelection, null, 2)}\n`);

      await writeFile(path.join(base, 'workspace.json'), '{not-json\n');
      await assert.rejects(
        () => workspaceMemberContextForRepository(member, selection, registry, { strict: true }),
        /Unable to read .*workspace\.json/
      );
      assert.equal(await workspaceMemberContextForRepository(member, selection, registry), null,
        'best-effort consumers fall back when the selected workspace manifest is corrupt');
      assert.equal(await workspaceMemberContextForRepository(unrelated, selection, registry), null,
        'damage in the selected workspace must not block an unrelated repository');
    });
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(unrelatedBase, { recursive: true, force: true });
  }
});

test('approved overlays never stamp fresh capability bytes with older pinned provenance', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-overlay-provenance-'));
  try {
    const root = path.join(base, 'application');
    const remote = path.join(base, 'application.git');
    const selection = path.join(base, 'no-active-workspace.json');
    const registry = path.join(base, 'no-workspaces.json');
    await initializeRepository(root, { singularity: true });
    const pinnedBytes = capabilityMap('Pinned Capability');
    await writeFile(path.join(root, 'singularity/capabilities.yml'), pinnedBytes);
    git(root, 'add', 'singularity/capabilities.yml');
    git(root, 'commit', '-qm', 'configure pinned capability');
    await publishRepository(root, remote);
    await ensureConfigurationBranch(remote);

    await withMachineFiles(selection, registry, async () => {
      git(root, 'switch', '-q', '-c', 'PINNED-STORY');
      const authority = await resolveStoryConfigurationAuthority(root);
      const snapshot = await loadStoryConfigurationSnapshot(authority);
      const materialized = await materializeConfigurationSnapshot(root, { authority, snapshot });
      git(root, 'add', '-A');
      git(root, 'commit', '-qm', 'pin approved configuration A');

      const pinned = await resolveLifecycleCapability(root, {
        capabilityId: 'member-capability', required: true, offline: true
      });
      assert.equal(pinned.map.sha256, createHash('sha256').update(pinnedBytes).digest('hex'));
      assert.equal(pinned.map.authority, 'pinned-story-configuration');
      assert.equal(pinned.map.commit, materialized.commit);

      const publisher = path.join(base, 'configuration-publisher');
      git(base, 'clone', '-q', '-b', 'sflow/config', remote, publisher);
      git(publisher, 'config', 'user.name', 'Configuration Publisher');
      git(publisher, 'config', 'user.email', 'publisher@example.test');
      const currentBytes = capabilityMap('Current Approved Capability');
      await writeFile(path.join(publisher, 'singularity/capabilities.yml'), currentBytes);
      git(publisher, 'add', 'singularity/capabilities.yml');
      git(publisher, 'commit', '-qm', 'advance capability authority to B');
      const currentCommit = git(publisher, 'rev-parse', 'HEAD');
      git(publisher, 'push', '-q', 'origin', 'sflow/config');

      const resolved = await withApprovedConfigurationRead(root, async (approvedAuthority) => ({
        approvedAuthority,
        capability: await resolveLifecycleCapability(root, {
          capabilityId: 'member-capability', required: true, offline: true
        })
      }), {
        preferAuthority: true,
        refreshAuthority: true,
        requireAuthorityRefresh: true
      });

      assert.equal(resolved.capability.map.sha256,
        createHash('sha256').update(currentBytes).digest('hex'));
      assert.equal(resolved.capability.map.authority, 'approved-configuration');
      assert.equal(resolved.capability.map.repository, remote);
      assert.equal(resolved.capability.map.branch, 'sflow/config');
      assert.equal(resolved.capability.map.commit, currentCommit);
      assert.equal(resolved.capability.map.commit, resolved.approvedAuthority.commit);

      const pinnedAgain = await resolveLifecycleCapability(root, {
        capabilityId: 'member-capability', required: true, offline: true
      });
      assert.equal(pinnedAgain.map.sha256, pinned.map.sha256);
      assert.equal(pinnedAgain.map.commit, pinned.map.commit);
      assert.equal(pinnedAgain.map.authority, 'pinned-story-configuration');
      assert.equal(await readFile(path.join(root, 'singularity/capabilities.yml'), 'utf8'), pinnedBytes);
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
