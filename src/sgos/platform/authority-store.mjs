import { constants as fsConstants } from 'node:fs';
import {
  lstat, mkdir, open, readdir, realpath, rename, rm, utimes
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '../../records.mjs';
import { scanText } from '../../secrets.mjs';
import { SingularityFlowError } from '../../util.mjs';
import {
  clonePlatformJson, createAuthorityCutover, createAuthorityGitCutover,
  createAuthorityGitProjection, createAuthorityPortableExport, createAuthorityRollback,
  createAuthorityState, createAuthorityTransactionEvent, createAuthorityTransport,
  createPlatformEnvelope, isPlainPlatformObject, PLATFORM_AUTHORITY_TRANSPORT_ATTESTATION,
  PLATFORM_AUTHORITY_GIT_PROJECTION_PROFILE,
  platformSha256, validatePlatformEnvelope, validatePlatformRecord
} from './contracts.mjs';
import { signPlatformRecord, verifySignedPlatformRecord } from './signatures.mjs';

const MAX_AUTHORITY_EVENTS = 100_000;
const MAX_AUTHORITY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_AUTHORITY_TRANSPORT_BYTES = 64 * 1024 * 1024;
// This is a private adapter protocol, not a durable migration-registry record. `lockVersion` is
// deliberately not named `schemaVersion`: a lock is operational coordination state and must never
// masquerade as one of Singularity Flow's registered record families.
const AUTHORITY_LOCK_FORMAT = 'sflow.sgos.authority-store-lock';
const AUTHORITY_LOCK_VERSION = 1;
const AUTHORITY_LOCK_TTL_MS = 30 * 1000;
const AUTHORITY_LOCK_ACQUISITION_GRACE_MS = 30 * 1000;
const AUTHORITY_LOCK_ATTEMPTS = 3;
const AUTHORITY_LOCK_RETRY_MS = 10;
const AUTHORITY_CUTOVER_LOCK_ATTEMPTS = 500;
const AUTHORITY_TRANSPORT_PROFILE = 'repository-bound-v1';
const AUTHORITY_TRANSPORT_JOURNAL_FORMAT = 'sflow.sgos.authority-transport-cutover';
const AUTHORITY_TRANSPORT_JOURNAL_VERSION = 1;
const AUTHORITY_TRANSPORT_JOURNAL_INTEGRITY = 'machine-local-hmac-sha256-v1';
const PORTABLE_STORE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$/;
const WINDOWS_RESERVED_STORE_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;

function fail(message, code = 'SGOS_AUTHORITY_STORE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(value)) {
    fail(`${label} must be a canonical identifier.`);
  }
}

export function assertPortableAuthorityStoreId(value, label = 'storeId') {
  if (typeof value !== 'string' || !PORTABLE_STORE_ID.test(value)
      || WINDOWS_RESERVED_STORE_ID.test(value)) {
    fail(`${label} must be a portable canonical lower-case identifier.`,
      'SGOS_AUTHORITY_STORE_ID_INVALID');
  }
  return value;
}

function exactObject(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
}

function canonicalStateBranch(value, label = 'stateBranch') {
  if (typeof value !== 'string' || !value.length || value.length > 255
      || /[\u0000-\u0020~^:?*[\\]/u.test(value)
      || value.includes('..') || value.includes('@{') || value.includes('//')
      || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')
      || value === '@' || value.split('/').some((component) =>
        component.startsWith('.') || component.endsWith('.lock'))) {
    fail(`${label} must be a safe canonical Git branch name.`,
      'SGOS_AUTHORITY_GIT_PROVENANCE_INVALID');
  }
  return value;
}

function exactGitCommit(value, label = 'stateCommit') {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/u.test(value)) {
    fail(`${label} must be an exact lower-case Git object ID.`,
      'SGOS_AUTHORITY_GIT_PROVENANCE_INVALID');
  }
  return value;
}

