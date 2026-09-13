/**
 * TKR M3 derived segment memoization.
 *
 * This is a disposable performance layer in the repository's common Git directory. It is never
 * workflow authority, retained packet history, proof of publication, or provider-cache evidence.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import {
  readPrivateSidecar, safePrivateSidecarDirectory, writeImmutablePrivateSidecar
} from './private-sidecar.mjs';
import { SingularityFlowError } from './util.mjs';

const ENTRY_FORMAT = 'sflow-tkr-derived-segment-v1';
const ENTRY_KIND = 'token-reduction-derived-segment';
const KEY_FIELDS = Object.freeze([
  'domain', 'effectiveInputRefs', 'rendererRef', 'relevantSelectionRef',
  'normalizationRef', 'format', 'serializerRef', 'segmentKind'
]);
const ENTRY_FIELDS = Object.freeze([
  'recordFormat', 'kind', 'keySha256', 'key', 'contentEncoding',
  'contentSha256', 'contentBytes', 'content'
]);
const DOMAIN_FIELDS = Object.freeze(['accessScope', 'repositoryRef', 'candidateRef']);
const EFFECTIVE_INPUT_REF_FIELDS = Object.freeze(['kind', 'ref']);
const ACCESS_SCOPES = new Set(['repository-private', 'private-candidate']);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EXACT_CONTRACT_REF = /^[a-z][a-z0-9./-]*@[1-9][0-9]*#sha256:[a-f0-9]{64}$/u;
const INPUT_REF_KIND = /^[a-z][a-z0-9.-]{0,127}$/u;
const MAXIMUM_KEY_BYTES = 64 * 1024;
const MAXIMUM_CANONICAL_DEPTH = 24;
const MAXIMUM_CANONICAL_ITEMS = 4096;
const MAXIMUM_CANONICAL_STRING_BYTES = 32 * 1024;
const MAXIMUM_SCANNED_FILES = 4096;
const ACTIVE_PENDING_MAXIMUM_AGE_MS = 5 * 60 * 1000;

export const TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS = Object.freeze({
  maximumEntries: 1024,
  maximumDiskBytes: 64 * 1024 * 1024,
  maximumEntryBytes: 2 * 1024 * 1024,
  maximumSegmentBytes: 1536 * 1024
});

function fail(message, code, details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function canonicalValue(value, state = { seen: new WeakSet(), items: 0 }, depth = 0) {
  if (depth > MAXIMUM_CANONICAL_DEPTH || ++state.items > MAXIMUM_CANONICAL_ITEMS) {
    fail('Token-reduction segment dependencies exceed the bounded canonicalization envelope.',
      'TKR_LIMIT_EXCEEDED');
  }
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAXIMUM_CANONICAL_STRING_BYTES) {
      fail('A token-reduction segment dependency string exceeds its byte ceiling.',
        'TKR_LIMIT_EXCEEDED');
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Token-reduction segment dependencies must use finite JSON numbers.',
      'TKR_CONTRACT_UNSUPPORTED');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    fail('Token-reduction segment dependencies must be canonical JSON values.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  if (state.seen.has(value)) {
    fail('Token-reduction segment dependencies must not contain cycles.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (item === undefined) fail('Token-reduction segment dependency arrays cannot contain undefined.',
          'TKR_CONTRACT_UNSUPPORTED');
        return canonicalValue(item, state, depth + 1);
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('Token-reduction segment dependency objects must be plain JSON objects.',
        'TKR_CONTRACT_UNSUPPORTED');
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) fail('Token-reduction segment dependencies cannot contain undefined.',
        'TKR_CONTRACT_UNSUPPORTED');
      return [key, canonicalValue(value[key], state, depth + 1)];
    }));
  } finally {
    state.seen.delete(value);
  }
}

function exactText(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.length || value !== value.trim()
      || (pattern && !pattern.test(value))) {
    fail(`Token-reduction segment key requires an exact ${label}.`,
      'TKR_CONTRACT_UNSUPPORTED');
  }
  return canonicalValue(value);
}

function exactImmutableRef(value, label) {
  const reference = exactText(value, label);
  if (!SHA256.test(reference) && !EXACT_CONTRACT_REF.test(reference)) {
    fail(`Token-reduction segment key ${label} must bind an immutable SHA-256 reference.`,
      'TKR_CONTRACT_UNSUPPORTED');
  }
  return reference;
}

function normalizeDomain(value) {
  if (!exactKeys(value, DOMAIN_FIELDS)) {
    fail(`Token-reduction segment key domain requires exactly: ${DOMAIN_FIELDS.join(', ')}.`,
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const accessScope = exactText(value.accessScope, 'domain.accessScope', INPUT_REF_KIND);
  if (!ACCESS_SCOPES.has(accessScope)) {
    fail(`Token-reduction segment key domain.accessScope '${accessScope}' is unsupported.`,
      'TKR_CONTRACT_UNSUPPORTED');
  }
  return {
    accessScope,
    repositoryRef: exactImmutableRef(value.repositoryRef, 'domain.repositoryRef'),
    candidateRef: exactImmutableRef(value.candidateRef, 'domain.candidateRef')
  };
}

function normalizeEffectiveInputRefs(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('Token-reduction segment key effectiveInputRefs must be a non-empty array.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  if (value.length > MAXIMUM_CANONICAL_ITEMS) {
    fail('Token-reduction segment key effectiveInputRefs exceeds its entry ceiling.',
      'TKR_LIMIT_EXCEEDED');
  }
  const seen = new Set();
  return value.map((reference, index) => {
    if (!exactKeys(reference, EFFECTIVE_INPUT_REF_FIELDS)) {
      fail(`Token-reduction segment key effectiveInputRefs[${index}] requires exactly: ${EFFECTIVE_INPUT_REF_FIELDS.join(', ')}.`,
        'TKR_CONTRACT_UNSUPPORTED');
    }
    const normalized = {
      kind: exactText(
        reference.kind, `effectiveInputRefs[${index}].kind`, INPUT_REF_KIND
      ),
      ref: exactImmutableRef(reference.ref, `effectiveInputRefs[${index}].ref`)
    };
    const identity = JSON.stringify(normalized);
    if (seen.has(identity)) {
      fail(`Token-reduction segment key repeats effectiveInputRefs[${index}].`,
        'TKR_CONTRACT_UNSUPPORTED');
    }
    seen.add(identity);
    return normalized;
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/** Canonical dependency identity from TKR IFC-005. Arrays retain order; object keys are sorted. */
export function canonicalTokenReductionSegmentKey(input) {
  if (!exactKeys(input, KEY_FIELDS) || !Array.isArray(input.effectiveInputRefs)) {
    fail(`Token-reduction segment key requires exactly: ${KEY_FIELDS.join(', ')}.`,
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const key = {
    domain: normalizeDomain(input.domain),
    effectiveInputRefs: normalizeEffectiveInputRefs(input.effectiveInputRefs),
    rendererRef: exactImmutableRef(input.rendererRef, 'rendererRef'),
    relevantSelectionRef: exactImmutableRef(
      input.relevantSelectionRef, 'relevantSelectionRef'
    ),
    normalizationRef: exactImmutableRef(input.normalizationRef, 'normalizationRef'),
    format: exactText(input.format, 'format'),
    serializerRef: exactImmutableRef(input.serializerRef, 'serializerRef'),
    segmentKind: exactText(input.segmentKind, 'segmentKind', INPUT_REF_KIND)
  };
  const canonical = canonicalValue(key);
  if (Buffer.byteLength(JSON.stringify(canonical)) > MAXIMUM_KEY_BYTES) {
    fail('Token-reduction segment key exceeds its byte ceiling.', 'TKR_LIMIT_EXCEEDED');
  }
  return deepFreeze(canonical);
}

export function tokenReductionSegmentKeySha256(input) {
  const key = canonicalTokenReductionSegmentKey(input);
  return sha256(Buffer.from(JSON.stringify(key)));
}

export function tokenReductionSegmentCacheRoot(root) {
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'cache', 'token-reduction', 'segments', 'v1'
  );
}

function cachePaths(root, input) {
  const key = canonicalTokenReductionSegmentKey(input);
  const keySha256 = sha256(Buffer.from(JSON.stringify(key)));
  const hexadecimal = keySha256.slice('sha256:'.length);
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  return Object.freeze({
    cacheRoot,
    entriesRoot: path.join(cacheRoot, 'entries'),
    quarantineRoot: path.join(cacheRoot, 'quarantine'),
    target: path.join(cacheRoot, 'entries', hexadecimal.slice(0, 2), `${hexadecimal}.json`),
    key,
    keySha256
  });
}

export function tokenReductionSegmentCachePath(root, input) {
  return cachePaths(root, input).target;
}

function normalizeLimits(overrides = {}) {
  const allowed = Object.keys(TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
      || !exactKeys({ ...TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS, ...overrides }, allowed)
      || Object.keys(overrides).some((field) => !allowed.includes(field))) {
    fail('Token-reduction segment cache limits contain unknown fields.', 'TKR_LIMIT_EXCEEDED');
  }
  return Object.freeze(Object.fromEntries(allowed.map((field) => {
    const value = overrides[field] ?? TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS[field];
    if (!Number.isSafeInteger(value) || value < 1
        || value > TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS[field]) {
      fail(`Token-reduction segment cache ${field} must be between 1 and ${TOKEN_REDUCTION_SEGMENT_CACHE_LIMITS[field]}.`,
        'TKR_LIMIT_EXCEEDED');
    }
    return [field, value];
  })));
}

function recordBytes(located, content) {
  const record = {
    // Disposable derived-cache format. This is deliberately not a durable schemaVersion family.
    // It may be deleted on any incompatibility and never authorizes or reconstructs retained work.
    recordFormat: ENTRY_FORMAT,
    kind: ENTRY_KIND,
    keySha256: located.keySha256,
    key: located.key,
    contentEncoding: 'base64',
    contentSha256: sha256(content),
    contentBytes: content.length,
    content: content.toString('base64')
  };
  return Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
}

function parseRecord(raw, located = null) {
  let record;
  try { record = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (!exactKeys(record, ENTRY_FIELDS)
      || record.recordFormat !== ENTRY_FORMAT
      || record.kind !== ENTRY_KIND
      || record.contentEncoding !== 'base64'
      || !SHA256.test(record.keySha256 ?? '')
      || !SHA256.test(record.contentSha256 ?? '')
      || !Number.isSafeInteger(record.contentBytes) || record.contentBytes < 0
      || typeof record.content !== 'string') return null;
  let key;
  try { key = canonicalTokenReductionSegmentKey(record.key); } catch { return null; }
  const keySha256 = sha256(Buffer.from(JSON.stringify(key)));
  if (keySha256 !== record.keySha256
      || (located && (record.keySha256 !== located.keySha256
        || JSON.stringify(key) !== JSON.stringify(located.key)))) return null;
  const content = Buffer.from(record.content, 'base64');
  if (content.toString('base64') !== record.content
      || content.length !== record.contentBytes
      || sha256(content) !== record.contentSha256) return null;
  return Object.freeze({ record, key, content, keySha256, contentSha256: record.contentSha256 });
}

async function inspectEntry(root, located, limits) {
  try {
    const raw = await readPrivateSidecar(root, located.target, {
      maximumBytes: limits.maximumEntryBytes,
      optional: true
    });
    if (raw == null) return Object.freeze({ status: 'miss', reason: 'absent', located });
    const parsed = parseRecord(raw, located);
    if (!parsed || parsed.content.length > limits.maximumSegmentBytes) {
      return Object.freeze({ status: 'miss', reason: 'corrupt', corrupt: true, located });
    }
    return Object.freeze({
      status: 'hit', hit: true, located,
      keySha256: located.keySha256,
      contentSha256: parsed.contentSha256,
      contentBytes: parsed.content.length,
      content: Buffer.from(parsed.content)
    });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) {
      return Object.freeze({ status: 'miss', reason: 'absent', located });
    }
    // Cache bytes are never required authority. An unreadable/oversized/unsafe entry is a miss;
    // the admitted prepare boundary decides whether it may be quarantined or merely bypassed.
    return Object.freeze({
      status: 'miss', reason: 'corrupt', corrupt: true, located,
      ...(error?.code ? { cacheErrorCode: error.code } : {})
    });
  }
}

/** Lookup is read-only: no directory creation, access-time update, quarantine, or eviction. */
export async function lookupTokenReductionSegment(root, input, { limits = {} } = {}) {
  const located = cachePaths(root, input);
  const inspected = await inspectEntry(root, located, normalizeLimits(limits));
  if (inspected.status === 'hit') return inspected;
  return Object.freeze({
    status: 'miss', hit: false, reason: inspected.reason,
    corrupt: inspected.corrupt === true,
    keySha256: located.keySha256,
    ...(inspected.cacheErrorCode ? { cacheErrorCode: inspected.cacheErrorCode } : {})
  });
}

async function quarantineCorruptEntry(root, located, limits) {
  const sourceInfo = await lstat(located.target).catch((error) => {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
    throw error;
  });
  if (!sourceInfo) return false;
  await safePrivateSidecarDirectory(root, path.dirname(located.target));
  await safePrivateSidecarDirectory(root, located.quarantineRoot, { create: true });
  const hexadecimal = located.keySha256.slice('sha256:'.length);
  const destination = path.join(
    located.quarantineRoot, `${hexadecimal}-${randomUUID()}.json`
  );
  try {
    await rename(located.target, destination);
    // Quarantine is still disposable derived data. Enforce the same finite disk envelope later.
    return true;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
    // Quarantine failure must not prevent a valid uncached composition.
    if (error?.code === 'EXDEV' || error?.code === 'EACCES' || error?.code === 'EPERM') return false;
    throw error;
  }
}

function contentBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  fail('A token-reduction rendered segment must be a string, Buffer, or Uint8Array.',
    'TKR_CONTRACT_UNSUPPORTED');
}

