import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, rm, symlink, utimes } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireFileLease, inspectFileLease, releaseHeldFileLeasesSync,
  installFileLeaseSignalHandlers } from '../src/file-lease.mjs';

const MODULE = pathToFileURL(path.resolve('src/file-lease.mjs')).href;
const absent = (file) => lstat(file).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error; });
const owner = (pid, extra = {}) => ({ version: 2, pid, host: os.hostname(), nonce: randomUUID(),
  createdAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), ...extra });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-file-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, '.allocation.lock') };
}
async function exitedChild() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  return pid;
}
async function launchLeaseHolder(file, protectedOperation = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {acquireFileLease,installFileLeaseSignalHandlers} from ${JSON.stringify(MODULE)};
     installFileLeaseSignalHandlers(); const lease=await acquireFileLease(${JSON.stringify(file)});
     ${protectedOperation ? 'await lease.protect();' : ''}
     process.stdout.write('READY\\n'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lease holder did not become ready.')), 5000);
    child.once('error', reject);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Lease holder exited before readiness.')); });
  });
  return { child, exit };
}

test('cache leases have versioned owners and exact nonce/inode releases', async (t) => {
  const { file } = await fixture(t);
  const lease = await acquireFileLease(file);
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'heartbeatAt', 'host', 'nonce', 'pid', 'version']);
  assert.equal(record.version, 2); assert.equal(record.pid, process.pid);
  assert.equal(await lease.owns(), true);
  assert.deepEqual(await inspectFileLease(file), { state: 'busy', reason: 'live-owner' });
  assert.equal(await acquireFileLease(file), null);
  assert.equal(await lease.release(), true); assert.equal(await absent(file), true);
  assert.equal(await lease.release(), false);
});

