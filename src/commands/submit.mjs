/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot } from '../git.mjs';
import { optionString, SingularityFlowError, optionStrings, optionBoolean } from '../util.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { selectedPhaseArgument } from './shared/selected-phase-argument.mjs';
import { currentPhase } from '../phase-generation.mjs';
import { prefetchStoryPublicationObservation, storyPublicationPending, assertNoPendingPublication, commitAndPublish, actorKey, submitConfirmedConvergencePhase, submitPhase, workflowPublicationBranch } from '../state-stores.mjs';
import { parseDecisionAssignments, decisionFedBy, normalizeDecisionInputValues, recordedDecisionValues, decisionInputsHint } from '../workflow-decisions.mjs';
import { isConvergencePhase } from '../phase-roles.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, noop, noEffects, succeeded, effects } from '../narration/command-result.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { withRefusalMemory } from './shared/with-refusal-memory.mjs';
import { actionActor } from './kernel.mjs';
import { phaseUsesDeterministicGeneration } from '../manual-authorship.mjs';
import { createStoryReviewPacket } from '../story-lineage.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { composeEvidenceReceipt, renderEvidenceReceipt } from '../evidence-receipt.mjs';
import { activateWorkItemSession } from '../session.mjs';
import { recordRequiredReceiptsAfterTransition } from './shared/record-required-receipts-after-transition.mjs';
import { phaseReview } from './shared/phase-review.mjs';
import { printPhaseReview } from './shared/print-phase-review.mjs';
import { recordedCompletion, printCompletionVerdict } from '../completion-verdict.mjs';
import { completionContinuation } from './shared/completion-continuation.mjs';
import { stepActionHoldAfterTransition } from './shared/step-action-hold-after-transition.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => submitCommand(positionals, options)));
}

