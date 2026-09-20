/**
 * Fail-closed orchestration for the internal REV kernels.
 *
 * This module deliberately exposes preview/confirm building blocks rather than a public command.
 * It never starts a provider, model, arbitrary process, or project command. Mutation is limited to
 * the existing private loop journal and the existing explicitly admitted manual Candidate freeze.
 */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { buildRevisionInterval } from './contracts.mjs';
import { buildRevisionPacket, verifyRevisionPacket } from './packet.mjs';
import { assertCurrentRevisionRoute, planRevisionRoute } from './router.mjs';
import {
  assertCurrentRevisionPrecheck, computeRevisionPrecheck
} from './precheck.mjs';
import {
  freezeManualRevisionCandidate, planManualRevisionCapture
} from './manual-capture.mjs';
import { verifyRevisionPublicationSelection } from './publication-selection.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/u;
const PLAN_BYTES_MAXIMUM = 512 * 1024;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function clone(value) {
  try { return structuredClone(value); }
  catch { fail('REV_ORCHESTRATION_INPUT', 'REV orchestration inputs must be structured-cloneable data.'); }
}
function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('REV_ORCHESTRATION_INPUT', `${label} must be a plain object.`);
  }
  return value;
}
function identifier(value, label) {
  if (!ID.test(String(value ?? ''))) fail('REV_ORCHESTRATION_INPUT', `${label} is invalid.`);
  return value;
}
function sha(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_ORCHESTRATION_INPUT', `${label} is invalid.`);
  return value;
}
function bounded(value, label) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); }
  catch { fail('REV_ORCHESTRATION_INPUT', `${label} must be bounded JSON data.`); }
  if (bytes > PLAN_BYTES_MAXIMUM) {
    fail('REV_ORCHESTRATION_LIMIT', `${label} exceeds the orchestration plan limit.`);
  }
  return value;
}
function selfHashedPlan(value, kind) {
  plain(value, 'orchestration plan');
  let selected;
  try { selected = readRecord('revision-orchestration-plan', value).record; }
  catch { fail('REV_ORCHESTRATION_PLAN_INVALID', `Expected an exact ${kind} plan.`); }
  if (selected.kind !== kind || !HASH.test(selected.planSha256)) {
    fail('REV_ORCHESTRATION_PLAN_INVALID', `Expected an exact ${kind} plan.`);
  }
  const { planSha256, ...core } = selected;
  if (hash(core) !== planSha256) {
    fail('REV_ORCHESTRATION_PLAN_INVALID', `${kind} failed its content hash.`);
  }
  bounded(selected, 'Orchestration plan');
  return selected;
}
function confirmed(plan, confirmation) {
  if (confirmation !== plan.planSha256) {
    fail('REV_ORCHESTRATION_CONFIRMATION_REQUIRED', 'Confirm the exact current orchestration plan digest.');
  }
}
function scopeOf(loopStore) {
  const scope = plain(loopStore?.scope, 'loop scope');
  identifier(scope.workId, 'Work ID');
  identifier(scope.phaseId, 'Phase ID');
  if (!Number.isSafeInteger(scope.phaseGeneration) || scope.phaseGeneration < 0) {
    fail('REV_ORCHESTRATION_INPUT', 'Phase generation is invalid.');
  }
  if (typeof loopStore.read !== 'function' || typeof loopStore.list !== 'function'
      || typeof loopStore.append !== 'function') {
    fail('REV_ORCHESTRATION_INPUT', 'A complete REV loop store is required.');
  }
  return clone(scope);
}
function exactContext(value) {
  plain(value, 'REV context');
  const keys = [
    'repositorySha256', 'headCommit', 'sourceTreeSha256', 'configSha256',
    'workflowSha256', 'approvedIntentSha256', 'routeContractSha256',
    'proofProfileSha256', 'editorDiskIndexBaselineSha256'
  ];
  if (Object.keys(value).sort().join('\0') !== keys.sort().join('\0')) {
    fail('REV_ORCHESTRATION_INPUT', 'REV context has missing or unknown authority fields.');
  }
  for (const key of keys) {
    if (key === 'headCommit') {
      if (!OID.test(String(value[key] ?? ''))) fail('REV_ORCHESTRATION_INPUT', 'REV HEAD is invalid.');
    } else sha(value[key], `REV context ${key}`);
  }
  return clone(value);
}
function exactProducer(value) {
  plain(value, 'REV producer');
  if (Object.keys(value).sort().join('\0')
      !== ['id', 'version', 'implementationSha256'].sort().join('\0')) {
    fail('REV_ORCHESTRATION_INPUT', 'REV producer has missing or unknown fields.');
  }
  identifier(value.id, 'REV producer ID');
  if (typeof value.version !== 'string' || !value.version.trim()
      || Buffer.byteLength(value.version) > 64) {
    fail('REV_ORCHESTRATION_INPUT', 'REV producer version is invalid.');
  }
  sha(value.implementationSha256, 'REV producer implementation');
  return clone(value);
}
function contextFromRead(value) {
  if (value?.status === 'ready') return exactContext(value.context);
  if (value?.status === 'unavailable') {
    fail(value.code ?? 'REV_CONTEXT_UNAVAILABLE', value.message ?? 'REV context is unavailable.');
  }
  return exactContext(value);
}
async function assertFreshContext(expected, readCurrentContext) {
  if (typeof readCurrentContext !== 'function') {
    fail('REV_CONTEXT_REQUIRED', 'A fresh REV context reader is required at confirmation.');
  }
  const actual = contextFromRead(await readCurrentContext());
  if (hash(actual) !== hash(expected)) {
    fail('REV_ORCHESTRATION_STALE', 'REV context changed after preview.');
  }
  return actual;
}
function candidateReference(value) {
  plain(value, 'Candidate reference');
  if (!['sgos-candidate', 'auto-candidate'].includes(value.family)
      || !CANDIDATE_ID.test(String(value.candidateId ?? ''))
      || !HASH.test(String(value.candidateSha256 ?? ''))
      || !HASH.test(String(value.retainedRecordSha256 ?? ''))
      || !OID.test(String(value.repository?.candidateTree ?? ''))) {
    fail('REV_PARENT_CANDIDATE_INVALID', 'An exact retained REV-compatible Candidate is required.');
  }
  return clone(value);
}
function candidateSummary(reference) {
  const selected = candidateReference(reference);
  return {
    candidateId: selected.candidateId,
    candidateSha256: selected.candidateSha256,
    candidateRefSha256: hash(selected),
    candidateTree: selected.repository.candidateTree
  };
}
async function assertVerifiedCandidate(reference, verifyCandidateReference) {
  if (typeof verifyCandidateReference !== 'function'
      || await verifyCandidateReference(clone(reference)) !== true) {
    fail('REV_PARENT_CANDIDATE_UNVERIFIED', 'The retained Candidate could not be independently verified.');
  }
}
function plan(kind, core) {
  const body = bounded({
    schemaVersion: currentSchemaVersion('revision-orchestration-plan'), kind, ...clone(core)
  }, 'Orchestration plan');
  return freezeDeep({ ...body, planSha256: hash(body) });
}
function appendRequest(value) {
  return {
    expectedRevision: value.expectedRevision,
    expectedHeadCandidateRefSha256: value.expectedHeadCandidateRefSha256,
    context: clone(value.context), idempotencyKey: value.idempotencyKey,
    transition: clone(value.transition)
  };
}

