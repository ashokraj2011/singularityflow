import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar } from '../private-sidecar.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { canonicalJson, deepFreeze, sealRecord, sha256 } from './canonicalize.mjs';
import {
  VIEW_ID_PATTERN, assertExactKeys, assertInteger, assertPlainRecord, assertSchemaKind,
  assertSelfHash, assertSha256, assertString, assertStringArray
} from './contracts.mjs';
import { validateWorldModelRefusal } from './refusal.mjs';

export const WORLD_MODEL_VIEW_RETRY_RECEIPT_FAMILY = 'world-model-view-retry-receipt';
export const WORLD_MODEL_VIEW_RETRY_MAXIMUM_ATTEMPTS = 3;

const MAXIMUM_RETRY_RECEIPT_BYTES = 4 * 1024 * 1024;
const CACHE_KEY_FIELDS = Object.freeze([
  'sourceManifestSha256',
  'scopeManifestSha256',
  'viewId',
  'viewVersion',
  'viewSpecSha256',
  'viewFactLedgerSha256',
  'consumerProfileSha256',
  'composerCoreSha256',
  'compositionCandidateSchemaSha256',
  'validatorSha256',
  'outputBudgetSha256',
  'executionProfileSha256'
]);

// This is deliberately an installed closed vocabulary. Callers can neither add failure classes
// nor raise the attempt ceiling at runtime. Source/scope/Fact/Contract errors are absent because
// they require a new governed build, not repetition of the same execution.
const RETRYABLE_FAILURE_CODES = Object.freeze([
  'WMB_CACHE_CANDIDATE_INVALID',
  'WMB_CACHE_ENTRY_CORRUPT',
  'WMB_CACHE_PRESERVATION_UNAVAILABLE',
  'WMB_CACHE_RECEIPT_INVALID',
  'WMB_CACHE_RECEIPT_MISMATCH',
  'WMB_CACHE_REPLACE_STALE',
  'WMB_CACHE_REVALIDATION_FAILED',
  'WMB_CACHE_VIEW_ENCODING_INVALID',
  'WMB_CACHE_VIEW_SIZE_INVALID',
  'WMB_CACHE_WRITE_INVALID',
  'WMB_CACHE_WRITE_RACE_INVALID',
  'WMB_CONTRADICTION_SUPPRESSED',
  'WMB_CROSS_VIEW_REFERENCE_FORBIDDEN',
  'WMB_DERIVATION_INVALID',
  'WMB_EVIDENCE_REFERENCE_UNKNOWN',
  'WMB_EXECUTION_UNIT_UNAVAILABLE',
  'WMB_FACT_ASSURANCE_UPGRADED',
  'WMB_FACT_REFERENCE_UNKNOWN',
  'WMB_FACT_STATUS_UPGRADED',
  'WMB_KERNEL_METADATA_FORBIDDEN',
  'WMB_MODEL_OUTPUT_INVALID',
  'WMB_OUTPUT_BUDGET_EXCEEDED',
  'WMB_REQUIRED_FACT_MISSING',
  'WMB_REQUIRED_UNAVAILABLE_FACT_MISSING',
  'WMB_SCOPE_VIOLATION',
  'WMB_SECTION_MISSING',
  'WMB_SECTION_ORDER_INVALID',
  'WMB_SECTION_UNREGISTERED',
  'WMB_SOURCE_BODY_FORBIDDEN',
  'WMB_TLDR_BUDGET_EXCEEDED',
  'WMB_VIEW_SPEC_MISMATCH',
  'WMB_VIEW_VALIDATION_FAILED'
].sort());

export const WMB_V4_FAILED_VIEW_RETRY_POLICY = deepFreeze(sealRecord({
  schemaVersion: 1,
  kind: 'world-model-view-retry-policy',
  mode: 'failed-view-only',
  maximumAttempts: WORLD_MODEL_VIEW_RETRY_MAXIMUM_ATTEMPTS,
  retryableFailureCodes: RETRYABLE_FAILURE_CODES
}, 'policySha256'));