function renderConflict(located, existing, proposed) {
  fail('Equal token-reduction segment dependencies produced different rendered bytes.',
    'TKR_RENDER_CONFLICT', {
      keySha256: located.keySha256,
      existing: { sha256: existing.contentSha256, bytes: existing.contentBytes },
      proposed: { sha256: sha256(proposed), bytes: proposed.length }
    });
}

function retainedKeySet(retainedKeys = []) {
  if (!Array.isArray(retainedKeys)) {
    fail('Retained segment keys must be an array.', 'TKR_CONTRACT_UNSUPPORTED');
  }
  return new Set(retainedKeys.map((key) => {
    if (typeof key === 'string') {
      if (!SHA256.test(key)) fail('Retained segment key digests must be full SHA-256 values.',
        'TKR_CONTRACT_UNSUPPORTED');
      return key;
    }
    return tokenReductionSegmentKeySha256(key);
  }));
}

async function cacheFiles(cacheRoot) {
  const output = [];
  let complete = true;
  for (const area of ['entries', 'quarantine']) {
    const areaRoot = path.join(cacheRoot, area);
    const areaInfo = await lstat(areaRoot).catch((error) => {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
      throw error;
    });
    if (!areaInfo) continue;
    if (!areaInfo.isDirectory() || areaInfo.isSymbolicLink()) {
      complete = false;
      continue;
    }
    let first;
    try { first = await readdir(areaRoot, { withFileTypes: true }); } catch {
      complete = false;
      continue;
    }
    if (area === 'entries' && first.some((entry) => (
      !entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{2}$/.test(entry.name)
    ))) complete = false;
    const directories = area === 'entries'
      ? first.filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
          .map((entry) => path.join(areaRoot, entry.name))
      : [areaRoot];
    for (const directory of directories.sort()) {
      let names;
      try { names = await readdir(directory, { withFileTypes: true }); } catch {
        complete = false;
        continue;
      }
      for (const entry of names.sort((left, right) => left.name.localeCompare(right.name))) {
        if (output.length >= MAXIMUM_SCANNED_FILES) {
          complete = false;
          break;
        }
        if (entry.isFile()
            && /^\.pending-[0-9]+-[a-f0-9-]+$/.test(entry.name)) {
          const pending = await lstat(path.join(directory, entry.name)).catch(() => null);
          // A concurrent immutable writer may remove its temporary entry between readdir/lstat.
          if (pending && (!pending.isFile() || pending.isSymbolicLink()
              || Date.now() - pending.mtimeMs > ACTIVE_PENDING_MAXIMUM_AGE_MS)) {
            complete = false;
          }
          continue;
        }
        const matched = area === 'entries'
          ? /^([a-f0-9]{64})\.json$/.exec(entry.name)
          : /^([a-f0-9]{64})-[a-f0-9-]+\.json$/.exec(entry.name);
        if (!matched || !entry.isFile() || entry.isSymbolicLink()) {
          complete = false;
          continue;
        }
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute).catch(() => null);
        if (info?.isFile() && !info.isSymbolicLink()) output.push({
          absolute, area, size: info.size, mtimeMs: info.mtimeMs,
          keySha256: `sha256:${matched[1]}`
        });
      }
      if (!complete) break;
    }
    if (!complete) break;
  }
  return { files: output, complete };
}

