import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverWorkspaceStoryRows, StoryRefreshGate } from '../apps/vscode/src/story-discovery.ts';

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
      items: [{ id: 'STORY-1', title: 'Half-done Story', status: 'in_progress', phase: 'implementation', branch: 'STORY-1' }],
      unavailableCount: 1
    };
  });
  assert.deepEqual(called.sort(), ['alpha', 'beta']);
  assert.deepEqual(result.stories.map((row) => [row.repositoryId, row.id, row.status]), [
    ['alpha', 'STORY-1', 'in_progress']
  ]);
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

test('Story discovery reports malformed workspace inventory instead of silently skipping it', async () => {
  const result = await discoverWorkspaceStoryRows([
    { id: 'missing-path', absolutePath: '', state: 'missing' },
    { id: '', absolutePath: '/workspace/repos/unknown', state: 'ready' }
  ], async () => ({ items: [] }));
  assert.deepEqual(result.stories, []);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0].message, /no stable ID, local path, or remote URL/);
});

test('deferred repository Stories are visible from approved remote metadata but not attachable yet', async () => {
  let observedConfigurationUrl = null;
  const result = await discoverWorkspaceStoryRows([
    { id: 'deferred', absolutePath: '/workspace/repos/deferred', state: 'missing',
      url: 'file:///team/deferred.git', configurationUrl: 'file:///team/lead.git' }
  ], async (repository) => {
    observedConfigurationUrl = repository.configurationUrl;
    return { items: [
      { id: 'WRK-7', title: 'In progress elsewhere', status: 'in_progress', phase: 'testing', branch: 'WRK-7' }
    ] };
  });
  assert.deepEqual(result.issues, []);
  assert.equal(observedConfigurationUrl, 'file:///team/lead.git');
  assert.equal(result.stories[0].repositoryPath, '');
  assert.equal(result.stories[0].repositoryUrl, 'file:///team/deferred.git');
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
