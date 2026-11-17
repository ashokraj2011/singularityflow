import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { hasPublishedPhaseGeneration } from './code-submission-evidence.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';
import { SingularityFlowError } from './util.mjs';

/** A current document step published, with no next draft open: that draft is a new version, owed the person's yes [D3]. */
export const documentSuccessorUnopened = (workflow, phase) => workflow.currentPhase === phase.id && phase.status === 'in_progress'
  && !phaseRequiresCodeDelivery(phase) && phase.generationPolicy?.requirement !== 'none'
  && hasPublishedPhaseGeneration(phase) && !phaseNeedsGeneration(workflow, phase);

/** That draft's refusal where it is written or published with no yes, naming its preview as `ask` says it [D3]. */
export async function documentSuccessorRefusal(workflow, phase, ask = { requested: true }) {
  const route = (await import('./guide.mjs')).requestedSuccessorAction(workflow, phase, ask)
    ?? (await import('./step-decision.mjs')).stepRoute(workflow, phase);
  return new SingularityFlowError(`The next version of ${phase.id} opens only on the person's yes. Nothing was opened. Preview it and ask them with the step's own preview.`,
    { code: 'VERSION_CONSENT_REQUIRED', details: { phase: phase.id, nextAction: route && { command: route.command,
      copilotCommand: route.copilotCommand ?? null, label: route.reason ?? route.detail ?? null } } });
}

/** The opening operation's reservation of that draft (phase-opening.mjs documentOpening), on the person's yes. */
export function reservePreparedDocumentSuccessor(workflow, phase, at) {
  if (!documentSuccessorUnopened(workflow, phase)) return false;
  phase.reworkRevalidation = { generation: phase.generation, invalidatedAt: at };
  return true;
}
