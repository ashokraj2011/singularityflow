/** Closed, versioned limits for Repository Discovery and Selection (RDS-v1). */
// schema-transient: these are read-only transport envelopes, not durable records.
export const RDS_ENVELOPE_VERSION = 1;
export const RDS_QUERY_PROFILE = 'literal-path-v1';
export const RDS_PROFILE_VERSION = 'github-gh-graphql-v1';

export const RDS_DEFAULTS = Object.freeze({
  returnedRows: 25,
  providerPageSize: 50,
  providerPages: 5,
  providerQueries: 8,
  requestTimeoutMs: 10_000,
  aggregateTimeoutMs: 20_000,
  cursorTtlMs: 15 * 60_000,
  cacheTtlMs: 15 * 60_000,
  maximumRows: 500,
  maximumNativeRows: 100,
  maximumModelRows: 10,
  maximumProviderPageSize: 100,
  maximumProviderPages: 10,
  maximumProviderQueries: 16,
  maximumAggregateTimeoutMs: 60_000,
  maximumActiveCursors: 100,
  maximumAuditRecords: 1_000,
  maximumAuditBytes: 1024 * 1024,
  maximumStdoutBytes: 4 * 1024 * 1024,
  maximumStderrBytes: 64 * 1024,
  maximumRenderedCliBytes: 2 * 1024 * 1024,
  maximumRenderedNativeBytes: 256 * 1024,
  maximumLocalFileBytes: 4 * 1024 * 1024,
  maximumLocalBytes: 16 * 1024 * 1024,
  maximumLocalFiles: 256,
  maximumSourceRecords: 10_000,
  maximumStoredRecords: 10_000,
  maximumStoreBytes: 10 * 1024 * 1024,
  maximumQueryScalars: 256,
  maximumQueryBytes: 1024
});

export const RDS_ERROR_CODES = Object.freeze([
  'REPOSITORY_PROVIDER_NOT_SELECTED',
  'REPOSITORY_PROVIDER_UNAVAILABLE',
  'REPOSITORY_PROVIDER_UNSUPPORTED',
  'REPOSITORY_PROVIDER_AUTH_REQUIRED',
  'REPOSITORY_PROVIDER_ACCOUNT_CHANGED',
  'REPOSITORY_PROVIDER_HOST_REFUSED',
  'REPOSITORY_PROVIDER_ACCESS_REFUSED',
  'REPOSITORY_PROVIDER_NETWORK_FAILED',
  'REPOSITORY_PROVIDER_RATE_LIMITED',
  'REPOSITORY_PROVIDER_TIMEOUT',
  'REPOSITORY_PROVIDER_OUTPUT_INVALID',
  'REPOSITORY_REMOTE_UNSAFE',
  'REPOSITORY_QUERY_REQUIRED',
  'REPOSITORY_QUERY_INVALID',
  'REPOSITORY_CATALOG_CURSOR_STALE',
  'REPOSITORY_CATALOG_SOURCE_INVALID',
  'REPOSITORY_CATALOG_STORAGE_UNAVAILABLE',
  'REPOSITORY_CATALOG_LIMIT_REACHED',
  'REPOSITORY_CATALOG_PARTIAL',
  'REPOSITORY_DISCLOSURE_REFUSED',
  'REPOSITORY_SELECTION_STALE',
  'REPOSITORY_CANCELLED'
]);

export const RDS_ENUMERATION = Object.freeze([
  'not_started', 'more', 'exhausted', 'limited', 'failed', 'cancelled'
]);

export function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

/** Exact deterministic matching profile required by RDS:REQ-022. */
export function normalizeLiteralQuery(value, { required = false } = {}) {
  if (value == null) {
    if (required) {
      const error = new TypeError('A repository search query is required.');
      error.code = 'REPOSITORY_QUERY_REQUIRED';
      throw error;
    }
    return null;
  }
  const query = String(value).replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/gu, '');
  const scalarCount = [...query].length;
  if (!query && required) {
    const error = new TypeError('A non-empty repository search query is required.');
    error.code = 'REPOSITORY_QUERY_REQUIRED';
    throw error;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(query)
      || scalarCount > RDS_DEFAULTS.maximumQueryScalars
      || Buffer.byteLength(query) > RDS_DEFAULTS.maximumQueryBytes) {
    const error = new TypeError('Repository search must be printable and within the reviewed literal-query limit.');
    error.code = 'REPOSITORY_QUERY_INVALID';
    throw error;
  }
  return query;
}

export function foldAscii(value) {
  return String(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function literalQueryMatches(query, ...values) {
  if (query == null) return true;
  const needle = foldAscii(query);
  return values.some((value) => foldAscii(value ?? '').includes(needle));
}