function assertPortableTransportContent(value, location = '$') {
  if (location === '$') {
    const findings = scanText(canonicalJson(value), { path: '<authority-transport>' });
    if (findings.length) {
      fail('Authority transport contains credential-shaped material.',
        'SGOS_AUTHORITY_TRANSPORT_CREDENTIAL_REFUSED', {
          findingCount: findings.length,
          rules: [...new Set(findings.map((finding) => finding.rule))].sort()
        });
    }
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPortableTransportContent(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    const platformSignatureValue = key === 'value'
      && value.algorithm === 'ed25519'
      && Object.keys(value).sort().join(',')
        === 'algorithm,keyId,keySha256,payloadSha256,value'
      && typeof child === 'string'
      && /^[A-Za-z0-9+/]{86}==$/u.test(child);
    if (typeof child === 'string' && child.length
        && /^(?:password|secret|privateKey|accessToken|refreshToken|apiKey|credential)$/iu.test(key)) {
      fail('Authority transport contains credential material.',
        'SGOS_AUTHORITY_TRANSPORT_CREDENTIAL_REFUSED', { location: childLocation });
    }
    if (typeof child === 'string' && !platformSignatureValue
        && (child.startsWith('/') || /^[a-z]:[\\/]/iu.test(child) || /^\\\\/u.test(child)
          || /^file:/iu.test(child) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(child))) {
      fail('Authority transport contains a machine-local or escaping path-shaped value.',
        'SGOS_AUTHORITY_TRANSPORT_PATH_UNSAFE', { location: childLocation });
    }
    assertPortableTransportContent(child, childLocation);
  }
}

async function assertNotSymlink(target, label, { optional = false, directory = false } = {}) {
  let info;
  try { info = await lstat(target); } catch (error) {
    if (optional && error?.code === 'ENOENT') return false;
    throw error;
  }
  if (info.isSymbolicLink()) fail(`${label} must not be a symbolic link.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  if (directory && !info.isDirectory()) fail(`${label} must be a directory.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  if (!directory && !info.isFile()) fail(`${label} must be a regular file.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
  return true;
}

async function safeReadJson(file, label, { maximumBytes = MAX_AUTHORITY_FILE_BYTES } = {}) {
  let handle;
  let text;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) fail(`${label} must be a regular file.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
    if (info.size > maximumBytes) fail(`${label} exceeds the installed byte ceiling.`, 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    text = await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') fail(`${label} must not be a symbolic link.`, 'SGOS_AUTHORITY_PATH_UNSAFE');
    throw error;
  } finally {
    await handle?.close();
  }
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new SingularityFlowError(`${label} is not valid JSON.`, {
      code: 'SGOS_AUTHORITY_STORE_CORRUPT', cause: error
    });
  }
  return value;
}

function authorityHeadSummary(head) {
  return Object.freeze({
    storeId: head.storeId,
    revision: head.revision,
    stateSha256: head.recordSha256,
    eventSha256: head.eventSha256,
    entriesSha256: head.entriesSha256,
    entryCount: Object.keys(head.entries).length
  });
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Windows and a small number of network filesystems do not permit opening or syncing a
    // directory handle. File contents are still fsynced before their atomic rename/link boundary.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeExclusive(file, value) {
  let handle;
  try {
    handle = await open(file,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    await handle.writeFile(canonicalJson(value), 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await fsyncDirectory(path.dirname(file));
}

async function writeAtomic(file, value) {
  const temporary = path.join(path.dirname(file), `.state-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, value);
    await rename(temporary, file);
    await fsyncDirectory(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

function transportJournalCore(value) {
  const core = clonePlatformJson(value);
  delete core.integrity;
  delete core.journalSha256;
  return core;
}

function journalMac(key, value) {
  return createHmac('sha256', key).update(canonicalJson({
    purpose: 'sgos-authority-cutover-journal',
    journal: { ...transportJournalCore(value), journalSha256: value.journalSha256 }
  })).digest();
}

async function cutoverIntegrityKey(parent, storeId, { create = false } = {}) {
  const file = path.join(parent, `.authority-cutover-integrity-${storeId}.key`);
  let info = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info && create) {
    let handle;
    try {
      handle = await open(file,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
      await handle.writeFile(`${randomBytes(32).toString('base64')}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    await fsyncDirectory(parent);
    info = await lstat(file);
  }
  if (!info || info.isSymbolicLink() || !info.isFile()
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    fail('Authority cutover integrity key is missing or unsafe.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 256
        || (opened.ino !== 0 && opened.ino !== info.ino)
        || (opened.dev !== 0 && opened.dev !== info.dev)) {
      fail('Authority cutover integrity key changed while it was opened.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    const key = Buffer.from((await handle.readFile('utf8')).trim(), 'base64');
    if (key.length !== 32) {
      fail('Authority cutover integrity key is invalid.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    return key;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function transportJournal(value, key) {
  exactObject(value, [
    'journalFormat', 'journalVersion', 'operation', 'storeId', 'stageName', 'backupName',
    'beforeStateSha256', 'afterStateSha256', 'receiptSha256', 'journalSha256', 'integrity'
  ], 'Authority transport cutover journal');
  if (value.journalFormat !== AUTHORITY_TRANSPORT_JOURNAL_FORMAT
      || value.journalVersion !== AUTHORITY_TRANSPORT_JOURNAL_VERSION
      || !['import', 'rollback'].includes(value.operation)) {
    fail('Authority transport cutover journal uses an unsupported format.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  assertPortableAuthorityStoreId(value.storeId);
  for (const [field, name] of [['stageName', value.stageName], ['backupName', value.backupName]]) {
    if (typeof name !== 'string' || !/^\.[a-z0-9._-]{8,220}$/.test(name)
        || name.includes('..') || name.includes('/') || name.includes('\\')) {
      fail(`Authority transport journal ${field} is unsafe.`,
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
  }
  for (const field of ['beforeStateSha256', 'afterStateSha256', 'receiptSha256', 'journalSha256']) {
    if (!/^sha256:[a-f0-9]{64}$/.test(String(value[field] ?? ''))) {
      fail(`Authority transport journal ${field} is invalid.`,
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
  }
  if (platformSha256(transportJournalCore(value)) !== value.journalSha256) {
    fail('Authority transport cutover journal failed self-hash verification.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (!isPlainPlatformObject(value.integrity)
      || Object.keys(value.integrity).sort().join(',') !== 'keyId,mac,scheme'
      || value.integrity.scheme !== AUTHORITY_TRANSPORT_JOURNAL_INTEGRITY
      || value.integrity.keyId !== platformSha256(key).slice(7, 23)
      || !/^sha256:[a-f0-9]{64}$/u.test(String(value.integrity.mac ?? ''))) {
    fail('Authority transport cutover journal integrity receipt is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const expected = journalMac(key, value);
  const observed = Buffer.from(value.integrity.mac.slice(7), 'hex');
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    fail('Authority transport cutover journal failed machine-local integrity verification.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  return Object.freeze(clonePlatformJson(value));
}

async function createTransportJournal(parent, input) {
  const core = {
    journalFormat: AUTHORITY_TRANSPORT_JOURNAL_FORMAT,
    journalVersion: AUTHORITY_TRANSPORT_JOURNAL_VERSION,
    ...clonePlatformJson(input)
  };
  const journalSha256 = platformSha256(core);
  const unsealed = { ...core, journalSha256 };
  const key = await cutoverIntegrityKey(parent, input.storeId, { create: true });
  const mac = journalMac(key, unsealed);
  return transportJournal({
    ...unsealed,
    integrity: {
      scheme: AUTHORITY_TRANSPORT_JOURNAL_INTEGRITY,
      keyId: platformSha256(key).slice(7, 23),
      mac: `sha256:${mac.toString('hex')}`
    }
  }, key);
}

async function stateDigestAt(directory) {
  await assertNotSymlink(directory, 'Authority transport recovery directory', {
    optional: true, directory: true
  });
  const file = path.join(directory, 'state.json');
  const present = await assertNotSymlink(file, 'Authority Store state', { optional: true });
  if (!present) return null;
  const envelope = validatePlatformEnvelope(
    await safeReadJson(file, 'Authority Store state'), 'platform-authority-state'
  );
  return envelope.record.recordSha256;
}

async function verifyStoreDirectoryAt(directory, storeId, expectedStateSha256, {
  operation = null, receiptSha256 = null, includeEvents = false,
  allowMissingReceipt = false
} = {}) {
  await assertNotSymlink(directory, 'Authority Store recovery root', { directory: true });
  const stateEnvelope = validatePlatformEnvelope(
    await safeReadJson(path.join(directory, 'state.json'), 'Recovered Authority Store state'),
    'platform-authority-state'
  );
  const head = stateEnvelope.record;
  if (head.storeId !== storeId || head.recordSha256 !== expectedStateSha256) {
    fail('Recovered Authority Store state does not match the cutover journal.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const eventsDirectory = path.join(directory, 'events');
  await assertNotSymlink(eventsDirectory, 'Authority Store recovery events', { directory: true });
  const names = await readdir(eventsDirectory);
  if (names.length > MAX_AUTHORITY_EVENTS
      || names.some((name) => !/^[a-f0-9]{64}\.json$/u.test(name))) {
    fail('Recovered Authority Store event directory is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const eventsByDigest = new Map();
  for (const name of names) {
    const envelope = validatePlatformEnvelope(
      await safeReadJson(path.join(eventsDirectory, name), 'Recovered Authority Store event'),
      'platform-authority-transaction'
    );
    const expected = `sha256:${name.slice(0, -'.json'.length)}`;
    if (envelope.record.recordSha256 !== expected) {
      fail('Recovered Authority Store event filename does not bind its contents.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    eventsByDigest.set(expected, envelope.record);
  }
  const reverse = [];
  let cursor = head.eventSha256;
  while (cursor !== null) {
    const event = eventsByDigest.get(cursor);
    if (!event || reverse.length >= MAX_AUTHORITY_EVENTS) {
      fail('Recovered Authority Store lineage is incomplete.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    reverse.push(event);
    cursor = event.priorEventSha256;
  }
  if (reverse.length !== eventsByDigest.size) {
    fail('Recovered Authority Store contains event files outside its exact committed lineage.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const events = reverse.reverse();
  await verifyEventSequence(storeId, head, events);
  if (operation === null) {
    return includeEvents ? Object.freeze({ head, events: Object.freeze(events) }) : head;
  }
  const receiptDirectory = operation === 'import' ? 'receipts' : 'rollbacks';
  const transportRoot = path.join(directory, 'transport');
  await assertNotSymlink(transportRoot, 'Authority recovery transport root', { directory: true });
  const receiptsRoot = path.join(transportRoot, receiptDirectory);
  await assertNotSymlink(receiptsRoot, 'Authority recovery receipt directory', {
    directory: true
  });
  const receiptFile = path.join(receiptsRoot, `${receiptSha256.slice(7)}.json`);
  const receiptPresent = await assertNotSymlink(
    receiptFile, 'Recovered Authority transport receipt', { optional: allowMissingReceipt }
  );
  if (!receiptPresent) {
    return includeEvents ? Object.freeze({ head, events: Object.freeze(events) }) : head;
  }
  const receiptEnvelope = validatePlatformEnvelope(await safeReadJson(
    receiptFile, 'Recovered Authority transport receipt'
  ));
  const allowedReceiptKinds = operation === 'import'
    ? new Set(['platform-authority-cutover', 'platform-authority-git-cutover'])
    : new Set(['platform-authority-rollback']);
  if (!allowedReceiptKinds.has(receiptEnvelope.family)) {
    fail('Recovered Authority transport receipt has the wrong kind.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (receiptEnvelope.record.recordSha256 !== receiptSha256
      || receiptEnvelope.record.storeId !== storeId) {
    fail('Recovered Authority transport receipt does not match the cutover journal.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (operation === 'import') {
    if (receiptEnvelope.record.afterHead.recordSha256 !== expectedStateSha256) {
      fail('Recovered Authority import receipt does not bind the installed head.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    if (receiptEnvelope.family === 'platform-authority-cutover') {
      const importsRoot = path.join(transportRoot, 'imports');
      await assertNotSymlink(importsRoot, 'Authority recovery import directory', {
        directory: true
      });
      const proofFile = path.join(
        importsRoot, `${receiptEnvelope.record.signedTransportSha256.slice(7)}.json`
      );
      await assertNotSymlink(proofFile, 'Recovered signed Authority transport');
      const proof = await safeReadJson(
        proofFile, 'Recovered signed Authority transport', {
          maximumBytes: MAX_AUTHORITY_TRANSPORT_BYTES
        }
      );
      if (platformSha256(proof) !== receiptEnvelope.record.signedTransportSha256
          || proof?.record?.recordSha256 !== receiptEnvelope.record.exportSha256
          || proof?.signature?.keyId !== receiptEnvelope.record.signerKeyId) {
        fail('Recovered signed Authority transport does not match its receipt.',
          'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
      }
    } else {
      const projectionsRoot = path.join(transportRoot, 'git-projections');
      await assertNotSymlink(projectionsRoot, 'Authority recovery Git projection directory', {
        directory: true
      });
      const proofFile = path.join(
        projectionsRoot, `${receiptEnvelope.record.projectionSha256.slice(7)}.json`
      );
      await assertNotSymlink(proofFile, 'Recovered Authority Git projection');
      const proof = validatePlatformRecord(await safeReadJson(
        proofFile, 'Recovered Authority Git projection', {
          maximumBytes: MAX_AUTHORITY_TRANSPORT_BYTES
        }
      ), 'platform-authority-git-projection');
      if (proof.recordSha256 !== receiptEnvelope.record.projectionSha256
          || proof.repositoryBindingSha256
            !== receiptEnvelope.record.repositoryBindingSha256
          || proof.policySha256 !== receiptEnvelope.record.policySha256
          || proof.head.recordSha256 !== receiptEnvelope.record.afterHead.recordSha256) {
        fail('Recovered Authority Git projection does not match its receipt.',
          'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
      }
    }
  } else if (receiptEnvelope.record.afterStateSha256 !== expectedStateSha256) {
    fail('Recovered Authority rollback receipt does not bind the restored head.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  return includeEvents ? Object.freeze({ head, events: Object.freeze(events) }) : head;
}

async function journalDirectory(parent, directory, label, { optional = false } = {}) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) {
    if (optional) return null;
    fail(`${label} is missing.`, 'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${label} must be an ordinary directory.`,
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const [canonicalParent, canonicalDirectory] = await Promise.all([
    realpath(parent), realpath(directory)
  ]);
  const relation = path.relative(canonicalParent, canonicalDirectory);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)
      || relation.includes(path.sep)) {
    fail(`${label} escapes its Authority Store parent.`,
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  return Object.freeze({ info, canonicalDirectory });
}

function sameJournalDirectory(left, right) {
  if (!left || !right) return false;
  if (left.info.ino !== 0 && right.info.ino !== 0) {
    return left.info.dev === right.info.dev && left.info.ino === right.info.ino;
  }
  return left.canonicalDirectory === right.canonicalDirectory
    && left.info.birthtimeMs === right.info.birthtimeMs;
}

async function renameJournalDirectory(parent, source, target, label, observed) {
  const current = await journalDirectory(parent, source, label);
  if (!sameJournalDirectory(observed, current)) {
    fail(`${label} changed before its recovery rename.`,
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const targetInfo = await lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (targetInfo) {
    fail('Authority transport recovery found an ambiguous filesystem cutover.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  await rename(source, target);
  await fsyncDirectory(parent);
}

async function cleanupAbortedRollbackStage(parent, stage, journal, observed) {
  const current = await journalDirectory(parent, stage, 'Authority rollback recovery stage');
  if (!sameJournalDirectory(observed, current)) {
    fail('Authority rollback recovery stage changed before cleanup.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const lock = path.join(stage, '.transaction-lock');
  const lockInfo = await lstat(lock).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (lockInfo?.isSymbolicLink() || (lockInfo && !lockInfo.isDirectory())) {
    fail('Authority rollback recovery lock must be an ordinary directory.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const transportDirectory = path.join(stage, 'transport');
  const transportDirectoryInfo = await lstat(transportDirectory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (transportDirectoryInfo?.isSymbolicLink()
      || (transportDirectoryInfo && !transportDirectoryInfo.isDirectory())) {
    fail('Authority rollback recovery transport root must be an ordinary directory.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const rollbackDirectory = path.join(transportDirectory, 'rollbacks');
  const rollbackDirectoryInfo = await lstat(rollbackDirectory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (rollbackDirectoryInfo?.isSymbolicLink()
      || (rollbackDirectoryInfo && !rollbackDirectoryInfo.isDirectory())) {
    fail('Authority rollback recovery receipts must use ordinary directories.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const receipt = path.join(rollbackDirectory, `${journal.receiptSha256.slice(7)}.json`);
  const receiptInfo = await lstat(receipt).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (receiptInfo?.isSymbolicLink() || (receiptInfo && !receiptInfo.isFile())) {
    fail('Authority rollback recovery receipt must be an ordinary file.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (lockInfo) await rm(lock, { recursive: true });
  if (receiptInfo) await rm(receipt);
  if (rollbackDirectoryInfo) await fsyncDirectory(rollbackDirectory);
  await fsyncDirectory(stage);
}

async function cleanupRecoveredBackupLock(parent, backup, observed) {
  const current = await journalDirectory(parent, backup, 'Authority recovery backup');
  if (!sameJournalDirectory(observed, current)) {
    fail('Authority recovery backup changed before lock cleanup.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const lock = path.join(backup, '.transaction-lock');
  const lockInfo = await lstat(lock).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (lockInfo?.isSymbolicLink() || (lockInfo && !lockInfo.isDirectory())) {
    fail('Authority recovery backup lock must be an ordinary directory.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  if (lockInfo) await rm(lock, { recursive: true });
  await fsyncDirectory(backup);
}

/**
 * Resolve a process crash at the two-rename directory cutover boundary before opening the store.
 * The recovery choice is deliberately conservative: if the new root was not fully installed, the
 * old complete root is restored. A staged partial store is quarantined and never exposed to normal
 * Authority Store orphan-event recovery.
 */
async function recoverInterruptedTransportCutover(requestedRoot, storeId) {
  const parent = path.dirname(requestedRoot);
  const journalFile = path.join(parent, `.authority-cutover-${storeId}.json`);
  const info = await lstat(journalFile).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('Authority transport cutover journal must be a regular file.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const integrityKey = await cutoverIntegrityKey(parent, storeId);
  const journal = transportJournal(await safeReadJson(
    journalFile, 'Authority transport cutover journal'
  ), integrityKey);
  if (journal.storeId !== storeId) {
    fail('Authority transport cutover journal belongs to another store.',
      'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  }
  const stage = path.join(parent, journal.stageName);
  const backup = path.join(parent, journal.backupName);
  const rootObserved = await journalDirectory(
    parent, requestedRoot, 'Authority Store recovery root', { optional: true }
  );
  const rootDigest = rootObserved === null ? null : await stateDigestAt(requestedRoot);
  if (rootDigest === journal.afterStateSha256) {
    // The commit point completed. The exact old store remains at `backup` for explicit rollback.
    await verifyStoreDirectoryAt(requestedRoot, storeId, journal.afterStateSha256, {
      operation: journal.operation, receiptSha256: journal.receiptSha256
    });
    const currentRoot = await journalDirectory(parent, requestedRoot,
      'Authority Store recovery root');
    if (!sameJournalDirectory(rootObserved, currentRoot)) {
      fail('Authority Store recovery root changed during verification.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    const stageObserved = await journalDirectory(
      parent, stage, 'Authority recovery stage', { optional: true }
    );
    if (stageObserved !== null) {
      fail('Authority transport recovery found an unexpected staged store after cutover.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    const backupObserved = await journalDirectory(
      parent, backup, 'Authority recovery backup'
    );
    await verifyStoreDirectoryAt(backup, storeId, journal.beforeStateSha256);
    await cleanupRecoveredBackupLock(parent, backup, backupObserved);
    await rm(journalFile, { force: true });
    await fsyncDirectory(parent);
    return;
  }
  if (rootDigest === journal.beforeStateSha256) {
    // No cutover occurred, or recovery already restored the exact old root. Import stages are
    // quarantined; rollback stages are the deterministic pre-import backup and must be retained.
    await verifyStoreDirectoryAt(requestedRoot, storeId, journal.beforeStateSha256);
    const currentRoot = await journalDirectory(parent, requestedRoot,
      'Authority Store recovery root');
    if (!sameJournalDirectory(rootObserved, currentRoot)) {
      fail('Authority Store recovery root changed during verification.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    const backupObserved = await journalDirectory(
      parent, backup, 'Authority recovery retired store', { optional: true }
    );
    if (backupObserved !== null) {
      fail('Authority transport recovery found an ambiguous retired store.',
        'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
    }
    const stageObserved = await journalDirectory(
      parent, stage, 'Authority recovery stage', { optional: true }
    );
    if (journal.operation === 'import' && stageObserved !== null) {
      await verifyStoreDirectoryAt(stage, storeId, journal.afterStateSha256, {
        operation: 'import', receiptSha256: journal.receiptSha256
      });
      await renameJournalDirectory(parent, stage, `${stage}.aborted-${randomUUID()}`,
        'Authority import recovery stage', stageObserved);
    } else if (journal.operation === 'rollback') {
      if (stageObserved === null) {
        fail('Authority rollback recovery backup is missing.',
          'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
      }
      await verifyStoreDirectoryAt(stage, storeId, journal.afterStateSha256, {
        operation: 'rollback', receiptSha256: journal.receiptSha256,
        allowMissingReceipt: true
      });
      await cleanupAbortedRollbackStage(parent, stage, journal, stageObserved);
    }
    await rm(journalFile, { force: true });
    await fsyncDirectory(parent);
    return;
  }
  if (rootDigest === null) {
    const backupObserved = await journalDirectory(
      parent, backup, 'Authority recovery retired store', { optional: true }
    );
    const stageObserved = await journalDirectory(
      parent, stage, 'Authority recovery stage', { optional: true }
    );
    if (backupObserved !== null && stageObserved !== null) {
      const backupDigest = await stateDigestAt(backup);
      const stageDigest = await stateDigestAt(stage);
      if (backupDigest === journal.beforeStateSha256
          && stageDigest === journal.afterStateSha256) {
        await verifyStoreDirectoryAt(backup, storeId, journal.beforeStateSha256);
        await verifyStoreDirectoryAt(stage, storeId, journal.afterStateSha256, {
          operation: journal.operation, receiptSha256: journal.receiptSha256,
          allowMissingReceipt: journal.operation === 'rollback'
        });
        await renameJournalDirectory(parent, backup, requestedRoot,
          'Authority recovery retired store', backupObserved);
        if (journal.operation === 'import') {
          await renameJournalDirectory(parent, stage, `${stage}.aborted-${randomUUID()}`,
            'Authority import recovery stage', stageObserved);
        } else {
          await cleanupAbortedRollbackStage(parent, stage, journal, stageObserved);
        }
        await rm(journalFile, { force: true });
        await fsyncDirectory(parent);
        return;
      }
    }
  }
  fail('Authority transport cutover is interrupted and cannot be resolved to the exact old or new head.',
    'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED', {
      expectedBeforeStateSha256: journal.beforeStateSha256,
      expectedAfterStateSha256: journal.afterStateSha256
    });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function authorityLockOwner(storeId, now = Date.now()) {
  const core = {
    lockFormat: AUTHORITY_LOCK_FORMAT,
    lockVersion: AUTHORITY_LOCK_VERSION,
    storeId,
    token: randomUUID(),
    host: os.hostname(),
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AUTHORITY_LOCK_TTL_MS).toISOString()
  };
  return Object.freeze({ ...core, ownerSha256: platformSha256(core) });
}

function authorityHeartbeatPath(directory, owner) {
  return path.join(directory, `heartbeat-${owner.token}`);
}

function startAuthorityHeartbeat(directory, owner) {
  const heartbeat = authorityHeartbeatPath(directory, owner);
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    const now = new Date();
    pending = pending.then(() => utimes(heartbeat, now, now)).catch(() => undefined);
  }, Math.max(250, Math.floor(AUTHORITY_LOCK_TTL_MS / 3)));
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
  };
}

function validateAuthorityLockOwner(value, storeId) {
  if (!isPlainPlatformObject(value)) {
    fail('Authority Store lock owner must be an object.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  // Inspect the private protocol version before exact validation. A newer build may legitimately
  // add fields, and treating those as corruption/staleness would let this build steal its live lock.
  if (value.lockFormat !== AUTHORITY_LOCK_FORMAT) {
    fail('Authority Store lock uses an unknown private format.', 'SGOS_AUTHORITY_LOCK_FORMAT_UNSUPPORTED');
  }
  if (!Number.isInteger(value.lockVersion) || value.lockVersion < 1) {
    fail('Authority Store lock version is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  if (value.lockVersion > AUTHORITY_LOCK_VERSION) {
    fail(`Authority Store lock version ${value.lockVersion} is newer than this build supports.`,
      'SGOS_AUTHORITY_LOCK_VERSION_UNSUPPORTED', { lockVersion: value.lockVersion });
  }
  exactObject(value, [
    'lockFormat', 'lockVersion', 'storeId', 'token', 'host', 'pid', 'acquiredAt', 'expiresAt',
    'ownerSha256'
  ], 'Authority Store lock owner');
  if (value.storeId !== storeId) {
    fail('Authority Store lock belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
  }
  if (typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/.test(value.token)) {
    fail('Authority Store lock token is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  if (typeof value.host !== 'string' || value.host.length < 1 || value.host.length > 255
      || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    fail('Authority Store lock host or process identity is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  const acquired = Date.parse(value.acquiredAt);
  const expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) {
    fail('Authority Store lock lease timestamps are invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  const core = { ...value };
  delete core.ownerSha256;
  if (value.ownerSha256 !== platformSha256(core)) {
    fail('Authority Store lock owner digest is invalid.', 'SGOS_AUTHORITY_LOCK_CORRUPT');
  }
  return Object.freeze({ ...value, acquired, expires });
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs && left.size === right.size);
}

async function waitBriefly() {
  await new Promise((resolve) => setTimeout(resolve, AUTHORITY_LOCK_RETRY_MS));
}

async function withStableCutoverLock(parent, storeId, operation) {
  const directory = path.join(parent, `.authority-cutover-lock-${storeId}`);

  async function inspect() {
    let info;
    try { info = await lstat(directory); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('Authority cutover lock must be a real directory.', 'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    let rawOwner = null;
    try {
      rawOwner = await safeReadJson(
        path.join(directory, 'owner.json'), 'Authority cutover lock owner'
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const owner = rawOwner === null ? null : validateAuthorityLockOwner(rawOwner, storeId);
    let heartbeatModifiedAt = null;
    if (owner) {
      const heartbeat = await lstat(authorityHeartbeatPath(directory, owner)).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (heartbeat) {
        if (heartbeat.isSymbolicLink() || !heartbeat.isFile()) {
          fail('Authority cutover lock heartbeat must be a regular file.',
            'SGOS_AUTHORITY_PATH_UNSAFE');
        }
        heartbeatModifiedAt = heartbeat.mtimeMs;
      }
    }
    return Object.freeze({ info, owner, heartbeatModifiedAt });
  }

  function reclaimable(lock, now = Date.now()) {
    if (!lock?.owner) {
      // mkdir is the acquisition boundary; owner publication follows it. Never interpret this
      // bounded, ownerless window as abandonment before the full acquisition grace has elapsed.
      return Boolean(lock) && now - lock.info.mtimeMs > AUTHORITY_LOCK_ACQUISITION_GRACE_MS;
    }
    if (lock.owner.acquired > now) return false;
    if (lock.owner.host === os.hostname() && !processAlive(lock.owner.pid)) return true;
    const heartbeatExpiry = Number.isFinite(lock.heartbeatModifiedAt)
      ? lock.heartbeatModifiedAt + AUTHORITY_LOCK_TTL_MS
      : 0;
    return now > Math.max(lock.owner.expires, heartbeatExpiry);
  }

  function sameObserved(left, right) {
    if (!left || !right || !sameFileIdentity(left.info, right.info)) return false;
    return (left.owner?.ownerSha256 ?? null) === (right.owner?.ownerSha256 ?? null)
      && left.heartbeatModifiedAt === right.heartbeatModifiedAt;
  }

  async function reclaim(seen) {
    const current = await inspect();
    if (!sameObserved(seen, current) || !reclaimable(current)) return false;
    const abandoned = path.join(parent,
      `.authority-cutover-lock-abandoned-${storeId}-${randomUUID()}`);
    try {
      await rename(directory, abandoned);
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false;
      throw error;
    }
    await fsyncDirectory(parent);
    return true;
  }

  for (let attempt = 0; attempt < AUTHORITY_CUTOVER_LOCK_ATTEMPTS; attempt += 1) {
    let created = false;
    let createdIdentity = null;
    let attemptedOwner = null;
    let acquiredOwner = null;
    try {
      await mkdir(directory, { mode: 0o700 });
      created = true;
      createdIdentity = await lstat(directory);
      const owner = authorityLockOwner(storeId);
      attemptedOwner = owner;
      const pendingOwner = path.join(directory, `.owner-${owner.token}.pending`);
      await writeExclusive(pendingOwner, owner);
      await writeExclusive(authorityHeartbeatPath(directory, owner), {
        lockFormat: `${AUTHORITY_LOCK_FORMAT}.heartbeat`,
        lockVersion: AUTHORITY_LOCK_VERSION,
        token: owner.token
      });
      await rename(pendingOwner, path.join(directory, 'owner.json'));
      await fsyncDirectory(directory);
      await fsyncDirectory(parent);
      acquiredOwner = owner;
    } catch (error) {
      if (created) {
        // A stalled publisher can itself pass the acquisition grace. Only remove the exact
        // directory inode this attempt created, and only while it is still ownerless or ours.
        const current = await inspect().catch(() => null);
        const sameCreatedDirectory = current && createdIdentity
          && ((createdIdentity.ino !== 0 && current.info.ino !== 0
            && createdIdentity.dev === current.info.dev && createdIdentity.ino === current.info.ino)
            || (createdIdentity.ino === 0 && current.info.ino === 0
              && createdIdentity.birthtimeMs === current.info.birthtimeMs));
        if (sameCreatedDirectory
            && (!current.owner || current.owner.token === attemptedOwner?.token)) {
          const failed = path.join(parent,
            `.authority-cutover-lock-failed-${storeId}-${attemptedOwner?.token ?? randomUUID()}`);
          await rename(directory, failed).catch(() => undefined);
          await rm(failed, { recursive: true, force: true }).catch(() => {});
          await fsyncDirectory(parent).catch(() => {});
        }
        throw error;
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const existing = await inspect();
      if (existing && reclaimable(existing) && await reclaim(existing)) continue;
      await waitBriefly();
    }
    if (acquiredOwner) {
      const stopHeartbeat = startAuthorityHeartbeat(directory, acquiredOwner);
      try {
        return await operation(acquiredOwner);
      } finally {
        await stopHeartbeat();
        const observed = await inspect();
        if (!observed?.owner || observed.owner.token !== acquiredOwner.token) {
          fail('Authority cutover lock ownership changed before release.',
            'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST');
        }
        const released = path.join(parent,
          `.authority-cutover-lock-released-${storeId}-${acquiredOwner.token}`);
        await rename(directory, released);
        await fsyncDirectory(parent);
        await rm(released, { recursive: true });
        await fsyncDirectory(parent);
      }
    }
  }
  fail('Authority Store cutover is busy.', 'SGOS_AUTHORITY_STORE_BUSY', { storeId });
}

function normalizeChanges(changes, entries) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 128) {
    fail('Authority transaction requires 1..128 changes.');
  }
  const normalized = changes.map((change, index) => {
    exactObject(change, ['op', 'key', 'value'], `changes[${index}]`);
    if (!['put', 'delete'].includes(change.op)) fail(`changes[${index}].op is invalid.`);
    identifier(change.key, `changes[${index}].key`);
    if (change.op === 'put') {
      if (!Object.hasOwn(change, 'value')) fail(`changes[${index}] put requires a value.`);
      return { op: 'put', key: change.key, value: clonePlatformJson(change.value) };
    }
    if (Object.hasOwn(change, 'value')) fail(`changes[${index}] delete cannot carry a value.`);
    if (!Object.hasOwn(entries, change.key)) fail(`Authority key '${change.key}' does not exist.`, 'SGOS_AUTHORITY_DELETE_MISSING');
    return { op: 'delete', key: change.key };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].key === normalized[index].key) fail(`Authority key '${normalized[index].key}' is changed more than once.`);
  }
  return normalized;
}

function applyChanges(entries, changes) {
  const next = clonePlatformJson(entries);
  for (const change of changes) {
    if (change.op === 'put') next[change.key] = clonePlatformJson(change.value);
    else delete next[change.key];
  }
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

function eventFilename(eventSha256) {
  if (!/^sha256:[a-f0-9]{64}$/.test(String(eventSha256 ?? ''))) fail('Authority event digest is invalid.');
  return `${eventSha256.slice(7)}.json`;
}

export function assertAuthorityStoreAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') fail('Authority Store adapter is required.');
  for (const method of ['read', 'transact', 'verify', 'planRecovery', 'recover', 'exportPortable']) {
    if (typeof adapter[method] !== 'function') fail(`Authority Store adapter is missing '${method}'.`);
  }
  if (adapter.profile !== 'experimental-filesystem-v1') {
    fail(`Authority Store profile '${adapter.profile ?? 'unknown'}' is not enabled.`, 'SGOS_AUTHORITY_PROFILE_UNSUPPORTED');
  }
  return adapter;
}

async function verifyEventSequence(storeId, head, events) {
  let entries = {};
  let priorEventSha256 = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = validatePlatformRecord(events[index], 'platform-authority-transaction');
    if (event.storeId !== storeId || event.revision !== index + 1 || event.priorEventSha256 !== priorEventSha256) {
      fail('Authority event lineage is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    if (event.beforeEntriesSha256 !== platformSha256(entries)) {
      fail('Authority event before-state digest is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    entries = applyChanges(entries, event.changes);
    if (event.afterEntriesSha256 !== platformSha256(entries)) {
      fail('Authority event after-state digest is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    }
    priorEventSha256 = event.recordSha256;
  }
  if (head.revision !== events.length || head.eventSha256 !== priorEventSha256
      || head.entriesSha256 !== platformSha256(entries)
      || canonicalJson(head.entries) !== canonicalJson(entries)) {
    fail('Authority head does not match its immutable event lineage.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  return entries;
}

function authorityStateAt(storeId, events, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > events.length) {
    fail('Authority transport checkpoint revision is outside the transported lineage.',
      'SGOS_AUTHORITY_TRANSPORT_STALE');
  }
  let entries = {};
  let eventSha256 = null;
  for (let index = 0; index < revision; index += 1) {
    entries = applyChanges(entries, events[index].changes);
    eventSha256 = events[index].recordSha256;
  }
  return createAuthorityState({
    storeId,
    revision,
    eventSha256,
    entriesSha256: platformSha256(entries),
    entries
  });
}

function assertMinimumAuthorityCheckpoint(head, events, minimumAuthority) {
  if (!isPlainPlatformObject(minimumAuthority)
      || !Number.isSafeInteger(minimumAuthority.revision)
      || minimumAuthority.revision < 0
      || !/^sha256:[a-f0-9]{64}$/.test(String(minimumAuthority.stateSha256 ?? ''))) {
    fail('Approved Authority Store minimum checkpoint is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
  }
  if (head.revision < minimumAuthority.revision) {
    fail('Authority Store predates the approved anti-rollback checkpoint.',
      'SGOS_AUTHORITY_TRANSPORT_STALE', {
        currentRevision: head.revision,
        minimumRevision: minimumAuthority.revision
      });
  }
  const checkpoint = authorityStateAt(head.storeId, events, minimumAuthority.revision);
  if (checkpoint.recordSha256 !== minimumAuthority.stateSha256) {
    fail('Authority Store does not contain the approved anti-rollback checkpoint.',
      'SGOS_AUTHORITY_TRANSPORT_STALE', {
        minimumRevision: minimumAuthority.revision,
        minimumStateSha256: minimumAuthority.stateSha256
      });
  }
}

async function verifyAuthoritySnapshot(record, {
  expectedStoreId = null,
  expectedRepositoryBindingSha256,
  expectedPolicySha256,
  minimumAuthority = null,
  minimumArtifactField,
  validateEntries
}) {
  assertPortableTransportContent(record);
  if (expectedStoreId !== null && record.storeId !== expectedStoreId) {
    fail('Authority transport belongs to another store.',
      'SGOS_AUTHORITY_TRANSPORT_STORE_MISMATCH');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(expectedRepositoryBindingSha256 ?? ''))
      || record.repositoryBindingSha256 !== expectedRepositoryBindingSha256) {
    fail('Authority transport belongs to another repository authority.',
      'SGOS_AUTHORITY_TRANSPORT_REPOSITORY_MISMATCH');
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(expectedPolicySha256 ?? ''))
      || record.policySha256 !== expectedPolicySha256) {
    fail('Authority transport was signed under stale or different approved trust.',
      'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
  }
  const entries = await verifyEventSequence(record.storeId, record.head, record.events);
  if (minimumAuthority !== null) {
    if (!isPlainPlatformObject(minimumAuthority)
        || !Number.isSafeInteger(minimumAuthority.revision) || minimumAuthority.revision < 0
        || !/^sha256:[a-f0-9]{64}$/.test(String(minimumAuthority.stateSha256 ?? ''))
        || !/^sha256:[a-f0-9]{64}$/.test(
          String(minimumAuthority[minimumArtifactField] ?? '')
        )) {
      fail('Approved Authority transport checkpoint is invalid.',
        'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
    }
    if (record.head.revision < minimumAuthority.revision) {
      fail('Authority transport predates the approved anti-rollback checkpoint.',
        'SGOS_AUTHORITY_TRANSPORT_STALE');
    }
    const checkpoint = authorityStateAt(record.storeId, record.events, minimumAuthority.revision);
    if (checkpoint.recordSha256 !== minimumAuthority.stateSha256
        || (record.head.revision === minimumAuthority.revision
          && record.recordSha256 !== minimumAuthority[minimumArtifactField])) {
      fail('Authority transport does not contain the approved anti-rollback checkpoint.',
        'SGOS_AUTHORITY_TRANSPORT_STALE');
    }
  }
  if (typeof validateEntries !== 'function') {
    fail('Authority transport requires a semantic entry validator.',
      'SGOS_AUTHORITY_TRANSPORT_ACTIVE_PACK_INVALID');
  }
  const semantic = await validateEntries(
    clonePlatformJson(entries), clonePlatformJson(record.events)
  );
  return clonePlatformJson(semantic ?? {});
}

/** Verify one public transport without trusting any key or repository claim carried by it. */
export async function verifyPortableAuthorityTransport(signedTransport, {
  trustedPublicKeyPem,
  expectedKeyId,
  expectedStoreId = null,
  expectedRepositoryBindingSha256,
  expectedPolicySha256,
  minimumAuthority = null,
  validateEntries
}) {
  const record = verifySignedPlatformRecord(signedTransport, {
    trustedPublicKeyPem,
    expectedKeyId,
    expectedKind: 'platform-authority-transport'
  });
  const semantic = await verifyAuthoritySnapshot(record, {
    expectedStoreId,
    expectedRepositoryBindingSha256,
    expectedPolicySha256,
    minimumAuthority,
    minimumArtifactField: 'exportSha256',
    validateEntries
  });
  return Object.freeze({
    valid: true,
    record,
    storeId: record.storeId,
    revision: record.head.revision,
    stateSha256: record.head.recordSha256,
    eventSha256: record.head.eventSha256,
    exportSha256: record.recordSha256,
    signedTransportSha256: platformSha256(signedTransport),
    signerKeyId: signedTransport.signature.keyId,
    semantic
  });
}

/**
 * Verify one deterministic projection and bind the Git provenance observed by the caller.
 *
 * This function does not claim to inspect Git. Its caller must supply the exact commit from which
 * it read `projection` and the configured branch it resolved. The returned immutable provenance
 * is carried into the import plan and durable cutover receipt.
 */
export async function verifyAuthorityGitProjection(projection, {
  expectedStoreId = null,
  expectedRepositoryBindingSha256,
  expectedPolicySha256,
  expectedStateBranch,
  stateBranch,
  stateCommit,
  minimumAuthority = null,
  validateEntries
}) {
  const record = validatePlatformRecord(
    projection, 'platform-authority-git-projection'
  );
  const expectedBranch = canonicalStateBranch(
    expectedStateBranch, 'expectedStateBranch'
  );
  const observedBranch = canonicalStateBranch(stateBranch);
  if (observedBranch !== expectedBranch) {
    fail('Authority Git projection was read from a different state branch.',
      'SGOS_AUTHORITY_GIT_PROVENANCE_MISMATCH', {
        expectedStateBranch: expectedBranch,
        observedStateBranch: observedBranch
      });
  }
  const observedCommit = exactGitCommit(stateCommit);
  const semantic = await verifyAuthoritySnapshot(record, {
    expectedStoreId,
    expectedRepositoryBindingSha256,
    expectedPolicySha256,
    minimumAuthority,
    minimumArtifactField: 'projectionSha256',
    validateEntries
  });
  return Object.freeze({
    valid: true,
    record,
    storeId: record.storeId,
    revision: record.head.revision,
    stateSha256: record.head.recordSha256,
    eventSha256: record.head.eventSha256,
    projectionSha256: record.recordSha256,
    gitProvenance: Object.freeze({
      stateBranch: observedBranch,
      stateCommit: observedCommit
    }),
    semantic
  });
}

function authorityImportDelta(currentHead, currentEvents, imported) {
  if (currentHead.storeId !== imported.storeId) {
    fail('Authority transport and destination Store IDs differ.',
      'SGOS_AUTHORITY_TRANSPORT_STORE_MISMATCH');
  }
  const shared = Math.min(currentEvents.length, imported.events.length);
  for (let index = 0; index < shared; index += 1) {
    if (currentEvents[index].recordSha256 !== imported.events[index].recordSha256) {
      fail('Authority transport lineage diverges from the destination store.',
        'SGOS_AUTHORITY_TRANSPORT_DIVERGED', { revision: index + 1 });
    }
  }
  if (currentHead.revision > imported.head.revision) {
    fail('Authority transport is behind the destination store; ordinary import never rewinds authority.',
      'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
  }
  if (currentHead.revision === imported.head.revision
      && currentHead.recordSha256 !== imported.head.recordSha256) {
    fail('Authority transport head differs at the destination revision.',
      'SGOS_AUTHORITY_TRANSPORT_DIVERGED');
  }
  const mode = currentHead.revision === imported.head.revision
    ? 'noop' : currentHead.revision === 0 ? 'install' : 'fast-forward';
  const importedEventSha256s = imported.events.slice(currentHead.revision)
    .map((event) => event.recordSha256);
  return Object.freeze({ mode, importedEventSha256s });
}

function authorityImportContext(authorityContextSha256) {
  if (authorityContextSha256 !== null
      && !/^sha256:[a-f0-9]{64}$/.test(String(authorityContextSha256))) {
    fail('Authority import context digest is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
  }
  return authorityContextSha256;
}

export function planPortableAuthorityImport(currentHead, currentEvents, transport, {
  authorityContextSha256 = null
} = {}) {
  authorityImportContext(authorityContextSha256);
  const imported = transport.record;
  const { mode, importedEventSha256s } = authorityImportDelta(
    currentHead, currentEvents, imported
  );
  const core = {
    kind: 'platform-authority-import-plan',
    transportProfile: AUTHORITY_TRANSPORT_PROFILE,
    repositoryBindingSha256: imported.repositoryBindingSha256,
    policySha256: imported.policySha256,
    authorityContextSha256,
    storeId: imported.storeId,
    exportSha256: imported.recordSha256,
    beforeRevision: currentHead.revision,
    beforeStateSha256: currentHead.recordSha256,
    afterRevision: imported.head.revision,
    afterStateSha256: imported.head.recordSha256,
    mode,
    importedEventSha256s
  };
  return Object.freeze({ ...core, confirmationSha256: platformSha256(core) });
}

export function planAuthorityGitProjectionImport(currentHead, currentEvents, projection, {
  authorityContextSha256 = null, forceInstall = false
} = {}) {
  authorityImportContext(authorityContextSha256);
  if (typeof forceInstall !== 'boolean') {
    fail('Authority Git projection installation intent is invalid.',
      'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
  }
  const imported = projection.record;
  const delta = authorityImportDelta(
    currentHead, currentEvents, imported
  );
  const mode = forceInstall && delta.mode === 'noop' && currentHead.revision === 0
    ? 'install' : delta.mode;
  const importedEventSha256s = delta.importedEventSha256s;
  const core = {
    kind: 'platform-authority-git-import-plan',
    projectionProfile: PLATFORM_AUTHORITY_GIT_PROJECTION_PROFILE,
    repositoryBindingSha256: imported.repositoryBindingSha256,
    policySha256: imported.policySha256,
    authorityContextSha256,
    storeId: imported.storeId,
    projectionSha256: imported.recordSha256,
    stateBranch: projection.gitProvenance.stateBranch,
    stateCommit: projection.gitProvenance.stateCommit,
    beforeRevision: currentHead.revision,
    beforeStateSha256: currentHead.recordSha256,
    afterRevision: imported.head.revision,
    afterStateSha256: imported.head.recordSha256,
    mode,
    importedEventSha256s
  };
  return Object.freeze({ ...core, confirmationSha256: platformSha256(core) });
}

export async function openFilesystemAuthorityStore({
  root, storeId, skipCutoverLock = false, allowLegacyStoreId = false
}) {
  if (allowLegacyStoreId) {
    identifier(storeId, 'storeId');
    if (process.platform === 'win32'
        && (!PORTABLE_STORE_ID.test(storeId) || WINDOWS_RESERVED_STORE_ID.test(storeId))) {
      fail('Legacy Authority Store IDs that are not portable cannot be opened on Windows.',
        'SGOS_AUTHORITY_STORE_ID_INVALID');
    }
  } else {
    assertPortableAuthorityStoreId(storeId);
  }
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('Authority Store root must be an absolute path.', 'SGOS_AUTHORITY_PATH_UNSAFE');
  const requestedRoot = path.resolve(root);
  const parentRoot = path.dirname(requestedRoot);
  await mkdir(parentRoot, { recursive: true, mode: 0o700 });
  const prepare = async () => {
    await recoverInterruptedTransportCutover(requestedRoot, storeId);
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    await assertNotSymlink(requestedRoot, 'Authority Store root', { directory: true });
  };
  if (skipCutoverLock) await prepare();
  else await withStableCutoverLock(parentRoot, storeId, prepare);
  const canonicalRoot = await realpath(requestedRoot);
  const eventsDirectory = path.join(canonicalRoot, 'events');
  await mkdir(eventsDirectory, { recursive: true, mode: 0o700 });
  await assertNotSymlink(eventsDirectory, 'Authority Store events directory', { directory: true });
  const stateFile = path.join(canonicalRoot, 'state.json');
  const lockDirectory = path.join(canonicalRoot, '.transaction-lock');

  async function assertLayout() {
    const reboundRoot = await realpath(requestedRoot).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (reboundRoot !== canonicalRoot) {
      fail('Authority Store was replaced by an import or rollback; reopen it before retrying.',
        'SGOS_AUTHORITY_STORE_REPLACED');
    }
    await assertNotSymlink(canonicalRoot, 'Authority Store root', { directory: true });
    await assertNotSymlink(eventsDirectory, 'Authority Store events directory', { directory: true });
    await assertNotSymlink(stateFile, 'Authority Store state', { optional: true });
  }

  async function inspectLock() {
    let info;
    try { info = await lstat(lockDirectory); } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('Authority Store lock must be a real directory.', 'SGOS_AUTHORITY_PATH_UNSAFE');
    }
    let rawOwner;
    try { rawOwner = await safeReadJson(path.join(lockDirectory, 'owner.json'), 'Authority Store lock owner'); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      rawOwner = null;
    }
    const owner = rawOwner === null ? null : validateAuthorityLockOwner(rawOwner, storeId);
    let heartbeatModifiedAt = null;
    if (owner) {
      let heartbeatInfo;
      try { heartbeatInfo = await lstat(authorityHeartbeatPath(lockDirectory, owner)); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (heartbeatInfo) {
        if (heartbeatInfo.isSymbolicLink() || !heartbeatInfo.isFile()) {
          fail('Authority Store lock heartbeat must be a regular file.', 'SGOS_AUTHORITY_PATH_UNSAFE');
        }
        heartbeatModifiedAt = heartbeatInfo.mtimeMs;
      }
    }
    return Object.freeze({ info, owner, heartbeatModifiedAt });
  }

  function reclaimableLock(lock, now = Date.now()) {
    if (!lock.owner) {
      // A newly-created directory precedes atomic owner publication by a few filesystem calls. It
      // is an acquiring lock throughout this bounded grace period, never evidence of abandonment.
      return now - lock.info.mtimeMs > AUTHORITY_LOCK_ACQUISITION_GRACE_MS;
    }
    if (lock.owner.acquired > now) return false;
    // A dead same-host owner is conclusive and can be recovered before its conservative lease
    // deadline. Otherwise expiry is authoritative only when the token-specific heartbeat also
    // expired. This prevents a recycled/live PID from stranding the store forever while ensuring a
    // genuinely active operation continually extends its lease.
    if (lock.owner.host === os.hostname() && !processAlive(lock.owner.pid)) return true;
    const heartbeatExpiry = Number.isFinite(lock.heartbeatModifiedAt)
      ? lock.heartbeatModifiedAt + AUTHORITY_LOCK_TTL_MS
      : 0;
    return now > Math.max(lock.owner.expires, heartbeatExpiry);
  }

  function sameObservedLock(left, right) {
    if (!left || !right || !sameFileIdentity(left.info, right.info)) return false;
    return (left.owner?.ownerSha256 ?? null) === (right.owner?.ownerSha256 ?? null)
      && left.heartbeatModifiedAt === right.heartbeatModifiedAt;
  }

  async function reclaimLock(seen) {
    const current = await inspectLock();
    if (!sameObservedLock(seen, current) || !reclaimableLock(current)) return false;
    // Rename is the recovery commit point. The abandoned directory is deliberately retained under
    // a unique forensic name: recovery never recursively deletes evidence and a competing process
    // cannot mistake these exact bytes for the active lock.
    const condemned = path.join(canonicalRoot,
      `.transaction-lock.reclaimed-${Date.now()}-${randomUUID()}`);
    try { await rename(lockDirectory, condemned); } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false;
      throw error;
    }
    await fsyncDirectory(canonicalRoot);
    return true;
  }

  async function acquireLock() {
    const owner = authorityLockOwner(storeId);
    for (let attempt = 0; attempt < AUTHORITY_LOCK_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await inspectLock();
        if (existing && reclaimableLock(existing) && await reclaimLock(existing)) continue;
        if (!existing || (!existing.owner && attempt + 1 < AUTHORITY_LOCK_ATTEMPTS)) {
          await waitBriefly();
          continue;
        }
        fail('Authority Store is busy.', 'SGOS_AUTHORITY_STORE_BUSY', {
          lock: lockDirectory,
          owner: existing.owner ? {
            host: existing.owner.host,
            pid: existing.owner.pid,
            acquiredAt: existing.owner.acquiredAt,
            expiresAt: existing.owner.expiresAt
          } : null
        });
      }
      // Publish a complete, fsynced owner atomically. Readers either see no owner (and observe the
      // acquisition grace) or the exact self-hashed record; they never accept a partial JSON write.
      const pending = path.join(lockDirectory, `.owner-${owner.token}.pending`);
      await writeExclusive(pending, owner);
      await writeExclusive(authorityHeartbeatPath(lockDirectory, owner), {
        lockFormat: `${AUTHORITY_LOCK_FORMAT}.heartbeat`,
        lockVersion: AUTHORITY_LOCK_VERSION,
        token: owner.token
      });
      await rename(pending, path.join(lockDirectory, 'owner.json'));
      await fsyncDirectory(lockDirectory);
      await fsyncDirectory(canonicalRoot);
      return owner;
    }
    fail('Authority Store lock could not be acquired after bounded retries.', 'SGOS_AUTHORITY_STORE_BUSY', {
      lock: lockDirectory
    });
  }

  async function releaseLock(owner) {
    const current = await inspectLock();
    if (!current?.owner || current.owner.token !== owner.token) {
      fail('Authority Store lock ownership changed before release.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST');
    }
    const released = path.join(canonicalRoot, `.transaction-lock.released-${owner.token}-${randomUUID()}`);
    try { await rename(lockDirectory, released); } catch (error) {
      if (error?.code === 'ENOENT') {
        fail('Authority Store lock disappeared before release.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST');
      }
      throw error;
    }
    // Recheck the token after the atomic move before deleting our own completed lease. If anything
    // unexpected moved, leave it quarantined for inspection instead of erasing another owner.
    const moved = validateAuthorityLockOwner(
      await safeReadJson(path.join(released, 'owner.json'), 'Released Authority Store lock owner'),
      storeId
    );
    if (moved.token !== owner.token) {
      fail('Released Authority Store lock does not match its owner token.', 'SGOS_AUTHORITY_LOCK_OWNERSHIP_LOST', {
        quarantine: released
      });
    }
    await rm(released, { recursive: true });
    await fsyncDirectory(canonicalRoot);
  }

  async function withLock(operation) {
    await assertLayout();
    const owner = await acquireLock();
    const stopHeartbeat = startAuthorityHeartbeat(lockDirectory, owner);
    try {
      // A process may have waited on the old store lock while another process atomically replaced
      // that complete store. Rebind after acquisition so a stale adapter can never mutate backup.
      await assertLayout();
      return await operation(owner);
    } finally {
      await stopHeartbeat();
      await releaseLock(owner);
    }
  }

  async function readState() {
    await assertLayout();
    const envelope = validatePlatformEnvelope(await safeReadJson(stateFile, 'Authority Store state'), 'platform-authority-state');
    const state = validatePlatformRecord(envelope.record, 'platform-authority-state');
    if (state.storeId !== storeId) fail('Authority Store state belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
    return state;
  }

  async function readEvent(eventSha256) {
    const file = path.join(eventsDirectory, eventFilename(eventSha256));
    const envelope = validatePlatformEnvelope(await safeReadJson(file, `Authority event ${eventSha256}`), 'platform-authority-transaction');
    const event = validatePlatformRecord(envelope.record, 'platform-authority-transaction');
    if (event.recordSha256 !== eventSha256) fail('Authority event file name does not bind its contents.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    return event;
  }

  async function lineage(head) {
    if (head.revision > MAX_AUTHORITY_EVENTS) fail('Authority event history exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    const reverse = [];
    let next = head.eventSha256;
    while (next !== null) {
      if (reverse.length >= MAX_AUTHORITY_EVENTS) fail('Authority event history exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
      const event = await readEvent(next);
      reverse.push(event);
      next = event.priorEventSha256;
    }
    return reverse.reverse();
  }

  async function recoveryInspection() {
    const head = await readState();
    const events = await lineage(head);
    await verifyEventSequence(storeId, head, events);
    const allFiles = await readdir(eventsDirectory);
    if (allFiles.length > MAX_AUTHORITY_EVENTS) fail('Authority event directory exceeds the installed ceiling.', 'SGOS_AUTHORITY_LIMIT_EXCEEDED');
    if (allFiles.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) {
      fail('Authority event directory contains an unexpected entry.', 'SGOS_AUTHORITY_STORE_CORRUPT');
    }
    const reachable = new Set(events.map((event) => `${event.recordSha256.slice(7)}.json`));
    const orphanFiles = allFiles.filter((name) => !reachable.has(name)).sort();
    if (!orphanFiles.length) return { head, events, orphanEventCount: 0, recoveryPlan: null };
    const remaining = new Map();
    for (const file of orphanFiles) {
      const event = await readEvent(`sha256:${file.slice(0, -'.json'.length)}`);
      remaining.set(event.recordSha256, event);
    }
    const recoveredEvents = [];
    let priorEventSha256 = head.eventSha256;
    let revision = head.revision;
    let entries = clonePlatformJson(head.entries);
    while (remaining.size) {
      const next = [...remaining.values()].filter((event) =>
        event.priorEventSha256 === priorEventSha256 && event.revision === revision + 1);
      if (next.length !== 1) {
        fail('Authority Store orphan events do not form one exact forward recovery chain.',
          'SGOS_AUTHORITY_RECOVERY_AMBIGUOUS', {
            orphanEventCount: orphanFiles.length,
            candidatesAtBoundary: next.length,
            revision
          });
      }
      const event = next[0];
      if (event.beforeEntriesSha256 !== platformSha256(entries)) {
        fail('Authority recovery event does not bind the current state.',
          'SGOS_AUTHORITY_LINEAGE_INVALID', { eventSha256: event.recordSha256 });
      }
      entries = applyChanges(entries, event.changes);
      if (event.afterEntriesSha256 !== platformSha256(entries)) {
        fail('Authority recovery event after-state is invalid.',
          'SGOS_AUTHORITY_LINEAGE_INVALID', { eventSha256: event.recordSha256 });
      }
      recoveredEvents.push(event);
      remaining.delete(event.recordSha256);
      priorEventSha256 = event.recordSha256;
      revision = event.revision;
    }
    const recoveredHead = createAuthorityState({
      storeId,
      revision,
      eventSha256: priorEventSha256,
      entriesSha256: platformSha256(entries),
      entries
    });
    const planCore = {
      kind: 'platform-authority-recovery-plan',
      storeId,
      beforeRevision: head.revision,
      beforeStateSha256: head.recordSha256,
      eventSha256s: recoveredEvents.map((event) => event.recordSha256),
      afterRevision: recoveredHead.revision,
      afterStateSha256: recoveredHead.recordSha256,
      orphanEventCount: orphanFiles.length
    };
    const recoveryPlan = Object.freeze({
      ...planCore,
      confirmationSha256: platformSha256(planCore)
    });
    return { head, events, orphanEventCount: orphanFiles.length, recoveredHead, recoveryPlan };
  }

  async function verifiedSnapshot() {
    const inspected = await recoveryInspection();
    if (inspected.orphanEventCount) {
      fail('Authority Store contains events outside the committed head lineage.', 'SGOS_AUTHORITY_ROLLBACK_OR_PARTIAL_WRITE', {
        orphanEventCount: inspected.orphanEventCount,
        recoveryPlan: inspected.recoveryPlan
      });
    }
    return inspected;
  }

  const transportDirectory = path.join(canonicalRoot, 'transport');
  const transportReceiptsDirectory = path.join(transportDirectory, 'receipts');
  const transportRollbacksDirectory = path.join(transportDirectory, 'rollbacks');

  async function writeLockReplica(directory, owner) {
    const replica = path.join(directory, '.transaction-lock');
    await mkdir(replica, { mode: 0o700 });
    await writeExclusive(path.join(replica, 'owner.json'), owner);
    await writeExclusive(authorityHeartbeatPath(replica, owner), {
      lockFormat: `${AUTHORITY_LOCK_FORMAT}.heartbeat`,
      lockVersion: AUTHORITY_LOCK_VERSION,
      token: owner.token
    });
    await fsyncDirectory(replica);
  }

  async function stageTransportStore(directory, signedTransport, receipt, owner) {
    const record = signedTransport.record;
    await mkdir(directory, { mode: 0o700 });
    const stagedEvents = path.join(directory, 'events');
    await mkdir(stagedEvents, { mode: 0o700 });
    for (const event of record.events) {
      await writeExclusive(
        path.join(stagedEvents, eventFilename(event.recordSha256)),
        createPlatformEnvelope(event)
      );
    }
    await writeExclusive(path.join(directory, 'state.json'), createPlatformEnvelope(record.head));
    const receipts = path.join(directory, 'transport', 'receipts');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await writeExclusive(
      path.join(receipts, `${receipt.recordSha256.slice(7)}.json`),
      createPlatformEnvelope(receipt)
    );
    const imports = path.join(directory, 'transport', 'imports');
    await mkdir(imports, { recursive: true, mode: 0o700 });
    const signedTransportSha256 = platformSha256(signedTransport);
    if (signedTransportSha256 !== receipt.signedTransportSha256
        || signedTransport.signature?.keyId !== receipt.signerKeyId
        || record.recordSha256 !== receipt.exportSha256) {
      fail('Staged Authority import proof does not match its cutover receipt.',
        'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
    }
    await writeExclusive(
      path.join(imports, `${signedTransportSha256.slice(7)}.json`), signedTransport
    );
    await writeLockReplica(directory, owner);
    await fsyncDirectory(stagedEvents);
    await fsyncDirectory(directory);
    const stagedState = validatePlatformEnvelope(
      await safeReadJson(path.join(directory, 'state.json'), 'Staged Authority Store state'),
      'platform-authority-state'
    ).record;
    const stagedRecords = [];
    for (const event of record.events) {
      stagedRecords.push(validatePlatformEnvelope(
        await safeReadJson(
          path.join(stagedEvents, eventFilename(event.recordSha256)),
          'Staged Authority Store event'
        ),
        'platform-authority-transaction'
      ).record);
    }
    await verifyEventSequence(storeId, stagedState, stagedRecords);
    if (stagedState.recordSha256 !== record.head.recordSha256) {
      fail('Staged Authority Store does not equal the verified transport head.',
        'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
    }
  }

  async function stageGitProjectionStore(directory, projection, receipt, owner) {
    const record = validatePlatformRecord(
      projection, 'platform-authority-git-projection'
    );
    if (record.recordSha256 !== receipt.projectionSha256
        || record.repositoryBindingSha256 !== receipt.repositoryBindingSha256
        || record.policySha256 !== receipt.policySha256
        || record.head.recordSha256 !== receipt.afterHead.recordSha256) {
      fail('Staged Authority Git projection does not match its cutover receipt.',
        'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
    }
    await mkdir(directory, { mode: 0o700 });
    const stagedEvents = path.join(directory, 'events');
    await mkdir(stagedEvents, { mode: 0o700 });
    for (const event of record.events) {
      await writeExclusive(
        path.join(stagedEvents, eventFilename(event.recordSha256)),
        createPlatformEnvelope(event)
      );
    }
    await writeExclusive(path.join(directory, 'state.json'), createPlatformEnvelope(record.head));
    const receipts = path.join(directory, 'transport', 'receipts');
    await mkdir(receipts, { recursive: true, mode: 0o700 });
    await writeExclusive(
      path.join(receipts, `${receipt.recordSha256.slice(7)}.json`),
      createPlatformEnvelope(receipt)
    );
    const projections = path.join(directory, 'transport', 'git-projections');
    await mkdir(projections, { recursive: true, mode: 0o700 });
    await writeExclusive(
      path.join(projections, `${record.recordSha256.slice(7)}.json`), record
    );
    await writeLockReplica(directory, owner);
    await fsyncDirectory(stagedEvents);
    await fsyncDirectory(directory);
    const stagedState = validatePlatformEnvelope(
      await safeReadJson(path.join(directory, 'state.json'), 'Staged Authority Store state'),
      'platform-authority-state'
    ).record;
    const stagedRecords = [];
    for (const event of record.events) {
      stagedRecords.push(validatePlatformEnvelope(
        await safeReadJson(
          path.join(stagedEvents, eventFilename(event.recordSha256)),
          'Staged Authority Store event'
        ),
        'platform-authority-transaction'
      ).record);
    }
    await verifyEventSequence(storeId, stagedState, stagedRecords);
    if (stagedState.recordSha256 !== record.head.recordSha256) {
      fail('Staged Authority Store does not equal the verified Git projection head.',
        'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
    }
  }

  async function transportInput(options) {
    return verifyPortableAuthorityTransport(options.signedTransport, {
      trustedPublicKeyPem: options.trustedPublicKeyPem,
      expectedKeyId: options.expectedKeyId,
      expectedStoreId: storeId,
      expectedRepositoryBindingSha256: options.expectedRepositoryBindingSha256,
      expectedPolicySha256: options.expectedPolicySha256,
      minimumAuthority: options.minimumAuthority ?? null,
      validateEntries: options.validateEntries
    });
  }

  async function gitProjectionInput(options) {
    return verifyAuthorityGitProjection(options.projection, {
      expectedStoreId: storeId,
      expectedRepositoryBindingSha256: options.expectedRepositoryBindingSha256,
      expectedPolicySha256: options.expectedPolicySha256,
      expectedStateBranch: options.expectedStateBranch,
      stateBranch: options.stateBranch,
      stateCommit: options.stateCommit,
      minimumAuthority: options.minimumAuthority ?? null,
      validateEntries: options.validateEntries
    });
  }

  async function readCutover(cutoverSha256) {
    if (!/^sha256:[a-f0-9]{64}$/.test(String(cutoverSha256 ?? ''))) {
      fail('Authority rollback requires an exact cutover receipt digest.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    await assertNotSymlink(transportDirectory, 'Authority transport directory', {
      directory: true
    });
    await assertNotSymlink(transportReceiptsDirectory, 'Authority transport receipt directory', {
      directory: true
    });
    const file = path.join(transportReceiptsDirectory, `${cutoverSha256.slice(7)}.json`);
    await assertNotSymlink(file, 'Authority transport cutover receipt');
    const envelope = validatePlatformEnvelope(
      await safeReadJson(file, 'Authority transport cutover receipt')
    );
    if (!['platform-authority-cutover', 'platform-authority-git-cutover']
      .includes(envelope.family)) {
      fail('Authority transport cutover receipt has an unsupported kind.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    if (envelope.record.recordSha256 !== cutoverSha256
        || envelope.record.storeId !== storeId) {
      fail('Authority transport cutover receipt does not bind this store.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    if (envelope.family === 'platform-authority-cutover') {
      const proofFile = path.join(
        transportDirectory, 'imports', `${envelope.record.signedTransportSha256.slice(7)}.json`
      );
      await assertNotSymlink(path.join(transportDirectory, 'imports'),
        'Authority retained import directory', { directory: true });
      await assertNotSymlink(proofFile, 'Retained signed Authority transport');
      const signedTransport = await safeReadJson(
        proofFile, 'Retained signed Authority transport', {
          maximumBytes: MAX_AUTHORITY_TRANSPORT_BYTES
        }
      );
      if (platformSha256(signedTransport) !== envelope.record.signedTransportSha256
          || signedTransport?.record?.recordSha256 !== envelope.record.exportSha256
          || signedTransport?.signature?.keyId !== envelope.record.signerKeyId) {
        fail('Retained signed Authority transport does not match its cutover receipt.',
          'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
      }
      validatePlatformRecord(signedTransport.record, 'platform-authority-transport');
    } else {
      const projectionFile = path.join(
        transportDirectory, 'git-projections',
        `${envelope.record.projectionSha256.slice(7)}.json`
      );
      await assertNotSymlink(path.join(transportDirectory, 'git-projections'),
        'Authority retained Git projection directory', { directory: true });
      await assertNotSymlink(projectionFile, 'Retained Authority Git projection');
      const projection = validatePlatformRecord(await safeReadJson(
        projectionFile, 'Retained Authority Git projection', {
          maximumBytes: MAX_AUTHORITY_TRANSPORT_BYTES
        }
      ), 'platform-authority-git-projection');
      if (projection.recordSha256 !== envelope.record.projectionSha256
          || projection.repositoryBindingSha256 !== envelope.record.repositoryBindingSha256
          || projection.policySha256 !== envelope.record.policySha256
          || projection.head.recordSha256 !== envelope.record.afterHead.recordSha256) {
        fail('Retained Authority Git projection does not match its cutover receipt.',
          'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
      }
    }
    return envelope.record;
  }

  async function rollbackPlanFor(cutoverSha256, {
    validateRollback, authorityContextSha256 = null, minimumAuthority = null
  }) {
    if (authorityContextSha256 !== null
        && !/^sha256:[a-f0-9]{64}$/.test(String(authorityContextSha256))) {
      fail('Authority rollback context digest is invalid.',
        'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
    }
    const current = await verifiedSnapshot();
    const cutover = await readCutover(cutoverSha256);
    if (current.head.recordSha256 !== cutover.afterHead.recordSha256) {
      fail('Authority rollback is stale because the store changed after import.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    const backupName = `.authority-backup-${storeId}-${cutover.recordSha256.slice(7)}`;
    const backupRoot = path.join(path.dirname(canonicalRoot), backupName);
    const backupPresent = await assertNotSymlink(
      backupRoot, 'Authority rollback backup', { optional: true, directory: true }
    );
    const backupStatePresent = backupPresent && await assertNotSymlink(
      path.join(backupRoot, 'state.json'), 'Authority rollback backup state', { optional: true }
    );
    const backupEventsPresent = backupPresent && await assertNotSymlink(
      path.join(backupRoot, 'events'), 'Authority rollback backup events', {
        optional: true, directory: true
      }
    );
    if (!backupPresent || !backupStatePresent || !backupEventsPresent) {
      fail('Authority rollback backup is missing or incomplete.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    const backupSnapshot = await verifyStoreDirectoryAt(
      backupRoot, storeId, cutover.beforeHead.recordSha256, { includeEvents: true }
    );
    const before = backupSnapshot.head;
    if (minimumAuthority !== null) {
      try {
        // A rollback target above the floor must still contain the exact approved checkpoint; a
        // revision comparison alone cannot distinguish a different authority lineage.
        assertMinimumAuthorityCheckpoint(before, backupSnapshot.events, minimumAuthority);
      } catch (error) {
        if (error?.code !== 'SGOS_AUTHORITY_TRANSPORT_STALE') throw error;
        fail('Authority rollback target does not contain the approved anti-rollback checkpoint.',
          'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED', {
            rollbackRevision: before.revision,
            rollbackStateSha256: before.recordSha256,
            minimumRevision: minimumAuthority.revision,
            minimumStateSha256: minimumAuthority.stateSha256
          });
      }
    }
    if (typeof validateRollback !== 'function') {
      fail('Authority rollback requires a semantic safety validator.',
        'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    }
    await validateRollback(
      clonePlatformJson(before.entries),
      clonePlatformJson(current.head.entries),
      clonePlatformJson(backupSnapshot.events),
      clonePlatformJson(current.events)
    );
    const core = {
      kind: 'platform-authority-rollback-plan',
      repositoryBindingSha256: cutover.repositoryBindingSha256,
      authorityContextSha256,
      storeId,
      cutoverSha256,
      beforeStateSha256: current.head.recordSha256,
      afterStateSha256: before.recordSha256,
      minimumRevision: minimumAuthority?.revision ?? null,
      minimumStateSha256: minimumAuthority?.stateSha256 ?? null
    };
    return Object.freeze({
      ...core,
      confirmationSha256: platformSha256(core),
      backupName,
      currentHead: current.head,
      rollbackHead: before
    });
  }

  if (!await assertNotSymlink(stateFile, 'Authority Store state', { optional: true })) {
    await withLock(async () => {
      if (await assertNotSymlink(stateFile, 'Authority Store state', { optional: true })) return;
      const genesis = createAuthorityState({
        storeId, revision: 0, eventSha256: null, entriesSha256: platformSha256({}), entries: {}
      });
      await writeExclusive(stateFile, createPlatformEnvelope(genesis));
    });
  }

  const adapter = {
    profile: 'experimental-filesystem-v1',
    storeId,
    root: canonicalRoot,

    async read() {
      const { head } = await verifiedSnapshot();
      return clonePlatformJson(head);
    },

    /** Read one verified snapshot only when its immutable lineage contains the approved floor. */
    async readAtMinimum(minimumAuthority) {
      const { head, events } = await verifiedSnapshot();
      assertMinimumAuthorityCheckpoint(head, events, minimumAuthority);
      return clonePlatformJson(head);
    },

    async transact(input) {
      exactObject(input, [
        'expectedRevision', 'expectedStateSha256', 'actorId', 'authorization', 'changes'
      ], 'authority transaction');
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('expectedRevision must be a non-negative safe integer.');
      if (!/^sha256:[a-f0-9]{64}$/.test(String(input.expectedStateSha256 ?? ''))) fail('expectedStateSha256 is invalid.');
      identifier(input.actorId, 'authority transaction.actorId');
      return withLock(async () => {
        const { head: before } = await verifiedSnapshot();
        if (before.revision !== input.expectedRevision || before.recordSha256 !== input.expectedStateSha256) {
          fail('Authority transaction lost its compare-and-swap race.', 'SGOS_AUTHORITY_CAS_MISMATCH', {
            currentRevision: before.revision, currentStateSha256: before.recordSha256
          });
        }
        const changes = normalizeChanges(input.changes, before.entries);
        const entries = applyChanges(before.entries, changes);
        const event = createAuthorityTransactionEvent({
          storeId,
          revision: before.revision + 1,
          priorEventSha256: before.eventSha256,
          beforeEntriesSha256: before.entriesSha256,
          afterEntriesSha256: platformSha256(entries),
          actorId: input.actorId,
          ...(input.authorization == null ? {} : { authorization: input.authorization }),
          committedAt: new Date().toISOString(),
          changes
        });
        const eventFile = path.join(eventsDirectory, eventFilename(event.recordSha256));
        try { await writeExclusive(eventFile, createPlatformEnvelope(event)); } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const existing = validatePlatformEnvelope(await safeReadJson(eventFile, 'Existing authority event'), 'platform-authority-transaction');
          if (existing.recordSha256 !== event.recordSha256) fail('Authority event collision detected.', 'SGOS_AUTHORITY_STORE_CORRUPT');
        }
        const after = createAuthorityState({
          storeId,
          revision: event.revision,
          eventSha256: event.recordSha256,
          entriesSha256: event.afterEntriesSha256,
          entries
        });
        await writeAtomic(stateFile, createPlatformEnvelope(after));
        return clonePlatformJson(after);
      });
    },

    async verify() {
      const { head, orphanEventCount } = await verifiedSnapshot();
      return Object.freeze({
        valid: true,
        storeId,
        revision: head.revision,
        stateSha256: head.recordSha256,
        eventSha256: head.eventSha256,
        orphanEventCount
      });
    },

    async planRecovery() {
      const inspected = await recoveryInspection();
      if (!inspected.recoveryPlan) {
        return Object.freeze({
          required: false,
          storeId,
          revision: inspected.head.revision,
          stateSha256: inspected.head.recordSha256,
          orphanEventCount: 0,
          recoveryPlan: null
        });
      }
      return Object.freeze({
        required: true,
        storeId,
        revision: inspected.head.revision,
        stateSha256: inspected.head.recordSha256,
        orphanEventCount: inspected.orphanEventCount,
        recoveryPlan: inspected.recoveryPlan
      });
    },

    async recover({ confirmationSha256 }) {
      if (!/^sha256:[a-f0-9]{64}$/.test(String(confirmationSha256 ?? ''))) {
        fail('Authority recovery requires the exact plan confirmation digest.',
          'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_REQUIRED');
      }
      return withLock(async () => {
        const inspected = await recoveryInspection();
        if (!inspected.recoveryPlan) {
          return Object.freeze({
            recovered: false,
            storeId,
            revision: inspected.head.revision,
            stateSha256: inspected.head.recordSha256,
            recoveredEventCount: 0
          });
        }
        if (inspected.recoveryPlan.confirmationSha256 !== confirmationSha256) {
          fail('Authority recovery confirmation does not match the current exact recovery plan.',
            'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_MISMATCH', {
              requiredConfirmationSha256: inspected.recoveryPlan.confirmationSha256
            });
        }
        await writeAtomic(stateFile, createPlatformEnvelope(inspected.recoveredHead));
        const verified = await verifiedSnapshot();
        return Object.freeze({
          recovered: true,
          storeId,
          revision: verified.head.revision,
          stateSha256: verified.head.recordSha256,
          recoveredEventCount: inspected.recoveryPlan.eventSha256s.length,
          recoveryPlanSha256: confirmationSha256
        });
      });
    },

    async exportPortable({ privateKeyPem, keyId }) {
      const { head, events } = await verifiedSnapshot();
      const record = createAuthorityPortableExport({
        storeId, head, events, exportedAt: new Date().toISOString()
      });
      return signPlatformRecord(record, { privateKeyPem, keyId });
    },

    async exportTransport({
      privateKeyPem, keyId, repositoryBindingSha256, policySha256, authorization,
      validateEntries
    }) {
      assertPortableAuthorityStoreId(storeId);
      return withLock(async () => {
        const { head, events } = await verifiedSnapshot();
        if (typeof validateEntries !== 'function') {
          fail('Authority transport export requires a semantic entry validator.',
            'SGOS_AUTHORITY_TRANSPORT_ACTIVE_PACK_INVALID');
        }
        await validateEntries(clonePlatformJson(head.entries), clonePlatformJson(events));
        const record = createAuthorityTransport({
          transportProfile: AUTHORITY_TRANSPORT_PROFILE,
          attestationAuthority: PLATFORM_AUTHORITY_TRANSPORT_ATTESTATION,
          repositoryBindingSha256,
          policySha256,
          storeId,
          head,
          events,
          eventCount: events.length,
          authorization,
          exportedAt: new Date().toISOString()
        });
        assertPortableTransportContent(record);
        return signPlatformRecord(record, { privateKeyPem, keyId });
      });
    },

    async exportGitProjection({
      repositoryBindingSha256, policySha256, validateEntries
    }) {
      assertPortableAuthorityStoreId(storeId);
      return withLock(async () => {
        const { head, events } = await verifiedSnapshot();
        if (typeof validateEntries !== 'function') {
          fail('Authority Git projection export requires a semantic entry validator.',
            'SGOS_AUTHORITY_TRANSPORT_ACTIVE_PACK_INVALID');
        }
        await validateEntries(clonePlatformJson(head.entries), clonePlatformJson(events));
        const record = createAuthorityGitProjection({
          projectionProfile: PLATFORM_AUTHORITY_GIT_PROJECTION_PROFILE,
          repositoryBindingSha256,
          policySha256,
          storeId,
          head,
          events,
          eventCount: events.length
        });
        assertPortableTransportContent(record);
        return record;
      });
    },

    async planImport(options) {
      assertPortableAuthorityStoreId(storeId);
      const transport = await transportInput(options);
      const current = await verifiedSnapshot();
      return Object.freeze({
        transport,
        plan: planPortableAuthorityImport(current.head, current.events, transport, {
          authorityContextSha256: options.authorityContextSha256 ?? null
        })
      });
    },

    async planGitProjectionImport(options) {
      assertPortableAuthorityStoreId(storeId);
      const projection = await gitProjectionInput(options);
      const current = await verifiedSnapshot();
      return Object.freeze({
        projection,
        plan: planAuthorityGitProjectionImport(current.head, current.events, projection, {
          authorityContextSha256: options.authorityContextSha256 ?? null,
          forceInstall: options.forceInstall === true
        })
      });
    },

    /**
     * Prove that one exact Git projection completed its atomic local cutover.
     *
     * A revision-zero projection has the same Authority head as a newly opened empty Store. The
     * retained projection and its cutover receipt are therefore the durable distinction between a
     * completed genesis synchronization and a process that stopped after merely creating genesis.
     */
    async hasGitProjectionCutover({ projectionSha256, stateBranch, stateCommit }) {
      assertPortableAuthorityStoreId(storeId);
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(projectionSha256 ?? ''))) {
        fail('Authority Git cutover lookup requires an exact projection digest.',
          'SGOS_AUTHORITY_GIT_PROVENANCE_INVALID');
      }
      const branch = canonicalStateBranch(stateBranch);
      const commit = exactGitCommit(stateCommit);
      const current = await verifiedSnapshot();
      if (!await assertNotSymlink(transportDirectory, 'Authority transport directory', {
        optional: true, directory: true
      })) return false;
      const projectionDirectory = path.join(transportDirectory, 'git-projections');
      if (!await assertNotSymlink(projectionDirectory,
        'Authority retained Git projection directory', { optional: true, directory: true })) {
        return false;
      }
      const projectionFile = path.join(
        projectionDirectory, `${projectionSha256.slice(7)}.json`
      );
      if (!await assertNotSymlink(projectionFile, 'Retained Authority Git projection', {
        optional: true
      })) return false;
      const projection = validatePlatformRecord(await safeReadJson(
        projectionFile, 'Retained Authority Git projection', {
          maximumBytes: MAX_AUTHORITY_TRANSPORT_BYTES
        }
      ), 'platform-authority-git-projection');
      if (projection.recordSha256 !== projectionSha256
          || projection.storeId !== storeId
          || projection.head.recordSha256 !== current.head.recordSha256) {
        fail('Retained Authority Git projection does not bind the current Store.',
          'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
      }
      if (!await assertNotSymlink(transportReceiptsDirectory,
        'Authority transport receipt directory', { optional: true, directory: true })) {
        return false;
      }
      const names = await readdir(transportReceiptsDirectory);
      if (names.length > MAX_AUTHORITY_EVENTS
          || names.some((name) => !/^[a-f0-9]{64}\.json$/u.test(name))) {
        fail('Authority transport receipt directory is not a bounded canonical set.',
          'SGOS_AUTHORITY_STORE_CORRUPT');
      }
      for (const name of names.sort()) {
        const file = path.join(transportReceiptsDirectory, name);
        await assertNotSymlink(file, 'Authority transport cutover receipt');
        const envelope = validatePlatformEnvelope(await safeReadJson(
          file, 'Authority transport cutover receipt'
        ));
        if (envelope.family !== 'platform-authority-git-cutover') continue;
        const receipt = envelope.record;
        if (receipt.storeId === storeId
            && receipt.projectionSha256 === projectionSha256
            && receipt.stateBranch === branch
            && receipt.stateCommit === commit
            && receipt.afterHead.recordSha256 === projection.head.recordSha256) {
          return true;
        }
      }
      return false;
    },

    async importTransport(options) {
      assertPortableAuthorityStoreId(storeId);
      if (!/^sha256:[a-f0-9]{64}$/.test(String(options.confirmationSha256 ?? ''))) {
        fail('Authority import requires the exact current plan confirmation digest.',
          'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE');
      }
      let backupRoot = null;
      const result = await withStableCutoverLock(parentRoot, storeId, async () => {
        const applied = await withLock(async (owner) => {
        const transport = await transportInput(options);
        const current = await verifiedSnapshot();
        const plan = planPortableAuthorityImport(current.head, current.events, transport, {
          authorityContextSha256: options.authorityContextSha256 ?? null
        });
        if (plan.confirmationSha256 !== options.confirmationSha256) {
          fail('Authority import confirmation does not match the exact current plan.',
            'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE', {
              requiredConfirmationSha256: plan.confirmationSha256
            });
        }
        if (plan.mode === 'noop') {
          return Object.freeze({
            status: 'already-current', changed: false, mode: 'noop', storeId,
            exportSha256: transport.exportSha256,
            signedTransportSha256: transport.signedTransportSha256,
            planSha256: plan.confirmationSha256,
            previous: authorityHeadSummary(current.head),
            current: authorityHeadSummary(current.head),
            importedEventCount: 0,
            cutoverSha256: null,
            semantic: transport.semantic
          });
        }
        const authorization = validatePlatformRecord(
          options.authorization, 'platform-mutation-authorization'
        );
        if (authorization.operation !== 'authority-store.import') {
          fail('Authority import authorization is invalid.',
            'SGOS_PLATFORM_AUTHORIZATION_TAMPERED');
        }
        const cutover = createAuthorityCutover({
          repositoryBindingSha256: transport.record.repositoryBindingSha256,
          storeId,
          exportSha256: transport.record.recordSha256,
          signedTransportSha256: transport.signedTransportSha256,
          signerKeyId: transport.signerKeyId,
          beforeHead: current.head,
          afterHead: transport.record.head,
          importedEventSha256s: plan.importedEventSha256s,
          authorization,
          committedAt: new Date().toISOString()
        });
        const parent = path.dirname(canonicalRoot);
        const stageName = `.authority-import-${storeId}-${randomUUID()}`;
        const backupName = `.authority-backup-${storeId}-${cutover.recordSha256.slice(7)}`;
        const stageRoot = path.join(parent, stageName);
        backupRoot = path.join(parent, backupName);
        const journalFile = path.join(parent, `.authority-cutover-${storeId}.json`);
        if (await lstat(backupRoot).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))) {
          fail('Authority import backup destination already exists.',
            'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
        }
        let journalWritten = false;
        try {
          await stageTransportStore(stageRoot, options.signedTransport, cutover, owner);
          const journal = await createTransportJournal(parent, {
            operation: 'import', storeId, stageName, backupName,
            beforeStateSha256: current.head.recordSha256,
            afterStateSha256: transport.record.head.recordSha256,
            receiptSha256: cutover.recordSha256
          });
          await writeAtomic(journalFile, journal);
          journalWritten = true;
          await rename(canonicalRoot, backupRoot);
          await fsyncDirectory(parent);
          await rename(stageRoot, canonicalRoot);
          await fsyncDirectory(parent);
        } catch (error) {
          if (!journalWritten) {
            await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
            await fsyncDirectory(parent).catch(() => {});
          }
          throw error;
        }
        return Object.freeze({
          status: 'imported', changed: true, mode: plan.mode, storeId,
          exportSha256: transport.exportSha256,
          signedTransportSha256: transport.signedTransportSha256,
          planSha256: plan.confirmationSha256,
          previous: authorityHeadSummary(current.head),
          current: authorityHeadSummary(transport.record.head),
          importedEventCount: plan.importedEventSha256s.length,
          cutoverSha256: cutover.recordSha256,
          semantic: transport.semantic
        });
        });
        // Keep the authenticated journal until the new store lock is cleanly released. Recovery
        // then verifies the full lineage, retained signed proof, and receipt before finalization.
        if (backupRoot) {
          await rm(path.join(backupRoot, '.transaction-lock'), { recursive: true, force: true });
          await fsyncDirectory(backupRoot);
        }
        await recoverInterruptedTransportCutover(canonicalRoot, storeId);
        return applied;
      });
      return result;
    },

    async importGitProjection(options) {
      assertPortableAuthorityStoreId(storeId);
      if (!/^sha256:[a-f0-9]{64}$/.test(String(options.confirmationSha256 ?? ''))) {
        fail('Authority Git projection import requires the exact current plan confirmation digest.',
          'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE');
      }
      let backupRoot = null;
      const result = await withStableCutoverLock(parentRoot, storeId, async () => {
        const applied = await withLock(async (owner) => {
          const projection = await gitProjectionInput(options);
          const current = await verifiedSnapshot();
          const plan = planAuthorityGitProjectionImport(
            current.head, current.events, projection, {
              authorityContextSha256: options.authorityContextSha256 ?? null,
              forceInstall: options.forceInstall === true
            }
          );
          if (plan.confirmationSha256 !== options.confirmationSha256) {
            fail('Authority Git projection import confirmation does not match the exact current plan.',
              'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE', {
                requiredConfirmationSha256: plan.confirmationSha256
              });
          }
          if (plan.mode === 'noop') {
            return Object.freeze({
              status: 'already-current', changed: false, mode: 'noop', storeId,
              projectionSha256: projection.projectionSha256,
              gitProvenance: projection.gitProvenance,
              planSha256: plan.confirmationSha256,
              previous: authorityHeadSummary(current.head),
              current: authorityHeadSummary(current.head),
              importedEventCount: 0,
              cutoverSha256: null,
              semantic: projection.semantic
            });
          }
          const authorization = validatePlatformRecord(
            options.authorization, 'platform-mutation-authorization'
          );
          if (authorization.operation !== 'authority-store.sync') {
            fail('Authority Git projection import authorization is invalid.',
              'SGOS_PLATFORM_AUTHORIZATION_TAMPERED');
          }
          const cutover = createAuthorityGitCutover({
            repositoryBindingSha256: projection.record.repositoryBindingSha256,
            policySha256: projection.record.policySha256,
            storeId,
            projectionSha256: projection.projectionSha256,
            stateBranch: projection.gitProvenance.stateBranch,
            stateCommit: projection.gitProvenance.stateCommit,
            beforeHead: current.head,
            afterHead: projection.record.head,
            importedEventSha256s: plan.importedEventSha256s,
            authorization,
            committedAt: new Date().toISOString()
          });
          const parent = path.dirname(canonicalRoot);
          const stageName = `.authority-import-${storeId}-${randomUUID()}`;
          const backupName = `.authority-backup-${storeId}-${cutover.recordSha256.slice(7)}`;
          const stageRoot = path.join(parent, stageName);
          backupRoot = path.join(parent, backupName);
          const journalFile = path.join(parent, `.authority-cutover-${storeId}.json`);
          if (await lstat(backupRoot).catch((error) =>
            error?.code === 'ENOENT' ? null : Promise.reject(error))) {
            fail('Authority Git projection import backup destination already exists.',
              'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
          }
          let journalWritten = false;
          try {
            await stageGitProjectionStore(stageRoot, projection.record, cutover, owner);
            const journal = await createTransportJournal(parent, {
              operation: 'import', storeId, stageName, backupName,
              beforeStateSha256: current.head.recordSha256,
              afterStateSha256: projection.record.head.recordSha256,
              receiptSha256: cutover.recordSha256
            });
            await writeAtomic(journalFile, journal);
            journalWritten = true;
            await rename(canonicalRoot, backupRoot);
            await fsyncDirectory(parent);
            await rename(stageRoot, canonicalRoot);
            await fsyncDirectory(parent);
          } catch (error) {
            if (!journalWritten) {
              await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
              await fsyncDirectory(parent).catch(() => {});
            }
            throw error;
          }
          return Object.freeze({
            status: 'imported', changed: true, mode: plan.mode, storeId,
            projectionSha256: projection.projectionSha256,
            gitProvenance: projection.gitProvenance,
            planSha256: plan.confirmationSha256,
            previous: authorityHeadSummary(current.head),
            current: authorityHeadSummary(projection.record.head),
            importedEventCount: plan.importedEventSha256s.length,
            cutoverSha256: cutover.recordSha256,
            semantic: projection.semantic
          });
        });
        if (backupRoot) {
          await rm(path.join(backupRoot, '.transaction-lock'), { recursive: true, force: true });
          await fsyncDirectory(backupRoot);
        }
        await recoverInterruptedTransportCutover(canonicalRoot, storeId);
        return applied;
      });
      return result;
    },

    async planRollback({
      cutoverSha256, validateRollback, authorityContextSha256 = null,
      minimumAuthority = null
    }) {
      assertPortableAuthorityStoreId(storeId);
      const plan = await withStableCutoverLock(parentRoot, storeId, () =>
        rollbackPlanFor(cutoverSha256, {
          validateRollback, authorityContextSha256, minimumAuthority
        }));
      const { backupName, currentHead, rollbackHead, ...portable } = plan;
      return Object.freeze({
        plan: portable,
        previous: authorityHeadSummary(currentHead),
        current: authorityHeadSummary(rollbackHead)
      });
    },

    async rollbackTransport({
      cutoverSha256, confirmationSha256, authorization, validateRollback,
      authorityContextSha256 = null, minimumAuthority = null
    }) {
      assertPortableAuthorityStoreId(storeId);
      if (!/^sha256:[a-f0-9]{64}$/.test(String(confirmationSha256 ?? ''))) {
        fail('Authority rollback requires the exact current plan confirmation digest.',
          'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE');
      }
      let retiredRoot = null;
      const result = await withStableCutoverLock(parentRoot, storeId, async () => {
        const applied = await withLock(async (owner) => {
        const calculated = await rollbackPlanFor(cutoverSha256, {
          validateRollback, authorityContextSha256, minimumAuthority
        });
        if (calculated.confirmationSha256 !== confirmationSha256) {
          fail('Authority rollback confirmation does not match the exact current plan.',
            'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE', {
              requiredConfirmationSha256: calculated.confirmationSha256
            });
        }
        const approved = validatePlatformRecord(
          authorization, 'platform-mutation-authorization'
        );
        if (approved.operation !== 'authority-store.rollback') {
          fail('Authority rollback authorization is invalid.',
            'SGOS_PLATFORM_AUTHORIZATION_TAMPERED');
        }
        const cutover = await readCutover(cutoverSha256);
        const rollback = createAuthorityRollback({
          repositoryBindingSha256: cutover.repositoryBindingSha256,
          storeId,
          cutoverSha256,
          beforeStateSha256: calculated.currentHead.recordSha256,
          afterStateSha256: calculated.rollbackHead.recordSha256,
          authorization: approved,
          rolledBackAt: new Date().toISOString()
        });
        const parent = path.dirname(canonicalRoot);
        const stageRoot = path.join(parent, calculated.backupName);
        retiredRoot = path.join(parent,
          `.authority-rolled-back-${storeId}-${rollback.recordSha256.slice(7)}`);
        await rm(path.join(stageRoot, '.transaction-lock'), { recursive: true, force: true });
        await mkdir(path.join(stageRoot, 'transport', 'rollbacks'), {
          recursive: true, mode: 0o700
        });
        const rollbackFile = path.join(
          stageRoot, 'transport', 'rollbacks', `${rollback.recordSha256.slice(7)}.json`
        );
        const journalFile = path.join(parent, `.authority-cutover-${storeId}.json`);
        let journalWritten = false;
        try {
          await writeExclusive(rollbackFile, createPlatformEnvelope(rollback));
          await writeLockReplica(stageRoot, owner);
          const journal = await createTransportJournal(parent, {
            operation: 'rollback', storeId, stageName: calculated.backupName,
            backupName: path.basename(retiredRoot),
            beforeStateSha256: calculated.currentHead.recordSha256,
            afterStateSha256: calculated.rollbackHead.recordSha256,
            receiptSha256: rollback.recordSha256
          });
          await writeAtomic(journalFile, journal);
          journalWritten = true;
          await rename(canonicalRoot, retiredRoot);
          await fsyncDirectory(parent);
          await rename(stageRoot, canonicalRoot);
          await fsyncDirectory(parent);
        } catch (error) {
          if (!journalWritten) {
            await rm(rollbackFile, { force: true }).catch(() => {});
            await rm(path.join(stageRoot, '.transaction-lock'), {
              recursive: true, force: true
            }).catch(() => {});
            await fsyncDirectory(stageRoot).catch(() => {});
          }
          throw error;
        }
        return Object.freeze({
          status: 'rolled-back', changed: true, storeId,
          planSha256: calculated.confirmationSha256,
          cutoverSha256,
          rollbackSha256: rollback.recordSha256,
          previous: authorityHeadSummary(calculated.currentHead),
          current: authorityHeadSummary(calculated.rollbackHead)
        });
        });
        if (retiredRoot) {
          await rm(path.join(retiredRoot, '.transaction-lock'), { recursive: true, force: true });
          await fsyncDirectory(retiredRoot);
        }
        await recoverInterruptedTransportCutover(canonicalRoot, storeId);
        return applied;
      });
      return result;
    }
  };
  return Object.freeze(adapter);
}

export function verifyPortableAuthorityExport(signedExport, {
  trustedPublicKeyPem,
  expectedKeyId,
  expectedStoreId = null
}) {
  const record = verifySignedPlatformRecord(signedExport, {
    trustedPublicKeyPem, expectedKeyId, expectedKind: 'platform-authority-export'
  });
  if (expectedStoreId !== null && record.storeId !== expectedStoreId) {
    fail('Portable Authority export belongs to another store.', 'SGOS_AUTHORITY_STORE_MISMATCH');
  }
  // The export contract validates the predecessor chain. Reapply mutations here so a self-consistent
  // but forged state cannot pass without the trusted signature and exact state reconstruction.
  let entries = {};
  for (const event of record.events) {
    if (event.beforeEntriesSha256 !== platformSha256(entries)) fail('Portable export before-state is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
    entries = applyChanges(entries, event.changes);
    if (event.afterEntriesSha256 !== platformSha256(entries)) fail('Portable export after-state is invalid.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  if (record.head.entriesSha256 !== platformSha256(entries)
      || canonicalJson(record.head.entries) !== canonicalJson(entries)) {
    fail('Portable export head does not match its events.', 'SGOS_AUTHORITY_LINEAGE_INVALID');
  }
  return Object.freeze({
    valid: true,
    storeId: record.storeId,
    revision: record.head.revision,
    stateSha256: record.head.recordSha256,
    exportSha256: record.recordSha256
  });
}