test('failed acquisition stat closes its unpublished descriptor instead of leaking a cache owner', async (t) => {
  const { file } = await fixture(t);
  const original = fsPromises.open;
  const handles = [];
  let closed = 0;
  fsPromises.open = async (target, ...args) => {
    const handle = await original(target, ...args);
    if (target === file) {
      handles.push(handle);
      const close = handle.close.bind(handle);
      handle.close = async () => { closed += 1; return close(); };
      handle.stat = async () => { throw new Error('Fixture acquisition stat failed'); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireFileLease(file), /Fixture acquisition stat failed/);
    assert.equal(closed, 1, 'an acquired descriptor must be closed even before its inode can be proved');
  } finally {
    fsPromises.open = original; syncBuiltinESMExports();
    for (const handle of handles) await handle.close().catch(() => {});
  }
});

test('concurrent release cannot remove a successor acquired after the first release', async (t) => {
  const { file } = await fixture(t);
  const firstOwner = await acquireFileLease(file);
  const original = fsPromises.rm;
  let calls = 0;
  let resumeFirst; const firstGate = new Promise((resolve) => { resumeFirst = resolve; });
  let resumeSecond; const secondGate = new Promise((resolve) => { resumeSecond = resolve; });
  let firstEntered; const entered = new Promise((resolve) => { firstEntered = resolve; });
  fsPromises.rm = async (target, ...args) => {
    if (target === file) {
      calls += 1;
      if (calls === 1) { firstEntered(); await firstGate; }
      else if (calls === 2) await secondGate;
    }
    return original(target, ...args);
  };
  syncBuiltinESMExports();
  let successor;
  try {
    const firstRelease = firstOwner.release();
    await entered;
    let secondSettled = false;
    const secondRelease = firstOwner.release().finally(() => { secondSettled = true; });
    // The old implementation reaches the delayed second unlink; the corrected implementation
    // refuses or shares one terminal release. Do not depend on which valid idempotency form wins.
    const deadline = performance.now() + 500;
    while (calls < 2 && !secondSettled && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    resumeFirst(); assert.equal(await firstRelease, true);
    successor = await acquireFileLease(file); assert.ok(successor);
    resumeSecond(); await secondRelease;
    assert.equal(await successor.owns(), true,
      'an old owner may retire only one exact generation, not a newly acquired successor');
    assert.equal(calls, 1, 'concurrent callers share or refuse the terminal release instead of unlinking twice');
  } finally {
    resumeFirst(); resumeSecond(); fsPromises.rm = original; syncBuiltinESMExports();
    await successor?.release();
  }
});

test('old lease finalization cannot erase a successor frame from signal cleanup', async (t) => {
  const { file } = await fixture(t);
  const old = await acquireFileLease(file);
  releaseHeldFileLeasesSync();
  assert.equal(await absent(file), true);
  const successor = await acquireFileLease(file); assert.ok(successor);
  try {
    assert.equal(await old.release(), false);
    assert.equal(await successor.owns(), true);
    releaseHeldFileLeasesSync();
    assert.equal(await absent(file), true, 'the successor frame remains registered until its own cleanup');
  } finally { await successor.release(); }
});

test('signal cleanup cannot race a pending async release into unlinking a successor', async (t) => {
  const { file } = await fixture(t);
  const old = await acquireFileLease(file);
  const original = fsPromises.rm;
  let resume; const gate = new Promise((resolve) => { resume = resolve; });
  let entered; const ready = new Promise((resolve) => { entered = resolve; });
  fsPromises.rm = async (target, ...args) => {
    if (target === file) { entered(); await gate; }
    return original(target, ...args);
  };
  syncBuiltinESMExports();
  let successor;
  const release = old.release();
  try {
    await ready;
    releaseHeldFileLeasesSync();
    assert.equal(await absent(file), false,
      'signal cleanup must not independently unlink the generation already being asynchronously retired');
    assert.equal(await acquireFileLease(file), null,
      'a successor cannot enter between synchronous cleanup and the pending async unlink');
    resume(); assert.equal(await release, true);
    successor = await acquireFileLease(file); assert.ok(successor);
    assert.equal(await successor.owns(), true);
  } finally {
    resume(); await release.catch(() => {});
    fsPromises.rm = original; syncBuiltinESMExports();
    await successor?.release();
  }
});

test('a changed successor is never removed by async or signal release', async (t) => {
  const { file } = await fixture(t);
  const lease = await acquireFileLease(file);
  const successor = `${JSON.stringify(owner(process.pid))}\n`;
  await writeFile(file, successor, { mode: 0o600 });
  releaseHeldFileLeasesSync();
  assert.equal(await readFile(file, 'utf8'), successor);
  assert.equal(await lease.owns(), false);
  assert.equal(await lease.release(), false);
  assert.equal(await readFile(file, 'utf8'), successor);
});

test('proven dead owners are atomically retired before a guarded store rebuild', async (t) => {
  const { root, file } = await fixture(t);
  const pid = await exitedChild();
  await writeFile(file, JSON.stringify(owner(pid)), { mode: 0o600 });
  const store = path.join(root, 'store'); await mkdir(store); await writeFile(path.join(store, 'old'), 'old');
  assert.deepEqual(await inspectFileLease(file), { state: 'reclaimable', reason: 'dead-owner' });
  let callback = 0;
  const lease = await acquireFileLease(file, { onReclaimed: async ({ reason }) => {
    assert.equal(reason, 'dead-owner'); callback += 1;
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid, 'new ownership precedes store recovery');
    await rm(store, { recursive: true }); await mkdir(store);
  } });
  assert.equal(lease.reclaimed, true); assert.equal(callback, 1);
  assert.equal(await absent(path.join(store, 'old')), true);
  assert.equal(await lease.release(), true);
  // A second independent dead lease can reuse the existing validated reclaim helper directory.
  await writeFile(file, JSON.stringify(owner(pid)), { mode: 0o600 });
  const second = await acquireFileLease(file); assert.ok(second); await second.release();
});

test('age never reclaims a live owner, foreign owner or unconfirmed child quarantine', async (t) => {
  const { file } = await fixture(t); const pid = await exitedChild();
  const old = new Date(Date.now() - 60 * 60_000);
  for (const record of [owner(process.pid), owner(pid, { host: 'another-host.invalid' }),
    owner(pid, { quarantine: true, childPids: [], unknownChildren: true }),
    owner(pid, { quarantine: true, childPids: [process.pid], unknownChildren: false }),
    owner(pid, { quarantine: true })]) {
    await writeFile(file, JSON.stringify(record), { mode: 0o600 }); await utimes(file, old, old);
    const observed = await inspectFileLease(file, { staleMs: 1 });
    assert.equal(observed.state, 'busy');
    assert.equal(await acquireFileLease(file, { staleMs: 1 }), null);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
  }
});

test('known child quarantine reclaims only after every child and owner are provably dead', async (t) => {
  const { file } = await fixture(t); const pid = await exitedChild();
  await writeFile(file, JSON.stringify(owner(pid, { quarantine: true, childPids: [pid], unknownChildren: false })), { mode: 0o600 });
  assert.deepEqual(await inspectFileLease(file), { state: 'reclaimable', reason: 'dead-quarantine' });
  const lease = await acquireFileLease(file); assert.ok(lease); await lease.release();
});

test('only allocation-only old UUID acquisitions are age-reclaimable; cache operation legacy remains quarantined', async (t) => {
  const { file } = await fixture(t); const legacy = `${randomUUID()}\n`;
  await writeFile(file, legacy, { mode: 0o600 });
  assert.deepEqual(await inspectFileLease(file), { state: 'busy', reason: 'legacy-busy' });
  assert.equal(await acquireFileLease(file), null);
  const old = new Date(Date.now() - 16 * 60_000); await utimes(file, old, old);
  assert.deepEqual(await inspectFileLease(file, { legacyQuarantine: true }), { state: 'busy', reason: 'unknown-children' });
  assert.equal(await acquireFileLease(file, { legacyQuarantine: true }), null);
  assert.equal(await readFile(file, 'utf8'), legacy);
  const lease = await acquireFileLease(file);
  assert.ok(lease); assert.equal(lease.reclaimed, true); await lease.release();
});

test('protected operations survive signal cleanup until positive completion is acknowledged', async (t) => {
  const { file } = await fixture(t); const lease = await acquireFileLease(file);
  await lease.protect(); releaseHeldFileLeasesSync();
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.quarantine, true); assert.equal(record.unknownChildren, true);
  assert.equal(await lease.release(), false); assert.equal(await absent(file), false);
  await rm(file);
  const completed = await acquireFileLease(file); await completed.protect();
  assert.equal(await completed.release({ cleanupConfirmed: true }), true);
});

