import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { actionCommandLines, copilotAction } from './copilot-guidance.mjs';

/**
 * Render the one phase-preparation action through the shared command/skill resolvers.
 *
 * Phase ids are workflow data, not Copilot skill names. Custom phases therefore keep their exact
 * shell argument while routing to the generation skill selected by phase policy.
 */
export function phasePreparationCommandLines(phase, label = 'Run') {
  const command = `singularity-flow prepare ${phase.id}`;
  const action = copilotAction({ skill: generationSkillForPhase(phase), command });
  return actionCommandLines(action, label);
}
