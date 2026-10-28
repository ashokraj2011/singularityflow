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

// A lapsed exception could only be cleared by returning the Story to its code step, regenerating and
// retesting unchanged code (2026-10-28). The step's approvers renew it instead.
test('a lapsed witness exception renewed by its step\'s approvers stands again, and only that exact one', async () => {
  const { recordWitnessExceptionRenewal } = await import('../src/witness-exception-renewals.mjs');
  const { lapsedWitnessExceptionFindings } = await import('../src/governance.mjs');
  const mapping = `sha256:${'a'.repeat(64)}`;
  const workflow = structuredClone({ ...finished, status: 'in_progress', workItem: { id: 'W-1' }, phases: { ...finished.phases,
    code: { ...finished.phases.code, generation: 2, approvals: [{ decision: 'approved', generation: 2, witnessMappings: [
      { mappingSha256: mapping, clauseId: 'W-1:AC-001', decision: 'exception', expiresAt: '2000-01-02T00:00:00.000Z' }] }] } } });
  const [lapsed] = lapsedWitnessExceptionFindings(workflow);
  assert.equal(lapsed.mappingSha256, mapping);
  assert.equal(lapsed.nextAction.command, `singularity-flow decision witness-exception W-1 --phase code --mapping ${mapping} --expires <YYYY-MM-DD> --reason "<why the exception still stands>"`);
  const now = new Date().toISOString();
  const common = { phaseId: 'code', mappingSha256: mapping, reason: 'The device lab is still down; the manual check stands.', actor: 'lead@example.test', authorityGroup: 'reviewers', at: now };
  assert.throws(() => recordWitnessExceptionRenewal(structuredClone(workflow), { ...common, expires: '2000-01-01' }), { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  assert.throws(() => recordWitnessExceptionRenewal(structuredClone(workflow), { ...common, mappingSha256: `sha256:${'b'.repeat(64)}`, expires: '2999-01-01' }), { code: 'WITNESS_EXCEPTION_UNKNOWN' });
  const record = recordWitnessExceptionRenewal(workflow, { ...common, expires: '2999-01-01' });
  assert.deepEqual([record.id, record.generation, record.previousExpiresAt, record.expiresAt], ['WXR-001', 2, '2000-01-02T00:00:00.000Z', '2999-01-01T23:59:59.999Z']);
  assert.deepEqual(lapsedWitnessExceptionFindings(workflow), [], 'the renewal stands in for the lapsed expiry');
  // A later generation of the step decides its own exceptions; the renewal does not carry to it.
  workflow.phases.code.generation = 3;
  workflow.phases.code.approvals[0].generation = 3;
  assert.equal(lapsedWitnessExceptionFindings(workflow).length, 1);
});