/** Evict only disposable entry/quarantine files; retained history directories are never traversed. */
export async function enforceTokenReductionSegmentCacheLimits(root, {
  limits = {}, retainedKeys = []
} = {}) {
  const normalized = normalizeLimits(limits);
  const retained = retainedKeySet(retainedKeys);
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  const scanned = await cacheFiles(cacheRoot);
  const files = scanned.files.sort((left, right) =>
    left.mtimeMs - right.mtimeMs || left.absolute.localeCompare(right.absolute));
  let entries = files.length;
  let bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  let evicted = 0;
  for (const entry of files) {
    if (entries <= normalized.maximumEntries && bytes <= normalized.maximumDiskBytes) break;
    if (entry.area === 'entries' && retained.has(entry.keySha256)) continue;
    try {
      await rm(entry.absolute, { force: true });
      entries -= 1;
      bytes -= entry.size;
      evicted += 1;
    } catch { /* A failed best-effort eviction is reflected by withinLimits=false below. */ }
  }
  return Object.freeze({
    entries, bytes, evicted, scanComplete: scanned.complete,
    withinLimits: scanned.complete
      && entries <= normalized.maximumEntries && bytes <= normalized.maximumDiskBytes,
    retainedEntries: files.filter((entry) =>
      entry.area === 'entries' && retained.has(entry.keySha256)).length,
    limits: normalized
  });
}