function retryFailure(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function assertNullableSha256(value, label) {
  if (value !== null) assertSha256(value, label);
}

function assertNullableString(value, label) {
  if (value !== null) assertString(value, label);
}

export function validateWorldModelViewRetryPolicy(value) {
  assertPlainRecord(value, 'World-model failed-view retry policy');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'mode', 'maximumAttempts', 'retryableFailureCodes',
      'policySha256'
    ],
    label: 'World-model failed-view retry policy'
  });
  assertSchemaKind(value, 'world-model-view-retry-policy', 'World-model failed-view retry policy');
  if (value.mode !== 'failed-view-only') {
    retryFailure('World-model retry policy must select only one failed view.',
      'WMB_RETRY_POLICY_INVALID');
  }
  assertInteger(value.maximumAttempts, 'World-model retry maximumAttempts', {
    minimum: 2, maximum: WORLD_MODEL_VIEW_RETRY_MAXIMUM_ATTEMPTS
  });
  assertStringArray(value.retryableFailureCodes,
    'World-model retryable failure codes', { sorted: true });
  if (value.retryableFailureCodes.some((code) => !/^WMB_[A-Z0-9_]+$/.test(code))) {
    retryFailure('World-model retry policy contains an invalid failure code.',
      'WMB_RETRY_POLICY_INVALID');
  }
  assertSelfHash(value, 'policySha256', 'World-model failed-view retry policy');
  if (canonicalJson(value) !== canonicalJson(WMB_V4_FAILED_VIEW_RETRY_POLICY)) {
    retryFailure('World-model retry policy is not the installed closed policy.',
      'WMB_RETRY_POLICY_INVALID');
  }
  return value;
}

function validateCacheKey(value) {
  assertPlainRecord(value, 'World-model retry cache identity');
  assertExactKeys(value, {
    required: CACHE_KEY_FIELDS,
    label: 'World-model retry cache identity'
  });
  for (const field of CACHE_KEY_FIELDS.filter((field) => ![
    'viewId', 'viewVersion', 'executionProfileSha256'
  ].includes(field))) {
    assertSha256(value[field], `World-model retry cache identity ${field}`);
  }
  assertString(value.viewId, 'World-model retry cache identity viewId', {
    pattern: VIEW_ID_PATTERN
  });
  assertInteger(value.viewVersion, 'World-model retry cache identity viewVersion', { minimum: 1 });
  assertNullableSha256(value.executionProfileSha256,
    'World-model retry cache identity executionProfileSha256');
  return value;
}

/** Seal every immutable semantic input needed to re-run exactly one view. */
export function createWorldModelViewRetryBinding({
  requestSha256,
  sourceManifestSha256,
  scopeManifestSha256,
  viewContract,
  viewFactLedger,
  contextManifestSha256,
  cacheKey,
  route,
  provider = null,
  model = null,
  providerConfig = null,
  executionProfileSha256,
  executionUnitManifestSha256,
  timeoutMs = 10 * 60 * 1000
} = {}) {
  const normalizedProvider = route === 'model' ? provider : null;
  const normalizedModel = route === 'model' ? model : null;
  const providerConfigSha256 = route === 'model' ? sha256(providerConfig ?? null) : null;
  const executionConfigurationSha256 = sha256({
    route,
    provider: normalizedProvider,
    requestedModel: normalizedModel,
    providerConfigSha256,
    timeoutMs
  });
  return validateWorldModelViewRetryBinding(deepFreeze(sealRecord({
    schemaVersion: 1,
    kind: 'world-model-view-retry-binding',
    requestSha256,
    sourceManifestSha256,
    scopeManifestSha256,
    viewId: viewContract?.id,
    viewVersion: viewContract?.version,
    viewContractSha256: viewContract?.contractSha256,
    viewFactLedgerSha256: viewFactLedger?.ledgerSha256,
    contextManifestSha256,
    cacheKey: structuredClone(cacheKey),
    execution: {
      route,
      provider: normalizedProvider,
      requestedModel: normalizedModel,
      providerConfigSha256,
      timeoutMs,
      executionConfigurationSha256,
      executionProfileSha256,
      executionUnitManifestSha256
    }
  }, 'bindingSha256')));
}

