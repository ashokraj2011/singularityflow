/**
 * The six payload shapes the guided journeys return. `[INT:IFC-082]` `[INT:IFC-083]` `[INT:REQ-178]`
 * `[INT:CON-177]` `[INT:CON-181]` `[INT:REQ-189]`
 *
 * These sit inside `sflow-result.data`. They are here, together and ahead of the journeys that
 * produce them, because each one encodes a *refusal* the journey would otherwise have to remember:
 * a lineage edge that cannot cite its evidence, a comparison that quietly interprets, a draft that
 * forgets it is not governed, a watch that decides something is true, a metric that stores a
 * conversation. Written as constructors, forgetting is not available.
 *
 * The recurring move is to make the dangerous case *expensive to express* rather than documented as
 * forbidden. An unsupported lineage claim is not rejected — it is admitted as a hypothesis and
 * labelled, because the honest form has to be easier to produce than the dishonest one or nobody
 * will produce it.
 */
import { SingularityFlowError } from '../util.mjs';

export const JOURNEY_SCHEMA_VERSION = 1;

function reject(code, detail, details = {}) {
  throw new SingularityFlowError(detail, { code, details });
}

const requireField = (value, code, detail) => {
  if (value === undefined || value === null || value === '') reject(code, detail);
  return value;
};

// ---------------------------------------------------------------------------------------------
// Comparison `[INT:IFC-083]` `[INT:CON-183]`

/** Where a comparison's facts came from. Comparison reuses these; it never becomes a diff authority. */
export const COMPARISON_AUTHORITIES = Object.freeze(['git', 'build', 'artifact', 'clause', 'claim', 'reconciliation', 'impact']);

/**
 * A typed comparison of two exactly-resolved sides.
 *
 * `unchangedGuarantees` is the field that makes this useful rather than a diff with extra steps.
 * "These forty files changed" answers nothing a reader was asking; "the public interface and the
 * approved clauses did not move" answers most of it.
 */
export function comparisonReport({
  subjectKind, left, right, baseline = null,
  changedFacts = [], unchangedGuarantees = [], evidenceGaps = [],
  authorities = [], assisted = false
} = {}) {
  requireField(subjectKind, 'COMPARISON_INVALID', 'A comparison must say what kind of thing it compared.');
  for (const [name, side] of [['left', left], ['right', right]]) {
    if (!side?.id || !side?.revision) {
      reject('COMPARISON_INVALID', `The ${name} side must resolve to an exact revision.`, { side: name });
    }
  }
  for (const authority of authorities) {
    if (!COMPARISON_AUTHORITIES.includes(authority)) {
      reject('COMPARISON_INVALID', `'${authority}' is not an existing comparison authority.`, { authority });
    }
  }
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'comparison',
    subjectKind,
    left: Object.freeze({ id: left.id, revision: left.revision, label: left.label ?? left.id }),
    right: Object.freeze({ id: right.id, revision: right.revision, label: right.label ?? right.id }),
    baseline,
    changedFacts: Object.freeze([...changedFacts]),
    unchangedGuarantees: Object.freeze([...unchangedGuarantees]),
    evidenceGaps: Object.freeze([...evidenceGaps]),
    authorities: Object.freeze([...new Set(authorities)].sort()),
    /** Declared, always. "Was any of this a model's opinion" is not a question a reader should have to ask. */
    assisted: Boolean(assisted)
  });
}

// ---------------------------------------------------------------------------------------------
// Intent lineage `[INT:IFC-082]` `[INT:CON-182]`

export const LINEAGE_RELATIONSHIPS = Object.freeze([
  'implements', 'specifies', 'approves', 'requests-change', 'tests', 'reverts', 'builds', 'supersedes', 'references'
]);

/**
 * How much weight an edge can carry.
 *
 * `recorded` is a link something wrote down. `derived` is a link computed from two records that
 * each wrote down half of it. `hypothesis` is a link nobody wrote down — temporal proximity, a
 * commit message, a model's reading — and it is admitted rather than dropped, because a missing
 * link that a reader can see is more useful than a confident one that is wrong `[INT:CON-182]`.
 */
export const CONFIDENCE_CLASSES = Object.freeze(['recorded', 'derived', 'hypothesis']);

export function lineageEdge({ from, to, relationship, evidenceSource, revision, confidence, note = null } = {}) {
  requireField(from, 'LINEAGE_INVALID', 'A lineage edge must have a source node.');
  requireField(to, 'LINEAGE_INVALID', 'A lineage edge must have a target node.');
  if (!LINEAGE_RELATIONSHIPS.includes(relationship)) {
    reject('LINEAGE_INVALID', `'${relationship}' is not a lineage relationship.`, { relationship });
  }
  if (!CONFIDENCE_CLASSES.includes(confidence)) {
    reject('LINEAGE_INVALID', `'${confidence}' is not a confidence class.`, { confidence });
  }
  /**
   * A recorded or derived edge must cite something. Only a hypothesis may have no revision — which
   * is the definition of a hypothesis, and the reason it is labelled one.
   */
  if (confidence !== 'hypothesis' && (!evidenceSource || !revision)) {
    reject('LINEAGE_INVALID', `A ${confidence} edge must name its evidence source and exact revision.`, { from, to });
  }
  return Object.freeze({
    from, to, relationship, confidence,
    evidenceSource: evidenceSource ?? null,
    revision: revision ?? null,
    note
  });
}

