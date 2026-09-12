import path from 'node:path';

import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, deepFreeze, isPlainRecord, sha256 } from '../canonicalize.mjs';
import {
  parseCanonicalWmpRecordBytes, validateWmpHandoff,
  validateWmpModelBinding, validateWmpViewBinding
} from './contracts.mjs';
import { WMP_MAXIMUM_OBJECT_BYTES } from './identity.mjs';
import {
  DEFAULT_WORLD_MODEL_HISTORY_DIR, DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  validateWorldModelHistoryRoots, worldModelHistoryHandoffPath,
  worldModelHistoryModelPath, worldModelHistoryObjectPath, worldModelHistoryViewPath
} from './paths.mjs';
import {
  parseExactRetainedObject, validateRetainedObjectReference
} from './retained-object.mjs';

const MAXIMUM_HISTORY_ADDITIONS = 100_000;
// The complete projection plus this history envelope must fit the 128 MiB immutable recovery
// sidecar. Reserve room for current projection bytes and recovery metadata in this first release.
const MAXIMUM_HISTORY_BYTES = 64 * 1024 * 1024;
const OBJECT_REF_KEYS = Object.freeze(['bytes', 'family', 'mediaType', 'role', 'sha256']);

function fail(message, code = 'WMP_PUBLICATION_INVALID', details = {}, cause = undefined) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function exactObjectRef(value) {
  return isPlainRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(OBJECT_REF_KEYS);
}

function collectObjectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectRefs(entry, refs);
  } else if (isPlainRecord(value)) {
    if (exactObjectRef(value)) {
      validateRetainedObjectReference(value);
      refs.push(value);
    } else {
      for (const entry of Object.values(value)) collectObjectRefs(entry, refs);
    }
  }
  return refs;
}

function exactUtf8Bytes(value, label) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    fail(`${label} must provide exact UTF-8 bytes.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (!bytes.length || bytes.length > WMP_MAXIMUM_OBJECT_BYTES) {
    fail(`${label} exceeds the retained-object byte limit.`, 'WMP_CONTRACT_LIMIT', {
      bytes: bytes.length, maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
    });
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    fail(`${label} is not valid UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED', {}, error);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(`${label} does not round-trip as exact UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED');
  }
  return { bytes, text };
}

const KEYED_HISTORY_PATHS = Object.freeze({
  models: Object.freeze({
    family: 'world-model-model-binding', identityField: 'modelKey'
  }),
  views: Object.freeze({
    family: 'world-model-view-binding', identityField: 'viewKey'
  }),
  handoffs: Object.freeze({
    family: 'world-model-handoff', identityField: 'handoffSha256'
  })
});

function historyPathDescriptor(target, historyDir) {
  const prefix = `${historyDir}/`;
  if (path.posix.normalize(target) !== target || !target.startsWith(prefix)) return null;
  const relative = target.slice(prefix.length);
  const keyed = /^(models|views|handoffs)\/([a-f0-9]{64})\.json$/.exec(relative);
  if (keyed) return Object.freeze({
    kind: 'keyed', ...KEYED_HISTORY_PATHS[keyed[1]],
    identity: `sha256:${keyed[2]}`
  });
  const object = /^objects\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(relative);
  if (object && object[2].startsWith(object[1])) return Object.freeze({
    kind: 'object', identity: `sha256:${object[2]}`
  });
  return null;
}

function exactExpectation(value, target, digest, bytes) {
  if (!isPlainRecord(value)
      || canonicalJson(Object.keys(value).sort())
        !== canonicalJson(['bytes', 'condition', 'gitMode', 'sha256'])
      || value.condition !== 'absent-or-identical'
      || value.sha256 !== digest
      || value.bytes !== bytes
      || value.gitMode !== '100644') {
    fail(`World-model history addition '${target}' is not bound to exact create-if-absent bytes.`,
      'WMP_PUBLICATION_INVALID', { path: target });
  }
  return Object.freeze({ ...value });
}

/**
 * Revalidate a raw history envelope at the state-writer boundary.
 *
 * The stager is a convenience, not an authority boundary: callers can construct the four maps
 * directly. This validator therefore accepts only the closed history grammar, binds every keyed
 * record to its identity and content-addressed copy, and recursively verifies every referenced
 * object through its semantic owner. Unreferenced content-addressed bytes are inert and may be
 * retained for a concurrent/future binding, but they cannot establish a verified record.
 */
