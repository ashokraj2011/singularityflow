import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) {
  return run('git', args, root).stdout.trim();
}

function isolatedMachine(base) {
  return {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'no-active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'no-workspace-registry.json')
  };
}

async function applicationRepository(base) {
  const root = path.join(base, 'repos', 'application');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Workspace Init Tester');
  git(root, 'config', 'user.email', 'workspace-init@example.com');
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'application main');
  return root;
}

async function approvedConfigurationRemote(base) {
  const source = path.join(base, 'configuration-source');
  const remote = path.join(base, 'configuration.git');
  await mkdir(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'Configuration Authority Tester');
  git(source, 'config', 'user.email', 'configuration-authority@example.com');
  await writeFile(path.join(source, 'README.md'), '# Authority\n');
  git(source, 'add', 'README.md');
  git(source, 'commit', '-m', 'authority main');
  git(source, 'switch', '-c', 'sflow/config');
  run(process.execPath, [cli, 'init'], source, { env: isolatedMachine(base) });
  git(source, 'add', '.github', 'singularity');
  git(source, 'commit', '-m', 'approved configuration');
  git(base, 'init', '--bare', remote);
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', 'origin', 'main', 'sflow/config');
  return remote;
}

async function stateOnlyRemote(base, { marked = false } = {}) {
  const source = path.join(base, marked ? 'marked-state-source' : 'generic-state-source');
  const remote = path.join(base, marked ? 'marked-state.git' : 'generic-state.git');
  await mkdir(source);
  git(source, 'init', '-b', 'state');
  git(source, 'config', 'user.name', 'State Branch Tester');
  git(source, 'config', 'user.email', 'state-branch@example.com');
  await writeFile(path.join(source, 'README.md'), '# Application state\n');
  if (marked) {
    await mkdir(path.join(source, 'configuration'), { recursive: true });
    await writeFile(path.join(source, 'configuration/manifest.json'), '{"format":"broken"}\n');
  }
  git(source, 'add', '-A');
  git(source, 'commit', '-m', marked ? 'corrupt marked mirror' : 'ordinary application state');
  git(base, 'clone', '--bare', source, remote);
  return remote;
}

