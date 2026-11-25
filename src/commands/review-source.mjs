/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { requirePositional, SingularityFlowError, optionString, optionBoolean } from '../util.mjs';
import { repoRoot, branch, gitDir, identity } from '../git.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { sourceReviewKind } from '../phase-roles.mjs';
import { workflowBranchAllowed } from '../story-paths.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { commandResult, effects, noEffects, action as narrationAction, noop, succeeded } from '../narration/command-result.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sourceReviewContext, sourceReviewDisputedEarlier, sourceReviewStepNotCurrent, sourceReviewStepRefusal, readSourceReviewStatus, sourceReviewInput, scopedSourceReviewerSession, evaluateSubmittedSourceReview, retainSourceReview, retainSourceReviewDecision } from '../source-review-lifecycle.mjs';
import { sourceReviewContextText } from '../source-review-context-display.mjs';
import { sourceReviewStagingProtocol } from '../source-review-staging.mjs';
import { commandRouteLines, safeCommandGuidance } from '../safe-command-guidance.mjs';
import { lstat, readFile, rm } from 'node:fs/promises';
import { loadSession } from '../session.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withFreshSourceReviewSnapshot } from '../source-review-snapshot.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';
import { SOURCE_REVIEW_TEMPLATE_INSTRUCTION, sourceReviewCheckProgress, sourceReviewProgress } from '../source-review-progress.mjs';

/**
 * No retained review, but a draft staged for this generation: the review is incomplete, not missing, with its reason
 * and the way to finish it [owner, 2026-11-13]. "No independent source-grounded review report exists" after six staged
 * packets read as if no review had happened, and the author's turn opened generation 2 with a reason of its own.
 */
async function withIncompleteReview(status, stagingPath) {
  if (status.reportSha256 || status.status !== 'missing' || !await lstat(stagingPath).then((entry) => entry.isFile(), () => false)) return status;
  const record = await (await import('../source-review-staging.mjs')).readSourceReviewIncomplete(stagingPath);
  const reason = record?.reason ?? 'its draft has not passed a check yet';
  const finish = `Finish the staged review in a fresh review turn: it resumes the draft at ${stagingPath} with a new repair budget, then retains it. What the step must correct is the review's to record, as a blocking finding; its retained review is the reason the next generation opens.`;
  return { ...status, status: 'incomplete',
    incomplete: { recorded: true, stagingPath, reason, ...(record ? { budgetSpent: record.budgetSpent === true, at: record.at, findings: record.findings } : {}) },
    findings: [{ code: 'review-incomplete', message: `A review of generation ${status.generation} is staged but not retained: ${reason}.` },
      ...status.findings.filter((entry) => entry.code !== 'review-missing')],
    ...(status.continuation ? { continuation: { ...status.continuation, classification: 'source-review-incomplete',
      actions: (status.continuation.actions ?? []).map((entry, index) => (index ? entry : { ...entry, reason: finish })) } } : {}) };
}

/**
 * `review-source dispute <step> --work-id W --finding F-2 --reason TEXT`: the person's dispute of the reviewer's blocking
 * finding, recorded as the review's own decision under the step's approval rules (review-finding-dispute.mjs). The read-only
 * reviewer never disputes its own review.
 */