/** Deterministic route + packet preview. It has no storage or execution effect. */
export async function previewRevisionPacket({ routeInput, packetInput } = {}) {
  const routePlan = planRevisionRoute(clone(routeInput));
  const packet = await buildRevisionPacket({
    ...packetInput, routePlan, routeInput
  });
  return plan('revision-orchestration-packet-plan', { routePlan, packet });
}

/** Rebuild and reverify the exact previewed packet; still no provider or filesystem execution. */
export async function confirmRevisionPacket({
  plan: supplied, confirmation, routeInput, packetInput
} = {}) {
  const selected = selfHashedPlan(supplied, 'revision-orchestration-packet-plan');
  confirmed(selected, confirmation);
  assertCurrentRevisionRoute(selected.routePlan, routeInput);
  verifyRevisionPacket(selected.packet, {
    routePlan: selected.routePlan,
    attachmentSetSha256: selected.routePlan.attachmentSetSha256 ?? null
  });
  const current = await previewRevisionPacket({ routeInput, packetInput });
  if (current.planSha256 !== selected.planSha256) {
    fail('REV_ORCHESTRATION_STALE', 'Route or packet inputs changed after preview.');
  }
  return selected.packet;
}

/** Preview the first local head entry. The retained Candidate is verified before a plan is shown. */
export async function previewRevisionLoopOpen({
  loopStore, context, initialCandidate, loopId, idempotencyKey,
  verifyCandidateReference
} = {}) {
  const scope = scopeOf(loopStore);
  const selected = candidateReference(initialCandidate);
  await assertVerifiedCandidate(selected, verifyCandidateReference);
  if (await loopStore.read() !== null) fail('REV_LOOP_ADVANCED', 'The REV loop is already open.');
  identifier(loopId, 'Loop ID');
  identifier(idempotencyKey, 'Idempotency key');
  const pinnedContext = exactContext(context);
  return plan('revision-orchestration-open-plan', {
    scope, expectedRevision: -1, expectedHeadCandidateRefSha256: null,
    context: pinnedContext, idempotencyKey, initialCandidate: selected,
    transition: { type: 'open-loop', loopId, initialCandidate: candidateSummary(selected) }
  });
}

