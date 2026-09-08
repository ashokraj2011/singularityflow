import { createHash, randomUUID } from 'node:crypto';

import { certifiedFosAdapterTypes, requireCertifiedFosAdapter } from './fos-adapters.mjs';
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
const FOS_ADAPTER_TYPES_FOR_READINESS = Object.freeze([
  ['identityAdapter', 'identity'],
  ['notificationAdapter', 'notification'],
  ['serverGate', 'server-gate'],
  ['workflowImportAdapter', 'workflow-import']
]);

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

/**
 * Classify bootstrap authority without performing bootstrap. A proposed policy can never authorize
 * itself, and a claimed organization identity without an existing trust anchor stays refused.
 */
export function classifyFosBootstrapAuthority(input = {}) {
  if (input.explicitIntent !== true) return Object.freeze({
    status: 'refused', code: 'BOOTSTRAP_INTENT_REQUIRED', authority: null
  });
  if (input.scope === 'unmanaged-local' && input.localPresetApproved === true) return Object.freeze({
    status: 'eligible-local-only',
    authority: 'local-only',
    organizationalAuthority: false,
    proposedPolicySelfAuthorizing: false
  });
  const trusted = input.scope === 'organization'
    && HASH.test(input.trustAnchorSha256 ?? '')
    && HASH.test(input.bootstrapPolicySha256 ?? '')
    && input.actorEligible === true
    && input.proposedPolicySelfAuthorizing !== true;
  return trusted
    ? Object.freeze({
        status: 'eligible-existing-trust', authority: 'organization-trust-anchor',
        organizationalAuthority: true, proposedPolicySelfAuthorizing: false
      })
    : Object.freeze({
        status: 'refused', code: 'TRUST_REQUIRED', authority: null,
        organizationalAuthority: false, proposedPolicySelfAuthorizing: false
      });
}

function publicationAuthorizationRequest(input) {
  const request = {
    operationId: boundedText(input?.operationId, 'operationId', 256),
    actorPrincipalId: boundedText(input?.actorPrincipalId, 'actorPrincipalId', 256),
    targetAuthoritySha256: digest(input?.targetAuthoritySha256, 'targetAuthoritySha256'),
    expectedParentSha256: digest(input?.expectedParentSha256, 'expectedParentSha256'),
    candidateSha256: digest(input?.candidateSha256, 'candidateSha256'),
    inputsSha256: digest(input?.inputsSha256, 'inputsSha256'),
    evidenceSha256: digest(input?.evidenceSha256, 'evidenceSha256'),
    approvalsSha256: digest(input?.approvalsSha256, 'approvalsSha256'),
    policySha256: digest(input?.policySha256, 'policySha256'),
    policyEpoch: Number(input?.policyEpoch)
  };
  if (!PRINCIPAL.test(request.actorPrincipalId) || !Number.isInteger(request.policyEpoch)) fail(
    'Publication authorization requires a verified principal and integer policy epoch.',
    'FOS_PUBLICATION_AUTHORIZATION_INVALID'
  );
  return Object.freeze(request);
}

/** Re-read every mutable authorization input and ask the existing kernel at publication time. */
export async function validateFosPublicationBoundary(input, {
  readCurrentAuthorization, kernelAuthorize
} = {}) {
  const request = publicationAuthorizationRequest(input);
  if (typeof readCurrentAuthorization !== 'function' || typeof kernelAuthorize !== 'function') {
    fail('Trusted publication requires current-authority and kernel adapters.', 'TRUST_REQUIRED');
  }
  const current = await readCurrentAuthorization(request);
  const exact = current?.actorValid === true
    && current.actorPrincipalId === request.actorPrincipalId
    && current.targetAuthoritySha256 === request.targetAuthoritySha256
    && current.expectedParentSha256 === request.expectedParentSha256
    && current.candidateSha256 === request.candidateSha256
    && current.inputsSha256 === request.inputsSha256
    && current.evidenceSha256 === request.evidenceSha256
    && current.approvalsSha256 === request.approvalsSha256
    && current.policySha256 === request.policySha256
    && current.policyEpoch === request.policyEpoch;
  if (!exact) fail(
    'Publication authorization changed after preflight; nothing may be published.',
    'FOS_PUBLICATION_AUTHORIZATION_STALE'
  );
  const kernelResult = await kernelAuthorize(request, Object.freeze(structuredClone(current)));
  const bound = kernelResult?.disposition === 'allow'
    && Object.entries(request).every(([key, value]) => kernelResult[key] === value);
  if (!bound) fail(
    'The governance kernel did not grant this exact publication request.', 'NOT_AUTHORIZED'
  );
  const body = {
    kind: 'fos-publication-authorization',
    authorized: true,
    ...request,
    kernelReceiptSha256: digest(kernelResult.receiptSha256, 'kernel receipt')
  };
  return Object.freeze({ ...body, authorizationSha256: `sha256:${recordSha256(body)}` });
}

