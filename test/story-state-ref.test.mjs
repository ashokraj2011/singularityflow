// SSB M2 [SSB:REQ-002, 003, 006, 007]: a state-ref Story's records live on refs/singularity/state/<ID>, checked out at
// .sflow-state/ as a linked worktree that Git's everyday commands in the code checkout leave alone (spec §11.2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  commitStoryState, createStateRef, detectStateCheckout, ensureStateCheckout, excludeStateCheckout, fetchStoryState,
  listStoryStates, openStoryState, refTip, removeStateCheckout, restoreStateCheckout, stateCheckoutChanges,
  stateCheckoutExcluded, storyStateRef
} from '../src/story-state-ref.mjs';
import { forgetStoryLayouts, storyLocation } from '../src/story-paths.mjs';
import { STATE_CHECKOUT_FOLDER, withoutAgentOutputStatus } from '../src/agent-output-folder.mjs';
import { STATE_CHECKOUT } from '../src/story-paths.mjs';
import { releaseStateCheckout, storyWorktreeChanges } from '../src/story-worktree.mjs';
import { assertNoStateCheckoutGitlink } from '../src/delivery-evidence.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function clone(t, name = 'app') {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ssb-m2-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const remote = path.join(parent, 'remote.git');
  git(parent, 'init', '-q', '--bare', '-b', 'main', remote);
  const root = path.join(parent, name);
  git(parent, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.name', 'State Tester');
  git(root, 'config', 'user.email', 'state-tester@example.com');
  await writeFile(path.join(root, 'README.md'), '# app\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'switch', '-q', '-c', 'WRK-1');
  return { parent, remote, root };
}

async function record(root, relative, value) {
  const file = path.join(root, '.sflow-state', relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

test.afterEach(() => forgetStoryLayouts());

test('a new Story opens its records: the exclude line first, then a ref with no application history, then the checkout', async (t) => {
  const { root } = await clone(t);
  assert.equal(stateCheckoutExcluded(root), false);
  const opened = await openStoryState(root, 'WRK-1');
  assert.equal(opened.ref, 'refs/singularity/state/WRK-1');
  assert.equal(stateCheckoutExcluded(root), true);
  // One root commit with an empty tree: no parent from the code, nothing to merge.
  assert.equal(git(root, 'rev-list', '--count', opened.ref), '1');
  assert.equal(git(root, 'ls-tree', opened.ref), '');
  assert.equal(spawnSync('git', ['merge-base', 'main', opened.ref], { cwd: root }).status, 1);
  // A detached checkout at the ref, inside the Story checkout; no branch list shows the ref.
  assert.equal(git(path.join(root, '.sflow-state'), 'rev-parse', 'HEAD'), opened.commit);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: path.join(root, '.sflow-state') }).status, 1);
  assert.doesNotMatch(git(root, 'branch', '--all'), /state/);
  // The resolver now finds this Story's records in the checkout, given only the definition.
  assert.equal(storyLocation(root, {}, 'WRK-1').layout, 'state-ref');
  assert.equal(storyLocation(root, {}, 'WRK-1').workflowFile, path.join(root, '.sflow-state', 'workflow.json'));
  assert.equal(storyLocation(root, {}, 'WRK-2').layout, 'story-branch');
  // A second start with the same ID is refused, with the way to open the first.
  assert.throws(() => createStateRef(root, 'WRK-1'), (error) => error.code === 'STORY_STATE_REF_EXISTS'
    && error.details.nextAction.argv.join(' ') === 'resume WRK-1');
  // The exclude line is written once.
  await excludeStateCheckout(root);
  const exclude = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((line) => line === '/.sflow-state/').length, 1);
});