/** Confirming the same plan is idempotent; the loop store owns the locked CAS and fresh-context check. */
export async function confirmRevisionLoopOpen({
  loopStore, plan: supplied, confirmation, readCurrentContext, verifyCandidateReference
} = {}) {
  const selected = selfHashedPlan(supplied, 'revision-orchestration-open-plan');
  confirmed(selected, confirmation);
  if (hash(scopeOf(loopStore)) !== hash(selected.scope)) {
    fail('REV_ORCHESTRATION_SCOPE', 'Open plan belongs to another REV loop scope.');
  }
  await assertFreshContext(selected.context, readCurrentContext);
  await assertVerifiedCandidate(selected.initialCandidate, verifyCandidateReference);
  const entry = await loopStore.append(appendRequest(selected));
  return freezeDeep({ entry: clone(entry), status: await readRevisionLoopStatus({ loopStore }) });
}

/** A compact read model suitable for CLI status without exposing mutable store internals. */
export async function readRevisionLoopStatus({ loopStore } = {}) {
  const scope = scopeOf(loopStore);
  const state = await loopStore.read();
  if (state === null) return freezeDeep({
    schemaVersion: 1, kind: 'revision-orchestration-status', scope,
    state: 'absent', revision: null, intervalSequence: 0, head: null,
    precheckSha256: null, publicationReady: false
  });
  return freezeDeep({
    schemaVersion: 1, kind: 'revision-orchestration-status', scope,
    state: state.status, revision: state.revision,
    intervalSequence: state.intervalSequence,
    headIntervalId: state.headIntervalId,
    head: clone(state.head), headTransitionSha256: state.headTransitionSha256,
    headSnapshotSha256: state.headSnapshotSha256,
    precheckSha256: state.precheckSha256,
    prechecked: state.status === 'open' && Boolean(state.precheckSha256),
    // The guarded local profile has no selected-head Story publication bridge.
    publicationReady: false
  });
}

function precheckInput({
  resultCandidate, state, context, precheckEvidence, transitionSha256, producer
}) {
  const reference = candidateReference(resultCandidate);
  const summary = candidateSummary(reference);
  const evidence = plain(clone(precheckEvidence), 'Precheck evidence');
  const evidenceKeys = [
    'bindings', 'hunkClaimSet', 'worktree', 'validations', 'criteria',
    'refusalSummary', 'proofProfile'
  ];
  if (Object.keys(evidence).sort().join('\0') !== evidenceKeys.sort().join('\0')) {
    fail('REV_ORCHESTRATION_INPUT', 'Precheck evidence has missing or unknown fields.');
  }
  return {
    subject: state.scope, producer: clone(producer),
    candidateReference: reference,
    head: {
      ...summary, phaseGeneration: state.scope.phaseGeneration,
      headRevision: state.revision + 1, headTransitionSha256: transitionSha256,
      workflowSha256: context.workflowSha256, configSha256: context.configSha256,
      proofProfileSha256: context.proofProfileSha256,
      editorDiskIndexBaselineSha256: context.editorDiskIndexBaselineSha256
    },
    ...evidence
  };
}
function headSnapshot(receipt) {
  const core = {
    candidateId: receipt.candidateId, candidateSha256: receipt.candidateSha256,
    candidateRefSha256: receipt.candidateRefSha256, candidateTree: receipt.candidateTree,
    phaseGeneration: receipt.phaseGeneration, headRevision: receipt.headRevision,
    headTransitionSha256: receipt.headTransitionSha256,
    workflowSha256: receipt.workflowSha256, configSha256: receipt.configSha256,
    proofProfileSha256: receipt.proofProfileSha256,
    editorDiskIndexBaselineSha256: receipt.editorDiskIndexBaselineSha256
  };
  return { ...core, headSnapshotSha256: hash(core) };
}

