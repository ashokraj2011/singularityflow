import { canonicalJson, TEXT_DIGEST_PROFILE } from './foundation/record-schema.mjs';
export { canonicalJson, compactCanonicalJson } from './foundation/record-schema.mjs';
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

/** Stable source-item identity shared by issue filing and read-only report association. */
export function discrepancyItemSha256(phaseId, itemText) {
  return createHash('sha256').update(`${phaseId}\n${String(itemText).replace(/\s+/gu, ' ').trim()}`).digest('hex');
}

export function recordSha256(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Native primitive capability; canonical record formatting is shared with the kernel. */
export const NODE_TEXT_DIGESTS = /* @__PURE__ */ Object.freeze({
  profile: TEXT_DIGEST_PROFILE,
  sha256Utf8(value) { return createHash('sha256').update(value).digest('hex'); }
});
