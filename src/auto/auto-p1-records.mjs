/**
 * Typed AUT v2 product records.
 *
 * These records describe a flight; they do not create a second lifecycle. Story phase operations,
 * publication, approval, and Candidate authority remain owned by their existing kernel modules.
 * Every writer is bounded below the Git common directory and every reader verifies the family,
 * flight binding, and exact content hash before returning a record.
 */
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import {
  listAutoPrivateRecords, readAutoPrivateRecord, writeAutoPrivateRecord
} from './auto-private-store.mjs';
import { assertAutoCredentialBrokerReference } from './auto-credential-reference.mjs';

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Z]{3}-[A-F0-9]{26}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const AUTO_PHASE_RUN_STATUSES = Object.freeze([
  'planned', 'running', 'verifying', 'waiting-human', 'refused', 'published', 'completed', 'halted'
]);
export const AUTO_ATTEMPT_KINDS = Object.freeze(['initial', 'repair', 'manual-adoption', 'resume']);
export const AUTO_ATTEMPT_STATUSES = Object.freeze([
  'planned', 'running', 'authored', 'verifying', 'refused', 'published', 'failed', 'completed'
]);
export const AUTO_REPAIR_ELIGIBILITY = Object.freeze([
  'auto-eligible', 'ask-only', 'manual-only', 'ineligible'
]);
// Versions 1 and 2 were sealed before AUT v2 added the remaining judgment boundaries. Validate
// archived bytes against the vocabulary that existed when they were written; otherwise a caller
// could forge a v2 seal around a v3-only type and have migration legitimize it.
const AUTO_HUMAN_REQUEST_TYPES_V1_V2 = Object.freeze([
  'clarification', 'credential', 'architecture-choice'
]);
export const AUTO_HUMAN_REQUEST_TYPES = Object.freeze([
  'clarification', 'approval', 'architecture-choice', 'scope-choice', 'credential',
  'exception', 'risk-acceptance', 'policy-choice', 'conflict-resolution',
  'evidence-review', 'production-authority', 'legal-judgment', 'scientific-judgment'
]);
const AUTO_HUMAN_CHOICE_REQUEST_TYPES = new Set(
  AUTO_HUMAN_REQUEST_TYPES.filter((type) => !['clarification', 'credential'].includes(type))
);
export const AUTO_HUMAN_REQUEST_STATUSES = Object.freeze(['open', 'answered', 'expired', 'cancelled']);
export const AUTO_SWITCH_STATUSES = Object.freeze(['proposed', 'confirmed', 'applied', 'refused']);
export const AUTO_ECONOMICS_CLASSIFICATIONS = Object.freeze([
  'unavailable', 'first-pass-pending-verification', 'repair-pending-verification',
  'verified-first-pass', 'verified-after-one-repair', 'verification-failed'
]);

const ATTEMPT_BUDGET_FIELDS = Object.freeze([
  'modelInvocations', 'repairAttempts', 'maximumRepairAttempts', 'routeChanges', 'tokens',
  'toolOutputTokens', 'toolOutputBytes', 'estimatedToolOutputTokens',
  'contextExpansions', 'fullContextFallbacks'
]);
const REFUSAL_ACTIONS = Object.freeze([
  'auto.repair', 'auto.takeover', 'auto.respond', 'auto.resume', 'auto.halt'
]);

const FAMILY = Object.freeze({
  'auto-phase-run': { directory: 'phase-runs', id: 'phaseRunId', hash: 'recordSha256', mutable: true },
  'auto-attempt': { directory: 'attempts', id: 'attemptId', hash: 'recordSha256', mutable: true },
  'auto-refusal': { directory: 'refusals', id: 'refusalId', hash: 'refusalSha256', mutable: false },
  'auto-repair-plan': { directory: 'repair-plans', id: 'repairPlanId', hash: 'repairPlanSha256', mutable: false },
  'auto-human-request': { directory: 'human-requests', id: 'requestId', hash: 'requestSha256', mutable: true },
  'auto-token-economics-receipt': { directory: 'economics', id: 'attemptId', hash: 'receiptSha256', mutable: true },
  'auto-execution-unit-switch': { directory: 'execution-unit-switches', id: 'switchPlanId', hash: 'switchPlanSha256', mutable: true }
});

const MUTABLE_RECORD_FIELDS = Object.freeze({
  'auto-phase-run': Object.freeze([
    'status', 'attemptIds', 'activeAttemptId', 'publishedGenerations',
    'requiredHumanRequestIds', 'phaseCheckpointSha256'
  ]),
  'auto-attempt': Object.freeze([
    'status', 'candidateSha256', 'verificationReceiptSha256',
    'publicationReceiptSha256', 'budgetImpact', 'result'
  ])
});

export const AUTO_P1_RECORD_FAMILIES = Object.freeze(Object.keys(FAMILY));

const FAMILY_FIELDS = Object.freeze({
  'auto-phase-run': [
    'schemaVersion', 'kind', 'mode', 'phaseRunId', 'flightId', 'phase', 'status',
    'attemptIds', 'activeAttemptId', 'publishedGenerations', 'requiredHumanRequestIds',
    'phaseCheckpointSha256', 'createdAt', 'updatedAt', 'recordSha256'
  ],
  'auto-attempt': [
    'schemaVersion', 'kind', 'mode', 'attemptId', 'flightId', 'phase', 'attemptNumber',
    'attemptKind', 'parentAttemptId', 'reason', 'generationIntentSha256', 'taskContractSha256',
    'contextManifestSha256', 'executionUnitManifestSha256', 'status', 'candidateSha256',
    'verificationReceiptSha256', 'publicationReceiptSha256', 'budgetImpact', 'result',
    'createdAt', 'updatedAt', 'recordSha256'
  ],
  'auto-refusal': [
    'schemaVersion', 'kind', 'mode', 'refusalId', 'flightId', 'phase', 'attemptId',
    'gate', 'code', 'subject', 'missing', 'preserved', 'repair', 'primaryNextAction',
    'createdAt', 'refusalSha256'
  ],
  'auto-repair-plan': [
    'schemaVersion', 'kind', 'mode', 'repairPlanId', 'flightId', 'parentAttemptId',
    'refusalSha256', 'objective', 'readScope', 'writeScope', 'forbiddenChanges',
    'requiredEvidence', 'budget', 'attemptNumber', 'createdAt', 'repairPlanSha256'
  ],
  'auto-human-request': [
    'schemaVersion', 'kind', 'mode', 'requestId', 'flightId', 'phase', 'attemptId',
    'requestType', 'title', 'detail', 'options', 'subjectSha256', 'policySha256',
    'checkpointSha256', 'status', 'response', 'createdAt', 'expiresAt', 'requestSha256'
  ],
  'auto-token-economics-receipt': [
    'schemaVersion', 'kind', 'mode', 'flightId', 'attemptId', 'contextManifestSha256',
    'input', 'output', 'cost', 'quality', 'classification', 'worldModelReference',
    'comprehensionReference', 'createdAt', 'receiptSha256'
  ],
  'auto-execution-unit-switch': [
    'schemaVersion', 'kind', 'mode', 'switchPlanId', 'flightId', 'fromExecutionUnit',
    'toExecutionUnit', 'taskContractSha256', 'parentAttemptId', 'reason', 'status',
    'createdAt', 'switchPlanSha256'
  ]
});

function fail(message, code = 'AUTO_RECORD_INVALID', details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function flightId(value) {
  const normalized = String(value ?? '').trim();
  if (!FLIGHT_ID.test(normalized)) fail(`Invalid Auto flight ID '${normalized}'.`, 'AUTO_FLIGHT_NOT_FOUND');
  return normalized;
}

function nonempty(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) fail(`${label} is required.`);
  return normalized;
}

