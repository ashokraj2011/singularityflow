/** GDP-M10 provider-neutral provenance contracts. No provider or verifier is built in. */
import { createHash } from 'node:crypto';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const MAX_ID = 160;

const DESCRIPTORS = Object.freeze({
  'build-attestation': Object.freeze({
    hash: 'attestationSha256', specific: ['toolchainSha256', 'artifactSha256']
  }),
  'provider-environment-attestation': Object.freeze({
    hash: 'attestationSha256', specific: ['environmentSha256', 'targetSha256']
  }),
  'deployment-attestation': Object.freeze({
    hash: 'attestationSha256', specific: ['artifactSha256', 'targetSha256', 'deploymentSha256']
  }),
  'runtime-identity-attestation': Object.freeze({
    hash: 'attestationSha256', specific: [
      'deploymentSha256', 'runtimeIdentitySha256', 'environmentAttestationSha256'
    ]
  }),
  'production-observation': Object.freeze({
    hash: 'observationSha256', specific: [
      'deploymentSha256', 'runtimeIdentitySha256', 'resultSha256'
    ]
  })
});
const COMMON_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'providerId', 'issuerSha256', 'audienceSha256',
  'proofSubjectSha256', 'candidateSha256', 'nonceSha256', 'issuedAt', 'expiresAt',
  'policyEpochSha256', 'signerKeyIdSha256', 'signatureBase64', 'signatureSha256'
]);
const CONFIG_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'providerId', 'providerType', 'trustRootSha256',
  'verifierId', 'acceptedIssuerDigests', 'acceptedAudienceDigests', 'enabled'
]);

