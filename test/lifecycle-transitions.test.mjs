import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceCompletedPhase, nextPhaseAfterSkillAmendment, reopenPhaseRange
} from '../src/lifecycle-transitions.mjs';

const at = '2026-09-27T12:00:00.000Z';

function fixture() {
  const ids = ['requirements', 'planning', 'implementation', 'verification', 'release'];
  return {
    status: 'in_progress', currentPhase: 'implementation', phaseOrder: ids,
    phases: Object.fromEntries(ids.map((id, index) => [id, {
      id, status: index < 2 ? 'approved' : index === 2 ? 'in_progress' : 'not_started',
      generation: index + 1, startedAt: '2026-09-26T12:00:00.000Z',
      submittedAt: '2026-09-26T13:00:00.000Z', approvedAt: '2026-09-26T14:00:00.000Z',
      approvedBy: 'earlier-reviewer',
      approvals: [
        { decision: 'approved', actor: { email: 'first@example.test' } },
        { decision: 'approved', actor: { email: 'old@example.test' }, invalidatedAt: '2026-09-25T00:00:00.000Z' }
      ],
      artifacts: [{ path: `artifacts/${id}/primary.md`, sha256: `${index}`.repeat(64) }],
      claimMaps: { planned: { path: `claims/${id}.json`, sha256: 'a'.repeat(64) } },
      submissionArchitectureDecision: { generation: index + 1, identity: { sha256: 'b'.repeat(64) } }
    }]))
  };
}

test('completed phase advances only the upcoming state while retaining earlier evidence', () => {
  const workflow = fixture();
  const phase = workflow.phases.implementation;
  phase.status = 'approved';
  const before = structuredClone(workflow);
  const upcoming = advanceCompletedPhase(workflow, phase, at);
  assert.equal(upcoming, workflow.phases.verification);
  assert.equal(workflow.currentPhase, 'verification');
  assert.equal(workflow.status, 'in_progress');
  assert.equal(upcoming.status, 'in_progress');
  assert.equal(upcoming.startedAt, at);
  for (const id of ['requirements', 'planning', 'implementation', 'release']) {
    assert.deepEqual(workflow.phases[id], before.phases[id]);
  }
  assert.deepEqual(upcoming.artifacts, before.phases.verification.artifacts);
  assert.deepEqual(upcoming.approvals, before.phases.verification.approvals);
});

test('terminal completion has no synthetic phase or generation mutation', () => {
  const workflow = fixture();
  const phase = workflow.phases.release;
  phase.status = 'approved';
  const phases = structuredClone(workflow.phases);
  assert.equal(advanceCompletedPhase(workflow, phase, at), null);
  assert.equal(workflow.currentPhase, null);
  assert.equal(workflow.status, 'complete');
  assert.deepEqual(workflow.phases, phases);
});

test('accepted selective skill amendment skips only already-approved preserved phases', () => {
  const workflow = fixture();
  workflow.phases.implementation.status = 'approved';
  workflow.phases.verification.status = 'approved';
  workflow.skillVersionAmendments = [{ status: 'approved',
    affectedPhaseIds: ['implementation', 'release'], preservedPhaseIds: ['verification'] }];
  const preserved = structuredClone(workflow.phases.verification);
  assert.equal(nextPhaseAfterSkillAmendment(workflow, workflow.phases.implementation), workflow.phases.release);
  assert.equal(advanceCompletedPhase(workflow, workflow.phases.implementation, at), workflow.phases.release);
  assert.deepEqual(workflow.phases.verification, preserved);

  const notApproved = fixture();
  notApproved.skillVersionAmendments = structuredClone(workflow.skillVersionAmendments);
  assert.equal(nextPhaseAfterSkillAmendment(notApproved, notApproved.phases.implementation),
    notApproved.phases.verification, 'a preservation ID cannot manufacture approval');
});

