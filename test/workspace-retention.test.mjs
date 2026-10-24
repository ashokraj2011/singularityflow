import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { DEFAULT_WORKSPACE_RETENTION, normalizeWorkspaceRetention, workspaceRetentionSettings,
  saveWorkspaceRetention, runWorkspaceRetention, terminalRetentionTimestamp, touchWorkspaceCheckout, retentionWorktreePage } from '../src/workspace-retention.mjs';
import { prepareWorkspaceBranch } from '../src/workspace-branch-checkout.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { withRepositoryMutationLease } from '../src/subject-lock.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (root, args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.longpaths=true', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-retention-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace'), root = path.join(workspacePath, 'repos', 'app');
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'Retention Tester']);
  git(root, ['config', 'user.email', 'retention@example.com']);
  // Keep the safety proof's raw-byte fixture stable under Git for Windows autocrlf=true.
  await writeFile(path.join(root, '.gitattributes'), '* text eol=lf\n');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Retention Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json') };
  const flow = (args, { cwd = root, fail = false } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(120000), maxBuffer: 32 * 1024 * 1024 });
    if (!fail) assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return result;
  };
  flow(['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed']);
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-q', '-u', 'origin', 'main']);
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'retention', name: 'Retention',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), anchor: { provider: 'workspace', key: 'retention', title: 'Retention', fetchedAt: new Date().toISOString() },
    leadRepository: 'app', capabilities: [], repositories: { app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] } } }));
  const workspace = await readWorkspace(workspacePath);
  await rememberWorkspace(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, workspace);
  // The library proof consults the same isolated profile as its CLI child.
  const previous = Object.fromEntries(Object.keys(env).filter(key => key.startsWith('SINGULARITY_FLOW_')).map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = env[key];
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const story = async (id, { cancel = true, publish = true } = {}) => {
    const started = JSON.parse(flow(['start', id, '--isolated-worktree', '--from-branch', 'main', '--ref', `delivery/${id.toLowerCase()}`,
      '--work-type', 'feature', '--title', 'Retention', '--description', 'Terminal Story cleanup fixture', '--json']).stdout);
    const target = (started.data ?? started).repositoryPath;
    if (cancel) flow(['cancel', '--reason', 'Cleanup qualification', '--confirm', id, '--json'], { cwd: target });
    if (publish) git(target, ['push', '-q', '-u', 'origin', `delivery/${id.toLowerCase()}`]);
    return target;
  };
  return { base, root, workspacePath, workspace, remote, flow, story };
}

test('retention settings are bounded, separately configurable and disable malformed preferences', async t => {
  assert.deepEqual(normalizeWorkspaceRetention(), DEFAULT_WORKSPACE_RETENTION);
  for (const value of [{ enabled: 'yes' }, { completedDays: -1 }, { cancelledDays: 1.1 }, { unusedCloneDays: Infinity }, { intervalMinutes: 0 }, { unknown: true }]) {
    assert.throws(() => normalizeWorkspaceRetention(value), { code: 'WORKSPACE_RETENTION_SETTINGS_INVALID' });
  }
  const f = await fixture(t);
  await saveWorkspaceRetention(f.workspacePath, { enabled: false, completedDays: 31 });
  assert.equal((await runWorkspaceRetention(f.workspacePath)).status, 'disabled');
  assert.equal((await workspaceRetentionSettings(f.workspacePath)).completedDays, 31);
  await writeFile(path.join(f.workspacePath, '.singularity-flow/retention-policy.json'), '{bad');
  await assert.rejects(() => runWorkspaceRetention(f.workspacePath), /Unreadable/);
});

test('terminal timestamps distinguish approved completion, cancellation and nonterminal state', () => {
  assert.equal(terminalRetentionTimestamp({ status: 'cancelled', cancellation: { cancelledAt: '2026-01-01T00:00:00Z' } }), Date.parse('2026-01-01'));
  assert.equal(terminalRetentionTimestamp({ status: 'closed', phases: { a: { approvedAt: '2026-01-02T00:00:00Z' }, b: { approvedAt: '2026-01-03T00:00:00Z' } } }), Date.parse('2026-01-03'));
  assert.ok(Number.isNaN(terminalRetentionTimestamp({ status: 'in_progress' })));
});

test('bounded maintenance rotates past protected entries instead of starving later worktrees', () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({ entry: { path: `checkout-${String(index).padStart(3, '0')}` } }));
  const first = retentionWorktreePage(entries), second = retentionWorktreePage(entries, first.at(-1).entry.path);
  assert.equal(first.length, 128); assert.equal(second[0].entry.path, 'checkout-128');
  const third = retentionWorktreePage(entries, second.at(-1).entry.path);
  assert.equal(third[0].entry.path, 'checkout-256'); assert.ok(third.some(item => item.entry.path === 'checkout-000'));
});

