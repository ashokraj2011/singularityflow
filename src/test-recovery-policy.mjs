/**
 * TRP v1 pure contracts and gate evaluation. This module performs no I/O and reads no clock.
 *
 * TRUST BOUNDARY: verifyAuthority and verifyEvidence are host-supplied verifier functions,
 * never deserialized policy fields or request parameters. They must authenticate their
 * records against the pinned authority / evidence store. Hashes prove content identity,
 * not human authority. Merely sealing a record never authorizes it.
 */
import { recordSha256 } from './records.mjs';

export const TRP_EVALUATOR_VERSION = 'trp/1.0';
export const TRP_RISK_CATEGORIES = Object.freeze([
  'known-test-failure', 'reduced-coverage', 'nonessential-document',
  'new-test-failure', 'validation-unavailable'
]);
export const TRP_INTEGRITY_CATEGORIES = Object.freeze([
  'provenance', 'identity', 'protected-path', 'source-safety', 'non-waivable', 'policy-integrity'
]);
/**
 * Evidence that was authentic but no longer describes the candidate: its dependencies, environment
 * or age moved on. It is neither a risk a person can accept nor tampering; the repair is to run the
 * check again. Classifying it as provenance sent people to restore authority they never lost.
 */
export const TRP_STALE_CATEGORY = 'stale-evidence';
const str = { type: 'string', minLength: 1, maxLength: 2048 };
const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' };
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const timestamp = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' };
const integer = { type: 'integer', minimum: 0 };
const bool = { type: 'boolean' };
const enumeration = (...values) => ({ enum: values });
const array = (items, minItems = 0, uniqueItems = false) => ({ type: 'array', items, minItems, ...(uniqueItems ? { uniqueItems: true } : {}) });
const set = (items = str) => array(items, 0, true);
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter((key) => !optional.includes(key)), additionalProperties: false });
const subject = object({ workId: id, repositoryId: id, phaseId: id, generation: integer, validationEpoch: integer });
const issuer = object({ principal: str, channel: str });
const provenance = object({ authorityRef: str, evidenceRefs: set(str) });
const dependencies = set(object({ id: str, sha256: digest }));
const environment = object({
  hostId: str, platform: str, arch: str, runtimeSha256: digest, dependencySha256: digest,
  runnerSha256: digest, adapterSha256: digest, configurationSha256: digest,
  externalDependenciesSha256: nullable(digest)
});
const counts = object({ discovered: integer, passed: integer, failed: integer, skipped: integer, notRun: integer });
const testCase = object({
  id: str, outcome: enumeration('passed', 'failed', 'skipped', 'not-run'),
  semanticsSha256: digest, causeSha256: nullable(digest)
});
// Obligation IDs are command identities, not filesystem names. Preserve structured
// command IDs such as '.-python-tests' exactly instead of silently normalizing them.
const obligation = object({ id: str, kind: enumeration('test', 'document', 'quality'), nonWaivable: bool,
  transitions: set(str), phaseIds: set(id) }, ['phaseIds']);
const execution = object({
  mode: enumeration('changed-and-affected', 'all-configured', 'not-applicable'),
  moduleExpansion: enumeration('deny', 'confirm', 'allow'),
  fullSuiteExpansion: enumeration('deny', 'confirm', 'allow'),
  knownFailureHandling: enumeration('observe', 'reviewed-exclusion')
});
const repository = object({
  repositoryId: id, required: bool, codeBearing: bool,
  baselineDisposition: enumeration('fix', 'accept-known-failures', 'unknown', 'not-applicable'),
  baselineScope: enumeration('targeted', 'all-configured', 'unknown', 'not-applicable'),
  baselineRefs: set(digest), execution, mandatoryObligations: set(obligation), riskDecisionRefs: set(digest)
});
const issue = object({
  id, causeFingerprint: digest, category: enumeration(...TRP_RISK_CATEGORIES, ...TRP_INTEGRITY_CATEGORIES, TRP_STALE_CATEGORY),
  severity: enumeration('noncritical', 'critical'), observationRef: nullable(digest), obligationId: str,
  owner: str, repairRoute: str, preservedState: set(str), riskEligible: bool, riskReason: str, message: str
});
const disposition = object({
  obligationId: str, observationRef: nullable(digest), observedOutcome: enumeration('passed', 'failed', 'not-run', 'unavailable', 'inconclusive', 'invalid-evidence'),
  disposition: enumeration('satisfied', 'repair-required', 'accepted-known-failures', 'accepted-risk', 'integrity-blocked'),
  decisionRefs: set(digest), issueIds: set(id)
});
const envelope = (kind, properties, subjectSchema = subject) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://example.invalid/singularity-flow/${kind}.schema.json`,
  ...object({ schemaVersion: { const: 1 }, kind: { const: kind }, id, subject: subjectSchema,
    createdAt: timestamp, issuer, provenance, ...properties, recordSha256: digest })
});
const observationFields = {
  obligationId: str, agreementSha256: digest, selectionSha256: digest, sourceRevision: str,
  sourceManifestSha256: digest, commandInventorySha256: digest, commandSha256: digest,
  selectorSha256: digest, dependencies, environment, startedAt: timestamp, completedAt: timestamp,
  processExitCode: nullable({ type: 'integer' }), reportStatus: enumeration('current', 'missing', 'stale', 'invalid', 'not-required'),
  reportSha256s: set(digest), expectedTestIds: set(str), cases: set(testCase), counts,
  identityCompleteness: enumeration('complete', 'incomplete', 'ambiguous'),
  observedOutcome: enumeration('passed', 'failed', 'not-run', 'unavailable', 'inconclusive', 'invalid-evidence'),
  diagnostics: array({ type: 'string', maxLength: 2048 }), executionOrigin: enumeration('executed', 'reused')
};