/** Preview one exact result-Candidate admission and its deterministic precheck as one CAS request. */
export async function previewRevisionPrecheck({
  loopStore, context, resultCandidate, routeInput, routePlan, packet, precheckEvidence,
  trigger, intervalId, executionAttempts, producer, startedAt, endedAt,
  idempotencyKey, verifyCandidateReference
} = {}) {
  const scope = scopeOf(loopStore);
  const state = await loopStore.read();
  if (!state || state.status !== 'open') fail('REV_LOOP_ADVANCED', 'An open REV loop is required.');
  const candidate = candidateReference(resultCandidate);
  producer = exactProducer(producer);
  await assertVerifiedCandidate(candidate, verifyCandidateReference);
  assertCurrentRevisionRoute(routePlan, routeInput);
  verifyRevisionPacket(packet, {
    routePlan,
    attachmentSetSha256: routePlan?.attachmentSetSha256 ?? null
  });
  identifier(intervalId, 'Interval ID');
  identifier(idempotencyKey, 'Idempotency key');
  const pinnedContext = exactContext(context);
  const destination = candidateSummary(candidate);
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: state.revision,
    expectedHeadTransitionSha256: state.headTransitionSha256,
    fromCandidateRefSha256: state.head.candidateRefSha256,
    toCandidateRefSha256: destination.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: state.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: pinnedContext.editorDiskIndexBaselineSha256,
    reason: 'admitted-result', producer: clone(producer)
  };
  const headTransition = { ...transitionCore, transitionSha256: hash(transitionCore) };
  const input = precheckInput({
    resultCandidate: candidate,
    state: { ...state, scope }, context: pinnedContext, precheckEvidence,
    transitionSha256: headTransition.transitionSha256, producer
  });
  const receipt = computeRevisionPrecheck(input);
  const snapshot = headSnapshot(receipt);
  if (snapshot.headSnapshotSha256 !== receipt.headSnapshotSha256) {
    fail('REV_PRECHECK_STALE', 'Precheck and proposed head snapshot disagree.');
  }
  plain(trigger, 'Interval trigger');
  const triggerKeys = [
    'kind', 'feedbackId', 'author', 'feedbackSha256', 'feedbackRecordSha256',
    'criteriaBindingSha256', 'specificationDispositionSha256', 'startPinSha256',
    'noteSha256'
  ];
  if (Object.keys(trigger).sort().join('\0') !== triggerKeys.sort().join('\0')
      || trigger.kind !== 'developer-feedback') {
    fail('REV_ORCHESTRATION_INPUT', 'Interval trigger has missing or unknown authority fields.');
  }
  identifier(trigger.feedbackId, 'Feedback ID');
  plain(trigger.author, 'Feedback author');
  if (Object.keys(trigger.author).sort().join('\0')
      !== ['kind', 'id', 'name'].sort().join('\0')
      || !['configured-local', 'authenticated-user', 'service'].includes(trigger.author.kind)) {
    fail('REV_ORCHESTRATION_INPUT', 'Feedback author is not an exact configured identity.');
  }
  if (typeof trigger.author.id !== 'string' || !trigger.author.id.trim()
      || Buffer.byteLength(trigger.author.id) > 256
      || /[\u0000-\u001f\u007f]/u.test(trigger.author.id)) {
    fail('REV_ORCHESTRATION_INPUT', 'Feedback author ID is invalid.');
  }
  if (typeof trigger.author.name !== 'string' || !trigger.author.name.trim()
      || Buffer.byteLength(trigger.author.name) > 256) {
    fail('REV_ORCHESTRATION_INPUT', 'Feedback author name is invalid.');
  }
  for (const field of triggerKeys.filter((field) => field.endsWith('Sha256'))) {
    sha(trigger[field], `Interval trigger ${field}`);
  }
  if (!Array.isArray(executionAttempts) || !executionAttempts.length
      || executionAttempts.length > 64
      || new Set(executionAttempts).size !== executionAttempts.length) {
    fail('REV_ORCHESTRATION_INPUT', 'Interval requires one or more unique execution-attempt records.');
  }
  executionAttempts.forEach((value) => sha(value, 'Execution attempt'));
  for (const [label, value] of [['startedAt', startedAt], ['endedAt', endedAt]]) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
        || new Date(value).toISOString() !== value) {
      fail('REV_ORCHESTRATION_INPUT', `Interval ${label} is invalid.`);
    }
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    fail('REV_ORCHESTRATION_INPUT', 'Interval endedAt precedes startedAt.');
  }
  plain(producer, 'Interval producer');
  if (Object.keys(producer).sort().join('\0')
      !== ['id', 'version', 'implementationSha256'].sort().join('\0')) {
    fail('REV_ORCHESTRATION_INPUT', 'Interval producer has missing or unknown fields.');
  }
  identifier(producer.id, 'Interval producer ID');
  if (typeof producer.version !== 'string' || !producer.version.trim()
      || Buffer.byteLength(producer.version) > 64) {
    fail('REV_ORCHESTRATION_INPUT', 'Interval producer version is invalid.');
  }
  sha(producer.implementationSha256, 'Interval producer implementation');
  const interval = buildRevisionInterval({
    intervalId,
    sequence: state.intervalSequence + 1, subject: scope,
    trigger: clone(trigger), parentCandidate: clone(state.head),
    resultCandidate: destination, packetSha256: packet.packetSha256,
    criteriaBindingSha256: precheckEvidence.bindings.criteriaBindingSha256,
    specificationDispositionSha256: precheckEvidence.bindings.specificationDispositionSha256,
    executionAttempts: clone(executionAttempts),
    hunkClaimSetSha256: precheckEvidence.bindings.hunkClaimSetSha256,
    startedAt, endedAt, producer: clone(producer),
    precheckSha256: receipt.precheckSha256, status: 'prechecked'
  });
  return plan('revision-orchestration-precheck-plan', {
    scope, expectedRevision: state.revision,
    expectedHeadCandidateRefSha256: state.head.candidateRefSha256,
    context: pinnedContext, idempotencyKey, resultCandidate: candidate,
    routeInput: clone(routeInput), routePlan: clone(routePlan),
    packet: clone(packet), precheckInput: input,
    transition: {
      type: 'commit-interval', loopId: state.loopId,
      interval, headTransition, headSnapshot: snapshot, precheck: receipt
    }
  });
}

