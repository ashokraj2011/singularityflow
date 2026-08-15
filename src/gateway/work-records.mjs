/**
 * The read model behind the current-work view. `[INT:CON-060]` `[INT:REQ-060]` `[INT:REQ-061]`
 *
 * A filtered read of records that already exist — the repository subject index, phase state,
 * approval state and pending publications — and emphatically not a second work store. The moment
 * this keeps its own list of what someone is working on, there are two answers to that question and
 * the wrong one is the one that renders fast.
 *
 * Grouping is the whole product idea of §8.1: five buckets that answer "is this mine to move?"
 * before the reader has to think about phases at all. The rules are deliberately mechanical, because
 * a bucket assigned by judgement is a bucket that differs between surfaces.
 */
import { buildRepositorySubjectIndex } from '../repository-subject-index.mjs';

/** In render order. A reader scans top-down and should hit their own work first. */
export const WORK_GROUP_ORDER = Object.freeze([
  'recovery-required', 'waiting-on-you', 'active', 'waiting-on-others', 'recently-completed'
]);

/** Phase statuses that mean the work is finished rather than paused. */
const COMPLETE_STATUSES = new Set(['approved', 'complete', 'completed']);

/**
 * The last thing that actually happened, as opposed to the last thing that was written.
 *
 * History carries bookkeeping entries as well as material ones, and "last updated 2 minutes ago"
 * because a projection was rebuilt is the kind of freshness signal that teaches people to distrust
 * every timestamp on the screen.
 */
const MATERIAL_EVENTS = new Set([
  'phase_submitted', 'phase_approved', 'phase_rejected', 'phase_reopened',
  'work_started', 'work_cancelled', 'publication_completed', 'publication_failed', 'rework_requested'
]);

export function lastMaterialEvent(workflow) {
  const history = Array.isArray(workflow?.history) ? workflow.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (MATERIAL_EVENTS.has(entry?.event)) {
      return { event: entry.event, phase: entry.phase ?? null, actor: entry.actor ?? null, at: entry.at ?? null };
    }
  }
  return null;
}

function actorMatches(actor, candidate) {
  if (!actor || !candidate) return false;
  const values = [candidate.login, candidate.email, candidate.name].filter(Boolean).map((value) => String(value).toLowerCase());
  return [actor.login, actor.email, actor.name].filter(Boolean)
    .some((value) => values.includes(String(value).toLowerCase()));
}

/**
 * Which bucket, and why.
 *
 * The `waiting-on-you` rule is narrower than "you could approve this": it is "this is awaiting
 * approval and you are not the person who submitted it". That is not full authority resolution —
 * which needs the approval policy, the authority map and the identity's roles — and it is not
 * claimed to be. It is the half that is knowable from the record in front of us and cannot be
 * wrong in the dangerous direction: nobody is told to approve their own work.
 */
function classify(workflow, { pendingPublication, actor }) {
  if (pendingPublication) {
    return { group: 'recovery-required', because: 'publication.pending' };
  }
  const phaseId = workflow.currentPhase ?? null;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;

  if (!phase) {
    const finished = (workflow.phaseOrder ?? []).every((id) => COMPLETE_STATUSES.has(workflow.phases?.[id]?.status));
    return finished
      ? { group: 'recently-completed', because: 'work.all-phases-complete' }
      : { group: 'active', because: 'work.no-current-phase' };
  }
  if (phase.status === 'awaiting_approval') {
    const submitted = [...(workflow.history ?? [])].reverse()
      .find((entry) => entry.event === 'phase_submitted' && entry.phase === phaseId);
    return actorMatches(actor, submitted?.actor)
      ? { group: 'waiting-on-others', because: 'approval.you-submitted-it' }
      : { group: 'waiting-on-you', because: 'approval.awaiting-a-reviewer' };
  }
  if (COMPLETE_STATUSES.has(phase.status) && phaseId === (workflow.phaseOrder ?? []).at(-1)) {
    return { group: 'recently-completed', because: 'work.final-phase-approved' };
  }
  return { group: 'active', because: 'work.in-progress' };
}

