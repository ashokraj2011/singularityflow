import test from 'node:test';
import assert from 'node:assert/strict';

import { preflightTestReadiness } from '../src/repository-readiness-evidence.mjs';

test('Story preflight test projection reports only exact-base tool and count evidence', () => {
  const baseCommit = 'a'.repeat(40);
  const projected = preflightTestReadiness([
    { id: 'app', baseCommit }, { id: 'reference', baseCommit: 'b'.repeat(40) }
  ], { repositories: {
    app: {
      status: 'pass', sourceCommit: baseCommit, scope: 'dependency-test',
      structuredTestContract: { status: 'available', commands: [{
        id: 'unit-tests', launcher: 'C:\\private\\tools\\mvn', adapter: 'junit-xml',
        argvSha256: 'secret', reportPath: '.sflow/results/report.xml'
      }] },
      testObservations: [{ commandId: 'unit-tests', status: 'available',
        counts: { discovered: 12, passed: 11, failed: 0, skipped: 1 },
        report: { path: '/private/report.xml' } }]
    }
  } });
  assert.equal(projected.repositories[0].disposition, 'no-observed-pre-story-failures');
  assert.deepEqual(projected.repositories[0].tools[0], {
    id: 'unit-tests', launcher: 'mvn', adapter: 'junit-xml', status: 'available',
    counts: { discovered: 12, passed: 11, failed: 0, skipped: 1 }
  });
  assert.equal(projected.repositories[1].status, 'missing');
  assert.equal(projected.repositories[1].disposition, 'not-verified');
  assert.doesNotMatch(JSON.stringify(projected), /secret|private|report\.xml/);
});

test('Story preflight never calls a failed or unobserved tool green', () => {
  const repositories = [{ id: 'app', baseCommit: 'a'.repeat(40) }];
  const receipt = {
    status: 'pass', sourceCommit: repositories[0].baseCommit,
    structuredTestContract: { status: 'available', commands: [
      { id: 'unit-tests', launcher: 'npm', adapter: 'jest-json' }
    ] }, testObservations: [{ commandId: 'unit-tests', status: 'available',
      counts: { discovered: 3, passed: 2, failed: 1, skipped: 0 } }]
  };
  assert.equal(preflightTestReadiness(repositories, { repositories: { app: receipt } })
    .repositories[0].disposition, 'not-verified');
  receipt.testObservations = [];
  assert.equal(preflightTestReadiness(repositories, { repositories: { app: receipt } })
    .repositories[0].disposition, 'not-verified');
  receipt.testObservations = [{ commandId: 'unit-tests', status: 'available',
    counts: { discovered: 3, passed: 3, failed: 0, skipped: 0 } }];
  receipt.sourceCommit = 'c'.repeat(40);
  const stale = preflightTestReadiness(repositories, { repositories: { app: receipt } }).repositories[0];
  assert.equal(stale.disposition, 'not-verified');
  assert.equal(stale.tools.length, 0, 'a stale base must not display tools as current');
});
