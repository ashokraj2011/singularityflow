import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStepsSnapshot, nextStepsText, workflowNextSteps } from '../src/nextsteps.mjs';

function workflow({ status = 'in_progress', phaseStatus = 'in_progress', generation = 0, currentPhase = 'intake', history = [] } = {}) {
  return {
    workItem: { id: 'NEXT-1', branch: 'NEXT-1', workType: 'feature', workTypeLabel: 'Feature', source: { type: 'manual' } },
    status,
    currentPhase,
    phaseOrder: ['intake', 'requirements'],
    phases: {
      intake: {
        id: 'intake', label: 'Intake', status: phaseStatus, generation,
        requiredArtifact: { path: 'artifacts/intake/intake.md' }, defaultAgent: 'product-owner',
        approvalPolicy: { agents: ['product-owner'], minimum: 1 }
      },
      requirements: {
        id: 'requirements', label: 'Requirements', status: currentPhase ? 'not_started' : 'approved', generation: currentPhase ? 0 : 1,
        requiredArtifact: { path: 'artifacts/requirements/requirements.md' }, defaultAgent: 'product-owner',
        approvalPolicy: { agents: ['product-owner'], minimum: 1 }
      }
    },
    history
  };
}

test('nextsteps works before initialization and without an active work item', () => {
  const uninitialized = nextStepsSnapshot({ initialized: false, branch: 'main' });
  assert.equal(uninitialized.state, 'not_initialized');
  assert.deepEqual(uninitialized.actions.map((item) => item.command), ['singularity-flow init', 'singularity-flow start <WORK-ID>']);

  const idle = nextStepsSnapshot({ branch: 'main' });
  assert.equal(idle.state, 'no_active_work_item');
  assert.deepEqual(idle.actions.map((item) => item.skill), ['/sf-start', '/sf-resume']);

  const requested = nextStepsSnapshot({ branch: 'main', requestedWorkId: 'ENG-42' });
  assert.equal(requested.actions[0].command, 'singularity-flow resume ENG-42 --fetch');
});

test('active generation plan includes current, subsequent, alternative, and following-phase actions', () => {
  const steps = workflowNextSteps(workflow());
  assert.deepEqual(steps.map((item) => item.skill), ['/sf-phase', '/sf-submit', '/sf-approve', '/sf-reject', '/sf-cancel', '/sf-phase']);
  assert.deepEqual(steps.map((item) => item.timing), ['now', 'then', 'then', 'alternative', 'alternative', 'then']);
  assert.match(steps.at(-1).reason, /Requirements/);
});

test('generated and approval-pending phases return only valid next transitions', () => {
  const generated = workflowNextSteps(workflow({ generation: 1 }));
  assert.equal(generated[0].skill, '/sf-submit');
  assert.equal(generated.filter((item) => item.skill === '/sf-submit').length, 1);

  const awaiting = workflowNextSteps(workflow({ generation: 1, phaseStatus: 'awaiting_approval' }));
  assert.deepEqual(awaiting.slice(0, 2).map((item) => item.skill), ['/sf-approve', '/sf-reject']);
  assert.equal(awaiting[1].timing, 'alternative');
  assert.equal(awaiting[2].skill, '/sf-phase');
});

test('rejection, pending publication, and completion produce safe action plans', () => {
  const rejectedWorkflow = workflow({ generation: 2, history: [{ phase: 'requirements', event: 'phase_rejected', at: '2026-01-02T00:00:00.000Z' }] });
  rejectedWorkflow.phases.intake.rejectedAt = '2026-01-02T00:00:00.000Z';
  const rejected = workflowNextSteps(rejectedWorkflow);
  assert.equal(rejected[0].skill, '/sf-phase');
  assert.match(rejected[0].reason, /Regenerate/);

  rejectedWorkflow.history.push({ phase: 'intake', event: 'phase_generated', at: '2026-01-03T00:00:00.000Z' });
  assert.equal(workflowNextSteps(rejectedWorkflow)[0].skill, '/sf-submit');

  const pending = workflowNextSteps(workflow(), { publicationPending: true });
  assert.equal(pending[0].command, 'singularity-flow sync');
  assert.equal(pending[1].skill, '/sf-nextsteps');

  const complete = workflow({ status: 'complete', currentPhase: null, phaseStatus: 'approved', generation: 1 });
  const completed = workflowNextSteps(complete);
  assert.deepEqual(completed.map((item) => item.skill), ['/sf-progress', '/sf-report', '/sf-next']);
  assert.match(completed.at(-1).command, /gate --terminal/);

  const cancelled = workflow({ status: 'cancelled', currentPhase: null, phaseStatus: 'cancelled', generation: 1 });
  cancelled.cancellation = {
    phase: 'intake', reason: 'Priority changed', cancelledAt: '2026-01-04T00:00:00.000Z',
    cancelledBy: { name: 'Reviewer', email: 'reviewer@example.com' }
  };
  assert.deepEqual(workflowNextSteps(cancelled).map((item) => item.skill), ['/sf-documents', '/sf-report']);
});

test('nextsteps text preserves timing, skill, reason, and CLI command', () => {
  const snapshot = nextStepsSnapshot({ workflow: workflow() });
  const text = nextStepsText(snapshot);
  assert.match(text, /NEXT-1 — next actions/);
  assert.match(text, /NOW — Copilot: \/sf-phase/);
  assert.match(text, /THEN — Copilot: \/sf-submit/);
  assert.match(text, /ALTERNATIVE — Copilot: \/sf-reject/);
  assert.match(text, /CLI equivalent: singularity-flow prepare intake/);
});

test('agent trust and synchronization prerequisites precede generation', () => {
  const prerequisites = [
    { timing: 'now', skill: null, command: 'singularity-flow agents lock architecture', reason: 'Trust hashes.' },
    { timing: 'then', skill: null, command: 'singularity-flow agents sync architecture', reason: 'Materialize cache.' }
  ];
  const snapshot = nextStepsSnapshot({ workflow: workflow(), prerequisites });
  assert.deepEqual(snapshot.actions.slice(0, 2).map((item) => item.command), prerequisites.map((item) => item.command));
  assert.deepEqual(snapshot.actions.slice(0, 2).map((item) => item.skill), ['/sf-agents', '/sf-agents']);
  assert.equal(snapshot.actions[2].skill, '/sf-phase');
});
