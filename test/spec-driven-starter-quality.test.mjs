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
  // A pinned Story carries each step's responsibilities: the specification defines the scope.
  const pinned = (resolution) => ({ phases: { specification: {}, implementation: {} }, resolution: { ...resolution,
    obligationGraph: { nodes: [{ id: 'specification', responsibilities: ['scope'] }, { id: 'implementation', responsibilities: ['implement'] }] } } });
  assert.equal(sourceReviewRequired(pinned({ sourceReview: current }), 'specification'), true);
  // A reviewer in every authored step, code included (owner decision 2026-11-10, review level 2, 92a78019c).
  assert.equal(sourceReviewRequired(pinned({ sourceReview: current }), 'implementation'), true);
  assert.equal(sourceReviewRequired(pinned({}), 'specification'), false);
  assert.throws(() => normalizeSourceReviewPolicy({ mode: 'enforce', phases: ['nonexistent'],
    reviewerAgent: 'sflow-source-reviewer' }, { workTypeId: 'bad', phases: starter.phases }),
  /distinct active steps/);
  // Level 2 (a72215495): a legacy phases list no longer limits or refuses the review; it is kept and reported.
  const listed = normalizeSourceReviewPolicy({ mode: 'enforce', phases: ['implementation'], reviewerAgent: 'sflow-source-reviewer' },
    { workTypeId: 'bad', phases: starter.phases, reviewable: (id) => (id === 'implementation' ? null : 'specification') });
  assert.deepEqual(listed.supersededPhases, ['implementation']);
  assert.ok(listed.phases.includes('implementation'));
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
