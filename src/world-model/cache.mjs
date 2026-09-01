/**
 * WMB v4 machine-local view cache and conservative staleness receipts.
 *
 * Cache content objects are immutable and content addressed. The cache-key record is written last,
 * so it is the only commit pointer: a crash may leave harmless unreferenced objects, but never a
 * partial hit. Ordinary fills retain their first complete pointer; explicit regeneration replaces
 * it only under a per-key lock and expected-record hash CAS. Every read revalidates canonical bytes,
 * self hashes, object hashes, receipt bindings, and the regular-file/no-symbolic-link boundary.
 */
import { randomUUID } from 'node:crypto';
import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { gitCommonDir } from '../git.mjs';
import {
  listPrivateSidecar,
  readPrivateSidecar,
  safePrivateSidecarDirectory,
  writeImmutablePrivateSidecar,
  writeMutablePrivateSidecar
} from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import { canonicalJson, isPlainRecord, sha256 } from './canonicalize.mjs';
import { WMB_V4_VALIDATION_CHECK_IDS } from './validate/candidate.mjs';

export const VIEW_CACHE_RECORD_FAMILY = 'world-model-view-cache-record';
export const STALENESS_RECEIPT_FAMILY = 'world-model-staleness-receipt';

const CACHE_KEY_KIND = 'world-model-view-cache-key';
const CACHE_RECORD_KIND = 'world-model-view-cache-record';
const VALIDATION_RECEIPT_KIND = 'world-model-view-validation-receipt';
const STALENESS_RECEIPT_KIND = 'world-model-staleness-receipt';
const VALIDATION_RECEIPT_FAMILY = 'world-model-view-validation-receipt';
const COMPOSITION_CANDIDATE_FAMILY = 'world-model-composition-candidate';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const VIEW_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const MAXIMUM_CACHE_RECORD_BYTES = 128 * 1024;
const MAXIMUM_CACHE_KEY_BYTES = 128 * 1024;
const MAXIMUM_VALIDATION_RECEIPT_BYTES = 1024 * 1024;
const MAXIMUM_COMPOSITION_CANDIDATE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_VIEW_BYTES = 4 * 1024 * 1024;
const MAXIMUM_STALENESS_RECEIPT_BYTES = 256 * 1024;

export const VIEW_CACHE_KEY_FIELDS = Object.freeze([
  'sourceManifestSha256',
  'scopeManifestSha256',
  'viewId',
  'viewVersion',
  'viewSpecSha256',
  'viewFactLedgerSha256',
  'consumerProfileSha256',
  'composerCoreSha256',
  'compositionCandidateSchemaSha256',
  'validatorSha256',
  'outputBudgetSha256',
  'executionProfileSha256'
]);

function fail(message, code = 'WMB_CACHE_INPUT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plainObject(value) {
  return isPlainRecord(value);
}

function sha256Record(value) {
  return sha256(value);
}

/** Match materialize/view.mjs: WMB text identities use canonical record hashing. */
function viewSha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const utf8 = bytes.toString('utf8');
  if (!Buffer.from(utf8, 'utf8').equals(bytes)) {
    fail('World-model cached view must be valid UTF-8.', 'WMB_CACHE_VIEW_ENCODING_INVALID');
  }
  return sha256Record({ utf8 });
}

function hashHex(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail(`${label} must be a canonical sha256:<64 lowercase hex> digest.`);
  }
  return value.slice('sha256:'.length);
}

function maximumViewByteCeiling(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_VIEW_BYTES) {
    fail(
      `World-model cache maximumViewBytes must be an integer from 1 through ${MAXIMUM_VIEW_BYTES}.`,
      'WMB_CACHE_VIEW_SIZE_INVALID'
    );
  }
  return value;
}

