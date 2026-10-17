import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { storyBaseForRepository, preflightStoryRepositories, prepareCapabilityRepositories } from '../src/capability-start.mjs';
import { run } from '../src/util.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { prepareWorkspaceBranch } from '../src/workspace-branch-checkout.mjs';
import { BRANCH_CHECKOUT_RECORD, preparedWorkspaceBranch, workspaceBranchFolder,
  workspaceBranchMember, workspaceBranchPath } from '../src/workspace-branch-locations.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { activateWorkspaceContext, readActiveWorkspaceContext, workspaceMemberContextForRepository } from '../src/workspace-context.mjs';

const git = (cwd, ...args) => run('git', args, { cwd }).stdout.trim();
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-branch-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  const workspacePath = path.join(root, 'workspace');
  const original = path.join(workspacePath, 'repos', 'app');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--quiet', remote, source);
  git(source, 'config', 'user.email', 'fixture@example.com');
  git(source, 'config', 'user.name', 'Fixture');
  await writeFile(path.join(source, 'app.txt'), 'published application\n');
  git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'seed');
  git(source, 'branch', 'feature/topic');
  git(source, 'branch', 'unrelated');
  git(source, 'push', '--quiet', 'origin', 'main', 'feature/topic', 'unrelated');
  await mkdir(path.dirname(original), { recursive: true });
  git(root, 'clone', '--quiet', remote, original);
  const manifest = {
    version: 1, id: 'branch-download', name: 'Branch download',
    createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
    anchor: { provider: 'workspace', key: 'branch-download', title: 'Branch download', fetchedAt: '2026-10-17T00:00:00Z' },
    leadRepository: 'app', repositories: {
      app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] }
    }
  };
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify(manifest));
  const workspace = await readWorkspace(workspacePath);
  const registry = path.join(root, 'registry.json');
  const selection = path.join(root, 'selection.json');
  await rememberWorkspace(registry, workspace);
  await activateWorkspaceContext(registry, selection, workspace.id, { detectStory: false });
  return { root, remote, source, workspace, original, manifest, registry, selection };
}

test('branch folders are portable, readable and collision-safe without accepting ref patterns', () => {
  assert.match(workspaceBranchFolder('feature/topic'), /^feature-topic--[a-f0-9]{12}$/u);
  assert.notEqual(workspaceBranchFolder('feature/topic'), workspaceBranchFolder('feature-topic'));
  assert.notEqual(workspaceBranchFolder('MAIN'), workspaceBranchFolder('main'));
  assert.match(workspaceBranchFolder('CON'), /^CON--/u);
  for (const name of ['', null, '-main', '../main', 'refs/heads/*', 'main:other', 'a b']) {
    assert.throws(() => workspaceBranchFolder(name));
  }
  assert.throws(() => workspaceBranchPath('/workspace', '../outside', 'main'));
  assert.throws(() => workspaceBranchPath('/workspace', 'app', 'main', '/outside'));
});

test('fresh selected-branch download never reads old objects and keeps unpublished work', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.original, 'private-draft.txt'), 'retain this unpublished work');
  await rename(path.join(f.original, '.git/objects'), path.join(f.original, '.git/retained-objects'));
  await mkdir(path.join(f.original, '.git/objects'));
  const calls = [];
  const result = await prepareWorkspaceBranch(f.workspace, 'app', 'feature/topic', {
    runGit: async (args, options) => {
      assert.notEqual(options.cwd, f.original, 'no command may inspect the old object store');
      calls.push(args);
      return runRemoteGitAsync(args, options);
    }
  });
  assert.equal(result.originalPreserved, true);
  assert.equal(result.repositoryPath, workspaceBranchPath(f.workspace.path, 'app', 'feature/topic'));
  assert.equal(await readFile(path.join(f.original, 'private-draft.txt'), 'utf8'), 'retain this unpublished work');
  assert.equal(git(result.repositoryPath, 'rev-parse', 'HEAD'), git(f.source, 'rev-parse', 'HEAD'));
  assert.equal(git(result.repositoryPath, 'config', '--local', '--get', 'remote.origin.url'), f.remote);
  assert.equal(git(result.repositoryPath, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), 'refs/remotes/origin/feature/topic');
  assert.ok(calls.find(args => args[0] === 'ls-remote').includes('refs/heads/feature/topic'));
  const clone = calls.find(args => args[0] === 'clone');
  assert.ok(clone.includes('--no-local') && clone.includes('--single-branch'));
  assert.ok(!clone.some(arg => /reference|shared|dissociate/u.test(arg)));
  assert.equal((await preparedWorkspaceBranch(f.workspace, 'app', 'feature/topic')).repositoryPath, result.repositoryPath);
  await assert.rejects(readFile(path.join(result.repositoryPath, '.git/objects/info/alternates')), { code: 'ENOENT' });
});

