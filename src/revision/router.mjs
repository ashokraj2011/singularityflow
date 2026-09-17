/** Deterministic REV phase-and-intent routing. No model, file write, or provider call. */
import { createHash } from 'node:crypto';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { scanText } from '../secrets.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DISPOSITIONS = new Set([
  'implementation-change', 'approved-intent-change', 'artifact-change',
  'clarification', 'new-work', 'unknown'
]);
const ROUTES = Object.freeze({
  'code-revision': 'revision.code',
  'artifact-revision': 'artifact.revise',
  amendment: 'story.amend',
  clarification: 'story.clarify',
  'implementation-reopen': 'implementation.reopen',
  'release-plan-revision': 'release.plan.revise',
  'outcome-review': 'outcome.review',
  'new-work': 'work.create'
});

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
export function revisionTextSha256(text) {
  return `sha256:${createHash('sha256').update(Buffer.from(text)).digest('hex')}`;
}
function requireHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_ROUTE_INPUT', `${label} must be an exact SHA-256 digest.`);
  return value;
}
function boundedText(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 8192) {
    fail('REV_FEEDBACK_INVALID', 'Feedback must be nonempty and no more than 8192 UTF-8 bytes.');
  }
  if (scanText(value).length) fail('REV_FEEDBACK_SECRET', 'Feedback may contain a credential; routing was refused.');
  return value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail('REV_ROUTE_INPUT', `${label} is missing or invalid.`);
  }
  return value;
}
function positiveGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('REV_ROUTE_INPUT', 'Phase generation must be a non-negative integer.');
  return value;
}
function candidateShaped(value) {
  return value && ['sgos-candidate', 'auto-candidate'].includes(value.family)
    && /^CAN-[A-Za-z0-9._:-]{6,127}$/.test(String(value.candidateId ?? ''))
    && typeof value.namespace === 'string'
    && value.namespace.startsWith('refs/singularity-flow/')
    && HASH.test(String(value.candidateSha256 ?? ''))
    && HASH.test(String(value.retainedRecordSha256 ?? ''))
    && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(value.repository?.candidateTree ?? ''));
}

/** Verify selected receipt integrity. The caller must also load it from the private evidence store. */
export function verifyRevisionAttachmentSet(receipt, { subject, feedbackSha256, binding }) {
  if (receipt && Buffer.byteLength(canonicalJson(receipt)) > 64 * 1024) {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Attachment-set receipt exceeds its bounded metadata limit.');
  }
  if (!receipt || receipt.kind !== 'revision-feedback-attachment-set' || receipt.confirmed !== true
      || !HASH.test(receipt.attachmentSetSha256)) {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', 'A confirmed, persisted feedback-attachment-set receipt is required.');
  }
  const { attachmentSetSha256, ...core } = receipt;
  if (hash(core) !== attachmentSetSha256 || !Array.isArray(receipt.attachments)
      || receipt.attachments.length < 1 || receipt.attachments.length > 5) {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Attachment-set receipt failed its content or selection proof.');
  }
  if (!HASH.test(String(binding.repositorySha256 ?? ''))
      || receipt.workId !== subject.workId || receipt.phaseId !== subject.phaseId
      || receipt.phaseGeneration !== subject.phaseGeneration
      || receipt.feedbackSha256 !== feedbackSha256
      || receipt.configSha256 !== binding.configSha256
      || receipt.workflowSha256 !== binding.workflowSha256
      || receipt.headCommit !== binding.headCommit
      || receipt.sourceTreeSha256 !== binding.sourceTreeSha256
      || receipt.repositorySha256 !== binding.repositorySha256
      || (binding.loopId != null && receipt.loopId !== binding.loopId)
      || (binding.loopRevision != null && receipt.loopRevision !== binding.loopRevision)) {
    fail('REV_ATTACHMENT_SET_STALE', 'Attachment set does not match the current feedback, loop, phase, or repository binding.');
  }
  for (const item of receipt.attachments) {
    if (item.kind !== 'user-document' || item.modelReadable !== true
        || !HASH.test(item.originalSha256) || !HASH.test(item.renditionSha256)
        || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 10 * 1024 * 1024
        || item.accessClass !== 'private') {
      fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Selected attachment lacks a bounded, verified rendition.');
    }
  }
  return attachmentSetSha256;
}

