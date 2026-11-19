/** Read-only author/reviewer handoff. A draft is never evidence of publication. */
import { stepBeingWritten } from './phase-generation-need.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { decisionRoutes, stepDecisionOf } from './step-decision.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { formatCommandRouteLines, modelFreeCommandForCommand } from './model-free-commands.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { raiseUpstreamIssueRoute } from './upstream-routes.mjs';
import { inTurnSubmitCommand, reviewFindingsOpenCommand } from './action-command-map.mjs';

/**
 * Whether only the reviewer has seen the published version its review asks to correct (owner, 2026-11-19, cut 10): the
 * review asks for corrections, nobody answered or disposed of it, no approval or return names that version, and no person
 * undid an earlier automatic start of this step. Its next version then starts on its own, with an undo
 * (review-findings-opening.mjs, which checks again with the person's typed words and changed files).
 */
export function reviewerAloneSaw(workflow, phase, review) {
  const version = Number(phase?.generation ?? 0);
  // A retained report is what the reviewer saw; a status with none is no review to act on.
  if (!(version >= 1) || phase.status !== 'in_progress' || workflow?.currentPhase !== phase.id || !reviewAsksForCorrection(review) || !review.reportSha256) return false;
  if (review.generation !== undefined && Number(review.generation) !== version) return false;
  if ((review.decisions ?? []).length || (review.carriedDecisions ?? []).length || (review.pendingDispositions ?? []).length) return false;
  if ((phase.approvals ?? []).some((entry) => Number(entry.generation) === version) || phase.rejectedAt || phase.submittedAt) return false;
  const undone = new Set((workflow.settledDecisions ?? []).map((entry) => entry?.undoes).filter(Boolean));
  return !(workflow.settledDecisions ?? []).some((entry) => entry?.kind === 'review-corrections' && entry.phase === phase.id && undone.has(entry.id));
}

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
  } else {
    // The step's primary action is the kernel's, from the same basis the edit permission and every other surface read:
    // this review, the step's open version, its successor's consent [OSA:REQ-020, b8]. Only its wording is said here.
    const decision = stepDecisionOf(workflow, phase, { review });
    const { operation, inputs } = decision.next;
    const reviewFollows = sourceReviewRequired(workflow, phase.id) ? 'its review follows its publication' : 'its submission follows its publication';
    if (['open-version', 'author-version', 'build-version', 'repair-version'].includes(operation)) {
      classification = 'successor-publication-required';
      generation = Number(inputs.version ?? decision.version.writing ?? decision.version.proposedNext);
      // The review's corrections, in plain words: the person gives one yes to start the next version (owner, 2026-11-16).
      const fix = inputs.reason === 'review-corrections' ? `Fix the review's findings (version ${generation})` : null;
      const code = phaseRequiresCodeDelivery(phase);
      if (operation === 'open-version' && inputs.consent === 'required') {
        // A published step's next version opens in its own work command, which asks the person, then fixes it in the same
        // turn [D3, OSA:REQ-030]; /sf-recover found nothing to recover for unchanged bytes (owner, 2026-11-16). For a review's
        // findings on a version only the reviewer has seen, it starts on its own, with an undo (owner, 2026-11-19).
        const skill = code ? '/sf-code' : String(author).replace(/^\/sflow-/u, '/sf-');
        const settles = Boolean(fix) && reviewerAloneSaw(workflow, phase, review);
        actions = [action(skill, settles ? reviewFindingsOpenCommand(phase.id) : `singularity-flow phase rollover ${phase.id} --json`,
          settles ? `Only the reviewer has seen version ${phase.generation}: ${skill} starts version ${generation} of ${phase.label ?? phase.id} to fix the review's findings on its own (undo on the decisions card) and fixes them in the same turn.`
            : fix ? `${skill} asks the person "Start version ${generation} of ${phase.label ?? phase.id} to fix the review's findings?" and, on their yes, fixes them in the same turn.`
            : `${skill} previews version ${generation} of ${phase.id} and asks the person to confirm it; version ${phase.generation} stays as published.`, fix)];
      } else if (operation === 'author-version' && decision.version.published >= 1) {
        // Its next version is open: writing it is the next step. The published version's review is carried into it, so
        // that review is never offered again, nor its submission [OSA:REQ-032, C2]. Only its own work command writes it.
        actions = [action(author, `singularity-flow prepare ${phase.id}`, `Write version ${generation} of ${phase.id}, then publish it; ${reviewFollows}.`,
          `Write version ${generation} of ${phase.label ?? phase.id}`)];
      } else if (operation === 'open-version' && code) {
        // A code step with no version open opens it first, as its entry, edit permission and task say: one command (C13).
        actions = [action(author, `singularity-flow phase begin ${phase.id} --json`,
          `Open version ${generation} of ${phase.id}, then write and publish it; the published version and its tests stay. ${sourceReviewRequired(workflow, phase.id) ? 'Its review follows its publication.' : 'Its submission follows its publication.'}`, fix)];
      } else {
        actions = [action(author, `singularity-flow prepare ${phase.id}`,
          `Resume the phase author and prepare generation ${generation}. Preserve any private corrected draft, author it at the returned artifact path, then draft-check and prepublish. Publish only when the returned gates are ready; ${sourceReviewRequired(workflow, phase.id) ? 'review the published successor afterward' : 'follow its returned submission handoff'}.`, fix)];
      }
    } else if (operation === 'decide' && inputs.decision === 'review-disposition' && review?.pendingDispositions?.length) {
      classification = 'human-disposition-required';
      actions = [action('/sf-review-decide', `singularity-flow review-source decision-context ${phase.id} --work-id ${workflow.workItem.id} --finding ${review.pendingDispositions[0].id} --reason <TEXT> --json`,
        'An authorized human must decide this exact pending disposition; the reviewer cannot accept it.', 'Decide what the review left to a person')];
    } else if (operation === 'submit-version') {
      classification = 'submission-required';
      actions = [action('/sf-submit', `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}${decisionSubmitArguments(workflow, phase.id)}`,
        'Run configured checks and submit the reviewed publication; this review is not approval.', phase.approvalPolicy?.mode === 'none'
          ? `Submit the ${phase.label ?? phase.id}; it completes without approval` : `Submit the ${phase.label ?? phase.id} for approval`)];
    } else if (['start-review', 'refresh-facts'].includes(operation)) {
      // A review owed and not ready, or not read here: the review's own read starts or continues it.
      classification = 'source-review-required';
      actions = [action('/sf-review-source', `singularity-flow review-source context ${phase.id} --json`,
        'Review the exact published generation and its pinned answers; never review an unpublished draft as a successor.', `Review the ${phase.label ?? phase.id} against its sources`)];
    } else {
      // Anything else the decision names (a decision the Story waits for, damage, a writer to take over): its own route.
      classification = 'lifecycle-review-required';
      actions = decisionRoutes(decision, workflow, phase, { exactSubmit: true }).filter((entry) => entry?.command)
        .map((entry) => action(entry.skill, entry.command, entry.detail));
    }
  }
  const presentation = continuationPresentation(actions[0]);
  // A ready version is submitted by the turn that wrote it and started its reviewer: /sf-submit's own entry, run there once,
  // so no separate /sf-submit turn follows (owner, 2026-11-19). A review turn of its own still ends on `presentation`.
  const inTurn = classification === 'submission-required' && actions[0]?.skill
    ? { command: inTurnSubmitCommand(workflow.workItem.id), skill: actions[0].skill, reason: 'Submit the ready version now, in the turn that wrote it.' } : null;
  return { classification, publishedGeneration: Number(phase.generation ?? 0), targetGeneration: generation,
    automaticAdvance: false, actions, ...(inTurn ? { inTurn } : {}), nextCommand: actions[0]?.command ?? null,
    nextSkill: actions[0]?.skill ?? null, copilotCommand: actions[0]?.copilotCommand ?? null, ...(presentation ? { presentation } : {}) };
}
