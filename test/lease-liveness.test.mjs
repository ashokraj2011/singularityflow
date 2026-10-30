/**
 * SDA M3: a lease is taken over only when its owner is proven dead (src/lease-liveness.mjs).
 *
 * Age used to decide: a live owner past its deadline (a laptop asleep, a long quality command whose
 * renewal fell behind) and every other machine's owner were taken over, putting a second writer
 * beside a live one. Each lease family below now follows the one predicate: a dead or recycled PID
 * is reclaimed, a live one never is, another machine's never is, and a person ends a lease nothing
 * here can prove abandoned only through a reviewed release of that exact generation.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LEASE_PROCESS_STARTED_AT, leaseOwnerAssessment, leaseOwnerIdentity, leaseOwnerState,
  localMachineId, machineIdFile, processStartTimeMs
} from '../src/lease-liveness.mjs';
import {
  acquireSubjectLock, activeSubjectLocks, assertNoActiveSubjectLocks, assertRepositoryResetAvailable,
  inspectSubjectLease, releaseLeaseAfterReview, releaseSubjectLock, releasedLeaseAuditPath,
  repositoryResetBarrierPath, subjectLockPath, withSubjectLock
} from '../src/subject-lock.mjs';
import { releaseRegistryLeaseAfterReview, withRegistryFileLease } from '../src/file-lease.mjs';
import { livePreparedPublicationOwner } from '../src/publication-pending.mjs';
import { openFilesystemAuthorityStore } from '../src/sgos/platform/authority-store.mjs';
import { platformSha256 } from '../src/sgos/platform/contracts.mjs';
import { run } from '../src/util.mjs';

const DEAD_PID = 2_147_483_647;
const HOURS_AGO = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lease-liveness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  return root;
}

/** Another live process on this machine, with the start time its own lease would record. */
async function liveProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const startedAt = processStartTimeMs(child.pid);
  assert.ok(Number.isFinite(startedAt), 'the process start-time probe reads a live process');
  return { child, pid: child.pid, processStartedAt: startedAt };
}

async function writeSubjectOwner(root, subject, owner, { heartbeatAt = null } = {}) {
  const directory = subjectLockPath(root, subject);
  await mkdir(directory, { recursive: true });
  const record = {
    schemaVersion: 1, subject, processToken: randomUUID(), lockToken: randomUUID(),
    acquiredAt: HOURS_AGO(5).toISOString(), expiresAt: HOURS_AGO(2).toISOString(), ...owner
  };
  await writeFile(path.join(directory, 'owner.json'), `${JSON.stringify(record)}\n`);
  if (heartbeatAt) {
    const heartbeat = path.join(directory, `heartbeat-${record.lockToken}`);
    await writeFile(heartbeat, '');
    await utimes(heartbeat, heartbeatAt, heartbeatAt);
  }
  return { directory, record };
}

test('the predicate: dead and recycled PIDs are dead, live ones alive, another machine unknown', async (t) => {
  assert.equal(machineIdFile(), path.resolve(process.env.SINGULARITY_FLOW_MACHINE_ID_FILE),
    'the suite redirects the machine ID out of the developer home');
  const machineId = localMachineId();
  assert.match(machineId, /^[0-9a-f-]{36}$/);
  assert.equal((await readFile(machineIdFile(), 'utf8')).trim(), machineId);

  const self = leaseOwnerIdentity();
  assert.equal(leaseOwnerState(self), 'alive');
  assert.equal(leaseOwnerState({ ...self, pid: DEAD_PID }), 'dead');
  // The current PID with a start long before this process began: the OS recycled it.
  const recycled = leaseOwnerAssessment({
    pid: process.pid, host: os.hostname(), machineId, processStartedAt: LEASE_PROCESS_STARTED_AT - 3_600_000
  });
  assert.deepEqual([recycled.state, recycled.reason], ['dead', 'process-id-reused']);
  // An older record has no start time; a running PID keeps it (fail closed).
  assert.equal(leaseOwnerState({ pid: process.pid, host: os.hostname() }), 'alive');

  const other = await liveProcess(t);
  assert.equal(leaseOwnerState({ pid: other.pid, host: os.hostname(), machineId, processStartedAt: other.processStartedAt }), 'alive');
  assert.equal(leaseOwnerState({ pid: other.pid, host: os.hostname(), machineId, processStartedAt: other.processStartedAt - 60_000 }), 'dead');

  // Another machine is unknown even when its PID means nothing here; a renamed host is still this one.
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: 'elsewhere.example', machineId: randomUUID() }), 'unknown');
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: os.hostname(), machineId: randomUUID() }), 'unknown');
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: 'renamed-host.example', machineId }), 'dead');
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: 'elsewhere.example' }), 'unknown',
    'a record without a machine ID compares by hostname');

  // A stale heartbeat is reported, never decisive.
  const stale = leaseOwnerAssessment(self, { heartbeatMtimeMs: Date.now() - 600_000, heartbeatTtlMs: 60_000 });
  assert.deepEqual([stale.state, stale.heartbeat], ['alive', 'stale']);
});