function hash(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!HASH.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}

function vocabulary(value, values, label) {
  if (!values.includes(value)) fail(`${label} must be one of: ${values.join(', ')}.`);
  return value;
}

function identifier(prefix, value) {
  const digest = recordSha256(value).slice(0, 26).toUpperCase();
  return `${prefix}-${digest}`;
}

function contentHash(value, field) {
  const core = structuredClone(value);
  delete core[field];
  return `sha256:${recordSha256(core)}`;
}

function exactKeys(family, value) {
  const expected = FAMILY_FIELDS[family];
  const actual = Object.keys(value ?? {});
  const unknown = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !Object.hasOwn(value ?? {}, key));
  if (unknown.length || missing.length) fail(
    `Auto ${family} record has an invalid field set.`, 'AUTO_RECORD_CORRUPT', { unknown, missing }
  );
}

function recordId(value, prefix, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!new RegExp(`^${prefix}-[A-F0-9]{26}$`).test(String(value ?? ''))) {
    fail(`${label} is invalid.`, 'AUTO_RECORD_CORRUPT');
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`, 'AUTO_RECORD_CORRUPT');
  return value;
}

function objectValue(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`, 'AUTO_RECORD_CORRUPT');
  }
  return value;
}

function exactObject(value, label, allowed, {
  required = allowed, nullable = false
} = {}) {
  if (nullable && value == null) return null;
  const object = objectValue(value, label);
  const fields = Object.keys(object);
  const unknown = fields.filter((field) => !allowed.includes(field));
  const missing = required.filter((field) => !Object.hasOwn(object, field));
  if (unknown.length || missing.length) fail(
    `${label} has an invalid field set.`, 'AUTO_RECORD_CORRUPT', { unknown, missing }
  );
  return object;
}

function stringSet(value, label, { allowEmpty = true } = {}) {
  const values = array(value, label);
  if (!allowEmpty && values.length === 0) fail(`${label} must not be empty.`, 'AUTO_RECORD_CORRUPT');
  const normalized = values.map((entry) => nonempty(entry, `${label} entry`));
  if (new Set(normalized).size !== normalized.length) fail(`${label} must not contain duplicates.`, 'AUTO_RECORD_CORRUPT');
  return normalized;
}

function timestamp(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const matched = typeof value === 'string' ? RFC3339.exec(value) : null;
  const date = matched
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
    : null;
  const [, year, month, day, hour, minute, second] = date ?? [];
  const maximumDay = date
    ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    : 0;
  if (!matched || !Number.isFinite(Date.parse(value))
      || Number(month) < 1 || Number(month) > 12
      || Number(day) < 1 || Number(day) > maximumDay
      || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    fail(`${label} must be an RFC 3339 timestamp.`, 'AUTO_RECORD_CORRUPT');
  }
  return value;
}

function uniqueRecordIds(value, prefix, label) {
  const ids = array(value, label);
  ids.forEach((id) => recordId(id, prefix, label.replace(/s$/, '')));
  if (new Set(ids).size !== ids.length) {
    fail(`${label} must not contain duplicates.`, 'AUTO_RECORD_CORRUPT');
  }
  return ids;
}

