import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { validateId } from '../src/state.mjs';
import { prepareStoryWorktree } from '../src/story-worktree.mjs';
import {
  beginStoryStartJournal, recoverStoryStart
} from '../src/story-start-journal.mjs';

const permissiveDefinition = {
  idPattern: '^.{1,128}$',
  defaultBaseBranch: 'main'
};

const invalidIds = [
  'CON',
  'nul.txt',
  'COM1',
  'COM¹',
  'com².txt',
  'CONIN$',
  'clock$.trace',
  'lpt9.log',
  'LPT³.log',
  'STORY.',
  'STORY ',
  'STORY.lock',
  'STORY.LOCK',
  'STORY..NEXT',
  'HEAD',
  '-STORY',
  '.STORY',
  'STORY@{NEXT',
  'STORY~NEXT',
  'STORY[NEXT',
  `A${'9'.repeat(64)}`
];

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-portable-work-id-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Portable Work ID Tester']);
  git(root, ['config', 'user.email', 'portable-work-id@example.com']);
  await writeFile(path.join(root, 'README.md'), '# portable Work IDs\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

async function pathMissing(target) {
  try {
    await access(target);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('portable Work ID validation preserves ordinary existing identifiers', () => {
  const definition = {
    idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    defaultBaseBranch: 'main'
  };
  for (const id of [
    'A', 'story-1', 'STORY_2', 'release.2026', 'CONSOLE', 'COM10', 'foo.locked',
    `A${'9'.repeat(63)}`
  ]) {
    assert.doesNotThrow(() => validateId(definition, id), id);
  }
});

test('application integration branches are reserved without Windows case distinctions', () => {
  const definition = {
    idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    defaultBaseBranch: 'TrUnK'
  };
  for (const id of ['main', 'MAIN', 'Master', 'mAsTeR', 'trunk', 'TRUNK']) {
    assert.throws(
      () => validateId(definition, id),
      /reserved for application integration/u,
      id
    );
  }
});

test('nonportable Work IDs are refused before any ref, worktree, or start journal is created', async (t) => {
  const root = await repository(t);
  const refsBefore = git(root, ['for-each-ref', '--format=%(refname) %(objectname)']);
  const worktreesBefore = git(root, ['worktree', 'list', '--porcelain']);
  const journalDirectory = path.join(root, '.git', 'singularity-flow', 'story-start');

  for (const id of invalidIds) {
    assert.throws(
      () => validateId(permissiveDefinition, id),
      (error) => error.code === 'WORK_ID_INVALID',
      id
    );
    await assert.rejects(
      () => prepareStoryWorktree(root, id),
      (error) => error.code === 'STORY_WORKTREE_INVALID',
      id
    );
    await assert.rejects(
      () => beginStoryStartJournal(root, {
        id,
        targetBranch: id,
        targetBranchExisted: false,
        originalBranch: 'main',
        originalHead: git(root, ['rev-parse', 'HEAD']),
        baseCommit: git(root, ['rev-parse', 'HEAD'])
      }),
      (error) => error.code === 'STORY_START_JOURNAL_INVALID',
      id
    );
    await assert.rejects(
      () => recoverStoryStart(root, id, { force: true }),
      (error) => error.code === 'STORY_START_JOURNAL_INVALID',
      id
    );

    assert.equal(
      git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
      refsBefore,
      id
    );
    assert.equal(git(root, ['worktree', 'list', '--porcelain']), worktreesBefore, id);
    assert.equal(await pathMissing(journalDirectory), true, id);
  }
});
