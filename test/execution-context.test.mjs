import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { captureExecutionContext, projectExecutionContext, executionContextArguments, surfaceContext,
  withExecutionContextScope, findWorkspaceMembership } from '../src/execution-context.mjs';
import { prepareWorkspaceBranch } from '../src/workspace-branch-checkout.mjs';
import { workspaceCheckoutInventory, planWorkspaceCheckoutCleanup, applyWorkspaceCheckoutCleanup } from '../src/workspace-checkout-inventory.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { withRepositoryMutationLease } from '../src/subject-lock.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (root, args) => {
  const value = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(value.status, 0, value.stderr); return value.stdout.trim();
};
async function fixture(t, { governed = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-execution-context-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace'), root = path.join(workspacePath, 'repos', 'app');
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Context Tester']); git(root, ['config', 'user.email', 'context@example.com']);
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Context Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'always' };
  const flow = (args, { cwd = root, environment = env, fail = false } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    if (!fail) assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return result;
  };
  await writeFile(path.join(root, 'README.md'), 'Shared context fixture\n');
  if (governed) {
    flow(['init']);
    const file = path.join(root, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    definition.git.publish = 'off'; definition.repositoryReadiness.requiredBeforeStory = false;
    definition.ledger.enabled = true;
    await writeFile(file, YAML.stringify(definition));
  }
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed']);
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-q', '-u', 'origin', 'main']);
  const workspace = { version: 1, id: 'context', name: 'Context',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    anchor: { provider: 'workspace', key: 'context', title: 'Context', fetchedAt: new Date().toISOString() },
    leadRepository: 'app', capabilities: [], repositories: { app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] } } };
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify(workspace));
  return { base, root, env, flow, remote, workspacePath, workspace: { ...workspace, path: workspacePath } };
}

test('global context selector strips exactly one absolute path and never treats trailing data as an option', () => {
  const root = path.resolve('a checkout');
  assert.deepEqual(executionContextArguments(['phase', 'show', '--context-root', root, '--json']), {
    argv: ['phase', 'show', '--json'], root });
  assert.deepEqual(executionContextArguments(['x', '--', '--context-root', root]).argv, ['x', '--', '--context-root', root]);
  for (const args of [['--context-root'], ['--context-root=x'], ['--context-root', root, '--context-root', root]]) {
    assert.throws(() => executionContextArguments(args), { code: 'EXECUTION_CONTEXT_BINDING_INVALID' });
  }
  assert.throws(() => surfaceContext({ SINGULARITY_FLOW_SURFACE_CONTEXT: '{}' }), { code: 'EXECUTION_CONTEXT_BINDING_INVALID' });
});

test('clones and worktrees have separate stable identities and branch is worktree-local', async t => {
  const f = await fixture(t);
  const linked = path.join(f.base, 'linked');
  git(f.root, ['worktree', 'add', '-q', '-b', 'story/custom', linked]);
  const a = await captureExecutionContext(f.root, { workspace: null });
  const b = await captureExecutionContext(linked, { workspace: null });
  assert.equal(a.clone.id, b.clone.id); assert.notEqual(a.worktree.id, b.worktree.id);
  assert.equal(a.worktree.branch, 'main'); assert.equal(b.worktree.branch, 'story/custom');
  assert.equal(b.observation.remoteStatus, 'not-checked'); assert.equal(b.observation.mutationAuthority, false);
  assert.ok(Object.isFrozen(b.worktree));
});

test('logical repository identity survives a second laptop clone while local clone identity differs', async t => {
  const f = await fixture(t), second = path.join(f.base, 'second');
  git(f.base, ['clone', '--no-local', '-q', f.remote, second]);
  const a = await captureExecutionContext(f.root, { workspace: null });
  const b = await captureExecutionContext(second, { workspace: null });
  assert.equal(a.repository.logicalId, b.repository.logicalId); assert.notEqual(a.clone.id, b.clone.id);
});