export function validateWorldModelViewRetryBinding(value) {
  assertPlainRecord(value, 'World-model failed-view retry binding');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'requestSha256', 'sourceManifestSha256',
      'scopeManifestSha256', 'viewId', 'viewVersion', 'viewContractSha256',
      'viewFactLedgerSha256', 'contextManifestSha256', 'cacheKey', 'execution',
      'bindingSha256'
    ],
    label: 'World-model failed-view retry binding'
  });
  assertSchemaKind(value, 'world-model-view-retry-binding',
    'World-model failed-view retry binding');
  for (const field of [
    'requestSha256', 'sourceManifestSha256', 'scopeManifestSha256',
    'viewContractSha256', 'viewFactLedgerSha256', 'contextManifestSha256'
  ]) assertSha256(value[field], `World-model retry binding ${field}`);
  assertString(value.viewId, 'World-model retry binding viewId', { pattern: VIEW_ID_PATTERN });
  assertInteger(value.viewVersion, 'World-model retry binding viewVersion', { minimum: 1 });
  validateCacheKey(value.cacheKey);
  assertPlainRecord(value.execution, 'World-model retry execution identity');
  assertExactKeys(value.execution, {
    required: [
      'route', 'provider', 'requestedModel', 'providerConfigSha256', 'timeoutMs',
      'executionConfigurationSha256', 'executionProfileSha256',
      'executionUnitManifestSha256'
    ],
    label: 'World-model retry execution identity'
  });
  if (!['deterministic', 'model'].includes(value.execution.route)) {
    retryFailure('World-model retry execution route is invalid.', 'WMB_RETRY_BINDING_INVALID');
  }
  assertNullableString(value.execution.provider, 'World-model retry execution provider');
  assertNullableString(value.execution.requestedModel, 'World-model retry requested model');
  assertNullableSha256(value.execution.providerConfigSha256,
    'World-model retry provider configuration SHA-256');
  assertInteger(value.execution.timeoutMs, 'World-model retry timeoutMs', { minimum: 1 });
  assertSha256(value.execution.executionConfigurationSha256,
    'World-model retry execution configuration SHA-256');
  assertNullableSha256(value.execution.executionProfileSha256,
    'World-model retry execution profile SHA-256');
  assertSha256(value.execution.executionUnitManifestSha256,
    'World-model retry execution-unit manifest SHA-256');
  const expectedConfigurationSha256 = sha256({
    route: value.execution.route,
    provider: value.execution.provider,
    requestedModel: value.execution.requestedModel,
    providerConfigSha256: value.execution.providerConfigSha256,
    timeoutMs: value.execution.timeoutMs
  });
  if (value.execution.executionConfigurationSha256 !== expectedConfigurationSha256) {
    retryFailure('World-model retry execution configuration identity is invalid.',
      'WMB_RETRY_BINDING_INVALID');
  }
  if (value.execution.route === 'deterministic'
      && [value.execution.provider, value.execution.requestedModel,
        value.execution.providerConfigSha256, value.execution.executionProfileSha256]
        .some((entry) => entry !== null)) {
    retryFailure('Deterministic retry execution identity cannot name a model provider.',
      'WMB_RETRY_BINDING_INVALID');
  }
  if (value.execution.route === 'model'
      && (value.execution.providerConfigSha256 === null
        || value.execution.executionProfileSha256 === null)) {
    retryFailure('Model retry execution identity is incomplete.', 'WMB_RETRY_BINDING_INVALID');
  }
  if (value.cacheKey.sourceManifestSha256 !== value.sourceManifestSha256
      || value.cacheKey.scopeManifestSha256 !== value.scopeManifestSha256
      || value.cacheKey.viewId !== value.viewId
      || value.cacheKey.viewVersion !== value.viewVersion
      || value.cacheKey.viewSpecSha256 !== value.viewContractSha256
      || value.cacheKey.viewFactLedgerSha256 !== value.viewFactLedgerSha256
      || value.cacheKey.executionProfileSha256 !== value.execution.executionProfileSha256) {
    retryFailure('World-model retry binding does not contain one exact cache/execution identity.',
      'WMB_RETRY_BINDING_INVALID');
  }
  assertSelfHash(value, 'bindingSha256', 'World-model failed-view retry binding');
  return value;
}

