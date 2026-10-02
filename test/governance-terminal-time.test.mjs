import assert from 'node:assert/strict';
import test from 'node:test';

import { lapsedWitnessExceptions, terminalTransitionAt } from '../src/governance.mjs';

const finished = {
  status: 'closed',
  phaseOrder: ['spec', 'code', 'release'],
  phases: {
    spec: { approvedAt: '2026-09-01T10:00:00.000Z', approvals: [] },
    code: { approvedAt: '2026-09-03T10:00:00.000Z', approvals: [] },
    release: { status: 'skipped', skippedAt: '2026-09-04T09:30:00.000Z', approvals: [] }
  }
};

test('the terminal gate judges accepted exceptions at the moment the Story finished', () => {
  assert.equal(terminalTransitionAt(finished), '2026-09-04T09:30:00.000Z');
  const inProgress = { ...finished, status: 'in_progress' };
  const before = Date.now();
  const now = Date.parse(terminalTransitionAt(inProgress));
  assert.ok(now >= before && now <= Date.now() + 1000, 'an unfinished Story is judged now');
});

test('a witness exception that lapsed before the Story finished no longer stands', () => {
  const withException = (expiresAt, extra = {}) => structuredClone({
    ...finished,
    phases: {
      ...finished.phases,
      code: {
        ...finished.phases.code,
        approvals: [{ witnessMappings: [{ clauseId: 'W-1:AC-001', decision: 'exception', expiresAt }], ...extra }]
      }
    }
  });
  assert.deepEqual(lapsedWitnessExceptions(withException('2026-09-10T00:00:00.000Z')), []);
  assert.deepEqual(lapsedWitnessExceptions(withException('2026-09-02T00:00:00.000Z')), [
    "terminal: code's witness exception for W-1:AC-001 expired at 2026-09-02T00:00:00.000Z, before the Story finished"
  ]);
  assert.deepEqual(lapsedWitnessExceptions(withException('2026-09-02T00:00:00.000Z', { invalidatedAt: '2026-09-02T12:00:00.000Z' })), [],
    'an invalidated approval no longer carries its exceptions');
  assert.equal(lapsedWitnessExceptions(withException(undefined)).length, 1, 'an exception with no expiry cannot stand');
});
