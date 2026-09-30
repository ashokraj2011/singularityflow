import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import {
  CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256, packagedWorkflowValueSha256
} from '../src/packaged-workflow-history.mjs';
import {
  assertSourceReviewerAvailable, normalizeSourceReviewPolicy, sourceReviewRequired
} from '../src/source-review-policy.mjs';

const template = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
const starter = template.workTypes['spec-driven-standard'];

test('spec-driven starter keeps a reviewed clause-continuity contract', () => {
  assert.equal(starter.spec.mode, 'enforce');
  assert.equal(starter.spec.coverage, 'enforce');
  assert.equal(starter.plannedClaims.mode, 'required');
  assert.equal(starter.plannedClaims.owners.implementation, 'planning');
  assert.deepEqual(starter.sourceReview, {
    mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer'
  });
  assert.equal(packagedWorkflowValueSha256(starter),
    CURRENT_PACKAGED_WORKFLOW_VALUE_SHA256.workTypes['spec-driven-standard']);
});

test('independent review is an explicit pinned policy, not a retroactive Story gate', () => {
  const current = normalizeSourceReviewPolicy(starter.sourceReview, {
    workTypeId: 'spec-driven-standard', phases: starter.phases
  });
  assert.equal(sourceReviewRequired({ resolution: { sourceReview: current } }, 'specification'), true);
  assert.equal(sourceReviewRequired({ resolution: { sourceReview: current } }, 'implementation'), false);
  assert.equal(sourceReviewRequired({ resolution: {} }, 'specification'), false);
  assert.throws(() => normalizeSourceReviewPolicy({ mode: 'enforce', phases: ['implementation'],
    reviewerAgent: 'sflow-source-reviewer' }, { workTypeId: 'bad', phases: starter.phases }),
  /distinct active specification\/planning/);
  assert.throws(() => assertSourceReviewerAvailable(current, [], {
    workTypeId: 'spec-driven-standard'
  }), { code: 'SOURCE_REVIEW_AGENT_UNAVAILABLE' });
  assert.doesNotThrow(() => assertSourceReviewerAvailable(current, [{
    id: 'sflow-source-reviewer', metadata: { 'sflow-mode': 'read-only-review' }
  }], { workTypeId: 'spec-driven-standard' }));
});

test('spec-driven downstream briefs retain scope, failures, permissions, and clauses', () => {
  const required = [
    'Actors', 'User scenarios', 'Failure and empty states', 'Permissions',
    'Boundary conditions', 'Requirements', 'Non-functional requirements',
    'Assumptions', 'Out of scope'
  ];
  for (const phase of ['planning', 'implementation', 'convergence', 'verification']) {
    const specification = starter.phaseOverrides[phase].inputs.find((entry) => entry.phase === 'specification');
    assert.ok(specification, `${phase} needs an approved specification input`);
    assert.deepEqual(specification.preserve, required, `${phase} must preserve the same reviewable scope`);
    assert.equal(specification.expansion, 'hash-bound-reference');
    assert.equal(specification.fallback, 'block');
  }
});
