/**
 * SDA M3: a lease is taken over only when its owner is proven dead (src/lease-liveness.mjs).
 *
 * Age used to decide: a live owner past its deadline (a laptop asleep, a long quality command whose
 * renewal fell behind) and every other machine's owner were taken over, putting a second writer
 * beside a live one. Each lease family below now follows the one predicate: a dead or recycled PID
 * is reclaimed, a live one never is, another machine's never is, and a person ends a lease nothing
 * here can prove abandoned only through a reviewed release of that exact generation.
 *
 * Shared and restored homes carry one machine ID onto other process tables: a container sharing the
 * home sees another container's live PID as gone, and a home restored onto a new laptop sees the old
 * laptop's. A different PID namespace, or hardware other than the ID was confirmed on, is unknown.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEASE_PROCESS_STARTED_AT, leaseOwnerAssessment, leaseOwnerIdentity, leaseOwnerState,
  localMachineId, localPidNamespace, machineHardwareFile, machineHardwareId, machineIdFile, processStartTimeMs,
  setMachineHardwareProbeForTests
} from '../src/lease-liveness.mjs';
import {
  acquireSubjectLock, activeSubjectLocks, assertNoActiveSubjectLocks, assertRepositoryResetAvailable,
  inspectSubjectLease, releaseLeaseAfterReview, releaseSubjectLock, releasedLeaseAuditPath,
  repositoryResetBarrierPath, subjectLockPath, withSubjectLock
} from '../src/subject-lock.mjs';
import { releaseRegistryLeaseAfterReview, withRegistryFileLease } from '../src/file-lease.mjs';
import { activePublicationRefusal, livePreparedPublicationOwner } from '../src/publication-pending.mjs';
import { openFilesystemAuthorityStore } from '../src/sgos/platform/authority-store.mjs';
import { lockCommand } from '../src/commands/lock.mjs';
import { platformSha256 } from '../src/sgos/platform/contracts.mjs';
import { withMachineStateResetBarrier } from '../src/machine-state-reset.mjs';
import { run } from '../src/util.mjs';

const DEAD_PID = 2_147_483_647;
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/singularity-flow.mjs');

/** The real CLI, as a person runs it: `json` parses its output (a result, or a refusal envelope). */
function sflow(cwd, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}`, json: () => JSON.parse(result.stdout) };
}

/** A lease owner record from another computer: nothing here can prove it stopped. */
function remoteOwner(extra = {}) {
  return { pid: 4242, host: 'other-laptop.example', machineId: randomUUID(), processToken: randomUUID(),
    processStartedAt: Date.parse('2026-10-01T00:00:00.000Z'), ...extra };
}
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

/** A machine ID of this test's own, so replacing it never changes the one the rest of the run shares. */
async function ownMachineState(t, reads, hardware) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-identity-'));
  const previous = process.env.SINGULARITY_FLOW_MACHINE_ID_FILE;
  process.env.SINGULARITY_FLOW_MACHINE_ID_FILE = path.join(directory, 'machine-id');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_MACHINE_ID_FILE;
    else process.env.SINGULARITY_FLOW_MACHINE_ID_FILE = previous;
    setMachineHardwareProbeForTests(null);
    await rm(directory, { recursive: true, force: true });
  });
  setMachineHardwareProbeForTests(() => { reads.push(hardware.id); return hardware.id; });
  return directory;
}

async function reclaimDeadOwner(root, id, owner) {
  const subject = { kind: 'story', id };
  await writeSubjectOwner(root, subject, { pid: DEAD_PID, host: os.hostname(), ...owner });
  assert.equal(await releaseSubjectLock(root, subject, await acquireSubjectLock(root, subject)), true);
}

test('an owner in another PID namespace is never reclaimed, whatever its PID shows here', async (t) => {
  const here = 'pid:[4026531836]';
  const there = 'pid:[4026532415]';
  assert.equal(localPidNamespace({ platform: 'linux', readLink: () => here }), here);
  assert.equal(localPidNamespace({ platform: 'linux', readLink: () => { throw Object.assign(new Error('no /proc'), { code: 'ENOENT' }); } }), null);
  assert.equal(localPidNamespace({ platform: 'darwin', readLink: () => assert.fail('only Linux has /proc') }), null);
  const own = process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : undefined;
  assert.equal(leaseOwnerIdentity().pidNamespace, own, 'recorded where there is one, from a link read');
  assert.notEqual(own, there);

  const machineId = localMachineId();
  const owner = { pid: DEAD_PID, host: os.hostname(), machineId, pidNamespace: there };
  const other = leaseOwnerAssessment(owner, { pidNamespace: here });
  assert.deepEqual([other.state, other.reason, other.sameMachine], ['unknown', 'other-pid-namespace', false]);
  assert.equal(leaseOwnerState(owner, { pidNamespace: null }), 'unknown', 'a reader with no namespace cannot judge one either');
  assert.equal(leaseOwnerState({ ...owner, pidNamespace: here }, { pidNamespace: here }), 'dead');
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: os.hostname(), machineId }, { pidNamespace: here }), 'dead',
    'a record without a namespace (an older build, or not Linux) is judged by its PID as before');

  // Another container's lease, its heartbeat a day old: it waits for a person's reviewed release.
  const root = await repository(t);
  const subject = { kind: 'story', id: 'CONTAINER-1' };
  const { record } = await writeSubjectOwner(root, subject, owner, { heartbeatAt: HOURS_AGO(24) });
  await assert.rejects(() => acquireSubjectLock(root, subject, { ttlMs: 0 }), (error) => {
    assert.equal(error.code, 'SUBJECT_LOCK_BUSY');
    assert.deepEqual([error.details.liveness.state, error.details.liveness.reason], ['unknown', 'other-pid-namespace']);
    assert.equal(error.details.releaseCommand, `singularity-flow lock release story CONTAINER-1 --confirm ${record.lockToken}`);
    return true;
  });
  const manifest = path.join(root, 'workspace.json');
  await writeFile(manifest, '{}\n');
  await writeRegistryLease(`${manifest}.lock`, owner, HOURS_AGO(24));
  await assert.rejects(() => withRegistryFileLease(manifest, async () => {}, { timeoutMs: 200 }),
    (error) => error.code === 'WORKSPACE_REGISTRY_BUSY' && error.details.liveness.reason === 'other-pid-namespace');
});

test('a hostname change alone keeps the machine: the same hardware, the same ID, a dead owner reclaimed', async (t) => {
  const reads = [];
  await ownMachineState(t, reads, { id: 'HARDWARE-ONE' });
  const root = await repository(t);
  const machineId = localMachineId();
  await reclaimDeadOwner(root, 'BEFORE-RENAME', { machineId });
  await reclaimDeadOwner(root, 'RENAMED-HOST', { machineId, host: 'renamed-host.example' });
  assert.equal(localMachineId(), machineId);
  assert.deepEqual(reads, ['HARDWARE-ONE'], 'the hardware is read once per process');
  const recorded = (await readFile(machineHardwareFile(), 'utf8')).trim();
  assert.match(recorded, /^[0-9a-f]{64}$/u, 'a digest of the hardware is kept beside the machine ID');
  assert.ok(!recorded.includes('HARDWARE-ONE'), 'never the hardware ID itself');
});

test('a machine ID found on other hardware is replaced, and owners under the old one read as another machine\'s', async (t) => {
  const reads = [];
  const hardware = { id: 'HARDWARE-ONE' };
  await ownMachineState(t, reads, hardware);
  const root = await repository(t);
  const original = localMachineId();
  await reclaimDeadOwner(root, 'CONFIRMED', { machineId: original });
  const confirmedOn = (await readFile(machineHardwareFile(), 'utf8')).trim();

  // The same home restored onto another computer: a process there reads other hardware.
  hardware.id = 'HARDWARE-TWO';
  setMachineHardwareProbeForTests(() => { reads.push(hardware.id); return hardware.id; });
  const subject = { kind: 'story', id: 'RESTORED' };
  const { record } = await writeSubjectOwner(root, subject, { pid: DEAD_PID, host: os.hostname(), machineId: original });
  await assert.rejects(() => acquireSubjectLock(root, subject), (error) => {
    assert.equal(error.code, 'SUBJECT_LOCK_BUSY');
    assert.deepEqual([error.details.liveness.state, error.details.liveness.reason], ['unknown', 'machine-hardware-changed']);
    assert.match(error.message, /another machine/);
    assert.equal(error.details.releaseCommand, `singularity-flow lock release story RESTORED --confirm ${record.lockToken}`);
    return true;
  });
  const fresh = localMachineId();
  assert.notEqual(fresh, original);
  assert.match(fresh, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal((await readFile(machineIdFile(), 'utf8')).trim(), fresh, 'the new ID is kept for later processes');
  assert.notEqual((await readFile(machineHardwareFile(), 'utf8')).trim(), confirmedOn);
  assert.deepEqual(reads, ['HARDWARE-ONE', 'HARDWARE-TWO']);

  // Every owner under the old ID is now another machine's; new leases carry the new ID, reclaimed when dead.
  assert.equal(leaseOwnerAssessment({ pid: DEAD_PID, host: os.hostname(), machineId: original }).reason, 'other-machine');
  assert.equal(leaseOwnerIdentity().machineId, fresh);
  await reclaimDeadOwner(root, 'AFTER-MOVE', { machineId: fresh });
  assert.equal(reads.length, 2, 'the hardware is not read again');

  // A process still holding the ID another process replaced does not reclaim an owner under it.
  const replaced = randomUUID();
  await writeFile(machineIdFile(), `${replaced}\n`);
  assert.equal(leaseOwnerAssessment({ pid: DEAD_PID, host: os.hostname(), machineId: fresh }).reason, 'machine-hardware-changed');
  assert.equal(localMachineId(), replaced);

  // Another process finding the same move derives the same new ID, so concurrent processes agree.
  const second = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-identity-'));
  t.after(() => rm(second, { recursive: true, force: true }));
  process.env.SINGULARITY_FLOW_MACHINE_ID_FILE = path.join(second, 'machine-id');
  await writeFile(machineIdFile(), `${original}\n`);
  await writeFile(machineHardwareFile(), `${confirmedOn}\n`);
  assert.equal(leaseOwnerState({ pid: DEAD_PID, host: os.hostname(), machineId: original }), 'unknown');
  assert.equal(localMachineId(), fresh);
});

test('ordinary acquisition reads the hardware once per process; renewal and refusal never do', async (t) => {
  const reads = [];
  await ownMachineState(t, reads, { id: 'HARDWARE-ONE' });
  const root = await repository(t);
  const subject = { kind: 'story', id: 'ORDINARY' };
  await withSubjectLock(root, subject, async (owner) => {
    // A one-second lease (the shortest that renews) renews every 333 ms.
    const heartbeat = path.join(subjectLockPath(root, subject), `heartbeat-${owner.lockToken}`);
    const before = (await stat(heartbeat)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok((await stat(heartbeat)).mtimeMs > before, 'the lease was renewed');
    assert.equal(leaseOwnerState(owner), 'alive');
  }, { ttlMs: 1_000 });
  let entered = false;
  await withRegistryFileLease(path.join(root, 'workspace.json'), async () => { entered = true; });
  assert.equal(entered, true);

  // Refusals of a live owner here, another machine's and another namespace's read no hardware either.
  const other = await liveProcess(t);
  const machineId = localMachineId();
  for (const [id, owner] of [
    ['LIVE', { pid: other.pid, host: os.hostname(), machineId, processStartedAt: other.processStartedAt }],
    ['REMOTE', { pid: DEAD_PID, host: 'elsewhere.example', machineId: randomUUID() }],
    ['CONTAINER', { pid: DEAD_PID, host: os.hostname(), machineId, pidNamespace: 'pid:[4026532415]' }]
  ]) {
    const locked = { kind: 'story', id };
    await writeSubjectOwner(root, locked, owner, { heartbeatAt: new Date() });
    await assert.rejects(() => acquireSubjectLock(root, locked), (error) => error.code === 'SUBJECT_LOCK_BUSY');
  }
  // Read once, for the digest every owner record this process writes carries (two computers sharing
  // one home read one machine ID, so only the record can tell them apart).
  assert.deepEqual(reads, ['HARDWARE-ONE']);
});

test('a machine reset keeps the machine ID and the hardware it was confirmed on', async (t) => {
  const localStateRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-reset-'));
  t.after(() => rm(localStateRoot, { recursive: true, force: true }));
  const kept = await withMachineStateResetBarrier({ localStateRoot }, async ({ lockPaths }) => lockPaths);
  assert.ok(kept.has(path.resolve(machineIdFile())));
  assert.ok(kept.has(path.resolve(machineHardwareFile())));
});

test('the hardware read: Linux /etc/machine-id, the macOS platform UUID through the system ioreg', () => {
  const files = [];
  assert.equal(machineHardwareId({ platform: 'linux', readFile: (file) => { files.push(file); return `${'a1'.repeat(16)}\n`; } }), 'a1'.repeat(16));
  assert.deepEqual(files, ['/etc/machine-id']);
  assert.equal(machineHardwareId({ platform: 'linux', readFile: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } }), null);
  let call;
  const uuid = '0A1B2C3D-4E5F-6789-ABCD-EF0123456789';
  assert.equal(machineHardwareId({ platform: 'darwin', spawnSyncCommand: (command, args) => {
    call = [command, ...args];
    return { status: 0, stdout: `+-o Mac  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "${uuid}"\n    }\n` };
  } }), uuid);
  assert.deepEqual(call, ['/usr/sbin/ioreg', '-rd1', '-c', 'IOPlatformExpertDevice']);
  assert.equal(machineHardwareId({ platform: 'darwin', spawnSyncCommand: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(machineHardwareId({ platform: 'win32', spawnSyncCommand: () => assert.fail('not read on Windows') }), null);
  // This computer's own answer, as the real takeover path reads it.
  if (process.platform === 'darwin') assert.match(machineHardwareId(), /^[0-9A-F-]{36}$/u);
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

test('two computers sharing one home at the same time never take over each other\'s lease', async (t) => {
  // Computer B used to take computer A's live lease over once B had rotated the shared machine ID:
  // A's new owners carried that ID, A's PIDs were not in B's process table, and B's hardware matched
  // the shared record (D4). Each owner record now names the hardware it ran on.
  const reads = [];
  const hardware = { id: 'COMPUTER-A' };
  await ownMachineState(t, reads, hardware);
  const root = await repository(t);
  const onA = leaseOwnerIdentity();
  assert.match(onA.hardwareDigest, /^[0-9a-f]{16}$/u, 'a digest of the hardware, never the hardware ID');
  assert.ok(!JSON.stringify(onA).includes('COMPUTER-A'));
  const machineId = localMachineId();

  // B: the same machine ID, other hardware, and A's PID is not running here.
  setMachineHardwareProbeForTests(() => { reads.push('COMPUTER-B'); return 'COMPUTER-B'; });
  const fromA = { ...onA, pid: DEAD_PID };
  assert.deepEqual([leaseOwnerAssessment(fromA).state, leaseOwnerAssessment(fromA).reason], ['unknown', 'other-hardware']);
  const subject = { kind: 'story', id: 'SHARED-HOME' };
  const { record } = await writeSubjectOwner(root, subject, fromA);
  await assert.rejects(() => acquireSubjectLock(root, subject), (error) => {
    assert.equal(error.code, 'SUBJECT_LOCK_BUSY');
    assert.deepEqual([error.details.liveness.state, error.details.liveness.reason], ['unknown', 'other-hardware']);
    assert.equal(error.details.releaseCommand, `singularity-flow lock release story SHARED-HOME --confirm ${record.lockToken}`);
    assert.match(error.message, /Review it with: singularity-flow lock show story SHARED-HOME\./u);
    return true;
  });
  assert.equal(localMachineId(), machineId, 'nothing rotated the shared machine ID');
  const manifest = path.join(root, 'workspace.json');
  await writeFile(manifest, '{}\n');
  await writeRegistryLease(`${manifest}.lock`, fromA, HOURS_AGO(1));
  await assert.rejects(() => withRegistryFileLease(manifest, async () => {}, { timeoutMs: 200 }),
    (error) => error.code === 'WORKSPACE_REGISTRY_BUSY' && error.details.liveness.reason === 'other-hardware');
  await rm(`${manifest}.lock`);

  // Back on A: its own dead owner is its own, and is taken over as before.
  setMachineHardwareProbeForTests(() => 'COMPUTER-A');
  assert.equal(leaseOwnerState(fromA), 'dead');
  assert.equal(await releaseSubjectLock(root, subject, await acquireSubjectLock(root, subject)), true);
});

test('the lock command runs while another machine\'s reset barrier holds the repository, and ends it', async (t) => {
  // `lock release` was wrapped in the repository mutation lease, which met the barrier it was meant to
  // release: every command, the release included, refused with the same release command (D1).
  const root = await repository(t);
  run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  const barrier = repositoryResetBarrierPath(root);
  await mkdir(barrier, { recursive: true });
  const lockToken = randomUUID();
  await writeFile(path.join(barrier, 'owner.json'), `${JSON.stringify({ schemaVersion: 1,
    subject: { kind: 'factory-reset-barrier', id: 'repository' }, ...remoteOwner(), lockToken,
    acquiredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-01T03:00:00.000Z' })}\n`);
  const release = `singularity-flow lock release factory-reset-barrier repository --confirm ${lockToken}`;

  const refused = sflow(root, ['sync', '--json']);
  assert.equal(refused.status, 1, refused.out);
  const envelope = refused.json();
  assert.equal(envelope.error.code, 'FACTORY_RESET_IN_PROGRESS');
  assert.doesNotMatch(envelope.error.message, /Wait for it to finish/u);
  assert.match(envelope.error.message, /PID 4242 on other-laptop\.example/u);
  assert.equal(envelope.error.details.releaseCommand, release);
  assert.deepEqual(envelope.remediationPlan.steps.map((step) => step.command),
    [release, 'singularity-flow lock show factory-reset-barrier repository']);

  // Another lock's reviewed release runs while the barrier is up, and so does the barrier's own.
  const story = { kind: 'story', id: 'BARRIER-1' };
  const { record } = await writeSubjectOwner(root, story, remoteOwner());
  const storyRelease = sflow(root, ['lock', 'release', 'story', 'BARRIER-1', '--confirm', record.lockToken, '--json']);
  assert.equal(storyRelease.status, 0, storyRelease.out);
  assert.equal(storyRelease.json().released, true);
  const shown = sflow(root, ['lock', 'show', 'factory-reset-barrier', 'repository', '--json']);
  assert.equal(shown.status, 0, shown.out);
  assert.equal(shown.json().releaseCommand, release);
  const released = sflow(root, ['lock', 'release', 'factory-reset-barrier', 'repository', '--confirm', lockToken, '--json']);
  assert.equal(released.status, 0, released.out);
  assert.equal(released.json().released, true);
  assert.equal(existsSync(barrier), false, 'the barrier is gone');
  const after = sflow(root, ['sync', '--json']);
  assert.notEqual(JSON.parse(after.out.slice(after.out.indexOf('{'))).error?.code, 'FACTORY_RESET_IN_PROGRESS', after.out);
});

test('a lease named by its path is read and released from any folder; the selection refusal names both', async (t) => {
  // `workspace use` said "busy, retry" forever behind another machine's selection lease, `lock show`
  // could not read it, and `lock release-file` refused outside a Git repository (E1, D6).
  const folder = await mkdtemp(path.join(os.tmpdir(), 'sflow-lease-folder-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const selection = path.join(folder, 'active-workspace.json');
  const env = { SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(folder, 'workspaces.json') };
  const lease = `${selection}.lock`;
  const token = await writeRegistryLease(lease, remoteOwner(), HOURS_AGO(3));
  const release = `singularity-flow lock release-file ${JSON.stringify(lease)} --confirm ${token}`;

  const refused = sflow(folder, ['workspace', 'use', 'ABSENT', '--json'], env);
  assert.equal(refused.status, 1, refused.out);
  const envelope = refused.json();
  assert.equal(envelope.error.code, 'ACTIVE_WORKSPACE_SELECTION_BUSY');
  assert.doesNotMatch(envelope.error.message, /Retry/u);
  assert.match(envelope.error.message, /PID 4242 on other-laptop\.example/u);
  assert.ok(envelope.error.message.includes(`lock show-file ${JSON.stringify(lease)}`), envelope.error.message);
  assert.equal(envelope.error.details.releaseCommand, release);
  assert.equal(envelope.error.details.holder.host, 'other-laptop.example');
  assert.deepEqual(envelope.remediationPlan.steps.map((step) => step.argv), [
    ['lock', 'release-file', lease, '--confirm', token], ['lock', 'show-file', lease]]);

  const shown = sflow(folder, ['lock', 'show-file', lease, '--json'], env);
  assert.equal(shown.status, 0, shown.out);
  assert.deepEqual([shown.json().held, shown.json().owner.host, shown.json().releaseCommand], [true, 'other-laptop.example', release]);
  const mismatch = sflow(folder, ['lock', 'release-file', lease, '--confirm', randomUUID(), '--json'], env);
  assert.equal(mismatch.json().error.code, 'WORKSPACE_REGISTRY_RELEASE_MISMATCH');
  assert.deepEqual(mismatch.json().remediationPlan.steps[0].argv, ['lock', 'show-file', lease]);
  const released = sflow(folder, ['lock', 'release-file', lease, '--confirm', token, '--json'], env);
  assert.equal(released.status, 0, released.out);
  assert.equal(released.json().released, true);
  assert.equal(existsSync(lease), false);
  const after = sflow(folder, ['workspace', 'use', 'ABSENT', '--json'], env);
  assert.notEqual(JSON.parse(after.out.slice(after.out.indexOf('{'))).error?.code, 'ACTIVE_WORKSPACE_SELECTION_BUSY', after.out);
});

test('an Authority Store lock from another machine names its reviewed release, and the lock command ends it', async (t) => {
  // "Release exactly that lock after review" named no command, and the cutover lock had no release at
  // all: opening the store waited on it forever (E4/D5).
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storeId = 'cutover-store';
  const cutover = path.join(directory, `.authority-cutover-lock-${storeId}`);
  const token = randomUUID();
  const core = { lockFormat: 'sflow.sgos.authority-store-lock', lockVersion: 2, storeId, token, host: 'other-laptop.example',
    machineId: randomUUID(), pid: 4242, processStartedAt: 0, acquiredAt: HOURS_AGO(3).toISOString(), expiresAt: HOURS_AGO(2).toISOString() };
  await mkdir(cutover, { mode: 0o700 });
  await writeFile(path.join(cutover, 'owner.json'), JSON.stringify({ ...core, ownerSha256: platformSha256(core) }));
  const release = `singularity-flow lock release-file ${JSON.stringify(cutover)} --confirm ${token}`;
  await assert.rejects(() => openFilesystemAuthorityStore({ root: path.join(directory, storeId), storeId }), (error) => {
    assert.equal(error.code, 'SGOS_AUTHORITY_STORE_BUSY');
    assert.equal(error.details.releaseCommand, release);
    assert.ok(error.message.includes(`lock show-file ${JSON.stringify(cutover)}`), error.message);
    return true;
  });
  const shown = await lockCommand(['lock', 'show-file', cutover]);
  assert.deepEqual([shown.held, shown.owner.host, shown.liveness.state, shown.releaseCommand], [true, 'other-laptop.example', 'unknown', release]);
  await assert.rejects(() => lockCommand(['lock', 'release-file', cutover], { confirm: randomUUID() }),
    (error) => error.code === 'SGOS_AUTHORITY_LOCK_RELEASE_MISMATCH');
  const released = await lockCommand(['lock', 'release-file', cutover], { confirm: token });
  assert.equal(released.released, true);
  assert.equal(JSON.parse(await readFile(path.join(released.retainedAt, 'owner.json'), 'utf8')).token, token, 'retained for inspection');
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, storeId), storeId });

  // The transaction lock: the same route, through the path a refusal prints.
  const transaction = path.join(store.root, '.transaction-lock');
  const held = { ...core, token: randomUUID(), lockVersion: 3, pidNamespace: 'pid:[4026532415]', hardwareDigest: 'ab'.repeat(8) };
  delete held.ownerSha256;
  await mkdir(transaction, { mode: 0o700 });
  await writeFile(path.join(transaction, 'owner.json'), JSON.stringify({ ...held, ownerSha256: platformSha256(held) }));
  const before = await store.read();
  await assert.rejects(() => store.transact({ expectedRevision: before.revision, expectedStateSha256: before.recordSha256,
    actorId: 'operator-release', changes: [{ op: 'put', key: 'policy:held', value: true }] }), (error) => error.code === 'SGOS_AUTHORITY_STORE_BUSY'
    && error.details.releaseCommand === `singularity-flow lock release-file ${JSON.stringify(transaction)} --confirm ${held.token}`);
  assert.equal((await lockCommand(['lock', 'release-file', transaction], { confirm: held.token })).released, true);
  assert.equal((await store.transact({ expectedRevision: before.revision, expectedStateSha256: before.recordSha256,
    actorId: 'operator-release', changes: [{ op: 'put', key: 'policy:after', value: true }] })).revision, before.revision + 1);
});

