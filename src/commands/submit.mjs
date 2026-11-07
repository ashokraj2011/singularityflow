/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { repoRoot } from '../git.mjs';
import { optionString, optionStrings, optionBoolean } from '../util.mjs';

import { selectedPhaseArgument } from './shared/selected-phase-argument.mjs';
import { currentPhase } from '../kernel/phase-policy.mjs';
import { workflowPublicationBranch } from '../state-stores.mjs';
import { parseDecisionAssignments } from '../workflow-decisions.mjs';

import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, noop, noEffects, succeeded, effects } from '../narration/command-result.mjs';

import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { renderEvidenceReceipt } from '../evidence-receipt.mjs';

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
  const root = repoRoot();
  const input = {workId:optionString(options,'work-id') ?? null,phaseId:selectedPhaseArgument(positionals,options,'submit') ?? null,
    runChecks:!optionBoolean(options,'skip-checks'),decisionValues:parseDecisionAssignments(optionStrings(options,'decision'))};
  const confirmation = submitContext?.convergenceConfirmation ?? null;
  const { createGitEngine } = await import('../engine-compatibility/git-publication.mjs');
  const binding = createGitEngine({root,notice(event) {
    if (event.code === 'submission.decision-values-ignored') console.warn(`Phase '${event.phase}' is already submitted; the decision values recorded then stand. Request changes to record different ones.`);
    if (event.code === 'submission.review-packet-missing') {
      console.warn('Warning: the submission commit succeeded, but its review packet was not returned to the caller. Do not submit again; reload the committed Story and inspect recovery.');
      printCommandRoutes(`singularity-flow recover ${event.workId} --phase ${event.phase} --json`, {label:'Inspect committed submission evidence'});
    }
  }});
  const receipt = confirmation === null
    ? await binding.engine.run('phase.submit',input)
    : await binding.engine.run('convergence.submit',{...input,confirmation});
  const context = binding.presentation();
  const {config,workflow,phase,publication,reviewPacket,registrationRepairs,evidenceReceipt,receiptsLine} = context;
  if (receipt.status === 'retained') {
    emitCommandResult(phaseSubmissionCommandResult(receipt, context), {json:optionBoolean(options,'json'),postState:workflow});
    return;
  }
  const approvalMode = phase.approvalPolicy?.mode ?? 'required';
  const completedWithoutReview = phase.status === 'approved' && approvalMode === 'none';
  const completedByPolicy = phase.status === 'approved' && approvalMode === 'policy';
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
  emitCommandResult(phaseSubmissionCommandResult(receipt, context, {completion}), {
    postState: workflow, restStateWhenIdle: advanced || completion ? null : 'complete',
    stepActionHold: phase.status === 'approved' ? await stepActionHoldAfterTransition(root, config, workflow) : null
  });
}

/** Legacy CLI wire contract projected from the SDK outcome and native presentation facts. */
export function phaseSubmissionCommandResult(receipt, context, {completion = null} = {}) {
  const {workflow,phase,publication,reviewPacket,evidenceReceipt,registrationRepairs} = context;
  if (receipt.status === 'retained') {
    const initialPhase = phase;
    return commandResult({
      operation: { id: 'submit', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: noop('submit.noop', { phase: initialPhase.id }),
      effects: noEffects(),
      data: {
        phase: initialPhase.id,
        generation: initialPhase.generation,
        submittedAt: initialPhase.submittedAt ?? null
      }
    });
  }
  return commandResult({
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
