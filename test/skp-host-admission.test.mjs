import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SKP_HOST_DIMENSIONS,
  assessSkillHostLaunchAdmission,
  assertSkillHostLaunchAdmission,
  assertSkillHostDelivery
} from '../src/skp-host-admission.mjs';

const hash = (digit) => `sha256:${digit.repeat(64)}`;

function fixture() {
  const binding = {
    operationId: 'phase-attempt-17', profileId: 'skp-restricted-v1',
    adapterId: 'qualified-local-host', adapterVersion: '1.0.0'
  };
  const required = {
    binding,
    dimensions: Object.fromEntries(SKP_HOST_DIMENSIONS.map((dimension) => [
      dimension, { policySha256: hash('a') }
    ]))
  };
  const observed = {
    binding: { ...binding },
    dimensions: Object.fromEntries(SKP_HOST_DIMENSIONS.map((dimension) => [
      dimension, {
        status: 'enforced-before-effect',
        policySha256: hash('a'),
        mechanism: dimension === 'cancellation' ? 'process-supervisor' : 'os-sandbox',
        evidenceId: `qualified-adapter:${dimension}`
      }
    ]))
  };
  const expected = {
    packageSha256: hash('b'),
    projectedEntrySha256: hash('c'),
    resourceManifestSha256: hash('d')
  };
  const acknowledgement = {
    ...binding, ...expected,
    status: 'acknowledged', channel: 'trusted-host-adapter', receiptId: 'receipt-17'
  };
  return { required, observed, expected, acknowledgement };
}

test('SKP refuses launch with no proven host controls', () => {
  const { required } = fixture();
  const preview = assessSkillHostLaunchAdmission({ required });
  assert.equal(preview.status, 'unavailable');
  assert.deepEqual(preview.unavailableDimensions, SKP_HOST_DIMENSIONS);
  assert.throws(
    () => assertSkillHostLaunchAdmission({ required }),
    { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' }
  );
});

test('SKP admits only exact, operation-bound pre-effect enforcement for every dimension', () => {
  const { required, observed } = fixture();
  const admission = assertSkillHostLaunchAdmission({ required, observed });
  assert.equal(admission.status, 'ready');
  assert.equal(admission.bindingMatches, true);
  assert.deepEqual(admission.unavailableDimensions, []);
  for (const dimension of SKP_HOST_DIMENSIONS) {
    assert.equal(admission.dimensions[dimension].required, hash('a'));
    assert.equal(admission.dimensions[dimension].verified.evidenceId,
      `qualified-adapter:${dimension}`);
  }
});

test('SKP refuses missing policy dimension, changed policy, and different operation binding', () => {
  const { required, observed } = fixture();
  delete required.dimensions.network;
  assert.throws(() => assertSkillHostLaunchAdmission({ required, observed }),
    { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' });

  const changedPolicy = fixture();
  changedPolicy.observed.dimensions.network.policySha256 = hash('f');
  assert.deepEqual(
    assessSkillHostLaunchAdmission(changedPolicy).unavailableDimensions, ['network']
  );

  const changedOperation = fixture();
  changedOperation.observed.binding.operationId = 'different-attempt';
  assert.throws(() => assertSkillHostLaunchAdmission(changedOperation),
    { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' });

  const forgedDigest = fixture();
  const lookalike = { toString: () => hash('a') };
  forgedDigest.required.dimensions.network.policySha256 = lookalike;
  forgedDigest.observed.dimensions.network.policySha256 = lookalike;
  assert.throws(() => assertSkillHostLaunchAdmission(forgedDigest),
    { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' });
});

test('SKP does not count prompt, permission, or final-diff claims as host enforcement', () => {
  for (const mechanism of ['prompt-instruction', 'model-permission', 'final-diff-check']) {
    const value = fixture();
    value.observed.dimensions.network.mechanism = mechanism;
    assert.deepEqual(
      assessSkillHostLaunchAdmission(value).unavailableDimensions, ['network']
    );
  }
  const value = fixture();
  value.observed.dimensions.reads.status = 'checked-after-run';
  assert.deepEqual(assessSkillHostLaunchAdmission(value).unavailableDimensions, ['reads']);
});

test('SKP refuses unacknowledged or inexact package delivery', () => {
  const { required, observed, expected, acknowledgement } = fixture();
  const admission = assertSkillHostLaunchAdmission({ required, observed });
  assert.throws(() => assertSkillHostDelivery(admission, expected, null),
    { code: 'SKP_HOST_DELIVERY_UNCONFIRMED' });
  assert.throws(() => assertSkillHostDelivery(admission, expected, {
    ...acknowledgement, resourceManifestSha256: hash('e')
  }), { code: 'SKP_HOST_DELIVERY_UNCONFIRMED' });
  assert.throws(() => assertSkillHostDelivery(admission, expected, {
    ...acknowledgement, channel: 'model-output'
  }), { code: 'SKP_HOST_DELIVERY_UNCONFIRMED' });
  assert.throws(() => assertSkillHostDelivery(admission, expected, {
    ...acknowledgement, operationId: 'different-attempt'
  }), { code: 'SKP_HOST_DELIVERY_UNCONFIRMED' });
});

test('SKP delivery accepts an exact trusted-host receipt only after launch admission', () => {
  const value = fixture();
  const forgedAdmission = assessSkillHostLaunchAdmission(value);
  assert.throws(() => assertSkillHostDelivery(
    forgedAdmission, value.expected, value.acknowledgement
  ), { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' });

  const admission = assertSkillHostLaunchAdmission(value);
  const delivery = assertSkillHostDelivery(admission, value.expected, value.acknowledgement);
  assert.equal(delivery.status, 'confirmed');
  assert.equal(delivery.receiptId, 'receipt-17');
  assert.equal(delivery.packageSha256, value.expected.packageSha256);
});
