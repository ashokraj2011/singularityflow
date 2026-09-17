/**
 * Read-only REV Code check result projection. A caller must supply store-backed verification
 * callbacks; a receipt object, self-hash, or model assertion alone is never execution evidence.
 * This module runs no project command and never changes Code, Testing, or Verification state.
 */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CHECKS = 64;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACTS = 64;

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function requiredHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_CODE_RESULT_INPUT', `${label} needs an exact SHA-256 digest.`);
  return value;
}
function identifier(value, label) {
  if (!ID.test(String(value ?? ''))) fail('REV_CODE_RESULT_INPUT', `${label} needs a bounded identifier.`);
  return value;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('REV_CODE_RESULT_INPUT', `${label} must be a plain object.`);
  }
  return value;
}
function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f\x7f]/u.test(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}
function reference(value) {
  plain(value, 'candidateReference');
  identifier(value.candidateId, 'candidate ID');
  if (!value.candidateId.startsWith('CAN-') || !['sgos-candidate', 'auto-candidate'].includes(value.family)
      || typeof value.namespace !== 'string' || !value.namespace.startsWith('refs/singularity-flow/')
      || !OID.test(String(value.repository?.candidateTree ?? ''))) {
    fail('REV_CODE_RESULT_INPUT', 'An exact retained Code candidate reference is required.');
  }
  for (const field of ['retainedRecordSha256', 'candidateSha256', 'sourceManifestSha256', 'effectSetSha256']) {
    requiredHash(value[field], `candidateReference.${field}`);
  }
  return structuredClone(value);
}
function checkDefinition(value) {
  plain(value, 'registered check');
  const checkId = identifier(value.checkId, 'check ID');
  if (!['test', 'build', 'lint', 'browser'].includes(value.kind)
      || typeof value.label !== 'string' || !value.label.trim()
      || Buffer.byteLength(value.label) > 128) {
    fail('REV_CODE_RESULT_INPUT', 'Registered check needs a supported kind and bounded label.');
  }
  for (const field of ['checkDefinitionSha256', 'argvSha256', 'testBodySha256', 'adapterSha256']) {
    requiredHash(value[field], `registered check ${field}`);
  }
  if (!Array.isArray(value.outputRoots) || value.outputRoots.length > 8
      || value.outputRoots.some((item) => !relativePath(item))) {
    fail('REV_CODE_RESULT_INPUT', 'Registered check output roots must be bounded relative paths.');
  }
  return {
    checkId, kind: value.kind, label: value.label,
    checkDefinitionSha256: value.checkDefinitionSha256,
    argvSha256: value.argvSha256, testBodySha256: value.testBodySha256,
    adapterSha256: value.adapterSha256, outputRoots: [...value.outputRoots]
  };
}
function receipt(value, expectedCheckId) {
  try { value = readRecord('revision-code-check-receipt', value).record; }
  catch { fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Verified reader returned an unreadable Code check receipt.'); }
  plain(value, 'verified receipt');
  if (value.kind !== 'revision-code-check-receipt'
      || value.checkId !== expectedCheckId || !HASH.test(String(value.receiptSha256 ?? ''))) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Verified reader returned the wrong Code check receipt.');
  }
  let size;
  try { size = Buffer.byteLength(canonicalJson(value)); }
  catch { fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Code check receipt is not canonical JSON.'); }
  if (size > MAX_RECEIPT_BYTES) fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Code check receipt exceeds the result limit.');
  const { receiptSha256, ...core } = value;
  if (hash(core) !== receiptSha256) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Code check receipt content hash does not match.');
  }
  if (!['passed', 'failed', 'skipped', 'unavailable'].includes(value.status)) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Code check receipt has no recognized outcome.');
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_ARTIFACTS) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Code check receipt artifact inventory is unbounded.');
  }
  return structuredClone(value);
}
function staleReasons(item, candidate, candidateRefSha256, scope, check) {
  const bindings = [
    ['candidate', item.candidateId, candidate.candidateId],
    ['candidate-ref', item.candidateRefSha256, candidateRefSha256],
    ['candidate-tree', item.candidateTree, candidate.repository.candidateTree],
    ['phase', item.phase, scope.phaseId],
    ['phase-generation', item.phaseGeneration, scope.phaseGeneration],
    ['check-definition', item.checkDefinitionSha256, check.checkDefinitionSha256],
    ['command', item.argvSha256, check.argvSha256],
    ['test-body', item.testBodySha256, check.testBodySha256],
    ['adapter', item.adapterSha256, check.adapterSha256],
    ['configuration', item.configSha256, scope.configSha256],
    ['proof-profile', item.proofProfileSha256, scope.proofProfileSha256],
    ['environment', item.environmentSha256, scope.environmentSha256]
  ];
  return bindings.filter(([, observed, expected]) => observed !== expected).map(([name]) => name);
}
function testCounts(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Normalized test totals are invalid.');
  }
  const counts = {};
  for (const key of ['discovered', 'passed', 'failed', 'skipped']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Normalized test totals are invalid.');
    }
    counts[key] = value[key];
  }
  if (counts.discovered !== counts.passed + counts.failed + counts.skipped) {
    fail('REV_CODE_RESULT_RECEIPT_INVALID', 'Normalized test totals do not reconcile.');
  }
  return counts;
}
function artifactProjection(item, check) {
  const path = item?.path;
  const inRoot = relativePath(path) && check.outputRoots.some((root) => path.startsWith(`${root}/`));
  const common = item && typeof item.kind === 'string' && item.kind.length <= 64
    && typeof item.mediaType === 'string' && item.mediaType.length <= 128
    && HASH.test(String(item.sha256 ?? '')) && inRoot
    && ['private', 'story', 'public'].includes(item.accessClass)
    && ['ephemeral', 'review', 'proof'].includes(item.retentionClass);
  if (!common) return { status: 'unavailable', reason: 'ARTIFACT_PROVENANCE_INCOMPLETE' };
  if (item.kind === 'playwright-screenshot') {
    if (check.kind !== 'browser' || !/^image\/(?:png|jpeg|webp)$/.test(item.mediaType)
        || !HASH.test(String(item.captureProvenanceSha256 ?? ''))) {
      return { status: 'unavailable', reason: 'SCREENSHOT_PROVENANCE_INCOMPLETE' };
    }
  }
  return {
    status: 'available', kind: item.kind, path,
    mediaType: item.mediaType, sha256: item.sha256,
    ...(item.kind === 'playwright-screenshot'
      ? { captureProvenanceSha256: item.captureProvenanceSha256 } : {}),
    accessClass: item.accessClass, retentionClass: item.retentionClass
  };
}
function aggregate(rows) {
  if (!rows.length) return 'unavailable';
  for (const status of ['failed', 'stale', 'unavailable', 'skipped']) {
    if (rows.some((row) => row.status === status)) return status;
  }
  return 'passed';
}

