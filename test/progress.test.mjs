import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseTokenStatus, progressBar, progressFlow, progressSnapshot } from '../src/progress.mjs';

test('progress distinguishes absent, unavailable, partial, and exact token telemetry', () => {
  assert.equal(phaseTokenStatus([]), 'none');
  assert.equal(phaseTokenStatus([{ status: 'unavailable', totalTokens: null }]), 'unavailable');
  assert.equal(phaseTokenStatus([
    { status: 'exact', totalTokens: 100 },
    { status: 'unavailable', totalTokens: null }
  ]), 'partial');
  assert.equal(phaseTokenStatus([
    { status: 'exact', totalTokens: 100 },
    { status: 'exact', totalTokens: 25 }
  ]), 'exact');

  const basePhase = {
    label: 'Intake', status: 'in_progress', generation: 1, approvals: [],
    approvalPolicy: { minimum: 1 }
  };
  const snapshot = progressSnapshot({
    phaseOrder: ['none', 'unavailable', 'partial', 'exact'],
    phases: {
      none: { ...basePhase, usage: [] },
      unavailable: { ...basePhase, usage: [{ status: 'unavailable', totalTokens: null }] },
      partial: { ...basePhase, usage: [{ status: 'exact', totalTokens: 100 }, { status: 'unavailable', totalTokens: null }] },
      exact: { ...basePhase, usage: [{ status: 'exact', totalTokens: 125 }] }
    },
    workItem: { id: 'TOKENS-1', workType: 'feature' },
    status: 'in_progress', currentPhase: 'none', usage: {}, documents: { count: 0 }
  });
  assert.deepEqual(snapshot.phases.map((phase) => phase.tokenStatus), ['none', 'unavailable', 'partial', 'exact']);
  assert.equal(snapshot.phases[2].tokens, 100);
});

test('progress flow renders approved, current approval, and pending phases as a connected map', () => {
  const output = progressFlow({
    currentPhase: 'design',
    approvedPhases: 2,
    totalPhases: 4,
    phases: [
      { id: 'intake', label: 'Intake', status: 'approved', generation: 1, approvals: 1, approvalsRequired: 1 },
      { id: 'requirements', label: 'Requirements', status: 'approved', generation: 1, approvals: 1, approvalsRequired: 1 },
      { id: 'design', label: 'Design', status: 'awaiting_approval', generation: 1, approvals: 0, approvalsRequired: 1 },
      { id: 'implementation', label: 'Implementation', status: 'not_started', generation: 0, approvals: 0, approvalsRequired: 1 }
    ]
  });

  assert.match(output, /✓ Intake\s+APPROVED \(1\/1\)/);
  assert.match(output, /✓ Requirements\s+APPROVED \(1\/1\)/);
  assert.match(output, /◆ Design\s+AWAITING APPROVAL \(0\/1\)  ← CURRENT/);
  assert.match(output, /○ Implementation\s+PENDING/);
  assert.equal(output.match(/▼/g)?.length, 3);
});

test('progress flow marks active generation and completed workflow', () => {
  const active = progressFlow({
    currentPhase: 'intake', approvedPhases: 0, totalPhases: 1,
    phases: [{ id: 'intake', label: 'Intake', status: 'in_progress', generation: 0, approvals: 0, approvalsRequired: 1 }]
  });
  assert.equal(active, '  ▶ Intake  IN PROGRESS · generation 0  ← CURRENT');

  const complete = progressFlow({
    currentPhase: null, approvedPhases: 1, totalPhases: 1,
    phases: [{ id: 'intake', label: 'Intake', status: 'approved', generation: 1, approvals: 1, approvalsRequired: 1 }]
  });
  assert.match(complete, /✓ WORKFLOW COMPLETE$/);
});

test('progress bar still clamps values for deterministic percentage display', () => {
  assert.equal(progressBar(-1, 4), '[░░░░]');
  assert.equal(progressBar(50, 4), '[██░░]');
  assert.equal(progressBar(101, 4), '[████]');
});
