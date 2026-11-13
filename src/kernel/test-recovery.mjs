/** Shared TRP schemas, record identity and gate evaluation over explicit evidence/authority verifiers. */
import {canonicalJson,textDigestCapability,REPAIR_BUDGET_STATE_SCHEMA} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {TRP_RISK_CATEGORIES} from './configuration-path-policies.mjs';
/** Value-only budget selection; native wrappers retain their original command presentation. */
export function repairBudgetPhaseForRejection(workflow, sourcePhase, targetPhaseId) {
  const sourceIndex=workflow.phaseOrder?.indexOf(sourcePhase.id)??-1,targetIndex=workflow.phaseOrder?.indexOf(targetPhaseId)??-1;
  if(sourceIndex<0||targetIndex<0||targetIndex>sourceIndex)return null;
  const declared=(workflow.resolution?.reworkLoops??[]).find(loop=>loop.from===sourcePhase.id&&loop.to===targetPhaseId);
  if(declared){const target=workflow.phases?.[targetPhaseId];
    if(!target?.repairBudget||target.repairBudget.maxAttempts!==declared.maxAttempts||target.repairBudget.resetOnPhase!==(declared.resetOnPhase??null))
      throw new SingularityFlowError(`Declared rework loop '${sourcePhase.id}' to '${targetPhaseId}' differs from its pinned repair budget.`,{code:'REWORK_LOOP_POLICY_MISMATCH'});
    return target;}
  return workflow.phaseOrder.slice(targetIndex,sourceIndex+1).map(id=>workflow.phases?.[id]).filter(phase=>phase?.repairBudget)
    .filter(phase=>phase.id!==sourcePhase.id||sourcePhase.validationVerdict==='failed').at(-1)??null;
}
export function repairBudgetResetTarget(workflow,policy,sourcePhase,targetPhase){
  const reset=policy.resetOnPhase;if(!reset||!sourcePhase||reset===targetPhase)return null;
  const allowed=sourcePhase.approvalPolicy?.rejectTo??[sourcePhase.id],order=workflow.phaseOrder??[];
  return allowed.includes(reset)&&order.indexOf(reset)>=0&&order.indexOf(reset)<=order.indexOf(sourcePhase.id)?reset:null;
}
/** The namespace caller supplies a verified approved reset generation; native v1 keeps its old default. */
export function consumeRepairAttemptValue(workflow,phase,{targetPhase,actor,at,changeRequestId,sourcePhase=null,resetGeneration=undefined}){
  const policy=phase.repairBudget;if(!policy)return null;
  resetGeneration??=policy.resetOnPhase?workflow.phases?.[policy.resetOnPhase]?.generation??0:0;
  workflow.repairBudgets??={};let state=workflow.repairBudgets[phase.id];
  if(!state||state.resetPhase!==policy.resetOnPhase||state.resetGeneration!==resetGeneration)state={schemaVersion:REPAIR_BUDGET_STATE_SCHEMA.currentVersion,phase:phase.id,
    maximum:policy.maxAttempts,resetPhase:policy.resetOnPhase,resetGeneration,attempts:[]};
  if(policy.resetOnPhase&&targetPhase===policy.resetOnPhase){workflow.repairBudgets[phase.id]=state;return {...structuredClone(state),resetRequested:true};}
  if(state.attempts.length>=policy.maxAttempts)throw new SingularityFlowError('The pinned repair budget is exhausted.',{code:'REPAIR_BUDGET_EXHAUSTED',details:{
    phase:phase.id,currentPhase:sourcePhase?.id??null,upstreamPhase:phase.id===sourcePhase?.id?null:phase.id,maximum:policy.maxAttempts,consumed:state.attempts.length,
    resetPhase:policy.resetOnPhase??null,resetTarget:repairBudgetResetTarget(workflow,policy,sourcePhase,targetPhase),sourceSubmitted:sourcePhase?.status==='awaiting_approval'}});
  state.attempts.push({number:state.attempts.length+1,targetPhase,actor,at,changeRequestId});workflow.repairBudgets[phase.id]=state;return structuredClone(state);
}
/** A distinct namespace history binds aggregate counters to original authenticated return receipts. */
export function applyNamespaceRepairBudget(workflow,source,request,facts,changeRequestId,kind){
  const budget=source.repairBudget;if(!budget?.selection)return null;
  const phase=workflow.phases[budget.selection.phase],from=workflow.phases[budget.sourcePhase];
  let result;try{result=consumeRepairAttemptValue(workflow,phase,{targetPhase:request.target,sourcePhase:from,actor:facts.actorId,at:facts.at,
    changeRequestId,resetGeneration:budget.selection.resetGeneration});}
  catch(cause){if(cause.code!=='REPAIR_BUDGET_EXHAUSTED')throw cause;
    const reset=cause.details.resetTarget,review={operation:'phase.review',inputs:{workId:workflow.workItem.id,phaseId:from.id}},
      actions=kind==='amendment'?[{operation:'decisions.list',inputs:{workId:workflow.workItem.id,phaseId:from.id}},
        {operation:'upstream.raise',inputs:{workId:workflow.workItem.id,phaseId:request.phaseId},requiredInputs:['operationId','about','problem'],
          prerequisites:['exact-defect-and-original-owner-review','pinned-repair-budget-remains-in-force']}]:cause.details.sourceSubmitted?[review]:[{operation:'upstream.list',inputs:{workId:workflow.workItem.id}},
        {operation:'upstream.decide',inputs:{workId:workflow.workItem.id,issueId:request.issueId},requiredInputs:['outcome','reason'],
          prerequisites:['authenticated-human-issue-owner','outcome-specific-expiry-or-link']},
        {operation:'phase.enter',inputs:{workId:workflow.workItem.id,phaseId:from.id},prerequisites:['phase-authoring-access']}];
    if(reset&&cause.details.sourceSubmitted)actions.push({operation:'phase.reject',inputs:{workId:workflow.workItem.id,phaseId:from.id,target:reset,
      ...(source.reviewPacket?{confirm:source.reviewPacket.sha256}:{})},requiredInputs:[...(!source.reviewPacket?['confirm']:[]),'reason'],prerequisites:['authenticated-human-phase-reviewer']});
    throw new SingularityFlowError('The reviewed return has exhausted its pinned repair budget. Review the original submission or its permitted reset return.',{
      code:cause.code,details:{profile:'sflow-namespace-repair-budget-refusal/v1',...cause.details,actions},cause});}
  workflow.namespaceRepairBudgetHistory=[...(workflow.namespaceRepairBudgetHistory??[]),{profile:'sflow-namespace-repair-budget-transition/v1',
    changeRequestId,kind,phase:['upstream','amendment'].includes(kind)?request.phaseId:from.id,generation:['upstream','amendment'].includes(kind)?source.generation:from.generation,budgetPhase:phase.id,recordedAt:facts.at}];
  return result;
}
export {TRP_RISK_CATEGORIES} from './configuration-path-policies.mjs';
export function testRecoveryPolicies(port) {
  const hashing=textDigestCapability(port),recordSha256=value=>hashing.sha256Utf8(canonicalJson(value));
const TRP_EVALUATOR_VERSION = 'trp/1.0';
const TRP_INTEGRITY_CATEGORIES = Object.freeze([
  'provenance', 'identity', 'protected-path', 'source-safety', 'non-waivable', 'policy-integrity'
]);
/**
 * Evidence that was authentic but no longer describes the candidate: its dependencies, environment
 * or age moved on. It is neither a risk a person can accept nor tampering; the repair is to run the
 * check again. Classifying it as provenance sent people to restore authority they never lost.
 */
const TRP_STALE_CATEGORY = 'stale-evidence';
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

const TRP_SCHEMAS = deepFreeze({
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
const TRP_RECORD_KINDS = Object.freeze(Object.keys(TRP_SCHEMAS));
const TRP_POLICY_SCHEMA = deepFreeze(object({
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
function trpDigest(value) { return `sha256:${recordSha256(value)}`; }
function trpEnvironmentDigest(value) { assertSchema(environment, value); return trpDigest(value); }
function trpRecordDigest(record) {
  const schema = TRP_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported TRP record kind');
  const core = { ...record };
  delete core.recordSha256;
  return trpDigest(canonicalSets(core, schema));
}
function sealTrpRecord(record) {
  const schema = TRP_SCHEMAS[record?.kind];
  if (!schema) fail('Unsupported TRP record kind');
  const core = canonicalSets(structuredClone(record), schema);
  delete core.recordSha256;
  const result = { ...core, recordSha256: trpDigest(core) };
  validateTrpRecord(result);
  return deepFreeze(result);
}
function validateTrpRecord(record, { kind } = {}) {
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
function trpIssueIdentity({ category, obligationId, message, observation = null, subject: evaluatedSubject = null }) {
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
function evaluateTestRecoveryGate({
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

return Object.freeze({TRP_EVALUATOR_VERSION,TRP_INTEGRITY_CATEGORIES,TRP_STALE_CATEGORY,TRP_SCHEMAS,TRP_RECORD_KINDS,TRP_POLICY_SCHEMA,trpDigest,trpEnvironmentDigest,trpRecordDigest,sealTrpRecord,validateTrpRecord,trpIssueIdentity,evaluateTestRecoveryGate});
}

/** Shared Story-command rules over exact admitted decisions; host review commands remain outside the kernel. */
/** Namespace recovery v1 keeps the full configured test set and never turns a failure into a pass.
 * Human risk and reduced-cohort records require their own, separately verified profiles. */
export function namespaceTestRecoveryPolicies(port) {
  const hash=value=>'sha256:'+textDigestCapability(port).sha256Utf8(canonicalJson(value));
  const fail=(message,code='TEST_RECOVERY_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
  function context(workflow,configuration,commands,previous=null){
    const policy=workflow.resolution.testRecovery;
    if(policy?.enabled!==true)fail('This Story has not enabled test recovery.','TEST_RECOVERY_DISABLED');
    if(!Array.isArray(commands)||commands.length!==workflow.phaseOrder.length
      ||commands.some((row,index)=>row.phaseId!==workflow.phaseOrder[index]||!Array.isArray(row.commands)))fail('The agreement needs the entire pinned command inventory.');
    const value={schemaVersion:1,profile:'sflow-namespace-test-recovery-context/v1',workId:workflow.workItem.id,
      configuration,policy,commands,previous,executionMode:'all-configured',reuse:'never',
      maximumAutomaticAttempts:policy.maxDistinctAutomaticAttempts,failures:'retain-and-repair'};
    if(!Number.isSafeInteger(value.maximumAutomaticAttempts)||value.maximumAutomaticAttempts<0||value.maximumAutomaticAttempts>3)
      fail('The automatic repair limit must be the pinned zero-to-three attempt budget.');
    return {value,sha256:hash(value)};
  }
  function confirm(workflow,request,source,facts){
    if(workflow.status!=='in_progress')fail('Confirm recovery while the Story is in progress.','TEST_RECOVERY_CLOSED');
    if(request.expectedContext!==source.context.sha256)fail('Review the current test-recovery agreement before confirming it.','TEST_RECOVERY_CONFIRMATION_REQUIRED',{
      operation:'test-recovery.context',expectedContext:source.context.sha256});
    if(typeof request.reason!=='string'||request.reason.trim().length<15||request.reason.length>2000)fail('Explain the reviewed recovery agreement.');
    const prior=workflow.namespaceTestRecoveryAgreements??[],last=prior.at(-1);
    if(prior.length>=64)fail('The Story reached its bounded recovery-agreement history. Preserve its current records for explicit migration.','ENGINE_STORAGE_LIMIT');
    if(last&&sameRecoveryInventory(last.context,source.context.value))fail('This exact recovery agreement is already confirmed.','TEST_RECOVERY_ALREADY_CONFIRMED');
    const record={schemaVersion:1,profile:'sflow-namespace-test-recovery-agreement/v1',phase:request.phaseId,revision:prior.length+1,
      previous:last?hash(last):null,context:structuredClone(source.context.value),contextSha256:source.context.sha256,
      actor:facts.actorId,authorityGroup:facts.authorityGroup,recordedAt:facts.at,reason:request.reason.trim()};
    const proposed=structuredClone(workflow);proposed.namespaceTestRecoveryAgreements=[...prior,record];
    proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'test_recovery_confirmed',phase:request.phaseId,
      detail:'Confirmed exact full-command recovery agreement revision '+record.revision+'. '+record.reason});
    return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
  }
  function sameRecoveryInventory(left,right){return canonicalJson({...left,previous:null})===canonicalJson({...right,previous:null});}
  function current(record,expected){
    if(!record||record.profile!=='sflow-namespace-test-recovery-agreement/v1'||record.contextSha256!==hash(record.context)
      ||!sameRecoveryInventory(record.context,expected.value))fail('Confirm the current commands and pinned recovery policy before execution.','TEST_RECOVERY_AGREEMENT_REQUIRED',{
        operation:'test-recovery.context',expectedContext:expected.sha256});
    return record;
  }
  function repairPlan({workflow,phaseId,agreement,failed,attempts,paths}){
    const phase=workflow.phases[phaseId];
    if(workflow.status!=='in_progress'||workflow.currentPhase!==phaseId||phase?.status!=='in_progress')fail(
      'Repair the current unsubmitted authoring phase.','TEST_RECOVERY_NOT_CURRENT');
    if(!failed?.body||failed.body.verdict==='passed')fail('Select an actual failed or unavailable execution.','TEST_RECOVERY_FAILURE_REQUIRED');
    const limit=agreement.context.maximumAutomaticAttempts;
    if(attempts.length>=limit)fail('The approved automatic test-repair budget is exhausted. A human may repair the preserved draft or review its command agreement.',
      'TEST_RECOVERY_BUDGET_EXHAUSTED',{attempts:attempts.length,limit,actions:[{operation:'test-recovery.context',inputs:{workId:workflow.workItem.id}},
        {operation:'phase.delivery.inspect',inputs:{workId:workflow.workItem.id,phaseId}},
        {operation:'test-command.context',inputs:{workId:workflow.workItem.id,phaseId}}]});
    if(!Array.isArray(paths)||!paths.length||paths.some(path=>typeof path!=='string'||!path||path.startsWith('/')||path.split('/').includes('..')
      ||path.split('/').some(part=>['.git','.singularity-flow'].includes(part))))fail('Repair needs the exact approved source/test paths.','TEST_RECOVERY_SCOPE_REQUIRED');
    return {schemaVersion:1,profile:'sflow-namespace-test-repair-plan/v1',phaseId,generation:failed.plan.generation,agreement:hash(agreement),
      failed:failed.record,attempt:attempts.length+1,allowedPaths:[...new Set(paths)].sort(),
      preserves:['approval-authority','source-scope','test-command','test-assertions','raw-failures'],rerun:'all-configured'};
  }
  return Object.freeze({context,confirm,current,hash,repairPlan});
}

export function storyTestCommandPolicies(port) {
const recordSha256=value=>textDigestCapability(port).sha256Utf8(canonicalJson(value));
const fail = (message, code = 'TEST_COMMAND_DECISION_INVALID', details = undefined) => {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
};
const REQUEST_ID = /^TCD-[0-9]{3,}$/u;
const OPEN_STEP = new Set(['not_started', 'in_progress', 'awaiting_approval']);

function reasonText(value, minimum, option) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > 1000) fail(`Say why in ${minimum} to 1000 characters with ${option}.`);
  return text;
}


/** One change before and after in words: `package.json scripts.test: before "vitest run", after "vitest run src"`. */
function pinDiffWords(entry) {
  const name = entry.field === 'definition' ? `${entry.path}${entry.selector ? ` ${entry.selector}` : ''}` : entry.field;
  const quoted = (value) => `"${String(value).replaceAll('\n', ' / ')}"`;
  if (entry.field === 'definition' && !entry.known) return `${name} ${entry.change}; the text it was pinned with is not in this Story's history, so compare it with the base commit`;
  if (entry.before == null && entry.after == null) return `${name} ${entry.change}`;
  if (entry.before == null) return `${name}: added ${quoted(entry.after)}`;
  if (entry.after == null) return `${name}: removed ${quoted(entry.before)}`;
  return `${name}: before ${quoted(entry.before)}, after ${quoted(entry.after)}`;
}

/** A request by its ID, and whether a person accepted or revoked it. */
function storyTestCommandState(workflow, id, observed = workflow?.testCommandDecisions ?? []) {
  const request = observed.find((entry) => entry.id === id) ?? null;
  if (!request) return null;
  const accepted = observed.find((entry) => entry.accepts === id) ?? null;
  const revoked = observed.find((entry) => entry.revokes === id) ?? null;
  return { request, accepted, revoked, state: revoked ? 'revoked' : accepted ? 'accepted' : 'requested' };
}

/** Requests of a step that wait for a person who approves it. */
function pendingStoryTestCommands(workflow, phaseId, observed = workflow?.testCommandDecisions ?? []) {
  return observed.filter((entry) => entry.id && entry.phase === phaseId
    && storyTestCommandState(workflow, entry.id, observed).state === 'requested');
}

/** Repeating the same request is not another human decision; prose/actor/time do not change its scope. */
function matchingPendingTestCommand(workflow, { phaseId, command, repin = null }, observed = workflow?.testCommandDecisions ?? []) {
  return pendingStoryTestCommands(workflow, phaseId, observed).find(entry => repin
    ? entry.command.id === command.id && canonicalJson(entry.repin ?? null) === canonicalJson(repin)
    : !entry.repin && canonicalJson(entry.command) === canonicalJson(command)) ?? null;
}

/**
 * The commands a step runs because a person accepted them, each bound to its request. The latest
 * acceptance of a command ID wins; a pending request never displaces an accepted command.
 */
function activeStoryTestCommands(workflow, phaseId, observed = workflow?.testCommandDecisions ?? []) {
  const latest = new Map();
  for (const entry of observed) {
    if (!entry.accepts || entry.phase !== phaseId) continue;
    const { request, state } = storyTestCommandState(workflow, entry.accepts, observed);
    if (state === 'accepted' && !request.repin) latest.set(request.command.id, request);
  }
  return [...latest.values()].map((request) => ({
    ...structuredClone(request.command), storyDecision: { id: request.id, sha256: `sha256:${recordSha256(request)}` }
  }));
}

function refreshStep(workflow, phaseId, observed) {
  const active = activeStoryTestCommands(workflow, phaseId, observed);
  if (active.length) workflow.phases[phaseId].storyTestCommands = active;
  else delete workflow.phases[phaseId].storyTestCommands;
}

/** Every step's accepted commands are exactly its active decisions; anything else was not decided. */
function assertStoryTestCommands(workflow, observed = workflow?.testCommandDecisions ?? []) {
  for (const [phaseId, phase] of Object.entries(workflow?.phases ?? {})) {
    if (canonicalJson(phase.storyTestCommands ?? []) !== canonicalJson(activeStoryTestCommands(workflow, phaseId, observed))) {
      fail(`Step ${phaseId}'s Story-only test commands differ from its recorded decisions.`, 'TEST_COMMAND_DECISION_STATE_INVALID', { phase: phaseId });
    }
  }
}

function openStep(workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase) fail(`This Story has no step ${phaseId}.`);
  if (!OPEN_STEP.has(phase.status)) fail(`Step ${phaseId} is ${phase.status}; a Story-only test command is decided before the step is approved.`, 'TEST_COMMAND_DECISION_CLOSED');
  if (phase.status === 'awaiting_approval') fail('Return this phase for changes before changing its approved test command review.', 'TEST_COMMAND_DECISION_DURING_REVIEW', {phase:phaseId});
  return phase;
}

/** Record a request for `command` (already normalized and checked by the caller). */
function recordStoryTestCommandRequest(workflow, { phaseId, command, repin = null, reason, actor, at }, observed = workflow?.testCommandDecisions ?? []) {
  openStep(workflow, phaseId);
  if (!command?.id || command.kind !== 'test') fail('A Story-only test command is one structured kind: test command.');
  const reasonValue = reasonText(reason, 15, '--reason');
  const existing = matchingPendingTestCommand(workflow, { phaseId, command, repin }, observed);
  if (existing) return existing;
  workflow.testCommandDecisions ??= [];
  const request = {
    id: `TCD-${String(observed.filter((entry) => entry.id).length + 1).padStart(3, '0')}`,
    phase: phaseId, command: structuredClone(command), ...(repin ? { repin: structuredClone(repin) } : {}),
    reason: reasonValue, requestedBy: actor, at
  };
  workflow.testCommandDecisions.push(request);
  return request;
}

/**
 * Record a person's acceptance or revocation of request `id`; the caller checked that they are in
 * one of the step's approval groups. `selfApproval: false` refuses accepting one's own request.
 */
function recordStoryTestCommandDecision(workflow, { id, outcome, reason = '', actor, authorityGroup, identityAssurance = null, at, selfApproval = true }, observed = workflow?.testCommandDecisions ?? []) {
  if (!REQUEST_ID.test(String(id ?? ''))) fail('Name the request as TCD-001.');
  const found = storyTestCommandState(workflow, id, observed);
  if (!found) fail(`This Story has no test command request ${id}.`, 'TEST_COMMAND_DECISION_UNKNOWN');
  openStep(workflow, found.request.phase);
  if (outcome === 'accept') {
    if (found.state !== 'requested') fail(`${id} is already ${found.state}.`, 'TEST_COMMAND_DECISION_CLOSED');
    if (!selfApproval && found.request.requestedBy === actor) {
      fail(`${id} was requested by ${actor}; the step's approval policy needs someone else to accept it.`, 'TEST_COMMAND_SELF_ACCEPTANCE');
    }
  } else if (outcome === 'revoke') {
    if (found.state === 'revoked') fail(`${id} is already revoked.`, 'TEST_COMMAND_DECISION_CLOSED');
  } else fail('A request is accepted or revoked.');
  const record = {
    [outcome === 'accept' ? 'accepts' : 'revokes']: id, phase: found.request.phase,
    reason: outcome === 'revoke' ? reasonText(reason, 15, '--reason') : String(reason ?? '').trim(),
    actor, authorityGroup, identityAssurance, at
  };
  workflow.testCommandDecisions.push(record);
  refreshStep(workflow, found.request.phase, observed.includes(record)?observed:[...observed,record]);
  return record;
}

return Object.freeze({pinDiffWords,storyTestCommandState,pendingStoryTestCommands,matchingPendingTestCommand,activeStoryTestCommands,assertStoryTestCommands,recordStoryTestCommandRequest,recordStoryTestCommandDecision});
}

/** Native-compatible test risk values. The caller supplies admitted attempts, explicit time and authority metadata.
 * These functions never authenticate, retain or turn a failed run into a pass. */
export function testRunRiskRecordPolicies(values){
  const {classifyTestRunCause,testRunCauseCategory,testRunCauseWords}=values??{};
  if([classifyTestRunCause,testRunCauseCategory,testRunCauseWords].some(value=>typeof value!=='function'))throw new SingularityFlowError(
    'Bind the cause value rules before constructing test-risk values.',{code:'ENGINE_INPUT_INVALID'});
  const MAX_TEST_RUN_RISK_DAYS=90,DAY=24*60*60*1000,NOT_RUN_STATUSES=new Set(['failed','blocked']),ARGV_DIGEST=/^[a-f0-9]{64}$/u;


/** How many tests a recorded attempt executed: passed plus failed; skipped ones did not run. */
function testsExecuted(attempt) {
  const tests = attempt?.tests;
  if (!tests || typeof tests !== 'object') return 0;
  return (Number(tests.passed) || 0) + (Number(tests.failed) || 0);
}

/** A run of the command failed or was blocked before any test executed. */
function noTestExecuted(attempt) {
  return Boolean(attempt) && NOT_RUN_STATUSES.has(attempt.status) && testsExecuted(attempt) === 0;
}


/**
 * What stopped a failed or blocked attempt: the cause recorded with it, or, for an attempt recorded
 * before causes were classified, what its shape alone says (a missing launcher, a timeout, every
 * test skipped, tests that failed; anything else is unrecognised).
 */
function testRunCause(attempt) {
  if (attempt?.cause && typeof attempt.cause === 'object' && testRunCauseCategory(attempt.cause.class) === attempt.cause.category) return attempt.cause;
  return classifyTestRunCause({ check: { status: attempt?.status, timedOut: attempt?.timedOut === true,
    infrastructureUnavailable: attempt?.process?.infrastructureUnavailable === true }, tests: attempt?.tests });
}


/** A cause as a person reads it: its words, the changed file it names, its class and marker. */
function testRunCauseText(cause) {
  return `${testRunCauseWords(cause?.class)}${cause?.file ? ` in ${cause.file}` : ''} (${[cause?.class, cause?.signal].filter(Boolean).join(', ')})`;
}


function textBetween(value, minimum, maximum, option, what) {
  const text = String(value ?? '').trim();
  if (text.length < minimum || text.length > maximum) {
    throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, {
      code: 'TEST_RUN_RISK_INVALID'
    });
  }
  return text;
}


/** Why a person may not accept the risk of this attempt, or null when they may: only an environment cause. */
function testRunRiskIneligibility(attempt) {
  if (!attempt) return 'no run of this command is recorded for the step in this checkout yet; publish or submit it first so its failure is recorded, or name the cause class and command digest its refusal gave with --cause-class and --argv-sha256';
  if (attempt.status === 'passed') return 'its latest run passed';
  if (!NOT_RUN_STATUSES.has(attempt.status)) return `its latest run is ${attempt.status}, not a run that failed or was blocked`;
  const cause = testRunCause(attempt);
  if (cause.category === 'environment') return null;
  const executed = testsExecuted(attempt);
  if (cause.category === 'code') {
    return `its latest run stopped on a code cause, ${testRunCauseText(cause)}; ${executed > 0 ? `${executed} test(s) executed, and ` : ''}a code fault is fixed, never accepted`;
  }
  return `nothing in its latest run says the environment stopped it: ${testRunCauseText(cause)}; fix the cause and run it again`;
}


/**
 * Record a decision on the aggregate; the caller found the attempt and checked authority. With no
 * run recorded in this checkout, the command is bound by `commandId`, its `argvSha256` and the
 * `causeClass` its refusal named instead.
 */
function recordTestRunRisk(workflow, { phaseId, attempt, commandId = null, argvSha256 = null, causeClass = null, cause, reason, expires, actor, authorityGroup, identityAssurance = null, at }) {
  const byDigest = !attempt && Boolean(commandId) && ARGV_DIGEST.test(String(argvSha256 ?? ''));
  const ineligible = byDigest ? null : testRunRiskIneligibility(attempt);
  const named = attempt?.commandId ?? commandId ?? 'this test command';
  if (ineligible) {
    throw new SingularityFlowError(`The risk of ${named} cannot be accepted: ${ineligible}.`, {
      code: 'TEST_RUN_RISK_NOT_ELIGIBLE', details: { phase: phaseId, commandId: attempt?.commandId ?? commandId ?? null }
    });
  }
  const observed = byDigest ? null : testRunCause(attempt);
  if (byDigest && testRunCauseCategory(causeClass) !== 'environment') {
    throw new SingularityFlowError('Name the environment cause class the refusal gave with --cause-class, beside --argv-sha256.', { code: 'TEST_RUN_RISK_INVALID' });
  }
  if (observed && causeClass && causeClass !== observed.class) {
    throw new SingularityFlowError(`The risk of ${named} cannot be accepted as ${causeClass}: its latest run stopped on ${testRunCauseText(observed)}.`, {
      code: 'TEST_RUN_RISK_NOT_ELIGIBLE', details: { phase: phaseId, commandId: named }
    });
  }
  const statedCause = textBetween(cause, 10, 300, '--cause', 'what in the environment stops the tests');
  const text = textBetween(reason, 20, 1000, '--reason', 'why the risk is acceptable');
  const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? new Date(`${expires}T23:59:59.999Z`) : null;
  const now = new Date(at);
  if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= now || expiry - now > MAX_TEST_RUN_RISK_DAYS * DAY) {
    throw new SingularityFlowError(`--expires must be a date after today and at most ${MAX_TEST_RUN_RISK_DAYS} days ahead (YYYY-MM-DD).`, {
      code: 'TEST_RUN_RISK_INVALID'
    });
  }
  workflow.testRunRisks ??= [];
  const decision = {
    id: `TRR-${String(workflow.testRunRisks.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
    phase: phaseId, commandId: byDigest ? commandId : attempt.commandId, argvSha256: byDigest ? argvSha256 : attempt.argvSha256,
    causeClass: byDigest ? causeClass : observed.class,
    cause: statedCause, reason: text, expiresAt: expiry.toISOString(),
    // Bound by digest, the decision saw no run here; each run it lets through is checked at use.
    ...(byDigest ? { boundBy: 'command-digest' } : { observation: {
      attemptId: attempt.attemptId, status: attempt.status,
      exitCode: Number.isInteger(attempt.exitCode) ? attempt.exitCode : null, testsExecuted: testsExecuted(attempt)
    } }),
    actor, authorityGroup, identityAssurance, at
  };
  workflow.testRunRisks.push(decision);
  return decision;
}
  return Object.freeze({MAX_TEST_RUN_RISK_DAYS,testsExecuted,noTestExecuted,testRunCause,testRunCauseText,
    testRunRiskText:textBetween,testRunRiskIneligibility,recordTestRunRisk});
}

/** Status over admitted namespace records and explicit time; it does not verify authority or execution. */
export function namespaceTestRiskState(workflow,decision,{at}){
  const rows=workflow.namespaceTestRunRisks??[];
  if(rows.some(row=>row.revokes===decision.id))return 'revoked';
  if(new Date(decision.expiresAt)<=new Date(at))return 'expired';
  const latest=rows.filter(row=>row.id&&row.phase===decision.phase&&row.commandId===decision.commandId
    &&row.argvSha256===decision.argvSha256&&row.causeClass===decision.causeClass).at(-1);
  return latest?.id===decision.id?'active':'superseded';
}
/** A renewal carries an original exact risk binding without rewriting its historical observation. */
export function namespaceTestRiskCoverage(workflow,decision,{at}){
  const rows=workflow.namespaceTestRunRisks??[],latest=rows.filter(row=>row.id&&row.phase===decision.phase&&row.commandId===decision.commandId
    &&row.argvSha256===decision.argvSha256&&row.causeClass===decision.causeClass&&row.commandSha256===decision.commandSha256).at(-1);
  return latest&&namespaceTestRiskState(workflow,latest,{at})==='active'?latest:null;
}
/** One versioned namespace risk ceremony. Native risk collections retain their original shape. */
export function namespaceTestRiskPlan(workflow,request,facts,source,rules){
  const proposed=structuredClone(workflow),rows=proposed.namespaceTestRunRisks??=[],common={actor:facts.actorId,authorityGroup:facts.authorityGroup,at:facts.at};
  let record;
  if(request.revoke){
    const target=rows.find(row=>row.id===request.revoke);
    if(!target)throw new SingularityFlowError('This Story has no such test-run risk. ',{code:'TEST_RUN_RISK_UNKNOWN'});
    if(rows.some(row=>row.revokes===request.revoke))throw new SingularityFlowError('This test-run risk is already revoked.',{code:'TEST_RUN_RISK_REVOKED'});
    record={schemaVersion:1,profile:'sflow-namespace-test-run-risk/v1',revokes:request.revoke,phase:target.phase,commandId:target.commandId,
      reason:rules.testRunRiskText(request.reason,20,1000,'--reason','why the decision is revoked'),...common};
  }else{
    if(rows.some(row=>row.id&&row.phase===request.phaseId&&row.commandId===request.commandId&&row.argvSha256===request.argvSha256
      &&row.causeClass===request.causeClass&&namespaceTestRiskState(proposed,row,{at:facts.at})==='active'))throw new SingularityFlowError(
      'A standing decision already covers this exact command and environment cause. Use it or revoke it before replacing it.',{code:'TEST_RUN_RISK_ALREADY_RECORDED'});
    const value=rules.recordTestRunRisk({testRunRisks:structuredClone(rows)},{...request,attempt:null,...common});
    record={schemaVersion:1,profile:'sflow-namespace-test-run-risk/v1',...value,commandSha256:source.commandSha256};
  }
  proposed.namespaceTestRunRisks=[...rows,record];
  proposed.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:'test_run_risk_decided',phase:request.phaseId,
    detail:(record.id??record.revokes)+(record.revokes?' revoked. ':' accepts only its exact environment cause. ')+record.reason});
  return {workflow:proposed,outcome:{currentPhase:workflow.currentPhase,record}};
}


/** Narrowed-run value rules. Record authentication, source collection and optional native clocks stay in adapters. */
export function testNarrowingPolicies(port){
  const {sha256Utf8}=textDigestCapability(port),recordSha256=value=>sha256Utf8(canonicalJson(value));
  const filterKey = (filter) => `${filter.option}=${filter.value ?? ""}`;
  const focusKey = (entry) => `${entry.path}|${entry.name ?? ""}`;
  function observedNarrowing(facts, tests) {
    const skipped = Number(tests?.skipped) || 0;
    const discovered = Number.isInteger(tests?.discovered) ? tests.discovered : null;
    const baseline = Number.isInteger(facts?.baseline) ? facts.baseline : null;
    const shortfall = baseline != null && discovered != null ? Math.max(0, baseline - discovered) : 0;
    const filters = facts?.filters ?? [];
    const focused = facts?.focused ?? [];
    // Skipped tests the team already had are not this Story's narrowing: only added skip markers, or more
    // skipped than the pin's first passing run, are.
    const skipsAdded = skipped > 0 && ((facts?.addedSkips ?? []).length > 0
      || (Number.isInteger(facts?.baselineSkipped) && skipped > facts.baselineSkipped));
    return {
      reasons: [...(filters.length ? ['filter'] : []), ...(focused.length ? ['focused'] : []), ...(skipsAdded ? ['skipped'] : []),
        ...(shortfall > 0 ? ['below-baseline'] : [])],
      filters, focused, skipped, discovered, baseline, shortfall,
      ...(facts?.standing && (facts.standing.filters.length || facts.standing.focused.length) ? { standing: facts.standing } : {}),
      ...(facts?.addedSkips?.length ? { addedSkips: facts.addedSkips } : {}),
      ...(facts?.paths?.length ? { paths: facts.paths } : {})
    };
  }

  function skippedByAgreement(workflow) {
    return Boolean((workflow?.testRecovery || workflow?.resolution?.testRecovery?.enabled === true)
      && workflow?.resolution?.testRecovery?.enabledRiskCategories?.includes('reduced-coverage'));
  }

  function narrowingReasons(narrowing, { skippedAccepted = false } = {}) {
    return (narrowing?.reasons ?? []).filter((reason) => !(skippedAccepted && reason === 'skipped'));
  }

  function narrowingFingerprint(narrowing) {
    return `sha256:${recordSha256({
      filters: [...new Set((narrowing?.filters ?? []).map(filterKey))].sort(),
      focused: [...new Set((narrowing?.focused ?? []).map(focusKey))].sort(),
      skipped: narrowing?.skipped ?? 0, shortfall: narrowing?.shortfall ?? 0
    })}`;
  }

  function narrowingCovers(accepted, observed, { skippedAccepted = false } = {}) {
    const filters = new Set((accepted?.filters ?? []).map(filterKey));
    const focused = new Set((accepted?.focused ?? []).map(focusKey));
    return (observed?.filters ?? []).every((entry) => filters.has(filterKey(entry)))
      && (observed?.focused ?? []).every((entry) => focused.has(focusKey(entry)))
      && (skippedAccepted || (observed?.skipped ?? 0) <= (accepted?.skipped ?? 0))
      && (observed?.shortfall ?? 0) <= (accepted?.shortfall ?? 0);
  }

  function testNarrowingIneligibility(attempt) {
    if (!attempt) return 'no run of this command is recorded for the step in this checkout yet; publish or submit it first so its narrowed run is recorded';
    if (attempt.status !== 'passed') return `its latest run is ${attempt.status}; only a narrowed run that passed is accepted, a failing one is fixed`;
    if (!attempt.pin?.sha256) return 'its latest run was recorded without a command pin; run it again';
    if (!narrowingReasons(attempt.narrowing).length) return 'its latest run was not narrowed';
    return null;
  }

  function textBetween(value, minimum, maximum, option, what) {
    const text = String(value ?? '').trim();
    if (text.length < minimum || text.length > maximum) {
      throw new SingularityFlowError(`Say ${what} in ${minimum} to ${maximum} characters with ${option}.`, { code: 'TEST_NARROWING_INVALID' });
    }
    return text;
  }

  function recordTestNarrowing(workflow, { phaseId, attempt, reason, expires = null, actor, authorityGroup, identityAssurance = null, at }) {
    const ineligible = testNarrowingIneligibility(attempt);
    if (ineligible) {
      throw new SingularityFlowError(`The narrowing of ${attempt?.commandId ?? 'this test command'} cannot be accepted: ${ineligible}.`, {
        code: 'TEST_NARROWING_NOT_ELIGIBLE', details: { phase: phaseId, commandId: attempt?.commandId ?? null }
      });
    }
    const text = textBetween(reason, 20, 1000, '--reason', 'why the narrowed run is enough for this step');
    let expiresAt = null;
    if (expires != null) {
      const expiry = /^\d{4}-\d{2}-\d{2}$/u.test(String(expires)) ? new Date(`${expires}T23:59:59.999Z`) : null;
      if (!expiry || Number.isNaN(expiry.getTime()) || expiry <= new Date(at)) {
        throw new SingularityFlowError('--expires must be a date from today on (YYYY-MM-DD); without it the acceptance lasts until the Story ends.', { code: 'TEST_NARROWING_INVALID' });
      }
      expiresAt = expiry.toISOString();
    }
    const { reasons, filters, focused, skipped, discovered, baseline, shortfall } = attempt.narrowing;
    workflow.testNarrowings ??= [];
    const decision = {
      id: `TNR-${String(workflow.testNarrowings.filter((entry) => !entry.revokes).length + 1).padStart(3, '0')}`,
      phase: phaseId, commandId: attempt.commandId, pinSha256: attempt.pin.sha256,
      narrowing: { reasons, filters, focused, skipped, discovered, baseline, shortfall }, fingerprint: narrowingFingerprint(attempt.narrowing),
      observation: { attemptId: attempt.attemptId }, reason: text, expiresAt, actor, authorityGroup, identityAssurance, at
    };
    workflow.testNarrowings.push(decision);
    return decision;
  }

  function recordTestNarrowingRevocation(workflow, { narrowingId, reason, actor, authorityGroup, identityAssurance = null, at }, {records,revocations=records}={}) {
    if(!Array.isArray(records)||!Array.isArray(revocations))throw new SingularityFlowError("Revocation values need explicit admitted record observations.",{code:"ENGINE_INPUT_INVALID"});
    const target = records.find((entry) => !entry.revokes && entry.id === narrowingId);
    if (!target) throw new SingularityFlowError(`This Story has no test-narrowing decision ${narrowingId}.`, { code: 'TEST_NARROWING_UNKNOWN' });
    if (revocations.some((entry) => entry.revokes === narrowingId)) {
      throw new SingularityFlowError(`${narrowingId} is already revoked.`, { code: 'TEST_NARROWING_REVOKED' });
    }
    const revocation = { revokes: narrowingId, phase: target.phase, commandId: target.commandId,
      reason: textBetween(reason, 20, 1000, '--reason', 'why the acceptance is revoked'), actor, authorityGroup, identityAssurance, at };
    workflow.testNarrowings.push(revocation);
    return revocation;
  }

  function testNarrowingState(records, decision, { at } = {}) {
    if(at===undefined||!Array.isArray(records))throw new SingularityFlowError("Narrowing state needs admitted records and explicit observation time.",{code:"ENGINE_INPUT_INVALID"});
    if (records.some((entry) => entry.revokes === decision.id)) return 'revoked';
    if (decision.expiresAt && new Date(decision.expiresAt) <= new Date(at)) return 'expired';
    return 'active';
  }

  function testNarrowingBinding(decision) {
    return { id: decision.id, sha256: `sha256:${recordSha256(decision)}` };
  }
  return Object.freeze({observedNarrowing,skippedByAgreement,narrowingReasons,narrowingFingerprint,narrowingCovers,testNarrowingIneligibility,recordTestNarrowing,recordTestNarrowingRevocation,testNarrowingState,testNarrowingBinding});
}
