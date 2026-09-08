import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const FOS_ADAPTER_TYPES = Object.freeze([
  'identity', 'notification', 'server-gate', 'workflow-import'
]);

export const FOS_ADAPTER_SCENARIOS = Object.freeze({
  identity: Object.freeze([
    'authenticate-principal', 'alias-refusal', 'delegation-revocation',
    'principal-revocation', 'separation-of-duties'
  ]),
  notification: Object.freeze([
    'deliver', 'duplicate-delivery', 'offline-retry', 'non-authoritative-delivery'
  ]),
  'server-gate': Object.freeze([
    'branch-protection', 'block-failure', 'exact-commit', 'preserve-existing-checks'
  ]),
  'workflow-import': Object.freeze([
    'altered-artifact-refusal', 'exact-witnesses', 'fork-refusal',
    'incomplete-test-refusal', 'stale-commit-refusal', 'trusted-source'
  ])
});

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const verifiedSets = new WeakMap();

function fail(message, code = 'FOS_ADAPTER_CERTIFICATION_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function text(value, label, maximum = 256) {
  const result = String(value ?? '').trim();
  if (!result || Buffer.byteLength(result) > maximum) fail(`${label} is missing or too large.`);
  return result;
}

function hash(value, label) {
  const result = text(value, label, 80);
  if (!HASH.test(result)) fail(`${label} must be a complete SHA-256 identity.`);
  return result;
}

function principal(value, label) {
  const result = text(value, label);
  if (!ID.test(result)) fail(`${label} must be a stable principal identifier.`);
  return result;
}

function certificationCore(record) {
  const result = structuredClone(record);
  delete result.attestation;
  delete result.payloadSha256;
  return result;
}

export function fosAdapterCertificationPayloadSha256(record) {
  return `sha256:${recordSha256(certificationCore(record))}`;
}

function runtimeMethod(type) {
  return {
    identity: 'verifyPrincipal',
    notification: 'deliver',
    'server-gate': 'verifyProtection',
    'workflow-import': 'verifyEvidence'
  }[type];
}

function parseCertification(value, { now, policySha256, trustRootSha256 } = {}) {
  const record = readRecord('fos-adapter-certification', value).record;
  if (record.kind !== 'fos-adapter-certification' || !FOS_ADAPTER_TYPES.includes(record.adapterType)) {
    fail('Unknown FOS adapter certification type.');
  }
  const adapterType = record.adapterType;
  const adapterId = principal(record.adapterId, 'adapterId');
  const adapterVersion = text(record.adapterVersion, 'adapterVersion', 64);
  const implementationSha256 = hash(record.implementationSha256, 'implementationSha256');
  const contractSha256 = hash(record.contractSha256, 'contractSha256');
  const recordedPolicy = hash(record.policySha256, 'policySha256');
  const recordedTrustRoot = hash(record.trustRootSha256, 'trustRootSha256');
  hash(record.evidenceSha256, 'evidenceSha256');
  hash(record.runner?.environmentSha256, 'runner.environmentSha256');
  text(record.runner?.identity, 'runner.identity');
  text(record.runner?.platform, 'runner.platform', 64);
  text(record.runner?.architecture, 'runner.architecture', 64);
  const testedAt = Date.parse(record.testedAt ?? '');
  const expiresAt = Date.parse(record.expiresAt ?? '');
  if (!Number.isFinite(testedAt) || !Number.isFinite(expiresAt) || expiresAt <= testedAt
      || testedAt > now.getTime() || expiresAt <= now.getTime()) {
    fail('Adapter certification is expired, future-dated, or has an invalid validity interval.');
  }
  if (record.status !== 'passed' || record.claimsOperationalAuthority !== false) {
    fail('Adapter certification must be passed and cannot itself grant operational authority.');
  }
  if (recordedPolicy !== policySha256 || recordedTrustRoot !== trustRootSha256) {
    fail('Adapter certification does not match the selected policy and trust root.', 'FOS_ADAPTER_CERTIFICATION_STALE');
  }
  const scenarios = [...new Set((record.scenarios ?? []).map(String))].sort();
  const missing = FOS_ADAPTER_SCENARIOS[adapterType].filter((scenario) => !scenarios.includes(scenario));
  if (missing.length) fail(`Adapter certification is missing required scenario(s): ${missing.join(', ')}.`);
  const reviewer = principal(record.independentReviewerPrincipalId, 'independentReviewerPrincipalId');
  if (reviewer === record.runner.identity) fail('Adapter certification requires an independent reviewer.');
  if (record.payloadSha256 !== fosAdapterCertificationPayloadSha256(record)) {
    fail('Adapter certification payload digest does not match its exact content.');
  }
  const format = text(record.attestation?.format, 'attestation.format', 64);
  const keyId = text(record.attestation?.keyId, 'attestation.keyId');
  const signature = text(record.attestation?.signature, 'attestation.signature', 16 * 1024);
  return Object.freeze({
    record: Object.freeze(structuredClone(record)), adapterType, adapterId, adapterVersion,
    implementationSha256, contractSha256, reviewer,
    attestation: Object.freeze({ format, keyId, signature })
  });
}

