/**
 * Intent to work (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md): a task's steps composed from its kind, the team's rules, and
 * the Story that records the composed workflow while workflow.yml stays as it was.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from '../src/config.mjs';
import {
  composeTask, definitionForStory, isTaskWorkType, kindFromWords, pathMatches, planLine, storyComposition, TASK_KINDS,
  taskClosureWorkTypes, taskDefinition, taskRules
} from '../src/task-composition.mjs';
import { taskPlan } from '../src/commands/work.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { taskTurnSkill, taskTurnSkillFor, typedAfterSkill } from '../src/task-turn.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const base = () => structuredClone(BASE);

test('ITW REQ-003: every kind composes the same steps every time, and each starts and walks to its end', async () => {
  const expected = {
    fix: ['intake', 'implementation', 'verification'], chore: ['intake', 'implementation', 'verification'],
    change: ['intake', 'implementation-spec', 'implementation', 'verification'],
    feature: ['intake', 'requirements', 'implementation-spec', 'implementation', 'verification'],
    refactor: ['intake', 'implementation-spec', 'implementation', 'verification'],
    tests: ['intake', 'implementation', 'verification'], docs: ['intake', 'design'],
    investigate: ['intake', 'design'], review: ['intake', 'design']
  };
  assert.deepEqual(Object.keys(expected).sort(), [...TASK_KINDS].sort());
  for (const kind of TASK_KINDS) {
    const plan = await taskPlan(base(), { kind });
    assert.deepEqual(plan.steps.map((step) => step.id), expected[kind], kind);
    assert.equal(plan.walk, 'completed', kind);
    assert.deepEqual(await taskPlan(base(), { kind }), plan, `${kind}: the same words and repository give the same plan`);
    // A person approves two things in every task: the plan (or the intake that is one) and what it delivers.
    assert.equal(plan.steps.filter((step) => step.approvedBy === 'person').length, 2, `${kind}: ${JSON.stringify(plan.steps)}`);
  }
  assert.equal((await taskPlan(base(), { kind: 'fix' })).plan, 'Plan: code → tests. You approve the plan in the intake and the code. Say "add a design step" to change it.');
  assert.equal((await taskPlan(base(), { kind: 'feature' })).plan, 'Plan: requirements → plan → code → tests. You approve the plan and the code. Say "add a design step" to change it.');
  assert.equal((await taskPlan(base(), { kind: 'investigate' })).plan, 'Plan: investigate → report. You approve the intake and the report. Say "add a design step" to change it.');
  assert.deepEqual((await taskPlan(base(), { kind: 'refactor' })).steps.map((step) => step.label), ['Intake', 'Plan: what must not change', 'Code', 'Tests']);
  // An investigation and a review change no code: their steps are document steps.
  for (const kind of ['investigate', 'review', 'docs']) {
    const definition = validateDefinition(structuredClone(taskDefinition(base(), composeTask(base(), { kind }))));
    for (const phase of resolveWorkType(definition, `task-${kind}`).phases) assert.equal(phase.writeScope ?? 'artifact-only', 'artifact-only', `${kind} ${phase.id}`);
  }
});

test('ITW REQ-002: an unknown kind is refused with the kinds; the words give a first guess', () => {
  assert.throws(() => composeTask(base(), { kind: 'hotfix' }), (error) => error.code === 'TASK_KIND_UNKNOWN' && /fix, feature, change/u.test(error.message));
  assert.equal(kindFromWords('why do cancelled orders still send emails?'), 'investigate');
  assert.equal(kindFromWords('fix the login timeout on slow networks'), 'fix');
  assert.equal(kindFromWords('refactor the order parser'), 'refactor');
  assert.equal(kindFromWords('write a spec for order export'), 'docs');
  assert.equal(kindFromWords('add CSV export to orders'), 'feature');
  assert.equal(kindFromWords('hello'), null);
});

test('ITW REQ-004: the team\'s rules only add steps and approvals, and a broken rule is refused with its words', async () => {
  const withRules = (tasks) => Object.assign(base(), { tasks });
  // A path rule adds its step only when the task touches its files.
  const rules = withRules({ paths: [{ paths: ['src/auth/**'], steps: ['review'], because: 'Auth changes get a conformance review.' }] });
  assert.deepEqual(composeTask(rules, { kind: 'fix' }).steps.map((step) => step.intent), ['intake', 'code', 'test']);
  const touched = composeTask(rules, { kind: 'fix', touchedPaths: ['src/auth/login.js'] });
  assert.deepEqual(touched.steps.map((step) => step.intent), ['intake', 'code', 'test', 'review']);
  assert.deepEqual(touched.added, [{ intent: 'review', rule: 'paths[0]', because: 'Auth changes get a conformance review.' }]);
  assert.equal((await taskPlan(rules, { kind: 'fix', touchedPaths: ['src/auth/login.js'] })).walk, 'completed');
  // A rule never gives a step that reads code to a task with no code.
  assert.deepEqual(composeTask(rules, { kind: 'investigate', touchedPaths: ['src/auth/login.js'] }).steps.map((step) => step.intent), ['intake', 'design']);
  // `always` raises an approval to a person.
  const raised = withRules({ always: [{ kinds: ['fix'], personApproves: ['test'], because: 'A person reads every fix\'s test results.' }] });
  const plan = await taskPlan(raised, { kind: 'fix' });
  assert.deepEqual(plan.steps.map((step) => step.approvedBy), ['person', 'person', 'person']);
  // `use` sends a kind to a configured workflow, unchanged.
  const used = withRules({ use: { feature: 'classic-delivery' } });
  assert.equal(composeTask(used, { kind: 'feature' }).workType, 'classic-delivery');
  assert.equal(taskDefinition(used, composeTask(used, { kind: 'feature' })), used);
  assert.equal(taskRules(withRules({ idPrefix: 'FIX' })).idPrefix, 'FIX');
  for (const [tasks, words] of [
    [{ skip: [] }, /'skip' is not a tasks rule/u],
    [{ always: [{ steps: ['deploy'], because: 'x' }] }, /names 'deploy'/u],
    [{ always: [{ steps: ['review'] }] }, /needs a because/u],
    [{ use: { feature: 'nowhere' } }, /'nowhere', which is not a workflow here/u],
    [{ idPrefix: 'task-1' }, /idPrefix must be letters and digits/u]
  ]) assert.throws(() => composeTask(withRules(tasks), { kind: 'fix' }), (error) => error.code === 'TASK_RULES_INVALID' && words.test(error.message), JSON.stringify(tasks));
  assert.equal(pathMatches('src/auth/**', 'src/auth/a/b.js'), true);
  assert.equal(pathMatches('db/migrations/*.sql', 'db/migrations/001.sql'), true);
  assert.equal(pathMatches('db/migrations/*.sql', 'db/migrations/a/001.sql'), false);
});

test('ITW REQ-009: before a task starts, a person may add a step or take one out; a rule\'s step and a code task\'s tests stay', async () => {
  const added = await taskPlan(base(), { kind: 'fix', add: ['design'] });
  assert.deepEqual(added.steps.map((step) => step.id), ['intake', 'design', 'implementation', 'verification']);
  assert.equal(added.walk, 'completed');
  assert.deepEqual(composeTask(base(), { kind: 'fix', add: ['design'] }).changes, [{ change: 'add', intent: 'design' }]);
  const skipped = await taskPlan(base(), { kind: 'change', skip: ['plan'] });
  assert.deepEqual(skipped.steps.map((step) => step.id), ['intake', 'implementation', 'verification']);
  // The intake of a change without its plan step is its plan: a person still approves two things.
  assert.equal(skipped.steps.filter((step) => step.approvedBy === 'person').length, 2);
  for (const [options, words] of [
    [{ kind: 'fix', skip: ['test'] }, /Every code change gets a test step/u],
    [{ kind: 'fix', skip: ['intake'] }, /Every task starts with its intake/u],
    [{ kind: 'investigate', skip: ['design'] }, /report is its design step/u],
    [{ kind: 'fix', add: ['deploy'] }, /not 'deploy'/u]
  ]) assert.throws(() => composeTask(base(), options), (error) => error.code === 'TASK_CHANGE_REFUSED' && words.test(error.message), JSON.stringify(options));
  // "Skip the review" on a task a rule gives one is refused with the rule's words [A4].
  const ruled = Object.assign(base(), { tasks: { always: [{ kinds: ['feature'], steps: ['review'], because: 'Every feature gets a conformance review.' }] } });
  assert.throws(() => composeTask(ruled, { kind: 'feature', skip: ['review'] }),
    (error) => error.code === 'TASK_CHANGE_REFUSED' && /Every feature gets a conformance review/u.test(error.message));
});

test('ITW REQ-006: the composed work type lives in memory and in the Story\'s record, never in the configuration', () => {
  const definition = base();
  const before = JSON.stringify(definition);
  const composition = composeTask(definition, { kind: 'change' });
  const overlaid = taskDefinition(definition, composition);
  assert.equal(JSON.stringify(definition), before, 'the definition it was laid over is unchanged');
  assert.ok(overlaid.workTypes['task-change'] && !definition.workTypes['task-change']);
  assert.equal(isTaskWorkType('task-change'), true);
  assert.equal(isTaskWorkType('task-deploy'), false);
  // A later command rebuilds the Story's work type from its record.
  const workflow = { resolution: { composition: structuredClone(composition) } };
  assert.deepEqual(storyComposition(workflow), composition);
  const resolved = assertWorkTypeStartable(resolveWorkType(validateDefinition(structuredClone(definitionForStory(definition, workflow))), 'task-change'));
  assert.deepEqual(resolved.phases.map((phase) => phase.id), ['intake', 'implementation-spec', 'implementation', 'verification']);
  assert.equal(definitionForStory(definition, { resolution: {} }), definition);
  // The Story branch carries the configured workflows that own its steps.
  assert.deepEqual(taskClosureWorkTypes(definition, composition), ['feature']);
  // A configured workflow with the composed name is never overwritten.
  const taken = base();
  taken.workTypes['task-fix'] = structuredClone(taken.workTypes.chore);
  assert.throws(() => taskDefinition(taken, composeTask(taken, { kind: 'fix' })), (error) => error.code === 'TASK_WORK_TYPE_TAKEN');
});

test('ITW REQ-001, REQ-007: work shows the plan and writes nothing; --start starts TASK-1 on the default branch with the composed steps', async (t) => {
  const story = await journeyRepository(t);
  const workflowFile = await story.read('singularity/workflow.yml');
  const shown = JSON.parse(story.cli('work', 'fix the value module so it returns 2', '--json'));
  assert.equal(shown.resultType, 'sflow-task-plan');
  assert.equal(shown.kind, 'fix');
  assert.deepEqual(shown.steps.map((step) => step.id), ['intake', 'implementation', 'verification']);
  assert.equal(story.git('status', '--porcelain'), '', 'showing the plan writes nothing');
  const started = JSON.parse(story.cli('work', 'fix the value module so it returns 2', '--start', '--json'));
  const data = started.data ?? started;
  assert.equal(data.id, 'TASK-1');
  assert.equal(data.task.kind, 'fix');
  assert.match(data.task.plan, /^Plan: code → tests\./u);
  story.item = 'singularity/work-items/TASK-1';
  const record = storyRecord(story);
  assert.equal(record.workItem.workType, 'task-fix');
  assert.equal(record.workItem.baseBranch, 'main');
  assert.deepEqual(record.phaseOrder, ['intake', 'implementation', 'verification']);
  assert.equal(record.resolution.composition.kind, 'fix');
  assert.equal(record.workItem.title, 'fix the value module so it returns 2');
  assert.equal(await story.read('singularity/workflow.yml'), workflowFile, 'workflow.yml is never written');
  // A later command reads the Story's own workflow.
  const shownStep = JSON.parse(story.cli('phase', 'show', 'intake', '--json'));
  assert.equal((shownStep.data ?? shownStep).phase?.id ?? (shownStep.data ?? shownStep).id ?? 'intake', 'intake');
  // Where the task stands, for its last message.
  const status = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.deepEqual([status.id, status.kind, status.done, status.branch], ['TASK-1', 'fix', false, 'TASK-1']);
  assert.deepEqual(status.steps.map((step) => step.status), ['in_progress', 'not_started', 'not_started']);
  assert.match(status.words, /^TASK-1 is at Intake\./u);
  // The next task takes the next free ID.
  // On TASK-1's own checkout the words are TASK-1's; "new task" (--new) starts another there.
  story.git('checkout', '-q', 'TASK-1');
  const held = story.raw(['work', 'investigate why the value is 1', '--start', '--json']);
  assert.notEqual(held.status, 0);
  assert.match(`${held.stdout}${held.stderr}`, /TASK_OPEN_HERE/u);
  story.git('checkout', '-q', 'main');
  const second = JSON.parse(story.cli('work', 'investigate why the value is 1', '--start', '--json'));
  assert.equal((second.data ?? second).id, 'TASK-2');
  // "fix it" after the investigation starts from its report, carried as the intake.
  story.git('checkout', '-q', 'main');
  const early = story.raw(['work', 'fix it', '--kind', 'fix', '--from', 'TASK-2', '--start', '--json']);
  assert.notEqual(early.status, 0);
  assert.match(`${early.stdout}${early.stderr}`, /TASK_FROM_NO_REPORT/u, 'no report yet');
  story.git('checkout', '-q', 'TASK-2');
  const investigation = JSON.parse(await story.read('singularity/work-items/TASK-2/workflow.json'));
  await story.write(`singularity/work-items/TASK-2/${investigation.phases.design.requiredArtifact.path}`, '# Findings\n\nThe value module exports 1; the tests expect 2.\n');
  const fix = JSON.parse(story.cli('work', 'fix it', '--kind', 'fix', '--from', 'TASK-2', '--new', '--start', '--json'));
  assert.equal((fix.data ?? fix).id, 'TASK-3');
  assert.match(story.git('show', 'TASK-3:singularity/work-items/TASK-3/USER-STORY.md'), /Starts from TASK-2's report[^]*the tests expect 2/u);
  // "… and open a pull request" puts it at the end of the plan.
  const asked = JSON.parse(story.cli('work', 'fix the value module and open a pull request', '--json'));
  assert.match(asked.plan, /→ pull request\./u);
});

test('ITW REQ-008: /sf-task on an open task takes the turn of what the Story needs next; with no Story it stays a task turn', async (t) => {
  assert.equal(typedAfterSkill('/sf-task'), '');
  assert.equal(typedAfterSkill('/sf-task fix the login'), 'fix the login');
  assert.equal(typedAfterSkill('<skill-context name="sf-task">x ARGUMENTS: add a design step </skill-context>'), 'add a design step');
  const story = await journeyRepository(t);
  story.cli('work', 'fix the value module so it returns 2', '--start', '--json');
  story.item = 'singularity/work-items/TASK-1';
  const record = storyRecord(story);
  // The step's own work is /sf-next's turn; a person's approval is /sf-approve's; a decision is /sf-decide's.
  assert.equal(taskTurnSkillFor(record, workflowGuide(record)), 'sf-next');
  const waiting = structuredClone(record);
  waiting.phases[waiting.currentPhase].status = 'awaiting_approval';
  assert.equal(taskTurnSkillFor(waiting, workflowGuide(waiting)), 'sf-approve');
  const deciding = structuredClone(record);
  deciding.pendingDecision = { key: 'd1', label: 'Pick one', options: [{ id: 'a', label: 'A' }] };
  assert.equal(taskTurnSkillFor(deciding, workflowGuide(deciding)), 'sf-decide');
  assert.equal(taskTurnSkillFor({ ...record, status: 'closed' }, workflowGuide(record)), null);
  // From the real Story: the chat bound to it gets /sf-next's turn, and typed words keep /sf-task's.
  assert.equal(await taskTurnSkill({ prompt: '/sf-task', cwd: story.root }, { resolveRoot: async () => story.root }), 'sf-next');
  // Words while the task is open are its next turn too (an answer, "go on"); the skill reads them.
  assert.equal(await taskTurnSkill({ prompt: '/sf-task go ahead', cwd: story.root }, { resolveRoot: async () => story.root }), 'sf-next');
  assert.equal(await taskTurnSkill({ prompt: '/sf-task', cwd: story.base }, { resolveRoot: async () => null }), null, 'no Story: a task turn');
  let captured = null;
  await recordRepositoryBoundaryTurn({ sessionId: 'task-turn', cwd: story.root, timestamp: Date.now(), prompt: '/sf-task' },
    { captureMutation: async (_payload, turn) => { captured = turn; return {}; } });
  assert.equal(captured?.skill, 'sf-next');
  assert.equal(captured?.typedSkill, 'sf-task');
});
