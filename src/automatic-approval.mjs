/**
 * Approve twice (owner, 2026-11-19: "do all the ceremony cuts and think from developer perspective").
 *
 * People approve the plan and the delivered code. A step whose workflow says `approval: { automatic: when-ready }` is
 * approved by SFlow right after it is submitted, in its own commit, when:
 * - its independent reviewer said ready for this version, with no finding a person disputed (owner, 2026-11-20);
 * - every check it ran passed;
 * - nothing is open for it on the decision list (a risk, a change outside the plan, an issue, a decision, a finding,
 *   a held test run), and the approval check a person's approval runs finds nothing either;
 * - its approval may be given without a second person (self-approval allowed, one approver, no group that must);
 * - no workflow rule routes the Story elsewhere after it;
 * - the Story takes no person's signature for its approvals (SF Guard);
 * - it changes no source files (configuration refuses the setting there; this re-checks the pinned step).
 * Otherwise the step stays with its people, exactly as before, and the submission says why.
 *
 * The record is the step's `automaticApproval`, its disposition `approved_automatically` and the history event
 * `phase-approved-automatically` ("approved automatically: the reviewer said ready; …"). The gate replays it from the
 * committed records (automatic-approval-replay.mjs). The undo is the next person approval's "Send back".
 *
 * Convergence (owner, 2026-11-21: convergence folds into the code approval): the step SFlow builds itself has no
 * independent reviewer; its check is SFlow's own spec-versus-code check (convergence-section.mjs). A workflow that marks
 * it `when-ready` has it approved here only when that check is clean: every requirement delivered, nothing found,
 * proposed or decided by a person, nothing blocking. A gap never approves itself: the step stays in progress with its
 * items on the decisions card (send it back to the code step, or accept it), and a person approves.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AUTOMATIC_APPROVAL_RULE, automaticApprovalHeldBy, automaticApprovalOn } from './approval-authority.mjs';

/** The rule this build approves by; the gate replays a record only against a rule it knows. */
export { AUTOMATIC_APPROVAL_RULE };

/** What an automatic approval checked, in the words history, reports and people read. */
export const AUTOMATIC_APPROVAL_CHECKS = Object.freeze({
  reviewReady: 'the reviewer said ready',
  checksPassed: 'its checks passed',
  nothingOpen: 'nothing was open for it'
});

/** What SFlow checked before approving a convergence step itself: its own check, in place of a reviewer's. */
export const CONVERGENCE_APPROVAL_CHECKS = Object.freeze({
  convergenceClean: 'the convergence check found every requirement delivered and nothing to decide',
  checksPassed: 'its checks passed',
  nothingOpen: 'nothing was open for it'
});

/** The convergence step's own check, from its sealed projection, verified as its approval verifies it; never throws. */
async function convergenceCheckOf(root, config, workflow, phase) {
  try {
    const [{ assertConvergencePublicationReady }, { convergenceSectionOf }] = await Promise.all([
      import('./convergence-context.mjs'), import('./convergence-section.mjs')]);
    const ready = await assertConvergencePublicationReady(root, config, workflow, phase);
    return { ready, section: convergenceSectionOf(ready.projection, ready.current) };
  } catch (error) {
    return { error: String(error?.message ?? error).split('\n')[0].slice(0, 200) };
  }
}

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
const unique = (lines) => [...new Set(lines.filter((line) => typeof line === 'string' && line.trim()).map((line) => line.trim()))];

/** "approved automatically: the reviewer said ready; …", as history and reports show it. */
export function automaticApprovalWords(record) {
  const checked = Array.isArray(record?.checked) && record.checked.length ? record.checked : Object.values(AUTOMATIC_APPROVAL_CHECKS);
  return `approved automatically: ${checked.join('; ')}`;
}

/**
 * Whether `phaseId`, just submitted, is approved automatically now. `applies: false` when its workflow leaves it to
 * people. Otherwise `eligible`, each fact checked (`predicates`), their words (`checked`) and, when not eligible, what
 * is open in plain words (`open`). Reads only; cheap facts first, the decision list last.
 */
