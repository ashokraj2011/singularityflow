/**
 * Whether the process that recorded a lease is still running: one rule for every lease family.
 *
 * A lease is taken over only when its owner is proven dead. Age never decides for a recorded owner:
 * an expired deadline is what a laptop asleep for an afternoon, or a two-hour quality command whose
 * renewal fell behind, looks like, and taking that lease over put a second writer beside a live one.
 *
 * - Same machine, PID gone (ESRCH): dead.
 * - Same machine, PID running but started more than 2 s after the recorded start: dead, the OS
 *   recycled the PID. The recorded start comes from the owner itself (`Date.now() - uptime`), which
 *   is never earlier than the kernel start, so only "later" can mean a different process.
 * - Same machine, PID running and the start matches or cannot be read (EPERM included): alive.
 * - Another machine: unknown. Nothing here can prove that process stopped, so only a person's
 *   reviewed release ends the lease.
 *
 * Same machine means the same `machineId` (a random ID kept in machine state, so it survives a
 * hostname change); records without one, or a machine whose ID file cannot be written, compare by
 * hostname as before. A stale heartbeat is reported, never acted on.
 */
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PID_REUSE_TOLERANCE_MS = 2_000;
const START_PROBE_CACHE_MS = 5_000;
const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
// The ps/PowerShell date is parsed, so its locale must be fixed; TZ still applies.
const PROBE_LOCALE = Object.freeze({ LC_ALL: 'C', LC_TIME: 'C', LANG: 'C' });

/** This process's own start, as every lease it writes records it (whole seconds, like `ps`). */
export const LEASE_PROCESS_STARTED_AT = Math.max(
  0, Math.round((Date.now() - process.uptime() * 1_000) / 1_000) * 1_000
);
/** One token per loaded copy of this module: a lease carrying it is this process's own. */
export const LEASE_PROCESS_TOKEN = randomUUID();

export function machineIdFile(env = process.env) {
  return env.SINGULARITY_FLOW_MACHINE_ID_FILE
    ? path.resolve(env.SINGULARITY_FLOW_MACHINE_ID_FILE)
    : path.join(os.homedir(), '.singularity-flow', 'machine-id');
}

const machineIds = new Map();

function readMachineId(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return MACHINE_ID.test(text) ? text : null;
  } catch { return null; }
}

function createMachineId(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const pending = `${file}.${randomUUID()}.pending`;
  writeFileSync(pending, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 });
  try {
    // A hard link publishes complete bytes without replacing a concurrent creator's ID.
    try { linkSync(pending, file); }
    catch (error) {
      if (error?.code === 'EEXIST') return;
      try { writeFileSync(file, readFileSync(pending), { flag: 'wx', mode: 0o600 }); }
      catch (fallbackError) { if (fallbackError?.code !== 'EEXIST') throw fallbackError; }
    }
  } finally { try { unlinkSync(pending); } catch { /* a leftover pending file is inert */ } }
}

/** This machine's ID, created once; null when machine state cannot hold one (compare by hostname). */
export function localMachineId(env = process.env) {
  const file = machineIdFile(env);
  if (machineIds.has(file)) return machineIds.get(file);
  let id = readMachineId(file);
  if (!id && !existsSync(file)) {
    try { createMachineId(file); }
    catch {
      // A read-only home compares by hostname for the rest of this process.
      machineIds.set(file, null);
      return null;
    }
    id = readMachineId(file);
  }
  // A half-written ID (a concurrent creator's fallback write) is read again next time.
  if (id) machineIds.set(file, id);
  return id;
}

/** The identity fields every new lease owner record carries. */
export function leaseOwnerIdentity() {
  const machineId = localMachineId();
  return {
    pid: process.pid,
    host: os.hostname(),
    ...(machineId ? { machineId } : {}),
    processStartedAt: LEASE_PROCESS_STARTED_AT,
    processToken: LEASE_PROCESS_TOKEN
  };
}

export function sameMachine(owner) {
  const local = localMachineId();
  if (typeof owner?.machineId === 'string' && owner.machineId && local) return owner.machineId === local;
  // A record from before machine IDs, or one without a host at all, is read as it always was.
  return !owner?.host || owner.host === os.hostname();
}

/**
 * The start-time probe of another process: `ps -o lstart=` (the system ps, never one a checkout or
 * PATH entry could shadow) or the .NET start ticks on Windows. The raw string is an identity; a
 * caller that needs a time passes a fixed locale and parses it with `processStartTimeMs`.
 */
