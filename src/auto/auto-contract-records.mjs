/** Immutable AUT v2 context, task, route, and normalized execution-event records. */
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { nowIso, SingularityFlowError } from '../util.mjs';
import {
  listAutoPrivateRecords, readAutoPrivateRecord, writeAutoPrivateRecord
} from './auto-private-store.mjs';

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const ATTEMPT_ID = /^AAT-[A-F0-9]{26}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const RECORD_ID = /^(?:ACM|ATC|AES|AEV)-[A-F0-9]{26}$/;
const PHASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_TYPES = Object.freeze([
  'execution.started', 'execution.progress', 'execution.message',
  'execution.file-observed', 'execution.tool-intent', 'execution.tool-result',
  'execution.subagent', 'execution.budget', 'execution.stop-requested',
  'execution.stopped', 'execution.quiesced', 'execution.failed',
  'execution.completed', 'provider.unknown'
]);
const NORMALIZED_EVENT_STATUS = Object.freeze({
  'execution.started': 'started',
  'execution.stop-requested': 'stop-requested',
  'execution.stopped': 'stopped',
  'execution.quiesced': 'quiesced',
  'execution.failed': 'failed',
  'execution.completed': 'completed'
});
const TERMINAL_EVENT_TYPES = new Set([
  'execution.stopped', 'execution.failed', 'execution.completed'
]);
const PHASE_CONTRACT_FIELDS = Object.freeze([
  'attemptId', 'generation', 'generationIntentId', 'contextContractSha256',
  'taskContractSha256', 'executionUnitContractSha256',
  'executionSelectionSha256', 'contextManifest', 'taskContract',
  'executionSelection', 'allowedTools', 'contractSha256'
]);

const FAMILY = Object.freeze({
  'auto-context-manifest': {
    directory: 'context-manifests', id: 'contextManifestId', prefix: 'ACM', hash: 'manifestSha256'
  },
  'auto-agent-task-contract': {
    directory: 'task-contracts', id: 'taskContractId', prefix: 'ATC', hash: 'contractSha256'
  },
  'auto-execution-selection': {
    directory: 'execution-selections', id: 'selectionId', prefix: 'AES', hash: 'selectionSha256'
  },
  'auto-execution-event': {
    directory: 'execution-events', id: 'eventId', prefix: 'AEV', hash: 'eventSha256'
  }
});

export const AUTO_CONTRACT_RECORD_FAMILIES = Object.freeze(Object.keys(FAMILY));
export const AUTO_EXECUTION_EVENT_TYPES = EVENT_TYPES;

function fail(message, code = 'AUTO_CONTRACT_RECORD_INVALID', details = {}) {
  throw new SingularityFlowError(message, { code, details });
}

function digest(value) { return `sha256:${recordSha256(value)}`; }

function validDateTime(value) {
  const matched = typeof value === 'string' ? RFC3339_DATE_TIME.exec(value) : null;
  const date = matched
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value)
    : null;
  const [, year, month, day, hour, minute, second] = date ?? [];
  const maximumDay = date
    ? new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()
    : 0;
  return Boolean(matched) && Number.isFinite(Date.parse(value))
    && Number(month) >= 1 && Number(month) <= 12
    && Number(day) >= 1 && Number(day) <= maximumDay
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function contentHash(record, field) {
  const core = structuredClone(record);
  delete core[field];
  return digest(core);
}

function identifier(prefix, identity) {
  return `${prefix}-${recordSha256(identity).slice(0, 26).toUpperCase()}`;
}

function nonempty(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string.`,
    'AUTO_CONTRACT_RECORD_CORRUPT');
  const normalized = value.trim();
  if (!normalized) fail(`${label} is required.`);
  return normalized;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`, 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail(`${label} has an invalid field set.`, 'AUTO_CONTRACT_RECORD_CORRUPT', {
      unknown, missing
    });
  }
  return value;
}

function stringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
      || value.some((entry) => typeof entry !== 'string' || !entry.trim())
      || new Set(value).size !== value.length) {
    fail(`${label} must be a ${allowEmpty ? '' : 'non-empty '}unique string array.`,
      'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  return value;
}

function relativeScopeArray(value, label, { allowEmpty = true } = {}) {
  stringArray(value, label, { allowEmpty });
  for (const entry of value) {
    const supplied = entry.trim();
    const normalized = supplied.replaceAll('\\', '/');
    if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(supplied)
        || /^[A-Za-z]:/.test(normalized)
        || normalized === '..' || normalized.startsWith('../')
        || normalized.includes('/../')) {
      fail(`${label} must contain only repository-relative scope.`,
        'AUTO_CONTRACT_RECORD_CORRUPT');
    }
  }
  return value;
}

