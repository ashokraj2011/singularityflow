import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryStack } from '../src/story-stack.mjs';

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
