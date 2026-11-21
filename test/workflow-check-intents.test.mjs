/**
 * `workflow check` says what each step is for and how sure SFlow is (step intents spec §6.1, Stage 1), and what kind
 * of software the repository is (§12.1). Both are reports: no finding, count or setting changes with them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Check Tester' };

function run(command, args, cwd, { input = '' } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const json = (root, args, options) => JSON.parse(flow(root, [...args, '--json'], options).stdout);
const changeSet = (changes) => JSON.stringify({ schema: 'sflow-studio-change-set@1', changes });

const PAYMENTS = [
  { op: 'workflow.create', id: 'pay', label: 'Payments change', phases: ['intake', 'requirements', 'pay-build', 'pay-check'] },
  { op: 'phase.create', id: 'pay-build', label: 'Build the change', output: 'code', inputs: ['requirements'], agent: 'developer' },
  { op: 'phase.create', id: 'pay-check', label: 'Validate the payment', output: 'document', inputs: ['pay-build'], agent: 'qa' }
];

async function paymentsRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-check-intents-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Check Tester'], root); run('git', ['config', 'user.email', 'check@example.com'], root);
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'pay-web', private: true, dependencies: { react: '18.3.1' } }, null, 2)}\n`);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.tsx'), 'export const App = () => null;\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  flow(root, ['workflow', 'studio', 'apply', '--change-set', '-'], { input: changeSet(PAYMENTS) });
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'payments'], root);
  return root;
}

async function setStep(root, id, values) {
  const file = path.join(root, 'singularity', 'workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  for (const [key, value] of Object.entries(values)) document.setIn(['phases', id, key], document.createNode(value));
  await writeFile(file, document.toString());
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', `${id}: ${Object.keys(values).join(', ')}`], root);
}

test('each step\'s intent and how sure SFlow is, and the repository\'s kind of software, without changing a finding', async () => {
  const root = await paymentsRepository();
  const before = json(root, ['workflow', 'check', 'pay']);
  const [workflow] = before.workflows;
  assert.deepEqual(workflow.intents.map((entry) => [entry.step, entry.intent, entry.confidence, entry.source]), [
    ['intake', 'intake', 'certain', 'shipped'],
    ['requirements', 'requirements', 'certain', 'shipped'],
    ['pay-build', 'code', 'certain', 'structure'],
    ['pay-check', 'test', 'likely', 'words']
  ]);
  assert.match(workflow.intents[3].why, /"check".*after the last code step/u);
  // The repository's own files: a React app.
  assert.equal(before.software.layout, 'single');
  assert.deepEqual(before.software.projects.map((project) => [project.id, project.kind, project.confidence]), [['repository-root', 'web', 'certain']]);
  const text = flow(root, ['workflow', 'check', 'pay']).stdout;
  assert.match(text, /^ {5}For: intake \(SFlow is sure: a step SFlow ships\)\.$/mu);
  assert.match(text, /^ {5}For: test \(likely: its words say "check", "validate"/mu);
  assert.match(text, /^What kind of software this is, from its files \(the runtime check follows it; singularity-flow capability kind confirms it once\):\n {2}This repository: web: react in package\.json; front-end component files\.$/mu);
  const all = flow(root, ['workflow', 'check']).stdout;
  assert.match(all, /^ {2}What each step is for: Intake: intake, Requirements: requirements, Build the change: code, Validate the payment: test \(likely\)\.$/mu);

  // A declared intent is shown as declared, with what the structure says when that differs. One step that says what it
  // is for derives nothing (Stage 2): the only change is the note that says which steps do not.
  await setStep(root, 'pay-check', { intent: 'review', because: { writeScope: 'Reads the delivered code and changes nothing itself.' } });
  const after = json(root, ['workflow', 'check', 'pay']);
  const declared = after.workflows[0].intents[3];
  assert.deepEqual([declared.intent, declared.confidence, declared.source, declared.inferred?.intent], ['review', 'certain', 'declared', 'test']);
  assert.match(flow(root, ['workflow', 'check', 'pay']).stdout, /^ {5}For: review \(workflow\.yml says so; its settings look like test \(/mu);
  const partial = after.workflows[0].findings.find((entry) => entry.code === 'CHECK_INTENTS_PARTIAL');
  assert.deepEqual([partial?.severity, partial?.title], ['note', 'Only 1 of 4 steps has an intent (what the step is for)']);
  assert.match(partial.detail, /These steps have none: Intake, Requirements, Build the change\./u);
  // Lines move when workflow.yml is written again, so findings compare by what they say, not where.
  const strip = (result) => result.workflows.map((entry) => ({ ...entry, intents: undefined, counts: undefined,
    findings: entry.findings.filter((finding) => finding.code !== 'CHECK_INTENTS_PARTIAL').map(({ code, severity, title, subject }) => ({ code, severity, title, subject })) }));
  assert.deepEqual(strip(after), strip(before), 'declaring an intent changes no explanation and no other finding');
  assert.deepEqual(after.counts, { ...before.counts, note: before.counts.note + 1 });

  // An intent in a workflow's overrides does not load, and says where to fix it.
  const file = path.join(root, 'singularity', 'workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.setIn(['workTypes', 'pay', 'phaseOverrides', 'pay-check', 'intent'], 'test');
  await writeFile(file, document.toString());
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'override intent'], root);
  const refused = json(root, ['workflow', 'check', 'pay']);
  assert.equal(refused.configuration.valid, false);
  const problem = refused.repository.findings.find((entry) => entry.code === 'STEP_INTENT_INVALID');
  assert.match(problem?.detail ?? '', /what a step is for is set on the step itself/u);
});

test('workflow check --settings: a version 4 workflow of intents, refused while a step contradicts its intent, then derived, with where each setting came from', async () => {
  const root = await paymentsRepository();
  const file = path.join(root, 'singularity', 'workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.set('version', 4);
  for (const [id, intent] of [['intake', 'intake'], ['requirements', 'requirements'], ['pay-build', 'code'], ['pay-check', 'test']]) {
    document.setIn(['phases', id, 'intent'], intent);
  }
  await writeFile(file, document.toString());
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'intents'], root);
  // Workflow Studio's blank step names its output after itself; a test step's output is test results.
  const refused = json(root, ['workflow', 'check', 'pay']);
  assert.equal(refused.configuration.valid, false);
  const problem = refused.repository.findings.find((entry) => entry.code === 'STEP_INTENT_INVALID');
  assert.match(problem?.detail ?? '', /Validate the payment is a test step, so SFlow recognises its output as test results \(test-evidence\), but it sets output kind pay-check\. Remove artifact\.kind from Validate the payment/u);

  document.deleteIn(['phases', 'pay-check', 'artifact', 'kind']);
  await writeFile(file, document.toString());
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'no kind'], root);
  const result = json(root, ['workflow', 'check', 'pay', '--settings']);
  const [workflow] = result.workflows;
  assert.equal(workflow.settings.derives, true);
  assert.equal(workflow.settings.profile, 1);
  const setting = (step, key) => workflow.settings.steps.find((entry) => entry.id === step).settings.find((entry) => entry.key === key);
  // The test step: its intent gives the kind, the repository's tests and SFlow's approval; it cites the code step's results.
  assert.deepEqual([setting('pay-check', 'artifact.kind').value, setting('pay-check', 'artifact.kind').from], ['test-evidence', 'intent']);
  assert.deepEqual([setting('pay-check', 'repositoryTests').value, setting('pay-check', 'repositoryTests').from], ['run', 'intent']);
  assert.deepEqual([setting('pay-check', 'testEvidenceFrom').value, setting('pay-check', 'testEvidenceFrom').from], ['pay-build', 'workflow-rule']);
  assert.equal(setting('pay-check', 'approval').value, 'sflow-when-clean');
  // The code step's own setting wins over nothing different: it says it changes source files, as its intent does.
  assert.deepEqual([setting('pay-build', 'writeScope').value, setting('pay-build', 'writeScope').from], ['source-and-artifact', 'shared-step']);
  assert.equal(setting('pay-build', 'approval').value, 'person');
  assert.deepEqual(workflow.settings.steps.map((step) => step.intent?.value), ['intake', 'requirements', 'code', 'test']);
  // Workflow Studio wrote the workflow's requirement IDs itself; they are what the rules give, so no reason is asked.
  const claims = workflow.settings.workflow.find((entry) => entry.key === 'plannedClaims.clausePhases');
  assert.deepEqual([claims.value, claims.from], [['requirements'], 'override']);
  assert.equal(workflow.findings.some((entry) => entry.code === 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON' && entry.subject.setting === 'plannedClaims'), false);
  // Other workflows that share a step with an intent derive nothing, and say why.
  const all = json(root, ['workflow', 'check', '--settings']);
  const others = all.workflows.filter((entry) => entry.id !== 'pay');
  assert.ok(others.length > 0);
  for (const other of others) {
    assert.equal(other.settings.derives, false, other.id);
    assert.ok(/^not every step has an intent|^its steps have no intent/u.test(other.settings.why), other.settings.why);
  }
  const sharing = others.filter((entry) => entry.settings.steps.some((step) => ['intake', 'requirements'].includes(step.id)));
  for (const other of sharing) assert.ok(other.findings.some((entry) => entry.code === 'CHECK_INTENTS_PARTIAL'), other.id);
  const text = flow(root, ['workflow', 'check', 'pay', '--settings']).stdout;
  assert.match(text, /^ {2}Settings: derived from each step's intent, what the step is for \(profile 1\)\.$/mu);
  assert.match(text, /^ {2}4\. Validate the payment: test, as workflow\.yml says$/mu);
  assert.match(text, /^ {5}Cites the test results of: Build the change \(workflow rule: nothing since Build the change changed source files, so it cites its committed test results\)$/mu);
  assert.match(text, /^ {5}Requirement IDs written by: Requirements \(this workflow's override\)$/mu);
});
