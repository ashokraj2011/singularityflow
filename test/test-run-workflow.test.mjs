/**
 * Test run, the shipped workflow that only runs a repository's tests [owner, 2026-11-12], and the rule it rests on:
 * a responsibility no step of a workflow holds, and every end of it omits, is settled by the reason the workflow
 * declares, approved with the workflow, so no Story asks a person for it again. One a step holds (a repair step a
 * Story may not reach) stays a person's decision for each Story that ends without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { applicabilityStatus, omittedByEveryRoute, recordApplicabilityDecision } from '../src/evidence/applicability.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function shipped() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-run-'));
  await initializeDefinition(root);
  return { root, definition: await loadDefinition(root) };
}

/** A Story of the work type as its start pins it: the resolved obligation graph, at its natural end. */
function story(resolved) {
  return { resolution: { obligationGraph: resolved.obligationGraph }, phaseOrder: resolved.phases.map((phase) => phase.id), decisionLog: [], phases: {} };
}

test('Test run ships as one step that runs the repository\'s tests and changes nothing', async () => {
  const { root, definition } = await shipped();
  try {
    const resolved = resolveWorkType(definition, 'test-run');
    assert.deepEqual(resolved.phases.map((phase) => phase.id), ['test-run']);
    const [step] = resolved.phases;
    assert.equal(step.repositoryTests, 'run', 'the repository\'s tests run when the step is submitted');
    assert.equal(step.writeScope, 'artifact-only', 'it writes only its report');
    assert.equal(step.artifact.kind, 'test-evidence');
    assert.deepEqual(step.approvalPolicy?.authorities ?? step.approval?.authorities, ['quality-reviewers']);
    assert.deepEqual(resolved.omits?.map((entry) => entry.responsibility) ?? definition.workTypes['test-run'].omits.map((entry) => entry.responsibility),
      ['scope', 'plan', 'implement']);
    const template = await readFile(path.join(root, 'singularity/templates/test-run/run.md'), 'utf8');
    for (const heading of ['## What ran', '## Results', '## Failures and follow-up']) assert.ok(template.includes(heading), heading);
    const qa = await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8');
    assert.match(qa, /sflow-default-for: "[^"]*\btest-run\b/u, 'the QA agent drafts it');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a responsibility no step holds is settled by the workflow; one a step may hold is a person\'s for each Story', async () => {
  const { root, definition } = await shipped();
  try {
    // Test run: nothing holds scope, a plan or a code change, so nobody is asked for them.
    const run = story(resolveWorkType(definition, 'test-run'));
    const settled = applicabilityStatus(run);
    assert.deepEqual(settled.map((entry) => [entry.responsibility, entry.satisfied, entry.decision?.source]),
      [['scope', true, 'workflow'], ['plan', true, 'workflow'], ['implement', true, 'workflow']]);
    assert.equal(settled[0].decision.reason, 'A test run checks the product as it is; it defines no new requirements.',
      'the reason the workflow declares is the one on record');
    assert.equal(omittedByEveryRoute(run, 'scope'), true);

    // A person's decision for one Story still stands over the workflow's own reason.
    recordApplicabilityDecision(run, { responsibility: 'scope', reason: 'This run only re-checks the release candidate.',
      actor: 'quality@example.test', authorityGroup: 'quality-reviewers', at: '2026-11-12T10:00:00.000Z' });
    const decided = applicabilityStatus(run).find((entry) => entry.responsibility === 'scope');
    assert.equal(decided.decision.actor, 'quality@example.test');
    assert.equal(decided.decision.source, undefined);

    // The instruction test loop omits implement at its end, but its repair step implements when a Story reaches it.
    const loop = story(resolveWorkType(definition, 'demo-instruction-test-loop'));
    assert.equal(omittedByEveryRoute(loop, 'implement'), false);
    assert.deepEqual(applicabilityStatus(loop).map((entry) => [entry.responsibility, entry.satisfied, entry.decision]), [['implement', false, null]],
      'an approver of that Story still says why implement does not apply');

    // The shipped workflows this settles: those whose steps never hold what they omit.
    const settledBy = Object.keys(definition.workTypes).filter((id) => {
      const resolved = resolveWorkType(definition, id);
      return applicabilityStatus(story(resolved)).some((entry) => entry.decision?.source === 'workflow');
    }).sort();
    assert.deepEqual(settledBy, ['careful-change', 'poc-lite', 'test-run']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
