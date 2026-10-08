import { readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { assertSelfHash, assertSha256 } from '../contracts.mjs';

// Input retention follows the sealed request, not whether its optional output succeeded.
export const PROJECTION_INPUT_RECORDS = Object.freeze([
  Object.freeze({
    field: 'capabilitySnapshot', digest: 'capabilitySnapshotSha256',
    path: 'inputs/capability-snapshot.json', family: 'architecture-fact-set',
    kind: 'architecture-capability-snapshot', hash: 'snapshotSha256'
  }),
  Object.freeze({
    field: 'configurationSnapshot', digest: 'configurationSnapshotSha256',
    path: 'inputs/configuration-snapshot.json', family: 'architecture-fact-set',
    kind: 'architecture-configuration-snapshot', hash: 'snapshotSha256'
  }),
  Object.freeze({
    field: 'toolchainLock', digest: 'toolchainLockSha256',
    path: 'toolchains/calm.json', family: 'calm-toolchain-lock',
    kind: 'calm-toolchain-lock', hash: 'lockSha256'
  })
]);

function mismatch(message, field, expected, received, code) {
  throw new SingularityFlowError(message, {
    code, details: { field, expected: expected ?? null, received: received ?? null }
  });
}

export function requestedProjectionInputRecords(request, {
  requireComplete = false, code = 'WMB_PUBLICATION_PARTIAL'
} = {}) {
  return PROJECTION_INPUT_RECORDS.filter((input) => {
    const digest = request?.[input.digest] ?? null;
    if (digest === null) {
      if (requireComplete) mismatch('Available projection requires complete sealed input bindings.',
        input.digest, 'sha256', null, code);
      return false;
    }
    assertSha256(digest, `Projection input ${input.digest}`);
    return true;
  });
}

/** Shared writer/reader boundary; null setup inputs remain distinct from missing bound bytes. */
export function verifyProjectionInputRecords(request, records, options = {}) {
  const code = options.code ?? 'WMB_PUBLICATION_PARTIAL';
  const bound = new Set(requestedProjectionInputRecords(request, options).map((input) => input.field));
  const verified = {};
  for (const input of PROJECTION_INPUT_RECORDS) {
    const value = records[input.field] ?? null;
    if (!bound.has(input.field)) {
      if (value !== null) mismatch('Projection contains an input absent from the sealed request.',
        input.digest, null, value[input.hash], code);
      verified[input.field] = null;
      continue;
    }
    if (value === null) mismatch('Projection is missing a request-bound input record.',
      input.digest, request[input.digest], null, code);
    const record = readRecord(input.family, value).record;
    assertSelfHash(record, input.hash, `Projection ${input.kind}`);
    if (record.kind !== input.kind) mismatch('Projection input has an unexpected record kind.',
      input.field, input.kind, record.kind, code);
    if (record[input.hash] !== request[input.digest]) mismatch(
      'Projection input does not match the sealed Build Request.',
      input.digest, request[input.digest], record[input.hash], code
    );
    verified[input.field] = record;
  }
  return Object.freeze(verified);
}

/** An unavailable output still has to explain the same exact build, not another attempt. */
export function assertProjectionRefusalInputBindings(refusal, {
  request, sourceSnapshot, scopeManifest, factLedger,
  code = 'WMB_PUBLICATION_PARTIAL'
}) {
  const expected = {
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeSha256: scopeManifest.scopeSha256,
    factLedgerSha256: factLedger.ledgerSha256,
    ...Object.fromEntries(PROJECTION_INPUT_RECORDS.map((input) => [
      input.digest, request[input.digest] ?? null
    ]))
  };
  for (const [field, digest] of Object.entries(expected)) {
    if (refusal.preserved?.[field] !== digest) mismatch(
      'Projection refusal does not bind the exact preserved build inputs.',
      field, digest, refusal.preserved?.[field], code
    );
  }
}
