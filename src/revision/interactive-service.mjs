/** Guarded interactive REV product flow. No model or arbitrary project command is invoked here. */
import { createHash } from 'node:crypto';

import { recordSha256 } from '../records.mjs';
import { assertNoSecrets } from '../git.mjs';
import { repositoryCaseInsensitivePaths } from '../repository-change-set.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { scanText } from '../secrets.mjs';
import {
  freezeSgosCandidate, listSgosCandidates, readSgosRetainedCandidate
} from '../sgos/candidate-lifecycle.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosRevisionCandidateReference, verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';
import {
  confirmManualRevision, confirmRevisionLoopOpen, confirmRevisionPacket,
  confirmRevisionPrecheck, previewManualRevision, previewRevisionLoopOpen,
  previewRevisionPacket, previewRevisionPrecheck, readRevisionLoopStatus
} from './core-orchestrator.mjs';
import {
  readOrCreateRevisionStartPin, readRevisionStartPin,
  readRevisionInteractiveConfirmationResult, readRevisionInteractivePayload,
  readRevisionInteractiveState, writeRevisionInteractiveConfirmationResult,
  writeRevisionInteractivePayload, writeRevisionInteractiveState
} from './interactive-state.mjs';
import {
  activeRevisionClauses, buildRevisionFeedbackRecords, classifyRevisionFeedback,
  loadActiveRevisionStory, packetInputFor, readRevisionContext, revisionCreator,
  readPinnedRevisionContext, revisionAttachmentStore, revisionDigest, revisionLoopStore,
  revisionProofProfile, revisionEffectPolicy, revisionFeedbackPrivacyPolicy,
  assertRevisionFeedbackPrivacy, routeInputFor, producerIdentity,
  selectRevisionCriteria
} from './product-context.mjs';
import { planRevisionRoute, verifyRevisionAttachmentSet } from './router.mjs';
import { assertGuardedRevisionCapability } from './runtime.mjs';
import { revisionPacketLimits } from './packet.mjs';
import { assertCurrentRevisionPrecheck } from './precheck.mjs';
import { readRevisionRecord, writeRevisionRecord } from './store.mjs';
import { buildRevisionAttempt, buildRevisionHunkClaimSet } from './contracts.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const START_KIND = 'revision-interactive-start-plan';
const CAPTURE_KIND = 'revision-interactive-capture-plan';
const CHECKS = Object.freeze([
  'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope', 'protectedPaths',
  'forbiddenEffects', 'secretScan', 'hunkDisposition', 'criteriaBindingFreshness',
  'specificationDisposition', 'requiredStructure', 'kernelChecks',
  'proofProfileReadiness', 'pendingRecovery', 'worktreeEquality'
]);

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}
function digest(value) { return `sha256:${recordSha256(value)}`; }
function textDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function plan(kind, value) {
  const core = {
    schemaVersion: currentSchemaVersion('revision-interactive-plan'), kind,
    ...structuredClone(value)
  };
  return Object.freeze({ ...core, planSha256: digest(core) });
}
function validatePlan(value, kind) {
  let selected;
  try { selected = readRecord('revision-interactive-plan', value).record; }
  catch { fail('REV_PLAN_INVALID', `An exact ${kind} is required.`); }
  if (!selected || selected.kind !== kind || !HASH.test(selected.planSha256)) {
    fail('REV_PLAN_INVALID', `An exact ${kind} is required.`);
  }
  const { planSha256, ...core } = selected;
  if (digest(core) !== planSha256) fail('REV_PLAN_INVALID', `${kind} failed its content hash.`);
  return selected;
}
function confirm(value, confirmation) {
  if (confirmation !== value.planSha256) {
    fail('REV_CONFIRMATION_REQUIRED', `Confirm the exact current plan with --confirm ${value.planSha256}.`);
  }
}
function scopeMatches(left, right) { return digest(left) === digest(right); }
function loopId(subject) {
  return `REVLOOP-${recordSha256(subject).slice(0, 24).toUpperCase()}`;
}
function idempotency(prefix, value) {
  return `${prefix}-${recordSha256(value).slice(0, 28).toUpperCase()}`;
}
function criteriaOptions(values = []) {
  return Array.isArray(values) ? values : [values];
}

function confirmedRecordSummaries(records) {
  return [records.feedback, records.binding, records.disposition, records.packet]
    .map((record) => ({
      kind: record.kind,
      sha256: record[record.kind === 'revision-feedback' ? 'recordSha256'
        : record.kind === 'revision-criteria-binding' ? 'bindingSha256'
          : record.kind === 'revision-specification-disposition' ? 'dispositionSha256'
            : 'packetSha256']
    }));
}

async function retainStartConfirmationResult(root, active, state, records) {
  const existing = await readRevisionInteractiveConfirmationResult(
    root, active.subject, state.startPlanSha256, { optional: true });
  const recovery = existing ?? await readRevisionInteractiveConfirmationResult(
    root, active.subject, state.startPlanSha256, { optional: true, recovery: true });
  if (recovery) {
    // Exact replay also backfills the independent recovery copy for results written by an older
    // build. Both paths are immutable and accept only byte-identical content.
    await writeRevisionInteractiveConfirmationResult(root, active.subject, {
      startPlanSha256: recovery.startPlanSha256,
      startPlanPayloadSha256: recovery.startPlanPayloadSha256,
      startPinSha256: recovery.startPinSha256,
      packetSha256: recovery.packetSha256,
      state: recovery.state, records: recovery.records, next: recovery.next
    });
    return Object.freeze({ result: recovery, summaries: recovery.records,
      next: recovery.next, created: existing == null });
  }
  if (state.status !== 'awaiting-edit') {
    fail('REV_START_CONFIRMATION_RESULT_MISSING',
      'The exact start-confirmation receipt is missing after this interval advanced. Preserve the loop and use an approved recovery adapter; a later interval will not replace this pointer.');
  }
  const summaries = confirmedRecordSummaries(records);
  const next = state.status === 'awaiting-edit' ? 'revision.capture' : 'revision.card';
  const result = await writeRevisionInteractiveConfirmationResult(root, active.subject, {
    startPlanSha256: state.startPlanSha256,
    startPlanPayloadSha256: state.startPlanPayloadSha256,
    startPinSha256: state.startPinSha256,
    packetSha256: state.packetSha256,
    state, records: summaries, next
  });
  return Object.freeze({ result, summaries, next, created: true });
}

async function ensureStartConfirmationResult(root, active, state) {
  const records = await loadInteractiveRecords(root, active, state);
  return retainStartConfirmationResult(root, active, state, records);
}

function startRouteContext(startPlan) {
  const revision = startPlan?.expectedLoopRevision;
  return Object.freeze({
    ...startPlan.context,
    ...(Number.isSafeInteger(revision) && revision >= 0 ? {
      loopId: startPlan.loopId, loopRevision: revision
    } : {})
  });
}

function protectedPaths(active) {
  return [...new Set([
    ...(active.config.governance?.protectedPaths ?? []),
    ...(active.workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ].filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.replace(/\/$/u, '')))];
}

function initialCandidateAdmission(active, observed) {
  const paths = [...observed.saved.applicationChangedPaths].sort();
  const savedByPath = new Map((observed.saved.saved ?? [])
    .map((entry) => [entry.path, entry]));
  const symlinks = paths.filter((item) => savedByPath.get(item)?.kind === 'symlink');
  if (symlinks.length) {
    fail('REV_SYMLINK_UNSUPPORTED',
      `Revision cannot scan or admit symlinked application path(s): ${symlinks.join(', ')}.`);
  }
  const fold = repositoryCaseInsensitivePaths(active.root)
    ? (value) => value.toLocaleLowerCase('en-US') : (value) => value;
  const guards = protectedPaths(active).map(fold);
  const blocked = paths.filter((item) => guards.some((guard) => fold(item) === guard
    || fold(item).startsWith(`${guard}/`)));
  if (blocked.length) {
    fail('REV_PROTECTED_PATH', `Revision cannot retain protected path(s): ${blocked.join(', ')}.`);
  }
  let scan = { scanned: 0, skipped: [], waived: [], blocking: [], clean: true };
  if (paths.length) {
    try { scan = assertNoSecrets(active.root, paths, { label: 'REV parent Candidate' }); }
    catch (error) {
      if (error?.code === 'SECRET_DETECTED') fail('REV_SECRET_DETECTED', error.message);
      throw error;
    }
  }
  if ((scan?.skipped?.length ?? 0) > 0 || (scan?.waived?.length ?? 0) > 0) {
    fail('REV_SECRET_SCAN_UNAVAILABLE',
      'Every selected parent-Candidate byte must pass the installed secret scanner without skips or waivers.');
  }
  const result = {
    status: 'pass', paths, protectedPathCount: guards.length,
    secretScan: { scanned: scan?.scanned ?? 0, skipped: scan?.skipped?.length ?? 0,
      waived: scan?.waived?.length ?? 0 }
  };
  return Object.freeze({ ...result, admissionSha256: digest(result) });
}

async function selectedAttachment(active, attachmentSetSha256, feedbackSha256, binding) {
  if (attachmentSetSha256 == null) return { receipt: null, store: null };
  if (!HASH.test(String(attachmentSetSha256))) {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', '--attachment-set must be an exact SHA-256 digest.');
  }
  const store = revisionAttachmentStore(active);
  const receipt = await store.read(attachmentSetSha256);
  if (!receipt || receipt.attachmentSetSha256 !== attachmentSetSha256) {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Selected attachment set is not registered for this Story phase.');
  }
  verifyRevisionAttachmentSet(receipt, {
    subject: active.subject, feedbackSha256, binding
  });
  return { receipt, store };
}

