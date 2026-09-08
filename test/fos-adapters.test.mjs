import assert from 'node:assert/strict';
import test from 'node:test';

import {
  certifiedFosAdapterTypes, requireCertifiedFosAdapter, verifyFosAdapterSet
} from '../src/fos-adapters.mjs';
import * as fosApi from '../src/fos-api.mjs';
import { fosMilestoneReadiness } from '../src/fos-features.mjs';
import {
  fakeCertifiedFosAdapterSet, fakeFosAdapterInputs,
  FOS_TEST_POLICY_SHA256, FOS_TEST_TRUST_ROOT_SHA256
} from './helpers/fos-certified-adapters.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function verificationOptions(verifyAttestation) {
  return {
    policySha256: FOS_TEST_POLICY_SHA256,
    trustRootSha256: FOS_TEST_TRUST_ROOT_SHA256,
    now: new Date('2030-01-01T00:00:00.000Z'),
    verifyAttestation
  };
}

test('the packaged FOS integration API exposes certification consumers without an enable switch', () => {
  for (const name of [
    'verifyFosAdapterSet', 'acceptFosApprovalRequest', 'deliverFosApprovalOutbox',
    'evaluateFosPrCheckAdoption', 'fosMilestoneReadiness'
  ]) assert.equal(typeof fosApi[name], 'function', name);
  assert.equal('enableFosM5' in fosApi, false);
});

test('M5 readiness accepts only process-branded exact-implementation adapter sets', async () => {
  const set = await fakeCertifiedFosAdapterSet();
  assert.deepEqual(certifiedFosAdapterTypes(set), [
    'identity', 'notification', 'server-gate', 'workflow-import'
  ]);
  const readiness = fosMilestoneReadiness({ adapterSet: set });
  assert.equal(readiness.M5.status,
    'verified-adapter-prerequisites-present-live-release-review-required');
  assert.equal(readiness.M5.enabled, false);
  assert.ok(Object.values(readiness.M5.prerequisites).every(Boolean));

  const copied = structuredClone(set);
  assert.deepEqual(certifiedFosAdapterTypes(copied), []);
  assert.equal(fosMilestoneReadiness({
    adapterSet: copied,
    identityAdapter: true,
    notificationAdapter: true,
    serverGate: true,
    workflowImportAdapter: true
  }).M5.status, 'external-adapters-required');
});

test('adapter certification refuses incomplete scenarios and runtime implementation substitution', async () => {
  await assert.rejects(() => fakeCertifiedFosAdapterSet({}, {
    types: ['identity'], certificationOverrides: { identity: { scenarios: ['authenticate-principal'] } }
  }), (error) => error.code === 'FOS_ADAPTER_CERTIFICATION_INVALID');
  await assert.rejects(() => fakeCertifiedFosAdapterSet({}, {
    types: ['notification'],
    certificationOverrides: { notification: { implementationSha256: sha('f') } }
  }), (error) => error.code === 'FOS_ADAPTER_IMPLEMENTATION_MISMATCH');
  await assert.rejects(() => fakeCertifiedFosAdapterSet({}, {
    types: ['notification'],
    certificationOverrides: { notification: { contractSha256: sha('f') } }
  }), (error) => error.code === 'FOS_ADAPTER_IMPLEMENTATION_MISMATCH');
});

test('adapter certification fails closed when the trust verifier rejects or changes the binding', async () => {
  const inputs = fakeFosAdapterInputs({}, { types: ['server-gate'] });
  await assert.rejects(() => verifyFosAdapterSet(inputs, verificationOptions(async () => ({
    verified: false
  }))), (error) => error.code === 'FOS_ADAPTER_ATTESTATION_INVALID');
  await assert.rejects(() => verifyFosAdapterSet(inputs, verificationOptions(async ({
    payloadSha256, trustRootSha256, reviewerPrincipalId
  }) => ({
    verified: true,
    payloadSha256: payloadSha256.replace(/.$/, '0'),
    trustRootSha256,
    signerPrincipalId: reviewerPrincipalId
  }))), (error) => error.code === 'FOS_ADAPTER_ATTESTATION_INVALID');
});

test('verified adapter sets capture the exact callable before caller-side method replacement', async () => {
  const inputs = fakeFosAdapterInputs({
    notification: { async deliver() { return { marker: 'certified-callable' }; } }
  }, { types: ['notification'] });
  const set = await verifyFosAdapterSet(inputs, verificationOptions(async ({
    payloadSha256, trustRootSha256, reviewerPrincipalId
  }) => ({
    verified: true,
    payloadSha256,
    trustRootSha256,
    signerPrincipalId: reviewerPrincipalId
  })));
  inputs.adapters[0].deliver = async () => ({ marker: 'substituted' });
  assert.deepEqual(await requireCertifiedFosAdapter(set, 'notification').deliver(), {
    marker: 'certified-callable'
  });
});
