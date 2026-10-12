import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateVisualCoverage } from '../src/visual-coverage.mjs';
import { fastPathProfile, milestoneReached } from '../src/fast-path.mjs';
import { milestonePhases, requiredInitiativeMilestone } from '../src/initiative-milestones.mjs';
import { readSourceReviewStatus } from '../src/source-review-lifecycle.mjs';
import { sourceReviewRequired } from '../src/source-review-policy.mjs';
import { submitRoute } from '../src/submit-route.mjs';

/**
 * Guidance follows what a step does, never what it is called. Each case renames or reorders the
 * seeded steps, so a question asked of the wrong step is answered and a route never names a check
 * the step does not have.
 */
function renamedStory({ statuses = {}, sourceReviewPhases = ['shape', 'map-work', 'discover'] } = {}) {
  const steps = [
    ['discover', [], 'markdown'],
    ['shape', ['scope'], 'markdown'],
    ['map-work', ['plan'], 'markdown'],
    ['build-it', ['implement'], 'code'],
    ['prove-it', ['verify'], 'test-evidence'],
    ['look', [], 'visual-test-evidence'],
    ['reconcile', [], 'convergence-report']
  ];
  return {
    workItem: { id: 'ROLE-1' },
    currentPhase: 'discover',
    phaseOrder: steps.map(([id]) => id),
    phases: Object.fromEntries(steps.map(([id, , kind]) => [id, {
      id, status: statuses[id] ?? 'not_started', generation: 0,
      requiredArtifact: { kind }, ...(kind === 'code' ? { requiresCodeDelivery: true } : {})
    }])),
    resolution: {
      sourceReview: { mode: 'enforce', phases: sourceReviewPhases },
      obligationGraph: { nodes: steps.map(([id, responsibilities]) => ({ id, responsibilities })) },
      verification: { coverage: 'warn', profiles: [{ id: 'home' }] }
    }
  };
}

test('a pinned source review counts only for a step that defines the scope or plans the claims', () => {
  const workflow = renamedStory();
  assert.equal(sourceReviewRequired(workflow, 'shape'), true);
  assert.equal(sourceReviewRequired(workflow, 'map-work'), true);
  // An older pin listing the first step would send it to a review that refuses and a gate that never clears.
  assert.equal(sourceReviewRequired(workflow, 'discover'), false);
  assert.equal(sourceReviewRequired({ ...workflow, resolution: { ...workflow.resolution, sourceReview: { mode: 'warn', phases: ['shape'] } } }, 'shape'), false);
});

test('every submit route names the check the step really owes', () => {
  const workflow = renamedStory();
  assert.deepEqual(submitRoute(workflow, workflow.phases.discover), {
    skill: '/sf-submit', command: 'singularity-flow submit discover --work-id ROLE-1', reason: 'Submit published discover.'
  });
  const reviewed = submitRoute(workflow, workflow.phases.shape);
  assert.equal(reviewed.command, 'singularity-flow status ROLE-1 --submission-readiness --json');
  assert.doesNotMatch(reviewed.command, /review-source/u, 'readiness reports the review and its exact route');
});

test('asking for a source review status is answered for a skipped or unpublished step', async () => {
  const workflow = renamedStory({ statuses: { shape: 'skipped' } });
  const skipped = await readSourceReviewStatus(null, null, workflow, 'shape');
  assert.equal(skipped.status, 'not-required');
  assert.equal(skipped.reason, 'step-skipped');
  const unpublished = await readSourceReviewStatus(null, null, workflow, 'map-work');
  assert.equal(unpublished.status, 'not-yet-published');
  assert.deepEqual(unpublished.findings.map((finding) => finding.code), ['source-review-unpublished']);
});

test('visual coverage answers not-applicable when a decision skipped every visual step', async () => {
  const workflow = renamedStory({ statuses: { look: 'skipped' } });
  const result = await evaluateVisualCoverage(null, workflow, { phaseId: 'reconcile' });
  assert.equal(result.status, 'not-applicable');
  assert.equal(result.reason, 'visual-step-skipped');
});

test('a defaulted fast-path verb finds its step by role when the seeded step is renamed', () => {
  const profile = fastPathProfile({ workTypes: { renamed: { fastPath: { specify: 'approved', plan: 'approved', implement: 'approved' } } } }, 'renamed');
  const approved = renamedStory({ statuses: { shape: 'approved', 'map-work': 'approved' } });
  assert.equal(milestoneReached(approved, profile, 'specify'), true, 'shape defines the scope');
  assert.equal(milestoneReached(approved, profile, 'plan'), true, 'map-work plans the claims');
  assert.equal(milestoneReached(approved, profile, 'implement'), false, 'build-it is not approved yet');
  const explicit = fastPathProfile({ workTypes: { renamed: { fastPath: { specify: { milestone: 'approved', phases: ['specification'] } } } } }, 'renamed');
  assert.equal(milestoneReached(approved, explicit, 'specify'), false, 'an explicit list is never guessed past');
});

test('Initiative milestones follow the step that produces the evidence, whatever it is called', () => {
  const initiative = {
    phaseOrder: ['frame', 'make', 'close'],
    phases: {
      frame: { outputs: [{ id: 'story-plan' }] },
      make: { outputs: [{ id: 'implementation-index' }, { id: 'test-and-ci-report' }] },
      close: { outputs: [{ id: 'initiative-conformance' }] }
    }
  };
  assert.equal(requiredInitiativeMilestone('make', initiative), 'verification');
  assert.equal(requiredInitiativeMilestone('close', initiative), 'conformance');
  assert.equal(requiredInitiativeMilestone('frame', initiative), null);
  assert.deepEqual(milestonePhases(initiative), ['make', 'close']);
  // A step named after a seeded one confers nothing; an older pin without outputs keeps the seeded IDs.
  assert.equal(requiredInitiativeMilestone('delivery', { phases: { delivery: { outputs: [{ id: 'notes' }] } } }), null);
  assert.equal(requiredInitiativeMilestone('delivery', { phases: { delivery: {} } }), 'conformance');
  assert.equal(requiredInitiativeMilestone('construction', null), 'verification');
});
