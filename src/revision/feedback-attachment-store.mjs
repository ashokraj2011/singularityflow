/** Private, append-only local store for REV feedback attachment evidence. */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from '../git.mjs';
import { secureWindowsAuthAcl } from '../mcp-auth-profile.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError, portableIdentifier, writeAtomicExclusive } from '../util.mjs';

const MAX_OBJECT_BYTES = 10 * 1024 * 1024;
const MAX_OBJECTS_PER_RECEIPT = 10;
const MAX_RECEIPTS_PER_SCOPE = 100;
const MAX_ACCOUNTED_BYTES_PER_SCOPE = 100 * 1024 * 1024;
const MAX_STAGED_PLANS_PER_SCOPE = 200;
const REVOCATION_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_JSON_BYTES = 1024 * 1024;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function sha(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function recordHash(record) { return `sha256:${recordSha256(record)}`; }
function hashPart(value) {
  const match = DIGEST.exec(String(value ?? ''));
  if (!match) fail('REV_ATTACHMENT_STORE_INVALID', 'Invalid content digest in attachment store request.');
  return match[1];
}
function validBinders(record) {
  if (!COMMIT.test(String(record?.headCommit ?? ''))
    || !DIGEST.test(String(record?.sourceTreeSha256 ?? ''))
    || !DIGEST.test(String(record?.configSha256 ?? ''))
    || !DIGEST.test(String(record?.workflowSha256 ?? ''))) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment evidence lacks exact HEAD, source-tree, configuration, or workflow binding.');
  }
}

async function privateDirectory(directory, { create, enforceMode, platform, windowsAcl }) {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (!create && error?.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail('REV_ATTACHMENT_STORE_UNSAFE', 'Attachment store path is not a private real directory.');
  }
  if (enforceMode) {
    if (platform === 'win32') {
      await windowsAcl(directory, { directory: true, apply: create });
    } else {
      if (create) await chmod(directory, 0o700);
      const privateInfo = await lstat(directory);
      if ((privateInfo.mode & 0o077) !== 0) {
        fail('REV_ATTACHMENT_STORE_UNSAFE', 'Attachment store directory is not private.');
      }
    }
  }
  return true;
}

async function privatePath(root, parts, {
  create = false, platform = process.platform, windowsAcl = secureWindowsAuthAcl
} = {}) {
  let directory = await realpath(gitCommonDir(root));
  const commonInfo = await lstat(directory);
  if (!commonInfo.isDirectory() || commonInfo.isSymbolicLink()) {
    fail('REV_ATTACHMENT_STORE_UNSAFE', 'Repository common Git directory is unsafe.');
  }
  let missing = false;
  for (const [index, part] of ['singularity-flow', 'revision-feedback-attachments', ...parts].entries()) {
    directory = path.join(directory, part);
    if (!missing) {
      const exists = await privateDirectory(directory, {
        create, enforceMode: index > 0, platform, windowsAcl
      });
      if (!exists) missing = true;
    }
  }
  return directory;
}

async function privateFile(file, { platform, windowsAcl, apply = false }) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail('REV_ATTACHMENT_STORE_UNSAFE', 'Attachment store entry is not a regular file.');
  }
  if (platform === 'win32') {
    await windowsAcl(file, { directory: false, apply });
  } else if ((info.mode & 0o077) !== 0) {
    fail('REV_ATTACHMENT_STORE_UNSAFE', 'Attachment store entry is not private.');
  }
  return info;
}

async function flushFile(file) {
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function flushDirectory(directory, platform) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Node cannot open directory handles for fsync on some Windows filesystems. File data is
    // still flushed; every subsequent proof read verifies the directory entry and exact bytes.
    if (platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error?.code)) {
      fail('REV_ATTACHMENT_STORE_DURABILITY_UNAVAILABLE', 'Attachment store could not flush its directory after publication.');
    }
  } finally { await handle?.close(); }
}

async function flushPublishedFile(file, runtime) {
  await privateFile(file, runtime);
  await flushFile(file);
  await flushDirectory(path.dirname(file), runtime.platform);
}

async function readBoundedPrivateFile(file, maximumBytes, runtime) {
  const before = await privateFile(file, runtime);
  if (before.size < 1 || before.size > maximumBytes) {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment store entry exceeds its bounded size.');
  }
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment store entry changed while being opened.');
    }
    const buffer = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment store entry changed while being read.');
    }
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

