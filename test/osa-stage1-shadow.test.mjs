/**
 * SPEC-OSA v1.1 shadow comparison (scripts/osa-shadow.mjs): the kernel's decision against every surface that names a
 * step's next action, on the same captured Story records and the same review, executing nothing [plan sections 3 and 5].
 *
 * Stage 1 moved the edit permission and the entry; Stage 3 moved sequence guidance, the guide, next steps, the review
 * continuation and submission readiness onto the same decision (step-decision.mjs). Stage 1's declared differences (sequence
 * ignored the amendment pause, wrote a damaged step and named submit where the permission led with readiness) are gone, so
 * every difference is now a new competing decision [OSA:AC-002, AC-020, section 13].
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { operationOf, shadowDifferences } from '../scripts/osa-shadow.mjs';

test('the shadow comparison: every surface names the kernel\'s operation for the same Story and review [OSA:AC-002]', async () => {
  const { records, comparisons, differences } = await shadowDifferences();
  assert.ok(records >= 600, `${records} captured records`);
  // Six surfaces, each read on every record it applies to, with each review a surface may hold.
  assert.ok(comparisons >= 6000, `${comparisons} surface readings`);
  assert.deepEqual(differences.slice(0, 5), [], `${differences.length} differences`);
});

test('the comparison reads two renderings of one action as one operation, and different actions apart', () => {
  assert.equal(operationOf('singularity-flow submit implement --work-id W-1'), operationOf('singularity-flow status W-1 --submission-readiness --json'));
  assert.equal(operationOf('singularity-flow review-source status plan'), operationOf('singularity-flow review-source context plan --json'));
  assert.equal(operationOf('singularity-flow phase begin implement --json'), operationOf('singularity-flow prepare implement'));
  assert.notEqual(operationOf('singularity-flow phase rollover implement --json'), operationOf('singularity-flow prepare implement'));
  assert.notEqual(operationOf('singularity-flow recover W-1 --phase implement --json'), operationOf('singularity-flow prepare implement'));
  assert.notEqual(operationOf('singularity-flow decisions W-1'), operationOf('singularity-flow submit implement'));
});