export function lineageGraph({ subject, edges = [], missingLinks = [] } = {}) {
  requireField(subject?.id, 'LINEAGE_INVALID', 'A lineage graph must name its subject.');
  const resolved = edges.map((edge) => (edge?.relationship ? lineageEdge(edge) : reject('LINEAGE_INVALID', 'Malformed lineage edge.')));
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'intent-lineage',
    subject: Object.freeze({ ...subject }),
    edges: Object.freeze(resolved),
    /** Gaps stay in the payload. A graph that hides what it could not join looks complete. */
    missingLinks: Object.freeze([...missingLinks]),
    hypothesisCount: resolved.filter((edge) => edge.confidence === 'hypothesis').length
  });
}

// ---------------------------------------------------------------------------------------------
// Handoff packet `[INT:REQ-178]` `[INT:CON-175]`

const HANDOFF_SECTIONS = Object.freeze([
  'approvedIntent', 'currentPhase', 'legalNextAction', 'revisions', 'completedWork', 'remainingWork',
  'localChanges', 'tests', 'evidence', 'openQuestions', 'risks', 'reconstruction'
]);

/**
 * Everything the next person needs, as a projection of records rather than a summary of a chat.
 *
 * Every section is required, including the ones that are usually empty. "No open questions" is a
 * statement someone checked; an absent section is one nobody looked at, and the reader cannot tell
 * those apart after the fact.
 */
export function handoffPacket(sections = {}) {
  const packet = {};
  for (const section of HANDOFF_SECTIONS) {
    if (!(section in sections)) {
      reject('HANDOFF_INVALID', `A handoff packet must include '${section}', even when it is empty.`, { section });
    }
    packet[section] = sections[section];
  }
  if (!sections.revisions || !Object.keys(sections.revisions).length) {
    reject('HANDOFF_INVALID', 'A handoff packet must carry exact revisions; it is a projection, not a description.');
  }
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'handoff-packet',
    ...packet,
    revisions: Object.freeze({ ...sections.revisions }),
    /** Never lifecycle authority. Sharing it goes through the evidence ceremony `[INT:CON-176]`. */
    authority: 'projection-only'
  });
}

// ---------------------------------------------------------------------------------------------
// Personal draft `[INT:CON-177]`

/** The label is part of the record, not a rendering choice a surface can forget. */
export const PERSONAL_DRAFT_LABEL = 'Not governed';

export function personalDraft({ id, ownerId, label, content = {}, createdAt } = {}) {
  requireField(id, 'DRAFT_INVALID', 'A draft needs an ID.');
  requireField(ownerId, 'DRAFT_INVALID', 'A draft is identity-scoped and needs an owner.');
  requireField(label, 'DRAFT_INVALID', 'A draft needs a label its owner will recognise.');
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'personal-draft',
    id,
    ownerId,
    label,
    content: Object.freeze({ ...content }),
    createdAt: createdAt ?? null,
    governed: false,
    displayLabel: PERSONAL_DRAFT_LABEL,
    /**
     * These three are stored rather than assumed, so a planner that reads a draft has to read a
     * `false` and decide to ignore it, instead of never having been told.
     */
    eligibleForApproval: false,
    visibleToLifecyclePlanners: false,
    canSupplyApprovedInputs: false
  });
}

/** Adoption is a governed work-start plan, not a flag flip `[INT:CON-177]`. */
export function assertDraftNotUsedAsInput(draft) {
  if (draft?.kind === 'personal-draft') {
    reject('DRAFT_NOT_GOVERNED',
      `'${draft.label}' is a personal draft and cannot supply approved inputs. Adopt it through a work-start plan first.`,
      { draftId: draft.id });
  }
  return draft;
}

// ---------------------------------------------------------------------------------------------
// Watch `[INT:CON-181]` `[INT:REQ-183]`

export const WATCH_PREDICATES = Object.freeze([
  'phase-advanced', 'approval-decided', 'publication-completed', 'publication-failed',
  'build-completed', 'investigation-concluded', 'recovery-required', 'work-assigned'
]);

/**
 * A watch is a typed subscription to a kernel or provider event, and nothing more.
 *
 * The three things it explicitly is not — a poll, an agent, or a model deciding a condition was met
 * `[INT:CON-181]` — are all the same failure wearing different clothes: something other than the
 * event source concluding that the event happened.
 */
