import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { phaseRequiresCodeDelivery, resolveDeliveryQualityCommands } from '../src/delivery-evidence.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'singularity-flow.mjs');
const PHASES = ['poc-lite-plan', 'poc-lite-act', 'poc-lite-verify', 'poc-lite-finalize'];

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'POC Lite Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function starter() {
  return YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
}

test('POC Lite is a separate four-checkpoint, deterministic, service-free profile', async () => {
  const definition = await starter();
  validateDefinition(definition);
  const profile = definition.workTypes['poc-lite'];
  const enterprise = definition.workTypes['poc-workflow'];
  assert.deepEqual(profile.phases, PHASES);
  assert.match(enterprise.label, /enterprise Playwright/i);
  assert.ok(enterprise.phases.includes('poc-ui-exploration'), 'the existing Playwright profile was replaced');

  const resolved = resolveWorkType(definition, 'poc-lite');
  assert.deepEqual(resolved.intelligence, { worldModel: 'off', ast: 'off', agentBriefs: 'off' });
  for (const phase of resolved.phases) {
    assert.equal(phase.generation.defaultProducer, 'deterministic', `${phase.id} can require a model`);
    assert.deepEqual(phase.generation.allowedProducers, ['deterministic']);
    assert.deepEqual(phase.worldModel.views, []);
    assert.deepEqual(phase.mcp, { requiredServers: [], requireSmoke: false, evidence: [] });
  }
  assert.deepEqual(resolved.phases.slice(0, -1).map((phase) => phase.approval.mode), ['none', 'none', 'none']);
  const final = resolved.phases.at(-1);
  assert.equal(final.approval.mode, 'required');
  assert.equal(final.approval.minimum, 1);
  assert.deepEqual(final.approval.authorities, ['quality-reviewers']);
  assert.deepEqual(final.approval.requiredAuthorities, ['quality-reviewers']);
  assert.equal(phaseRequiresCodeDelivery(resolved.phases[1]), true);
});

test('POC Lite ACT uses the changed module repository test command without adding a dependency', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-lite-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    private: true,
    scripts: { test: 'node --test' }
  }));
  await writeFile(path.join(root, 'app.js'), 'export const answer = 42;\n');
  await writeFile(path.join(root, 'app.test.js'), "import assert from 'node:assert'; assert.equal(42, 42);\n");
  const definition = await starter();
  const act = resolveWorkType(definition, 'poc-lite').phases[1];
  const commands = await resolveDeliveryQualityCommands(root, {
    ...act,
    deliveryEvidence: { sourcePaths: ['app.js'], testPaths: ['app.test.js'] }
  });
  assert.ok(commands.some((command) => command.id === 'git-diff-check'));
  const testCommand = commands.find((command) => command.kind === 'test');
  assert.deepEqual(testCommand.argv, ['npm', 'test']);
  assert.equal(testCommand.modelPolicy, 'never');
  assert.equal(testCommand.result.adapter, 'node-tap');
});

test('fresh init and catalog install ship phase-specific POC Lite agents and templates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-lite-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const old = YAML.parse(await readFile(workflowPath, 'utf8'));
  delete old.workTypes['poc-lite'];
  for (const phase of PHASES) delete old.phases[phase];
  await writeFile(workflowPath, YAML.stringify(old));
  for (const agent of ['poc-lite-planner', 'poc-lite-implementer', 'poc-lite-verifier']) {
    await rm(path.join(root, `.github/agents/${agent}.agent.md`));
  }
  await rm(path.join(root, 'singularity/templates/poc-lite'), { recursive: true });

  const result = await installWorkflow(root, 'poc-lite');
  for (const agent of ['poc-lite-planner', 'poc-lite-implementer', 'poc-lite-verifier']) {
    assert.ok(result.files.includes(`.github/agents/${agent}.agent.md`));
  }
  for (const file of ['plan.md', 'act.md', 'verify.md', 'finalize.md']) {
    assert.ok(result.files.includes(`singularity/templates/poc-lite/${file}`));
  }
  const installed = await loadDefinition(root);
  assert.deepEqual(resolveWorkType(installed, 'poc-lite').phases.map((phase) => phase.defaultAgent), [
    'poc-lite-planner', 'poc-lite-implementer', 'poc-lite-verifier', 'poc-lite-verifier'
  ]);
});

