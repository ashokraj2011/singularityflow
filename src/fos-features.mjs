import { createHash, randomUUID } from 'node:crypto';

import { recordSha256 } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const FOS_FEATURE_IDS = Object.freeze([
  'reusable-defaults',
  'policy-preauthorization',
  'approval-routing',
  'template-prefill',
  'pr-check-adoption',
  'error-explanations',
  'evidence-ingestion',
  'story-switching'
]);

export const FOS_FEATURE_DEFAULTS = Object.freeze(Object.fromEntries(
  FOS_FEATURE_IDS.map((id) => [id, false])
));

const HASH = /^sha256:[a-f0-9]{64}$/;
const FIELD_CLASSIFICATIONS = new Set(['observed', 'derived', 'historical', 'needs_input']);
const PRINCIPAL = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

function fail(message, code) {
  throw new SingularityFlowError(message, { code });
}

function digest(value, label) {
  if (!HASH.test(value ?? '')) fail(`${label} must be a complete SHA-256 identity.`, 'FOS_INPUT_INVALID');
  return value;
}

function boundedText(value, label, max = 4096) {
  const text = String(value ?? '').trim();
  if (!text || Buffer.byteLength(text) > max) fail(`${label} is missing or exceeds ${max} bytes.`, 'FOS_INPUT_INVALID');
  return text;
}

export function resolveFosFeatures(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('FOS feature controls must be an object.', 'FOS_FEATURE_CONFIGURATION_INVALID');
  }
  const unknown = Object.keys(input).filter((key) => !FOS_FEATURE_IDS.includes(key));
  if (unknown.length) fail(`Unknown FOS feature control(s): ${unknown.join(', ')}.`, 'FOS_FEATURE_CONFIGURATION_INVALID');
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'boolean') fail(`FOS feature '${key}' must be true or false.`, 'FOS_FEATURE_CONFIGURATION_INVALID');
  }
  return Object.freeze({ ...FOS_FEATURE_DEFAULTS, ...input });
}

export function assertFosFeature(features, id) {
  if (!FOS_FEATURE_IDS.includes(id)) fail(`Unknown FOS feature '${id}'.`, 'FOS_FEATURE_CONFIGURATION_INVALID');
  const resolved = resolveFosFeatures(features);
  if (!resolved[id]) fail(
    `FOS feature '${id}' is disabled. Enable only this feature through approved repository policy after its prerequisites are certified.`,
    'FOS_FEATURE_DISABLED'
  );
  return resolved;
}

export function createFosReusableDefault(input, { features = {} } = {}) {
  assertFosFeature(features, 'reusable-defaults');
  const expiresAt = new Date(input?.expiresAt ?? 'invalid');
  if (!Number.isFinite(expiresAt.getTime())) fail('Reusable default expiry is invalid.', 'FOS_DEFAULT_INVALID');
  const record = {
    schemaVersion: currentSchemaVersion('fos-reusable-default'),
    kind: 'fos-reusable-default',
    repositoryId: boundedText(input?.repositoryId, 'repositoryId', 256),
    authoritySha256: digest(input?.authoritySha256, 'authoritySha256'),
    question: {
      id: boundedText(input?.question?.id, 'question.id', 128),
      version: boundedText(input?.question?.version, 'question.version', 64)
    },
    contextSha256: digest(input?.contextSha256, 'contextSha256'),
    policySha256: digest(input?.policySha256, 'policySha256'),
    sourceSha256: digest(input?.sourceSha256, 'sourceSha256'),
    value: structuredClone(input?.value),
    classification: 'candidate-default',
    authoritative: false,
    grantsAuthority: false,
    expiresAt: expiresAt.toISOString(),
    revokedAt: null
  };
  return Object.freeze({ ...record, defaultSha256: `sha256:${recordSha256(record)}` });
}

export function resolveFosReusableDefault(record, expected, { now = new Date() } = {}) {
  const keys = ['repositoryId', 'authoritySha256', 'contextSha256', 'policySha256'];
  const reasons = keys.filter((key) => record?.[key] !== expected?.[key]).map((key) => `${key}-changed`);
  if (record?.question?.id !== expected?.question?.id || record?.question?.version !== expected?.question?.version) {
    reasons.push('question-contract-changed');
  }
  if (record?.revokedAt) reasons.push('revoked');
  if (!Number.isFinite(Date.parse(record?.expiresAt ?? '')) || Date.parse(record.expiresAt) <= now.getTime()) {
    reasons.push('expired');
  }
  const { defaultSha256: recordedDigest, ...recordBody } = record ?? {};
  if (record?.authoritative !== false || record?.grantsAuthority !== false
      || recordedDigest !== `sha256:${recordSha256(recordBody)}`) {
    reasons.push('invalid-record');
  }
  return reasons.length
    ? Object.freeze({ status: 'needs_input', value: null, reasons: Object.freeze(reasons) })
    : Object.freeze({ status: 'suggested-default', value: structuredClone(record.value), reasons: Object.freeze([]) });
}