test('Story IDs, refs and laptop paths are independent and projection never authorizes a write', async t => {
  const f = await fixture(t), captured = await captureExecutionContext(f.root, { workspace: null });
  const pin = { commit: 'a'.repeat(40) };
  const projected = projectExecutionContext({ identity: { root: f.root, commonDir: captured.clone.commonDirectory,
    gitDir: captured.worktree.gitDirectory, repositoryInstanceId: captured.clone.id, worktreeInstanceId: captured.worktree.id,
    head: captured.worktree.head, branch: 'delivery/customer-change' },
    workflow: { workItem: { id: 'STORY-12', branch: 'delivery/customer-change' }, currentPhase: 'planning', status: 'in_progress' },
    configurationPin: pin, remote: f.remote });
  assert.equal(projected.story.id, 'STORY-12'); assert.equal(projected.story.binding.storyRef, 'delivery/customer-change');
  assert.equal(Object.isFrozen(pin), false); assert.equal(projected.observation.mutationAuthority, false);
});

test('invocation scopes coalesce reads but never share mutable observations between commands', async t => {
  const f = await fixture(t);
  await withExecutionContextScope(f.root, async () => {
    const a = await captureExecutionContext(f.root);
    assert.equal(await captureExecutionContext(f.root), a);
    git(f.root, ['switch', '-qc', 'next']);
    assert.equal((await captureExecutionContext(f.root, { fresh: true })).worktree.branch, 'next');
  });
  assert.equal((await captureExecutionContext(f.root)).worktree.branch, 'next');
});

test('membership resolves the actual workspace without changing the profile selection', async t => {
  const f = await fixture(t);
  const before = JSON.stringify({ unrelated: true }); await writeFile(f.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, before);
  const context = await findWorkspaceMembership(f.root, { workspacePath: f.workspacePath });
  assert.equal(context.workspaceId, 'context'); assert.equal(context.repositoryId, 'app');
  assert.equal(await readFile(f.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8'), before);
  git(f.root, ['remote', 'set-url', 'origin', path.join(f.base, 'other.git')]);
  await assert.rejects(findWorkspaceMembership(f.root, { workspacePath: f.workspacePath }), { code: 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH' });
});

test('an explicit workspace context needs neither registration nor a machine profile', async t => {
  const f = await fixture(t);
  const result = JSON.parse(f.flow(['workspace', 'context', f.workspacePath, '--json']).stdout);
  assert.equal(result.workspace.id, 'context');
  assert.equal(result.repository.id, 'app');
  assert.equal(result.worktree.path, await (await import('node:fs/promises')).realpath(f.root));
});

test('explicit shell and window contexts refuse missing locations instead of routing elsewhere', async t => {
  const f = await fixture(t);
  const missing = path.join(f.base, 'missing');
  const a = f.flow(['status', '--context-root', missing, '--json'], { fail: true });
  assert.notEqual(a.status, 0); assert.match(a.stdout, /EXECUTION_CONTEXT_ROOT_UNAVAILABLE/);
  const b = f.flow(['status', '--json'], { fail: true, environment: { ...f.env,
    SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: missing }) } });
  assert.notEqual(b.status, 0); assert.match(b.stdout, /EXECUTION_CONTEXT_ROOT_UNAVAILABLE/);
});

test('checkout inventory protects selected clones, private recovery and dependent Story worktrees', async t => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const second = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const linked = path.join(f.base, 'dependent');
  git(first.repositoryPath, ['worktree', 'add', '-q', '-b', 'Story', linked]);
  const inventory = await workspaceCheckoutInventory(f.workspacePath);
  assert.equal(inventory.clones.find(clone => clone.root === first.repositoryPath).cleanupEligible, false);
  assert.equal(inventory.clones.find(clone => clone.root === second.repositoryPath).current, true);
  git(first.repositoryPath, ['worktree', 'remove', linked]);
  await mkdir(path.join(first.repositoryPath, '.git', 'singularity-flow', 'pending-publication'), { recursive: true });
  const guarded = await workspaceCheckoutInventory(f.workspacePath);
  assert.equal(guarded.clones.find(clone => clone.root === first.repositoryPath).privateState, true);
});

test('cleanup binds the exact candidate and preserves edited or unpublished retries', async t => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const plan = await planWorkspaceCheckoutCleanup(f.workspacePath);
  assert.equal(plan.candidates.length, 1);
  await writeFile(path.join(first.repositoryPath, 'unpublished.txt'), 'keep me\n');
  await assert.rejects(applyWorkspaceCheckoutCleanup(f.workspacePath, plan.confirmation), { code: 'CHECKOUT_CLEANUP_STALE' });
  assert.equal(await readFile(path.join(first.repositoryPath, 'unpublished.txt'), 'utf8'), 'keep me\n');
});

