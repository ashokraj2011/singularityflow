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
