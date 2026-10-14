/**
 * Another program's brief hold on a Story worktree's index must not fail a governed publication.
 *
 * VS Code's Git view and editors run `git status`, which takes `index.lock`, typically right after
 * Singularity Flow writes files. A publication refreshes its published index entries after the
 * branch has advanced; failing there reported "Unable to create '.../index.lock': File exists",
 * left the commit published, and made every published file look changed.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { completeDeferredIndexRefresh } from '../src/deferred-index-refresh.mjs';
import { commitIsolated, refreshStalePublishedIndex } from '../src/git.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { run } from '../src/util.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

const env = { ...process.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Lock Tester',
  GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'lock@example.invalid' };
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A Story worktree beside its repository, with one governed file written and not yet committed. */
async function storyWorktree(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-index-lock-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'app');
  git(base, 'init', '-q', '-b', 'main', repo);
  await writeFile(path.join(repo, 'README.md'), '# App\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'init');
  const worktree = path.join(base, 'story');
  git(repo, 'worktree', 'add', '-q', '-b', 'STORY-1', worktree);
  await writeFile(path.join(worktree, 'spec.md'), '# Specification\n');
  return { worktree, lock: path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'index.lock')) };
}

/** Hold `lock` as another program would, releasing it after `ms` from a separate process. */
async function holdLock(lock, ms) {
  await writeFile(lock, '');
  spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').rmSync(${JSON.stringify(lock)}, { force: true }), ${ms})`],
    { detached: true, stdio: 'ignore' }).unref();
}

test('a publication waits out a brief index lock taken after its branch advanced, and leaves a clean index', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  const committed = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead,
    // The moment that failed: after the branch moved, before the index refresh.
    onRefAdvanced: () => holdLock(lock, 600)
  });
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), committed);
  assert.equal(existsSync(lock), false);
  assert.equal(git(worktree, 'status', '--porcelain'), '', 'nothing looks changed after publishing');
});

/** Run with a shorter index-lock wait for this test only. */
function shortLockWait(t, ms) {
  const previous = process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS;
  process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS = String(ms);
  t.after(() => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS;
    else process.env.SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS = previous;
  });
}

const markerOf = (worktree) => path.resolve(worktree, git(worktree, 'rev-parse', '--git-path', 'singularity-flow/index-refresh-pending'));

test('a lock held past the wait no longer fails a publication: the commit stands and the next command completes the index', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  shortLockWait(t, 300);
  const committed = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead, onRefAdvanced: () => writeFile(lock, '')
  });
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), committed, 'published, not refused');
  assert.equal(readFileSync(markerOf(worktree), 'utf8').trim(), committed, 'the owed refresh is recorded in this checkout');
  assert.match(git(worktree, 'status', '--porcelain'), /spec\.md/u, 'until then the file looks changed');

  // Still locked: the next command says so once, keeps the record, and does not wait a mutation's 10 s.
  let note = '';
  const started = Date.now();
  const waiting = await completeDeferredIndexRefresh(worktree, { stderr: { write: (text) => { note += text; } } });
  assert.equal(waiting.status, 'waiting');
  assert.ok(Date.now() - started < 8000);
  assert.match(note, /still needs its files refreshed in Git's index/u);
  assert.ok(existsSync(markerOf(worktree)));

  await rm(lock, { force: true });
  // Something staged meanwhile is not the publication's to refresh.
  await writeFile(path.join(worktree, 'notes.txt'), 'developer notes\n');
  git(worktree, 'add', 'notes.txt');
  const done = await completeDeferredIndexRefresh(worktree);
  assert.deepEqual([done.status, done.paths], ['refreshed', ['spec.md']]);
  assert.equal(git(worktree, 'status', '--porcelain'), 'A  notes.txt', 'only what someone staged remains');
  assert.equal(existsSync(markerOf(worktree)), false);
  assert.equal(await completeDeferredIndexRefresh(worktree), null, 'nothing more is owed');
});

