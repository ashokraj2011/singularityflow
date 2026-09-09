/** RFC 8785 JSON Canonicalization Scheme for LOC semantic records. */
import { SingularityFlowError } from '../util.mjs';

function fail(message) {
  throw new SingularityFlowError(message, { code: 'LOCAL_RECORD_INVALID' });
}

function validUnicode(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} contains an unpaired Unicode surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${label} contains an unpaired Unicode surrogate.`);
    }
  }
}

function encode(value, seen, label) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    validUnicode(value, label);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number.`);
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || value instanceof Uint8Array) {
    fail(`${label} contains a value JCS cannot encode.`);
  }
  if (seen.has(value)) fail(`${label} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => encode(entry, seen, `${label}[${index}]`)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} is not a plain JSON object.`);
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      validUnicode(key, `${label} key`);
      if (value[key] === undefined) fail(`${label}.${key} is undefined.`);
      return `${JSON.stringify(key)}:${encode(value[key], seen, `${label}.${key}`)}`;
    }).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJcs(value) {
  return encode(value, new Set(), 'record');
}

export function parseCanonicalJcs(bytes, { maximumBytes = 16 * 1024 * 1024 } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length > maximumBytes) fail(`Canonical JSON exceeds ${maximumBytes} bytes.`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  let value;
  try { value = JSON.parse(text); } catch (error) {
    throw new SingularityFlowError(`Canonical JSON is invalid: ${error.message}`, {
      code: 'LOCAL_RECORD_INVALID', cause: error
    });
  }
  if (canonicalJcs(value) !== text) fail('JSON bytes are not in the registered RFC 8785 canonical form.');
  return value;
}