async function workspaceEnvironment(base, root, capabilityAuthority, {
  repositoryRemote = capabilityAuthority,
  leadRepositoryRemote = null
} = {}) {
  if (!git(root, 'remote').split(/\r?\n/).filter(Boolean).includes('origin')) {
    git(root, 'remote', 'add', 'origin', repositoryRemote);
  }
  const leadRepository = leadRepositoryRemote ? 'lead' : 'application';
  const workspace = {
    version: 1,
    id: 'local--init-authority',
    name: 'Initialization Authority',
    anchor: {
      provider: 'workspace', siteId: 'local', key: 'init-authority', title: 'Initialization Authority'
    },
    leadRepository,
    capabilityAuthority: capabilityAuthority ? { url: capabilityAuthority } : null,
    repositories: {
      application: {
        id: 'application', url: repositoryRemote, defaultBranch: 'main', required: true,
        path: 'repos/application', capabilities: [],
        clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
      },
      ...(leadRepositoryRemote ? {
        lead: {
          id: 'lead', url: leadRepositoryRemote, defaultBranch: 'main', required: true,
          path: 'repos/lead', capabilities: [],
          clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
        }
      } : {})
    },
    capabilities: [],
    directories: {
      repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira'
    },
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
  await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: base,
    anchorKey: workspace.anchor.key,
    repositoryId: 'application',
    repositoryPath: root,
    canonicalRepositoryPath: root,
    checkoutPath: root,
    repositoryState: 'ready',
    branch: 'main',
    capabilities: [],
    repositoryCapabilities: [],
    storyId: null,
    selectedAt: '2026-08-31T00:00:00.000Z'
  }, null, 2)}\n`);
  await writeFile(registry, `${JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2)}\n`);
  return {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry
  };
}

test('init can bootstrap configuration on a Work-ID branch without changing main', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-work-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Bootstrap Tester');
  git(root, 'config', 'user.email', 'branch-bootstrap@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  const mainBefore = git(root, 'rev-parse', 'main');

  const initialized = run(process.execPath, [
    cli, 'init', '--work-id', 'WORK-123', '--base', 'main'
  ], root);

  assert.equal(git(root, 'branch', '--show-current'), 'WORK-123');
  assert.equal(git(root, 'rev-parse', 'main'), mainBefore);
  assert.equal(git(root, 'rev-parse', 'WORK-123'), mainBefore);
  assert.match(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), /defaultBaseBranch: main/);
  assert.match(initialized.stdout, /Initialized Singularity Flow on Work-ID branch WORK-123/);
  assert.match(initialized.stdout, /base branch was not modified/);
  assert.match(initialized.stdout, /singularity-flow start WORK-123/);
});

test('branch-local init refuses to carry uncommitted changes to the Work-ID branch', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-dirty-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Bootstrap Tester');
  git(root, 'config', 'user.email', 'branch-bootstrap@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(root, 'uncommitted.txt'), 'do not carry me\n');

  const result = spawnSync(process.execPath, [
    cli, 'init', '--work-id', 'WORK-124', '--base', 'main'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Working tree is not clean/);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('init check finds missing assets and repair restores them without overwriting custom files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-repair-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Branch Repair Tester');
  git(root, 'config', 'user.email', 'branch-repair@example.com');
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'initial');
  run(process.execPath, [cli, 'init', '--work-id', 'WORK-REPAIR', '--base', 'main'], root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const customizedWorkflow = `${await readFile(workflowPath, 'utf8')}\n# company customization remains\n`;
  await writeFile(workflowPath, customizedWorkflow);
  await rm(path.join(root, '.github/agents/qa.agent.md'));
  await rm(path.join(root, 'singularity/prompts/copilot-planning.md'));

  const before = JSON.parse(run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout);
  assert.equal(before.complete, false);
  assert.ok(before.missingFiles.includes('.github/agents/qa.agent.md'));
  assert.ok(before.missingFiles.includes('singularity/prompts/copilot-planning.md'));

  const repaired = run(process.execPath, [cli, 'init', '--repair'], root);
  assert.match(repaired.stdout, /Repaired/);
  const after = JSON.parse(run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout);
  assert.equal(after.complete, true);
  assert.equal(after.missingFiles.length, 0);
  assert.equal(await readFile(workflowPath, 'utf8'), customizedWorkflow);
  assert.match(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), /\S/);
  assert.match(await readFile(path.join(root, 'singularity/prompts/copilot-planning.md'), 'utf8'), /\S/);
});

