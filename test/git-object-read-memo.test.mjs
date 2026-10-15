/**
 * Reads of objects named by full ID are answered once per process. `[perf]`
 *
 * A lifecycle command read the same blobs, the same `<commit>:<path>` resolutions and the same
 * exact-commit files several times; a Story walk repeated about 150 of them. An object's content
 * never changes, so the second read is answered from what Git already gave, while a symbolic name
 * (`HEAD`, a branch) still asks Git every time.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readLocalGitBlobs } from '../src/git-blob-batch.mjs';
import { committedFilesAtRevisions, exactFileAtObject } from '../src/git.mjs';

const source = (relative) => fileURLToPath(new URL(`../src/${relative}`, import.meta.url));

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-object-memo-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Object Memo Tester']);
  git(root, ['config', 'user.email', 'memo@example.invalid']);
  await writeFile(path.join(root, 'a.txt'), 'first a\n');
  await writeFile(path.join(root, 'b.txt'), 'first b\n');
  git(root, ['add', '.']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first']);
  return { root, first: git(root, ['rev-parse', 'HEAD']) };
}

/** Git processes `expression` started in a fresh process, with the probe on. */
function processes(root, expression) {
  const script = `const blobs = await import(${JSON.stringify(source('git-blob-batch.mjs'))});
const git = await import(${JSON.stringify(source('git.mjs'))}); ${expression};`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1', SINGULARITY_FLOW_GIT_FACT_STORE: 'off' }
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(/^subprocesses:\s+(\d+)\s+calls/m.exec(result.stderr)?.[1]);
}

test('a blob read twice is read once, as a copy, within the same limits', async (t) => {
  const { root } = await repository(t);
  const ids = ['a.txt', 'b.txt'].map((file) => git(root, ['rev-parse', `HEAD:${file}`]));
  const first = readLocalGitBlobs(root, ids);
  first.get(ids[0]).fill(0);
  const second = readLocalGitBlobs(root, ids);
  assert.equal(second.get(ids[0]).toString('utf8'), 'first a\n', 'a caller changing its bytes cannot change a later read');
  assert.equal(second.get(ids[1]).toString('utf8'), 'first b\n');
  assert.throws(() => readLocalGitBlobs(root, ids, { maximumObjectBytes: 3, code: 'TEST_LIMIT' }),
    (error) => error.code === 'TEST_LIMIT', 'a smaller limit is still refused');

  const once = processes(root, `blobs.readLocalGitBlobs(process.cwd(), ${JSON.stringify(ids)})`);
  const twice = processes(root, `blobs.readLocalGitBlobs(process.cwd(), ${JSON.stringify(ids)}); blobs.readLocalGitBlobs(process.cwd(), ${JSON.stringify(ids)})`);
  assert.equal(twice, once, 'the second read started no Git process');
});

test('a path at a full commit ID resolves once; a path at HEAD is asked every time', async (t) => {
  const { root, first } = await repository(t);
  const atFirst = [{ key: 'a', ref: first, path: 'a.txt' }];
  assert.equal(committedFilesAtRevisions(root, atFirst).get('a').toString('utf8'), 'first a\n');
  const atHead = [{ key: 'a', ref: 'HEAD', path: 'a.txt' }];
  assert.equal(committedFilesAtRevisions(root, atHead).get('a').toString('utf8'), 'first a\n');
  await writeFile(path.join(root, 'a.txt'), 'second a\n');
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'second']);
  assert.equal(committedFilesAtRevisions(root, atHead).get('a').toString('utf8'), 'second a\n', 'HEAD moved, and is read again');
  assert.equal(committedFilesAtRevisions(root, atFirst).get('a').toString('utf8'), 'first a\n', 'the commit ID still names the old bytes');
  assert.equal(exactFileAtObject(root, first, 'a.txt').toString('utf8'), 'first a\n');
  assert.equal(exactFileAtObject(root, first, 'a.txt', { maximumBytes: 3 }), null, 'a smaller limit asks Git and is refused as before');

  const request = JSON.stringify(atFirst);
  const once = processes(root, `git.committedFilesAtRevisions(process.cwd(), ${request})`);
  const twice = processes(root, `git.committedFilesAtRevisions(process.cwd(), ${request}); git.committedFilesAtRevisions(process.cwd(), ${request})`);
  assert.equal(twice, once, 'the repeated resolution and read started no Git process');
  const exactOnce = processes(root, `git.exactFileAtObject(process.cwd(), ${JSON.stringify(first)}, 'a.txt')`);
  const exactTwice = processes(root, `git.exactFileAtObject(process.cwd(), ${JSON.stringify(first)}, 'a.txt'); git.exactFileAtObject(process.cwd(), ${JSON.stringify(first)}, 'a.txt')`);
  assert.equal(exactTwice, exactOnce);
});
