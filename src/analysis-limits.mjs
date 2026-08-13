/**
 * Bounds for deterministic analysis and convergence. `[SPK:REQ-130]` `[SPK:REQ-131]` `[SPK:REQ-133]`
 *
 * Both engines join records whose size nobody chose: a reconciliation over a large refactor can
 * report tens of thousands of changed paths, and one fact per path is not a report — it is a way of
 * making a real finding unfindable. So the work is bounded, and the bounds are configurable
 * `[SPK:REQ-130]` because the right number for a small service is wrong for a monorepo.
 *
 * The important decision is what happens at the edge, and it differs by direction:
 *
 * - An **input** past its bound is refused. A 40 MB "specification" is a mistake, and analysing it
 *   anyway would spend five seconds proving something nobody wanted.
 * - An **output** past its bound is capped *and disclosed*. Silent truncation is the failure this
 *   codebase is most allergic to: a list of 200 facts that stops at 200 reads exactly like a
 *   complete list of 200, and the reader has no way to tell. Every cap emits a record saying what
 *   was dropped and how to see it.
 */
import { SingularityFlowError } from './util.mjs';

export const DEFAULT_ANALYSIS_LIMITS = Object.freeze({
  /** Refused above this: analysing a document this large is answering the wrong question. */
  maxArtifactBytes: 2 * 1024 * 1024,
  /** Reconciliation findings convergence will join before it starts capping. */
  maxChangedPaths: 2000,
  /** Clauses convergence will consider. `extractClauses` bounds the index itself. */
  maxClauses: 2000,
  /** Evidence records bound into one iteration. */
  maxEvidenceRecords: 500,
  /** Facts or findings a single report will carry. */
  maxFacts: 500,
  /** The serialized record, so one iteration cannot become a file nothing can open. */
  maxOutputBytes: 4 * 1024 * 1024
});

const KEYS = Object.freeze(Object.keys(DEFAULT_ANALYSIS_LIMITS));

/** Normalize and validate a configured `analysisLimits` block. */
export function analysisLimits(value = {}) {
  if (value == null) return DEFAULT_ANALYSIS_LIMITS;
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('analysisLimits must be an object.');
  for (const key of Object.keys(value)) {
    if (!KEYS.includes(key)) throw new SingularityFlowError(`analysisLimits contains unknown field '${key}'. Allowed: ${KEYS.join(', ')}.`);
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      throw new SingularityFlowError(`analysisLimits.${key} must be a positive integer.`);
    }
  }
  return Object.freeze({ ...DEFAULT_ANALYSIS_LIMITS, ...value });
}

/**
 * Refuse an input that is past its bound.
 *
 * Names the limit and the key that raises it, because a refusal a reader cannot act on is only
 * slightly better than a hang.
 */
export function assertWithinLimit(actual, key, { limits = DEFAULT_ANALYSIS_LIMITS, label, unit = '' } = {}) {
  const limit = limits[key] ?? DEFAULT_ANALYSIS_LIMITS[key];
  if (actual <= limit) return actual;
  throw new SingularityFlowError(
    `${label} is ${actual}${unit} and the configured limit is ${limit}${unit}. `
    + `Raise analysisLimits.${key} if this is genuinely the size of the work.`
  );
}

/**
 * Cap a list and say so. `[SPK:REQ-130]`
 *
 * Returns the kept items and a disclosure, never a quietly shortened array. Callers are expected to
 * put the disclosure somewhere a reader sees — a capped list with the note dropped is the silent
 * truncation this exists to prevent.
 */
export function capWithDisclosure(items, key, { limits = DEFAULT_ANALYSIS_LIMITS, label } = {}) {
  const limit = limits[key] ?? DEFAULT_ANALYSIS_LIMITS[key];
  const list = [...items];
  if (list.length <= limit) return { items: list, dropped: 0, disclosure: null };
  return {
    items: list.slice(0, limit),
    dropped: list.length - limit,
    disclosure: `${list.length} ${label} exceeded the configured limit of ${limit}; ${list.length - limit} are not listed. `
      + `Raise analysisLimits.${key} to see them all.`
  };
}

/**
 * A bounded reference envelope for an assisted pass. `[SPK:REQ-131]`
 *
 * Assisted operations get references and excerpts, never "the repository". The bound is on what is
 * *sent*, which is the only place it can be enforced — once a model has the content, no policy
 * downstream can un-send it.
 */
export function boundedEnvelope(entries, { limits = DEFAULT_ANALYSIS_LIMITS, maxEntryBytes = 4096, label = 'reference' } = {}) {
  const capped = capWithDisclosure(entries, 'maxEvidenceRecords', { limits, label });
  let total = 0;
  const kept = [];
  for (const entry of capped.items) {
    const excerpt = String(entry.excerpt ?? '').slice(0, maxEntryBytes);
    const bytes = Buffer.byteLength(excerpt, 'utf8');
    if (total + bytes > limits.maxOutputBytes) break;
    total += bytes;
    kept.push({ ...entry, excerpt, truncated: excerpt.length < String(entry.excerpt ?? '').length });
  }
  const dropped = capped.dropped + (capped.items.length - kept.length);
  return {
    entries: kept,
    bytes: total,
    dropped,
    disclosure: dropped
      ? `${dropped} ${label}(s) were not sent to the model: the envelope is bounded to ${limits.maxEvidenceRecords} records and ${limits.maxOutputBytes} bytes.`
      : null
  };
}