/** Ask the kernel separately for every capability edit; batching never creates a grant. */
export async function evaluateFosCapabilityMutationBatch(input, { kernelAuthorize } = {}) {
  if (!Array.isArray(input?.changes) || input.changes.length === 0 || typeof kernelAuthorize !== 'function') {
    fail('Capability mutation evaluation requires explicit changes and a kernel adapter.', 'TRUST_REQUIRED');
  }
  const base = publicationAuthorizationRequest(input);
  const seen = new Set();
  const decisions = [];
  for (const change of input.changes) {
    const capabilityId = boundedText(change?.capabilityId, 'capabilityId', 256);
    if (seen.has(capabilityId)) fail(
      `Capability '${capabilityId}' appears more than once in one mutation batch.`,
      'FOS_CAPABILITY_BATCH_INVALID'
    );
    seen.add(capabilityId);
    const ancestry = [...new Set((change.ancestry ?? []).map((entry) => boundedText(entry, 'ancestry', 256)))];
    const request = Object.freeze({
      ...base,
      capabilityId,
      changeSha256: digest(change.changeSha256, 'changeSha256'),
      ancestry: Object.freeze(ancestry),
      ancestrySha256: `sha256:${recordSha256(ancestry)}`,
      regulated: change.regulated === true,
      foreign: change.foreign === true
    });
    const result = await kernelAuthorize(request);
    const disposition = ['deny', 'proposal', 'direct'].includes(result?.disposition)
      ? result.disposition : 'deny';
    const bound = result != null
      && result.capabilityId === capabilityId
      && result.changeSha256 === request.changeSha256
      && result.policySha256 === request.policySha256
      && result.policyEpoch === request.policyEpoch
      && result.actorPrincipalId === request.actorPrincipalId
      && result.ancestrySha256 === request.ancestrySha256;
    const ancestryAllowsDirect = !request.regulated && !request.foreign
      || result?.directAncestryAuthorized === true;
    const effective = bound && (disposition !== 'direct' || ancestryAllowsDirect)
      ? disposition : 'deny';
    const receiptBody = {
      capabilityId,
      changeSha256: request.changeSha256,
      ancestrySha256: request.ancestrySha256,
      disposition: effective,
      policySha256: request.policySha256,
      policyEpoch: request.policyEpoch,
      actorPrincipalId: request.actorPrincipalId
    };
    decisions.push(Object.freeze({
      ...receiptBody,
      receiptSha256: `sha256:${recordSha256(receiptBody)}`
    }));
  }
  return Object.freeze({
    status: decisions.every((entry) => entry.disposition === 'direct') ? 'direct'
      : decisions.some((entry) => entry.disposition === 'proposal') ? 'proposal' : 'denied',
    decisions: Object.freeze(decisions)
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

export async function acceptFosApprovalRequest(request, response, current, kernelAccept, {
  now = new Date(), replayed = false, adapterSet = null
} = {}) {
  if (replayed || response?.challenge !== request?.challenge) fail('Approval challenge is stale or replayed.', 'FOS_APPROVAL_REPLAYED');
  if (Date.parse(request.expiresAt) <= now.getTime()) fail('Approval request expired.', 'FOS_APPROVAL_EXPIRED');
  if (current?.candidateSha256 !== request.candidateSha256 || current?.policySha256 !== request.policySha256
      || current?.policyEpoch !== request.policyEpoch) fail('Approval request no longer matches current authority.', 'FOS_APPROVAL_STALE');
  if (!PRINCIPAL.test(response?.principalId ?? '')) fail('Approving principal is outside the authorized scope.', 'NOT_AUTHORIZED');
  const identityAdapter = requireCertifiedFosAdapter(adapterSet, 'identity');
  const verifiedIdentity = await identityAdapter.verifyPrincipal(Object.freeze({
    requestId: request.requestId,
    challenge: request.challenge,
    assertedPrincipalId: response.principalId,
    targetAuthoritySha256: request.targetAuthoritySha256,
    recipients: Object.freeze([...request.recipients])
  }));
  const authorizedRecipientIds = [...new Set(verifiedIdentity?.authorizedRecipientIds ?? [])];
  if (verifiedIdentity?.authenticated !== true || verifiedIdentity?.revoked === true
      || verifiedIdentity?.principalId !== response.principalId
      || verifiedIdentity?.requestId !== request.requestId
      || verifiedIdentity?.challenge !== request.challenge
      || verifiedIdentity?.targetAuthoritySha256 !== request.targetAuthoritySha256
      || !authorizedRecipientIds.some((id) => request.recipients.includes(id))) {
    fail('The configured identity adapter did not verify an authorized principal.', 'NOT_AUTHORIZED');
  }
  if (verifiedIdentity.principalId === request.actorPrincipalId && current?.separationOfDuties) fail('Separation of duties forbids self-approval.', 'NOT_AUTHORIZED');
  if (typeof kernelAccept !== 'function') fail('No approved approval-kernel adapter is configured.', 'TRUST_REQUIRED');
  return kernelAccept({ request, response, current, verifiedIdentity: Object.freeze(structuredClone(verifiedIdentity)) });
}

export async function evaluateFosPrCheckAdoption(input, { features = {}, adapterSet = null } = {}) {
  assertFosFeature(features, 'pr-check-adoption');
  if (!['advisory', 'enforced'].includes(input?.mode)) fail('PR-check adoption mode must be advisory or enforced.', 'FOS_PR_MODE_INVALID');
  if (!input.repositoryAuthorized) return Object.freeze({ status: 'refused', code: 'NOT_AUTHORIZED', authoritative: false });
  if (input.mode === 'advisory') return Object.freeze({
    status: 'advisory', authoritative: false, mayMerge: false,
    scope: Object.freeze([...(input.scope ?? [])]), gaps: Object.freeze([...(input.gaps ?? [])])
  });
  let serverGate;
  let workflowImport;
  try {
    serverGate = requireCertifiedFosAdapter(adapterSet, 'server-gate');
    workflowImport = requireCertifiedFosAdapter(adapterSet, 'workflow-import');
  } catch (error) {
    if (error?.code !== 'TRUST_REQUIRED') throw error;
    return Object.freeze({ status: 'unavailable', code: 'TRUST_REQUIRED', authoritative: false, mayMerge: false });
  }
  const repositoryId = boundedText(input.repositoryId, 'repositoryId', 256);
  const sourceCommit = boundedText(input.sourceCommit, 'sourceCommit', 64);
  if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) fail('PR adoption requires an exact source commit.', 'FOS_PR_EVIDENCE_INVALID');
  const protection = await serverGate.verifyProtection(Object.freeze({ repositoryId, sourceCommit }));
  if (protection?.verified !== true || protection.repositoryId !== repositoryId
      || protection.sourceCommit !== sourceCommit || protection.branchProtection !== true
      || protection.existingChecksPreserved !== true) {
    return Object.freeze({ status: 'refused', code: 'SERVER_GATE_UNVERIFIED', authoritative: false, mayMerge: false });
  }
  const evidence = input.evidence;
  const requiredTests = [...new Set((input.requiredTestIdentities ?? []).map((identity) =>
    boundedText(identity, 'required test identity', 512)))].sort();
  const imported = await workflowImport.verifyEvidence(Object.freeze(structuredClone(evidence ?? {})));
  const importedTests = Array.isArray(imported?.tests) ? [...imported.tests] : [];
  const importedTestIdentities = importedTests.map((test) => String(test?.identity ?? '')).sort();
  const complete = evidence?.forkControlled !== true
    && boundedText(evidence?.provider, 'evidence.provider', 128) === imported?.provider
    && repositoryId === imported?.repositoryId
    && HASH.test(evidence?.workflowDefinitionSha256 ?? '')
    && evidence.workflowDefinitionSha256 === imported?.workflowDefinitionSha256
    && HASH.test(evidence?.trustIdentitySha256 ?? '')
    && evidence.trustIdentitySha256 === imported?.trustIdentitySha256
    && boundedText(evidence?.runId, 'evidence.runId', 256) === imported?.runId
    && Number.isSafeInteger(evidence?.runAttempt) && evidence.runAttempt > 0
    && evidence.runAttempt === imported?.runAttempt
    && HASH.test(evidence?.artifactSha256 ?? '')
    && evidence.artifactSha256 === imported?.artifactSha256
    && HASH.test(evidence?.environmentSha256 ?? '')
    && evidence.environmentSha256 === imported?.environmentSha256
    && evidence.testedCommit === sourceCommit && imported?.testedCommit === sourceCommit
    && imported?.trusted === true && imported?.status === 'passed'
    && requiredTests.length > 0
    && importedTestIdentities.length === requiredTests.length
    && importedTestIdentities.every((identity, index) => identity === requiredTests[index])
    && importedTests.every((test) => test.status === 'passed' && test.skipped !== true);
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

export function fosMilestoneReadiness({ adapterSet = null } = {}) {
  const certified = new Set(certifiedFosAdapterTypes(adapterSet));
  const prerequisites = Object.freeze(Object.fromEntries(FOS_ADAPTER_TYPES_FOR_READINESS.map(
    ([name, type]) => [name, certified.has(type)]
  )));
  const complete = Object.values(prerequisites).every(Boolean);
  return Object.freeze({
    trackA: Object.freeze({ status: 'implemented', milestones: Object.freeze(['M0', 'M1', 'M2', 'M3']) }),
    M4: Object.freeze({ status: 'implemented-disabled-by-default', features: Object.freeze(FOS_FEATURE_IDS.filter((id) => !['policy-preauthorization', 'approval-routing', 'pr-check-adoption'].includes(id))) }),
    M5: Object.freeze({
      status: complete ? 'verified-adapter-prerequisites-present-live-release-review-required'
        : 'external-adapters-required',
      enabled: false,
      prerequisites
    })
  });
}
