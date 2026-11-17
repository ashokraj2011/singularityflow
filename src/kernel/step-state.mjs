/**
 * SPEC-OSA v1.1 §3–§6: the one decision owner for a step [OSA:REQ-001, REQ-005]. `stepState(snapshot)` is pure: it reads a
 * bounded `StepSnapshot/v1` that trusted adapters assembled and returns a `StepDecision/v1`. It imports only its sibling
 * (docs/osa/kernel-location.md, AC-009): no files, Git, processes, network, model provider or host command. It returns
 * operation identifiers, inputs, logical targets and reason codes, never a shell string, skill name, question wording or
 * prompt [OSA:REQ-021]; host adapters render them (phase-mutation-contract.mjs `decisionRoutes`).
 */
import { versionNumbers, needsVersion, versionNeed, beingWritten, consumedOpeningMismatch, reopenedByReturn } from './step-versions.mjs';

export { versionNumbers, hasPublishedVersion, hasOpenVersion, currentVersionPublished, needsVersion, beingWritten,
  consumedByPublishedVersion, consumedOpeningMismatch, publishedVersionRecorded, explicitlyReopened, reopenedByReturn, versionNeed } from './step-versions.mjs';

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DECISION_SCHEMA_VERSION = 1;
/** Record families and versions the kernel admits (schemas/workflow.schema.json `schemaVersion`). */
export const RECORD_ADMISSION = Object.freeze({ 'story-workflow': Object.freeze({ min: 1, max: 13 }) });
export const STEP_STATES = Object.freeze(['not-started', 'writing', 'kernel-build', 'waiting', 'published', 'in-review', 'review-ready',
  'review-corrections', 'reopened', 'submitted', 'approved', 'paused', 'held', 'damaged', 'complete', 'cancelled', 'invalid']);
export const ACTION_KINDS = Object.freeze(['agent-work', 'person-consent', 'person-decision', 'person-approval', 'review', 'observe',
  'refresh', 'reconcile', 'none']);
export const OPERATIONS = Object.freeze(['open-version', 'author-version', 'build-version', 'publish-version', 'start-review',
  'review-version', 'submit-version', 'approve-step', 'decide', 'recover-operation', 'refresh-authority', 'refresh-facts',
  'takeover-writer', 'inspect', 'repair-version', 'provide-input', 'none']);
export const PRINCIPAL_KINDS = Object.freeze(['agent', 'human']);
export const ROLES = Object.freeze(['author', 'reviewer', 'approver', 'person']);
export const SOURCE_STATUSES = Object.freeze(['verified', 'not-created', 'missing', 'unavailable', 'stale', 'corrupt']);
/** The sources a decision needs, and the ones it may do without (an absent optional source is `unavailable`). */
export const REQUIRED_SOURCES = Object.freeze(['lifecycle', 'configuration']);
export const OPTIONAL_SOURCES = Object.freeze(['review', 'authority', 'working', 'execution']);
/** Authoring write categories. Review staging and execution outputs are separate capabilities, never these [REQ-013]. */
export const EDIT_CATEGORIES = Object.freeze(['step-artifacts', 'application']);
export const REVIEW_STATUSES = Object.freeze(['unavailable', 'not-created', 'pending', 'ready', 'correction-required', 'disposition-required']);
export const REASON_CODES = Object.freeze([
  'SNAPSHOT_VERSION_UNSUPPORTED', 'SNAPSHOT_SHAPE_INVALID', 'RECORD_VERSION_NOT_ADMITTED', 'SUBJECT_BINDING_MIXED',
  'SOURCE_UNAVAILABLE', 'SOURCE_STALE', 'SOURCE_MISSING', 'SOURCE_CORRUPT', 'GENERATION_COUNTER_INVALID',
  'OPENING_NOT_APPLICABLE', 'OPENING_AHEAD_OF_COUNTERS', 'STORY_CANCELLED', 'STORY_COMPLETE', 'STEP_DAMAGED',
  'PERMISSION_REVOKED', 'STEP_HELD', 'DECISION_PENDING', 'AMENDMENT_PAUSE', 'REVIEW_DISPOSITION_PENDING', 'STEP_SUBMITTED',
  'INITIAL_VERSION', 'WATERMARK_SUCCESSOR', 'VERSION_OPEN', 'KERNEL_BUILT', 'REWORK', 'AMENDMENT', 'REJECTED', 'AUTHOR_CONFLICT',
  'REVIEW_CORRECTIONS', 'REVIEW_PENDING', 'REVIEW_READY', 'REVIEW_UNAVAILABLE', 'NO_REVIEW_OWED', 'FUTURE_STEP',
  'APPROVED_STEP', 'CONSUMED_OPENING_MISMATCH', 'NOT_AUTHORING_TURN', 'NO_CHANGE_CAPABILITY', 'STEP_NOT_ACTIVE',
  'LEGACY_LOCAL_OPENING', 'OPENING_PENDING', 'OPENING_UNKNOWN', 'OPENING_REFUSED', 'OPENING_UNOBSERVED', 'WRITER_FENCED', 'CONSENT_REQUIRED',
  'TASK_RUNNING', 'TASK_WAITING_INPUT', 'TASK_WAITING_ENVIRONMENT', 'TASK_WAITING_PERSON', 'TASK_REPAIR_REQUIRED', 'TASK_REPAIR_EXHAUSTED',
  'REVIEW_CORRECTIONS_WITHOUT_VERSIONS', 'TASK_PUBLICATION_PENDING', 'CHANGE_REQUESTED'
]);
/**
 * A durable task's outcome (§8, plan section 5 "Task stages"): what the version being written waits for, as its task
 * record keeps it across turns, chats and laptops. `running` is an execution being observed; the four waits stop at a
 * named, recoverable boundary with the original code and resources, never a repetition of the same route.
 * `publication-pending`: the step's commit, made here, is sent as it is.
 */
