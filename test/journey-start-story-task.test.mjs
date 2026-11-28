/**
 * Journey ITW REQ-114 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md): a small change started from VS Code's Start Story in task
 * mode, walked to its end by its routes. The person fills in the Story's details and presses Start: the extension runs
 * the form's own `work --start` (apps/vscode/src/views/intake-form.ts taskIntakeCommand), then sends /sf-task to the chat
 * of the window that opens the task's checkout (extension.ts carryStartedTaskOn), so nothing is typed. From there the walk
 * is /sf-task's own: the requirement, its Yes, implement and test, its Yes, SFlow's run of the tests.
 * Counted [ITW:REQ-112]: Start, the requirement's Yes, the code's Yes: 3, as /sf-task in the chat; the form adds none.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_INTAKE_FORM, taskIntakeCommand } from '../apps/vscode/src/views/intake-form.ts';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

/** What the person did on the walk, as the /sf-task journeys count it (journey-tasks-shapes.test.mjs personActions). */
const personActions = (trail) => {
  const typed = trail.filter((entry) => entry.typed).length;
  const answers = trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length;
  const own = trail.filter((entry) => entry.turn === 'person').length;
  return { typed, answers, own };
};

test('journey ITW REQ-114: a small change from Start Story\'s task mode is Start and two Yeses, as /sf-task is', slowLane({ timeout: 2_400_000 }), async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  // The form as the person filled it: the ID, the title, the words; the base the form chose. No workflow, no checks.
  const form = { ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', startMode: 'task', id: 'TASK-1', title: 'Make the value module return 2',
    description: 'The value module returns 1; its callers want 2.', baseBranch: 'main', basePreflightPassed: true,
    baseRepositories: [{ id: 'repository', defaultBranch: 'main', branches: ['main'] }],
    baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }] };
  // Start: the form's command as the extension runs it. Its own checkout is the window's that the chat then runs in, so
  // the walk starts the task in the journey's checkout, where its chat runs: the one flag that names the checkout aside.
  const command = taskIntakeCommand(form);
  assert.ok(command.includes('--isolated-worktree'));
  const started = JSON.parse(story.cli(...command.filter((word) => word !== '--isolated-worktree')));
  assert.equal((started.data ?? started).id, 'TASK-1');
  // VS Code sends /sf-task to that chat: the turn goes on as after /sf-task's own start.
  const walk = await followRoutes(story, {
    label: 'task from Start Story',
    start: { copilot: '/sf-task', sent: 'VS Code' },
    agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'),
    done: ({ record }) => record?.status === 'closed', maxSteps: 160
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.deepEqual(walk.findings, [], `${JSON.stringify(walk.findings)}\n${formatTrail(walk.trail)}`);
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.sizing, 'requirement');
  assert.deepEqual(record.phaseOrder.map((id) => record.phases[id].label), ['Requirement', 'Implement and test', 'Tests']);
  assert.equal(record.phases.verification.approvalDisposition, 'approved_automatically');
  // Start (the form's one action past filling it in), the requirement's Yes and the code's Yes; nothing typed.
  const actions = personActions(walk.trail);
  assert.deepEqual(actions, { typed: 0, answers: 2, own: 0 }, formatTrail(walk.trail));
  assert.equal(1 + actions.typed + actions.answers + actions.own, 3);
});