async function readPrivateJson(file, runtime) {
  try { await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const bytes = await readBoundedPrivateFile(file, MAX_JSON_BYTES, runtime);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment store record is unreadable.'); }
  return parsed;
}

function validPlan(plan, scope) {
  plan = readRecord('revision-feedback-attachment-import-plan', plan).record;
  if (!plan || plan.kind !== 'revision-feedback-attachment-import-plan') {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Expected a REV feedback-attachment import plan.');
  }
  const { planSha256, ...core } = plan;
  hashPart(planSha256);
  if (recordHash(core) !== planSha256) fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment import plan failed its content hash.');
  validBinders(plan);
  if (plan.workId !== scope.workId || plan.phaseId !== scope.phaseId || plan.phaseGeneration !== scope.phaseGeneration) {
    fail('REV_ATTACHMENT_STORE_SCOPE', 'Attachment import plan belongs to another work phase.');
  }
  if (!Array.isArray(plan.attachments) || plan.attachments.length > 5
    || !Array.isArray(plan.selectedIndexes)
    || plan.selectedIndexes.length !== plan.attachments.filter((item) => item?.selected === true).length
    || !Number.isFinite(Date.parse(plan.createdAt)) || !Number.isFinite(Date.parse(plan.expiresAt))
    || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment import plan has invalid selection or expiry metadata.');
  }
  return plan;
}

function validReceipt(receipt, scope) {
  receipt = readRecord('revision-feedback-attachment-set', receipt).record;
  if (!receipt || receipt.kind !== 'revision-feedback-attachment-set') {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Expected a REV feedback-attachment-set receipt.');
  }
  const { attachmentSetSha256, ...core } = receipt;
  hashPart(attachmentSetSha256);
  if (recordHash(core) !== attachmentSetSha256) fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment-set receipt failed its content hash.');
  validBinders(receipt);
  if (receipt.workId !== scope.workId || receipt.phaseId !== scope.phaseId
    || receipt.phaseGeneration !== scope.phaseGeneration) {
    fail('REV_ATTACHMENT_STORE_SCOPE', 'Attachment-set receipt belongs to another work phase.');
  }
  if (!Array.isArray(receipt.attachments) || !receipt.attachments.length || receipt.attachments.length > 5) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment-set receipt has an invalid selected set.');
  }
  if (receipt.confirmed !== true || !Number.isFinite(Date.parse(receipt.registeredAt))) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment-set receipt lacks exact confirmation or registration time.');
  }
  hashPart(receipt.importPlanSha256);
  return receipt;
}

function validEntry(entry, scope) {
  entry = readRecord('revision-feedback-attachment-store-entry', entry).record;
  if (!entry || entry.kind !== 'revision-feedback-attachment-store-entry') {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment store entry has an unsupported schema.');
  }
  hashPart(entry.idempotencyKeySha256);
  hashPart(entry.requestSha256);
  validReceipt(entry.receipt, scope);
  return entry;
}

function sameEvidenceContext(actual, expected, scope) {
  return expected?.workId === scope.workId
    && expected.phaseId === scope.phaseId
    && expected.phaseGeneration === scope.phaseGeneration
    && expected.attachmentSetSha256 === actual.attachmentSetSha256
    && expected.feedbackSha256 === actual.feedbackSha256
    && expected.repositorySha256 === actual.repositorySha256
    && expected.policySha256 === actual.policySha256
    && expected.loopId === actual.loopId
    && expected.loopRevision === actual.loopRevision
    && expected.loopStatus === actual.loopStatus
    && expected.headCommit === actual.headCommit
    && expected.sourceTreeSha256 === actual.sourceTreeSha256
    && expected.configSha256 === actual.configSha256
    && expected.workflowSha256 === actual.workflowSha256;
}

function receiptContext(receipt) {
  const {
    attachmentSetSha256, workId, phaseId, phaseGeneration, feedbackSha256,
    repositorySha256, policySha256, loopId, loopRevision, loopStatus,
    headCommit, sourceTreeSha256, configSha256, workflowSha256
  } = receipt;
  return {
    attachmentSetSha256, workId, phaseId, phaseGeneration, feedbackSha256,
    repositorySha256, policySha256, loopId, loopRevision, loopStatus,
    headCommit, sourceTreeSha256, configSha256, workflowSha256
  };
}