export async function previewInteractiveRevision(root, {
  feedbackText, criteria: requestedCriteria = [], disposition: requestedDisposition = null,
  attachmentSetSha256 = null, savedBuffersConfirmed = false
} = {}) {
  assertGuardedRevisionCapability('preview');
  if (typeof feedbackText !== 'string' || !feedbackText.trim()) {
    fail('REV_FEEDBACK_EMPTY', 'Provide nonempty revision feedback on standard input or as one argument.');
  }
  if (Buffer.byteLength(feedbackText) > 8192 || feedbackText.split(/\r?\n/u).length > 80) {
    fail('REV_FEEDBACK_TOO_LARGE', 'Revision feedback exceeds 8192 bytes or 80 lines.');
  }
  if (scanText(feedbackText).length) {
    fail('REV_FEEDBACK_SECRET', 'Revision feedback may contain a credential; no durable REV effect was created.');
  }
  if (savedBuffersConfirmed !== true) {
    fail('REV_UNSAVED_BUFFERS',
      'Save all repository editor buffers, then repeat with --saved-buffers-confirmed.');
  }
  const active = await loadActiveRevisionStory(root);
  const privacyPolicy = revisionFeedbackPrivacyPolicy(active);
  assertRevisionFeedbackPrivacy(feedbackText, privacyPolicy);
  const observed = await readRevisionContext(active);
  if (observed.saved.otherGovernedPaths.length) {
    fail('REV_WORKTREE_SCOPE',
      'Revision cannot start while saved changes exist outside application or Story-owned paths.', {
        paths: observed.saved.otherGovernedPaths
      });
  }
  const store = revisionLoopStore(active);
  const loop = await store.read();
  const current = await readRevisionInteractiveState(root, active.subject, { optional: true });
  if (loop?.status && loop.status !== 'open') {
    fail('REV_LOOP_ADVANCED', `The local revision loop is '${loop.status}' and cannot accept another interval.`);
  }
  if (['awaiting-edit', 'capturing', 'candidate-frozen'].includes(current?.status)) {
    fail('REV_INTERVAL_ACTIVE',
      'A revision packet is already awaiting saved code changes. Capture/precheck or abandon it before another revision.');
  }
  if (current?.status === 'opening' || current?.status === 'recovery-required') {
    fail('REV_RECOVERY_REQUIRED',
      'The active revision has an incomplete durable transition. Run revision resume before starting another interval.');
  }
  if (!loop && observed.saved.applicationChangedPaths.length) {
    fail('REV_PARENT_CANDIDATE_UNRETAINED',
      'The guarded local REV profile requires a clean retained parent Candidate. Publish or otherwise retain the current implementation before opening the correction loop; no Candidate or loop was changed.');
  }
  // A first interval has no immutable parent boundary yet. Refuse dirty application bytes
  // before secret scanning (which may dereference a symlink) or constructing any record.
  // Existing loops may scan saved edits because their exact retained head is already pinned.
  const admission = initialCandidateAdmission(active, observed);
  const criteria = selectRevisionCriteria(feedbackText, observed.clauses,
    criteriaOptions(requestedCriteria));
  const disposition = classifyRevisionFeedback(feedbackText, requestedDisposition,
    criteria.bound.length ? criteria.bound : criteria.packet);
  const feedbackSha256 = textDigest(feedbackText);
  const creator = revisionCreator(active);
  const effectPolicy = revisionEffectPolicy(active);
  const routeContext = startRouteContext({
    context: observed.context, loopId: loop?.loopId ?? loopId(active.subject),
    expectedLoopRevision: loop?.revision ?? -1
  });
  const attachment = await selectedAttachment(active, attachmentSetSha256,
    feedbackSha256, routeContext);
  let routing = null;
  if (disposition.result !== 'implementation-change') {
    const routeCandidate = loop?.head
      ? await completeCandidateReference(root, loop.head) : null;
    const routeInput = routeInputFor({
      active, context: routeContext, candidateReference: routeCandidate,
      feedbackText, disposition, attachmentSet: attachment.receipt, creator
    });
    routing = planRevisionRoute(routeInput);
  }
  return plan(START_KIND, {
    status: disposition.result === 'implementation-change' ? 'ready' : 'routing-required',
    subject: active.subject, context: observed.context,
    expectedLoopRevision: loop?.revision ?? -1,
    expectedHeadCandidateId: loop?.head?.candidateId ?? null,
    expectedInteractiveStateSha256: current?.stateSha256 ?? null,
    feedbackSha256,
    attachmentSetSha256: attachment.receipt?.attachmentSetSha256 ?? null,
    candidateAdmission: admission,
    candidateAdmissionSha256: admission.admissionSha256,
    creator,
    privacyPolicy,
    effectPolicy,
    packetBudgets: revisionPacketLimits,
    executionUnit: 'safe-built-in-manual-capture',
    savedBuffersConfirmed: true,
    precheckProfile: revisionProofProfile(active),
    criteria: { mode: criteria.mode,
      bound: criteria.bound.map(({ id, clauseSha256 }) => ({ id, clauseSha256 })),
      packet: criteria.packet.map(({ id, clauseSha256 }) => ({ id, clauseSha256 })) },
    disposition,
    routing,
    loopId: loop?.loopId ?? loopId(active.subject),
    idempotencyKey: idempotency('REVSTART', {
      subject: active.subject, context: observed.context, feedbackSha256,
      criteria: criteria.bound.map(({ id, clauseSha256 }) => ({ id, clauseSha256 })),
      disposition: disposition.result, revision: loop?.revision ?? -1,
      attachmentSetSha256: attachment.receipt?.attachmentSetSha256 ?? null,
      candidateAdmissionSha256: admission.admissionSha256
    }),
    effects: {
      codeChanged: false, lifecycleChanged: false, externalSystemsChanged: false,
      onConfirmation: disposition.result === 'implementation-change'
        ? ['pin-feedback-binding-and-disposition', 'freeze-current-candidate-if-needed',
          'prepare-and-pin-revision-packet', 'open-local-loop-if-needed'] : []
    }
  });
}

function selectedCriteria(planValue, clauses) {
  const byId = new Map(clauses.map((clause) => [clause.id, clause]));
  const map = (values) => values.map((selected) => {
    const clause = byId.get(selected.id);
    if (!clause || clause.clauseSha256 !== selected.clauseSha256) {
      fail('REV_PLAN_STALE', `Approved criterion '${selected.id}' changed after preview.`);
    }
    return clause;
  });
  return { mode: planValue.criteria.mode, bound: map(planValue.criteria.bound),
    packet: map(planValue.criteria.packet) };
}

async function completeCandidateReference(root, compact) {
  if (!compact?.candidateId) return null;
  const reference = await sgosRevisionCandidateReference(root, compact.candidateId);
  if (reference.candidateSha256 !== compact.candidateSha256
      || reference.repository.candidateTree !== compact.candidateTree) {
    fail('REV_PARENT_CANDIDATE_STALE', 'Selected local loop Candidate changed in retained storage.');
  }
  return reference;
}

async function completeOpeningState(root, active, state) {
  if (state?.status !== 'opening') return state;
  const store = revisionLoopStore(active);
  let loop = await store.read();
  if (loop) {
    const committedHead = await sgosRevisionCandidateReference(root, loop.head.candidateId);
    const committedHeadValid = committedHead.candidateSha256 === loop.head.candidateSha256
      && committedHead.repository.candidateTree === loop.head.candidateTree
      && await verifySgosRevisionCandidateReference(root, committedHead, {
        subjectId: `${active.subject.workId}:${active.subject.phaseId}`
      }) === true;
    if (loop.status !== 'open' || loop.loopId !== state.loopId || loop.revision !== 0
        || loop.head.candidateId !== state.parentCandidateId
        || digest(loop.context) !== state.contextSha256
        || !committedHeadValid) {
      fail('REV_LOOP_ADVANCED',
        'The committed local loop does not match the exact durable opening state.');
    }
    return writeRevisionInteractiveState(root, {
      ...state, status: 'awaiting-edit', loopRevision: loop.revision,
      updatedAt: new Date().toISOString()
    }, { expectedStateSha256: state.stateSha256 });
  }
  const observed = await readRevisionContext(active);
  if (digest(observed.context) !== state.contextSha256) {
    fail('REV_CONTEXT_STALE', 'Repository or workflow authority changed before the local loop opened.');
  }
  const retainedParent = await sgosRevisionCandidateReference(root, state.parentCandidateId);
  const parentCandidate = await completeCandidateReference(root, {
    candidateId: state.parentCandidateId,
    candidateSha256: retainedParent.candidateSha256,
    candidateTree: retainedParent.repository.candidateTree
  });
  const records = await loadInteractiveRecords(root, active, state);
  const routeContext = startRouteContext(records.startPlan);
  const attachment = await selectedAttachment(active,
    records.packet.feedback.attachmentSetSha256 ?? null,
    records.feedback.feedbackSha256, routeContext);
  const routeInput = routeInputFor({ active, context: routeContext,
    candidateReference: parentCandidate, feedbackText: records.feedback.text,
    disposition: { result: records.disposition.result }, attachmentSet: attachment.receipt });
  const routePlan = planRevisionRoute(routeInput);
  if (routePlan.planSha256 !== records.packet.routePlanSha256) {
    fail('REV_ROUTE_PLAN_STALE',
      'The durable opening packet no longer matches its exact current code-revision route.');
  }
  if (!loop) {
    const opening = await previewRevisionLoopOpen({
      loopStore: store, context: observed.context, initialCandidate: parentCandidate,
      loopId: state.loopId,
      idempotencyKey: idempotency('REVOPEN', {
        startPlanSha256: state.startPlanSha256, parentCandidateId: state.parentCandidateId
      }),
      verifyCandidateReference: (reference) => verifySgosRevisionCandidateReference(root, reference, {
        subjectId: `${active.subject.workId}:${active.subject.phaseId}`
      })
    });
    await confirmRevisionLoopOpen({
      loopStore: store, plan: opening, confirmation: opening.planSha256,
      readCurrentContext: async () => (await readRevisionContext(
        await loadActiveRevisionStory(root))).context,
      verifyCandidateReference: (reference) => verifySgosRevisionCandidateReference(root, reference, {
        subjectId: `${active.subject.workId}:${active.subject.phaseId}`
      })
    });
    loop = await store.read();
  }
  if (!loop || loop.status !== 'open' || loop.loopId !== state.loopId || loop.revision !== 0
      || loop.head.candidateId !== state.parentCandidateId
      || digest(loop.context) !== state.contextSha256) {
    fail('REV_LOOP_ADVANCED', 'The local loop does not match the exact durable opening state.');
  }
  return writeRevisionInteractiveState(root, {
    ...state, status: 'awaiting-edit', loopRevision: loop.revision,
    updatedAt: new Date().toISOString()
  }, { expectedStateSha256: state.stateSha256 });
}