/** Commit exactly the previewed interval/precheck bundle. No provider execution occurs here. */
export async function confirmRevisionPrecheck({
  loopStore, plan: supplied, confirmation, readCurrentContext, verifyCandidateReference
} = {}) {
  const selected = selfHashedPlan(supplied, 'revision-orchestration-precheck-plan');
  confirmed(selected, confirmation);
  if (hash(scopeOf(loopStore)) !== hash(selected.scope)) {
    fail('REV_ORCHESTRATION_SCOPE', 'Precheck plan belongs to another REV loop scope.');
  }
  await assertFreshContext(selected.context, readCurrentContext);
  await assertVerifiedCandidate(selected.resultCandidate, verifyCandidateReference);
  assertCurrentRevisionRoute(selected.routePlan, selected.routeInput);
  verifyRevisionPacket(selected.packet, {
    routePlan: selected.routePlan,
    attachmentSetSha256: selected.routePlan.attachmentSetSha256 ?? null
  });
  assertCurrentRevisionPrecheck(selected.transition.precheck, selected.precheckInput);
  const entry = await loopStore.append(appendRequest(selected));
  return freezeDeep({ entry: clone(entry), precheck: clone(selected.transition.precheck),
    status: await readRevisionLoopStatus({ loopStore }) });
}

