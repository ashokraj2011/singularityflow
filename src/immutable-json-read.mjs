/** Bounded byte-keyed parsing only. Never caches files, refs, policy admission or decisions. */
import { createHash } from 'node:crypto';

const cache = new Map();
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;
let retainedBytes = 0;

export function parseImmutableJson(bytes) {
  const key = createHash('sha256').update('utf8-json/v1\0').update(bytes).digest('hex');
  const known = cache.get(key);
  if (known) {
    cache.delete(key); cache.set(key, known);
    return structuredClone(known.value);
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (bytes.length <= MAX_BYTES / 4) {
    cache.set(key, { value: structuredClone(value), bytes: bytes.length });
    retainedBytes += bytes.length;
    for (const [oldKey, entry] of cache) {
      if (retainedBytes <= MAX_BYTES && cache.size <= MAX_ENTRIES) break;
      cache.delete(oldKey); retainedBytes -= entry.bytes;
    }
  }
  return value;
}
