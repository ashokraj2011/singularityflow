export {assertWithinLimit,capWithDisclosure} from './kernel/configuration-declarations.mjs';
import { DEFAULT_ANALYSIS_LIMITS,capWithDisclosure } from './kernel/configuration-declarations.mjs';
export { DEFAULT_ANALYSIS_LIMITS, analysisLimits } from './kernel/configuration-declarations.mjs';
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
