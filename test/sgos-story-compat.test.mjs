import assert from 'node:assert/strict';
import test from 'node:test';

import { projectStoryForSgos } from '../src/sgos/story-compat.mjs';

test('Story compatibility is deterministic, projection-only, and never invents GVM success', () => {
  const story = {
    workItem: { id: 'WRK-SGOS', branch: 'WRK-SGOS', workType: 'feature' },
    status: 'active',
    currentPhase: 'implementation',
    phaseOrder: ['intake', 'implementation'],
    phases: {
      implementation: { status: 'in_progress', generation: 2, approvals: [] },
      intake: { status: 'approved', generation: 1, approvals: [{ decision: 'approved' }] }
    }
  };
  const before = structuredClone(story);
  const first = projectStoryForSgos(story);
  const second = projectStoryForSgos(structuredClone(story));

  assert.deepEqual(first, second);
  assert.deepEqual(story, before);
  assert.equal(first.guarantees.projectionOnly, true);
  assert.equal(first.phases[0].compatibilityState, 'authoritative-completion-observed');
  assert.equal(first.phases[1].compatibilityState, 'active');
  assert.equal(JSON.stringify(first).includes('"succeeded"'), false);
  assert.match(first.projectionSha256, /^sha256:[a-f0-9]{64}$/);
});