export function assertWorldModelViewRetryBinding(expectedValue, actualValue) {
  const expected = validateWorldModelViewRetryBinding(expectedValue);
  const actual = validateWorldModelViewRetryBinding(actualValue);
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    retryFailure('World-model failed-view retry inputs do not match the original execution.',
      'WMB_RETRY_BINDING_MISMATCH', {
        expectedBindingSha256: expected.bindingSha256,
        actualBindingSha256: actual.bindingSha256,
        viewId: expected.viewId
      });
  }
  return actual;
}

export function isWorldModelViewRetryableCode(code) {
  return RETRYABLE_FAILURE_CODES.includes(String(code ?? ''));
}

function validateRetryMetadata(value, refusal = null) {
  assertPlainRecord(value, 'World-model refusal retry authority');
  assertExactKeys(value, {
    required: [
      'attempt', 'policy', 'binding', 'rootRefusalSha256', 'parentRefusalSha256'
    ],
    label: 'World-model refusal retry authority'
  });
  assertInteger(value.attempt, 'World-model refusal retry attempt', {
    minimum: 1, maximum: WORLD_MODEL_VIEW_RETRY_MAXIMUM_ATTEMPTS
  });
  const policy = validateWorldModelViewRetryPolicy(value.policy);
  const binding = validateWorldModelViewRetryBinding(value.binding);
  assertNullableSha256(value.rootRefusalSha256, 'World-model retry root refusal SHA-256');
  assertNullableSha256(value.parentRefusalSha256, 'World-model retry parent refusal SHA-256');
  if (value.attempt === 1
      ? value.rootRefusalSha256 !== null || value.parentRefusalSha256 !== null
      : value.rootRefusalSha256 === null || value.parentRefusalSha256 === null) {
    retryFailure('World-model refusal retry lineage is incomplete.',
      'WMB_RETRY_LINEAGE_INVALID');
  }
  if (refusal && (refusal.view !== binding.viewId
      || !policy.retryableFailureCodes.includes(refusal.code))) {
    retryFailure('World-model refusal is not authorized by its failed-view retry policy.',
      'WMB_RETRY_POLICY_UNSAFE', { viewId: refusal.view, code: refusal.code });
  }
  return value;
}

/** Create the retry authority embedded in an initial or descendant typed refusal. */
export function createWorldModelViewRetryMetadata({
  binding,
  previousRefusal = null,
  policy = WMB_V4_FAILED_VIEW_RETRY_POLICY
} = {}) {
  const validatedBinding = validateWorldModelViewRetryBinding(binding);
  const validatedPolicy = validateWorldModelViewRetryPolicy(policy);
  if (previousRefusal == null) {
    return deepFreeze({
      attempt: 1,
      policy: structuredClone(validatedPolicy),
      binding: structuredClone(validatedBinding),
      rootRefusalSha256: null,
      parentRefusalSha256: null
    });
  }
  const previous = validateWorldModelViewRetryRefusal(previousRefusal);
  if (previous.retry.attempt >= validatedPolicy.maximumAttempts) {
    retryFailure(
      `World-model view '${validatedBinding.viewId}' exhausted its ${validatedPolicy.maximumAttempts} governed attempts.`,
      'WMB_RETRY_ATTEMPTS_EXHAUSTED', {
        viewId: validatedBinding.viewId,
        attempts: previous.retry.attempt,
        maximumAttempts: validatedPolicy.maximumAttempts
      }
    );
  }
  assertWorldModelViewRetryBinding(previous.retry.binding, validatedBinding);
  if (canonicalJson(previous.retry.policy) !== canonicalJson(validatedPolicy)) {
    retryFailure('World-model failed-view retry policy changed between attempts.',
      'WMB_RETRY_POLICY_INVALID');
  }
  return deepFreeze({
    attempt: previous.retry.attempt + 1,
    policy: structuredClone(validatedPolicy),
    binding: structuredClone(validatedBinding),
    rootRefusalSha256: previous.retry.rootRefusalSha256 ?? previous.refusalSha256,
    parentRefusalSha256: previous.refusalSha256
  });
}

