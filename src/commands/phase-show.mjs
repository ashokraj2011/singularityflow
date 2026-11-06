/** Phase document reads use the same review kernel without loading lifecycle mutation handlers. */
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { phaseReview } from './shared/phase-review.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';

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
  if (optionBoolean(options, 'for-agent') && !optionBoolean(options, 'json')) throw new SingularityFlowError('--for-agent requires --json.');
  // No agent reads the step sheet yet (study 6.6, S3), so it costs an agent's review no read of the list.
  const review = await measureCommandSpan('phase.review', () => phaseReview(root, definition, workflow, phase, { includeContinuation: true, includeSheet: !optionBoolean(options, 'for-agent') }));
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
    // `approve <PHASE>` in this terminal is then the one confirmation [SPEC-OAP M4].
    const { recordTerminalReview, terminalReviewBinding } = await import('../terminal-review.mjs');
    await recordTerminalReview(root, terminalReviewBinding(workflow, phase));
  }
}
