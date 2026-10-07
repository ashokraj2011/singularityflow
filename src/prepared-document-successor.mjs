import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { hasPublishedPhaseGeneration } from './code-submission-evidence.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';

/** Explicit successful prepare opens document authoring, never code or submitted evidence. */
export function reservePreparedDocumentSuccessor(workflow, phase, at) {
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress'
      || phaseRequiresCodeDelivery(phase) || phase.generationPolicy?.requirement === 'none'
      || !hasPublishedPhaseGeneration(phase) || phaseNeedsGeneration(workflow, phase)) return false;
  phase.reworkRevalidation = { generation: phase.generation, invalidatedAt: at };
  return true;
}