export function validateWorldModelViewRetryRefusal(value) {
  const refusal = validateWorldModelRefusal(value);
  if (!refusal.retry) {
    retryFailure('World-model refusal has no failed-view retry authority.',
      'WMB_RETRY_NOT_AUTHORIZED', { viewId: refusal.view, code: refusal.code });
  }
  validateRetryMetadata(refusal.retry, refusal);
  if (refusal.nextAction.operation !== 'world-model.retry-failed-view'
      || refusal.nextAction.view !== refusal.view
      || refusal.nextAction.reuseFacts !== true) {
    retryFailure('World-model retry refusal does not carry the registered selective next action.',
      'WMB_RETRY_NOT_AUTHORIZED', { viewId: refusal.view });
  }
  return refusal;
}

function validateReceiptOutcome(value, { receipt, previousRefusal }) {
  assertPlainRecord(value, 'World-model retry outcome');
  assertExactKeys(value, {
    required: ['status', 'executionSha256', 'execution', 'refusal'],
    label: 'World-model retry outcome'
  });
  if (!['completed', 'refused'].includes(value.status)) {
    retryFailure('World-model retry outcome status is invalid.', 'WMB_RETRY_RECEIPT_INVALID');
  }
  assertNullableSha256(value.executionSha256, 'World-model retry outcome execution SHA-256');
  if (value.status === 'completed') {
    if (value.executionSha256 === null || value.execution === null || value.refusal !== null) {
      retryFailure('Completed world-model retry outcome is incomplete.',
        'WMB_RETRY_RECEIPT_INVALID');
    }
    const execution = readRecord('world-model-view-execution', value.execution).record;
    assertExactKeys(execution, {
      required: [
        'schemaVersion', 'kind', 'requestSha256', 'viewId', 'viewVersion',
        'executionUnitManifestSha256', 'contextManifestSha256', 'viewFactLedgerSha256',
        'status', 'candidateSha256', 'validationReceiptSha256', 'publishedViewSha256',
        'usageObservationSha256', 'executionSha256'
      ],
      label: 'World-model retry outcome execution'
    });
    assertSchemaKind(execution, 'world-model-view-execution',
      'World-model retry outcome execution');
    for (const field of [
      'requestSha256', 'executionUnitManifestSha256', 'contextManifestSha256',
      'viewFactLedgerSha256', 'executionSha256'
    ]) assertSha256(execution[field], `World-model retry outcome execution ${field}`);
    for (const field of [
      'candidateSha256', 'validationReceiptSha256', 'publishedViewSha256',
      'usageObservationSha256'
    ]) assertNullableSha256(execution[field], `World-model retry outcome execution ${field}`);
    assertString(execution.viewId, 'World-model retry outcome execution viewId', {
      pattern: VIEW_ID_PATTERN
    });
    assertInteger(execution.viewVersion,
      'World-model retry outcome execution viewVersion', { minimum: 1 });
    if ([execution.candidateSha256, execution.validationReceiptSha256,
      execution.publishedViewSha256, execution.usageObservationSha256]
      .some((digest) => digest === null)) {
      retryFailure('Terminal world-model retry execution is missing an output identity.',
        'WMB_RETRY_RECEIPT_INVALID');
    }
    assertSelfHash(execution, 'executionSha256', 'World-model retry outcome execution');
    const executionUnitMatches = execution.executionUnitManifestSha256
      === receipt.binding.execution.executionUnitManifestSha256
      || (receipt.binding.execution.route === 'model'
        && receipt.binding.execution.requestedModel === null);
    if (execution.executionSha256 !== value.executionSha256
        || execution.requestSha256 !== receipt.binding.requestSha256
        || execution.viewId !== receipt.binding.viewId
        || execution.viewVersion !== receipt.binding.viewVersion
        || execution.contextManifestSha256 !== receipt.binding.contextManifestSha256
        || execution.viewFactLedgerSha256 !== receipt.binding.viewFactLedgerSha256
        || !executionUnitMatches
        || !['completed', 'cached'].includes(execution.status)) {
      retryFailure('World-model retry outcome execution does not match its exact binding.',
        'WMB_RETRY_RECEIPT_INVALID');
    }
    return value;
  }
  if (value.executionSha256 !== null || value.execution !== null || value.refusal === null) {
    retryFailure('Refused world-model retry outcome is incomplete.',
      'WMB_RETRY_RECEIPT_INVALID');
  }
  const refusal = validateWorldModelViewRetryRefusal(value.refusal);
  if (refusal.retry.attempt !== receipt.attempt
      || refusal.retry.parentRefusalSha256 !== previousRefusal.refusalSha256
      || refusal.retry.rootRefusalSha256 !== receipt.lineage.rootRefusalSha256
      || canonicalJson(refusal.retry.policy) !== canonicalJson(receipt.policy)
      || canonicalJson(refusal.retry.binding) !== canonicalJson(receipt.binding)) {
    retryFailure('Refused world-model retry outcome breaks exact refusal lineage.',
      'WMB_RETRY_LINEAGE_INVALID');
  }
  return value;
}

