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
        requiredArtifact: { path: 'artifacts/intake/intake.md' }, suggestedPersonas: ['product-owner'],
        approvalPolicy: { personas: ['product-owner'], minimum: 1 }
      },
      requirements: {
        id: 'requirements', label: 'Requirements', status: currentPhase ? 'not_started' : 'approved', generation: currentPhase ? 0 : 1,
        requiredArtifact: { path: 'artifacts/requirements/requirements.md' }, suggestedPersonas: ['product-owner'],
        approvalPolicy: { personas: ['product-owner'], minimum: 1 }
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
  assert.deepEqual(idle.actions.map((item) => item.skill), ['/sflow-start', '/sflow-resume']);

  const requested = nextStepsSnapshot({ branch: 'main', requestedWorkId: 'ENG-42' });
  assert.equal(requested.actions[0].command, 'singularity-flow resume ENG-42 --fetch');
});

test('active generation plan includes current, subsequent, alternative, and following-phase actions', () => {
  const steps = workflowNextSteps(workflow());
  assert.deepEqual(steps.map((item) => item.skill), ['/sflow-phase', '/sflow-submit', '/sflow-approve', '/sflow-reject', '/sflow-phase']);
  assert.deepEqual(steps.map((item) => item.timing), ['now', 'then', 'then', 'alternative', 'then']);
  assert.match(steps.at(-1).reason, /Requirements/);
});

test('generated and approval-pending phases return only valid next transitions', () => {
  const generated = workflowNextSteps(workflow({ generation: 1 }));
  assert.equal(generated[0].skill, '/sflow-submit');
  assert.equal(generated.filter((item) => item.skill === '/sflow-submit').length, 1);

  const awaiting = workflowNextSteps(workflow({ generation: 1, phaseStatus: 'awaiting_approval' }));
  assert.deepEqual(awaiting.slice(0, 2).map((item) => item.skill), ['/sflow-approve', '/sflow-reject']);
  assert.equal(awaiting[1].timing, 'alternative');
  assert.equal(awaiting[2].skill, '/sflow-phase');
});

test('rejection, pending publication, and completion produce safe action plans', () => {
  const rejectedWorkflow = workflow({ generation: 2, history: [{ phase: 'requirements', event: 'phase_rejected', at: '2026-01-02T00:00:00.000Z' }] });
  rejectedWorkflow.phases.intake.rejectedAt = '2026-01-02T00:00:00.000Z';
  const rejected = workflowNextSteps(rejectedWorkflow);
  assert.equal(rejected[0].skill, '/sflow-phase');
  assert.match(rejected[0].reason, /Regenerate/);

  rejectedWorkflow.history.push({ phase: 'intake', event: 'phase_generated', at: '2026-01-03T00:00:00.000Z' });
  assert.equal(workflowNextSteps(rejectedWorkflow)[0].skill, '/sflow-submit');

  const pending = workflowNextSteps(workflow(), { publicationPending: true });
  assert.equal(pending[0].command, 'singularity-flow sync');
  assert.equal(pending[1].skill, '/sflow-nextsteps');

  const complete = workflow({ status: 'complete', currentPhase: null, phaseStatus: 'approved', generation: 1 });
  const completed = workflowNextSteps(complete);
  assert.deepEqual(completed.map((item) => item.skill), ['/sflow-progress', '/sflow-report', null]);
  assert.match(completed.at(-1).command, /gate --terminal/);
});

test('nextsteps text preserves timing, skill, reason, and CLI command', () => {
  const snapshot = nextStepsSnapshot({ workflow: workflow() });
  const text = nextStepsText(snapshot);
  assert.match(text, /NEXT-1 — next actions/);
  assert.match(text, /NOW — \/sflow-phase/);
  assert.match(text, /THEN — \/sflow-submit/);
  assert.match(text, /ALTERNATIVE — \/sflow-reject/);
  assert.match(text, /CLI: singularity-flow prepare intake/);
});