export const TRP_SCHEMAS = deepFreeze({
  'story-test-recovery-agreement': envelope('story-test-recovery-agreement', {
    revision: { type: 'integer', minimum: 1 }, parentRevision: nullable(integer), policyAuthoritySha256: digest,
    confirmedPlanSha256: digest, repositories: array(repository, 1), repair: object({ maxDistinctAutomaticAttempts: integer })
  }, object({ workId: id })),
  'test-baseline-manifest': envelope('test-baseline-manifest', {
    ...observationFields, agreementSha256: nullable(digest), preFeatureBase: str, inventoryTestIds: set(str), inventoryComplete: bool
  }),
  'test-selection-manifest': envelope('test-selection-manifest', {
    agreementSha256: digest, requestedMode: execution.properties.mode, effectiveMode: execution.properties.mode,
    candidateDeltaSha256: digest, commandInventorySha256: digest, commandSha256: digest, selectorSha256: digest,
    selectedTestIds: set(str), selectedSuites: set(str), inventoryTestIds: set(str),
    reasons: array(object({ target: str, reason: str })),
    expansion: enumeration('none', 'module', 'full-suite'), fullSuiteEquivalent: bool,
    confirmationSha256: nullable(digest), exclusions: set(object({ testId: str, baselineSha256: digest, decisionSha256: digest })),
    uncoveredAreas: set(str), impactComplete: bool
  }),
  'phase-validation-observation': envelope('phase-validation-observation', observationFields),
  'phase-risk-decision': envelope('phase-risk-decision', {
    agreementSha256: digest, policyAuthoritySha256: digest, issueId: id,
    category: enumeration(...TRP_RISK_CATEGORIES), severity: { const: 'noncritical' },
    anchorObservationDigest: digest, obligationId: str, transitions: array(str, 1, true),
    authorityRef: str, authorizationRef: str, confirmationSha256: digest,
    reason: { type: 'string', minLength: 15, maxLength: 2000 }, expiresAt: timestamp,
    followUpOwner: str, remediationRef: str,
    applicability: object({
      carryForward: bool, phaseIds: array(id, 1, true), dependencies,
      environmentSha256: digest, baselineSha256: nullable(digest),
      acceptedFailures: set(object({ testId: str, semanticsSha256: digest, causeSha256: nullable(digest) })),
      allowedTestIds: set(str), excludedTestIds: set(str), maxFailed: integer,
      commandSha256: digest, selectorSha256: digest, maxObservationAgeSeconds: integer
    })
  }),
  'phase-risk-revocation': envelope('phase-risk-revocation', {
    agreementSha256: digest, policyAuthoritySha256: digest, decisionSha256: digest,
    category: enumeration(...TRP_RISK_CATEGORIES), transitions: array(str, 1, true),
    authorizationRef: str, confirmationSha256: digest,
    reason: { type: 'string', minLength: 15, maxLength: 2000 }, effectiveAt: timestamp
  }),
  'phase-gate-evaluation': envelope('phase-gate-evaluation', {
    evaluatorVersion: { const: TRP_EVALUATOR_VERSION }, agreementSha256: nullable(digest), policyAuthoritySha256: nullable(digest),
    operation: str, mode: enumeration('current', 'historical'), inputSha256: digest,
    observationRefs: set(digest), decisionRefs: set(digest), requiredObligations: set(str),
    issues: array(issue), dispositions: array(disposition), remainingBlockers: set(id),
    supportedNextActions: set(str), decisionDependencies: set(object({ decisionSha256: digest, dependencies })),
    operationReadiness: enumeration('ready', 'needs-execution', 'needs-decision', 'needs-repair', 'blocked', 'publication-pending'),
    gateDecision: enumeration('allow', 'allow-with-risk', 'block'), normalApprovalRequired: bool
  }),
  'story-test-policy-amendment': envelope('story-test-policy-amendment', {
    oldAgreementSha256: digest, newAgreementSha256: digest, oldPolicyAuthoritySha256: digest,
    newPolicyAuthoritySha256: digest, originalAuthorityReceiptRef: str, candidateAuthorityReceiptRef: str,
    reviewedDeltaSha256: digest, affectedPhaseIds: set(id), previousEpoch: integer, nextEpoch: integer,
    transactionId: id, confirmationSha256: digest
  }, object({ workId: id })),
  'phase-repair-receipt': envelope('phase-repair-receipt', {
    agreementSha256: digest, issueId: id, reviewedPlanSha256: digest, attempt: integer,
    issueFingerprint: digest, retryEvidenceSha256: digest, affectedPaths: set(str),
    preservedRefs: set(str), result: enumeration('repaired', 'failed', 'needs-review', 'external-prerequisite'),
    successorGeneration: nullable(integer), observationRefs: set(digest)
  }),
  'trp-authority-receipt': envelope('trp-authority-receipt', {
    authorizedRecordSha256: digest, policyAuthoritySha256: digest, confirmationSha256: digest,
    capability: enumeration('trp-agreement', 'trp-risk-decision', 'trp-scope-confirmation', 'trp-risk-revocation'),
    transitions: set(str), issuedAt: timestamp, authorizationRef: str,
    authorityGroup: str, assurance: { const: 'configured-local-review' },
    reviewPlanSha256: digest, reviewActionId: str, actionAuthorizationId: str,
    questionId: str, answerReceipt: str, actor: object({ name: str, email: nullable(str), login: nullable(str) })
  }, { anyOf: [subject, object({ workId: id })] })
});
export const TRP_RECORD_KINDS = Object.freeze(Object.keys(TRP_SCHEMAS));
export const TRP_POLICY_SCHEMA = deepFreeze(object({
  enabled: bool, authoritySha256: digest, enabledRiskCategories: set(enumeration(...TRP_RISK_CATEGORIES)),
  maxRiskDays: { type: 'integer', minimum: 1, maximum: 30 }, allowEvidenceReuse: bool,
  maxEvidenceAgeSeconds: integer, requiredApproval: bool
}));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
function fail(message) {
  const error = new Error(message);
  error.code = 'TRP_RECORD_INVALID';
  throw error;
}
function assertSchema(schema, value, path = '$') {
  if (schema.anyOf) {
    if (!schema.anyOf.some((entry) => { try { assertSchema(entry, value, path); return true; } catch { return false; } })) fail(`${path}: invalid value`);
    return;
  }
  if ('const' in schema && value !== schema.const) fail(`${path}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${path}: unsupported value`);
  if (schema.type === 'null' && value !== null) fail(`${path}: expected null`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') fail(`${path}: expected boolean`);
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail(`${path}: invalid integer`);
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)
    || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) || (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))))) fail(`${path}: invalid string`);
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0)) fail(`${path}: invalid array`);
    value.forEach((entry, index) => assertSchema(schema.items, entry, `${path}[${index}]`));
    if (schema.uniqueItems && new Set(value.map((entry) => recordSha256(entry))).size !== value.length) fail(`${path}: duplicate values`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${path}: expected plain object`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}: required`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) fail(`${path}.${key}: unknown field`);
      assertSchema(schema.properties[key], value[key], `${path}.${key}`);
    }
  }
}

