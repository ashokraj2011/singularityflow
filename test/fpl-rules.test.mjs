// FPL M3, the Rules place (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.4, REQ-019 to REQ-026, A11 to A15): the team's task rules in
// plain when and then, the tasks.* Studio operations, the check every way of changing them runs, the preview of what a
// change adds, stable rule IDs, and tasks in flight keeping the rules they started with.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { checkTaskRules, composeTask, definitionForStory, taskDefinition, taskRules, TASK_KINDS } from '../src/task-composition.mjs';
import {
  applyTaskRuleChange, BUILT_IN_RULES, findTaskRule, inFlightOf, previewRuleChanges, ruleChangeLines, ruleForm, ruleSlug, ruleViews, rulesText,
  samplePath, taskRuleChecks, taskRulesChange
} from '../src/task-rules.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8');
const BASE = YAML.parse(TEMPLATE);
const withTasks = (tasks) => ({ ...structuredClone(BASE), tasks });
const intents = (composition) => composition.steps.map((step) => step.intent);

const RULES = {
  idPrefix: 'TASK',
  always: [{ kinds: ['feature'], steps: ['review'], because: 'Every feature gets a conformance review.' }],
  paths: [{ id: 'sign-in-review', paths: ['src/auth/**'], steps: ['review'], personApproves: ['test'], because: 'Changes to sign-in are reviewed.' }],
  use: { change: 'classic-delivery' }
};

test('A11: the built-in rules are fixed, and every tasks: rule reads as when and then with its because', () => {
  assert.deepEqual(BUILT_IN_RULES.map((rule) => [rule.builtIn, rule.words]), [
    [true, 'When any code changes: add tests.'],
    [true, 'When a task changes code: a person approves the code.'],
    [true, 'When a task has a plan: a person approves the plan.']]);
  const views = ruleViews(RULES, { labelOf: (id) => BASE.workTypes[id]?.label ?? id });
  assert.deepEqual(views.map((view) => [view.id, view.words, view.because]), [
    ['always[0]', 'When a task is a feature: add a review.', 'Every feature gets a conformance review.'],
    ['sign-in-review', 'When a task touches src/auth/**: add a review, and a person approves the test results.', 'Changes to sign-in are reviewed.'],
    ['use.change', `When a task is a change: follow the workflow ${BASE.workTypes['classic-delivery'].label}.`,
      `This team runs every change task as the ${BASE.workTypes['classic-delivery'].label} workflow.`]]);
  assert.deepEqual(ruleViews({ always: [{ because: 'All code is linted.' }] })[0].when, 'any code changes');
  assert.equal(ruleViews({ paths: [{ kinds: ['fix', 'change'], paths: ['src/billing/**'], steps: ['review'], because: 'b' }] })[0].when,
    'a fix or a change touches src/billing/**');
  // The form offers only what taskRules accepts: the nine kinds, five steps, the seven approvals and this repository's workflows.
  const form = ruleForm(BASE);
  assert.deepEqual(form.kinds.map((entry) => entry.id), TASK_KINDS);
  assert.deepEqual(form.steps.map((entry) => entry.id), ['requirements', 'design', 'plan', 'review', 'test']);
  assert.ok(form.workflows.some((entry) => entry.id === 'classic-delivery') && form.workflows.every((entry) => !entry.id.startsWith('task-')));
});

