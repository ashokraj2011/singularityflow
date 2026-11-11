/**
 * A verification step runs the repository's own tests when it is submitted.
 *
 * The packaged verification step names no checks of its own, so until now it ran nothing and its
 * test evidence was whatever the author wrote. With `repositoryTests: run` its submission runs the
 * suite the build files name. A pass is recorded; a failure goes to the reviewer, who cannot
 * approve and returns the Story to repair; a repository with no test command gets a note. None of
 * them holds the Story where no route leads on.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { verificationRepositoryTests } from '../src/verification/repository-tests.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const choreFlow = { workType: 'chore', agent: 'developer' };

function execute(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Verification Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify(choreFlow) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: childTimeout(180_000) });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);

async function repository(t, { tests = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-verification-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(`${root}.git`, { recursive: true, force: true }));
  execute('git', ['init', '-q', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Verification Tester'], root);
  execute('git', ['config', 'user.email', 'verification.tester@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# Ledger\n');
  if (tests) await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ledger', private: true, type: 'module', scripts: { test: 'node --test' } }));
  if (tests && tests !== 'none') {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test/ledger.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
      + `test('ledger balances', () => assert.equal(1 + 1, ${tests === 'passing' ? 2 : 3}));\n`);
  }
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.approvalSecurity = { profile: 'poc' };
  config.repositoryReadiness = { ...config.repositoryReadiness, requiredBeforeStory: false };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', '.'], root);
  execute('git', ['commit', '-q', '-m', 'initial'], root);
  execute('git', ['init', '-q', '--bare', '-b', 'main', `${root}.git`], root);
  execute('git', ['remote', 'add', 'origin', `${root}.git`], root);
  execute('git', ['push', '-q', '-u', 'origin', 'main'], root);
  return root;
}

async function complete(root, workId, phaseId) {
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  const file = path.join(root, 'singularity/work-items', workId, workflow.phases[phaseId].requiredArtifact.path);
  const text = (await readFile(file, 'utf8'))
    .replace(/TODO:[^\n]*/g, 'Ran the ledger suite and checked the balance outcome with complete operational detail and exact references.')
    .replace(/\bTODO\b/g, 'checked');
  await writeFile(file, text);
}

