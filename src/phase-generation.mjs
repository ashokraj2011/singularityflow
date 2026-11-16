import path from 'node:path';
import { invariant, posix, SingularityFlowError } from './util.mjs';
import { versionNumbers } from './kernel/step-versions.mjs';
import { counters } from './phase-generation-need.mjs';

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

/** max(generation, high-watermark, used reservation) + 1, validated: the kernel's one version arithmetic (§4.3). */
export function nextPhaseGeneration(phase) {
  const numbers = versionNumbers(counters(phase) ?? {});
  if (!numbers.ok) throw new SingularityFlowError('Phase generation counters must be nonnegative safe integers with room for a new generation.', {
    code: 'GENERATION_COUNTER_INVALID'
  });
  return numbers.next;
}