test('REQ-023: taskRules collects every problem with its field, not only the first', () => {
  const { problems, rules } = checkTaskRules(withTasks({
    idPrefix: 'task-1', always: [{ steps: ['deploy'] }, { kinds: ['feature'], steps: ['review'], because: 'Fine.' }],
    paths: [{ steps: ['review'], because: 'No files.' }], use: { release: 'classic-delivery', fix: 'nowhere' }
  }));
  assert.deepEqual(problems.map((problem) => problem.field), ['tasks.idPrefix', 'tasks.always[0].steps', 'tasks.always[0].because',
    'tasks.paths[0].paths', 'tasks.use.release', 'tasks.use.fix']);
  assert.equal(rules.always.length, 1, 'the valid rule beside them still holds');
  assert.throws(() => taskRules(withTasks({ always: [{ steps: ['deploy'] }] })), (error) => error.code === 'TASK_RULES_INVALID'
    && /names 'deploy'.*and 1 more: tasks\.always\[0\]\.because/su.test(error.message) && error.details.problems.length === 2
    && error.details.nextAction.command === 'singularity-flow rules');
  // A rule whose kinds name none applies to no task: named at its field.
  assert.deepEqual(checkTaskRules(withTasks({ always: [{ kinds: [], steps: ['review'], because: 'Reviewed.' }] })).problems.map((problem) => problem.field),
    ['tasks.always[0].kinds']);
  // Two rules with one ID: the second is named.
  assert.deepEqual(checkTaskRules(withTasks({ always: [{ id: 'same', because: 'a' }], paths: [{ id: 'same', paths: ['x/**'], because: 'b' }] })).problems
    .map((problem) => problem.field), ['tasks.paths[0].id']);
});

test('REQ-024: a rule with an id is named by it in the Story\'s composition; one without keeps its place\'s name', () => {
  const definition = withTasks(RULES);
  const touched = composeTask(definition, { kind: 'fix', touchedPaths: ['src/auth/login.js'] });
  assert.deepEqual(touched.added, [{ intent: 'review', rule: 'sign-in-review', because: 'Changes to sign-in are reviewed.' }]);
  assert.deepEqual(composeTask(definition, { kind: 'feature' }).rules, [{ rule: 'always[0]', because: 'Every feature gets a conformance review.' }]);
  // A use rule the Rules place wrote carries its own id and because.
  const used = withTasks({ use: { change: { workflow: 'classic-delivery', because: 'Changes ship the classic way.', id: 'change-classic' } } });
  assert.deepEqual(composeTask(used, { kind: 'change' }).rules, [{ rule: 'change-classic', because: 'Changes ship the classic way.' }]);
  assert.equal(composeTask(used, { kind: 'change' }).workType, 'classic-delivery');
});