export const TASK_OUTCOMES = Object.freeze(['running', 'waiting-input', 'waiting-environment', 'waiting-person', 'repair-required', 'publication-pending']);
/** An opening operation's shared acceptance as this checkout observed it (story-version-acceptance.mjs), and its writer. */
export const OPENING_ACCEPTANCE = Object.freeze(['confirmed', 'pending', 'unknown', 'refused', 'unobserved']);
export const OPENING_WRITERS = Object.freeze(['current', 'other']);

const BOUND = 256;
const text = (value) => value === null || value === undefined ? null : typeof value === 'string' && value.length <= BOUND ? value : undefined;
const BASIS_FIELDS = ['lifecycleRevision', 'authorityEpoch', 'configurationRevision', 'publicationDigest', 'reviewDigest',
  'openVersionReceiptId', 'workingObservationId', 'principalBinding', 'capabilityRevision', 'executionRevision'];

/** Every decision carries its basis: the revisions it was made on, how fresh they were, and accepted/working differences. */
function basisOf(snapshot) {
  const basis = Object.fromEntries(BASIS_FIELDS.map((field) => [field, text(snapshot?.basis?.[field]) ?? null]));
  const sources = Object.entries(snapshot?.sources ?? {}).map(([name, value]) => [name, value?.status]);
  const freshness = sources.some(([, status]) => status === 'stale') ? 'stale'
    : sources.some(([, status]) => status === 'unavailable') ? 'partial' : 'verified';
  const differences = (Array.isArray(snapshot?.differences) ? snapshot.differences : []).slice(0, 32)
    .map((entry) => ({ field: String(entry?.field ?? ''), state: ['same', 'differs', 'unknown'].includes(entry?.state) ? entry.state : 'unknown' }));
  return { ...basis, decisionSnapshotId: text(snapshot?.basis?.decisionSnapshotId) ?? null, freshness, differences };
}

function action(kind, operation, { target, principalKind = 'agent', role = 'author', inputs = {}, prerequisites = [], reasonCodes = [], then = [] }) {
  return { actionId: `${operation}:${target?.phase ?? 'story'}${target?.version ? `@${target.version}` : ''}`, kind, operation, inputs,
    target: target ?? null, principalKind, role, prerequisites, reasonCodes, then };
}

const NO_EDIT = (reasons) => ({ eligible: false, scopeReference: null, permittedCategories: [], reasons });

function decision(snapshot, state, next, { version = null, publication = null, edit = NO_EDIT([]), obligations = [], task = null } = {}) {
  const subject = snapshot?.subject ?? {};
  // An opening at a used number (a restored checkpoint leaves one) opens nothing: it is stated, never written into [§4.3].
  if (snapshot?.step && versionNumbers(snapshot.step).opening === 'superseded' && !next.reasonCodes.includes('OPENING_NOT_APPLICABLE')) {
    next = { ...next, reasonCodes: [...next.reasonCodes, 'OPENING_NOT_APPLICABLE'] };
  }
  const kind = snapshot?.step?.kind ?? {};
  return { schemaVersion: DECISION_SCHEMA_VERSION,
    subject: { projectId: text(subject.projectId) ?? null, workId: text(subject.workId) ?? null,
      requestedPhaseId: text(subject.requestedPhaseId) ?? null, currentPhaseId: text(subject.currentPhaseId) ?? null },
    basis: basisOf(snapshot),
    kind: { executionOwner: kind.executionOwner === 'kernel' ? 'kernel' : 'agent', changeCapabilities: capabilitiesOf(kind) },
    state,
    version: version ? { published: version.published, writing: version.writing, highWatermark: version.highWatermark, proposedNext: version.proposedNext }
      : { published: null, writing: null, highWatermark: null, proposedNext: null },
    publication: publication ?? { hasPublishedVersion: null, hasOpenVersion: null, currentVersionPublished: null },
    // `authoring`: the requested step is the current one and its version is being written (§4.3 `beingWritten`), whatever
    // this turn may write; `eligible` and `permittedCategories` say what may be written now.
    edit: { ...edit, authoring: Boolean(subject.requestedPhaseId && subject.requestedPhaseId === subject.currentPhaseId
      && beingWritten(snapshot?.step)) },
    next, obligations,
    task: task ?? { id: null, status: null, stage: null, progressReference: null, continuation: null },
    turn: { boundScope: { workId: text(subject.workId) ?? null, phaseId: text(subject.requestedPhaseId ?? subject.currentPhaseId) ?? null,
      version: version?.writing ?? version?.proposedNext ?? null, role: snapshot?.actor?.role ?? null },
      permittedEffects: edit.permittedCategories, endOnScopeChange: true } };
}