test('published completed lifecycle fixtures use completion retention, not cancellation retention', slowLane({ timeout: 180000 }), async t => {
  const f = await fixture(t), target = await f.story('COMPLETE', { cancel: false });
  // Isolated lifecycle fixture: no real user approval or Story is changed by qualification.
  const { loadAcceptedStoryExecution } = await import('../src/accepted-story-execution.mjs');
  const { saveStoryDraft } = await import('../src/state-stores.mjs');
  const { withReadScope } = await import('../src/read-scope.mjs');
  const loaded = await withReadScope(() => loadAcceptedStoryExecution(target, 'COMPLETE'));
  const workflow = loaded.workflow;
  for (const phase of Object.values(workflow.phases)) { phase.status = 'approved'; phase.approvedAt = new Date().toISOString(); }
  workflow.status = 'closed'; workflow.currentPhase = null;
  await saveStoryDraft(target, loaded.definition, workflow);
  git(target, ['add', '.']); git(target, ['commit', '-qm', 'completed lifecycle fixture']); git(target, ['push', '-q', 'origin', 'delivery/complete']);
  await saveWorkspaceRetention(f.workspacePath, { completedDays: 0, cancelledDays: 99 });
  const result = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.ok(result.removed.some(item => item.root === target && item.status === 'closed'), JSON.stringify(result));
});

test('automatic retention removes only the published cancelled worktree after retention, keeping its branch and source clone', slowLane({ timeout: 180000 }), async t => {
  const f = await fixture(t), target = await f.story('RETIRE');
  const early = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.equal(early.removed.length, 0);
  const late = await runWorkspaceRetention(f.workspacePath, { force: true, now: Date.now() + 8 * 86400000 });
  assert.ok(late.removed.some(item => item.root === target), JSON.stringify(late));
  const archived = late.removed.find(item => item.root === target).retainedMetadata;
  assert.ok(archived); assert.ok(await readFile(path.join(archived, 'session.json')));
  assert.equal(await lstat(target).catch(() => null), null);
  assert.ok(git(f.root, ['rev-parse', 'refs/heads/delivery/retire']));
  assert.ok(await lstat(f.root));
  assert.equal((await runWorkspaceRetention(f.workspacePath, { now: Date.now() + 8 * 86400000 })).status, 'not-due');
});

test('unpushed, active, dirty, ignored, recovery and open-window Story worktrees are preserved', slowLane({ timeout: 240000 }), async t => {
  const f = await fixture(t), target = await f.story('PROTECT');
  await saveWorkspaceRetention(f.workspacePath, { cancelledDays: 0 });
  const check = async reason => {
    const result = await runWorkspaceRetention(f.workspacePath, { force: true });
    assert.equal(result.removed.length, 0, `${reason}: ${JSON.stringify(result)}`); assert.ok(await lstat(target));
  };
  await writeFile(path.join(target, 'draft.txt'), 'uncommitted'); await check('untracked'); await rm(path.join(target, 'draft.txt'));
  const tracked = path.join(target, '.gitattributes'), original = await readFile(tracked, 'utf8');
  await writeFile(tracked, original.replaceAll('\n', '\r\n')); await check('retained line-ending bytes');
  await writeFile(tracked, original);
  const privateGit = git(target, ['rev-parse', '--absolute-git-dir']);
  await mkdir(path.join(privateGit, 'singularity-flow/recovery'), { recursive: true }); await check('recovery');
  await rm(path.join(privateGit, 'singularity-flow/recovery'), { recursive: true });
  const common = git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  await mkdir(path.join(common, 'singularity-flow/pending-publication'), { recursive: true });
  await writeFile(path.join(common, 'singularity-flow/pending-publication/retained.json'), 'recovery'); await check('shared recovery');
  await rm(path.join(common, 'singularity-flow/pending-publication/retained.json'));
  await writeFile(path.join(target, '.gitignore'), 'scratch/\n'); git(target, ['add', '.']); git(target, ['commit', '-qm', 'ignore fixture']);
  git(target, ['push', '-q', 'origin', 'delivery/protect']);
  await mkdir(path.join(target, 'scratch')); await writeFile(path.join(target, 'scratch/notes'), 'ignored but valuable'); await check('ignored');
  await rm(path.join(target, 'scratch'), { recursive: true });
  await touchWorkspaceCheckout(f.workspacePath, target, { surface: 'open-window', pid: process.pid }); await check('open-window');
  await rm(path.join(f.workspacePath, '.singularity-flow/checkout-presence/open-window.json'));
  await withRepositoryMutationLease(f.root, 'test.foreign', async () => {
    // Same process knows this lease; a raw writer lock still protects an unrelated operation.
    await writeFile(path.join(privateGit, 'index.lock'), 'busy'); await check('writer'); await rm(path.join(privateGit, 'index.lock'));
  });
  await writeFile(path.join(target, 'local.txt'), 'not pushed'); git(target, ['add', '.']); git(target, ['commit', '-qm', 'private']); await check('unpushed');
  // Reset away, that commit survives only in this worktree's own HEAD reflog, which still protects it.
  git(target, ['reset', '-q', '--hard', 'HEAD~1']);
  await rm(path.join(privateGit, 'COMMIT_EDITMSG'), { force: true });
  const reflogged = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.ok(reflogged.preserved.some(item => item.message === 'Private reflog retains unpublished history.'), JSON.stringify(reflogged));
  assert.ok(await lstat(target));
  const active = await f.story('ACTIVE', { cancel: false });
  await check('nonterminal'); assert.ok(await lstat(active));
});