test('fresh retry preserves even a completed checkout and selects a new independent attempt', async (t) => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  await writeFile(path.join(first.repositoryPath, 'private.txt'), 'preserve');
  const second = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  assert.notEqual(first.repositoryPath, second.repositoryPath);
  assert.match(second.repositoryPath, /--retry-[a-f0-9]{16}/u);
  assert.equal(await readFile(path.join(first.repositoryPath, 'private.txt'), 'utf8'), 'preserve');
  assert.equal((await preparedWorkspaceBranch(f.workspace, 'app', 'main')).repositoryPath, second.repositoryPath);
});

test('downloaded repositories and their linked Story worktrees remain manifest-bound workspace members', async (t) => {
  const f = await fixture(t);
  const oldStory = path.join(f.root, 'old-story');
  git(f.original, 'worktree', 'add', '--quiet', '-b', 'old-story', oldStory);
  const result = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const freshStory = path.join(f.root, 'fresh-story');
  git(result.repositoryPath, 'worktree', 'add', '--quiet', '-b', 'fresh-story', freshStory);
  // The original objects are intentionally unavailable, as in an offloaded repository.
  await rename(path.join(f.original, '.git/objects'), path.join(f.original, '.git/retained-objects'));
  await mkdir(path.join(f.original, '.git/objects'));
  for (const repository of [result.repositoryPath, freshStory]) {
    const member = await workspaceMemberContextForRepository(repository, f.selection, f.registry, { strict: true });
    assert.equal(member.repositoryId, 'app');
    assert.equal(member.canonicalRepositoryPath, result.repositoryPath);
    assert.equal(member.branchCheckout.branch, 'main');
    assert.equal(member.workspace.id, f.workspace.id);
  }
  for (const repository of [f.original, oldStory]) {
    const member = await workspaceMemberContextForRepository(repository, f.selection, f.registry, { strict: true });
    assert.equal(member.repositoryId, 'app');
    assert.equal(member.canonicalRepositoryPath, await realpath(f.original));
    assert.equal(member.branchCheckout, undefined);
  }
});

test('a changed manifest, receipt or alternate object store cannot register a branch location', async (t) => {
  const f = await fixture(t);
  const result = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const common = path.join(result.repositoryPath, '.git');
  const changed = structuredClone(f.workspace);
  changed.repositories.app.url = 'https://example.invalid/other.git';
  assert.equal(await workspaceBranchMember(common, changed), null);
  await writeFile(path.join(common, 'objects/info/alternates'), f.original);
  assert.equal(await workspaceBranchMember(common, f.workspace), null);
  await rm(path.join(common, 'objects/info/alternates'));
  const recordPath = path.join(common, BRANCH_CHECKOUT_RECORD);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  await writeFile(recordPath, JSON.stringify({ ...record, branch: 'other' }));
  assert.equal(await preparedWorkspaceBranch(f.workspace, 'app', 'main'), null);
});