function validRevocationPlan(raw, scope) {
  const plan = readRecord('revision-feedback-attachment-revocation-plan', raw).record;
  if (plan?.kind !== 'revision-feedback-attachment-revocation-plan') {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Expected a REV attachment revocation plan.');
  }
  const { planSha256, ...core } = plan;
  hashPart(planSha256);
  hashPart(plan.attachmentSetSha256);
  hashPart(plan.feedbackSha256);
  hashPart(plan.repositorySha256);
  hashPart(plan.policySha256);
  if (recordHash(core) !== planSha256) {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation plan failed its content hash.');
  }
  validBinders(plan);
  if (!sameEvidenceContext(plan, plan, scope)
    || !Number.isFinite(Date.parse(plan.createdAt))
    || !Number.isFinite(Date.parse(plan.expiresAt))
    || Date.parse(plan.expiresAt) <= Date.parse(plan.createdAt)
    || Date.parse(plan.expiresAt) - Date.parse(plan.createdAt) > REVOCATION_PLAN_TTL_MS) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment revocation plan has invalid scope or expiry.');
  }
  return plan;
}

function validRevocation(raw, scope) {
  const event = readRecord('revision-feedback-attachment-revocation', raw).record;
  if (event?.kind !== 'revision-feedback-attachment-revocation') {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation has an unsupported schema.');
  }
  const { revocationSha256, ...core } = event;
  hashPart(revocationSha256);
  hashPart(event.planSha256);
  hashPart(event.attachmentSetSha256);
  hashPart(event.idempotencyKeySha256);
  hashPart(event.requestSha256);
  hashPart(event.feedbackSha256);
  hashPart(event.repositorySha256);
  hashPart(event.policySha256);
  if (recordHash(core) !== revocationSha256) {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation failed its content hash.');
  }
  validBinders(event);
  if (!sameEvidenceContext(event, event, scope) || !Number.isFinite(Date.parse(event.revokedAt))) {
    fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation has invalid scope or time.');
  }
  return event;
}

function requiredObjects(receipt) {
  const required = [];
  for (const attachment of receipt.attachments) {
    if (attachment.kind !== 'user-document' || !Number.isSafeInteger(attachment.bytes)
      || attachment.bytes < 1 || attachment.bytes > MAX_OBJECT_BYTES) {
      fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment metadata is not a bounded user document.');
    }
    hashPart(attachment.originalSha256);
    required.push({ role: 'original', sha256: attachment.originalSha256, size: attachment.bytes });
    if (attachment.renditionSha256 != null) {
      hashPart(attachment.renditionSha256);
      required.push({ role: 'selected-rendition', sha256: attachment.renditionSha256, size: null });
    }
  }
  return required;
}

function checkedObjects(objects, receipt) {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS_PER_RECEIPT) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment object count exceeds the local store limit.');
  }
  const needed = requiredObjects(receipt);
  if (objects.length !== needed.length) {
    fail('REV_ATTACHMENT_STORE_INVALID', 'Selected original/rendition bytes do not match the receipt.');
  }
  return objects.map((object, index) => {
    const expected = needed[index];
    if (object?.role !== expected.role || object.sha256 !== expected.sha256
      || !Buffer.isBuffer(object.bytes) || object.bytes.length < 1
      || object.bytes.length > MAX_OBJECT_BYTES || sha(object.bytes) !== expected.sha256
      || (expected.size != null && object.bytes.length !== expected.size)) {
      fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment object failed its exact digest, role, or size check.');
    }
    return object;
  });
}

/**
 * Construct one active Story-phase store. `assertCurrentContext` is re-run inside the Story lock
 * immediately before the final append; it must reload active Story/phase/generation and return
 * true only for the exact expected context. A missing check fails closed on mutation.
 */
