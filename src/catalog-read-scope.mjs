import { inReadScope, scopedRead } from './read-scope.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';
import { serialize } from 'node:v8';

const CACHE = Symbol('catalog-read-snapshots');
const MAX_ENTRIES = 32;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;

function retainFrozenShape(source, copy, seen = new WeakSet()) {
  if (!source || typeof source !== 'object' || seen.has(source)) return;
  seen.add(source);
  if (source instanceof Map) {
    const copied = [...copy];
    [...source].forEach(([key, value], index) => {
      retainFrozenShape(key, copied[index][0], seen);
      retainFrozenShape(value, copied[index][1], seen);
    });
  } else if (source instanceof Set) {
    const copied = [...copy];
    [...source].forEach((value, index) => retainFrozenShape(value, copied[index], seen));
  } else {
    for (const key of Object.keys(source)) retainFrozenShape(source[key], copy[key], seen);
  }
  if (Object.isFrozen(source)) Object.freeze(copy);
}

/**
 * One catalog scan per explicitly read-only request snapshot; never a process/disk catalog cache.
 * Writers and composed mutations exit read scopes. Direct active-asset reads keep their existing
 * filesystem/security checks. Copies preserve frozen records and optional nonserializable
 * provenance without letting a caller change the snapshot another reader receives.
 */
export async function scopedCatalogRead(key, compute, preserve = null) {
  incrementCommandCounter('catalog.reads');
  const scan = () => { incrementCommandCounter('catalog.scans'); return compute(); };
  if (!inReadScope()) return scan();
  const state = await scopedRead(CACHE, () => ({ entries: new Map(), bytes: 0 }));
  let pending = state.entries.get(key);
  if (pending) incrementCommandCounter('catalog.cache-hits');
  else {
    pending = (async () => {
      const value = await scan();
      if (state.entries.get(key) !== pending) return value;
      const size = serialize(value).length + Buffer.byteLength(key);
      if (size > MAX_ENTRY_BYTES || state.bytes + size > MAX_BYTES) state.entries.delete(key);
      else state.bytes += size;
      return value;
    })();
    if (state.entries.size < MAX_ENTRIES) state.entries.set(key, pending);
    // A larger workspace still gets its original read; later calls scan an uncached catalog again.
    pending.catch(() => { if (state.entries.get(key) === pending) state.entries.delete(key); });
  }
  const source = await pending;
  const copy = structuredClone(source);
  retainFrozenShape(source, copy);
  preserve?.(source, copy);
  return copy;
}
