/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { requirePositional, SingularityFlowError, optionString, optionBoolean } from '../util.mjs';
import { repoRoot, branch, gitDir, identity } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { sourceReviewKind } from '../phase-roles.mjs';
import { workflowBranchAllowed, assertNoPendingPublication, transactStory, loadStoryAggregate } from '../state-stores.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, effects, noEffects, action as narrationAction, noop, succeeded } from '../narration/command-result.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import path from 'node:path';
import { sourceReviewContext, readSourceReviewStatus, sourceReviewInput, checkSourceReviewReport, scopedSourceReviewerSession, evaluateSubmittedSourceReview, retainSourceReview, retainSourceReviewDecision } from '../source-review-lifecycle.mjs';
import { sourceReviewContextText } from '../source-review-context-display.mjs';
import { commandRouteLines } from '../safe-command-guidance.mjs';
import { lstat, readFile } from 'node:fs/promises';
import { loadSession } from '../session.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => reviewSourceCommand(positionals, options)));
}

export async function reviewSourceCommand(positionals, options) {
  if (options['for-agent'] !== undefined) {
    const { validateAgentEntryRequest } = await import('../agent-entry-options.mjs');
    validateAgentEntryRequest('review-source', { positionals, options });
    const { sourceReviewAgentContext } = await import('../source-review-agent-context.mjs');
    return console.log(JSON.stringify(await sourceReviewAgentContext({ phaseId: positionals[2] ?? null }), null, 2));
  }
  const action = requirePositional(positionals, 1, 'source review action');
  if (!['context', 'decision-context', 'stage', 'check', 'submit', 'decide', 'status'].includes(action)) {
    throw new SingularityFlowError("Source review action must be context, decision-context, stage, check, submit, decide, or status.");
  }
  const phaseId = requirePositional(positionals, 2, 'step that defines the scope or plans the claims');
  const root = repoRoot();
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  // Reviewable by what the step does, not what it is called [E2G-001]. Asking whether a review is
  // needed is answered for every step, so a caller never stops on a step that needs none.
  if (['status', 'context', 'decision-context', 'check'].includes(action) && !sourceReviewKind(workflow, phaseId) && workflow.phases?.[phaseId]) {
    const result = { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, phase: phaseId,
      mode: 'not-applicable', status: 'not-required', findings: [], pendingDispositions: [],
      reason: `'${phaseId}' neither defines the scope nor plans the claims, so it has no source review.` };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`Source review: not required for ${workflow.workItem.id} ${phaseId}; ${result.reason}`);
  }
  if (!sourceReviewKind(workflow, phaseId)) {
    throw new SingularityFlowError(`Source review applies only to a step that defines the scope or plans the claims; '${phaseId}' does neither.`);
  }
  if (!workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Current branch is not registered for Story '${workflow.workItem.id}'.`);
  }
  const phase = workflow.phases?.[phaseId];
  if (!phase) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no '${phaseId}' phase.`);
  const emitReview = (operation, outcome, changed, data) => emitCommandResult(commandResult({
    operation: { id: `review-source.${operation}`, classification: changed ? 'mutation' : 'read' },
    subject: { kind: 'story', id: workflow.workItem.id }, outcome,
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true }) : noEffects(),
    restState: changed ? 'complete' : 'informational', data,
    next: (data?.continuation?.actions ?? []).map((entry, index) => narrationAction({ id: `source-review.next.${index}`, command: entry.command, skill: entry.skill, label: entry.reason, rank: 'NOW' }))
  }), { postState: workflow });
  if (action === 'status' && !sourceReviewRequired(workflow, phaseId)) {
    const result = { schemaVersion: 1, resultType: 'source-review-status',
      workId: workflow.workItem.id, phase: phaseId, mode: 'off', status: 'not-required',
      findings: [], pendingDispositions: [] };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Source review: not required for ${workflow.workItem.id} ${phaseId} (pinned policy is off).`);
    return emitReview('status', noop('source-review.status-reported', {
      workId: workflow.workItem.id, phase: phaseId, status: 'not-required'
    }), false, result);
  }
  const stagingPath = path.join(gitDir(root), 'singularity-flow', 'source-reviews',
    `${workflow.workItem.id}-${phaseId}-gen${phase.generation}.json`);
  if (action === 'context') {
    if (workflow.currentPhase !== phaseId || phase.status !== 'in_progress') {
      throw new SingularityFlowError(`Source review context requires current in-progress phase '${phaseId}'.`);
    }
    const packet = await sourceReviewContext(root, config, workflow, phaseId, stagingPath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(packet, null, 2));
    console.log(sourceReviewContextText(packet));
    return emitReview('context', noop('source-review.context-reported', {
      workId: workflow.workItem.id, phase: phaseId, generation: packet.generation, canReview: packet.canReview
    }), false, packet);
  }
  if (action === 'status') {
    const status = await readSourceReviewStatus(root, config, workflow, phaseId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    console.log(`Source review: ${status.status} for ${status.workId} ${phaseId} generation ${status.generation}`);
    if (status.reportSha256) console.log(`Report: ${status.reportSha256} · ${status.reportPath}`);
    for (const finding of status.findings) console.log(`- ${finding.code}: ${finding.message}`);
    for (const pending of status.pendingDispositions) console.log(`- Human decision pending: ${pending.id} — ${pending.reason}`);
    return emitReview('status', noop('source-review.status-reported', {
      workId: workflow.workItem.id, phase: phaseId, status: status.status
    }), false, status);
  }
  if (workflow.currentPhase !== phaseId || phase.status !== 'in_progress') {
    throw new SingularityFlowError(`Source review ${action} requires current in-progress phase '${phaseId}'.`);
  }
  if (action !== 'check' && action !== 'decision-context') await assertNoPendingPublication(root, config, workflow, `record source review ${action}`);
  if (action === 'stage') {
    const { stageSourceReviewReport } = await import('../source-review-staging.mjs');
    const result = await stageSourceReviewReport(root, config, workflow, phaseId, optionString(options, 'report-json'));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Review draft staged: ${result.stagingPath}; no review, submission or approval retained.`);
    console.log(commandRouteLines(result.commandGuidance).join('\n'));
    return;
  }
  if (action === 'check' || action === 'submit') {
    const reportFile = optionString(options, 'report-file');
    if (!reportFile || path.resolve(reportFile) !== path.resolve(stagingPath)) {
      throw new SingularityFlowError(`Source review report must be staged at ${stagingPath}.`, {
        code: 'SOURCE_REVIEW_REPORT_STAGING_REQUIRED'
      });
    }
    const input = await sourceReviewInput(root, config, workflow, phaseId);
    const stagingEntry = await lstat(stagingPath).catch(() => null);
    if (!stagingEntry?.isFile() || stagingEntry.size > 8 * 1024 * 1024) {
      throw new SingularityFlowError('Staged source review must be a regular JSON file of at most 8 MiB.', {
        code: 'SOURCE_REVIEW_REPORT_STAGING_INVALID'
      });
    }
    let report;
    try { report = JSON.parse(await readFile(stagingPath, 'utf8')); }
    catch { throw new SingularityFlowError('Staged source review is not valid JSON. Repair the staging file; no review was retained.', {
      code: 'SOURCE_REVIEW_REPORT_INVALID'
    }); }
    if (action === 'check') {
      const checked = checkSourceReviewReport(report, input);
      const result = { schemaVersion: 1, resultType: 'source-review-check', // schema-transient
        workId: workflow.workItem.id, phase: phaseId, generation: phase.generation,
        status: checked.format.status !== 'ready' ? checked.format.status : checked.evaluation.status,
        ...checked, findings: [...checked.format.findings, ...(checked.evaluation?.findings ?? [])] };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Source review check: ${result.status}; format ${result.format.status}; retention ${result.retentionReady ? 'ready' : 'blocked'} (no changes).`);
      for (const finding of result.findings) console.log(`- ${finding.field ?? finding.code}: ${finding.message}`);
      return emitReview('check', noop('source-review.checked', {
        workId: workflow.workItem.id, phase: phaseId, retentionReady: result.retentionReady
      }), false, result);
    }
    const session = scopedSourceReviewerSession(input, await loadSession(root));
    const evaluation = evaluateSubmittedSourceReview(report, input, session);
    let retained;
    const { publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId, generation: phase.generation,
      actor: session.actor, agent: session.agent,
      payload: { kind: 'source-grounded-review', reportSha256: evaluation.reportSha256 }
    }, `[${workflow.workItem.id}][phase:${phaseId}][source-review] ${evaluation.reportSha256.slice(0, 12)}`,
    async (aggregate, publicationEvent) => {
      const current = await sourceReviewInput(root, config, aggregate, phaseId);
      if (JSON.stringify(current.binding) !== JSON.stringify(input.binding)) throw new SingularityFlowError(
        'Review sources or artifact changed during submission.', { code: 'SOURCE_REVIEW_BINDING_STALE' }
      );
      retained = await retainSourceReview(root, config, aggregate, phaseId, report, evaluation, session, publicationEvent);
      return retained;
    });
    const status = await readSourceReviewStatus(root, config, await loadStoryAggregate(root, config, workflow.workItem.id), phaseId);
    const result = { ...status, commit: publication.sha, pushed: publication.pushed };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Source review retained: ${retained.reportSha256} · ${retained.path}`);
    console.log(`Commit: ${publication.sha}${publication.pushed ? ' (pushed)' : ' (local)'}`);
    console.log(`Status: ${status.status}; ${status.findings.length} finding(s), ${status.pendingDispositions.length} human decision(s) pending.`);
    return emitReview('submit', succeeded('source-review.submitted', {
      workId: workflow.workItem.id, phase: phaseId, reportSha256: retained.reportSha256
    }), true, result);
  }
  const decisionSession = await loadSession(root, { required: false });
  if (decisionSession?.agent === workflow.resolution?.sourceReview?.reviewerAgent) {
    throw new SingularityFlowError(
      `The read-only source reviewer '${decisionSession.agent}' cannot record a human source review decision. Select a different agent or use an authorized human shell session, then retry.`,
      { code: 'SOURCE_REVIEW_REVIEWER_CANNOT_DECIDE', details: {
        recoveryCommand: `singularity-flow agent --agent ${phase.defaultAgent}`,
        recoverySkill: '/sf-agent', retrySkill: '/sf-review-decide' } }
    );
  }
  const status = await readSourceReviewStatus(root, config, workflow, phaseId);
  const id = optionString(options, 'finding');
  const reason = optionString(options, 'reason');
  if (!status.reportSha256 || !id || !reason) throw new SingularityFlowError(
    'Source review decision requires a retained report, --finding ID, and --reason TEXT.'
  );
  const actor = identity(root);
  const authorities = workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities;
  const authority = requireApprovalAuthority(authorities, phase.approvalPolicy, actor);
  const { sourceReviewDecisionPacket, assertSourceReviewDecisionConfirmation } = await import('../source-review-decision.mjs');
  const decisionPacket = sourceReviewDecisionPacket({ workflow, phaseId, status, findingId: id, reason, actor, authority });
  if (action === 'decision-context') {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(decisionPacket, null, 2));
    console.log(`${decisionPacket.instruction}\nReport: ${status.reportSha256}\nFinding: ${id}\nReason: ${reason}\nAuthority: ${authority.authorityGroup}`);
    console.log(commandRouteLines(decisionPacket.commandGuidance).join('\n'));
    return;
  }
  assertSourceReviewDecisionConfirmation(decisionPacket, optionString(options, 'confirm'));
  let retained;
  const { publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId, generation: phase.generation,
    actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { kind: 'source-review-disposition',
      reportSha256: status.reportSha256, findingId: id }
  }, `[${workflow.workItem.id}][phase:${phaseId}][source-review-decision] ${id}`,
  async (aggregate, publicationEvent) => {
    const current = await readSourceReviewStatus(root, config, aggregate, phaseId);
    if (current.reportSha256 !== status.reportSha256 || current.status === 'stale') throw new SingularityFlowError(
      'Source review changed before the human decision was recorded.', {
        code: 'SOURCE_REVIEW_BINDING_STALE'
      }
    );
    assertSourceReviewDecisionConfirmation(sourceReviewDecisionPacket({ workflow: aggregate, phaseId,
      status: current, findingId: id, reason, actor, authority }), optionString(options, 'confirm'));
    retained = await retainSourceReviewDecision(root, config, aggregate, phaseId, current,
      id, reason, actor, authority, publicationEvent);
    return retained;
  });
  const updated = await readSourceReviewStatus(root, config, await loadStoryAggregate(root, config, workflow.workItem.id), phaseId);
  const result = { ...updated, decision: retained, commit: publication.sha, pushed: publication.pushed,
    turnBoundary: 'end', effects: { decisionRecorded: true, phaseAdvanced: false, approvalRecorded: false } };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Human source review decision retained: ${id} · ${retained.recordSha256}`);
  console.log(`Commit: ${publication.sha}${publication.pushed ? ' (pushed)' : ' (local)'}`);
  console.log(`Status: ${updated.status}; ${updated.findings.length} finding(s) remain.`);
  return emitReview('decide', succeeded('source-review.decided', {
    workId: workflow.workItem.id, phase: phaseId, findingId: id
  }), true, result);
}
