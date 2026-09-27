/** Private encrypted editor checkpoints only: no shared draft, execution, or approval authority. */
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TextDecoder } from 'node:util';

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
async function lock<T>(directory: Directory, name: string, work: () => Promise<T>): Promise<T> {
  const file = path.join(directory.path, name);
  let handle: FileHandle | null = null;
  const expires = Date.now() + 2000;
  while (!handle) {
    await unchanged(directory);
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
  try { await unchanged(directory); return await work(); }
  finally {
    await handle.close();
    await unchanged(directory);
    const current = await regular(file);
    if (!current || !sameFile(identity, current)) unsafe();
    await unlink(file);
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
  return {
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