export async function confirmInteractiveRevision(root, {
  plan: suppliedPlan, confirmation, feedbackText,
  criteria: requestedCriteria = [], disposition: requestedDisposition = null,
  attachmentSetSha256 = null, savedBuffersConfirmed = false
} = {}) {
  assertGuardedRevisionCapability('preview');
  const selected = validatePlan(suppliedPlan, START_KIND);
  confirm(selected, confirmation);
  if (selected.status !== 'ready' || selected.disposition.result !== 'implementation-change') {
    const code = selected.disposition.result === 'specification-change' ? 'REV_SPECIFICATION_CHANGE'
      : selected.disposition.result === 'unrelated' ? 'REV_FEEDBACK_UNRELATED'
        : 'REV_SPECIFICATION_AMBIGUOUS';
    fail(code, 'Feedback is not an admitted implementation change. No code, Candidate, or loop was changed.');
  }
  if (textDigest(feedbackText) !== selected.feedbackSha256) {
    fail('REV_PLAN_STALE', 'Feedback text differs from the reviewed revision plan.');
  }
  if (scanText(feedbackText).length) {
    fail('REV_FEEDBACK_SECRET', 'Revision feedback may contain a credential; no durable REV effect was created.');
  }
  if ((attachmentSetSha256 ?? null) !== selected.attachmentSetSha256) {
    fail('REV_PLAN_STALE', 'Attachment-set selection differs from the reviewed revision plan.');
  }
  if (savedBuffersConfirmed !== true || selected.savedBuffersConfirmed !== true) {
    fail('REV_UNSAVED_BUFFERS',
      'The reviewed revision plan requires an explicit saved-buffer assertion.');
  }
  const active = await loadActiveRevisionStory(root);
  if (!scopeMatches(active.subject, selected.subject)) {
    fail('REV_PLAN_STALE', 'The active Story phase changed after revision preview.');
  }
  const replay = await readRevisionInteractiveState(root, active.subject, { optional: true });
  if (replay?.startPlanSha256 === selected.planSha256 && replay.status === 'opening') {
    const state = await completeOpeningState(root, active, replay);
    const records = await loadInteractiveRecords(root, active, state);
    const retained = await retainStartConfirmationResult(root, active, state, records);
    return Object.freeze({ replayed: true, recoveredConfirmationResult: retained.created,
      state: retained.result.state, packet: records.packet,
      records: retained.summaries, next: retained.next });
  }
  if (replay?.startPlanSha256 === selected.planSha256
      && ['awaiting-edit', 'prechecked'].includes(replay.status)) {
    const records = await loadInteractiveRecords(root, active, replay);
    const retained = await retainStartConfirmationResult(root, active, replay, records);
    return Object.freeze({ replayed: true, recoveredConfirmationResult: retained.created,
      state: retained.result.state, packet: records.packet,
      records: retained.summaries, next: retained.next });
  }
  if (replay?.startPlanSha256 !== selected.planSha256 && replay?.status === 'prechecked') {
    // A later interval must never replace the only pointer from which a start confirmation can be
    // reconstructed. Repair an independently addressed copy first, or fail closed if that exact
    // historical result was already lost or tampered with.
    await ensureStartConfirmationResult(root, active, replay);
  }
  if ((replay?.stateSha256 ?? null) !== selected.expectedInteractiveStateSha256) {
    fail('REV_INTERACTIVE_STATE_ADVANCED',
      'Interactive REV state changed after preview; inspect and retry from the current state.');
  }
  const observed = await readRevisionContext(active);
  if (digest(observed.context) !== digest(selected.context)) {
    fail('REV_PLAN_STALE', 'Repository, workflow, approved intent, or saved bytes changed after preview.');
  }
  const admission = initialCandidateAdmission(active, observed);
  if (admission.admissionSha256 !== selected.candidateAdmissionSha256) {
    fail('REV_PLAN_STALE', 'Candidate admission evidence changed after preview.');
  }
  const creator = revisionCreator(active);
  if (digest(creator) !== digest(selected.creator)
      || digest(revisionFeedbackPrivacyPolicy(active)) !== digest(selected.privacyPolicy)
      || digest(revisionEffectPolicy(active)) !== digest(selected.effectPolicy)
      || digest(revisionPacketLimits) !== digest(selected.packetBudgets)
      || selected.executionUnit !== 'safe-built-in-manual-capture'
      || selected.precheckProfile !== revisionProofProfile(active)) {
    fail('REV_PLAN_STALE', 'Revision identity, effect policy, budgets, or precheck profile changed after preview.');
  }
  const store = revisionLoopStore(active);
  let loop = await store.read();
  if ((loop?.revision ?? -1) !== selected.expectedLoopRevision
      || (loop?.head?.candidateId ?? null) !== selected.expectedHeadCandidateId) {
    fail('REV_LOOP_ADVANCED', 'The revision loop head changed after preview.');
  }
  const routeContext = startRouteContext(selected);
  const attachment = await selectedAttachment(active, selected.attachmentSetSha256,
    selected.feedbackSha256, routeContext);
  const clauses = await activeRevisionClauses(active);
  const criteria = selectedCriteria(selected, clauses);
  // Re-run user-option interpretation so a changed option cannot borrow an old confirmation.
  const currentCriteria = selectRevisionCriteria(feedbackText, clauses, criteriaOptions(requestedCriteria));
  const currentDisposition = classifyRevisionFeedback(feedbackText, requestedDisposition,
    currentCriteria.bound.length ? currentCriteria.bound : currentCriteria.packet);
  if (digest({ mode: currentCriteria.mode,
    bound: currentCriteria.bound.map(({ id, clauseSha256 }) => ({ id, clauseSha256 })),
    packet: currentCriteria.packet.map(({ id, clauseSha256 }) => ({ id, clauseSha256 }))
  }) !== digest(selected.criteria) || digest(currentDisposition) !== digest(selected.disposition)) {
    fail('REV_PLAN_STALE', 'Criteria or specification disposition changed after preview.');
  }
  const startPin = await readOrCreateRevisionStartPin(root, active.subject, {
    startPlanSha256: selected.planSha256, feedbackSha256: selected.feedbackSha256,
    feedbackText, author: creator.feedback,
    criteria: selected.criteria, disposition: selected.disposition,
    privacyPolicySha256: selected.privacyPolicy.policySha256,
    producer: producerIdentity()
  });
  const startPlanPayloadSha256 = await writeRevisionInteractivePayload(root, active.subject, {
    schemaVersion: 1, kind: 'revision-interactive-start-authority', plan: selected
  });
  // Feedback, criteria binding, and disposition are immutable and durable before Candidate, loop,
  // packet, or execution effects. A later refusal may leave only harmless content-addressed facts.
  const records = buildRevisionFeedbackRecords({
    active, feedbackText, capturedAt: startPin.capturedAt, criteria,
    disposition: selected.disposition, creator
  });
  for (const record of [records.feedback, records.binding, records.disposition]) {
    await writeRevisionRecord(root, record);
  }
  let parentCandidate;
  if (!loop) {
    parentCandidate = await freezeInitialRevisionCandidate(root, active, observed, creator);
  } else parentCandidate = await completeCandidateReference(root, loop.head);

  const pinnedContext = loop?.context ?? observed.context;
  const routeInput = routeInputFor({ active, context: routeContext,
    candidateReference: parentCandidate, feedbackText, disposition: selected.disposition,
    attachmentSet: attachment.receipt, creator });
  const packetInput = await packetInputFor({
    active, candidateReference: parentCandidate, criteria,
    feedbackId: records.feedback.feedbackId,
    feedbackRecordSha256: records.feedback.recordSha256,
    criteriaBindingSha256: records.binding.bindingSha256,
    specificationDispositionSha256: records.disposition.dispositionSha256,
    attachmentSet: attachment.receipt, attachmentStore: attachment.store
  });
  const packetPlan = await previewRevisionPacket({ routeInput, packetInput });
  const packet = await confirmRevisionPacket({
    plan: packetPlan, confirmation: packetPlan.planSha256, routeInput, packetInput
  });
  await writeRevisionRecord(root, packet);
  let state = await writeRevisionInteractiveState(root, {
    subject: active.subject, status: loop ? 'awaiting-edit' : 'opening',
    loopId: loop?.loopId ?? selected.loopId,
    loopRevision: loop?.revision ?? -1, startPlanSha256: selected.planSha256,
    startPlanPayloadSha256,
    contextSha256: digest(pinnedContext),
    feedbackRecordSha256: records.feedback.recordSha256,
    criteriaBindingSha256: records.binding.bindingSha256,
    dispositionSha256: records.disposition.dispositionSha256,
    packetSha256: packet.packetSha256, routePlanSha256: packet.routePlanSha256,
    parentCandidateId: parentCandidate.candidateId, resultCandidateId: null,
    startPinSha256: startPin.pinSha256,
    precheckSha256: null, precheckInputSha256: null
  }, { expectedStateSha256: selected.expectedInteractiveStateSha256 });
  if (!loop) state = await completeOpeningState(root, active, state);
  const retained = await retainStartConfirmationResult(root, active, state, {
    ...records, packet
  });
  return Object.freeze({ replayed: false, state, packet,
    records: retained.summaries, next: retained.next });
}

/** Exact public replay path after a prior confirmation created durable interactive state. */
export async function replayInteractiveRevisionConfirmation(root, {
  confirmation, feedbackText, criteria: requestedCriteria = [],
  disposition: requestedDisposition = null, attachmentSetSha256 = null,
  savedBuffersConfirmed = false
} = {}) {
  if (!HASH.test(String(confirmation ?? ''))) return null;
  const active = await loadActiveRevisionStory(root);
  const storedResult = await readRevisionInteractiveConfirmationResult(
    root, active.subject, confirmation, { optional: true });
  const recoveryResult = storedResult ?? await readRevisionInteractiveConfirmationResult(
    root, active.subject, confirmation, { optional: true, recovery: true });
  let state = recoveryResult?.state
    ?? await readRevisionInteractiveState(root, active.subject, { optional: true });
  if (!state || state.startPlanSha256 !== confirmation) return null;
  if (savedBuffersConfirmed !== true) {
    fail('REV_UNSAVED_BUFFERS', 'Exact revision replay requires --saved-buffers-confirmed.');
  }
  const records = await loadInteractiveRecords(root, active, state);
  const selected = validatePlan(records.startPlan, START_KIND);
  if (textDigest(feedbackText) !== selected.feedbackSha256
      || feedbackText !== records.feedback.text
      || (attachmentSetSha256 ?? null) !== selected.attachmentSetSha256) {
    fail('REV_PLAN_STALE', 'Revision replay feedback or attachment selection differs from the confirmed plan.');
  }
  assertRevisionFeedbackPrivacy(feedbackText, revisionFeedbackPrivacyPolicy(active));
  if (digest(revisionCreator(active)) !== digest(selected.creator)) {
    fail('REV_PLAN_STALE',
      'Revision replay identity or repository approval membership differs from the confirmed plan.');
  }
  await selectedAttachment(active, selected.attachmentSetSha256,
    records.feedback.feedbackSha256, startRouteContext(selected));
  const clauses = await activeRevisionClauses(active);
  const currentCriteria = selectRevisionCriteria(
    feedbackText, clauses, criteriaOptions(requestedCriteria));
  const currentDisposition = classifyRevisionFeedback(feedbackText, requestedDisposition,
    currentCriteria.bound.length ? currentCriteria.bound : currentCriteria.packet);
  if (digest({
    mode: currentCriteria.mode,
    bound: currentCriteria.bound.map(({ id, clauseSha256 }) => ({ id, clauseSha256 })),
    packet: currentCriteria.packet.map(({ id, clauseSha256 }) => ({ id, clauseSha256 }))
  }) !== digest(selected.criteria) || digest(currentDisposition) !== digest(selected.disposition)) {
    fail('REV_PLAN_STALE', 'Revision replay criteria or disposition differs from the confirmed plan.');
  }
  if (state.status === 'opening') state = await completeOpeningState(root, active, state);
  let recoveredConfirmationResult = false;
  let retainedResult = storedResult;
  if (!retainedResult && recoveryResult) {
    retainedResult = await writeRevisionInteractiveConfirmationResult(root, active.subject, {
      startPlanSha256: recoveryResult.startPlanSha256,
      startPlanPayloadSha256: recoveryResult.startPlanPayloadSha256,
      startPinSha256: recoveryResult.startPinSha256,
      packetSha256: recoveryResult.packetSha256,
      state: recoveryResult.state, records: recoveryResult.records, next: recoveryResult.next
    });
    recoveredConfirmationResult = true;
  }
  if (!retainedResult) {
    retainedResult = (await retainStartConfirmationResult(root, active, state, records)).result;
    recoveredConfirmationResult = true;
  }
  return Object.freeze({ replayed: true, state, packet: records.packet, plan: selected,
    recoveredConfirmationResult,
    records: retainedResult.records,
    next: retainedResult.next
      ?? (state.status === 'awaiting-edit' ? 'revision.capture' : 'revision.card') });
}

function savedEditorProof(enabled) {
  return async ({ changedPaths }) => enabled === true ? {
    status: 'all-saved', snapshotSha256: digest({ source: 'explicit-cli-assertion', changedPaths }),
    // The CLI can preserve an explicit human assertion, but it is not a trusted editor-host proof.
    assurance: 'user-asserted'
  } : null;
}

function deterministicCandidateTimestamp(active) {
  const selected = active.phase?.startedAt ?? active.workflow?.workItem?.createdAt ?? null;
  if (typeof selected !== 'string' || Number.isNaN(Date.parse(selected))) {
    fail('REV_PARENT_CANDIDATE_MISSING',
      'The active phase has no durable start timestamp from which to derive Candidate identity.');
  }
  return new Date(selected).toISOString();
}

/**
 * Retain the initial implementation without `git add`, clean/process filters, or a second read of
 * unadmitted bytes. HEAD becomes a clean retained base; the already-bounded application delta is
 * then captured through the same raw-byte/private-index path used for later manual intervals.
 */
