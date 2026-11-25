/** Read-only author/reviewer handoff. A draft is never evidence of publication. */
import { stepBeingWritten } from './phase-generation-need.mjs';
import { generationSkillForPhase, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { decisionRoutes, stepDecisionOf } from './step-decision.mjs';
import { copilotAction } from './copilot-guidance.mjs';
import { taskDoneRoute, withTaskRoutes } from './safe-command-guidance.mjs';
import { formatCommandRouteLines, modelFreeCommandForCommand } from './model-free-commands.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { decisionSubmitArguments } from './workflow-decisions.mjs';
import { autoFixVersionsOf, sourceReviewRequired } from './source-review-policy.mjs';
import { raiseUpstreamIssueRoute } from './upstream-routes.mjs';
import { inTurnSubmitCommand, reviewFindingsOpenCommand } from './action-command-map.mjs';
import { disputedFindingWords } from './review-dispute-words.mjs';

/** Only the reviewer has seen the version its retained review asks to correct (owner, 2026-11-19): review-findings-opening.mjs. */
export function reviewerAloneSaw(workflow, phase, review) {
  const version = Number(phase?.generation ?? 0);
  if (!(version >= 1) || phase.status !== 'in_progress' || workflow?.currentPhase !== phase.id || !reviewAsksForCorrection(review) || !review.reportSha256) return false;
  if (review.generation !== undefined && Number(review.generation) !== version) return false;
  if ((review.decisions ?? []).length || (review.carriedDecisions ?? []).length || (review.pendingDispositions ?? []).length) return false;
  if ((phase.approvals ?? []).some((entry) => Number(entry.generation) === version) || phase.rejectedAt || phase.submittedAt) return false;
  const undone = new Set((workflow.settledDecisions ?? []).map((entry) => entry?.undoes).filter(Boolean));
  return !(workflow.settledDecisions ?? []).some((entry) => entry?.kind === 'review-corrections' && entry.phase === phase.id && undone.has(entry.id))
    && !reviewFindingsHold(workflow, phase, review);
}

/** The reviewer's blocking findings by the reviewer's own IDs: what "the same finding" is from one version to the next. */
export const reviewFindingKeys = (review) => [...new Set((review?.findings ?? [])
  .filter((entry) => entry?.code === 'reviewer-blocker' && entry.reviewFindingId).map((entry) => String(entry.reviewFindingId)))];

/**
 * Why a review's next version is the person's question although only the reviewer saw this one (owner, 2026-11-19): SFlow
 * started as many in a row as the workflow lets it already (`sourceReview.autoFixVersions`, 2 unless set; a person's yes
 * breaks the run; 0 asks every time), or a finding came back after SFlow's fix. Null: neither.
 */
export function reviewFindingsHold(workflow, phase, review) {
  const limit = autoFixVersionsOf(workflow, phase?.id);
  if (limit === 0) return { reason: 'setting', words: 'This workflow asks you before every version that fixes a review\'s findings.' };
  const starts = (workflow?.settledDecisions ?? []).filter((entry) => entry?.kind === 'review-corrections' && entry.phase === phase?.id);
  const run = [];
  for (let version = Number(phase?.generation ?? 0); version > 1 && run.length < limit;) {
    const start = starts.findLast((entry) => Number(entry.effect?.toGeneration) === version);
    const opening = phase.versionOpening;
    if (!start || !(Number(start.effect.generation) < version) || (Number(opening?.version) === version && opening.consent?.surface !== 'settled')) break;
    run.push(start);
    version = Number(start.effect.generation);
  }
  if (run.length >= limit) return { reason: 'rounds', words: `The reviewer has asked for corrections ${run.length + 1} times in a row.` };
  const before = new Set(run[0]?.effect?.findings ?? []);
  const back = reviewFindingKeys(review).filter((key) => before.has(key));
  return back.length ? { reason: 'repeated', findings: back, words: `The reviewer's finding ${back[0]} came back after SFlow's fix.` } : null;
}

/**
 * When everything a review still holds is a finding an earlier step owns, the way on is to raise it there [PHR:REQ-003]: a
 * planning finding about the specification, one at a time; or the findings on a document SFlow wrote from an earlier step's
 * records, in one filled raise naming each (d-story, 2026-11-22). Null otherwise, or when no raise is open.
 */
export function reviewUpstreamRoute(workflow, phase, review) {
  const holding = (review?.findings ?? []).filter((entry) => entry.code !== 'human-disposition-required');
  if (review?.status !== 'correction-required' || !holding.length || !holding.every((entry) => entry.upstreamPhase
    && (entry.code === 'reviewer-blocker' || entry.recordDocument))) return null;
  const [first] = holding;
  const raised = raiseUpstreamIssueRoute(workflow, first.upstreamPhase, phase.id);
  if (!raised) return null;
  // Shell-safe words: the route filter refuses quotes and brackets.
  const word = (value, limit) => { const text = String(value ?? '').replace(/[^A-Za-z0-9 .,:_/@%+=-]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit).trim();
    return /^[A-Za-z0-9.,:_/@%+=-]+$/u.test(text) ? text : `'${text}'`; };
  const records = holding.every((entry) => entry.recordDocument && entry.upstreamPhase === first.upstreamPhase);
  if (!records) {
    return { command: raised.command.replace('<clause-or-section>', word(first.about ?? first.reviewFindingId, 200)), skill: '/sf-decide',
      label: `${holding.length === 1 ? 'The reviewer finding is' : `${holding.length} reviewer findings are`} about ${first.upstreamPhase}'s approved output: raise ${holding.length === 1 ? 'it' : 'each'} to ${first.upstreamPhase}'s approvers; then ${phase.id} is not held by ${holding.length === 1 ? 'it' : 'them'}, only the Story's ending.` };
  }
  // Each finding by the name its raise is matched on, then a comma (the match refuses ':' or '-' after it), words shortened.
  const named = holding.slice(0, 12);
  const lead = `Review of ${phase.id} version ${review.generation ?? phase.generation}, a document SFlow wrote from ${first.upstreamPhase}'s records:`;
  const room = Math.max(40, Math.floor((900 - lead.length) / named.length) - 20);
  const problem = `${lead} ${named.map((entry) => `${entry.about ?? entry.reviewFindingId ?? entry.rowId}, ${String(entry.problem ?? entry.message).slice(0, room)}`).join(' / ')}`;
  return { command: raised.command.replace('<clause-or-section>', word(`${phase.id}-review-v${review.generation ?? phase.generation}`, 200))
    .replace('<what-is-wrong>', word(problem, 990)), skill: '/sf-decide', label: `Raise the review's findings to ${first.upstreamPhase}'s approvers`,
    reason: `SFlow wrote ${phase.id} from ${first.upstreamPhase}'s records, so another version would say the same. Raise its findings to ${first.upstreamPhase}'s approvers; then only the ending waits.` };
}

/** Whether a retained review asks the step for corrections its author makes (blocking findings, not only a person's decision). */
export function reviewAsksForCorrection(review) {
  return review?.status === 'correction-required' && (review.findings ?? []).some((finding) => finding.code !== 'human-disposition-required');
}

/**
 * A review's blocking findings as the author of the step's next generation reads them: what each says, its check and
 * where it points, from the retained report (`review.report`), else the status's own reviewer findings. Null when none.
 * `disputed`: the findings a person disputed (review-finding-dispute.mjs), each `{ id, by, reason }`: never among those to
 * fix, and named in `disputed`, so the author is told not to make that fix (owner, 2026-11-20).
 */
export function reviewCorrection(review, generation, disputed = []) {
  const report = review?.report ?? null;
  const sources = new Map((report?.binding?.sources ?? []).map((source) => [source?.id, source?.path]));
  const reported = (Array.isArray(report?.findings) ? report.findings : []).filter((entry) => entry?.severity === 'blocking')
    .map((entry) => ({ id: entry.id, ...(entry.check ? { check: entry.check } : {}), message: String(entry.message ?? '').slice(0, 600),
      ...(sources.get(entry.sourceId) && Number.isSafeInteger(entry.line) ? { at: `${sources.get(entry.sourceId)}:${entry.line}` } : {}) }));
  const all = (reported.length ? reported : (review?.findings ?? []).filter((entry) => entry?.code === 'reviewer-blocker')
    .map((entry) => ({ id: entry.reviewFindingId ?? null, message: String(entry.message ?? '').slice(0, 600) }))).slice(0, 20);
  const disputes = new Map((disputed ?? []).filter((entry) => entry?.id).map((entry) => [String(entry.id), entry]));
  const findings = all.filter((entry) => !disputes.has(String(entry.id)));
  const named = all.filter((entry) => disputes.has(String(entry.id))).map((entry) => ({ id: entry.id, words: `${disputedFindingWords(entry.id, disputes.get(String(entry.id)))} Do not make that fix.` }));
  return findings.length || named.length ? { generation: Number(generation), findings, ...(named.length ? { disputed: named } : {}) } : null;
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
    // A closed task's next is its last message (work status) [ITW:REQ-018].
    const done = taskDoneRoute(workflow);
    actions = done ? [done] : [action('/sf-nextsteps', `singularity-flow nextsteps ${workflow.workItem.id} --json`,
      'Inspect the current lifecycle. Submitted evidence requires an authorized return before authoring a successor.', 'See where the Story stands')];
  } else if (!stepBeingWritten(workflow, phase) && reviewUpstreamRoute(workflow, phase, review)) {
    const route = reviewUpstreamRoute(workflow, phase, review);
    classification = 'upstream-issue-required';
    actions = [action(route.skill, route.command, route.reason ?? route.label, route.reason ? route.label : null)];
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
        // turn [D3, OSA:REQ-030]; /sf-recover found nothing to recover for unchanged bytes (owner, 2026-11-16), or starts it
        // on its own when only the reviewer saw this one (owner, 2026-11-19).
        const skill = code ? '/sf-code' : String(author).replace(/^\/sflow-/u, '/sf-');
        const settles = Boolean(fix) && reviewerAloneSaw(workflow, phase, review);
        const held = fix && !settles ? reviewFindingsHold(workflow, phase, review) : null;
        actions = [action(skill, settles ? reviewFindingsOpenCommand(phase.id) : `singularity-flow phase rollover ${phase.id} --json`,
          settles ? `Only the reviewer has seen version ${phase.generation}: ${skill} starts version ${generation} of ${phase.label ?? phase.id} to fix the review's findings on its own and fixes them in the same turn.`
            : fix ? `${held ? `${held.words} ` : ''}${skill} asks the person "Start version ${generation} of ${phase.label ?? phase.id} to fix the review's findings?" and, on their yes, fixes them in the same turn.`
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
  // A task's Story names /sf-task for each turn it takes, in the same chat [ITW:REQ-008].
  actions = withTaskRoutes(workflow, actions);
  const presentation = continuationPresentation(actions[0]);
  // A ready version is submitted in the turn that wrote it, never a /sf-submit turn of its own (owner, 2026-11-19), unless it
  // records decision values: those are the person's, given in /sf-submit, never guessed here.
  const inTurn = classification === 'submission-required' && actions[0]?.skill && !/\s--decision\s/u.test(actions[0].command ?? '')
    ? { command: inTurnSubmitCommand(workflow.workItem.id), skill: actions[0].skill, reason: 'Submit the ready version now, in the turn that wrote it.' } : null;
  return { classification, publishedGeneration: Number(phase.generation ?? 0), targetGeneration: generation,
    automaticAdvance: false, actions, ...(inTurn ? { inTurn } : {}), nextCommand: actions[0]?.command ?? null,
    nextSkill: actions[0]?.skill ?? null, copilotCommand: actions[0]?.copilotCommand ?? null, ...(presentation ? { presentation } : {}) };
}
