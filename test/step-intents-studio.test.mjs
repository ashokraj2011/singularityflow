/**
 * Step intents Stage 3 in Workflow Studio's change sets: a new step starts from what it does (its intent), a step's
 * intent and reasons change through phase.update, and confirming every step's intent on one screen writes them with
 * workflow.yml version 4, so the workflow derives its settings from them.
 */
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import { STEP_INTENT_CHOICES, newStepContract } from '../src/step-outputs.mjs';
import { INTENT_PROFILES } from '../src/step-intent-settings.mjs';
import { STEP_INTENTS } from '../src/phase-roles.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Studio Tester' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const flow = (root, args, options) => run(process.execPath, [bin, ...args], root, options);
const json = (root, args, options) => JSON.parse(flow(root, [...args, '--json'], options).stdout);

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-studio-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Studio Tester'], root); run('git', ['config', 'user.email', 'studio@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Studio\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

async function changeSet(root, changes, base) {
  const file = path.join(root, '..', `${path.basename(root)}-change-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify({ schema: 'sflow-studio-change-set@1', base, changes }));
  return file;
}

test('every intent Studio offers names its profile\'s starter template, and a new step from an intent writes no kind of its own', () => {
  assert.deepEqual(STEP_INTENT_CHOICES.map((entry) => entry.id).sort(), [...STEP_INTENTS].sort());
  for (const entry of STEP_INTENT_CHOICES) assert.equal(entry.template, INTENT_PROFILES[1].intents[entry.id].template, entry.id);
  const test = newStepContract('run-checks', 'Run checks', 'document', { intent: 'test' });
  assert.deepEqual(test, { intent: 'test', label: 'Run checks', artifact: { path: 'artifacts/run-checks/run-checks.md', minimumBytes: 200 },
    defaultTemplate: 'common/run-checks.md' });
  assert.equal(Object.hasOwn(test.artifact, 'kind'), false, 'the blank step\'s kind (its own ID) is refused on a test step; the intent decides it');
  assert.deepEqual(newStepContract('pay-build', 'Build', 'document', { intent: 'code' }).generation, { task: 'code' });
  assert.equal(newStepContract('pay-build', 'Build', 'document', { intent: 'code' }).writeScope, 'source-and-artifact');
  assert.throws(() => newStepContract('x', 'X', 'document', { intent: 'verify' }), /not a step intent/u);
  // Without an intent the blank step is as it was.
  assert.equal(newStepContract('notes', 'Notes').artifact.kind, 'notes');
});

test('Studio adds a step from its intent, refuses an output that contradicts it, and confirming every intent writes version 4', async () => {
  const root = await repository();
  const model = json(root, ['workflow', 'studio']);
  assert.ok(model.choices.intents.some((entry) => entry.id === 'test' && entry.label === 'Runs the tests'));

  // A step whose output says it delivers code, while its intent says it runs tests, is refused with both ways out.
  const contradiction = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.create', id: 'run-checks', label: 'Run checks', intent: 'test', output: 'code', agent: 'qa' }
  ], model.base), '--dry-run']);
  assert.equal(contradiction.valid, false);
  assert.equal(contradiction.problems[0].code, 'STUDIO_INTENT_CONTRADICTION');
  assert.match(contradiction.problems[0].message, /give it intent code if it changes the code, or leave out its output/u);

  const changes = [
    { op: 'workflow.create', id: 'checks-only', label: 'Checks only', phases: ['gather', 'run-checks', 'checks-report'] },
    { op: 'phase.create', id: 'gather', label: 'Gather needs', intent: 'requirements', agent: 'product-owner' },
    { op: 'phase.create', id: 'run-checks', label: 'Run checks', intent: 'test', agent: 'qa' },
    { op: 'phase.create', id: 'checks-report', label: 'Checks report', intent: 'report', agent: 'qa' },
    { op: 'workflow.intents', id: 'checks-only', steps: { gather: 'requirements', 'run-checks': 'test', 'checks-report': 'report' } }
  ];
  const plan = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, changes, model.base), '--dry-run']);
  assert.equal(plan.valid, true, JSON.stringify(plan.problems));
  assert.ok(plan.summary.some((line) => /^New step Run checks: drafted by .*\. It runs the tests \(intent test\)\.$/u.test(line)), plan.summary.join('\n'));
  assert.ok(plan.summary.some((line) => /^Checks only: every step says what it is for, confirmed on one screen; workflow\.yml is version 4/u.test(line)), plan.summary.join('\n'));
  const applied = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, changes, model.base)]);
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));

  const written = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(written.version, 4);
  assert.deepEqual(written.phases['run-checks'], { intent: 'test', label: 'Run checks', artifact: { path: 'artifacts/run-checks/run-checks.md', minimumBytes: 200 },
    defaultTemplate: 'common/run-checks.md', approval: { authorities: ['quality-reviewers'], minimum: 1 } },
  'its intent\'s group signs it off, and nothing else framework-wide is written: the intent derives it');
  assert.equal(written.phases.gather.approval.authorities[0], 'product-approvers');
  // Each new step starts from its intent's packaged template, as its own copy.
  const starter = await readFile(path.join(root, 'singularity/templates/common/run-checks.md'), 'utf8');
  assert.equal(starter, await readFile(path.join(packageRoot, 'templates/artifacts/common/verification.md'), 'utf8'));
  assert.match(await readFile(path.join(root, 'singularity/templates/common/gather.md'), 'utf8'), /\[\{\{work\.id\}\}:REQ-001\]/u);

  // The workflow derives from its intents now: workflow check reads each step's declared intent.
  const check = json(root, ['workflow', 'check', 'checks-only']);
  assert.deepEqual(check.workflows[0].intents.map((row) => [row.step, row.intent, row.source]),
    [['gather', 'requirements', 'declared'], ['run-checks', 'test', 'declared'], ['checks-report', 'report', 'declared']]);
  assert.ok(!check.workflows[0].findings.some((entry) => entry.code === 'CHECK_INTENTS_NEED_VERSION'), JSON.stringify(check.workflows[0].findings.map((entry) => entry.code)));

  // A step's intent and its reasons change through phase.update; a shared step keeps one meaning.
  const next = json(root, ['workflow', 'studio']);
  // A framework setting a save gives a step, other than what its intent gives, says why, or the save is refused.
  const unreasoned = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'run-checks', changesCode: true }
  ], next.base), '--dry-run']);
  assert.equal(unreasoned.valid, false);
  assert.equal(unreasoned.problems[0].code, 'STUDIO_INTENT_REASON_REQUIRED');
  assert.match(unreasoned.problems[0].message, /^Run checks sets writeScope itself, with no reason\. Say why under because on Run checks/u);
  assert.match(unreasoned.problems[0].nextAction.workflowStudio, /Why this setting/u);
  const reasoned = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'run-checks', changesCode: true, because: { writeScope: 'It adds the missing regression tests itself, so a person approves it.' } }
  ], next.base), '--dry-run']);
  assert.equal(reasoned.valid, true, JSON.stringify(reasoned.problems));
  assert.match(reasoned.files.find((file) => file.path === 'singularity/workflow.yml').diff, /\+\s+because:\n\+\s+writeScope: It adds the missing regression tests itself/u);
  const refusedReason = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'phase.update', id: 'run-checks', because: { writeScope: 'too short' } }
  ], next.base), '--dry-run']);
  assert.equal(refusedReason.problems[0].code, 'STUDIO_BECAUSE_INVALID');
  const shared = json(root, ['workflow', 'studio', 'apply', '--change-set', await changeSet(root, [
    { op: 'workflow.update', id: 'repo-feature', phases: [...next.workflows.find((workflow) => workflow.id === 'repo-feature').phases, 'run-checks'] },
    { op: 'phase.update', id: 'run-checks', intent: 'review' }
  ], next.base), '--dry-run']);
  assert.equal(shared.valid, false);
  assert.equal(shared.problems[0].code, 'STUDIO_INTENT_SHARED');
  assert.match(shared.problems[0].message, /^Run checks is a test step in .* too, and a step means one thing in every workflow\. Copy Run checks for this workflow and give the copy intent review\.$/u);
});