export function validateStagedWorldModelHistory({
  outputDir = DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR,
  historyAdditions, historyExpectations, exactBlobSha256
} = {}) {
  const roots = validateWorldModelHistoryRoots({ outputDir, historyDir });
  for (const [label, value] of [
    ['historyAdditions', historyAdditions],
    ['historyExpectations', historyExpectations],
    ['exactBlobSha256', exactBlobSha256]
  ]) {
    if (!isPlainRecord(value)) {
      fail(`World-model ${label} must be a plain-object path map.`,
        'WMP_PUBLICATION_INVALID');
    }
  }
  const paths = Object.keys(historyAdditions).sort();
  if (paths.length > MAXIMUM_HISTORY_ADDITIONS) {
    fail('World-model history additions exceed their path limit.', 'WMP_CONTRACT_LIMIT', {
      paths: paths.length, maximumPaths: MAXIMUM_HISTORY_ADDITIONS
    });
  }
  for (const [label, received] of [
    ['historyExpectations', Object.keys(historyExpectations).sort()],
    ['exactBlobSha256', Object.keys(exactBlobSha256).sort()]
  ]) {
    if (canonicalJson(received) !== canonicalJson(paths)) {
      fail(`World-model ${label} must bind exactly the immutable history additions.`,
        'WMP_PUBLICATION_INVALID', { additions: paths, received });
    }
  }

  const additions = {};
  const expectations = {};
  const exactDigests = {};
  const retainedByDigest = new Map();
  const keyedRecords = [];
  let totalBytes = 0;
  for (const target of paths) {
    const descriptor = historyPathDescriptor(target, roots.historyDir);
    const contents = historyAdditions[target];
    if (!descriptor || typeof contents !== 'string') {
      fail(`World-model history addition '${target}' is outside the closed immutable layout.`,
        'WMP_HISTORY_PATH_INVALID', { path: target });
    }
    const raw = Buffer.from(contents, 'utf8');
    if (!raw.length || raw.length > WMP_MAXIMUM_OBJECT_BYTES) {
      fail(`World-model history addition '${target}' exceeds its per-record/object byte limit.`,
        'WMP_CONTRACT_LIMIT', {
          path: target, bytes: raw.length, maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
        });
    }
    totalBytes += raw.length;
    if (totalBytes > MAXIMUM_HISTORY_BYTES) {
      fail('World-model history additions exceed their bounded publication envelope.',
        'WMP_CONTRACT_LIMIT', {
          paths: paths.length, bytes: totalBytes, maximumBytes: MAXIMUM_HISTORY_BYTES
        });
    }
    const digest = sha256(raw);
    expectations[target] = exactExpectation(
      historyExpectations[target], target, digest, raw.length
    );
    if (exactBlobSha256[target] !== digest) {
      fail(`World-model history addition '${target}' has an inconsistent exact-blob digest.`,
        'WMP_INTEGRITY_FAILED', {
          path: target, expectedSha256: digest,
          receivedSha256: exactBlobSha256[target] ?? null
        });
    }
    additions[target] = contents;
    exactDigests[target] = digest;
    if (descriptor.kind === 'object') {
      if (digest !== descriptor.identity) {
        fail(`World-model retained object path does not match its exact bytes: '${target}'.`,
          'WMP_INTEGRITY_FAILED', {
            path: target, expectedSha256: descriptor.identity, observedSha256: digest
          });
      }
      retainedByDigest.set(digest, Object.freeze({ path: target, bytes: raw }));
      continue;
    }
    const record = parseCanonicalWmpRecordBytes(descriptor.family, raw, {
      maximumBytes: raw.length
    });
    if (record[descriptor.identityField] !== descriptor.identity) {
      fail(`World-model history keyed path does not match its record identity: '${target}'.`,
        'WMP_INTEGRITY_FAILED', {
          path: target, identityField: descriptor.identityField,
          expected: descriptor.identity, received: record[descriptor.identityField] ?? null
        });
    }
    keyedRecords.push(Object.freeze({ target, record, bytes: raw, byteSha256: digest }));
  }

  for (const keyed of keyedRecords) {
    const retained = retainedByDigest.get(keyed.byteSha256);
    if (!retained) {
      fail(`World-model keyed record '${keyed.target}' is missing its content-addressed copy.`,
        'WMP_INPUT_MISSING', {
          path: keyed.target,
          sha256: keyed.byteSha256,
          objectPath: worldModelHistoryObjectPath(keyed.byteSha256, roots)
        });
    }
    if (!retained.bytes.equals(keyed.bytes)) {
      fail(`World-model keyed record '${keyed.target}' differs from its content-addressed copy.`,
        'WMP_INTEGRITY_FAILED', { path: keyed.target, sha256: keyed.byteSha256 });
    }
  }

  const resolved = new Map();
  const visit = (refValue, ancestors, owner) => {
    const ref = validateRetainedObjectReference(refValue);
    if (ancestors.includes(ref.sha256)) {
      fail(`World-model retained-object closure contains a cycle at '${ref.sha256}'.`,
        'WMP_INTEGRITY_FAILED', {
          owner, sha256: ref.sha256, cycle: [...ancestors, ref.sha256]
        });
    }
    const prior = resolved.get(ref.sha256);
    if (prior) {
      if (canonicalJson(prior.ref) !== canonicalJson(ref)) {
        fail(`World-model closure repeats '${ref.sha256}' with contradictory metadata.`,
          'WMP_INTEGRITY_FAILED', { sha256: ref.sha256 });
      }
      return;
    }
    const retained = retainedByDigest.get(ref.sha256);
    if (!retained) {
      fail(`World-model retained closure is missing '${ref.sha256}'.`,
        'WMP_INPUT_MISSING', {
          owner, role: ref.role, sha256: ref.sha256,
          path: worldModelHistoryObjectPath(ref.sha256, roots)
        });
    }
    const record = parseExactRetainedObject(ref, retained.bytes);
    resolved.set(ref.sha256, Object.freeze({ ref: structuredClone(ref), record }));
    if (record) {
      for (const child of collectObjectRefs(record)) {
        visit(child, [...ancestors, ref.sha256], ref.sha256);
      }
    }
  };
  for (const keyed of keyedRecords) {
    for (const ref of collectObjectRefs(keyed.record)) visit(ref, [], keyed.target);
  }

  return deepFreeze({
    historyDir: roots.historyDir,
    historyAdditions: additions,
    historyExpectations: expectations,
    exactBlobSha256: exactDigests
  });
}