test('REQ-022, REQ-024: the tasks.* operations write workflow.yml in place, keep its formatting, and give a rule an id', () => {
  const text = `version: 4\n# the team's file\nworkTypes:\n  classic-delivery: { label: Classic delivery, phases: [intake] }\ntasks:\n  idPrefix: TASK # our prefix\n  always:\n    - kinds: [feature]\n      steps: [review]\n      because: Every feature gets a conformance review.\n`;
  const document = YAML.parseDocument(text);
  const summary = applyTaskRuleChange(document, { op: 'tasks.rule.add', rule: { kinds: ['fix', 'change'], paths: ['src/billing/**'], steps: ['review'],
    because: 'Billing changes are reviewed.' } });
  assert.match(summary, /^Rule fix-change-touching-src-billing-adds-review added: when a fix or a change touches src\/billing\/\*\*, add a review\.$/u);
  applyTaskRuleChange(document, { op: 'tasks.rule.add', rule: { kinds: ['change'], workflow: 'classic-delivery', because: 'Changes ship the classic way.' } },
    { labelOf: () => 'Classic delivery' });
  applyTaskRuleChange(document, { op: 'tasks.idPrefix.set', idPrefix: 'FIX' });
  const written = document.toString();
  assert.match(written, /^# the team's file$/mu, 'a comment stays');
  assert.match(written, /idPrefix: FIX # our prefix/u, 'the prefix is changed where it is');
  assert.match(written, /  paths:\n    - id: fix-change-touching-src-billing-adds-review\n      kinds: \[ fix, change \]\n      paths: \[ src\/billing\/\*\* \]\n      steps: \[ review \]\n      because: Billing changes are reviewed\./u);
  assert.match(written, /  use:\n    change:\n      workflow: classic-delivery\n      because: Changes ship the classic way\.\n      id: change-follows-classic-delivery/u);
  // Change keeps the id; a rule found by its place gets one; remove takes the section away when it is the last.
  const tasks = () => document.toJS().tasks;
  applyTaskRuleChange(document, { op: 'tasks.rule.change', id: 'fix-change-touching-src-billing-adds-review',
    rule: { kinds: ['fix'], paths: ['src/billing/**'], steps: ['review'], personApproves: ['code'], because: 'Billing fixes are reviewed.' } });
  assert.deepEqual(tasks().paths[0], { id: 'fix-change-touching-src-billing-adds-review', kinds: ['fix'], paths: ['src/billing/**'], steps: ['review'],
    personApproves: ['code'], because: 'Billing fixes are reviewed.' });
  applyTaskRuleChange(document, { op: 'tasks.rule.change', id: 'always[0]', rule: { kinds: ['feature'], steps: ['review', 'design'], because: 'Features are designed and reviewed.' } });
  assert.equal(tasks().always[0].id, 'feature-adds-review-design');
  applyTaskRuleChange(document, { op: 'tasks.rule.remove', id: 'change-follows-classic-delivery' });
  assert.equal(tasks().use, undefined);
  assert.throws(() => applyTaskRuleChange(document, { op: 'tasks.rule.remove', id: 'nowhere' }), (error) => error.code === 'TASK_RULE_UNKNOWN'
    && error.details.nextAction.command === 'singularity-flow rules');
  assert.throws(() => applyTaskRuleChange(document, { op: 'tasks.rule.add', rule: { kinds: ['fix', 'change'], workflow: 'classic-delivery', because: 'x' } }),
    (error) => error.code === 'TASK_RULE_CHANGE_INVALID' && /one kind of task/u.test(error.message));
  assert.equal(findTaskRule(tasks(), 'paths[0]').entry.id, 'fix-change-touching-src-billing-adds-review');
  assert.equal(ruleSlug({ kinds: ['all'], paths: [], steps: ['review'], personApproves: [], workflow: null }, new Set(['adds-review'])), 'adds-review-2');
  // A task in a fresh file: the section is made.
  const fresh = YAML.parseDocument('version: 4\n');
  applyTaskRuleChange(fresh, { op: 'tasks.rule.add', rule: { steps: ['review'], because: 'Every change is reviewed.' } });
  assert.deepEqual(fresh.toJS().tasks, { always: [{ id: 'adds-review', steps: ['review'], because: 'Every change is reviewed.' }] });
});

test('A13: a broken rule a change adds is refused with every problem and its field; an untouched broken one is a warning', () => {
  const broken = { always: [{ steps: ['deploy'] }] };
  const before = withTasks(broken);
  // A change that adds a valid rule beside the old broken one: the old one is a warning.
  const added = withTasks({ ...broken, paths: [{ paths: ['src/billing/**'], steps: ['review'], because: 'Billing is reviewed.' }] });
  assert.deepEqual(taskRuleChecks(before, added), { refused: [], warnings: [
    { code: 'TASK_RULE_INVALID', field: 'tasks.always[0].steps', message: 'always[0] steps names \'deploy\'; a step is one of intake, requirements, design, plan, code, test, review.' },
    { code: 'TASK_RULE_INVALID', field: 'tasks.always[0].because', message: 'always[0] needs a because: the team\'s reason, shown when the rule adds a step.' }] });
  // A change that adds a broken rule: every one of its problems, each with its field.
  const bad = withTasks({ paths: [{ paths: [], steps: ['deploy'] }] });
  assert.deepEqual(taskRuleChecks(withTasks(undefined), bad).refused.map((problem) => problem.field),
    ['tasks.paths[0].steps', 'tasks.paths[0].because', 'tasks.paths[0].paths']);
  // A change that removes the workflow a use rule names brings the problem, so it is refused though the rule is untouched.
  const used = withTasks({ use: { change: 'classic-delivery' } });
  const removed = structuredClone(used);
  delete removed.workTypes['classic-delivery'];
  assert.deepEqual(taskRuleChecks(used, removed).refused.map((problem) => problem.field), ['tasks.use.change']);
  // Removing an earlier rule moves a broken one's place: it is still the same rule, and still only a warning.
  const two = withTasks({ always: [{ because: 'Fine.' }, { steps: ['deploy'], because: 'Broken.' }] });
  assert.deepEqual(taskRuleChecks(two, withTasks({ always: [{ steps: ['deploy'], because: 'Broken.' }] })).refused, []);
});

test('A12, REQ-021: the preview shows fix and change tasks touching src/billing gaining the review, and no other kind changing', async () => {
  const definition = structuredClone(BASE);
  const preview = await previewRuleChanges(definition, TEMPLATE, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'tasks.rule.add', rule: { kinds: ['fix', 'change'], paths: ['src/billing/**'], steps: ['review'], because: 'Billing changes are reviewed.' } }] });
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  assert.deepEqual(preview.lines.map((line) => [line.kind, line.touching, line.added]), [
    ['fix', 'src/billing/x.ts', ['Conformance review']], ['change', 'src/billing/x.ts', ['Conformance review']]]);
  assert.match(preview.lines[0].words, /^A fix touching src\/billing\/x\.ts: Intake → Code → Tests → Conformance review \(added\)\. You approve /u);
  assert.equal(preview.others, 'No other kind changes.');
  // A broken rule: refused before any proposal, with each problem and its field, and no lines.
  const refused = await previewRuleChanges(definition, TEMPLATE, { schema: 'sflow-studio-change-set@1', changes: [
    { op: 'tasks.rule.add', rule: { kinds: ['fix'], steps: ['deploy'], because: '' } }] });
  assert.equal(refused.valid, false);
  assert.deepEqual(refused.problems.map((problem) => problem.field), ['tasks.always[0].steps', 'tasks.always[0].because']);
  assert.deepEqual(refused.lines, []);
  // Only the tasks.* operations: anything else is Workflow Studio's to preview.
  const other = await previewRuleChanges(definition, TEMPLATE, { changes: [{ op: 'phase.update', id: 'design' }] });
  assert.match(other.problems[0].message, /takes only tasks\.rule\.add/u);
  assert.equal(samplePath('db/migrations/*.sql'), 'db/migrations/x.sql');
  assert.equal(samplePath('**/*.proto'), 'x.proto');
});

