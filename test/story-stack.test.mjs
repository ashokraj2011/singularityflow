import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildStoryStack, publishedStackForStory } from '../src/story-stack.mjs';

const breakdown = {
  stories: [
    { id: 'STORY-1', repository: 'api', blocking: true, dependsOn: [] },
    { id: 'STORY-2', repository: 'web', blocking: true, dependsOn: [{ story: 'STORY-1' }] },
    { id: 'STORY-3', repository: 'web', blocking: true, dependsOn: [] }
  ]
};

test('stack imposes one deterministic PR order in addition to declared dependencies', () => {
  const stack = buildStoryStack({
    initiativeId: 'EPIC-1', epicBranch: 'EPIC-1', epicReady: false,
    outstanding: ['STORY-1', 'STORY-2', 'STORY-3'], unreachable: [],
    stories: [
      { order: 1, id: 'STORY-1', workId: 'API-1', repository: 'api', blocking: true, status: 'ready', blockedBy: [] },
      { order: 2, id: 'STORY-2', workId: 'WEB-2', repository: 'web', blocking: true, status: 'blocked', blockedBy: ['STORY-1'] },
      { order: 3, id: 'STORY-3', workId: 'WEB-3', repository: 'web', blocking: true, status: 'ready', blockedBy: [] }
    ]
  }, breakdown);
  assert.equal(stack.nextToMerge, 'API-1');
  assert.deepEqual(stack.stories[1].mergeBlockedBy, ['API-1']);
  assert.deepEqual(stack.stories[2].mergeBlockedBy, ['API-1', 'WEB-2']);
  assert.equal(stack.stories[2].mergeEligible, false, 'an independent Story still waits for earlier stack entries');
  assert.match(stack.sha256, /^[a-f0-9]{64}$/);
});

test('stack advances after the preceding Story is merged', () => {
  const stack = buildStoryStack({
    initiativeId: 'EPIC-1', epicBranch: 'EPIC-1', epicReady: false,
    outstanding: ['STORY-2', 'STORY-3'], unreachable: [],
    stories: [
      { order: 1, id: 'STORY-1', workId: 'API-1', repository: 'api', blocking: true, status: 'merged', blockedBy: [] },
      { order: 2, id: 'STORY-2', workId: 'WEB-2', repository: 'web', blocking: true, status: 'ready', blockedBy: [] },
      { order: 3, id: 'STORY-3', workId: 'WEB-3', repository: 'web', blocking: true, status: 'ready', blockedBy: [] }
    ]
  }, breakdown);
  assert.equal(stack.nextToMerge, 'WEB-2');
  assert.deepEqual(stack.stories[1].mergeBlockedBy, []);
  assert.deepEqual(stack.stories[2].mergeBlockedBy, ['WEB-2']);
});

test('a failed Story-stack refresh never falls back to a stale local state ref', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-stack-remote-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-b', 'main');
  git('remote', 'add', 'origin', path.join(root, 'missing-remote.git'));
  await mkdir(path.join(root, 'singularity', 'seeds'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'seeds', 'STORY-1.yml'),
    'initiative:\n  id: EPIC-1\n');
  await assert.rejects(
    publishedStackForStory(root, { git: { remote: 'origin' }, ledger: { branch: 'state' } },
      { workItem: { id: 'STORY-1' } }),
    /Cannot refresh the published Story stack|Git remote/i
  );
});
