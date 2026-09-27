import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  CAPABILITY_AUTHORITY_LINK_PATH, createCapabilityAuthorityLink, readCapabilityAuthorityLink
} from '../src/capability-authority-link.mjs';
import { GitRemoteSession, runRemoteGitAsync } from '../src/git-execution.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { readRecord } from '../src/schema-migrations.mjs';
import { run } from '../src/util.mjs';

async function fixture(t, { fileUrl = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-negative-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, 'repository');
  const cache = path.join(root, 'cache');
  await mkdir(repository);
  run('git', ['init', '-q', '-b', 'state'], { cwd: repository });
  run('git', ['config', 'user.name', 'Local test'], { cwd: repository });
  run('git', ['config', 'user.email', 'local@example.invalid'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), '# local state fixture\n');
  run('git', ['add', '-A'], { cwd: repository });
  run('git', ['commit', '-qm', 'state without link'], { cwd: repository });
  const env = { ...process.env, SINGULARITY_FLOW_AUTHORITY_CACHE: cache };
  const remote = fileUrl ? pathToFileURL(repository).href : repository;
  const observations = [];
  const transfers = [];
  const read = () => readCapabilityAuthorityLink(remote, {
    env,
    remoteSession: new GitRemoteSession({ env, async runAsyncCommand(args, options) {
      observations.push(args);
      return runRemoteGitAsync(args, options);
    } }),
    async runRemoteCommand(args, options) {
      transfers.push(args);
      return runRemoteGitAsync(args, options);
    }
  });
  return { root, repository, remote, cache, env, read, observations, transfers };
}

test('negative authority link is exact-state cached, freshly observed, and invalidated by a new state tip', async (t) => {
  const f = await fixture(t);
  const first = await f.read();
  assert.equal(first.status, 'missing');
  assert.equal(f.transfers.filter((args) => args.includes('fetch')).length, 1);
  const second = await f.read();
  assert.equal(second.status, 'missing');
  assert.equal(second.stateCommit, first.stateCommit);
  assert.equal(f.observations.length, 2, 'each invocation still observes current remote state');
  assert.equal(f.transfers.length, 1, 'warm missing link does not fetch another state pack');
  const receiptName = (await readdir(f.cache)).find((name) => name.endsWith('.json'));
  const receipt = JSON.parse(await readFile(path.join(f.cache, receiptName), 'utf8'));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.status, 'missing');
  assert.equal(receipt.link, null);
  assert.equal(receipt.stateCommit, first.stateCommit);
  const link = createCapabilityAuthorityLink({
    authorityRemote: f.repository, repositoryRemote: f.repository, capabilityIds: ['application']
  });
  await mkdir(path.join(f.repository, 'singularity'));
  await writeFile(path.join(f.repository, CAPABILITY_AUTHORITY_LINK_PATH), canonicalJson(link));
  run('git', ['add', '-A'], { cwd: f.repository });
  run('git', ['commit', '-qm', 'add routing link'], { cwd: f.repository });
  const current = await f.read();
  assert.equal(current.status, 'current');
  assert.notEqual(current.stateCommit, first.stateCommit);
  assert.deepEqual(current.link.subject.capabilityIds, ['application']);
  assert.equal(f.observations.length, 3);
  assert.equal(f.transfers.length, 2);
});

test('corrupt cache receipt is rebuilt from complete exact local objects, not trusted or transferred twice', async (t) => {
  const f = await fixture(t);
  await f.read();
  const receiptName = (await readdir(f.cache)).find((name) => name.endsWith('.json'));
  await writeFile(path.join(f.cache, receiptName), '{"status":"missing","forged":true}');
  const current = await f.read();
  assert.equal(current.status, 'missing');
  assert.equal(f.observations.length, 2);
  assert.equal(f.transfers.length, 1);
  const repaired = JSON.parse(await readFile(path.join(f.cache, receiptName), 'utf8'));
  assert.equal(repaired.stateCommit, current.stateCommit);
  const core = { ...repaired }; delete core.cacheSha256;
  assert.equal(repaired.cacheSha256, `sha256:${recordSha256(core)}`);
});

test('v1 cache migration verifies source integrity and never rewrites or invents absence', () => {
  const core = { schemaVersion: 1, kind: 'capability-authority-cache-entry', repositoryIdentity: 'local',
    stateBranch: 'state', stateCommit: 'a'.repeat(40), link: { preserved: true } };
  const old = { ...core, cacheSha256: `sha256:${recordSha256(core)}` };
  const source = canonicalJson(old);
  const result = readRecord('capability-authority-cache-entry', source);
  assert.equal(result.storedVersion, 1);
  assert.equal(result.record.schemaVersion, 2);
  assert.equal(result.record.status, 'current');
  assert.deepEqual(result.record.link, old.link);
  assert.equal(canonicalJson(old), source);
  const migratedCore = { ...result.record }; delete migratedCore.cacheSha256;
  assert.equal(result.record.cacheSha256, `sha256:${recordSha256(migratedCore)}`);
  assert.throws(() => readRecord('capability-authority-cache-entry', {
    ...old, stateCommit: 'b'.repeat(40)
  }), (error) => error.code === 'SCHEMA_MIGRATION_SOURCE_CORRUPT');
});

