/**
 * SDA M2 read index: serve last-known state and coalesce refreshes across processes (SDA §8,
 * SDA-AC-014 and SDA-AC-021). The projections are the existing repository-check records (ADR 0017).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cachedStoryIntakeCatalog, readRefreshAttempt, repositoryCheckStatus, withFreshRepositoryChecks } from '../src/repository-check-cache.mjs';
import { createStoryReadinessFixture } from '../scripts/story-readiness-benchmark.mjs';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const READER = fileURLToPath(new URL('./helpers/sda-index-reader.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-index-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'),
    SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(root, 'preferences.json'), SINGULARITY_FLOW_INDEX_REFRESH: 'off' };
  for (const name of ['SINGULARITY_FLOW_GIT_FACT_CACHE', 'SINGULARITY_FLOW_REPOSITORY_CHECK_MODE',
    'SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES']) delete env[name];
  const git = (args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe', encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Index tester']); git(['config', 'user.email', 'index@example.invalid']);
  const observed = path.join(root, 'observed.json'); await writeFile(observed, '{}\n');
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const directory = path.join(root, '.git/singularity-flow/cache/repository-checks');
  const record = async () => path.join(directory, (await readdir(directory)).find((name) => /^[a-f0-9]{64}\.json$/u.test(name)));
  const age = async (ms) => {
    const file = await record(); const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.checkedAt = Date.now() - ms; await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  };
  return { root, env, git, observed, record, age };
}

const unreachable = () => { throw new SingularityFlowError('Could not read from the remote.', { code: 'REMOTE_REMOTE_NOT_FOUND' }); };

test('an expired catalog is served at once as stale; a refresh the authority cannot answer keeps it with the real error', async (t) => {
  const f = await fixture(t);
  const read = (verify, identity = { catalog: 'sda' }) => cachedStoryIntakeCatalog(f.root, { identity, files: [f.observed], env: f.env }, verify);
  let calls = 0;
  const verified = async () => ({ choicesComplete: true, intake: { storyWorkflows: [] }, unreachable: [], n: ++calls });
  assert.equal((await read(verified)).n, 1);
  assert.equal(repositoryCheckStatus(f.root).freshness, 'fresh');
  assert.equal((await read(verified)).n, 1);
  assert.equal(repositoryCheckStatus(f.root).source, 'cache');

  await f.age(31 * 60_000);
  const stale = await read(unreachable);
  assert.equal(stale.n, 1, 'the verified record, without waiting on the authority');
  const status = repositoryCheckStatus(f.root);
  assert.equal(status.source, 'last-known'); assert.equal(status.freshness, 'stale');
  assert.equal(status.completeness, 'complete'); assert.equal(status.backgroundRefresh, 'off');

  // An explicit refresh disproves the record's dependencies; the authority is unreachable, so the
  // verified record stays as refresh-failed with the refusal it would have been.
  const kept = await withFreshRepositoryChecks(() => read(unreachable));
  assert.equal(kept.n, 1);
  assert.equal(repositoryCheckStatus(f.root).freshness, 'refresh-failed');
  assert.equal(repositoryCheckStatus(f.root).refreshError.code, 'REMOTE_REMOTE_NOT_FOUND');
  assert.equal(readRefreshAttempt(await f.record()).error.code, 'REMOTE_REMOTE_NOT_FOUND');
  // A later routine read refreshes again (the explicit check invalidated it) and keeps it again.
  assert.equal((await read(unreachable)).n, 1);
  assert.equal(repositoryCheckStatus(f.root).freshness, 'refresh-failed');

  // Only an unreachable authority leaves last-known state standing: any other refusal is the answer.
  await assert.rejects(withFreshRepositoryChecks(() => read(() => {
    throw new SingularityFlowError('No such workspace.', { code: 'WORKSPACE_NOT_FOUND' });
  })), { code: 'WORKSPACE_NOT_FOUND' });
  // A successful refresh replaces it and clears the kept error.
  assert.equal((await withFreshRepositoryChecks(() => read(verified))).n, 2);
  assert.equal(repositoryCheckStatus(f.root).freshness, 'fresh');
  assert.equal(readRefreshAttempt(await f.record()).error, null);
  assert.equal((await read(unreachable)).n, 2);
  assert.equal(repositoryCheckStatus(f.root).source, 'cache');

  // A record checked "in the future" (the clock moved back) is no record: nothing is served.
  await f.age(-60_000);
  await assert.rejects(read(unreachable), { code: 'REMOTE_REMOTE_NOT_FOUND' });
  // Never synchronized is not an empty inventory: with no record, the refusal stands.
  await assert.rejects(read(unreachable, { catalog: 'never-read' }), { code: 'REMOTE_REMOTE_NOT_FOUND' });
});

test('a last-known record never answers for another authority: a changed remote ends it (SDA §8)', async (t) => {
  const f = await fixture(t);
  const read = (verify) => cachedStoryIntakeCatalog(f.root, { identity: { catalog: 'authority' }, files: [f.observed], env: f.env }, verify);
  await read(async () => ({ choicesComplete: true, intake: { storyWorkflows: [] }, unreachable: [], n: 1 }));
  await f.age(31 * 60_000);
  assert.equal((await read(unreachable)).n, 1);
  assert.equal(repositoryCheckStatus(f.root).freshness, 'stale');
  f.git(['remote', 'add', 'origin', 'https://example.invalid/another.git']);
  // Neither served stale nor kept when the refresh fails: it was the answer of another authority.
  await assert.rejects(read(unreachable), { code: 'REMOTE_REMOTE_NOT_FOUND' });
  await assert.rejects(withFreshRepositoryChecks(() => read(unreachable)), { code: 'REMOTE_REMOTE_NOT_FOUND' });
});

function reader(f, counter, delay, failCode = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [READER, f.root, f.observed, counter, String(delay), ...(failCode ? [failCode] : [])],
      { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr, result: status === 0 ? JSON.parse(stdout) : null }));
  });
}

test('concurrent refreshes of one record in several processes share one authority observation (SDA-AC-014)', async (t) => {
  const f = await fixture(t);
  const counter = path.join(f.root, 'observations.log');
  const results = await Promise.all([reader(f, counter, 1500), reader(f, counter, 1500), reader(f, counter, 1500)]);
  for (const run of results) assert.equal(run.status, 0, run.stderr);
  const observations = (await readFile(counter, 'utf8')).trim().split('\n');
  assert.equal(observations.length, 1, `one observation, not ${observations.length}`);
  assert.deepEqual(new Set(results.map((run) => run.result.value.observedBy)), new Set([Number(observations[0])]));
  assert.deepEqual(results.map((run) => run.result.status.source).sort(), ['fresh', 'shared', 'shared']);
});

test('the intake catalog answers offline after expiry and after a failed refresh, and refreshes behind a stale answer', slowLane({ timeout: 300_000 }), async (t) => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  await f.invokeCatalog(); await f.invokeCatalog();
  assert.equal((await f.invokeCatalog()).metrics.snapshot, 'cache');
  const directory = path.join(f.original, '.git/singularity-flow/cache/repository-checks');
  const catalogRecord = async () => {
    for (const name of (await readdir(directory)).filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))) {
      const file = path.join(directory, name);
      if (JSON.parse(await readFile(file, 'utf8')).kind === 'story-intake-catalog') return file;
    }
    return null;
  };
  const expire = async () => {
    const file = await catalogRecord(); const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.checkedAt = Date.now() - 31 * 60_000; await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
    return stored.checkedAt;
  };
  // M0 measured this refusing with REMOTE_REMOTE_NOT_FOUND (benchmarks/sda/m0-qualification.md).
  await expire();
  await rename(f.remote, `${f.remote}.offline`);
  const stale = await f.invokeCatalog();
  assert.equal(stale.packet.readinessSnapshot.source, 'last-known');
  assert.equal(stale.packet.readinessSnapshot.freshness, 'stale');
  assert.equal(stale.metrics.remoteGitOperations, 0);
  const failed = await f.invokeCatalog({}, ['--refresh-readiness']);
  assert.equal(failed.packet.readinessSnapshot.freshness, 'refresh-failed');
  assert.match(failed.packet.readinessSnapshot.refreshError.code, /^REMOTE_|^SESSION_STATE_REFRESH_UNAVAILABLE$/u);
  assert.equal((await f.invokeCatalog()).packet.readinessSnapshot.freshness, 'refresh-failed');
  await rename(`${f.remote}.offline`, f.remote);

  // Back online: a fresh answer, then an expired one served at once while a replay refreshes it.
  assert.equal((await f.invokeCatalog({}, ['--refresh-readiness'])).packet.readinessSnapshot.freshness, 'fresh');
  const expiredAt = await expire();
  const behind = await f.invokeCatalog({ SINGULARITY_FLOW_INDEX_REFRESH: '' });
  assert.equal(behind.packet.readinessSnapshot.freshness, 'stale');
  assert.equal(behind.packet.readinessSnapshot.backgroundRefresh, 'started');
  const deadline = Date.now() + 120_000;
  let refreshed = null;
  while (Date.now() < deadline) {
    const stored = JSON.parse(await readFile(await catalogRecord(), 'utf8'));
    if (stored.checkedAt > expiredAt + 60_000) { refreshed = stored; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(refreshed, 'the replayed read refreshed the record');
  assert.equal(refreshed.refresh.argv.slice(0, 2).join(' '), 'workspace branches');
  assert.equal((await f.invokeCatalog()).metrics.snapshot, 'cache');
});

test('after initialization the Story list answers with Git and the network unavailable, starting no Git (SDA-AC-002)', slowLane({ timeout: 300_000 }), async (t) => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  await f.invoke(); await f.invoke();
  assert.equal((await f.invoke()).packet.listingSnapshot.source, 'cache');
  const directory = path.join(f.directory, 'cache/session-listings');
  for (const name of (await readdir(directory)).filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))) {
    const file = path.join(directory, name); const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.checkedAt = Date.now() - 31 * 60_000; await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  }
  await rename(f.remote, `${f.remote}.offline`);
  // No remote, and not one Git process started, so whether Git could run does not matter. (PATH is
  // part of a record's environment binding, so a different PATH is a different record by design.)
  for (let read = 0; read < 2; read += 1) {
    const listed = await f.invoke();
    assert.equal(listed.child.status, 0, listed.child.stderr + listed.child.stdout);
    assert.equal(listed.packet.listingSnapshot.freshness, 'stale');
    assert.equal(listed.packet.listingSnapshot.completeness, 'complete');
    assert.equal(listed.metrics.gitProcesses, 0, 'no Git process');
    assert.equal(listed.metrics.remoteOperations, 0, 'no network');
  }
});