test('the start-time probe parses ps under a fixed locale and Windows start ticks', () => {
  const at = Date.parse('2026-10-29T10:00:00.000Z');
  // `ps -o lstart=` in the C locale: local time as "Thu Oct 29 15:30:00 2026".
  const [day, month, date, year, time] = new Date(at).toString().split(' ');
  let options;
  const ps = processStartTimeMs(900_001, {
    platform: 'darwin', now: 1,
    spawnSyncCommand: (_command, _args, value) => { options = value; return { status: 0, stdout: `${day} ${month} ${date} ${time} ${year}\n` }; }
  });
  assert.equal(options.env.LC_ALL, 'C');
  assert.equal(ps, at);
  const ticks = BigInt(at) * 10_000n + 621_355_968_000_000_000n;
  assert.equal(processStartTimeMs(900_002, {
    platform: 'win32', now: 1, spawnSyncCommand: () => ({ status: 0, stdout: `${ticks}\r\n` })
  }), at);
  assert.equal(processStartTimeMs(900_003, {
    platform: 'darwin', now: 1, spawnSyncCommand: () => ({ status: 1, stdout: '' })
  }), null);
});

test('a live subject-lock owner with a stale heartbeat is never reclaimed; a reviewed release ends it', async (t) => {
  const root = await repository(t);
  const subject = { kind: 'story', id: 'LIVE-STALE' };
  const other = await liveProcess(t);
  const { directory, record } = await writeSubjectOwner(root, subject, {
    pid: other.pid, host: os.hostname(), machineId: localMachineId(), processStartedAt: other.processStartedAt
  }, { heartbeatAt: HOURS_AGO(4) });

  await assert.rejects(() => acquireSubjectLock(root, subject, { ttlMs: 1 }), (error) => {
    assert.equal(error.code, 'SUBJECT_LOCK_BUSY');
    assert.equal(error.details.liveness.state, 'alive');
    assert.equal(error.details.liveness.heartbeat, 'stale');
    assert.match(error.message, new RegExp(`PID ${other.pid} on .* since ${record.acquiredAt}, last heartbeat .*\\(stale\\)`));
    assert.match(error.message, /stopped renewing/);
    assert.equal(error.details.releaseCommand,
      `singularity-flow lock release story LIVE-STALE --confirm ${record.lockToken}`);
    return true;
  });
  const [active] = await activeSubjectLocks(root);
  assert.equal(path.basename(active.directory), path.basename(directory));
  assert.deepEqual([active.liveness.state, active.liveness.heartbeat], ['alive', 'stale']);
  await assert.rejects(() => assertNoActiveSubjectLocks(root), (error) => error.code === 'FACTORY_RESET_ACTIVE_OPERATIONS'
    && error.message.includes(`lock release story LIVE-STALE --confirm ${record.lockToken}`));

  const released = await releaseLeaseAfterReview(root, subject, { expectedLockToken: record.lockToken });
  assert.equal(released.released, true);
  assert.equal(existsSync(directory), false);
  const audit = (await readFile(releasedLeaseAuditPath(root), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([audit.length, audit[0].lockToken, audit[0].owner.pid, audit[0].liveness.heartbeat],
    [1, record.lockToken, other.pid, 'stale']);
  const owner = await acquireSubjectLock(root, subject);
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
});

test('a live PID that started after the recorded owner, and a dead PID, are reclaimed', async (t) => {
  const root = await repository(t);
  const recycled = { kind: 'story', id: 'RECYCLED' };
  await writeSubjectOwner(root, recycled, {
    pid: process.pid, host: os.hostname(), processStartedAt: Date.parse('2001-01-01T00:00:00.000Z'),
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  });
  const first = await acquireSubjectLock(root, recycled);
  assert.equal(await releaseSubjectLock(root, recycled, first), true);

  const dead = { kind: 'story', id: 'DEAD' };
  const other = await liveProcess(t);
  await writeSubjectOwner(root, dead, {
    pid: other.pid, host: os.hostname(), machineId: localMachineId(), processStartedAt: other.processStartedAt,
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  }, { heartbeatAt: new Date() });
  await assert.rejects(() => acquireSubjectLock(root, dead), (error) => error.code === 'SUBJECT_LOCK_BUSY'
    && !error.details.releaseCommand && /freed when that command finishes/.test(error.message));
  other.child.kill('SIGKILL');
  await new Promise((resolve) => other.child.once('exit', resolve));
  const second = await acquireSubjectLock(root, dead);
  assert.equal(await releaseSubjectLock(root, dead, second), true);
});

test('another machine\'s lease is never reclaimed; the reviewed release removes exactly that generation', async (t) => {
  const root = await repository(t);
  const subject = { kind: 'story', id: 'REMOTE-1' };
  // Ancient, and its PID does not even exist here: neither proves anything about another machine.
  const { directory, record } = await writeSubjectOwner(root, subject, {
    pid: DEAD_PID, host: 'build-agent.example', machineId: randomUUID(),
    acquiredAt: '2001-01-01T00:00:00.000Z', expiresAt: '2001-01-01T03:00:00.000Z'
  }, { heartbeatAt: HOURS_AGO(24 * 365) });
  await assert.rejects(() => acquireSubjectLock(root, subject, { ttlMs: 0 }), (error) => {
    assert.equal(error.code, 'SUBJECT_LOCK_BUSY');
    assert.equal(error.details.liveness.state, 'unknown');
    assert.match(error.message, /PID 2147483647 on build-agent\.example \(machine [0-9a-f]{8}\) since 2001-01-01T00:00:00\.000Z, last heartbeat/);
    assert.match(error.message, /another machine/);
    assert.match(error.message, new RegExp(`singularity-flow lock release story REMOTE-1 --confirm ${record.lockToken}`));
    return true;
  });
  assert.equal((await activeSubjectLocks(root))[0]?.liveness.state, 'unknown',
    'factory reset sees an unknown writer as active');
  assert.equal((await inspectSubjectLease(root, subject)).releaseCommand,
    `singularity-flow lock release story REMOTE-1 --confirm ${record.lockToken}`);

  await assert.rejects(() => releaseLeaseAfterReview(root, subject, { expectedLockToken: randomUUID() }),
    (error) => error.code === 'SUBJECT_LOCK_RELEASE_MISMATCH');
  assert.equal(existsSync(path.join(directory, 'owner.json')), true, 'a mismatched release removes nothing');
  assert.equal((await releaseLeaseAfterReview(root, subject, { expectedLockToken: record.lockToken })).released, true);

  // The old token never reaches the successor generation.
  const successor = await acquireSubjectLock(root, subject);
  await assert.rejects(() => releaseLeaseAfterReview(root, subject, { expectedLockToken: record.lockToken }),
    (error) => error.code === 'SUBJECT_LOCK_RELEASE_MISMATCH');
  // A live owner here that still renews is refused even with its own token.
  await assert.rejects(() => releaseLeaseAfterReview(root, subject, { expectedLockToken: successor.lockToken }),
    (error) => error.code === 'SUBJECT_LOCK_RELEASE_REFUSED');
  assert.equal(await releaseSubjectLock(root, subject, successor), true);
  assert.equal((await releaseLeaseAfterReview(root, subject, { expectedLockToken: successor.lockToken })).reason,
    'already-released');
});

test('a hostname change keeps the machine; a different machine ID under the same hostname does not', async (t) => {
  const root = await repository(t);
  const renamed = { kind: 'story', id: 'RENAMED' };
  await writeSubjectOwner(root, renamed, { pid: DEAD_PID, host: 'old-name.local', machineId: localMachineId() });
  const owner = await acquireSubjectLock(root, renamed);
  assert.equal(await releaseSubjectLock(root, renamed, owner), true);

  const twin = { kind: 'story', id: 'TWIN' };
  await writeSubjectOwner(root, twin, { pid: DEAD_PID, host: os.hostname(), machineId: randomUUID() });
  await assert.rejects(() => acquireSubjectLock(root, twin), (error) => error.details?.liveness?.state === 'unknown');
});

test('a reset barrier from another machine blocks work until a reviewed release', async (t) => {
  const root = await repository(t);
  const barrier = repositoryResetBarrierPath(root);
  await mkdir(barrier, { recursive: true });
  const lockToken = randomUUID();
  await writeFile(path.join(barrier, 'owner.json'), `${JSON.stringify({
    schemaVersion: 1, subject: { kind: 'factory-reset-barrier', id: 'repository' }, pid: 17,
    host: 'elsewhere.example', machineId: randomUUID(), processToken: randomUUID(), lockToken,
    acquiredAt: '2001-01-01T00:00:00.000Z', expiresAt: '2001-01-01T03:00:00.000Z'
  })}\n`);
  await assert.rejects(() => assertRepositoryResetAvailable(root), (error) => error.code === 'FACTORY_RESET_IN_PROGRESS'
    && error.message.includes(`singularity-flow lock release factory-reset-barrier repository --confirm ${lockToken}`));
  await releaseLeaseAfterReview(root, { kind: 'factory-reset-barrier', id: 'repository' }, { expectedLockToken: lockToken });
  await assertRepositoryResetAvailable(root);
});

test('this process\'s own held lease is refused a reviewed release', async (t) => {
  const root = await repository(t);
  const subject = { kind: 'story', id: 'OWN' };
  await withSubjectLock(root, subject, async (owner) => {
    await assert.rejects(() => releaseLeaseAfterReview(root, subject, { expectedLockToken: owner.lockToken }),
      (error) => error.code === 'SUBJECT_LOCK_RELEASE_REFUSED');
  });
});

async function writeRegistryLease(lock, owner, mtime) {
  const token = randomUUID();
  await writeFile(lock, `${JSON.stringify({ ...owner, token, createdAt: mtime.toISOString() })}\n`, { mode: 0o600 });
  await utimes(lock, mtime, mtime);
  return token;
}

test('a registry lease of a live owner whose heartbeat stopped, or of another machine, is never reclaimed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-registry-liveness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'workspace.json');
  const lock = `${manifest}.lock`;
  await writeFile(manifest, '{}\n');
  const other = await liveProcess(t);
  const token = await writeRegistryLease(lock, {
    pid: other.pid, host: os.hostname(), machineId: localMachineId(), processStartedAt: other.processStartedAt,
    processToken: randomUUID()
  }, HOURS_AGO(1));
  await assert.rejects(() => withRegistryFileLease(manifest, async () => {
    throw new Error('a live owner must keep its registry lease');
  }, { timeoutMs: 200 }), (error) => {
    assert.equal(error.code, 'WORKSPACE_REGISTRY_BUSY');
    assert.deepEqual([error.details.liveness.state, error.details.liveness.heartbeat], ['alive', 'stale']);
    assert.match(error.message, new RegExp(`PID ${other.pid} on `));
    assert.match(error.message, new RegExp(`lock release-file .* --confirm ${token}`));
    return true;
  });
  const released = await releaseRegistryLeaseAfterReview(lock, { expectedToken: token });
  assert.equal(released.released, true);
  assert.equal(JSON.parse(await readFile(released.retainedAt, 'utf8')).token, token, 'the released lease is retained');
  let entered = false;
  await withRegistryFileLease(manifest, async () => { entered = true; });
  assert.equal(entered, true);

  const remote = await writeRegistryLease(lock, { pid: DEAD_PID, host: 'elsewhere.example', machineId: randomUUID() },
    HOURS_AGO(24));
  await assert.rejects(() => withRegistryFileLease(manifest, async () => {}, { timeoutMs: 200 }),
    (error) => error.code === 'WORKSPACE_REGISTRY_BUSY' && error.details.liveness.state === 'unknown');
  await assert.rejects(() => releaseRegistryLeaseAfterReview(lock, { expectedToken: randomUUID() }),
    (error) => error.code === 'WORKSPACE_REGISTRY_RELEASE_MISMATCH');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, remote);
});