function capabilitiesOf(kind) {
  return (Array.isArray(kind?.changeCapabilities) ? kind.changeCapabilities : []).filter((entry) => EDIT_CATEGORIES.includes(entry));
}

/** An explicit error: never a plausible healthy state [§12.1]. The person inspects the step as it is. */
function invalid(snapshot, code, target = null) {
  return decision(snapshot, 'invalid', action('observe', 'inspect', { target, principalKind: 'human', role: 'person', reasonCodes: [code] }),
    { edit: NO_EDIT([code]) });
}

function shapeProblem(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'SNAPSHOT_SHAPE_INVALID';
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return 'SNAPSHOT_VERSION_UNSUPPORTED'; // schema-transient: never stored
  const { subject, step, story, actor } = snapshot;
  if (!subject || typeof subject.workId !== 'string' || !subject.workId || text(subject.workId) === undefined
      || [subject.requestedPhaseId, subject.currentPhaseId, subject.projectId].some((value) => text(value) === undefined)) return 'SNAPSHOT_SHAPE_INVALID';
  if (!story || !['active', 'complete', 'cancelled'].includes(story.status) || !Array.isArray(story.phaseOrder)
      || story.phaseOrder.length > 128 || story.phaseOrder.some((id) => typeof id !== 'string' || id.length > BOUND)) return 'SNAPSHOT_SHAPE_INVALID';
  if (!actor || !PRINCIPAL_KINDS.includes(actor.principalKind) || !ROLES.includes(actor.role) || typeof actor.turnMode !== 'string') return 'SNAPSHOT_SHAPE_INVALID';
  if (step && (typeof step.id !== 'string' || typeof step.status !== 'string')) return 'SNAPSHOT_SHAPE_INVALID';
  const admitted = RECORD_ADMISSION[snapshot.record?.family];
  if (!admitted || !Number.isSafeInteger(snapshot.record.version) || snapshot.record.version < admitted.min
      || snapshot.record.version > admitted.max) return 'RECORD_VERSION_NOT_ADMITTED';
  // Inputs from different Stories or steps are never combined silently [§4.1].
  if (step && step.id !== (subject.requestedPhaseId ?? subject.currentPhaseId)) return 'SUBJECT_BINDING_MIXED';
  if (snapshot.current && snapshot.current.id !== subject.currentPhaseId) return 'SUBJECT_BINDING_MIXED';
  if (subject.currentPhaseId && !story.phaseOrder.includes(subject.currentPhaseId)) return 'SUBJECT_BINDING_MIXED';
  return null;
}

/** The source facts, worst first: corruption is damage; unavailable, stale or missing is a refresh, never an empty record [§4.1]. */
function sourceProblem(snapshot) {
  const sources = snapshot.sources ?? {};
  for (const name of REQUIRED_SOURCES) {
    const status = sources[name]?.status;
    if (!SOURCE_STATUSES.includes(status)) return { name, code: 'SOURCE_UNAVAILABLE' };
  }
  for (const [name, value] of Object.entries(sources)) if (!SOURCE_STATUSES.includes(value?.status)) return { name, code: 'SOURCE_UNAVAILABLE' };
  const worst = (status) => Object.entries(sources).find(([name, value]) => value.status === status
    && (REQUIRED_SOURCES.includes(name) || status === 'corrupt'))?.[0];
  if (worst('corrupt')) return { name: worst('corrupt'), code: 'SOURCE_CORRUPT' };
  for (const [status, code] of [['missing', 'SOURCE_MISSING'], ['unavailable', 'SOURCE_UNAVAILABLE'], ['stale', 'SOURCE_STALE']]) {
    if (worst(status)) return { name: worst(status), code };
  }
  return null;
}

const published3 = (numbers) => ({ hasPublishedVersion: numbers.published >= 1, hasOpenVersion: numbers.writing !== null,
  currentVersionPublished: numbers.published >= 1 && numbers.writing === null });

/**
 * What an authoring turn may write in this state: the step's declared capabilities, narrowed by the state [§6]. A successor
 * grants nothing before its accepted opening: the person's yes and the shared opening come first [D3, OSA:REQ-030, REQ-031].
 */
function editFor(snapshot, state, numbers, target, { successor = false } = {}) {
  const facts = snapshot.step;
  if (snapshot.actor.turnMode !== 'authoring') return NO_EDIT(['NOT_AUTHORING_TURN']);
  if (successor) return NO_EDIT(['CONSENT_REQUIRED']);
  const code = facts.kind?.code === true;
  // Application edits in a code step need its version open; a document step's own declared source scope needs none.
  const permitted = capabilitiesOf(facts.kind).filter((entry) => entry !== 'application' || !code || numbers.writing !== null);
  if (!permitted.length) return NO_EDIT([facts.kind?.executionOwner === 'kernel' ? 'KERNEL_BUILT' : 'NO_CHANGE_CAPABILITY']);
  return { eligible: true, scopeReference: target, permittedCategories: permitted,
    reasons: [state === 'writing' || numbers.writing !== null ? 'VERSION_OPEN' : 'INITIAL_VERSION'] };
}