test('capability readiness uses fresh checkouts for every required repository, not old sibling objects', async (t) => {
  const f = await fixture(t);
  f.manifest.repositories.app.capabilities = ['payments'];
  f.manifest.repositories.sibling = { ...f.manifest.repositories.app, path: 'repos/sibling' };
  await writeFile(path.join(f.workspace.path, 'workspace.json'), JSON.stringify(f.manifest));
  const workspace = await readWorkspace(f.workspace.path);
  const app = await prepareWorkspaceBranch(workspace, 'app', 'main');
  const sibling = await prepareWorkspaceBranch(workspace, 'sibling', 'main');
  const names = { SINGULARITY_FLOW_ACTIVE_WORKSPACE: f.selection, SINGULARITY_FLOW_WORKSPACE_REGISTRY: f.registry };
  for (const [name, value] of Object.entries(names)) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const base = await storyBaseForRepository(app.repositoryPath, {
    values: ['main'], interactive: false, deferCapabilityAuthority: true
  });
  assert.equal(base.scope, 'capability');
  const calls = [];
  const result = await preflightStoryRepositories(workspace.path, base.plan, 'CAP-FRESH', {
    publishRequired: false, lifecycleRoot: app.repositoryPath, capabilityId: null,
    runGit: async (args, options) => {
      calls.push(options.cwd);
      assert.ok([app.repositoryPath, sibling.repositoryPath].includes(options.cwd));
      return runRemoteGitAsync(args, options);
    }
  });
  assert.deepEqual(new Set(result.map(entry => entry.root)), new Set([app.repositoryPath, sibling.repositoryPath]));
  assert.ok(calls.includes(sibling.repositoryPath), 'the sibling is fetched only in its independent checkout');
  const newerApp = await prepareWorkspaceBranch(workspace, 'app', 'main');
  const newerSibling = await prepareWorkspaceBranch(workspace, 'sibling', 'main');
  const prepared = await prepareCapabilityRepositories(workspace.path, base.plan, 'CAP-FRESH', {
    lifecycleRoot: app.repositoryPath, fetched: true
  });
  assert.deepEqual(new Set(prepared.map(entry => entry.target)), new Set([app.repositoryPath, sibling.repositoryPath]));
  assert.equal(git(newerApp.repositoryPath, 'branch', '--show-current'), 'main');
  assert.equal(git(newerSibling.repositoryPath, 'branch', '--show-current'), 'main');
  assert.equal(git(sibling.repositoryPath, 'branch', '--show-current'), 'CAP-FRESH');
});

test('symlink parents and cancelled downloads cannot write outside the owned workspace', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.dirname(workspaceBranchPath(f.workspace.path, 'app', 'main')), 'junction');
  await assert.rejects(prepareWorkspaceBranch(f.workspace, 'app', 'main'), { code: 'WORKSPACE_BRANCH_PATH_UNSAFE' });
  assert.deepEqual(await readdir(outside), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareWorkspaceBranch(f.workspace, 'app', 'feature/topic', {
    signal: controller.signal, runGit() { throw new Error('cancelled download must not spawn Git'); }
  }), /cancelled/u);
});

test('timeouts and moved branches preserve partial downloads but never issue a ready pointer', async (t) => {
  const f = await fixture(t);
  for (const mode of ['timeout', 'moved']) {
    let target;
    await assert.rejects(prepareWorkspaceBranch(f.workspace, 'app', 'main', {
      runGit: async (args, options) => {
        if (args[0] === 'clone') {
          target = args.at(-1);
          if (mode === 'timeout') return { status: null, failure: { code: 'GIT_OPERATION_TIMEOUT', advice: 'The operation timed out.' } };
        }
        if (mode === 'moved' && args[0] === 'rev-parse') return { status: 0, stdout: `${'0'.repeat(40)}\n`, stderr: '' };
        return runRemoteGitAsync(args, options);
      }
    }), mode === 'timeout' ? { code: 'GIT_OPERATION_TIMEOUT' } : { code: 'STORY_BASE_INVALID' });
    assert.ok(target);
    assert.ok(Array.isArray(await readdir(target)), 'partial download is retained');
    assert.equal(await preparedWorkspaceBranch(f.workspace, 'app', 'main'), null);
    assert.equal(await readFile(path.join(f.original, 'app.txt'), 'utf8'), 'published application\n');
  }
});

