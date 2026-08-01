/**
 * Content addressing for append-only records.
 *
 * Every governed record in this product is named by the hash of its own canonical form, so two
 * writers producing the same claim produce the same file rather than two. The canonical form sorts
 * object keys at every depth, because JSON key order is an accident of construction and must not
 * change a record's identity.
 *
 * These live apart from initiative-evidence.mjs — where they used to be — only so that modules which
 * need to *hash* a record do not have to import the module that *writes initiative* records.
 * knowledge.mjs needed exactly that, and the resulting cycle was what stopped the approval path from
 * harvesting knowledge at all. initiative-evidence.mjs re-exports both names, so every existing
 * caller is unaffected.
 */
import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function recordSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