/**
 * An opening the opening operation made is written only once this checkout observed its shared acceptance and holds its
 * writer fence [§7.2, §7.3, OSA:REQ-031, REQ-033, REQ-034]: the reason it may not be yet, or null. An opening whose facts
 * carry no provenance (`record` absent) is the abstract accepted opening of §4.3.
 */
function openingHold(opening) {
  if (opening?.record !== 'operation') return null;
  if (opening.writer === 'other') return 'WRITER_FENCED';
  if (opening.writer !== 'current') return 'OPENING_UNOBSERVED';
  if (opening.acceptance === 'confirmed') return null;
  return { pending: 'OPENING_PENDING', unknown: 'OPENING_UNKNOWN', refused: 'OPENING_REFUSED' }[opening.acceptance] ?? 'OPENING_UNOBSERVED';
}

/**
 * The open version's task outcome as the next action, or null when the task is simply being written [§8]. `task`:
 * `{ id, outcome, code, input?, repairs: { used, budget } }` from the task record (workflow-task-outcome.mjs). A running execution
 * is observed and keeps the version's edits; a wait names the person's or environment's step; a repair runs within its
 * configured budget, and an exhausted budget is a person's decision with the evidence kept, never the same work again.
 */
function taskWait(task, target) {
  if (!task || !TASK_OUTCOMES.includes(task.outcome) || task.outcome === 'publication-pending') return null;
  const code = text(task.code) ?? null;
  const used = Number.isSafeInteger(task.repairs?.used) && task.repairs.used >= 0 ? task.repairs.used : 0;
  const budget = Number.isSafeInteger(task.repairs?.budget) && task.repairs.budget >= 0 ? task.repairs.budget : 0;
  const record = (status, next) => ({ id: text(task.id) ?? null, status, stage: text(task.stage) ?? null, progressReference: text(task.progressReference) ?? null,
    continuation: next.actionId });
  const make = (reason, next, edit = false) => ({ code: reason, next, edit, task: record(task.outcome, next) });
  if (task.outcome === 'running') return make('TASK_RUNNING', action('observe', 'inspect', { target, inputs: { task: 'execution' }, reasonCodes: ['TASK_RUNNING'] }), true);
  const input = text(task.input) ? { input: text(task.input) } : {};
  if (task.outcome === 'waiting-input') return make('TASK_WAITING_INPUT', action('person-decision', 'provide-input', { target, principalKind: 'human', role: 'person',
    inputs: { code, ...input }, reasonCodes: ['TASK_WAITING_INPUT'] }));
  if (task.outcome === 'waiting-environment' || task.outcome === 'waiting-person') {
    const reason = task.outcome === 'waiting-person' ? 'TASK_WAITING_PERSON' : 'TASK_WAITING_ENVIRONMENT';
    return make(reason, action('person-decision', 'decide', { target, principalKind: 'human', role: 'person',
      inputs: { decision: 'task-outcome', outcome: task.outcome, code, ...input }, reasonCodes: [reason] }));
  }
  // repair-required: within its budget the same step's work repairs it; past it, a person decides.
  if (used < budget) return make('TASK_REPAIR_REQUIRED', action('agent-work', 'repair-version', { target,
    inputs: { code, attempt: used + 1, budget }, reasonCodes: ['TASK_REPAIR_REQUIRED'], then: ['publish-version'] }), true);
  return make('TASK_REPAIR_EXHAUSTED', action('person-decision', 'decide', { target, principalKind: 'human', role: 'person',
    inputs: { decision: 'task-outcome', outcome: 'repair-exhausted', code, attempts: used }, reasonCodes: ['TASK_REPAIR_EXHAUSTED'] }));
}

/** What a hold may block [§5 4]: opening a version, or an open version's work up to its publication (submission: a prerequisite). */
const blockedEffect = (next) => ['open-version', 'build-version'].includes(next.operation) && next.inputs.consent !== 'given' ? 'opening'
  : ['author-version', 'build-version', 'repair-version', 'publish-version'].includes(next.operation) ? 'publication' : null;

/** The primary action of the Story's current step, for a decision about another step [§5 precedence 11]. */
function currentStepNext(snapshot) {
  if (!snapshot.current) return null;
  const inner = stepState({ ...snapshot, subject: { ...snapshot.subject, requestedPhaseId: snapshot.current.id }, step: snapshot.current, current: null });
  return inner.next;
}