/**
 * Store already-rendered bytes after an admitted prepare. Storage failure returns the bytes and a
 * cache miss; a complete-key/different-byte conflict remains a hard deterministic refusal.
 */
export async function writeTokenReductionSegment(root, input, content, {
  admitted = false, quarantineCorrupt = true, retainedKeys = [], limits = {}
} = {}) {
  if (admitted !== true) {
    fail('Token-reduction segment cache writes require an admitted preparation operation.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const normalized = normalizeLimits(limits);
  const located = cachePaths(root, input);
  const rendered = contentBytes(content);
  const identity = {
    keySha256: located.keySha256,
    contentSha256: sha256(rendered),
    contentBytes: rendered.length,
    content: Buffer.from(rendered)
  };
  if (rendered.length > normalized.maximumSegmentBytes) {
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false, reason: 'segment-too-large'
    });
  }
  let existing = await inspectEntry(root, located, normalized);
  if (existing.status === 'hit') {
    if (!existing.content.equals(rendered)) renderConflict(located, existing, rendered);
    return Object.freeze({ ...existing, cached: true, reused: true });
  }
  let quarantined = false;
  if (existing.corrupt && quarantineCorrupt) {
    try { quarantined = await quarantineCorruptEntry(root, located, normalized); }
    catch { quarantined = false; }
    existing = await inspectEntry(root, located, normalized);
    if (existing.status === 'hit') {
      if (!existing.content.equals(rendered)) renderConflict(located, existing, rendered);
      return Object.freeze({ ...existing, cached: true, reused: true, quarantined });
    }
  }
  if (existing.corrupt) {
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false,
      reason: 'corrupt-entry-retained', quarantined: false
    });
  }
  const serialized = recordBytes(located, rendered);
  if (serialized.length > normalized.maximumEntryBytes) {
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false, reason: 'entry-too-large', quarantined
    });
  }
  let publication;
  try {
    publication = await writeImmutablePrivateSidecar(root, located.target, serialized, {
      maximumBytes: normalized.maximumEntryBytes
    });
  } catch (error) {
    if (error?.code === 'PRIVATE_SIDECAR_RECORD_CONFLICT') {
      const raced = await inspectEntry(root, located, normalized);
      if (raced.status === 'hit') {
        if (!raced.content.equals(rendered)) renderConflict(located, raced, rendered);
        return Object.freeze({ ...raced, cached: true, reused: true, raced: true, quarantined });
      }
    }
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false, reason: 'cache-write-failed',
      ...(error?.code ? { cacheErrorCode: error.code } : {}), quarantined
    });
  }
  let quota;
  try {
    quota = await enforceTokenReductionSegmentCacheLimits(root, { limits: normalized, retainedKeys });
  } catch (error) {
    if (publication.created) await rm(located.target, { force: true }).catch(() => {});
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false,
      reason: 'cache-maintenance-failed',
      ...(error?.code ? { cacheErrorCode: error.code } : {}),
      quarantined
    });
  }
  if (!quota.withinLimits) {
    if (publication.created) await rm(located.target, { force: true }).catch(() => {});
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false, reason: 'cache-full',
      quarantined, quota
    });
  }
  const survived = await inspectEntry(root, located, normalized);
  if (survived.status !== 'hit') {
    return Object.freeze({
      ...identity, status: 'miss', hit: false, cached: false, reason: 'cache-full',
      quarantined, quota
    });
  }
  if (!survived.content.equals(rendered)) renderConflict(located, survived, rendered);
  return Object.freeze({
    ...survived, cached: true, reused: publication.created === false,
    created: publication.created, quarantined, quota
  });
}

