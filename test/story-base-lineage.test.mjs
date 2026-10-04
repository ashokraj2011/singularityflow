import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  baseStoryCandidates, baseStoryPullRequestTarget, baseStoryRecord, detectBaseStory, inheritFromBaseStory,
  storyClaimsBranch, storyLineageLines
} from '../src/story-base-lineage.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-base-story-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Base Story');
  git(root, 'config', 'user.email', 'base.story@example.com');
  await writeFile(path.join(root, 'README.md'), '# base\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'Initial');
  return root;
}

test('candidates are the branch name, then the Story IDs of recent commit subjects, once each', () => {
  assert.deepEqual(baseStoryCandidates('STORY-1', [
    '[STORY-1][intake] submit intake', '[STORY-0][init] start feature workflow', 'Merge branch main', '[STORY-0][x] y'
  ]), ['STORY-1', 'STORY-0']);
  // A branch name that cannot be a Work ID is skipped; its commits still name the Story.
  assert.deepEqual(baseStoryCandidates('feature/retry', ['[PAY-9][init] start feature workflow']), ['PAY-9']);
  assert.deepEqual(baseStoryCandidates('PAY-9', ['[PAY-9][init] start'], { exclude: 'PAY-9' }), []);
  const many = Array.from({ length: 20 }, (_, index) => `[S-${index}][init] start`);
  assert.equal(baseStoryCandidates('main', many).length, 8, 'reads at most eight workflows');
});

test('a Story claims its canonical branch, its work branch and its registered child branches only', () => {
  const story = {
    workItem: { id: 'S-1', branch: 'S-1' },
    lineage: { canonicalBranch: 'S-1', childBranches: [{ name: 'S-1-api' }] }
  };
  assert.equal(storyClaimsBranch(story, 'S-1'), true);
  assert.equal(storyClaimsBranch(story, 'S-1-api'), true);
  assert.equal(storyClaimsBranch(story, 'main'), false);
  assert.equal(storyClaimsBranch(story, ''), false);
});

test('the record keeps the chain of Stories above, and an Epic is inherited only when there is none', () => {
  const parent = {
    workItem: { id: 'S-2', title: 'Second', baseBranch: 'S-1' },
    lineage: { epicId: 'EPIC-1', baseStory: { workId: 'S-1', ancestors: ['S-0', 'S-0'] } }
  };
  const record = baseStoryRecord(parent, { branch: 'S-2', commit: 'a'.repeat(40) });
  assert.deepEqual(record, {
    workId: 'S-2', title: 'Second', branch: 'S-2', commit: 'a'.repeat(40), baseBranch: 'S-1', epicId: 'EPIC-1', ancestors: ['S-1', 'S-0']
  });

  const fresh = inheritFromBaseStory({ epicId: null }, record);
  assert.equal(fresh.epicId, 'EPIC-1');
  assert.equal(fresh.epicInheritedFrom, 'S-2');
  const own = inheritFromBaseStory({ epicId: 'EPIC-9' }, record);
  assert.equal(own.epicId, 'EPIC-9', 'a Story keeps the Epic it was given');
  assert.equal(own.epicInheritedFrom, undefined);
  assert.equal(own.baseStory.workId, 'S-2');
  assert.deepEqual(inheritFromBaseStory({ epicId: null }, null), { epicId: null }, 'no base Story changes nothing');

  assert.deepEqual(storyLineageLines({ lineage: fresh }), [
    `Built on: S-2 — Second (branch S-2 at ${'a'.repeat(8)})`, 'Epic: EPIC-1 (inherited from S-2)'
  ]);
  assert.deepEqual(storyLineageLines({ lineage: { epicId: null } }), []);
});

test('the pull request falls back to the base Story\'s own base when its branch is gone from the remote', async () => {
  const root = await repository();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const workflow = { lineage: { baseStory: { workId: 'S-1', branch: 'S-1', baseBranch: 'main' } } };
  assert.deepEqual(baseStoryPullRequestTarget(root, workflow), {
    workId: 'S-1', branch: 'S-1', landing: 'main', base: 'main', state: 'gone'
  });
  git(root, 'switch', '-q', '-c', 'S-1');
  await writeFile(path.join(root, 'work.txt'), 'open\n');
  git(root, 'add', 'work.txt');
  git(root, 'commit', '-q', '-m', '[S-1][init] start feature workflow');
  git(root, 'update-ref', 'refs/remotes/origin/S-1', 'HEAD');
  assert.equal(baseStoryPullRequestTarget(root, workflow).state, 'open');
  assert.equal(baseStoryPullRequestTarget(root, { lineage: {} }), null);
});

test('detection is advisory: a branch whose workflow cannot be read links to nothing', async () => {
  const root = await repository();
  git(root, 'switch', '-q', '-c', 'S-BROKEN');
  await mkdir(path.join(root, 'singularity/work-items/S-BROKEN'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/S-BROKEN/workflow.json'), '{ not json');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', '[S-BROKEN][init] start feature workflow');
  const commit = git(root, 'rev-parse', 'HEAD');
  assert.equal(detectBaseStory(root, {}, { baseBranch: 'S-BROKEN', baseCommit: commit }), null);
  assert.equal(detectBaseStory(root, {}, { baseBranch: 'S-BROKEN', baseCommit: 'not-a-commit' }), null);
  assert.equal(detectBaseStory(path.join(root, 'missing'), {}, { baseBranch: 'S-BROKEN', baseCommit: commit }), null);
});