async function freezeInitialRevisionCandidate(root, active, observed, creator) {
  const createdAt = deterministicCandidateTimestamp(active);
  const subjectId = `${active.subject.workId}:${active.subject.phaseId}`;
  const baseline = await freezeSgosCandidate(root, {
    subjectId, createdBy: creator.candidate, createdAt,
    expectedBaseline: observed.context.headCommit, paths: []
  });
  const baselineReference = await sgosRevisionCandidateReference(
    root, baseline.candidate.candidateId);
  if (observed.saved.applicationChangedPaths.length) {
    fail('REV_PARENT_CANDIDATE_UNRETAINED',
      'A dirty initial parent cannot be retained before a recoverable REV pointer exists. Retain it through the normal code-phase publication boundary first.');
  }
  return baselineReference;
}

async function liveCapturePlan(root, active, state, { note, savedBuffersConfirmed }) {
  if (typeof note !== 'string' || !note.trim()) {
    fail('REV_MANUAL_NOTE_REQUIRED', 'Capture needs --note describing the saved implementation change.');
  }
  if (savedBuffersConfirmed !== true) {
    fail('REV_UNSAVED_BUFFERS',
      'Save all repository editor buffers, then repeat with --saved-buffers-confirmed.');
  }
  const store = revisionLoopStore(active);
  const loop = await store.read();
  if (!loop || loop.status !== 'open' || loop.revision !== state.loopRevision
      || loop.head.candidateId !== state.parentCandidateId) {
    fail('REV_LOOP_ADVANCED', 'The revision loop head changed before saved edits were captured.');
  }
  const parentCandidate = await completeCandidateReference(root, loop.head);
  const observed = await readRevisionContext(active);
  if (observed.saved.otherGovernedPaths.length) {
    fail('REV_WORKTREE_SCOPE',
      'Revision capture found saved changes outside application or Story-owned paths.', {
        paths: observed.saved.otherGovernedPaths
      });
  }
  const packet = await readRevisionRecord(root, 'revision-packet', state.packetSha256, {
    subject: active.subject
  });
  if (packet.effectPolicy?.writeScope !== 'source-and-artifact'
      || packet.effectPolicy?.externalEffectsAllowed !== false
      || !Number.isSafeInteger(packet.effectPolicy?.maximumChangedFiles)
      || packet.effectPolicy.maximumChangedFiles < 1) {
    fail('REV_EFFECT_POLICY_UNAVAILABLE',
      'The bound revision packet does not permit a bounded source capture.');
  }
  const subjectId = `${active.subject.workId}:${active.subject.phaseId}`;
  const proof = savedEditorProof(true);
  const discovery = await previewManualRevision({
    root, subjectId, parentCandidate, allowedPaths: [], note,
    ignoredPaths: observed.saved.transactionOwnedPaths,
    stagedDisposition: null, untrackedDisposition: null,
    config: active.config, workflow: active.workflow, verifySavedEditorBuffers: proof
  });
  const allowedPaths = discovery.drift.map((item) => item.path).sort();
  if (!allowedPaths.length || !discovery.drift.some((item) => item.candidateDrift)) {
    fail('REV_MANUAL_NO_CANDIDATE_DRIFT', 'Saved application bytes do not differ from the current loop head.');
  }
  const candidateDrift = discovery.drift.filter((item) => item.candidateDrift);
  const capturedBytes = candidateDrift.reduce((total, item) => total + (item.saved?.bytes ?? 0), 0);
  if (candidateDrift.length > packet.effectPolicy.maximumChangedFiles) {
    fail('REV_EFFECT_POLICY_LIMIT',
      `Revision changes ${candidateDrift.length} files; the bound limit is ${packet.effectPolicy.maximumChangedFiles}.`);
  }
  if (capturedBytes > packet.budgets.maximumOutputBytes) {
    fail('REV_PACKET_LIMIT',
      `Saved revision bytes exceed the bound ${packet.budgets.maximumOutputBytes}-byte output limit.`);
  }
  const manual = await previewManualRevision({
    root, subjectId, parentCandidate, allowedPaths, note,
    ignoredPaths: observed.saved.transactionOwnedPaths,
    stagedDisposition: discovery.drift.some((item) => item.staged)
      ? 'capture-saved-disk' : null,
    untrackedDisposition: discovery.drift.some((item) => item.untracked)
      ? 'capture-listed' : null,
    config: active.config, workflow: active.workflow, verifySavedEditorBuffers: proof
  });
  if (manual.status !== 'ready-for-explicit-freeze' || manual.findings.length) {
    fail('REV_MANUAL_CAPTURE_UNAVAILABLE', manual.findings.map((item) => item.message).join(' '), {
      findings: manual.findings
    });
  }
  return {
    active, state, loop, store, parentCandidate, subjectId, proof, manual, packet, observed
  };
}

export async function previewInteractiveCapture(root, options = {}) {
  assertGuardedRevisionCapability('capture');
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject);
  if (state?.status === 'capturing') {
    fail('REV_RECOVERY_REQUIRED',
      'Capture outcome is uncertain after interruption. Run revision resume; do not repeat capture or abandon the loop.');
  }
  if (state && ['candidate-frozen', 'prechecked'].includes(state.status)) {
    if (options.savedBuffersConfirmed !== true) {
      fail('REV_UNSAVED_BUFFERS',
        'Exact capture replay requires the same --saved-buffers-confirmed assertion.');
    }
    const payload = await readRevisionInteractivePayload(
      root, active.subject, state.capturePayloadSha256);
    if (payload?.kind !== 'revision-interactive-capture-authority'
        || payload.plan?.planSha256 !== state.capturePlanSha256
        || textDigest(String(options.note ?? '').trim()) !== payload.plan.noteSha256) {
      fail('REV_PLAN_STALE', 'Capture replay differs from its exact stored plan or note.');
    }
    return validatePlan(payload.plan, CAPTURE_KIND);
  }
  if (!state || state.status !== 'awaiting-edit') {
    fail('REV_INTERVAL_ACTIVE', 'No prepared revision packet is awaiting saved implementation changes.');
  }
  const live = await liveCapturePlan(root, active, state, options);
  return plan(CAPTURE_KIND, {
    subject: active.subject, startPlanSha256: state.startPlanSha256,
    loopId: live.loop.loopId, expectedLoopRevision: live.loop.revision,
    expectedHeadCandidateId: live.loop.head.candidateId,
    manualPlanSha256: live.manual.planSha256,
    noteSha256: textDigest(options.note.trim()), allowedPaths: live.manual.allowedPaths,
    idempotencyKey: idempotency('REVCAPTURE', {
      loopId: live.loop.loopId, revision: live.loop.revision,
      manualPlanSha256: live.manual.planSha256
    }),
    effects: { codeChanged: false, lifecycleChanged: false,
      retainedCandidateCreatedOnConfirmation: true, precheckRecordedOnConfirmation: true }
  });
}

function hunkClaimSet({ active, parentCandidate, resultCandidate, manual }) {
  // The safe built-in capture knows which complete saved files changed, but it does not parse a
  // patch into independently reviewable hunks or prove the cause of each one. Retain stable
  // diff-unit identities as unexplained instead of manufacturing criterion claims.
  const unexplained = manual.drift.filter((item) => item.candidateDrift).map((item) =>
    `DIFFUNIT-${recordSha256({
      parent: parentCandidate.candidateSha256, result: resultCandidate.candidateSha256,
      path: item.path, before: item.candidate, after: item.saved
    }).slice(0, 24).toUpperCase()}`
  ).sort();
  return buildRevisionHunkClaimSet({
    subject: active.subject,
    parentCandidateId: parentCandidate.candidateId,
    resultCandidateId: resultCandidate.candidateId,
    claims: [], unexplained, producer: producerIdentity()
  });
}

function precheckEvidence({ active, current, state, packet, claims, resultCandidate, manual }) {
  // A precheck receipt reports only evidence actually established by this product path. The manual
  // capture kernel proves candidate retention, lineage, admitted paths, protected-path refusal,
  // cleanup, immutable bindings, and a saved-byte secret scan. The CLI buffer assertion is retained
  // as user asserted, not promoted to trusted editor proof. This path does not run repository
  // structure/kernel checks, hunk attribution, recovery inspection, or a proof runner.
  // Those checks remain explicitly unavailable, making the candidate ineligible for publication
  // until a registered verifier supplies them.
  const proven = new Set([
    'candidateIntegrity', 'candidateFreeze', 'parentResultLineage', 'scope',
    'forbiddenEffects', 'criteriaBindingFreshness', 'specificationDisposition'
  ]);
  if (manual.protectedPathCheck?.status === 'pass') proven.add('protectedPaths');
  if (manual.secretScan?.status === 'pass') proven.add('secretScan');
  const unavailableReasons = Object.freeze({
    protectedPaths: 'protected-path-check-not-established',
    secretScan: 'registered-saved-byte-secret-scan-not-established',
    hunkDisposition: 'saved-file-diff-is-not-hunk-attribution',
    requiredStructure: 'no-registered-structure-check-executed',
    kernelChecks: 'no-registered-kernel-check-executed',
    proofProfileReadiness: 'no-bound-proof-runner-receipt',
    pendingRecovery: 'no-recovery-store-inspection-executed',
    worktreeEquality: 'cli-buffer-assertion-is-not-trusted-editor-proof'
  });
  const evidence = (name) => ({
    status: proven.has(name) ? 'pass' : 'unavailable',
    evidenceSha256: digest({
      check: name,
      status: proven.has(name) ? 'pass' : 'unavailable',
      reason: unavailableReasons[name] ?? 'built-in-check-unavailable',
      candidate: resultCandidate.candidateSha256,
      capturePlanSha256: manual.planSha256
    })
  });
  const criteria = packet.criteria.items.map((item) => ({
    clauseId: item.id, applicable: true,
    claimedChange: false,
    witnessReady: false, availability: 'unavailable', contradicted: false,
    testBodySha256: null, environmentSha256: null, witnesses: []
  }));
  return {
    bindings: {
      criteriaBindingSha256: state.criteriaBindingSha256,
      specificationDispositionSha256: state.dispositionSha256,
      hunkClaimSetSha256: claims.claimSetSha256
    },
    hunkClaimSet: claims,
    worktree: {
      savedTree: resultCandidate.repository.candidateTree,
      editorDiskIndexBaselineSha256: current.context.editorDiskIndexBaselineSha256,
      // The admitted Candidate delta is represented by the retained Candidate and manual drift
      // evidence. This field is reserved for drift observed *after* that exact freeze.
      changedPaths: []
    },
    validations: Object.fromEntries(CHECKS.map((name) => [name, evidence(name)])),
    criteria,
    refusalSummary: { count: 0, corrected: 0, unresolved: 0 },
    proofProfile: revisionProofProfile(active)
  };
}