export async function runSubmitCommand(positionals, options, submitContext) {
  const convergenceConfirmation = submitContext?.convergenceConfirmation ?? null;
  const root = repoRoot();
  const requestedWorkId = optionString(options, 'work-id');
  const accepted = await loadAcceptedStoryExecution(root, requestedWorkId);
  const config = accepted.definition;
  let workflow = accepted.workflow;
  // Resolve the target once, then pin every subsequent read to that exact Story: another
  // UI/session may change the globally active Story; submission must not cross that boundary.
  const resolvedWorkId = workflow.workItem.id;
  const requestedPhase = selectedPhaseArgument(positionals, options, 'submit');
  const initialPhaseId = requestedPhase ?? workflow.currentPhase;
  const initialPhase = workflow.phases[initialPhaseId];
  if (!initialPhase) throw new SingularityFlowError(`Unknown or unavailable phase '${initialPhaseId ?? ''}'. Provide a phase ID.`);
  prefetchStoryPublicationObservation(root, config, workflow);
  // Checked before the publication unit opens, so a mistyped value is
  // refused with nothing written. The transition records the same values again.
  const decisionValues = parseDecisionAssignments(optionStrings(options, 'decision'));
  const fedDecision = decisionFedBy(workflow, initialPhase.id);
  if (initialPhase.status !== 'awaiting_approval') {
    if (!fedDecision && Object.keys(decisionValues).length) {
      throw new SingularityFlowError(`Phase '${initialPhase.id}' feeds no decision that records values; submit it without --decision.`,
        { code: 'DECISION_INPUT_UNKNOWN' });
    }
    if (fedDecision && Object.keys(decisionValues).length) normalizeDecisionInputValues(fedDecision, decisionValues);
    else if (fedDecision && !recordedDecisionValues(initialPhase, fedDecision)) {
      throw new SingularityFlowError(
        `Decision '${fedDecision.label}' after '${initialPhase.id}' reads values this submission must record. Submit with ${decisionInputsHint(fedDecision)}.`,
        { code: 'DECISION_INPUTS_MISSING', details: { decision: fedDecision.id, inputs: fedDecision.inputs } }
      );
    }
  } else if (Object.keys(decisionValues).length) {
    console.warn(`Phase '${initialPhase.id}' is already submitted; the decision values recorded then stand. Request changes to record different ones.`);
  }
  // Submission is an idempotent boundary. A retry can come from Copilot replaying an action after
  // the first command succeeded, or from a person not seeing the prior terminal result. Letting the
  // ordinary soft phase-status gate handle it opens the publication journal and subject lock before
  // asking "continue?"; while that prompt waits, every other surface mistakes the live command for
  // an interrupted commit. The committed aggregate already proves the exact phase and generation
  // awaiting review, so no transaction or override is appropriate.
  if (initialPhase.status === 'awaiting_approval') {
    if (isConvergencePhase(initialPhase)) {
      await assertConvergencePublicationReady(root, config, workflow, initialPhase);
    }
    if (await storyPublicationPending(root, config, workflow.workItem.id)) {
      await assertNoPendingPublication(root, config, workflow, 'submit for approval');
    }
    emitCommandResult(commandResult({
      operation: { id: 'submit', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: noop('submit.noop', { phase: initialPhase.id }),
      effects: noEffects(),
      data: {
        phase: initialPhase.id,
        generation: initialPhase.generation,
        submittedAt: initialPhase.submittedAt ?? null
      }
    }), { json: optionBoolean(options, 'json'), postState: workflow });
    return;
  }
  // Refuse a generic `submit convergence` before any write. The
  // only combined confirmation route is `story advance --confirm`; command-line options cannot
  // set this private function argument.
  if (isConvergencePhase(initialPhase)) {
    if (typeof convergenceConfirmation !== 'string'
        || !/^sha256:[0-9a-f]{64}$/.test(convergenceConfirmation)) {
      throw new SingularityFlowError(
        `Convergence can be submitted only through explicit human advancement. Run singularity-flow story advance --work-id ${resolvedWorkId} to review the deterministic result and receive its digest-bound confirmation command.`,
        { code: 'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED', details: { workId: resolvedWorkId } }
      );
    }
    if (initialPhase.approvalPolicy?.mode !== 'required') {
      throw new SingularityFlowError(
        `Convergence phase '${initialPhase.id}' requires a non-waivable human approval after explicit advancement; approval modes 'none' and 'policy' are not permitted.`,
        { code: 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED' }
      );
    }
    const confirmed = await assertConvergencePublicationReady(root, config, workflow, initialPhase);
    if (convergenceConfirmation !== confirmed.snapshotSha256) {
      throw new SingularityFlowError(
        `The convergence result changed after preview. Review the current result and confirm ${confirmed.snapshotSha256}.`,
        {
          code: 'CONVERGENCE_ADVANCE_CONFIRMATION_STALE',
          details: {
            workId: resolvedWorkId,
            supplied: convergenceConfirmation,
            expected: confirmed.snapshotSha256
          }
        }
      );
    }
  }
  // A failed required push is a transport recovery. Preserve the established sequence-gate refusal
  // (including its structured recovery command and exit code) before submission opens.
  await assertNoPendingPublication(root, config, workflow, 'submit');
  // Copilot usage is never read during the work; `singularity-flow telemetry reconcile` records it.
  const workflowBeforeSubmission = structuredClone(workflow);
  const phaseId = requestedPhase ?? workflow.currentPhase;
  const requested = workflow.phases[phaseId];
  if (!requested) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  const registrationRepairCount = requested.artifactRegistrationRepairs?.length ?? 0;
  let phase = requested;
  let reviewPacket = null;
  const expectedConvergenceSnapshotSha256 = isConvergencePhase(requested)
    ? (await assertConvergencePublicationReady(root, config, workflow, requested)).snapshotSha256
    : null;
  const submissionStabilityGuard = async () => {
        let convergenceIdentity = 'not-convergence';
        if (expectedConvergenceSnapshotSha256) {
        const current = await assertConvergencePublicationReady(root, config, workflow, requested);
        if (current.snapshotSha256 !== expectedConvergenceSnapshotSha256) {
          throw new SingularityFlowError(
            `The reviewed convergence projection or one of its exact inputs changed while submission was running. Nothing was committed; run singularity-flow prepare ${requested.id} again.`,
            {
              code: 'PUBLICATION_SNAPSHOT_CHANGED',
              details: {
                expectedConvergenceSnapshotSha256,
                currentConvergenceSnapshotSha256: current.snapshotSha256
              }
            }
          );
        }
        convergenceIdentity = current.snapshotSha256;
        }
        return convergenceIdentity;
      };
  const publication = await withRefusalMemory(root, {
    operation: 'submit', workId: workflow.workItem.id, phase: requested.id, actor: actorKey(actionActor(root)),
    args: [decisionValues ?? null, optionBoolean(options, 'skip-checks')]
  }, () => commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.APPROVAL_REQUESTED, phaseId: requested.id, generation: requested.generation },
    `[${workflow.workItem.id}][phase:${requested.id}][submit] request approval`,
    requested.artifacts.map((item) => item.path),
    {
      rollbackWorkflow: workflowBeforeSubmission,
      beforeStateWrite: async () => {
        const submit = isConvergencePhase(requested)
          ? submitConfirmedConvergencePhase
          : submitPhase;
        const deterministicSubmission = phaseUsesDeterministicGeneration(requested);
        phase = await submit(root, config, workflow, {
          phaseId: requested.id,
          runChecks: !optionBoolean(options, 'skip-checks'),
          persist: false,
          decisionValues,
          ...(deterministicSubmission ? { actor: actionActor(root), agent: null } : {}),
          ...(isConvergencePhase(requested)
            ? { confirmation: convergenceConfirmation }
            : {})
        });
        reviewPacket = await createStoryReviewPacket(root, config, workflow, phase);
      },
      worktreeGuard: submissionStabilityGuard
    }
  ));
  if (!reviewPacket) {
    console.warn('Warning: the governed submission commit succeeded, but its review packet was not returned to the caller. Do not submit again; reload the committed Story and inspect recovery.');
    printCommandRoutes(`singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`, {
      label: 'Inspect committed submission evidence'
    });
  }
  const registrationRepairs = (phase.artifactRegistrationRepairs ?? []).slice(registrationRepairCount);
  const evidenceReceiptResult = reviewPacket
    ? await postPublicationStep(
        'the evidence-receipt projection', workflow.workItem.id,
        () => composeEvidenceReceipt(root, config, workflow, reviewPacket.packet)
      )
    : { ok: false, value: null };
  const evidenceReceipt = evidenceReceiptResult.value;
  const approvalMode = phase.approvalPolicy?.mode ?? 'required';
  const completedWithoutReview = phase.status === 'approved' && approvalMode === 'none';
  const completedByPolicy = phase.status === 'approved' && approvalMode === 'policy';
  if (phase.status === 'approved') {
    // No-approval and policy-waived submission advance inside the submit transaction, without a
    // later approve command to perform the handoff. Bind the exact committed next phase now; a
    // stale prior-phase session must never be reported ready merely because the next phase happens
    // to use the same agent ID.
    await postPublicationStep('the next-phase session activation', workflow.workItem.id, async () => {
      const afterSubmission = await loadAcceptedStoryExecution(root, workflow.workItem.id);
      return activateWorkItemSession(root, afterSubmission.config, afterSubmission.workflow);
    });
  }
  const receiptsLine = phase.status === 'approved' ? await recordRequiredReceiptsAfterTransition(root, workflow) : null;
  if (completedWithoutReview) console.log(`\nCompleted ${phase.id} phase (configured approval mode: none).`);
  else if (completedByPolicy) console.log(`\nCompleted ${phase.id} phase using its deterministic policy waiver.`);
  else console.log(`\nSubmitted ${phase.id} phase for approval.`);
  for (const repair of registrationRepairs) {
    console.log(`Repaired stale artifact registration for ${repair.path} and continued; authored content still matches generation ${repair.generation}.`);
  }
  console.log(`Commit: ${publication.sha.slice(0, 8)} — ${phase.status === 'approved' ? 'complete phase' : 'request approval'} (${workflow.workItem.id})`);
  console.log(`Push: ${publication.pushed ? `${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}` : 'disabled by git.publish: off'}`);
  if (receiptsLine) console.log(receiptsLine);
  if (reviewPacket) {
    console.log(`Review packet: ${reviewPacket.path} (${reviewPacket.packet.packetSha256.slice(0, 12)})`);
  }
  if (evidenceReceipt) console.log(`\n${renderEvidenceReceipt(evidenceReceipt)}`);
  const submittedReview = await postPublicationStep(
    'the submitted phase review projection', workflow.workItem.id,
    () => phaseReview(root, config, workflow, phase)
  );
  if (submittedReview.ok) {
    printPhaseReview(submittedReview.value, { showArtifact: optionBoolean(options, 'show-artifact') });
  }
  // The trailer is narrated. It used to name a Copilot skill and a CLI equivalent chosen by hand
  // here; NEXT now comes from the deterministic planner against the state the submission left.
  const advanced = currentPhase(workflow);
  // An approval-free last phase ends the Story here; its transaction passed the final evaluation.
  const completion = !advanced ? recordedCompletion(workflow) : null;
  if (completion) printCompletionVerdict(completion);
  emitCommandResult(commandResult({
    operation: { id: 'submit', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded(phase.status === 'approved' ? 'submit.completed' : 'submit.succeeded', {
      phase: phase.id, documents: phase.artifacts.length,
      ...(completion ? { finalCheck: completion.verified ? 'passed' : 'failed', completionLabel: completion.label ?? null } : {})
    }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    ...completionContinuation(completion),
    data: {
      commit: publication.sha,
      pushed: publication.pushed,
      reviewPacket: reviewPacket?.packet?.packetSha256 ?? null,
      evidenceReceipt,
      registrationRepairs,
      ...(completion ? { finalCheck: { verified: completion.verified, errors: completion.errors } } : {})
    }
  }), {
    postState: workflow, restStateWhenIdle: advanced || completion ? null : 'complete',
    stepActionHold: phase.status === 'approved' ? await stepActionHoldAfterTransition(root, config, workflow) : null
  });
}

/** Generic phase submission can never opt into the convergence advancement context. */
export async function submitCommand(positionals, options) {
  return runSubmitCommand(positionals, options);
}

/** Combined command used only after `story advance` has received its explicit confirmation. */
export async function submitConfirmedConvergenceCommand(positionals, options, confirmation) {
  return runSubmitCommand(positionals, options, { convergenceConfirmation: confirmation });
}