test('cleanup preserves unpublished history and active operations, not just working-tree edits', async t => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  await withRepositoryMutationLease(first.repositoryPath, 'test.concurrent-writer', async () => {
    const plan = JSON.parse(f.flow(['workspace', 'cleanup', f.workspacePath, '--json']).stdout);
    assert.equal(plan.candidates.length, 0, 'another process cannot treat our live writer as its own');
    assert.ok(plan.preserved.some(item => item.path === first.repositoryPath && item.reason === 'private-or-recovery-state'));
  });
  git(first.repositoryPath, ['config', 'user.name', 'Local author']);
  git(first.repositoryPath, ['config', 'user.email', 'local@example.com']);
  await writeFile(path.join(first.repositoryPath, 'README.md'), 'Unpublished work\n');
  git(first.repositoryPath, ['commit', '-qam', 'unpublished']);
  const plan = await planWorkspaceCheckoutCleanup(f.workspacePath);
  assert.equal(plan.candidates.length, 0);
  assert.ok(plan.preserved.some(item => item.path === first.repositoryPath));
});

test('retirement and permanent cleanup require different exact previews and never drop selected clones', async t => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const selected = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const retire = await planWorkspaceCheckoutCleanup(f.workspacePath);
  const purge = await planWorkspaceCheckoutCleanup(f.workspacePath, { purge: true });
  assert.notEqual(retire.confirmation, purge.confirmation);
  await assert.rejects(applyWorkspaceCheckoutCleanup(f.workspacePath, retire.confirmation, { purge: true }), { code: 'CHECKOUT_CLEANUP_STALE' });
  const applied = await applyWorkspaceCheckoutCleanup(f.workspacePath, purge.confirmation, { purge: true });
  assert.equal(applied.retired[0].removed, true);
  await assert.rejects(lstat(first.repositoryPath), { code: 'ENOENT' });
  assert.ok(await lstat(selected.repositoryPath));
});

test('a window binding resolves its own workspace while another window changes the profile', async t => {
  const a = await fixture(t), b = await fixture(t);
  await rememberWorkspace(a.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(a.workspacePath));
  await rememberWorkspace(a.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(b.workspacePath));
  a.flow(['workspace', 'use', b.workspacePath, '--repository', 'app', '--json']);
  const before = await readFile(a.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8');
  const context = JSON.parse(a.flow(['workspace', 'current', '--json'], { environment: { ...a.env,
    SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: a.root }) } }).stdout);
  assert.equal(context.workspacePath, await (await import('node:fs/promises')).realpath(a.workspacePath));
  assert.equal(context.executionContext.worktree.head, git(a.root, ['rev-parse', 'HEAD']));
  assert.equal(await readFile(a.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'utf8'), before);
});