function fail(message, code = 'PFC_PROVENANCE_INVALID') {
  const error = new TypeError(`GDP provenance: ${message}`); error.code = code; throw error;
}
function digest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}
function id(value, label) {
  const result = String(value ?? '');
  if (result.length > MAX_ID || !ID.test(result)) fail(`${label} is invalid.`);
  return result;
}
function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label} must be canonical ISO-8601.`);
  return value;
}
function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} has an invalid field set.`);
  }
}
function uniqueDigests(values, label) {
  if (!Array.isArray(values) || !values.length || values.length > 64) fail(`${label} must contain 1-64 digests.`);
  const result = values.map((value) => digest(value, label)).sort();
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates.`);
  return result;
}
function hash(value) { return `sha256:${recordSha256(value)}`; }
function signature(value, expectedSha256) {
  const encoded = String(value ?? '');
  if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail('signatureBase64 is invalid.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) fail('signatureBase64 is not canonical base64.');
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== digest(expectedSha256, 'signatureSha256')) fail('signature digest does not match signature bytes.');
  return encoded;
}

export function normalizeProvenanceProvider(value) {
  exactKeys(value, CONFIG_FIELDS, 'provider configuration');
  if (value.schemaVersion !== 1 || value.kind !== 'gdp-provenance-provider') { // schema-transient: reviewed provider configuration input
    fail('provider schema is not current.');
  }
  if (typeof value.enabled !== 'boolean') fail('enabled must be boolean.');
  return Object.freeze({
    schemaVersion: 1, kind: value.kind,
    providerId: id(value.providerId, 'providerId'),
    providerType: id(value.providerType, 'providerType'),
    trustRootSha256: digest(value.trustRootSha256, 'trustRootSha256'),
    verifierId: id(value.verifierId, 'verifierId'),
    acceptedIssuerDigests: uniqueDigests(value.acceptedIssuerDigests, 'acceptedIssuerDigests'),
    acceptedAudienceDigests: uniqueDigests(value.acceptedAudienceDigests, 'acceptedAudienceDigests'),
    enabled: value.enabled
  });
}

export function buildProvenanceAttestation(kind, fields) {
  const descriptor = DESCRIPTORS[kind];
  if (!descriptor) fail(`unknown attestation family '${kind}'.`);
  exactKeys(fields, [...COMMON_FIELDS.filter((field) => !['schemaVersion', 'kind'].includes(field)),
    ...descriptor.specific], `${kind} fields`);
  const issuedAt = instant(fields.issuedAt, 'issuedAt');
  const expiresAt = instant(fields.expiresAt, 'expiresAt');
  if (new Date(expiresAt) <= new Date(issuedAt)) fail('expiresAt must be after issuedAt.');
  const core = {
    schemaVersion: currentSchemaVersion(kind), kind,
    providerId: id(fields.providerId, 'providerId'),
    issuerSha256: digest(fields.issuerSha256, 'issuerSha256'),
    audienceSha256: digest(fields.audienceSha256, 'audienceSha256'),
    proofSubjectSha256: digest(fields.proofSubjectSha256, 'proofSubjectSha256'),
    candidateSha256: digest(fields.candidateSha256, 'candidateSha256'),
    nonceSha256: digest(fields.nonceSha256, 'nonceSha256'), issuedAt, expiresAt,
    policyEpochSha256: digest(fields.policyEpochSha256, 'policyEpochSha256'),
    signerKeyIdSha256: digest(fields.signerKeyIdSha256, 'signerKeyIdSha256'),
    signatureBase64: signature(fields.signatureBase64, fields.signatureSha256),
    signatureSha256: digest(fields.signatureSha256, 'signatureSha256'),
    ...Object.fromEntries(descriptor.specific.map((field) => [field, digest(fields[field], field)]))
  };
  return Object.freeze({ ...core, [descriptor.hash]: hash(core) });
}

export function validateProvenanceAttestation(kind, value) {
  const descriptor = DESCRIPTORS[kind];
  if (!descriptor) fail(`unknown attestation family '${kind}'.`);
  exactKeys(value, [...COMMON_FIELDS, ...descriptor.specific, descriptor.hash], kind);
  const readable = readRecord(kind, value);
  if (readable.migratedThrough.length || value.kind !== kind) fail(`${kind} is not current.`);
  const normalized = buildProvenanceAttestation(kind, Object.fromEntries(
    [...COMMON_FIELDS.filter((field) => !['schemaVersion', 'kind'].includes(field)),
      ...descriptor.specific].map((field) => [field, value[field]])
  ));
  if (canonicalJson(normalized) !== canonicalJson(value)) fail(`${kind} is not canonical.`);
  const core = structuredClone(value); delete core[descriptor.hash];
  if (value[descriptor.hash] !== hash(core)) fail(`${kind} self hash is invalid.`);
  return Object.freeze(structuredClone(value));
}

export function provenanceReadiness(configuration = null) {
  if (!configuration) return Object.freeze({
    schemaVersion: 1, kind: 'gdp-provenance-readiness', status: 'unavailable',
    configured: false, verifierAvailable: false, authority: 'none',
    gaps: ['PROVENANCE_PROVIDER_NOT_CONFIGURED'], acceptedFamilies: []
  });
  const provider = normalizeProvenanceProvider(configuration);
  const gaps = [
    ...(provider.enabled ? [] : ['PROVENANCE_PROVIDER_DISABLED']),
    'PROVENANCE_VERIFIER_NOT_INSTALLED'
  ];
  return Object.freeze({
    schemaVersion: 1, kind: 'gdp-provenance-readiness', status: 'unavailable',
    configured: true, verifierAvailable: false, authority: 'none', gaps,
    provider: {
      providerId: provider.providerId, providerType: provider.providerType,
      verifierId: provider.verifierId, trustRootSha256: provider.trustRootSha256
    },
    acceptedFamilies: []
  });
}

export async function assessProvenanceAttestation(kind, value, {
  configuration, verifier = null, now, seenNonceDigests = [], revokedSignerKeyDigests = []
} = {}) {
  const record = validateProvenanceAttestation(kind, value);
  const provider = normalizeProvenanceProvider(configuration);
  const checkedAt = new Date(now);
  if (!Number.isFinite(checkedAt.getTime())) fail('now is required and must be valid.');
  const reasons = [];
  if (!provider.enabled) reasons.push('PROVENANCE_PROVIDER_DISABLED');
  if (provider.providerId !== record.providerId) reasons.push('PROVENANCE_PROVIDER_MISMATCH');
  if (!provider.acceptedIssuerDigests.includes(record.issuerSha256)) reasons.push('PROVENANCE_ISSUER_UNTRUSTED');
  if (!provider.acceptedAudienceDigests.includes(record.audienceSha256)) reasons.push('PROVENANCE_AUDIENCE_UNTRUSTED');
  if (seenNonceDigests.includes(record.nonceSha256)) reasons.push('PROVENANCE_NONCE_REPLAYED');
  if (revokedSignerKeyDigests.includes(record.signerKeyIdSha256)) reasons.push('PROVENANCE_SIGNER_REVOKED');
  if (checkedAt < new Date(record.issuedAt)) reasons.push('PROVENANCE_NOT_YET_VALID');
  if (checkedAt >= new Date(record.expiresAt)) reasons.push('PROVENANCE_EXPIRED');
  if (typeof verifier !== 'function') reasons.push('PROVENANCE_VERIFIER_NOT_INSTALLED');
  if (reasons.length) return Object.freeze({
    schemaVersion: 1, kind: 'gdp-provenance-assessment', family: kind,
    status: 'unavailable', authority: 'none', reasons: [...new Set(reasons)].sort(),
    attestationSha256: record[DESCRIPTORS[kind].hash]
  });
  const verified = await verifier({
    verifierId: provider.verifierId, trustRootSha256: provider.trustRootSha256,
    record: structuredClone(record)
  });
  return Object.freeze({
    schemaVersion: 1, kind: 'gdp-provenance-assessment', family: kind,
    status: verified === true ? 'verified' : 'failed',
    authority: verified === true ? 'configured-provider' : 'none',
    reasons: verified === true ? [] : ['PROVENANCE_SIGNATURE_INVALID'],
    attestationSha256: record[DESCRIPTORS[kind].hash]
  });
}

export const M10_PROVENANCE_FAMILIES = DESCRIPTORS;
