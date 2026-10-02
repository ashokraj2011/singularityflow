import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exactChangedPathsBetweenObjects } from '../src/git.mjs';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-exact-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(root, 'source with spaces.txt'), 'before');
  git(root, ['add', '--', 'source with spaces.txt']);
  git(root, ['commit', '-qm', 'before']);
  const before = git(root, ['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'source with spaces.txt'), 'after');
  git(root, ['add', '--', 'source with spaces.txt']);
  git(root, ['commit', '-qm', 'after']);
  return { root, before, after: git(root, ['rev-parse', 'HEAD']) };
}

test('exact changed paths preserve names and distinguish a genuinely empty comparison', async t => {
  const { root, before, after } = await fixture(t);
  assert.deepEqual(exactChangedPathsBetweenObjects(root, before, after), ['source with spaces.txt']);
  assert.deepEqual(exactChangedPathsBetweenObjects(root, after, after), []);
});

test('exact changed paths ignore replace refs and caller-selected indexes', async t => {
  const { root, before, after } = await fixture(t);
  git(root, ['replace', after, before]);
  assert.equal(git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', before, after]), '');
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = path.join(root, 'nonexistent-index');
  try {
    assert.deepEqual(exactChangedPathsBetweenObjects(root, before, after), ['source with spaces.txt']);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test('exact changed paths refuse symbolic selectors and missing objects, never treating them as clean', async t => {
  const { root, before, after } = await fixture(t);
  for (const invalid of ['HEAD', '--all', `${after}~1`, after.slice(0, 8)]) {
    assert.throws(() => exactChangedPathsBetweenObjects(root, before, invalid), /full object IDs/u);
  }
  assert.throws(() => exactChangedPathsBetweenObjects(root, before, '0'.repeat(40)), { code: 'GIT_READ_UNAVAILABLE' });
});
