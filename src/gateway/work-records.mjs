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
import { matchApprovalAuthority } from '../approval-authority.mjs';
import { subjectKey, validateSubjectKey } from '../subject-ref.mjs';

/** In render order. A reader scans top-down and should hit their own work first. */
export const WORK_GROUP_ORDER = Object.freeze([
  'recovery-required', 'waiting-on-you', 'active', 'waiting-on-others', 'recently-completed'
]);

/** Resolve a typed subject, permitting a legacy bare ID only when it is unambiguous. */
export function resolveWorkRecord(records, { workId, workKind = null } = {}) {
  const matches = (records?.items ?? []).filter((entry) => entry.id === workId
    && (!workKind || entry.kind === workKind));
  if (matches.length <= 1) return matches[0] ?? null;
  const error = new Error(`Work ID '${workId}' exists as more than one governed subject; supply workKind.`);
  error.code = 'WORK_SUBJECT_AMBIGUOUS';
  throw error;
}

/** Phase statuses that mean the work is finished rather than paused. */
const COMPLETE_STATUSES = new Set(['approved', 'complete', 'completed']);

/**
 * The phase rail: every phase in order, and where this work has got to. `[UXH:REQ-050]`
 *
 * Screen B draws it as `intake ✓ design ✓ implement ● verify ○ release ○`, and the reason it is
 * built here rather than in a renderer is that only this layer has the pinned definition open. A
 * surface handed a current phase and asked to draw a rail has to guess the sequence, and the guess
 * is wrong for every repository that configured its own.
 *
 * Three states and no fourth. `done` is a phase the lifecycle considers complete, `current` is
 * where the work is, `pending` is everything after it. A phase that was skipped, reopened or is
 * awaiting approval is still *current* or *done* by its own status — this rail reports position,
 * not health, and the checklist is where health belongs.
 */
export function phaseRail(workflow) {
  const order = workflow?.phaseOrder ?? [];
  if (!order.length) return [];
  const currentIndex = order.indexOf(workflow.currentPhase ?? '');
  return order.map((id, index) => {
    const phase = workflow.phases?.[id] ?? {};
    /**
     * Status first, position second.
     *
     * A phase whose own status says approved is done even if it sits after the current one — which
     * happens on a reopen, and a rail that inferred purely from position would show completed work
     * as pending and invite someone to redo it.
     */
    const state = COMPLETE_STATUSES.has(phase.status) ? 'done'
      : (currentIndex >= 0 && index === currentIndex) ? 'current'
        : (currentIndex >= 0 && index < currentIndex) ? 'done' : 'pending';
    return { id, label: phase.label ?? id, state, status: phase.status ?? null };
  });
}

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
  // A display name is presentation, not identity. Two people called "Alex Smith" must never be
  // treated as the same submitter on a screen that decides whether an approval is theirs to make.
  const values = [candidate.login, candidate.email].filter(Boolean).map((value) => String(value).toLowerCase());
  return [actor.login, actor.email].filter(Boolean)
    .some((value) => values.includes(String(value).toLowerCase()));
}

function mayDecideApproval(workflow, phase, actor, submitted, fallbackAuthorities = null) {
  const policy = phase?.approvalPolicy ?? {};
  let match;
  try {
    match = matchApprovalAuthority(
      workflow?.resolution?.approvalAuthorities ?? fallbackAuthorities,
      policy,
      actor
    );
  } catch {
    // Legacy or malformed records do not confer authority by omission. The mutation command will
    // report the configuration defect if selected; Home merely avoids directing the wrong person
    // to a ceremony they cannot perform.
    return false;
  }
  if (!match.authorized) return false;
  return !actorMatches(actor, submitted?.actor) || policy.allowSelfApproval !== false;
}

/**
 * Which bucket, and why.
 *
 * `waiting-on-you` means the pinned approval authority admits this stable email/login and the
 * self-approval rule permits this exact submitter relationship. Missing or malformed authority is
 * fail-closed into `waiting-on-others`; Home never advertises a ceremony the reader cannot perform.
 */