function common(record, family) {
  const descriptor = FAMILY[family];
  if (!descriptor || record?.kind !== family || record?.mode !== 'auto') {
    fail(`Auto ${family} record has the wrong family.`, 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  if (!FLIGHT_ID.test(String(record.flightId ?? ''))
      || !ATTEMPT_ID.test(String(record.attemptId ?? ''))
      || !PHASE.test(String(record.phase ?? ''))
      || !new RegExp(`^${descriptor.prefix}-[A-F0-9]{26}$`).test(
        String(record[descriptor.id] ?? '')
      )
      || typeof record.createdAt !== 'string'
      || !validDateTime(record.createdAt)) {
    fail(`Auto ${family} record identity is invalid.`, 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  if (!HASH.test(String(record[descriptor.hash] ?? ''))
      || record[descriptor.hash] !== contentHash(record, descriptor.hash)) {
    fail(`Auto ${family} record failed its integrity check.`,
      'AUTO_CONTRACT_RECORD_CORRUPT');
  }
}

function validateContextSection(section) {
  exactObject(section, [
    'id', 'sourceRef', 'contentSha256', 'representation',
    'estimatedTokens', 'mandatory'
  ], 'Auto Context Manifest section');
  nonempty(section.id, 'Context section ID');
  nonempty(section.sourceRef, 'Context section source reference');
  if (!HASH.test(String(section.contentSha256 ?? ''))
      || !Number.isSafeInteger(section.estimatedTokens) || section.estimatedTokens < 0
      || typeof section.mandatory !== 'boolean') {
    fail('Auto Context Manifest section is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  nonempty(section.representation, 'Context section representation');
}

function validateOmission(omission) {
  exactObject(omission, ['id', 'reason'], 'Auto Context Manifest omission');
  nonempty(omission.id, 'Context omission ID');
  nonempty(omission.reason, 'Context omission reason');
}

function validateContextManifest(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'mode', 'contextManifestId', 'flightId', 'attemptId',
    'phase', 'sections', 'omitted', 'expansionPolicySha256', 'budgetSha256',
    'createdAt', 'manifestSha256'
  ], 'Auto Context Manifest');
  common(record, 'auto-context-manifest');
  if (!Array.isArray(record.sections) || !record.sections.length
      || !Array.isArray(record.omitted)
      || !HASH.test(String(record.expansionPolicySha256 ?? ''))
      || !HASH.test(String(record.budgetSha256 ?? ''))) {
    fail('Auto Context Manifest is incomplete.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  record.sections.forEach(validateContextSection);
  record.omitted.forEach(validateOmission);
  const sectionIds = record.sections.map((entry) => entry.id);
  const omittedIds = record.omitted.map((entry) => entry.id);
  if (new Set(sectionIds).size !== sectionIds.length
      || new Set(omittedIds).size !== omittedIds.length
      || omittedIds.some((id) => sectionIds.includes(id))) {
    fail('Auto Context Manifest section and omission IDs must be unique and disjoint.',
      'AUTO_CONTRACT_RECORD_CORRUPT');
  }
}

function validateBudgets(value) {
  exactObject(value, [
    'maximumTouchedPaths', 'maximumTouchedChanges', 'maximumModelInvocations',
    'maximumTotalTokens', 'tokenAssurance'
  ], 'Auto Task Contract budgets');
  for (const key of [
    'maximumTouchedPaths', 'maximumTouchedChanges', 'maximumModelInvocations',
    'maximumTotalTokens'
  ]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) {
      fail(`Auto Task Contract budget '${key}' is invalid.`,
        'AUTO_CONTRACT_RECORD_CORRUPT');
    }
  }
  if (!['exact-required', 'best-available'].includes(value.tokenAssurance)) {
    fail('Auto Task Contract token assurance is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
}

function validateTaskContract(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'mode', 'taskContractId', 'flightId', 'attemptId',
    'phase', 'objective', 'acceptanceClauses', 'readScope', 'writeScope',
    'protectedScope', 'forbiddenScope', 'allowedTools', 'requiredOutputs',
    'requiredEvidence', 'budgets', 'stopConditions', 'createdAt', 'contractSha256'
  ], 'Auto Agent Task Contract');
  common(record, 'auto-agent-task-contract');
  nonempty(record.objective, 'Auto Task Contract objective');
  for (const [field, allowEmpty] of [
    ['acceptanceClauses', true], ['readScope', false], ['writeScope', false],
    ['protectedScope', true], ['forbiddenScope', false], ['allowedTools', false],
    ['requiredOutputs', false], ['requiredEvidence', true], ['stopConditions', false]
  ]) stringArray(record[field], `Auto Task Contract ${field}`, { allowEmpty });
  for (const [field, allowEmpty] of [
    ['readScope', false], ['writeScope', false],
    ['protectedScope', true], ['forbiddenScope', false]
  ]) relativeScopeArray(record[field], `Auto Task Contract ${field}`, { allowEmpty });
  validateBudgets(record.budgets);
}

function validateExecutionSelection(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'mode', 'selectionId', 'flightId', 'attemptId',
    'phase', 'executionUnitId', 'manifestSha256', 'reason', 'createdAt',
    'selectionSha256'
  ], 'Auto Execution Selection');
  common(record, 'auto-execution-selection');
  nonempty(record.executionUnitId, 'Execution Unit ID');
  nonempty(record.reason, 'Execution Unit selection reason');
  if (!HASH.test(String(record.manifestSha256 ?? ''))) {
    fail('Execution Unit manifest hash is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
}

function validateExecutionEvent(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'mode', 'eventId', 'flightId', 'attemptId', 'phase',
    'sequence', 'eventType', 'executionSelectionSha256', 'taskContractSha256',
    'observation', 'rawEvidence', 'createdAt', 'eventSha256'
  ], 'Auto Execution Event');
  common(record, 'auto-execution-event');
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1
      || !EVENT_TYPES.includes(record.eventType)
      || !HASH.test(String(record.executionSelectionSha256 ?? ''))
      || !HASH.test(String(record.taskContractSha256 ?? ''))) {
    fail('Auto Execution Event boundary is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  exactObject(record.observation, [
    'status', 'invocationId', 'code', 'usageSha256'
  ], 'Auto Execution Event observation');
  nonempty(record.observation.status, 'Execution observation status');
  if (record.observation.invocationId != null) {
    nonempty(record.observation.invocationId, 'Execution observation invocation ID');
  }
  const normalizedStatus = NORMALIZED_EVENT_STATUS[record.eventType];
  if (normalizedStatus && record.observation.status !== normalizedStatus) {
    fail(
      `Auto Execution Event '${record.eventType}' requires observation status '${normalizedStatus}'.`,
      'AUTO_CONTRACT_RECORD_CORRUPT'
    );
  }
  if (record.observation.code != null) nonempty(record.observation.code, 'Execution observation code');
  if (record.observation.usageSha256 != null
      && !HASH.test(String(record.observation.usageSha256))) {
    fail('Execution observation usage hash is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  exactObject(record.rawEvidence, ['status', 'sha256', 'reason'],
    'Auto Execution Event raw evidence');
  const evidenceReason = record.rawEvidence.reason;
  if (!['hash-linked', 'unavailable'].includes(record.rawEvidence.status)
      || (record.rawEvidence.status === 'hash-linked'
        && !HASH.test(String(record.rawEvidence.sha256 ?? '')))
      || (record.rawEvidence.status === 'unavailable'
        && (record.rawEvidence.sha256 != null
          || typeof evidenceReason !== 'string' || !evidenceReason.trim()))
      || (evidenceReason != null
        && (typeof evidenceReason !== 'string' || !evidenceReason.trim()))) {
    fail('Auto Execution Event raw evidence is invalid.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
}

/** Validate exact monotonic event streams independently for every authoring attempt. */
export function validateAutoExecutionEventStreams(records, { requireQuiescence = false } = {}) {
  if (!Array.isArray(records)) {
    fail('Auto Execution Event stream must be an array.', 'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  const groups = new Map();
  for (const record of records) {
    validateExecutionEvent(record);
    const entries = groups.get(record.attemptId) ?? [];
    entries.push(record);
    groups.set(record.attemptId, entries);
  }
  for (const [attemptId, unsorted] of groups) {
    const stream = [...unsorted].sort((left, right) => left.sequence - right.sequence);
    const authority = stream[0];
    for (let index = 0; index < stream.length; index += 1) {
      const event = stream[index];
      if (event.sequence !== index + 1) {
        fail(`Auto execution attempt '${attemptId}' has a non-contiguous event sequence.`,
          'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
      }
      if (event.flightId !== authority.flightId || event.phase !== authority.phase
          || event.executionSelectionSha256 !== authority.executionSelectionSha256
          || event.taskContractSha256 !== authority.taskContractSha256) {
        fail(`Auto execution attempt '${attemptId}' changes authority within its event stream.`,
          'AUTO_EXECUTION_EVENT_AUTHORITY_CONFLICT');
      }
    }
    if (stream[0]?.eventType !== 'execution.started'
        || stream.filter((event) => event.eventType === 'execution.started').length !== 1) {
      fail(`Auto execution attempt '${attemptId}' must begin with exactly one started event.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
    const terminalIndexes = stream.flatMap((event, index) => (
      TERMINAL_EVENT_TYPES.has(event.eventType) ? [index] : []
    ));
    if (terminalIndexes.length > 1) {
      fail(`Auto execution attempt '${attemptId}' has conflicting terminal events.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
    const stoppedIndex = stream.findIndex((event) => event.eventType === 'execution.stopped');
    if (stoppedIndex >= 0 && !stream.slice(0, stoppedIndex).some((event) => (
      event.eventType === 'execution.stop-requested'
    ))) {
      fail(`Auto execution attempt '${attemptId}' stopped without a prior stop request.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
    const stopRequests = stream.filter((event) => (
      event.eventType === 'execution.stop-requested'
    ));
    if (stopRequests.length > 1) {
      fail(`Auto execution attempt '${attemptId}' has multiple stop requests.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
    const quiescedIndexes = stream.flatMap((event, index) => (
      event.eventType === 'execution.quiesced' ? [index] : []
    ));
    if (quiescedIndexes.length > 1
        || (quiescedIndexes.length === 1 && (
          terminalIndexes.length !== 1
          || quiescedIndexes[0] !== terminalIndexes[0] + 1
          || quiescedIndexes[0] !== stream.length - 1
        ))) {
      fail(`Auto execution attempt '${attemptId}' has invalid quiescence ordering.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
    if (stopRequests.length === 1 && terminalIndexes.length === 1) {
      const stopEvidence = stopRequests[0].rawEvidence;
      const terminal = stream[terminalIndexes[0]];
      const quiesced = quiescedIndexes.length === 1 ? stream[quiescedIndexes[0]] : null;
      if (stopEvidence.status !== 'hash-linked' || !HASH.test(String(stopEvidence.sha256 ?? ''))
          || terminal.rawEvidence.status !== 'hash-linked'
          || terminal.rawEvidence.sha256 !== stopEvidence.sha256
          || (quiesced && (quiesced.rawEvidence.status !== 'hash-linked'
            || quiesced.rawEvidence.sha256 !== stopEvidence.sha256))) {
        fail(`Auto execution attempt '${attemptId}' changed stop authority before quiescence.`,
          'AUTO_EXECUTION_EVENT_AUTHORITY_CONFLICT');
      }
    }
    if (requireQuiescence
        && (terminalIndexes.length !== 1 || quiescedIndexes.length !== 1)) {
      fail(`Auto execution attempt '${attemptId}' has not reached terminal quiescence.`,
        'AUTO_EXECUTION_EVENT_QUIESCENCE_UNPROVEN');
    }
    if (terminalIndexes.length === 1 && terminalIndexes[0] !== stream.length - 1
        && quiescedIndexes.length === 0) {
      fail(`Auto execution attempt '${attemptId}' records events after termination.`,
        'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
    }
  }
  return records;
}

/** Merge sealed event projections without allowing same-ID or stream-authority drift. */
export function mergeAutoExecutionEventRecords(existing = [], additions = []) {
  const byId = new Map(existing.map((record) => [record.eventId, structuredClone(record)]));
  for (const record of additions) {
    validateExecutionEvent(record);
    const prior = byId.get(record.eventId);
    if (prior && prior.eventSha256 !== record.eventSha256) {
      fail(`Auto execution event '${record.eventId}' changed after it was recorded.`,
        'AUTO_EXECUTION_EVENT_CONFLICT');
    }
    byId.set(record.eventId, structuredClone(record));
  }
  const merged = [...byId.values()].sort((left, right) => (
    left.attemptId.localeCompare(right.attemptId)
      || left.sequence - right.sequence
      || left.eventId.localeCompare(right.eventId)
  ));
  validateAutoExecutionEventStreams(merged);
  return merged;
}

const VALIDATOR = Object.freeze({
  'auto-context-manifest': validateContextManifest,
  'auto-agent-task-contract': validateTaskContract,
  'auto-execution-selection': validateExecutionSelection,
  'auto-execution-event': validateExecutionEvent
});

/** Migrate and validate one durable Auto contract record without writing any bytes. */
export function validateAutoContractRecord(family, value) {
  if (!FAMILY[family]) fail(`Unknown Auto contract record family '${family}'.`,
    'AUTO_CONTRACT_RECORD_CORRUPT');
  const current = readRecord(family, value).record;
  VALIDATOR[family](current);
  return Object.freeze(structuredClone(current));
}

function phaseContractKey(contract, suffix = 'initial') {
  const intent = contract.generationIntentId ?? 'no-intent';
  return `${contract.taskContract.phase}@${contract.generation}@${intent}@${suffix}`;
}

/** Validate one immutable composite phase-contract snapshot and all nested pointers. */
export function validateAutoPhaseContractSnapshot(value, {
  mapKey = null, flightId = null
} = {}) {
  exactObject(value, PHASE_CONTRACT_FIELDS, 'Auto phase-contract snapshot');
  if (!ATTEMPT_ID.test(String(value.attemptId ?? ''))
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || (value.generationIntentId != null
        && (typeof value.generationIntentId !== 'string'
          || !value.generationIntentId || value.generationIntentId.includes('@')))
      || ![value.contextContractSha256, value.taskContractSha256,
        value.executionUnitContractSha256, value.executionSelectionSha256,
        value.contractSha256].every((entry) => HASH.test(String(entry ?? '')))) {
    fail('Auto phase-contract snapshot identity is invalid.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  const core = structuredClone(value);
  delete core.contractSha256;
  if (value.contractSha256 !== digest(core)) {
    fail('Auto phase-contract snapshot failed its top-level integrity check.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  const contextManifest = validateAutoContractRecord(
    'auto-context-manifest', value.contextManifest
  );
  const taskContract = validateAutoContractRecord(
    'auto-agent-task-contract', value.taskContract
  );
  const executionSelection = validateAutoContractRecord(
    'auto-execution-selection', value.executionSelection
  );
  // A nested migration that changes bytes also changes its pointer and the enclosing hash. Until
  // the composite itself has a registered migration, never silently rewrite that authority.
  if (canonicalJson(contextManifest) !== canonicalJson(value.contextManifest)
      || canonicalJson(taskContract) !== canonicalJson(value.taskContract)
      || canonicalJson(executionSelection) !== canonicalJson(value.executionSelection)) {
    fail('Auto phase-contract snapshot requires a governed composite migration.',
      'AUTO_PHASE_CONTRACT_MIGRATION_REQUIRED');
  }
  const identities = [contextManifest, taskContract, executionSelection];
  const expectedFlightId = flightId ?? contextManifest.flightId;
  if (!FLIGHT_ID.test(String(expectedFlightId ?? ''))
      || identities.some((record) => record.flightId !== expectedFlightId
        || record.attemptId !== value.attemptId
        || record.phase !== taskContract.phase)
      || contextManifest.contextManifestId !== identifier('ACM', {
        flightId: expectedFlightId, attemptId: value.attemptId, phase: taskContract.phase
      })
      || taskContract.taskContractId !== identifier('ATC', {
        flightId: expectedFlightId, attemptId: value.attemptId, phase: taskContract.phase
      })
      || executionSelection.selectionId !== identifier('AES', {
        flightId: expectedFlightId, attemptId: value.attemptId, phase: taskContract.phase
      })) {
    fail('Auto phase-contract nested identities do not match.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  if (value.contextContractSha256 !== contextManifest.manifestSha256
      || value.taskContractSha256 !== taskContract.contractSha256
      || value.executionSelectionSha256 !== executionSelection.selectionSha256
      || canonicalJson(value.allowedTools) !== canonicalJson(taskContract.allowedTools)) {
    fail('Auto phase-contract nested hash pointers do not match.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  stringArray(value.allowedTools, 'Auto phase-contract allowed tools', { allowEmpty: false });
  if (mapKey != null) {
    if (typeof mapKey !== 'string' || !mapKey) {
      fail('Auto phase-contract map key is invalid.', 'AUTO_PHASE_CONTRACT_CORRUPT');
    }
    const initial = phaseContractKey(value);
    const repairPrefix = phaseContractKey(value, 'repair:');
    const repairId = mapKey.startsWith(repairPrefix)
      ? mapKey.slice(repairPrefix.length) : null;
    if (mapKey !== initial && !/^ARP-[A-F0-9]{26}$/.test(String(repairId ?? ''))) {
      fail(`Auto phase-contract map key '${mapKey}' does not match its snapshot.`,
        'AUTO_PHASE_CONTRACT_CORRUPT');
    }
  }
  return Object.freeze({
    ...structuredClone(value), contextManifest, taskContract, executionSelection
  });
}

/** Validate a complete checkpoint/state projection, including every event authority reference. */
export function validateAutoPhaseContractSnapshots(phaseContracts = {}, executionEvents = [], {
  flightId = null, activeContractSha256 = null, requireTerminalQuiescence = false
} = {}) {
  if (!phaseContracts || typeof phaseContracts !== 'object' || Array.isArray(phaseContracts)
      || !Array.isArray(executionEvents)) {
    fail('Auto phase-contract snapshot projection is invalid.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  const contracts = {};
  const byAttempt = new Map();
  for (const [key, value] of Object.entries(phaseContracts)) {
    const contract = validateAutoPhaseContractSnapshot(value, { mapKey: key, flightId });
    if (byAttempt.has(contract.attemptId)) {
      fail(`Auto attempt '${contract.attemptId}' has multiple phase-contract snapshots.`,
        'AUTO_PHASE_CONTRACT_CORRUPT');
    }
    byAttempt.set(contract.attemptId, contract);
    contracts[key] = contract;
  }
  if (activeContractSha256 != null
      && (!HASH.test(String(activeContractSha256))
        || !Object.values(contracts).some((contract) => (
          contract.contractSha256 === activeContractSha256
        )))) {
    fail('Active phase-contract pointer does not reference the snapshot map.',
      'AUTO_PHASE_CONTRACT_CORRUPT');
  }
  const events = executionEvents.map((event) => (
    validateAutoContractRecord('auto-execution-event', event)
  ));
  validateAutoExecutionEventStreams(events, {
    requireQuiescence: requireTerminalQuiescence
  });
  for (const event of events) {
    const contract = byAttempt.get(event.attemptId);
    if (!contract || event.flightId !== contract.contextManifest.flightId
        || event.phase !== contract.taskContract.phase
        || event.taskContractSha256 !== contract.taskContractSha256
        || event.executionSelectionSha256 !== contract.executionSelectionSha256) {
      fail(`Auto execution event '${event.eventId}' does not reference its exact phase contract.`,
        'AUTO_EXECUTION_EVENT_AUTHORITY_CONFLICT');
    }
  }
  return Object.freeze({
    phaseContracts: Object.freeze(contracts), executionEvents: Object.freeze(events)
  });
}

function seal(family, value) {
  const descriptor = FAMILY[family];
  const record = {
    ...structuredClone(value), schemaVersion: currentSchemaVersion(family)
  };
  record[descriptor.hash] = contentHash(record, descriptor.hash);
  VALIDATOR[family](record);
  return Object.freeze(record);
}

function recordRoot(root, flightId) {
  if (!FLIGHT_ID.test(String(flightId ?? ''))) fail('Auto contract flight ID is invalid.');
  return path.join(gitCommonDir(root), 'singularity-flow', 'auto-flights', flightId);
}

function recordFile(root, family, flightId, recordId) {
  const descriptor = FAMILY[family];
  if (!descriptor || !RECORD_ID.test(String(recordId ?? ''))
      || !String(recordId).startsWith(`${descriptor.prefix}-`)) {
    fail(`Auto ${family} record ID is invalid.`);
  }
  return path.join(recordRoot(root, flightId), descriptor.directory, `${recordId}.json`);
}

function recordMeaning(family, record) {
  const descriptor = FAMILY[family];
  const value = structuredClone(record);
  delete value.createdAt;
  delete value[descriptor.hash];
  return canonicalJson(value);
}

async function persist(root, family, record) {
  const descriptor = FAMILY[family];
  const target = recordFile(root, family, record.flightId, record[descriptor.id]);
  return withSubjectLock(root, {
    kind: family, id: `${record.flightId}:${record[descriptor.id]}`
  }, async () => {
    const existing = await readAutoContractRecord(
      root, family, record.flightId, record[descriptor.id]
    ).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing) {
      if (recordMeaning(family, existing) !== recordMeaning(family, record)) {
        fail(`Auto ${family} record ID is already bound to different content.`,
          'AUTO_CONTRACT_RECORD_CONFLICT');
      }
      return existing;
    }
    await writeAutoPrivateRecord(root, target, 'auto-p1-record', canonicalJson(record), {
      immutable: true
    });
    return record;
  });
}

function baseRecord(family, value, idField, prefix, identity, now) {
  return {
    kind: family, mode: 'auto',
    [idField]: value[idField] ?? identifier(prefix, identity),
    flightId: value.flightId, attemptId: value.attemptId, phase: value.phase,
    createdAt: value.createdAt ?? now()
  };
}

export function buildAutoContextManifest(value, { now = nowIso } = {}) {
  const base = baseRecord(
    'auto-context-manifest', value, 'contextManifestId', 'ACM',
    { flightId: value.flightId, attemptId: value.attemptId, phase: value.phase }, now
  );
  return seal('auto-context-manifest', {
    ...base,
    sections: structuredClone(value.sections ?? []),
    omitted: structuredClone(value.omitted ?? []),
    expansionPolicySha256: value.expansionPolicySha256,
    budgetSha256: value.budgetSha256
  });
}

export function buildAutoAgentTaskContract(value, { now = nowIso } = {}) {
  const base = baseRecord(
    'auto-agent-task-contract', value, 'taskContractId', 'ATC',
    { flightId: value.flightId, attemptId: value.attemptId, phase: value.phase }, now
  );
  return seal('auto-agent-task-contract', {
    ...base,
    objective: value.objective,
    acceptanceClauses: [...new Set(value.acceptanceClauses ?? [])],
    readScope: [...new Set(value.readScope ?? [])],
    writeScope: [...new Set(value.writeScope ?? [])],
    protectedScope: [...new Set(value.protectedScope ?? [])],
    forbiddenScope: [...new Set(value.forbiddenScope ?? [])],
    allowedTools: [...new Set(value.allowedTools ?? [])],
    requiredOutputs: [...new Set(value.requiredOutputs ?? [])],
    requiredEvidence: [...new Set(value.requiredEvidence ?? [])],
    budgets: structuredClone(value.budgets),
    stopConditions: [...new Set(value.stopConditions ?? [])]
  });
}

export function buildAutoExecutionSelection(value, { now = nowIso } = {}) {
  const base = baseRecord(
    'auto-execution-selection', value, 'selectionId', 'AES',
    { flightId: value.flightId, attemptId: value.attemptId, phase: value.phase }, now
  );
  return seal('auto-execution-selection', {
    ...base,
    executionUnitId: value.executionUnitId,
    manifestSha256: value.manifestSha256,
    reason: value.reason
  });
}

export function buildAutoExecutionEvent(value, { now = nowIso } = {}) {
  const base = baseRecord(
    'auto-execution-event', value, 'eventId', 'AEV', {
      flightId: value.flightId, attemptId: value.attemptId,
      sequence: value.sequence, eventType: value.eventType
    }, now
  );
  const rawStatus = value.rawEvidence?.status ?? 'unavailable';
  return seal('auto-execution-event', {
    ...base,
    sequence: value.sequence,
    eventType: value.eventType,
    executionSelectionSha256: value.executionSelectionSha256,
    taskContractSha256: value.taskContractSha256,
    observation: {
      status: value.observation?.status,
      invocationId: value.observation?.invocationId ?? null,
      code: value.observation?.code ?? null,
      usageSha256: value.observation?.usageSha256 ?? null
    },
    rawEvidence: {
      status: rawStatus,
      sha256: value.rawEvidence?.sha256 ?? null,
      reason: value.rawEvidence?.reason
        ?? (rawStatus === 'unavailable'
          ? 'provider event stream was not exposed by the adapter' : null)
    }
  });
}

export async function persistAutoContextManifest(root, value, options = {}) {
  return persist(root, 'auto-context-manifest', buildAutoContextManifest(value, options));
}

export async function persistAutoAgentTaskContract(root, value, options = {}) {
  return persist(root, 'auto-agent-task-contract', buildAutoAgentTaskContract(value, options));
}

export async function persistAutoExecutionSelection(root, value, options = {}) {
  return persist(root, 'auto-execution-selection', buildAutoExecutionSelection(value, options));
}

export async function persistAutoExecutionEvent(root, value, options = {}) {
  return persist(root, 'auto-execution-event', buildAutoExecutionEvent(value, options));
}

function sameTransition(left, right) {
  return left.eventType === right.eventType
    && left.observation.status === right.observation.status
    && left.observation.invocationId === (right.observation.invocationId ?? null)
    && left.observation.code === (right.observation.code ?? null)
    && left.observation.usageSha256 === (right.observation.usageSha256 ?? null)
    && left.rawEvidence.status === right.rawEvidence.status
    && left.rawEvidence.sha256 === (right.rawEvidence.sha256 ?? null)
    && left.rawEvidence.reason === (right.rawEvidence.reason ?? null);
}

/**
 * Append normalized transitions under one per-attempt lease. Sequence allocation and replay are
 * therefore exact even when a human stop and the executor observe the same interrupt together.
 */
export async function persistAutoExecutionTransitions(root, authority, transitions) {
  if (!authority || !Array.isArray(transitions) || !transitions.length) {
    fail('Auto execution transitions require exact authority and at least one event.');
  }
  const subject = {
    kind: 'auto-execution-event-stream',
    id: `${authority.flightId}:${authority.attemptId}`
  };
  const persistLocked = async () => {
    let stream = (await listAutoContractRecords(
      root, 'auto-execution-event', authority.flightId
    )).filter((record) => record.attemptId === authority.attemptId);
    validateAutoExecutionEventStreams(stream);
    for (const transition of transitions) {
      const expected = {
        eventType: transition.eventType,
        observation: {
          status: transition.observation?.status,
          invocationId: transition.observation?.invocationId ?? null,
          code: transition.observation?.code ?? null,
          usageSha256: transition.observation?.usageSha256 ?? null
        },
        rawEvidence: {
          status: transition.rawEvidence?.status ?? 'unavailable',
          sha256: transition.rawEvidence?.sha256 ?? null,
          reason: transition.rawEvidence?.reason
            ?? ((transition.rawEvidence?.status ?? 'unavailable') === 'unavailable'
              ? 'provider event stream was not exposed by the adapter' : null)
        }
      };
      const replay = stream.find((record) => sameTransition(record, expected));
      if (replay) continue;
      if (stream.some((record) => record.eventType === 'execution.quiesced')) {
        fail(`Auto execution attempt '${authority.attemptId}' is already quiesced.`,
          'AUTO_EXECUTION_EVENT_SEQUENCE_INVALID');
      }
      const proposed = buildAutoExecutionEvent({
        ...authority,
        sequence: stream.length + 1,
        eventType: expected.eventType,
        observation: expected.observation,
        rawEvidence: expected.rawEvidence,
        ...(transition.createdAt ? { createdAt: transition.createdAt } : {})
      });
      validateAutoExecutionEventStreams([...stream, proposed]);
      const record = await persistAutoExecutionEvent(root, proposed);
      stream = [...stream, record];
    }
    return Object.freeze([...stream]);
  };
  // Stop control and the executor deliberately observe the same transition concurrently. Retry
  // only acquisition contention; every attempt re-reads the immutable stream under the lease.
  const maximumAttempts = 100;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try { return await withSubjectLock(root, subject, persistLocked); }
    catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || attempt === maximumAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new SingularityFlowError('Auto execution event stream lock retry was exhausted.', {
    code: 'SUBJECT_LOCK_BUSY'
  });
}

export async function persistAutoPhaseContractRecords(root, contract) {
  const [contextManifest, taskContract, executionSelection] = await Promise.all([
    persistAutoContextManifest(root, contract.contextManifest),
    persistAutoAgentTaskContract(root, contract.taskContract),
    persistAutoExecutionSelection(root, contract.executionSelection)
  ]);
  return Object.freeze({ contextManifest, taskContract, executionSelection });
}

export async function readAutoContractRecord(root, family, flightId, recordId) {
  const raw = await readAutoPrivateRecord(
    root, recordFile(root, family, flightId, recordId), 'auto-p1-record'
  );
  let stored;
  try { stored = JSON.parse(raw); }
  catch (error) {
    fail(`Auto ${family} record is not valid JSON: ${error.message}`,
      'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  const current = validateAutoContractRecord(family, stored);
  if (current.flightId !== flightId) {
    fail(`Auto ${family} record belongs to another flight.`,
      'AUTO_CONTRACT_RECORD_CORRUPT');
  }
  return Object.freeze(current);
}

export async function listAutoContractRecords(root, family, flightId) {
  const descriptor = FAMILY[family];
  if (!descriptor) fail(`Unknown Auto contract record family '${family}'.`);
  const directory = path.join(recordRoot(root, flightId), descriptor.directory);
  const entries = await listAutoPrivateRecords(root, directory);
  const records = [];
  for (const entry of entries.filter((item) => item.name.endsWith('.json'))) {
    const id = entry.name.slice(0, -5);
    if (!RECORD_ID.test(id) || !id.startsWith(`${descriptor.prefix}-`)) continue;
    records.push(await readAutoContractRecord(root, family, flightId, id));
  }
  return records.sort((left, right) => (
    Number(left.sequence ?? 0) - Number(right.sequence ?? 0)
      || left.createdAt.localeCompare(right.createdAt)
  ));
}

/** Recreate disposable sidecars from the exact records embedded in a governed checkpoint. */
export async function restoreAutoContractRecords(root, phaseContracts = {}, executionEvents = []) {
  // Validate and migrate the complete embedded authority before writing even one disposable
  // sidecar. Missing/future schemas, bad composite pointers, and incomplete terminal streams must
  // leave recovery retryable with no partial local projection.
  const validated = validateAutoPhaseContractSnapshots(
    phaseContracts, executionEvents ?? [], { requireTerminalQuiescence: true }
  );
  const records = Object.values(validated.phaseContracts).flatMap((contract) => [
    contract?.contextManifest, contract?.taskContract, contract?.executionSelection
  ]).filter(Boolean);
  const allRecords = [...records, ...validated.executionEvents];
  const existingRecords = [];
  for (const record of allRecords) {
    const family = record?.kind;
    const descriptor = FAMILY[family];
    if (!descriptor) fail(`Unknown embedded Auto contract family '${family}'.`,
      'AUTO_CONTRACT_RECORD_CORRUPT');
    const existing = await readAutoContractRecord(
      root, family, record.flightId, record[descriptor.id]
    ).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing && existing[descriptor.hash] !== record[descriptor.hash]) {
      fail(
        `Governed Auto checkpoint record '${record[descriptor.id]}' differs from its disposable sidecar.`,
        'AUTO_CONTRACT_RECORD_CONFLICT', {
          family,
          recordId: record[descriptor.id],
          expected: record[descriptor.hash],
          actual: existing[descriptor.hash]
        }
      );
    }
    existingRecords.push({ family, record });
  }
  for (const { family, record } of existingRecords) {
    await persist(root, family, record);
  }
}
