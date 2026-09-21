/**
 * CAB-R2 authenticated-runner provider foundation.
 *
 * This module validates a closed, credential-free declaration and reports what is still absent.
 * It deliberately does not load a provider, verify an attestation, execute Candidate code, create
 * evidence, upgrade assurance, or participate in a lifecycle gate. External authority is required
 * before any of those capabilities can exist.
 */
import { canonicalJson } from '../records.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PROVIDER_ID = /^cabp_[a-f0-9]{64}$/u;
const INTEGRATION_ID = /^cabi_[a-f0-9]{64}$/u;
const PROVIDER_TYPES = new Set(['enterprise-ci', 'independent-runner-service']);
const CONFIGURATION_FIELDS = Object.freeze([
  'schemaVersion', 'kind', 'providerId', 'providerType', 'integrationId',
  'trustRootSha256', 'runnerProfileSha256', 'sandboxPolicySha256', 'trustPolicySha256',
  'resultIngestionPolicySha256', 'evidencePolicySha256',
  'acceptedIssuerDigests', 'acceptedAudienceDigests', 'enabled'
]);

function fail(message, code = 'CAB_RUNNER_PROVIDER_INVALID') {
  const error = new TypeError(`CAB authenticated-runner provider: ${message}`);
  error.code = code;
  throw error;
}

function exactKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort())
        !== canonicalJson([...CONFIGURATION_FIELDS].sort())) {
    fail('configuration has an invalid field set. Credentials, commands, paths, and endpoints are not allowed.');
  }
}

function identifier(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    fail(`${label} must be a sha256 digest string.`);
  }
  return value;
}

function uniqueDigests(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail(`${label} must contain 1-64 sha256 digests.`);
  }
  const normalized = value.map((entry) => digest(entry, label)).sort();
  if (new Set(normalized).size !== normalized.length) fail(`${label} contains duplicates.`);
  return Object.freeze(normalized);
}

/** Validate a reviewed, repository-relative provider declaration. This is not an approval. */
export function normalizeAuthenticatedRunnerProvider(value) {
  exactKeys(value);
  if (value.schemaVersion !== 1 || value.kind !== 'cab-authenticated-runner-provider') { // schema-transient: reviewed configuration input, not a durable record
    fail('configuration schema is not current.');
  }
  if (!PROVIDER_TYPES.has(value.providerType)) {
    fail(`providerType must be one of: ${[...PROVIDER_TYPES].join(', ')}.`);
  }
  if (typeof value.enabled !== 'boolean') fail('enabled must be boolean.');
  return Object.freeze({
    schemaVersion: 1,
    kind: value.kind,
    providerId: identifier(value.providerId, 'providerId', PROVIDER_ID),
    providerType: value.providerType,
    integrationId: identifier(value.integrationId, 'integrationId', INTEGRATION_ID),
    trustRootSha256: digest(value.trustRootSha256, 'trustRootSha256'),
    runnerProfileSha256: digest(value.runnerProfileSha256, 'runnerProfileSha256'),
    sandboxPolicySha256: digest(value.sandboxPolicySha256, 'sandboxPolicySha256'),
    trustPolicySha256: digest(value.trustPolicySha256, 'trustPolicySha256'),
    resultIngestionPolicySha256: digest(
      value.resultIngestionPolicySha256, 'resultIngestionPolicySha256'
    ),
    evidencePolicySha256: digest(value.evidencePolicySha256, 'evidencePolicySha256'),
    acceptedIssuerDigests: uniqueDigests(value.acceptedIssuerDigests, 'acceptedIssuerDigests'),
    acceptedAudienceDigests: uniqueDigests(value.acceptedAudienceDigests, 'acceptedAudienceDigests'),
    enabled: value.enabled
  });
}

function check(id, status, detail) {
  return Object.freeze({ id, status, detail });
}

/**
 * Read-only CAB-R2 doctor projection. A descriptor can remove only the configuration gap; all
 * authority, integration, platform, containment, pilot, and storage gaps remain external.
 */
export function authenticatedRunnerReadiness(configuration = null) {
  const provider = configuration == null ? null : normalizeAuthenticatedRunnerProvider(configuration);
  const configured = provider !== null;
  const enabled = provider?.enabled === true;
  const gaps = [
    ...(!configured ? ['CAB_RUNNER_PROVIDER_NOT_CONFIGURED'] : []),
    ...(configured && !enabled ? ['CAB_RUNNER_PROVIDER_DISABLED'] : []),
    'CAB_RUNNER_INTEGRATION_NOT_INSTALLED',
    'CAB_RUNNER_TRUST_AUTHORITY_NOT_APPROVED',
    'CAB_RUNNER_SANDBOX_EVIDENCE_MISSING',
    'CAB_RUNNER_PLATFORM_EVIDENCE_MISSING',
    'CAB_RUNNER_PROVIDER_PILOTS_MISSING',
    'CAB_RUNNER_EVIDENCE_STORAGE_AUTHORITY_MISSING'
  ];
  return Object.freeze({
    schemaVersion: 1,
    kind: 'cab-authenticated-runner-readiness',
    status: 'unavailable',
    configured,
    enabled,
    integrationAvailable: false,
    verifierAvailable: false,
    authority: 'none',
    gateEligible: false,
    consumedByLifecycle: false,
    enforcementAvailable: false,
    assuranceUpgradeAvailable: false,
    provider: provider == null ? null : Object.freeze({
      providerId: provider.providerId,
      providerType: provider.providerType,
      integrationId: provider.integrationId,
      trustRootSha256: provider.trustRootSha256,
      runnerProfileSha256: provider.runnerProfileSha256,
      sandboxPolicySha256: provider.sandboxPolicySha256,
      trustPolicySha256: provider.trustPolicySha256,
      resultIngestionPolicySha256: provider.resultIngestionPolicySha256,
      evidencePolicySha256: provider.evidencePolicySha256
    }),
    gaps: Object.freeze([...gaps]),
    acceptedEvidenceFamilies: Object.freeze([]),
    checks: Object.freeze([
      check('provider-configuration', configured ? (enabled ? 'declared' : 'disabled') : 'missing',
        configured
          ? 'A closed credential-free descriptor was validated; it grants no authority.'
          : 'No authenticated-runner provider descriptor was supplied.'),
      check('provider-integration', 'unavailable',
        'No authenticated runner integration is installed by this build.'),
      check('trust-authority', 'unavailable',
        'No independently approved trust-root, revocation, replay, or signer authority is installed.'),
      check('hermetic-platform-evidence', 'unavailable',
        'No supported-platform containment and process-quiescence evidence is installed.'),
      check('provider-pilots', 'unavailable',
        'No independently reviewed outage, replay, revocation, privacy, or retention pilot is installed.'),
      check('lifecycle-consumption', 'unavailable',
        'CAB evidence is not accepted by lifecycle gates and cannot upgrade assurance.')
    ])
  });
}

export const AUTHENTICATED_RUNNER_PROVIDER_TYPES = Object.freeze([...PROVIDER_TYPES]);
