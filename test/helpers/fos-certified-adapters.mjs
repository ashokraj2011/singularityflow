import {
  FOS_ADAPTER_SCENARIOS, fosAdapterCertificationPayloadSha256, verifyFosAdapterSet
} from '../../src/fos-adapters.mjs';
import { currentSchemaVersion } from '../../src/schema-migrations.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

export const FOS_TEST_POLICY_SHA256 = sha('a');
export const FOS_TEST_TRUST_ROOT_SHA256 = sha('b');

function runtime(type, index, implementation = {}) {
  const methods = {
    identity: { async verifyPrincipal() { return { authenticated: false }; } },
    notification: { async deliver() { return { delivered: false, code: 'TEST_ONLY' }; } },
    'server-gate': { async verifyProtection() { return { verified: false }; } },
    'workflow-import': { async verifyEvidence() { return { trusted: false }; } }
  }[type];
  return {
    type,
    id: `test:${type}`,
    version: '1.0.0',
    implementationSha256: sha(String(index)),
    contractSha256: sha('c'),
    ...methods,
    ...implementation
  };
}

function certification(adapter, index, overrides = {}) {
  const record = {
    schemaVersion: currentSchemaVersion('fos-adapter-certification'),
    kind: 'fos-adapter-certification',
    adapterType: adapter.type,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    implementationSha256: adapter.implementationSha256,
    contractSha256: adapter.contractSha256,
    policySha256: FOS_TEST_POLICY_SHA256,
    trustRootSha256: FOS_TEST_TRUST_ROOT_SHA256,
    evidenceSha256: sha('d'),
    runner: {
      identity: `runner:${index}`,
      platform: 'test-platform',
      architecture: 'test-architecture',
      environmentSha256: sha('e')
    },
    testedAt: '2029-01-01T00:00:00.000Z',
    expiresAt: '2031-01-01T00:00:00.000Z',
    status: 'passed',
    scenarios: [...FOS_ADAPTER_SCENARIOS[adapter.type]],
    independentReviewerPrincipalId: `reviewer:${index}`,
    claimsOperationalAuthority: false,
    ...overrides,
    attestation: overrides.attestation ?? {
      format: 'test-detached-signature', keyId: `test-key-${index}`, signature: `signature-${index}`
    }
  };
  record.payloadSha256 = fosAdapterCertificationPayloadSha256(record);
  return record;
}

export function fakeFosAdapterInputs(implementations = {}, {
  types = ['identity', 'notification', 'server-gate', 'workflow-import'],
  certificationOverrides = {}
} = {}) {
  const adapters = types.map((type, index) => runtime(type, index + 1, implementations[type]));
  const certifications = adapters.map((adapter, index) => certification(
    adapter, index + 1, certificationOverrides[adapter.type]
  ));
  return { certifications, adapters };
}

export async function fakeCertifiedFosAdapterSet(implementations = {}, options = {}) {
  const { certifications, adapters } = fakeFosAdapterInputs(implementations, options);
  return verifyFosAdapterSet({ certifications, adapters }, {
    policySha256: FOS_TEST_POLICY_SHA256,
    trustRootSha256: FOS_TEST_TRUST_ROOT_SHA256,
    now: new Date('2030-01-01T00:00:00.000Z'),
    verifyAttestation: async ({ payloadSha256, trustRootSha256, reviewerPrincipalId }) => ({
      verified: true, payloadSha256, trustRootSha256, signerPrincipalId: reviewerPrincipalId
    })
  });
}
