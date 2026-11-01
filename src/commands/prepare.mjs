/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { repoRoot } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { SingularityFlowError, optionBoolean } from '../util.mjs';
import { prepareConfiguredPhase } from './shared/prepare-configured-phase.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, succeeded, effects } from '../narration/command-result.mjs';
import { preparedPhaseNextActions } from './shared/prepared-phase-next-actions.mjs';
import { phaseKernelOwned } from '../code-delivery-policy.mjs';
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
  // A template draft (with its approved inputs) is often longer than the host file tool shows at
  // once; refused whole, an agent then reads it again in slices. Name the ranges up front.
  const draftText = artifact ? await readFile(path.resolve(root, artifact), 'utf8').catch(() => null) : null;
  const read = draftText == null ? null : (await import('../agent-output.mjs')).readRangesText(draftText);
  const scope = await preparedScope(root, config, workflow, phaseContract, prepared);
  emitCommandResult(commandResult({
    operation: { id: 'prepare', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('prepare.succeeded', { phase, path: artifact, ...(read ? { read } : {}), ...(scope ? { scope } : {}) }),
    // Materialises the artifact from its template and captures the interval baseline. Nothing is
    // committed or pushed: preparing is not a governed transition.
    effects: effects({ filesChanged: true, stateChanged: true }),
    next: preparedPhaseNextActions(workflow, phaseContract, prepared),
    data: {
      preparation: {
        path: artifact,
        ...(read ? { read } : {}),
        ...(scope ? { scope } : {}),
        stage: 'prepared',
        producer: prepared.publicationProducer,
        authoringRequired: prepared.publicationProducer !== 'deterministic' || !phaseKernelOwned(phaseContract),
        instruction: prepared.publicationProducer === 'deterministic' && !phaseKernelOwned(phaseContract)
          ? 'The kernel builds this summary from what changed; the code is not written yet. Write the planned code and tests in the open generation, run prepare again to rebuild the summary, then check readiness. Never hand-edit the summary.'
          : prepared.publicationProducer === 'deterministic'
          ? 'The kernel owns this artifact. Check readiness; do not hand-edit deterministic output.'
          : prepared.publicationProducer === 'governed-agent'
            ? 'Preparation preserves the draft and captures inputs; it does not author it. Use the composed prompt and native file-edit tool to complete the existing artifact, then check readiness. Do not stop merely because the prepared template has TODOs.'
            : 'Preparation is not authoring. The configured human or external-tool producer owns completion; preserve its output and check readiness after that owner completes the draft.'
      },
      ...(prepared.convergence ? { convergence: convergencePreparationState(prepared.convergence) } : {})
    }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}

/**
 * The source statements a scope-owning draft has yet to link, named where its author starts. The
 * phase-entry scopeReview carried them, but in a field the bounded result moved to its file: two
 * live discount Stories went from their clarification answers to prepare and never read it, so
 * none of their sliced clauses was linked (SPEC-SPA S2 live check, 1 November 2026). Guidance only:
 * it never blocks preparation or decides scope.
 */
async function preparedScope(root, config, workflow, phase, prepared) {
  if (prepared.publicationProducer === 'deterministic') return null;
  const review = await (await import('../scope/authoring.mjs')).scopeAuthoringCheckpoint(root, config, workflow, phase);
  if (review?.status === 'unavailable') return { status: 'unavailable', reason: review.reason, inspect: review.inspect?.command ?? null };
  const items = (review?.items ?? []).filter((item) => item.repair?.scope === 'current-draft');
  if (!items.length) return null;
  return { status: review.status, unresolvedCount: review.unresolvedCount,
    items: items.map((item) => ({ id: item.id, sourceReference: item.repair.sourceReference, text: item.text })),
    more: review.more, inspect: review.inspect?.command ?? null };
}
