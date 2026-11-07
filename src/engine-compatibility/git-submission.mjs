/** Native submission composition. Existing Git, lifecycle, checks and recovery remain their owners. */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { isConvergencePhase, phaseUsesDeterministicGeneration } from '../kernel/phase-policy.mjs';
import { prefetchStoryPublicationObservation, storyPublicationPending, assertNoPendingPublication,
  commitAndPublish, actorKey, submitConfirmedConvergencePhase, submitPhase } from '../state-stores.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { withRefusalMemory } from '../evidence/refusal-memory.mjs';
import { actionActor } from '../git.mjs';
import { createStoryReviewPacket } from '../story-lineage.mjs';
import { composeEvidenceReceipt } from '../evidence-receipt.mjs';
import { activateWorkItemSession } from '../session.mjs';
// Native post-commit effects return facts; the host observes and renders any recovery notice.
import { postPublicationStep, collectRequiredReceiptsAfterTransition } from './post-transition.mjs';

function submissionFacts(context, publication = null) {
  const {workflow,phase,reviewPacket} = context;
  return {workId:workflow.workItem.id,phase:phase.id,generation:phase.generation,
    revision:publication?.sha ?? phase.submissionCommit ?? null,pushed:publication?.pushed === true,
    phaseStatus:phase.status,submittedAt:phase.submittedAt ?? null,
    approvalMode:phase.approvalPolicy?.mode ?? 'required',currentPhase:workflow.currentPhase ?? null,
    reviewPacket:reviewPacket?.packet?.packetSha256 ?? null};
}

export function createGitSubmissionPort({ root, notice = () => {}, onContext = () => {} }) {
  return {
    notice,
    async load(input) {
      const accepted = await loadAcceptedStoryExecution(root, input.workId ?? null);
      const config = accepted.definition, workflow = accepted.workflow;
      const phaseId = input.phaseId ?? workflow.currentPhase;
      const phase = workflow.phases[phaseId];
      if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
      const context = {root,accepted,config,workflow,phase,phaseId,subject:Object.freeze({kind:'story',id:workflow.workItem.id})};
      prefetchStoryPublicationObservation(root, config, workflow);
      onContext(context);
      return context;
    },
    async retained(context) {
      const {root,config,workflow,phase} = context;
      if (phase.status !== 'awaiting_approval') return null;
      if (isConvergencePhase(phase)) await assertConvergencePublicationReady(root, config, workflow, phase);
      if (await storyPublicationPending(root, config, workflow.workItem.id)) {
        await assertNoPendingPublication(root, config, workflow, 'submit for approval');
      }
      return submissionFacts(context);
    },
    async prepare(context, input) {
      const {root,config,workflow,phase:initialPhase} = context;
      const convergenceConfirmation = input.confirmation ?? null;
      const resolvedWorkId = workflow.workItem.id;
      const requestedPhase = initialPhase.id;
      const decisionValues = input.decisionValues ?? {};
      if (isConvergencePhase(initialPhase)) {
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
                  details: { nextAction: { executable: 'singularity-flow', argv: ['prepare', requested.id], label: 'Inspect or continue the retained operation; recheck before retrying.' },
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

      return {workflowBeforeSubmission,requested,registrationRepairCount,submissionStabilityGuard,
        convergenceConfirmation,decisionValues,input};
    },
    async commit(context, prepared) {
      const {root,config,workflow} = context;
      const {workflowBeforeSubmission,requested,submissionStabilityGuard,convergenceConfirmation,decisionValues,input} = prepared;
      let phase = requested;
      let reviewPacket = null;
      const publication = await withRefusalMemory(root, {
        operation: 'submit', workId: workflow.workItem.id, phase: requested.id, actor: actorKey(actionActor(root)),
        args: [decisionValues ?? null, input.runChecks === false]
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
              runChecks: input.runChecks !== false,
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

      Object.assign(context,{phase,reviewPacket,publication});
      return publication;
    },
    async finish(context, prepared, publication) {
      const {root,config,workflow,phase,reviewPacket} = context;
      const {registrationRepairCount} = prepared;
      if (!reviewPacket) notice({code:'submission.review-packet-missing',workId:workflow.workItem.id,phase:phase.id});
      const registrationRepairs = (phase.artifactRegistrationRepairs ?? []).slice(registrationRepairCount);
      const evidenceReceiptResult = reviewPacket
        ? await postPublicationStep(
            'the evidence-receipt projection', workflow.workItem.id,
            () => composeEvidenceReceipt(root, config, workflow, reviewPacket.packet), {notice}
          )
        : { ok: false, value: null };
      const evidenceReceipt = evidenceReceiptResult.value;
      if (phase.status === 'approved') {
        // No-approval and policy-waived submission advance inside the submit transaction, without a
        // later approve command to perform the handoff. Bind the exact committed next phase now; a
        // stale prior-phase session must never be reported ready merely because the next phase happens
        // to use the same agent ID.
        await postPublicationStep('the next-phase session activation', workflow.workItem.id, async () => {
          const afterSubmission = await loadAcceptedStoryExecution(root, workflow.workItem.id);
          return activateWorkItemSession(root, afterSubmission.config, afterSubmission.workflow);
        }, {notice});
      }
      const receiptsReport = phase.status === 'approved' ? await collectRequiredReceiptsAfterTransition(root, workflow, {notice}) : null;

      Object.assign(context,{registrationRepairs,evidenceReceipt,receiptsReport});
      return submissionFacts(context,publication);
    }
  };
}