export function watchSubscription({ id, ownerId, predicate, subject, createdAt = null } = {}) {
  requireField(id, 'WATCH_INVALID', 'A watch needs an ID.');
  requireField(ownerId, 'WATCH_INVALID', 'A watch is identity-scoped and needs an owner.');
  if (!WATCH_PREDICATES.includes(predicate)) {
    reject('WATCH_INVALID', `'${predicate}' is not a watchable predicate.`, { predicate, known: [...WATCH_PREDICATES] });
  }
  if (!subject?.kind || !subject?.id) reject('WATCH_INVALID', 'A watch must name an exact subject.');
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'watch',
    id,
    ownerId,
    predicate,
    subject: Object.freeze({ kind: subject.kind, id: subject.id }),
    createdAt,
    delivery: 'event-driven',
    revocable: true,
    authoritative: false
  });
}

/**
 * A notification names the event that fired it, and carries no action.
 *
 * Legal next actions are recomputed when the notification is opened `[INT:REQ-183]`, because a
 * button embedded at send time is a button that acts on a world that has since moved — and a
 * notification is precisely the message that gets opened late.
 */
export function watchNotification({ watchId, eventId, subject, changed, occurredAt } = {}) {
  requireField(watchId, 'WATCH_NOTIFICATION_INVALID', 'A notification must name its watch.');
  requireField(eventId, 'WATCH_NOTIFICATION_INVALID', 'A notification must name the event that triggered it.');
  requireField(changed, 'WATCH_NOTIFICATION_INVALID', 'A notification must say what changed.');
  if (!subject?.kind || !subject?.id) reject('WATCH_NOTIFICATION_INVALID', 'A notification must name an exact subject.');
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'watch-notification',
    watchId,
    eventId,
    subject: Object.freeze({ kind: subject.kind, id: subject.id }),
    changed,
    occurredAt: occurredAt ?? null,
    nextActions: null,
    recomputeNextActionsOnOpen: true
  });
}

// ---------------------------------------------------------------------------------------------
// Experience metrics `[INT:REQ-189]` `[INT:CON-187]` `[INT:CON-188]` `[INT:CON-189]`

export const EXPERIENCE_METRICS = Object.freeze([
  'timeToFirstUsefulAction', 'sessionsWithoutCommandKnowledge', 'clarificationRate', 'repairRate',
  'wrongContextCorrections', 'plansAbandonedBeforeConfirmation', 'readinessBlockersResolved',
  'contextTokensSelected', 'contextTokensReused', 'contextTokensAvoided',
  'investigationConclusionClasses', 'handoffReconstructionSuccess', 'unsafeIntentsRefusedOrCeremonied'
]);

/** Things a metrics record must never contain, checked rather than asked for `[INT:CON-187]`. */
const FORBIDDEN_METRIC_FIELDS = Object.freeze([
  'conversation', 'transcript', 'excerpt', 'sourceText', 'receipt', 'confirmationValue', 'secret', 'reasoning'
]);

export function experienceMetrics(values = {}) {
  const unknown = Object.keys(values).filter((key) => !EXPERIENCE_METRICS.includes(key));
  if (unknown.length) reject('METRICS_INVALID', `Unknown experience metrics: ${unknown.join(', ')}.`, { unknown });
  const leaking = Object.keys(values).filter((key) => FORBIDDEN_METRIC_FIELDS.includes(key));
  if (leaking.length) reject('METRICS_FORBIDDEN', `Experience metrics must not carry ${leaking.join(', ')}.`, { leaking });
  const missing = EXPERIENCE_METRICS.filter((metric) => !(metric in values));
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'experience-metrics',
    values: Object.freeze({ ...values }),
    /** An unmeasured metric is reported as unmeasured, not omitted into looking like a zero. */
    unmeasured: Object.freeze(missing),
    /** `[INT:CON-189]`, carried in the record so a consumer cannot claim it did not know. */
    permittedUses: Object.freeze(['product-improvement', 'release-reporting']),
    forbiddenUses: Object.freeze([
      'weakening-safety-friction', 'ranking-approval-verdicts', 'evaluating-individuals', 'granting-authorization'
    ])
  });
}

/**
 * A token-savings claim, with the baseline it is a saving against. `[INT:CON-188]`
 *
 * "We saved 60%" is not a claim until it says sixty percent of what. The whole-context baseline is
 * required, cache reuse is separated from genuine avoidance, and the tokenizer's limitations travel
 * with the number rather than living in a footnote nobody copies.
 */
export function tokenSavingsClaim({ wholeContextBaseline, selected, cacheReused = 0, tokenizer, limitations } = {}) {
  if (!Number.isInteger(wholeContextBaseline) || wholeContextBaseline <= 0) {
    reject('METRICS_INVALID', 'A token-savings claim requires a declared whole-context baseline.');
  }
  if (!Number.isInteger(selected) || selected < 0) reject('METRICS_INVALID', 'A token-savings claim requires the selected context size.');
  requireField(tokenizer, 'METRICS_INVALID', 'A token-savings claim must name its tokenizer.');
  requireField(limitations, 'METRICS_INVALID', 'A token-savings claim must disclose its measurement limitations.');
  return Object.freeze({
    schemaVersion: JOURNEY_SCHEMA_VERSION,
    kind: 'token-savings',
    wholeContextBaseline,
    selected,
    cacheReused,
    avoided: Math.max(0, wholeContextBaseline - selected),
    tokenizer,
    limitations,
    exact: false
  });
}
