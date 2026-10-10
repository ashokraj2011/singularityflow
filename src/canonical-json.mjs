import { createHash } from 'node:crypto';

/** JSON-only canonicalization used by every WMB v4 content identity. */
export function isPlainRecord(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`World-model canonical JSON cannot encode a non-finite number at ${location}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      if (entry === undefined) throw new TypeError(`World-model canonical JSON cannot encode undefined at ${location}[${index}].`);
      return canonicalValue(entry, `${location}[${index}]`);
    });
  }
  if (!isPlainRecord(value)) throw new TypeError(`World-model canonical JSON requires a plain object at ${location}.`);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`World-model canonical JSON cannot encode undefined at ${location}.${key}.`);
    output[key] = canonicalValue(value[key], `${location}.${key}`);
  }
  return output;
}

export function canonicalize(value) {
  return canonicalValue(value);
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(canonicalJson(value), 'utf8');
  return `sha256:${sha256Bytes(bytes)}`;
}

export function withoutFields(value, fields = []) {
  if (!isPlainRecord(value)) throw new TypeError('World-model record projection requires a plain object.');
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

export function recordSha256(value, hashField = null) {
  return sha256(hashField ? withoutFields(value, [hashField]) : value);
}

export function sealRecord(value, hashField) {
  const record = structuredClone(value);
  delete record[hashField];
  record[hashField] = sha256(record);
  return record;
}

export function assertRecordSha256(value, hashField, label = 'World-model record') {
  const expected = recordSha256(value, hashField);
  if (value?.[hashField] !== expected) {
    const error = new TypeError(`${label} ${hashField} does not match its canonical content.`);
    error.code = 'WMB_RECORD_HASH_MISMATCH';
    error.details = { hashField, expected, received: value?.[hashField] ?? null };
    throw error;
  }
  return value;
}

export function digestHex(value) {
  const digest = String(value ?? '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('World-model digest must be a lowercase SHA-256 value.');
  return digest;
}

/**
 * Allocate readable content IDs without treating a truncated digest as globally unique.
 * Identical full digests intentionally receive one ID; distinct digests extend together until
 * their visible suffixes differ.
 */
export function collisionSafeIds(digests, { prefix, minimumLength = 16 } = {}) {
  if (typeof prefix !== 'string' || !prefix) throw new TypeError('Content ID prefix is required.');
  if (!Number.isInteger(minimumLength) || minimumLength < 1 || minimumLength > 64) {
    throw new TypeError('Content ID minimumLength must be an integer from 1 through 64.');
  }
  const unique = [...new Set(digests.map(digestHex))].sort();
  const lengths = new Map(unique.map((digest) => [digest, minimumLength]));
  while (true) {
    const groups = new Map();
    for (const digest of unique) {
      const visible = digest.slice(0, lengths.get(digest));
      if (!groups.has(visible)) groups.set(visible, []);
      groups.get(visible).push(digest);
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1);
    if (!collisions.length) break;
    for (const group of collisions) {
      for (const digest of group) {
        const next = lengths.get(digest) + 1;
        if (next > 64) {
          const error = new TypeError('Distinct world-model content descriptors produced the same full SHA-256 digest.');
          error.code = 'WMB_CONTENT_DIGEST_COLLISION';
          throw error;
        }
        lengths.set(digest, next);
      }
    }
  }
  return new Map(unique.map((digest) => [digest, `${prefix}${digest.slice(0, lengths.get(digest))}`]));
}

export function compareCanonical(left, right) {
  return compareText(canonicalJson(left), canonicalJson(right));
}

/** Locale-independent lexical order for every governed registry and ledger. */
export function compareText(left, right) {
  const first = String(left);
  const second = String(right);
  return first === second ? 0 : first < second ? -1 : 1;
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