test('allocation contention waits at most its fixed allowance and never deletes the live lease', async (t) => {
  const { file } = await fixture(t); const lease = await acquireFileLease(file);
  const began = performance.now();
  assert.equal(await acquireFileLease(file, { waitMs: 250 }), null);
  assert.ok(performance.now() - began < 500, 'bounded wait excludes ordinary filesystem scheduling slack');
  assert.equal(await lease.owns(), true); await lease.release();
  await assert.rejects(acquireFileLease(file, { waitMs: 251 }), { code: 'FILE_LEASE_INVALID' });
});

test('unsafe lock paths and future versions cannot become abandoned leases', async (t) => {
  const { root, file } = await fixture(t); const target = path.join(root, 'target');
  await writeFile(target, JSON.stringify(owner(await exitedChild())), { mode: 0o600 });
  await symlink(target, file);
  assert.equal((await inspectFileLease(file)).state, 'unverifiable');
  assert.equal(await acquireFileLease(file), null); await rm(file);
  const future = { ...owner(await exitedChild()), version: 3 };
  await writeFile(file, JSON.stringify(future), { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60_000); await utimes(file, old, old);
  assert.equal((await inspectFileLease(file)).state, 'unverifiable');
  assert.equal(await acquireFileLease(file), null);
});

test('a rejected complete version-two owner is not mistaken for an old allocation UUID', async (t) => {
  const { file } = await fixture(t);
  const record = owner(process.pid, { futureField: true });
  const bytes = `${JSON.stringify(record)}\n`;
  await writeFile(file, bytes, { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60_000); await utimes(file, old, old);
  assert.equal((await inspectFileLease(file)).state, 'unverifiable');
  assert.equal(await acquireFileLease(file), null);
  assert.equal(await readFile(file, 'utf8'), bytes,
    'a still-live or unknown-format owner cannot be retired solely from its old modification time');
});

test('a truncated version-two owner is not age-reaped as a legacy allocation marker', async (t) => {
  const { file } = await fixture(t);
  const bytes = `{"version":2,"pid":${process.pid},"host":${JSON.stringify(os.hostname())},"nonce":`;
  await writeFile(file, bytes, { mode: 0o600 });
  const old = new Date(Date.now() - 60 * 60_000); await utimes(file, old, old);
  assert.equal((await inspectFileLease(file)).state, 'unverifiable');
  assert.equal(await acquireFileLease(file), null);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('signal handler ownership is reference counted and leaves embedding handlers intact', () => {
  const before = process.listenerCount('SIGTERM');
  const first = installFileLeaseSignalHandlers(); const second = installFileLeaseSignalHandlers();
  assert.equal(process.listenerCount('SIGTERM'), before || 1);
  first(); first(); assert.equal(process.listenerCount('SIGTERM'), before || 1);
  second(); assert.equal(process.listenerCount('SIGTERM'), before);
  const embedding = () => {};
  process.on('SIGTERM', embedding); const cleanup = installFileLeaseSignalHandlers(); cleanup();
  assert.equal(process.listeners('SIGTERM').includes(embedding), true); process.removeListener('SIGTERM', embedding);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) test(`actual ${signal} removes ordinary leases and preserves native signal exit`, {
  skip: process.platform === 'win32' ? 'POSIX signal exit fixture, not native Windows qualification.' : false
}, async (t) => {
  const { file } = await fixture(t); const { child, exit } = await launchLeaseHolder(file);
  t.after(() => child.kill('SIGKILL')); child.kill(signal);
  assert.deepEqual(await exit, { code: null, signal });
  assert.equal(await absent(file), true);
});

test('actual SIGTERM preserves protected operation quarantine; SIGKILL plain lease recovers immediately', {
  skip: process.platform === 'win32' ? 'POSIX process termination fixture, not native Windows qualification.' : false
}, async (t) => {
  const { file } = await fixture(t);
  const protectedHolder = await launchLeaseHolder(file, true); t.after(() => protectedHolder.child.kill('SIGKILL'));
  protectedHolder.child.kill('SIGTERM'); await protectedHolder.exit;
  assert.deepEqual(await inspectFileLease(file), { state: 'busy', reason: 'unknown-children' });
  assert.equal(await acquireFileLease(file), null); await rm(file);
  const normalHolder = await launchLeaseHolder(file); t.after(() => normalHolder.child.kill('SIGKILL'));
  normalHolder.child.kill('SIGKILL'); await normalHolder.exit;
  const began = performance.now(); const recovered = await acquireFileLease(file);
  assert.ok(recovered); assert.ok(performance.now() - began < 1000);
  assert.equal(recovered.reclaimed, true); await recovered.release();
});
