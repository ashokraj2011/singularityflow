/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot } from '../git.mjs';
import { optionString, SingularityFlowError, optionStrings, optionBoolean, unknownStepDetails } from '../util.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { selectedPhaseArgument } from './shared/selected-phase-argument.mjs';
import { currentPhase } from '../phase-generation.mjs';
import { prefetchStoryPublicationObservation, storyPublicationPending, assertNoPendingPublication, commitAndPublish, actorKey, submitConfirmedConvergencePhase, submitPhase, workflowPublicationBranch } from '../state-stores.mjs';
import { parseDecisionAssignments, decisionFedBy, normalizeDecisionInputValues, recordedDecisionValues, decisionInputsHint } from '../workflow-decisions.mjs';
import { isConvergencePhase } from '../phase-roles.mjs';
import { clarifiedValueQuestions } from '../phase-roles.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, noop, noEffects, succeeded, effects } from '../narration/command-result.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { withRefusalMemory } from './shared/with-refusal-memory.mjs';
import { actionActor } from './kernel.mjs';
import { automaticApprovalOn } from '../approval-authority.mjs';
import { phaseUsesDeterministicGeneration } from '../manual-authorship.mjs';
import { createStoryReviewPacket } from '../story-lineage.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { composeEvidenceReceipt, renderEvidenceReceipt } from '../evidence-receipt.mjs';
import { activateWorkItemSession } from '../session.mjs';
import { recordRequiredReceiptsAfterTransition } from './shared/record-required-receipts-after-transition.mjs';
import { phaseReview } from './shared/phase-review.mjs';
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
  if (!initialPhase) throw new SingularityFlowError(`Unknown or unavailable phase '${initialPhaseId ?? ''}'. Provide a phase ID.`, { code: 'PHASE_UNKNOWN', details: unknownStepDetails(workflow, requestedPhase) });
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
    // A value the step's own clarification asked is the person's answer there (a marketplace agent's hard gate) [ITW:REQ-011].
    if (fedDecision && !recordedDecisionValues(initialPhase, fedDecision) && clarifiedValueQuestions(workflow, initialPhase.id).size) {
      Object.assign(decisionValues, await (await import('../story-value-answers.mjs')).clarifiedDecisionValues(root, config, workflow, initialPhase, fedDecision, decisionValues));
    }
    if (fedDecision && Object.keys(decisionValues).length) normalizeDecisionInputValues(fedDecision, decisionValues);
    else if (fedDecision && !recordedDecisionValues(initialPhase, fedDecision)) {
      // One filled submission per value, never the Decide card, which holds no decision inputs [owner, 2026-11-28].
      const [{ decisionInputChoiceRoutes }, { actionCommandLine }] = await Promise.all([import('../story-value-answers.mjs'), import('../action-command-map.mjs')]);
      const routes = decisionInputChoiceRoutes(actionCommandLine, workflow, initialPhase, fedDecision, decisionValues);
      throw new SingularityFlowError(
        `Decision '${fedDecision.label}' after '${initialPhase.id}' reads values this submission must record. Submit with ${decisionInputsHint(fedDecision)}.`,
        { code: 'DECISION_INPUTS_MISSING', details: { workId: workflow.workItem.id, phase: initialPhase.id, decision: fedDecision.id, inputs: fedDecision.inputs,
          ...(routes.recoveryCommands.length ? { recoveryCommands: routes.recoveryCommands } : {}) } }
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
        `Convergence is submitted with singularity-flow story advance --work-id ${resolvedWorkId} --submit, which checks the report first; SFlow approves a clean one, else a person approves it.`,
        { code: 'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED', details: { workId: resolvedWorkId, nextAction: `singularity-flow story advance --work-id ${resolvedWorkId}` } }
      );
    }
    if (initialPhase.approvalPolicy?.mode !== 'required') {
      throw new SingularityFlowError(
        `Convergence phase '${initialPhase.id}' requires its approval after explicit advancement, by a person or by SFlow when its check is clean; approval modes 'none' and 'policy' are not permitted.`,
        { code: 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED' }
      );
    }
    const confirmed = await assertConvergencePublicationReady(root, config, workflow, initialPhase);
    if (convergenceConfirmation !== confirmed.snapshotSha256) {
      throw new SingularityFlowError(
        `The convergence result changed after preview. Nothing was submitted. Review it again: singularity-flow story advance --work-id ${resolvedWorkId}`,
        {
          code: 'CONVERGENCE_ADVANCE_CONFIRMATION_STALE',
          details: {
            workId: resolvedWorkId,
            supplied: convergenceConfirmation,
            expected: confirmed.snapshotSha256,
            nextAction: `singularity-flow story advance --work-id ${resolvedWorkId}`
          }
        }
      );
    }
  }
  // A failed required push is a transport recovery. Preserve the established sequence-gate refusal
  // (including its structured recovery command and exit code) before submission opens.
  await assertNoPendingPublication(root, config, workflow, 'submit');
  // Files changed after the published draft: refused before anything opens, with the person's set-aside route (N7).
  const changed = await import('../changes-after-publication.mjs');
  const target = workflow.phases[requestedPhase ?? workflow.currentPhase];
  const after = await changed.changesAfterPublication(root, config, workflow, target);
  if (after) throw changed.changesAfterPublicationError(workflow, target, after, await changed.setAsideFor(root, config, workflow));
  // Copilot usage is never read during the work; `singularity-flow telemetry reconcile` records it.
  const workflowBeforeSubmission = structuredClone(workflow);
  const phaseId = requestedPhase ?? workflow.currentPhase;
  const requested = workflow.phases[phaseId];
  if (!requested) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`, { code: 'PHASE_UNKNOWN', details: unknownStepDetails(workflow, requestedPhase) });
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
  const publication = await withRefusalMemory(root, {
    operation: 'submit', workId: workflow.workItem.id, phase: requested.id, actor: actorKey(actionActor(root)),
    args: [decisionValues ?? null, optionBoolean(options, 'skip-checks')]
  }, () => commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.APPROVAL_REQUESTED, phaseId: requested.id, generation: requested.generation },
    `[${workflow.workItem.id}][phase:${requested.id}][submit] ${requested.approvalPolicy?.mode === 'none' ? 'complete without approval' : 'request approval'}`,
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
  // `--json` asks for one result object and nothing else on stdout: what the lines below tell a person, its
  // data and outcome carry instead (`story advance --confirm --json` comes through here too).
  const json = optionBoolean(options, 'json');
  if (!reviewPacket) {
    console.warn('Warning: the submission commit succeeded, but its review packet was not returned to the caller. Do not submit again; reload the committed Story and inspect recovery.');
    if (!json) printCommandRoutes(`singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`, {
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
  // D1 (owner, 2026-11-20): a test step that changes no source code returns its failing tests to its code step on its own,
  // which starts its next version with them as its task; at the workflow's review brake its people decide, with filled
  // choices (failing-tests-opening.mjs). Its own commits, after the submission's.
  let automaticReturn = null;
  if (phase.status === 'awaiting_approval' && phase.validationVerdict === 'failed') {
    const submittedId = phase.id;
    automaticReturn = (await postPublicationStep('the automatic return of the failing tests', workflow.workItem.id,
      async () => (await import('../failing-tests-opening.mjs')).returnFailingTests(root, workflow.workItem.id, submittedId, { actor: actionActor(root) }))).value;
    if (automaticReturn?.returned) {
      workflow = (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow;
      phase = workflow.phases[submittedId];
    }
    if (!automaticReturn?.data) automaticReturn = null;
  }
  // A task's code that touched a team's path rule gains that rule's steps now, after the code step; a fix whose code changes
  // the data or a public interface becomes a change, and its code goes back to the plan added before it [ITW:REQ-014].
  let taskRuleSteps = null;
  if (automaticReturn?.returned !== true && workflow.resolution?.composition && phase.deliveryEvidence?.changeSetPath) {
    const submittedId = phase.id;
    taskRuleSteps = (await postPublicationStep('the steps the team\'s rules add for the files the code changed', workflow.workItem.id,
      async () => (await import('../task-amendment.mjs')).addRuleStepsAfterCode(root, workflow.workItem.id, submittedId))).value;
    if (taskRuleSteps?.added.length) {
      workflow = (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow;
      phase = workflow.phases[submittedId];
    }
  }
  // A sized task's requirement decides its shape: a big change gains its steps after it, and its question says so [ITW:REQ-103].
  let taskShape = null;
  if (automaticReturn?.returned !== true && workflow.resolution?.composition?.sizing === 'requirement' && phase.status === 'awaiting_approval'
      && workflow.resolution.composition.steps?.find((entry) => entry.id === phase.id)?.intent === 'intake') {
    const submittedId = phase.id;
    taskShape = (await postPublicationStep('the task\'s shape', workflow.workItem.id,
      async () => (await import('../task-shape.mjs')).decideShapeAfterRequirement(root, workflow.workItem.id, submittedId))).value;
    if (taskShape?.added.length) {
      workflow = (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow;
      phase = workflow.phases[submittedId];
    }
  }
  const grown = taskRuleSteps?.grown?.returned === true ? taskRuleSteps.grown : null;
  const returned = automaticReturn?.returned === true || Boolean(grown);
  // Approve twice (owner, 2026-11-19): a step SFlow approves when it is ready is approved now, in its own commit, when its
  // reviewer said ready, its checks passed and nothing is open for it; otherwise its people approve it and are told why.
  let automaticApproval = null;
  if (!returned && phase.status === 'awaiting_approval' && automaticApprovalOn(phase.approvalPolicy)) {
    const submittedId = phase.id;
    automaticApproval = (await postPublicationStep('the automatic approval', workflow.workItem.id, async () => {
      const current = await loadAcceptedStoryExecution(root, workflow.workItem.id);
      return (await import('../automatic-approval.mjs')).approveAutomaticallyAfterSubmission(root, current.config, current.workflow, submittedId, { actor: actionActor(root) });
    })).value;
    if (automaticApproval?.approved) {
      workflow = automaticApproval.workflow;
      phase = workflow.phases[submittedId];
    }
  }
  const approvalMode = phase.approvalPolicy?.mode ?? 'required';
  const completedWithoutReview = phase.status === 'approved' && approvalMode === 'none';
  const completedByPolicy = phase.status === 'approved' && approvalMode === 'policy';
  if (phase.status === 'approved' || returned) {
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
  // A completed step that brought the Story back to a test step whose failing tests SFlow returned: its tests run again (D1).
  const rerun = phase.status === 'approved' && (workflow.settledDecisions ?? []).some((entry) => entry?.kind === 'failing-tests') ? (await postPublicationStep('the test step\'s run again', workflow.workItem.id,
    async () => (await import('../failing-tests-opening.mjs')).rerunTestsAfterFix(root, workflow.workItem.id, { actor: actionActor(root) }))).value : null;
  if (rerun) workflow = (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow;
  // A plan SFlow approved for a fix that became a change: the code's next version starts after it [ITW:REQ-014].
  const grownCode = !rerun && phase.status === 'approved' && (workflow.resolution?.composition?.changes ?? []).some((entry) => entry?.change === 'grow')
    ? (await postPublicationStep('the code\'s next version after the plan', workflow.workItem.id,
      async () => (await import('../task-amendment.mjs')).codeVersionAfterGrownPlan(root, workflow.workItem.id, { actor: actionActor(root) }))).value : null;
  if (grownCode) workflow = (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow;
  // A step approved by its submission moves the register items it fixed on the way too [CQF:REQ-066].
  const fixedOnTheWay = phase.status === 'approved' && workflow.departures?.some((entry) => entry.phase === phase.id && entry.findings?.length)
    ? await (await import('../findings/register/on-the-way.mjs')).recordFindingsAfterApproval(root, config,
      (await loadAcceptedStoryExecution(root, workflow.workItem.id)).workflow, phase.id) : null;
  const pushedTo = publication.pushed ? `${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}` : null;
  if (!json) {
    if (completedWithoutReview) console.log(`\nCompleted ${phase.id} phase (configured approval mode: none).`);
    else if (automaticApproval?.approved) console.log(`\nApproved ${phase.label ?? phase.id} v${phase.generation} automatically: ${automaticApproval.checked.join('; ')}.`);
    else if (completedByPolicy) console.log(`\nCompleted ${phase.id} phase using its deterministic policy waiver.`);
    else if (returned) console.log(`\nSubmitted ${phase.id}.`);
    else console.log(`\nSubmitted ${phase.id} phase for approval.`);
    // The lessons the step left, as after a person's approval [LRN:REQ-003].
    if (automaticApproval?.approved) {
      const kept = await (await import('../story-lessons-notice.mjs')).lessonsAfterApproval(root, workflow.workItem.id, phase.id);
      if (kept) console.log(kept.line);
    }
    if (automaticApproval?.applies && !automaticApproval.approved) console.log((await import('../automatic-approval.mjs')).needsPersonWords(phase, automaticApproval));
    // The return, or at the brake why SFlow did not make it and the person's filled choices; the test step's run again.
    for (const line of [...(automaticReturn?.lines ?? []), ...(rerun?.line ? [rerun.line] : []), ...(taskRuleSteps?.lines ?? []), ...(taskShape?.lines ?? []),
      ...(grownCode?.line ? [grownCode.line] : [])]) console.log(line);
    for (const repair of registrationRepairs) {
      console.log(`Repaired stale artifact registration for ${repair.path} and continued; authored content still matches generation ${repair.generation}.`);
    }
    console.log(`Committed: ${automaticApproval?.approved ? 'request approval, then approved automatically' : returned ? 'request approval, then returned automatically' : phase.status === 'approved' ? 'complete phase' : 'request approval'} (${workflow.workItem.id})`);
    console.log(`Push: ${pushedTo ?? 'disabled by git.publish: off'}`);
    if (receiptsLine) console.log(receiptsLine);
    if (fixedOnTheWay?.moved.length) console.log(`Fixed on the way, awaiting proof in the findings register: ${fixedOnTheWay.moved.join(', ')}.`);
    // The packet's file is named by its digest: a person reads that it was kept, `--json` gives the digest.
    if (reviewPacket) console.log(`Review packet: kept with ${phase.id} generation ${phase.generation}`);
    if (evidenceReceipt) console.log(`\n${renderEvidenceReceipt(evidenceReceipt)}`);
    const submittedReview = await postPublicationStep(
      'the submitted phase review projection', workflow.workItem.id,
      () => phaseReview(root, config, workflow, phase)
    );
    // Only a person's terminal prints it, so it loads only there, as `phase show` loads it.
    if (submittedReview.ok) {
      (await import('./shared/print-phase-review.mjs')).printPhaseReview(submittedReview.value, { showArtifact: optionBoolean(options, 'show-artifact') });
    }
  }
  // The trailer is narrated. It used to name a Copilot skill and a CLI equivalent chosen by hand
  // here; NEXT now comes from the deterministic planner against the state the submission left.
  const advanced = currentPhase(workflow);
  // An approval-free last phase ends the Story here; its transaction passed the final evaluation.
  const completion = !advanced ? recordedCompletion(workflow) : null;
  if (completion && !json) printCompletionVerdict(completion);
  // SFlow never merges (owner, 2026-11-19): when the last steps were approved by themselves after a person's Yes to the
  // delivered code, finalizing and opening the pull request follow here (story-landing.mjs).
  const landing = completion ? (await postPublicationStep('finalizing and the pull request', workflow.workItem.id,
    async () => (await import('../story-landing.mjs')).landAfterLastApproval(root, workflow.workItem.id))).value : null;
  if (landing && !json) for (const line of landing.lines) console.log(line);
  emitCommandResult(commandResult({
    operation: { id: 'submit', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded(grown ? 'submit.grown' : returned ? 'submit.returned' : phase.status === 'approved' ? 'submit.completed' : 'submit.succeeded', {
      phase: phase.id, documents: phase.artifacts.length,
      ...(grown ? { plan: `a ${String(workflow.phases?.[grown.id]?.label ?? 'plan').toLowerCase()} step` }
        : returned ? { code: automaticReturn.code, version: automaticReturn.opened?.generation ?? null } : {}),
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
      generation: phase.generation,
      pushedTo,
      ...(automaticReturn ? { automaticReturn: automaticReturn.data } : {}),
      ...(rerun ? { testsRerun: rerun } : {}),
      ...(taskRuleSteps ? { taskSteps: taskRuleSteps } : {}),
      ...(taskShape ? { taskShape: { shape: taskShape.shape, reasons: taskShape.facts?.reasons ?? [], added: taskShape.added, lines: taskShape.lines } } : {}),
      ...(grownCode ? { grownCode } : {}),
      ...(automaticApproval?.applies ? { automaticApproval: { approved: automaticApproval.approved === true, checked: automaticApproval.checked ?? [],
        open: automaticApproval.open ?? [], ...(automaticApproval.approved ? { commit: automaticApproval.publication?.sha ?? null } : {}) } } : {}),
      ...(fixedOnTheWay?.moved.length ? { fixedOnTheWay: fixedOnTheWay.moved } : {}),
      ...(landing ? { landing: { finalized: landing.finalized, pullRequest: landing.pullRequest, next: landing.next } } : {}),
      ...(completion ? { finalCheck: { verified: completion.verified, errors: completion.errors } } : {})
    }
  }), {
    json, postState: workflow, restStateWhenIdle: advanced || completion ? null : 'complete',
    stepActionHold: phase.status === 'approved' ? await stepActionHoldAfterTransition(root, config, workflow) : null
  });
}

/** Generic phase submission can never opt into the convergence advancement context. */
export async function submitCommand(positionals, options) {
  const result = await runSubmitCommand(positionals, options);
  // In a test run: a release document SFlow wrote from its records still says what they say (story-invariants.mjs).
  if (globalThis.__SFLOW_CLI_BUNDLE__ !== true && globalThis.__SFLOW_EXTENSION_HOST__ !== true && process.env.SINGULARITY_FLOW_INVARIANTS) await submittedRecordDocuments(positionals, options);
  return result;
}

async function submittedRecordDocuments(positionals, options) {
  await (await import('../invariant-checks.mjs')).withStoryInvariants(async (checks) => {
    const { repoRoot } = await import('../git.mjs');
    const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
    const root = repoRoot();
    const { definition, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id') ?? undefined);
    const phase = workflow.phases?.[positionals[1] ?? ''] ?? null;
    if (phase) checks.reportViolations(await checks.recordDocumentViolations(root, definition, workflow, phase), { story: workflow.workItem?.id ?? null, phase: phase.id });
  });
}

/** Combined command used only after `story advance` has received its explicit confirmation. */
export async function submitConfirmedConvergenceCommand(positionals, options, confirmation) {
  return runSubmitCommand(positionals, options, { convergenceConfirmation: confirmation });
}
