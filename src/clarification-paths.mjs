/** Canonical clarification path, without loading the clarification writer. */
import path from 'node:path';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { posix } from './util.mjs';

export function clarificationRecordRelative(definition, workflow, phase, generation = nextPhaseGeneration(phase)) {
  return posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'context',
    `clarifications-${phase.id}-gen${generation}.json`
  ));
}
