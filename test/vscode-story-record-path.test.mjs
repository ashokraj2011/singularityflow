// SSB M1 [SSB:REQ-009]: the VS Code extension and the plugin do not bundle src/story-paths.mjs, so each keeps a small copy
// of its record classifier. These tests hold both copies to the engine's answers, and to the patterns they replaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_WORK_ITEM_ROOT, storyRecordWithin as engineRecordWithin } from '../src/story-paths.mjs';
import { DEFAULT_STORIES_FOLDER, storyRecordWithin as extensionRecordWithin } from '../apps/vscode/src/story-attach.ts';
import { inferWorkId } from '../plugin/extensions/documents/documents.mjs';

const PATHS = [
  'singularity/work-items/W-1/workflow.json',
  'singularity/work-items/W-1/artifacts/design/design.md',
  'singularity/work-items/a.b_c-9/evidence/x.png',
  'member/singularity/work-items/W-2/context/claims/a.json',
  'deep/member/singularity/work-items/W-3/artifacts/intake/intake.md',
  'singularity/work-items/W-4',
  'singularity/work-items/',
  'singularity/work-itemsX/W-5/a.md',
  'other/work-items/W-6/a.md',
  'src/app.mjs',
  ''
];

test('the extension\'s copy gives the engine\'s answer for every path, with the default Stories folder', () => {
  assert.equal(DEFAULT_STORIES_FOLDER, DEFAULT_WORK_ITEM_ROOT);
  for (const recorded of [...PATHS, null, undefined]) {
    assert.deepEqual(extensionRecordWithin(recorded), engineRecordWithin(recorded), String(recorded));
  }
  for (const recorded of ['team/stories/S-1/a.md', 'x/team/stories/S-1/a.md', 'singularity/work-items/W-1/a.md']) {
    assert.deepEqual(extensionRecordWithin(recorded, 'team/stories'), engineRecordWithin(recorded, { workItemRoot: 'team/stories' }), recorded);
  }
});

test('the copies name a document\'s Story as the patterns they replaced did', () => {
  const inbox = (value) => value.match(/(?:^|\/)singularity\/work-items\/([^/]+)\//)?.[1] ?? null;
  const plugin = (value) => value.match(/singularity\/work-items\/([^/]+)\//)?.[1] ?? null;
  for (const recorded of PATHS) {
    const story = extensionRecordWithin(recorded);
    assert.equal(story?.inside ? story.id : null, inbox(recorded), recorded);
    assert.equal(inferWorkId([{ path: recorded }]), plugin(recorded), recorded);
  }
  assert.equal(inferWorkId([{ path: 'src/a.mjs' }, { path: 'singularity/work-items/W-7/a.md' }]), 'W-7');
  assert.equal(inferWorkId([{}]), null);
});
