import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_MAP_FORM, mapCommand, mapFormHasInput, mapCapabilityHtml
} from '../apps/vscode/src/views/map-capability-form.ts';
import { EMPTY_TEST_RECOVERY_DRAFT, testRecoveryHtml } from '../apps/vscode/src/views/test-recovery-intake.ts';

test('capability mapping exposes and submits separate source and test-input paths', () => {
  const form = { ...EMPTY_MAP_FORM, capabilityId: 'orders', lead: 'https://git.example.invalid/org/app.git',
    sourceHashExcludedRoots: 'generated, src/test/fixtures',
    testConfigurationPaths: 'src/test/resources/application-test.yml' };
  const command = mapCommand(form);
  assert.deepEqual(command.slice(command.indexOf('--source-hash-excluded-roots'), command.indexOf('--source-hash-excluded-roots') + 2),
    ['--source-hash-excluded-roots', form.sourceHashExcludedRoots]);
  assert.deepEqual(command.slice(command.indexOf('--test-configuration-paths'), command.indexOf('--test-configuration-paths') + 2),
    ['--test-configuration-paths', form.testConfigurationPaths]);
  assert.equal(mapFormHasInput({ ...EMPTY_MAP_FORM, testConfigurationPaths: 'src/test/resources/application-test.yml' }), true);
  const html = mapCapabilityHtml(form, { step: 'capability' });
  assert.match(html, /data-map="sourceHashExcludedRoots"/);
  assert.match(html, /data-map="testConfigurationPaths"/);
});

test('Story intake explains where test selection must be enabled when it is unavailable', () => {
  const html = testRecoveryHtml(EMPTY_TEST_RECOVERY_DRAFT);
  assert.match(html, /data-test-policy-availability/);
  assert.match(html, /testRecovery\.enabled/);
  assert.doesNotMatch(html, /data-test-recovery-confirm/);
});
