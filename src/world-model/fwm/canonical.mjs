import { createHash } from 'node:crypto';

const NAMESPACE = /^[a-z0-9][a-z0-9./:@-]{0,127}$/;

function fail(message, code = 'FWM_CANONICAL_INPUT_INVALID', details = null) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

function assertUnicode(value, location) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`FWM canonical JSON rejects an unpaired high surrogate at ${location}.`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`FWM canonical JSON rejects an unpaired low surrogate at ${location}.`);
    }
  }
}

function canonicalValue(value, location = '$') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertUnicode(value, location);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`FWM canonical JSON rejects a non-finite number at ${location}.`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail(`FWM canonical JSON requires unsafe integers to be encoded as validated strings at ${location}.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) fail(`FWM canonical JSON rejects undefined at ${location}[${index}].`);
      return canonicalValue(entry, `${location}[${index}]`);
    });
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`FWM canonical JSON requires a plain JSON object at ${location}.`);
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    assertUnicode(key, `${location} key`);
    if (value[key] === undefined) fail(`FWM canonical JSON rejects undefined at ${location}.${key}.`);
    result[key] = canonicalValue(value[key], `${location}.${key}`);
  }
  return result;
}

/** RFC 8785-compatible JSON bytes for the JSON subset admitted by the FWM schemas. */
export function fwmCanonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/** Namespace-separated semantic identity. The namespace is part of the hash preimage. */
export function fwmSemanticSha256(namespace, value) {
  if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
    fail('FWM semantic hash namespace is invalid.', 'FWM_HASH_NAMESPACE_INVALID', { namespace });
  }
  return `sha256:${createHash('sha256')
    .update(Buffer.from(namespace, 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(fwmCanonicalJson(value), 'utf8'))
    .digest('hex')}`;
}

export function fwmSealRecord(value, hashField, namespace = value?.kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('FWM can seal only a plain record.');
  }
  const record = structuredClone(value);
  delete record[hashField];
  record[hashField] = fwmSemanticSha256(namespace, record);
  return record;
}

export function assertFwmRecordHash(value, hashField, namespace = value?.kind) {
  const copy = structuredClone(value);
  const received = copy?.[hashField] ?? null;
  delete copy[hashField];
  const expected = fwmSemanticSha256(namespace, copy);
  if (received !== expected) {
    fail(`FWM ${hashField} does not match its canonical semantic content.`,
      'FWM_RECORD_HASH_MISMATCH', { hashField, expected, received });
  }
  return value;
}