test('every state commit moves the ref at once, under its expected value; nothing lives only on the detached HEAD', async (t) => {
  const { root } = await clone(t);
  const opened = await openStoryState(root, 'WRK-1');
  assert.deepEqual(commitStoryState(root, 'WRK-1', 'nothing'), { committed: false, ref: opened.ref, commit: opened.commit });
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  await record(root, 'approvals/design.json', { decision: 'approved' });
  const first = commitStoryState(root, 'WRK-1', '[WRK-1][init] start');
  assert.equal(first.committed, true);
  assert.equal(refTip(root, opened.ref), first.commit);
  assert.equal(git(path.join(root, '.sflow-state'), 'rev-parse', 'HEAD'), first.commit);
  assert.deepEqual(stateCheckoutChanges(root), []);
  assert.equal(git(root, 'show', `${opened.ref}:approvals/design.json`), '{"decision":"approved"}');
  // A teammate's commit moved the ref: the next write is refused and the ref is left as found.
  await record(root, 'decisions/one.json', { n: 1 });
  const other = git(root, 'commit-tree', `${first.commit}^{tree}`, '-p', first.commit, '-m', 'elsewhere');
  git(root, 'update-ref', opened.ref, other, first.commit);
  assert.throws(() => commitStoryState(root, 'WRK-1', 'second'), (error) => error.code === 'STORY_STATE_REF_MOVED');
  assert.equal(refTip(root, opened.ref), other);
  assert.equal(stateCheckoutChanges(root).length, 1);
  // An unfinished write is undone from the checkout's HEAD.
  restoreStateCheckout(root);
  assert.deepEqual(stateCheckoutChanges(root), []);
});

test('git status, git add -A, git clean -fdx and git stash -u in the code checkout never touch the state checkout', async (t) => {
  const { root } = await clone(t);
  await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  commitStoryState(root, 'WRK-1', 'start');
  assert.equal(git(root, 'status', '--porcelain'), '');
  await writeFile(path.join(root, 'code.txt'), 'code\n');
  git(root, 'add', '-A');
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'code.txt');
  git(root, 'commit', '-q', '-m', 'code');
  assert.equal(git(root, 'show', '--stat', '--format=', 'HEAD').includes('.sflow-state'), false);
  git(root, 'clean', '-fdx');
  git(root, 'stash', '-u');
  assert.equal(existsSync(path.join(root, '.sflow-state', 'workflow.json')), true);
  assert.equal(detectStateCheckout(root)?.id, 'WRK-1');
});

test('a missing, moved or foreign state checkout is made again from the ref; only uncommitted bytes are at risk', async (t) => {
  const { parent, root } = await clone(t);
  const opened = await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  const saved = commitStoryState(root, 'WRK-1', 'start');
  // Deleted, as by git clean -ffdx: still registered, so Git needs a prune before the checkout is made again.
  await rm(path.join(root, '.sflow-state'), { recursive: true, force: true });
  const rebuilt = await ensureStateCheckout(root, 'WRK-1');
  assert.equal(rebuilt.created, true);
  assert.deepEqual(rebuilt.repaired, ['rebuilt']);
  assert.equal(await readFile(path.join(root, '.sflow-state', 'workflow.json'), 'utf8'), '{"workItem":{"id":"WRK-1"}}\n');
  // The whole Story checkout moved: both worktree links break, and repair fixes them.
  const moved = path.join(parent, 'moved');
  await rename(root, moved);
  const repaired = await ensureStateCheckout(moved, 'WRK-1');
  assert.deepEqual(repaired.repaired, ['links']);
  assert.equal(git(path.join(moved, '.sflow-state'), 'rev-parse', 'HEAD'), saved.commit);
  // A plain folder in its place is kept aside, never deleted, and the checkout is made again.
  await rm(path.join(moved, '.sflow-state'), { recursive: true, force: true });
  git(moved, 'worktree', 'prune');
  await mkdir(path.join(moved, '.sflow-state'));
  await writeFile(path.join(moved, '.sflow-state', 'stray.txt'), 'kept\n');
  const replaced = await ensureStateCheckout(moved, 'WRK-1');
  assert.ok(replaced.setAside);
  assert.equal(await readFile(path.join(replaced.setAside, 'stray.txt'), 'utf8'), 'kept\n');
  assert.equal(refTip(moved, opened.ref), saved.commit);
  assert.equal(existsSync(path.join(moved, '.sflow-state', 'workflow.json')), true);
});

