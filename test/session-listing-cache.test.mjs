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
  assert.equal((await f.invoke()).packet.listingSnapshot.source, 'cache');
  assert.notEqual((await f.invoke({ options: ['--refresh'] })).child.status, 0);
});

test('session candidates and composed open reuse advisory listings; explicit refresh refuses with the real error', async t => {
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
  const refused = await f.invoke({ command: ['session', 'open'], options: ['--refresh', '--for-agent'] });
  assert.notEqual(refused.child.status, 0);
  assert.equal(refused.packet.error.code, 'SESSION_STATE_REFRESH_UNAVAILABLE', JSON.stringify(refused.packet));
  assert.notEqual(refused.packet.error.code, 'SESSION_OPEN_STEP_FAILED');
  assert.match(refused.packet.error.message, /REMOTE_|observation|fetch/u);
  assert.ok(refused.packet.error.remoteFailure?.failure?.classification);
  assert.equal(refused.packet.error.remoteFailure.stage, 'observation');
  assert.equal(refused.packet.error.remoteFailure.evidence.timedOut, false);
  const retry = await f.invoke();
  assert.notEqual(retry.child.status, 0, 'a failed explicit refresh invalidates the earlier success');
  assert.equal(retry.packet.error.code, refused.packet.error.code);
  t.diagnostic(JSON.stringify({ first: second.metrics, cached: hit.metrics }));
});

test('session listing shares configurable TTL and always/manual modes; invalidation and corrupt cache are safe', async t => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
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
  assert.equal((await invoke(oneMinute)).packet.listingSnapshot.source, 'fresh');
  const manual = { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: 'manual' };
  await invoke(manual); await invoke(manual);
  for (const name of files) {
    const file = path.join(directory, name), record = JSON.parse(await readFile(file, 'utf8'));
    record.checkedAt = Date.now() - 31 * 60_000;
    await writeFile(file, JSON.stringify(record));
  }
  assert.equal((await invoke(manual)).packet.listingSnapshot.source, 'cache');
  for (const name of files) await writeFile(path.join(directory, name), '{broken');
  assert.equal((await invoke(manual)).packet.listingSnapshot.source, 'fresh');
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
