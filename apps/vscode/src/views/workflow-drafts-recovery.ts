/** Private encrypted editor checkpoints only: no shared draft, execution, or approval authority. */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';

export const WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES = 20 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DRAFT = /^WFD-[A-Z0-9]{6,32}$/u;
const HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const FORMAT = 'sflow-workflow-draft-recovery/aes-256-gcm@1';
const FILE = /^[a-f0-9]{64}\.wdr\.enc$/u;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const queues = new Map<string, Promise<void>>();
const LOCK_MAX_BYTES = 4096;
const PROCESS_NONCE = randomUUID();
const OWNER_PID = process.pid;
const OWNER_PLATFORM = process.platform;
const OWNER_HOSTNAME = hostname();
const signalZero = process.kill.bind(process);

export type WorkflowDraftRecoveryLockKind = 'scope' | 'key-init';
export interface WorkflowDraftRecoveryLockInspection {
  schemaVersion: 1; kind: WorkflowDraftRecoveryLockKind;
  scope: WorkflowDraftRecoveryScope; scopeSha256: string | null; directorySha256: string;
  status: 'absent' | 'live' | 'dead' | 'unknown' | 'legacy'; reason: string;
  owner: { pid: number; processNonce: string; lockNonce: string; createdAt: string } | null;
  repairSupported: boolean; reviewId: string | null;
}
export interface WorkflowDraftRecoveryLockRepairResult {
  status: 'repaired' | 'cancelled'; kind: WorkflowDraftRecoveryLockKind;
  checkpointChanged: false; keyChanged: false;
}