async function loadInteractiveRecords(root, active, state, packet = null) {
  const selectedPacket = packet ?? await readRevisionRecord(root, 'revision-packet',
    state.packetSha256, { subject: active.subject });
  const [feedback, binding, disposition, startPin, startPayload] = await Promise.all([
    readRevisionRecord(root, 'revision-feedback', state.feedbackRecordSha256, {
      subject: active.subject
    }),
    readRevisionRecord(root, 'revision-criteria-binding', state.criteriaBindingSha256, {
      subject: active.subject
    }),
    readRevisionRecord(root, 'revision-specification-disposition', state.dispositionSha256, {
      subject: active.subject
    }),
    readRevisionStartPin(root, active.subject, state.startPlanSha256),
    readRevisionInteractivePayload(root, active.subject, state.startPlanPayloadSha256)
  ]);
  const approvedCriteria = new Map((await activeRevisionClauses(active))
    .map((item) => [item.id, item.clauseSha256]));
  const packetCriteria = selectedPacket.criteria.items.map((item) => ({
    id: item.id, clauseSha256: approvedCriteria.get(item.id) ?? null
  }));
  const startPlan = startPayload?.plan;
  if (startPayload?.kind !== 'revision-interactive-start-authority'
      || startPlan?.planSha256 !== state.startPlanSha256
      || validatePlan(startPlan, START_KIND).planSha256 !== state.startPlanSha256
      || startPlan.feedbackSha256 !== startPin.feedbackSha256
      || digest(startPlan.creator?.feedback) !== digest(startPin.author)
      || digest(startPlan.criteria) !== digest(startPin.criteria)
      || digest(startPlan.disposition) !== digest(startPin.disposition)
      || startPlan.privacyPolicy?.policySha256 !== startPin.privacyPolicySha256
      || startPin.pinSha256 !== state.startPinSha256
      || startPin.feedbackSha256 !== feedback.feedbackSha256
      || startPin.feedbackText !== feedback.text
      || digest(startPin.author) !== digest(feedback.author)
      || startPin.capturedAt !== feedback.capturedAt
      || startPin.criteria.mode !== binding.mode
      || digest(startPin.criteria.bound) !== digest(binding.criteria.map(
        ({ clauseId, clauseSha256 }) => ({ id: clauseId, clauseSha256 })))
      || packetCriteria.some((item) => !HASH.test(String(item.clauseSha256 ?? '')))
      || digest(startPin.criteria.packet) !== digest(packetCriteria)
      || startPin.disposition.result !== disposition.result
      || startPin.disposition.predicateId !== disposition.predicateResults[0]?.predicateId
      || startPin.disposition.human !== (disposition.humanResolution !== null)
      || (startPin.disposition.human && (
        disposition.humanResolution?.decision !== startPin.disposition.result
        || disposition.humanResolution?.decidedBy !== startPin.author.id
        || disposition.humanResolution?.decidedAt !== startPin.capturedAt))
      || digest(startPin.producer) !== digest(feedback.producer)
      || digest(feedback.producer) !== digest(binding.producer)
      || digest(binding.producer) !== digest(disposition.producer)
      || startPin.privacyPolicySha256 !== revisionFeedbackPrivacyPolicy(active).policySha256
      || selectedPacket.feedback.feedbackId !== feedback.feedbackId
      || selectedPacket.feedback.feedbackRecordSha256 !== feedback.recordSha256
      || selectedPacket.feedback.feedbackSha256 !== feedback.feedbackSha256
      || selectedPacket.feedback.text !== feedback.text
      || selectedPacket.routePlanSha256 !== state.routePlanSha256
      || selectedPacket.criteriaBindingSha256 !== binding.bindingSha256
      || selectedPacket.specificationDispositionSha256 !== disposition.dispositionSha256
      || binding.feedbackSha256 !== feedback.feedbackSha256
      || disposition.feedbackSha256 !== feedback.feedbackSha256
      || disposition.bindingSha256 !== binding.bindingSha256
      || disposition.result !== 'implementation-change') {
    fail('REV_RECORD_CHAIN_STALE',
      'Feedback, criterion binding, specification disposition, packet, and interactive pointer do not form one exact chain.');
  }
  return Object.freeze({
    feedback, binding, disposition, startPin, startPlan: startPayload.plan,
    packet: selectedPacket
  });
}

async function loadInteractiveAuthority(root, active, state, live) {
  const records = await loadInteractiveRecords(root, active, state, live.packet);
  const { feedback, binding, disposition, packet } = records;
  const routeContext = startRouteContext(records.startPlan);
  if (records.startPlan.expectedLoopRevision >= 0
      && (records.startPlan.loopId !== live.loop.loopId
        || records.startPlan.expectedLoopRevision !== state.loopRevision
        || records.startPlan.expectedLoopRevision !== live.loop.revision)) {
    fail('REV_RECORD_CHAIN_STALE',
      'The pinned revision start route does not match the exact active loop head.');
  }
  const attachment = await selectedAttachment(active,
    packet.feedback.attachmentSetSha256 ?? null,
    feedback.feedbackSha256, routeContext);
  const routeInput = routeInputFor({ active, context: routeContext,
    candidateReference: live.parentCandidate, feedbackText: feedback.text,
    disposition: { result: disposition.result }, attachmentSet: attachment.receipt,
    creator: { candidate: { kind: 'human', id: feedback.author.id }, feedback: feedback.author } });
  const routePlan = planRevisionRoute(routeInput);
  if (routePlan.planSha256 !== packet.routePlanSha256
      || routePlan.feedbackSha256 !== feedback.feedbackSha256) {
    fail('REV_ROUTE_PLAN_STALE',
      'The current route no longer matches the exact packet and feedback chain.');
  }
  return Object.freeze({ ...records, attachment, routeInput, routePlan });
}

function capturePayloadAuthority(payload, state) {
  const selected = payload?.plan;
  const manual = payload?.manual;
  if (payload?.kind !== 'revision-interactive-capture-authority'
      || validatePlan(selected, CAPTURE_KIND).planSha256 !== state.capturePlanSha256
      || selected.manualPlanSha256 !== manual?.planSha256
      || payload.parentCandidateId !== state.parentCandidateId
      || !HASH.test(String(payload.editorDiskIndexBaselineSha256 ?? ''))
      || textDigest(String(payload.note ?? '').trim()) !== selected.noteSha256) {
    fail('REV_INTERACTIVE_PAYLOAD_CORRUPT',
      'Frozen Candidate recovery lacks its exact capture authority payload.');
  }
  const { planSha256, ...manualCore } = manual;
  if (digest(manualCore) !== planSha256
      || manual.status !== 'ready-for-explicit-freeze'
      || manual.findings?.length !== 0
      || digest(manual.allowedPaths) !== digest(selected.allowedPaths)) {
    fail('REV_INTERACTIVE_PAYLOAD_CORRUPT',
      'Frozen Candidate recovery manual-plan evidence is invalid.');
  }
  return Object.freeze({ selected, manual,
    editorDiskIndexBaselineSha256: payload.editorDiskIndexBaselineSha256 });
}