test('A14: a rule\'s addition adds and never removes a step, for every kind and rule; removing one names each step it stops adding', async () => {
  const fixture = [
    { steps: ['review'], because: 'a' }, { kinds: ['feature'], steps: ['design'], because: 'b' }, { kinds: ['fix'], personApproves: ['test'], because: 'c' },
    { kinds: ['all'], steps: ['requirements'], because: 'd' }, { kinds: ['docs'], steps: ['review'], because: 'e' }
  ];
  const pathRules = [{ paths: ['src/auth/**'], steps: ['plan', 'review'], because: 'f' }, { kinds: ['refactor'], paths: ['db/**'], steps: ['design'], because: 'g' }];
  for (const kind of TASK_KINDS) {
    for (const touchedPaths of [[], ['src/auth/a.js'], ['db/schema.sql']]) {
      const plain = intents(composeTask(withTasks(undefined), { kind, touchedPaths }));
      for (const rule of fixture) {
        const ruled = intents(composeTask(withTasks({ always: [rule] }), { kind, touchedPaths }));
        assert.ok(plain.every((intent) => ruled.includes(intent)), `${kind} ${JSON.stringify(rule)} took a step out`);
      }
      for (const rule of pathRules) {
        const ruled = intents(composeTask(withTasks({ paths: [rule] }), { kind, touchedPaths }));
        assert.ok(plain.every((intent) => ruled.includes(intent)), `${kind} ${JSON.stringify(rule)} took a step out`);
      }
    }
  }
  // Removing a rule: its proposal's preview names each step it stops adding.
  const definition = withTasks({ paths: [{ id: 'sign-in-review', paths: ['src/auth/**'], steps: ['review'], because: 'Sign-in is reviewed.' }] });
  const lines = await ruleChangeLines(definition, undefined);
  assert.deepEqual(lines.map((line) => [line.kind, line.removed]), ['fix', 'feature', 'change', 'refactor', 'tests', 'chore']
    .map((kind) => [kind, ['Conformance review']]), 'every kind with code, touching src/auth');
  assert.match(lines[0].words, /No longer adds Conformance review\.$/u);
});

