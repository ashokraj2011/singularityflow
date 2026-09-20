/** Bounded, deterministic REV execution input. Building a packet has no effects. */
import { createHash } from 'node:crypto';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { validateRevisionRecord } from './contracts.mjs';
import { assertCurrentRevisionRoute, revisionTextSha256, verifyRevisionAttachmentSet } from './router.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_PACKET_BYTES = 128 * 1024;
const MAX_ATTACHMENT_RENDITION_BYTES = 64 * 1024;
const DEFAULT_BUDGETS = Object.freeze({
  maximumInputBytes: MAX_PACKET_BYTES,
  maximumOutputBytes: 1024 * 1024,
  maximumToolCalls: 50,
  maximumSubattempts: 3
});

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function hashBytes(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function requireHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_PACKET_INPUT', `${label} needs an exact SHA-256 digest.`);
  return value;
}
function bounded(value, maximum, label) {
  if (Buffer.byteLength(canonicalJson(value)) > maximum) {
    fail('REV_PACKET_LIMIT', `${label} exceeds its packet byte budget; select less content explicitly.`);
  }
  return value;
}
function candidateReference(value) {
  if (!value || !['sgos-candidate', 'auto-candidate'].includes(value.family)
      || typeof value.namespace !== 'string' || !value.namespace.startsWith('refs/singularity-flow/')
      || !/^CAN-[A-Za-z0-9._:-]{6,127}$/.test(String(value.candidateId ?? ''))
      || !GIT_OBJECT.test(String(value.repository?.baselineCommit ?? ''))
      || !GIT_OBJECT.test(String(value.repository?.candidateTree ?? ''))
      || !['sha1', 'sha256'].includes(value.repository?.objectFormat)) {
    fail('REV_PARENT_CANDIDATE_INVALID', 'An exact retained Auto/SGOS candidate reference is required.');
  }
  for (const field of ['retainedRecordSha256', 'candidateSha256', 'sourceManifestSha256', 'effectSetSha256']) {
    requireHash(value[field], `Parent candidate ${field}`);
  }
  if (!value.createdBy || !['human', 'agent', 'service'].includes(value.createdBy.kind)
      || typeof value.createdBy.id !== 'string' || !value.createdBy.id) {
    fail('REV_PARENT_CANDIDATE_INVALID', 'Parent candidate creator is not bound.');
  }
  return bounded(value, 8192, 'Parent candidate reference');
}
function packetBudgets(value = DEFAULT_BUDGETS) {
  for (const [key, maximum] of Object.entries(DEFAULT_BUDGETS)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum) {
      fail('REV_PACKET_BUDGET', `${key} exceeds the installed pilot ceiling.`);
    }
  }
  return Object.fromEntries(Object.keys(DEFAULT_BUDGETS).map((key) => [key, value[key]]));
}
function selectedRenditions(receipt, renditions) {
  if (receipt == null) {
    if (renditions?.length) fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Unregistered attachment content cannot enter the packet.');
    return [];
  }
  if (!Array.isArray(renditions) || renditions.length !== receipt.attachments.length) {
    fail('REV_ATTACHMENT_RENDITION_MISSING', 'Every selected attachment needs its exact verified rendition bytes.');
  }
  let total = 0;
  return receipt.attachments.map((item, index) => {
    const raw = renditions[index];
    if (!Buffer.isBuffer(raw) && !(raw instanceof Uint8Array)) {
      fail('REV_ATTACHMENT_RENDITION_MISSING', 'Selected attachment rendition bytes are missing.');
    }
    const bytes = Buffer.from(raw);
    total += bytes.length;
    if (!bytes.length || total > MAX_ATTACHMENT_RENDITION_BYTES
        || hashBytes(bytes) !== item.renditionSha256) {
      fail('REV_ATTACHMENT_RENDITION_STALE', 'Selected rendition bytes changed or exceed the packet limit.');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('REV_ATTACHMENT_RENDITION_STALE', 'Selected rendition is not valid UTF-8 text.'); }
    return {
      kind: 'untrusted-user-document-rendition',
      displayName: item.displayName,
      mediaType: item.mediaType,
      originalSha256: item.originalSha256,
      renditionSha256: item.renditionSha256,
      selectedRanges: item.selectedRanges,
      text
    };
  });
}

