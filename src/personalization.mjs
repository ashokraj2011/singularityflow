/**
 * Presentation-only personalization derived from the actor's local Git identity.
 *
 * This value never participates in authorization, handle binding, lifecycle state, or telemetry.
 * Those use the stable actor ID. A display name is allowed only to make a reply feel addressed to
 * the person who asked, and every renderer still escapes it for its own output format.
 */

export const PERSONALIZATION_SCHEMA_VERSION = 1;

const NON_PERSON_NAMES = /^(?:unknown(?:-user)?|root|runner|github-actions(?:\[bot\])?|singularity flow)$/i;

function cleanDisplayName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // Control and bidi-control characters have no place in a greeting and can disguise its source.
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  if (!cleaned || NON_PERSON_NAMES.test(cleaned) || (cleaned.includes('@') && !cleaned.includes(' '))) return null;
  return cleaned;
}

function replyName(displayName) {
  if (!displayName) return null;
  // Accommodate the common Git form "Family, Given" without inventing a nickname.
  const givenSide = displayName.includes(',') ? displayName.split(',').slice(1).join(' ').trim() : displayName;
  return givenSide.split(/\s+/)[0] || displayName;
}

export function personalizationFromGitIdentity(actor) {
  const displayName = cleanDisplayName(actor?.name);
  return Object.freeze({
    schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
    source: 'git-identity',
    displayName,
    replyName: replyName(displayName)
  });
}
