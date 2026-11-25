/**
 * Journey ITW (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md A1, A10, A11): a task started from its words, walked by its routes to
 * its end as Copilot CLI drives it, with the workflow's own checks deciding each step. The scripted agent writes each
 * step from its own template, by intent (test/helpers/generated-journey.mjs), so nothing here knows the composed steps.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { firstClause, generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

async function walkTask(t, words, kind) {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const walk = await followRoutes(story, {
    label: `task ${kind}`,
    start: { shell: `singularity-flow work "${words}" --kind ${kind} --start` },
    agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'),
    done: ({ record }) => record?.status === 'closed',
    maxSteps: 160
  });
  t.diagnostic(formatTrail(walk.trail));
  return { story, walk };
}

test('journey ITW: a fix task goes from its words to a closed Story by its routes, and a person approves the plan and the code', slowLane({ timeout: 1_800_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'fix the value module so it returns 2', 'fix');
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const record = storyRecord(story);
  assert.equal(record.workItem.workType, 'task-fix');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  const byPerson = record.phaseOrder.filter((id) => record.phases[id].approvedBy);
  assert.deepEqual(byPerson, ['intake', 'implementation'], 'a person approves the plan in the intake and the code; SFlow the test step');
  assert.equal(record.phases.verification.approvalDisposition, 'approved_automatically');
  // What the person did [ITW:REQ-019]: the words, the intake's one question, and two approvals; the start's route is /sf-task.
  assert.equal(walk.trail[1]?.turn, '/sf-task', formatTrail(walk.trail));
  assert.equal(walk.trail.filter((entry) => entry.turn === 'person').length, 2, formatTrail(walk.trail));
  assert.equal(walk.trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length, 1, formatTrail(walk.trail));
  void firstClause;
});

test('journey ITW: an investigation ends with its report approved by a person and changes no code', slowLane({ timeout: 1_800_000 }), async (t) => {
  const { story, walk } = await walkTask(t, 'why does the value module return 1', 'investigate');
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'design']);
  assert.equal(record.phases.design.approvedBy ? 'person' : 'sflow', 'person', 'a person approves the report');
  assert.equal(story.git('diff', '--name-only', 'main', 'TASK-1', '--', 'src', 'test'), '', 'no code changed');
});

for (const [kind, words, steps] of [
  ['docs', 'write a short note about the value module', ['intake', 'design']],
  ['change', 'make the value module return 2', ['intake', 'implementation-spec', 'implementation', 'verification']],
  ['feature', 'add a second value to the value module', ['intake', 'requirements', 'implementation-spec', 'implementation', 'verification']]
]) {
  // The scripted author writes a step from its intent's own template; the packaged implementation-spec template a feature's
  // plan step keeps asks for more than it writes, so the feature walk stops at a correction a real agent makes. The same
  // steps run in the packaged feature workflow.
  const known = kind === 'feature' ? { todo: 'the scripted author cannot write the packaged implementation-spec template' } : {};
  test(`journey ITW: a ${kind} task goes from its words to a closed Story by its routes, with two approvals by a person`, { ...slowLane({ timeout: 2_400_000 }), ...known }, async (t) => {
    const { story, walk } = await walkTask(t, words, kind);
    assert.equal(walk.reached, true, formatTrail(walk.trail));
    assert.deepEqual(walk.findings, [], JSON.stringify(walk.findings));
    const record = storyRecord(story);
    assert.deepEqual(record.phaseOrder, steps);
    assert.equal(record.phaseOrder.filter((id) => record.phases[id].approvedBy).length, 2, JSON.stringify(record.phaseOrder.map((id) => [id, record.phases[id].approvedBy ?? record.phases[id].approvalDisposition])));
  });
}