test('only the latest approved amendment affecting this source may preserve later evidence', () => {
  const workflow = fixture();
  workflow.phases.verification.status = 'approved';
  workflow.skillVersionAmendments = [
    { status: 'approved', affectedPhaseIds: ['implementation'], preservedPhaseIds: ['verification'] },
    { status: 'rejected', affectedPhaseIds: ['implementation'], preservedPhaseIds: [] },
    { status: 'approved', affectedPhaseIds: ['planning'], preservedPhaseIds: [] }
  ];
  assert.equal(nextPhaseAfterSkillAmendment(workflow, workflow.phases.implementation), workflow.phases.release);
  workflow.skillVersionAmendments.push({ status: 'approved', affectedPhaseIds: ['implementation'], preservedPhaseIds: [] });
  assert.equal(nextPhaseAfterSkillAmendment(workflow, workflow.phases.implementation), workflow.phases.verification);
});

test('an amendment can complete a source while retaining all remaining approved independent phases', () => {
  const workflow = fixture();
  for (const id of ['implementation', 'verification', 'release']) workflow.phases[id].status = 'approved';
  workflow.skillVersionAmendments = [{ status: 'approved', affectedPhaseIds: ['implementation'],
    preservedPhaseIds: ['verification', 'release'] }];
  const preserved = structuredClone(workflow.phases);
  assert.equal(advanceCompletedPhase(workflow, workflow.phases.implementation, at), null);
  assert.equal(workflow.status, 'complete');
  assert.deepEqual(workflow.phases, preserved);
});

test('rejection resets the full target-to-end range without discarding generations or audit evidence', () => {
  const workflow = fixture();
  workflow.status = 'complete';
  const before = structuredClone(workflow);
  const affected = reopenPhaseRange(workflow, { targetId: 'planning', at,
    actor: 'reviewer@example.test', reason: 'Correct the reviewed test plan.' });
  assert.deepEqual(affected, ['planning', 'implementation', 'verification', 'release']);
  assert.deepEqual(workflow.phases.requirements, before.phases.requirements);
  assert.equal(workflow.currentPhase, 'planning');
  assert.equal(workflow.status, 'in_progress');
  for (const [index, id] of affected.entries()) {
    const phase = workflow.phases[id];
    assert.equal(phase.status, index === 0 ? 'in_progress' : 'not_started');
    assert.equal(phase.approvals[0].invalidatedAt, at);
    assert.equal(phase.approvals[1].invalidatedAt, before.phases[id].approvals[1].invalidatedAt);
    for (const key of ['submittedAt', 'approvedAt', 'approvedBy', 'submissionArchitectureDecision']) {
      assert.equal(phase[key], null);
    }
    for (const key of ['generation', 'artifacts', 'claimMaps', 'startedAt']) {
      assert.deepEqual(phase[key], before.phases[id][key]);
    }
  }
  assert.equal(workflow.phases.planning.rejectedAt, at);
  assert.equal(workflow.phases.planning.rejectedBy, 'reviewer@example.test');
  assert.equal(workflow.phases.planning.rejectionReason, 'Correct the reviewed test plan.');
  assert.equal(workflow.phases.implementation.rejectedAt, undefined);
});

test('unknown selected phases refuse before mutating the aggregate', () => {
  const workflow = fixture();
  const before = structuredClone(workflow);
  for (const action of [
    () => nextPhaseAfterSkillAmendment(workflow, { id: 'missing' }),
    () => advanceCompletedPhase(workflow, { id: 'missing' }, at),
    () => reopenPhaseRange(workflow, { targetId: 'missing', at, actor: 'reviewer', reason: 'Review.' })
  ]) {
    assert.throws(action, { code: 'LIFECYCLE_TRANSITION_INVALID' });
    assert.deepEqual(workflow, before);
  }
});

test('malformed later phases or decisions cannot leave a partially reopened range', () => {
  for (const corrupt of [
    (workflow) => { delete workflow.phases.release; },
    (workflow) => { workflow.phases.release.id = 'different'; },
    (workflow) => { workflow.phaseOrder.push('release'); },
    (workflow) => { workflow.phases.release.approvals = null; },
    (workflow) => { workflow.phases.release.approvals.push(null); }
  ]) {
    const workflow = fixture();
    corrupt(workflow);
    const before = structuredClone(workflow);
    assert.throws(() => reopenPhaseRange(workflow, { targetId: 'planning', at,
      actor: 'reviewer', reason: 'Correct this range.' }), { code: 'LIFECYCLE_TRANSITION_INVALID' });
    assert.deepEqual(workflow, before);
  }
});