export function createFeedbackAttachmentStore(root, {
  workId, phaseId, phaseGeneration, assertCurrentContext = null,
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
}) {
  const runtime = { platform, windowsAcl };
  const scope = {
    workId: portableIdentifier(workId, 'Work ID'),
    phaseId: portableIdentifier(phaseId, 'Phase ID'),
    phaseGeneration
  };
  if (!Number.isSafeInteger(scope.phaseGeneration) || scope.phaseGeneration < 0) {
    fail('REV_ATTACHMENT_STORE_SCOPE', 'An exact phase generation is required for attachment storage.');
  }
  const scopeParts = [scope.workId, scope.phaseId, String(scope.phaseGeneration).padStart(4, '0')];
  const dir = (...parts) => privatePath(root, [...scopeParts, ...parts], runtime);
  const ensureDir = (...parts) => privatePath(root, [...scopeParts, ...parts], { ...runtime, create: true });
  const planFile = async (planSha256) => path.join(await dir('plans'), `${hashPart(planSha256)}.json`);
  const requestFile = async (idempotencyKey) => path.join(
    await dir('requests'), `${hashPart(sha(Buffer.from(idempotencyKey)))}.json`
  );
  const objectFile = async (objectSha256) => path.join(await dir('objects'), `${hashPart(objectSha256)}.bin`);
  const revocationPlanFile = async (planSha256) => path.join(
    await dir('revocation-plans'), `${hashPart(planSha256)}.json`
  );
  const revocationFile = async (attachmentSetSha256) => path.join(
    await dir('revocations'), `${hashPart(attachmentSetSha256)}.json`
  );

  async function verifyObject(objectSha256, expectedSize = null) {
    const file = await objectFile(objectSha256);
    let bytes;
    try { bytes = await readBoundedPrivateFile(file, MAX_OBJECT_BYTES, runtime); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Registered attachment bytes are missing from the private store.');
    }
    if (sha(bytes) !== objectSha256 || (expectedSize != null && bytes.length !== expectedSize)) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Registered attachment bytes no longer match their receipt.');
    }
    return bytes;
  }

  async function verifyReceiptObjects(receipt, verified = new Set()) {
    for (const object of requiredObjects(receipt)) {
      if (verified.has(object.sha256)) continue;
      await verifyObject(object.sha256, object.size);
      verified.add(object.sha256);
    }
  }

  async function readPlan(planSha256) {
    const plan = await readPrivateJson(await planFile(planSha256), runtime);
    if (!plan) return null;
    if (plan.planSha256 !== planSha256) fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment import plan address is wrong.');
    return validPlan(plan, scope);
  }

  async function pruneExpiredPlans() {
    const directory = await dir('plans');
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
    const candidates = [];
    let retained = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
    const now = Date.now();
    // The scope quota bounds this sweep. Resolve durable references only when at least one
    // expired plan exists, so normal previews do not rehash every registered object.
    let removed = false;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const planSha256 = `sha256:${name.slice(0, -5)}`;
      const plan = await readPlan(planSha256);
      if (Date.parse(plan.expiresAt) <= now) candidates.push({ name, planSha256 });
    }
    if (candidates.length === 0) return retained;
    const referenced = new Set((await list()).map((receipt) => receipt.importPlanSha256));
    for (const { name, planSha256 } of candidates) {
      if (referenced.has(planSha256)) continue;
      const file = path.join(directory, name);
      await privateFile(file, runtime);
      await unlink(file);
      removed = true;
      retained -= 1;
    }
    if (removed) await flushDirectory(directory, runtime.platform);
    return retained;
  }

  async function stagedPlanCount() {
    const directory = await dir('plans');
    const names = await readdir(directory);
    let removed = false;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json\.tmp-\d+-[a-f0-9-]{36}$/.test(name)) continue;
      const file = path.join(directory, name);
      await privateFile(file, { ...runtime, apply: true });
      await unlink(file);
      removed = true;
    }
    if (removed) await flushDirectory(directory, runtime.platform);
    return names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
  }

  async function pruneOrphanObjects(receipts) {
    const directory = await dir('objects');
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    const referenced = new Set(receipts.flatMap((receipt) =>
      requiredObjects(receipt).map((object) => `${hashPart(object.sha256)}.bin`)));
    let removed = false;
    for (const name of names) {
      // A prior process can die after writing an object but before publishing its receipt.
      // Every producer of this directory holds the same Story lock, so these entries are safe
      // to collect before starting the next append. Never remove bytes named by a receipt.
      const abandonedTemp = /^[a-f0-9]{64}\.bin\.tmp-\d+-[a-f0-9-]{36}$/.test(name);
      if (!abandonedTemp && (!/^[a-f0-9]{64}\.bin$/.test(name) || referenced.has(name))) continue;
      const file = path.join(directory, name);
      await privateFile(file, { ...runtime, apply: true });
      await unlink(file);
      removed = true;
    }
    if (removed) await flushDirectory(directory, runtime.platform);
  }

  async function pruneAbandonedRequestTemps() {
    const directory = await dir('requests');
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    let removed = false;
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json\.tmp-\d+-[a-f0-9-]{36}$/.test(name)) continue;
      const file = path.join(directory, name);
      await privateFile(file, { ...runtime, apply: true });
      await unlink(file);
      removed = true;
    }
    if (removed) await flushDirectory(directory, runtime.platform);
  }

  async function savePlan(plan) {
    validPlan(plan, scope);
    if (typeof assertCurrentContext !== 'function') {
      fail('REV_ATTACHMENT_STORE', 'Attachment store needs an active Story/phase recheck before staging a plan.');
    }
    return withSubjectLock(root, { kind: 'story', id: scope.workId }, async () => {
      if (await assertCurrentContext(plan) !== true) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Active work or phase changed before attachment preview was staged.');
      }
      await ensureDir('plans');
      const file = await planFile(plan.planSha256);
      const existing = await readPlan(plan.planSha256);
      await stagedPlanCount();
      const retained = await pruneExpiredPlans();
      if (!existing) {
        if (retained >= MAX_STAGED_PLANS_PER_SCOPE) {
          fail('REV_ATTACHMENT_STORE_QUOTA', 'Private attachment preview plans reached their per-phase limit. Let unused plans expire before previewing more.');
        }
      }
      try {
        await writeAtomicExclusive(file, canonicalJson(plan), { mode: 0o600 });
        await privateFile(file, { ...runtime, apply: true });
      } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await flushPublishedFile(file, runtime);
      const stored = await readPlan(plan.planSha256);
      if (recordHash(stored) !== recordHash(plan)) {
        fail('REV_ATTACHMENT_STORE_CORRUPT', 'An existing attachment import plan has different content.');
      }
      return stored;
    });
  }

  // Called only while holding this Story's subject lock. A registration replay must never
  // resurrect a set that was excluded by a later, append-only revocation.
  async function findByIdempotencyKeyUnderLock(idempotencyKey) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
      fail('REV_ATTACHMENT_IDEMPOTENCY', 'A bounded attachment idempotency key is required.');
    }
    const entry = await readPrivateJson(await requestFile(idempotencyKey), runtime);
    if (!entry) return null;
    validEntry(entry, scope);
    if (entry.idempotencyKeySha256 !== sha(Buffer.from(idempotencyKey))) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment idempotency index address is wrong.');
    }
    await verifyReceiptObjects(entry.receipt);
    if (await readRevocation(entry.receipt.attachmentSetSha256, entry.receipt)) {
      fail('REV_ATTACHMENT_SET_REVOKED', 'Attachment set was revoked and cannot be registered again by idempotent replay.');
    }
    return { requestSha256: entry.requestSha256, receipt: entry.receipt };
  }

  async function findByIdempotencyKey(idempotencyKey) {
    return withSubjectLock(root, { kind: 'story', id: scope.workId },
      () => findByIdempotencyKeyUnderLock(idempotencyKey));
  }

  async function append({ idempotencyKey, requestSha256, receipt, objects, expectedContext }) {
    if (typeof assertCurrentContext !== 'function') {
      fail('REV_ATTACHMENT_STORE', 'Attachment store needs an active Story/phase recheck before append.');
    }
    validReceipt(receipt, scope);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
      fail('REV_ATTACHMENT_IDEMPOTENCY', 'A bounded attachment idempotency key is required.');
    }
    hashPart(requestSha256);
    const verifiedObjects = checkedObjects(objects, receipt);
    if (requestSha256 !== recordHash({ planSha256: receipt.importPlanSha256, idempotencyKey, attachments: receipt.attachments })) {
      fail('REV_ATTACHMENT_STORE_INVALID', 'Attachment request digest does not match its idempotency key and selection.');
    }
    if (!expectedContext || expectedContext.workId !== scope.workId
      || expectedContext.phaseId !== scope.phaseId || expectedContext.phaseGeneration !== scope.phaseGeneration
      || expectedContext.feedbackSha256 !== receipt.feedbackSha256
      || expectedContext.repositorySha256 !== receipt.repositorySha256
      || expectedContext.loopId !== receipt.loopId || expectedContext.loopRevision !== receipt.loopRevision
      || expectedContext.loopStatus !== receipt.loopStatus
      || expectedContext.headCommit !== receipt.headCommit
      || expectedContext.sourceTreeSha256 !== receipt.sourceTreeSha256
      || expectedContext.configSha256 !== receipt.configSha256
      || expectedContext.workflowSha256 !== receipt.workflowSha256) {
      fail('REV_ATTACHMENT_STORE_SCOPE', 'Attachment request does not match its expected work context.');
    }
    return withSubjectLock(root, { kind: 'story', id: scope.workId }, async () => {
      if (await assertCurrentContext(expectedContext) !== true) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Active work or phase changed before attachment storage.');
      }
      const existing = await findByIdempotencyKeyUnderLock(idempotencyKey);
      if (existing) {
        if (existing.requestSha256 !== requestSha256) {
          fail('REV_ATTACHMENT_IDEMPOTENCY_CONFLICT', 'Idempotency key already names a different attachment set.');
        }
        return existing;
      }
      const prior = await list();
      await pruneOrphanObjects(prior);
      await pruneAbandonedRequestTemps();
      const accountedBytes = prior.reduce((total, item) => total
        + item.attachments.reduce((fileTotal, file) => fileTotal + file.bytes, 0), 0);
      const incomingBytes = receipt.attachments.reduce((total, file) => total + file.bytes, 0);
      if (prior.length >= MAX_RECEIPTS_PER_SCOPE
        || accountedBytes + incomingBytes > MAX_ACCOUNTED_BYTES_PER_SCOPE) {
        fail('REV_ATTACHMENT_STORE_QUOTA', 'Private feedback attachment evidence reached its per-phase quota. Review retention before registering more.');
      }
      const plan = await readPlan(receipt.importPlanSha256);
      if (!plan || plan.feedbackSha256 !== receipt.feedbackSha256
        || plan.repositorySha256 !== receipt.repositorySha256
        || plan.policySha256 !== receipt.policySha256
        || plan.loopId !== receipt.loopId || plan.loopRevision !== receipt.loopRevision
        || plan.loopStatus !== receipt.loopStatus
        || plan.headCommit !== receipt.headCommit
        || plan.sourceTreeSha256 !== receipt.sourceTreeSha256
        || plan.configSha256 !== receipt.configSha256
        || plan.workflowSha256 !== receipt.workflowSha256) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Stored attachment import plan does not match the current receipt.');
      }
      const plannedSelection = plan.attachments.filter((attachment) => attachment.selected).map((attachment) => {
        const { selected: _selected, ...metadata } = attachment;
        return metadata;
      });
      if (recordHash(plannedSelection) !== recordHash(receipt.attachments)) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Attachment-set selection does not match its stored import plan.');
      }
      if (Date.parse(plan.expiresAt) <= Date.now()) {
        fail('REV_ATTACHMENT_PLAN_EXPIRED', 'Attachment import plan expired before storage.');
      }
      await ensureDir('objects');
      for (const object of verifiedObjects) {
        const file = await objectFile(object.sha256);
        try {
          await writeAtomicExclusive(file, object.bytes, { mode: 0o600 });
          await privateFile(file, { ...runtime, apply: true });
        } catch (error) { if (error?.code !== 'EEXIST') throw error; }
        await flushPublishedFile(file, runtime);
        await verifyObject(object.sha256, object.bytes.length);
      }
      const entry = stampCurrentRecord('revision-feedback-attachment-store-entry', {
        kind: 'revision-feedback-attachment-store-entry',
        idempotencyKeySha256: sha(Buffer.from(idempotencyKey)), requestSha256, receipt
      });
      await ensureDir('requests');
      const file = await requestFile(idempotencyKey);
      try {
        await writeAtomicExclusive(file, canonicalJson(entry), { mode: 0o600 });
        await privateFile(file, { ...runtime, apply: true });
      } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await flushPublishedFile(file, runtime);
      const persisted = await findByIdempotencyKeyUnderLock(idempotencyKey);
      if (persisted.requestSha256 !== requestSha256) {
        fail('REV_ATTACHMENT_IDEMPOTENCY_CONFLICT', 'Idempotency key concurrently named another attachment set.');
      }
      return persisted;
    });
  }

  async function listRecords({ verifyObjects }) {
    const directory = await dir('requests');
    let available;
    try { available = await readdir(directory); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const names = available.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    const receipts = [];
    const verified = new Set();
    for (const name of names) {
      const entry = validEntry(await readPrivateJson(path.join(directory, name), runtime), scope);
      if (`${hashPart(entry.idempotencyKeySha256)}.json` !== name) {
        fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment idempotency index filename is wrong.');
      }
      // Status needs only the signed receipt and revocation record. Rehashing every original
      // and rendition on each status/read makes a full private-store scan the hot path,
      // especially on Windows where every object also requires an ACL check. Operations
      // which consume evidence verify the selected bytes below; public list() remains fsck-like.
      if (verifyObjects) await verifyReceiptObjects(entry.receipt, verified);
      receipts.push(entry.receipt);
    }
    return receipts.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
  }

  async function list() {
    return listRecords({ verifyObjects: true });
  }

  async function readRevocationPlan(planSha256) {
    const plan = await readPrivateJson(await revocationPlanFile(planSha256), runtime);
    if (!plan) return null;
    if (plan.planSha256 !== planSha256) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation plan address is wrong.');
    }
    return validRevocationPlan(plan, scope);
  }

  async function readRevocation(attachmentSetSha256, receipt = null) {
    hashPart(attachmentSetSha256);
    const raw = await readPrivateJson(await revocationFile(attachmentSetSha256), runtime);
    if (!raw) return null;
    const event = validRevocation(raw, scope);
    if (event.attachmentSetSha256 !== attachmentSetSha256
      || (receipt && !sameEvidenceContext(receipt, event, scope))) {
      fail('REV_ATTACHMENT_STORE_CORRUPT', 'Attachment revocation does not match its addressed receipt.');
    }
    return event;
  }

  async function enforceRevocationPlanQuota(receipts) {
    const directory = await dir('revocation-plans');
    const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const candidates = [];
    const now = Date.now();
    for (const name of names) {
      const planSha256 = `sha256:${name.slice(0, -5)}`;
      const plan = await readRevocationPlan(planSha256);
      if (Date.parse(plan.expiresAt) <= now) candidates.push({ name, planSha256 });
    }
    const used = new Set();
    if (candidates.length > 0) {
      for (const receipt of receipts) {
        const event = await readRevocation(receipt.attachmentSetSha256, receipt);
        if (event) used.add(event.planSha256);
      }
    }
    let removed = false;
    let retained = names.length;
    for (const { name, planSha256 } of candidates) {
      if (used.has(planSha256)) continue;
      const file = path.join(directory, name);
      await privateFile(file, runtime);
      await unlink(file);
      removed = true;
      retained -= 1;
    }
    if (removed) await flushDirectory(directory, runtime.platform);
    if (retained >= MAX_STAGED_PLANS_PER_SCOPE) {
      fail('REV_ATTACHMENT_STORE_QUOTA', 'Private revocation preview plans reached their per-phase limit. Let unused plans expire before previewing more.');
    }
  }

  /**
   * Stage an exact, short-lived removal confirmation. No registered evidence is deleted.
   * The caller must provide the current receipt's complete context, not merely a Story ID.
   */
  async function planRevocation({ attachmentSetSha256, expectedContext, now = Date.now() }) {
    hashPart(attachmentSetSha256);
    if (typeof assertCurrentContext !== 'function') {
      fail('REV_ATTACHMENT_STORE', 'Attachment revocation needs an active Story/phase recheck.');
    }
    if (!Number.isFinite(now)) fail('REV_ATTACHMENT_PLAN', 'Attachment revocation preview time is invalid.');
    return withSubjectLock(root, { kind: 'story', id: scope.workId }, async () => {
      if (await assertCurrentContext(expectedContext) !== true) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Active work or phase changed before attachment revocation preview.');
      }
      const receipts = await list();
      const receipt = receipts.find((item) => item.attachmentSetSha256 === attachmentSetSha256);
      if (!receipt) fail('REV_ATTACHMENT_SET_UNKNOWN', 'Attachment set is not registered in this Story phase.');
      if (!sameEvidenceContext(receipt, expectedContext, scope)) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Attachment set no longer matches the exact work context.');
      }
      if (await readRevocation(attachmentSetSha256, receipt)) {
        fail('REV_ATTACHMENT_SET_REVOKED', 'Attachment set has already been revoked.');
      }
      const core = {
        schemaVersion: 1, kind: 'revision-feedback-attachment-revocation-plan',
        ...receiptContext(receipt),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + REVOCATION_PLAN_TTL_MS).toISOString(),
        expectedEffects: ['append-local-revocation', 'exclude-set-from-future-routing']
      };
      const plan = { ...core, planSha256: recordHash(core) };
      validRevocationPlan(plan, scope);
      await ensureDir('revocation-plans');
      const file = await revocationPlanFile(plan.planSha256);
      await enforceRevocationPlanQuota(receipts);
      try {
        await writeAtomicExclusive(file, canonicalJson(plan), { mode: 0o600 });
        await privateFile(file, { ...runtime, apply: true });
      } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await flushPublishedFile(file, runtime);
      const stored = await readRevocationPlan(plan.planSha256);
      if (recordHash(stored) !== recordHash(plan)) {
        fail('REV_ATTACHMENT_STORE_CORRUPT', 'An existing revocation plan has different content.');
      }
      return stored;
    });
  }

  /** Commit one append-only revocation after exact confirmation and a locked context CAS. */
  async function revoke({ planSha256, confirm, idempotencyKey, expectedContext, now = Date.now() }) {
    if (planSha256 !== confirm) {
      fail('REV_ATTACHMENT_CONFIRMATION', 'Revocation confirmation must equal the exact preview plan ID.');
    }
    hashPart(planSha256);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128) {
      fail('REV_ATTACHMENT_IDEMPOTENCY', 'A bounded revocation idempotency key is required.');
    }
    if (!Number.isFinite(now)) fail('REV_ATTACHMENT_PLAN', 'Attachment revocation time is invalid.');
    if (typeof assertCurrentContext !== 'function') {
      fail('REV_ATTACHMENT_STORE', 'Attachment revocation needs an active Story/phase recheck.');
    }
    return withSubjectLock(root, { kind: 'story', id: scope.workId }, async () => {
      if (await assertCurrentContext(expectedContext) !== true) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Active work or phase changed before attachment revocation.');
      }
      const plan = await readRevocationPlan(planSha256);
      if (!plan) fail('REV_ATTACHMENT_PLAN_STALE', 'Exact attachment revocation plan is missing.');
      if (!sameEvidenceContext(plan, expectedContext, scope)) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Attachment revocation plan no longer matches the work context.');
      }
      const receipts = await list();
      const receipt = receipts.find((item) => item.attachmentSetSha256 === plan.attachmentSetSha256);
      if (!receipt || !sameEvidenceContext(receipt, plan, scope)) {
        fail('REV_ATTACHMENT_PLAN_STALE', 'Attachment revocation plan no longer names an exact registered set.');
      }
      const requestSha256 = recordHash({ planSha256, idempotencyKey,
        attachmentSetSha256: plan.attachmentSetSha256 });
      const idempotencyKeySha256 = sha(Buffer.from(idempotencyKey));
      for (const otherReceipt of receipts) {
        if (otherReceipt.attachmentSetSha256 === plan.attachmentSetSha256) continue;
        const prior = await readRevocation(otherReceipt.attachmentSetSha256, otherReceipt);
        if (prior?.idempotencyKeySha256 === idempotencyKeySha256) {
          fail('REV_ATTACHMENT_IDEMPOTENCY_CONFLICT', 'Revocation idempotency key already names a different attachment set.');
        }
      }
      const existing = await readRevocation(plan.attachmentSetSha256, receipt);
      if (existing) {
        if (existing.requestSha256 !== requestSha256
          || existing.idempotencyKeySha256 !== idempotencyKeySha256) {
          fail('REV_ATTACHMENT_SET_REVOKED', 'Attachment set was revoked by another request.');
        }
        return existing;
      }
      if (Date.parse(plan.expiresAt) <= now) {
        fail('REV_ATTACHMENT_PLAN_EXPIRED', 'Attachment revocation confirmation expired; preview again.');
      }
      const core = {
        schemaVersion: 1, kind: 'revision-feedback-attachment-revocation',
        ...receiptContext(receipt),
        planSha256,
        idempotencyKeySha256, requestSha256,
        revokedAt: new Date(now).toISOString()
      };
      const event = { ...core, revocationSha256: recordHash(core) };
      validRevocation(event, scope);
      await ensureDir('revocations');
      const file = await revocationFile(plan.attachmentSetSha256);
      try {
        await writeAtomicExclusive(file, canonicalJson(event), { mode: 0o600 });
        await privateFile(file, { ...runtime, apply: true });
      } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await flushPublishedFile(file, runtime);
      const stored = await readRevocation(plan.attachmentSetSha256, receipt);
      if (stored.requestSha256 !== requestSha256) {
        fail('REV_ATTACHMENT_SET_REVOKED', 'Attachment set was concurrently revoked by another request.');
      }
      return stored;
    });
  }

  async function listStatus() {
    const receipts = await listRecords({ verifyObjects: false });
    return Promise.all(receipts.map(async (receipt) => {
      const event = await readRevocation(receipt.attachmentSetSha256, receipt);
      return {
        attachmentSetSha256: receipt.attachmentSetSha256,
        status: event ? 'revoked' : 'active',
        objectIntegrity: 'not-checked',
        registeredAt: receipt.registeredAt,
        ...(event ? { revokedAt: event.revokedAt, revocationSha256: event.revocationSha256 } : {})
      };
    }));
  }

  async function read(attachmentSetSha256) {
    hashPart(attachmentSetSha256);
    const receipt = (await listRecords({ verifyObjects: false }))
      .find((item) => item.attachmentSetSha256 === attachmentSetSha256) ?? null;
    if (receipt && await readRevocation(attachmentSetSha256, receipt)) {
      fail('REV_ATTACHMENT_SET_REVOKED', 'Attachment set was revoked and cannot be used for future routing.');
    }
    if (receipt) await verifyReceiptObjects(receipt);
    return receipt;
  }

  async function readObject(objectSha256) {
    hashPart(objectSha256);
    const receipts = await listRecords({ verifyObjects: false });
    let allowed = false;
    for (const receipt of receipts) {
      if (await readRevocation(receipt.attachmentSetSha256, receipt)) continue;
      if (receipt.attachments.some((attachment) => attachment.originalSha256 === objectSha256
        || attachment.renditionSha256 === objectSha256)) allowed = true;
    }
    if (!allowed) fail('REV_ATTACHMENT_STORE_UNAUTHORIZED', 'Attachment object is not referenced by a registered set.');
    return verifyObject(objectSha256);
  }

  return Object.freeze({
    scope, savePlan, readPlan, findByIdempotencyKey, append, list, read, readObject,
    planRevocation, readRevocationPlan, revoke, readRevocation, listStatus
  });
}