export function buildFosInterpretationCard({ interpretation, mandatoryEvidence = [], relatedQuestions = [], defaults = [] } = {}) {
  const missing = mandatoryEvidence.filter((item) => !HASH.test(item?.sha256 ?? ''));
  if (missing.length) return Object.freeze({
    status: 'needs_input', interpretation: null,
    missingEvidence: Object.freeze(missing.map((item) => item?.id ?? 'unknown')),
    questions: Object.freeze(relatedQuestions.slice(0, 3).map(String))
  });
  return Object.freeze({
    status: 'confirm-interpretation',
    interpretation: boundedText(interpretation, 'interpretation'),
    evidence: Object.freeze(mandatoryEvidence.map((item) => Object.freeze({ id: item.id, sha256: item.sha256 }))),
    questions: Object.freeze(relatedQuestions.slice(0, 3).map(String)),
    defaults: Object.freeze(defaults.map((item) => Object.freeze({ ...item, authority: 'suggestion-only' }))),
    grantsApproval: false
  });
}

export function prefillFosTemplate(fieldDefinitions, inputs = {}, { features = {} } = {}) {
  assertFosFeature(features, 'template-prefill');
  if (!Array.isArray(fieldDefinitions)) fail('Template field definitions must be an array.', 'FOS_TEMPLATE_INVALID');
  const fields = {};
  for (const definition of fieldDefinitions) {
    const id = boundedText(definition?.id, 'template field id', 128);
    const supplied = inputs[id];
    if (!supplied) {
      fields[id] = Object.freeze({ value: null, classification: 'needs_input', provenance: null, required: definition.required === true });
      continue;
    }
    if (!FIELD_CLASSIFICATIONS.has(supplied.classification) || supplied.classification === 'needs_input'
        || !HASH.test(supplied.provenance?.sha256 ?? '') || !supplied.provenance?.version) {
      fail(`Template field '${id}' lacks valid field-level provenance.`, 'FOS_TEMPLATE_PROVENANCE_INVALID');
    }
    fields[id] = Object.freeze({
      value: structuredClone(supplied.value),
      classification: supplied.classification,
      provenance: Object.freeze({
        source: boundedText(supplied.provenance.source, `${id} provenance source`, 256),
        version: boundedText(supplied.provenance.version, `${id} provenance version`, 64),
        sha256: supplied.provenance.sha256
      }),
      required: definition.required === true
    });
  }
  const missing = Object.entries(fields).filter(([, value]) => value.required && value.classification === 'needs_input')
    .map(([id]) => id);
  return Object.freeze({ status: missing.length ? 'needs_input' : 'ready', fields: Object.freeze(fields), missing: Object.freeze(missing) });
}

function safeDocumentationCandidate(candidate, policy) {
  if (!policy?.approved || !HASH.test(policy.policySha256 ?? '') || !Number.isInteger(policy.epoch)
      || !Array.isArray(policy.paths) || !policy.paths.length) return { eligible: false, reason: 'policy-unavailable' };
  if (!HASH.test(candidate?.baseSha256 ?? '') || !HASH.test(candidate?.candidateSha256 ?? '')
      || !Array.isArray(candidate?.changes) || !candidate.changes.length) return { eligible: false, reason: 'candidate-unsealed' };
  for (const change of candidate.changes) {
    const candidates = [change.oldPath, change.newPath].filter(Boolean);
    if (!candidates.length || candidates.some((name) => !policy.paths.some((prefix) => name.startsWith(prefix)))) {
      return { eligible: false, reason: 'mixed-or-unapproved-scope' };
    }
    if (change.mode && change.mode !== '100644') return { eligible: false, reason: 'executable-or-special-mode' };
    if (change.symlink || change.generated || change.consumedByTooling || change.authorityMaterial
        || change.classifierConfiguration || change.testPath || change.unknownFormat) {
      return { eligible: false, reason: 'unsafe-document-consumer' };
    }
  }
  return { eligible: true, reason: 'enumerated-non-executable-documentation' };
}

