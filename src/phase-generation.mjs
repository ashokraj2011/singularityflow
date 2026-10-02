import { SingularityFlowError } from './util.mjs';

/**
 * A restored checkpoint selects earlier evidence; it does not make later publication identities
 * reusable. Keep the allocation watermark separate from the generation currently being reviewed.
 */
export function nextPhaseGeneration(phase) {
  const values = [phase?.generation, phase?.generationHighWatermark].map((value) => value === undefined ? 0 : value);
  const counters = values.map((value) => typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)
    ? Number(value) : value);
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)
      || Math.max(...counters) >= Number.MAX_SAFE_INTEGER) {
    throw new SingularityFlowError('Phase generation counters must be nonnegative safe integers with room for a new generation.', {
      code: 'GENERATION_COUNTER_INVALID'
    });
  }
  return Math.max(...counters) + 1;
}
