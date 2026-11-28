/**
 * Intent to work v1.2 (docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md REQ-101–106): a code task starts with its requirement and one
 * step that implements and tests; its shape, small or big, is decided from Copilot's proposal and the facts SFlow computes
 * from the files the requirement names; a big change gains its spec, design (for UI or architecture work), plan and tests.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { composeTask, planLine, SIZED_KINDS, taskDefinition, taskRules, taskShape } from '../src/task-composition.mjs';
import { areaOf, namedFiles, nextWords, proposedSize, shapeFacts, SMALL_LIMITS, taskApprovalQuestion, taskIntakeGuidance } from '../src/task-shape.mjs';
import { bigShapeStep } from '../src/task-change-contracts.mjs';
import { taskPlan } from '../src/commands/work.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const base = (tasks) => Object.assign(structuredClone(BASE), tasks ? { tasks } : {});
const intents = (composition) => composition.steps.map((step) => step.intent);

test('ITW REQ-101, REQ-102, REQ-104: a code task starts with its requirement, one step that implements and tests, and SFlow\'s run of the tests; a refactor and an analysis keep their steps', async () => {
  for (const kind of SIZED_KINDS) {
    const composition = composeTask(base(), { kind });
    assert.deepEqual(intents(composition), ['intake', 'code', 'test'], kind);
    assert.equal(composition.sizing, 'requirement', kind);
    assert.equal(taskShape(composition), 'small', kind);
    assert.equal(composition.steps[0].label, 'Requirement');
    assert.equal(composition.steps[1].label, kind === 'tests' ? 'Write and run the tests' : 'Implement and test');
  }
  assert.deepEqual(intents(composeTask(base(), { kind: 'refactor' })), ['intake', 'plan', 'code', 'test']);
  assert.equal(composeTask(base(), { kind: 'refactor' }).sizing, undefined, 'a refactor keeps v1.1\'s composition');
  for (const kind of ['investigate', 'review', 'docs']) {
    const composition = composeTask(base(), { kind });
    assert.deepEqual(intents(composition), ['intake', 'design'], kind);
    assert.equal(taskShape(composition), 'analysis', kind);
  }
  // A team that sizes by kind keeps v1.1's steps.
  assert.deepEqual(intents(composeTask(base({ sizing: 'kind' }), { kind: 'fix' })), ['intake', 'code', 'test']);
  assert.equal(composeTask(base({ sizing: 'kind' }), { kind: 'fix' }).sizing, undefined);
  assert.throws(() => taskRules(base({ sizing: 'medium' })), /sizing is requirement/u);
  // The plan a person reads, the same every time, and the walk passes.
  const plan = await taskPlan(base(), { kind: 'fix' });
  assert.equal(plan.plan, 'Plan: requirement → implement and test → SFlow runs the tests. You approve the requirement and the code. Small or big is decided with the requirement. Say "add a design step" to change it.');
  assert.equal(plan.walk, 'completed');
  assert.deepEqual(plan.steps.map((step) => [step.id, step.approvedBy]), [['intake', 'person'], ['implementation', 'person'], ['verification', 'sflow']]);
  assert.deepEqual(await taskPlan(base(), { kind: 'fix' }), plan);
});

test('ITW REQ-102: the requirement asks only what the words leave open', () => {
  const composition = composeTask(base(), { kind: 'change' });
  const definition = validateDefinition(structuredClone(taskDefinition(base(), composition)));
  const intake = resolveWorkType(definition, composition.workType).phases.find((phase) => phase.id === 'intake');
  assert.equal(intake.clarification.mode, 'when-needed');
  // v1.1's composition still asks every time.
  const kept = composeTask(base({ sizing: 'kind' }), { kind: 'change' });
  const v11 = resolveWorkType(validateDefinition(structuredClone(taskDefinition(base({ sizing: 'kind' }), kept))), kept.workType);
  assert.equal(v11.phases.find((phase) => phase.id === 'intake').clarification.mode, 'required');
  assert.match(taskIntakeGuidance(composition), /Size: small change" or "Size: big change"/u);
  assert.match(taskIntakeGuidance(composeTask(base(), { kind: 'investigate' })), /## Follow-ups/u);
  assert.equal(taskIntakeGuidance(kept), null);
});

test('ITW REQ-105: a big change composes the spec, design when asked, plan, code and tests, the code named "Code"', async () => {
  const big = composeTask(base(), { kind: 'change', shape: 'big' });
  assert.deepEqual(intents(big), ['intake', 'requirements', 'plan', 'code', 'test']);
  assert.deepEqual(big.steps.map((step) => step.label), ['Requirement', 'Spec', 'Plan', 'Code', 'Tests']);
  assert.equal(taskShape(big), 'big');
  assert.deepEqual(intents(composeTask(base(), { kind: 'feature', shape: 'big', design: true })), ['intake', 'requirements', 'design', 'plan', 'code', 'test']);
  assert.equal(nextWords(big), 'spec, plan, code and tests');
  assert.equal(nextWords(composeTask(base(), { kind: 'fix' })), 'implement and test');
  assert.match(planLine(big, { approvals: { intake: 'person', 'implementation-spec': 'person', implementation: 'person' } }),
    /^Plan: requirement → spec → plan → code → tests\. You approve the requirement, the plan and the code\./u);
  assert.deepEqual(bigShapeStep({ id: 'implementation', intent: 'code', label: 'Implement and test' }, 'change').label, 'Code');
  assert.deepEqual(bigShapeStep({ id: 'implementation', intent: 'code', label: 'Write and run the tests' }, 'tests').label, 'Write the tests');
  assert.deepEqual(bigShapeStep({ id: 'design', intent: 'design', label: 'Design' }, 'change').label, 'Design');
});

test('ITW REQ-103: Copilot\'s proposal is read from the requirement', () => {
  assert.equal(proposedSize('## Analysis\n\nSize: small change, one file.'), 'small');
  assert.equal(proposedSize('- **Size:** Big change: three services'), 'big');
  assert.equal(proposedSize('## Size\n\nThis is a big change because the schema moves.\n\n## Risk\n\nsmall change'), 'big');
  assert.equal(proposedSize('## Size\n\nUnclear.\n\n## Risk\n\nA small change elsewhere.'), null);
  assert.equal(proposedSize('No size at all.'), null);
});

test('ITW REQ-103: the files a requirement names, the facts and the decision, the same way every time', () => {
  const tree = new Set(['src', 'src/value.mjs', 'src/auth', 'src/auth/login.mjs', 'db', 'db/migrations', 'test', 'test/value.test.mjs', 'web', 'web/components']);
  const exists = (file) => tree.has(file);
  const text = 'Change `src/value.mjs` and src/auth/login.mjs, add src/value-cache.mjs; see v1.2 and https://example.com/a.html; '
    + 'the test test/value.test.mjs; not singularity/work-items/TASK-1/x.md nor lib/missing.mjs.';
  assert.deepEqual(namedFiles(text, exists), ['src/value.mjs', 'src/auth/login.mjs', 'src/value-cache.mjs', 'test/value.test.mjs']);
  assert.equal(areaOf('src/auth/login.mjs'), 'src/auth');
  assert.equal(areaOf('README.md'), '.');
  const isTest = (file) => file.startsWith('test/');
  const growthOf = (files) => (files.some((file) => file.includes('migrations/')) ? { reasons: ['data'], files: files.filter((file) => file.includes('migrations/')), what: 'the data (db/migrations/1.sql)' } : null);
  const small = shapeFacts({ files: ['src/value.mjs', 'test/value.test.mjs'], isTest, growthOf });
  assert.equal(small.shape, 'small');
  assert.deepEqual(small.files, ['src/value.mjs']);
  // Over the limits, by files or by areas.
  const many = shapeFacts({ files: Array.from({ length: SMALL_LIMITS.files + 1 }, (_, index) => `src/f${index}.mjs`), isTest, growthOf });
  assert.equal(many.shape, 'big');
  assert.match(many.reasons[0], /^it names 6 files, more than a small change's 5 files in 2 areas$/u);
  assert.equal(shapeFacts({ files: ['a/x.mjs', 'b/y.mjs', 'c/z.mjs'], isTest, growthOf }).shape, 'big');
  // A migration, Copilot's big, a team rule that plans the files: big; SFlow never makes a big proposal small.
  assert.deepEqual(shapeFacts({ files: ['db/migrations/1.sql'], isTest, growthOf }).reasons, ['it changes the data (db/migrations/1.sql)']);
  const proposed = shapeFacts({ files: ['src/value.mjs'], proposed: 'big', isTest, growthOf });
  assert.deepEqual([proposed.shape, proposed.overruled], ['big', false]);
  const overruled = shapeFacts({ files: ['db/migrations/1.sql'], proposed: 'small', isTest, growthOf });
  assert.deepEqual([overruled.shape, overruled.overruled], ['big', true]);
  const rules = taskRules(base({ paths: [{ paths: ['src/auth/**'], steps: ['plan'], because: 'Sign-in changes are planned.' }] }));
  const ruled = shapeFacts({ files: ['src/auth/login.mjs'], rules, kind: 'fix', isTest, growthOf });
  assert.deepEqual([ruled.shape, ruled.reasons], ['big', ['the team\'s rule: Sign-in changes are planned']]);
  // Design for a big change with UI or architecture work; a small change never gains it.
  assert.equal(shapeFacts({ files: ['web/components/Value.tsx'], proposed: 'big', isTest, growthOf }).design, true);
  assert.equal(shapeFacts({ files: ['web/components/Value.tsx'], isTest, growthOf }).design, false);
  assert.equal(shapeFacts({ files: ['services/billing/index.mjs'], proposed: 'big', isTest, growthOf, newFolder: (file) => file.startsWith('services/') }).design, true);
  assert.equal(shapeFacts({ files: ['src/value.mjs'], proposed: 'big', isTest, growthOf }).design, false);
});

test('ITW REQ-103: the requirement\'s approval question says the shape and what comes next', () => {
  const small = composeTask(base(), { kind: 'fix' });
  const phase = { id: 'intake', generation: 1 };
  assert.equal(taskApprovalQuestion({ resolution: { composition: small } }, phase), 'Approve the requirement v1 · Small change: implement and test next?');
  const big = { ...composeTask(base(), { kind: 'change', shape: 'big' }), changes: [{ change: 'add', intent: 'requirements', shape: 'big', because: 'It names 7 files in 3 areas.' }] };
  assert.equal(taskApprovalQuestion({ resolution: { composition: big } }, phase),
    'Approve the requirement v1 · Big change: spec, plan, code and tests next (It names 7 files in 3 areas)?');
  assert.equal(taskApprovalQuestion({ resolution: { composition: small } }, { id: 'implementation', generation: 1 }), null);
  assert.equal(taskApprovalQuestion({ resolution: { composition: composeTask(base({ sizing: 'kind' }), { kind: 'fix' }) } }, phase), null);
});

test('ITW REQ-107: the team\'s rules add to the workflow a `use` rule picks; with nothing to add it runs exactly as it is', async () => {
  const plain = composeTask(base({ use: { fix: 'quick-fix' } }), { kind: 'fix' });
  assert.deepEqual([plain.workType, plain.uses, plain.steps.map((step) => step.id)], ['quick-fix', 'quick-fix', ['intake', 'implement', 'verify']]);
  const ruled = base({ use: { fix: 'quick-fix' }, always: [{ kinds: ['fix'], steps: ['review'], because: 'Every fix gets a conformance review.' }] });
  const composition = composeTask(ruled, { kind: 'fix' });
  assert.deepEqual([composition.workType, composition.uses, composition.local], ['task-fix', undefined, { workflow: 'quick-fix', label: ruled.workTypes['quick-fix'].label ?? 'quick-fix', by: 'use' }]);
  assert.deepEqual(composition.steps.map((step) => step.id), ['intake', 'implement', 'verify', 'conformance']);
  assert.deepEqual(composition.added, [{ intent: 'review', rule: 'always[0]', because: 'Every fix gets a conformance review.' }]);
  assert.match(composition.rules[0].because, /This team runs every fix task as the .* workflow\./u, 'the use rule still picks it');
  const plan = await taskPlan(ruled, { kind: 'fix' });
  assert.equal(plan.walk, 'completed');
  assert.match(plan.plan, /^Plan, from your team's workflow /u);
  // A paths rule for the files the task names adds its step too; one the workflow already has is not added twice.
  const paths = base({ use: { fix: 'quick-fix' }, paths: [{ paths: ['src/auth/**'], steps: ['test', 'review'], personApproves: ['test'], because: 'Sign-in changes are reviewed.' }] });
  const touched = composeTask(paths, { kind: 'fix', touchedPaths: ['src/auth/login.mjs'] });
  assert.deepEqual(touched.steps.map((step) => step.id), ['intake', 'implement', 'verify', 'conformance']);
  assert.deepEqual(touched.personApproves, ['test']);
  assert.equal(composeTask(paths, { kind: 'fix' }).uses, 'quick-fix', 'no file of the rule\'s: as it is');
});

test('ITW REQ-103: `work shape big` is the person\'s while the requirement waits for its Yes, and only then; a big change stays big', async (t) => {
  const story = await journeyRepository(t);
  const started = JSON.parse(story.cli('work', 'make the value module return 2', '--kind', 'change', '--start', '--json'));
  assert.equal((started.data ?? started).id, 'TASK-1');
  const refusedWith = (args) => {
    const ran = story.raw([...args, '--json']);
    assert.notEqual(ran.status, 0, `${args.join(' ')} should be refused`);
    const body = JSON.parse(ran.stdout.slice(ran.stdout.indexOf('{')));
    return body.error ?? body;
  };
  const early = refusedWith(['work', 'shape', 'big']);
  assert.equal(early.code, 'TASK_CHANGE_REFUSED');
  assert.match(early.message, /^TASK-1 is not a sized task whose requirement waits for its approval/u);
  assert.equal(early.details.nextAction.command ?? early.details.nextAction, 'singularity-flow work status TASK-1');
  const small = refusedWith(['work', 'shape', 'small']);
  assert.equal(small.details.nextAction.command ?? small.details.nextAction, 'singularity-flow work shape big --work-id TASK-1');
});

test('ITW REQ-113 (owner, 2026-11-28): each approval of a sized task says why the person is asked and what each answer does; a small requirement offers its big change beside the Yes', async () => {
  const { taskApprovalAlternatives, taskApprovalWhy } = await import('../src/task-shape.mjs');
  const { agentAct } = await import('../src/agent-output.mjs');
  const small = { workItem: { id: 'TASK-1' }, resolution: { composition: composeTask(base(), { kind: 'fix' }) } };
  const intake = { id: 'intake', generation: 1 };
  assert.equal(taskApprovalWhy(small, intake), 'You decide what gets built: the requirement says it, clause by clause, with how each is tested. Yes: implement and test start. Make it a big change: a spec and a plan come first. Not now: the requirement waits; /sf-task brings it back.');
  assert.equal(taskApprovalWhy(small, { id: 'implementation', generation: 1 }), 'You decide whether this code goes in: it changes the repository. Yes: SFlow runs the tests itself and approves the tests step when they pass. Not now: the code waits; /sf-task brings it back.');
  assert.equal(taskApprovalWhy(small, { id: 'verification', generation: 1 }), null, 'SFlow\'s own tests step asks nobody');
  assert.deepEqual(taskApprovalAlternatives(small, intake), [{ label: 'Make it a big change', command: 'singularity-flow work shape big --work-id TASK-1 --json',
    does: 'adds a spec and a plan before the code, and the requirement asks for your Yes again' }]);
  const big = { workItem: { id: 'TASK-1' }, resolution: { composition: composeTask(base(), { kind: 'change', shape: 'big' }) } };
  assert.deepEqual(taskApprovalAlternatives(big, intake), [], 'a big change stays big');
  assert.equal(taskApprovalWhy(big, { id: 'implementation-spec', generation: 1 }), 'You decide how the code will be written: the plan names the files and the tests for each clause. Yes: the code is written to it. Not now: the plan waits; /sf-task brings it back.');
  assert.equal(taskApprovalWhy({ resolution: { composition: composeTask(base({ sizing: 'kind' }), { kind: 'fix' }) } }, intake), null, 'a Story composed before v1.2 asks as before');
  // The chat's question carries the line and the other answer, with the command it runs; the Yes stays the first choice.
  const act = agentAct({ approvalPacket: {}, approvalContext: { phase: 'intake' }, ready: true, workId: 'TASK-1', onYes: { command: 'singularity-flow choices answer x' },
    choiceSets: [{ id: 'phase-confirmation', question: 'Approve the requirement v1 · Small change: implement and test next?', why: taskApprovalWhy(small, intake),
      alternatives: taskApprovalAlternatives(small, intake) }] });
  assert.equal(act.ask.why, taskApprovalWhy(small, intake));
  assert.deepEqual(act.ask.choices, [{ label: 'Approve the requirement v1 · Small change: implement and test next' },
    { label: 'Make it a big change', command: 'singularity-flow work shape big --work-id TASK-1 --json' }, { label: 'Not now' }]);
  assert.match(act.ask.how, /Say ask\.why in one line before the question\. On a choice with a command, run that command, say its words, and begin this approval again\.$/u);
});

test('ITW REQ-113 (coordinator, 2026-11-28): a step a team\'s rules give a person says the reasons of the rules that gave it, each once on one line, never another rule\'s', async () => {
  const { taskApprovalWhy } = await import('../src/task-shape.mjs');
  const tasks = {
    always: [{ kinds: ['fix'], personApproves: ['test'], because: 'A person reads every fix\'s test results.' }, { kinds: ['fix'], personApproves: ['code'], because: 'A person reads every fix.' }],
    paths: [{ paths: ['src/billing/**'], personApproves: ['code'], because: 'Billing code is read by a person.' }] };
  const definition = base(tasks);
  const composition = composeTask(definition, { kind: 'fix', touchedPaths: ['src/billing/total.mjs'] });
  assert.deepEqual(composition.approvalRules, [
    { intent: 'test', rule: 'always[0]', because: 'A person reads every fix\'s test results.' },
    { intent: 'code', rule: 'always[1]', because: 'A person reads every fix.' },
    { intent: 'code', rule: 'paths[0]', because: 'Billing code is read by a person.' }]);
  const workflow = { workItem: { id: 'TASK-1' }, resolution: { composition } };
  assert.equal(taskApprovalWhy(workflow, { id: 'implementation', generation: 1 }), 'You decide whether this code goes in: it changes the repository. Yes: SFlow runs the tests itself and approves the tests step when they pass. Not now: the code waits; /sf-task brings it back. Also, the team\'s rules ask: A person reads every fix; Billing code is read by a person.');
  assert.equal(taskApprovalWhy(workflow, { id: 'verification', generation: 1 }), 'You approve the tests because the team\'s rule asks: A person reads every fix\'s test results. Yes: the task goes on. Not now: the tests wait; /sf-task brings them back.');
  // The step's pinned reason is its own rules' too, not the first rule's.
  const pinned = taskDefinition(definition, composition).workTypes['task-fix'].phaseOverrides;
  assert.equal(pinned.implementation.because['approval.automatic'], 'A person reads every fix. Billing code is read by a person.');
  assert.equal(pinned.verification.because['approval.automatic'], 'A person reads every fix\'s test results.');
  // Without the paths rule's files, only the rule that gave it.
  const plain = { workItem: { id: 'TASK-1' }, resolution: { composition: composeTask(definition, { kind: 'fix' }) } };
  assert.match(taskApprovalWhy(plain, { id: 'implementation', generation: 1 }), / Also, the team's rule asks: A person reads every fix\.$/u);
  // A composition recorded before it kept the reasons names no rule it cannot tell gave the step.
  const { approvalRules: _kept, ...older } = composition;
  assert.match(taskApprovalWhy({ resolution: { composition: older } }, { id: 'implementation', generation: 1 }), / Also, the team's task rules give it to you\.$/u);
  assert.equal(taskDefinition(definition, older).workTypes['task-fix'].phaseOverrides.verification.because['approval.automatic'], 'A person reads every fix\'s test results.',
    'a Story recorded before keeps its pinned words');
  // No rule, no field: the composition is as before.
  assert.equal(Object.hasOwn(composeTask(base(), { kind: 'fix' }), 'approvalRules'), false);
});

test('ITW REQ-113 (coordinator, 2026-11-28): a refactor\'s plan and code say what the person decides (behaviour kept, checked before and after) and what Yes does; Not now names what waits', async () => {
  const { taskApprovalWhy } = await import('../src/task-shape.mjs');
  const refactor = { workItem: { id: 'TASK-1' }, resolution: { composition: composeTask(base(), { kind: 'refactor' }) } };
  assert.equal(taskApprovalWhy(refactor, { id: 'implementation-spec', generation: 1 }), 'You decide what must not change: the plan names the behaviour this refactor keeps and the checks that show it. Yes: the code is changed to it, and SFlow checks that what passed on the base before any edit still passes. Not now: the plan waits; /sf-task brings it back.');
  assert.equal(taskApprovalWhy(refactor, { id: 'implementation', generation: 1 }), 'You decide whether this refactor goes in: what passed on the base before any edit still passes on it, so its behaviour stays the same. Yes: SFlow runs the tests again at the tests step and approves it when they pass. Not now: the code waits; /sf-task brings it back.');
  assert.equal(taskApprovalWhy(refactor, { id: 'intake', generation: 1 }), null, 'its intake is SFlow\'s to approve');
  // A Story of another kind composed before v1.2 keeps its approval's own words.
  assert.equal(taskApprovalWhy({ resolution: { composition: composeTask(base({ sizing: 'kind' }), { kind: 'change' }) } }, { id: 'implementation-spec', generation: 1 }), null);
});
