import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { ledgerStoryPointers } from '../src/ledger.mjs';

test('the real ledger owner preserves a fetch deadline and makes no blind retry', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const oid = f.git(f.remote, 'rev-parse', 'refs/heads/state');
  const calls = [];
  await assert.rejects(ledgerStoryPointers(f.original, f.definition.ledger, { runGit: async args => {
    calls.push(args[0]);
    if (args[0] === 'ls-remote') return { status: 0, stdout: Buffer.from(`${oid}\trefs/heads/state\n`), stderr: Buffer.alloc(0) };
    assert.equal(args[0], 'fetch');
    return { status: null, signal: 'SIGTERM', timedOut: true, timeoutMs: 300000, stdout: '', stderr: '' };
  } }), error => {
    assert.equal(error.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
    assert.equal(error.details.remoteFailure.stage, 'fetch');
    assert.equal(error.details.remoteFailure.timeoutMs, 300000);
    assert.equal(error.details.remoteFailure.evidence.timedOut, true);
    assert.equal(error.details.remoteFailure.failure.classification, 'operation-timeout'); return true;
  });
  assert.deepEqual(calls, ['ls-remote', 'fetch']);
});

test('first listing can verify a retained local index without waiting for an unavailable remote', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  f.git(f.original, 'fetch', '--quiet', 'origin', 'refs/heads/state:refs/remotes/origin/state');
  await rename(f.remote, f.remote + '.offline');
  const local = await f.invoke();
  assert.equal(local.child.status, 0, local.child.stdout + local.child.stderr);
  assert.equal(local.packet.listingSnapshot.source, 'local');
  assert.equal(local.packet.listingSnapshot.remoteCheckedAt, null);
  assert.equal(local.packet.fetched, false);
  assert.equal(local.metrics.remoteOperations, 0);
  assert.match(local.child.stderr, /Using local Story listing.*remote checked at unavailable/u);
  assert.equal((await f.invoke()).packet.listingSnapshot.source, 'cache');
  // An explicit refresh the remote cannot answer keeps the verified listing beside the real error
  // instead of refusing (SDA-AC-021).
  const kept = await f.invoke({ options: ['--refresh'] });
  assert.equal(kept.child.status, 0, kept.child.stderr + kept.child.stdout);
  assert.equal(kept.packet.listingSnapshot.source, 'last-known');
  assert.equal(kept.packet.listingSnapshot.freshness, 'refresh-failed');
  assert.equal(kept.packet.listingSnapshot.refreshError.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
  assert.equal(kept.packet.fetched, false);
  assert.match(kept.child.stderr, /Using the last-known \(refresh failed: SESSION_STATE_REFRESH_UNAVAILABLE/u);
});

test('session candidates and composed open reuse advisory listings; a failed refresh keeps them with the real error', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  await f.invoke(); // First authority materialization can invalidate its pre-read observation.
  const second = await f.invoke();
  const hit = await f.invoke();
  assert.equal(hit.child.status, 0, hit.child.stderr + hit.child.stdout);
  assert.equal(hit.packet.listingSnapshot.source, 'cache');
  assert.equal(hit.packet.listingSnapshot.intervalMinutes, 30);
  assert.equal(hit.packet.listingSnapshot.advisory, true);
  assert.equal(hit.packet.fetched, false, 'a cached response must not claim this invocation fetched');
  assert.equal(hit.metrics.remoteOperations, 0);
  assert.ok(hit.metrics.gitProcesses <= 1, 'at most the native location fallback, never a roster rebuild');
  const chosen = await f.invoke({ command: ['session', 'open'] });
  assert.equal(chosen.child.status, 0, chosen.child.stderr + chosen.child.stdout);
  assert.equal(chosen.packet.status, 'choose'); assert.match(chosen.packet.table, /Listing: cache/u);
  // The successful preview is intentionally historical while the selected remote is offline.
  await rename(f.remote, f.remote + '.offline');
  assert.equal((await f.invoke()).packet.listingSnapshot.source, 'cache');
  // A refresh the remote cannot answer no longer refuses the listing: the verified one stays, marked
  // refresh-failed, with the real error beside it (SDA-AC-021).
  const kept = await f.invoke({ command: ['session', 'open'], options: ['--refresh', '--for-agent'] });
  assert.equal(kept.child.status, 0, kept.child.stderr + kept.child.stdout);
  assert.equal(kept.packet.status, 'choose', JSON.stringify(kept.packet));
  // The roster is Markdown, so the code's underscores are escaped.
  // The cause under the wrapper code, and its fix rather than another refresh when one cannot end it (A3).
  assert.match(kept.packet.table, /Listing: last-known \(refresh-failed: SESSION\\_STATE\\_REFRESH\\_UNAVAILABLE: REMOTE\\_[A-Z\\_]+\)/u);
  assert.match(kept.packet.table, /Verify the repository URL and your access to it, then retry\. Diagnose the connection with: singularity-flow workspace doctor --network\./u);
  assert.doesNotMatch(kept.packet.table, /Refresh with --refresh/u);
  // The explicit refresh disproved the earlier success: a routine read refreshes again, fails again,
  // and still answers from the verified listing with the diagnosis, never a fresh claim.
  const retry = await f.invoke();
  assert.equal(retry.child.status, 0, retry.child.stderr + retry.child.stdout);
  const snapshot = retry.packet.listingSnapshot;
  assert.equal(snapshot.source, 'last-known');
  assert.equal(snapshot.freshness, 'refresh-failed');
  assert.equal(snapshot.refreshError.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
  assert.match(snapshot.refreshError.message, /REMOTE_|observation|fetch/u);
  assert.ok(snapshot.refreshError.remoteFailure?.classification);
  assert.equal(snapshot.refreshError.remoteFailure.stage, 'observation');
  assert.equal(snapshot.refreshError.remoteFailure.timedOut, false);
  assert.equal(retry.packet.fetched, false);
  t.diagnostic(JSON.stringify({ first: second.metrics, cached: hit.metrics }));
});

test('session listing shares configurable TTL and always/manual modes; invalidation and corrupt cache are safe', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  // The expired read below says its refresh is off: the suite runner turns background refreshes off,
  // a bare `node --test` does not.
  f.env.SINGULARITY_FLOW_INDEX_REFRESH = 'off';
  const invoke = extra => f.invoke({ extra });
  await invoke(); await invoke();
  assert.equal((await invoke()).packet.listingSnapshot.source, 'cache');
  const always = { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'always' };
  assert.equal((await invoke(always)).packet.listingSnapshot.source, 'fresh');
  assert.equal((await invoke(always)).packet.listingSnapshot.source, 'fresh');
  const oneMinute = { SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES: '1' };
  await invoke(oneMinute); await invoke(oneMinute);
  const directory = path.join(f.directory, 'cache/session-listings');
  const files = (await readdir(directory)).filter(name => name.endsWith('.json'));
  for (const name of files) {
    const file = path.join(directory, name), record = JSON.parse(await readFile(file, 'utf8'));
    record.checkedAt = Date.now() - 61_000;
    await writeFile(file, JSON.stringify(record));
  }
  // Expired with nothing it depends on changed: served at once as stale, and refreshed behind it
  // (off in test runs, so the listing says so) instead of waiting on the remote (SDA-AC-021).
  const expired = (await invoke(oneMinute)).packet.listingSnapshot;
  assert.equal(expired.source, 'last-known');
  assert.equal(expired.freshness, 'stale');
  assert.equal(expired.backgroundRefresh, 'off');
  assert.equal(expired.completeness, 'complete');
  const manual = { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'manual' };
  await invoke(manual); await invoke(manual);
  for (const name of files) {
    const file = path.join(directory, name), record = JSON.parse(await readFile(file, 'utf8'));
    record.checkedAt = Date.now() - 31 * 60_000;
    await writeFile(file, JSON.stringify(record));
  }
  assert.equal((await invoke(manual)).packet.listingSnapshot.source, 'cache');
  for (const name of files) await writeFile(path.join(directory, name), '{broken');
  // A record that cannot be read counts as missing: the first read answers from the verified local
  // clone again instead of refusing offline (A1).
  assert.equal((await invoke(manual)).packet.listingSnapshot.source, 'local');
  f.git(f.original, 'config', 'sflow.test-cache-identity', 'changed');
  assert.equal((await invoke(manual)).packet.listingSnapshot.source, 'fresh', 'Git configuration invalidates a listing');
});

test('metadata-only URL listings reuse a distinct snapshot without creating application checkouts', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const query = () => f.invoke({ selectors: false, options: ['--repository-url', f.remote] });
  const first = await query(); assert.equal(first.child.status, 0, first.child.stderr + first.child.stdout);
  const hit = await query(); assert.equal(hit.child.status, 0, hit.child.stderr + hit.child.stdout);
  assert.equal(hit.packet.listingSnapshot.source, 'cache'); assert.equal(hit.metrics.remoteOperations, 0);
  assert.equal(hit.packet.repositoryPath, first.packet.repositoryPath);
});