/**
 * Verify live adapter evidence through an already trusted attestation verifier and bind that
 * evidence to the exact runtime implementations used in this process. The returned object is
 * deliberately process-local and branded by object identity; serializing it cannot preserve the
 * brand or turn copied JSON/booleans into adapter authority.
 */
export async function verifyFosAdapterSet({ certifications = [], adapters = [] } = {}, {
  verifyAttestation, policySha256, trustRootSha256, now = new Date()
} = {}) {
  hash(policySha256, 'policySha256');
  hash(trustRootSha256, 'trustRootSha256');
  if (typeof verifyAttestation !== 'function') {
    fail('FOS adapter certification requires a trusted attestation verifier.', 'TRUST_REQUIRED');
  }
  if (!Array.isArray(certifications) || !Array.isArray(adapters)) {
    fail('FOS adapter certifications and runtime adapters must be arrays.');
  }
  const runtimeByType = new Map();
  for (const adapter of adapters) {
    if (!FOS_ADAPTER_TYPES.includes(adapter?.type) || runtimeByType.has(adapter.type)) {
      fail('Runtime adapters must contain at most one known adapter per type.');
    }
    const method = runtimeMethod(adapter.type);
    if (typeof adapter[method] !== 'function') fail(`Runtime ${adapter.type} adapter lacks '${method}'.`);
    // Capture the exact callable surface now so replacing a method on the caller's mutable object
    // after verification cannot substitute a different implementation under the same receipt.
    runtimeByType.set(adapter.type, Object.freeze({ ...adapter }));
  }
  const bound = new Map();
  const summaries = [];
  for (const supplied of certifications) {
    const parsed = parseCertification(supplied, { now, policySha256, trustRootSha256 });
    if (bound.has(parsed.adapterType)) fail(`More than one ${parsed.adapterType} certification was supplied.`);
    const runtime = runtimeByType.get(parsed.adapterType);
    if (!runtime || runtime.id !== parsed.adapterId || runtime.version !== parsed.adapterVersion
        || runtime.implementationSha256 !== parsed.implementationSha256
        || runtime.contractSha256 !== parsed.contractSha256) {
      fail(`The certified ${parsed.adapterType} implementation is not the runtime implementation.`,
        'FOS_ADAPTER_IMPLEMENTATION_MISMATCH');
    }
    const verdict = await verifyAttestation(Object.freeze({
      payloadSha256: parsed.record.payloadSha256,
      trustRootSha256,
      reviewerPrincipalId: parsed.reviewer,
      attestation: parsed.attestation,
      certification: parsed.record
    }));
    if (verdict?.verified !== true || verdict.payloadSha256 !== parsed.record.payloadSha256
        || verdict.trustRootSha256 !== trustRootSha256
        || verdict.signerPrincipalId !== parsed.reviewer) {
      fail(`The ${parsed.adapterType} certification attestation was not verified.`,
        'FOS_ADAPTER_ATTESTATION_INVALID');
    }
    bound.set(parsed.adapterType, runtime);
    summaries.push(Object.freeze({
      type: parsed.adapterType, id: parsed.adapterId, version: parsed.adapterVersion,
      implementationSha256: parsed.implementationSha256,
      certificationSha256: `sha256:${recordSha256(parsed.record)}`,
      expiresAt: parsed.record.expiresAt
    }));
  }
  const set = Object.freeze({
    schemaVersion: currentSchemaVersion('fos-adapter-set'),
    kind: 'fos-verified-adapter-set',
    status: bound.size === FOS_ADAPTER_TYPES.length ? 'all-prerequisites-verified' : 'partial',
    policySha256, trustRootSha256,
    adapters: Object.freeze(summaries.sort((left, right) => left.type.localeCompare(right.type))),
    grantsOperationalAuthority: false
  });
  verifiedSets.set(set, bound);
  return set;
}

export function certifiedFosAdapterTypes(set) {
  const adapters = verifiedSets.get(set);
  return Object.freeze(adapters ? [...adapters.keys()].sort() : []);
}

export function requireCertifiedFosAdapter(set, type) {
  if (!FOS_ADAPTER_TYPES.includes(type)) fail(`Unknown FOS adapter type '${type}'.`);
  const adapter = verifiedSets.get(set)?.get(type);
  if (!adapter) fail(`A verified ${type} adapter is required.`, 'TRUST_REQUIRED');
  return adapter;
}
