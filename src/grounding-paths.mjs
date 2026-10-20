/** Record paths shared by read-only guidance and grounding writers, without writer imports. */
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { posix } from './util.mjs';

export function groundingRecordRelative(definition, workflow, phase, generation = nextPhaseGeneration(phase)) {
  return posix(path.join(definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context', `${phase.id}-gen${generation}.json`));
}
