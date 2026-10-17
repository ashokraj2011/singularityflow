/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { optionBoolean, SingularityFlowError, optionString, optionStrings } from '../util.mjs';
import { decisionWorkflow } from './shared/decision-workflow.mjs';
import { printPhaseReview } from './shared/print-phase-review.mjs';
import { phaseReview } from './shared/phase-review.mjs';
import { requireApprovalAuthority, remainingRequiredAuthorities } from '../approval-authority.mjs';
import { confirm, activeActionContext } from './kernel.mjs';
import { checklistDecisions } from './shared/checklist-decisions.mjs';
import { isConvergencePhase } from '../phase-roles.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { withRefusalMemory } from './shared/with-refusal-memory.mjs';
import { actorKey, transactStory, approvePhase, workflowPublicationBranch } from '../state-stores.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { consumeSelectionReceipt } from '../choices.mjs';
import { postPublicationStep } from './shared/post-publication-step.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { activateWorkItemSession } from '../session.mjs';
import { recordRequiredReceiptsAfterTransition } from './shared/record-required-receipts-after-transition.mjs';
import { formatContextBoundaryHandoff } from '../context-policy.mjs';
import { recordedCompletion, printCompletionVerdict } from '../completion-verdict.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, succeeded, effects } from '../narration/command-result.mjs';
import { completionContinuation } from './shared/completion-continuation.mjs';
import { stepActionHoldAfterTransition } from './shared/step-action-hold-after-transition.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => approveCommand(positionals, options)));
}

/**
 * Per-binding decisions from `--binding <clause>=accept|exception`; each exception takes the next
 * `--binding-reason`. Approving with none accepts every submitted binding as a batch [E2G-011].
 */
export function implementationBindingDecisions(options) {
  const reasons = optionStrings(options, 'binding-reason');
  let next = 0;
  return optionStrings(options, 'binding').map((entry) => {
    const separator = String(entry).lastIndexOf('=');
    if (separator < 1) throw new SingularityFlowError(`--binding must be <clause>=accept|exception; got '${entry}'.`, { code: 'IMPLEMENTATION_BINDING_DECISION_INVALID' });
    const decision = String(entry).slice(separator + 1).trim();
    return { clauseId: String(entry).slice(0, separator).trim(), decision, ...(decision === 'exception' ? { reason: reasons[next++] ?? null } : {}) };
  });
}

export function witnessMappingDecisions(options) {
  const mappings = optionStrings(options, 'witness-mapping');
  const reasons = optionStrings(options, 'witness-mapping-reason');
  const expiries = optionStrings(options, 'witness-mapping-expires');
  let reasonIndex = 0;
  let expiryIndex = 0;
  const decisions = mappings.map((entry) => {
    const separator = String(entry).indexOf('=');
    const mappingSha256 = separator === -1 ? '' : String(entry).slice(0, separator).trim();
    // An exception names the adequacy facets the test falls short on: exception:assertions,boundaries.
    const [decision, facets = ''] = (separator === -1 ? '' : String(entry).slice(separator + 1).trim()).split(':');
    const inadequate = facets.split(',').map((facet) => facet.trim()).filter(Boolean);
    if (!/^sha256:[a-f0-9]{64}$/.test(mappingSha256)
        || !['satisfied', 'exception', 'not-applicable'].includes(decision)
        || (decision === 'exception') !== (inadequate.length > 0)) {
      throw new SingularityFlowError(
        `--witness-mapping must be <sha256>=satisfied, <sha256>=exception:<facet>[,<facet>] (facets: setup, action, assertions, boundaries, implementation) or <sha256>=not-applicable; got '${entry}'.`
      );
    }
    const needsReason = decision !== 'satisfied';
    const needsExpiry = decision === 'exception';
    return {
      mappingSha256,
      decision,
      ...(inadequate.length ? { inadequate } : {}),
      ...(needsReason ? { reason: reasons[reasonIndex++] ?? null } : {}),
      ...(needsExpiry ? { expiresAt: expiries[expiryIndex++] ?? null } : {})
    };
  });
  if (reasonIndex !== reasons.length) {
    throw new SingularityFlowError('--witness-mapping-reason applies only to exception or not-applicable witness decisions.');
  }
  if (expiryIndex !== expiries.length) {
    throw new SingularityFlowError('--witness-mapping-expires applies only to exception witness decisions.');
  }
  return decisions;
}