function resourceDeltaPaths(parent, result) {
  const left = new Map((parent.candidate.resources ?? []).map((item) => [item.path, item]));
  const right = new Map((result.candidate.resources ?? []).map((item) => [item.path, item]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((item) => digest(left.get(item) ?? null) !== digest(right.get(item) ?? null))
    .sort();
}

function retainedCaptureResourcesMatch(manual, record) {
  const resources = new Map((record?.candidate?.resources ?? [])
    .map((resource) => [resource.path, resource]));
  return manual.drift.filter((item) => item.candidateDrift).every((item) => {
    const resource = resources.get(item.path);
    if (!resource) return false;
    if (item.saved == null) {
      return resource.deletion === true
        && resource.mode == null
        && resource.contentSha256 == null;
    }
    return resource.deletion !== true
      && resource.mode === item.saved.mode
      && resource.contentSha256 === item.saved.sha256;
  });
}

async function discoverRetainedCaptureCandidate(root, active, state, payload, parentCandidate,
  creator) {
  const expectedPaths = payload.manual.drift.filter((item) => item.candidateDrift)
    .map((item) => item.path).sort();
  const parent = await readSgosRetainedCandidate(root, parentCandidate.candidateId);
  const matches = (await listSgosCandidates(root)).filter((record) =>
    record?.kind === 'sgos-retained-candidate'
      && record.candidate.subject?.id === `${active.subject.workId}:${active.subject.phaseId}`
      && record.candidate.createdAt === state.captureStartedAt
      && record.candidate.createdBy?.kind === creator.kind
      && record.candidate.createdBy?.id === creator.id
      && record.repository.baselineCommit === parentCandidate.repository.baselineCommit
      && record.repository.candidateTree !== parentCandidate.repository.candidateTree
      && digest(resourceDeltaPaths(parent, record)) === digest(expectedPaths)
      && retainedCaptureResourcesMatch(payload.manual, record));
  if (matches.length > 1) {
    fail('REV_CAPTURE_RECOVERY_AMBIGUOUS',
      'More than one retained Candidate matches the interrupted capture authority.');
  }
  return matches.length ? sgosRevisionCandidateReference(
    root, matches[0].candidate.candidateId) : null;
}

async function completeFrozenCapture(root, active, captureState, payload, resultCandidate) {
  const { selected, manual, editorDiskIndexBaselineSha256 } = capturePayloadAuthority(
    payload, captureState);
  if (captureState.status !== 'candidate-frozen'
      || captureState.resultCandidateId !== resultCandidate.candidateId
      || await verifySgosRevisionCandidateReference(root, resultCandidate, {
        subjectId: `${active.subject.workId}:${active.subject.phaseId}`
      }) !== true) {
    fail('REV_CAPTURE_RECOVERY_UNPROVEN',
      'The retained result Candidate does not match the frozen capture pointer.');
  }
  const baseStore = revisionLoopStore(active);
  const loop = await baseStore.read();
  if (!loop || loop.status !== 'open' || loop.revision !== captureState.loopRevision
      || loop.head.candidateId !== captureState.parentCandidateId) {
    fail('REV_LOOP_ADVANCED', 'The revision loop head changed before precheck recovery.');
  }
  const parentCandidate = await completeCandidateReference(root, loop.head);
  const packet = await readRevisionRecord(root, 'revision-packet', captureState.packetSha256, {
    subject: active.subject
  });
  const live = { store: baseStore, loop, parentCandidate, packet,
    subjectId: `${active.subject.workId}:${active.subject.phaseId}` };
  const authority = await loadInteractiveAuthority(root, active, captureState, live);
  const claims = hunkClaimSet({ active, parentCandidate, resultCandidate, manual });
  await writeRevisionRecord(root, claims);
  const intervalContext = Object.freeze({
    ...loop.context, editorDiskIndexBaselineSha256
  });
  const current = { context: { editorDiskIndexBaselineSha256 } };
  const evidence = precheckEvidence({
    active, current, state: captureState, packet, claims, resultCandidate, manual
  });
  const intervalId = `REV-${active.subject.workId}-${String(loop.intervalSequence + 1).padStart(3, '0')}`;
  const attempt = buildRevisionAttempt({
    attemptId: `REVATT-${active.subject.workId}-${String(loop.intervalSequence + 1).padStart(3, '0')}-01`,
    intervalId, sequence: 1, subject: active.subject,
    parentCandidate: { candidateId: parentCandidate.candidateId,
      candidateSha256: parentCandidate.candidateSha256 },
    provider: producerIdentity(), status: 'candidate-frozen', reasonCode: null,
    effectSetSha256: captureState.captureEffectSetSha256,
    resultCandidate: { candidateId: resultCandidate.candidateId,
      candidateSha256: resultCandidate.candidateSha256,
      candidateTree: resultCandidate.repository.candidateTree,
      sourceManifestSha256: resultCandidate.sourceManifestSha256 },
    restorationReceiptSha256: null,
    startedAt: captureState.captureStartedAt, endedAt: captureState.captureEndedAt,
    producer: producerIdentity()
  });
  await writeRevisionRecord(root, attempt);
  const precheckPlan = await previewRevisionPrecheck({
    loopStore: baseStore, context: intervalContext, resultCandidate,
    routeInput: authority.routeInput, routePlan: authority.routePlan, packet,
    precheckEvidence: evidence,
    trigger: { kind: 'developer-feedback', feedbackId: authority.feedback.feedbackId,
      author: authority.feedback.author, feedbackSha256: authority.feedback.feedbackSha256,
      feedbackRecordSha256: authority.feedback.recordSha256,
      criteriaBindingSha256: authority.binding.bindingSha256,
      specificationDispositionSha256: authority.disposition.dispositionSha256,
      startPinSha256: captureState.startPinSha256, noteSha256: selected.noteSha256 },
    intervalId, executionAttempts: [attempt.attemptSha256], producer: producerIdentity(),
    startedAt: captureState.captureStartedAt, endedAt: captureState.captureEndedAt,
    idempotencyKey: selected.idempotencyKey,
    verifyCandidateReference: (reference) => verifySgosRevisionCandidateReference(root, reference, {
      subjectId: live.subjectId
    })
  });
  const precheckInput = precheckPlan.precheckInput;
  const precheck = precheckPlan.transition.precheck;
  const store = revisionLoopStore(active, { expectedPrecheck: precheck,
    expectedPrecheckInput: precheckInput, frozenCaptureContext: intervalContext });
  const precheckInputSha256 = await writeRevisionInteractivePayload(root, active.subject,
    precheckInput);
  if (precheckInputSha256 !== precheck.precheckInputsSha256) {
    fail('REV_INTERACTIVE_PAYLOAD_CORRUPT',
      'Precheck input storage returned a different content digest.');
  }
  await writeRevisionRecord(root, precheck);
  await writeRevisionRecord(root, precheckPlan.transition.interval);
  let committed;
  try {
    committed = await confirmRevisionPrecheck({
      loopStore: store, plan: precheckPlan, confirmation: precheckPlan.planSha256,
      readCurrentContext: async () => intervalContext,
      verifyCandidateReference: (reference) => verifySgosRevisionCandidateReference(root, reference, {
        subjectId: live.subjectId
      })
    });
  } catch (error) {
    if (error?.code === 'REV_LOOP_STALE') {
      fail('REV_CAPTURE_WORKTREE_DRIFT',
        'The worktree changed after the Candidate was frozen. The retained Candidate was preserved, but the loop head was not advanced. Restore the exact captured worktree bytes or explicitly abandon this revision attempt.');
    }
    throw error;
  }
  const nextState = await writeRevisionInteractiveState(root, {
    ...captureState, status: 'prechecked', loopRevision: committed.status.revision,
    resultCandidateId: resultCandidate.candidateId,
    precheckSha256: precheck.precheckSha256, precheckInputSha256,
    updatedAt: new Date().toISOString()
  }, { expectedStateSha256: captureState.stateSha256 });
  return Object.freeze({ replayed: false, state: nextState, resultCandidate,
    precheck, card: renderRevisionCard({ status: committed.status, precheck, state: nextState }) });
}

export async function confirmInteractiveCapture(root, {
  plan: suppliedPlan, confirmation, note, savedBuffersConfirmed
} = {}) {
  assertGuardedRevisionCapability('capture');
  const selected = validatePlan(suppliedPlan, CAPTURE_KIND);
  confirm(selected, confirmation);
  if (textDigest(String(note ?? '').trim()) !== selected.noteSha256) {
    fail('REV_PLAN_STALE', 'Capture note changed after preview.');
  }
  const active = await loadActiveRevisionStory(root);
  if (!scopeMatches(active.subject, selected.subject)) {
    fail('REV_PLAN_STALE', 'The active Story phase changed after capture preview.');
  }
  const state = await readRevisionInteractiveState(root, active.subject);
  if (!state || state.startPlanSha256 !== selected.startPlanSha256) {
    fail('REV_PLAN_STALE', 'The prepared interactive revision changed after capture preview.');
  }
  if (['awaiting-edit', 'candidate-frozen', 'prechecked'].includes(state.status)) {
    // Close the crash window between pointer publication and confirmation-result retention before
    // any capture can advance or replace the reconstructable awaiting-edit state.
    await ensureStartConfirmationResult(root, active, state);
  }
  if (state.status === 'prechecked' && state.resultCandidateId) {
    if (state.capturePlanSha256 !== selected.planSha256) {
      fail('REV_PLAN_STALE', 'Completed capture belongs to another exact plan.');
    }
    return Object.freeze({ replayed: true, state,
      precheckInput: await readRevisionInteractivePayload(root, active.subject,
        state.precheckInputSha256) });
  }
  if (state.status === 'capturing') {
    fail('REV_RECOVERY_REQUIRED',
      'Capture was interrupted. Run revision resume; never repeat its uncertain attempt directly.');
  }
  if (state.status === 'candidate-frozen' && state.resultCandidateId) {
    const payload = await readRevisionInteractivePayload(
      root, active.subject, state.capturePayloadSha256);
    capturePayloadAuthority(payload, state);
    return completeFrozenCapture(root, active, state, payload,
      await sgosRevisionCandidateReference(root, state.resultCandidateId));
  }
  const live = await liveCapturePlan(root, active, state, { note, savedBuffersConfirmed });
  if (live.manual.planSha256 !== selected.manualPlanSha256
      || digest(live.manual.allowedPaths) !== digest(selected.allowedPaths)) {
    fail('REV_PLAN_STALE', 'Saved files, index, or editor assertion changed after capture preview.');
  }
  // Resolve every immutable authority and revocation-sensitive attachment before the first
  // Candidate/Git-object effect. These exact objects are reused below and rechecked at loop CAS.
  const authority = await loadInteractiveAuthority(root, active, state, live);
  const creator = Object.freeze({
    candidate: { kind: 'human', id: authority.feedback.author.id },
    feedback: authority.feedback.author
  });
  if (digest(revisionCreator(active)) !== digest(creator)) {
    fail('REV_PLAN_STALE',
      'Repository identity or approval membership changed after the interval was opened.');
  }
  const capturePayload = Object.freeze({
    schemaVersion: 1, kind: 'revision-interactive-capture-authority',
    plan: selected, note: String(note ?? '').trim(), manual: live.manual,
    parentCandidateId: live.parentCandidate.candidateId,
    editorDiskIndexBaselineSha256: live.observed.context.editorDiskIndexBaselineSha256
  });
  const capturePayloadSha256 = await writeRevisionInteractivePayload(
    root, active.subject, capturePayload);
  let captureState = state;
  if (state.status === 'awaiting-edit') {
    const captureStartedAt = new Date().toISOString();
    captureState = await writeRevisionInteractiveState(root, {
      ...state, status: 'capturing', capturePlanSha256: selected.planSha256,
      capturePayloadSha256, captureEffectSetSha256: null, recoveryCode: null,
      captureStartedAt, captureEndedAt: null, updatedAt: captureStartedAt
    }, { expectedStateSha256: state.stateSha256 });
  } else if (!['capturing', 'candidate-frozen'].includes(state.status)
      || state.capturePlanSha256 !== selected.planSha256
      || state.capturePayloadSha256 !== capturePayloadSha256) {
    fail('REV_INTERACTIVE_STATE_ADVANCED',
      'The interactive capture state does not match this exact confirmed capture plan.');
  }
  let frozen;
  try {
    if (captureState.status === 'candidate-frozen' && captureState.resultCandidateId) {
      frozen = { frozen: {
        childCandidate: await sgosRevisionCandidateReference(root, captureState.resultCandidateId),
        effectSetSha256: captureState.captureEffectSetSha256
      } };
    } else {
      frozen = await confirmManualRevision({
        plan: live.manual, confirmation: live.manual.planSha256,
        root, subjectId: live.subjectId, parentCandidate: live.parentCandidate,
        config: active.config, workflow: active.workflow,
        verifySavedEditorBuffers: live.proof,
        verifyAdmission: async ({ plan: admittedPlan, attemptResult }) =>
          admittedPlan.planSha256 === live.manual.planSha256
            && attemptResult.cleanup?.verified === true
            && attemptResult.changes.every((change) => live.manual.allowedPaths.includes(change.path)),
        createdBy: creator.candidate,
        // The pointer timestamp is immutable for this interval request, making Candidate retention
        // replay-safe across a process crash after object creation.
        createdAt: captureState.captureStartedAt
      });
    }
  } catch (error) {
    if (captureState.status === 'capturing' && [
      'REV_MANUAL_PLAN_STALE', 'REV_MANUAL_PLAN_UNVERIFIED',
      'REV_MANUAL_ADMISSION_REQUIRED', 'REV_MANUAL_ATTEMPT_UNAVAILABLE',
      'REV_MANUAL_CAPTURE_UNAVAILABLE'
    ].includes(error?.code)) {
      await writeRevisionInteractiveState(root, {
        ...captureState, status: 'awaiting-edit', capturePlanSha256: null,
        capturePayloadSha256: null, captureEffectSetSha256: null,
        captureStartedAt: null, captureEndedAt: null,
        updatedAt: new Date().toISOString()
      }, { expectedStateSha256: captureState.stateSha256 });
    }
    if (['REV_ATTEMPT_ROLLBACK_FAILED', 'REV_ATTEMPT_FREEZE_RECOVERY_REQUIRED']
      .includes(error?.code)) {
      await writeRevisionInteractiveState(root, {
        ...captureState, status: 'recovery-required', recoveryCode: error.code,
        updatedAt: new Date().toISOString()
      }, { expectedStateSha256: captureState.stateSha256 });
    }
    throw error;
  }
  const resultCandidate = frozen.frozen.childCandidate;
  if (captureState.status !== 'candidate-frozen') {
    const captureEndedAt = new Date().toISOString();
    captureState = await writeRevisionInteractiveState(root, {
      ...captureState, status: 'candidate-frozen', resultCandidateId: resultCandidate.candidateId,
      captureEffectSetSha256: frozen.frozen.effectSetSha256, recoveryCode: null,
      captureEndedAt, updatedAt: captureEndedAt
    }, { expectedStateSha256: captureState.stateSha256 });
  }
  return completeFrozenCapture(root, active, captureState, capturePayload, resultCandidate);
}

export function renderRevisionCard({
  status, precheck, state = null, historical = false, freshness = 'current'
}) {
  const stateName = state?.status ?? status?.state ?? 'absent';
  if (historical && precheck) return Object.freeze({
    headline: `Historical revision interval · candidate ${precheck.candidateId}`,
    candidate: { id: precheck.candidateId, sha256: precheck.candidateSha256,
      tree: precheck.candidateTree },
    criteria: precheck.criteria, unexplainedHunks: precheck.unexplainedHunks,
    refusals: precheck.refusalSummary, verification: 'historical',
    publicationEligible: false, remainingObligations: [
      ...(precheck.remainingObligations ?? []), 'historical-interval-is-not-current-authority'
    ], next: 'revision.card'
  });
  if (!precheck) {
    const projections = {
      absent: ['No active local revision loop.', 'revise.preview'],
      opening: ['Revision opening is incomplete.', 'revision.resume'],
      'awaiting-edit': ['Revision is awaiting saved implementation changes.', 'revision.capture'],
      capturing: ['Revision capture was interrupted before its outcome was certain.', 'revision.resume'],
      'candidate-frozen': ['Result Candidate is retained; deterministic precheck is pending.', 'revision.resume'],
      abandoning: ['Revision abandonment is durably pending journal reconciliation.', 'revision.resume'],
      'recovery-required': ['Revision requires an approved local recovery adapter.', 'revision.status'],
      abandoned: ['Revision loop was abandoned; its retained head remains local review evidence only.', 'revision.status']
    };
    const [headline, next] = projections[stateName] ?? projections.absent;
    return Object.freeze({
      headline, candidate: status?.head ?? null, criteria: [], unexplainedHunks: [],
      publicationEligible: false,
      remainingObligations: stateName === 'recovery-required'
        ? [state?.recoveryCode ?? 'manual-recovery-adapter-required'] : [],
      ...(stateName === 'recovery-required' ? {
        recoveryGuidance: 'Inspect status and use an approved recovery adapter; resume will not repeat an uncertain attempt.'
      } : {}),
      next
    });
  }
  return Object.freeze({
    headline: `${status.scope.phaseId} · revision ${status.intervalSequence} · candidate ${precheck.candidateId}`,
    candidate: {
      id: precheck.candidateId, sha256: precheck.candidateSha256,
      tree: precheck.candidateTree
    },
    criteria: precheck.criteria,
    unexplainedHunks: precheck.unexplainedHunks,
    refusals: precheck.refusalSummary,
    verification: 'not-started',
    // The bridge is intentionally narrow: this current card may be consumed only when the
    // deterministic receipt itself is eligible. Historical, stale, incomplete, or uncertain
    // pointers remain non-authoritative and the Story transaction rechecks every binding.
    publicationEligible: freshness === 'current' && precheck.publicationEligible === true,
    remainingObligations: [...new Set([
      ...(precheck.remainingObligations ?? []),
      ...(freshness === 'current' ? [] : ['refresh-precheck-after-worktree-change'])
    ])],
    next: freshness === 'current' && precheck.publicationEligible
      ? 'phase.publish-code' : freshness === 'current'
        ? 'revision.revise-or-inspect' : 'revision.capture-or-recover'
  });
}

async function reconciliationProjection(root, active, state, entries) {
  const latest = entries.at(-1) ?? null;
  if (!state || !latest || latest.transition?.type !== 'commit-interval'
      || latest.revision <= state.loopRevision) return null;
  const interval = latest.transition.interval;
  const precheck = latest.transition.precheck;
  const exact = latest.revision === state.loopRevision + 1
    && latest.transition.loopId === state.loopId
    && interval?.subject?.workId === active.subject.workId
    && interval?.subject?.phaseId === active.subject.phaseId
    && interval?.subject?.phaseGeneration === active.subject.phaseGeneration
    && interval?.parentCandidate?.candidateId === state.parentCandidateId
    && interval?.packetSha256 === state.packetSha256
    && precheck?.precheckSha256 === interval?.precheckSha256
    && HASH.test(String(precheck?.precheckInputsSha256 ?? ''));
  if (!exact) return Object.freeze({ required: true, recoverable: false,
    reason: 'journal-and-pointer-do-not-form-one-exact-interval', revision: latest.revision,
    intervalId: interval?.intervalId ?? null });
  try {
    await readRevisionInteractivePayload(root, active.subject, precheck.precheckInputsSha256);
  } catch {
    return Object.freeze({ required: true, recoverable: false,
      reason: 'precheck-input-payload-missing-or-corrupt', revision: latest.revision,
      intervalId: interval.intervalId });
  }
  return Object.freeze({ required: true, recoverable: true, revision: latest.revision,
    intervalId: interval.intervalId, resultCandidateId: interval.resultCandidate.candidateId,
    precheckSha256: precheck.precheckSha256,
    precheckInputSha256: precheck.precheckInputsSha256 });
}

/** Reconcile only a journal interval whose exact immutable payload was durable before its CAS. */
export async function resumeInteractiveRevision(root, intervalId = null) {
  assertGuardedRevisionCapability('recovery');
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject);
  if (!state) {
    fail('REV_RECOVERY_NOT_REQUIRED', 'The active Story phase has no interactive revision state to recover.');
  }
  if (state?.status === 'opening') {
    if (intervalId != null) {
      fail('REV_INTERVAL_UNKNOWN', 'The durable opening has no interval ID yet. Resume without an interval ID.');
    }
    const repaired = await completeOpeningState(root, active, state);
    return Object.freeze({ replayed: false, recovered: true, state: repaired,
      recovery: { required: true, recoverable: true, kind: 'loop-opening' } });
  }
  if (state.status === 'abandoning') {
    if (intervalId != null) {
      fail('REV_INTERVAL_UNKNOWN',
        'The durable abandonment is a loop transition, not a revision interval. Resume without an interval ID.');
    }
    const result = await completeAbandoningState(root, active, state);
    return Object.freeze({ replayed: false, recovered: true, state: result.state,
      recovery: { required: true, recoverable: true, kind: 'loop-abandonment' } });
  }
  // Reconcile a committed journal interval before branching on the pointer status. A crash can
  // leave the pointer at candidate-frozen even though the loop CAS already committed the interval.
  const store = revisionLoopStore(active);
  const entries = await store.list();
  const recovery = await reconciliationProjection(root, active, state, entries);
  if (recovery) {
    if (intervalId != null && intervalId !== recovery.intervalId) {
      fail('REV_INTERVAL_UNKNOWN', `Revision interval '${intervalId}' is not the recoverable interval.`);
    }
    if (!recovery.recoverable) {
      const blocked = await writeRevisionInteractiveState(root, {
        ...state, status: 'recovery-required', recoveryCode: 'REV_POINTER_RECONCILIATION_UNPROVEN',
        updatedAt: new Date().toISOString()
      }, { expectedStateSha256: state.stateSha256 });
      return Object.freeze({ replayed: false, recovered: false, state: blocked, recovery });
    }
    const repaired = await writeRevisionInteractiveState(root, {
      ...state, status: 'prechecked', loopRevision: recovery.revision,
      resultCandidateId: recovery.resultCandidateId,
      precheckSha256: recovery.precheckSha256,
      precheckInputSha256: recovery.precheckInputSha256,
      updatedAt: new Date().toISOString()
    }, { expectedStateSha256: state.stateSha256 });
    return Object.freeze({ replayed: false, recovered: true, state: repaired, recovery });
  }
  if (state.status === 'capturing') {
    let payload;
    let recoveredCandidate = null;
    try {
      payload = await readRevisionInteractivePayload(
        root, active.subject, state.capturePayloadSha256);
      capturePayloadAuthority(payload, state);
      const loop = await store.read();
      if (!loop || loop.status !== 'open' || loop.revision !== state.loopRevision
          || loop.head.candidateId !== state.parentCandidateId) {
        fail('REV_LOOP_ADVANCED', 'The revision loop head changed during capture recovery.');
      }
      const parentCandidate = await completeCandidateReference(root, loop.head);
      const records = await loadInteractiveRecords(root, active, state);
      recoveredCandidate = await discoverRetainedCaptureCandidate(
        root, active, state, payload, parentCandidate,
        { kind: 'human', id: records.feedback.author.id });
    } catch (error) {
      if (error?.code === 'REV_CAPTURE_RECOVERY_AMBIGUOUS') throw error;
      recoveredCandidate = null;
    }
    if (recoveredCandidate) {
      const captureEndedAt = new Date().toISOString();
      const frozenState = await writeRevisionInteractiveState(root, {
        ...state, status: 'candidate-frozen',
        resultCandidateId: recoveredCandidate.candidateId,
        captureEffectSetSha256: recoveredCandidate.effectSetSha256,
        recoveryCode: null, captureEndedAt, updatedAt: captureEndedAt
      }, { expectedStateSha256: state.stateSha256 });
      const completed = await completeFrozenCapture(
        root, active, frozenState, payload, recoveredCandidate);
      return Object.freeze({ ...completed, recovered: true,
        recovery: { required: true, recoverable: true,
          kind: 'retained-candidate-precheck' } });
    }
    const blocked = await writeRevisionInteractiveState(root, {
      ...state, status: 'recovery-required', recoveryCode: 'REV_CAPTURE_OUTCOME_UNCERTAIN',
      updatedAt: new Date().toISOString()
    }, { expectedStateSha256: state.stateSha256 });
    return Object.freeze({ replayed: false, recovered: false, state: blocked,
      recovery: {
        required: true, recoverable: false, kind: 'capture-outcome-uncertain',
        code: blocked.recoveryCode,
        guidance: 'No exact retained Candidate matched the interrupted built-in capture. Inspect cleanup/object retention with an approved recovery adapter; never repeat or abandon the uncertain attempt.'
      } });
  }
  if (state.status === 'candidate-frozen') {
    const payload = await readRevisionInteractivePayload(
      root, active.subject, state.capturePayloadSha256);
    capturePayloadAuthority(payload, state);
    const result = await completeFrozenCapture(root, active, state, payload,
      await sgosRevisionCandidateReference(root, state.resultCandidateId));
    return Object.freeze({ replayed: result.replayed === true, recovered: true,
      state: result.state, recovery: { required: true, recoverable: true,
        kind: 'candidate-frozen-precheck' } });
  }
  if (state.status === 'recovery-required') {
    return Object.freeze({ replayed: true, recovered: false, state,
      recovery: { required: true, recoverable: false, kind: 'manual-recovery-required',
        code: state.recoveryCode } });
  }
  if (state.status === 'prechecked'
      && (intervalId == null || entries.at(-1)?.transition?.interval?.intervalId === intervalId)) {
    return Object.freeze({ replayed: true, recovered: true, state });
  }
  fail('REV_RECOVERY_NOT_REQUIRED', 'The active revision has no recoverable journal/pointer gap.');
}

export async function inspectInteractiveRevision(root) {
  assertGuardedRevisionCapability('inspect');
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject, { optional: true });
  const store = revisionLoopStore(active);
  const status = await readRevisionLoopStatus({ loopStore: store });
  let precheck = null;
  let interval = null;
  const entries = await store.list();
  const latest = entries.at(-1);
  let freshness = Object.freeze({ status: 'current', code: null });
  if (latest?.transition?.type === 'commit-interval'
      && state?.status === 'prechecked'
      && state.loopRevision === latest.revision
      && state.precheckSha256 === latest.transition.precheck?.precheckSha256) {
    precheck = latest.transition.precheck;
    interval = latest.transition.interval;
    try {
      const loop = await store.read();
      await readPinnedRevisionContext(active, loop.context);
      if (!state?.precheckInputSha256) {
        fail('REV_PRECHECK_STALE', 'Interactive pointer lacks the exact precheck input identity.');
      }
      const input = await readRevisionInteractivePayload(root, active.subject,
        state.precheckInputSha256);
      assertCurrentRevisionPrecheck(precheck, input);
    } catch (error) {
      freshness = Object.freeze({ status: 'stale',
        code: error?.code ?? 'REV_PRECHECK_STALE' });
    }
  }
  const recovery = await reconciliationProjection(root, active, state, entries);
  const card = renderRevisionCard({ status, precheck, state, freshness: freshness.status });
  const safeCard = freshness.status === 'current' ? card : Object.freeze({
    ...card, publicationEligible: false,
    remainingObligations: [...new Set([
      ...(card.remainingObligations ?? []), 'refresh-precheck-after-worktree-change'
    ])], next: 'revision.capture-or-recover'
  });
  return Object.freeze({ active: { subject: active.subject, phaseStatus: active.phase.status },
    state, status, interval, precheck, freshness, recovery, card: safeCard });
}

