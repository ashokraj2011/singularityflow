import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  adoptWorkspaceConfiguration, archiveWorkspace, createWorkspace, createWorkspaceConfiguration, fetchWorkspace, forgetWorkspace, listWorkspaceDocuments,
  normalizeWorkspaceAnchor, previewWorkspace, previewWorkspaceConfiguration, readWorkspace, readWorkspaceRegistry,
  rememberWorkspace, resolveWorkspaceDocument, restoreWorkspace, saveWorkspaceConfiguration, stageWorkspaceDocuments,
  updateWorkspaceConfiguration, validateWorkspaceManifest, workspaceArchiveReadiness, workspaceRepositoryPath,
  workspaceStatus
} from '../src/workspace.mjs';
import {
  activateWorkspaceContext, buildWorkspaceContext, discardUnsupportedWorkflowWorkspaces,
  readActiveWorkspaceContext, resolveWorkspaceReference, workspacePromptLabel
} from '../src/workspace-context.mjs';
import { activeWorkspaceRepositoryRoot, ACTIVE_WORKSPACE_ROUTING_EXCLUSIONS } from '../src/cli-entry.mjs';
import { run } from '../src/util.mjs';
import { ensureConfigurationBranch } from '../src/configuration-branch.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

test('repository commands can route through the explicitly selected workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-selected-command-root-'));
  const repository = path.join(root, 'repository');
  const selection = path.join(root, 'active-workspace.json');
  const registry = path.join(root, 'workspaces.json');
  await mkdir(repository);
  run('git', ['init', '-b', 'main'], { cwd: repository });
  run('git', ['config', 'user.name', 'Workspace Router'], { cwd: repository });
  run('git', ['config', 'user.email', 'router@example.com'], { cwd: repository });
  const initialized = spawnSync(process.execPath, [cli, 'init'], { cwd: repository, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  run('git', ['add', '-A'], { cwd: repository });
  run('git', ['commit', '-m', 'initialize'], { cwd: repository });
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'payments',
    workspaceName: 'Payments',
    workspacePath: path.join(root, 'workspace'),
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
  assert.equal(JSON.parse(routed.stdout).status, 'missing',
    'the repository-scoped command ran against the selected workspace repository');
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
    (error) => error?.code === 'WORKSPACE_CAPABILITY_UNKNOWN'
  );
  assert.equal(await readFile(manifestFile, 'utf8'), before,
    'an invalid capability edit must preserve the last approved manifest exactly');
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
  assert.equal(saved.status.warnings[0].code, 'world-model-missing');
  assert.match(saved.status.warnings[0].message, /No repository world model was found/);
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
  assert.notEqual(created.status.repositories[0].absolutePath, created.status.repositories[1].absolutePath);
  const loaded = await readWorkspace(created.workspace.path);
  assert.equal(loaded.anchor.issueTypeName, 'Business Initiative');
  assert.equal(loaded.localOnly, true);
  assert.deepEqual(loaded.repositories.platform.metadata, { appId: 'APP-PLATFORM', name: 'Shared platform' });
  assert.deepEqual(loaded.repositories.mobile.metadata, { appId: 'APP-MOBILE', owner: 'Digital' });

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
});
