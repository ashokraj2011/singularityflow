/**
 * SPEC-OSA v1.1 §7.2–§7.3: what this checkout has observed of an open version's shared acceptance and writer fence
 * [OSA:REQ-031, REQ-034]. Read from a few local files only, never Git or the network, so the edit guard and the phase
 * entry can ask it on every call [OSA:REQ-041]:
 * - the Story record's `versionOpening` pointer (the opening operation wrote it, committed with the opening);
 * - this checkout's writer identity (`<git dir>/singularity-flow/version-writer.json`, one per checkout);
 * - the operation's sealed checkpoint (`<git common dir>/singularity-flow/version-openings/`), which the operation and
 *   its reconciliation write after they observe the shared Story branch.
 * Nothing here grants anything by itself: the kernel decides from these facts (kernel/step-state.mjs). A checkpoint that
 * is missing, unreadable or not sealed with this clone's key is `unobserved`, never confirmed: an opening or its
 * acceptance cannot be made from local JSON.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { recordSha256 } from './records.mjs';

export const CHECKPOINT_PURPOSE = 'version-opening-checkpoint';
export const CHECKPOINT_SCHEMA = 'version-opening-checkpoint/v1';
export const WRITER_SCHEMA = 'version-writer/v1';
/** The checkpoints of one opening operation (§7.2): they are one operation's progress, never competing authorities. */
export const CHECKPOINT_STATES = Object.freeze(['prepared', 'locally-persisted', 'shared-pending', 'shared-confirmed', 'unknown', 'refused']);
const INTEGRITY_SCHEME = 'machine-local-hmac-sha256-v1';
const KEY_FILE = 'pending-publication-integrity.key';
const MAX_BYTES = 256 * 1024;

const safe = (value) => encodeURIComponent(String(value ?? '').trim()).replace(/%/gu, '_');

/** One small regular file's text, or null (absent, a link, too large or unreadable). */
function smallFile(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) return null;
    return readFileSync(file, 'utf8');
  } catch { return null; }
}

/** `{ gitDir, commonDir }` of a checkout from its `.git` entry, by reading files only; null when it has none. */
export function gitDirectories(root) {
  if (!root) return null;
  const entry = path.join(root, '.git');
  let gitDir = null;
  try {
    const info = lstatSync(entry);
    if (info.isDirectory()) gitDir = entry;
    else if (info.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/mu.exec(smallFile(entry) ?? '')?.[1]?.trim();
      gitDir = pointer ? path.resolve(root, pointer) : null;
    }
  } catch { return null; }
  if (!gitDir) return null;
  const common = smallFile(path.join(gitDir, 'commondir'))?.trim();
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
}

export const writerFile = (gitDir) => path.join(gitDir, 'singularity-flow', 'version-writer.json');
export const checkpointFile = (commonDir, workId, operationId) =>
  path.join(commonDir, 'singularity-flow', 'version-openings', `${safe(workId)}--${safe(operationId)}.json`);

/** This checkout's writer ID, or null before its first opening or takeover made one. */
export function readWriterId(gitDir) {
  try {
    const value = JSON.parse(smallFile(writerFile(gitDir)) ?? 'null');
    return value?.schema === WRITER_SCHEMA && /^vw-[0-9a-f]{32}$/u.test(value.writerId ?? '') ? value.writerId : null;
  } catch { return null; }
}

/** The clone's machine-local integrity key, as publication-machine-integrity.mjs keeps it; null when absent. */
function machineKey(commonDir) {
  const text = smallFile(path.join(commonDir, 'singularity-flow', KEY_FILE));
  const key = text ? Buffer.from(text.trim(), 'base64') : null;
  return key?.length === 32 ? key : null;
}

const mac = (key, purpose, value) => createHmac('sha256', key).update(`sha256:${recordSha256({ purpose, payload: value })}`).digest();
const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** Whether `record` carries this clone's seal for `purpose` (the same scheme as sealMachineLocalPublicationReceipt). */
export function sealedHere(commonDir, purpose, record) {
  const integrity = record?.machineLocalIntegrity;
  const key = machineKey(commonDir);
  if (!key || integrity?.scheme !== INTEGRITY_SCHEME || integrity.purpose !== purpose || integrity.keyId !== keyId(key)
      || !/^sha256:[0-9a-f]{64}$/u.test(integrity.mac ?? '')) return false;
  const { machineLocalIntegrity: _seal, ...value } = record;
  const expected = mac(key, purpose, value);
  const actual = Buffer.from(integrity.mac.slice('sha256:'.length), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** `record` sealed with this clone's key for `purpose`, or null when the clone has no key yet (nothing is sealed then). */
export function sealHere(commonDir, purpose, record) {
  const key = machineKey(commonDir);
  const { machineLocalIntegrity: _old, ...value } = record ?? {};
  return key ? { ...value, machineLocalIntegrity: { scheme: INTEGRITY_SCHEME, purpose, keyId: keyId(key),
    mac: `sha256:${mac(key, purpose, value).toString('hex')}` } } : null;
}

/** One operation's sealed checkpoint, or null when it is absent or not sealed here. */
export function readCheckpoint(commonDir, workId, operationId) {
  try {
    const record = JSON.parse(smallFile(checkpointFile(commonDir, workId, operationId)) ?? 'null');
    return record?.schema === CHECKPOINT_SCHEMA && record.operationId === operationId && record.workId === workId
      && CHECKPOINT_STATES.includes(record.state) && sealedHere(commonDir, CHECKPOINT_PURPOSE, record) ? record : null;
  } catch { return null; }
}

const ACCEPTANCE = Object.freeze({ 'shared-confirmed': 'confirmed', 'locally-persisted': 'pending', 'shared-pending': 'pending',
  prepared: 'pending', unknown: 'unknown', refused: 'refused' });

/**
 * What this checkout observed of `phase`'s open version: `{ acceptance, writer, operationId, fence, files }`, or null when
 * the step's opening was not made by the opening operation (a legacy local one, or none). `acceptance` is confirmed,
 * pending, unknown, refused or unobserved; `writer` is current when this checkout holds the writer fence, else other.
 * `files` are what it read, so a cached decision can tell when they change.
 */
export function observeOpening(root, workflow, phase) {
  const pointer = phase?.versionOpening;
  if (!pointer?.operationId || !workflow?.workItem?.id) return null;
  const directories = gitDirectories(root);
  if (!directories) return { acceptance: 'unobserved', writer: 'other', operationId: pointer.operationId, fence: pointer.writer?.fence ?? null, files: [] };
  const holder = pointer.writer?.operationId ?? pointer.operationId;
  const checkpoint = readCheckpoint(directories.commonDir, workflow.workItem.id, holder);
  const own = readWriterId(directories.gitDir);
  // The checkpoint must name the record this checkout holds: the same operation, version and committed record.
  const matches = checkpoint && Number(checkpoint.version) === Number(pointer.version)
    && (holder !== pointer.operationId || checkpoint.recordSha256 === pointer.sha256);
  return { acceptance: matches ? ACCEPTANCE[checkpoint.state] : 'unobserved',
    writer: own && pointer.writer?.writerId === own ? 'current' : 'other', operationId: pointer.operationId,
    fence: pointer.writer?.fence ?? null,
    files: [writerFile(directories.gitDir), checkpointFile(directories.commonDir, workflow.workItem.id, holder)] };
}