/** A chore through implementation, then its verification published and submitted. */
async function submitVerification(root, workId) {
  flow(root, ['start', workId, '--from-branch', 'main', '--title', 'Tidy the ledger', '--description', 'Maintenance only.']);
  await complete(root, workId, 'intake');
  flow(root, ['phase', 'publish', 'intake']); flow(root, ['submit']); flow(root, ['approve', '--yes']);
  flow(root, ['prepare', 'implementation']);
  await complete(root, workId, 'implementation');
  flow(root, ['phase', 'publish', 'implementation']); flow(root, ['submit']); flow(root, ['approve', '--yes']);
  flow(root, ['prepare', 'verification']);
  await complete(root, workId, 'verification');
  flow(root, ['phase', 'publish', 'verification']);
  const submitted = flow(root, ['submit']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items', workId, 'workflow.json'), 'utf8'));
  return { submitted, workflow, phase: workflow.phases.verification };
}

test('the packaged verification and testing steps ask for the repository tests, and the setting is checked', async () => {
  const config = YAML.parse(await readFile(path.join(packageRoot, 'templates/workflow.yml'), 'utf8'));
  validateDefinition(config);
  const phaseOf = (workType, id) => resolveWorkType(config, workType).phases.find((phase) => phase.id === id);
  assert.equal(phaseOf('feature', 'verification').repositoryTests, 'run');
  assert.equal(phaseOf('chore', 'verification').repositoryTests, 'run');
  assert.equal(phaseOf('benchmarking-a', 'testing').repositoryTests, 'run');
  // Every other step resolves to the shape it always had.
  assert.equal(Object.hasOwn(phaseOf('feature', 'implementation'), 'repositoryTests'), false);
  const off = structuredClone(config);
  off.workTypes.chore.phaseOverrides.verification.repositoryTests = 'off';
  assert.equal(Object.hasOwn(resolveWorkType(off, 'chore').phases.find((phase) => phase.id === 'verification'), 'repositoryTests'), false);
  const wrong = structuredClone(config);
  wrong.phases.verification.repositoryTests = 'always';
  assert.throws(() => validateDefinition(wrong), /Phase 'verification' repositoryTests must be run or off\./u);
});

test('a Story pinned before the setting, or a step that names its own test, runs nothing extra', async () => {
  const phase = { id: 'verification', status: 'in_progress' };
  const workflow = (pinned) => ({ workItem: { id: 'W-1' }, phaseOrder: ['verification'], phases: { verification: phase },
    resolution: { phases: [{ id: 'verification', ...pinned }] } });
  assert.deepEqual(await verificationRepositoryTests(packageRoot, {}, workflow({}), phase), { commands: [], notes: [] });
  assert.deepEqual(await verificationRepositoryTests(packageRoot, {}, workflow({ repositoryTests: 'run' }), phase,
    [{ id: 'suite', kind: 'test', argv: ['npm', 'test'], modelPolicy: 'never' }]), { commands: [], notes: [] });
  assert.deepEqual(await verificationRepositoryTests(packageRoot, {}, workflow({ repositoryTests: 'run', testEvidenceFrom: 'implementation' }), phase),
    { commands: [], notes: [] });
});

test('a verification step runs the repository tests and records the pass', slowLane({ timeout: 300_000 }), async (t) => {
  const root = await repository(t, { tests: 'passing' });
  const { phase } = await submitVerification(root, 'CH-PASS');
  const run = phase.checks.filter((check) => check.source === 'repository-tests');
  assert.equal(run.length, 1, JSON.stringify(phase.checks, null, 2));
  assert.equal(run[0].status, 'passed');
  assert.equal(run[0].kind, 'test');
  assert.equal(phase.status, 'awaiting_approval');
  flow(root, ['approve', '--yes']);
});

test('a failing run goes to the reviewer, who returns the Story to repair it', slowLane({ timeout: 300_000 }), async (t) => {
  const root = await repository(t, { tests: 'failing' });
  const { submitted, phase } = await submitVerification(root, 'CH-FAIL');
  assert.match(submitted.stderr, /Warning: the repository's tests failed: .*verification goes to its reviewer, who cannot approve it/su);
  const run = phase.checks.find((check) => check.source === 'repository-tests');
  assert.equal(run.status, 'failed');
  assert.equal(phase.status, 'awaiting_approval');
  // Publication ran it and refused nothing; submission ran it again, and both runs are bound by their counts [CQF:REQ-010, REQ-012].
  assert.equal(phase.stepTestRuns.preflightAttempts[0].status, 'failed');
  assert.equal(phase.stepTestRuns.testExecutions[0].status, 'failed');
  assert.notEqual(phase.stepTestRuns.testExecutions[0].attemptId, phase.stepTestRuns.preflightAttempts[0].attemptId);
  assert.equal(phase.stepTestRuns.testExecutions[0].counts.failed, 1);
  const approve = flow(root, ['approve', '--yes', '--json'], { allowFailure: true });
  assert.notEqual(approve.status, 0);
  const { error, remediationPlan } = JSON.parse(approve.stdout);
  assert.equal(error.code, 'PHASE_VALIDATION_FAILED');
  // The regression is in the code implementation delivered: the refusal and the hold both return it
  // there, never verification to itself [PHR:REQ-003, REQ-004].
  const back = 'singularity-flow reject verification --work-id CH-FAIL --to implementation --reason <REASON>';
  assert.match(error.message, /The repository's own tests fail on the code implementation delivered, which implementation repairs/u);
  assert.ok(remediationPlan.steps.some((entry) => entry.command === back && entry.skill === '/sf-reject'), JSON.stringify(remediationPlan.steps));
  const [hold] = JSON.parse(flow(root, ['status', 'CH-FAIL', '--submission-readiness', '--json']).stdout).approvalCheck.holds;
  assert.equal(hold.code, 'PHASE_VALIDATION_FAILED');
  assert.equal(hold.action.command, back);
  assert.match(hold.action.label, /returns verification to implementation/u);
  flow(root, ['reject', '--to', 'implementation', '--reason', 'The ledger suite fails.']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/CH-FAIL/workflow.json'), 'utf8'));
  assert.equal(workflow.currentPhase, 'implementation');
});

test('a run that exits 0 with no test in it reads as no tests ran, and refuses nothing new [CQF:REQ-010]', slowLane({ timeout: 300_000 }), async (t) => {
  const root = await repository(t, { tests: 'none' });
  const { phase } = await submitVerification(root, 'CH-ZERO');
  const check = phase.checks.find((entry) => entry.source === 'repository-tests');
  assert.equal(check.status, 'passed', 'its exit code is unchanged');
  const [run] = phase.stepTestRuns.testExecutions;
  assert.deepEqual([run.counts.discovered, run.status], [0, 'failed'], 'judged by its counts');
  const review = JSON.parse(flow(root, ['phase', 'show', 'verification', '--json']).stdout);
  assert.match(review.stepTestRuns[0].words, /: node-tests failed, no tests ran$/u);
  flow(root, ['approve', '--yes']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/CH-ZERO/workflow.json'), 'utf8'));
  assert.equal(workflow.phases.verification.status, 'approved');
});

test('a repository with no test command gets a note, and the step can still be approved', slowLane({ timeout: 300_000 }), async (t) => {
  const root = await repository(t);
  const { phase } = await submitVerification(root, 'CH-NONE');
  const notes = phase.checks.filter((check) => check.source === 'repository-tests');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'skipped-warning');
  assert.equal(notes[0].requirement, 'advisory');
  assert.match(notes[0].stderr, /found no test command .*capability test-setup --json/su);
  flow(root, ['approve', '--yes']);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/CH-NONE/workflow.json'), 'utf8'));
  assert.equal(workflow.phases.verification.status, 'approved');
});