export function processStartIdentity(pid, { platform = process.platform, spawnSyncCommand = spawnSync, env } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const result = spawnSyncCommand(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 2_000, windowsHide: true, ...(env ? { env } : {}) });
      const value = String(result.stdout ?? '').trim();
      return result.status === 0 && /^\d+$/u.test(value) ? value : null;
    }
    const result = spawnSyncCommand(existsSync('/bin/ps') ? '/bin/ps' : '/usr/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2_000, ...(env ? { env } : {}) });
    const value = String(result.stdout ?? '').trim();
    return result.status === 0 && value ? value : null;
  } catch { return null; }
}

const DOTNET_EPOCH_TICKS = 621_355_968_000_000_000n;
const startProbes = new Map();

/** Another process's start time in ms, or null when it cannot be read. Cached briefly per PID. */
export function processStartTimeMs(pid, { platform = process.platform, spawnSyncCommand = spawnSync, now = Date.now() } = {}) {
  const cached = startProbes.get(pid);
  if (cached && now - cached.at < START_PROBE_CACHE_MS) return cached.startedAt;
  const identity = processStartIdentity(pid, { platform, spawnSyncCommand, env: { ...process.env, ...PROBE_LOCALE } });
  let startedAt = null;
  if (identity && platform === 'win32') startedAt = Number((BigInt(identity) - DOTNET_EPOCH_TICKS) / 10_000n);
  else if (identity) startedAt = Date.parse(identity.replace(/\s+/gu, ' '));
  if (!Number.isFinite(startedAt)) startedAt = null;
  startProbes.set(pid, { at: now, startedAt });
  return startedAt;
}

function pidState(pid) {
  try { process.kill(pid, 0); return 'running'; }
  catch (error) { return error?.code === 'ESRCH' ? 'gone' : 'running'; }
}

function heartbeatState(heartbeatMtimeMs, heartbeatTtlMs, now) {
  if (!Number.isFinite(heartbeatMtimeMs)) return 'missing';
  if (!Number.isFinite(heartbeatTtlMs) || heartbeatTtlMs <= 0) return 'unknown';
  return now > heartbeatMtimeMs + heartbeatTtlMs ? 'stale' : 'fresh';
}

/**
 * The full answer: `state` ('alive' | 'dead' | 'unknown'), why, and the heartbeat as reported
 * information ('fresh' | 'stale' | 'missing' | 'unknown'). `probe` replaces the start-time read.
 */
export function leaseOwnerAssessment(owner, {
  now = Date.now(), heartbeatMtimeMs = null, heartbeatTtlMs = null, probe = processStartTimeMs
} = {}) {
  const heartbeat = heartbeatState(heartbeatMtimeMs, heartbeatTtlMs, now);
  const lastHeartbeatAt = Number.isFinite(heartbeatMtimeMs) ? new Date(heartbeatMtimeMs).toISOString() : null;
  const answer = (state, reason, local) => Object.freeze({ state, reason, sameMachine: local, heartbeat, lastHeartbeatAt });
  if (!sameMachine(owner)) return answer('unknown', 'other-machine', false);
  const pid = owner?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return answer('dead', 'no-process', true);
  if (pidState(pid) === 'gone') return answer('dead', 'process-exited', true);
  const recorded = owner.processStartedAt;
  // An older record has no start to compare, so a running PID keeps it (fail closed).
  if (!Number.isFinite(recorded)) return answer('alive', 'process-running', true);
  if (pid === process.pid && (owner.processToken === LEASE_PROCESS_TOKEN || recorded === LEASE_PROCESS_STARTED_AT)) {
    return answer('alive', 'this-process', true);
  }
  const observed = probe(pid);
  if (Number.isFinite(observed) && observed - recorded > PID_REUSE_TOLERANCE_MS) {
    return answer('dead', 'process-id-reused', true);
  }
  return answer('alive', Number.isFinite(observed) ? 'process-running' : 'process-start-unreadable', true);
}

/** 'alive' | 'dead' | 'unknown' for a recorded lease owner. Only 'dead' may be taken over. */
export function leaseOwnerState(owner, options = {}) {
  return leaseOwnerAssessment(owner, options).state;
}

/** One line naming a lease owner for a refusal: machine, PID, start of the lease, last heartbeat. */
export function describeLeaseOwner(owner, assessment = null, { acquiredAt = owner?.acquiredAt ?? owner?.createdAt } = {}) {
  const machine = owner?.machineId ? `${owner?.host ?? 'unknown host'} (machine ${String(owner.machineId).slice(0, 8)})` : owner?.host ?? 'unknown host';
  const heartbeat = assessment?.lastHeartbeatAt
    ? `last heartbeat ${assessment.lastHeartbeatAt}${assessment.heartbeat === 'stale' ? ' (stale)' : ''}`
    : 'no heartbeat recorded';
  return `PID ${owner?.pid ?? 'unknown'} on ${machine} since ${acquiredAt ?? 'unknown'}, ${heartbeat}`;
}