test('CLI policy updates and automatic run are distinct from manual deletion confirmation', async t => {
  const f = await fixture(t);
  const settings = JSON.parse(f.flow(['workspace', 'retention', f.workspacePath, '--enabled', 'false', '--completed-days', '21', '--json']).stdout);
  assert.equal(settings.settings.completedDays, 21);
  const result = JSON.parse(f.flow(['workspace', 'cleanup', f.workspacePath, '--automatic', '--json']).stdout);
  assert.equal(result.status, 'disabled');
  assert.notEqual(f.flow(['workspace', 'retention', f.workspacePath, '--completed-days', '', '--json'], { fail: true }).status, 0);
  assert.notEqual(f.flow(['workspace', 'cleanup', f.workspacePath, '--automatic', '--purge', '--json'], { fail: true }).status, 0);
  assert.notEqual(f.flow(['workspace', 'cleanup', f.workspacePath, '--automatic', '--enabled', 'false', '--json'], { fail: true }).status, 0);
  assert.notEqual(f.flow(['workspace', 'retention', f.workspacePath, '--heartbeat', '--enabled', 'false', '--json'], { fail: true }).status, 0);
});

test('background worker finishes independently and repeat foreground launches are throttled', slowLane({ timeout: 120000 }), async t => {
  const f = await fixture(t);
  const { scheduleWorkspaceRetention } = await import('../src/workspace-retention-background.mjs');
  const options = { protect: [f.root], env: { ...process.env, NODE_ENV: 'production', SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'on' } };
  assert.equal(await scheduleWorkspaceRetention(f.workspacePath, options), true);
  const file = path.join(f.workspacePath, '.singularity-flow/cleanup-state.json');
  const deadline = Date.now() + 90000;
  let result, leased = true;
  // Done means the journal says completed and the worker has released its lease: after that it
  // writes nothing, so removing the fixture cannot race its last file operations.
  while (Date.now() < deadline) {
    result = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    leased = await lstat(`${file}.lock`).then(() => true, () => false);
    if (result?.status === 'completed' && !leased) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result?.status, 'completed');
  assert.equal(leased, false, 'the worker released its maintenance lease');
  assert.equal(await scheduleWorkspaceRetention(f.workspacePath, options), false);
});

test('the background worker refuses to start without a valid launch packet', async t => {
  const { RETENTION_WORKER_PACKET } = await import('../src/workspace-retention-background.mjs');
  const worker = fileURLToPath(new URL('../src/workspace-retention-worker.mjs', import.meta.url));
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-retention-packet-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const packet of [undefined, '{bad', JSON.stringify({ workspacePath: 'relative', protect: [] }),
    JSON.stringify({ workspacePath: base, protect: ['relative'] }),
    JSON.stringify({ workspacePath: base, protect: Array.from({ length: 33 }, (_, index) => path.join(base, String(index))) })]) {
    const env = { ...process.env };
    if (packet === undefined) delete env[RETENTION_WORKER_PACKET]; else env[RETENTION_WORKER_PACKET] = packet;
    const result = spawnSync(process.execPath, [worker], { cwd: base, env, encoding: 'utf8', timeout: childTimeout(30000) });
    assert.equal(result.status, 1, `${packet}: ${result.stderr}`);
  }
  assert.deepEqual(await readdir(base), [], 'a refused launch writes nothing');
});

test('unused superseded clones have their own retention clock and selected clones survive', slowLane({ timeout: 180000 }), async t => {
  const f = await fixture(t);
  const first = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  git(first.repositoryPath, ['config', 'user.name', 'Retention Tester']); git(first.repositoryPath, ['config', 'user.email', 'retention@example.com']);
  const selected = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const early = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.equal(early.removed.length, 0);
  const late = await runWorkspaceRetention(f.workspacePath, { force: true, now: Date.now() + 8 * 86400000 });
  assert.ok(late.removed.some(item => item.from === first.repositoryPath), JSON.stringify(late));
  assert.ok(await lstat(selected.repositoryPath));
  assert.equal(await lstat(first.repositoryPath).catch(() => null), null);
});