/**
 * One next action, computed from phase state rather than suggested.
 *
 * Returns null rather than guessing. A wrong next action in a guided surface is worse than none:
 * the reader follows it, it refuses, and now they distrust the four that were right.
 */
function nextAction(workflow, group) {
  const phaseId = workflow.currentPhase ?? null;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;
  if (group === 'recovery-required') return { operation: 'work.continue', reasonCode: 'recovery.resume-publication' };
  if (!phase) return null;
  if (phase.status === 'awaiting_approval') {
    return group === 'waiting-on-you'
      ? { operation: 'review.packet', reasonCode: 'approval.open-the-packet' }
      : { operation: 'work.continue', reasonCode: 'approval.waiting' };
  }
  if (phase.status === 'in_progress' || phase.status === 'rework') {
    return { operation: 'work.continue', reasonCode: 'work.resume-phase' };
  }
  return { operation: 'work.readiness', reasonCode: 'work.check-readiness' };
}

function blockersOf(workflow, { pendingPublication }) {
  const blockers = [];
  if (pendingPublication) blockers.push('publication-pending');
  const phaseId = workflow.currentPhase ?? null;
  const phase = phaseId ? workflow.phases?.[phaseId] : null;
  if (phase?.status === 'awaiting_approval') {
    const required = phase.approvalPolicy?.minimum ?? 1;
    const received = (phase.approvals ?? []).filter((entry) => entry?.decision === 'approved').length;
    if (received < required) blockers.push('approvals-outstanding');
  }
  if (phase?.requiredArtifact?.path && !phase.requiredArtifact.recordedAt) blockers.push('required-artifact-missing');
  return blockers;
}

/**
 * Enumerate visible work, grouped and deterministically ordered.
 *
 * `pendingPublications` and `actor` are injected rather than read here: the pending-publication
 * store and identity resolution both have their own callers and their own caching, and a read model
 * that reaches for them itself becomes a second place they can be consulted inconsistently.
 */
export async function workRecords(root, {
  definition = {}, portfolio = null, actor = null, pendingPublications = new Set(), includeCompleted = false
} = {}) {
  const index = await buildRepositorySubjectIndex(root, { definition, portfolio });
  const items = [];

  for (const kind of ['story', 'initiative']) {
    for (const subject of index.list(kind)) {
      const workflow = subject.state ?? {};
      const pendingPublication = pendingPublications.has?.(subject.id) ?? false;
      const { group, because } = classify(workflow, { pendingPublication, actor });
      if (group === 'recently-completed' && !includeCompleted) continue;
      const phaseId = workflow.currentPhase ?? null;
      const phase = phaseId ? workflow.phases?.[phaseId] : null;

      items.push({
        kind,
        id: subject.id,
        title: workflow.workItem?.title ?? workflow.initiative?.title ?? subject.id,
        repository: subject.location?.repository ?? null,
        branch: subject.canonicalBranch ?? null,
        phase: phaseId,
        phaseLabel: phase?.label ?? phaseId,
        generation: phase?.generation ?? 0,
        status: phase?.status ?? null,
        lastMaterialEvent: lastMaterialEvent(workflow),
        blockers: blockersOf(workflow, { pendingPublication }),
        group,
        // `[INT:REQ-061]`: why it is on this screen, in the record rather than in the renderer.
        whyVisible: because,
        nextAction: nextAction(workflow, group)
      });
    }
  }

  /**
   * Newest material event first, then ID.
   *
   * The ID tiebreak is what makes the order stable `[INT:REQ-060]`: two items that moved in the same
   * second would otherwise swap places between reads, and a list that reorders under the cursor is
   * a list people stop trusting.
   */
  items.sort((left, right) => {
    const leftAt = left.lastMaterialEvent?.at ?? '';
    const rightAt = right.lastMaterialEvent?.at ?? '';
    return rightAt.localeCompare(leftAt) || left.id.localeCompare(right.id);
  });

  const groups = Object.fromEntries(WORK_GROUP_ORDER.map((group) => [group, items.filter((item) => item.group === group)]));
  return { items, groups, groupOrder: [...WORK_GROUP_ORDER] };
}
