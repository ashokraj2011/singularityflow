import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changes, changedFiles, pathHasChanges, storyIndexDrift, worktreeStatusDetail } from '../src/git.mjs';
import { withWorktreeReadScope } from '../src/read-scope.mjs';
import { withFreshGitFacts, clearGitFactCache } from '../src/git-fact-cache.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sflow-worktree-observation-'));
  t.after(() => { clearGitFactCache(); rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); });
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Worktree Qualification']); git(['config', 'user.email', 'worktree@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture']);
  return { root, git, write: (name, text) => writeFileSync(path.join(root, name), text) };
}

test('one read-only worktree observation supplies status, changed paths and clean-index proof', async t => {
  const f = fixture(t), timer = commandTimer('worktree-observation');
  await withCommandTiming(timer, () => withWorktreeReadScope(() => {
    assert.equal(changes(f.root), '');
    assert.deepEqual(changedFiles(f.root), []);
    assert.equal(worktreeStatusDetail(f.root).entries.length, 0);
    assert.deepEqual(storyIndexDrift(f.root, 'singularity/work-items/fixture'), []);
  }));
  const counters = timer.finish().counters;
  assert.equal(counters['git.local.command.status'], 1);
  assert.equal(counters['git.local.command.diff'] ?? 0, 0);
  assert.equal(counters['git.local.command.diff-tree'] ?? 0, 0);
});

test('ordinary staged, unstaged, deleted and untracked paths retain exact legacy projections', t => {
  const f = fixture(t);
  f.write('tracked.txt', 'changed\n'); f.write('added.txt', 'new\n');
  f.git(['add', '.']); f.write('tracked.txt', 'changed again\n'); f.write('untracked.txt', 'new\n');
  const expected = { status: changes(f.root), paths: changedFiles(f.root) };
  withWorktreeReadScope(() => {
    assert.equal(changes(f.root), expected.status);
    assert.deepEqual(changedFiles(f.root), expected.paths);
  });
  unlinkSync(path.join(f.root, 'tracked.txt'));
  const deleted = changedFiles(f.root);
  withWorktreeReadScope(() => assert.deepEqual(changedFiles(f.root), deleted));
});

test('renames and quoted filenames keep original Git rendering and path semantics', t => {
  const f = fixture(t);
  f.git(['mv', 'tracked.txt', 'renamed file.txt']); f.write('untracked file.txt', 'new\n');
  const expected = { status: changes(f.root), paths: changedFiles(f.root) };
  withWorktreeReadScope(() => {
    assert.equal(changes(f.root), expected.status);
    assert.deepEqual(changedFiles(f.root), expected.paths);
    const entry = worktreeStatusDetail(f.root).entries.find(value => value.type === 'rename-or-copy');
    assert.equal(entry.sourcePath.value, 'tracked.txt');
    assert.equal(entry.path.value, 'renamed file.txt');
  });
});

test('fresh boundaries bypass shared observations and another operation observes external changes', t => {
  const f = fixture(t);
  withWorktreeReadScope(() => {
    assert.equal(changes(f.root), '');
    f.write('tracked.txt', 'external edit\n');
    assert.equal(changes(f.root), '', 'one advisory observation stays internally consistent');
    withFreshGitFacts(() => {
      assert.match(changes(f.root), /tracked\.txt/u);
      assert.deepEqual(changedFiles(f.root), ['tracked.txt']);
      assert.equal(worktreeStatusDetail(f.root).entries.length, 1);
    });
  });
  withWorktreeReadScope(() => assert.deepEqual(changedFiles(f.root), ['tracked.txt']));
});

test('an ambient alternate index is never replaced by the sanitized lifecycle observation', t => {
  const f = fixture(t), alternate = path.join(f.root, '.git', 'qualification-index');
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: f.root, env: { ...process.env, GIT_INDEX_FILE: alternate } });
  f.write('added.txt', 'alternate-index only\n');
  execFileSync('git', ['add', 'added.txt'], { cwd: f.root, env: { ...process.env, GIT_INDEX_FILE: alternate } });
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = alternate;
    const expected = changes(f.root);
    withWorktreeReadScope(() => {
      assert.equal(changes(f.root), expected);
      assert.match(expected, /A  added\.txt/u);
      assert.equal(worktreeStatusDetail(f.root).entries.find(value => value.path.value === 'added.txt').type, 'untracked');
    });
  } finally { if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous; }
});

test('a lagging Story index still takes the original exact parent/index verification route', t => {
  const f = fixture(t), name = 'singularity/work-items/fixture/workflow.json';
  mkdirSync(path.dirname(path.join(f.root, name)), { recursive: true }); f.write(name, '{"value":1}\n');
  f.git(['add', '.']); f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'First Story state']);
  f.write(name, '{"value":2}\n'); f.git(['add', '.']);
  f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Published Story state']);
  f.git(['read-tree', 'HEAD^']);
  withWorktreeReadScope(() => assert.deepEqual(storyIndexDrift(f.root, 'singularity/work-items/fixture'), [name]));
  assert.equal(readFileSync(path.join(f.root, name), 'utf8'), '{"value":2}\n');
});

test('draft-specific lookup uses literal paths and does not run broad diffs or change the index', async t => {
  const f = fixture(t), name = 'draft[1].md'; f.write(name, 'draft\n');
  f.git(['add', '.']); f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Draft']);
  const index = readFileSync(path.join(f.root, '.git', 'index'));
  f.write('draft1.md', 'not the selected draft\n');
  const timer = commandTimer('draft-observation');
  await withCommandTiming(timer, () => {
    assert.equal(pathHasChanges(f.root, name), false);
    f.write(name, 'authored draft\n'); assert.equal(pathHasChanges(f.root, name), true);
  });
  assert.deepEqual(readFileSync(path.join(f.root, '.git', 'index')), index);
  const counters = timer.finish().counters;
  assert.equal(counters['git.local.command.status'], 2);
  assert.equal(counters['git.local.command.diff'] ?? 0, 0);
  assert.equal(counters['git.local.command.ls-files'] ?? 0, 0);
  assert.throws(() => pathHasChanges(f.root, '../outside'));
});

test('draft-specific lookup is exact under host literal, glob and case-insensitive pathspec modes', t => {
  const f = fixture(t), name = 'draft[1].md'; f.write(name, 'draft\n');
  f.git(['add', '.']); f.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Draft']);
  f.write('draft1.md', 'not the selected draft\n');
  const keys = ['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      for (const clear of keys) delete process.env[clear];
      process.env[key] = '1';
      assert.equal(pathHasChanges(f.root, name), false, key);
    }
    f.write(name, 'authored draft\n');
    for (const key of keys) {
      for (const clear of keys) delete process.env[clear];
      process.env[key] = '1';
      assert.equal(pathHasChanges(f.root, name), true, key);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
