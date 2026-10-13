/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { effectivePhasePublicationProducer } from '../../manual-authorship.mjs';
import { operationContext } from '../../operation-context.mjs';
import { isConvergencePhase } from '../../phase-roles.mjs';
import { storyDraftTransaction } from './story-draft-transaction.mjs';
import { preparePhase, saveStoryDraft } from '../../state-stores.mjs';

/**
 * Prepare one phase through its configured generator.
 *
 * Convergence is not a generic template: its deterministic artifact is a projection of the
 * implementation reconciliation and clause evidence. Keeping this dispatch beside both CLI
 * preparation entry points prevents `next` and `prepare` from drifting into different generators.
 */
export async function prepareConfiguredPhase(root, config, workflow, phase) {
  const publicationProducer = effectivePhasePublicationProducer(phase, {
    modelEnabled: operationContext()?.modelMode.enabled !== false
  });
  if (isConvergencePhase(phase) && publicationProducer === 'deterministic') {
    const { prepareDeterministicConvergence } = await import('../story.mjs');
    const prepared = await prepareDeterministicConvergence(root, config, workflow.workItem.id);
    return {
      artifact: prepared.artifactPath,
      workflow: prepared.workflow,
      convergence: prepared.projection,
      publicationProducer
    };
  }
  const artifact = await storyDraftTransaction(root, config, workflow, `prepare:${phase.id}`, async () => {
    const prepared = await preparePhase(root, config, workflow, phase.id);
    await saveStoryDraft(root, config, workflow);
    return prepared;
  });
  return { artifact, workflow, convergence: null, publicationProducer };
}
