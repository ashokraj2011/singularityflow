import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';

/**
 * Reuse pure source analysis, not the read or authority that supplied its input. `[perf]`
 *
 * Each scanner owns a cache and supplies its schema/options as `identity`. The complete UTF-16
 * text is hashed (including unpaired surrogates), so edits cannot reuse an earlier analysis.
 * Serialized snapshots keep callers from poisoning later results; no entry survives the process.
 */
export function createSourceAnalysisCache({
  maximumEntries = 128, maximumBytes = 8 * 1024 * 1024,
  maximumEntryBytes = 1024 * 1024, maximumSourceCharacters = 1024 * 1024
} = {}) {
  for (const limit of [maximumEntries, maximumBytes, maximumEntryBytes, maximumSourceCharacters]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Source analysis cache limits must be nonnegative safe integers.');
  }
  const entries = new Map();
  let bytes = 0;
  return (source, identity, analyze) => {
    if (!maximumEntries || !maximumBytes || !maximumEntryBytes || typeof source !== 'string' || typeof identity !== 'string'
        || source.length > maximumSourceCharacters || identity.length > 4096) return analyze();
    const digest = createHash('sha256').update(source, 'utf16le').digest('hex');
    const key = JSON.stringify([identity, digest]);
    const known = entries.get(key);
    if (known) {
      entries.delete(key);
      entries.set(key, known);
      return deserialize(known.snapshot);
    }
    // Analysis exceptions are never cached or turned into a successful result.
    const result = analyze();
    let snapshot;
    try { snapshot = serialize(result); } catch { return result; }
    const size = snapshot.length + Buffer.byteLength(key);
    if (size > maximumEntryBytes || size > maximumBytes) return result;
    entries.set(key, { snapshot, size });
    bytes += size;
    while (entries.size > maximumEntries || bytes > maximumBytes) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).size;
      entries.delete(oldest);
    }
    return result;
  };
}