/** Preview selection of an earlier retained loop Candidate after external exact materialization. */
export async function previewRevisionRestore({
  loopStore, context, selectedCandidate, reason = 'restore', idempotencyKey,
  verifyCandidateReference, producer
} = {}) {
  if (!['restore', 'discard', 'developer-rejected-result'].includes(reason)) {
    fail('REV_ORCHESTRATION_INPUT', 'Restore reason is not registered.');
  }
  const scope = scopeOf(loopStore);
  const state = await loopStore.read();
  if (!state || state.status !== 'open') fail('REV_LOOP_ADVANCED', 'An open REV loop is required.');
  const reference = candidateReference(selectedCandidate);
  producer = exactProducer(producer);
  await assertVerifiedCandidate(reference, verifyCandidateReference);
  identifier(idempotencyKey, 'Idempotency key');
  const pinnedContext = exactContext(context);
  const destination = candidateSummary(reference);
  const transitionCore = {
    schemaVersion: 1, kind: 'revision-head-transition',
    expectedLoopRevision: state.revision,
    expectedHeadTransitionSha256: state.headTransitionSha256,
    fromCandidateRefSha256: state.head.candidateRefSha256,
    toCandidateRefSha256: destination.candidateRefSha256,
    worktreeIndexEditorPreimageSha256: state.context.editorDiskIndexBaselineSha256,
    materializedPostimageSha256: pinnedContext.editorDiskIndexBaselineSha256,
    reason, producer: clone(producer)
  };
  const headTransition = { ...transitionCore, transitionSha256: hash(transitionCore) };
  const snapshotCore = {
    ...destination, phaseGeneration: scope.phaseGeneration,
    headRevision: state.revision + 1,
    headTransitionSha256: headTransition.transitionSha256,
    workflowSha256: pinnedContext.workflowSha256,
    configSha256: pinnedContext.configSha256,
    proofProfileSha256: pinnedContext.proofProfileSha256,
    editorDiskIndexBaselineSha256: pinnedContext.editorDiskIndexBaselineSha256
  };
  const headSnapshot = { ...snapshotCore, headSnapshotSha256: hash(snapshotCore) };
  return plan('revision-orchestration-restore-plan', {
    scope, expectedRevision: state.revision,
    expectedHeadCandidateRefSha256: state.head.candidateRefSha256,
    context: pinnedContext, idempotencyKey, selectedCandidate: reference,
    transition: { type: 'select-head', loopId: state.loopId,
      selectedCandidate: destination, headTransition, headSnapshot }
  });
}

/** Confirm a restore only after a fresh context proves the externally materialized postimage. */
export async function confirmRevisionRestore({
  loopStore, plan: supplied, confirmation, readCurrentContext, verifyCandidateReference
} = {}) {
  const selected = selfHashedPlan(supplied, 'revision-orchestration-restore-plan');
  confirmed(selected, confirmation);
  if (hash(scopeOf(loopStore)) !== hash(selected.scope)) {
    fail('REV_ORCHESTRATION_SCOPE', 'Restore plan belongs to another REV loop scope.');
  }
  await assertFreshContext(selected.context, readCurrentContext);
  await assertVerifiedCandidate(selected.selectedCandidate, verifyCandidateReference);
  const entry = await loopStore.append(appendRequest(selected));
  return freezeDeep({ entry: clone(entry), status: await readRevisionLoopStatus({ loopStore }) });
}

/** Existing manual-capture preview, surfaced with the same explicit confirmation convention. */
export async function previewManualRevision(options = {}) {
  return planManualRevisionCapture(options);
}

/** Candidate freeze only; it does not precheck, advance the loop, or publish. */
export async function confirmManualRevision({ plan: selected, confirmation, ...options } = {}) {
  if (!selected || confirmation !== selected.planSha256) {
    fail('REV_ORCHESTRATION_CONFIRMATION_REQUIRED', 'Confirm the exact current manual-capture plan digest.');
  }
  return freezeManualRevisionCandidate({ ...options, plan: selected });
}

/** Read-only exact publication selection preview. */
export async function previewRevisionPublication(selectionRequest = {}) {
  const selection = await verifyRevisionPublicationSelection(selectionRequest);
  return plan('revision-orchestration-publication-plan', { selection });
}

/** Re-run all live selection checks and return only the still-identical kernel selection. */
export async function confirmRevisionPublication({
  plan: supplied, confirmation, selectionRequest
} = {}) {
  const selected = selfHashedPlan(supplied, 'revision-orchestration-publication-plan');
  confirmed(selected, confirmation);
  const current = await verifyRevisionPublicationSelection(selectionRequest);
  if (current.selectionSha256 !== selected.selection.selectionSha256
      || hash(current) !== hash(selected.selection)) {
    fail('REV_ORCHESTRATION_STALE', 'Publication selection changed after preview.');
  }
  return current;
}