test('init never installs generic branch configuration when approved authority already exists', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  const remote = path.join(base, 'remote.git');
  await mkdir(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Authority Init Tester');
  git(root, 'config', 'user.email', 'authority-init@example.com');
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'application main');
  git(root, 'switch', '-c', 'sflow/config');
  run(process.execPath, [cli, 'init'], root);
  git(root, 'add', '.github', 'singularity');
  git(root, 'commit', '-m', 'approved configuration');
  const authorityBranchCheck = JSON.parse(
    run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout
  );
  assert.equal(authorityBranchCheck.complete, true);
  assert.equal(authorityBranchCheck.configurationMode, 'working-tree');
  assert.equal(authorityBranchCheck.authorityState, 'authoring-first-bootstrap');
  run(process.execPath, [cli, 'init', '--repair'], root);
  git(root, 'switch', 'main');
  git(base, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-u', 'origin', 'main', 'sflow/config');
  git(root, 'switch', 'sflow/config');
  const exactAuthorityHead = git(root, 'rev-parse', 'HEAD');
  await rm(path.join(root, '.github/agents/qa.agent.md'));
  const exactCheck = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env: isolatedMachine(base) }).stdout);
  assert.equal(exactCheck.complete, false);
  assert.equal(exactCheck.authorityState, 'authoring-exact');
  assert.equal(exactCheck.localAuthorityCommit, exactAuthorityHead);
  assert.equal(exactCheck.expectedAuthorityCommit, exactAuthorityHead);
  run(process.execPath, [cli, 'init', '--repair'], root, { env: isolatedMachine(base) });
  assert.match(await readFile(path.join(root, '.github/agents/qa.agent.md'), 'utf8'), /\S/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), exactAuthorityHead);
  git(root, 'switch', 'main');
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const checked = JSON.parse(run(process.execPath, [cli, 'init', '--check', '--json'], root).stdout);
  assert.equal(checked.complete, true);
  assert.equal(checked.configurationMode, 'approved-authority');
  assert.equal(checked.localMaterialized, false);
  assert.match(checked.authority.ref, /sflow\/config$/);

  for (const args of [
    ['init', '--repair'],
    ['init', '--work-id', 'WORK-MUST-NOT-EXIST', '--base', 'main']
  ]) {
    const refused = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /already governed by approved configuration/);
    assert.match(refused.stderr, /will not install generic configuration/);
  }
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(git(root, 'branch', '--list', 'WORK-MUST-NOT-EXIST'), '');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('init validates an external workspace capability authority from one retained snapshot', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-external-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = await approvedConfigurationRemote(base);
  const env = await workspaceEnvironment(base, root, authority);
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env }).stdout);
  assert.equal(checked.complete, true);
  assert.equal(checked.configurationMode, 'approved-authority');
  assert.equal(checked.authorityState, 'present');
  assert.equal(checked.authority.ref, 'sflow/config');
  assert.equal(checked.authority.commit, checked.authority.sourceCommit);
  assert.equal(checked.localMaterialized, false);
  assert.equal(checked.nextCommand, null);

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already governed by approved configuration sflow\/config/);
  assert.match(refused.stderr, /workspace refresh-configuration/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('init keeps an external workspace authority inside a linked Story worktree', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-linked-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = await approvedConfigurationRemote(base);
  const env = await workspaceEnvironment(base, root, authority);
  const linked = path.join(base, '.singularity-flow', 'story-worktrees', 'LINKED-INIT', 'repos', 'application');
  await mkdir(path.dirname(linked), { recursive: true });
  git(root, 'worktree', 'add', '-b', 'LINKED-INIT', linked, 'main');
  const beforeHead = git(linked, 'rev-parse', 'HEAD');
  const beforeStatus = git(linked, 'status', '--porcelain');

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], linked, { env }).stdout);
  assert.equal(checked.complete, true);
  assert.equal(checked.configurationMode, 'approved-authority');
  assert.equal(checked.authorityState, 'present');
  assert.equal(checked.authority.ref, 'sflow/config');
  assert.equal(checked.localMaterialized, false);

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: linked, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /already governed by approved configuration sflow\/config/);
  assert.equal(git(linked, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(linked, 'status', '--porcelain'), beforeStatus);
  await assert.rejects(readFile(path.join(linked, 'singularity/workflow.yml')), {
    code: 'ENOENT'
  });
});

test('init falls back to the external workspace lead when no capability authority is declared', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-lead-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = await approvedConfigurationRemote(base);
  const delivery = path.join(base, 'delivery.git');
  git(base, 'init', '--bare', delivery);
  const env = await workspaceEnvironment(base, root, null, {
    repositoryRemote: delivery,
    leadRepositoryRemote: authority
  });

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env }).stdout);
  assert.equal(checked.complete, true);
  assert.equal(checked.configurationMode, 'approved-authority');
  assert.equal(checked.authorityState, 'present');
  assert.equal(checked.authority.ref, 'sflow/config');
  assert.equal(checked.localMaterialized, false);
});

