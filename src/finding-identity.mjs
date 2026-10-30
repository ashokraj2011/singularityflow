/**
 * Canonical finding identity [SDA-AC-022]. A gate problem is named by what it is about (code, path,
 * value), never by its sentence or a line number, so rewording a message or moving a line leaves a
 * dispute and an escalation streak matching the same finding. A list value (aggregated clause IDs)
 * is one sorted set.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './records.mjs';

export const CANONICAL_FINDING_ID = /^FND-[a-f0-9]{24}$/u;

/** The normalized identity with its ID: { id, code, path, value }. */
export function canonicalFinding({ code, path = null, value = null } = {}) {
  const identity = { code: String(code), path: path ?? null,
    value: Array.isArray(value) ? [...new Set(value.map(String))].sort() : value ?? null };
  return { id: `FND-${createHash('sha256').update(canonicalJson(identity)).digest('hex').slice(0, 24)}`, ...identity };
}

export function canonicalFindingId(identity) {
  return canonicalFinding(identity).id;
}
