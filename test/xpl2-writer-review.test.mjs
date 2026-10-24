/**
 * Review fixes for XPL2 observed writes and line history: quoted blame paths, filtered blob bytes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { lineCommitAt, worktreeBytesAtRevision } from '../src/git.mjs';
import { git } from './helpers/xpl2-fixture.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Review Tester');
  git(root, 'config', 'user.email', 'review@example.test');
  return root;
}

test('blame paths with non-ASCII or special characters are unquoted before they are matched', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'données "x".js'), 'a\nb\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'first');
  await writeFile(path.join(root, 'données "x".js'), 'a\nB\n');
  git(root, 'commit', '-qam', 'second');
  const result = lineCommitAt(root, git(root, 'rev-parse', 'HEAD'), 'données "x".js', 2);
  assert.equal(result.filename, 'données "x".js');
  assert.equal(result.previous.path, 'données "x".js');
});

test('committed bytes are read as a checkout writes them, so CRLF and filters match disk', async (t) => {
  const root = await repository(t);
  git(root, 'config', 'core.autocrlf', 'true');
  await writeFile(path.join(root, 'a.txt'), 'one\r\ntwo\r\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'crlf');
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(worktreeBytesAtRevision(root, head, 'a.txt').toString('utf8'), 'one\r\ntwo\r\n');
  assert.equal(worktreeBytesAtRevision(root, head, 'missing.txt'), null);
});
