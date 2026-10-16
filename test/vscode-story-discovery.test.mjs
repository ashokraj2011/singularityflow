import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverWorkspaceStoryRows, settleIndependentStoryRead, StoryRefreshGate } from '../apps/vscode/src/story-discovery.ts';

test('an independent local read starts once and joins without serializing remote discovery', async () => {
  const seen = [];
  let finish;
  const local = settleIndependentStoryRead(async () => {
    seen.push('local-start');
    await new Promise(resolve => { finish = resolve; });
    seen.push('local-complete');
  });
  assert.deepEqual(seen, ['local-start']);
  const remote = Promise.resolve().then(() => seen.push('remote-complete'));
  await remote;
  assert.deepEqual(seen, ['local-start', 'remote-complete']);
  finish();
  assert.deepEqual(await local, { ok: true });
  assert.deepEqual(seen, ['local-start', 'remote-complete', 'local-complete']);
});

test('a rejected or superseded local read is retained, not retried or reported as success', async () => {
  const failure = new Error('superseded repository read');
  let calls = 0;
  const result = settleIndependentStoryRead(() => { calls++; throw failure; });
  await new Promise(resolve => setImmediate(resolve)); // rejection is handled even before the join
  assert.deepEqual(await result, { ok: false, error: failure });
  assert.equal(calls, 1);
});

test('Story discovery reads every ready workspace repository without hiding partial failures', async () => {
  const called = [];
  const result = await discoverWorkspaceStoryRows([
    { id: 'alpha', absolutePath: '/workspace/repos/alpha', state: 'ready' },
    { id: 'duplicate', absolutePath: '/workspace/repos/alpha', state: 'ready' },
    { id: 'beta', absolutePath: '/workspace/repos/beta', state: 'ready' },
    { id: 'deferred', absolutePath: '/workspace/repos/deferred', state: 'missing' }
  ], async (repository) => {
    called.push(repository.id);
    if (repository.id === 'beta') throw new Error('Git authentication failed');
    return {
      items: [{ id: 'STORY-1', title: 'Half-done Story', status: 'in_progress', phase: 'implementation', branch: 'STORY-1', createdAt: '2026-10-01T08:30:00Z' }],
      unavailableCount: 1
    };
  });
  assert.deepEqual(called.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.stories.map((row) => [row.repositoryId, row.id, row.status]), [
    ['alpha', 'STORY-1', 'in_progress']
  ]);
  assert.equal(result.stories[0].createdAt, '2026-10-01T08:30:00Z');
  assert.deepEqual(result.issues.map((issue) => issue.repositoryId), ['alpha', 'beta', 'deferred']);
  assert.match(result.issues.find((issue) => issue.repositoryId === 'deferred').message, /materialize or repair/);
});

test('Story discovery never treats a malformed response as a verified empty catalog', async () => {
  const result = await discoverWorkspaceStoryRows([
    { id: 'app', absolutePath: '/workspace/repos/app', state: 'ready' }
  ], async () => ({}));
  assert.deepEqual(result.stories, []);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /no candidate list/);
});

test('Story discovery surfaces the affected branch and failure reason in the Inbox warning', async () => {
  const result = await discoverWorkspaceStoryRows([
    { id: 'pysfield', absolutePath: '/workspace/repos/pysfield', state: 'ready' }
  ], async () => ({
    items: [{ id: 'test', title: 'test', status: 'in_progress', phase: 'intake', branch: 'test' }],
    unavailableCount: 2,
    unavailable: [
      { code: 'SUBJECT_STATE_UNAVAILABLE', branch: 'migration', reason: 'Git could not list governed state at origin/migration.' },
      { code: 'SUBJECT_STATE_UNAVAILABLE', branch: 'old', reason: 'required configuration object is unavailable locally' }
    ]
  }));
  assert.equal(result.stories.length, 1);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /migration \[SUBJECT_STATE_UNAVAILABLE\]: Git could not list governed state/);
  assert.match(result.issues[0].message, /old \[SUBJECT_STATE_UNAVAILABLE\]: required configuration object is unavailable locally/);
  assert.match(result.issues[0].message, /session candidates --json --diagnostics/);
});

test('Story discovery reports malformed workspace inventory instead of silently skipping it', async () => {
  const result = await discoverWorkspaceStoryRows([
    { id: 'missing-path', absolutePath: '', state: 'missing' },
    { id: '', absolutePath: '/workspace/repos/unknown', state: 'ready' }
  ], async () => ({ items: [] }));
  assert.deepEqual(result.stories, []);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0].message, /no stable ID, local path, or remote URL/);
});

test('deferred repository Stories retain their mapped URL for explicit attach and materialization', async () => {
  let observedConfigurationUrl = null;
  const result = await discoverWorkspaceStoryRows([
    { id: 'deferred', absolutePath: '/workspace/repos/deferred', state: 'missing',
      url: 'file:///team/deferred.git', configurationUrl: 'file:///team/lead.git' }
  ], async (repository) => {
    observedConfigurationUrl = repository.configurationUrl;
    return { items: [
      { id: 'WRK-7', title: 'In progress elsewhere', status: 'in_progress', phase: 'testing', branch: 'WRK-7', createdAt: '2026-09-30T16:00:00Z' }
    ] };
  });
  assert.deepEqual(result.issues, []);
  assert.equal(observedConfigurationUrl, 'file:///team/lead.git');
  assert.equal(result.stories[0].repositoryPath, '');
  assert.equal(result.stories[0].repositoryUrl, 'file:///team/deferred.git');
  assert.equal(result.stories[0].createdAt, '2026-09-30T16:00:00Z');
});

test('post-attachment Story refresh reruns after an older in-flight catalog read', async () => {
  const gate = new StoryRefreshGate();
  let release;
  const first = gate.run(3, () => new Promise((resolve) => { release = resolve; }));
  let reads = 0;
  const postAttachment = gate.run(3, async () => { reads += 1; }, true);
  await Promise.resolve();
  release();
  await Promise.all([first, postAttachment]);
  assert.equal(reads, 1);
});

test('Story refresh for a new repository epoch does not wait for the old checkout', async () => {
  const gate = new StoryRefreshGate();
  let release;
  const old = gate.run(4, () => new Promise((resolve) => { release = resolve; }));
  let newRan = false;
  await gate.run(5, async () => { newRan = true; });
  assert.equal(newRan, true);
  release();
  await old;
});

test('post-attachment Story refresh still reruns after the older fetch fails', async () => {
  const gate = new StoryRefreshGate();
  const original = gate.run(8, async () => { throw new Error('old fetch failed'); });
  let refreshed = false;
  const next = gate.run(8, async () => { refreshed = true; }, true);
  await assert.rejects(original, /old fetch failed/);
  await next;
  assert.equal(refreshed, true);
});