export async function resolveIntervalRecordChain(root, active, entry) {
  const embeddedInterval = entry.transition.interval;
  const embeddedPrecheck = entry.transition.precheck;
  const selected = { subject: active.subject };
  const interval = await readRevisionRecord(root, 'revision-interval',
    embeddedInterval.intervalSha256, selected);
  const precheck = await readRevisionRecord(root, 'revision-precheck',
    embeddedPrecheck.precheckSha256, selected);
  if (digest(interval) !== digest(embeddedInterval)
      || digest(precheck) !== digest(embeddedPrecheck)) {
    fail('REV_RECORD_CHAIN_STALE',
      'Journal interval or precheck bytes differ from their content-addressed records.');
  }
  const [packet, feedback, binding, disposition, claims, attempts, precheckInput] =
    await Promise.all([
      readRevisionRecord(root, 'revision-packet', interval.packetSha256, selected),
      readRevisionRecord(root, 'revision-feedback', interval.trigger.feedbackRecordSha256, selected),
      readRevisionRecord(root, 'revision-criteria-binding', interval.criteriaBindingSha256, selected),
      readRevisionRecord(root, 'revision-specification-disposition',
        interval.specificationDispositionSha256, selected),
      readRevisionRecord(root, 'revision-hunk-claim-set', interval.hunkClaimSetSha256, selected),
      Promise.all(interval.executionAttempts.map((attemptSha256) =>
        readRevisionRecord(root, 'revision-attempt', attemptSha256, selected))),
      readRevisionInteractivePayload(root, active.subject, precheck.precheckInputsSha256)
    ]);
  const restorations = await Promise.all(attempts
    .filter((attempt) => attempt.restorationReceiptSha256 !== null)
    .map((attempt) => readRevisionRecord(root, 'revision-attempt-restoration',
      attempt.restorationReceiptSha256, selected)));
  const producerSha256 = digest(interval.producer);
  const producerRecords = [packet, feedback, binding, disposition, claims, precheck, ...attempts,
    ...restorations];
  const frozenAttempts = attempts.filter((attempt) => attempt.status === 'candidate-frozen');
  const restorationBySha256 = new Map(restorations.map((restoration) =>
    [restoration.restorationReceiptSha256, restoration]));
  if (packet.parentCandidate.candidateId !== interval.parentCandidate.candidateId
      || packet.parentCandidate.candidateSha256 !== interval.parentCandidate.candidateSha256
      || packet.parentCandidate.candidateRefSha256 !== interval.parentCandidate.candidateRefSha256
      || packet.feedback.feedbackId !== feedback.feedbackId
      || packet.feedback.feedbackSha256 !== feedback.feedbackSha256
      || packet.feedback.feedbackRecordSha256 !== feedback.recordSha256
      || binding.feedbackSha256 !== feedback.feedbackSha256
      || disposition.feedbackSha256 !== feedback.feedbackSha256
      || disposition.bindingSha256 !== binding.bindingSha256
      || packet.criteriaBindingSha256 !== binding.bindingSha256
      || packet.specificationDispositionSha256 !== disposition.dispositionSha256
      || interval.trigger.feedbackId !== feedback.feedbackId
      || interval.trigger.feedbackSha256 !== feedback.feedbackSha256
      || interval.trigger.criteriaBindingSha256 !== binding.bindingSha256
      || interval.trigger.specificationDispositionSha256 !== disposition.dispositionSha256
      || claims.parentCandidateId !== interval.parentCandidate.candidateId
      || claims.resultCandidateId !== interval.resultCandidate.candidateId
      || precheck.criteriaBindingSha256 !== binding.bindingSha256
      || precheck.specificationDispositionSha256 !== disposition.dispositionSha256
      || precheck.hunkClaimSetSha256 !== claims.claimSetSha256
      || precheck.candidateId !== interval.resultCandidate.candidateId
      || precheck.candidateSha256 !== interval.resultCandidate.candidateSha256
      || precheck.candidateRefSha256 !== interval.resultCandidate.candidateRefSha256
      || precheck.candidateTree !== interval.resultCandidate.candidateTree
      || attempts.some((attempt, index) => attempt.intervalId !== interval.intervalId
        || attempt.sequence !== index + 1
        || attempt.parentCandidate.candidateId !== interval.parentCandidate.candidateId
        || attempt.parentCandidate.candidateSha256 !== interval.parentCandidate.candidateSha256
        || (attempt.restorationReceiptSha256 !== null
          && (restorationBySha256.get(attempt.restorationReceiptSha256)?.attemptId !== attempt.attemptId
            || restorationBySha256.get(attempt.restorationReceiptSha256)?.parentCandidate.candidateId
              !== attempt.parentCandidate.candidateId
            || restorationBySha256.get(attempt.restorationReceiptSha256)?.parentCandidate.candidateSha256
              !== attempt.parentCandidate.candidateSha256)))
      || frozenAttempts.length !== 1
      || frozenAttempts[0].resultCandidate?.candidateId !== interval.resultCandidate.candidateId
      || frozenAttempts[0].resultCandidate?.candidateSha256 !== interval.resultCandidate.candidateSha256
      || frozenAttempts[0].resultCandidate?.candidateTree !== interval.resultCandidate.candidateTree
      || producerRecords.some((record) => digest(record.producer) !== producerSha256)) {
    fail('REV_RECORD_CHAIN_STALE',
      'Interval references do not form one exact feedback, packet, attempt, Candidate, claim, and precheck chain.');
  }
  assertCurrentRevisionPrecheck(precheck, precheckInput);
  return Object.freeze({
    interval, precheck, packet, feedback, binding, disposition, claims,
    attempts: Object.freeze(attempts), restorations: Object.freeze(restorations), precheckInput
  });
}