test('explicit takeover uses a published custom branch and returns the accepted context without approval', async t => {
  const f = await fixture(t, { governed: true });
  const started = JSON.parse(f.flow(['start', 'CTX-STORY', '--isolated-worktree', '--from-branch', 'main',
    '--ref', 'delivery/ctx-story', '--work-type', 'feature', '--title', 'Context takeover',
    '--description', 'Independent published Story takeover', '--json']).stdout);
  const source = (started.data ?? started).repositoryPath;
  git(source, ['push', '-q', '-u', 'origin', 'delivery/ctx-story']);
  const second = path.join(f.base, 'laptop-b'); git(f.base, ['clone', '--no-local', '-q', f.remote, second]);
  git(second, ['config', 'user.name', 'Second Contributor']); git(second, ['config', 'user.email', 'second@example.com']);
  const environment = { ...f.env, SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: second }) };
  const taken = JSON.parse(f.flow(['session', 'takeover', 'CTX-STORY', '--json'], { cwd: second, environment }).stdout);
  assert.equal(taken.ready, true); assert.equal(taken.executionContext.story.id, 'CTX-STORY');
  assert.equal(taken.executionContext.story.binding.storyRef, 'delivery/ctx-story');
  assert.equal(taken.effects.storyAdvanced, false); assert.equal(taken.effects.pushed, false);
  assert.equal(git(second, ['branch', '--show-current']), 'main');
  await rememberWorkspace(f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(f.workspacePath));
  f.flow(['workspace', 'use', f.workspacePath, '--repository', 'app', '--json']);
  const selectedLocal = JSON.parse(f.flow(['session', 'open', 'CTX-STORY', '--workspace', f.workspacePath,
    '--repository', 'app', '--json']).stdout);
  const fromCanonical = f.flow(['phase', 'enter', '--for-agent', '--json'], { cwd: f.root });
  assert.ok(fromCanonical.stdout.includes(JSON.stringify(selectedLocal.repositoryPath)),
    'a native Copilot launcher on main must still reach its explicitly selected Story');
  for (const args of [['session', 'current'], ['phase', 'enter'], ['nextsteps']]) {
    const entry = f.flow([...args, '--context-root', taken.repositoryPath, '--for-agent', '--json'], { cwd: f.root });
    assert.match(entry.stdout, /"workId"\s*:\s*"CTX-STORY"/, args.join(' '));
    assert.ok(entry.stdout.includes(JSON.stringify(taken.repositoryPath)), args.join(' '));
  }
  const hook = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(new URL('../src/copilot-repository-boundary.mjs', import.meta.url).href)}); console.log(await m.resolveCopilotDiscoveryRoot({cwd: process.argv[1]}));`,
    taken.repositoryPath], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout.trim(), taken.repositoryPath, 'Copilot hooks must not retarget this session to another window’s profile');
  const snapshot = JSON.parse(f.flow(['snapshot', '--include', 'executionContext', '--json'], { cwd: taken.repositoryPath }).stdout);
  assert.equal(snapshot.executionContext.clone.id, taken.executionContext.clone.id);
  const refreshed = JSON.parse(f.flow(['session', 'open', 'CTX-STORY', '--refresh', '--json'], { cwd: second, environment }).stdout);
  assert.equal(refreshed.attachedFromRemote, true);
  assert.equal(refreshed.localOnly, false);
  const again = JSON.parse(f.flow(['snapshot', '--include', 'executionContext', '--if-revision', snapshot.revision.subjectRevision, '--json'], { cwd: taken.repositoryPath }).stdout);
  assert.equal(again.notModified, true, 'timestamps must not invalidate a stable context snapshot');
});

test('branch downloads honor the approved partial and sparse clone policy', async t => {
  const f = await fixture(t);
  git(f.remote, ['config', 'uploadpack.allowFilter', 'true']);
  f.workspace.repositories.app.clone = { mode: 'blobless-sparse', sparseCone: ['src'], fallback: 'refuse' };
  const result = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  assert.equal(git(result.repositoryPath, ['config', '--get', 'remote.origin.promisor']), 'true');
  assert.equal(git(result.repositoryPath, ['config', '--get', 'remote.origin.partialclonefilter']), 'blob:none');
  assert.deepEqual(git(result.repositoryPath, ['sparse-checkout', 'list']).split(/\r?\n/u).sort(), ['.github/agents', 'singularity', 'src']);
});

test('takeover reports missing laptop-local evidence instead of claiming a complete handoff', async t => {
  const f = await fixture(t, { governed: true });
  const brief = path.join(f.base, 'brief.md'); await writeFile(brief, 'A local-only intake attachment\n');
  const started = JSON.parse(f.flow(['start', 'LOCAL-CONTEXT', '--isolated-worktree', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Local documents', '--document', brief, '--document-name', 'Local brief',
    '--document-store', 'local', '--json']).stdout);
  const source = (started.data ?? started).repositoryPath;
  git(source, ['push', '-q', '-u', 'origin', 'LOCAL-CONTEXT']);
  const second = path.join(f.base, 'second'); git(f.base, ['clone', '--no-local', '-q', f.remote, second]);
  git(second, ['config', 'user.name', 'Second Contributor']); git(second, ['config', 'user.email', 'second@example.com']);
  const taken = f.flow(['session', 'takeover', 'LOCAL-CONTEXT', '--json'], { cwd: second, fail: true,
    environment: { ...f.env, SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: second }) } });
  assert.notEqual(taken.status, 0);
  assert.match(taken.stdout, /STORY_TAKEOVER_EVIDENCE_UNAVAILABLE/);
  assert.match(taken.stdout, /completedRepositoryPaths/);
  assert.equal(git(second, ['branch', '--show-current']), 'main');
  assert.equal(await readFile(brief, 'utf8'), 'A local-only intake attachment\n');
});

test('takeover restores every required repository from the pinned capability without switching canonical clones', async t => {
  const f = await fixture(t, { governed: true });
  const apiRemote = path.join(f.base, 'api.git');
  git(f.base, ['init', '--bare', '-q', '-b', 'main', apiRemote]);
  const api = path.join(f.workspacePath, 'repos', 'api');
  git(f.base, ['clone', '--no-local', '-q', f.remote, api]);
  git(api, ['remote', 'set-url', 'origin', apiRemote]); git(api, ['push', '-q', '-u', 'origin', 'main']);
  const portfolioPath = path.join(f.root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = { app: { url: f.remote, defaultBranch: 'main', required: true },
    api: { url: apiRemote, defaultBranch: 'main', required: true } };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  const capabilitiesPath = path.join(f.root, 'singularity/capabilities.yml');
  const capabilities = { version: 1, capabilities: {
    enterprise: { kind: 'collection', parent: null, policy: {} },
    product: { kind: 'collection', parent: 'enterprise', policy: {} }
  } };
  capabilities.capabilities['context-delivery'] = { kind: 'delivery', parent: 'product', repositories: ['app', 'api'], policy: {} };
  await writeFile(capabilitiesPath, YAML.stringify(capabilities));
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'approved multi-repository configuration']);
  git(f.root, ['branch', 'sflow/config']); git(f.root, ['push', '-q', 'origin', 'main', 'sflow/config']);
  f.workspace.repositories.api = { url: apiRemote, path: 'repos/api', defaultBranch: 'main', required: true, capabilities: ['context-delivery'] };
  f.workspace.repositories.app.capabilities = ['context-delivery']; f.workspace.capabilities = ['context-delivery'];
  const { path: ignoredPath, ...manifest } = f.workspace;
  await writeFile(path.join(f.workspacePath, 'workspace.json'), JSON.stringify(manifest));
  await rememberWorkspace(f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(f.workspacePath));
  f.flow(['workspace', 'use', f.workspacePath, '--repository', 'app', '--json']);
  const started = JSON.parse(f.flow(['start', 'MULTI-CONTEXT', '--isolated-worktree', '--from-branch', 'main',
    '--capability', 'context-delivery', '--work-type', 'feature', '--title', 'Shared delivery', '--json']).stdout);
  const source = (started.data ?? started).repositoryPath;
  git(source, ['push', '-q', '-u', 'origin', 'MULTI-CONTEXT']);
  // Sibling delivery refs are published code, not duplicate lifecycle aggregates.
  git(api, ['branch', 'MULTI-CONTEXT']); git(api, ['push', '-q', 'origin', 'MULTI-CONTEXT']);
  const secondWorkspace = path.join(f.base, 'second-workspace'), second = path.join(secondWorkspace, 'repos', 'app');
  await mkdir(path.dirname(second), { recursive: true });
  git(f.base, ['clone', '--no-local', '-q', f.remote, second]);
  git(second, ['config', 'user.name', 'Second Contributor']); git(second, ['config', 'user.email', 'second@example.com']);
  await writeFile(path.join(secondWorkspace, 'workspace.json'), JSON.stringify(manifest));
  await rememberWorkspace(f.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(secondWorkspace));
  const taken = JSON.parse(f.flow(['session', 'takeover', 'MULTI-CONTEXT', '--workspace', secondWorkspace,
    '--repository', 'app', '--json'], { cwd: second, environment: { ...f.env,
      SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: second }) } }).stdout);
  assert.equal(taken.ready, true); assert.equal(taken.repositories.length, 2);
  assert.deepEqual(taken.repositories.map(context => context.repository.id), ['app', 'api']);
  assert.ok(taken.repositories.every(context => context.story.id === 'MULTI-CONTEXT'));
  assert.equal(git(second, ['branch', '--show-current']), 'main');
  assert.ok(taken.nextsteps);
});
