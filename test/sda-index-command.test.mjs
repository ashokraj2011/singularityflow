/**
 * `index status|refresh|rebuild|verify` (SDA §14, M2) over a real Story-listing fixture: the
 * commands see, refresh and rebuild the advisory projections, keep last-known state when the remote
 * cannot answer, and never touch anything outside the index (SDA-AC-003).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const BIN = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('index status, refresh, verify and rebuild work on the advisory projections only', slowLane({ timeout: 300_000 }), async (t) => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const index = (...args) => {
    const child = spawnSync(process.execPath, [BIN, 'index', ...args, '--json'], {
      cwd: f.original, env: f.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024
    });
    let result = null; try { result = JSON.parse(child.stdout); } catch { /* the refusal is in stderr */ }
    return { child, result };
  };

  // Never synchronized: no projection, and the explicit first action.
  const empty = index('status');
  assert.equal(empty.child.status, 0, empty.child.stderr);
  assert.equal(empty.result.resultType, 'sflow-index-status');
  assert.deepEqual(empty.result.projections, []);
  assert.equal(empty.result.firstSynchronization, 'singularity-flow index refresh');

  // The first refresh runs the first lists of this repository.
  const first = index('refresh');
  assert.equal(first.child.status, 0, first.child.stderr);
  assert.deepEqual(first.result.firstReads.map((item) => [item.read, item.outcome]),
    [['session candidates', 'synchronized'], ['workspace branches', 'synchronized']]);
  await f.invoke(); await f.invoke();
  const status = index('status').result;
  const reads = status.projections.filter((item) => item.replayable).map((item) => item.read).sort();
  assert.ok(reads.includes('session candidates') && reads.includes('workspace branches'), JSON.stringify(status.projections));
  for (const item of status.projections) assert.equal(item.integrity, 'verified');
  assert.deepEqual(status.pendingOperations.pushes, []);

  // Offline: every refresh fails and every record keeps its last-known state with the real error.
  await rename(f.remote, `${f.remote}.offline`);
  const offline = index('refresh').result;
  assert.ok(offline.refreshed.length >= 2);
  for (const item of offline.refreshed) {
    assert.equal(item.outcome, 'refresh-failed', JSON.stringify(item));
    assert.equal(item.kept, 'last-known');
  }
  const failed = index('status').result.projections.filter((item) => item.replayable);
  for (const item of failed) {
    assert.equal(item.freshness, 'refresh-failed');
    assert.ok(item.lastRefreshError.code);
  }
  assert.equal((await f.invoke()).child.status, 0, 'the Story list still answers');
  await rename(`${f.remote}.offline`, f.remote);

  // Verify: every record checks out; a corrupted one is found, and verify exits non-zero.
  const verified = index('verify', '--authority');
  assert.equal(verified.child.status, 0, verified.child.stderr);
  assert.equal(verified.result.ok, true);
  for (const item of verified.result.checked.filter((entry) => entry.authority)) {
    assert.ok(['matches', 'changed'].includes(item.authority), JSON.stringify(item));
  }
  const directory = path.join(f.original, '.git/singularity-flow/cache/repository-checks');
  const victim = (await readdir(directory)).find((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  await writeFile(path.join(directory, victim), '{"format":1,"broken":', { mode: 0o600 });
  const corrupt = index('verify');
  assert.equal(corrupt.child.status, 1);
  assert.equal(corrupt.result.ok, false);
  assert.equal(corrupt.result.repair, 'singularity-flow index rebuild');

  // Rebuild discards what cannot be verified, refreshes the rest, and touches nothing else.
  const journal = path.join(f.original, '.git/singularity-flow/publications/kept.json');
  await mkdir(path.dirname(journal), { recursive: true });
  await writeFile(journal, '{"kept":true}\n');
  const draft = path.join(f.original, '.git/singularity-flow/configuration-drafts/draft.json');
  await mkdir(path.dirname(draft), { recursive: true });
  await writeFile(draft, '{"draft":true}\n');
  const rebuilt = index('rebuild');
  assert.equal(rebuilt.child.status, 0, rebuilt.child.stderr);
  assert.ok(rebuilt.result.rebuilt.some((item) => item.record === victim && item.outcome === 'discarded'));
  assert.ok(rebuilt.result.rebuilt.filter((item) => item.kind === 'session-listing' || item.kind === 'story-intake-catalog')
    .every((item) => item.outcome === 'refreshed'), JSON.stringify(rebuilt.result.rebuilt));
  assert.equal(await readFile(journal, 'utf8'), '{"kept":true}\n');
  assert.equal(await readFile(draft, 'utf8'), '{"draft":true}\n');
  assert.equal(index('verify').result.ok, true);
  assert.equal((await f.invoke()).child.status, 0);
});

test('index refuses an unknown subcommand or option', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'sflow-index-refusal-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd });
  const run = (...args) => spawnSync(process.execPath, [BIN, 'index', ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.match(run('compact').stderr, /Unknown index subcommand 'compact'/u);
  assert.match(run('status', '--authority').stderr, /index status does not accept --authority/u);
});