export function validateWorldModelViewRetryReceipt(value) {
  const receipt = readRecord(WORLD_MODEL_VIEW_RETRY_RECEIPT_FAMILY, value).record;
  assertPlainRecord(receipt, 'World-model failed-view retry receipt');
  assertExactKeys(receipt, {
    required: [
      'schemaVersion', 'kind', 'viewId', 'viewVersion', 'attempt', 'policy', 'binding',
      'lineage', 'previousRefusal', 'outcome', 'receiptSha256'
    ],
    label: 'World-model failed-view retry receipt'
  });
  assertSchemaKind(receipt, 'world-model-view-retry-receipt',
    'World-model failed-view retry receipt');
  assertString(receipt.viewId, 'World-model retry receipt viewId', { pattern: VIEW_ID_PATTERN });
  assertInteger(receipt.viewVersion, 'World-model retry receipt viewVersion', { minimum: 1 });
  assertInteger(receipt.attempt, 'World-model retry receipt attempt', {
    minimum: 2, maximum: WORLD_MODEL_VIEW_RETRY_MAXIMUM_ATTEMPTS
  });
  validateWorldModelViewRetryPolicy(receipt.policy);
  validateWorldModelViewRetryBinding(receipt.binding);
  const previous = validateWorldModelViewRetryRefusal(receipt.previousRefusal);
  assertPlainRecord(receipt.lineage, 'World-model retry receipt lineage');
  assertExactKeys(receipt.lineage, {
    required: [
      'rootRefusalSha256', 'previousRefusalSha256', 'previousRetryReceiptSha256'
    ],
    label: 'World-model retry receipt lineage'
  });
  assertSha256(receipt.lineage.rootRefusalSha256,
    'World-model retry receipt root refusal SHA-256');
  assertSha256(receipt.lineage.previousRefusalSha256,
    'World-model retry receipt previous refusal SHA-256');
  assertNullableSha256(receipt.lineage.previousRetryReceiptSha256,
    'World-model retry receipt previous receipt SHA-256');
  const expectedRoot = previous.retry.rootRefusalSha256 ?? previous.refusalSha256;
  if (receipt.viewId !== receipt.binding.viewId
      || receipt.viewVersion !== receipt.binding.viewVersion
      || receipt.attempt !== previous.retry.attempt + 1
      || receipt.lineage.rootRefusalSha256 !== expectedRoot
      || receipt.lineage.previousRefusalSha256 !== previous.refusalSha256
      || (receipt.attempt === 2) !== (receipt.lineage.previousRetryReceiptSha256 === null)
      || canonicalJson(receipt.policy) !== canonicalJson(previous.retry.policy)
      || canonicalJson(receipt.binding) !== canonicalJson(previous.retry.binding)) {
    retryFailure('World-model retry receipt does not bind its exact previous refusal.',
      'WMB_RETRY_LINEAGE_INVALID');
  }
  validateReceiptOutcome(receipt.outcome, { receipt, previousRefusal: previous });
  assertSelfHash(receipt, 'receiptSha256', 'World-model failed-view retry receipt');
  return deepFreeze(receipt);
}

