import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  copilotStoryFollowDirectory, copilotStoryFollowFile, recordCopilotStoryFollow,
  readCopilotStoryFollow, createCopilotStoryFollower, copilotStoryFollowSkill, verifiedCopilotStoryFollow,
  COPILOT_STORY_FOLLOW_MAX_AGE_MS
} from '../src/copilot-story-follow.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-follow-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const originPath = path.join(base, 'workspace'), repositoryPath = path.join(base, 'Story checkout');
  await mkdir(originPath); await mkdir(repositoryPath);
  return { base, originPath, repositoryPath, directory: path.join(base, 'machine', 'copilot-story-follow'), now: Date.now() };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};

test('only bound Story skills follow; listing, selection questions and ordinary chat do not', () => {
  for (const skill of ['sf-phase', 'sf-code', 'sflow-phase', 'sflow-next', 'sf-review-source', 'sf-publish']) {
    assert.equal(copilotStoryFollowSkill(skill), true, skill);
  }
  for (const skill of ['sf-stories', 'sf-session', 'sflow-session', 'sf-workflows', 'sf-workspace', null, 'hello']) {
    assert.equal(copilotStoryFollowSkill(skill), false, skill);
  }
});

test('verified Copilot hints are per launch folder, bounded, expiring and content-free', async t => {
  const f = await fixture(t);
  const notice = await recordCopilotStoryFollow({ ...f, workId: 'STORY-1' }, f);
  assert.deepEqual(await readCopilotStoryFollow(f.originPath, f), notice);
  assert.equal(await readCopilotStoryFollow(f.base, f), null, 'another launch folder cannot consume this hint');
  assert.equal(await readCopilotStoryFollow(f.originPath, { ...f, now: f.now - 1 }), null);
  assert.equal(await readCopilotStoryFollow(f.originPath, { ...f, now: f.now + COPILOT_STORY_FOLLOW_MAX_AGE_MS + 1 }), null);
  assert.deepEqual(Object.keys(notice).sort(), ['schemaVersion', 'kind', 'eventId', 'originPath', 'repositoryPath', 'workId', 'observedAt'].sort());
  const next = await recordCopilotStoryFollow({ ...f, workId: 'STORY-2' }, { ...f, now: f.now + 1 });
  assert.notEqual(notice.eventId, next.eventId);
  assert.equal((await readdir(f.directory)).length, 1, 'one slot, not an accumulating history or Story database');
  assert.equal(await recordCopilotStoryFollow({ ...f, repositoryPath: f.originPath, workId: 'STORY-1' }, f), null,
    'an already-open Story emits no window navigation');
  assert.equal(copilotStoryFollowDirectory({ SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(f.base, 'profile.json') }),
    path.join(f.base, 'copilot-story-follow'));
});

test('unsafe, malformed and misbound hints never navigate', async t => {
  const f = await fixture(t);
  const good = await recordCopilotStoryFollow({ ...f, workId: 'STORY-1' }, f);
  const file = await copilotStoryFollowFile(f.originPath, f.directory);
  for (const bytes of ['{broken', '[]', 'null', 'x'.repeat(16385),
    ...[{ schemaVersion: 2 }, { kind: 'other' }, { eventId: '../bad' }, { originPath: f.base },
      { repositoryPath: '../relative' }, { workId: 'bad\nwork' }, { observedAt: null }, { observedAt: Infinity }]
      .map(change => JSON.stringify({ ...good, ...change }))]) {
    await writeFile(file, bytes);
    assert.equal(await readCopilotStoryFollow(f.originPath, f), null, bytes.slice(0, 90));
  }
  for (const change of [{ originPath: '../relative' }, { repositoryPath: null }, { workId: '' }]) {
    assert.equal(await recordCopilotStoryFollow({ ...f, workId: 'STORY-1', ...change }, f), null);
  }
  await rm(file); await mkdir(file);
  assert.equal(await readCopilotStoryFollow(f.originPath, f), null);
});