test('the state checkout follows its ref, but never moves over uncommitted records', async (t) => {
  const { root } = await clone(t);
  const opened = await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  const saved = commitStoryState(root, 'WRK-1', 'start');
  // The ref moved on (a fetch): a clean checkout goes with it.
  const next = git(root, 'commit-tree', `${saved.commit}^{tree}`, '-p', saved.commit, '-m', 'next');
  git(root, 'update-ref', opened.ref, next, saved.commit);
  assert.equal((await ensureStateCheckout(root, 'WRK-1')).moved, true);
  assert.equal(git(path.join(root, '.sflow-state'), 'rev-parse', 'HEAD'), next);
  // With a record not yet committed, it stays, and says what to run.
  const later = git(root, 'commit-tree', `${saved.commit}^{tree}`, '-p', next, '-m', 'later');
  git(root, 'update-ref', opened.ref, later, next);
  await record(root, 'decisions/pending.json', { n: 1 });
  await assert.rejects(ensureStateCheckout(root, 'WRK-1'), (error) => error.code === 'STORY_STATE_CHECKOUT_CHANGED'
    && error.details.nextAction.executable === 'singularity-flow');
  // A Story whose records are not in this clone names the command that fetches them.
  await assert.rejects(ensureStateCheckout(root, 'WRK-9'), (error) => error.code === 'STORY_STATE_REF_MISSING'
    && error.details.nextAction.argv.join(' ') === 'resume WRK-9 --fetch');
});

test('removing a Story checkout removes its state checkout first, and refuses while records are unsaved', async (t) => {
  const { root } = await clone(t);
  await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  assert.throws(() => removeStateCheckout(root, { id: 'WRK-1' }), (error) => error.code === 'STORY_STATE_CHECKOUT_UNSAVED'
    && error.details.changes.length === 1 && error.details.nextAction.argv.join(' ') === 'recover');
  assert.equal(existsSync(path.join(root, '.sflow-state', 'workflow.json')), true);
  commitStoryState(root, 'WRK-1', 'start');
  assert.deepEqual(removeStateCheckout(root, { id: 'WRK-1' }), { removed: true });
  assert.equal(existsSync(path.join(root, '.sflow-state')), false);
  assert.doesNotMatch(git(root, 'worktree', 'list'), /\.sflow-state/);
  // The records stay on the ref.
  assert.equal(git(root, 'show', 'refs/singularity/state/WRK-1:workflow.json'), '{"workItem":{"id":"WRK-1"}}');
});