/** Read through the governed store, so a self-hashed synthetic receipt is never called registered. */
export async function planRevisionRouteWithRegisteredAttachments({
  context, feedbackText, attachmentSetSha256 = null, store = null
}) {
  let attachmentSet = null;
  if (attachmentSetSha256 != null) {
    requireHash(attachmentSetSha256, 'Attachment set');
    if (typeof store?.read !== 'function') {
      fail('REV_ATTACHMENT_SET_UNVERIFIED', 'A governed attachment store read is required for routing.');
    }
    attachmentSet = await store.read(attachmentSetSha256);
    if (attachmentSet?.attachmentSetSha256 !== attachmentSetSha256) {
      fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Selected attachment set was not found in the governed store.');
    }
  }
  return { plan: planRevisionRoute({ context, feedbackText, attachmentSet }), attachmentSet };
}

function routeFor(context) {
  const disposition = context.specificationDisposition;
  if (context.publicationRecovery || context.loopRecovery) {
    return { route: 'unavailable', reasonCode: 'REV_RECOVERY_REQUIRED', nextOperation: 'revision.recovery' };
  }
  if (disposition === 'approved-intent-change') return { route: 'amendment' };
  if (disposition === 'clarification' || disposition === 'unknown') return { route: 'clarification' };
  if (disposition === 'new-work') return { route: 'new-work' };
  if (context.target?.kind === 'generated-architecture') {
    return { route: 'unavailable', reasonCode: 'REV_GENERATED_PROJECTION', nextOperation: 'architecture.source.revise' };
  }
  if (disposition === 'artifact-change' || context.phaseTask !== 'code') {
    if (context.target?.status === 'approved' || context.target?.status === 'published') return { route: 'amendment' };
    if (context.target?.kind === 'release-plan') return { route: 'release-plan-revision' };
    if (context.target?.status === 'draft') return { route: 'artifact-revision' };
    return { route: 'unavailable', reasonCode: 'REV_ROUTE_UNAVAILABLE', nextOperation: 'phase.show' };
  }
  if (context.phaseStatus === 'published' || context.published === true) return { route: 'implementation-reopen' };
  if (context.phaseStatus !== 'in_progress' && context.phaseStatus !== 'rework') {
    return { route: 'unavailable', reasonCode: 'REV_PHASE_NOT_OPEN', nextOperation: 'phase.show' };
  }
  if (!context.parentCandidate) {
    return { route: 'unavailable', reasonCode: 'REV_PARENT_CANDIDATE_MISSING', nextOperation: 'implementation.generate' };
  }
  if (!candidateShaped(context.parentCandidate)) {
    return { route: 'unavailable', reasonCode: 'REV_PARENT_CANDIDATE_INVALID', nextOperation: 'implementation.candidate.show' };
  }
  return { route: 'code-revision' };
}

/**
 * `context` must be a kernel-verified snapshot. Classification is an explicit disposition, never
 * inferred by an LLM here. `installedOperations` is a closed operation registry supplied by caller.
 */
