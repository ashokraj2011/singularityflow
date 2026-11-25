/**
 * Intent to work, changing the plan (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-009): a started task gains a step after
 * its current one, as one accepted revision of its pinned workflow; done steps and the current one stay as they are,
 * nothing is taken out, and every later command reads the Story with its new step.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { reviewSafeTaskChanges } from '../src/task-change-review.mjs';
import { assertTaskChangeScope, stableTaskStepState } from '../src/task-change-contracts.mjs';
import { assertTaskStepAddable } from '../src/task-amendment.mjs';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ITEM = 'singularity/work-items/TASK-1';
const json = (text) => JSON.parse(text);
/** A command the person runs that SFlow refuses: its code, words and way out. */
function refusal(story, args) {
  const result = story.raw(['--no-model', ...args, '--json']);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused:\n${result.stdout}`);
  const text = `${result.stdout}\n${result.stderr}`;
  const start = text.indexOf('{');
  const body = start >= 0 ? json(text.slice(start, text.lastIndexOf('}') + 1)) : {};
  return { text, body, code: body.error?.code ?? body.code ?? /"code":\s*"([A-Z_]+)"/u.exec(text)?.[1] ?? null };
}

async function startedFix(t) {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  json(story.cli('work', 'fix the value module so it returns 2', '--start', '--json'));
  return story;
}

test('ITW REQ-009: a started fix gains a design step before its code, as a new revision of its pinned workflow', async (t) => {
  const story = await startedFix(t);
  const before = storyRecord(story);
  assert.deepEqual(before.phaseOrder, ['intake', 'implementation', 'verification']);
  const changed = json(story.cli('work', 'add', 'design', '--json'));
  assert.equal(changed.resultType, 'sflow-task-change');
  assert.equal(changed.changeId, 'TSC-001');
  assert.equal(changed.words, 'Added a design step before the code.');
  assert.match(changed.plan, /^Plan: design → code → tests\./u);
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'design', 'implementation', 'verification']);
  assert.deepEqual(record.resolution.phases.map((phase) => phase.id), record.phaseOrder);
  assert.equal(record.currentPhase, 'intake');
  // Done and current steps stay byte for byte; the new one has not started; later steps read it and may return to it.
  assert.deepEqual(stableTaskStepState(record.phases.intake), stableTaskStepState(before.phases.intake));
  assert.deepEqual(record.resolution.phases[0], before.resolution.phases[0]);
  assert.equal(record.phases.design.status, 'not_started');
  assert.equal(record.phases.design.label, 'Design');
  assert.ok(record.phases.implementation.inputs.some((input) => input.phase === 'design'));
  assert.deepEqual(record.phases.implementation.approvalPolicy.rejectTo, ['intake', 'design', 'implementation']);
  assert.equal(record.phases.implementation.order, 2);
  // Recorded with who asked, once in the composition and once in the history.
  const composition = record.resolution.composition;
  assert.deepEqual(composition.steps.map((step) => step.id), record.phaseOrder);
  const last = composition.changes.at(-1);
  assert.deepEqual(Object.keys(last).sort(), ['at', 'by', 'change', 'intent']);
  assert.equal(last.change, 'add');
  assert.equal(last.intent, 'design');
  assert.equal(last.by, 'journey.driver@example.com');
  // The intake was the plan, so a person approves it; with a design step it would go to SFlow, so it stays a person's.
  assert.deepEqual(composition.personKeeps, ['intake']);
  assert.equal(record.resolution.phases[0].approval.automatic, undefined);
  assert.equal(record.history.at(-1).event, 'task_step_added');
  assert.equal(record.taskChanges.length, 1);
  // A new snapshot revision linked to its parent, and its decision record in the same commit.
  assert.equal(record.workflowSnapshot.revision, 2);
  assert.equal(record.workflowSnapshot.genesisSnapshotHash, before.workflowSnapshot.snapshotHash);
  const manifest = json(readFileSync(path.join(story.root, record.workflowSnapshot.manifestPath), 'utf8'));
  assert.equal(manifest.parentSnapshotHash, before.workflowSnapshot.snapshotHash);
  assert.equal(manifest.semantics.amendment, 'task-step-added/v1');
  assert.ok(manifest.assets.some((asset) => asset.logicalId === 'template:design'));
  const decisionPath = record.taskChanges[0].decisionPath;
  const decision = json(readFileSync(path.join(story.root, decisionPath), 'utf8'));
  assert.equal(decision.step.id, 'design');
  assert.equal(decision.afterPhase, 'intake');
  assertTaskChangeScope(before.resolution, record.resolution, decision);
  const files = story.git('show', '--name-only', '--format=', 'HEAD').split('\n');
  assert.ok(files.includes(decisionPath) && files.includes(record.workflowSnapshot.manifestPath), files.join('\n'));
  assert.equal(story.git('status', '--porcelain'), '', 'the change is committed whole');
  // A step submitted before the change keeps its review: the change commit is exactly one added step after it.
  const change = story.git('rev-parse', 'HEAD');
  const config = { workItemRoot: 'singularity/work-items' };
  assert.deepEqual(await reviewSafeTaskChanges(story.root, config, record, { id: 'intake' }, [change]), [change]);
  assert.deepEqual(await reviewSafeTaskChanges(story.root, config, record, { id: 'implementation' }, [change]), [],
    'a step the change comes before is not one whose review it leaves alone');
  // Every later command reads the Story with its new step.
  const shown = json(story.cli('phase', 'show', 'intake', '--json'));
  assert.ok(JSON.stringify(shown).includes('intake'));
  const status = json(story.cli('status', '--json'));
  assert.ok(JSON.stringify(status).includes('design'), 'status names the new step');
  const work = json(story.cli('work', 'status', '--json'));
  assert.deepEqual(work.steps.map((step) => step.id), record.phaseOrder);
  // A second step: a review after the tests, revision 3.
  const review = json(story.cli('work', 'add', 'review', '--json'));
  assert.equal(review.words, 'Added a review step after the tests.');
  const again = storyRecord(story);
  assert.deepEqual(again.phaseOrder, ['intake', 'design', 'implementation', 'verification', 'conformance']);
  assert.equal(again.workflowSnapshot.revision, 3);
  json(story.cli('status', '--json'));
});

test('ITW REQ-009: a started task only gains steps, after its current one, and says why in plain words', async (t) => {
  const story = await startedFix(t);
  const again = (step) => refusal(story, ['work', 'add', step]);
  json(story.cli('work', 'add', 'design', '--json'));
  const twice = again('design');
  assert.equal(twice.code, 'TASK_CHANGE_REFUSED', twice.text);
  assert.match(twice.text, /already has a design step/u);
  const unknown = again('tests');
  assert.equal(unknown.code, 'TASK_CHANGE_REFUSED', unknown.text);
  assert.match(unknown.text, /can gain a requirements, design, plan, review step/u);
  const skipped = refusal(story, ['work', 'skip', 'verification']);
  assert.equal(skipped.code, 'TASK_CHANGE_REFUSED', skipped.text);
  assert.match(skipped.text, /only gains steps/u);
  assert.equal(storyRecord(story).workflowSnapshot.revision, 2, 'a refusal writes nothing');
  assert.equal(story.git('status', '--porcelain'), '');
});

test('ITW REQ-009: a step whose place is at or before the current step is refused with the reason', async () => {
  const steps = [{ id: 'intake', intent: 'intake', label: 'Intake' }, { id: 'implementation', intent: 'code', label: 'Code' },
    { id: 'verification', intent: 'test', label: 'Tests' }];
  const workflow = (current, statuses) => ({
    workItem: { id: 'TASK-9' }, status: 'in_progress', currentPhase: current, phaseOrder: steps.map((step) => step.id),
    phases: Object.fromEntries(steps.map((step) => [step.id, { status: statuses[step.id] ?? 'not_started' }])),
    resolution: { composition: { schemaVersion: 1, kind: 'fix', workType: 'task-fix', steps, added: [], personApproves: [], rules: [] } }
  });
  const coding = workflow('implementation', { intake: 'approved', implementation: 'in_progress' });
  await assert.rejects(assertTaskStepAddable(coding, 'plan'), (error) => error.code === 'TASK_CHANGE_REFUSED'
    && error.message === 'The code is already being written; a plan step goes before it.' && error.details.nextAction.command === 'singularity-flow work status TASK-9');
  const testing = workflow('verification', { intake: 'approved', implementation: 'approved', verification: 'in_progress' });
  await assert.rejects(assertTaskStepAddable(testing, 'design'), /^SingularityFlowError: The code is already written; a design step goes before it\.$|The code is already written; a design step goes before it\./u);
  assert.equal((await assertTaskStepAddable(coding, 'review')).position, 3);
  const docs = { ...workflow('intake', {}), resolution: { composition: { kind: 'docs', workType: 'task-docs', steps: [steps[0], { id: 'design', intent: 'design', label: 'Write the document' }] } } };
  await assert.rejects(assertTaskStepAddable(docs, 'review'), /A review step reads code, and a docs task changes none\./u);
  const story = { ...coding, resolution: {} };
  await assert.rejects(assertTaskStepAddable(story, 'design'), /was not started as a task/u);
  await assert.rejects(assertTaskStepAddable({ ...coding, status: 'closed' }, 'review'), /TASK-9 is closed/u);
});

test('journey ITW REQ-009: a review added while the code waits for its approval keeps that approval, and the task walks on to it', slowLane({ timeout: 1_800_000 }), async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  const routes = { agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1') };
  const coded = await followRoutes(story, { label: 'task fix to its code approval', ...routes, maxSteps: 120,
    start: { shell: 'singularity-flow work "fix the value module so it returns 2" --kind fix --start' },
    done: ({ record }) => record?.phases?.implementation?.status === 'awaiting_approval' });
  t.diagnostic(formatTrail(coded.trail));
  assert.equal(coded.reached, true, formatTrail(coded.trail));
  const changed = json(story.cli('work', 'add', 'review', '--json'));
  assert.equal(changed.words, 'Added a review step after the tests.');
  assert.equal(storyRecord(story).phases.implementation.status, 'awaiting_approval', 'the step under review is untouched');
  const walked = await followRoutes(story, { label: 'task fix after its added review', ...routes, maxSteps: 160,
    // The person's approval of the code, which the walk left waiting for them.
    start: { ...coded.next, person: true },
    done: ({ record }) => record?.status === 'closed' });
  t.diagnostic(formatTrail(walked.trail));
  const record = storyRecord(story);
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification', 'conformance']);
  assert.ok(record.phases.implementation.approvedBy, `a person approved the code after the review was added: ${formatTrail(walked.trail)}`);
  assert.notEqual(record.phases.conformance.status, 'not_started', formatTrail(walked.trail));
  assert.equal(walked.reached, true, formatTrail(walked.trail));
  assert.deepEqual(walked.findings, [], JSON.stringify(walked.findings));
});
