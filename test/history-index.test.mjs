import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HISTORY_INDEX_WRITE, historyIndexPresent, refreshHistoryIndex } from '../src/history-index.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function packedRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-history-index-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'History Index']);
  git(root, ['config', 'user.email', 'history@example.invalid']);
  for (let index = 0; index < 3; index += 1) {
    await writeFile(path.join(root, 'a.txt'), `${index}\n`);
    git(root, ['add', 'a.txt']);
    git(root, ['commit', '-q', '-m', `change ${index}`]);
  }
  git(root, ['repack', '-adq']);
  return root;
}

// The write runs in the test's own process instead of a detached worker, so its result is visible.
const writeNow = (root) => { git(root, HISTORY_INDEX_WRITE); return { pid: null }; };

test('a large history without changed-path filters gets them once; a small one is only looked at', async (t) => {
  const root = await packedRepository(t);
  const common = path.join(root, '.git');
  const launched = [];
  const launch = (directory) => { launched.push(directory); return writeNow(directory); };

  // Every test fixture is far below the default size, so a command pays only stat calls.
  assert.equal(refreshHistoryIndex(root, { env: {}, launch }).status, 'small');
  assert.deepEqual(launched, []);
  assert.equal(historyIndexPresent(common), false);

  const env = { SINGULARITY_FLOW_HISTORY_INDEX_MIN_PACK_BYTES: '1' };
  assert.equal(refreshHistoryIndex(root, { env, launch }).status, 'started');
  assert.deepEqual(launched, [root]);
  assert.equal(historyIndexPresent(common), true, 'every commit-graph layer now carries changed-path filters');
  assert.match(JSON.parse(await readFile(path.join(common, 'singularity-flow', 'history-index.json'), 'utf8')).startedAt, /^\d{4}-/u);
  assert.equal(refreshHistoryIndex(root, { env, launch }).status, 'present');
  assert.equal(launched.length, 1);

  // The filters change how fast Git answers, never what it answers.
  assert.equal(git(root, ['log', '--format=%H', '--diff-filter=A', '--reverse', '--', 'a.txt']),
    git(root, ['rev-list', '--max-parents=0', 'HEAD']));
});

test('a plain commit graph is replaced; a recent attempt, shallow clones, left-out trees and the switch are skipped', async (t) => {
  const root = await packedRepository(t);
  const common = path.join(root, '.git');
  const env = { SINGULARITY_FLOW_HISTORY_INDEX_MIN_PACK_BYTES: '1' };
  git(root, ['commit-graph', 'write', '--reachable', '--split']);
  assert.equal(historyIndexPresent(common), false, 'a commit graph without filters is a gap');

  let launches = 0;
  const now = Date.parse('2026-10-13T12:00:00Z');
  const pending = () => { launches += 1; return { pid: null }; };
  assert.equal(refreshHistoryIndex(root, { env: { ...env, SINGULARITY_FLOW_HISTORY_INDEX: 'off' }, now, launch: pending }).status, 'off');
  assert.equal(refreshHistoryIndex(root, { env, now, launch: pending }).status, 'started');
  // The worker is still writing: the next commands do not start another one.
  assert.equal(refreshHistoryIndex(root, { env, now: now + 60_000, launch: pending }).status, 'started-recently');
  assert.equal(launches, 1);
  assert.equal(refreshHistoryIndex(root, { env, now: now + 2 * 60 * 60 * 1000, launch: writeNow }).status, 'started');
  assert.equal(historyIndexPresent(common), true);

  const partial = await packedRepository(t);
  git(partial, ['config', 'remote.origin.partialclonefilter', 'tree:0']);
  assert.equal(refreshHistoryIndex(partial, { env, launch: pending }).status, 'trees-left-out');
  const shallow = await packedRepository(t);
  await writeFile(path.join(shallow, '.git', 'shallow'), `${git(shallow, ['rev-parse', 'HEAD'])}\n`);
  assert.equal(refreshHistoryIndex(shallow, { env, launch: pending }).status, 'shallow');
  assert.equal(launches, 1);
  assert.equal(refreshHistoryIndex(path.join(os.tmpdir(), 'sflow-no-such-repository'), { env }).status, 'not-a-repository');
});