/** Render only inside an admitted prepare; cache failures never replace or invalidate its bytes. */
export async function prepareTokenReductionSegment(root, input, render, options = {}) {
  if (options.admitted !== true) {
    fail('Token-reduction segment preparation requires an admitted operation.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  if (typeof render !== 'function') {
    fail('Token-reduction segment preparation requires a deterministic renderer function.',
      'TKR_CONTRACT_UNSUPPORTED');
  }
  const hit = await lookupTokenReductionSegment(root, input, { limits: options.limits });
  if (hit.hit) return Object.freeze({ ...hit, cached: true, reused: true, rendered: false });
  const rendered = contentBytes(await render());
  const stored = await writeTokenReductionSegment(root, input, rendered, options);
  return Object.freeze({ ...stored, rendered: true, content: Buffer.from(rendered) });
}

export async function tokenReductionSegmentCacheStatus(root, { limits = {} } = {}) {
  const normalized = normalizeLimits(limits);
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  const scanned = await cacheFiles(cacheRoot);
  let validEntries = 0;
  let corruptEntries = 0;
  let contentBytesTotal = 0;
  for (const entry of scanned.files) {
    if (entry.area !== 'entries' || entry.size > normalized.maximumEntryBytes) {
      if (entry.area === 'entries') corruptEntries += 1;
      continue;
    }
    const raw = await readPrivateSidecar(root, entry.absolute, {
      maximumBytes: normalized.maximumEntryBytes,
      optional: true
    }).catch(() => null);
    const parsed = raw ? parseRecord(raw) : null;
    if (!parsed || parsed.keySha256 !== entry.keySha256
        || parsed.content.length > normalized.maximumSegmentBytes) corruptEntries += 1;
    else {
      validEntries += 1;
      contentBytesTotal += parsed.content.length;
    }
  }
  const diskBytes = scanned.files.reduce((sum, entry) => sum + entry.size, 0);
  return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only cache projection; never persisted or authorized
    status: !scanned.complete ? 'partial'
      : corruptEntries ? 'attention' : validEntries ? 'ready' : 'empty',
    entries: scanned.files.filter((entry) => entry.area === 'entries').length,
    validEntries,
    corruptEntries,
    quarantinedEntries: scanned.files.filter((entry) => entry.area === 'quarantine').length,
    contentBytes: contentBytesTotal,
    diskBytes,
    scanComplete: scanned.complete,
    withinLimits: scanned.complete
      && scanned.files.length <= normalized.maximumEntries
      && diskBytes <= normalized.maximumDiskBytes,
    limits: normalized
  });
}

