/** GDP-M5 deterministic mode recommendation and bounded Outcome contract kernel. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MODES = new Set(['workflow', 'outcome']);
const STRATEGIES = new Set(['recommend', 'fixed', 'human-choice']);
const PROFILES = new Set(['standard', 'high-assurance', 'regulated', 'custom-registered']);
const PACES = new Set(['manual', 'assisted', 'auto']);
const AUTONOMY = new Set(['A0', 'A1', 'A2', 'A3']);
const RISK = new Set(['low', 'medium', 'high', 'critical', 'unknown']);
const RECOMMENDATIONS = new Set([
  'outcome-recommended', 'workflow-recommended', 'workflow-required',
  'human-choice-required', 'insufficient-evidence'
]);
const MAX_ITEMS = 256;
const MAX_BYTES = 64 * 1024;

export const M5_RECORD_FAMILIES = Object.freeze({
  'delivery-recommendation': ['recommendationSha256', [
    'schemaVersion', 'kind', 'workId', 'requestSha256', 'repositoryRevisionSha256',
    'configurationSha256', 'selectionStrategy', 'outcome', 'requiredMode', 'reasons',
    'assumptions', 'allowedModes', 'defaultWorkflowProfile', 'recommendationSha256'
  ]],
  'delivery-selection': ['selectionSha256', [
    'schemaVersion', 'kind', 'workId', 'selectionStrategy', 'deliveryMode',
    'workflowProfile', 'executionProvider', 'executionPace', 'autonomyCeiling',
    'proofProfile', 'proofPolicySha256', 'policySnapshotSha256', 'selectedBy',
    'selectionReason', 'recommendationSha256', 'selectionSha256'
  ]],
  'completion-contract': ['contractSha256', [
    'schemaVersion', 'kind', 'contractId', 'subject', 'outcome', 'acceptanceClauses',
    'nonGoals', 'humanDecisions', 'effectPolicySha256', 'proofProfile',
    'proofPolicySha256', 'gapAcceptancePolicySha256', 'riskAssessmentSha256',
    'promotionPolicySha256', 'contractSha256'
  ]],
  'effect-policy': ['effectPolicySha256', [
    'schemaVersion', 'kind', 'workId', 'allowedEffects', 'forbiddenEffects',
    'externalEffects', 'protectedPaths', 'credentialUse', 'effectPolicySha256'
  ]],
  'effect-policy-compilation': ['compilationSha256', [
    'schemaVersion', 'kind', 'effectPolicySha256', 'repositoryRevisionSha256',
    'allowedPathPrefixes', 'forbiddenPathPrefixes', 'externalEffectsAllowed',
    'credentialsAllowed', 'compilationSha256'
  ]],
  'change-risk-assessment': ['riskAssessmentSha256', [
    'schemaVersion', 'kind', 'workId', 'riskClass', 'repositoryCount',
    'predictedResourceCount', 'triggers', 'basisSha256', 'riskAssessmentSha256'
  ]],
  'autonomy-decision': ['autonomyDecisionSha256', [
    'schemaVersion', 'kind', 'workId', 'requestedCeiling', 'effectiveCeiling',
    'executionPace', 'decisionBasis', 'selectedBy', 'autonomyDecisionSha256'
  ]]
});

function fail(message, code = 'GDM_MODE_REQUIRED', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function keys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  if (canonicalJson(actual) !== canonicalJson([...expected].sort())) fail(`${label} has an invalid field set.`);
}

function digest(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}

function id(value, label) {
  const result = String(value ?? '');
  if (!ID.test(result)) fail(`${label} is invalid.`);
  return result;
}

function text(value, label, maximum = 1024) {
  const result = String(value ?? '').trim();
  if (!result || Buffer.byteLength(result, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(`${label} must be non-empty bounded text.`);
  }
  return result;
}

function integer(value, label, minimum = 0, maximum = 10_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is out of range.`);
  return value;
}

function list(values, normalize, label, maximum = MAX_ITEMS) {
  if (!Array.isArray(values) || values.length > maximum) fail(`${label} exceeds ${maximum} entries.`);
  const normalized = values.map((value, index) => normalize(value, `${label}[${index}]`));
  const unique = new Map(normalized.map((value) => [canonicalJson(value), value]));
  if (unique.size !== normalized.length) fail(`${label} contains duplicates.`);
  return [...unique.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function strings(values, label, maximum = MAX_ITEMS) {
  return list(values, (value, at) => text(value, at, 512), label, maximum);
}

function record(family, fields) {
  const descriptor = M5_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown delivery family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  const core = { schemaVersion: currentSchemaVersion(family), kind: family, ...fields };
  const result = { ...core, [descriptor[0]]: `sha256:${recordSha256(core)}` };
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > MAX_BYTES) fail(`${family} exceeds ${MAX_BYTES} bytes.`);
  return Object.freeze(result);
}

function actor(value, label = 'selectedBy') {
  keys(value, ['kind', 'identity', 'authoritySha256'], label);
  if (!['human', 'policy'].includes(value.kind)) fail(`${label}.kind is invalid.`);
  const result = {
    kind: value.kind,
    identity: value.identity == null ? null : text(value.identity, `${label}.identity`, 320),
    authoritySha256: digest(value.authoritySha256, `${label}.authoritySha256`, true)
  };
  if (result.kind === 'human' && !result.identity) fail('Human selection requires an identity.');
  if (result.kind === 'policy' && !result.authoritySha256) fail('Policy selection requires an authority digest.');
  return result;
}

function clause(value, label) {
  keys(value, ['clauseId', 'bodySha256', 'required', 'witnessPolicy'], label);
  if (typeof value.required !== 'boolean') fail(`${label}.required must be boolean.`);
  return {
    clauseId: id(value.clauseId, `${label}.clauseId`),
    bodySha256: digest(value.bodySha256, `${label}.bodySha256`),
    required: value.required,
    witnessPolicy: id(value.witnessPolicy, `${label}.witnessPolicy`)
  };
}

export function normalizeDeliveryRequest(value) {
  keys(value, [
    'schemaVersion', 'kind', 'workId', 'outcome', 'acceptanceClauses', 'nonGoals',
    'predicted', 'riskClass', 'executionProvider', 'executionPace', 'autonomyCeiling',
    'proofProfile', 'workflowProfile', 'allowedEffects', 'forbiddenEffects'
  ], 'delivery request');
  if (value.schemaVersion !== 1 || value.kind !== 'delivery-request') fail('Delivery request schema is not current.');
  keys(value.outcome, ['statement', 'observablePredicate'], 'outcome');
  keys(value.predicted, [
    'repositories', 'touchedResources', 'protectedPaths', 'externalEffects',
    'credentialUse', 'architectureDecision', 'publicContractChange', 'databaseMigration'
  ], 'predicted');
  const predicted = {
    repositories: integer(value.predicted.repositories, 'predicted.repositories', 0, 100),
    touchedResources: integer(value.predicted.touchedResources, 'predicted.touchedResources', 0, 10_000),
    protectedPaths: value.predicted.protectedPaths === true,
    externalEffects: value.predicted.externalEffects === true,
    credentialUse: value.predicted.credentialUse === true,
    architectureDecision: value.predicted.architectureDecision === true,
    publicContractChange: value.predicted.publicContractChange === true,
    databaseMigration: value.predicted.databaseMigration === true
  };
  if (Object.entries(value.predicted).some(([key, item]) => key !== 'repositories'
      && key !== 'touchedResources' && typeof item !== 'boolean')) fail('Predicted flags must be boolean.');
  if (!RISK.has(value.riskClass)) fail('riskClass is invalid.');
  if (!PACES.has(value.executionPace)) fail('executionPace is invalid.');
  if (!AUTONOMY.has(value.autonomyCeiling)) fail('autonomyCeiling is invalid.');
  if (!PROFILES.has(value.proofProfile)) fail('proofProfile is invalid.');
  return Object.freeze({
    schemaVersion: 1, kind: 'delivery-request', workId: id(value.workId, 'workId'),
    outcome: {
      statement: text(value.outcome.statement, 'outcome.statement', 2048),
      observablePredicate: text(value.outcome.observablePredicate, 'outcome.observablePredicate', 2048)
    },
    acceptanceClauses: list(value.acceptanceClauses, clause, 'acceptanceClauses', 128),
    nonGoals: strings(value.nonGoals, 'nonGoals', 128), predicted,
    riskClass: value.riskClass,
    executionProvider: id(value.executionProvider, 'executionProvider'),
    executionPace: value.executionPace, autonomyCeiling: value.autonomyCeiling,
    proofProfile: value.proofProfile,
    workflowProfile: id(value.workflowProfile, 'workflowProfile'),
    allowedEffects: strings(value.allowedEffects, 'allowedEffects'),
    forbiddenEffects: strings(value.forbiddenEffects, 'forbiddenEffects')
  });
}

function recommendationReasons(request) {
  const reasons = [];
  if (request.predicted.repositories > 1) reasons.push('MULTIPLE_REPOSITORIES');
  if (request.predicted.protectedPaths) reasons.push('PROTECTED_PATHS');
  if (request.predicted.externalEffects) reasons.push('EXTERNAL_EFFECTS');
  if (request.predicted.credentialUse) reasons.push('CREDENTIAL_USE');
  if (request.predicted.architectureDecision) reasons.push('ARCHITECTURE_DECISION');
  if (request.predicted.publicContractChange) reasons.push('PUBLIC_CONTRACT_CHANGE');
  if (request.predicted.databaseMigration) reasons.push('DATABASE_MIGRATION');
  if (['high', 'critical'].includes(request.riskClass)) reasons.push('RISK_ABOVE_OUTCOME_CEILING');
  if (request.predicted.touchedResources > 40) reasons.push('RESOURCE_CEILING_EXCEEDED');
  if (!request.acceptanceClauses.length) reasons.push('ACCEPTANCE_CLAUSES_UNAVAILABLE');
  return reasons.sort();
}

export function recommendDelivery({
  request, repositoryRevisionSha256, configurationSha256,
  selectionStrategy = 'recommend', allowedModes = ['outcome', 'workflow'],
  defaultWorkflowProfile = 'feature'
} = {}) {
  const normalized = normalizeDeliveryRequest(request);
  if (!STRATEGIES.has(selectionStrategy)) fail('selectionStrategy is invalid.');
  const modes = list(allowedModes, (value) => {
    if (!MODES.has(value)) fail(`Unsupported delivery mode '${value}'.`, 'GDM_MODE_NOT_ALLOWED');
    return value;
  }, 'allowedModes', 2);
  if (!modes.length) fail('At least one delivery mode must be allowed.', 'GDM_MODE_NOT_ALLOWED');
  const reasons = recommendationReasons(normalized);
  const hard = reasons.filter((value) => !['ACCEPTANCE_CLAUSES_UNAVAILABLE'].includes(value));
  let outcome;
  let requiredMode = null;
  if (hard.length || !modes.includes('outcome')) {
    outcome = 'workflow-required'; requiredMode = 'workflow';
  } else if (reasons.includes('ACCEPTANCE_CLAUSES_UNAVAILABLE')) outcome = 'human-choice-required';
  else outcome = 'outcome-recommended';
  if (!RECOMMENDATIONS.has(outcome)) fail('Recommendation outcome is invalid.');
  const requestSha256 = `sha256:${recordSha256(normalized)}`;
  return record('delivery-recommendation', {
    workId: normalized.workId, requestSha256,
    repositoryRevisionSha256: digest(repositoryRevisionSha256, 'repositoryRevisionSha256'),
    configurationSha256: digest(configurationSha256, 'configurationSha256'),
    selectionStrategy, outcome, requiredMode,
    reasons, assumptions: [
      'ONE_REPOSITORY_BOUND', 'NO_PROTECTED_BASE_WRITE', 'ASSISTED_MANUAL_PUBLICATION'
    ],
    allowedModes: modes, defaultWorkflowProfile: id(defaultWorkflowProfile, 'defaultWorkflowProfile')
  });
}

export function buildEffectPolicy({ workId, request } = {}) {
  const normalized = normalizeDeliveryRequest(request);
  if (normalized.workId !== workId) fail('Effect Policy Work ID differs from the request.');
  return record('effect-policy', {
    workId: normalized.workId,
    allowedEffects: normalized.allowedEffects,
    forbiddenEffects: normalized.forbiddenEffects,
    externalEffects: 'forbidden', protectedPaths: 'promote', credentialUse: 'forbidden'
  });
}

export function compileEffectPolicy({ effectPolicy, repositoryRevisionSha256 } = {}) {
  validateDeliveryRecord('effect-policy', effectPolicy);
  return record('effect-policy-compilation', {
    effectPolicySha256: effectPolicy.effectPolicySha256,
    repositoryRevisionSha256: digest(repositoryRevisionSha256, 'repositoryRevisionSha256'),
    allowedPathPrefixes: [], forbiddenPathPrefixes: [],
    externalEffectsAllowed: false, credentialsAllowed: false
  });
}

export function buildRiskAssessment({ workId, request } = {}) {
  const normalized = normalizeDeliveryRequest(request);
  if (normalized.workId !== workId) fail('Risk Work ID differs from the request.');
  const triggers = recommendationReasons(normalized);
  return record('change-risk-assessment', {
    workId, riskClass: normalized.riskClass,
    repositoryCount: normalized.predicted.repositories,
    predictedResourceCount: normalized.predicted.touchedResources,
    triggers, basisSha256: `sha256:${recordSha256(normalized.predicted)}`
  });
}

export function buildAutonomyDecision({ workId, request, selectedBy } = {}) {
  const normalized = normalizeDeliveryRequest(request);
  if (normalized.workId !== workId) fail('Autonomy Work ID differs from the request.');
  const effective = ['A0', 'A1', 'A2', 'A3'].indexOf(normalized.autonomyCeiling) > 3
    ? 'A3' : normalized.autonomyCeiling;
  return record('autonomy-decision', {
    workId, requestedCeiling: normalized.autonomyCeiling, effectiveCeiling: effective,
    executionPace: normalized.executionPace,
    decisionBasis: 'human-confirmed-delivery-plan', selectedBy: actor(selectedBy)
  });
}

export function buildDeliverySelection({
  request, recommendation, mode, proofPolicySha256, policySnapshotSha256, selectedBy,
  selectionReason = 'human-confirmed-recommendation'
} = {}) {
  const normalized = normalizeDeliveryRequest(request);
  validateDeliveryRecord('delivery-recommendation', recommendation);
  if (!MODES.has(mode)) fail(`Unsupported delivery mode '${mode}'.`, 'GDM_MODE_NOT_ALLOWED');
  if (!recommendation.allowedModes.includes(mode)) fail(`Delivery mode '${mode}' is not allowed.`, 'GDM_MODE_NOT_ALLOWED');
  if (recommendation.requiredMode && recommendation.requiredMode !== mode) {
    fail(`Recommendation policy requires '${recommendation.requiredMode}' mode.`, 'GDM_MODE_NOT_ALLOWED');
  }
  if (recommendation.workId !== normalized.workId
      || recommendation.requestSha256 !== `sha256:${recordSha256(normalized)}`) {
    fail('Recommendation does not bind this request.', 'GDM_SELECTION_PLAN_STALE');
  }
  return record('delivery-selection', {
    workId: normalized.workId, selectionStrategy: recommendation.selectionStrategy,
    deliveryMode: mode, workflowProfile: mode === 'workflow' ? normalized.workflowProfile : null,
    executionProvider: normalized.executionProvider, executionPace: normalized.executionPace,
    autonomyCeiling: normalized.autonomyCeiling, proofProfile: normalized.proofProfile,
    proofPolicySha256: digest(proofPolicySha256, 'proofPolicySha256'),
    policySnapshotSha256: digest(policySnapshotSha256, 'policySnapshotSha256'),
    selectedBy: actor(selectedBy), selectionReason: id(selectionReason, 'selectionReason'),
    recommendationSha256: recommendation.recommendationSha256
  });
}

export function buildCompletionContract({
  request, effectPolicySha256, proofPolicySha256, gapAcceptancePolicySha256,
  riskAssessmentSha256, promotionPolicySha256
} = {}) {
  const normalized = normalizeDeliveryRequest(request);
  return record('completion-contract', {
    contractId: `CC-${normalized.workId}`,
    subject: { kind: 'outcome', id: normalized.workId }, outcome: normalized.outcome,
    acceptanceClauses: normalized.acceptanceClauses, nonGoals: normalized.nonGoals,
    humanDecisions: [], effectPolicySha256: digest(effectPolicySha256, 'effectPolicySha256'),
    proofProfile: normalized.proofProfile,
    proofPolicySha256: digest(proofPolicySha256, 'proofPolicySha256'),
    gapAcceptancePolicySha256: digest(gapAcceptancePolicySha256, 'gapAcceptancePolicySha256'),
    riskAssessmentSha256: digest(riskAssessmentSha256, 'riskAssessmentSha256'),
    promotionPolicySha256: digest(promotionPolicySha256, 'promotionPolicySha256')
  });
}

export function buildOutcomeSelectionBundle({
  request, recommendation, mode = 'outcome', proofPolicySha256, policySnapshotSha256,
  gapAcceptancePolicySha256, promotionPolicySha256, selectedBy
} = {}) {
  const effectPolicy = buildEffectPolicy({ workId: request.workId, request });
  const effectPolicyCompilation = compileEffectPolicy({
    effectPolicy, repositoryRevisionSha256: recommendation.repositoryRevisionSha256
  });
  const riskAssessment = buildRiskAssessment({ workId: request.workId, request });
  const selection = buildDeliverySelection({
    request, recommendation, mode, proofPolicySha256, policySnapshotSha256, selectedBy
  });
  const autonomyDecision = buildAutonomyDecision({ workId: request.workId, request, selectedBy });
  const completionContract = buildCompletionContract({
    request, effectPolicySha256: effectPolicy.effectPolicySha256, proofPolicySha256,
    gapAcceptancePolicySha256, riskAssessmentSha256: riskAssessment.riskAssessmentSha256,
    promotionPolicySha256
  });
  const core = {
    schemaVersion: 1, kind: 'gdm-outcome-selection-bundle', workId: request.workId,
    recommendation, selection, completionContract, effectPolicy, effectPolicyCompilation,
    riskAssessment, autonomyDecision,
    runtime: { execution: 'adhoc-v1', publication: 'existing-publication-uow', maximumRisk: 'medium' }
  };
  return Object.freeze({ ...core, bundleSha256: `sha256:${recordSha256(core)}` });
}

export function validateOutcomeSelectionBundle(value) {
  keys(value, [
    'schemaVersion', 'kind', 'workId', 'recommendation', 'selection', 'completionContract',
    'effectPolicy', 'effectPolicyCompilation', 'riskAssessment', 'autonomyDecision',
    'runtime', 'bundleSha256'
  ], 'Outcome selection bundle');
  if (value.schemaVersion !== 1 || value.kind !== 'gdm-outcome-selection-bundle') {
    fail('Outcome selection bundle is not current.', 'PFC_SCHEMA_UNAVAILABLE');
  }
  for (const [family, member] of [
    ['delivery-recommendation', value.recommendation], ['delivery-selection', value.selection],
    ['completion-contract', value.completionContract], ['effect-policy', value.effectPolicy],
    ['effect-policy-compilation', value.effectPolicyCompilation],
    ['change-risk-assessment', value.riskAssessment], ['autonomy-decision', value.autonomyDecision]
  ]) validateDeliveryRecord(family, member);
  if ([value.recommendation.workId, value.selection.workId,
    value.completionContract.subject.id, value.effectPolicy.workId,
    value.riskAssessment.workId, value.autonomyDecision.workId]
    .some((workId) => workId !== value.workId)) {
    fail('Outcome selection bundle contains different Work IDs.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  if (value.selection.deliveryMode !== 'outcome'
      || value.selection.recommendationSha256 !== value.recommendation.recommendationSha256
      || value.completionContract.effectPolicySha256 !== value.effectPolicy.effectPolicySha256
      || value.completionContract.riskAssessmentSha256 !== value.riskAssessment.riskAssessmentSha256
      || value.completionContract.proofPolicySha256 !== value.selection.proofPolicySha256
      || value.effectPolicyCompilation.effectPolicySha256 !== value.effectPolicy.effectPolicySha256
      || value.effectPolicyCompilation.repositoryRevisionSha256
        !== value.recommendation.repositoryRevisionSha256) {
    fail('Outcome selection bundle references are inconsistent.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  keys(value.runtime, ['execution', 'publication', 'maximumRisk'], 'runtime');
  if (value.runtime.execution !== 'adhoc-v1'
      || value.runtime.publication !== 'existing-publication-uow'
      || value.runtime.maximumRisk !== 'medium') fail('Outcome runtime binding is invalid.');
  const core = structuredClone(value); delete core.bundleSha256;
  if (digest(value.bundleSha256, 'bundleSha256') !== `sha256:${recordSha256(core)}`) {
    fail('Outcome selection bundle self hash is invalid.', 'PFC_PROOF_SUBJECT_INVALID');
  }
  return Object.freeze(structuredClone(value));
}

export function validateDeliveryRecord(family, value) {
  const descriptor = M5_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown delivery family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  keys(value, descriptor[1], family);
  const readable = readRecord(family, value);
  if (readable.migratedThrough.length || value.kind !== family) fail(`${family} is not current.`, 'PFC_SCHEMA_UNAVAILABLE');
  const supplied = digest(value[descriptor[0]], `${family}.${descriptor[0]}`);
  const core = structuredClone(value); delete core[descriptor[0]];
  if (supplied !== `sha256:${recordSha256(core)}`) fail(`${family} self hash is invalid.`, 'PFC_PROOF_SUBJECT_INVALID');
  return Object.freeze(structuredClone(value));
}

export function validateRecommendationPlan(value) {
  const plan = value?.data?.plan ?? value?.plan ?? value;
  return validateDeliveryRecord('delivery-recommendation', plan);
}
