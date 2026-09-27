import assert from 'node:assert/strict';
import test from 'node:test';
import { registeredModelProviderIds } from '../src/model-runner.mjs';
import {
  SKP_HOST_DIMENSIONS, assertSkillHostLaunchAdmission, assertSkillHostDelivery
} from '../src/skp-host-admission.mjs';
import { diagnoseSkillHostReadiness } from '../src/skp-host-readiness.mjs';

test('runner inventory exposes only a fresh list of registered provider IDs', () => {
  const original = registeredModelProviderIds();
  assert.deepEqual(original, ['copilot-cli']);
  const modified = registeredModelProviderIds();
  assert.notEqual(modified, original);
  modified.push('unregistered-test-provider');
  modified[0] = 'not-a-host';
  assert.deepEqual(registeredModelProviderIds(), original);
  assert.ok(original.every((id) => typeof id === 'string'));
});

test('source readiness reports the real registry seam, never installed-host qualification', () => {
  const report = diagnoseSkillHostReadiness();
  assert.equal(report.resultType, 'sflow-skill-host-readiness');
  assert.equal(report.observationScope, 'source-capabilities-only');
  assert.deepEqual(report.registeredModelProviders, registeredModelProviderIds());
  assert.equal(report.integrationSeam.modelProviderId, 'copilot-cli');
  assert.equal(report.integrationSeam.transport, 'acp');
  assert.equal(report.integrationSeam.status, 'registered-model-provider-only');
  assert.equal(report.integrationSeam.qualifiedSkillAdapter, false);
  assert.equal(report.installedHost, 'not-checked');
  assert.equal(report.nativeQualification, 'not-performed');
  assert.equal(report.status, 'unavailable');
  assert.equal(report.code, 'SKP_HOST_ENFORCEMENT_UNAVAILABLE');
  assert.deepEqual(report.unavailableDimensions, SKP_HOST_DIMENSIONS);
  assert.equal(report.executable, false);
  assert.equal(report.launchAuthorized, false);
  assert.equal(report.mutationRequired, false);
});

test('readiness identifies concrete missing live owners and the limits of existing source', () => {
  const report = diagnoseSkillHostReadiness();
  assert.deepEqual(report.missingOwners.map((owner) => owner.id), [
    'pre-effect-enforcement', 'authenticated-mediated-confirmation', 'exact-host-delivery'
  ]);
  assert.ok(report.missingOwners.every((owner) => owner.status === 'unavailable'));
  assert.deepEqual(report.missingOwners[0].dimensions, SKP_HOST_DIMENSIONS);
  assert.match(report.missingOwners[0].requirement, /native process access/);
  assert.match(report.missingOwners[0].requirement, /actual installed host/);
  assert.equal(report.missingOwners[1].authenticatedNativeHost, false);
  assert.equal(report.missingOwners[1].localOwnerAssurance, 'configured-local-review');
  assert.match(report.missingOwners[2].requirement, /package, projected entry and resource manifest/);
  const permissionOwner = report.sourceOwners.find((owner) => owner.id === 'acp-file-mutation-permissions');
  assert.match(permissionOwner.limitation, /Read\/search notifications can be post-effect/);
  const authoringOwner = report.sourceOwners.find((owner) => owner.id === 'terminal-local-authoring-review');
  assert.match(authoringOwner.limitation, /not authenticated native-host mediated consent/);
  assert.ok(report.sourceOwners.every((owner) => owner.status === 'implemented-source-only'));
  assert.equal(report.nextAction.kind, 'external-prerequisite');
  assert.equal(report.nextAction.executionAuthorized, false);
  assert.match(report.nextAction.description, /No existing command can enable SKP execution/);
  assert.equal(report.nextAction.command, undefined);
});

test('caller evidence, configuration and identities cannot upgrade readiness', () => {
  const untrusted = new Proxy({}, { get() { assert.fail('Readiness must not read supplied evidence.'); } });
  const original = diagnoseSkillHostReadiness();
  assert.deepEqual(diagnoseSkillHostReadiness(untrusted), original);
  assert.deepEqual(diagnoseSkillHostReadiness({
    status: 'ready', installedHost: 'qualified', authenticatedNativeHost: true,
    observed: { dimensions: Object.fromEntries(SKP_HOST_DIMENSIONS.map((dimension) => [
      dimension, { status: 'enforced-before-effect', mechanism: 'os-sandbox' }
    ])) },
    adapter: { id: 'trusted-host', version: '1' }, credentials: 'not-a-credential'
  }), original);
  assert.doesNotMatch(JSON.stringify(original), /not-a-credential|trusted-host|valueHash|receiptId/);
});

test('a readiness report is immutable and cannot be used as an admission or delivery grant', () => {
  const report = diagnoseSkillHostReadiness();
  function frozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    Object.values(value).forEach(frozen);
  }
  frozen(report);
  assert.throws(() => { report.status = 'ready'; }, TypeError);
  assert.throws(() => report.unavailableDimensions.pop(), TypeError);
  assert.throws(() => { report.missingOwners[1].authenticatedNativeHost = true; }, TypeError);
  assert.throws(() => assertSkillHostLaunchAdmission(report), {
    code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE'
  });
  assert.throws(() => assertSkillHostDelivery(report, {}, {}), {
    code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE'
  });
  assert.deepEqual(diagnoseSkillHostReadiness(), report);
});
