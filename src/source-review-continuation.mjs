/** Read-only author/reviewer handoff. A draft is never evidence of publication. */
import { phaseNeedsGeneration } from './sequence.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { stepBeingWritten, successorGenerationOpen } from './phase-generation-need.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { generationSkillForPhase, opensCodeVersion, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { formatCommandRouteLines, modelFreeCommandForCommand } from './model-free-commands.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { raiseUpstreamIssueRoute } from './upstream-routes.mjs';

/**
 * When everything a review still holds is a reviewer finding about the approved specification, the
 * way on is to raise it there [PHR:REQ-003]: the plan's author cannot correct it, and a successor of
 * the plan would meet it again. Null otherwise, or when no raise is open from here.
 */
export function reviewUpstreamRoute(workflow, phase, review) {
  const holding = (review?.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required');
  if (review?.status !== 'correction-required' || !holding.length || !holding.every((entry) => entry.code === 'reviewer-blocker' && entry.upstreamPhase)) return null;
  const [first] = holding;
  const raised = raiseUpstreamIssueRoute(workflow, first.upstreamPhase, phase.id);
  return raised ? { command: raised.command.replace('<clause-or-section>', first.about ?? first.reviewFindingId), skill: '/sf-decide',
    label: `${holding.length === 1 ? 'The reviewer finding is' : `${holding.length} reviewer findings are`} about ${first.upstreamPhase}'s approved output: raise ${holding.length === 1 ? 'it' : 'each'} to ${first.upstreamPhase}'s approvers; then ${phase.id} is not held by ${holding.length === 1 ? 'it' : 'them'}, only the Story's ending.` } : null;
}

/** Whether a retained review asks the step for corrections its author makes (blocking findings, not only a person's decision). */
export function reviewAsksForCorrection(review) {
  return review?.status === 'correction-required' && (review.findings ?? []).some((finding) => finding.code !== 'human-disposition-required');
}

/**
 * A review's blocking findings as the author of the step's next generation reads them: what each says, its check and
 * where it points, from the retained report (`review.report`), else the status's own reviewer findings. Null when none.
 */
export function reviewCorrection(review, generation) {
  const report = review?.report ?? null;
  const sources = new Map((report?.binding?.sources ?? []).map((source) => [source?.id, source?.path]));
  const reported = (Array.isArray(report?.findings) ? report.findings : []).filter((entry) => entry?.severity === 'blocking')
    .map((entry) => ({ id: entry.id, ...(entry.check ? { check: entry.check } : {}), message: String(entry.message ?? '').slice(0, 600),
      ...(sources.get(entry.sourceId) && Number.isSafeInteger(entry.line) ? { at: `${sources.get(entry.sourceId)}:${entry.line}` } : {}) }));
  const findings = (reported.length ? reported : (review?.findings ?? []).filter((entry) => entry?.code === 'reviewer-blocker')
    .map((entry) => ({ id: entry.reviewFindingId ?? null, message: String(entry.message ?? '').slice(0, 600) }))).slice(0, 20);
  return findings.length ? { generation: Number(generation), findings } : null;
}

/**
 * The next step as a person reads it, ready to relay as is: "Now — <label>" and its three routes, in the runtime command
 * presentation contract. A review turn ended on the findings alone when its skill made it choose the ending (owner, 2026-11-16).
 * The person's Shell line is the command without the agent's JSON flags: in their own terminal it shows and asks.
 */
export function continuationPresentation(action, timing = 'Now') {
  if (!action?.command && !action?.copilotCommand) return null;
  const shell = action.command ? action.command.replace(/\s--(?:for-agent|json)(?=\s|$)/gu, '') : null;
  const label = action.label ?? String(action.reason ?? '').split(/(?<=[.;:])\s/u)[0].replace(/[.;:]$/u, '');
  return [`${timing} — ${label}`, ...formatCommandRouteLines({ copilotCommand: action.copilotCommand ?? null, command: shell,
    modelFreeCommand: shell ? modelFreeCommandForCommand(shell) : null }, { markdown: true })].join('\n');
}

export function sourceReviewContinuation(workflow, phase, review = null) {
  const hold = phaseGovernanceHold(workflow, phase);
  const action = (skill, command, reason, label = null) => ({ ...copilotAction({ skill, command, reason }), ...(label ? { label } : {}) });
  // The step's own work command: it writes the step, and it asks the person before a next version opens.
  const author = generationSkillForPhase(phase, workflow);
  let classification, actions, generation = Number(phase.generation ?? 0);
  if (hold) { classification = hold.classification; actions = hold.actions; }
  else if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') {
    classification = 'lifecycle-review-required';
    actions = [action('/sf-nextsteps', `singularity-flow nextsteps ${workflow.workItem.id} --json`,
      'Inspect the current lifecycle. Submitted evidence requires an authorized return before authoring a successor.', 'See where the Story stands')];
  } else if (!stepBeingWritten(workflow, phase) && reviewUpstreamRoute(workflow, phase, review)) {
    const route = reviewUpstreamRoute(workflow, phase, review);
    classification = 'upstream-issue-required';
    actions = [action(route.skill, route.command, route.label)];
  } else if (successorGenerationOpen(phase)) {
    // Its next version is open: writing it is the next step. The published version's review is carried into it, so
    // that review is never offered again, nor its submission [OSA:REQ-032, C2]. Only its own work command writes it.
    classification = 'successor-publication-required';
    generation = Number(phase.generationIntent?.generation ?? phase.versionOpening?.version);
    actions = [action(author, `singularity-flow prepare ${phase.id}`,
      `Write version ${generation} of ${phase.id}, then publish it; ${sourceReviewRequired(workflow, phase.id) ? 'its review follows its publication' : 'its submission follows its publication'}.`,
      `Write version ${generation} of ${phase.label ?? phase.id}`)];
  } else if (phaseNeedsGeneration(workflow, phase) || reviewAsksForCorrection(review)) {
    classification = 'successor-publication-required'; generation = nextPhaseGeneration(phase);
    // The review's corrections, in plain words: the person gives one yes to start the next version (owner, 2026-11-16).
    const fix = !phaseNeedsGeneration(workflow, phase) && reviewAsksForCorrection(review) ? `Fix the review's findings (version ${generation})` : null;
    // A published step's next version, for any reason (a return, a rejection or a review's corrections), opens in its own
    // work command, which asks the person and goes straight on to the fix in the same turn [D3, OSA:REQ-030]. /sf-recover
    // found "no recovery required" for unchanged bytes and ran nothing (owner, 2026-11-16).
    const code = phaseRequiresCodeDelivery(phase);
    const successor = Number(phase.generation ?? 0) >= 1 && (code || (!phaseUsesDeterministicGeneration(phase) && phase.generationPolicy?.requirement !== 'none'));
    const skill = code ? '/sf-code' : String(author).replace(/^\/sflow-/u, '/sf-');
    actions = successor
      ? [action(skill, `singularity-flow phase rollover ${phase.id} --json`,
        fix ? `${skill} asks the person "Start version ${generation} of ${phase.label ?? phase.id} to fix the review's findings?" and, on their yes, fixes them in the same turn.`
          : `${skill} previews version ${generation} of ${phase.id} and asks the person to confirm it; version ${phase.generation} stays as published.`, fix)]
      // A code step with no version open opens it first, as its entry, edit permission and task say: one command (C13).
      : opensCodeVersion(phase) ? [action(author, `singularity-flow phase begin ${phase.id} --json`,
        `Open version ${generation} of ${phase.id}, then write and publish it; the published version and its tests stay. ${sourceReviewRequired(workflow, phase.id) ? 'Its review follows its publication.' : 'Its submission follows its publication.'}`, fix)]
      : [action(author, `singularity-flow prepare ${phase.id}`,
        `Resume the phase author and prepare generation ${generation}. Preserve any private corrected draft, author it at the returned artifact path, then draft-check and prepublish. Publish only when the returned gates are ready; ${sourceReviewRequired(workflow, phase.id) ? 'review the published successor afterward' : 'follow its returned submission handoff'}.`, fix)];
  } else if (review?.pendingDispositions?.length) {
    classification = 'human-disposition-required';
    actions = [action('/sf-review-decide', `singularity-flow review-source decision-context ${phase.id} --work-id ${workflow.workItem.id} --finding ${review.pendingDispositions[0].id} --reason <TEXT> --json`,
      'An authorized human must decide this exact pending disposition; the reviewer cannot accept it.', 'Decide what the review left to a person')];
  } else if (review?.status === 'ready') {
    classification = 'submission-required';
    actions = [action('/sf-submit', `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}${decisionSubmitArguments(workflow, phase.id)}`,
      'Run configured checks and submit the reviewed publication; this review is not approval.', `Submit the ${phase.label ?? phase.id} for approval`)];
  } else {
    classification = 'source-review-required';
    actions = [action('/sf-review-source', `singularity-flow review-source context ${phase.id} --json`,
      'Review the exact published generation and its pinned answers; never review an unpublished draft as a successor.', `Review the ${phase.label ?? phase.id} against its sources`)];
  }
  const presentation = continuationPresentation(actions[0]);
  return { classification, publishedGeneration: Number(phase.generation ?? 0), targetGeneration: generation,
    automaticAdvance: false, actions, nextCommand: actions[0]?.command ?? null,
    nextSkill: actions[0]?.skill ?? null, copilotCommand: actions[0]?.copilotCommand ?? null, ...(presentation ? { presentation } : {}) };
}