test('POC Lite completes its one human boundary with --no-model and a local bare remote', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-poc-lite-start-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(remote, { recursive: true, force: true })
  ]));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'POC Lite Tester'], root);
  run('git', ['config', 'user.email', 'poc-lite@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# POC Lite\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module', private: true, scripts: { test: 'node --test' }
  }));
  await writeFile(path.join(root, 'message.js'), "export const message = 'before';\n");
  await writeFile(path.join(root, 'message.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { message } from './message.js';",
    "test('message', () => assert.equal(message, 'before'));",
    ''
  ].join('\n'));
  run(process.execPath, [CLI, 'init'], root);
  // This fixture exercises deterministic POC lifecycle behavior; pre-Story readiness has its
  // own integration coverage and is not an additional checkpoint in this local harness.
  const configPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configPath, 'utf8'));
  configuration.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(configuration));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize local POC harness'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const baseBefore = run('git', ['rev-parse', 'refs/remotes/origin/main'], root).stdout.trim();

  run(process.execPath, [
    CLI, '--no-model', 'start', 'POC-LITE-1', '--from-branch', 'main', '--work-type', 'poc-lite',
    '--title', 'One local change', '--description', 'Prove a deterministic local workflow.'
  ], root);
  const workflow = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/POC-LITE-1/workflow.json'), 'utf8'
  ));
  assert.deepEqual(workflow.phaseOrder, PHASES);
  assert.deepEqual(workflow.resolution.intelligence, { worldModel: 'off', ast: 'off', agentBriefs: 'off' });
  assert.equal(workflow.phases['poc-lite-plan'].generationPolicy.defaultProducer, 'deterministic');
  const astWarmRecords = await readdir(
    path.join(root, '.git/singularity-flow/ast/v2/story-start')
  ).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  assert.deepEqual(astWarmRecords, [], 'an AST-off workflow must not schedule or record cache warming');

  const lifecycle = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const publish = (phase) => lifecycle(
    'phase', 'publish', phase, '--authored', 'deterministic', '--channel', 'kernel-generator'
  );
  const preparedPlan = lifecycle('prepare', 'poc-lite-plan');
  assert.match(preparedPlan.stdout,
    /phase publish poc-lite-plan --authored deterministic --channel kernel-generator/);
  assert.doesNotMatch(preparedPlan.stdout, /--authored human/);
  publish('poc-lite-plan');
  const submittedPlan = lifecycle('run', '--yes');
  assert.match(submittedPlan.stdout, /prepare poc-lite-act/,
    'post-submit continuation must be planned from the newly active phase');
  assert.doesNotMatch(submittedPlan.stdout, /(?:approve|reject) poc-lite-plan/,
    'a completed no-approval phase must not retain review actions');
  assert.doesNotMatch(submittedPlan.stdout, /review poc-lite-plan/,
    'the guided runner must not invent a review boundary after no-approval completion');
  assert.match(submittedPlan.stdout, /Guided run advanced to 'poc-lite-act'/);

  // The code interval must open before either endpoint changes. A passing baseline test cannot be
  // relabelled as evidence for new behavior: this generation changes both product and test bytes.
  lifecycle('prepare', 'poc-lite-act');
  await writeFile(path.join(root, 'message.js'), "export const message = 'after';\n");
  await writeFile(path.join(root, 'message.test.js'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { message } from './message.js';",
    "test('message', () => assert.equal(message, 'after'));",
    ''
  ].join('\n'));
  lifecycle('prepare', 'poc-lite-act');
  publish('poc-lite-act');
  lifecycle('submit', 'poc-lite-act');

  lifecycle('prepare', 'poc-lite-verify');
  publish('poc-lite-verify');
  lifecycle('submit', 'poc-lite-verify');
  await assert.rejects(
    readFile(path.join(root, '.git/singularity-flow/session.json'), 'utf8'),
    (error) => error?.code === 'ENOENT',
    'a deterministic next phase must not synthesize a governed-agent session'
  );
  lifecycle('prepare', 'poc-lite-finalize');
  publish('poc-lite-finalize');
  lifecycle('submit', 'poc-lite-finalize');

  const awaitingDecision = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/POC-LITE-1/workflow.json'), 'utf8'
  ));
  assert.equal(awaitingDecision.currentPhase, 'poc-lite-finalize');
  assert.equal(awaitingDecision.phases['poc-lite-finalize'].status, 'awaiting_approval');
  assert.deepEqual(awaitingDecision.phases['poc-lite-finalize'].approvals, []);

  // POC Lite omits scope; its final approval is refused until someone in the omission's group says
  // why scope does not apply to this Story, and the refusal writes nothing.
  const statePath = path.join(root, 'singularity/work-items/POC-LITE-1/workflow.json');
  const stateBefore = await readFile(statePath, 'utf8');
  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const refused = run(process.execPath, [CLI, '--no-model', 'approve', 'poc-lite-finalize', '--yes'], root, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /cannot finish yet[\s\S]*ends without scope; someone in quality-reviewers must record why it does not apply/);
  assert.match(refused.stdout + refused.stderr, /decision applicability --responsibility scope/);
  assert.equal(await readFile(statePath, 'utf8'), stateBefore, 'a refused ending must not change the Story');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');

  // The guidance offers the decision before the approval it unblocks.
  const next = JSON.parse(lifecycle('nextsteps', '--json').stdout).actions;
  assert.equal(next[0].command, 'singularity-flow decision applicability POC-LITE-1 --responsibility scope --reason <reason>');
  assert.equal(next[0].timing, 'now');
  assert.ok(next.some((entry) => entry.timing === 'then' && /approve/.test(entry.command)), JSON.stringify(next.map((entry) => [entry.timing, entry.command])));
  const shown = JSON.parse(lifecycle('decision', 'show', '--json').stdout);
  assert.deepEqual(shown.applicability.map((entry) => [entry.responsibility, entry.authority, entry.satisfied]), [['scope', 'quality-reviewers', false]]);
  const short = run(process.execPath, [CLI, '--no-model', 'decision', 'applicability', '--responsibility', 'scope', '--reason', 'n/a'], root, { allowFailure: true });
  assert.notEqual(short.status, 0);
  assert.match(short.stdout + short.stderr, /20 to 1000 characters/);
  const notOmitted = run(process.execPath, [CLI, '--no-model', 'decision', 'applicability', '--responsibility', 'verify', '--reason', 'Verification always applies to this Story.'], root, { allowFailure: true });
  assert.notEqual(notOmitted.status, 0);
  assert.match(notOmitted.stdout + notOmitted.stderr, /No end of this Story's workflow omits verify/);
  const decided = lifecycle('decision', 'applicability', '--responsibility', 'scope',
    '--reason', 'This POC demonstrates the lifecycle on one local change and has no requirements.');
  assert.match(decided.stdout, /Recorded that scope does not apply to POC-LITE-1, decided by .+ through quality-reviewers/);
  assert.equal(JSON.parse(lifecycle('decision', 'show', '--json').stdout).applicability[0].satisfied, true);

  lifecycle('approve', 'poc-lite-finalize', '--yes');

  const completed = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/POC-LITE-1/workflow.json'), 'utf8'
  ));
  assert.equal(completed.currentPhase, null, 'the final human decision must complete the workflow');
  assert.equal(completed.completion.label, 'Complete');
  assert.equal(completed.completion.mode, 'decision');
  assert.equal(completed.applicability.length, 1);
  const matrix = JSON.parse(lifecycle('evidence', 'matrix', '--json').stdout).data.matrix;
  assert.equal(matrix.evaluation.completion.label, 'Complete', JSON.stringify(matrix.evaluation.findings));
  assert.equal(matrix.page.rows.find((row) => row.id === 'story:scope').result, 'not-applicable');
  assert.equal(completed.phases['poc-lite-finalize'].status, 'approved');
  assert.equal(completed.phases['poc-lite-finalize'].approvals.length, 1);
  assert.equal(completed.phases['poc-lite-finalize'].approvals[0].decision, 'approved');
  for (const phase of PHASES) {
    assert.equal(completed.phases[phase].telemetry[0].status, 'not-invoked', `${phase} invoked a model`);
    assert.ok(completed.phases[phase].generationCommit, `${phase} has no governed generation commit`);
  }
  assert.ok(completed.phases['poc-lite-act'].deliveryEvidence.testExecutions.some((execution) =>
    execution.status === 'passed'));
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const published = run('git', ['rev-parse', 'refs/remotes/origin/POC-LITE-1'], root).stdout.trim();
  assert.equal(published, head, 'the completed Story branch was not published exactly');
  assert.equal(run('git', ['rev-parse', 'refs/remotes/origin/main'], root).stdout.trim(), baseBefore,
    'the isolated POC changed its selected base branch');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');
});
