import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessProvenanceAttestation, buildProvenanceAttestation, M10_PROVENANCE_FAMILIES,
  normalizeProvenanceProvider, provenanceReadiness, validateProvenanceAttestation
} from '../src/delivery-modes/provenance.mjs';
import {
  currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot
} from '../src/schema-migrations.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repositoryRoot, 'bin', 'singularity-flow.mjs');
const digest = (character) => `sha256:${character.repeat(64)}`;
const signatureBase64 = Buffer.from('public-test-signature').toString('base64');
const signatureSha256 = `sha256:${createHash('sha256').update(Buffer.from(signatureBase64, 'base64')).digest('hex')}`;

function provider(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'gdp-provenance-provider', providerId: 'office-ci',
    providerType: 'provider-neutral-test', trustRootSha256: digest('1'),
    verifierId: 'detached-signature-v1', acceptedIssuerDigests: [digest('2')],
    acceptedAudienceDigests: [digest('3')], enabled: true, ...overrides
  };
}

function fields(kind, overrides = {}) {
  const common = {
    providerId: 'office-ci', issuerSha256: digest('2'), audienceSha256: digest('3'),
    proofSubjectSha256: digest('4'), candidateSha256: digest('5'), nonceSha256: digest('6'),
    issuedAt: '2026-09-04T00:00:00.000Z', expiresAt: '2026-09-05T00:00:00.000Z',
    policyEpochSha256: digest('7'), signerKeyIdSha256: digest('8'),
    signatureBase64, signatureSha256
  };
  const specific = {
    'build-attestation': { toolchainSha256: digest('9'), artifactSha256: digest('a') },
    'provider-environment-attestation': { environmentSha256: digest('b'), targetSha256: digest('c') },
    'deployment-attestation': {
      artifactSha256: digest('a'), targetSha256: digest('c'), deploymentSha256: digest('d')
    },
    'runtime-identity-attestation': {
      deploymentSha256: digest('d'), runtimeIdentitySha256: digest('e'),
      environmentAttestationSha256: digest('f')
    },
    'production-observation': {
      deploymentSha256: digest('d'), runtimeIdentitySha256: digest('e'), resultSha256: digest('0')
    }
  }[kind];
  return { ...common, ...specific, ...overrides };
}

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_NETWORK: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'GDP M10 Tester'
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result;
}
function git(root, ...args) { return execute('git', args, root); }
function sflow(root, ...args) { return execute(process.execPath, [cli, ...args], root); }

test('M10 is unavailable without configuration and remains fail-closed without a verifier', () => {
  assert.deepEqual(provenanceReadiness(), {
    schemaVersion: 1, kind: 'gdp-provenance-readiness', status: 'unavailable',
    configured: false, verifierAvailable: false, authority: 'none',
    gaps: ['PROVENANCE_PROVIDER_NOT_CONFIGURED'], acceptedFamilies: []
  });
  const configured = provenanceReadiness(provider());
  assert.equal(configured.configured, true);
  assert.equal(configured.status, 'unavailable');
  assert.equal(configured.authority, 'none');
  assert.deepEqual(configured.gaps, ['PROVENANCE_VERIFIER_NOT_INSTALLED']);
  assert.deepEqual(configured.acceptedFamilies, []);
  assert.throws(() => normalizeProvenanceProvider({ ...provider(), token: 'secret' }), /invalid field set/);
});

test('M10 builds five exact provider-neutral envelopes without credentials', async () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const [kind, descriptor] of Object.entries(M10_PROVENANCE_FAMILIES)) {
    const record = buildProvenanceAttestation(kind, fields(kind));
    assert.deepEqual(validateProvenanceAttestation(kind, record), record);
    assert.equal(currentSchemaVersion(kind), 1);
    assert.equal(registry.get(kind).immutable, true);
    const schema = JSON.parse(await readFile(path.join(repositoryRoot, 'schemas', `gdp-${kind}.schema.json`), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort());
    assert.equal(familyForStoredPath(
      `singularity/work-items/GDP-M10/gdp/evidence/${kind}/${'a'.repeat(64)}.json`
    )?.id, kind);
    assert.match(record[descriptor.hash], /^sha256:/);
    assert.doesNotMatch(JSON.stringify(record), /token|password|credential|\/Users\//i);
  }
});

test('M10 rejects altered signatures, replay, expiry, revocation, issuer, and audience drift', async () => {
  const record = buildProvenanceAttestation('build-attestation', fields('build-attestation'));
  assert.throws(() => buildProvenanceAttestation('build-attestation', fields(
    'build-attestation', { signatureSha256: digest('f') }
  )), /signature digest/);
  const unavailable = await assessProvenanceAttestation('build-attestation', record, {
    configuration: provider(), now: '2026-09-04T12:00:00.000Z'
  });
  assert.deepEqual(unavailable.reasons, ['PROVENANCE_VERIFIER_NOT_INSTALLED']);
  const refused = await assessProvenanceAttestation('build-attestation', record, {
    configuration: provider({
      acceptedIssuerDigests: [digest('a')], acceptedAudienceDigests: [digest('b')]
    }),
    verifier: async () => true, now: '2026-09-06T00:00:00.000Z',
    seenNonceDigests: [record.nonceSha256], revokedSignerKeyDigests: [record.signerKeyIdSha256]
  });
  assert.equal(refused.status, 'unavailable');
  assert.deepEqual(refused.reasons, [
    'PROVENANCE_AUDIENCE_UNTRUSTED', 'PROVENANCE_EXPIRED', 'PROVENANCE_ISSUER_UNTRUSTED',
    'PROVENANCE_NONCE_REPLAYED', 'PROVENANCE_SIGNER_REVOKED'
  ]);
});

test('M10 accepts only the explicit verifier result after every deterministic check', async () => {
  const record = buildProvenanceAttestation('deployment-attestation', fields('deployment-attestation'));
  const verified = await assessProvenanceAttestation('deployment-attestation', record, {
    configuration: provider(), now: '2026-09-04T12:00:00.000Z',
    verifier: async ({ verifierId, trustRootSha256, record: supplied }) => (
      verifierId === 'detached-signature-v1'
      && trustRootSha256 === digest('1')
      && supplied.attestationSha256 === record.attestationSha256
    )
  });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.authority, 'configured-provider');
  const invalid = await assessProvenanceAttestation('deployment-attestation', record, {
    configuration: provider(), now: '2026-09-04T12:00:00.000Z', verifier: async () => false
  });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.authority, 'none');
});

test('M10 CLI reports honest readiness and never accepts provider evidence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gdp-m10-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'GDP M10 Tester');
  git(root, 'config', 'user.email', 'gdp-m10@example.com');
  sflow(root, 'init');
  await writeFile(path.join(root, 'provider.json'), `${JSON.stringify(provider(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize GDP M10 fixture');
  const before = git(root, 'rev-parse', 'HEAD').stdout.trim();
  const empty = JSON.parse(sflow(root, 'delivery', 'provenance-status', '--json').stdout);
  assert.equal(empty.data.configured, false);
  const configured = JSON.parse(sflow(
    root, 'delivery', 'provenance-status', '--provider-file', 'provider.json', '--json'
  ).stdout);
  assert.equal(configured.data.configured, true);
  assert.equal(configured.data.verifierAvailable, false);
  assert.equal(configured.data.authority, 'none');
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout.trim(), before);
  assert.equal(git(root, 'status', '--porcelain').stdout, '');
});