/**
 * `readVerifiedReceipt(checkId)` must read and independently verify the durable receipt store,
 * returning the latest receipt for that check (even if it belongs to an older candidate), or null.
 * `verifyCandidate(reference)` must verify the retained candidate store. Neither callback may
 * execute a check. A direct caller-supplied receipt array is intentionally unsupported.
 */
export async function projectRevisionCodeCheckResult({
  candidateReference, verifyCandidate, phaseId, phaseGeneration,
  configSha256, proofProfileSha256, environmentSha256,
  registeredChecks, readVerifiedReceipt
} = {}) {
  if (typeof verifyCandidate !== 'function' || typeof readVerifiedReceipt !== 'function') {
    fail('REV_CODE_RESULT_READER_REQUIRED', 'Verified candidate and receipt readers are required.');
  }
  const candidate = reference(candidateReference);
  if (await verifyCandidate(candidate) !== true) {
    fail('REV_CODE_RESULT_CANDIDATE_UNVERIFIED', 'Code result needs a verified retained candidate.');
  }
  const candidateRefSha256 = hash(candidate);
  const scope = {
    phaseId: identifier(phaseId, 'phase ID'),
    phaseGeneration, configSha256: requiredHash(configSha256, 'configuration'),
    proofProfileSha256: requiredHash(proofProfileSha256, 'proof profile'),
    environmentSha256: requiredHash(environmentSha256, 'environment')
  };
  if (!Number.isSafeInteger(phaseGeneration) || phaseGeneration < 0) {
    fail('REV_CODE_RESULT_INPUT', 'Phase generation must be a non-negative safe integer.');
  }
  if (!Array.isArray(registeredChecks) || registeredChecks.length > MAX_CHECKS) {
    fail('REV_CODE_RESULT_INPUT', 'Registered checks must be a bounded exact inventory.');
  }
  const definitions = registeredChecks.map(checkDefinition);
  if (new Set(definitions.map((item) => item.checkId)).size !== definitions.length) {
    fail('REV_CODE_RESULT_INPUT', 'Registered check IDs must be unique.');
  }
  const rows = [];
  for (const check of definitions) {
    const raw = await readVerifiedReceipt(check.checkId);
    if (raw == null) {
      rows.push({ checkId: check.checkId, kind: check.kind, label: check.label,
        status: 'unavailable', reason: 'NO_VERIFIED_RECEIPT', receiptSha256: null,
        tests: null, logSha256: null, artifacts: [] });
      continue;
    }
    const item = receipt(raw, check.checkId);
    const reasons = staleReasons(item, candidate, candidateRefSha256, scope, check);
    if (reasons.length) {
      rows.push({ checkId: check.checkId, kind: check.kind, label: check.label,
        status: 'stale', reason: 'BINDING_CHANGED', staleBindings: reasons,
        receiptSha256: item.receiptSha256, tests: null, logSha256: null, artifacts: [] });
      continue;
    }
    const tests = testCounts(item.tests);
    if (item.status === 'passed' && (item.exitCode !== 0 || (tests && tests.failed !== 0))) {
      fail('REV_CODE_RESULT_RECEIPT_INVALID', 'A passed Code check has contradictory execution totals.');
    }
    rows.push({ checkId: check.checkId, kind: check.kind, label: check.label,
      status: item.status, reason: item.reason ?? null,
      receiptSha256: item.receiptSha256, exitCode: item.exitCode ?? null,
      tests, logSha256: HASH.test(String(item.logSha256 ?? '')) ? item.logSha256 : null,
      artifacts: item.artifacts.map((artifact) => artifactProjection(artifact, check)) });
  }
  const core = {
    schemaVersion: 1, kind: 'revision-code-check-result',
    candidateId: candidate.candidateId, candidateSha256: candidate.candidateSha256,
    candidateRefSha256, candidateTree: candidate.repository.candidateTree,
    ...scope, checkRegistrySha256: hash(definitions),
    status: aggregate(rows), reason: definitions.length ? null : 'NO_REGISTERED_CHECKS',
    checks: rows, testingVerificationStatus: 'not-established-by-code-result',
    publicationEligibilityEstablished: false
  };
  return { ...core, resultSha256: hash(core) };
}
