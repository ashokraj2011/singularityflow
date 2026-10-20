import path from 'node:path';
import { invariant, posix, SingularityFlowError } from './util.mjs';

/** Pure selection, shared with the persistence API without importing that API. */
export function currentPhase(workflow) {
  if (!workflow.currentPhase) return null;
  const phase = workflow.phases[workflow.currentPhase];
  invariant(phase, `Unknown current phase ${workflow.currentPhase}.`);
  return phase;
}

/** Pure context-record location, without grounding, source-review or input readers. */
export function groundingRecordRelative(definition, workflow, phase, generation = nextPhaseGeneration(phase)) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `${phase.id}-gen${generation}.json`));
}

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