// Only schema-declared sets are sorted. Ordered arrays (including any command argv)
// retain their order, following the repository's canonical record hashing rules.
function canonicalSets(value, schema) {
  if (value === null || !schema) return value;
  if (schema.anyOf) return canonicalSets(value, schema.anyOf.find((entry) => entry.type !== 'null'));
  if (Array.isArray(value)) {
    const result = value.map((entry) => canonicalSets(entry, schema.items));
    return schema.uniqueItems ? result.sort((a, b) => { const x = recordSha256(a); const y = recordSha256(b); return x < y ? -1 : x > y ? 1 : 0; }) : result;
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, canonicalSets(entry, schema.properties?.[key])]));
  return value;
}
export function trpDigest(value) { return `sha256:${recordSha256(value)}`; }
export function trpEnvironmentDigest(value) { assertSchema(environment, value); return trpDigest(value); }
export function trpRecordDigest(record) {
  const schema = TRP_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported TRP record kind');
  const core = { ...record };
  delete core.recordSha256;
  return trpDigest(canonicalSets(core, schema));
}
export function sealTrpRecord(record) {
  const schema = TRP_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported TRP record kind');
  const core = canonicalSets(structuredClone(record), schema);
  delete core.recordSha256;
  const result = { ...core, recordSha256: trpDigest(core) };
  validateTrpRecord(result);
  return deepFreeze(result);
}
export function validateTrpRecord(record, { kind } = {}) {
  if (kind && record?.kind !== kind) fail(`Expected ${kind}`);
  const schema = TRP_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported TRP record kind; use a compatible reader');
  assertSchema(schema, record);
  if (trpRecordDigest(record) !== record.recordSha256) fail('TRP record digest mismatch');
  if (record.subject?.workId?.includes('..') || record.id.includes('..')) fail('Unsafe record identifier');
  const duplicateIds = (entries, key) => entries && new Set(entries.map((entry) => entry[key])).size !== entries.length;
  if (duplicateIds(record.repositories, 'repositoryId') || duplicateIds(record.cases, 'id') || duplicateIds(record.dependencies, 'id')
    || duplicateIds(record.applicability?.dependencies, 'id') || duplicateIds(record.applicability?.acceptedFailures, 'testId')) fail('Duplicate identity');
  for (const repo of record.repositories ?? []) if (duplicateIds(repo.mandatoryObligations, 'id')) fail('Duplicate obligation');
  if (record.counts) {
    const measured = { discovered: record.cases.length, passed: 0, failed: 0, skipped: 0, notRun: 0 };
    for (const entry of record.cases) measured[entry.outcome === 'not-run' ? 'notRun' : entry.outcome] += 1;
    if (Object.keys(measured).some((key) => measured[key] !== record.counts[key])) fail('Counts do not match exact test identities');
    if (Date.parse(record.completedAt) < Date.parse(record.startedAt) || Date.parse(record.createdAt) < Date.parse(record.completedAt)) fail('Invalid observation chronology');
    if (record.identityCompleteness === 'complete' && (record.cases.length !== record.expectedTestIds.length
      || record.cases.some((entry) => !record.expectedTestIds.includes(entry.id)))) fail('Complete observation must include every expected test');
  }
  if (record.kind === 'phase-risk-decision' && Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) fail('Decision expiry must follow issuance');
  if (record.kind === 'phase-risk-revocation' && record.effectiveAt !== record.createdAt) fail('Revocation takes effect at its recorded review time');
  return record;
}

