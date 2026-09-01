import path from 'node:path';

import { assertRecordSha256, compareText, isPlainRecord } from './canonicalize.mjs';

export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const VIEW_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
export const EVIDENCE_ID_PATTERN = /^EV-[a-f0-9]{16,64}$/;
export const FACT_ID_PATTERN = /^FACT-[a-f0-9]{16,64}$/;
export const DERIVATION_ID_PATTERN = /^DRV-[a-f0-9]{16,64}$/;

export function contractFailure(message, code = 'WMB_CONTRACT_INVALID', details = {}) {
  const error = new TypeError(message);
  error.code = code;
  error.details = details;
  throw error;
}

export function assertPlainRecord(value, label = 'World-model value') {
  if (!isPlainRecord(value)) contractFailure(`${label} must be a plain object.`);
  return value;
}

export function assertExactKeys(value, { required = [], optional = [], label = 'World-model record' } = {}) {
  assertPlainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) contractFailure(`${label} is missing required field '${key}'.`, 'WMB_CONTRACT_FIELD_MISSING', { label, key });
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) contractFailure(`${label} contains unknown field '${key}'.`, 'WMB_CONTRACT_FIELD_UNKNOWN', { label, key });
  }
  return value;
}

export function assertSchemaKind(value, kind, label = kind) {
  assertExactKeys(value, { required: ['schemaVersion', 'kind'], optional: Object.keys(value).filter((key) => !['schemaVersion', 'kind'].includes(key)), label });
  // These content-addressed kernel records are v4 transport artifacts, not independently
  // reopened durable families. A bounded integer assertion keeps that boundary strict without
  // introducing schema-version migration branching outside the migration registry.
  assertInteger(value.schemaVersion, `${label} schemaVersion`, { minimum: 1, maximum: 1 });
  if (value.kind !== kind) contractFailure(`${label} kind must be '${kind}'.`, 'WMB_CONTRACT_KIND_INVALID', { received: value.kind });
  return value;
}

export function assertString(value, label, { pattern = null, nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !value.length) contractFailure(`${label} must be a non-empty string.`);
  if (pattern && !pattern.test(value)) contractFailure(`${label} has an invalid format.`, 'WMB_CONTRACT_FORMAT_INVALID', { label, value });
  return value;
}

export function assertInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    contractFailure(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function assertBoolean(value, label) {
  if (typeof value !== 'boolean') contractFailure(`${label} must be a boolean.`);
  return value;
}

export function assertSha256(value, label) {
  return assertString(value, label, { pattern: SHA256_PATTERN });
}

export function assertStringArray(value, label, { unique = true, sorted = false, pattern = null } = {}) {
  if (!Array.isArray(value)) contractFailure(`${label} must be an array.`);
  value.forEach((entry, index) => assertString(entry, `${label}[${index}]`, { pattern }));
  if (unique && new Set(value).size !== value.length) contractFailure(`${label} must not contain duplicates.`);
  if (sorted && value.some((entry, index) => index && compareText(value[index - 1], entry) > 0)) {
    contractFailure(`${label} must use canonical lexical order.`, 'WMB_CANONICAL_ORDER_INVALID');
  }
  return value;
}

export function normalizeRepositoryPath(value, label = 'Repository path') {
  assertString(value, label);
  const normalized = String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const segments = normalized.split('/');
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)
      || segments.includes('..') || segments.includes('.') || /[\0\r\n]/.test(normalized)) {
    contractFailure(`${label} must be a normalized repository-relative path.`, 'WMB_PATH_INVALID', { value });
  }
  return normalized;
}

export function assertNormalizedRepositoryPath(value, label = 'Repository path') {
  const normalized = normalizeRepositoryPath(value, label);
  if (value !== normalized) contractFailure(`${label} is not normalized.`, 'WMB_PATH_INVALID', { value, normalized });
  return value;
}

export function assertSelfHash(value, field, label) {
  try { return assertRecordSha256(value, field, label); }
  catch (error) {
    if (!error.code) error.code = 'WMB_RECORD_HASH_MISMATCH';
    throw error;
  }
}

export function assertCanonicalOrder(values, keyOf, label) {
  for (let index = 1; index < values.length; index += 1) {
    if (compareText(keyOf(values[index - 1]), keyOf(values[index])) > 0) {
      contractFailure(`${label} must use canonical order.`, 'WMB_CANONICAL_ORDER_INVALID', { index });
    }
  }
  return values;
}