test('A15, REQ-025: tasks in flight keep the rules they started with; the page says how many', () => {
  const started = withTasks({ paths: [{ paths: ['src/auth/**'], steps: ['review'], because: 'Sign-in is reviewed.' }] });
  const composition = composeTask(started, { kind: 'fix', touchedPaths: ['src/auth/login.js'] });
  const workflow = { resolution: { composition } };
  // The rule changes after the task started: the task's own workflow is still the one it started with.
  const changed = withTasks({ always: [{ steps: ['design'], because: 'Every task is designed.' }] });
  const own = definitionForStory(changed, workflow).workTypes[composition.workType];
  assert.deepEqual(own.phases, composition.steps.map((step) => step.id));
  assert.deepEqual(taskDefinition(changed, composition).workTypes['task-fix'].phases, ['intake', 'implementation', 'verification', 'conformance']);
  assert.deepEqual(inFlightOf([{ status: 'in_progress', workType: 'task-fix' }, { status: 'in_progress', workType: 'task-change' },
    { status: 'closed', workType: 'task-fix' }, { status: 'in_progress', workType: 'feature' }]),
  { count: 2, words: '2 tasks in flight keep the rules they started with; a change applies to tasks started after it is approved.' });
  assert.equal(inFlightOf([]).words, null);
});

test('REQ-019, REQ-026: a proposal\'s change to the rules reads as what it adds, changes and removes; lessons are guidance, not rules', () => {
  const before = withTasks({ always: [{ id: 'feature-review', kinds: ['feature'], steps: ['review'], because: 'Features are reviewed.' }] });
  const after = withTasks({ idPrefix: 'FIX', always: [{ id: 'feature-review', kinds: ['feature'], steps: ['review', 'design'], because: 'Features are reviewed.' }],
    paths: [{ id: 'billing', paths: ['src/billing/**'], steps: ['review'], because: 'Billing is reviewed.' }] });
  assert.deepEqual(taskRulesChange(before, after), { changes: [
    { change: 'changed', id: 'feature-review', words: 'When a task is a feature: add a review and a design step.', because: 'Features are reviewed.' },
    { change: 'added', id: 'billing', words: 'When a task touches src/billing/**: add a review.', because: 'Billing is reviewed.' }],
  idPrefix: { before: 'TASK', after: 'FIX' } });
  assert.equal(taskRulesChange(before, before), null);
  // The terminal's words: built in first, then the team's, the ID prefix, each kind's steps, and the guidance line.
  const text = rulesText({ builtIn: BUILT_IN_RULES, rules: ruleViews(RULES), waiting: [{ words: 'Waiting for review, proposed by Builder.', branch: 'sflow/config-change/workflow/x',
    lines: ['Adds: When a task touches src/billing/**: add a review.'] }], idPrefix: { words: 'Tasks are named TASK-<n>.' },
  compose: [{ words: 'A fix: Intake → Code → Tests' }], workflows: { words: 'For work a team must always do one way, use a workflow: Workflow Studio, under Advanced.' },
  guidance: { words: 'Guidance the agents read: 3 lessons.', command: 'singularity-flow lessons' }, inFlight: null, problems: [], lines: [] });
  assert.match(text, /^Built in \(SFlow keeps these for every task\)\n  When any code changes: add tests\./u);
  assert.match(text, /Waiting for review\n  Waiting for review, proposed by Builder\. \(sflow\/config-change\/workflow\/x\)\n    Adds: When a task touches src\/billing\/\*\*: add a review\./u);
  assert.match(text, /Guidance the agents read: 3 lessons\. \(singularity-flow lessons\)/u);
  assert.match(text, /singularity-flow configuration save singularity\/workflow\.yml --propose < singularity\/workflow\.yml/u, 'a complete command, nothing to compose');
});

// ---------------------------------------------------------------------- the reviewed path, through the CLI