test('a publication another machine holds names its owner and reviewed release; a live one here is waited for', async (t) => {
  // sync said "Return to that terminal" with no code and no machine, and every other mutation said
  // "wait": since SDA nothing takes another machine's lock over by age, so both looped (D3/E3).
  const root = await repository(t);
  const subject = { kind: 'story', id: 'HELD-1' };
  const pending = (owner) => ({
    journal: true,
    record: { recoveryStage: 'interrupted-before-branch-ref-advanced' },
    journalRecord: { stage: 'prepared', subject, commit: null, createdAt: '2026-10-01T00:00:00.000Z',
      owner: { pid: owner.pid, processId: 'held', host: owner.host, processToken: owner.processToken, lockToken: owner.lockToken } }
  });
  const remote = await writeSubjectOwner(root, subject, remoteOwner());
  const journal = pending(remote.record);
  const refusal = await activePublicationRefusal(root, journal, livePreparedPublicationOwner(journal, root),
    { what: 'Story \'HELD-1\'', retry: 'singularity-flow sync HELD-1', code: 'STORY_PUBLICATION_IN_PROGRESS' });
  assert.equal(refusal.code, 'STORY_PUBLICATION_IN_PROGRESS');
  assert.equal(refusal.details.releaseCommand, `singularity-flow lock release story HELD-1 --confirm ${remote.record.lockToken}`);
  assert.match(refusal.message, /PID 4242 on other-laptop\.example/u);
  assert.match(refusal.message, /Waiting does not end it\..*lock show story HELD-1\..*--confirm \S+\. Then run singularity-flow sync HELD-1 again\./u);
  assert.doesNotMatch(refusal.message, /Return to that terminal/u);
  await rm(remote.directory, { recursive: true });

  const other = await liveProcess(t);
  const live = await writeSubjectOwner(root, subject, { pid: other.pid, host: os.hostname(), machineId: localMachineId(),
    processStartedAt: other.processStartedAt }, { heartbeatAt: new Date() });
  const here = pending(live.record);
  const waiting = await activePublicationRefusal(root, here, livePreparedPublicationOwner(here, root),
    { what: 'Story \'HELD-1\'', retry: 'singularity-flow sync HELD-1', code: 'STORY_PUBLICATION_IN_PROGRESS' });
  assert.equal(waiting.details.releaseCommand, undefined);
  assert.match(waiting.message, new RegExp(`PID ${other.pid}.*Return to that terminal`, 'u'));
});