test('symlink aliases find the same launch slot, while symlink notice files are rejected', async t => {
  const f = await fixture(t);
  const alias = path.join(f.base, 'alias');
  try { await symlink(f.originPath, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create a directory symlink'); throw error; }
  const notice = await recordCopilotStoryFollow({ ...f, originPath: alias, workId: 'STORY-1' }, f);
  assert.deepEqual(await readCopilotStoryFollow(f.originPath, f), notice);
  assert.equal(await copilotStoryFollowFile(alias, f.directory), await copilotStoryFollowFile(f.originPath, f.directory));
  const file = await copilotStoryFollowFile(f.originPath, f.directory);
  const other = path.join(f.base, 'other.json');
  await writeFile(other, JSON.stringify(notice)); await rm(file);
  try { await symlink(other, file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host cannot create a file symlink'); throw error; }
  assert.equal(await readCopilotStoryFollow(f.originPath, f), null);
});

test('follow hints work with Windows path casing without an extra Git lookup', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const notice = await recordCopilotStoryFollow({ ...f, originPath: f.originPath.toUpperCase(), workId: 'STORY-1' }, f);
  assert.deepEqual(await readCopilotStoryFollow(f.originPath.toLowerCase(), f), notice);
});

test('watcher bursts coalesce, verify before navigation and apply each binding once', async () => {
  const gate = deferred(), entered = deferred(), operations = [];
  const notice = { eventId: 'one' };
  const follower = createCopilotStoryFollower({ read: async () => notice, isActive: () => true,
    verify: async value => { operations.push('verify'); entered.resolve(); await gate.promise; return value; },
    apply: async (value, current) => { assert.ok(await current()); operations.push(value.eventId); } });
  const pending = follower.reconcile(); await entered.promise;
  assert.equal(follower.reconcile(), pending); follower.reconcile(); gate.resolve();
  await pending; await follower.reconcile(); follower.dispose(); await follower.reconcile();
  assert.deepEqual(operations, ['verify', 'one']);
});

test('fresh kernel projection must bind the exact Story, checkout and mapped workspace', async t => {
  const f = await fixture(t);
  const notice = await recordCopilotStoryFollow({ ...f, workId: 'STORY-1' }, f);
  const context = { schemaVersion: 1, resultType: 'execution-context',
    workspace: { id: 'workspace', path: f.originPath }, repository: { id: 'app' },
    worktree: { path: f.repositoryPath }, story: { id: 'STORY-1' } };
  assert.equal(verifiedCopilotStoryFollow(notice, context), true);
  for (const change of [{ schemaVersion: 2 }, { resultType: 'invented' }, { workspace: null },
    { workspace: { id: '', path: f.originPath } }, { workspace: { id: 'workspace', path: '../outside' } },
    { repository: null }, { story: { id: 'STORY-2' } }, { worktree: { path: f.originPath } }]) {
    assert.equal(verifiedCopilotStoryFollow(notice, { ...context, ...change }), false, JSON.stringify(change));
  }
});

test('a newer Copilot binding supersedes an in-flight verification', async () => {
  const gate = deferred(), entered = deferred(), applied = [];
  let notice = { eventId: 'old' };
  const follower = createCopilotStoryFollower({ read: async () => notice, isActive: () => true,
    verify: async value => { if (value.eventId === 'old') { entered.resolve(); await gate.promise; } return value; },
    apply: async value => { applied.push(value.eventId); } });
  const pending = follower.reconcile(); await entered.promise;
  notice = { eventId: 'new' }; follower.reconcile(); gate.resolve(); await pending;
  assert.deepEqual(applied, ['new']);
});

test('unfocused windows, Story-start holds, rejected contexts and disposal cannot switch', async () => {
  const gate = deferred(), entered = deferred(), applied = [];
  let active = false, accepted = false;
  const follower = createCopilotStoryFollower({ read: async () => ({ eventId: 'one' }), isActive: () => active,
    verify: async value => { if (!accepted) return null; entered.resolve(); await gate.promise; return value; },
    apply: async value => { applied.push(value); } });
  await follower.reconcile(); active = true; await follower.reconcile(); accepted = true;
  const pending = follower.reconcile(); await entered.promise; follower.dispose(); gate.resolve(); await pending;
  assert.deepEqual(applied, []);
});

test('a validation error preserves editing and can recover on the next signal', async () => {
  let fail = true;
  const failures = [], applied = [];
  const follower = createCopilotStoryFollower({ read: async () => ({ eventId: 'one' }), isActive: () => true,
    verify: async value => { if (fail) throw new Error('checkout unavailable'); return value; },
    apply: async value => { applied.push(value); }, onError: error => failures.push(error.message) });
  await follower.reconcile(); fail = false; await follower.reconcile();
  assert.deepEqual(failures, ['checkout unavailable']); assert.equal(applied.length, 1);
});

test('extension follows a scoped verified checkout, not a profile update or Story browsing', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const start = extension.indexOf('const copilotLaunchFolders =');
  const follow = extension.slice(start, extension.indexOf('Run whatever a node offers', start));
  assert.match(follow, /vscode\.workspace\.workspaceFolders/);
  assert.match(follow, /vscode\.window\.state\.focused/);
  assert.match(follow, /client\.forkForRepository\(notice\.repositoryPath\)/);
  assert.match(follow, /\['workspace', 'context', '--json'\]/);
  assert.match(follow, /verifiedCopilotStoryFollow\(notice, verified\)/);
  assert.match(follow, /navigationGeneration !== workspaceNavigationGeneration/);
  assert.match(follow, /await follow\(\{ \.\.\.selection, navigationIsCurrent: isCurrent \}\)/);
  assert.match(follow, /storyCheckoutNeedsWindowSwitch/);
  assert.match(follow, /'vscode\.openFolder', vscode\.Uri\.file\(selection\.repositoryPath\), false/);
  assert.doesNotMatch(follow, /openGovernedCopilot|\.sendText\(|reloadWindow|executeCommand\('git/);
});