export async function requestFosPreauthorization({ candidate, policy, actor, evidence = [], kernelAuthorize, features = {} } = {}) {
  assertFosFeature(features, 'policy-preauthorization');
  const classification = safeDocumentationCandidate(candidate, policy);
  if (!classification.eligible) return Object.freeze({
    disposition: 'ordinary-review', classification, grantsAuthority: false
  });
  if (!policy.actors?.includes(actor?.principalId) || typeof kernelAuthorize !== 'function') {
    return Object.freeze({ disposition: 'ordinary-review', classification: { eligible: false, reason: 'kernel-or-actor-unavailable' }, grantsAuthority: false });
  }
  const request = Object.freeze({
    policyId: policy.id,
    policySha256: policy.policySha256,
    policyEpoch: policy.epoch,
    actorPrincipalId: actor.principalId,
    baseSha256: candidate.baseSha256,
    candidateSha256: candidate.candidateSha256,
    classifier: { id: 'fos-non-executable-docs', version: 1, ...classification },
    evidence: Object.freeze([...evidence])
  });
  const result = await kernelAuthorize(request);
  const bound = result?.disposition === 'pre-authorized'
    && result.policySha256 === request.policySha256
    && result.candidateSha256 === request.candidateSha256
    && result.actorPrincipalId === request.actorPrincipalId;
  if (!bound) return Object.freeze({ disposition: 'ordinary-review', classification, grantsAuthority: false });
  return Object.freeze({
    disposition: 'pre-authorized',
    attribution: `pre-authorized under ${policy.id}`,
    humanReviewer: null,
    grantsAuthority: true,
    kernelReceipt: structuredClone(result)
  });
}

export function createFosApprovalRequest(input, { features = {}, now = new Date() } = {}) {
  assertFosFeature(features, 'approval-routing');
  const recipients = [...new Set(input?.recipients ?? [])];
  if (!recipients.length || recipients.some((value) => !PRINCIPAL.test(value))) {
    fail('Approval routing requires verified principal IDs or authorized group IDs.', 'FOS_APPROVER_SCOPE_INVALID');
  }
  const expiresAt = new Date(input?.expiresAt ?? 'invalid');
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) fail('Approval request expiry must be in the future.', 'FOS_APPROVAL_REQUEST_INVALID');
  const request = {
    schemaVersion: currentSchemaVersion('fos-approval-request'),
    kind: 'fos-approval-request',
    requestId: `fos-approval-${randomUUID()}`,
    operationId: boundedText(input?.operationId, 'operationId', 256),
    generation: Number(input?.generation),
    actorPrincipalId: boundedText(input?.actorPrincipalId, 'actorPrincipalId', 256),
    targetAuthoritySha256: digest(input?.targetAuthoritySha256, 'targetAuthoritySha256'),
    baseSha256: digest(input?.baseSha256, 'baseSha256'),
    candidateSha256: digest(input?.candidateSha256, 'candidateSha256'),
    evidenceSha256: digest(input?.evidenceSha256, 'evidenceSha256'),
    policySha256: digest(input?.policySha256, 'policySha256'),
    policyEpoch: Number(input?.policyEpoch),
    recipients: recipients.sort(),
    expiresAt: expiresAt.toISOString(),
    challenge: `sha256:${createHash('sha256').update(randomUUID()).digest('hex')}`,
    deliveryStatus: 'pending',
    grantsAuthority: false
  };
  if (!Number.isInteger(request.generation) || request.generation < 1 || !Number.isInteger(request.policyEpoch)) {
    fail('Approval request generation and policy epoch must be integers.', 'FOS_APPROVAL_REQUEST_INVALID');
  }
  return Object.freeze({ ...request, requestSha256: `sha256:${recordSha256(request)}` });
}

export async function acceptFosApprovalRequest(request, response, current, kernelAccept, { now = new Date(), replayed = false } = {}) {
  if (replayed || response?.challenge !== request?.challenge) fail('Approval challenge is stale or replayed.', 'FOS_APPROVAL_REPLAYED');
  if (Date.parse(request.expiresAt) <= now.getTime()) fail('Approval request expired.', 'FOS_APPROVAL_EXPIRED');
  if (current?.candidateSha256 !== request.candidateSha256 || current?.policySha256 !== request.policySha256
      || current?.policyEpoch !== request.policyEpoch) fail('Approval request no longer matches current authority.', 'FOS_APPROVAL_STALE');
  if (!request.recipients.includes(response?.principalId)) fail('Approving principal is outside the authorized scope.', 'NOT_AUTHORIZED');
  if (response.principalId === request.actorPrincipalId && current?.separationOfDuties) fail('Separation of duties forbids self-approval.', 'NOT_AUTHORIZED');
  if (typeof kernelAccept !== 'function') fail('No approved approval-kernel adapter is configured.', 'TRUST_REQUIRED');
  return kernelAccept({ request, response, current });
}