/**
 * The candidate callback must read and validate the actual immutable candidate store. A shape or
 * self-hash alone never authorizes a packet. `routeInput` is re-evaluated to catch staleness.
 */
export async function buildRevisionPacket({
  routePlan, routeInput, parentCandidate, verifyCandidate, attachmentRenditions = [],
  verifyAttachmentSet, criteria, feedbackId, feedbackRecordSha256,
  criteriaBindingSha256, specificationDispositionSha256,
  rules, diff, skeletons = [], effectPolicy,
  expansions = [], budgets = DEFAULT_BUDGETS, producer
}) {
  assertCurrentRevisionRoute(routePlan, routeInput);
  if (routePlan.classification.route !== 'code-revision'
      || routePlan.operation.id !== 'revision.code' || routePlan.operation.available !== true) {
    fail('REV_ROUTE_NOT_CODE', 'Only an installed open code-revision route may create a revision packet.');
  }
  const reference = candidateReference(parentCandidate);
  if (typeof verifyCandidate !== 'function' || await verifyCandidate(reference) !== true) {
    fail('REV_PARENT_CANDIDATE_UNVERIFIED', 'The retained parent candidate could not be verified.');
  }
  if (!routeInput.context.parentCandidate
      || hash(routeInput.context.parentCandidate) !== hash(reference)) {
    fail('REV_PARENT_CANDIDATE_STALE', 'Route parent candidate differs from the exact retained packet parent.');
  }
  const feedbackText = routeInput.feedbackText;
  if (revisionTextSha256(feedbackText) !== routePlan.feedbackSha256) {
    fail('REV_FEEDBACK_STALE', 'Feedback text changed after route planning.');
  }
  const attachmentSet = routeInput.attachmentSet ?? null;
  if (attachmentSet) {
    if (typeof verifyAttachmentSet !== 'function'
        || await verifyAttachmentSet(attachmentSet.attachmentSetSha256) !== true) {
      fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Selected attachment set is not verified in the governed store.');
    }
    const subject = routePlan.subject;
    const binding = routeInput.context;
    const digest = verifyRevisionAttachmentSet(attachmentSet, {
      subject, feedbackSha256: routePlan.feedbackSha256, binding
    });
    if (digest !== routePlan.attachmentSetSha256) {
      fail('REV_ATTACHMENT_SET_STALE', 'Selected attachment set changed after route planning.');
    }
  } else if (routePlan.attachmentSetSha256) {
    fail('REV_ATTACHMENT_SET_STALE', 'Route plan requires a selected attachment set.');
  }
  if (!criteria || !Array.isArray(criteria.items) || !criteria.items.length
      || criteria.items.length > 128
      || !criteria.items.every((item) => typeof item?.id === 'string' && item.id
        && typeof item?.text === 'string' && item.text)
      || new Set(criteria.items.map((item) => item.id)).size !== criteria.items.length) {
    fail('REV_CRITERIA_SELECTION_REQUIRED', 'Choose the exact bounded criteria; none may be silently truncated.');
  }
  bounded(criteria, 32 * 1024, 'Criteria');
  if (!/^REVFB-[A-Za-z0-9._:-]{6,127}$/u.test(String(feedbackId ?? ''))) {
    fail('REV_PACKET_INPUT', 'Feedback record ID is required.');
  }
  requireHash(feedbackRecordSha256, 'Feedback record');
  requireHash(criteriaBindingSha256, 'Criteria-binding record');
  requireHash(specificationDispositionSha256, 'Specification-disposition record');
  if (!rules || typeof rules !== 'object' || !effectPolicy || typeof effectPolicy !== 'object'
      || typeof diff !== 'string' || !Array.isArray(skeletons) || !Array.isArray(expansions)) {
    fail('REV_PACKET_INPUT', 'Rules, diff, skeletons, and effect policy are required.');
  }
  bounded(rules, 16 * 1024, 'Implementation rules');
  bounded(diff, 32 * 1024, 'Candidate diff');
  bounded(skeletons, 32 * 1024, 'Touched-file skeletons');
  bounded(effectPolicy, 16 * 1024, 'Effect policy');
  bounded(expansions, 8192, 'Expansion handles');
  if (expansions.length) {
    fail('REV_EXPANSION_UNAVAILABLE', 'No verified packet-expansion adapter is installed for this pilot.');
  }
  const attachments = selectedRenditions(attachmentSet, attachmentRenditions);
  const boundBudgets = packetBudgets(budgets);
  const candidateRefSha256 = hash(reference);
  const core = {
    schemaVersion: 1, kind: 'revision-packet', subject: routePlan.subject,
    routePlanSha256: routePlan.planSha256,
    parentCandidate: {
      candidateId: reference.candidateId,
      candidateSha256: reference.candidateSha256,
      candidateRefSha256
    },
    feedback: {
      feedbackId, feedbackRecordSha256,
      feedbackSha256: routePlan.feedbackSha256, text: feedbackText,
      ...(routePlan.attachmentSetSha256 ? { attachmentSetSha256: routePlan.attachmentSetSha256 } : {})
    },
    attachments,
    criteria,
    criteriaBindingSha256,
    specificationDispositionSha256,
    rules, rulesSha256: hash(rules),
    diff, diffSha256: hashBytes(Buffer.from(diff)),
    skeletons, skeletonSetSha256: hash(skeletons),
    effectPolicy, effectPolicySha256: hash(effectPolicy),
    expansions, budgets: boundBudgets, producer
  };
  const packet = { ...core, packetSha256: hash(core) };
  if (Buffer.byteLength(canonicalJson(packet)) > boundBudgets.maximumInputBytes) {
    fail('REV_PACKET_LIMIT', 'Revision packet exceeds its exact input-byte budget.');
  }
  return validateRevisionRecord('revision-packet', packet);
}