function classify(workflow, { recovery, actor, approvalAuthorities = null }) {
  if (recovery?.status === 'pending' || recovery?.status === 'unreadable') {
    return { group: 'recovery-required', because: recovery.status === 'unreadable'
      ? 'publication.marker-unreadable' : 'publication.pending' };
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
    if (mayDecideApproval(workflow, phase, actor, submitted, approvalAuthorities)) {
      return { group: 'waiting-on-you', because: 'approval.you-are-authorized' };
    }
    return actorMatches(actor, submitted?.actor)
      ? { group: 'waiting-on-others', because: 'approval.you-submitted-it' }
      : { group: 'waiting-on-others', because: 'approval.requires-an-authorized-reviewer' };
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

function blockersOf(workflow, { recovery }) {
  const blockers = [];
  if (recovery?.status === 'pending') blockers.push('publication-pending');
  if (recovery?.status === 'unreadable') blockers.push('publication-marker-unreadable');
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
 * Actor identity is supplied by the host. Pending publication state is discovered here unless a
 * caller supplies an already-scanned set, so omission never acquires the accidental meaning "none".
 */
export async function workRecords(root, {
  definition = {}, portfolio = null, actor = null, pendingPublications = null, includeCompleted = false,
  repositoryId = null
} = {}) {
  const index = await buildRepositorySubjectIndex(root, { definition, portfolio });
  const items = [];

  // Recovery is durable repository state, so the shared record reader owns discovering it. An
  // injected set remains supported for bounded tests and callers that already performed the scan,
  // but omission can no longer silently mean "there are no interrupted publications".
  let pending = pendingPublications;
  if (pending == null) {
    const { inspectPendingPublication } = await import('../publication-pending.mjs');
    const discovered = await Promise.all(['story', 'initiative'].flatMap((kind) =>
      index.list(kind).map(async (subject) => {
        const recovery = await inspectPendingPublication(root, {
          kind, id: subject.id, migrate: false
        });
        return [subjectKey({ kind, id: subject.id }), recovery];
      })));
    pending = new Map(discovered);
  } else if (pending instanceof Set) {
    pending = new Map([...pending].map((key) => [validateSubjectKey(key), {
      status: 'pending', subject: { kind: String(key).split(':', 1)[0], id: String(key).slice(String(key).indexOf(':') + 1) }
    }]));
  }

  for (const kind of ['story', 'initiative']) {
    for (const subject of index.list(kind)) {
      const workflow = subject.state ?? {};
      const recovery = pending.get?.(subjectKey({ kind, id: subject.id })) ?? { status: 'absent' };
      const { group, because } = classify(workflow, {
        recovery,
        actor,
        approvalAuthorities: definition?.approvalAuthorities ?? portfolio?.approvalAuthorities ?? null
      });
      if (group === 'recently-completed' && !includeCompleted) continue;
      const phaseId = workflow.currentPhase ?? null;
      const phase = phaseId ? workflow.phases?.[phaseId] : null;

      items.push({
        kind,
        id: subject.id,
        title: workflow.workItem?.title ?? workflow.initiative?.title ?? subject.id,
        repository: subject.location?.repository ?? repositoryId,
        /** Stable repository identity and every branch that can select this governed subject. */
        repositoryId: repositoryId ?? subject.location?.repository ?? null,
        branch: subject.canonicalBranch ?? null,
        branches: [...(subject.branches ?? [])],
        phase: phaseId,
        phaseLabel: phase?.label ?? phaseId,
        generation: phase?.generation ?? 0,
        status: phase?.status ?? null,
        // Where this work sits in its own lifecycle, from the pinned definition `[UXH:REQ-050]`.
        rail: phaseRail(workflow),
        lastMaterialEvent: lastMaterialEvent(workflow),
        blockers: blockersOf(workflow, { recovery }),
        recovery: recovery.status === 'absent' ? null : {
          status: recovery.status,
          path: recovery.path ?? null,
          code: recovery.code ?? null
        },
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