/** `stepState(snapshot) → StepDecision/v1`, applying §5's precedence; every unresolved obligation stays listed. */
export function stepState(snapshot) {
  // 1. Scope, record families and required facts.
  const shape = shapeProblem(snapshot);
  if (shape) return invalid(snapshot, shape);
  const { subject, story, actor } = snapshot;
  const facts = snapshot.step;
  const targetOf = (phase, version = null) => ({ projectId: text(subject.projectId) ?? null, workId: subject.workId, phase, version });
  const source = sourceProblem(snapshot);
  if (source?.code === 'SOURCE_CORRUPT') return decision(snapshot, 'damaged',
    action('reconcile', 'recover-operation', { target: targetOf(subject.currentPhaseId), inputs: { source: source.name }, reasonCodes: ['SOURCE_CORRUPT'] }),
    { edit: NO_EDIT(['SOURCE_CORRUPT']) });
  if (source) return decision(snapshot, 'waiting',
    action('refresh', 'refresh-authority', { target: targetOf(subject.currentPhaseId), inputs: { source: source.name }, reasonCodes: [source.code] }),
    { edit: NO_EDIT([source.code]) });
  // 2. A cancelled or completed Story: historical inspection only.
  if (story.status === 'cancelled') return decision(snapshot, 'cancelled',
    action('none', 'none', { target: targetOf(null), principalKind: 'human', role: 'person', reasonCodes: ['STORY_CANCELLED'] }), { edit: NO_EDIT(['STORY_CANCELLED']) });
  if (story.status === 'complete' || !subject.currentPhaseId) return decision(snapshot, 'complete',
    action('none', 'none', { target: targetOf(null), principalKind: 'human', role: 'person', reasonCodes: ['STORY_COMPLETE'] }), { edit: NO_EDIT(['STORY_COMPLETE']) });
  if (!facts) return invalid(snapshot, 'SNAPSHOT_SHAPE_INVALID', targetOf(subject.currentPhaseId));
  const numbers = versionNumbers(facts);
  if (!numbers.ok) return invalid(snapshot, numbers.code, targetOf(facts.id));
  if (numbers.opening === 'ahead' || numbers.opening === 'invalid') return invalid(snapshot, 'OPENING_AHEAD_OF_COUNTERS', targetOf(facts.id));
  const version = { published: numbers.published, writing: numbers.writing, highWatermark: numbers.highWatermark, proposedNext: numbers.proposedNext };
  const publication = published3(numbers);
  const base = { version, publication };
  // Another step than the current one: inspect it, and route to the current step's action [§4.2 target, §5 11].
  if (facts.id !== subject.currentPhaseId) {
    const next = currentStepNext(snapshot) ?? action('observe', 'inspect', { target: targetOf(subject.currentPhaseId), principalKind: 'human', role: 'person' });
    const state = facts.status === 'approved' ? 'approved' : 'not-started';
    return decision(snapshot, state, next, { ...base, edit: NO_EDIT([state === 'approved' ? 'APPROVED_STEP' : 'FUTURE_STEP']) });
  }
  const target = (versionNumber) => targetOf(facts.id, versionNumber);
  // 3. Positive damage or an interrupted operation: reconcile it before anything that could repeat an effect.
  const damaged = facts.damage?.code ? facts.damage.code
    : facts.kind?.code && consumedOpeningMismatch(facts) ? 'CONSUMED_OPENING_MISMATCH' : null;
  if (damaged) return decision(snapshot, 'damaged',
    action('reconcile', 'recover-operation', { target: target(numbers.published || null), inputs: { damage: damaged }, reasonCodes: ['STEP_DAMAGED', damaged] }),
    { ...base, edit: NO_EDIT(['STEP_DAMAGED']) });
  // An interrupted publication: its retained commit is sent before anything could write or publish again [REQ-033].
  const pending = facts.task?.outcome === 'publication-pending' ? facts.task : null;
  if (pending) {
    const next = action('reconcile', 'publish-version', { target: target(numbers.writing ?? (numbers.published || null)),
      inputs: { pending: true, code: text(pending.code) ?? null, commit: text(pending.commit) ?? null }, reasonCodes: ['TASK_PUBLICATION_PENDING'] });
    return decision(snapshot, 'waiting', next, { ...base, edit: NO_EDIT(['TASK_PUBLICATION_PENDING']),
      task: { id: text(pending.id) ?? null, status: 'publication-pending', stage: text(pending.stage) ?? null, progressReference: null, continuation: next.actionId } });
  }
  // 4. Authorization, ownership and holds that stop authoring name their owner and resolution.
  if (actor.permissionsRevoked === true) return decision(snapshot, 'held',
    action('refresh', 'refresh-authority', { target: target(numbers.writing), principalKind: 'human', role: 'person', reasonCodes: ['PERMISSION_REVOKED'] }),
    { ...base, edit: NO_EDIT(['PERMISSION_REVOKED']) });
  const holds = (Array.isArray(facts.holds) ? facts.holds : []).slice(0, 16);
  const blocking = holds.find((hold) => (hold?.blocks ?? []).includes('authoring'));
  if (blocking) return decision(snapshot, 'held',
    action(blocking.owner === 'agent' ? 'agent-work' : 'person-decision', OPERATIONS.includes(blocking.resolution) ? blocking.resolution : 'decide',
      { target: target(numbers.writing), principalKind: blocking.owner === 'agent' ? 'agent' : 'human', role: blocking.owner === 'agent' ? 'author' : 'person',
        inputs: { hold: String(blocking.code ?? 'STEP_HELD') }, reasonCodes: ['STEP_HELD', String(blocking.code ?? 'STEP_HELD')] }),
    { ...base, edit: NO_EDIT(['STEP_HELD']) });
  const obligations = holds.filter((hold) => hold !== blocking).map((hold) => ({ code: String(hold?.code ?? 'STEP_HELD'), blocks: hold?.blocks ?? [],
    owner: hold?.owner === 'agent' ? 'agent' : 'human', resolution: OPERATIONS.includes(hold?.resolution) ? hold.resolution : 'decide',
    ...(text(hold?.id) ? { id: hold.id } : {}) }));
  // A hold leads the opening or publishing it blocks, then that action; edits stay as the state gives them (owner,
  // 2026-11-17: an approved amendment is acknowledged before the person is asked to start a version).
  const lead = (state, next, rest) => {
    const effect = blockedEffect(next), hold = obligations.find((entry) => entry.blocks.includes(effect));
    return hold ? decision(snapshot, 'held', action(hold.owner === 'agent' ? 'agent-work' : 'person-decision', hold.resolution, { target: target(numbers.writing),
      principalKind: hold.owner === 'agent' ? 'agent' : 'human', role: hold.owner === 'agent' ? 'author' : 'person',
      inputs: { hold: hold.code, id: hold.id, effect }, reasonCodes: ['STEP_HELD', hold.code], then: [next.operation] }), rest) : decision(snapshot, state, next, rest);
  };
  // 5. A human decision that pauses authoring.
  if (story.pendingDecision || facts.pause) return decision(snapshot, 'paused',
    action('person-decision', 'decide', { target: target(numbers.writing), principalKind: 'human', role: 'person',
      inputs: { decision: story.pendingDecision ? 'story-decision' : 'intent-amendment', id: text(story.pendingDecision?.id ?? facts.pause?.id) ?? null },
      reasonCodes: [story.pendingDecision ? 'DECISION_PENDING' : 'AMENDMENT_PAUSE'] }), { ...base, edit: NO_EDIT([story.pendingDecision ? 'DECISION_PENDING' : 'AMENDMENT_PAUSE']), obligations });
  // 6. A submitted version waits for its approval; the authoring command cannot roll it over.
  if (facts.status === 'awaiting_approval') return decision(snapshot, 'submitted',
    action('person-approval', 'approve-step', { target: target(numbers.published), principalKind: 'human', role: 'approver', reasonCodes: ['STEP_SUBMITTED'] }),
    { ...base, edit: NO_EDIT(['STEP_SUBMITTED']), obligations });
  if (facts.status === 'approved') return decision(snapshot, 'approved',
    action('none', 'none', { target: target(numbers.published), principalKind: 'human', role: 'person', reasonCodes: ['APPROVED_STEP'] }), { ...base, edit: NO_EDIT(['APPROVED_STEP']) });
  if (facts.status !== 'in_progress') return decision(snapshot, 'not-started',
    action('observe', 'inspect', { target: target(null), principalKind: 'human', role: 'person', reasonCodes: ['STEP_NOT_ACTIVE'] }), { ...base, edit: NO_EDIT(['STEP_NOT_ACTIVE']) });
  const kernelBuilt = facts.kind?.executionOwner === 'kernel';
  const reviewRequired = facts.review?.required === true;
  const after = (open) => [...(open ? ['author-version'] : []), 'publish-version', ...(reviewRequired ? ['start-review'] : ['submit-version'])];
  // 7–8. No accepted version open and none published: the initial version, which needs no successor consent unless an
  // earlier reservation used its number. Then an accepted open version, which is written now.
  const successor = numbers.published >= 1 ? versionNeed(facts) : null;
  // A local opening no operation made (an older build's working-copy intent) opens a successor only once it is promoted
  // through the opening operation, with the person's yes; until then it grants nothing [§14, OSA:REQ-030, REQ-031].
  if (numbers.writing !== null && numbers.writing > 1 && facts.opening?.record === 'legacy') {
    return lead('reopened', action('person-consent', kernelBuilt ? 'build-version' : 'open-version', { target: target(numbers.writing),
      principalKind: 'human', inputs: { ...(kernelBuilt ? { producer: 'deterministic' } : {}), version: numbers.writing, consent: 'required',
        reason: 'legacy-promotion', from: numbers.published, opening: 'promotion' },
      reasonCodes: ['LEGACY_LOCAL_OPENING', ...(kernelBuilt ? ['KERNEL_BUILT'] : [])], then: kernelBuilt ? ['publish-version'] : after(true) }),
    { ...base, edit: NO_EDIT(['LEGACY_LOCAL_OPENING']), obligations });
  }
  // An opening the operation made: written only once accepted on the shared authority and held by this checkout's writer.
  // A view that observed nothing of it (`turnMode: 'view'`, no acceptance or writer given) names its writing, as an
  // advisory decision with its basis [§4.1]: it grants nothing, and the work command's entry observes the opening before
  // any write and reconciles an uncertain one [OSA:REQ-031, REQ-041].
  const advisory = actor.turnMode === 'view' && facts.opening?.record === 'operation' && facts.opening.acceptance === undefined && facts.opening.writer === undefined;
  const held = numbers.writing !== null && !advisory ? openingHold(facts.opening) : null;
  if (held === 'WRITER_FENCED') return lead('held', action('person-decision', 'takeover-writer', { target: target(numbers.writing),
    principalKind: 'human', role: 'person', inputs: { version: numbers.writing, fence: facts.opening.fence ?? null }, reasonCodes: ['STEP_HELD', 'WRITER_FENCED'] }),
  { ...base, edit: NO_EDIT(['WRITER_FENCED']), obligations });
  // A lost or uncertain shared acceptance is reconciled as the same operation, never replaced by another version [REQ-033].
  if (held) return lead('waiting', action('reconcile', 'recover-operation', { target: target(numbers.writing),
    inputs: { operation: 'version-opening', version: numbers.writing, operationId: text(facts.opening.operationId) ?? null }, reasonCodes: [held] }),
  { ...base, edit: NO_EDIT([held]), obligations });
  // 8. The open version's task, as its durable record keeps it: an execution is observed, a wait names its exact
  // continuation, and a repair runs only within its budget [§8, OSA:REQ-012, REQ-051].
  const waiting = numbers.writing !== null ? taskWait(facts.task, target(numbers.writing)) : null;
  if (waiting) return lead('waiting', waiting.next, { ...base, edit: waiting.edit ? editFor(snapshot, 'writing', numbers, target(numbers.writing)) : NO_EDIT([waiting.code]),
    obligations, task: waiting.task });
  if (numbers.writing !== null) {
    if (kernelBuilt) return lead('kernel-build', action('agent-work', 'build-version', { target: target(numbers.writing),
      inputs: { producer: 'deterministic', version: numbers.writing, consent: 'given' }, reasonCodes: ['KERNEL_BUILT', 'VERSION_OPEN'], then: ['publish-version'] }),
    { ...base, edit: editFor(snapshot, 'kernel-build', numbers, target(numbers.writing)), obligations });
    return lead('writing', action('agent-work', 'author-version', { target: target(numbers.writing),
      inputs: { version: numbers.writing, ...(numbers.published >= 1 ? { from: numbers.published } : {}) },
      reasonCodes: ['VERSION_OPEN', ...(advisory ? ['OPENING_UNOBSERVED'] : [])], then: after(false) }),
    { ...base, edit: editFor(snapshot, 'writing', numbers, target(numbers.writing)), obligations });
  }
  // A published step with no version open whose execution still runs (a submission's tests under the Story's lease) is
  // observed, never submitted, reviewed or opened again meanwhile; it writes nothing [§5 `waiting`, §8, OSA:REQ-051].
  const executing = numbers.published >= 1 && facts.task?.outcome === 'running' ? taskWait(facts.task, target(numbers.published)) : null;
  if (executing) return lead('waiting', executing.next, { ...base, edit: NO_EDIT([executing.code]), obligations, task: executing.task });
  if (numbers.published === 0 && needsVersion(facts)) {
    const initial = numbers.proposedNext === 1;
    const consent = initial ? 'not-required' : 'required';
    const reasonCodes = [initial ? 'INITIAL_VERSION' : 'WATERMARK_SUCCESSOR'];
    if (kernelBuilt) return lead('kernel-build', action(initial ? 'agent-work' : 'person-consent', 'build-version', { target: target(numbers.proposedNext),
      principalKind: initial ? 'agent' : 'human', inputs: { producer: 'deterministic', version: numbers.proposedNext, consent },
      reasonCodes: [...reasonCodes, 'KERNEL_BUILT'], then: ['publish-version'] }), { ...base, edit: editFor(snapshot, 'kernel-build', numbers, target(numbers.proposedNext), { successor: !initial }), obligations });
    return lead('not-started', action(initial ? 'agent-work' : 'person-consent', 'open-version', { target: target(numbers.proposedNext),
      principalKind: initial ? 'agent' : 'human', inputs: { version: numbers.proposedNext, consent, reason: initial ? 'initial' : 'watermark' }, reasonCodes, then: after(true) }),
    { ...base, edit: editFor(snapshot, 'not-started', numbers, target(numbers.proposedNext), { successor: !initial }), obligations });
  }
  // A published step a person's return, an amendment or a rejection reopened: its successor needs the person's yes [D3].
  if (successor) {
    const reopenedBy = reopenedByReturn(facts) ? 'return' : 'successor-preview';
    const inputs = { version: numbers.proposedNext, consent: 'required', reason: successor.toLowerCase().replaceAll('_', '-'), from: numbers.published, opening: reopenedBy };
    if (kernelBuilt) return lead('kernel-build', action('person-consent', 'build-version', { target: target(numbers.proposedNext), principalKind: 'human',
      inputs: { producer: 'deterministic', ...inputs }, reasonCodes: [successor, 'KERNEL_BUILT'], then: ['publish-version'] }),
    { ...base, edit: editFor(snapshot, 'kernel-build', numbers, target(numbers.proposedNext), { successor: true }), obligations });
    // Nothing of the step is written before the person's yes and the accepted opening [D3, OSA:REQ-030].
    return lead('reopened', action('person-consent', 'open-version', { target: target(numbers.proposedNext), principalKind: 'human',
      inputs, reasonCodes: [successor, 'CONSENT_REQUIRED'], then: after(true) }),
    { ...base, edit: editFor(snapshot, 'reopened', numbers, target(numbers.proposedNext), { successor: true }), obligations });
  }
  if (numbers.published === 0) return lead('published',
    action('agent-work', 'submit-version', { target: target(0), reasonCodes: ['NO_REVIEW_OWED'] }), { ...base, edit: NO_EDIT(['NO_REVIEW_OWED']), obligations });
  // A change the person typed for the published version asks for its next one first, on their yes [D3, daily run 2026-11-17].
  if (facts.changeRequested === true) return lead('published', action('person-consent', 'open-version', { target: target(numbers.proposedNext),
    principalKind: 'human', inputs: { version: numbers.proposedNext, consent: 'required', reason: 'change-requested', from: numbers.published,
      opening: 'successor-preview' }, reasonCodes: ['CHANGE_REQUESTED', 'CONSENT_REQUIRED'], then: after(true) }),
  { ...base, edit: editFor(snapshot, 'published', numbers, null, { successor: true }), obligations });
  // 9–10. A current publication with no open successor: its review, its corrections, or its submission.
  const submitPrerequisites = obligations.filter((entry) => entry.blocks.includes('submission'))
    .map((entry) => ({ operation: entry.resolution, principalKind: entry.owner, code: entry.code, ...(entry.id ? { id: entry.id } : {}) }));
  const review = facts.review ?? { required: false };
  if (review.required) {
    const status = REVIEW_STATUSES.includes(review.status) ? review.status : 'unavailable';
    // A review of another version than the published one is not this version's review.
    const stale = Number.isSafeInteger(review.version) && review.version !== numbers.published;
    if (status === 'unavailable') return lead('published', action('refresh', 'refresh-facts', { target: target(numbers.published),
      inputs: { source: 'review' }, reasonCodes: ['REVIEW_UNAVAILABLE'] }), { ...base, edit: NO_EDIT(['REVIEW_UNAVAILABLE']), obligations });
    // A step that takes no versions cannot open a successor for its corrections: a person decides what the review left.
    if (status === 'correction-required' && !stale && facts.versionRequired === false) return lead('paused', action('person-decision', 'decide',
      { target: target(numbers.published), principalKind: 'human', role: 'person', inputs: { decision: 'review-disposition' }, reasonCodes: ['REVIEW_CORRECTIONS_WITHOUT_VERSIONS'] }),
    { ...base, edit: NO_EDIT(['REVIEW_CORRECTIONS_WITHOUT_VERSIONS']), obligations });
    if (status === 'correction-required' && !stale) return lead('review-corrections', action('person-consent', 'open-version',
      { target: target(numbers.proposedNext), principalKind: 'human', inputs: { version: numbers.proposedNext, consent: 'required', reason: 'review-corrections',
        from: numbers.published, opening: 'successor-preview' }, reasonCodes: ['REVIEW_CORRECTIONS'], then: after(true) }),
    { ...base, edit: NO_EDIT(['REVIEW_CORRECTIONS']), obligations });
    if (status === 'disposition-required' && !stale) return lead('paused', action('person-decision', 'decide',
      { target: target(numbers.published), principalKind: 'human', role: 'person', inputs: { decision: 'review-disposition' }, reasonCodes: ['REVIEW_DISPOSITION_PENDING'] }),
    { ...base, edit: NO_EDIT(['REVIEW_DISPOSITION_PENDING']), obligations });
    if (status === 'ready' && !stale) return lead('review-ready', action('agent-work', 'submit-version',
      { target: target(numbers.published), prerequisites: submitPrerequisites, reasonCodes: ['REVIEW_READY'] }), { ...base, edit: NO_EDIT(['REVIEW_READY']), obligations });
    return lead('in-review', action('review', 'start-review', { target: target(numbers.published), role: 'reviewer',
      reasonCodes: ['REVIEW_PENDING'] }), { ...base, edit: NO_EDIT(['REVIEW_PENDING']), obligations });
  }
  return lead('published', action('agent-work', 'submit-version', { target: target(numbers.published),
    prerequisites: submitPrerequisites, reasonCodes: ['NO_REVIEW_OWED'] }), { ...base, edit: NO_EDIT(['NO_REVIEW_OWED']), obligations });
}