const authorityReceipt = object({
  recordSha256: digest, principal: str, policyAuthoritySha256: digest, confirmationSha256: digest,
  capability: enumeration('trp-agreement', 'trp-risk-decision', 'trp-scope-confirmation', 'trp-risk-revocation'),
  transitions: set(str), issuedAt: timestamp, revokedAt: nullable(timestamp), durable: { const: true }, authorizationRef: str
});
const evidenceReceipt = object({ recordSha256: digest, authenticated: { const: true }, reportsAvailable: bool, verifiedAt: timestamp });
function verifiedAuthority(record, context, verifyAuthority, capability, confirmation) {
  if (typeof verifyAuthority !== 'function') return false;
  try {
    const receipt = verifyAuthority(record, { ...context, capability });
    assertSchema(authorityReceipt, receipt);
    const time = Date.parse(context.at);
    return receipt.recordSha256 === record.recordSha256
      && (capability === 'trp-agreement' || receipt.principal === record.issuer.principal)
      && receipt.policyAuthoritySha256 === context.policy.authoritySha256
      && receipt.confirmationSha256 === confirmation && receipt.capability === capability
      && Date.parse(record.createdAt) <= Date.parse(receipt.issuedAt)
      && Date.parse(receipt.issuedAt) <= time && (receipt.revokedAt === null || Date.parse(receipt.revokedAt) > time)
      && (capability !== 'trp-risk-decision' || (receipt.authorizationRef === record.authorizationRef && receipt.transitions.includes(context.operation)));
  } catch { return false; }
}
function verifiedEvidence(record, context, verifyEvidence) {
  if (typeof verifyEvidence !== 'function') return false;
  try {
    const receipt = verifyEvidence(record, context);
    assertSchema(evidenceReceipt, receipt);
    return receipt.recordSha256 === record.recordSha256 && receipt.reportsAvailable === true
      && Date.parse(record.createdAt) <= Date.parse(context.at)
      && Date.parse(receipt.verifiedAt) >= Date.parse(record.createdAt)
      // Historical replay authenticates old bytes now; its verification timestamp may
      // legitimately be later than the original transition, never a new authorization.
      && (context.mode === 'historical' || Date.parse(receipt.verifiedAt) <= Date.parse(context.at));
  } catch { return false; }
}
function staleEvidence(message) {
  return Object.assign(new Error(message), { staleEvidence: true });
}
function sameDependencies(expected, actual) {
  return Array.isArray(actual) && expected.every((dependency) => actual.some((entry) => entry.id === dependency.id && entry.sha256 === dependency.sha256));
}
function exactDependencies(expected, actual) {
  return expected.length === actual.length && sameDependencies(expected, actual);
}
function sameSubject(left, right, { phase = true, generation = true } = {}) {
  return left.workId === right.workId && left.repositoryId === right.repositoryId
    && (!phase || left.phaseId === right.phaseId) && (!generation || left.generation === right.generation)
    && left.validationEpoch === right.validationEpoch;
}
function makeIssue(category, obligationId, observation, message, policy, nonWaivable = false, evaluatedSubject = null) {
  const actualCategory = nonWaivable ? 'non-waivable' : category;
  const { causeFingerprint } = trpIssueIdentity({ category: actualCategory, obligationId, message,
    observation, subject: evaluatedSubject });
  const eligible = !nonWaivable && policy?.enabledRiskCategories?.includes(category) === true;
  return { id: `issue-${causeFingerprint.slice(7, 31)}`, causeFingerprint, category: actualCategory,
    severity: nonWaivable || TRP_INTEGRITY_CATEGORIES.includes(actualCategory) || actualCategory === TRP_STALE_CATEGORY ? 'critical' : 'noncritical',
    observationRef: observation?.recordSha256 ?? null, obligationId, owner: 'story-owner',
    repairRoute: TRP_INTEGRITY_CATEGORIES.includes(actualCategory) ? 'restore-authority-or-evidence'
      : actualCategory === TRP_STALE_CATEGORY ? 'rerun-validation' : 'repair-obligation',
    preservedState: ['source bytes', 'published generations', 'approval history', 'original observations'],
    riskEligible: eligible, riskReason: eligible ? 'Enabled by pinned policy; authenticated decision required' : 'Not waivable under pinned policy', message };
}
export function trpIssueIdentity({ category, obligationId, message, observation = null, subject: evaluatedSubject = null }) {
  const boundSubject = evaluatedSubject ?? observation?.subject;
  // Group repeated causes across report IDs and generations, never across another
  // repository, epoch, command contract or testcase/cause hidden by equal totals.
  const cases = (Array.isArray(observation?.cases) ? observation.cases : []).map((entry) => ({
    id: entry.id ?? null, outcome: entry.outcome ?? null, semanticsSha256: entry.semanticsSha256 ?? null,
    causeSha256: entry.causeSha256 ?? null
  })).sort((left, right) => trpDigest(left).localeCompare(trpDigest(right)));
  const causeFingerprint = trpDigest({ category, obligationId, message,
    subject: boundSubject ? { workId: boundSubject.workId, repositoryId: boundSubject.repositoryId,
      validationEpoch: boundSubject.validationEpoch } : null,
    observation: observation ? { observedOutcome: observation.observedOutcome ?? null,
      commandSha256: observation.commandSha256 ?? null, selectorSha256: observation.selectorSha256 ?? null,
      cases } : null });
  return { id: `issue-${causeFingerprint.slice(7, 31)}`, causeFingerprint };
}

function knownFailureMatch(current, baseline, decision, selection) {
  const baselineCompatibility = baseline?.dependencies?.filter(entry => entry.id === 'baseline-compatibility') ?? [];
  const currentCompatibility = current.dependencies.filter(entry => entry.id === 'baseline-compatibility');
  const boundedCompatibility = baselineCompatibility.length === 1 && currentCompatibility.length === 1
    && baselineCompatibility[0].sha256 === currentCompatibility[0].sha256
    && exactDependencies(decision.applicability.dependencies, baselineCompatibility)
    && trpEnvironmentDigest({ ...current.environment, dependencySha256: baselineCompatibility[0].sha256 })
      === trpEnvironmentDigest({ ...baseline.environment, dependencySha256: baselineCompatibility[0].sha256 });
  const exactCompatibility = baseline && exactDependencies(decision.applicability.dependencies, baseline.dependencies)
    && trpEnvironmentDigest(current.environment) === trpEnvironmentDigest(baseline.environment);
  if (!baseline || baseline.kind !== 'test-baseline-manifest' || baseline.identityCompleteness !== 'complete'
    || current.identityCompleteness !== 'complete' || baseline.subject.repositoryId !== current.subject.repositoryId
    || baseline.subject.phaseId !== current.subject.phaseId
    || baseline.subject.workId !== current.subject.workId || baseline.obligationId !== current.obligationId
    || baseline.preFeatureBase !== baseline.sourceRevision
    || current.commandSha256 !== baseline.commandSha256 || current.commandInventorySha256 !== baseline.commandInventorySha256
    || current.selectorSha256 !== baseline.selectorSha256 || (!boundedCompatibility && !exactCompatibility)
    || current.expectedTestIds.some((testId) => !baseline.expectedTestIds.includes(testId))) return false;
  // Disappearance/skips and changed semantics are findings even if failure counts fall.
  if (current.expectedTestIds.length !== selection.selectedTestIds.length
    || selection.selectedTestIds.some((testId) => !current.expectedTestIds.includes(testId))) return false;
  for (const entry of current.cases) {
    const previous = baseline.cases.find((candidate) => candidate.id === entry.id);
    if (!previous || previous.semanticsSha256 !== entry.semanticsSha256 || entry.outcome === 'not-run'
      || (entry.outcome === 'skipped' && previous.outcome !== 'skipped')) return false;
    if (entry.outcome === 'failed') {
      const accepted = decision.applicability.acceptedFailures.find((candidate) => candidate.testId === entry.id);
      if (previous.outcome !== 'failed' || !accepted || accepted.semanticsSha256 !== entry.semanticsSha256
        || previous.causeSha256 !== entry.causeSha256 || accepted.causeSha256 !== entry.causeSha256) return false;
    }
  }
  return current.counts.failed > 0 && current.counts.failed <= decision.applicability.maxFailed;
}