test('a prepared publication journal follows the same predicate', async (t) => {
  const root = await repository(t);
  const subject = { kind: 'story', id: 'JOURNAL-1' };
  const pending = (owner) => ({
    journal: true,
    record: { recoveryStage: 'interrupted-before-branch-ref-advanced' },
    journalRecord: {
      stage: 'prepared', subject, commit: null, createdAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z',
      owner: { pid: owner.pid, processId: 'journal-test', host: owner.host, processToken: owner.processToken, lockToken: owner.lockToken }
    }
  });
  // Another machine's long-expired lease: still live, never declared interrupted.
  const remote = await writeSubjectOwner(root, subject, { pid: DEAD_PID, host: 'elsewhere.example', machineId: randomUUID() });
  assert.equal(livePreparedPublicationOwner(pending(remote.record), root)?.pid, DEAD_PID);
  await rm(remote.directory, { recursive: true });

  // A live owner here with a stale heartbeat: live.
  const other = await liveProcess(t);
  const live = await writeSubjectOwner(root, subject, {
    pid: other.pid, host: os.hostname(), machineId: localMachineId(), processStartedAt: other.processStartedAt
  }, { heartbeatAt: HOURS_AGO(4) });
  assert.equal(livePreparedPublicationOwner(pending(live.record), root)?.pid, other.pid);
  await rm(live.directory, { recursive: true });

  // A dead owner here with an unexpired lease: interrupted.
  const dead = await writeSubjectOwner(root, subject, {
    pid: DEAD_PID, host: os.hostname(), machineId: localMachineId(),
    acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  }, { heartbeatAt: new Date() });
  assert.equal(livePreparedPublicationOwner(pending(dead.record), root), null);
});

test('the SGOS Authority Store keeps a live owner whose heartbeat stopped', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-liveness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, 'store'), storeId: 'liveness-store' });
  const other = await liveProcess(t);
  const core = {
    lockFormat: 'sflow.sgos.authority-store-lock', lockVersion: 2, storeId: store.storeId, token: randomUUID(),
    host: os.hostname(), machineId: localMachineId(), pid: other.pid, processStartedAt: other.processStartedAt,
    acquiredAt: HOURS_AGO(2).toISOString(), expiresAt: HOURS_AGO(1).toISOString()
  };
  const lock = path.join(store.root, '.transaction-lock');
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ ...core, ownerSha256: platformSha256(core) }));
  const before = await store.read();
  await assert.rejects(() => store.transact({
    expectedRevision: before.revision, expectedStateSha256: before.recordSha256, actorId: 'operator-liveness',
    changes: [{ op: 'put', key: 'policy:unsafe', value: true }]
  }), (error) => error.code === 'SGOS_AUTHORITY_STORE_BUSY' && error.details.owner.liveness.state === 'alive'
    && error.details.owner.liveness.heartbeat === 'missing');
  assert.equal(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).token, core.token);
});
