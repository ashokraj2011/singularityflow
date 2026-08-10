/**
 * Read the stamped docs manifest `[DOC:REQ-004]`.
 *
 * Loaded once and cached: `explain` is an L0 read that people run repeatedly, and re-parsing a
 * committed JSON file on every invocation would be a cost with nothing to show for it.
 *
 * A missing manifest is not fatal. Topics still resolve and still serve — the provenance line simply
 * says `unstamped`, which is the truthful thing to say about a tree whose manifest was never built.
 * Refusing to answer would punish the reader for a build-time omission they cannot fix.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cached;

export function docsManifest() {
  if (cached !== undefined) return cached;
  try {
    cached = require('./docs-manifest.json');
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam: forget the cached manifest so a fixture can be read instead. */
export function resetDocsManifestCache() {
  cached = undefined;
}