export function verifyRevisionPacket(packet, { routePlan, attachmentSetSha256 = null } = {}) {
  try { packet = validateRevisionRecord('revision-packet', packet); }
  catch {
    fail('REV_PACKET_INVALID', 'An exact revision packet is required.');
  }
  if (!routePlan?.classification || !packet.feedback || !packet.parentCandidate
      || !packet.budgets || !Array.isArray(packet.attachments)
      || !Array.isArray(packet.skeletons) || typeof packet.diff !== 'string'
      || typeof packet.feedback.text !== 'string') {
    fail('REV_PACKET_INVALID', 'Revision packet is missing required bounded bindings.');
  }
  const { planSha256: routeDigest, ...routeCore } = routePlan;
  if (!HASH.test(routeDigest) || hash(routeCore) !== routeDigest
      || routePlan.classification.route !== 'code-revision'
      || routePlan.operation?.id !== 'revision.code') {
    fail('REV_PACKET_STALE', 'Revision route plan is not an exact installed code route.');
  }
  packetBudgets(packet.budgets);
  const { packetSha256, ...core } = packet;
  if (hash(core) !== packetSha256 || packet.routePlanSha256 !== routePlan?.planSha256
      || (packet.feedback.attachmentSetSha256 ?? null) !== attachmentSetSha256
      || (attachmentSetSha256 === null ? packet.attachments.length !== 0 : packet.attachments.length === 0)
      || packet.feedback.feedbackSha256 !== revisionTextSha256(packet.feedback.text)
      || !/^REVFB-[A-Za-z0-9._:-]{6,127}$/u.test(String(packet.feedback.feedbackId ?? ''))
      || !HASH.test(String(packet.feedback.feedbackRecordSha256 ?? ''))
      || !HASH.test(packet.criteriaBindingSha256)
      || !HASH.test(packet.specificationDispositionSha256)
      || packet.rulesSha256 !== hash(packet.rules)
      || packet.diffSha256 !== hashBytes(Buffer.from(packet.diff))
      || packet.skeletonSetSha256 !== hash(packet.skeletons)
      || packet.effectPolicySha256 !== hash(packet.effectPolicy)
      || !Array.isArray(packet.attachments)
      || packet.attachments.some((item) => item.kind !== 'untrusted-user-document-rendition'
        || !HASH.test(item.originalSha256) || item.renditionSha256 !== hashBytes(Buffer.from(item.text)))
      || Buffer.byteLength(canonicalJson(packet)) > packet.budgets.maximumInputBytes) {
    fail('REV_PACKET_STALE', 'Packet, route, attachment set, or byte budget changed.');
  }
  return packet;
}

export const revisionPacketLimits = DEFAULT_BUDGETS;