/**
 * Evaluate one repository/phase gate. At every gate the caller passes the SAME pinned
 * policy and exact dependencies, plus host verifier functions. Other repositories must
 * be evaluated independently before Story-wide feature admission.
 */
export function evaluateTestRecoveryGate({
  policy, agreement, subject: evaluationSubject, operation, mode = 'current', at,
  observations = [], baselines = [], decisions = [], selection = null, candidateDependencies = [],
  candidateEnvironment = null, verifyAuthority, verifyEvidence, integrityIssues = [], publicationPending = false,
  obligationIds = null
}) {
  assertSchema(subject, evaluationSubject);
  assertSchema(timestamp, at);
  assertSchema(str, operation);
  if (!['current', 'historical'].includes(mode)) fail('Unknown evaluation mode');
  assertSchema(dependencies, candidateDependencies);
  if (obligationIds !== null) assertSchema(array(str, 1, true), obligationIds);
  if (candidateEnvironment) assertSchema(environment, candidateEnvironment);
  const context = { at, mode, operation, policy, subject: evaluationSubject };
  const issues = [];
  const dispositions = [];
  const usedDecisions = [];
  const requiredObligations = [];
  let needsExecution = false;
  const addIssue = (category, obligationId, observation, message, pinnedPolicy, nonWaivable = false) => {
    const item = makeIssue(category, obligationId, observation, message, pinnedPolicy, nonWaivable, evaluationSubject);
    issues.push(item); return item;
  };
  const finish = () => {
    const acceptedIssueIds = new Set(dispositions.filter((entry) => ['accepted-known-failures', 'accepted-risk'].includes(entry.disposition)).flatMap((entry) => entry.issueIds));
    const blockers = issues.filter((entry) => !acceptedIssueIds.has(entry.id));
    const integrity = blockers.some((entry) => TRP_INTEGRITY_CATEGORIES.includes(entry.category));
    const readiness = publicationPending ? 'publication-pending' : integrity ? 'blocked' : blockers.length
      ? needsExecution ? 'needs-execution' : blockers.every((entry) => entry.riskEligible) ? 'needs-decision' : 'needs-repair' : 'ready';
    const inputSha256 = trpDigest({ policy: policy ?? null, agreement: agreement?.recordSha256 ?? null,
      subject: evaluationSubject, operation, mode, at, observations: observations.map((entry) => entry.recordSha256 ?? null).sort(),
      baselines: baselines.map((entry) => entry.recordSha256 ?? null).sort(), decisions: decisions.map((entry) => entry.recordSha256 ?? null).sort(),
      selection: selection?.recordSha256 ?? null, candidateDependencies: canonicalSets(candidateDependencies, dependencies),
      candidateEnvironment, integrityIssues, publicationPending, obligationIds });
    return sealTrpRecord({ schemaVersion: 1, kind: 'phase-gate-evaluation', id: `evaluation-${inputSha256.slice(7, 31)}`,
      subject: evaluationSubject, createdAt: at, issuer: { principal: 'trp-evaluator', channel: TRP_EVALUATOR_VERSION },
      provenance: { authorityRef: policy?.authoritySha256 ?? 'legacy-policy', evidenceRefs: [] },
      evaluatorVersion: TRP_EVALUATOR_VERSION, agreementSha256: agreement?.recordSha256 ?? null,
      policyAuthoritySha256: policy?.authoritySha256 ?? null, operation, mode, inputSha256,
      observationRefs: [...new Set(observations.map((entry) => entry.recordSha256).filter((value) => /^sha256:[a-f0-9]{64}$/u.test(value)))],
      decisionRefs: [...new Set(usedDecisions.map((entry) => entry.recordSha256))], requiredObligations,
      issues, dispositions, remainingBlockers: [...new Set(blockers.map((entry) => entry.id))],
      supportedNextActions: publicationPending ? ['resume-exact-publication'] : blockers.length
        ? [...new Set(blockers.flatMap((entry) => [entry.repairRoute, ...(entry.riskEligible ? ['request-risk-review'] : [])]))]
        : [operation], decisionDependencies: usedDecisions.map((entry) => ({ decisionSha256: entry.recordSha256, dependencies: entry.applicability.dependencies })),
      operationReadiness: readiness, gateDecision: readiness === 'ready' ? usedDecisions.length ? 'allow-with-risk' : 'allow' : 'block',
      normalApprovalRequired: policy?.requiredApproval !== false });
  };
  try {
    assertSchema(TRP_POLICY_SCHEMA, policy);
    if (policy.enabled !== true || !agreement) throw new Error('TRP requires explicit enablement and an approved agreement; legacy behavior remains active');
    validateTrpRecord(agreement, { kind: 'story-test-recovery-agreement' });
    if (agreement.subject.workId !== evaluationSubject.workId || agreement.policyAuthoritySha256 !== policy.authoritySha256
      || !verifiedAuthority(agreement, context, verifyAuthority, 'trp-agreement', agreement.confirmedPlanSha256)) throw new Error('Agreement authority or durability is not established');
  } catch (error) {
    addIssue('policy-integrity', 'agreement', null, error.message, policy);
    return finish();
  }
  for (const finding of integrityIssues) {
    assertSchema(object({ category: enumeration(...TRP_INTEGRITY_CATEGORIES), obligationId: str, message: str }), finding);
    addIssue(finding.category, finding.obligationId, null, finding.message, policy);
  }
  const repo = agreement.repositories.find((entry) => entry.repositoryId === evaluationSubject.repositoryId);
  if (!repo) { addIssue('policy-integrity', 'repository', null, 'Repository is absent from the pinned agreement', policy); return finish(); }
  const obligations = repo.mandatoryObligations.filter((entry) => entry.transitions.includes(operation)
    && (!entry.phaseIds || entry.phaseIds.includes(evaluationSubject.phaseId))
    && (obligationIds === null || obligationIds.includes(entry.id)));
  if (obligationIds?.some(id => !obligations.some(entry => entry.id === id))) {
    addIssue('policy-integrity', 'obligation-selection', null, 'The requested obligation is not pinned for this phase and transition', policy);
    return finish();
  }
  requiredObligations.push(...obligations.map((entry) => entry.id));
  const testObligations = obligations.filter((entry) => entry.kind === 'test');
  // Missing execution can have an authenticated attempt without a testcase
  // inventory. It never supports a passed/failed claim or inferred coverage.
  const unavailableAttempt = (entry) => entry && ['unavailable', 'not-run'].includes(entry.observedOutcome)
    && ['missing', 'not-required'].includes(entry.reportStatus) && entry.processExitCode === null
    && entry.identityCompleteness === 'incomplete' && entry.cases.length === 0
    && entry.expectedTestIds.length === 0 && entry.reportSha256s.length === 0
    && Object.values(entry.counts).every((count) => count === 0);
  const unavailableSelection = testObligations.length > 0 && testObligations.every((required) => {
    const matching = observations.filter((entry) => entry?.obligationId === required.id);
    if (matching.length !== 1) return false;
    try {
      const entry = validateTrpRecord(matching[0], { kind: 'phase-validation-observation' });
      return unavailableAttempt(entry) && sameSubject(entry.subject, evaluationSubject)
        && entry.agreementSha256 === agreement.recordSha256 && verifiedEvidence(entry, context, verifyEvidence);
    } catch { return false; }
  });
  let selectionValid = testObligations.length === 0;
  if (testObligations.length) {
    try {
      if (!candidateEnvironment || candidateDependencies.length === 0) throw new Error('Current host qualification and explicit dependency bindings are required');
      validateTrpRecord(selection, { kind: 'test-selection-manifest' });
      if (!sameSubject(selection.subject, evaluationSubject) || selection.agreementSha256 !== agreement.recordSha256
        || selection.requestedMode !== repo.execution.mode) throw new Error('Selection is bound to a different agreement or candidate');
      const inventoryCovered = selection.inventoryTestIds.length > 0 && selection.inventoryTestIds.every((testId) =>
        selection.selectedTestIds.includes(testId) || selection.exclusions.some((entry) => entry.testId === testId));
      const full = selection.fullSuiteEquivalent || selection.effectiveMode === 'all-configured' || selection.expansion === 'full-suite' || inventoryCovered;
      const expansionRule = full && repo.execution.mode !== 'all-configured' ? repo.execution.fullSuiteExpansion
        : selection.expansion !== 'none' ? repo.execution.moduleExpansion : 'allow';
      if (expansionRule === 'deny' || (expansionRule === 'confirm' && (!selection.confirmationSha256
        || !verifiedAuthority(selection, context, verifyAuthority, 'trp-scope-confirmation', selection.confirmationSha256)))) throw new Error('Exact expanded test scope needs authorized confirmation');
      if (selection.effectiveMode === 'not-applicable' || (!selection.selectedTestIds.length && !selection.selectedSuites.length)) throw new Error('Required test selection is empty');
      if ((!selection.inventoryTestIds.length || !selection.selectedTestIds.length) && !unavailableSelection) throw new Error('A verified exact test inventory is required by this TRP adapter');
      if ([...selection.selectedTestIds, ...selection.exclusions.map((entry) => entry.testId)]
        .some((testId) => !selection.inventoryTestIds.includes(testId))) throw new Error('Selected or excluded tests are absent from the verified inventory');
      if (full && selection.inventoryTestIds.some((testId) => !selection.selectedTestIds.includes(testId)
        && !selection.exclusions.some((entry) => entry.testId === testId))) throw new Error('All-configured selection does not cover its inventory');
      if (selection.exclusions.some((entry) => selection.selectedTestIds.includes(entry.testId))) throw new Error('Excluded tests cannot count as executed');
      if (selection.exclusions.length && repo.execution.knownFailureHandling !== 'reviewed-exclusion') throw new Error('Known-failure exclusions require an approved handling amendment');
      selectionValid = true;
    } catch (error) { addIssue('policy-integrity', 'test-selection', null, error.message, policy); }
  }
  const validBaselines = baselines.filter((baseline) => {
    try {
      validateTrpRecord(baseline, { kind: 'test-baseline-manifest' });
      return verifiedEvidence(baseline, context, verifyEvidence) && baseline.preFeatureBase === baseline.sourceRevision
        && ['passed', 'failed'].includes(baseline.observedOutcome) && baseline.reportStatus === 'current' && baseline.reportSha256s.length > 0
        && baseline.identityCompleteness === 'complete' && baseline.counts.discovered > 0 && baseline.counts.notRun === 0
        && ((baseline.observedOutcome === 'passed' && baseline.processExitCode === 0 && baseline.counts.failed === 0)
          || (baseline.observedOutcome === 'failed' && baseline.processExitCode !== null && baseline.processExitCode !== 0 && baseline.counts.failed > 0));
    } catch { return false; }
  });
  const validDecisions = decisions.filter((decision) => {
    try {
      validateTrpRecord(decision, { kind: 'phase-risk-decision' });
      const conditions = decision.applicability;
      return decision.agreementSha256 === agreement.recordSha256 && decision.policyAuthoritySha256 === policy.authoritySha256
        && decision.subject.workId === evaluationSubject.workId && decision.subject.repositoryId === evaluationSubject.repositoryId
        && decision.subject.validationEpoch === evaluationSubject.validationEpoch
        && (conditions.carryForward || sameSubject(decision.subject, evaluationSubject))
        && (decision.subject.phaseId !== evaluationSubject.phaseId || decision.subject.generation <= evaluationSubject.generation)
        && conditions.phaseIds.includes(evaluationSubject.phaseId) && decision.transitions.includes(operation)
        && policy.enabledRiskCategories.includes(decision.category) && Date.parse(decision.createdAt) <= Date.parse(at)
        && Date.parse(at) < Date.parse(decision.expiresAt)
        && Date.parse(decision.expiresAt) - Date.parse(decision.createdAt) <= policy.maxRiskDays * 86400000
        && sameDependencies(conditions.dependencies, candidateDependencies)
        && verifiedAuthority(decision, context, verifyAuthority, 'trp-risk-decision', decision.confirmationSha256);
    } catch { return false; }
  });
  for (const required of obligations) {
    const matching = observations.filter((entry) => entry?.obligationId === required.id);
    let observation = matching.length === 1 ? matching[0] : null;
    const localIssues = [];
    const raise = (category, message) => { const finding = addIssue(category, required.id, observation, message, policy, required.nonWaivable); localIssues.push(finding); return finding; };
    if (matching.length > 1) raise('provenance', 'Multiple observations supplied for one obligation; choose the exact current evidence');
    if (!observation) {
      if (matching.length === 0) { needsExecution = true; raise('validation-unavailable', 'Required check has no current observation'); }
    } else {
      try {
        validateTrpRecord(observation, { kind: 'phase-validation-observation' });
        if (observation.agreementSha256 !== agreement.recordSha256 || !sameSubject(observation.subject, evaluationSubject)
          || !verifiedEvidence(observation, context, verifyEvidence)) throw new Error('Observation identity, policy, epoch or authenticated provenance does not match');
        if (!sameDependencies(observation.dependencies, candidateDependencies)
          || (candidateEnvironment && trpEnvironmentDigest(observation.environment) !== trpEnvironmentDigest(candidateEnvironment))) throw staleEvidence('Observation dependency or host environment is no longer current');
        if (Date.parse(at) - Date.parse(observation.completedAt) > policy.maxEvidenceAgeSeconds * 1000
          || (observation.executionOrigin === 'reused' && !policy.allowEvidenceReuse)) throw staleEvidence('Observation freshness does not permit reuse');
        if (required.kind === 'test' && (!selectionValid || observation.selectionSha256 !== selection?.recordSha256
          || observation.commandSha256 !== selection.commandSha256 || observation.selectorSha256 !== selection.selectorSha256
          || observation.commandInventorySha256 !== selection.commandInventorySha256)) throw new Error('Observation is not bound to the sealed test selection');
        if (observation.observedOutcome === 'invalid-evidence' || ['stale', 'invalid'].includes(observation.reportStatus)) throw new Error('Invalid or stale report cannot be accepted as authentic evidence');
        if (required.kind === 'test' && ['passed', 'failed'].includes(observation.observedOutcome)
          && (observation.reportStatus !== 'current' || observation.reportSha256s.length === 0)) throw new Error('Executed test claim requires a current authenticated report');
        if (required.kind === 'test' && ['passed', 'failed'].includes(observation.observedOutcome)
          && (observation.identityCompleteness !== 'complete' || observation.expectedTestIds.length !== selection.selectedTestIds.length
            || observation.dependencies.length === 0 || selection.selectedTestIds.some((testId) => !observation.expectedTestIds.includes(testId)))) throw new Error('Test identity completeness is not established for the sealed cohort');
        if (observation.observedOutcome === 'passed' && (observation.processExitCode !== 0 || observation.counts.failed > 0
          || observation.counts.notRun > 0 || (required.kind === 'test' && observation.counts.discovered === 0))) throw new Error('Passing claim contradicts process or exact observed outcomes');
        if (required.kind === 'test' && observation.observedOutcome === 'failed'
          && (observation.processExitCode === null || observation.processExitCode === 0 || observation.counts.failed === 0)) {
          throw new Error('Executed failure claim requires a nonzero process and exact failed test identities');
        }
      } catch (error) {
        if (error?.staleEvidence) { needsExecution = true; raise(TRP_STALE_CATEGORY, error.message); }
        else raise('provenance', error.message);
      }
      if (!localIssues.length) {
        if (['not-run', 'unavailable', 'inconclusive'].includes(observation.observedOutcome)) raise('validation-unavailable', 'Required validation remains unverified');
        else if (observation.observedOutcome === 'failed') {
          const known = required.kind === 'test' && validBaselines.some((baseline) => repo.baselineRefs.includes(baseline.recordSha256)
            && knownFailureMatch(observation, baseline, { applicability: { dependencies: baseline.dependencies.some(entry => entry.id === 'baseline-compatibility')
              ? baseline.dependencies.filter(entry => entry.id === 'baseline-compatibility') : observation.dependencies,
              acceptedFailures: baseline.cases.filter((entry) => entry.outcome === 'failed').map((entry) => ({ testId: entry.id,
                semanticsSha256: entry.semanticsSha256, causeSha256: entry.causeSha256 })), maxFailed: baseline.counts.failed } }, selection));
          raise(required.kind === 'document' ? 'nonessential-document' : required.kind === 'quality' ? 'non-waivable'
            : known ? 'known-test-failure' : 'new-test-failure', 'Required check failed');
        }
        if (required.kind === 'test' && (selection.exclusions.length || (!unavailableAttempt(observation)
          && (selection.uncoveredAreas.length || !selection.impactComplete || observation.counts.skipped > 0
            || (observation.observedOutcome === 'failed' && observation.counts.notRun > 0))))) {
          raise('reduced-coverage', 'Selected validation has explicitly untested coverage');
        }
        if (required.kind === 'test' && !unavailableAttempt(observation)) {
          const pinnedBaselines = validBaselines.filter((entry) => repo.baselineRefs.includes(entry.recordSha256)
            && entry.subject.repositoryId === evaluationSubject.repositoryId && entry.subject.workId === evaluationSubject.workId
            && entry.obligationId === required.id);
          if (repo.baselineDisposition === 'accept-known-failures' && (!pinnedBaselines.length
            || repo.baselineRefs.some((reference) => !validBaselines.some((entry) => entry.recordSha256 === reference
              && entry.subject.repositoryId === evaluationSubject.repositoryId && entry.subject.workId === evaluationSubject.workId)))) {
            raise('provenance', 'Accepted baseline evidence is missing or cannot be authenticated');
          }
          const missingSentinel = pinnedBaselines.flatMap((entry) => entry.cases.filter((test) => test.outcome === 'failed'))
            .some((test) => !selection.selectedTestIds.includes(test.id) && !selection.exclusions.some((entry) => entry.testId === test.id));
          if (repo.baselineDisposition === 'accept-known-failures' && missingSentinel) raise('reduced-coverage', 'Accepted baseline failure sentinels are absent from the current cohort');
          if (repo.execution.mode === 'all-configured' && selection.inventoryTestIds.some((testId) =>
            !pinnedBaselines.some((entry) => entry.identityCompleteness === 'complete' && entry.expectedTestIds.includes(testId)))) {
            raise('reduced-coverage', 'All-configured baseline coverage contains unknown tests');
          }
        }
      }
    }
    const authorized = [];
    for (const finding of localIssues) {
      if (required.nonWaivable || !finding.riskEligible || finding.severity !== 'noncritical'
        || TRP_INTEGRITY_CATEGORIES.includes(finding.category) || !observation) continue;
      const decision = validDecisions.find((candidate) => {
        const conditions = candidate.applicability;
        const knownCandidate = candidate.category === 'known-test-failure' && finding.category === 'known-test-failure'
          && repo.baselineDisposition === 'accept-known-failures';
        if (candidate.obligationId !== required.id || (!knownCandidate && (conditions.environmentSha256 !== trpEnvironmentDigest(observation.environment)
          || !exactDependencies(conditions.dependencies, observation.dependencies)))
          || (required.kind === 'test' && conditions.dependencies.length === 0)
          || conditions.commandSha256 !== observation.commandSha256 || conditions.selectorSha256 !== observation.selectorSha256
          || Date.parse(at) - Date.parse(observation.completedAt) > conditions.maxObservationAgeSeconds * 1000
          || observation.expectedTestIds.some((testId) => !conditions.allowedTestIds.includes(testId))) return false;
        if (knownCandidate) {
          const baseline = validBaselines.find((entry) => entry.recordSha256 === conditions.baselineSha256);
          return baseline && candidate.anchorObservationDigest === baseline.recordSha256 && repo.baselineRefs.includes(baseline.recordSha256)
            && conditions.environmentSha256 === trpEnvironmentDigest(baseline.environment)
            && knownFailureMatch(observation, baseline, candidate, selection);
        }
        const excludedBaseline = candidate.category === 'reduced-coverage' && selection?.exclusions.length > 0
          && validBaselines.some((entry) => entry.recordSha256 === candidate.anchorObservationDigest
            && repo.baselineRefs.includes(entry.recordSha256)
            && entry.obligationId === required.id && entry.subject.workId === evaluationSubject.workId
            && entry.subject.repositoryId === evaluationSubject.repositoryId
            && selection.exclusions.every((excluded) => excluded.baselineSha256 === entry.recordSha256
              && entry.cases.some((test) => test.id === excluded.testId && test.outcome === 'failed')));
        return candidate.category === finding.category && candidate.issueId === finding.id
          && (candidate.anchorObservationDigest === observation.recordSha256 || excludedBaseline)
          && (finding.category !== 'reduced-coverage' || (selection && selection.exclusions.every((entry) => conditions.excludedTestIds.includes(entry.testId)
            && entry.decisionSha256 === candidate.recordSha256)));
      });
      if (decision) {
        if (decision.category === 'known-test-failure') { finding.category = 'known-test-failure'; finding.riskEligible = true; finding.riskReason = 'Exact baseline identities and applicability verified'; }
        authorized.push(decision);
        if (!usedDecisions.some((entry) => entry.recordSha256 === decision.recordSha256)) usedDecisions.push(decision);
      }
    }
    const allAccepted = localIssues.length > 0 && authorized.length === localIssues.length;
    dispositions.push({ obligationId: required.id, observationRef: observation?.recordSha256 ?? null,
      observedOutcome: observation?.observedOutcome ?? 'not-run', disposition: !localIssues.length ? 'satisfied'
        : localIssues.some((entry) => TRP_INTEGRITY_CATEGORIES.includes(entry.category)) ? 'integrity-blocked'
          : allAccepted ? authorized.every((entry) => entry.category === 'known-test-failure') ? 'accepted-known-failures' : 'accepted-risk' : 'repair-required',
      decisionRefs: [...new Set(authorized.map((entry) => entry.recordSha256))], issueIds: localIssues.map((entry) => entry.id) });
  }
  return finish();
}