async function disputeFinding(root, config, workflow, phase, options) {
  const session = await loadSession(root, { required: false });
  if (session?.agent && session.agent === workflow.resolution?.sourceReview?.reviewerAgent) {
    throw new SingularityFlowError(`The read-only source reviewer '${session.agent}' cannot dispute its own review. A person who may decide for ${phase.label ?? phase.id} disputes it, on the decision list or in their own terminal.`,
      { code: 'SOURCE_REVIEW_REVIEWER_CANNOT_DECIDE', details: { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, label: 'Dispute it on the decision list' } } });
  }
  const findingId = optionString(options, 'finding');
  if (!findingId) throw new SingularityFlowError('Name the reviewer\'s finding to dispute with --finding (its ID, such as F-2), and say why with --reason.',
    { code: 'REVIEW_DISPUTE_FINDING_UNKNOWN', details: { nextAction: { command: `singularity-flow decisions ${workflow.workItem.id}`, label: 'Dispute it on the decision list' } } });
  const { commitReviewDispute } = await import('../review-finding-dispute.mjs');
  const result = await commitReviewDispute(root, config, workflow, { phaseId: phase.id, findingId, reason: optionString(options, 'reason') }, { actor: identity(root) });
  if (optionBoolean(options, 'json')) return void console.log(JSON.stringify(result, null, 2));
  console.log(result.words);
  console.log(`Committed${result.pushed ? ' and pushed' : ' locally'}.`);
  if (result.continuation?.presentation) console.log(`\n${result.continuation.presentation.replaceAll('`', '')}`);
  return result;
}

/** The folder a report is kept in: its file name is its digest, which a person never reads. */
const reportFolder = (relative) => String(relative ?? '').replace(/[^/\\]*$/u, '') || 'the Story';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => reviewSourceCommand(positionals, options)),
    { preferencesOnly: true });
}