/** Clear only disposable entries/quarantine; a sibling retained-history tree is never touched. */
export async function clearTokenReductionSegmentCache(root, {
  dryRun = false, retainedKeys = [], limits = {}
} = {}) {
  const retained = retainedKeySet(retainedKeys);
  const before = await tokenReductionSegmentCacheStatus(root, { limits });
  const cacheRoot = tokenReductionSegmentCacheRoot(root);
  const scanned = await cacheFiles(cacheRoot);
  const selected = scanned.files.filter((entry) =>
    entry.area === 'quarantine' || !retained.has(entry.keySha256));
  const scanComplete = before.scanComplete && scanned.complete;
  if (!dryRun && scanComplete) {
    for (const entry of selected) await rm(entry.absolute, { force: true });
  }
  return Object.freeze({
    schemaVersion: 1, // schema-transient: command/service result; never persisted or authorized
    status: !scanComplete ? 'partial' : dryRun ? 'preview' : 'cleared',
    scanComplete,
    removedEntries: !dryRun && scanComplete ? selected.length : 0,
    removableEntries: selected.length,
    retainedEntries: !dryRun && scanComplete
      ? scanned.files.length - selected.length : scanned.files.length,
    bytes: selected.reduce((sum, entry) => sum + entry.size, 0),
    before
  });
}