export interface WorkflowDraftRecoveryScope { repository: string; authority: string; draftId: string }
export interface WorkflowDraftRecoveryCheckpoint {
  schemaVersion: 1; checkpointId: string; capturedAt: string; scope: WorkflowDraftRecoveryScope;
  base: {
    record: { draftId: string; displayName: string; revision: number; lifecycleEpoch: number; revisionSha256: string };
    head: string; savedName: string; savedText: string;
  };
  buffer: { name: string; text: string };
  pendingSave?: {
    operationId: string;
    snapshot: { draftId: string; authority: string; head: string; epoch: number; name: string; text: string };
    uncertain: true;
  };
}
export interface WorkflowDraftRecoveryStore {
  read(scope: WorkflowDraftRecoveryScope): Promise<WorkflowDraftRecoveryCheckpoint | null>;
  /** Create-only without an expected ID. Replacement requires the exact prior private checkpoint. */
  write(checkpoint: WorkflowDraftRecoveryCheckpoint, expectedCheckpointId?: string | null): Promise<void>;
  remove(scope: WorkflowDraftRecoveryScope, expectedCheckpointId: string): Promise<boolean>;
  /** Read-only exact-scope diagnostics. No lock is removed and no key is initialized. */
  inspectLocks?(scope: WorkflowDraftRecoveryScope): Promise<{ scope: WorkflowDraftRecoveryScope; locks: WorkflowDraftRecoveryLockInspection[] }>;
  /** Private inspection tickets cannot authorize liveness; native rechecks must independently prove death. */
  repairLock?(scope: WorkflowDraftRecoveryScope, reviewId: string,
    confirm: (inspection: WorkflowDraftRecoveryLockInspection) => Promise<boolean>): Promise<WorkflowDraftRecoveryLockRepairResult>;
}
export interface WorkflowDraftRecoverySecrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}
export class WorkflowDraftRecoveryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'WorkflowDraftRecoveryError'; this.code = code; }
}
function refuse(code: string, message: string): never { throw new WorkflowDraftRecoveryError(code, message); }
function invalid(): never {
  return refuse('WORKFLOW_DRAFT_RECOVERY_INVALID', 'The private recovery checkpoint is invalid or exceeds its bounded schema.');
}
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
      || required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function literal(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum
    && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function captureScope(value: unknown): WorkflowDraftRecoveryScope {
  const v = closed(value, ['repository', 'authority', 'draftId']);
  if (!literal(v.repository, 8192) || !path.isAbsolute(v.repository) || /[\0\r\n]/u.test(v.repository)
      || !literal(v.authority, 4096) || !v.authority.trim() || /[\0\r\n]/u.test(v.authority)
      || typeof v.draftId !== 'string' || !DRAFT.test(v.draftId)) invalid();
  return { repository: v.repository, authority: v.authority, draftId: v.draftId };
}
function captureCheckpoint(value: unknown): { checkpoint: WorkflowDraftRecoveryCheckpoint; bytes: Buffer } {
  const v = closed(value, ['schemaVersion', 'checkpointId', 'capturedAt', 'scope', 'base', 'buffer'], ['pendingSave']);
  const scope = captureScope(v.scope);
  const base = closed(v.base, ['record', 'head', 'savedName', 'savedText']);
  const record = closed(base.record, ['draftId', 'displayName', 'revision', 'lifecycleEpoch', 'revisionSha256']);
  const buffer = closed(v.buffer, ['name', 'text']);
  if (v.schemaVersion !== 1 || typeof v.checkpointId !== 'string' || !UUID.test(v.checkpointId)
      || typeof v.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v.capturedAt)
      || !Number.isFinite(Date.parse(v.capturedAt)) || new Date(v.capturedAt).toISOString() !== v.capturedAt
      || record.draftId !== scope.draftId || !literal(record.displayName, 512)
      || !positive(record.revision) || !positive(record.lifecycleEpoch)
      || typeof record.revisionSha256 !== 'string' || !SHA.test(record.revisionSha256)
      || typeof base.head !== 'string' || !HEAD.test(base.head)
      || !literal(base.savedName, 512) || !literal(buffer.name, 512)
      || !literal(base.savedText, WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES)
      || !literal(buffer.text, WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES)) invalid();
  let pendingSave: WorkflowDraftRecoveryCheckpoint['pendingSave'];
  if (Object.hasOwn(v, 'pendingSave')) {
    const pending = closed(v.pendingSave, ['operationId', 'snapshot', 'uncertain']);
    const snapshot = closed(pending.snapshot, ['draftId', 'authority', 'head', 'epoch', 'name', 'text']);
    if (pending.uncertain !== true || typeof pending.operationId !== 'string' || !UUID.test(pending.operationId)
        || snapshot.draftId !== scope.draftId || snapshot.authority !== scope.authority
        || snapshot.head !== base.head || snapshot.epoch !== record.lifecycleEpoch
        || !literal(snapshot.name, 512) || !literal(snapshot.text, WORKFLOW_DRAFT_RECOVERY_MAX_TEXT_BYTES)) invalid();
    pendingSave = { operationId: pending.operationId, uncertain: true,
      snapshot: { draftId: scope.draftId, authority: scope.authority, head: base.head,
        epoch: Number(snapshot.epoch), name: snapshot.name, text: snapshot.text } };
  }
  // Validation precedes serialization; closed records cannot provide a toJSON executable hook.
  const checkpoint: WorkflowDraftRecoveryCheckpoint = {
    schemaVersion: 1, checkpointId: v.checkpointId, capturedAt: v.capturedAt, scope,
    base: { record: { draftId: scope.draftId, displayName: record.displayName,
      revision: Number(record.revision), lifecycleEpoch: Number(record.lifecycleEpoch), revisionSha256: record.revisionSha256 },
      head: base.head, savedName: base.savedName, savedText: base.savedText },
    buffer: { name: buffer.name, text: buffer.text }, ...(pendingSave ? { pendingSave } : {})
  };
  const bytes = Buffer.from(JSON.stringify(checkpoint), 'utf8');
  if (bytes.length > WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES) invalid();
  return { checkpoint, bytes };
}
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function scopeHash(scope: WorkflowDraftRecoveryScope): string {
  return hash(JSON.stringify([scope.repository, scope.authority, scope.draftId]));
}
function equalScope(left: WorkflowDraftRecoveryScope, right: WorkflowDraftRecoveryScope): boolean {
  return left.repository === right.repository && left.authority === right.authority && left.draftId === right.draftId;
}
function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(code) ? code : 'UNKNOWN';
}
function missing(error: unknown): boolean { return errorCode(error) === 'ENOENT'; }
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof WorkflowDraftRecoveryError) throw error;
    return refuse('WORKFLOW_DRAFT_RECOVERY_IO', `Private recovery storage is unavailable (${errorCode(error)}).`);
  }
}
function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.then(work);
  const settled = operation.then(() => undefined, () => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return operation;
}
interface Identity { dev: number; ino: number }
interface Directory extends Identity { path: string }
function sameFile(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function unsafe(): never { return refuse('WORKFLOW_DRAFT_RECOVERY_UNSAFE_PATH', 'Private recovery storage contains an unsafe or changed filesystem path.'); }
async function directoryAt(directory: string, create: boolean): Promise<Directory | null> {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info = await lstat(current).catch((error) => missing(error) ? null : Promise.reject(error));
    if (!info && create) {
      await mkdir(current, { mode: 0o700 }).catch((error) => errorCode(error) === 'EEXIST' ? undefined : Promise.reject(error));
      info = await lstat(current);
    }
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) unsafe();
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) unsafe();
  return { path: directory, dev: info.dev, ino: info.ino };
}
async function unchanged(directory: Directory): Promise<void> {
  const current = await directoryAt(directory.path, false);
  if (!current || !sameFile(directory, current)) unsafe();
}
async function regular(file: string): Promise<Stats | null> {
  const info = await lstat(file).catch((error) => missing(error) ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) unsafe();
  return info;
}
interface ProcessDomain { profile: 'linux-boot-pid-namespace/v1' | 'macos-boot-session/v1'; sha256: string }
/** A diagnostic policy, never liveness evidence or a repair-authorizing platform override. */
export function workflowDraftRecoveryNativeDomainRefusal(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'WINDOWS_NATIVE_BOOT_PROCESS_DOMAIN_UNQUALIFIED';
  return ['darwin', 'linux'].includes(platform) ? null : 'NATIVE_PROCESS_DOMAIN_UNAVAILABLE';
}
interface LockRecord {
  schemaVersion: 1; kind: 'workflow-draft-recovery-lock'; purpose: 'mutation' | 'repair';
  target: WorkflowDraftRecoveryLockKind; directorySha256: string; scopeSha256: string | null;
  owner: { pid: number; processNonce: string; domain: ProcessDomain | null };
  lockNonce: string; createdAt: string;
}
interface CapturedLock { identity: Identity; bytes: Buffer; record: LockRecord | null; legacy: boolean }
let nativeDomainPromise: Promise<ProcessDomain | null> | null = null;
async function nativeDomain(): Promise<ProcessDomain | null> {
  nativeDomainPromise ??= (async () => {
    // Fixed local OS observations only. No caller can supply a probe, PID, command or death result.
    // Boot plus Linux PID namespace disambiguates another host/container and PID reuse. An owner
    // from a different or unqualified domain remains unknown, even if its numeric PID is absent.
    if (OWNER_PLATFORM === 'linux') {
      let handle: FileHandle | null = null;
      try {
        handle = await open('/proc/sys/kernel/random/boot_id', constants.O_RDONLY | NOFOLLOW);
        const bytes = Buffer.alloc(1024); const read = await handle.read(bytes, 0, bytes.length, 0);
        const boot = bytes.subarray(0, read.bytesRead).toString('utf8').trim().toLowerCase();
        const namespace = await readlink('/proc/self/ns/pid');
        if (!UUID.test(boot) || !/^pid:\[\d{1,20}\]$/u.test(namespace)) return null;
        return { profile: 'linux-boot-pid-namespace/v1', sha256: hash(JSON.stringify([OWNER_PLATFORM, OWNER_HOSTNAME, boot, namespace])) };
      } catch { return null; }
      finally { await handle?.close().catch(() => undefined); }
    }
    if (OWNER_PLATFORM === 'darwin') {
      const boot = await new Promise<string | null>((resolve) => {
        execFile('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { shell: false, encoding: 'utf8',
          timeout: 1000, maxBuffer: 1024, windowsHide: true }, (error, stdout) => {
          const value = typeof stdout === 'string' ? stdout.trim().toLowerCase() : '';
          resolve(!error && UUID.test(value) ? value : null);
        });
      });
      return boot ? { profile: 'macos-boot-session/v1', sha256: hash(JSON.stringify([OWNER_PLATFORM, OWNER_HOSTNAME, boot])) } : null;
    }
    // Windows requires an independently qualified native provider. Node
    // supplies no exact kernel boot + process-namespace observation here. WMI boot time, hostname,
    // SessionId, environment variables, or a caller-provided hash must not substitute for that owner.
    // Do not dynamically compile an undocumented NtQuerySystemInformation ABI through PowerShell:
    // boot structure/version and server-silo membership require independent Windows qualification.
    // Read/inspect remains supported; there is no PID-only or timestamp-only deletion fallback.
    return null;
  })();
  return nativeDomainPromise;
}
function lockTarget(name: string): { target: WorkflowDraftRecoveryLockKind; scopeSha256: string | null } {
  if (name === '.key-init.lock') return { target: 'key-init', scopeSha256: null };
  const match = /^\.([a-f0-9]{64})\.lock$/u.exec(name);
  if (!match) invalid();
  return { target: 'scope', scopeSha256: match[1]! };
}
function lockRecord(directory: Directory, name: string, domain: ProcessDomain | null, purpose: LockRecord['purpose']): LockRecord {
  return { schemaVersion: 1, kind: 'workflow-draft-recovery-lock', purpose, ...lockTarget(name),
    directorySha256: hash(directory.path), owner: { pid: OWNER_PID, processNonce: PROCESS_NONCE, domain },
    lockNonce: randomUUID(), createdAt: new Date().toISOString() };
}
function parseLock(bytes: Buffer, directory: Directory, name: string, purpose: LockRecord['purpose']): LockRecord | null {
  try {
    const value = closed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      ['schemaVersion', 'kind', 'purpose', 'target', 'directorySha256', 'scopeSha256', 'owner', 'lockNonce', 'createdAt']);
    const owner = closed(value.owner, ['pid', 'processNonce', 'domain']);
    const target = lockTarget(name);
    if (value.schemaVersion !== 1 || value.kind !== 'workflow-draft-recovery-lock' || value.purpose !== purpose
        || value.target !== target.target || value.directorySha256 !== hash(directory.path)
        || value.scopeSha256 !== target.scopeSha256 || !Number.isSafeInteger(owner.pid)
        || Number(owner.pid) < 1 || Number(owner.pid) > 2147483647
        || typeof owner.processNonce !== 'string' || !UUID.test(owner.processNonce)
        || typeof value.lockNonce !== 'string' || !UUID.test(value.lockNonce)
        || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.createdAt)
        || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) return null;
    let domain: ProcessDomain | null = null;
    if (owner.domain !== null) {
      const observed = closed(owner.domain, ['profile', 'sha256']);
      if (!['linux-boot-pid-namespace/v1', 'macos-boot-session/v1'].includes(String(observed.profile))
          || typeof observed.sha256 !== 'string' || !HEX.test(observed.sha256)) return null;
      domain = { profile: observed.profile as ProcessDomain['profile'], sha256: observed.sha256 };
    }
    return { schemaVersion: 1, kind: 'workflow-draft-recovery-lock', purpose, ...target,
      directorySha256: hash(directory.path), owner: { pid: Number(owner.pid), processNonce: owner.processNonce, domain },
      lockNonce: value.lockNonce, createdAt: value.createdAt };
  } catch { return null; }
}
async function captureLock(directory: Directory, name: string, purpose: LockRecord['purpose'] = 'mutation'): Promise<CapturedLock | null> {
  await unchanged(directory); const file = path.join(directory.path, name); const before = await regular(file);
  if (!before) return null;
  if (before.size > LOCK_MAX_BYTES) return { identity: before, bytes: Buffer.alloc(0), record: null, legacy: false };
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !sameFile(before, info)) unsafe();
    const bytes = Buffer.alloc(LOCK_MAX_BYTES + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, read.bytesRead);
    const after = await regular(file);
    await unchanged(directory);
    if (!after || !sameFile(info, after)) unsafe();
    return { identity: { dev: info.dev, ino: info.ino }, bytes: Buffer.from(content), legacy: content.length === 0,
      record: content.length <= LOCK_MAX_BYTES ? parseLock(content, directory, name, purpose) : null };
  } finally { await handle.close(); }
}
async function processState(record: LockRecord): Promise<{ status: 'live' | 'dead' | 'unknown'; reason: string }> {
  if (record.owner.pid === OWNER_PID && record.owner.processNonce === PROCESS_NONCE) {
    return { status: 'live', reason: 'CURRENT_PROCESS_OWNER' };
  }
  const nativeRefusal = workflowDraftRecoveryNativeDomainRefusal(OWNER_PLATFORM);
  if (nativeRefusal) return { status: 'unknown', reason: nativeRefusal };
  const domain = await nativeDomain();
  if (!domain || !record.owner.domain) return { status: 'unknown', reason: 'NATIVE_PROCESS_DOMAIN_UNAVAILABLE' };
  if (record.owner.domain.profile !== domain.profile || record.owner.domain.sha256 !== domain.sha256) {
    return { status: 'unknown', reason: 'NATIVE_PROCESS_DOMAIN_MISMATCH' };
  }
  try { signalZero(record.owner.pid, 0); return { status: 'live', reason: 'NATIVE_PROCESS_PRESENT' }; }
  catch (error) {
    return errorCode(error) === 'ESRCH' ? { status: 'dead', reason: 'NATIVE_PROCESS_ABSENT_IN_EXACT_DOMAIN' }
      : { status: 'unknown', reason: 'NATIVE_PROCESS_PROBE_UNAVAILABLE' };
  }
}
async function barrierAbsent(directory: Directory, name: string): Promise<void> {
  if (await regular(path.join(directory.path, `${name}.repair`))) refuse('WORKFLOW_DRAFT_RECOVERY_BUSY',
    'Private recovery lock maintenance is active or interrupted. No checkpoint, encryption key or maintenance lock was removed.');
}
async function releaseOwnedLock(directory: Directory, file: string, identity: Identity, bytes: Buffer): Promise<void> {
  await unchanged(directory);
  const current = await regular(file);
  if (!current || !sameFile(identity, current)) unsafe();
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const info = await handle.stat(); const observed = Buffer.alloc(LOCK_MAX_BYTES + 1);
    const read = await handle.read(observed, 0, observed.length, 0);
    if (!sameFile(identity, info) || !observed.subarray(0, read.bytesRead).equals(bytes)) unsafe();
  } finally { await handle.close(); }
  await unchanged(directory); const final = await regular(file);
  if (!final || !sameFile(identity, final)) unsafe();
  await unlink(file);
}
async function lock<T>(directory: Directory, name: string, work: () => Promise<T>): Promise<T> {
  const file = path.join(directory.path, name);
  const metadata = Buffer.from(JSON.stringify(lockRecord(directory, name, await nativeDomain(), 'mutation')));
  let handle: FileHandle | null = null;
  const expires = Date.now() + 2000;
  while (!handle) {
    await unchanged(directory); await barrierAbsent(directory, name);
    try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      await regular(file);
      if (Date.now() >= expires) refuse('WORKFLOW_DRAFT_RECOVERY_BUSY',
        'Private recovery mutation is locked by another or interrupted editor. The retained checkpoint remains readable; no lock was removed.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const identity = await handle.stat();
  let written = false;
  try {
    await handle.writeFile(metadata); await handle.sync(); written = true;
    await unchanged(directory); await barrierAbsent(directory, name); return await work();
  }
  finally {
    await handle.close();
    if (written) await releaseOwnedLock(directory, file, identity, metadata);
    else { await unchanged(directory); const current = await regular(file);
      if (!current || !sameFile(identity, current)) unsafe(); await unlink(file); }
  }
}
async function bytesAt(directory: Directory, file: string): Promise<{ bytes: Buffer; identity: Identity } | null> {
  await unchanged(directory);
  const before = await regular(file);
  if (!before) return null;
  if (before.size > WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES) invalid();
  const handle = await open(file, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    // An already-open old seal can have zero links after atomic replacement. More than one link
    // is a hardlink escape, not an old publication. No-follow opens still authenticate the exact
    // file and decrypted scope; platforms without O_NOFOLLOW additionally verify the live path.
    if (!info.isFile() || ![0, 1].includes(info.nlink)) unsafe();
    if (!NOFOLLOW && !sameFile(before, info)) {
      // A legitimate atomic publication can replace the inode between lstat and open. Admit only
      // a currently regular exact handle, then independently authenticate its seal and scope.
      const current = await regular(file);
      if (!current || !sameFile(current, info)) unsafe();
    }
    const chunks: Buffer[] = []; let total = 0;
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (!read.bytesRead) break;
      total += read.bytesRead;
      if (total > WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES) invalid();
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    await unchanged(directory);
    // Atomic replacement may have published a newer inode. This already-open old seal is valid.
    return { bytes: Buffer.concat(chunks), identity: { dev: info.dev, ino: info.ino } };
  } finally { await handle.close(); }
}
function base64(value: unknown, exactBytes?: number): Buffer {
  if (typeof value !== 'string') invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (exactBytes != null && bytes.length !== exactBytes)) invalid();
  return bytes;
}
function aad(scope: string, keyId: string): Buffer { return Buffer.from(JSON.stringify([FORMAT, scope, keyId])); }
function admitEncryptedSize(bytes: Buffer, scope: WorkflowDraftRecoveryScope): void {
  const headerBytes = Buffer.byteLength(JSON.stringify({ format: FORMAT, scopeSha256: scopeHash(scope),
    keyId: '0'.repeat(64), nonce: '0'.repeat(16), ciphertext: '', tag: '0'.repeat(24) }));
  if (headerBytes + 4 * Math.ceil(bytes.length / 3) > WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES) invalid();
}
async function secret(secrets: WorkflowDraftRecoverySecrets, key: string): Promise<string | undefined> {
  try { return await secrets.get(key); }
  catch { return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE', 'The private recovery encryption key is unavailable from SecretStorage.'); }
}
function encryptionKey(value: string): Buffer {
  try { if (typeof value !== 'string' || value.length !== 44) invalid(); return base64(value, 32); }
  catch { return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE', 'The private recovery encryption key is invalid. No fallback key was created.'); }
}
async function keyFor(directory: Directory, secrets: WorkflowDraftRecoverySecrets, secretName: string, create: boolean): Promise<Buffer> {
  const existing = await secret(secrets, secretName);
  if (existing !== undefined) return encryptionKey(existing);
  if (!create) return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE',
    'The retained private checkpoint has no available encryption key. No plaintext fallback or replacement key was created.');
  return lock(directory, '.key-init.lock', async () => {
    const observed = await secret(secrets, secretName);
    if (observed !== undefined) return encryptionKey(observed);
    if ((await readdir(directory.path)).some((name) => FILE.test(name))) {
      return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE',
        'Retained private checkpoints exist without their encryption key. No replacement key was created.');
    }
    const value = randomBytes(32).toString('base64');
    try { await secrets.store(secretName, value); }
    catch { return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE', 'SecretStorage could not persist the private recovery encryption key.'); }
    if (await secret(secrets, secretName) !== value) return refuse('WORKFLOW_DRAFT_RECOVERY_KEY_UNAVAILABLE',
      'SecretStorage did not retain the exact private recovery encryption key. No checkpoint was published.');
    return encryptionKey(value);
  });
}
async function readCheckpoint(directory: Directory, file: string, scope: WorkflowDraftRecoveryScope,
  secrets: WorkflowDraftRecoverySecrets, secretName: string): Promise<{
    checkpoint: WorkflowDraftRecoveryCheckpoint; bytes: Buffer; identity: Identity;
  } | null> {
  const stored = await bytesAt(directory, file);
  if (!stored) return null;
  const key = await keyFor(directory, secrets, secretName, false);
  let plaintext: Buffer | null = null;
  try {
    const envelope = closed(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes)),
      ['format', 'scopeSha256', 'keyId', 'nonce', 'ciphertext', 'tag']);
    if (envelope.format !== FORMAT || envelope.scopeSha256 !== scopeHash(scope)
        || typeof envelope.keyId !== 'string' || !HEX.test(envelope.keyId) || envelope.keyId !== hash(key)) invalid();
    const decipher = createDecipheriv('aes-256-gcm', key, base64(envelope.nonce, 12));
    decipher.setAAD(aad(scopeHash(scope), envelope.keyId));
    decipher.setAuthTag(base64(envelope.tag, 16));
    plaintext = Buffer.concat([decipher.update(base64(envelope.ciphertext)), decipher.final()]);
    const captured = captureCheckpoint(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    if (!equalScope(captured.checkpoint.scope, scope)) invalid();
    return { ...captured, identity: stored.identity };
  } catch {
    return refuse('WORKFLOW_DRAFT_RECOVERY_CORRUPT', 'The private recovery checkpoint is corrupt, incompatible, or bound to a different editor. It was not discarded.');
  } finally { plaintext?.fill(0); key.fill(0); }
}
async function syncDirectory(directory: Directory): Promise<void> {
  // POSIX file+directory fsync covers rename durability. Some Windows/filesystem providers cannot
  // open or fsync directories; atomic replacement and file fsync remain, not a power-loss promise.
  let handle: FileHandle | null = null;
  try { handle = await open(directory.path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(errorCode(error))) throw error; }
  finally { await handle?.close(); }
}
async function publish(directory: Directory, file: string, bytes: Buffer): Promise<void> {
  const temporary = path.join(directory.path, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let identity: Identity | null = null;
  try {
    await unchanged(directory); await regular(file);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { identity = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await unchanged(directory); await regular(file);
    const current = await regular(temporary);
    if (!current || !sameFile(identity, current)) unsafe();
    await rename(temporary, file);
    await unchanged(directory); await syncDirectory(directory);
  } finally {
    if (identity) {
      await unchanged(directory);
      const current = await regular(temporary);
      if (current) { if (!sameFile(identity, current)) unsafe(); await unlink(temporary); }
    }
  }
}

/** Directory is the caller's exact globalStorageUri.fsPath/workflow-draft-recovery, never a repo. */
export function createWorkflowDraftRecoveryStore(directory: string, secrets: WorkflowDraftRecoverySecrets): WorkflowDraftRecoveryStore {
  if (!literal(directory, 8192) || !path.isAbsolute(directory) || path.resolve(directory) !== directory
      || directory === path.parse(directory).root || /[\0\r\n]/u.test(directory)
      || !secrets || typeof secrets.get !== 'function' || typeof secrets.store !== 'function') invalid();
  const secretName = `singularityFlow.workflowDraftRecovery.aes256.${hash(directory)}`;
  const queueKey = (scope: WorkflowDraftRecoveryScope) => `${directory}\0${scopeHash(scope)}`;
  const location = (scope: WorkflowDraftRecoveryScope) => path.join(directory, `${scopeHash(scope)}.wdr.enc`);
  interface Review { scope: WorkflowDraftRecoveryScope; directory: Directory; name: string;
    captured: CapturedLock; inspection: WorkflowDraftRecoveryLockInspection; expires: number }
  const reviews = new Map<string, Review>();
  const inspected = async (scope: WorkflowDraftRecoveryScope, folder: Directory | null, kind: WorkflowDraftRecoveryLockKind): Promise<WorkflowDraftRecoveryLockInspection> => {
    const name = kind === 'scope' ? `.${scopeHash(scope)}.lock` : '.key-init.lock';
    const captured = folder ? await captureLock(folder, name) : null;
    const barrier = folder ? await regular(path.join(folder.path, `${name}.repair`)) : null;
    const record = captured?.record ?? null;
    const state = barrier ? { status: 'unknown' as const, reason: 'INTERRUPTED_OR_ACTIVE_REPAIR_BARRIER' }
      : !captured ? { status: 'absent' as const, reason: 'NO_LOCK' }
        : captured.legacy ? { status: 'legacy' as const, reason: 'LEGACY_EMPTY_LOCK_HAS_NO_OWNER_PROOF' }
          : !record ? { status: 'unknown' as const, reason: 'LOCK_OWNER_RECORD_INVALID_OR_UNBOUNDED' }
            : await processState(record);
    const reviewId = state.status === 'dead' && folder && captured ? randomUUID() : null;
    const inspection: WorkflowDraftRecoveryLockInspection = Object.freeze({ schemaVersion: 1, kind,
      scope: Object.freeze({ ...scope }), scopeSha256: kind === 'scope' ? scopeHash(scope) : null,
      directorySha256: hash(directory), ...state,
      owner: record ? Object.freeze({ pid: record.owner.pid, processNonce: record.owner.processNonce,
        lockNonce: record.lockNonce, createdAt: record.createdAt }) : null,
      repairSupported: reviewId !== null, reviewId });
    if (reviewId && folder && captured) {
      for (const [id, review] of reviews) if (review.expires < Date.now()) reviews.delete(id);
      while (reviews.size >= 64) reviews.delete(reviews.keys().next().value!);
      reviews.set(reviewId, { scope: { ...scope }, directory: folder, name, captured, inspection, expires: Date.now() + 120000 });
    }
    return inspection;
  };
  return {
    async inspectLocks(input) {
      const scope = captureScope(input);
      return guarded(async () => {
        const folder = await directoryAt(directory, false);
        const locks = [await inspected(scope, folder, 'scope'), await inspected(scope, folder, 'key-init')];
        return { scope, locks };
      });
    },
    async repairLock(input, reviewId, confirm) {
      const scope = captureScope(input);
      if (typeof reviewId !== 'string' || !UUID.test(reviewId) || typeof confirm !== 'function') invalid();
      const review = reviews.get(reviewId);
      reviews.delete(reviewId); // One-use, including cancellation, errors and concurrent attempts.
      if (!review || review.expires < Date.now() || !equalScope(review.scope, scope)) refuse('WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED',
        'Inspect this exact private recovery scope again. No current one-use repair review is available.');
      return guarded(async () => {
        if (await confirm(review.inspection) !== true) return { status: 'cancelled', kind: review.inspection.kind,
          checkpointChanged: false, keyChanged: false };
        if (review.expires < Date.now()) refuse('WORKFLOW_DRAFT_RECOVERY_LOCK_REVIEW_REQUIRED',
          'The private lock review expired while confirmation was open. Inspect this exact scope again; no lock was removed.');
        return queued(`${directory}\0lock-repair\0${review.name}`, async () => {
          await unchanged(review.directory);
          const barrier = path.join(directory, `${review.name}.repair`);
          const metadata = Buffer.from(JSON.stringify(lockRecord(review.directory, review.name, await nativeDomain(), 'repair')));
          let handle: FileHandle;
          try { handle = await open(barrier, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
          catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            await regular(barrier);
            return refuse('WORKFLOW_DRAFT_RECOVERY_BUSY', 'Private recovery maintenance is already active or interrupted. No lock was removed.');
          }
          const identity = await handle.stat(); let written = false;
          try {
            await handle.writeFile(metadata); await handle.sync(); written = true;
            const current = await captureLock(review.directory, review.name);
            if (!current || !sameFile(current.identity, review.captured.identity) || !current.bytes.equals(review.captured.bytes)
                || !current.record) refuse('WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED',
              'The reviewed private recovery lock changed. Inspect it again; no replacement lock was removed.');
            if ((await processState(current.record)).status !== 'dead') refuse('WORKFLOW_DRAFT_RECOVERY_LOCK_OWNER_UNPROVEN',
              'The reviewed lock owner is live or cannot be proven absent in this exact native process domain. No lock was removed.');
            const final = await captureLock(review.directory, review.name);
            if (!final || !sameFile(final.identity, review.captured.identity) || !final.bytes.equals(review.captured.bytes)) {
              refuse('WORKFLOW_DRAFT_RECOVERY_LOCK_CHANGED', 'The reviewed private recovery lock changed. No replacement lock was removed.');
            }
            // The exclusive barrier fences all participating acquisitions/repairs. A reused PID
            // cannot adopt this nonce-owned file; an existing live/unknown owner was refused above.
            await unchanged(review.directory); await unlink(path.join(directory, review.name)); await syncDirectory(review.directory);
            return { status: 'repaired' as const, kind: review.inspection.kind, checkpointChanged: false as const, keyChanged: false as const };
          } finally {
            await handle.close();
            if (written) await releaseOwnedLock(review.directory, barrier, identity, metadata);
            else { await unchanged(review.directory); const current = await regular(barrier);
              if (!current || !sameFile(identity, current)) unsafe(); await unlink(barrier); }
          }
        });
      });
    },
    async read(input) {
      const scope = captureScope(input);
      return queued(queueKey(scope), () => guarded(async () => {
        const folder = await directoryAt(directory, false);
        if (!folder) return null;
        return (await readCheckpoint(folder, location(scope), scope, secrets, secretName))?.checkpoint ?? null;
      }));
    },
    async write(input, expectedCheckpointId = null) {
      // Capture every literal and CAS operand before the first asynchronous boundary.
      const captured = captureCheckpoint(input);
      admitEncryptedSize(captured.bytes, captured.checkpoint.scope);
      if (expectedCheckpointId !== null && (typeof expectedCheckpointId !== 'string' || !UUID.test(expectedCheckpointId))) invalid();
      const expected = expectedCheckpointId;
      const scope = captured.checkpoint.scope;
      return queued(queueKey(scope), () => guarded(async () => {
        const folder = (await directoryAt(directory, true))!;
        return lock(folder, `.${scopeHash(scope)}.lock`, async () => {
          const file = location(scope);
          const prior = await readCheckpoint(folder, file, scope, secrets, secretName);
          if (prior?.checkpoint.checkpointId === captured.checkpoint.checkpointId) {
            if (prior.bytes.equals(captured.bytes)) return;
            return refuse('WORKFLOW_DRAFT_RECOVERY_CHECKPOINT_CHANGED', 'A private checkpoint ID was reused with different content. Nothing was replaced.');
          }
          if ((prior?.checkpoint.checkpointId ?? null) !== expected) return refuse('WORKFLOW_DRAFT_RECOVERY_CONFLICT',
            'A different or newer private checkpoint exists. Read and review it; no private buffer was overwritten.');
          const key = await keyFor(folder, secrets, secretName, true);
          try {
            const nonce = randomBytes(12); const keyId = hash(key);
            const cipher = createCipheriv('aes-256-gcm', key, nonce);
            cipher.setAAD(aad(scopeHash(scope), keyId));
            const ciphertext = Buffer.concat([cipher.update(captured.bytes), cipher.final()]);
            const envelope = Buffer.from(JSON.stringify({ format: FORMAT, scopeSha256: scopeHash(scope), keyId,
              nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }));
            if (envelope.length > WORKFLOW_DRAFT_RECOVERY_MAX_ENVELOPE_BYTES) invalid();
            await publish(folder, file, envelope);
          } finally { key.fill(0); }
        });
      }));
    },
    async remove(input, expectedCheckpointId) {
      const scope = captureScope(input);
      if (typeof expectedCheckpointId !== 'string' || !UUID.test(expectedCheckpointId)) invalid();
      const expected = expectedCheckpointId;
      return queued(queueKey(scope), () => guarded(async () => {
        const folder = await directoryAt(directory, false);
        if (!folder) return false;
        return lock(folder, `.${scopeHash(scope)}.lock`, async () => {
          const file = location(scope);
          const prior = await readCheckpoint(folder, file, scope, secrets, secretName);
          if (!prior || prior.checkpoint.checkpointId !== expected) return false;
          await unchanged(folder);
          const current = await regular(file);
          if (!current || !sameFile(current, prior.identity)) unsafe();
          await unlink(file); await syncDirectory(folder); return true;
        });
      }));
    }
  };
}