/** Prove the supplied refusal/receipt pair is the one live terminal edge before any retry effect. */
export function assertWorldModelViewRetryLineage(previousRefusal, previousRetryReceipt = null) {
  const previous = validateWorldModelViewRetryRefusal(previousRefusal);
  const attempt = previous.retry.attempt + 1;
  if (attempt > previous.retry.policy.maximumAttempts) {
    retryFailure(
      `World-model view '${previous.view}' exhausted its ${previous.retry.policy.maximumAttempts} governed attempts.`,
      'WMB_RETRY_ATTEMPTS_EXHAUSTED', {
        viewId: previous.view,
        attempts: previous.retry.attempt,
        maximumAttempts: previous.retry.policy.maximumAttempts
      }
    );
  }
  if (previous.retry.attempt === 1) {
    if (previousRetryReceipt !== null) {
      retryFailure('The first world-model retry cannot name a previous retry receipt.',
        'WMB_RETRY_LINEAGE_INVALID');
    }
    return Object.freeze({ previous, previousRetryReceipt: null, attempt });
  }
  const priorReceipt = validateWorldModelViewRetryReceipt(previousRetryReceipt);
  if (priorReceipt.outcome.status !== 'refused'
      || priorReceipt.outcome.refusal.refusalSha256 !== previous.refusalSha256
      || priorReceipt.attempt !== previous.retry.attempt
      || canonicalJson(priorReceipt.binding) !== canonicalJson(previous.retry.binding)
      || canonicalJson(priorReceipt.policy) !== canonicalJson(previous.retry.policy)) {
    retryFailure('World-model retry does not descend from the exact prior failed receipt.',
      'WMB_RETRY_LINEAGE_INVALID');
  }
  return Object.freeze({ previous, previousRetryReceipt: priorReceipt, attempt });
}

/** Create one immutable receipt after exactly one selective attempt reaches a terminal outcome. */
export function createWorldModelViewRetryReceipt({
  previousRefusal,
  previousRetryReceipt = null,
  execution = null,
  refusal = null
} = {}) {
  const lineage = assertWorldModelViewRetryLineage(previousRefusal, previousRetryReceipt);
  const { previous, attempt } = lineage;
  const priorReceipt = lineage.previousRetryReceipt;
  if ((execution === null) === (refusal === null)) {
    retryFailure('World-model retry receipt requires exactly one execution or refusal outcome.',
      'WMB_RETRY_RECEIPT_INVALID');
  }
  let outcome;
  if (execution) {
    assertSha256(execution.executionSha256, 'World-model retry execution SHA-256');
    outcome = {
      status: 'completed',
      executionSha256: execution.executionSha256,
      execution: structuredClone(execution),
      refusal: null
    };
  } else {
    const nextRefusal = validateWorldModelViewRetryRefusal(refusal);
    outcome = {
      status: 'refused', executionSha256: null, execution: null,
      refusal: structuredClone(nextRefusal)
    };
  }
  return validateWorldModelViewRetryReceipt(deepFreeze(sealRecord({
    schemaVersion: currentSchemaVersion(WORLD_MODEL_VIEW_RETRY_RECEIPT_FAMILY),
    kind: 'world-model-view-retry-receipt',
    viewId: previous.retry.binding.viewId,
    viewVersion: previous.retry.binding.viewVersion,
    attempt,
    policy: structuredClone(previous.retry.policy),
    binding: structuredClone(previous.retry.binding),
    lineage: {
      rootRefusalSha256: previous.retry.rootRefusalSha256 ?? previous.refusalSha256,
      previousRefusalSha256: previous.refusalSha256,
      previousRetryReceiptSha256: priorReceipt?.receiptSha256 ?? null
    },
    previousRefusal: structuredClone(previous),
    outcome
  }, 'receiptSha256')));
}

