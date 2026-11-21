/**
 * Step intents Stage 3 in the Workflow Builder: a new step says what it does, a proposal never goes against what a
 * step's structure says for certain, and the workflow finishes only once the person confirmed what each step is for on
 * one screen (the intents table, its one question and its confirm code), which writes every intent and version 4.
 */
import { repositoryOwnedWorkflows, requirementsTemplatePlansCode } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import { intentTable } from '../src/step-intent-table.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-build-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Build Tester', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(state, 'outbox') };
  const run = (command, args, cwd, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
    if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);
  const json = (cwd, args, options) => JSON.parse(flow(cwd, [...args, '--json'], options).stdout);
  const engineEnv = { env: { ...process.env, SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: env.SINGULARITY_FLOW_WORKFLOW_BUILD_STATE } };
  return { run, flow, json, engineEnv };
}

async function repository(run, flow) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-build-repo-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Build Tester'], root); run('git', ['config', 'user.email', 'build@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Build\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  await requirementsTemplatePlansCode(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('the intents table: certain rows, Copilot\'s proposal, the one question when they disagree, and the rules\' two ways', () => {
  const definition = {
    version: 3,
    approvalAuthorities: { 'engineering-reviewers': {}, 'quality-reviewers': {} },
    phases: {
      'build-it': { label: 'Build it', artifact: { path: 'a/b.md' }, generation: { task: 'code' }, writeScope: 'source-and-artifact' },
      validate: { label: 'Validate', artifact: { path: 'a/v.md' } }
    },
    workTypes: { pay: { label: 'Pay', phases: ['build-it', 'validate'] } }
  };
  const rows = [
    { step: 'build-it', intent: 'code', confidence: 'certain', source: 'structure', why: 'its generation task is code' },
    { step: 'validate', intent: 'test', confidence: 'likely', source: 'words', why: 'its words say "validate", and it comes after the last code step' }
  ];
  // Copilot disagrees with a likely row: the person is asked once, with the top choices and what each means.
  const asked = intentTable(definition, 'pay', { rows, proposed: { validate: { intent: 'review', why: 'It checks the change against the requirements.', proposal: 'p-2' } } });
  const validate = asked.rows.find((row) => row.step === 'validate');
  assert.equal(validate.badge, 'needs-answer');
  assert.equal(validate.question.question, 'What does "Validate" do?');
  assert.deepEqual(validate.question.choices.map((choice) => choice.intent), ['test', 'review', 'document']);
  assert.match(validate.question.choices[0].text, /^Runs the tests \(test: sflow approves it when clean\)$/iu);
  assert.equal(validate.question.choices[2].text.startsWith('Something else (document: '), true);
  assert.equal(asked.rows[0].badge, 'sure');
  assert.equal(asked.rows[0].locked, true, 'a step its structure decides keeps its intent; to change it, copy it');
  assert.deepEqual(asked.rows[0].options.map((option) => option.intent), ['code']);
  assert.deepEqual(asked.rows[0].consequences, ['Changes code', 'A person approves it', 'Asks when unclear']);
  // Nothing before the code step plans it: the rules ask once, with both ways as moves.
  assert.equal(asked.questions[0].kind, 'unplanned');
  assert.deepEqual(asked.questions[0].choices.map((choice) => choice.key), ['add-plan', 'plans-itself']);
  assert.deepEqual(asked.questions[0].choices[0].moves[0], { move: 'step.add', id: 'build-it-plan', label: 'Plan Build it', intent: 'plan', after: null, agent: null,
    purpose: 'Lists the exact changes Build it makes and the tests that prove each requirement; a person approves it before the code changes.' });
  assert.deepEqual(asked.questions[0].choices[1].moves.map((move) => [move.move, move.responsibility, move.authority]),
    [['workflow.omit', 'scope', 'engineering-reviewers'], ['workflow.omit', 'plan', 'engineering-reviewers']]);
  assert.equal(asked.open, 2);
  // Copilot agrees, or the person answered: nothing left to ask about the step, and the code names the table.
  const agreed = intentTable(definition, 'pay', { rows, proposed: { validate: { intent: 'test', why: 'It runs the payment tests.', proposal: 'p-2' } } });
  assert.equal(agreed.rows[1].badge, 'copilot');
  assert.equal(agreed.rows[1].badgeText, 'Copilot suggests');
  assert.deepEqual(agreed.rows[1].consequences, ['Changes no code', 'SFlow approves it when clean', 'Asks when unclear']);
  const answered = intentTable(definition, 'pay', { rows, chosen: { validate: 'review' } });
  assert.equal(answered.rows[1].badge, 'yours');
  assert.notEqual(answered.code, agreed.code, 'another intent is another table');
  assert.match(answered.code, /^[0-9a-f]{6}$/u);
  assert.equal(intentTable(definition, 'pay', { rows, chosen: { validate: 'test' }, confirmed: { 'build-it': 'code', validate: 'test' } }).confirmed, true);
});

test('a new step says what it does, and a proposal never goes against a step\'s structure', async () => {
  const { run, flow, json, engineEnv } = await harness();
  const root = await repository(run, flow);
  const build = json(root, ['workflow', 'build', 'start', '--describe', 'Payments change: build it and run the checks.', '--name', 'Payments change']).build;
  const { proposeToBuild } = await import('../src/workflow-build/engine.mjs');
  const refused = (moves) => proposeToBuild(build.id, { title: 'Steps', why: 'The steps the description names.', moves }, { root, by: 'you', ...engineEnv })
    .then(() => null, (error) => error);
  const missing = await refused([{ move: 'step.add', id: 'intake' }, { move: 'step.add', id: 'run-checks', label: 'Run checks', agent: 'qa', after: 'intake' }]);
  const finding = missing.details.findings.find((entry) => entry.at === 'moves[1].intent');
  assert.equal(finding.code, 'BUILD_MOVE_FIELD_MISSING');
  assert.match(finding.message, /^A new step says what it does: give Run checks intent, one of intake, requirements, design, plan, code, test, review, release, report, document \(guide\.values\.intent says what each does\)\. It looks like test \(runs the tests\): /u);
  const contradiction = await refused([{ move: 'step.add', id: 'run-checks', label: 'Run checks', agent: 'qa', intent: 'test', output: 'code' }]);
  assert.equal(contradiction.details.findings[0].code, 'BUILD_MOVE_INTENT_CONTRADICTION');
  const certain = await refused([{ move: 'step.add', id: 'implementation' }, { move: 'step.intent', id: 'implementation', intent: 'test' }]);
  assert.equal(certain.details.findings[0].code, 'BUILD_MOVE_INTENT_CERTAIN');
  assert.match(certain.details.findings[0].message, /is a code step for certain \(it delivers code changes\), so it cannot be test\. Propose intent code, or add a copy with step\.add, from: 'implementation' and intent test\.$/u);
  const reason = await refused([{ move: 'step.add', id: 'run-checks', label: 'Run checks', agent: 'qa', intent: 'test', because: { writeScope: 'short' } }]);
  assert.equal(reason.details.findings[0].at, 'moves[0].because.writeScope');
});

test('a build finishes only once the person confirmed each step\'s intent, which writes them and version 4', async () => {
  const { run, flow, json } = await harness();
  const root = await repository(run, flow);
  const build = json(root, ['workflow', 'build', 'start', '--describe', 'Payments change: build it and run the checks.', '--name', 'Payments change']).build;
  const proposal = path.join(root, '..', `${path.basename(root)}-proposal.json`);
  await writeFile(proposal, JSON.stringify({ title: 'Four steps', why: 'Intake, requirements, the change and its checks.', moves: [
    { move: 'step.add', id: 'intake', after: null },
    { move: 'step.add', id: 'requirements', after: 'intake' },
    { move: 'step.add', id: 'pay-build', label: 'Build it', after: 'requirements', agent: 'developer', intent: 'code', reads: ['requirements'],
      signOff: { groups: ['engineering-reviewers'], minimum: 1 }, purpose: 'Makes the change and runs the payment tests.' },
    { move: 'step.add', id: 'pay-checks', label: 'Run checks', after: 'pay-build', agent: 'qa', intent: 'test', purpose: 'Runs the payment tests against the change.' }
  ] }));
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', proposal, '--by', 'you', '--accept']);
  const check = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.equal(check.intents.required, true, 'a build whose new steps say what they do confirms every step');
  assert.deepEqual(check.intents.rows.map((row) => [row.step, row.intent, row.badge]),
    [['intake', 'intake', 'sure'], ['requirements', 'requirements', 'sure'], ['pay-build', 'code', 'yours'], ['pay-checks', 'test', 'yours']]);
  assert.deepEqual(check.intents.rows.find((row) => row.step === 'pay-checks').consequences, ['Changes no code', 'SFlow approves it when clean', 'Asks when unclear']);
  assert.ok(check.intents.facts.lines.includes('Requirement IDs are written in Requirements.'), check.intents.facts.lines.join('\n'));
  assert.equal(check.ready, false);
  assert.equal(check.intents.confirmCommand, `singularity-flow workflow build intents --build ${build.id} --confirm ${check.intents.code}`);

  const finish = flow(root, ['workflow', 'build', 'finish', '--build', build.id, '--propose', '--json'], { allowFailure: true });
  assert.notEqual(finish.status, 0);
  assert.match(finish.stdout + finish.stderr, /confirm what each step is for first/u);

  const text = flow(root, ['workflow', 'build', 'intents', '--build', build.id]).stdout;
  assert.match(text, /^What each step of payments-change is for:\n {2}Intake: intake \(captures the request\) {2}\[SFlow is sure\]/u);
  assert.match(text, /Run checks: test \(runs the tests\) {2}\[Your choice\] {2}Changes no code · SFlow approves it when clean · Asks when unclear/u);
  assert.match(text, new RegExp(`Confirm this table \\(code ${check.intents.code}\\): singularity-flow workflow build intents --build ${build.id} --confirm ${check.intents.code}`, 'u'));

  const stale = flow(root, ['workflow', 'build', 'intents', '--build', build.id, '--confirm', 'abcdef', '--json'], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /WORKFLOW_BUILD_INTENTS_CHANGED/u);

  const confirmed = json(root, ['workflow', 'build', 'intents', '--build', build.id, '--confirm', check.intents.code]);
  assert.equal(confirmed.intents.confirmed, true, JSON.stringify(confirmed.intents.problems));
  const after = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  const op = after.changeSet.changes.find((change) => change.op === 'workflow.intents');
  assert.deepEqual(op, { op: 'workflow.intents', id: 'payments-change', steps: { intake: 'intake', requirements: 'requirements', 'pay-build': 'code', 'pay-checks': 'test' } });
  const created = after.changeSet.changes.find((change) => change.op === 'phase.create' && change.id === 'pay-checks');
  assert.equal(created.intent, 'test');
  assert.equal(Object.hasOwn(created, 'approval'), false, 'no sign-off given: the intent decides, never approval none');
  assert.equal(Object.hasOwn(created, 'output'), false);
  const diff = after.plan.files.find((file) => file.path === 'singularity/workflow.yml');
  assert.ok(diff, JSON.stringify(after.plan.problems));
  assert.equal(after.intents.confirmed, true);
  assert.ok(!after.intents.problems.length, JSON.stringify(after.intents.problems));
});

test('workflow build start --intents settles an existing workflow in place', async () => {
  const { run, flow, json } = await harness();
  const root = await repository(run, flow);
  const build = json(root, ['workflow', 'build', 'start', '--intents', 'repo-classic-delivery']).build;
  const check = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.equal(check.intents.required, true);
  assert.deepEqual(check.intents.rows.map((row) => [row.step, row.intent, row.badge]),
    [['intake', 'intake', 'sure'], ['implementation', 'code', 'sure'], ['testing', 'test', 'sure'], ['conformance', 'review', 'sure']]);
  const confirmed = json(root, ['workflow', 'build', 'intents', '--build', build.id, '--confirm', check.intents.code]);
  assert.equal(confirmed.intents.confirmed, true, JSON.stringify(confirmed.intents));
  const after = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual(after.changeSet.changes.map((change) => change.op), ['workflow.intents']);
  assert.equal(YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')).version, 2, 'nothing is written before the build finishes');
});