function counter(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer.`, 'AUTO_RECORD_CORRUPT');
  return value;
}

function finiteAmount(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be a non-negative number.`, 'AUTO_RECORD_CORRUPT');
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean.`, 'AUTO_RECORD_CORRUPT');
  return value;
}

function nullableNonempty(value, label) {
  return value == null ? null : nonempty(value, label);
}

function executionUnitId(value, label) {
  const normalized = nonempty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    fail(`${label} is invalid.`, 'AUTO_RECORD_CORRUPT');
  }
  return normalized;
}

function validatePublishedGeneration(value) {
  const entry = exactObject(value, 'Published generation', [
    'generation', 'candidateSha256', 'publicationReceiptSha256'
  ]);
  if (entry.generation != null) counter(entry.generation, 'Published generation number');
  hash(entry.candidateSha256, 'Published Candidate', { nullable: true });
  hash(entry.publicationReceiptSha256, 'Published receipt', { nullable: true });
}

function validateAttemptBudget(value) {
  const budget = exactObject(value, 'Attempt budget impact', ATTEMPT_BUDGET_FIELDS, { required: [] });
  for (const [field, amount] of Object.entries(budget)) counter(amount, `Attempt budget ${field}`);
}

function validateAttemptResult(value) {
  if (value == null) return;
  const result = objectValue(value, 'Attempt result');
  switch (result.status) {
    case 'authored':
      exactObject(result, 'Authored attempt result', ['status', 'invocationId']);
      nullableNonempty(result.invocationId, 'Invocation ID');
      break;
    case 'refused':
      exactObject(result, 'Refused attempt result', ['status', 'refusalId', 'refusalSha256']);
      recordId(result.refusalId, 'ARF', 'Result refusal ID');
      hash(result.refusalSha256, 'Result refusal');
      break;
    case 'published':
      exactObject(result, 'Published attempt result', ['status', 'generation']);
      if (result.generation != null) counter(result.generation, 'Published result generation');
      break;
    case 'completed':
      exactObject(result, 'Completed attempt result', ['status']);
      break;
    case 'failed':
      exactObject(result, 'Failed attempt result', ['status', 'code', 'message']);
      nonempty(result.code, 'Attempt failure code');
      nonempty(result.message, 'Attempt failure message');
      break;
    default:
      fail(`Attempt result status '${result.status ?? '(missing)'}' is invalid.`, 'AUTO_RECORD_CORRUPT');
  }
}

function validateRefusalSubject(value) {
  const subject = exactObject(value, 'Refusal subject', [
    'candidateSha256', 'verificationReceiptSha256'
  ]);
  hash(subject.candidateSha256, 'Refusal Candidate', { nullable: true });
  hash(subject.verificationReceiptSha256, 'Refusal Candidate verification', { nullable: true });
}

function validateMissingEvidence(value) {
  const entries = array(value, 'Refusal missing evidence');
  if (!entries.length) fail('A refusal must name at least one missing requirement or evidence item.', 'AUTO_RECORD_CORRUPT');
  entries.forEach((entry) => {
    const missing = exactObject(entry, 'Refusal missing-evidence entry', ['requirement', 'evidence'], { required: [] });
    if (!Object.hasOwn(missing, 'requirement') && !Object.hasOwn(missing, 'evidence')) {
      fail('Refusal missing-evidence entry must name a requirement or evidence.', 'AUTO_RECORD_CORRUPT');
    }
    if (Object.hasOwn(missing, 'requirement')) nonempty(missing.requirement, 'Missing requirement');
    if (Object.hasOwn(missing, 'evidence')) nonempty(missing.evidence, 'Missing evidence');
  });
}

function validatePreservedWork(value) {
  const preserved = exactObject(value, 'Refusal preserved work', [
    'candidateSha256', 'verificationReceiptSha256', 'changedPaths', 'paths', 'workingArea'
  ]);
  hash(preserved.candidateSha256, 'Preserved Candidate', { nullable: true });
  hash(preserved.verificationReceiptSha256, 'Preserved Candidate verification', {
    nullable: true
  });
  counter(preserved.changedPaths, 'Preserved changed path count');
  stringSet(preserved.paths, 'Preserved paths');
  booleanValue(preserved.workingArea, 'Preserved working-area indicator');
}

function validateRepair(value) {
  const repair = exactObject(value, 'Refusal repair', [
    'eligibility', 'operation', 'scope', 'maximumAttempts'
  ]);
  vocabulary(repair.eligibility, AUTO_REPAIR_ELIGIBILITY, 'Repair eligibility');
  if (repair.operation !== 'auto.repair') fail("Repair operation must be 'auto.repair'.", 'AUTO_RECORD_CORRUPT');
  stringSet(repair.scope, 'Repair scope');
  if (![0, 1].includes(repair.maximumAttempts)) fail('Repair maximumAttempts is invalid.', 'AUTO_RECORD_CORRUPT');
  if (['manual-only', 'ineligible'].includes(repair.eligibility) && repair.maximumAttempts !== 0) {
    fail('A non-automatic repair cannot retain an automatic attempt.', 'AUTO_RECORD_CORRUPT');
  }
}

function validateNextAction(value) {
  const action = exactObject(value, 'Refusal next action', ['operation', 'label']);
  vocabulary(action.operation, REFUSAL_ACTIONS, 'Refusal next action operation');
  nonempty(action.label, 'Refusal next action label');
}

function validateRepairBudget(value) {
  const budget = exactObject(value, 'Repair budget', [
    'maximumAttempts', 'remainingModelInvocations'
  ]);
  if (budget.maximumAttempts !== 1) fail('Repair budget maximumAttempts must equal one.', 'AUTO_RECORD_CORRUPT');
  counter(budget.remainingModelInvocations, 'Remaining model invocations');
}

function validateHumanDetail(type, value) {
  if (type === 'clarification') {
    const detail = exactObject(value, 'Clarification detail', ['question', 'whyStopped'], {
      required: ['question']
    });
    nonempty(detail.question, 'Clarification question');
    if (Object.hasOwn(detail, 'whyStopped')) nonempty(detail.whyStopped, 'Clarification stop reason');
  } else if (type === 'credential') {
    const detail = exactObject(value, 'Credential detail', ['provider']);
    nonempty(detail.provider, 'Credential provider');
  } else {
    const detail = exactObject(value, `${type} detail`, ['reason']);
    nonempty(detail.reason, `${type} reason`);
  }
}

function optionId(option) {
  if (typeof option === 'string') return nonempty(option, 'Human Request option');
  const entry = exactObject(option, 'Human Request option', [
    'id', 'label', 'description', 'consequences'
  ], { required: ['id'] });
  nonempty(entry.id, 'Human Request option ID');
  for (const field of ['label', 'description']) {
    if (Object.hasOwn(entry, field)) nonempty(entry[field], `Human Request option ${field}`);
  }
  if (Object.hasOwn(entry, 'consequences')) stringSet(entry.consequences, 'Human Request option consequences');
  return entry.id;
}

function validateHumanOptions(type, value) {
  const options = array(value, 'Human Request options');
  const ids = options.map(optionId);
  if (new Set(ids).size !== ids.length) fail('Human Request option IDs must be unique.', 'AUTO_RECORD_CORRUPT');
  if (AUTO_HUMAN_CHOICE_REQUEST_TYPES.has(type) && options.length < 2) {
    fail(`A ${type} request requires at least two exact options.`, 'AUTO_RECORD_CORRUPT');
  }
  if (type === 'credential' && options.length) {
    fail('A credential request cannot offer inline credential values.', 'AUTO_RECORD_CORRUPT');
  }
}

function validateHumanResponse(type, status, value, options) {
  if (status !== 'answered') {
    if (value !== null) fail(`A ${status} Human Request cannot contain a response.`, 'AUTO_RECORD_CORRUPT');
    return;
  }
  const response = exactObject(value, 'Human Request response', [
    'value', 'requestSha256', 'responseSha256'
  ]);
  hash(response.requestSha256, 'Human Request response request hash');
  hash(response.responseSha256, 'Human Request response hash');
  if (type === 'credential') {
    const answer = exactObject(response.value, 'Credential response', ['brokerReference', 'status'], {
      required: ['brokerReference']
    });
    assertAutoCredentialBrokerReference(answer.brokerReference, {
      invalidCode: 'AUTO_RECORD_CORRUPT', secretCode: 'AUTO_RECORD_CORRUPT'
    });
    if (Object.hasOwn(answer, 'status')) vocabulary(answer.status, ['available', 'unavailable'], 'Credential status');
  } else if (AUTO_HUMAN_CHOICE_REQUEST_TYPES.has(type)) {
    const answer = exactObject(response.value, `${type} response`, ['choice']);
    nonempty(answer.choice, `${type} choice`);
    if (!new Set(options.map(optionId)).has(answer.choice)) {
      fail(`${type} response must select one exact offered option.`, 'AUTO_RECORD_CORRUPT');
    }
  } else {
    const answer = exactObject(response.value, 'Clarification response', ['answer', 'choice'], { required: [] });
    if (Object.keys(answer).length !== 1) fail('Clarification response must contain one answer or choice.', 'AUTO_RECORD_CORRUPT');
    nonempty(answer.answer ?? answer.choice, 'Clarification answer');
    if (answer.choice && !new Set(options.map(optionId)).has(answer.choice)) {
      fail('Clarification response must select one exact offered option.', 'AUTO_RECORD_CORRUPT');
    }
  }
  const expectedResponseSha256 = `sha256:${recordSha256({
    requestSha256: response.requestSha256, response: response.value
  })}`;
  if (response.responseSha256 !== expectedResponseSha256) {
    fail('Human Request response failed its exact content-integrity check.', 'AUTO_RECORD_CORRUPT');
  }
}

function validateWorldModelReference(value) {
  if (value == null) return;
  const reference = exactObject(value, 'World Model reference', [
    'protocol', 'path', 'workId', 'phase', 'generation', 'agent', 'worldModelCommit',
    'manifestSha256', 'renderedSha256', 'modelSourceTreeSha256',
    'composedSourceTreeSha256', 'fresh'
  ]);
  if (reference.protocol !== 'auto-world-model-reference-v1') fail('World Model reference protocol is invalid.', 'AUTO_RECORD_CORRUPT');
  for (const field of ['path', 'workId', 'phase', 'agent']) nonempty(reference[field], `World Model ${field}`);
  if (path.isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes('..')
      || reference.path.includes('\0')) {
    fail('World Model reference path must be repository-relative.', 'AUTO_RECORD_CORRUPT');
  }
  counter(reference.generation, 'World Model generation');
  if (!/^[a-f0-9]{40}$/.test(String(reference.worldModelCommit ?? ''))) fail('World Model commit is invalid.', 'AUTO_RECORD_CORRUPT');
  for (const field of ['manifestSha256', 'renderedSha256', 'modelSourceTreeSha256', 'composedSourceTreeSha256']) {
    hash(reference[field], `World Model ${field}`);
  }
  booleanValue(reference.fresh, 'World Model freshness');
}

function validateComprehensionReference(value) {
  if (value == null) return;
  const reference = exactObject(value, 'Comprehension reference', [
    'protocol', 'packetSha256', 'subjectSha256', 'status'
  ]);
  if (reference.protocol !== 'auto-comprehension-reference-v1') fail('Comprehension reference protocol is invalid.', 'AUTO_RECORD_CORRUPT');
  hash(reference.packetSha256, 'Comprehension packet');
  hash(reference.subjectSha256, 'Comprehension subject');
  vocabulary(reference.status, ['pending', 'verified'], 'Comprehension reference status');
}

function validateEconomics(value) {
  const input = exactObject(value.input, 'Economics input', [
    'promptBytes', 'estimatedTokens', 'providerTokens', 'cachedTokens'
  ]);
  const output = exactObject(value.output, 'Economics output', [
    'estimatedTokens', 'providerTokens'
  ]);
  for (const [field, amount] of Object.entries(input)) counter(amount, `Economics input ${field}`, { nullable: true });
  for (const [field, amount] of Object.entries(output)) counter(amount, `Economics output ${field}`, { nullable: true });
  const cost = exactObject(value.cost, 'Economics cost', ['amount', 'currency', 'assurance']);
  finiteAmount(cost.amount, 'Economics cost amount', { nullable: true });
  if (cost.currency !== 'USD') fail("Economics cost currency must be 'USD'.", 'AUTO_RECORD_CORRUPT');
  vocabulary(cost.assurance, ['unavailable', 'provider-reported'], 'Economics cost assurance');
  if ((cost.amount == null) !== (cost.assurance === 'unavailable')) {
    fail('Economics cost amount and assurance disagree.', 'AUTO_RECORD_CORRUPT');
  }
  const quality = exactObject(value.quality, 'Economics quality', [
    'verification', 'firstPass', 'repairAttempts', 'reviewReturned', 'missingContextIncident'
  ]);
  vocabulary(quality.verification, ['pending', 'passed', 'failed'], 'Economics verification');
  booleanValue(quality.firstPass, 'Economics first-pass indicator');
  counter(quality.repairAttempts, 'Economics repair attempts');
  booleanValue(quality.reviewReturned, 'Economics review-returned indicator');
  booleanValue(quality.missingContextIncident, 'Economics missing-context indicator');
  vocabulary(value.classification, AUTO_ECONOMICS_CLASSIFICATIONS, 'Economics classification');
  if (quality.repairAttempts > 1) fail('Economics repair attempts exceed the P1 ceiling.', 'AUTO_RECORD_CORRUPT');
  const expectedClassifications = quality.verification === 'passed'
    ? (quality.firstPass && quality.repairAttempts === 0
      ? ['verified-first-pass'] : ['verified-after-one-repair'])
    : quality.verification === 'failed'
      ? ['verification-failed']
      : quality.firstPass && quality.repairAttempts === 0
        ? ['first-pass-pending-verification', 'unavailable']
        : ['repair-pending-verification', 'unavailable'];
  if (!expectedClassifications.includes(value.classification)) {
    fail('Economics classification disagrees with its quality result.', 'AUTO_RECORD_CORRUPT');
  }
  validateWorldModelReference(value.worldModelReference);
  validateComprehensionReference(value.comprehensionReference);
}

function validateLegacyFamilyShape(family, value) {
  // Schema-v1 records predate recursively closed nested contracts. Their exact bytes and self-hash
  // are still verified before the migration registry projects them into the current vocabulary.
  if (family === 'auto-phase-run') array(value.publishedGenerations, 'Published generations');
  else if (family === 'auto-attempt') {
    objectValue(value.budgetImpact, 'Attempt budget impact');
    if (value.result != null) objectValue(value.result, 'Attempt result');
  } else if (family === 'auto-refusal') {
    objectValue(value.subject, 'Refusal subject');
    array(value.missing, 'Refusal missing evidence');
    objectValue(value.preserved, 'Refusal preserved work');
    objectValue(value.repair, 'Refusal repair');
    objectValue(value.primaryNextAction, 'Refusal next action');
  } else if (family === 'auto-repair-plan') objectValue(value.budget, 'Repair budget');
  else if (family === 'auto-human-request') {
    objectValue(value.detail, 'Human Request detail');
    array(value.options, 'Human Request options');
  } else if (family === 'auto-token-economics-receipt') {
    for (const field of ['input', 'output', 'cost', 'quality']) objectValue(value[field], `Economics ${field}`);
  }
}

function validateFamilyShape(family, value, { legacyNested = false } = {}) {
  exactKeys(family, value);
  flightId(value.flightId);
  timestamp(value.createdAt, 'Auto record createdAt');
  if (Object.hasOwn(value, 'updatedAt')) timestamp(value.updatedAt, 'Auto record updatedAt');
  if (Object.hasOwn(value, 'expiresAt')) {
    timestamp(value.expiresAt, 'Human Request expiresAt', { nullable: true });
  }
  if (family === 'auto-phase-run') {
    recordId(value.phaseRunId, 'APR', 'Phase-run ID');
    nonempty(value.phase, 'Auto phase');
    vocabulary(value.status, AUTO_PHASE_RUN_STATUSES, 'Auto phase-run status');
    uniqueRecordIds(value.attemptIds, 'AAT', 'Phase-run attempt IDs');
    recordId(value.activeAttemptId, 'AAT', 'Active attempt ID', { nullable: true });
    array(value.publishedGenerations, 'Published generations');
    uniqueRecordIds(value.requiredHumanRequestIds, 'AHR', 'Human Request IDs');
    hash(value.phaseCheckpointSha256, 'Phase checkpoint', { nullable: true });
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    value.publishedGenerations.forEach(validatePublishedGeneration);
  } else if (family === 'auto-attempt') {
    recordId(value.attemptId, 'AAT', 'Attempt ID');
    if (!Number.isSafeInteger(value.attemptNumber) || value.attemptNumber < 1) fail('Attempt number is invalid.', 'AUTO_RECORD_CORRUPT');
    vocabulary(value.attemptKind, AUTO_ATTEMPT_KINDS, 'Attempt kind');
    vocabulary(value.status, AUTO_ATTEMPT_STATUSES, 'Attempt status');
    recordId(value.parentAttemptId, 'AAT', 'Parent attempt ID', { nullable: true });
    for (const field of ['generationIntentSha256', 'taskContractSha256', 'contextManifestSha256', 'executionUnitManifestSha256']) hash(value[field], field);
    for (const field of ['candidateSha256', 'verificationReceiptSha256', 'publicationReceiptSha256']) hash(value[field], field, { nullable: true });
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    validateAttemptBudget(value.budgetImpact);
    validateAttemptResult(value.result);
  } else if (family === 'auto-refusal') {
    recordId(value.refusalId, 'ARF', 'Refusal ID');
    recordId(value.attemptId, 'AAT', 'Refusal attempt ID');
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    validateRefusalSubject(value.subject);
    validateMissingEvidence(value.missing);
    validatePreservedWork(value.preserved);
    if (value.subject.candidateSha256 !== value.preserved.candidateSha256
        || value.subject.verificationReceiptSha256
          !== value.preserved.verificationReceiptSha256) {
      fail('Refusal subject and preserved Candidate authority must match.',
        'AUTO_RECORD_CORRUPT');
    }
    validateRepair(value.repair);
    validateNextAction(value.primaryNextAction);
  } else if (family === 'auto-repair-plan') {
    recordId(value.repairPlanId, 'ARP', 'Repair Plan ID');
    recordId(value.parentAttemptId, 'AAT', 'Repair parent attempt ID');
    hash(value.refusalSha256, 'Repair refusal hash');
    for (const field of ['readScope', 'writeScope', 'forbiddenChanges', 'requiredEvidence']) array(value[field], `Repair ${field}`);
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    for (const field of ['readScope', 'writeScope', 'forbiddenChanges', 'requiredEvidence']) stringSet(value[field], `Repair ${field}`);
    validateRepairBudget(value.budget);
    if (value.attemptNumber !== 1) fail('Repair attempt number is invalid.', 'AUTO_RECORD_CORRUPT');
  } else if (family === 'auto-human-request') {
    recordId(value.requestId, 'AHR', 'Human Request ID');
    recordId(value.attemptId, 'AAT', 'Human Request attempt ID', { nullable: true });
    const requestTypes = Number(value.schemaVersion) <= 2
      ? AUTO_HUMAN_REQUEST_TYPES_V1_V2 : AUTO_HUMAN_REQUEST_TYPES;
    if (!requestTypes.includes(value.requestType)) {
      fail(`Human Request type must be one of: ${requestTypes.join(', ')}.`,
        'AUTO_RECORD_CORRUPT');
    }
    vocabulary(value.status, AUTO_HUMAN_REQUEST_STATUSES, 'Human Request status');
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    validateHumanDetail(value.requestType, value.detail);
    validateHumanOptions(value.requestType, value.options);
    for (const field of ['subjectSha256', 'policySha256', 'checkpointSha256']) hash(value[field], field);
    validateHumanResponse(value.requestType, value.status, value.response, value.options);
  } else if (family === 'auto-token-economics-receipt') {
    recordId(value.attemptId, 'AAT', 'Economics attempt ID');
    hash(value.contextManifestSha256, 'Economics context manifest');
    if (legacyNested) return validateLegacyFamilyShape(family, value);
    validateEconomics(value);
  } else if (family === 'auto-execution-unit-switch') {
    recordId(value.switchPlanId, 'AUS', 'Switch Plan ID');
    recordId(value.parentAttemptId, 'AAT', 'Switch parent attempt ID');
    executionUnitId(value.fromExecutionUnit, 'Switch source Execution Unit');
    executionUnitId(value.toExecutionUnit, 'Switch target Execution Unit');
    hash(value.taskContractSha256, 'Switch Task Contract');
    vocabulary(value.status, AUTO_SWITCH_STATUSES, 'Execution Unit switch status');
    if (value.fromExecutionUnit === value.toExecutionUnit) fail('Execution Unit switch source and target must differ.', 'AUTO_RECORD_CORRUPT');
  }
}

function seal(family, value) {
  const descriptor = FAMILY[family];
  if (!descriptor) fail(`Unknown Auto record family '${family}'.`);
  const record = { ...structuredClone(value), schemaVersion: currentSchemaVersion(family) };
  const sealed = { ...record, [descriptor.hash]: contentHash(record, descriptor.hash) };
  validateFamilyShape(family, sealed);
  return sealed;
}

function validate(family, value, expectedFlightId = null, { legacyNested = false } = {}) {
  const descriptor = FAMILY[family];
  if (!descriptor || value?.kind !== family || value?.mode !== 'auto') {
    fail(`Auto ${family} record has the wrong family.`, 'AUTO_RECORD_CORRUPT');
  }
  if (expectedFlightId && value.flightId !== expectedFlightId) {
    fail(`Auto ${family} record belongs to another flight.`, 'AUTO_RECORD_CORRUPT');
  }
  validateFamilyShape(family, value, { legacyNested });
  if (value[descriptor.hash] !== contentHash(value, descriptor.hash)) {
    fail(`Auto ${family} record failed its integrity check.`, 'AUTO_RECORD_CORRUPT');
  }
  return value;
}

function flightRoot(root, id) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'auto-flights', flightId(id));
}

function recordFile(root, family, id, recordId) {
  const descriptor = FAMILY[family];
  if (!descriptor) fail(`Unknown Auto record family '${family}'.`);
  const normalized = String(recordId ?? '').trim();
  if (!SAFE_ID.test(normalized)) fail(`Invalid ${family} record ID '${normalized}'.`);
  return path.join(flightRoot(root, id), descriptor.directory, `${normalized}.json`);
}

async function writeRecord(root, family, record) {
  const descriptor = FAMILY[family];
  const target = recordFile(root, family, record.flightId, record[descriptor.id]);
  await writeAutoPrivateRecord(root, target, 'auto-p1-record', canonicalJson(record), {
    immutable: !descriptor.mutable
  });
  return record;
}

function immutableMeaning(family, record) {
  const descriptor = FAMILY[family];
  const value = structuredClone(record);
  delete value.createdAt;
  delete value[descriptor.hash];
  return canonicalJson(value);
}

function creationMeaning(family, record) {
  const descriptor = FAMILY[family];
  const value = structuredClone(record);
  delete value.createdAt;
  delete value.updatedAt;
  delete value[descriptor.hash];
  return canonicalJson(value);
}

async function withMutableRecordLock(root, family, flight, recordIdValue, operation) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await withSubjectLock(root, {
        kind: family, id: `${flight}:${recordIdValue}`
      }, operation);
    } catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || attempt === 199) throw error;
      await delay(5);
    }
  }
  throw new Error('unreachable');
}

async function persistMutableRecord(root, family, record) {
  const descriptor = FAMILY[family];
  return withMutableRecordLock(
    root, family, record.flightId, record[descriptor.id], async () => {
      const existing = await readAutoP1Record(
        root, family, record.flightId, record[descriptor.id]
      ).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) {
        if (creationMeaning(family, existing) === creationMeaning(family, record)) {
          return existing;
        }
        fail(`Auto ${family} record ID is already bound to different content.`,
          'AUTO_RECORD_CONFLICT', { recordId: record[descriptor.id] });
      }
      await writeAutoPrivateRecord(
        root,
        recordFile(root, family, record.flightId, record[descriptor.id]),
        'auto-p1-record', canonicalJson(record), { immutable: true }
      );
      return record;
    }
  );
}

function validateMutableUpdate(family, update) {
  const value = objectValue(update, `Auto ${family} update`);
  const allowed = MUTABLE_RECORD_FIELDS[family];
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length) {
    fail(`Auto ${family} update contains immutable or unsupported fields.`,
      'AUTO_RECORD_INVALID', { unknown });
  }
  return structuredClone(value);
}

function updateAlreadyApplied(current, update) {
  return Object.entries(update).every(([field, value]) => (
    canonicalJson(current[field]) === canonicalJson(value)
  ));
}

async function writeImmutableIdempotent(root, family, record) {
  const descriptor = FAMILY[family];
  const reuse = async () => {
    const existing = await readAutoP1Record(
      root, family, record.flightId, record[descriptor.id]
    );
    if (immutableMeaning(family, existing) !== immutableMeaning(family, record)) {
      fail(`Auto ${family} record ID is already bound to different content.`, 'AUTO_RECORD_CONFLICT', {
        recordId: record[descriptor.id]
      });
    }
    return existing;
  };
  try { return await reuse(); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try { return await writeRecord(root, family, record); }
  catch (error) {
    if (error?.code !== 'AUTO_PRIVATE_STORE_CONFLICT') throw error;
    return reuse();
  }
}

export async function readAutoP1Record(root, family, id, recordId) {
  const raw = await readAutoPrivateRecord(
    root, recordFile(root, family, id, recordId), 'auto-p1-record'
  );
  let stored;
  try { stored = JSON.parse(raw); }
  catch (error) {
    fail(`Auto ${family} record is not valid JSON: ${error.message}`, 'AUTO_RECORD_CORRUPT');
  }
  // Verify the bytes under their stored schema before any migration can give them a current stamp.
  validate(family, stored, flightId(id), {
    legacyNested: Number(stored.schemaVersion) < currentSchemaVersion(family)
  });
  return validate(family, readRecord(family, stored).record, flightId(id));
}

export async function listAutoP1Records(root, family, id) {
  const descriptor = FAMILY[family];
  if (!descriptor) fail(`Unknown Auto record family '${family}'.`);
  const directory = path.join(flightRoot(root, id), descriptor.directory);
  const entries = await listAutoPrivateRecords(root, directory);
  const records = [];
  for (const entry of entries.filter((candidate) => candidate.isFile?.() !== false && candidate.name.endsWith('.json'))) {
    const recordId = entry.name.slice(0, -5);
    if (!SAFE_ID.test(recordId)) continue;
    records.push(await readAutoP1Record(root, family, id, recordId));
  }
  return records.sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')));
}

/** Capture the exact validated local lineage that a governed boundary must make portable. */
export async function snapshotAutoP1Records(root, id) {
  const flight = flightId(id);
  return validateAutoP1Snapshot(flight, Object.fromEntries(await Promise.all(
    AUTO_P1_RECORD_FAMILIES.map(async (family) => [family, await listAutoP1Records(root, family, flight)])
  )));
}

/** Verify an embedded lineage snapshot with the same recursively closed family validators as disk. */
export function validateAutoP1Snapshot(id, snapshot) {
  const flight = flightId(id);
  const expected = new Set(AUTO_P1_RECORD_FAMILIES);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || Object.keys(snapshot).some((family) => !expected.has(family))
      || AUTO_P1_RECORD_FAMILIES.some((family) => !Array.isArray(snapshot[family]))) {
    fail('Governed Auto lineage snapshot has an invalid field set.', 'AUTO_RECORD_CORRUPT');
  }
  return Object.freeze(Object.fromEntries(AUTO_P1_RECORD_FAMILIES.map((family) => [
    family,
    snapshot[family].map((stored) => {
      validate(family, stored, flight, {
        legacyNested: Number(stored.schemaVersion) < currentSchemaVersion(family)
      });
      return validate(family, readRecord(family, stored).record, flight);
    })
  ])));
}

/** Restore an Authority-Store-backed lineage snapshot into disposable machine-local storage. */
export async function restoreAutoP1Records(root, id, snapshot) {
  const flight = flightId(id);
  const validated = validateAutoP1Snapshot(flight, snapshot);
  for (const family of AUTO_P1_RECORD_FAMILIES) {
    const descriptor = FAMILY[family];
    for (const record of validated[family]) {
      await writeAutoPrivateRecord(
        root,
        recordFile(root, family, flight, record[descriptor.id]),
        'auto-p1-record',
        canonicalJson(record),
        { immutable: !descriptor.mutable }
      );
    }
  }
  return snapshotAutoP1Records(root, flight);
}

export function buildAutoPhaseRun(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const core = {
    kind: 'auto-phase-run', mode: 'auto', flightId: flightId(value.flightId),
    phase: nonempty(value.phase, 'Auto phase'),
    status: vocabulary(value.status ?? 'planned', AUTO_PHASE_RUN_STATUSES, 'Auto phase-run status'),
    attemptIds: [...new Set(value.attemptIds ?? [])], activeAttemptId: value.activeAttemptId ?? null,
    publishedGenerations: structuredClone(value.publishedGenerations ?? []),
    requiredHumanRequestIds: [...new Set(value.requiredHumanRequestIds ?? [])],
    phaseCheckpointSha256: hash(value.phaseCheckpointSha256, 'Phase checkpoint', { nullable: true }),
    createdAt, updatedAt: value.updatedAt ?? createdAt
  };
  const phaseRunId = value.phaseRunId ?? identifier('APR', {
    flightId: core.flightId, phase: core.phase, createdAt
  });
  return seal('auto-phase-run', { ...core, phaseRunId });
}

export async function persistAutoPhaseRun(root, value, options = {}) {
  return persistMutableRecord(root, 'auto-phase-run', buildAutoPhaseRun(value, options));
}

export async function updateAutoPhaseRun(root, flightIdValue, phaseRunId, update, {
  expectedRecordSha256 = null, now = nowIso
} = {}) {
  const flight = flightId(flightIdValue);
  recordId(phaseRunId, 'APR', 'Phase-run ID');
  if (!HASH.test(String(expectedRecordSha256 ?? ''))) {
    fail('Phase-run mutation requires the exact current record hash.',
      'AUTO_RECORD_CAS_REQUIRED');
  }
  const requested = validateMutableUpdate('auto-phase-run', update);
  return withMutableRecordLock(root, 'auto-phase-run', flight, phaseRunId, async () => {
    const current = await readAutoP1Record(
      root, 'auto-phase-run', flight, phaseRunId
    );
    if (current.recordSha256 !== expectedRecordSha256) {
      if (updateAlreadyApplied(current, requested)) return current;
      fail('Phase-run changed before its update could be recorded.', 'AUTO_PHASE_RUN_STALE', {
        expected: expectedRecordSha256, actual: current.recordSha256
      });
    }
    if (updateAlreadyApplied(current, requested)) return current;
    const next = buildAutoPhaseRun({
      ...current, ...requested, phaseRunId: current.phaseRunId,
      flightId: current.flightId, phase: current.phase, createdAt: current.createdAt,
      updatedAt: now()
    }, { now });
    return writeRecord(root, 'auto-phase-run', next);
  });
}

export function buildAutoAttempt(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const core = {
    kind: 'auto-attempt', mode: 'auto', flightId: flightId(value.flightId),
    phase: nonempty(value.phase, 'Auto attempt phase'),
    attemptNumber: value.attemptNumber,
    attemptKind: vocabulary(value.attemptKind ?? 'initial', AUTO_ATTEMPT_KINDS, 'Auto attempt kind'),
    parentAttemptId: value.parentAttemptId ?? null,
    reason: nonempty(value.reason ?? 'phase-entry', 'Auto attempt reason'),
    generationIntentSha256: hash(value.generationIntentSha256, 'Generation intent'),
    taskContractSha256: hash(value.taskContractSha256, 'Task Contract'),
    contextManifestSha256: hash(value.contextManifestSha256, 'Context Manifest'),
    executionUnitManifestSha256: hash(value.executionUnitManifestSha256, 'Execution Unit manifest'),
    status: vocabulary(value.status ?? 'planned', AUTO_ATTEMPT_STATUSES, 'Auto attempt status'),
    candidateSha256: hash(value.candidateSha256, 'Candidate', { nullable: true }),
    verificationReceiptSha256: hash(value.verificationReceiptSha256, 'Verification receipt', { nullable: true }),
    publicationReceiptSha256: hash(value.publicationReceiptSha256, 'Publication receipt', { nullable: true }),
    budgetImpact: structuredClone(value.budgetImpact ?? {}),
    result: structuredClone(value.result ?? null),
    createdAt, updatedAt: value.updatedAt ?? createdAt
  };
  if (!Number.isInteger(core.attemptNumber) || core.attemptNumber < 1) fail('Auto attemptNumber must be a positive integer.');
  const attemptId = value.attemptId ?? identifier('AAT', {
    flightId: core.flightId, phase: core.phase, attemptNumber: core.attemptNumber,
    parentAttemptId: core.parentAttemptId, reason: core.reason
  });
  return seal('auto-attempt', { ...core, attemptId });
}

export async function persistAutoAttempt(root, value, options = {}) {
  return persistMutableRecord(root, 'auto-attempt', buildAutoAttempt(value, options));
}

export async function updateAutoAttempt(root, flightIdValue, attemptId, update, {
  expectedRecordSha256 = null, now = nowIso
} = {}) {
  const flight = flightId(flightIdValue);
  recordId(attemptId, 'AAT', 'Attempt ID');
  if (!HASH.test(String(expectedRecordSha256 ?? ''))) {
    fail('Attempt mutation requires the exact current record hash.',
      'AUTO_RECORD_CAS_REQUIRED');
  }
  const requested = validateMutableUpdate('auto-attempt', update);
  return withMutableRecordLock(root, 'auto-attempt', flight, attemptId, async () => {
    const current = await readAutoP1Record(root, 'auto-attempt', flight, attemptId);
    if (current.recordSha256 !== expectedRecordSha256) {
      if (updateAlreadyApplied(current, requested)) return current;
      fail('Attempt changed before its update could be recorded.', 'AUTO_ATTEMPT_STALE', {
        expected: expectedRecordSha256, actual: current.recordSha256
      });
    }
    if (updateAlreadyApplied(current, requested)) return current;
    const next = buildAutoAttempt({
      ...current, ...requested, attemptId: current.attemptId,
      flightId: current.flightId, phase: current.phase, attemptNumber: current.attemptNumber,
      attemptKind: current.attemptKind, parentAttemptId: current.parentAttemptId,
      createdAt: current.createdAt, updatedAt: now()
    }, { now });
    return writeRecord(root, 'auto-attempt', next);
  });
}

export function buildAutoRefusal(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const subjectInput = objectValue(value.subject ?? {}, 'Refusal subject');
  const preservedInput = objectValue(value.preserved ?? {}, 'Refusal preserved work');
  const candidateSha256 = subjectInput.candidateSha256
    ?? preservedInput.candidateSha256 ?? null;
  const verificationReceiptSha256 = subjectInput.verificationReceiptSha256
    ?? preservedInput.verificationReceiptSha256 ?? null;
  const core = {
    kind: 'auto-refusal', mode: 'auto', flightId: flightId(value.flightId),
    phase: nonempty(value.phase, 'Auto refusal phase'),
    attemptId: nonempty(value.attemptId, 'Auto refusal attempt'),
    gate: nonempty(value.gate, 'Auto refusal gate'), code: nonempty(value.code, 'Auto refusal code'),
    subject: {
      candidateSha256, verificationReceiptSha256, ...structuredClone(subjectInput)
    },
    missing: structuredClone(value.missing ?? []),
    preserved: {
      candidateSha256,
      verificationReceiptSha256,
      changedPaths: preservedInput.changedPaths ?? (preservedInput.paths ?? []).length,
      paths: structuredClone(preservedInput.paths ?? []),
      workingArea: preservedInput.workingArea ?? true,
      ...structuredClone(preservedInput)
    },
    repair: {
      eligibility: vocabulary(value.repair?.eligibility ?? 'ask-only', AUTO_REPAIR_ELIGIBILITY, 'Repair eligibility'),
      operation: value.repair?.operation ?? 'auto.repair',
      scope: [...new Set(value.repair?.scope ?? [])],
      maximumAttempts: value.repair?.maximumAttempts ?? 1
    },
    primaryNextAction: structuredClone(value.primaryNextAction ?? {
      operation: 'auto.repair', label: 'Review the bounded Repair Plan'
    }),
    createdAt
  };
  const refusalId = value.refusalId ?? identifier('ARF', {
    flightId: core.flightId, attemptId: core.attemptId, gate: core.gate,
    code: core.code, subject: core.subject
  });
  return seal('auto-refusal', { ...core, refusalId });
}

export async function persistAutoRefusal(root, value, options = {}) {
  return writeImmutableIdempotent(root, 'auto-refusal', buildAutoRefusal(value, options));
}

export function buildAutoRepairPlan(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const core = {
    kind: 'auto-repair-plan', mode: 'auto', flightId: flightId(value.flightId),
    parentAttemptId: nonempty(value.parentAttemptId, 'Parent attempt'),
    refusalSha256: hash(value.refusalSha256, 'Refusal'),
    objective: nonempty(value.objective, 'Repair objective'),
    readScope: [...new Set(value.readScope ?? [])], writeScope: [...new Set(value.writeScope ?? [])],
    forbiddenChanges: [...new Set(value.forbiddenChanges ?? [])],
    requiredEvidence: [...new Set(value.requiredEvidence ?? [])],
    budget: {
      maximumAttempts: value.budget?.maximumAttempts ?? 1,
      remainingModelInvocations: value.budget?.remainingModelInvocations ?? 0,
      ...structuredClone(value.budget ?? {})
    },
    attemptNumber: value.attemptNumber ?? 1, createdAt
  };
  if (core.attemptNumber !== 1) fail('AUT v2 permits exactly one automatic repair attempt.');
  const repairPlanId = value.repairPlanId ?? identifier('ARP', {
    flightId: core.flightId, parentAttemptId: core.parentAttemptId, refusalSha256: core.refusalSha256
  });
  return seal('auto-repair-plan', { ...core, repairPlanId });
}

export async function persistAutoRepairPlan(root, value, options = {}) {
  return writeImmutableIdempotent(root, 'auto-repair-plan', buildAutoRepairPlan(value, options));
}

export function buildAutoHumanRequest(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const core = {
    kind: 'auto-human-request', mode: 'auto', flightId: flightId(value.flightId),
    phase: nonempty(value.phase, 'Human Request phase'), attemptId: value.attemptId ?? null,
    requestType: vocabulary(value.requestType, AUTO_HUMAN_REQUEST_TYPES, 'Human Request type'),
    title: nonempty(value.title, 'Human Request title'), detail: structuredClone(value.detail ?? {}),
    options: structuredClone(value.options ?? []),
    subjectSha256: hash(value.subjectSha256, 'Human Request subject'),
    policySha256: hash(value.policySha256, 'Human Request policy'),
    checkpointSha256: hash(value.checkpointSha256, 'Human Request checkpoint'),
    status: vocabulary(value.status ?? 'open', AUTO_HUMAN_REQUEST_STATUSES, 'Human Request status'),
    response: structuredClone(value.response ?? null), createdAt, expiresAt: value.expiresAt ?? null
  };
  const requestId = value.requestId ?? identifier('AHR', {
    flightId: core.flightId, requestType: core.requestType, subjectSha256: core.subjectSha256,
    checkpointSha256: core.checkpointSha256
  });
  return seal('auto-human-request', { ...core, requestId });
}

export async function persistAutoHumanRequest(root, value, options = {}) {
  const request = buildAutoHumanRequest(value, options);
  return withSubjectLock(root, {
    kind: 'auto-human-request', id: `${request.flightId}:${request.requestId}`
  }, async () => {
    let existing = null;
    try {
      existing = await readAutoP1Record(
        root, 'auto-human-request', request.flightId, request.requestId
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (existing) {
      if (existing.status === 'open'
          && immutableMeaning('auto-human-request', existing)
            === immutableMeaning('auto-human-request', request)) {
        return existing;
      }
      fail('Auto Human Request ID is already bound to different or closed content.',
        'AUTO_RECORD_CONFLICT', { requestId: request.requestId });
    }
    const target = recordFile(
      root, 'auto-human-request', request.flightId, request.requestId
    );
    await writeAutoPrivateRecord(
      root, target, 'auto-p1-record', canonicalJson(request), { immutable: true }
    );
    return request;
  });
}

export async function updateAutoHumanRequest(root, flightIdValue, requestId, update, {
  expectedRequestSha256 = null, ...options
} = {}) {
  const flight = flightId(flightIdValue);
  if (expectedRequestSha256 != null) hash(expectedRequestSha256, 'Expected Human Request');
  return withSubjectLock(root, {
    kind: 'auto-human-request', id: `${flight}:${requestId}`
  }, async () => {
    const current = await readAutoP1Record(root, 'auto-human-request', flight, requestId);
    if (expectedRequestSha256 != null && current.requestSha256 !== expectedRequestSha256) {
      fail('Human Request changed before its response could be recorded.',
        'AUTO_HUMAN_REQUEST_STALE', {
          expected: expectedRequestSha256, actual: current.requestSha256
        });
    }
    const next = buildAutoHumanRequest({
      ...current, ...structuredClone(update), requestId: current.requestId,
      flightId: current.flightId, requestType: current.requestType,
      subjectSha256: current.subjectSha256, policySha256: current.policySha256,
      checkpointSha256: current.checkpointSha256, createdAt: current.createdAt
    }, options);
    return writeRecord(root, 'auto-human-request', next);
  });
}

export function buildAutoTokenEconomicsReceipt(value, { now = nowIso } = {}) {
  const record = {
    kind: 'auto-token-economics-receipt', mode: 'auto', flightId: flightId(value.flightId),
    attemptId: nonempty(value.attemptId, 'Economics attempt'),
    contextManifestSha256: hash(value.contextManifestSha256, 'Economics Context Manifest'),
    input: {
      promptBytes: null, estimatedTokens: null, providerTokens: null, cachedTokens: null,
      ...structuredClone(value.input ?? {})
    },
    output: {
      estimatedTokens: null, providerTokens: null, ...structuredClone(value.output ?? {})
    },
    cost: {
      amount: null, currency: 'USD', assurance: 'unavailable', ...structuredClone(value.cost ?? {})
    },
    quality: {
      verification: 'pending', firstPass: false, repairAttempts: 0,
      reviewReturned: false, missingContextIncident: false,
      ...structuredClone(value.quality ?? {})
    },
    classification: nonempty(value.classification ?? 'unavailable', 'Economics classification'),
    worldModelReference: structuredClone(value.worldModelReference ?? null),
    comprehensionReference: structuredClone(value.comprehensionReference ?? null),
    createdAt: value.createdAt ?? now()
  };
  return seal('auto-token-economics-receipt', record);
}

export async function persistAutoTokenEconomicsReceipt(root, value, options = {}) {
  const record = buildAutoTokenEconomicsReceipt(value, options);
  return withSubjectLock(root, {
    kind: 'auto-token-economics', id: `${record.flightId}:${record.attemptId}`
  }, async () => {
    const existing = await readAutoP1Record(
      root, 'auto-token-economics-receipt', record.flightId, record.attemptId
    ).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (existing) {
      if (immutableMeaning('auto-token-economics-receipt', existing)
          !== immutableMeaning('auto-token-economics-receipt', record)) {
        fail('Auto token-economics receipt is already bound to different observations.',
          'AUTO_ECONOMICS_RECEIPT_CONFLICT', { attemptId: record.attemptId });
      }
      return existing;
    }
    return writeRecord(root, 'auto-token-economics-receipt', record);
  });
}

/** Finalize one authored observation by exact compare-and-swap; it cannot be reclassified later. */
export async function updateAutoTokenEconomicsReceipt(root, flightIdValue, attemptId, update, {
  expectedReceiptSha256, now = nowIso
} = {}) {
  const flight = flightId(flightIdValue);
  recordId(attemptId, 'AAT', 'Economics attempt ID');
  const requested = exactObject(update, 'Economics receipt update', ['quality', 'classification']);
  hash(expectedReceiptSha256, 'Expected economics receipt');
  return withSubjectLock(root, {
    kind: 'auto-token-economics', id: `${flight}:${attemptId}`
  }, async () => {
    const current = await readAutoP1Record(
      root, 'auto-token-economics-receipt', flight, attemptId
    );
    const proposed = buildAutoTokenEconomicsReceipt({
      ...current,
      quality: { ...current.quality, ...structuredClone(requested.quality) },
      classification: requested.classification,
      createdAt: current.createdAt
    }, { now });
    const same = immutableMeaning('auto-token-economics-receipt', current)
      === immutableMeaning('auto-token-economics-receipt', proposed);
    if (current.receiptSha256 !== expectedReceiptSha256) {
      if (same && current.quality.verification !== 'pending') return current;
      fail('Auto token-economics receipt changed before finalization.',
        'AUTO_ECONOMICS_RECEIPT_STALE', {
          expected: expectedReceiptSha256, actual: current.receiptSha256
        });
    }
    if (current.quality.verification !== 'pending') {
      if (same) return current;
      fail('Auto token-economics quality is already final and cannot be reclassified.',
        'AUTO_ECONOMICS_RECEIPT_FINALIZED', { receiptSha256: current.receiptSha256 });
    }
    if (proposed.quality.verification === 'pending') {
      fail('Auto token-economics finalization requires a passed or failed verification result.',
        'AUTO_ECONOMICS_RECEIPT_NOT_FINAL');
    }
    return writeRecord(root, 'auto-token-economics-receipt', proposed);
  });
}

export function buildAutoExecutionUnitSwitch(value, { now = nowIso } = {}) {
  const createdAt = value.createdAt ?? now();
  const core = {
    kind: 'auto-execution-unit-switch', mode: 'auto', flightId: flightId(value.flightId),
    fromExecutionUnit: nonempty(value.fromExecutionUnit, 'Current Execution Unit'),
    toExecutionUnit: nonempty(value.toExecutionUnit, 'Requested Execution Unit'),
    taskContractSha256: hash(value.taskContractSha256, 'Switch Task Contract'),
    parentAttemptId: nonempty(value.parentAttemptId, 'Switch parent attempt'),
    reason: nonempty(value.reason, 'Switch reason'),
    status: vocabulary(value.status ?? 'proposed', AUTO_SWITCH_STATUSES, 'Execution Unit switch status'),
    createdAt
  };
  const switchPlanId = value.switchPlanId ?? identifier('AUS', {
    flightId: core.flightId, fromExecutionUnit: core.fromExecutionUnit,
    toExecutionUnit: core.toExecutionUnit, taskContractSha256: core.taskContractSha256,
    parentAttemptId: core.parentAttemptId
  });
  return seal('auto-execution-unit-switch', { ...core, switchPlanId });
}

export async function persistAutoExecutionUnitSwitch(root, value, options = {}) {
  return writeRecord(root, 'auto-execution-unit-switch', buildAutoExecutionUnitSwitch(value, options));
}

export async function updateAutoExecutionUnitSwitch(root, flightIdValue, switchPlanId, update, {
  expectedSwitchPlanSha256 = null, ...options
} = {}) {
  const flight = flightId(flightIdValue);
  if (expectedSwitchPlanSha256 != null) hash(expectedSwitchPlanSha256, 'Expected switch Plan');
  return withSubjectLock(root, {
    kind: 'auto-execution-unit-switch', id: `${flight}:${switchPlanId}`
  }, async () => {
    const current = await readAutoP1Record(
      root, 'auto-execution-unit-switch', flight, switchPlanId
    );
    if (expectedSwitchPlanSha256 != null
        && current.switchPlanSha256 !== expectedSwitchPlanSha256) {
      fail('Execution Unit switch changed before it could be applied.', 'AUTO_SWITCH_STALE', {
        expected: expectedSwitchPlanSha256, actual: current.switchPlanSha256
      });
    }
    const next = buildAutoExecutionUnitSwitch({
      ...current, ...structuredClone(update), switchPlanId: current.switchPlanId,
      flightId: current.flightId, fromExecutionUnit: current.fromExecutionUnit,
      toExecutionUnit: current.toExecutionUnit, taskContractSha256: current.taskContractSha256,
      parentAttemptId: current.parentAttemptId, createdAt: current.createdAt
    }, options);
    return writeRecord(root, 'auto-execution-unit-switch', next);
  });
}

export function autoRecordDigest(value, field = 'recordSha256') {
  return contentHash(value, field);
}
