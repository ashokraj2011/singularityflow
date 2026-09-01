import { compareText, isPlainRecord, recordSha256 } from '../../canonicalize.mjs';
import { readRecord } from '../../../schema-migrations.mjs';
import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  unavailableDraft
} from './common.mjs';

export const RUNTIME_OBSERVATION_IMPORT_ID = 'runtime-observation-import';
export const RUNTIME_OBSERVATION_IMPORT_VERSION = '1.0.0';
export const RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256 = implementationSha256(
  RUNTIME_OBSERVATION_IMPORT_ID,
  RUNTIME_OBSERVATION_IMPORT_VERSION,
  'sealed-bounded-runtime-frequency-record-import-v1'
);

export const RUNTIME_OBSERVATION_IMPORT_PATH =
  'world-model-inputs/runtime-observations.json';

const MAXIMUM_BYTES = 256 * 1024;
const MAXIMUM_RECORDS = 256;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const IMPORT_FAMILY = 'world-model-runtime-observation-import';
const RECORD_FAMILY = 'world-model-runtime-observation';

function exactKeys(value, required, label) {
  if (!isPlainRecord(value)
      || Object.keys(value).sort().join('\0') !== [...required].sort().join('\0')) {
    throw new Error(`${label} must contain exactly: ${[...required].sort().join(', ')}`);
  }
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC ISO-8601 timestamp`);
  }
  return value;
}

/** Parse the closed, self-hashed runtime-frequency import format. */
export function parseRuntimeObservationImport(source) {
  let document;
  try { document = JSON.parse(String(source)); }
  catch { throw new Error('runtime observation import is not valid JSON'); }
  document = readRecord(IMPORT_FAMILY, document).record;
  exactKeys(document, ['schemaVersion', 'kind', 'records'], 'Runtime observation import');
  if (document.kind !== IMPORT_FAMILY) throw new Error('runtime observation import kind is unsupported');
  if (!Array.isArray(document.records) || document.records.length > MAXIMUM_RECORDS) {
    throw new Error(`runtime observation import records must contain at most ${MAXIMUM_RECORDS} entries`);
  }
  const records = document.records.map((value, index) => {
    const record = readRecord(RECORD_FAMILY, value).record;
    exactKeys(record, [
      'schemaVersion', 'kind', 'id', 'metric', 'subjectId', 'count', 'windowStart',
      'windowEnd', 'producerId', 'producerVersion', 'receiptSha256', 'recordSha256'
    ], `Runtime observation record ${index}`);
    if (record.kind !== RECORD_FAMILY || record.metric !== 'frequency') {
      throw new Error(`runtime observation record ${index} kind or metric is unsupported`);
    }
    if (!ID.test(record.id) || !ID.test(record.subjectId) || !ID.test(record.producerId)
        || !VERSION.test(record.producerVersion)) {
      throw new Error(`runtime observation record ${index} contains a non-canonical identifier`);
    }
    if (!Number.isSafeInteger(record.count) || record.count < 0) {
      throw new Error(`runtime observation record ${index} count must be a non-negative safe integer`);
    }
    timestamp(record.windowStart, `Runtime observation record ${index} windowStart`);
    timestamp(record.windowEnd, `Runtime observation record ${index} windowEnd`);
    if (record.windowStart >= record.windowEnd) {
      throw new Error(`runtime observation record ${index} window must increase`);
    }
    if (!SHA256.test(record.receiptSha256)
        || record.recordSha256 !== recordSha256(record, 'recordSha256')) {
      throw new Error(`runtime observation record ${index} receipt or record digest is invalid`);
    }
    return structuredClone(record);
  });
  const ids = records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error('runtime observation IDs must be unique');
  const semantic = records.map((record) => (
    `${record.subjectId}\0${record.windowStart}\0${record.windowEnd}`
  ));
  if (new Set(semantic).size !== semantic.length) {
    throw new Error('runtime observation windows must be unique per subject');
  }
  return records.sort((left, right) => compareText(left.id, right.id));
}

export function extractRuntimeObservations(context) {
  const observations = [];
  const facts = [];
  if (!context.scopeManifest.allowedSubjects.includes('runtime-observation')) {
    return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
  }
  const file = adapterFiles(context).find((entry) => (
    entry.path === RUNTIME_OBSERVATION_IMPORT_PATH
  ));
  if (!file) return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
  const fileSubject = { kind: 'runtime-observation', id: RUNTIME_OBSERVATION_IMPORT_PATH };
  if (file.bytes > MAXIMUM_BYTES) {
    facts.push(unavailableDraft({
      factType: 'runtime-frequency', subject: fileSubject,
      attemptedProducer: RUNTIME_OBSERVATION_IMPORT_ID,
      code: 'PARSE_FAILURE',
      detail: `Runtime observation import exceeds the registered ${MAXIMUM_BYTES}-byte bound.`
    }));
    return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
  }
  let source;
  try {
    source = exactText(context, file);
  } catch (error) {
    if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
    facts.push(unavailableDraft({
      factType: 'runtime-frequency', subject: fileSubject,
      attemptedProducer: RUNTIME_OBSERVATION_IMPORT_ID,
      code: 'INVALID_UTF8',
      detail: 'The pinned runtime observation import is not valid UTF-8.'
    }));
    return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
  }
  let records;
  try {
    records = parseRuntimeObservationImport(source);
  } catch (error) {
    const evidence = evidenceDescriptor(file, {
      kind: 'runtime-observation', subject: fileSubject
    });
    observations.push(evidence);
    facts.push(unavailableDraft({
      factType: 'runtime-frequency', subject: fileSubject,
      attemptedProducer: RUNTIME_OBSERVATION_IMPORT_ID,
      code: 'PARSE_FAILURE',
      detail: `The runtime observation import was refused: ${error.message}`,
      evidence: [evidence]
    }));
    return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
  }
  for (const record of records) {
    const subject = { kind: 'runtime-observation', id: record.subjectId };
    const evidence = evidenceDescriptor(file, {
      kind: 'runtime-observation', locator: { target: record.id }, subject
    });
    observations.push(evidence);
    facts.push(factDraft({
      factType: 'runtime-frequency',
      subject,
      claim: `${record.subjectId} was observed ${record.count} time(s) during its registered runtime window by ${record.producerId}@${record.producerVersion}; exact times and receipt digest remain in the evidence-bound import record.`,
      assurance: 'runtime-observed',
      evidence: [evidence]
    }));
  }
  return result(RUNTIME_OBSERVATION_IMPORT_ID, observations, facts);
}