export async function reviewSourceCommand(positionals, options) {
  if (options['for-agent'] !== undefined) {
    const { validateAgentEntryRequest } = await import('../agent-entry-options.mjs');
    validateAgentEntryRequest('review-source', { positionals, options });
    const { sourceReviewAgentContext } = await import('../source-review-agent-context.mjs');
    return console.log(JSON.stringify(await sourceReviewAgentContext({ phaseId: positionals[2] ?? null }), null, 2));
  }
  const action = requirePositional(positionals, 1, 'source review action');
  if (!['context', 'decision-context', 'stage', 'check', 'submit', 'decide', 'dispute', 'status'].includes(action)) {
    throw new SingularityFlowError("Source review action must be context, decision-context, stage, check, submit, decide, dispute, or status.");
  }
  const phaseId = requirePositional(positionals, 2, 'step to review');
  const root = repoRoot();
  const { config, workflow } = await loadAcceptedStoryExecution(root, optionString(options, 'work-id'));
  // Reviewable by what the step does, not what it is called [E2G-001]. Asking whether a review is
  // needed is answered for every step, so a caller never stops on a step that needs none.
  if (['status', 'context', 'decision-context', 'check'].includes(action) && !sourceReviewKind(workflow, phaseId) && workflow.phases?.[phaseId]) {
    const result = { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, phase: phaseId,
      mode: 'not-applicable', status: 'not-required', findings: [], pendingDispositions: [],
      reason: workflow.resolution?.sourceReview?.kinds ? `'${phaseId}' has no review in this Story's pinned review policy.`
        : `'${phaseId}' neither defines the scope nor plans the claims, so it has no source review.` };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`Source review: not required for ${workflow.workItem.id} ${phaseId}; ${result.reason}`);
  }
  // A step the Story lacks, or one its review does not cover: the Story's next step is the way on.
  if (!sourceReviewKind(workflow, phaseId)) throw sourceReviewStepRefusal(workflow, phaseId);
  if (!workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Current branch is not registered for Story '${workflow.workItem.id}'.`);
  }
  const phase = workflow.phases[phaseId];
  const emitReview = (operation, outcome, changed, data) => emitCommandResult(commandResult({
    operation: { id: `review-source.${operation}`, classification: changed ? 'mutation' : 'read' },
    subject: { kind: 'story', id: workflow.workItem.id }, outcome,
    effects: changed ? effects({ stateChanged: true, filesChanged: true, publicationCreated: true }) : noEffects(),
    restState: changed ? 'complete' : 'informational', data,
    next: (data?.continuation?.actions ?? []).map((entry, index) => narrationAction({ id: `source-review.next.${index}`, command: entry.command, skill: entry.skill, label: entry.reason, rank: 'NOW' }))
  }), { json: optionBoolean(options, 'json'), postState: workflow });
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
    if (workflow.currentPhase !== phaseId || phase.status !== 'in_progress') throw sourceReviewStepNotCurrent(workflow, phase, 'context');
    const packet = await sourceReviewContext(root, config, workflow, phaseId, stagingPath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(packet, null, 2));
    console.log(sourceReviewContextText(packet));
    return emitReview('context', noop('source-review.context-reported', {
      workId: workflow.workItem.id, phase: phaseId, generation: packet.generation, canReview: packet.canReview
    }), false, packet);
  }
  if (action === 'status') {
    const status = await withIncompleteReview(await readSourceReviewStatus(root, config, workflow, phaseId), stagingPath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    console.log(`Source review: ${status.status} for ${status.workId} ${phaseId} generation ${status.generation}`);
    // The report's file is named by its digest: a person reads where it is kept (owner, 2026-11-11: no hash shown).
    if (status.reportSha256) console.log(`Report: kept in ${reportFolder(status.reportPath)}`);
    for (const finding of status.findings) console.log(`- ${finding.code}: ${finding.message}`);
    for (const pending of status.pendingDispositions) console.log(`- Human decision pending: ${pending.id} — ${pending.reason}`);
    // The next step in SFlow's own words, "Now — <label>" and its routes (owner, 2026-11-16).
    if (status.continuation?.presentation) console.log(`\n${status.continuation.presentation.replaceAll('`', '')}`);
    return emitReview('status', noop('source-review.status-reported', {
      workId: workflow.workItem.id, phase: phaseId, status: status.status
    }), false, status);
  }
  // Dispute this finding: a person who may decide for the step, with their own reason, never the reviewer (owner, 2026-11-20).
  if (action === 'dispute') {
    const disputed = await disputeFinding(root, config, workflow, phase, options);
    return disputed ? emitReview('dispute', succeeded('source-review.disputed', {
      workId: workflow.workItem.id, phase: phaseId, findingId: disputed.finding
    }), true, disputed) : undefined;
  }
  if (workflow.currentPhase !== phaseId || phase.status !== 'in_progress') throw sourceReviewStepNotCurrent(workflow, phase, action);
  // `stage` with no inline JSON is the check of the file the reviewer wrote at stagingPath, with the check's exact
  // findings and repairs in its result: stage, repair, stage, submit, never a separate check call [owner, 2026-11-25:
  // 23 of 66 real reviews ran the check more than once and took 124 s against 71 s]. `check` stays as it was.
  const inlineStage = action === 'stage' && Object.hasOwn(options, 'report-json');
  const checks = action === 'check' || (action === 'stage' && !inlineStage);
  if (!checks && action !== 'decision-context') {
    const { assertNoPendingPublication } = await import('../story-publication-pending.mjs');
    await assertNoPendingPublication(root, config, workflow, `record source review ${action}`);
  }
  if (inlineStage) {
    const { stageSourceReviewReport } = await import('../source-review-staging.mjs');
    const result = await stageSourceReviewReport(root, config, workflow, phaseId, optionString(options, 'report-json'));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Review draft staged: ${result.stagingPath}; no review, submission or approval retained.`);
    if (result.correctedWords) console.log(result.correctedWords);
    console.log(commandRouteLines(result.commandGuidance).join('\n'));
    return;
  }
  if (checks || action === 'submit') {
    // The file is the one SFlow issued for this step and generation, so --report-file may be left out; any other
    // file is still refused [owner, 2026-11-20: SFlow fills what it knows].
    const reportFile = optionString(options, 'report-file') ?? stagingPath;
    if (path.resolve(reportFile) !== path.resolve(stagingPath)) {
      throw new SingularityFlowError(`Source review report must be staged at ${stagingPath}.`, {
        code: 'SOURCE_REVIEW_REPORT_STAGING_REQUIRED'
      });
    }
    const input = await sourceReviewInput(root, config, workflow, phaseId);
    const stagingEntry = await lstat(stagingPath).catch(() => null);
    // Nothing staged yet: say so, and how, rather than a file-format refusal: the file, never JSON in a shell argument.
    if (!stagingEntry) throw new SingularityFlowError(`Nothing is staged at ${stagingPath} yet. Write the whole report with your file-edit tool at that exact path, then run this again; nothing was retained.`, {
      code: 'SOURCE_REVIEW_REPORT_NOT_STAGED', details: { stagingPath }
    });
    if (!stagingEntry.isFile() || stagingEntry.size > 8 * 1024 * 1024) {
      throw new SingularityFlowError('Staged source review must be a regular JSON file of at most 8 MiB.', {
        code: 'SOURCE_REVIEW_REPORT_STAGING_INVALID'
      });
    }
    let report;
    let text;
    try { text = await readFile(stagingPath, 'utf8'); report = JSON.parse(text); }
    catch (error) { throw new SingularityFlowError(`Staged source review is not valid JSON (${error.message}). Repair the staging file; no review was retained.`, {
      code: 'SOURCE_REVIEW_REPORT_INVALID'
    }); }
    const staging = await import('../source-review-staging.mjs');
    const { recordSha256 } = await import('../records.mjs');
    // A re-raised disputed finding's ID copied with a slip is set by the check too (normalizeSourceReviewReport).
    const disputedEarlier = await sourceReviewDisputedEarlier(root, config, workflow, phaseId);
    report = await staging.withSourceReviewContextBinding(root, stagingPath, report);
    const given = recordSha256(report);
    // Retained only through the reviewer's own scoped session: refused before anything is corrected.
    const session = action === 'submit' ? scopedSourceReviewerSession(input, await loadSession(root)) : null;
    // What the packet's own quotes fix exactly, SFlow sets in the file and checks again, here and before retention
    // alike, whatever repair budget is left: it is SFlow's write, never a repair attempt [owner, 2026-11-20].
    const fixed = await staging.correctStagedSourceReview(root, stagingPath, { text, report,
      input: disputedEarlier.length ? { ...input, disputedEarlier } : input });
    report = fixed.report;
    const correction = fixed.corrected.length ? { corrected: fixed.corrected, correctedWords: fixed.correctedWords } : {};
    if (checks) {
      const { checked } = fixed;
      // The skeleton context wrote, checked untouched: the reviewer's judgments are still to write, and it spends nothing.
      const untouched = text === staging.sourceReviewTemplateText((await import('../source-review-contract.mjs')).sourceReviewReportTemplate(input));
      // The bytes this check read at stagingPath (as SFlow left them), in its progress: a result is about the file as
      // it is now, and says so, so a result of an earlier packet is never taken for it [owner, 2026-11-20].
      const stagedSha256 = createHash('sha256').update(fixed.text).digest('hex');
      const protocol = sourceReviewStagingProtocol(phaseId, stagingPath);
      // Each packet that cannot be retained is noted beside the draft, so the review is never silently dropped [owner, 2026-11-13].
      const noted = checked.evaluation?.status === 'stale' ? null : await staging.noteSourceReviewAttempt(root, stagingPath, { phaseId, generation: phase.generation,
        checked, reportSha256: given, writtenSha256: fixed.corrected.length ? recordSha256(report) : null, untouched }).catch(() => null);
      const incomplete = staging.sourceReviewBudgetSpent(phaseId, stagingPath, noted);
      // Spent repairs: the way on is a fresh review turn, never this check of the same bytes again.
      const progress = { ...sourceReviewCheckProgress(input, stagingPath, checked, protocol), stagedSha256,
        ...(untouched && !checked.retentionReady ? { state: 'author-report', templateWritten: true, templateSha256: stagedSha256, instruction: SOURCE_REVIEW_TEMPLATE_INSTRUCTION } : {}),
        ...(incomplete ? { state: 'repairs-spent', nextAction: incomplete.nextAction, instruction: incomplete.instruction } : {}) };
      const { observeWorkflowTaskCheck } = await import('../workflow-task-store.mjs');
      await observeWorkflowTaskCheck(root, workflow, phase, { ...checked, generation: phase.generation,
        reportSha256: recordSha256(report) }, { role: 'source-reviewer', inputSha256: recordSha256(input.binding) });
      progress.operationId = (await import('../workflow-task.mjs')).workflowTaskIdentity(workflow, phase, 'source-reviewer').id;
      await (await import('../copilot-mutation-guard.mjs')).recordSourceReviewProgress(root,
        { workId: workflow.workItem.id, phaseId, generation: phase.generation, ...progress });
      const commandGuidance = checked.evaluation?.status === 'stale'
        ? safeCommandGuidance({ argv: ['review-source', 'context', phaseId, '--json'] })
        : checked.retentionReady ? protocol.retain : incomplete?.nextAction ?? protocol.check;
      const guidance = { commandGuidance, command: commandGuidance.command, skill: commandGuidance.skill };
      const reason = incomplete?.instruction ?? (untouched && !checked.retentionReady ? SOURCE_REVIEW_TEMPLATE_INSTRUCTION : checked.repair.instruction);
      const result = { schemaVersion: 1, resultType: 'source-review-check', // schema-transient
        workId: workflow.workItem.id, phase: phaseId, generation: phase.generation,
        status: checked.format.status !== 'ready' ? checked.format.status : checked.evaluation.status,
        // With a format error, also the citation and reference slips found beside it (checkSourceReviewReport).
        ...checked, findings: checked.evaluation ? [...checked.format.findings, ...checked.evaluation.findings] : checked.findings, ...correction,
        stagingPath, stagingProtocol: protocol, progress, ...(incomplete ? { incomplete } : {}),
        continuation: { automaticAdvance: false,
          nextAction: { ...guidance, reason },
          actions: [{ ...guidance, reason }] } };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`${action === 'stage' ? 'Review draft staged and checked' : 'Source review check'}: ${result.status}; format ${result.format.status}; retention ${result.retentionReady ? 'ready' : 'blocked'}${result.correctedWords ? '' : ' (no changes)'}.`);
      if (result.correctedWords) console.log(result.correctedWords);
      for (const finding of result.findings) console.log(`- ${finding.field ?? finding.code}: ${finding.message}`);
      console.log(incomplete?.instruction ?? result.repair.instruction);
      for (const citation of result.repair.citations) console.log(`- ${citation.field}: ${citation.instruction}${citation.proposedEdit ? ` ${citation.proposedEdit.field} = ${citation.proposedEdit.value}` : ''}`);
      console.log(commandRouteLines(commandGuidance).join('\n'));
      return emitReview(action, noop('source-review.checked', {
        workId: workflow.workItem.id, phase: phaseId, retentionReady: result.retentionReady
      }), false, result);
    }
    let evaluation;
    try { evaluation = evaluateSubmittedSourceReview(report, input, session); }
    catch (error) {
      // What SFlow already set stays named beside what is left to repair.
      if (fixed.corrected.length && error instanceof SingularityFlowError && error.details && typeof error.details === 'object') error.details = { ...error.details, ...correction };
      throw error;
    }
    await (await import('../workflow-task-store.mjs')).observeWorkflowTask(root, workflow, phase, {
      state: 'retention-requested', checkpoint: 'retention-requested',
      inputSha256: (await import('../records.mjs')).recordSha256(input.binding)
    }, { role: 'source-reviewer', generation: phase.generation });
    const { transactStory } = await measureCommandSpan('publication.writer-load', () => import('../story-publication-store.mjs'));
    let retained;
    const { publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId, generation: phase.generation,
      actor: session.actor, agent: session.agent,
      payload: { kind: 'source-grounded-review', reportSha256: evaluation.reportSha256 }
    }, `[${workflow.workItem.id}][phase:${phaseId}][source-review] ${evaluation.reportSha256.slice(0, 12)}`,
    async (aggregate, publicationEvent) => {
      const current = await withFreshSourceReviewSnapshot(root, () => sourceReviewInput(root, config, aggregate, phaseId));
      if (JSON.stringify(current.binding) !== JSON.stringify(input.binding)) throw new SingularityFlowError(
        'Review sources or artifact changed during submission.', { code: 'SOURCE_REVIEW_BINDING_STALE' }
      );
      retained = await retainSourceReview(root, config, aggregate, phaseId, report, evaluation, session, publicationEvent);
      return retained;
    });
    const status = await readSourceReviewStatus(root, config, await loadStoryAggregate(root, config, workflow.workItem.id), phaseId);
    await (await import('../workflow-task-store.mjs')).observeWorkflowTask(root, workflow, phase, {
      state: 'complete', checkpoint: 'retained-review', fingerprint: status.reportSha256,
      inputSha256: (await import('../records.mjs')).recordSha256(input.binding)
    }, { role: 'source-reviewer', generation: phase.generation });
    await rm((await import('../source-review-staging.mjs')).sourceReviewIncompletePath(stagingPath), { force: true }).catch(() => {});
    const progress = await sourceReviewProgress({ input, retained: status, stagingPath });
    await (await import('../copilot-mutation-guard.mjs')).recordSourceReviewProgress(root,
      { workId: workflow.workItem.id, phaseId, generation: phase.generation, ...progress });
    const result = { ...status, commit: publication.sha, pushed: publication.pushed, ...correction };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (result.correctedWords) console.log(result.correctedWords);
    console.log(`Source review retained for ${workflow.workItem.id} ${phaseId} generation ${phase.generation}, in ${reportFolder(retained.path)}`);
    console.log(`Committed${publication.pushed ? ' and pushed' : ' locally'}.`);
    console.log(`Status: ${status.status}; ${status.findings.length} finding(s), ${status.pendingDispositions.length} human decision(s) pending.`);
    if (status.continuation?.presentation) console.log(`\n${status.continuation.presentation.replaceAll('`', '')}`);
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
    console.log(`${decisionPacket.instruction}\nReport: the review of ${phaseId} generation ${status.generation}\nFinding: ${id}\nReason: ${reason}\nAuthority: ${authority.authorityGroup}`);
    console.log(commandRouteLines(decisionPacket.commandGuidance).join('\n'));
    return;
  }
  assertSourceReviewDecisionConfirmation(decisionPacket, optionString(options, 'confirm'));
  // SF Guard: on a Story it requires, the retained decision keeps its approver's signature, taken where it is
  // written (source-review-lifecycle.mjs, SPEC-PSS-v1 §10.7).
  const { transactStory } = await measureCommandSpan('publication.writer-load', () => import('../story-publication-store.mjs'));
  let retained;
  const { publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, phaseId, generation: phase.generation,
    actor, agent: null, authorityGroup: authority.authorityGroup,
    payload: { kind: 'source-review-disposition',
      reportSha256: status.reportSha256, findingId: id }
  }, `[${workflow.workItem.id}][phase:${phaseId}][source-review-decision] ${id}`,
  async (aggregate, publicationEvent) => {
    const current = await withFreshSourceReviewSnapshot(root, () => readSourceReviewStatus(root, config, aggregate, phaseId));
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
  console.log(`Human source review decision retained: ${id}`);
  console.log(`Committed${publication.pushed ? ' and pushed' : ' locally'}.`);
  console.log(`Status: ${updated.status}; ${updated.findings.length} finding(s) remain.`);
  return emitReview('decide', succeeded('source-review.decided', {
    workId: workflow.workItem.id, phase: phaseId, findingId: id
  }), true, result);
}
