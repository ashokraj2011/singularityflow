import assert from 'node:assert/strict';
import test from 'node:test';

import { storyTestReadinessDocument } from '../src/story-test-readiness-document.mjs';

test('Story test-readiness document binds exact repositories and an explicit failure disposition', () => {
  const document = storyTestReadinessDocument('STORY-1', [
    { id: 'b', baseCommit: 'b'.repeat(40) },
    { id: 'a', baseCommit: 'a'.repeat(40) }
  ], {
    repositories: {
      a: {
        status: 'pass', sourceCommit: 'a'.repeat(40), scope: 'dependency-test',
        receiptSha256: `sha256:${'a'.repeat(64)}`,
        structuredTestContract: {
          status: 'available', commands: [{ id: 'unit', workingDirectory: '.',
            launcher: 'mvn', adapter: 'junit-xml', reportPath: 'target/surefire-reports' }]
        },
        testObservations: [{ commandId: 'unit', adapter: 'junit-xml', status: 'available',
          counts: { discovered: 3, passed: 3, failed: 0, skipped: 0 } }],
        commandResults: [{ id: 'unit', purpose: 'test', status: 'pass' }]
      }
    }
  }, { required: true });

  assert.equal(document.kind, 'story-test-readiness');
  assert.equal(document.required, true);
  assert.deepEqual(document.repositories.map((entry) => entry.repository), ['a', 'b']);
  assert.equal(document.repositories[0].testTools[0].adapter, 'junit-xml');
  assert.equal(document.repositories[0].existingFailureDisposition, 'no-observed-pre-story-failures');
  assert.equal(document.repositories[1].existingFailureDisposition, 'repair-or-verify-before-code');
  assert.equal(document.repositories[1].status, 'not-checked');
});

test('Story readiness does not present a stale receipt as test evidence for the selected base', () => {
  const baseCommit = 'a'.repeat(40);
  const stale = storyTestReadinessDocument('STORY-2', [{ id: 'app', baseCommit }], {
    repositories: { app: {
      status: 'stale', sourceCommit: 'b'.repeat(40),
      structuredTestContract: { status: 'available', commands: [{ id: 'unit' }] },
      testObservations: [{ commandId: 'unit', status: 'available',
        counts: { discovered: 1, passed: 1, failed: 0, skipped: 0 } }]
    } }
  });
  assert.equal(stale.repositories[0].receiptSourceCommit, 'b'.repeat(40));
  assert.deepEqual(stale.repositories[0].testTools, []);
  assert.equal(stale.repositories[0].existingFailureDisposition, 'repair-or-verify-before-code');
});

test('Story document preserves accepted existing failures and decision instead of calling them green', () => {
  const baseCommit = 'a'.repeat(40);
  const baselineSha256 = `sha256:${'b'.repeat(64)}`;
  const acceptanceSha256 = `sha256:${'c'.repeat(64)}`;
  const evidence = { repositories: { app: {
    status: 'accepted-known-failures', sourceCommit: baseCommit,
    scope: 'dependency-test', baselineSha256,
    sourceManifestSha256: `sha256:${'d'.repeat(64)}`,
    planId: `sha256:${'e'.repeat(64)}`,
    structuredTestContract: { status: 'available', commands: [
      { id: 'unit', launcher: 'npm', workingDirectory: '.', adapter: 'node-tap' }
    ] },
    testObservations: [{ commandId: 'unit', adapter: 'node-tap', status: 'available',
      counts: { discovered: 3, passed: 2, failed: 1, skipped: 0 },
      failingCases: [{ name: 'known failing baseline', identityStatus: 'observed-name-only' }] }],
    commandResults: [{ id: 'install', purpose: 'dependency', status: 'pass' },
      { id: 'unit', purpose: 'test', status: 'failed' }],
    riskAcceptance: { status: 'accepted-known-failures', baselineSha256,
      acceptanceSha256, reason: 'Accepted before Story coding.' }
  } } };
  const record = storyTestReadinessDocument('STORY-FAIL', [
    { id: 'app', baseCommit }
  ], evidence, { required: true }).repositories[0];
  assert.equal(record.status, 'accepted-known-failures');
  assert.equal(record.existingFailureDisposition, 'accepted-pre-existing-test-failures');
  assert.equal(record.baselineSha256, baselineSha256);
  assert.equal(record.riskAcceptance.acceptanceSha256, acceptanceSha256);
  assert.equal(Object.hasOwn(record.riskAcceptance, 'reason'), false);
  assert.equal(record.commandResults.at(-1).status, 'failed');
  assert.equal(record.testResults[0].counts.failed, 1);
  assert.equal(record.testResults[0].failingCases[0].name, 'known failing baseline');
});