function canonicalObject(value) {
  return JSON.parse(canonicalJson(value));
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields are incomplete or contain unknown values.`, 'WMB_CACHE_KEY_INCOMPLETE', {
      expected: wanted,
      received: actual
    });
  }
}

function normalizedCacheKeyComponents(value) {
  if (!plainObject(value)) fail('World-model view cache-key components must be an object.');
  exactKeys(value, VIEW_CACHE_KEY_FIELDS, 'World-model view cache key');
  const normalized = canonicalObject(value);
  for (const field of VIEW_CACHE_KEY_FIELDS.filter((field) => field.endsWith('Sha256'))) {
    if (field === 'executionProfileSha256' && normalized[field] === null) continue;
    hashHex(normalized[field], `World-model view cache key ${field}`);
  }
  if (!VIEW_ID.test(normalized.viewId)) {
    fail('World-model view cache key viewId must be a lower-case dot or kebab namespaced ID.');
  }
  if (!Number.isInteger(normalized.viewVersion) || normalized.viewVersion < 1) {
    fail('World-model view cache key viewVersion must be a positive integer.');
  }
  return Object.freeze(normalized);
}

/**
 * Derive the exact WMB v4 section 50 key. `executionProfileSha256` is always explicit: use null
 * only for a deterministic route where no narrative execution profile participates in identity.
 */
export function deriveWorldModelViewCacheKey(value) {
  const components = normalizedCacheKeyComponents(value);
  const payload = Object.freeze({
    schemaVersion: 1, // schema-transient: cache-key identity payload, not a durable record family
    kind: CACHE_KEY_KIND,
    ...components
  });
  return Object.freeze({
    cacheKeySha256: sha256Record(payload),
    components,
    payload
  });
}

export function worldModelViewCacheRoot(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'world-model-cache', 'v4');
}

function cacheRecordPath(root, cacheKeySha256) {
  const digest = hashHex(cacheKeySha256, 'World-model view cache key');
  return path.join(
    worldModelViewCacheRoot(root), 'records', digest.slice(0, 2), digest, 'record.json'
  );
}

function cacheObjectPath(root, kind, digest, extension = '') {
  const hex = hashHex(digest, `World-model cache ${kind} object digest`);
  return path.join(worldModelViewCacheRoot(root), 'objects', kind, hex.slice(0, 2), `${hex}${extension}`);
}

function cacheKeyObjectPath(root, cacheKeySha256) {
  return cacheObjectPath(root, 'cache-keys', cacheKeySha256, '.json');
}

function stalenessReceiptPath(root, receiptSha256) {
  const digest = hashHex(receiptSha256, 'World-model staleness receipt digest');
  return path.join(worldModelViewCacheRoot(root), 'staleness', digest.slice(0, 2), `${digest}.json`);
}

function withoutField(value, field) {
  const copy = structuredClone(value);
  delete copy[field];
  return copy;
}

function assertValidationReceipt(value, components) {
  let receipt;
  try { receipt = readRecord(VALIDATION_RECEIPT_FAMILY, value).record; }
  catch (error) {
    fail(`World-model validation receipt schema is invalid: ${error.message}`, 'WMB_CACHE_RECEIPT_INVALID');
  }
  if (receipt.kind !== VALIDATION_RECEIPT_KIND || receipt.status !== 'passed') {
    fail('World-model cache accepts only passed v4 view validation receipts.', 'WMB_CACHE_RECEIPT_INVALID');
  }
  if (receipt.viewId !== components.viewId || receipt.viewVersion !== components.viewVersion
      || receipt.viewSpecSha256 !== components.viewSpecSha256
      || receipt.factLedgerSha256 !== components.viewFactLedgerSha256
      || receipt.scopeSha256 !== components.scopeManifestSha256
      || receipt.candidateSchemaSha256 !== components.compositionCandidateSchemaSha256
      || receipt.validatorSha256 !== components.validatorSha256) {
    fail('World-model validation receipt does not bind the exact view cache-key inputs.', 'WMB_CACHE_RECEIPT_MISMATCH');
  }
  for (const field of [
    'candidateSha256', 'viewSpecSha256', 'factLedgerSha256', 'scopeSha256',
    'validatorSha256', 'receiptSha256'
  ]) hashHex(receipt[field], `World-model validation receipt ${field}`);
  if (!Array.isArray(receipt.checks)
      || receipt.checks.some((check) => !plainObject(check) || check.status !== 'pass')
      || JSON.stringify(receipt.checks.map((check) => check.id))
        !== JSON.stringify(WMB_V4_VALIDATION_CHECK_IDS)) {
    fail('World-model validation receipt contains a non-passing check.', 'WMB_CACHE_RECEIPT_INVALID');
  }
  if (receipt.receiptSha256 !== sha256Record(withoutField(receipt, 'receiptSha256'))) {
    fail('World-model validation receipt self hash does not verify.', 'WMB_CACHE_RECEIPT_INVALID');
  }
  return receipt;
}

function validationReceiptBytes(receipt, components) {
  const normalized = assertValidationReceipt(receipt, components);
  return Object.freeze({ normalized, bytes: Buffer.from(canonicalJson(normalized)) });
}

function compositionCandidateBytes(value, receipt) {
  let candidate;
  try { candidate = readRecord(COMPOSITION_CANDIDATE_FAMILY, value).record; }
  catch (error) {
    fail(`World-model composition candidate schema is invalid: ${error.message}`, 'WMB_CACHE_CANDIDATE_INVALID');
  }
  const bytes = Buffer.from(canonicalJson(candidate));
  if (bytes.length > MAXIMUM_COMPOSITION_CANDIDATE_BYTES) {
    fail('World-model composition candidate exceeds its byte ceiling.', 'WMB_CACHE_CANDIDATE_INVALID');
  }
  if (sha256Record(candidate) !== receipt.candidateSha256) {
    fail('World-model composition candidate does not match its validation receipt.', 'WMB_CACHE_CANDIDATE_INVALID');
  }
  return Object.freeze({ normalized: Object.freeze(candidate), bytes });
}

function cacheRecordCore({ cacheKeySha256, viewSha256, validationReceiptSha256, createdAt }) {
  return {
    schemaVersion: currentSchemaVersion(VIEW_CACHE_RECORD_FAMILY),
    kind: CACHE_RECORD_KIND,
    cacheKeySha256,
    viewSha256,
    validationReceiptSha256,
    createdAt,
    lastUsedAt: createdAt,
    status: 'valid'
  };
}

function cacheRecord({ cacheKeySha256, viewSha256, validationReceiptSha256, createdAt }) {
  const core = cacheRecordCore({ cacheKeySha256, viewSha256, validationReceiptSha256, createdAt });
  return { ...core, recordSha256: sha256Record(core) };
}

function assertCacheRecord(rawBytes, expectedCacheKeySha256) {
  let record;
  try { record = readRecord(VIEW_CACHE_RECORD_FAMILY, rawBytes).record; }
  catch (error) {
    fail(`World-model view cache record schema is invalid: ${error.message}`, 'WMB_CACHE_ENTRY_CORRUPT');
  }
  const fields = [
    'schemaVersion', 'kind', 'cacheKeySha256', 'viewSha256', 'validationReceiptSha256',
    'createdAt', 'lastUsedAt', 'status', 'recordSha256'
  ];
  exactKeys(record, fields, 'World-model view cache record');
  if (!Buffer.from(canonicalJson(record)).equals(rawBytes)) {
    fail('World-model view cache record is not canonical JSON.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (record.kind !== CACHE_RECORD_KIND || record.status !== 'valid') {
    fail('World-model view cache record kind or status is invalid.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (record.cacheKeySha256 !== expectedCacheKeySha256) {
    fail('World-model view cache record is stored under the wrong cache key.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  for (const field of ['cacheKeySha256', 'viewSha256', 'validationReceiptSha256', 'recordSha256']) {
    hashHex(record[field], `World-model view cache record ${field}`);
  }
  if (!ISO_UTC.test(record.createdAt) || !ISO_UTC.test(record.lastUsedAt)) {
    fail('World-model view cache record timestamps are invalid.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (record.recordSha256 !== sha256Record(withoutField(record, 'recordSha256'))) {
    fail('World-model view cache record self hash does not verify.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  return record;
}

function miss(cacheKeySha256, recordPath) {
  return Object.freeze({
    hit: false,
    status: 'miss',
    code: 'WMB_CACHE_ENTRY_MISS',
    cacheKeySha256,
    recordPath
  });
}

function corrupt(cacheKeySha256, recordPath, error) {
  return Object.freeze({
    hit: false,
    status: 'corrupt',
    code: 'WMB_CACHE_ENTRY_CORRUPT',
    cacheKeySha256,
    recordPath,
    reason: error?.message ?? String(error)
  });
}

function cacheKeyObject(rawBytes, expectedCacheKeySha256, expectedComponents = null) {
  let value;
  try { value = JSON.parse(Buffer.from(rawBytes).toString('utf8')); }
  catch (error) {
    fail(`World-model cache key object is invalid JSON: ${error.message}`, 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (!plainObject(value)) {
    fail('World-model cache key object must be an object.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  exactKeys(
    value,
    ['schemaVersion', 'kind', ...VIEW_CACHE_KEY_FIELDS],
    'World-model cache key object'
  );
  const components = normalizedCacheKeyComponents(Object.fromEntries(
    VIEW_CACHE_KEY_FIELDS.map((field) => [field, value[field]])
  ));
  const derived = deriveWorldModelViewCacheKey(components);
  if (derived.cacheKeySha256 !== expectedCacheKeySha256) {
    fail('World-model cache key object does not match its content address.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (expectedComponents
      && canonicalJson(components) !== canonicalJson(normalizedCacheKeyComponents(expectedComponents))) {
    fail('World-model cache key object does not match the requested exact inputs.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  if (!Buffer.from(canonicalJson(derived.payload)).equals(rawBytes)) {
    fail('World-model cache key object is not canonical JSON.', 'WMB_CACHE_ENTRY_CORRUPT');
  }
  return Object.freeze({ components, payload: derived.payload });
}

async function readWorldModelViewCacheByIdentity(root, cacheKeySha256, {
  expectedComponents = null,
  maximumViewBytes = MAXIMUM_VIEW_BYTES,
  optional = false
} = {}) {
  const recordPath = cacheRecordPath(root, cacheKeySha256);
  let recordBytes;
  try {
    recordBytes = await readPrivateSidecar(root, recordPath, {
      maximumBytes: MAXIMUM_CACHE_RECORD_BYTES,
      optional
    });
  } catch (error) {
    return corrupt(cacheKeySha256, recordPath, error);
  }
  if (!recordBytes) return miss(cacheKeySha256, recordPath);

  try {
    const record = assertCacheRecord(recordBytes, cacheKeySha256);
    const keyPath = cacheKeyObjectPath(root, cacheKeySha256);
    const viewPath = cacheObjectPath(root, 'views', record.viewSha256);
    const receiptPath = cacheObjectPath(root, 'validation-receipts', record.validationReceiptSha256, '.json');
    const [keyBytes, viewBytes, receiptBytes] = await Promise.all([
      readPrivateSidecar(root, keyPath, { maximumBytes: MAXIMUM_CACHE_KEY_BYTES }),
      readPrivateSidecar(root, viewPath, { maximumBytes: maximumViewBytes }),
      readPrivateSidecar(root, receiptPath, { maximumBytes: MAXIMUM_VALIDATION_RECEIPT_BYTES })
    ]);
    const key = cacheKeyObject(keyBytes, cacheKeySha256, expectedComponents);
    if (viewSha256(viewBytes) !== record.viewSha256) {
      fail('World-model cached view content hash does not verify.', 'WMB_CACHE_ENTRY_CORRUPT');
    }
    const validationReceipt = assertValidationReceipt(receiptBytes, key.components);
    if (!Buffer.from(canonicalJson(validationReceipt)).equals(receiptBytes)) {
      fail('World-model cached validation receipt is not canonical JSON.', 'WMB_CACHE_ENTRY_CORRUPT');
    }
    if (validationReceipt.receiptSha256 !== record.validationReceiptSha256) {
      fail('World-model cached validation receipt identity does not verify.', 'WMB_CACHE_ENTRY_CORRUPT');
    }
    const candidatePath = cacheObjectPath(
      root, 'composition-candidates', validationReceipt.candidateSha256, '.json'
    );
    const candidateBytes = await readPrivateSidecar(root, candidatePath, {
      maximumBytes: MAXIMUM_COMPOSITION_CANDIDATE_BYTES
    });
    const candidate = compositionCandidateBytes(candidateBytes, validationReceipt).normalized;
    if (!Buffer.from(canonicalJson(candidate)).equals(candidateBytes)) {
      fail('World-model cached composition candidate is not canonical JSON.', 'WMB_CACHE_ENTRY_CORRUPT');
    }
    return Object.freeze({
      hit: true,
      status: 'hit',
      code: null,
      cacheKeySha256,
      components: key.components,
      recordPath,
      keyPath,
      viewPath,
      receiptPath,
      candidatePath,
      viewBytes,
      candidate,
      validationReceipt: Object.freeze(validationReceipt),
      record: Object.freeze(record)
    });
  } catch (error) {
    return corrupt(cacheKeySha256, recordPath, error);
  }
}

/** Read and fully verify one exact cache entry. Corruption is data, not an uncaught read error. */
export async function readWorldModelViewCache(root, keyComponents, {
  maximumViewBytes = MAXIMUM_VIEW_BYTES
} = {}) {
  maximumViewByteCeiling(maximumViewBytes);
  const { cacheKeySha256, components } = deriveWorldModelViewCacheKey(keyComponents);
  return readWorldModelViewCacheByIdentity(root, cacheKeySha256, {
    expectedComponents: components,
    maximumViewBytes,
    optional: true
  });
}

/**
 * Enumerate and independently verify every installed cache entry. This is intentionally separate
 * from exact-key lookup: a published model-composed view may retain an execution profile that the
 * current provider configuration can no longer reconstruct. The immutable key object makes the
 * original identity inspectable without trusting filenames or rerunning a model.
 */
export async function inspectWorldModelViewCache(root, {
  maximumViewBytes = MAXIMUM_VIEW_BYTES
} = {}) {
  maximumViewByteCeiling(maximumViewBytes);
  const recordsRoot = path.join(worldModelViewCacheRoot(root), 'records');
  const entries = [];
  const problems = [];
  const prefixes = await listPrivateSidecar(root, recordsRoot, { optional: true });
  for (const prefix of prefixes) {
    const prefixPath = path.join(recordsRoot, prefix.name);
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) {
      problems.push(Object.freeze({ path: prefixPath, reason: 'unexpected-cache-record-prefix' }));
      continue;
    }
    const digests = await listPrivateSidecar(root, prefixPath);
    for (const digest of digests) {
      const digestPath = path.join(prefixPath, digest.name);
      if (!digest.isDirectory() || !/^[a-f0-9]{64}$/.test(digest.name)
          || !digest.name.startsWith(prefix.name)) {
        problems.push(Object.freeze({ path: digestPath, reason: 'unexpected-cache-record-identity' }));
        continue;
      }
      const children = await listPrivateSidecar(root, digestPath);
      if (children.length !== 1 || children[0].name !== 'record.json' || !children[0].isFile()) {
        problems.push(Object.freeze({ path: digestPath, reason: 'cache-record-directory-is-not-exact' }));
        continue;
      }
      const cacheKeySha256 = `sha256:${digest.name}`;
      const result = await readWorldModelViewCacheByIdentity(root, cacheKeySha256, {
        maximumViewBytes
      });
      if (result.hit) entries.push(result);
      else problems.push(Object.freeze({
        path: result.recordPath,
        cacheKeySha256,
        reason: result.reason ?? result.code
      }));
    }
  }
  return Object.freeze({
    entries: Object.freeze(entries.sort((left, right) => (
      left.cacheKeySha256.localeCompare(right.cacheKeySha256)
    ))),
    problems: Object.freeze(problems.sort((left, right) => left.path.localeCompare(right.path)))
  });
}

async function quarantineUnsafeTarget(root, target, label) {
  let info;
  try { info = await lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const cacheRoot = worldModelViewCacheRoot(root);
  const quarantine = path.join(cacheRoot, 'quarantine');
  await safePrivateSidecarDirectory(root, quarantine, { create: true });
  await safePrivateSidecarDirectory(root, path.dirname(target));
  const destination = path.join(
    quarantine,
    `${label}-${Date.now()}-${process.pid}-${randomUUID()}-${path.basename(target)}`
  );
  await rename(target, destination).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  return info ? destination : null;
}

async function writeContentObject(root, target, bytes, maximumBytes, label) {
  try {
    return await writeImmutablePrivateSidecar(root, target, bytes, { maximumBytes });
  } catch (error) {
    if (!['PRIVATE_SIDECAR_PATH_UNSAFE', 'PRIVATE_SIDECAR_RECORD_CONFLICT'].includes(error?.code)) throw error;
    // A digest-named target containing different or unsafe bytes is a corrupt cache object, never a
    // valid winner. Quarantine it under the same Git-common cache and retry the immutable publish.
    await quarantineUnsafeTarget(root, target, label);
    return writeImmutablePrivateSidecar(root, target, bytes, { maximumBytes });
  }
}

async function withCacheEntryLock(root, cacheKeySha256, operation) {
  const id = hashHex(cacheKeySha256, 'World-model view cache key');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await withSubjectLock(root, { kind: 'world-model-cache-entry', id }, operation);
    } catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || attempt === 99) throw error;
      await delay(10);
    }
  }
  throw new SingularityFlowError('World-model cache entry lock retry budget was exhausted.', {
    code: 'WMB_CACHE_WRITE_RACE_INVALID', details: { cacheKeySha256 }
  });
}

/**
 * Write a complete entry. Immutable view/receipt objects land first and the key record last.
 * Ordinary concurrent fills retain the first complete winner. Explicit regeneration atomically
 * replaces the pointer only when its expected prior record still matches.
 */
export async function writeWorldModelViewCache(root, keyComponents, {
  view,
  candidate,
  validationReceipt,
  createdAt = new Date().toISOString(),
  maximumViewBytes = MAXIMUM_VIEW_BYTES,
  replaceExisting = false,
  expectedRecordSha256
} = {}) {
  maximumViewByteCeiling(maximumViewBytes);
  const { cacheKeySha256, components } = deriveWorldModelViewCacheKey(keyComponents);
  if (!ISO_UTC.test(createdAt)) fail('World-model view cache createdAt must be an ISO 8601 UTC timestamp.');
  const viewBytes = Buffer.isBuffer(view) ? Buffer.from(view) : Buffer.from(String(view ?? ''), 'utf8');
  if (!viewBytes.length || viewBytes.length > maximumViewBytes) {
    fail('World-model cached view is empty or exceeds its byte ceiling.', 'WMB_CACHE_VIEW_SIZE_INVALID', {
      bytes: viewBytes.length,
      maximumViewBytes
    });
  }
  const { normalized: normalizedValidationReceipt, bytes: receiptBytes } = validationReceiptBytes(
    validationReceipt,
    components
  );
  const { bytes: candidateBytes } = compositionCandidateBytes(
    candidate, normalizedValidationReceipt
  );
  if (receiptBytes.length > MAXIMUM_VALIDATION_RECEIPT_BYTES) {
    fail('World-model validation receipt exceeds its byte ceiling.', 'WMB_CACHE_RECEIPT_INVALID');
  }

  const existing = await readWorldModelViewCache(root, components, { maximumViewBytes });
  if (existing.hit && !replaceExisting) {
    return Object.freeze({ ...existing, written: false, raced: false, replaced: false });
  }
  if (!replaceExisting && existing.status === 'corrupt') {
    await quarantineUnsafeTarget(root, existing.recordPath, 'record');
  }
  if (expectedRecordSha256 !== undefined && expectedRecordSha256 !== null) {
    hashHex(expectedRecordSha256, 'World-model view cache expected record');
  }
  const expectedReplacementRecord = expectedRecordSha256 === undefined
    ? (existing.hit ? existing.record.recordSha256 : null)
    : expectedRecordSha256;

  const installedViewSha256 = viewSha256(viewBytes);
  const validationReceiptSha256 = normalizedValidationReceipt.receiptSha256;
  const cacheKeyPath = cacheKeyObjectPath(root, cacheKeySha256);
  const viewPath = cacheObjectPath(root, 'views', installedViewSha256);
  const receiptPath = cacheObjectPath(root, 'validation-receipts', validationReceiptSha256, '.json');
  const candidatePath = cacheObjectPath(
    root, 'composition-candidates', normalizedValidationReceipt.candidateSha256, '.json'
  );
  await Promise.all([
    writeContentObject(
      root, cacheKeyPath, Buffer.from(canonicalJson(deriveWorldModelViewCacheKey(components).payload)),
      MAXIMUM_CACHE_KEY_BYTES, 'cache-key'
    ),
    writeContentObject(root, viewPath, viewBytes, maximumViewBytes, 'view'),
    writeContentObject(
      root, receiptPath, receiptBytes, MAXIMUM_VALIDATION_RECEIPT_BYTES, 'validation-receipt'
    ),
    writeContentObject(
      root, candidatePath, candidateBytes, MAXIMUM_COMPOSITION_CANDIDATE_BYTES,
      'composition-candidate'
    )
  ]);

  const record = cacheRecord({
    cacheKeySha256,
    viewSha256: installedViewSha256,
    validationReceiptSha256,
    createdAt
  });
  const recordBytes = Buffer.from(canonicalJson(record));
  const recordPath = cacheRecordPath(root, cacheKeySha256);
  if (replaceExisting) {
    return withCacheEntryLock(root, cacheKeySha256, async () => {
      const current = await readWorldModelViewCache(root, components, { maximumViewBytes });
      const currentRecordSha256 = current.hit ? current.record.recordSha256 : null;
      if (currentRecordSha256 !== expectedReplacementRecord) {
        fail(
          'World-model cache entry changed while its replacement was being composed.',
          'WMB_CACHE_REPLACE_STALE',
          {
            cacheKeySha256,
            expectedRecordSha256: expectedReplacementRecord,
            currentRecordSha256,
            currentStatus: current.status
          }
        );
      }
      if (current.status === 'corrupt') {
        await quarantineUnsafeTarget(root, current.recordPath, 'record');
      }
      await writeMutablePrivateSidecar(root, recordPath, recordBytes, {
        maximumBytes: MAXIMUM_CACHE_RECORD_BYTES
      });
      const installed = await readWorldModelViewCache(root, components, { maximumViewBytes });
      if (!installed.hit || installed.record.recordSha256 !== record.recordSha256) {
        fail('World-model view cache replacement did not verify after publication.',
          'WMB_CACHE_WRITE_INVALID', {
            cacheKeySha256,
            status: installed.status,
            reason: installed.reason ?? null
          });
      }
      return Object.freeze({
        ...installed,
        written: true,
        raced: false,
        replaced: current.hit
      });
    });
  }
  let publication;
  try {
    publication = await writeImmutablePrivateSidecar(root, recordPath, recordBytes, {
      maximumBytes: MAXIMUM_CACHE_RECORD_BYTES
    });
  } catch (error) {
    if (error?.code !== 'PRIVATE_SIDECAR_RECORD_CONFLICT') throw error;
    // Different valid outputs can race for one exact semantic key. The immutable key record makes
    // the first complete writer authoritative for this cache generation; return that winner.
    const winner = await readWorldModelViewCache(root, components, { maximumViewBytes });
    if (!winner.hit) {
      fail('Concurrent world-model view cache writer left no valid winner.', 'WMB_CACHE_WRITE_RACE_INVALID', {
        cacheKeySha256,
        winnerStatus: winner.status
      });
    }
    return Object.freeze({ ...winner, written: false, raced: true, replaced: false });
  }

  const installed = await readWorldModelViewCache(root, components, { maximumViewBytes });
  if (!installed.hit) {
    fail('World-model view cache entry did not verify after publication.', 'WMB_CACHE_WRITE_INVALID', {
      cacheKeySha256,
      status: installed.status,
      reason: installed.reason ?? null
    });
  }
  return Object.freeze({
    ...installed,
    written: publication.created,
    raced: !publication.created,
    replaced: false
  });
}

function normalizedFactIds(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  const values = value.map((item) => String(item ?? '').trim());
  if (values.some((item) => !item)) fail(`${label} contains an empty fact ID.`);
  return [...new Set(values)].sort();
}

/** Conservative v4 behavior: the prior view is stale and no fact is asserted unaffected. */
export function createConservativeWorldModelStalenessReceipt({
  previousViewSha256,
  cause,
  affectedFactIds = [],
  viewId
} = {}) {
  hashHex(previousViewSha256, 'World-model staleness previousViewSha256');
  if (!plainObject(cause) || typeof cause.kind !== 'string' || !cause.kind.trim()) {
    fail('World-model staleness cause requires a kind.', 'WMB_STALENESS_RECEIPT_INVALID');
  }
  hashHex(cause.previousSha256, 'World-model staleness cause previousSha256');
  hashHex(cause.currentSha256, 'World-model staleness cause currentSha256');
  if (!VIEW_ID.test(String(viewId ?? ''))) {
    fail('World-model staleness next action requires a valid viewId.', 'WMB_STALENESS_RECEIPT_INVALID');
  }
  const core = {
    schemaVersion: currentSchemaVersion(STALENESS_RECEIPT_FAMILY),
    kind: STALENESS_RECEIPT_KIND,
    previousViewSha256,
    cause: {
      kind: cause.kind.trim(),
      previousSha256: cause.previousSha256,
      currentSha256: cause.currentSha256
    },
    affectedFactIds: normalizedFactIds(affectedFactIds, 'World-model staleness affectedFactIds'),
    unaffectedFactIds: [],
    status: 'stale',
    nextAction: { operation: 'world-model.regenerate-view', view: viewId }
  };
  return Object.freeze({ ...core, receiptSha256: sha256Record(core) });
}

export function verifyWorldModelStalenessReceipt(value) {
  try {
    const receipt = readRecord(STALENESS_RECEIPT_FAMILY, value).record;
    const expected = createConservativeWorldModelStalenessReceipt({
      previousViewSha256: receipt.previousViewSha256,
      cause: receipt.cause,
      affectedFactIds: receipt.affectedFactIds,
      viewId: receipt.nextAction?.view
    });
    return canonicalJson(expected) === canonicalJson(receipt);
  } catch {
    return false;
  }
}

export async function storeConservativeWorldModelStalenessReceipt(root, input) {
  const receipt = input?.kind === STALENESS_RECEIPT_KIND
    ? readRecord(STALENESS_RECEIPT_FAMILY, input).record
    : createConservativeWorldModelStalenessReceipt(input);
  if (!verifyWorldModelStalenessReceipt(receipt)) {
    fail('World-model staleness receipt does not verify.', 'WMB_STALENESS_RECEIPT_INVALID');
  }
  const target = stalenessReceiptPath(root, receipt.receiptSha256);
  const bytes = Buffer.from(canonicalJson(receipt));
  const result = await writeImmutablePrivateSidecar(root, target, bytes, {
    maximumBytes: MAXIMUM_STALENESS_RECEIPT_BYTES
  });
  return Object.freeze({ receipt: Object.freeze(receipt), path: target, written: result.created });
}