test('the completing command leaves a published path alone once someone staged new content for it', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  const expectedHead = git(worktree, 'rev-parse', 'HEAD');
  shortLockWait(t, 0);
  const committed = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead, onRefAdvanced: () => writeFile(lock, '')
  });
  await rm(lock, { force: true });
  await writeFile(path.join(worktree, 'spec.md'), '# Specification\n\nA later edit.\n');
  git(worktree, 'add', 'spec.md');
  assert.deepEqual(refreshStalePublishedIndex(worktree, committed), []);
  const done = await completeDeferredIndexRefresh(worktree);
  assert.deepEqual(done.paths, []);
  assert.equal(git(worktree, 'status', '--porcelain'), 'M  spec.md');
});

test('a record another commit has superseded is dropped, leaving the rest to recover', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  shortLockWait(t, 0);
  const committed = await commitIsolated(worktree, '[STORY-1][phase:specification] publish', ['spec.md'], {
    expectedHead: git(worktree, 'rev-parse', 'HEAD'), onRefAdvanced: () => writeFile(lock, '')
  });
  await rm(lock, { force: true });
  git(worktree, 'commit', '-q', '--allow-empty', '-m', 'a later commit');
  const done = await completeDeferredIndexRefresh(worktree);
  assert.deepEqual([done.status, done.commit], ['superseded', committed]);
  assert.equal(existsSync(markerOf(worktree)), false);
});

test('only commands that take the index lock before changing anything are run again', async (t) => {
  const { worktree, lock } = await storyWorktree(t);
  await holdLock(lock, 400);
  const added = run('git', ['-c', 'core.quotepath=false', 'add', 'spec.md'], { cwd: worktree, env });
  assert.equal(added.status, 0, 'add waited for the lock');
  await writeFile(lock, '');
  const stash = run('git', ['stash'], { cwd: worktree, env, allowFailure: true });
  assert.notEqual(stash.status, 0, 'a compound command is not repeated');
  assert.doesNotMatch(stash.stderr, /Singularity Flow waited/u);
  await rm(lock, { force: true });
});

/** A POC Lite Story whose first phase is prepared and ready to publish, beside a bare origin. */
async function preparedStory(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-index-lock-story-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'app');
  const storyEnv = { ...env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), SINGULARITY_FLOW_TEST_IDENTITY: 'Lock Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'ws.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json') };
  const sflow = (args, extra = {}) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, env: { ...storyEnv, ...extra }, encoding: 'utf8' });
  git(base, 'init', '-q', '-b', 'main', root);
  await writeFile(path.join(root, 'README.md'), '# Lock\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  assert.equal(sflow(['init']).status, 0);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configPath, 'utf8'));
  configuration.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(configuration));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', `${root}.git`);
  git(root, 'remote', 'add', 'origin', `${root}.git`);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  for (const args of [['start', 'LOCK-1', '--from-branch', 'main', '--work-type', 'poc-lite', '--title', 'One local change',
    '--description', 'Publication survives a busy index.'], ['prepare', 'poc-lite-plan']]) {
    const result = sflow(args);
    assert.equal(result.status, 0, result.stderr);
  }
  const lock = path.resolve(root, git(root, 'rev-parse', '--git-path', 'index.lock'));
  const publish = (extra) => sflow(['phase', 'publish', 'poc-lite-plan', '--authored', 'deterministic', '--channel', 'kernel-generator'], extra);
  return { root, lock, sflow, publish };
}

/** Another program taking the index lock whenever it is free: for `holdMs`, or until stopped. */
function lockHolder(lock, { holdMs = null, everyMs = 2 } = {}) {
  const release = holdMs ? `;setTimeout(()=>fs.rmSync(${JSON.stringify(lock)},{force:true}),${holdMs})` : '';
  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');setInterval(()=>{try{fs.writeFileSync(${JSON.stringify(lock)},'',{flag:'wx'})${release}}catch{}},${everyMs})`],
    { stdio: 'ignore' });
  return async () => { child.kill(); await new Promise((resolve) => setTimeout(resolve, 50)); await rm(lock, { force: true }); };
}

test('a Story publishes while an editor keeps taking the index lock for a moment', { timeout: 300_000 }, async (t) => {
  const { root, lock, publish } = await preparedStory(t);
  const stop = lockHolder(lock, { holdMs: 150, everyMs: 400 });
  t.after(stop);
  const published = publish();
  await stop();
  assert.equal(published.status, 0, published.stderr);
  assert.equal(git(root, 'status', '--porcelain'), '', 'nothing looks changed after publishing');
});

