import { isDeepStrictEqual } from 'node:util';

const DEFAULT_IGNORED_KEYS = Object.freeze(new Set([
  'at', 'completedAt', 'correlationId', 'createdAt', 'diagnosticId', 'durationMs',
  'firstFeedbackMs', 'recordedAt', 'requestId', 'startedAt', 'timestamp'
]));

function stableProjection(value, ignoredKeys) {
  if (Array.isArray(value)) return value.map((entry) => stableProjection(entry, ignoredKeys));
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !ignoredKeys.has(key))
    .map((key) => [key, stableProjection(value[key], ignoredKeys)]));
}

/**
 * Strip only reviewed non-semantic fields from a command result.
 *
 * Callers cannot pass dotted paths or regexes: a broad ignore rule could hide an authority or
 * evidence mismatch. Additions to this closed vocabulary require a reviewed code change.
 */
export function fosSemanticProjection(value, { ignoredKeys = DEFAULT_IGNORED_KEYS } = {}) {
  if (!(ignoredKeys instanceof Set)
      || [...ignoredKeys].some((key) => !DEFAULT_IGNORED_KEYS.has(key))) {
    throw new TypeError('FOS semantic projection accepts only the reviewed non-semantic key vocabulary.');
  }
  return Object.freeze(stableProjection(structuredClone(value), ignoredKeys));
}

export function compareFosSemanticProjections(reference, candidate) {
  const expected = fosSemanticProjection(reference);
  const actual = fosSemanticProjection(candidate);
  return Object.freeze({ equivalent: isDeepStrictEqual(expected, actual), expected, actual });
}

export const FOS_NON_SEMANTIC_KEYS = DEFAULT_IGNORED_KEYS;
