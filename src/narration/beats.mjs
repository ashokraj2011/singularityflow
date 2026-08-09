/**
 * One beat vocabulary, projected from the several the kernel actually keeps.
 *
 * A Story's past is recorded twice. `publicationProjections[].event` is the attested lifecycle
 * stream with a closed type list (`artifact-generated`, `phase-approved`, `work-completed`, …).
 * `workflow.history[]` is the operational log, snake_cased and far broader (`phase_generated`,
 * `work_interval_started`, `documents_added`, …). They overlap without agreeing: the same approval
 * appears in both, spelled differently, with different fields.
 *
 * Recap must not learn to read either. If it did, a third vocabulary would appear the first time
 * someone wanted a beat neither stream carried, and the renderer would slowly become the place
 * where "what happened" is decided. So this is the only translation layer, and `recap` consumes
 * beats — never a persistence structure.
 *
 * Nothing here writes. A beat is a projection of what the kernel already recorded.
 */

/** Lifecycle event type → beat kind. */
const LIFECYCLE_KINDS = Object.freeze({
  binding: 'story.started',
  'artifact-generated': 'generation.published',
  'approval-requested': 'phase.submitted',
  'phase-approved': 'phase.approved',
  'phase-rejected': 'phase.rejected',
  'workflow-reopened': 'story.reopened',
  'work-cancelled': 'story.cancelled',
  'work-completed': 'story.completed',
  'branch-linked': 'branch.attached',
  'evidence-recorded': 'evidence.recorded',
  'sequence-override': 'sequence.overridden',
  'configuration-changed': 'configuration.changed'
});

/** Operational history event → beat kind. Only events that are genuinely part of the story. */
const HISTORY_KINDS = Object.freeze({
  phase_generated: 'generation.published',
  phase_submitted: 'phase.submitted',
  phase_approved: 'phase.approved',
  phase_self_approved: 'phase.approved',
  phase_rejected: 'phase.rejected',
  workflow_reopened: 'story.reopened',
  work_cancelled: 'story.cancelled',
  child_branch_attached: 'branch.attached',
  documents_added: 'documents.added',
  sequence_gate_overridden: 'sequence.overridden',
  work_interval_started: 'interval.started',
  work_interval_reconciled: 'interval.reconciled',
  work_interval_closed: 'interval.closed',
  story_checks_recorded: 'checks.recorded',
  design_source_promoted: 'design.promoted',
  impact_invalidated: 'impact.invalidated'
});

/**
 * Which stream wins when both describe the same moment.
 *
 * The lifecycle stream is attested — it carries the commit the event landed in — so it is the
 * better witness. The operational log fills in what the lifecycle stream never recorded.
 */
const SOURCE_PRECEDENCE = Object.freeze({ lifecycle: 0, operational: 1 });

function text(value) {
  return value === undefined || value === null ? null : String(value);
}

function beat({ kind, at, phase = null, generation = null, actor = null, authority = null, detail = null, source }) {
  return Object.freeze({
    // Deterministic, content-derived, and deliberately built only from what both streams always
    // carry. Including `generation` here meant a published generation recorded as `1` by the
    // lifecycle stream and left null by the operational log produced two ids and survived
    // deduplication as two beats — the same moment, reported twice.
    id: [kind, at, phase ?? ''].join('|'),
    kind,
    at,
    phase,
    generation,
    actor,
    authority,
    detail,
    source: Object.freeze(source)
  });
}

function fromLifecycle(projections) {
  return (projections ?? []).flatMap((projection) => {
    const event = projection.event ?? projection;
    const kind = LIFECYCLE_KINDS[event?.type];
    // LifecycleEvent v1 calls these fields `createdAt` and `sourceCommit`. Keep the older aliases
    // as read-only compatibility for projections created before the event envelope was formalised.
    const at = event?.createdAt ?? event?.at;
    if (!kind || !at) return [];
    return [beat({
      kind,
      at,
      phase: text(event.phaseId),
      generation: event.generation ?? null,
      actor: event.actor ?? null,
      authority: text(event.authorityGroup),
      detail: null,
      source: {
        stream: 'lifecycle',
        eventId: text(event.eventId),
        commit: text(event.sourceCommit ?? projection.commit ?? event.commit)
      }
    })];
  });
}

function fromHistory(history) {
  return (history ?? []).flatMap((entry) => {
    const kind = HISTORY_KINDS[entry?.event];
    if (!kind || !entry?.at) return [];
    return [beat({
      kind,
      at: entry.at,
      phase: text(entry.phase),
      generation: entry.generation ?? null,
      actor: entry.actor ? { email: text(entry.actor) } : null,
      authority: null,
      detail: text(entry.detail),
      source: { stream: 'operational', eventId: null, commit: null }
    })];
  });
}

/**
 * Stable order: time, then a fixed precedence, then the id.
 *
 * Two beats can share a timestamp — an approval that completes a Story emits both in the same
 * second — and `Array.prototype.sort` gives no guarantee for equal keys across engines. Without the
 * tie-break the recap could differ between two machines reading identical history, which is exactly
 * the kind of instability that makes a governance narrative untrustworthy.
 */
function ordered(beats) {
  return [...beats].sort((a, b) => (
    a.at.localeCompare(b.at)
    || SOURCE_PRECEDENCE[a.source.stream] - SOURCE_PRECEDENCE[b.source.stream]
    || a.id.localeCompare(b.id)
  ));
}

/**
 * Normalized, deduplicated beats for a Story, oldest first.
 *
 * Deduplication keeps the better witness: where the attested lifecycle stream and the operational
 * log describe the same beat, the lifecycle one survives and contributes its commit, while any
 * detail only the operational entry carried is merged in rather than dropped.
 */
export function narrationBeats(workflow) {
  const merged = new Map();
  for (const candidate of ordered([...fromLifecycle(workflow?.publicationProjections), ...fromHistory(workflow?.history)])) {
    const existing = merged.get(candidate.id);
    if (!existing) { merged.set(candidate.id, candidate); continue; }
    merged.set(candidate.id, Object.freeze({
      ...existing,
      detail: existing.detail ?? candidate.detail,
      authority: existing.authority ?? candidate.authority,
      actor: existing.actor ?? candidate.actor,
      generation: existing.generation ?? candidate.generation
    }));
  }
  return Object.freeze(ordered([...merged.values()]));
}

export function beatKinds() {
  return Object.freeze([...new Set([...Object.values(LIFECYCLE_KINDS), ...Object.values(HISTORY_KINDS)])].sort());
}