test('init never falls through an unreadable origin to a lower-priority workspace lead', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-origin-precedence-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const lead = await approvedConfigurationRemote(base);
  const missingOrigin = path.join(base, 'missing-origin.git');
  git(root, 'remote', 'add', 'origin', missingOrigin);
  const env = await workspaceEnvironment(base, root, null, {
    repositoryRemote: missingOrigin,
    leadRepositoryRemote: lead
  });
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cannot validate the configured Singularity Flow authority/);
  assert.match(refused.stderr, /Cannot reach Story configuration authority/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  await assert.rejects(readFile(path.join(root, 'singularity/workflow.yml')), { code: 'ENOENT' });
});

test('init propagates an unreadable matched workspace instead of trusting repository origin', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-unreadable-workspace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = await approvedConfigurationRemote(base);
  git(root, 'remote', 'add', 'origin', authority);
  const env = await workspaceEnvironment(base, root, authority);
  await writeFile(path.join(base, 'workspace.json'), '{not-json\n');
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cannot validate the configured Singularity Flow authority/);
  assert.match(refused.stderr, /workspace\.json/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  await assert.rejects(readFile(path.join(root, 'singularity/workflow.yml')), { code: 'ENOENT' });
});

test('init permits first bootstrap only after a configured authority positively reports no authority branches', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-empty-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = path.join(base, 'empty-authority.git');
  git(base, 'init', '--bare', authority);
  const env = await workspaceEnvironment(base, root, authority);

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env }).stdout);
  assert.equal(checked.configurationMode, 'working-tree');
  assert.equal(checked.authorityState, 'absent');
  assert.equal(checked.nextCommand, 'singularity-flow init --repair');

  const initialized = run(process.execPath, [
    cli, 'init', '--work-id', 'FIRST-INIT', '--base', 'main'
  ], root, { env });
  assert.match(initialized.stdout, /Initialized Singularity Flow on Work-ID branch FIRST-INIT/);
  assert.equal(git(root, 'branch', '--show-current'), 'FIRST-INIT');
  assert.match(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), /version: 2/);
});

test('init treats an unmarked application state branch as no SFlow authority', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-generic-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const remote = await stateOnlyRemote(base);
  git(root, 'remote', 'add', 'origin', remote);

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env: isolatedMachine(base) }).stdout);
  assert.equal(checked.authorityState, 'absent');
  assert.equal(checked.configurationMode, 'working-tree');
  assert.equal(checked.nextCommand, 'singularity-flow init --repair');
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('init refuses a corrupt state branch once the SFlow mirror marker exists', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-corrupt-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const remote = await stateOnlyRemote(base, { marked: true });
  git(root, 'remote', 'add', 'origin', remote);
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...isolatedMachine(base) }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cannot validate the configured Singularity Flow authority/);
  assert.match(refused.stderr, /State configuration manifest must be/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
});

test('init refuses an unreachable configured authority without changing Git or repository files', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-unreachable-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const env = await workspaceEnvironment(base, root, path.join(base, 'missing-authority.git'));
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [
    cli, 'init', '--work-id', 'MUST-NOT-EXIST', '--base', 'main'
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env } });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cannot validate the configured Singularity Flow authority/);
  assert.match(refused.stderr, /workspace refresh-configuration/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(git(root, 'branch', '--list', 'MUST-NOT-EXIST'), '');
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('init refuses an invalid configured authority without installing generic configuration', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-invalid-authority-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const source = path.join(base, 'invalid-authority-source');
  const authority = path.join(base, 'invalid-authority.git');
  await mkdir(path.join(source, 'singularity'), { recursive: true });
  git(source, 'init', '-b', 'sflow/config');
  git(source, 'config', 'user.name', 'Invalid Authority Tester');
  git(source, 'config', 'user.email', 'invalid-authority@example.com');
  await writeFile(path.join(source, 'singularity/workflow.yml'), 'version: 1\n');
  git(source, 'add', 'singularity/workflow.yml');
  git(source, 'commit', '-m', 'invalid configuration');
  git(base, 'init', '--bare', authority);
  git(source, 'remote', 'add', 'origin', authority);
  git(source, 'push', 'origin', 'sflow/config');
  const env = await workspaceEnvironment(base, root, authority);
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cannot validate the configured Singularity Flow authority/);
  assert.match(refused.stderr, /workflow.yml version must be 2/);
  assert.match(refused.stderr, /workspace refresh-configuration/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(git(root, 'branch', '--show-current'), 'main');
});

