import test from 'node:test';
import assert from 'node:assert/strict';
import { guideText, workflowGuide } from '../src/guide.mjs';

function workflow(status = 'in_progress', generation = 0) {
  const currentPhase = status === 'complete' ? null : 'intake';
  return {
    workItem: { id: 'GUIDE-1', workType: 'feature', workTypeLabel: 'Feature', source: { type: 'manual', key: null } },
    status,
    currentPhase,
    phaseOrder: ['intake', 'requirements'],
    phases: {
      intake: {
        id: 'intake', label: 'Intake', status: status === 'complete' ? 'approved' : status,
        generation, requiredArtifact: { path: 'artifacts/intake/intake.md' },
        suggestedPersonas: ['product-owner'], approvalPolicy: { personas: ['product-owner'], minimum: 1 }
      },
      requirements: {
        id: 'requirements', label: 'Requirements', status: status === 'complete' ? 'approved' : 'not_started',
        generation: status === 'complete' ? 1 : 0, requiredArtifact: { path: 'artifacts/requirements/requirements.md' },
        suggestedPersonas: ['product-owner'], approvalPolicy: { personas: ['product-owner'], minimum: 1 }
      }
    },
    history: []
  };
}

test('workflow guide recommends the valid next skill for each lifecycle state', () => {
  let guide = workflowGuide(workflow('in_progress', 0));
  assert.equal(guide.nextActions[0].skill, '/sflow-phase');
  assert.match(guideText(guide), /Workflow template:/);

  guide = workflowGuide(workflow('in_progress', 1));
  assert.equal(guide.nextActions[0].skill, '/sflow-submit');

  guide = workflowGuide(workflow('awaiting_approval', 1));
  assert.deepEqual(guide.nextActions.map((item) => item.skill), ['/sflow-approve', '/sflow-reject']);

  guide = workflowGuide(workflow('complete', 1));
  assert.equal(guide.nextActions[0].skill, '/sflow-progress');
});
