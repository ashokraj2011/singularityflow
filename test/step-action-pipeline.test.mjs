/**
 * Delivering after-step actions from a pipeline: a target marked deliverFrom: pipeline is left to
 * the pipeline by the machine that moves the Story, and `integrations deliver --commit` delivers it
 * from the pushed commit, only to targets the approved configuration declares, and records it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { deliverStepActions, enqueueStepActions, listStepActionDeliveries } from '../src/step-action-delivery.mjs';
import { normalizeIntegrations, normalizeStepActions, pinStepActions } from '../src/step-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Pipeline Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function runAsync(command, args, cwd, env = {}, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...ENV, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 || allowFailure ? resolve({ status, stdout, stderr })
      : reject(new Error(`${command} ${args.join(' ')} failed\n${stdout}\n${stderr}`))));
  });
}

async function receiver(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}/hook` };
}

test('a target is delivered by the machine that moves the Story unless it names a pipeline', () => {
  const targets = (deliverFrom) => normalizeIntegrations({ targets: { audit: { kind: 'webhook', url: 'https://audit.example.com/sflow', ...(deliverFrom === undefined ? {} : { deliverFrom }) } } }).targets.audit;
  assert.equal(targets('pipeline').deliverFrom, 'pipeline');
  assert.equal(Object.hasOwn(targets('transition'), 'deliverFrom'), false, 'the default is never written, so existing pins do not change');
  assert.deepEqual(targets('transition'), targets(undefined));
  assert.throws(() => targets('ci'), (error) => error.code === 'INTEGRATION_TARGET_INVALID' && /deliverFrom must be transition .* or pipeline/.test(error.message));
});

test('the machine that moves the Story leaves a pipeline target to the pipeline, unless someone names it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], root);
  const integrations = normalizeIntegrations({ targets: {
    audit: { kind: 'webhook', url: 'https://audit.example.com/sflow', deliverFrom: 'pipeline' },
    team: { kind: 'webhook', url: 'https://hooks.example.com/sflow' }
  } });
  const afterStep = pinStepActions(normalizeStepActions([
    { id: 'audit', on: ['approved'], target: 'audit' }, { id: 'announce', on: ['approved'], target: 'team' }
  ], integrations, 'intake'), integrations);
  const workflow = {
    workItem: { id: 'STORY-9', title: 'Checkout retry', branch: 'STORY-9' },
    resolution: { workType: 'feature', phases: [{ id: 'intake', label: 'Intake', afterStep }] },
    phases: { intake: { status: 'approved', generation: 1, artifacts: [] } }
  };
  const queued = await enqueueStepActions(root, workflow, { event: { type: 'phase-approved', phaseId: 'intake', generation: 1 }, commit: 'c'.repeat(40) });
  assert.deepEqual(queued.map((record) => [record.action.id, record.status]).sort(), [['announce', 'pending'], ['audit', 'pipeline']]);
  const sent = [];
  const post = async (request) => { sent.push(request.url); return { outcome: 'delivered', status: 200 }; };
  const report = await deliverStepActions(root, { env: {}, post });
  assert.deepEqual(sent, ['https://hooks.example.com/sflow'], 'only the machine\'s own target is sent');
  assert.equal(report.delivered.length, 1);
  const listed = await listStepActionDeliveries(root);
  assert.equal(listed.find((entry) => entry.action === 'audit').status, 'pipeline');
  const audit = queued.find((record) => record.action.id === 'audit');
  await deliverStepActions(root, { keys: [audit.key], env: {}, post });
  assert.deepEqual(sent.at(-1), 'https://audit.example.com/sflow', 'someone can still deliver it from here by naming it');
});

test('a pipeline delivers a pushed approval to a trusted target, records it, and releases the next step [after-step actions]', async (t) => {
  const local = await receiver(t);
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-pipeline-story-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dev = path.join(base, 'dev');
  const ci = path.join(base, 'ci');
  const remote = path.join(base, 'remote.git');
  await mkdir(dev);
  const cli = (cwd, ...args) => runAsync(process.execPath, [CLI, '--no-model', ...args], cwd);
  run('git', ['init', '-b', 'main'], dev);
  run('git', ['config', 'user.name', 'Pipeline Tester'], dev);
  run('git', ['config', 'user.email', 'pipeline@example.test'], dev);
  await writeFile(path.join(dev, 'README.md'), '# Fixture\n');
  await writeFile(path.join(dev, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await mkdir(path.join(dev, 'test'), { recursive: true });
  await writeFile(path.join(dev, 'test/fixture.test.mjs'), "import test from 'node:test';\ntest('fixture', () => {});\n");
  await cli(dev, 'init');
  const configPath = path.join(dev, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.integrations = { targets: { 'audit-log': { kind: 'webhook', url: local.url, signingSecret: 'SFLOW_SECRET_PIPELINE_KEY', deliverFrom: 'pipeline' } } };
  config.phases.intake.afterStep = [{ id: 'audit', on: ['approved'], target: 'audit-log', required: true }];
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], dev);
  run('git', ['commit', '-m', 'Initialize the pipeline fixture'], dev);
  run('git', ['init', '--bare', '-b', 'main', remote], dev);
  run('git', ['remote', 'add', 'origin', remote], dev);
  run('git', ['push', '-u', 'origin', 'main'], dev);
  const configCommit = run('git', ['rev-parse', 'HEAD'], dev).stdout.trim();
  const readiness = JSON.parse((await cli(dev, 'precheck', '--run', '--scope', 'dependency-test', '--json')).stdout).data.plan;
  await cli(dev, 'precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  const W = 'PIPE-1';
  await cli(dev, 'start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Audit from the pipeline', '--description', 'Pipeline.');
  const item = path.join(dev, 'singularity/work-items', W);
  await cli(dev, 'prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Audit each approval from the pipeline.', '',
    '## Scope and constraints', '', 'Only the audit.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | An approval is audited. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${W}:AC-001\` | \`README.md\` | \`test/fixture.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The fixture.', ''
  ].join('\n'));
  await cli(dev, 'wm', 'compose', '--phase', 'intake');
  await cli(dev, 'clarification', 'record', 'intake', '--question', 'Audit approvals?', '--answer', 'Yes.');
  await cli(dev, 'phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  await cli(dev, 'submit', 'intake');
  const approved = await cli(dev, 'approve', 'intake', '--yes');
  const approval = run('git', ['rev-parse', 'HEAD'], dev).stdout.trim();
  assert.equal(local.requests.length, 0, 'the machine that approved leaves the pipeline target to the pipeline');
  assert.doesNotMatch(approved.stdout + approved.stderr, /not delivered yet/, 'a pipeline delivery is not a failure here');
  const devStatus = JSON.parse((await cli(dev, 'integrations', 'status', '--all', '--json')).stdout);
  assert.deepEqual(devStatus.data.deliveries.map((entry) => [entry.status, entry.required]), [['pipeline', true]]);
  const held = await runAsync(process.execPath, [CLI, '--no-model', 'prepare', 'implement'], dev, {}, { allowFailure: true });
  assert.notEqual(held.status, 0);
  assert.match(held.stdout + held.stderr, /A pipeline delivers it and records its receipt; once it has, bring that receipt here: singularity-flow refresh-branch/);

  // The pipeline: a clone of the pushed branch, with its own identity and the target's secret.
  run('git', ['clone', '-q', remote, ci], base);
  run('git', ['config', 'user.name', 'Delivery Pipeline'], ci);
  run('git', ['config', 'user.email', 'pipeline-bot@example.test'], ci);
  run('git', ['checkout', '-q', '-B', W, `origin/${W}`], ci);
  const pipelineEnv = { SFLOW_SECRET_PIPELINE_KEY: 'pipeline-only-secret' };
  const deliver = (...args) => runAsync(process.execPath, [CLI, '--no-model', 'integrations', 'deliver', ...args, '--json'], ci, pipelineEnv, { allowFailure: true });

  const notLifecycle = await deliver('--commit', configCommit);
  assert.equal(notLifecycle.status, 0);
  assert.equal(JSON.parse(notLifecycle.stdout).data.lifecycle, false);

  // A trusted ref whose configuration names a different address: nothing is sent, and the job fails.
  run('git', ['branch', 'tampered', 'origin/main'], ci);
  run('git', ['checkout', '-q', 'tampered'], ci);
  const tampered = YAML.parse(await readFile(path.join(ci, 'singularity/workflow.yml'), 'utf8'));
  tampered.integrations.targets['audit-log'].url = 'https://elsewhere.example.com/hook';
  await writeFile(path.join(ci, 'singularity/workflow.yml'), YAML.stringify(tampered));
  run('git', ['commit', '-qam', 'A different target'], ci);
  run('git', ['checkout', '-q', W], ci);
  const untrusted = await deliver('--commit', approval, '--trusted-ref', 'tampered');
  assert.equal(untrusted.status, 1);
  const untrustedResult = JSON.parse(untrusted.stdout).data;
  assert.deepEqual(untrustedResult.actions.map((entry) => [entry.action, entry.trusted]), [['audit', false]]);
  assert.match(untrustedResult.actions[0].reason, /differs from the approved configuration on tampered/);
  assert.equal(local.requests.length, 0, 'an untrusted target is never sent the pipeline secret');

  const delivered = await deliver('--commit', approval, '--record');
  assert.equal(delivered.status, 0, delivered.stderr);
  const result = JSON.parse(delivered.stdout).data;
  assert.equal(result.report.delivered.length, 1);
  assert.deepEqual([result.receipts.recorded, result.receipts.count, result.receipts.pushed], [true, 1, true]);
  assert.equal(local.requests.length, 1);
  const [request] = local.requests;
  assert.equal(JSON.parse(request.body).delivery.trigger, 'approved');
  assert.equal(request.headers['idempotency-key'], devStatus.data.deliveries[0].key, 'the pipeline delivers under the same key the Story pinned');
  assert.match(request.headers['x-sflow-signature'], /^v1=[0-9a-f]{64}$/, 'signed with the pipeline\'s secret');

  const again = await deliver('--commit', approval, '--record');
  assert.equal(again.status, 0);
  assert.equal(local.requests.length, 1, 'a second run sends nothing new');
  assert.equal(JSON.parse(again.stdout).data.receipts.recorded, false);

  // Back on the developer's machine: bring the receipt in, and the next step starts.
  await cli(dev, 'refresh-branch');
  await cli(dev, 'prepare', 'implement');
  const recorded = JSON.parse((await cli(dev, 'integrations', 'status', '--all', '--json')).stdout);
  assert.deepEqual(recorded.data.deliveries.map((entry) => [entry.status, entry.recorded]), [['pipeline', true]]);
});
