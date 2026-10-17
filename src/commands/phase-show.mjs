/** Phase document reads use the same review kernel without loading lifecycle mutation handlers. */
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { phaseReview } from './shared/phase-review.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability('phase', argv, options,
    () => withCommandConfirmation(options, () => phaseShowCommand(positionals, options)));
}

export async function phaseShowCommand(positionals, options) {
  const root = repoRoot();
  const { definition, workflow } = await loadAcceptedStoryExecution(root);
  const phaseId = positionals[2] ?? workflow.currentPhase;
  const phase = workflow.phases[phaseId];
  if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  const review = await phaseReview(root, definition, workflow, phase, { includeContinuation: true });
  if (optionBoolean(options, 'for-agent') && !optionBoolean(options, 'json')) throw new SingularityFlowError('--for-agent requires --json.');
  if (optionBoolean(options, 'for-agent')) {
    const { agentJson, phaseReviewAgentPresentation } = await import('../agent-packet-presentation.mjs');
    console.log(agentJson(phaseReviewAgentPresentation(review)));
  } else if (optionBoolean(options, 'json')) console.log(JSON.stringify(review, null, 2));
  else {
    const [{ printPhaseReview }, { phaseContinuationLines }] = await Promise.all([
      import('./shared/print-phase-review.mjs'), import('../phase-continuation.mjs')
    ]);
    printPhaseReview(review, { showArtifact: optionBoolean(options, 'show-artifact') });
    if (review.continuation) console.log(`\n${phaseContinuationLines(review.continuation).join('\n')}`);
  }
}
