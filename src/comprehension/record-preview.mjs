/**
 * Experimental, source-free CMP record-mode preview.
 *
 * This is intentionally a migration-registered transport prototype with no durable path or writer.
 * It writes nothing, has no authority, and cannot participate in a lifecycle gate. The v1 reader exists so
 * the pilot can prove that a future record shape can be migrated without gaining assurance before
 * a storage/retention/privacy ADR authorizes any durable CMP family.
 */
import { recordSha256 } from '../records.mjs';
import {
  currentSchemaVersion, readRecord, stampCurrentRecord
} from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const KIND = 'comprehension-record-preview';
const FAMILY = 'comprehension-record-preview';
const COUNT_KEYS = Object.freeze([
  'regions', 'materialRegions', 'nonmaterialRegions', 'explained', 'approvedDeviations',
  'deterministicTransformations', 'split', 'unresolved', 'diagnostics'
]);

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function fail(message, details = null) {
  throw new SingularityFlowError(message, {
    code: 'CMP_RECORD_PREVIEW_INVALID',
    ...(details ? { details } : {})
  });
}

function digest(record) {
  const core = structuredClone(record);
  delete core.previewSha256;
  return `sha256:${recordSha256(core)}`;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has an unsupported field set.`);
  }
}

function validatedCounts(value) {
  exactKeys(value, COUNT_KEYS, 'Comprehension preview counts');
  return Object.fromEntries(COUNT_KEYS.map((key) => {
    const count = value[key];
    if (!Number.isSafeInteger(count) || count < 0) {
      fail(`Comprehension preview count '${key}' must be a non-negative safe integer.`);
    }
    return [key, count];
  }));
}

function validatedReasonCounts(value) {
  if (!plainObject(value)) fail('Comprehension preview reasonCounts must be an object.');
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 128) fail('Comprehension preview reasonCounts exceeds 128 reason classes.');
  return Object.fromEntries(entries.map(([code, count]) => {
    if (!/^CMP_[A-Z0-9_]{1,96}$/u.test(code)
        || !Number.isSafeInteger(count) || count < 1) {
      fail('Comprehension preview reasonCounts contains an invalid reason or count.');
    }
    return [code, count];
  }));
}

function assertBoundary(record) {
  if (record.mode !== 'record' || record.status !== 'experimental'
      || record.authoritative !== false || record.lifecycleGate !== false
      || record.assurance !== 'unverified-observation') {
    fail('A comprehension record preview cannot claim authority, enforcement, or verified assurance.');
  }
}

function validateV2(record) {
  exactKeys(record, [
    'schemaVersion', 'kind', 'mode', 'status', 'subject', 'summary', 'availability',
    'authoritative', 'lifecycleGate', 'assurance', 'previewSha256'
  ], 'Comprehension record preview v2');
  assertBoundary(record);
  exactKeys(record.subject, [
    'candidateSha256', 'manifestSha256', 'resultSha256'
  ], 'Comprehension preview subject');
  for (const value of Object.values(record.subject)) {
    if (!SHA256.test(String(value ?? ''))) fail('Comprehension preview subject contains an invalid digest.');
  }
  exactKeys(record.summary, ['verdict', 'counts', 'reasonCounts'], 'Comprehension preview summary');
  if (!['complete', 'incomplete'].includes(record.summary.verdict)) fail('Comprehension record preview verdict is invalid.');
  validatedCounts(record.summary.counts);
  validatedReasonCounts(record.summary.reasonCounts);
  exactKeys(record.availability, ['structure', 'evidenceAuthority'], 'Comprehension preview availability');
  if (record.availability.structure !== 'unavailable'
      || record.availability.evidenceAuthority !== 'unavailable') {
    fail('The experimental record preview cannot claim structural or evidence authority.');
  }
  if (!SHA256.test(String(record.previewSha256 ?? '')) || record.previewSha256 !== digest(record)) {
    fail('Comprehension record preview v2 failed its integrity check.');
  }
}

function v2(core) {
  const record = stampCurrentRecord(FAMILY, {
    kind: KIND,
    mode: 'record',
    status: 'experimental',
    ...core,
    authoritative: false,
    lifecycleGate: false,
    assurance: 'unverified-observation'
  });
  return freezeDeep({ ...record, previewSha256: digest(record) });
}

function reasonCounts(coverage) {
  const counts = new Map();
  for (const entry of [...(coverage.unresolved ?? []), ...(coverage.diagnostics ?? [])]) {
    const code = String(entry?.code ?? '');
    if (!/^CMP_[A-Z0-9_]{1,96}$/u.test(code)) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildComprehensionRecordPreview({ manifest, coverage }) {
  if (!plainObject(manifest) || !plainObject(coverage)
      || !SHA256.test(String(manifest.compatibilityCandidateSha256 ?? ''))
      || !SHA256.test(String(manifest.manifestSha256 ?? ''))
      || !SHA256.test(String(coverage.resultSha256 ?? ''))
      || coverage.candidateSha256 !== manifest.compatibilityCandidateSha256) {
    fail('A verified current manifest and matching coverage result are required for record preview.');
  }
  return v2({
    subject: {
      candidateSha256: manifest.compatibilityCandidateSha256,
      manifestSha256: manifest.manifestSha256,
      resultSha256: coverage.resultSha256
    },
    summary: {
      verdict: coverage.verdict,
      counts: validatedCounts(coverage.counts),
      reasonCounts: reasonCounts(coverage)
    },
    availability: { structure: 'unavailable', evidenceAuthority: 'unavailable' }
  });
}

export function readComprehensionRecordPreview(source) {
  if (!plainObject(source) || source.kind !== KIND) {
    fail('The input is not a supported comprehension record preview.');
  }
  const migrated = readRecord(FAMILY, source);
  validateV2(migrated.record);
  return freezeDeep({
    storedSchemaVersion: migrated.storedVersion,
    applied: migrated.migratedThrough.map((step) => `${step.from}->${step.to}`),
    record: structuredClone(migrated.record)
  });
}

export const COMPREHENSION_RECORD_PREVIEW_SCHEMA_VERSION = currentSchemaVersion(FAMILY);

export function comprehensionRecordPreviewDigest(record) {
  return digest(record);
}
