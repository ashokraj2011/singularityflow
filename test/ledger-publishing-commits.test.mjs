/**
 * One history walk instead of one subprocess per intent file.
 *
 * Measured on a real repository: 420 `git log -1` calls inside a single snapshot, the largest
 * remaining share after the fetches came out. The cost was never the history walk — Git does that
 * quickly — it was spawning 420 processes to walk the same history 420 times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run } from '../src/util.mjs';
import { codeOnly } from './source-text.mjs';

test('the per-path git log is gone from the remote intent read', async () => {
  /**
   * A source check because the property is "how many processes", which no unit test observes.
   * `-1` with a pathspec is the shape that costs one spawn per path.
   */
  const { readFile } = await import('node:fs/promises');
  const source = codeOnly(await readFile(new URL('../src/ledger.mjs', import.meta.url), 'utf8'));
  assert.match(source, /'log', '--format=%H', '--name-only', ref/);
  assert.ok(!/'log',\s*'-1',\s*'--format=%H',\s*ref/.test(source),
    'a per-path log inside the intent loop is one subprocess per file');
});

test('the walk reports the newest commit that touched each path', async (t) => {
  /**
   * The equivalence that matters: `git log -1 -- <path>` returns the newest commit touching that
   * path, and first-mention-wins over a newest-first walk is the same answer.
   */
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root, allowFailure: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.test');
  git('config', 'user.name', 'Dev');

  await mkdir(path.join(root, 'singularity', 'ledger'), { recursive: true });
  const write = async (name, body) => writeFile(path.join(root, 'singularity', 'ledger', name), body);

  await write('a.json', '{"eventId":"a"}');
  git('add', '-A'); git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD').stdout.trim();

  await write('b.json', '{"eventId":"b"}');
  git('add', '-A'); git('commit', '-q', '-m', 'second');
  const second = git('rev-parse', 'HEAD').stdout.trim();

  // `a.json` changes again, so its newest commit moves forward while `b.json`'s does not.
  await write('a.json', '{"eventId":"a","v":2}');
  git('add', '-A'); git('commit', '-q', '-m', 'third');
  const third = git('rev-parse', 'HEAD').stdout.trim();

  const perPath = (file) =>
    git('log', '-1', '--format=%H', 'HEAD', '--', `singularity/ledger/${file}`).stdout.trim();

  // What the old code computed, one spawn at a time.
  assert.equal(perPath('a.json'), third);
  assert.equal(perPath('b.json'), second);
  assert.notEqual(first, third);

  // What one walk computes, parsed the way the fix parses it.
  const walked = git('log', '--format=%H', '--name-only', 'HEAD', '--', 'singularity').stdout;
  const commits = new Map();
  let commit = null;
  for (const line of walked.split('\n')) {
    const value = line.trim();
    if (!value) continue;
    if (/^[0-9a-f]{40}$/.test(value)) { commit = value; continue; }
    if (commit && !commits.has(value)) commits.set(value, commit);
  }
  assert.equal(commits.get('singularity/ledger/a.json'), perPath('a.json'));
  assert.equal(commits.get('singularity/ledger/b.json'), perPath('b.json'));
});