/**
 * Whether a run of decisions made progress [OSA:AC-012]: the same action on an unchanged basis, taken again, is a loop.
 * Not a loop: observing a running task (its execution is the progress), a declared wait for a person (the decision says
 * what it waits for) and an idempotent acknowledgement (the caller marks it: repeating it changes nothing and asks for nothing).
 * `steps`: `[{ decision, basisKey, acknowledgement }]` in the order they were taken; `basisKey` is the caller's digest of
 * the facts the decision was made on. Returns `{ loop: false }` or `{ loop: true, first, repeated, actionId }`.
 */
export function noProgress(steps) {
  const seen = new Map();
  for (const [index, entry] of (Array.isArray(steps) ? steps : []).entries()) {
    const next = entry?.decision?.next;
    if (!next?.actionId) continue;
    // A wait for a person is declared; the agent's own repair or retry on an unchanged basis is not.
    const legitimate = next.kind === 'observe' || (entry.decision.state === 'waiting' && next.principalKind === 'human') || entry.acknowledgement === true;
    const key = `${next.actionId}|${String(entry.basisKey ?? '')}`;
    if (seen.has(key) && !legitimate) return { loop: true, first: seen.get(key), repeated: index, actionId: next.actionId };
    if (!seen.has(key)) seen.set(key, index);
  }
  return { loop: false };
}