test('workspace prepare-branch is available from the narrow CLI without an old object read', async (t) => {
  const f = await fixture(t);
  const oldStory = path.join(f.root, 'old-story');
  git(f.original, 'worktree', 'add', '--quiet', '-b', 'old-story', oldStory);
  const selected = JSON.parse(await readFile(f.selection, 'utf8'));
  await writeFile(f.selection, JSON.stringify({ ...selected, repositoryPath: oldStory, checkoutPath: oldStory }));
  await rename(path.join(f.original, '.git/objects'), path.join(f.original, '.git/retained-objects'));
  await mkdir(path.join(f.original, '.git/objects'));
  const execution = spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'),
    'workspace', 'prepare-branch', '--repository', 'app', '--repository-path', oldStory, '--from-branch', 'main', '--json'], {
    cwd: f.workspace.path, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, SINGULARITY_FLOW_ACTIVE_WORKSPACE: f.selection, SINGULARITY_FLOW_WORKSPACE_REGISTRY: f.registry }
  });
  assert.equal(execution.status, 0, execution.stderr || execution.stdout);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.status, 'ready');
  assert.equal(result.originalPreserved, true);
  assert.equal(result.repositories.length, 1);
  assert.ok(result.repositoryPath.startsWith(path.join(f.workspace.path, 'repos', workspaceBranchFolder('main'))));
});

test('recovered checkout passes governed readiness, creates a Story and retains its workspace selection', async (t) => {
  const f = await fixture(t);
  await initializeDefinition(f.source);
  const workflowFile = path.join(f.source, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  definition.worldModel.grounding = 'off';
  definition.repositoryReadiness.requiredBeforeStory = false;
  for (const authority of Object.values(definition.approvalAuthorities ?? {})) {
    authority.members = [{ name: 'Fixture', email: 'fixture@example.com' }];
  }
  await writeFile(workflowFile, YAML.stringify(definition));
  git(f.source, 'add', '.'); git(f.source, 'commit', '--quiet', '-m', 'governed configuration');
  git(f.source, 'push', '--quiet', 'origin', 'main', 'main:refs/heads/sflow/config');
  const result = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  git(result.repositoryPath, 'config', 'user.email', 'fixture@example.com');
  git(result.repositoryPath, 'config', 'user.name', 'Fixture');
  await writeFile(path.join(f.original, 'private-draft.txt'), 'preserve unpublished work');
  await rename(path.join(f.original, '.git/objects'), path.join(f.original, '.git/retained-objects'));
  await mkdir(path.join(f.original, '.git/objects'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Fixture',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: f.selection, SINGULARITY_FLOW_WORKSPACE_REGISTRY: f.registry,
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(f.root, 'leads.json') };
  const cli = (args) => {
    const executed = spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'), ...args], {
      cwd: result.repositoryPath, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024
    });
    assert.equal(executed.status, 0, executed.stderr || executed.stdout);
    return JSON.parse(executed.stdout);
  };
  const preflight = cli(['workspace', 'branches', '--intake', '--preflight-story', 'FRESH-STORY',
    '--from-branch', 'main', '--work-type', 'feature', '--selected-base-only', '--mint-intake-receipt', '--json']);
  assert.equal(preflight.preflight.passed, true, JSON.stringify(preflight.preflight));
  const started = cli(['start', 'FRESH-STORY', '--isolated-worktree', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Fresh local Story', '--description', 'Independent object recovery', '--json']);
  const payload = started.data ?? started;
  assert.ok(payload.repositoryPath);
  assert.notEqual(payload.repositoryPath, result.repositoryPath);
  const selected = await readActiveWorkspaceContext(f.selection, f.registry);
  assert.equal(selected.selectionStatus, 'ready');
  assert.equal(selected.storyId, 'FRESH-STORY');
  assert.equal(selected.canonicalRepositoryPath, result.repositoryPath);
  assert.equal(selected.branchCheckout.branch, 'main');
  const old = await workspaceMemberContextForRepository(f.original, f.selection, f.registry, { strict: true });
  assert.equal(old.branchCheckout, undefined, 'the active fresh selection must not reclassify old workspace members');
  assert.equal(await readFile(path.join(f.original, 'private-draft.txt'), 'utf8'), 'preserve unpublished work');
});
