/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { SingularityFlowError, optionBoolean } from '../util.mjs';
import { prepareConfiguredPhase } from './shared/prepare-configured-phase.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, succeeded, effects } from '../narration/command-result.mjs';
import { preparedPhaseNextActions } from './shared/prepared-phase-next-actions.mjs';
import { convergencePreparationState } from './shared/convergence-preparation-state.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => prepareCommand(positionals, options)));
}

export async function prepareCommand(positionals, options) {
  const root = repoRoot();
  const accepted = await loadAcceptedStoryExecution(root);
  const config = accepted.config;
  let workflow = accepted.workflow;
  const phase = positionals[1] ?? workflow.currentPhase;
  let phaseContract = workflow.phases[phase];
  if (!phaseContract) throw new SingularityFlowError(`Unknown or unavailable phase '${phase ?? ''}'. Provide a phase ID.`);
  const prepared = await prepareConfiguredPhase(root, config, workflow, phaseContract);
  workflow = prepared.workflow;
  phaseContract = workflow.phases[phase] ?? phaseContract;
  const artifact = prepared.artifact;
  emitCommandResult(commandResult({
    operation: { id: 'prepare', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('prepare.succeeded', { phase, path: artifact }),
    // Materialises the artifact from its template and captures the interval baseline. Nothing is
    // committed or pushed: preparing is not a governed transition.
    effects: effects({ filesChanged: true, stateChanged: true }),
    next: preparedPhaseNextActions(workflow, phaseContract, prepared),
    data: {
      preparation: {
        path: artifact,
        stage: 'prepared',
        producer: prepared.publicationProducer,
        authoringRequired: prepared.publicationProducer !== 'deterministic',
        instruction: prepared.publicationProducer === 'deterministic'
          ? 'The kernel owns this artifact. Check readiness; do not hand-edit deterministic output.'
          : prepared.publicationProducer === 'governed-agent'
            ? 'Preparation preserves the draft and captures inputs; it does not author it. Use the composed prompt and native file-edit tool to complete the existing artifact, then check readiness. Do not stop merely because the prepared template has TODOs.'
            : 'Preparation is not authoring. The configured human or external-tool producer owns completion; preserve its output and check readiness after that owner completes the draft.'
      },
      ...(prepared.convergence ? { convergence: convergencePreparationState(prepared.convergence) } : {})
    }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
