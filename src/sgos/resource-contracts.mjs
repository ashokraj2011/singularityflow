import { SingularityFlowError } from '../util.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';

export const SGOS_RESOURCE_MODES = Object.freeze([
  'read', 'write', 'device', 'external-effect'
]);

const FIELD_MODE = Object.freeze({
  reads: 'read',
  writes: 'write',
  devices: 'device',
  externalEffects: 'external-effect'
});

function fail(message, code = 'SGOS_RESOURCE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

/** Keep runtime resource identity byte-for-byte compatible with the static safety oracle. */
export function normalizeSgosResourceKey(value) {
  const normalized = String(value ?? '').trim().normalize('NFC')
    .replaceAll('\\', '/')
    .replace(/\/(?:\*\*|\*)$/, '')
    .replace(/\/$/, '');
  if (!normalized) fail('A resource key cannot be empty.');
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('A resource key cannot contain control characters.');
  }
  // Path-like resource identities are an authorization boundary.  Refuse traversal aliases
  // (including percent-encoded dots) instead of allowing two spellings of the same target to
  // evade the parallel conflict proof.
  if (normalized.split('/').some((segment) => {
    const decodedDots = segment.replace(/%2e/giu, '.');
    return decodedDots === '.' || decodedDots === '..';
  })) {
    fail('A resource key cannot contain traversal segments.');
  }
  return normalized;
}

export function sgosResourceKeysOverlap(left, right) {
  const a = normalizeSgosResourceKey(left);
  const b = normalizeSgosResourceKey(right);
  return a === '*' || b === '*' || a === b
    || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function compareEntry(left, right) {
  return compareSgosCodePoints(left.key, right.key)
    || compareSgosCodePoints(left.mode, right.mode);
}

export function canonicalSgosResourceEntries(resources = {}) {
  const entries = [];
  for (const [field, mode] of Object.entries(FIELD_MODE)) {
    const values = resources?.[field] ?? [];
    if (!Array.isArray(values)) fail(`Resource field '${field}' must be an array.`);
    for (const value of values) entries.push({ key: normalizeSgosResourceKey(value), mode });
  }
  const unique = new Map(entries.map((entry) => [`${entry.key}\0${entry.mode}`, entry]));
  const result = [...unique.values()].sort(compareEntry);
  if (result.length > SGOS_INSTALLED_LIMITS.maximumResourceLeaseEntries) {
    fail('A task resource lease exceeds the installed entry ceiling.',
      'SGOS_RESOURCE_LEASE_LIMIT', {
        actual: result.length,
        maximum: SGOS_INSTALLED_LIMITS.maximumResourceLeaseEntries
      });
  }
  return Object.freeze(result.map((entry) => Object.freeze(entry)));
}

function modesConflict(left, right) {
  if (left === 'read' && right === 'read') return false;
  if ((left === 'read' || left === 'write') && (right === 'read' || right === 'write')) {
    return left === 'write' || right === 'write';
  }
  return left === right;
}

export function sgosResourceEntriesConflict(leftEntries = [], rightEntries = []) {
  for (const left of leftEntries) {
    for (const right of rightEntries) {
      if (modesConflict(left.mode, right.mode)
          && sgosResourceKeysOverlap(left.key, right.key)) return true;
    }
  }
  return false;
}

export function sgosResourceConflictDetails(leftEntries = [], rightEntries = []) {
  const conflicts = [];
  for (const left of leftEntries) {
    for (const right of rightEntries) {
      if (!modesConflict(left.mode, right.mode)
          || !sgosResourceKeysOverlap(left.key, right.key)) continue;
      conflicts.push(Object.freeze({
        left: Object.freeze({ ...left }), right: Object.freeze({ ...right })
      }));
    }
  }
  return Object.freeze(conflicts.sort((left, right) =>
    compareEntry(left.left, right.left) || compareEntry(left.right, right.right)));
}