test('a second clone fetches a Story\'s records into a tracking ref of their own and lists every Story in one call', async (t) => {
  const { parent, remote, root } = await clone(t);
  const opened = await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  const saved = commitStoryState(root, 'WRK-1', 'start');
  git(root, 'push', '-q', 'origin', `${opened.ref}:${opened.ref}`, 'WRK-1');
  const second = path.join(parent, 'second');
  git(parent, 'clone', '-q', remote, second);
  git(second, 'config', 'user.name', 'Second Laptop');
  git(second, 'config', 'user.email', 'second@example.com');
  // A plain clone brings no refs/singularity/*.
  assert.equal(refTip(second, opened.ref), null);
  assert.deepEqual((await listStoryStates(second, { remote: 'origin' })).map((entry) => [entry.id, entry.commit]), [['WRK-1', saved.commit]]);
  const fetched = await fetchStoryState(second, 'WRK-1', { remote: 'origin' });
  assert.equal(fetched.action, 'created');
  assert.equal(refTip(second, 'refs/singularity/remotes/origin/state/WRK-1'), saved.commit);
  assert.equal(refTip(second, opened.ref), saved.commit);
  assert.deepEqual((await listStoryStates(second)).map((entry) => entry.id), ['WRK-1']);
  git(second, 'switch', '-q', 'WRK-1');
  await ensureStateCheckout(second, 'WRK-1');
  assert.equal(detectStateCheckout(second)?.id, 'WRK-1');
  // A local state commit not published yet is never overwritten by the next fetch.
  await writeFile(path.join(second, '.sflow-state', 'local.json'), '{}\n');
  const local = commitStoryState(second, 'WRK-1', 'local');
  assert.equal((await fetchStoryState(second, 'WRK-1', { remote: 'origin' })).action, 'kept-local-ahead');
  assert.equal(refTip(second, opened.ref), local.commit);
  // The first clone publishes more: the second fast-forwards only when it has nothing of its own on top.
  await record(root, 'more.json', { n: 2 });
  const more = commitStoryState(root, 'WRK-1', 'more');
  git(root, 'push', '-q', 'origin', `${opened.ref}:${opened.ref}`);
  assert.equal((await fetchStoryState(second, 'WRK-1', { remote: 'origin' })).action, 'diverged');
  assert.equal(refTip(second, opened.ref), local.commit);
  const third = path.join(parent, 'third');
  git(parent, 'clone', '-q', remote, third);
  await fetchStoryState(third, 'WRK-1', { remote: 'origin' });
  assert.equal(refTip(third, opened.ref), more.commit);
  // A Story without records on the remote fetches nothing.
  assert.equal((await fetchStoryState(third, 'WRK-2', { remote: 'origin' })).present, false);
  assert.equal(refTip(third, storyStateRef('WRK-2')), null);
});

test('where the ledger pins as branches, the state ref is the branch sflow/state/<ID>', async (t) => {
  const { root } = await clone(t);
  const definition = { ledger: { pinTransport: 'branches' } };
  const opened = await openStoryState(root, 'WRK-1', { definition });
  assert.equal(opened.ref, 'refs/heads/sflow/state/WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  assert.equal(commitStoryState(root, 'WRK-1', 'start', { definition }).committed, true);
  assert.deepEqual((await listStoryStates(root, { definition })).map((entry) => entry.id), ['WRK-1']);
});

test('checks that list ignored files skip the state checkout; removal releases it first, never over unsaved records', async (t) => {
  const { root } = await clone(t);
  assert.equal(STATE_CHECKOUT_FOLDER, STATE_CHECKOUT);
  await openStoryState(root, 'WRK-1');
  await record(root, 'workflow.json', { workItem: { id: 'WRK-1' } });
  commitStoryState(root, 'WRK-1', 'start');
  const ignored = git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching');
  assert.match(ignored, /^!! \.sflow-state\/$/mu);
  assert.equal(withoutAgentOutputStatus(ignored, root), '');
  assert.equal(storyWorktreeChanges(root).clean, true);
  await record(root, 'decisions/unsaved.json', { n: 1 });
  assert.equal(await releaseStateCheckout(root), false);
  assert.equal(existsSync(path.join(root, '.sflow-state', 'decisions', 'unsaved.json')), true);
  commitStoryState(root, 'WRK-1', 'saved');
  assert.equal(await releaseStateCheckout(root), true);
  assert.equal(existsSync(path.join(root, '.sflow-state')), false);
});

test('the code step refuses a state checkout staged into the code as a gitlink', async (t) => {
  const { root } = await clone(t);
  await openStoryState(root, 'WRK-1');
  assertNoStateCheckoutGitlink(root);
  // Forced past the exclude line, Git stages the nested worktree as a gitlink (mode 160000).
  git(root, 'add', '-f', '.sflow-state');
  assert.match(git(root, 'ls-files', '--stage', '--', '.sflow-state'), /^160000 /u);
  assert.throws(() => assertNoStateCheckoutGitlink(root), (error) => error.code === 'CODE_DELIVERY_STATE_CHECKOUT_STAGED'
    && error.details.nextAction.command === 'git rm -r --cached --quiet -- .sflow-state');
  git(root, 'rm', '-r', '--cached', '--quiet', '--', '.sflow-state');
  assertNoStateCheckoutGitlink(root);
});