async function retainedStore(f) {
  const name = (await readdir(f.cache)).find((entry) => /^[a-f0-9]{64}$/.test(entry));
  assert.ok(name, 'the fixture retained exactly its private identity-keyed object store');
  return path.join(f.cache, name);
}

for (const [label, poison] of [
  ['timeout', { timedOut: true }], ['abort', { aborted: true }],
  ['overflow', { outputOverflow: true }], ['blocked', { blocked: true }],
  ['signal', { signal: 'SIGTERM' }], ['execution error', { error: new Error('Fixture execution outcome unknown') }]
]) {
  test(`status-zero ${label} fetch cannot create absence evidence; quarantine is bypassed without reuse`, async (t) => {
    const f = await fixture(t);
    const result = await readCapabilityAuthorityLink(f.repository, {
      env: f.env,
      async runRemoteCommand(args, options) {
        assert.ok(await lstat(`${options.cwd}.incomplete`), 'quarantine is present before dispatch');
        const completed = await runRemoteGitAsync(args, options);
        assert.equal(completed.status, 0);
        return { ...completed, ...poison };
      }
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.link, null);
    const store = await retainedStore(f);
    assert.ok(await lstat(path.join(store, 'HEAD')));
    assert.ok(await lstat(`${store}.incomplete`));
    assert.equal((await readdir(f.cache)).some((name) => name.endsWith('.json')), false);
    const retry = await f.read();
    assert.equal(retry.status, 'missing');
    assert.equal(retry.failure, null);
    assert.equal(f.transfers.length, 1, 'one-off fallback reads a different private store');
    assert.ok(await lstat(`${store}.incomplete`), 'fallback does not remove an unconfirmed store');
  });
}

test('an existing valid negative receipt cannot bypass quarantine through the leased cache-hit path', async (t) => {
  const f = await fixture(t);
  await f.read();
  const store = await retainedStore(f);
  const receipt = (await readdir(f.cache)).find((name) => name.endsWith('.json'));
  const before = await readFile(path.join(f.cache, receipt));
  await writeFile(`${store}.incomplete`, 'Fixture interrupted owner\n');
  const result = await f.read();
  assert.equal(result.status, 'missing');
  assert.equal(result.failure, null);
  assert.equal(f.transfers.length, 2);
  assert.deepEqual(await readFile(path.join(f.cache, receipt)), before);
  assert.ok(await lstat(path.join(store, 'HEAD')));
});

test('a completed non-zero fetch leaves the store retryable rather than inventing unknown cleanup', async (t) => {
  const f = await fixture(t);
  const failed = await readCapabilityAuthorityLink(f.repository, {
    env: f.env, async runRemoteCommand() { return { status: 128, stdout: '', stderr: 'Fixture refused transfer' }; }
  });
  assert.equal(failed.status, 'unavailable');
  const store = await retainedStore(f);
  await assert.rejects(lstat(`${store}.incomplete`), { code: 'ENOENT' });
  assert.equal((await f.read()).status, 'missing');
  assert.equal(f.transfers.length, 1);
});

test('a rejected transfer after dispatch preserves its pre-published operation quarantine', async (t) => {
  const f = await fixture(t);
  const refusedScratch = [];
  t.after(async () => {
    // This runner throws without creating a child. The production owner cannot infer that from
    // an opaque rejection, but the fixture can remove its explicitly recorded private scratch.
    for (const scratch of refusedScratch) {
      await rm(scratch, { recursive: true, force: true });
      await rm(`${scratch}.incomplete`, { force: true });
    }
  });
  const result = await readCapabilityAuthorityLink(f.repository, {
    env: f.env, async runRemoteCommand(_args, options) {
      if (!options.cwd.startsWith(f.root)) refusedScratch.push(options.cwd);
      throw new Error('Fixture lost acknowledgement');
    }
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.failure.code, 'CAPABILITY_AUTHORITY_CACHE_OPERATION_UNCONFIRMED');
  const store = await retainedStore(f);
  assert.ok(await lstat(`${store}.incomplete`));
  assert.equal((await f.read()).status, 'missing');
  assert.equal(f.transfers.length, 1);
});

test('poisoned status-zero local tree output is refused before absence caching and preserves quarantine', async (t) => {
  const f = await fixture(t);
  const original = childProcess.spawnSync;
  let poisoned = 0;
  childProcess.spawnSync = (command, args, options) => {
    const result = original(command, args, options);
    if (args.includes('ls-tree') && String(options.cwd).includes(path.join(path.basename(f.root), 'cache'))) {
      poisoned += 1;
      const error = new Error('Fixture local child outcome unknown');
      error.code = 'ETIMEDOUT';
      return { ...result, status: 0, error };
    }
    return result;
  };
  syncBuiltinESMExports();
  let result;
  try { result = await f.read(); }
  finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
  assert.equal(poisoned, 1);
  assert.equal(result.status, 'missing', 'unconfirmed cache-local read uses verified one-off fallback');
  const store = await retainedStore(f);
  assert.ok(await lstat(`${store}.incomplete`));
  assert.equal((await readdir(f.cache)).some((name) => name.endsWith('.json')), false);
  assert.equal((await f.read()).status, 'missing');
  assert.equal(f.transfers.length, 3);
});

test('unknown scratch fetch keeps its store when a successor replaces the quarantine marker', async (t) => {
  const f = await fixture(t);
  let scratch;
  t.after(async () => {
    // This callback injects an unknown result only after a real child has completed. No live child
    // remains in this fixture; production must still preserve the reported unknown owner.
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      await rm(`${scratch}.incomplete`, { recursive: true, force: true });
    }
  });
  const result = await readCapabilityAuthorityLink(f.repository, {
    env: { ...f.env, SINGULARITY_FLOW_AUTHORITY_CACHE: 'off' },
    async runRemoteCommand(args, options) {
      scratch = options.cwd;
      const completed = await runRemoteGitAsync(args, options);
      assert.equal(completed.status, 0);
      await unlink(`${scratch}.incomplete`);
      await mkdir(`${scratch}.incomplete`);
      return { ...completed, timedOut: true };
    }
  });
  assert.equal(result.status, 'unavailable');
  assert.ok(await lstat(path.join(scratch, 'HEAD')));
  assert.equal((await lstat(`${scratch}.incomplete`)).isDirectory(), true,
    'the owner must not overwrite or delete a successor marker');
});

test('failed quarantine publication refuses before any Git work in the private store', async (t) => {
  const f = await fixture(t);
  const original = fsPromises.open;
  let refused = 0;
  fsPromises.open = async (file, ...args) => {
    if (String(file).startsWith(f.cache) && String(file).endsWith('.incomplete')) {
      refused += 1;
      const error = new Error('Fixture marker publication denied');
      error.code = 'EACCES';
      throw error;
    }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  let result;
  try { result = await f.read(); }
  finally { fsPromises.open = original; syncBuiltinESMExports(); }
  assert.equal(refused, 1);
  assert.equal(result.status, 'missing');
  assert.equal(result.failure, null);
  assert.equal(f.transfers.length, 1);
  assert.equal((await readdir(f.cache)).some((name) => /^[a-f0-9]{64}$/.test(name)), false,
    'initialization and quota Git work require persisted quarantine');
});

test('known completion does not remove an in-place successor marker or publish a cache receipt', async (t) => {
  const f = await fixture(t);
  let store;
  const replacement = 'Fixture successor owns this quarantine\n';
  const result = await readCapabilityAuthorityLink(f.repository, {
    env: f.env,
    async runRemoteCommand(args, options) {
      const completed = await runRemoteGitAsync(args, options);
      assert.equal(completed.status, 0);
      if (options.cwd.startsWith(f.cache)) {
        store = options.cwd;
        await writeFile(`${store}.incomplete`, replacement);
      }
      return completed;
    }
  });
  assert.equal(result.status, 'missing');
  assert.equal(result.failure, null);
  assert.equal(await readFile(`${store}.incomplete`, 'utf8'), replacement);
  assert.equal((await readdir(f.cache)).some((name) => name.endsWith('.json')), false);
  assert.equal((await f.read()).status, 'missing');
  assert.equal(f.transfers.length, 1);
});

async function completedChildPid() {
  const child = childProcess.spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await once(child, 'exit');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}

function fixtureOwner(pid) {
  const now = new Date().toISOString();
  return { version: 2, pid, host: os.hostname(), nonce: randomUUID(), createdAt: now, heartbeatAt: now };
}

for (const status of ['missing', 'current']) {
  test(`file fixture ${status} link bypasses a live-owner cache marker without touching its store`, async (t) => {
    const f = await fixture(t, { fileUrl: true });
    if (status === 'current') {
      const link = createCapabilityAuthorityLink({
        authorityRemote: f.remote, repositoryRemote: f.remote, capabilityIds: ['application']
      });
      await mkdir(path.join(f.repository, 'singularity'));
      await writeFile(path.join(f.repository, CAPABILITY_AUTHORITY_LINK_PATH), canonicalJson(link));
      run('git', ['add', '-A'], { cwd: f.repository });
      run('git', ['commit', '-qm', 'routing fixture'], { cwd: f.repository });
    }
    const first = await f.read();
    assert.equal(first.status, status);
    const store = await retainedStore(f);
    const marker = `${store}.incomplete`;
    const owner = `${JSON.stringify(fixtureOwner(process.pid))}\n`;
    await writeFile(marker, owner);
    await writeFile(path.join(store, 'live-owner-sentinel'), 'must remain\n');
    const bypass = await f.read();
    const uncached = await readCapabilityAuthorityLink(f.remote, {
      env: { ...f.env, SINGULARITY_FLOW_AUTHORITY_CACHE: 'off' }
    });
    assert.deepEqual(bypass, uncached, 'derived-cache state must not change the verified link result');
    assert.equal(await readFile(marker, 'utf8'), owner);
    assert.equal(await readFile(path.join(store, 'live-owner-sentinel'), 'utf8'), 'must remain\n');
    assert.equal(f.transfers.length, 2, 'busy cache immediately takes a separate one-off path');
  });
}

test('dead-owner authority marker is reclaimed and its store is moved aside before an exact rebuild', async (t) => {
  const f = await fixture(t, { fileUrl: true });
  await f.read();
  const store = await retainedStore(f);
  await writeFile(path.join(store, 'dead-owner-sentinel'), 'retained not reused\n');
  await writeFile(`${store}.incomplete`, `${JSON.stringify(fixtureOwner(await completedChildPid()))}\n`);
  const result = await f.read();
  assert.equal(result.status, 'missing');
  await assert.rejects(lstat(`${store}.incomplete`), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(store, 'dead-owner-sentinel')), { code: 'ENOENT' });
  const retired = (await readdir(f.cache)).find((name) => name.startsWith(`${path.basename(store)}.retained-`));
  assert.ok(retired, 'old store was not deleted and did not become the new evidence store');
  assert.equal(await readFile(path.join(f.cache, retired, 'dead-owner-sentinel'), 'utf8'), 'retained not reused\n');
  assert.equal(f.transfers.length, 2, 'reclaimed store is rebuilt rather than reading old objects');
  assert.equal((await f.read()).status, 'missing');
  assert.equal(f.transfers.length, 2, 'rebuilt cache admits exact verified receipt');
});

for (const age of ['young', 'old']) {
  test(`${age} legacy UUID authority marker cannot hide the readable link`, async (t) => {
    const f = await fixture(t, { fileUrl: true });
    await f.read();
    const store = await retainedStore(f);
    const marker = `${store}.incomplete`;
    await writeFile(marker, `${randomUUID()}\n`);
    if (age === 'old') {
      const before = new Date(Date.now() - 16 * 60 * 1000);
      await utimes(marker, before, before);
    }
    assert.equal((await f.read()).status, 'missing');
    assert.ok(await lstat(marker), `${age} legacy operation has no trusted child-death evidence`);
  });
}

test('legacy unknown-child quarantine stays preserved even when old; readable link uses one-off fallback', async (t) => {
  const f = await fixture(t, { fileUrl: true });
  await f.read();
  const store = await retainedStore(f);
  const marker = `${store}.incomplete`;
  const bytes = `Authority object-store operation completion unconfirmed: ${randomUUID()}\n`;
  await writeFile(marker, bytes);
  const before = new Date(Date.now() - 16 * 60 * 1000);
  await utimes(marker, before, before);
  assert.equal((await f.read()).status, 'missing');
  assert.equal(await readFile(marker, 'utf8'), bytes,
    'age alone is not proof that an unrecorded child/process tree exited');
  assert.ok(await lstat(path.join(store, 'HEAD')));
});

for (const childState of ['unknown', 'live']) {
  test(`dead owner with ${childState} child evidence is not reclaimed by age or fallback`, async (t) => {
    const f = await fixture(t, { fileUrl: true });
    await f.read();
    const store = await retainedStore(f);
    const marker = `${store}.incomplete`;
    const before = new Date(Date.now() - 16 * 60 * 1000);
    const owner = {
      ...fixtureOwner(await completedChildPid()), quarantine: true,
      childPids: childState === 'live' ? [process.pid] : [], unknownChildren: childState === 'unknown',
      createdAt: before.toISOString(), heartbeatAt: before.toISOString()
    };
    const bytes = `${JSON.stringify(owner)}\n`;
    await writeFile(marker, bytes);
    await utimes(marker, before, before);
    await writeFile(path.join(store, 'child-owned-sentinel'), 'keep exact store\n');
    assert.equal((await f.read()).status, 'missing');
    assert.equal(await readFile(marker, 'utf8'), bytes);
    assert.equal(await readFile(path.join(store, 'child-owned-sentinel'), 'utf8'), 'keep exact store\n');
  });
}