export function planRevisionRoute({ context, feedbackText, attachmentSet = null }) {
  const text = boundedText(feedbackText);
  if (!context || typeof context !== 'object') fail('REV_ROUTE_INPUT', 'An exact route context is required.');
  const subject = {
    workId: identifier(context.workId, 'Work ID'),
    phaseId: identifier(context.phaseId, 'Phase ID'),
    phaseGeneration: positiveGeneration(context.phaseGeneration)
  };
  const binding = {
    headCommit: GIT_COMMIT.test(String(context.headCommit ?? ''))
      ? context.headCommit : fail('REV_ROUTE_INPUT', 'HEAD commit must be an exact Git object ID.'),
    sourceTreeSha256: requireHash(context.sourceTreeSha256, 'Source tree'),
    configSha256: requireHash(context.configSha256, 'Configuration'),
    workflowSha256: requireHash(context.workflowSha256, 'Workflow'),
    approvedIntentSha256: requireHash(context.approvedIntentSha256, 'Approved intent'),
    routeContractSha256: requireHash(context.routeContractSha256, 'Routing contract'),
    ...(context.repositorySha256 ? { repositorySha256: requireHash(context.repositorySha256, 'Repository') } : {}),
    ...(context.loopId != null ? { loopId: identifier(context.loopId, 'Loop ID') } : {}),
    ...(context.loopRevision != null ? { loopRevision: positiveGeneration(context.loopRevision) } : {})
  };
  if (!DISPOSITIONS.has(context.specificationDisposition)) {
    fail('REV_DISPOSITION_REQUIRED', 'Select a registered specification disposition before routing.');
  }
  if (!['code', 'artifact', 'other'].includes(context.phaseTask)) {
    fail('REV_ROUTE_INPUT', 'Pinned phase task must be exactly code, artifact, or other.');
  }
  if (!['in_progress', 'rework', 'published', 'awaiting_approval'].includes(context.phaseStatus)) {
    fail('REV_ROUTE_INPUT', 'Current phase status is unavailable or unsupported.');
  }
  if (!context.identity || typeof context.identity.id !== 'string' || !context.identity.id
      || typeof context.identity.kind !== 'string' || !context.identity.kind) {
    fail('REV_ROUTE_INPUT', 'Authenticated identity is required.');
  }
  if (Buffer.byteLength(canonicalJson({
    target: context.target ?? null, parentCandidate: context.parentCandidate ?? null,
    identity: context.identity
  })) > 16 * 1024) {
    fail('REV_ROUTE_INPUT', 'Route target, candidate, and identity exceed the bounded metadata limit.');
  }
  const feedbackSha256 = revisionTextSha256(text);
  const attachmentSetSha256 = attachmentSet
    ? verifyRevisionAttachmentSet(attachmentSet, { subject, feedbackSha256, binding }) : null;
  if (!Array.isArray(context.installedOperations ?? [])
      || (context.installedOperations ?? []).length > Object.keys(ROUTES).length
      || (context.installedOperations ?? []).some((id) => typeof id !== 'string')) {
    fail('REV_ROUTE_INPUT', 'Installed route operations must be a closed registered list.');
  }
  const installedOperations = [...new Set(context.installedOperations ?? [])].sort();
  if (!Array.isArray(context.installedOperations ?? [])
      || installedOperations.some((id) => typeof id !== 'string' || !Object.values(ROUTES).includes(id))) {
    fail('REV_ROUTE_INPUT', 'Installed route operations must be a closed registered list.');
  }
  const normalized = {
    subject, binding, phaseTask: context.phaseTask, phaseStatus: context.phaseStatus,
    published: context.published === true, publicationRecovery: context.publicationRecovery === true,
    loopRecovery: context.loopRecovery === true, specificationDisposition: context.specificationDisposition,
    target: context.target ?? null, parentCandidate: context.parentCandidate ?? null,
    deliveryMode: context.deliveryMode ?? null, proofProfile: context.proofProfile ?? null,
    identity: { kind: context.identity.kind, id: context.identity.id },
    installedOperations, feedbackSha256, attachmentSetSha256
  };
  const selected = routeFor(normalized);
  const operationId = ROUTES[selected.route] ?? null;
  const available = operationId != null && installedOperations.includes(operationId);
  const route = selected.route !== 'unavailable' && !available ? 'unavailable' : selected.route;
  const core = {
    schemaVersion: 1, kind: 'revision-route-plan', subject,
    feedbackSha256, ...(attachmentSetSha256 ? { attachmentSetSha256 } : {}),
    target: normalized.target, classification: {
      specificationDisposition: normalized.specificationDisposition, route,
      ...(route === 'unavailable' ? { proposedRoute: selected.route } : {})
    },
    operation: {
      id: available ? operationId : null,
      authorityRequired: available ? 'configured-policy' : null,
      mutation: available,
      available
    },
    ...(route === 'unavailable' ? {
      refusal: {
        code: selected.reasonCode ?? 'REV_ROUTE_UNAVAILABLE',
        nextOperation: selected.nextOperation ?? operationId ?? 'phase.show'
      }
    } : {}),
    effects: { codeChanged: false, artifactChanged: false, lifecycleChanged: false, externalChanged: false },
    inputsSha256: hash(normalized)
  };
  return { ...core, planSha256: hash(core) };
}

export function assertCurrentRevisionRoute(plan, input) {
  if (!plan || plan.kind !== 'revision-route-plan' || !HASH.test(plan.planSha256)) {
    fail('REV_ROUTE_PLAN_INVALID', 'An exact revision route plan is required.');
  }
  const { planSha256, ...core } = plan;
  if (hash(core) !== planSha256 || planRevisionRoute(input).planSha256 !== planSha256) {
    fail('REV_ROUTE_PLAN_STALE', 'Feedback, attachments, candidate, phase, authority, or routing inputs changed; plan again.');
  }
  return plan;
}