export async function approveCommand(positionals, options) {
  const forAgent = optionBoolean(options, 'for-agent');
  if (forAgent && !optionBoolean(options, 'json')) throw new SingularityFlowError('--for-agent approval requires --json; it changes presentation only.');
  if (optionString(options, 'selection-receipt') && optionBoolean(options, 'yes')) {
    throw new SingularityFlowError('Do not combine --selection-receipt with --yes; the receipt already carries the reviewer\'s exact phase confirmation.');
  }
  const { root, config, workflow, phase, session, receipt, receiptToken } = await decisionWorkflow(positionals, options, 'approve');
  const selfApproval = (phase.generatedBy?.login ?? phase.generatedBy?.email ?? phase.generatedBy?.name) === (session.actor.login ?? session.actor.email ?? session.actor.name);
  if (!forAgent) printPhaseReview(await phaseReview(root, config, workflow, phase), { showArtifact: optionBoolean(options, 'show-artifact') });
  const approvalAuthority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,
    session.actor,
    { preferredAuthorities: remainingRequiredAuthorities(phase.approvalPolicy, phase.approvals) }
  );
  if (!forAgent) {
  console.log(`\nReviewing ${workflow.workItem.id} / ${phase.id}`);
  console.log(`Reviewer: ${session.actor.name ?? session.actor.email ?? session.actor.login} · authority: ${approvalAuthority.authorityLabel} (${approvalAuthority.authorityGroup})`);
  console.log(`Agent: ${session.agent} (prompt/audit context only)`);
  console.log(`Artifacts: ${phase.artifacts.map((item) => `${item.path} (${item.sha256?.slice(0, 18) ?? 'no hash'})`).join(', ')}`);
  console.log(`Checks: ${phase.checks.map((item) => `${item.command}=${item.status}`).join(', ') || 'none'}`);
  console.log(`Tokens: ${phase.usage.map((item) => item.totalTokens ?? item.status).join(', ') || 'unavailable'}`);
  console.log(`Prior approvals: ${phase.approvals.filter((item) => !item.invalidatedAt).map((item) => `${item.actor?.name ?? item.actor?.email ?? 'unknown'} via ${item.authorityGroup ?? 'unrecorded authority'}; agent ${item.agent ?? 'unavailable'} (${item.decision})`).join(', ') || 'none'}`);
  if (selfApproval) console.warn('Warning: this identity generated the phase; approval will be recorded as self-approval.');
  }
  if (!receipt && !optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const checklist = await checklistDecisions(options);
  const witnessMappings = witnessMappingDecisions(options);
  const bindingDecisions = implementationBindingDecisions(options);
  // The transition mutates the aggregate in place, so the convergence guard uses an immutable
  // pre-decision projection while rereading external files/refs at the isolated-commit boundary.
  const approvalStabilityWorkflow = structuredClone(workflow);
  const approvalStabilityPhase = approvalStabilityWorkflow.phases[phase.id];
  const expectedConvergenceApprovalSnapshot = isConvergencePhase(phase)
    ? (await assertConvergencePublicationReady(
        root, config, approvalStabilityWorkflow, approvalStabilityPhase
      )).snapshotSha256
    : null;
  const approvalStabilityGuard = async () => {
    let convergenceIdentity = 'not-convergence';
    if (expectedConvergenceApprovalSnapshot) {
      const current = await assertConvergencePublicationReady(
        root, config, approvalStabilityWorkflow, approvalStabilityPhase
      );
      if (current.snapshotSha256 !== expectedConvergenceApprovalSnapshot) {
        throw new SingularityFlowError(
          'Convergence evidence changed while approval was being recorded. Nothing was committed; review and submit the current projection again.',
          { code: 'PUBLICATION_SNAPSHOT_CHANGED' }
        );
      }
      convergenceIdentity = current.snapshotSha256;
    }
    return convergenceIdentity;
  };
  const { value: result, publication } = await withRefusalMemory(root, {
    operation: 'approve', workId: workflow.workItem.id, phase: phase.id, actor: actorKey(session.actor),
    args: [checklist ?? null, witnessMappings ?? null, bindingDecisions]
  }, () => transactStory(
    root,
    config,
    workflow,
    {
      type: LIFECYCLE_EVENT.PHASE_APPROVED,
      phaseId: phase.id,
      generation: phase.generation,
      actor: session.actor,
      agent: session.agent,
      authorityGroup: approvalAuthority.authorityGroup
    },
    `[${workflow.workItem.id}][phase:${phase.id}][approve] ${approvalAuthority.authorityGroup}`,
    (aggregate) => approvePhase(root, config, aggregate, {
      phaseId: phase.id,
      channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : receipt ? 'copilot-selection-receipt' : 'terminal',
      actionContext: activeActionContext() ?? receipt?.approvalContext ?? null,
      checklist,
      witnessMappings,
      bindingDecisions,
      actor: session.actor,
      agent: session.agent,
      persist: false
    }),
    {
      paths: phase.artifacts.map((item) => item.path),
      eventFromResult: (transition) => ({
        actor: transition.approval.actor,
        agent: transition.approval.agent,
        authorityGroup: transition.approval.authorityGroup,
        identityAssurance: transition.approval.identityAssurance,
        payload: {
          decision: transition.approval.decision,
          reviewPacketSha256: transition.approval.reviewPacketSha256,
          evidenceCommit: transition.approval.evidenceCommit,
          artifactSetSha256: transition.approval.artifactSetSha256,
          witnessMappingsSha256: transition.approval.witnessMappingsSha256 ?? null
        }
      }),
      worktreeGuard: approvalStabilityGuard
    }
  ));
  // Spent once the approval has actually landed. Consuming it up front — before the confirmation
  // prompt, let alone the publication — meant declining at the prompt or hitting any refusal burned
  // the reviewer's one-shot receipt, and a new one had to be issued before they could try again.
  if (receiptToken) {
    try { await consumeSelectionReceipt(root, receiptToken); }
    catch (error) {
      // The governed decision is already committed and may already be on the remote. Treat receipt
      // cleanup as a local recovery warning so retry cannot strand the reviewer behind an
      // "already approved" refusal after a successful gate transition.
      console.warn(`Warning: approval succeeded, but selection receipt cleanup is pending: ${error.message}`);
    }
  }
  // Approval may cross a phase boundary. Rebind from the committed aggregate rather than the
  // caller's pre-transaction object so a same-agent transition (for example verification →
  // release) still changes the phase binding, and deterministic convergence clears agent
  // authority instead of inheriting the previous phase's session.
  await postPublicationStep('the next-phase session activation', workflow.workItem.id, async () => {
    const accepted = await loadAcceptedStoryExecution(root, workflow.workItem.id);
    return activateWorkItemSession(root, accepted.config, accepted.workflow);
  });
  if (!forAgent) console.log(publication.pushed
    ? `Approval decision committed ${publication.sha.slice(0, 8)} and pushed to ${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}.`
    : `Approval decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  if (!forAgent) console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy} through ${result.approval.authorityGroup}; agent ${result.approval.agent}.`);
  if (result.approval.selfApproval) console.warn(`Warning: ${result.phase.id} was self-approved; this is not independent review.`);
  const receiptsLine = await recordRequiredReceiptsAfterTransition(root, workflow);
  if (receiptsLine && !forAgent) console.log(receiptsLine);
  if (!forAgent) formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
  // The last approval ends the Story only after its transaction passed the final evaluation.
  const completion = result.next ? null : recordedCompletion(workflow);
  if (completion && !forAgent) printCompletionVerdict(completion);
  emitCommandResult(commandResult({
    operation: { id: 'approve', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('approve.succeeded', {
      phase: result.phase.id, next: result.next?.id ?? null, reached: result.reached !== false,
      ...(completion ? { finalCheck: completion.verified ? 'passed' : 'failed', completionLabel: completion.label ?? null } : {})
    }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    ...completionContinuation(completion),
    data: {
      commit: publication.sha, pushed: publication.pushed, authorityGroup: result.approval.authorityGroup,
      turnBoundary: 'end', selfApproval: result.approval.selfApproval === true,
      contextBoundary: result.contextBoundary,
      reviewer: result.approval.approvedBy, reviewPacketSha256: result.approval.reviewPacketSha256,
      artifactSetSha256: result.approval.artifactSetSha256,
      ...(completion ? { finalCheck: { verified: completion.verified, errors: completion.errors } } : {})
    }
  }), { postState: workflow, json: optionBoolean(options, 'json'), forAgent,
    stepActionHold: await stepActionHoldAfterTransition(root, config, workflow) });
}