function retryReceiptPath(root, receiptSha256) {
  assertSha256(receiptSha256, 'World-model retry receipt SHA-256');
  const digest = receiptSha256.slice('sha256:'.length);
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'world-model-cache', 'v4', 'objects',
    'retry-receipts', digest.slice(0, 2), `${digest}.json`
  );
}

function retryReceiptEdgePath(root, previousRefusalSha256) {
  assertSha256(previousRefusalSha256, 'World-model previous refusal SHA-256');
  const digest = previousRefusalSha256.slice('sha256:'.length);
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'world-model-cache', 'v4', 'objects',
    'retry-edges', digest.slice(0, 2), `${digest}.json`
  );
}

export async function readWorldModelViewRetryReceiptForRefusal(
  root, previousRefusalSha256
) {
  const target = retryReceiptEdgePath(root, previousRefusalSha256);
  const bytes = await readPrivateSidecar(root, target, {
    maximumBytes: MAXIMUM_RETRY_RECEIPT_BYTES,
    optional: true
  });
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    retryFailure('World-model retry lineage edge is not valid JSON.',
      'WMB_RETRY_LINEAGE_CORRUPT', { cause: error.message });
  }
  const receipt = validateWorldModelViewRetryReceipt(value);
  if (receipt.lineage.previousRefusalSha256 !== previousRefusalSha256
      || canonicalJson(receipt) !== bytes.toString('utf8')) {
    retryFailure('World-model retry lineage edge does not bind its exact previous refusal.',
      'WMB_RETRY_LINEAGE_CORRUPT', { previousRefusalSha256 });
  }
  return receipt;
}

export async function storeWorldModelViewRetryReceipt(root, value) {
  const receipt = validateWorldModelViewRetryReceipt(value);
  const target = retryReceiptPath(root, receipt.receiptSha256);
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8');
  const edge = retryReceiptEdgePath(root, receipt.lineage.previousRefusalSha256);
  let edgeResult;
  try {
    edgeResult = await writeImmutablePrivateSidecar(
      root, edge, bytes,
      { maximumBytes: MAXIMUM_RETRY_RECEIPT_BYTES }
    );
  } catch (error) {
    if (error?.code !== 'PRIVATE_SIDECAR_RECORD_CONFLICT') throw error;
    retryFailure('World-model refusal already has a different immutable retry outcome.',
      'WMB_RETRY_LINEAGE_CONFLICT', {
        previousRefusalSha256: receipt.lineage.previousRefusalSha256
      });
  }
  // The refusal-keyed terminal edge lands first. A crash can therefore leave a recoverable edge
  // without its redundant content object, never an unconsumed refusal after an execution ran.
  const result = await writeImmutablePrivateSidecar(
    root, target, bytes,
    { maximumBytes: MAXIMUM_RETRY_RECEIPT_BYTES }
  );
  return Object.freeze({
    receipt, path: target, lineagePath: edge,
    written: result.created, lineageWritten: edgeResult.created
  });
}