const cli = path.join(ROOT, 'bin/singularity-flow.mjs');
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test('A12, A13, A15 through the CLI: a rule is proposed, waits for review, lands once approved; broken ones are refused at every door',
  slowLane({ timeout: 900_000 }), async (t) => {
    const [{ initializeDefinition }, { isolatedTestEnvironment }, { childTimeout }] = await Promise.all([import('../src/config.mjs'),
      import('../scripts/test-machine-state.mjs'), import('./helpers/child-timeout.mjs')]);
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-fpl-rules-')));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Rule Author', SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Rule Author', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'rule.author@example.invalid' };
    const flow = (cwd, args, status = 0, input = undefined) => {
      const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, input, encoding: 'utf8', timeout: childTimeout(240_000), maxBuffer: 64 * 1024 * 1024 });
      if (status !== null) assert.equal(result.status, status, `singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
      return result;
    };
    const seed = path.join(base, 'seed'); const remote = path.join(base, 'remote.git'); const checkout = path.join(base, 'laptop');
    await mkdir(seed);
    git(seed, 'init', '-q', '-b', 'main');
    await writeFile(path.join(seed, 'README.md'), '# Rules\n');
    await initializeDefinition(seed);
    // The approved configuration already holds a broken rule: an untouched problem, a warning for every later change.
    const workflowFile = path.join(seed, 'singularity/workflow.yml');
    await writeFile(workflowFile, `${await readFile(workflowFile, 'utf8')}\ntasks:\n  idPrefix: TASK\n  always:\n    - kinds: [feature]\n      steps: [deploy]\n      because: Features are deployed.\n`);
    git(seed, 'add', '.');
    git(seed, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
    git(base, 'clone', '-q', '--bare', seed, remote);
    flow(base, ['bootstrap', remote, '--capability', 'rules', '--into', checkout]);

    // A11: the read, offline: the built-in rules, the team's rule with its problem, the prefix, and each kind's steps.
    const read = JSON.parse(flow(checkout, ['rules', '--offline', '--json']).stdout);
    assert.equal(read.resultType, 'sflow-rules');
    assert.equal(read.builtIn.length, 3);
    assert.deepEqual(read.rules.map((rule) => [rule.id, rule.words, rule.problems.map((problem) => problem.field)]),
      [['always[0]', 'When a task is a feature: add deploy.', ['tasks.always[0].steps']]]);
    assert.equal(read.idPrefix.words, 'Tasks are named TASK-<n>.');
    assert.equal(read.compose.find((entry) => entry.kind === 'fix').words, 'A fix: Intake → Code → Tests');
    assert.match(flow(checkout, ['rules', '--offline']).stdout, /^Built in \(SFlow keeps these for every task\)/u);
    // A13: workflow check reports the broken rule at its line; today it did not.
    const check = JSON.parse(flow(checkout, ['workflow', 'check', '--json']).stdout);
    const finding = check.repository.findings.find((entry) => entry.code === 'CHECK_TASK_RULE_INVALID');
    assert.ok(finding, 'workflow check reports a broken tasks: rule');
    assert.equal(finding.subject.field, 'tasks.always[0].steps');
    assert.ok(finding.location?.line > 0);

    // A12: the preview first, then one Studio change set and one proposal; sflow/config does not change before approval.
    // The page proposes on what its online read saw (offline is what this clone last fetched).
    const online = JSON.parse(flow(checkout, ['rules', '--json']).stdout);
    const add = { schema: 'sflow-studio-change-set@1', base: online.base, changes: [{ op: 'tasks.rule.add',
      rule: { kinds: ['fix', 'change'], paths: ['src/billing/**'], steps: ['review'], because: 'Billing changes are reviewed.' } }] };
    const preview = JSON.parse(flow(checkout, ['rules', 'preview', '--change-set', '-', '--json'], 0, JSON.stringify(add)).stdout);
    assert.deepEqual(preview.lines.map((line) => line.kind), ['fix', 'change']);
    assert.equal(preview.warnings[0].field, 'tasks.always[0].steps', 'the broken rule already there is a warning, not a refusal');
    const approvedBefore = git(remote, 'rev-parse', 'sflow/config');
    const proposed = JSON.parse(flow(checkout, ['workflow', 'studio', 'apply', '--change-set', '-', '--propose', '--json'], 0, JSON.stringify(add)).stdout);
    assert.ok(proposed.branch?.startsWith('sflow/config-change/workflow/'), JSON.stringify(proposed));
    assert.equal(git(remote, 'rev-parse', 'sflow/config'), approvedBefore, 'nothing lands before approval');
    assert.doesNotMatch(git(remote, 'show', 'sflow/config:singularity/workflow.yml'), /Billing changes are reviewed/u);
    assert.match(git(remote, 'show', `${proposed.branch}:singularity/workflow.yml`), /id: fix-change-touching-src-billing-adds-review\n\s+kinds: \[ ?fix, change ?\]/u);
    // Waiting for review, with who proposed it.
    const waiting = JSON.parse(flow(checkout, ['rules', '--json']).stdout);
    assert.deepEqual(waiting.waiting.map((entry) => [entry.branch, entry.proposer, entry.lines]), [[proposed.branch, 'Rule Author',
      ['Adds: When a fix or a change touches src/billing/**: add a review.']]]);

    // A13: a broken rule is refused before any proposal, with every problem and its field.
    const broken = flow(checkout, ['workflow', 'studio', 'apply', '--change-set', '-', '--propose', '--json'], null, JSON.stringify({ ...add,
      changes: [{ op: 'tasks.rule.add', rule: { kinds: ['fix'], paths: ['src/**'], steps: ['deploy'], because: '' } }] }));
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr + broken.stdout, /task rules would have 2 problems:\s+- paths\[0\] steps names 'deploy'.*\(tasks\.paths\[0\]\.steps\)\s+- paths\[0\] needs a because.*\(tasks\.paths\[0\]\.because\)/su);
    // And at a configuration save.
    const yaml = git(remote, 'show', 'sflow/config:singularity/workflow.yml').replace('tasks:\n  idPrefix: TASK', 'tasks:\n  idPrefix: TASK\n  paths:\n    - paths: [src/**]\n      steps: [deploy]');
    const saved = flow(checkout, ['configuration', 'save', 'singularity/workflow.yml', '--propose', '--json'], null, `${yaml}\n`);
    assert.notEqual(saved.status, 0);
    assert.match(saved.stderr + saved.stdout, /CONFIGURATION_SAVE_TASK_RULES_INVALID|task rules would have 2 problems/u);

    // A15: once approved, the rule applies; the read says it. An approval names the revision its approver was shown: approve
    // shows it and approves nothing, then --yes approves exactly that revision.
    flow(checkout, ['configuration', 'approve'], 1);
    flow(checkout, ['configuration', 'approve', '--yes']);
    const after = JSON.parse(flow(checkout, ['rules', '--json']).stdout);
    assert.ok(after.rules.some((rule) => rule.id === 'fix-change-touching-src-billing-adds-review'));
    assert.deepEqual(after.waiting, []);

    // A13 at approval: a proposal made by hand that breaks a rule is refused by configuration approve, with each problem and
    // its field, and the way on (reject it with that reason).
    const hand = path.join(base, 'by-hand');
    git(base, 'clone', '-q', remote, hand);
    git(hand, 'switch', '-q', '-c', 'sflow/config-change/workflow/broken-rule', 'origin/sflow/config');
    const handFile = path.join(hand, 'singularity/workflow.yml');
    await writeFile(handFile, (await readFile(handFile, 'utf8')).replace('id: fix-change-touching-src-billing-adds-review', 'id: fix-change-touching-src-billing-adds-review\n      personApproves: [deploy]'));
    git(hand, '-c', 'user.name=Rule Author', '-c', 'user.email=rule.author@example.invalid', 'commit', '-qam', 'a rule by hand');
    git(hand, 'push', '-q', 'origin', 'sflow/config-change/workflow/broken-rule');
    flow(checkout, ['configuration', 'approve'], 1);
    const refused = flow(checkout, ['configuration', 'approve', '--yes'], null);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /would give the team's task rules a problem\. Nothing was changed\.\s+- paths\[0\] personApproves names 'deploy'.*\(tasks\.paths\[0\]\.personApproves\)/su);
    // Its one way on: reject it with that reason (the reject command, behind a short confirmation code).
    assert.match(refused.stderr + refused.stdout, /1\. Reject it with that reason, so its proposer fixes the rules\n\s+- Copilot: \/sf-confirm [A-Z0-9-]+\n\s+- Shell: singularity-flow confirm [A-Z0-9-]+/u);
    assert.doesNotMatch(git(remote, 'show', 'sflow/config:singularity/workflow.yml'), /personApproves: \[deploy\]/u);
  });