export async function showInteractiveInterval(root, intervalId) {
  assertGuardedRevisionCapability('inspect');
  const active = await loadActiveRevisionStory(root);
  const store = revisionLoopStore(active);
  const entry = (await store.list()).find((candidate) =>
    candidate.transition?.type === 'commit-interval'
      && candidate.transition.interval?.intervalId === intervalId);
  if (!entry) fail('REV_INTERVAL_UNKNOWN', `Revision interval '${intervalId}' is not in the active local loop.`);
  const chain = await resolveIntervalRecordChain(root, active, entry);
  return Object.freeze({ ...chain, headSnapshot: entry.transition.headSnapshot,
    loop: await store.projection(),
    journal: { revision: entry.revision, entrySha256: entry.entrySha256 } });
}

export async function previewInteractiveAbandon(root) {
  assertGuardedRevisionCapability('recovery');
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject);
  const store = revisionLoopStore(active);
  const loop = await store.read();
  if (!state || !loop || loop.status !== 'open') fail('REV_LOOP_ADVANCED', 'No open local revision loop can be abandoned.');
  if (!['awaiting-edit', 'prechecked'].includes(state.status)) {
    fail('REV_RECOVERY_REQUIRED',
      'An opening, in-flight, or uncertain revision cannot be abandoned. Run revision resume and preserve its exact recovery evidence.');
  }
  const current = await readRevisionContext(active);
  const pinnedContext = Object.freeze({
    ...loop.context,
    editorDiskIndexBaselineSha256: current.context.editorDiskIndexBaselineSha256
  });
  return plan('revision-interactive-abandon-plan', {
    subject: active.subject, loopId: loop.loopId, expectedRevision: loop.revision,
    expectedHeadCandidateRefSha256: loop.head.candidateRefSha256,
    context: pinnedContext,
    idempotencyKey: idempotency('REVABANDON', { loopId: loop.loopId, revision: loop.revision }),
    effects: { codeChanged: false, lifecycleChanged: false, externalSystemsChanged: false,
      localLoopStateChanged: true }
  });
}

async function completeAbandoningState(root, active, state) {
  if (state.status !== 'abandoning' || !state.abandonPayloadSha256) {
    fail('REV_INTERACTIVE_STATE_ADVANCED',
      'The interactive revision is not at a recoverable abandonment checkpoint.');
  }
  const payload = await readRevisionInteractivePayload(
    root, active.subject, state.abandonPayloadSha256);
  if (payload?.kind !== 'revision-interactive-abandon-authority'
      || payload.plan?.planSha256 !== state.abandonPlanSha256) {
    fail('REV_INTERACTIVE_PAYLOAD_CORRUPT',
      'Pending abandonment lacks its exact immutable authority payload.');
  }
  const selected = validatePlan(payload.plan, 'revision-interactive-abandon-plan');
  if (!scopeMatches(active.subject, selected.subject)
      || selected.loopId !== state.loopId
      || selected.expectedRevision !== state.loopRevision) {
    fail('REV_PLAN_STALE', 'Pending abandonment no longer matches the active Story loop.');
  }
  const store = revisionLoopStore(active);
  // append() is idempotent on this exact immutable request. If the journal CAS completed before a
  // crash it returns that entry; otherwise it performs the single pending transition now.
  const entry = await store.append({
    expectedRevision: selected.expectedRevision,
    expectedHeadCandidateRefSha256: selected.expectedHeadCandidateRefSha256,
    context: selected.context, idempotencyKey: selected.idempotencyKey,
    transition: { type: 'abandon-loop', loopId: selected.loopId }
  });
  const next = await writeRevisionInteractiveState(root, {
    ...state, status: 'abandoned', loopRevision: entry.revision,
    updatedAt: new Date().toISOString()
  }, { expectedStateSha256: state.stateSha256 });
  return Object.freeze({ entry, state: next });
}

export async function confirmInteractiveAbandon(root, { plan: suppliedPlan, confirmation } = {}) {
  assertGuardedRevisionCapability('recovery');
  const selected = validatePlan(suppliedPlan, 'revision-interactive-abandon-plan');
  confirm(selected, confirmation);
  const active = await loadActiveRevisionStory(root);
  if (!scopeMatches(active.subject, selected.subject)) fail('REV_PLAN_STALE', 'Active Story phase changed.');
  await readPinnedRevisionContext(active, selected.context);
  let prior = await readRevisionInteractiveState(root, active.subject);
  if (!prior || prior.loopId !== selected.loopId) {
    fail('REV_LOOP_ADVANCED', 'Revision loop changed after abandonment preview.');
  }
  if (prior.status === 'abandoned' && prior.abandonPlanSha256 === selected.planSha256) {
    return replayInteractiveAbandonConfirmation(root, {
      confirmation: selected.planSha256, targetId: selected.loopId
    });
  }
  if (['awaiting-edit', 'prechecked'].includes(prior.status)) {
    await ensureStartConfirmationResult(root, active, prior);
  }
  const payload = Object.freeze({
    schemaVersion: 1, kind: 'revision-interactive-abandon-authority', plan: selected
  });
  const abandonPayloadSha256 = await writeRevisionInteractivePayload(
    root, active.subject, payload);
  if (prior.status !== 'abandoning') {
    if (!['awaiting-edit', 'prechecked'].includes(prior.status)
        || prior.loopRevision !== selected.expectedRevision) {
      fail('REV_LOOP_ADVANCED', 'Revision loop advanced after abandonment preview.');
    }
    prior = await writeRevisionInteractiveState(root, {
      ...prior, status: 'abandoning', abandonPlanSha256: selected.planSha256,
      abandonPayloadSha256, updatedAt: new Date().toISOString()
    }, { expectedStateSha256: prior.stateSha256 });
  } else if (prior.abandonPlanSha256 !== selected.planSha256
      || prior.abandonPayloadSha256 !== abandonPayloadSha256) {
    fail('REV_INTERACTIVE_STATE_ADVANCED',
      'Another exact abandonment is already pending for this revision loop.');
  }
  return completeAbandoningState(root, active, prior);
}

export async function replayInteractiveAbandonConfirmation(root, {
  confirmation, targetId
} = {}) {
  if (!HASH.test(String(confirmation ?? ''))) return null;
  const active = await loadActiveRevisionStory(root);
  const state = await readRevisionInteractiveState(root, active.subject, { optional: true });
  if (!state || state.status !== 'abandoned' || state.abandonPlanSha256 !== confirmation) return null;
  const store = revisionLoopStore(active);
  const entries = await store.list();
  const entry = entries.at(-1);
  const previousIntervalId = [...entries].reverse().find((item) =>
    item.transition?.type === 'commit-interval')?.transition?.interval?.intervalId ?? null;
  if (targetId !== null && targetId !== state.loopId && targetId !== previousIntervalId) return null;
  if (entry?.transition?.type !== 'abandon-loop' || entry.transition.loopId !== state.loopId
      || entry.revision !== state.loopRevision) {
    fail('REV_LOOP_CORRUPT', 'Abandoned interactive state does not match the exact loop journal.');
  }
  return Object.freeze({ replayed: true, entry, state });
}

export const interactiveRevisionKinds = Object.freeze({ start: START_KIND, capture: CAPTURE_KIND });