test('a Story publish succeeds even when the lock outlasts the wait; the next command leaves nothing looking changed', { timeout: 300_000 }, async (t) => {
  const { root, lock, sflow, publish } = await preparedStory(t);
  const stop = lockHolder(lock);
  t.after(stop);
  const before = git(root, 'rev-parse', 'HEAD');
  const published = publish({ SINGULARITY_FLOW_GIT_INDEX_LOCK_WAIT_MS: '300' });
  await stop();
  assert.equal(published.status, 0, published.stderr + published.stdout);
  assert.match(published.stderr, /Git's index could not be refreshed yet .*the next Singularity Flow command in this checkout completes it/u);
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(commit, before);
  assert.match(git(root, 'ls-remote', 'origin'), new RegExp(commit), 'pushed by the publication itself');
  assert.notEqual(git(root, 'status', '--porcelain'), '', 'the published files look changed until the next command');
  const next = sflow(['status']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(git(root, 'status', '--porcelain'), '', 'any command completed the refresh');
});

test('a publication that failed after committing names sync, not the publish again, as its way out', () => {
  const error = Object.assign(new Error('Story LOCK-1 retained its commit, but a later step failed.'), {
    code: 'SINGULARITY_FLOW_ERROR', publicationRefAdvanced: true, publicationCommit: 'a'.repeat(40)
  });
  const plan = refusalRemediationPlan(error, ['--no-model', 'phase', 'publish', 'poc-lite-plan', '--json']);
  assert.deepEqual(plan.steps.map((entry) => entry.command),
    ['singularity-flow sync', 'singularity-flow recover --phase poc-lite-plan --json'], 'a --no-model run keeps its phase');
  assert.equal(plan.context.strategy, 'roll-forward-exact-commit');
  assert.match(plan.retry.label, /Do not repeat the original command/u);
});

test('recover refreshes Story index entries left behind by an earlier sync, and nothing else', { timeout: 300_000 }, async (t) => {
  const { root, sflow, publish } = await preparedStory(t);
  assert.equal(publish().status, 0);
  // What an older sync left: published and pushed, the index still describing the parent.
  git(root, 'reset', '-q', 'HEAD~1', '--', 'singularity/work-items/LOCK-1');
  await writeFile(path.join(root, 'notes.txt'), 'developer notes\n');
  git(root, 'add', 'notes.txt');
  assert.notEqual(git(root, 'status', '--porcelain'), 'A  notes.txt');
  const inspected = sflow(['recover', 'LOCK-1', '--phase', 'poc-lite-plan', '--json']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const plan = JSON.parse(inspected.stdout);
  const refresh = plan.actions.find((entry) => entry.id === 'refresh-index');
  assert.ok(refresh?.automatic, JSON.stringify(plan.actions.map((entry) => entry.id)));
  assert.ok(refresh.paths.every((file) => file.startsWith('singularity/work-items/LOCK-1/')));
  assert.ok(!plan.actions.some((entry) => entry.id === 'working-tree'), 'no manual review of bookkeeping');
  const applied = sflow(['recover', 'LOCK-1', '--phase', 'poc-lite-plan', '--apply', '--confirm', plan.planId, '--json']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).postconditionsMet, true);
  assert.equal(git(root, 'status', '--porcelain'), 'A  notes.txt', 'only what someone staged remains');
});

test('recover removes an index lock a crashed command left, and only waits on a fresh one', { timeout: 300_000 }, async (t) => {
  const { root, lock, sflow } = await preparedStory(t);
  await writeFile(lock, '');
  const fresh = JSON.parse(sflow(['recover', 'LOCK-1', '--phase', 'poc-lite-plan', '--json']).stdout);
  assert.ok(fresh.actions.some((entry) => entry.id === 'wait-index-lock' && !entry.automatic));
  assert.ok(!fresh.actions.some((entry) => entry.id === 'remove-stale-index-lock'), 'a lock in use is never removed');
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await utimes(lock, old, old);
  const plan = JSON.parse(sflow(['recover', 'LOCK-1', '--phase', 'poc-lite-plan', '--json']).stdout);
  const remove = plan.actions.find((entry) => entry.id === 'remove-stale-index-lock');
  assert.ok(remove?.automatic);
  assert.equal(remove.lockPath, lock);
  const applied = sflow(['recover', 'LOCK-1', '--phase', 'poc-lite-plan', '--apply', '--confirm', plan.planId, '--json']);
  assert.equal(applied.status, 0, applied.stderr + applied.stdout);
  assert.equal(existsSync(lock), false);
  assert.equal(JSON.parse(applied.stdout).postconditionsMet, true);
  assert.equal(git(root, 'status', '--porcelain').includes('index.lock'), false);
});

test('a specification draft not yet published or submitted recovers from a lagging index without losing a word', { timeout: 300_000 }, async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-index-lock-spec-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'app');
  const specEnv = { ...env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'), SINGULARITY_FLOW_TEST_IDENTITY: 'Spec Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'ws.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json') };
  const sflow = (...args) => spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: repo, env: specEnv, encoding: 'utf8' });
  git(base, 'init', '-q', '-b', 'main', repo);
  await writeFile(path.join(repo, 'README.md'), '# App\n');
  assert.equal(sflow('init').status, 0);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(base, 'init', '-q', '--bare', '-b', 'main', path.join(base, 'app.git'));
  git(repo, 'remote', 'add', 'origin', path.join(base, 'app.git'));
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  const started = sflow('start', 'SPEC-1', '--title', 'Add an order note', '--description', 'Orders may carry an optional note.',
    '--acceptance-criteria', 'A note up to 200 characters is stored with the order.', '--work-type', 'spec-code-test-loop',
    '--from-branch', 'main', '--readiness-baseline', 'defer');
  assert.equal(started.status, 0, started.stderr);
  const spec = path.join(repo, 'singularity/work-items/SPEC-1/artifacts/specification/spec.md');
  await writeFile(spec, (await readFile(spec, 'utf8')).replace('## Actors', '## Actors\n\nOrder clerks, still being written.'));
  // The Story files' index entries one commit behind, as an interrupted publication leaves them.
  git(repo, 'reset', '-q', 'HEAD~1', '--', 'singularity/work-items/SPEC-1');
  const plan = JSON.parse(sflow('recover', 'SPEC-1', '--phase', 'specification', '--json').stdout);
  const refresh = plan.actions.find((entry) => entry.id === 'refresh-index');
  assert.ok(refresh?.automatic, JSON.stringify(plan.actions.map((entry) => entry.id)));
  assert.ok(refresh.paths.includes('singularity/work-items/SPEC-1/artifacts/specification/spec.md'));
  const applied = sflow('recover', 'SPEC-1', '--phase', 'specification', '--apply', '--confirm', plan.planId, '--json');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(git(repo, 'status', '--porcelain'), 'M singularity/work-items/SPEC-1/artifacts/specification/spec.md',
    'only the unpublished draft remains, as an ordinary edit');
  assert.match(await readFile(spec, 'utf8'), /Order clerks, still being written\./u);
  const next = JSON.parse(sflow('recover', 'SPEC-1', '--phase', 'specification', '--json').stdout);
  assert.ok(next.actions.every((entry) => entry.mode !== 'manual'), JSON.stringify(next.actions.map((entry) => [entry.id, entry.mode])));
});

test("Singularity Flow's own git status never takes the index lock; everything else is unchanged", () => {
  const seen = [];
  const spawnSyncCommand = (_executable, args, options) => {
    seen.push([args.find((arg) => !arg.startsWith('-') && !arg.includes('=')), options.env.GIT_OPTIONAL_LOCKS]);
    return { status: 0, stdout: '', stderr: '' };
  };
  run('git', ['status', '--porcelain=v1'], { spawnSyncCommand });
  run('git', ['-c', 'core.quotepath=false', 'status'], { spawnSyncCommand });
  run('git', ['add', 'spec.md'], { spawnSyncCommand });
  run('git', ['status'], { spawnSyncCommand, env: { ...process.env, GIT_OPTIONAL_LOCKS: '1' } });
  assert.deepEqual(seen, [['status', '0'], ['status', '0'], ['add', process.env.GIT_OPTIONAL_LOCKS], ['status', '1']]);
});
