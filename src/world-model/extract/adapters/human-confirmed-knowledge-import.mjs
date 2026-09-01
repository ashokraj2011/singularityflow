import { compareText, isPlainRecord, recordSha256 } from '../../canonicalize.mjs';
import { readRecord } from '../../../schema-migrations.mjs';
import {
  adapterFiles, evidenceDescriptor, exactText, factDraft, implementationSha256, result,
  unavailableDraft
} from './common.mjs';

export const HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID = 'human-confirmed-knowledge-import';
export const HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION = '1.0.0';
export const HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256 = implementationSha256(
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION,
  'sealed-bounded-human-confirmed-business-knowledge-import-v1'
);

export const HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_PATH =
  'world-model-inputs/human-confirmed-knowledge.json';

const MAXIMUM_BYTES = 256 * 1024;
const MAXIMUM_RECORDS = 256;
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_TERM = /^[A-Za-z0-9][A-Za-z0-9 ._:/()+&-]{0,79}$/;
const SAFE_STATEMENT = /^[A-Za-z0-9][A-Za-z0-9 .,_:/()'&+%=-]{0,279}$/;
const PROMPT_DIRECTIVE = /\b(?:ignore|disregard|override|system prompt|assistant|tool call|follow these instructions?|execute|run command)\b/i;
const IMPORT_FAMILY = 'world-model-human-confirmed-knowledge-import';
const RECORD_FAMILY = 'world-model-human-confirmed-knowledge';

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
}

/** Parse bounded reviewed business knowledge; prompt-shaped prose is rejected as data. */
export function parseHumanConfirmedKnowledgeImport(source) {
  let document;
  try { document = JSON.parse(String(source)); }
  catch { throw new Error('human-confirmed knowledge import is not valid JSON'); }
  document = readRecord(IMPORT_FAMILY, document).record;
  exactKeys(document, ['schemaVersion', 'kind', 'records'], 'Human-confirmed knowledge import');
  if (document.kind !== IMPORT_FAMILY) throw new Error('human-confirmed knowledge import kind is unsupported');
  if (!Array.isArray(document.records) || document.records.length > MAXIMUM_RECORDS) {
    throw new Error(`human-confirmed knowledge records must contain at most ${MAXIMUM_RECORDS} entries`);
  }
  const records = document.records.map((value, index) => {
    const record = readRecord(RECORD_FAMILY, value).record;
    exactKeys(record, [
      'schemaVersion', 'kind', 'id', 'factType', 'term', 'statement', 'confirmation',
      'recordSha256'
    ], `Human-confirmed knowledge record ${index}`);
    if (record.kind !== RECORD_FAMILY
        || !['business-glossary', 'business-meaning'].includes(record.factType)) {
      throw new Error(`human-confirmed knowledge record ${index} kind or factType is unsupported`);
    }
    exactKeys(record.confirmation, [
      'status', 'authorityId', 'identitySha256', 'confirmedAt', 'receiptSha256'
    ], `Human-confirmed knowledge record ${index} confirmation`);
    if (!ID.test(record.id) || !ID.test(record.confirmation.authorityId)
        || record.confirmation.status !== 'confirmed'
        || !SHA256.test(record.confirmation.identitySha256)
        || !SHA256.test(record.confirmation.receiptSha256)) {
      throw new Error(`human-confirmed knowledge record ${index} confirmation is not canonical`);
    }
    timestamp(record.confirmation.confirmedAt,
      `Human-confirmed knowledge record ${index} confirmedAt`);
    if (!SAFE_TERM.test(record.term) || !SAFE_STATEMENT.test(record.statement)
        || PROMPT_DIRECTIVE.test(record.term) || PROMPT_DIRECTIVE.test(record.statement)) {
      throw new Error(`human-confirmed knowledge record ${index} contains unsafe or prompt-shaped prose`);
    }
    if (record.recordSha256 !== recordSha256(record, 'recordSha256')) {
      throw new Error(`human-confirmed knowledge record ${index} record digest is invalid`);
    }
    return structuredClone(record);
  });
  const ids = records.map((record) => record.id);
  if (new Set(ids).size !== ids.length) throw new Error('human-confirmed knowledge IDs must be unique');
  const terms = records.map((record) => record.term.toLowerCase());
  if (new Set(terms).size !== terms.length) {
    throw new Error('human-confirmed knowledge terms must be unique to avoid hidden contradiction');
  }
  return records.sort((left, right) => compareText(left.id, right.id));
}

export function extractHumanConfirmedKnowledge(context) {
  const observations = [];
  const facts = [];
  if (!context.scopeManifest.allowedSubjects.includes('human-record')) {
    return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
  }
  const file = adapterFiles(context).find((entry) => (
    entry.path === HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_PATH
  ));
  if (!file) return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
  const fileSubject = { kind: 'human-record', id: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_PATH };
  if (file.bytes > MAXIMUM_BYTES) {
    facts.push(unavailableDraft({
      factType: 'business-meaning', subject: fileSubject,
      attemptedProducer: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID,
      code: 'PARSE_FAILURE',
      detail: `Human-confirmed knowledge import exceeds the registered ${MAXIMUM_BYTES}-byte bound.`
    }));
    return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
  }
  let source;
  try {
    source = exactText(context, file);
  } catch (error) {
    if (error?.code !== 'WMB_EXTRACTION_UNAVAILABLE') throw error;
    facts.push(unavailableDraft({
      factType: 'business-meaning', subject: fileSubject,
      attemptedProducer: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID,
      code: 'INVALID_UTF8',
      detail: 'The pinned human-confirmed knowledge import is not valid UTF-8.'
    }));
    return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
  }
  let records;
  try {
    records = parseHumanConfirmedKnowledgeImport(source);
  } catch (error) {
    const evidence = evidenceDescriptor(file, {
      kind: 'human-confirmed-record', subject: fileSubject
    });
    observations.push(evidence);
    facts.push(unavailableDraft({
      factType: 'business-meaning', subject: fileSubject,
      attemptedProducer: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID,
      code: 'PARSE_FAILURE',
      detail: `The human-confirmed knowledge import was refused: ${error.message}`,
      evidence: [evidence]
    }));
    return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
  }
  for (const record of records) {
    const subject = { kind: 'human-record', id: `knowledge:${record.id}` };
    const evidence = evidenceDescriptor(file, {
      kind: 'human-confirmed-record', locator: { target: record.id }, subject
    });
    observations.push(evidence);
    facts.push(factDraft({
      factType: record.factType,
      subject,
      claim: `${record.term}: ${record.statement}`,
      assurance: 'human-confirmed',
      evidence: [evidence]
    }));
  }
  return result(HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, observations, facts);
}