export const validateStagedWorldModelHistoryPublication = validateStagedWorldModelHistory;

/**
 * Stage additive, immutable World-model history independently of the replaceable current view.
 * Every binding is stored under its input key and its raw-byte object digest. Referenced objects
 * must be supplied as a complete exact closure; no ambient cache or state read fills a gap.
 */
export function stageWorldModelHistoryPublication({
  outputDir = DEFAULT_WORLD_MODEL_OUTPUT_DIR,
  historyDir = DEFAULT_WORLD_MODEL_HISTORY_DIR,
  modelBindings = [], viewBindings = [], objects = [], handoffs = []
} = {}) {
  const roots = validateWorldModelHistoryRoots({ outputDir, historyDir });
  for (const [label, value] of [
    ['modelBindings', modelBindings], ['viewBindings', viewBindings],
    ['objects', objects], ['handoffs', handoffs]
  ]) {
    if (!Array.isArray(value)) fail(`World-model history ${label} must be an array.`);
  }

  const additions = new Map();
  const availableObjects = new Map();
  const parsedObjects = [];
  let totalBytes = 0;

  const add = (target, text) => {
    const bytes = Buffer.from(text, 'utf8');
    if (!bytes.length || bytes.length > WMP_MAXIMUM_OBJECT_BYTES) {
      fail(`World-model history record '${target}' exceeds its per-record/object byte limit.`,
        'WMP_CONTRACT_LIMIT', {
          path: target, bytes: bytes.length, maximumBytes: WMP_MAXIMUM_OBJECT_BYTES
        });
    }
    const digest = sha256(bytes);
    const prior = additions.get(target);
    if (prior && prior.digest !== digest) {
      fail(`World-model history path '${target}' has two different staged values.`,
        'WMP_IDENTITY_CONFLICT', { path: target, firstSha256: prior.digest, secondSha256: digest });
    }
    if (!prior) {
      if (additions.size >= MAXIMUM_HISTORY_ADDITIONS
          || totalBytes + bytes.length > MAXIMUM_HISTORY_BYTES) {
        fail('World-model history additions exceed their bounded publication envelope.',
          'WMP_CONTRACT_LIMIT', {
            paths: additions.size + 1, bytes: totalBytes + bytes.length,
            maximumPaths: MAXIMUM_HISTORY_ADDITIONS, maximumBytes: MAXIMUM_HISTORY_BYTES
          });
      }
      additions.set(target, { text, digest, bytes: bytes.length });
      totalBytes += bytes.length;
    }
    return { digest, bytes: bytes.length };
  };

  const addRecord = (record, family, validate, keyedPath) => {
    const verified = validate(record);
    const text = canonicalJson(verified);
    const raw = Buffer.from(text, 'utf8');
    const digest = sha256(raw);
    add(keyedPath(verified), text);
    add(worldModelHistoryObjectPath(digest, roots), text);
    const prior = availableObjects.get(digest);
    if (prior && (prior.ref.bytes !== raw.length || prior.ref.family !== family
        || prior.ref.mediaType !== 'application/json' || !prior.bytes.equals(raw))) {
      fail(`Retained record digest '${digest}' has contradictory metadata or bytes.`,
        'WMP_IDENTITY_CONFLICT', { sha256: digest });
    }
    if (!prior) availableObjects.set(digest, {
      ref: { family, mediaType: 'application/json', sha256: digest, bytes: raw.length },
      bytes: raw
    });
    parsedObjects.push(verified);
  };

  for (const binding of modelBindings) {
    addRecord(binding, 'world-model-model-binding', validateWmpModelBinding,
      (record) => worldModelHistoryModelPath(record.modelKey, roots));
  }
  for (const binding of viewBindings) {
    addRecord(binding, 'world-model-view-binding', validateWmpViewBinding,
      (record) => worldModelHistoryViewPath(record.viewKey, roots));
  }
  for (const handoff of handoffs) {
    addRecord(handoff, 'world-model-handoff', validateWmpHandoff,
      (record) => worldModelHistoryHandoffPath(record.handoffSha256, roots));
  }

  for (const [index, object] of objects.entries()) {
    if (!isPlainRecord(object)
        || JSON.stringify(Object.keys(object).sort()) !== JSON.stringify(['bytes', 'ref'])) {
      fail(`World-model retained object ${index} must contain exactly ref and bytes.`);
    }
    const ref = validateRetainedObjectReference(object.ref);
    const raw = exactUtf8Bytes(object.bytes, `World-model retained object '${ref.role}'`);
    const parsed = parseExactRetainedObject(ref, raw.bytes);
    const prior = availableObjects.get(ref.sha256);
    if (prior && (prior.ref.bytes !== ref.bytes || prior.ref.family !== ref.family
        || prior.ref.mediaType !== ref.mediaType || !prior.bytes.equals(raw.bytes))) {
      fail(`Retained object digest '${ref.sha256}' has contradictory metadata or bytes.`,
        'WMP_IDENTITY_CONFLICT', { sha256: ref.sha256 });
    }
    if (!prior) availableObjects.set(ref.sha256, { ref, bytes: raw.bytes });
    add(worldModelHistoryObjectPath(ref.sha256, roots), raw.text);
    if (parsed) parsedObjects.push(parsed);
  }

  const missing = [];
  for (const owner of parsedObjects) {
    for (const ref of collectObjectRefs(owner)) {
      if (!availableObjects.has(ref.sha256)) missing.push({ role: ref.role, sha256: ref.sha256 });
    }
  }
  if (missing.length) {
    fail('World-model history publication does not contain its complete retained-object closure.',
      'WMP_INPUT_MISSING', { missing: missing.slice(0, 100), omitted: Math.max(0, missing.length - 100) });
  }

  const historyAdditions = {};
  const historyExpectations = {};
  const exactBlobSha256 = {};
  for (const [target, value] of [...additions.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0)) {
    historyAdditions[target] = value.text;
    historyExpectations[target] = Object.freeze({
      condition: 'absent-or-identical', sha256: value.digest,
      bytes: value.bytes, gitMode: '100644'
    });
    exactBlobSha256[target] = value.digest;
  }
  const verified = validateStagedWorldModelHistory({
    outputDir: roots.outputDir,
    historyDir: roots.historyDir,
    historyAdditions,
    historyExpectations,
    exactBlobSha256
  });
  return deepFreeze({
    ...verified,
    summary: { paths: additions.size, bytes: totalBytes }
  });
}

export const stagePersistedWorldModelHistory = stageWorldModelHistoryPublication;