export function evaluateFosPrCheckAdoption(input, { features = {} } = {}) {
  assertFosFeature(features, 'pr-check-adoption');
  if (!['advisory', 'enforced'].includes(input?.mode)) fail('PR-check adoption mode must be advisory or enforced.', 'FOS_PR_MODE_INVALID');
  if (!input.repositoryAuthorized) return Object.freeze({ status: 'refused', code: 'NOT_AUTHORIZED', authoritative: false });
  if (input.mode === 'advisory') return Object.freeze({
    status: 'advisory', authoritative: false, mayMerge: false,
    scope: Object.freeze([...(input.scope ?? [])]), gaps: Object.freeze([...(input.gaps ?? [])])
  });
  if (!input.trustedServerGate || !input.branchProtectionVerified || !input.workflowImportCertified) {
    return Object.freeze({ status: 'unavailable', code: 'TRUST_REQUIRED', authoritative: false, mayMerge: false });
  }
  const evidence = input.evidence;
  const complete = evidence?.trusted === true && HASH.test(evidence.artifactSha256 ?? '')
    && evidence.sourceCommit === input.sourceCommit && evidence.status === 'passed'
    && Array.isArray(evidence.tests) && evidence.tests.length > 0
    && evidence.tests.every((test) => test.status === 'passed' && test.identity);
  return complete
    ? Object.freeze({ status: 'enforced-evidence-eligible', authoritative: true, mayMerge: false })
    : Object.freeze({ status: 'refused', code: 'EVIDENCE_INCOMPLETE', authoritative: false, mayMerge: false });
}

export const FOS_FAILURE_GUIDANCE = Object.freeze({
  NOT_CONFIGURED: 'singularity-flow onboard <LOCAL-PATH> --remote <NAME>',
  AUTHORITY_UNAVAILABLE: 'singularity-flow authority refresh <LOCAL-PATH>',
  AUTHORITY_INVALID: 'singularity-flow doctor --json',
  UNSUPPORTED_SCHEMA: 'singularity-flow doctor --json',
  AUTHORITY_MOVED: 'singularity-flow authority refresh <LOCAL-PATH>',
  AUTHORITY_CONFLICT: 'singularity-flow authority refresh <LOCAL-PATH>',
  TRUST_REQUIRED: 'singularity-flow doctor --json',
  NOT_AUTHORIZED: 'singularity-flow approvals --json',
  REVIEW_REQUIRED: 'singularity-flow approvals --json',
  NEEDS_CONTEXT: 'singularity-flow nextsteps --json',
  SNAPSHOT_CHANGED: 'singularity-flow snapshot --json',
  OBJECT_UNAVAILABLE: 'singularity-flow doctor --network --json',
  CACHE_REJECTED: 'singularity-flow cache clear --derived --repo <LOCAL-PATH>',
  RECOVERY_REQUIRED: 'singularity-flow recover <WORK-ID> --json',
  IDEMPOTENCY_CONFLICT: 'singularity-flow doctor --json',
  LIMIT_EXCEEDED: 'singularity-flow doctor --json',
  WORK_PRESERVATION_FAILED: 'singularity-flow workspace list --json'
});

export function fosFailureGuidance(code) {
  const command = FOS_FAILURE_GUIDANCE[code];
  if (!command) fail(`No FOS recovery guidance is registered for '${code}'.`, 'FOS_ERROR_UNREGISTERED');
  return Object.freeze({ code, command, executesAutomatically: false });
}

export function fosMilestoneReadiness({ identityAdapter = false, notificationAdapter = false, serverGate = false, workflowImportAdapter = false } = {}) {
  return Object.freeze({
    trackA: Object.freeze({ status: 'implemented', milestones: Object.freeze(['M0', 'M1', 'M2', 'M3']) }),
    M4: Object.freeze({ status: 'implemented-disabled-by-default', features: Object.freeze(FOS_FEATURE_IDS.filter((id) => !['policy-preauthorization', 'approval-routing', 'pr-check-adoption'].includes(id))) }),
    M5: Object.freeze({
      status: identityAdapter && notificationAdapter && serverGate && workflowImportAdapter
        ? 'adapter-prerequisites-present-certification-required' : 'external-adapters-required',
      enabled: false,
      prerequisites: Object.freeze({ identityAdapter, notificationAdapter, serverGate, workflowImportAdapter })
    })
  });
}