export async function automaticApprovalCheck(root, config, workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId] ?? null;
  if (!phase || phase.status !== 'awaiting_approval' || workflow.currentPhase !== phaseId || !automaticApprovalOn(phase.approvalPolicy)) {
    return { applies: false };
  }
  const open = [];
  const policy = phase.approvalPolicy;
  const [{ editsSource, isConvergencePhase }, { decisionOutcome }] = await Promise.all([import('./phase-roles.mjs'), import('./workflow-decisions.mjs')]);
  const convergence = isConvergencePhase(phase);
  const noSourceChange = !editsSource(phase);
  if (!noSourceChange) open.push('it may change source files');
  const heldBy = automaticApprovalHeldBy(policy);
  const selfApprovalAllowed = !heldBy;
  if (heldBy) open.push(heldBy);
  const noSignatureRequired = !workflow.resolution?.presence;
  if (!noSignatureRequired) open.push('approvals on this Story take a person\'s signature');
  const outcome = (() => { try { return decisionOutcome(workflow, phase); } catch { return { kind: 'unknown' }; } })();
  const outcomeNext = !outcome || outcome.kind === 'next';
  if (!outcomeNext) open.push('a workflow rule decides where the Story goes after it');
  const failing = (phase.checks ?? []).filter((check) => check?.status !== 'passed');
  const checksPassed = !failing.length;
  if (!checksPassed) open.push(`${failing.length === 1 ? 'a check' : `${failing.length} checks`} did not pass (${failing.slice(0, 3).map((check) => check.id ?? check.command).join(', ')})`);
  // The reviewer: only a step its independent reviewer reviews is ever approved without a person; convergence, which
  // SFlow builds itself, only when its own spec-versus-code check is clean (owner, 2026-11-21).
  let review = null;
  let converged = null;
  const { sourceReviewRequired } = await import('./source-review-policy.mjs');
  if (convergence) {
    converged = await convergenceCheckOf(root, config, workflow, phase);
    if (!converged.section) open.push(`its convergence check could not be read here (${converged.error})`);
    else if (!converged.section.clean) open.push(converged.section.words);
  } else if (!sourceReviewRequired(workflow, phaseId)) open.push('no reviewer reviews this step');
  else {
    review = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phaseId).catch(() => null);
    if (review?.status !== 'ready') open.push(`its review is ${String(review?.status ?? 'unreadable').replaceAll('-', ' ')}`);
    // The reviewer did not say ready on its own: a person disputed its finding, so a person approves with the dispute in view.
    else if (review.disputedFindings?.length) open.push(`a person disputed the reviewer's finding ${review.disputedFindings.map((entry) => entry.id).join(', ')}`);
  }
  const reviewReady = review?.status === 'ready';
  const convergenceClean = converged?.section?.clean === true;
  // Nothing open: the one list of decisions, read offline. The approval check itself runs once, when it is recorded.
  let list = null;
  if (open.length === 0) {
    try {
      const { readPendingList } = await import('./decision-list-reads.mjs');
      list = await readPendingList(root, config, workflow, { phaseId, offline: true, card: false, reuse: false, approvalCheck: null });
      open.push(...(list.items ?? []).filter((item) => item.kind !== 'approval' && !item.settled).map((item) => item.plain?.question ?? item.title));
    } catch { open.push('the decision list could not be read here'); }
  }
  const nothingOpen = Boolean(list) && open.length === 0;
  const predicates = convergence
    ? { convergenceClean, checksPassed, nothingOpen, selfApprovalAllowed, outcomeNext, noSourceChange, noSignatureRequired }
    : { reviewReady, checksPassed, nothingOpen, selfApprovalAllowed, outcomeNext, noSourceChange, noSignatureRequired };
  const eligible = Object.values(predicates).every(Boolean);
  const checked = Object.values(convergence ? CONVERGENCE_APPROVAL_CHECKS : AUTOMATIC_APPROVAL_CHECKS);
  return {
    applies: true,
    eligible,
    predicates,
    checked,
    open: eligible ? [] : unique(open),
    ...(converged?.section ? { convergence: converged.section } : {}),
    record: eligible ? {
      rule: AUTOMATIC_APPROVAL_RULE,
      predicates,
      checked,
      // The convergence step's check, as its sealed projection holds it; any other step's reviewer's report.
      ...(convergence ? { convergence: { iteration: converged.ready.current.iteration, path: converged.ready.projectionRelative,
        convergenceSha256: converged.ready.projection.convergenceSha256,
        requirements: converged.section.requirements.length, settledByPlan: converged.section.settledByPlan.length } }
        : { review: { status: 'ready', reportSha256: review?.reportSha256 ?? null,
          reportPath: review?.reportPath ? path.relative(root, review.reportPath).split(path.sep).join('/') : null } }),
      checksSha256: digest(phase.checks ?? []),
      decisionListSha256: list?.packetSha256 ?? null
    } : null
  };
}

/** Why the step waits for a person after all, one plain sentence. */
export function needsPersonWords(phase, check) {
  const name = phase?.label ?? phase?.id ?? 'This step';
  const why = (check?.open ?? []).slice(0, 4);
  return `${name} v${Number(phase?.generation ?? 0)} needs your approval${why.length ? `: ${why.join('; ')}` : ''}.`;
}

/**
 * Approve the submitted step automatically when it qualifies, in its own commit after the submission. Returns
 * `{ applies: false }`, `{ applies: true, approved: false, open }` (it stays with its people) or `{ applies: true,
 * approved: true, result, publication, workflow }`. The recording runs every check a person's approval runs; one that
 * holds refuses, nothing is recorded, and its words say why the step stays with its people.
 */
export async function approveAutomaticallyAfterSubmission(root, config, workflow, phaseId, { actor = null } = {}) {
  const check = await automaticApprovalCheck(root, config, workflow, phaseId);
  if (!check.applies || !check.eligible) return { ...check, approved: false };
  const phase = workflow.phases[phaseId];
  const [{ transactStory, approvePhase, actorKey }, { LIFECYCLE_EVENT }] = await Promise.all([import('./state-stores.mjs'), import('./lifecycle-event.mjs')]);
  const record = { ...check.record, ranBy: actor ? actorKey(actor) : null };
  try {
    const { value: result, publication } = await transactStory(root, config, workflow,
      { type: LIFECYCLE_EVENT.PHASE_APPROVED, phaseId, generation: phase.generation, actor, agent: null, authorityGroup: null },
      `[${workflow.workItem.id}][phase:${phaseId}][approve] approved automatically`,
      (aggregate) => approvePhase(root, config, aggregate, { phaseId, automaticApproval: record, persist: false }),
      {
        paths: (phase.artifacts ?? []).map((item) => item.path),
        eventFromResult: (transition) => ({
          actor, agent: null, authorityGroup: null, identityAssurance: 'automatic',
          payload: { decision: 'approved', automatic: true, rule: AUTOMATIC_APPROVAL_RULE, reviewPacketSha256: transition.approval.reviewPacketSha256 }
        })
      });
    return { ...check, approved: true, result, publication, workflow };
  } catch (error) {
    // The check a person's approval runs held it: the step stays with its people, who are told why.
    return { ...check, eligible: false, approved: false, open: unique([String(error?.message ?? error).split('\n')[0]]) };
  }
}