test('init refuses to repair a stale local sflow/config branch after its authority advances', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-stale-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  const remote = path.join(base, 'remote.git');
  const publisher = path.join(base, 'publisher');
  await mkdir(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Stale Configuration Tester');
  git(root, 'config', 'user.email', 'stale-configuration@example.com');
  await writeFile(path.join(root, 'README.md'), '# Stale configuration\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'main');
  git(root, 'switch', '-c', 'sflow/config');
  run(process.execPath, [cli, 'init'], root, { env: isolatedMachine(base) });
  git(root, 'add', '.github', 'singularity');
  git(root, 'commit', '-m', 'configuration revision one');
  const staleCommit = git(root, 'rev-parse', 'HEAD');
  git(base, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main', 'sflow/config');
  git(base, 'clone', '--branch', 'sflow/config', remote, publisher);
  git(publisher, 'config', 'user.name', 'Configuration Publisher');
  git(publisher, 'config', 'user.email', 'configuration-publisher@example.com');
  const publisherWorkflow = path.join(publisher, 'singularity/workflow.yml');
  await writeFile(publisherWorkflow, `${await readFile(publisherWorkflow, 'utf8')}\n# authority advanced\n`);
  git(publisher, 'add', 'singularity/workflow.yml');
  git(publisher, 'commit', '-m', 'advance configuration authority');
  git(publisher, 'push', 'origin', 'sflow/config');
  const authorityCommit = git(publisher, 'rev-parse', 'HEAD');
  await rm(path.join(root, '.github/agents/qa.agent.md'));
  const beforeStatus = git(root, 'status', '--porcelain');

  const checked = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], root, { env: isolatedMachine(base) }).stdout);
  assert.equal(checked.complete, false);
  assert.equal(checked.authorityState, 'authoring-mismatch');
  assert.equal(checked.localAuthorityCommit, staleCommit);
  assert.equal(checked.expectedAuthorityCommit, authorityCommit);
  assert.equal(checked.nextCommand, 'singularity-flow workspace refresh-configuration');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...isolatedMachine(base) }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not the exact configured authority revision/);
  assert.match(refused.stderr, /stale, orphaned, or unrelated local sflow\/config branch/);
  assert.match(refused.stderr, /Nothing was changed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), staleCommit);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  await assert.rejects(readFile(path.join(root, '.github/agents/qa.agent.md')), { code: 'ENOENT' });
});

test('init refuses an unrelated local sflow/config branch despite an existing workflow file', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-init-unrelated-config-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = await applicationRepository(base);
  const authority = await approvedConfigurationRemote(base);
  const env = await workspaceEnvironment(base, root, authority);
  git(root, 'switch', '-c', 'sflow/config');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\n');
  const unrelatedCommit = git(root, 'rev-parse', 'HEAD');
  const beforeStatus = git(root, 'status', '--porcelain');

  const refused = spawnSync(process.execPath, [cli, 'init', '--repair'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not the exact configured authority revision/);
  assert.match(refused.stderr, /stale, orphaned, or unrelated local sflow\/config branch/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), unrelatedCommit);
  assert.equal(git(root, 'status', '--porcelain'), beforeStatus);
  assert.equal(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'), 'version: 2\n');
  await assert.rejects(readFile(path.join(root, '.github/agents/qa.agent.md')), { code: 'ENOENT' });
});
