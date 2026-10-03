import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  MAX_DELIVERY_ATTEMPTS, classifyResponse, deliverStepActions, deliveryRequest, enqueueStepActions, listStepActionDeliveries,
  postDelivery, releaseWaitingStepActions, runStepActionsAfterTransition, stepActionWarning
} from '../src/step-action-delivery.mjs';
import { normalizeIntegrations, pinStepActions, normalizeStepActions } from '../src/step-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const SECRET = 'test-signing-secret';

function run(command, args, cwd, env = {}, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Delivery Tester', SINGULARITY_FLOW_NO_MODEL: '1', ...env }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Run a command without blocking this process, so the local receiver can answer it. */
function runAsync(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Delivery Tester', SINGULARITY_FLOW_NO_MODEL: '1', ...env }
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve({ status, stdout, stderr })
      : reject(new Error(`${command} ${args.join(' ')} failed\n${stdout}\n${stderr}`))));
  });
}

async function gitRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], root);
  return root;
}

/** A local receiver that records every request and answers with the next scripted status. */
async function receiver(t, statuses = []) {
  const requests = [];
  const queue = [...statuses];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const status = queue.length ? queue.shift() : 200;
      if (status === 302) response.writeHead(302, { location: 'https://elsewhere.example.com/' });
      else response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status >= 400 ? '{"error":"nope","token":"leaked-value"}' : '{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${server.address().port}/hook`, queue };
}

function storyWorkflow(actions, integrations, { status = 'awaiting_approval' } = {}) {
  return {
    workItem: { id: 'STORY-9', title: 'Checkout retry', branch: 'STORY-9' },
    resolution: { workType: 'feature', phases: [{ id: 'intake', label: 'Intake', afterStep: pinStepActions(normalizeStepActions(actions, integrations, 'intake'), integrations) }] },
    phases: { intake: { status, generation: 1, artifacts: [{ path: 'singularity/work-items/STORY-9/artifacts/intake.md', sha256: 'a'.repeat(64) }] } }
  };
}

test('each target kind builds its request, and a missing secret makes the delivery unavailable here', () => {
  const integrations = normalizeIntegrations({ targets: {
    hook: { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_SECRET_HOOK_KEY' },
    splunk: { kind: 'http-log', format: 'splunk-hec', url: 'https://logs.example.com/services/collector', tokenSecret: 'SFLOW_SECRET_HEC', labels: { index: 'eng' } },
    datadog: { kind: 'http-log', format: 'datadog', url: 'https://http-intake.logs.datadoghq.com/api/v2/logs', tokenSecret: 'SFLOW_SECRET_DD', labels: { service: 'flow', team: 'eng' } },
    loki: { kind: 'http-log', format: 'loki', url: 'https://loki.example.com/loki/api/v1/push' },
    teams: { kind: 'teams', urlSecret: 'SFLOW_SECRET_TEAMS_URL' }
  } });
  const record = (target) => ({
    key: 'sad_' + '1'.repeat(40), trigger: 'approved',
    action: { id: 'a', target, send: 'event', targetSpec: integrations.targets[target] },
    event: { schema: 'sflow-step-action@1', delivery: { trigger: 'approved' }, step: { label: 'Intake', generation: 1 }, story: { id: 'STORY-9', title: 'Checkout retry' }, at: '2026-10-03T10:00:00.000Z' }
  });
  const clock = () => Date.parse('2026-10-03T10:00:00.000Z');

  const hook = deliveryRequest(record('hook'), { SFLOW_SECRET_HOOK_KEY: SECRET }, clock);
  assert.equal(hook.headers['idempotency-key'], 'sad_' + '1'.repeat(40));
  const expected = createHmac('sha256', SECRET).update(`${hook.headers['x-sflow-timestamp']}.${hook.body}`).digest('hex');
  assert.equal(hook.headers['x-sflow-signature'], `v1=${expected}`, 'receivers can verify the body and timestamp');
  assert.deepEqual(deliveryRequest(record('hook'), {}, clock).unavailable.code, 'STEP_ACTION_SECRET_MISSING');

  const splunk = deliveryRequest(record('splunk'), { SFLOW_SECRET_HEC: 'hec-token' }, clock);
  assert.equal(splunk.headers.authorization, 'Splunk hec-token');
  assert.equal(JSON.parse(splunk.body).fields.index, 'eng');
  const datadog = deliveryRequest(record('datadog'), { SFLOW_SECRET_DD: 'dd-key' }, clock);
  assert.equal(datadog.headers['dd-api-key'], 'dd-key');
  assert.equal(JSON.parse(datadog.body)[0].ddtags, 'team:eng');
  const loki = deliveryRequest(record('loki'), {}, clock);
  assert.equal(JSON.parse(loki.body).streams[0].values[0][0], `${Date.parse('2026-10-03T10:00:00.000Z')}000000`);
  assert.equal(loki.headers.authorization, undefined, 'loki without a token sends none');

  const teams = deliveryRequest(record('teams'), { SFLOW_SECRET_TEAMS_URL: 'https://example.webhook.office.com/abc' }, clock);
  assert.equal(teams.url, 'https://example.webhook.office.com/abc');
  assert.match(JSON.parse(teams.body).text, /Intake approved/);
  assert.equal(deliveryRequest(record('teams'), { SFLOW_SECRET_TEAMS_URL: 'http://plain.example.com' }, clock).failed.code, 'STEP_ACTION_ADDRESS_REFUSED');
});

test('an answer decides the delivery: done, try later, or needs a person', () => {
  assert.equal(classifyResponse(200).outcome, 'delivered');
  assert.equal(classifyResponse(204).outcome, 'delivered');
  assert.equal(classifyResponse(409).outcome, 'delivered', 'a receiver that already has the key has the delivery');
  for (const status of [408, 425, 429, 500, 502, 503]) assert.equal(classifyResponse(status).outcome, 'retry', String(status));
  for (const status of [400, 401, 403, 404, 410, 413, 422]) assert.equal(classifyResponse(status).outcome, 'failed', String(status));
  assert.equal(classifyResponse(302).code, 'STEP_ACTION_REDIRECT_REFUSED');
  assert.doesNotMatch(classifyResponse(500, '{"token":"abc123"}').detail, /abc123/, 'answers are redacted before they are kept');
});

test('requests go only where the target allows, and never follow a redirect', async (t) => {
  const local = await receiver(t, [200, 302]);
  const ok = await postDelivery({ url: local.url, headers: { 'content-type': 'application/json' }, body: '{"a":1}', timeoutMs: 5000 });
  assert.equal(ok.outcome, 'delivered');
  assert.equal(local.requests[0].body, '{"a":1}');
  const redirected = await postDelivery({ url: local.url, headers: {}, body: '{}', timeoutMs: 5000 });
  assert.equal(redirected.outcome, 'failed');
  assert.equal(local.requests.length, 2, 'the redirect was not followed');

  const privateLookup = async () => [{ address: '10.0.0.8', family: 4 }];
  const refused = await postDelivery({ url: 'https://internal.example.com/hook', headers: {}, body: '{}', timeoutMs: 1000, lookupImpl: privateLookup });
  assert.equal(refused.code, 'STEP_ACTION_ADDRESS_REFUSED', 'a public target never reaches a private address');
  const plain = await postDelivery({ url: 'http://example.com/hook', headers: {}, body: '{}', timeoutMs: 1000 });
  assert.equal(plain.code, 'STEP_ACTION_ADDRESS_REFUSED');
});

test('the outbox delivers once, retries with backoff, holds unavailable deliveries without spending attempts, and refuses tampered records', async (t) => {
  const root = await gitRepository(t);
  const integrations = normalizeIntegrations({ targets: { hook: { kind: 'webhook', url: 'https://hooks.example.com/sflow', signingSecret: 'SFLOW_SECRET_HOOK_KEY' } } });
  const workflow = storyWorkflow([{ id: 'announce', on: ['submitted', 'approved'], target: 'hook' }], integrations);
  const event = { type: 'approval-requested', phaseId: 'intake', generation: 1, actor: 'ada', createdAt: '2026-10-03T10:00:00.000Z' };
  let now = Date.parse('2026-10-03T10:00:00.000Z');
  const clock = () => now;
  const sent = [];
  let answer = 'retry';
  const post = async (request) => { sent.push(request); return answer === 'ok' ? { outcome: 'delivered', status: 200 } : { outcome: 'retry', status: 503, code: 'STEP_ACTION_TARGET_UNAVAILABLE' }; };

  const queued = await enqueueStepActions(root, workflow, { event, commit: 'c'.repeat(40), clock });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].trigger, 'submitted');
  assert.equal((await enqueueStepActions(root, workflow, { event, commit: 'c'.repeat(40), clock })).length, 0, 'the same delivery is written once');

  // No secret on this machine: held, no attempt spent, nothing sent.
  let report = await deliverStepActions(root, { env: {}, clock, post });
  assert.equal(report.unavailable.length, 1);
  assert.equal(sent.length, 0);

  report = await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.equal(report.retrying.length, 1);
  assert.equal(sent.length, 1);
  report = await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.equal(sent.length, 1, 'not due again until its backoff passes');
  now += 31_000;
  answer = 'ok';
  report = await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.equal(report.delivered.length, 1);
  assert.equal(sent[1].body, sent[0].body, 'a retry sends exactly the same body');
  assert.equal(sent[1].headers['idempotency-key'], sent[0].headers['idempotency-key']);
  report = await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.equal(sent.length, 2, 'a delivered record is never sent again');
  const [listed] = await listStepActionDeliveries(root);
  assert.equal(listed.status, 'delivered');
  assert.equal(listed.attempts, 3);

  // A record whose budget runs out fails, and a named retry gives it a fresh budget.
  const approved = storyWorkflow([{ id: 'announce', on: ['submitted', 'approved'], target: 'hook' }], integrations, { status: 'approved' });
  await enqueueStepActions(root, approved, { event: { ...event, type: 'phase-approved' }, commit: 'd'.repeat(40), clock });
  answer = 'retry';
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS + 1; attempt += 1) {
    now += 90_000_000;
    await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  }
  const failed = (await listStepActionDeliveries(root)).find((entry) => entry.trigger === 'approved');
  assert.equal(failed.status, 'failed');
  assert.match(stepActionWarning({ failed: [{ action: 'announce', target: 'hook', status: 503 }], retrying: [], unavailable: [] }), /integrations retry/);
  answer = 'ok';
  report = await deliverStepActions(root, { keys: [failed.key], env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.equal(report.delivered.length, 1);

  // A record changed on disk is never delivered.
  const directory = path.join(root, '.git', 'singularity-flow', 'action-outbox');
  const rejected = storyWorkflow([{ id: 'announce', on: ['rejected'], target: 'hook' }], integrations, { status: 'in_progress' });
  const [tampered] = await enqueueStepActions(root, rejected, { event: { ...event, type: 'phase-rejected' }, commit: 'e'.repeat(40), clock });
  const file = path.join(directory, `${tampered.key}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  stored.action.targetSpec.url = 'https://attacker.example.com/';
  await writeFile(file, JSON.stringify(stored));
  report = await deliverStepActions(root, { env: { SFLOW_SECRET_HOOK_KEY: SECRET }, clock, post });
  assert.deepEqual(report.tampered.map((entry) => entry.key), [tampered.key]);
  assert.equal(sent.some((request) => request.url.includes('attacker')), false);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.lock')), false, 'no lock is left behind');
});

test('deliveries for a commit that could not be pushed wait until sync publishes it', async (t) => {
  const root = await gitRepository(t);
  const integrations = normalizeIntegrations({ targets: { hook: { kind: 'webhook', url: 'https://hooks.example.com/sflow' } } });
  const workflow = storyWorkflow([{ id: 'announce', on: ['submitted'], target: 'hook' }], integrations);
  const sent = [];
  const post = async (request) => { sent.push(request); return { outcome: 'delivered', status: 200 }; };
  const result = await runStepActionsAfterTransition(root, workflow, {
    event: { type: 'approval-requested', phaseId: 'intake', generation: 1 }, commit: 'f'.repeat(40), published: false, env: {}, post
  });
  assert.equal(result.waiting.length, 1);
  assert.equal(sent.length, 0, 'nothing is sent about a transition the remote does not have');
  assert.equal(await releaseWaitingStepActions(root, { workId: 'STORY-9' }), 1);
  const report = await deliverStepActions(root, { env: {}, post });
  assert.equal(report.delivered.length, 1);
  const quiet = await runStepActionsAfterTransition(root, workflow, { event: { type: 'work-cancelled', phaseId: 'intake' }, commit: 'f'.repeat(40), env: {}, post });
  assert.deepEqual(quiet.queued, [], 'other lifecycle events send nothing');
});

test('a Story sends its pinned actions on submit and approve, signed, exactly once, and the command line reports them [after-step actions]', async (t) => {
  const local = await receiver(t, [503]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-story-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const env = { SFLOW_SECRET_STEP_HOOK: SECRET };
  const cli = (...args) => runAsync(process.execPath, [CLI, '--no-model', ...args], root, env);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Delivery Tester'], root);
  run('git', ['config', 'user.email', 'delivery@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Fixture\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'test/fixture.test.mjs'), "import test from 'node:test';\ntest('fixture', () => {});\n");
  await cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.integrations = { targets: { 'team-events': { kind: 'webhook', url: local.url, signingSecret: 'SFLOW_SECRET_STEP_HOOK' } } };
  config.phases.intake.afterStep = [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events' }];
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the delivery fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse((await cli('precheck', '--run', '--scope', 'dependency-test', '--json')).stdout).data.plan;
  await cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  const listed = JSON.parse((await cli('integrations', 'list', '--json')).stdout);
  assert.deepEqual(listed.data.uses.find((use) => use.workflow === 'quick-fix')?.action ?? listed.data.uses[0].action, 'announce');
  assert.equal(listed.data.targets[0].secrets[0].set, true);
  const preview = JSON.parse((await cli('integrations', 'test', 'team-events', '--json')).stdout);
  assert.equal(preview.data.request.headers['x-sflow-signature'], '[redacted]', 'a preview never shows a secret');
  assert.equal(local.requests.length, 0, 'test without --send-test sends nothing');

  const W = 'DEL-1';
  await cli('start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Announce the work', '--description', 'Send events.');
  const item = path.join(root, 'singularity/work-items', W);
  await cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Announce each decision.', '',
    '## Scope and constraints', '', 'Only the announcement.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | A decision is announced. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${W}:AC-001\` | \`README.md\` | \`test/fixture.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The fixture.', ''
  ].join('\n'));
  await cli('wm', 'compose', '--phase', 'intake');
  await cli('clarification', 'record', 'intake', '--question', 'Announce approvals too?', '--answer', 'Yes.');
  await cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const submitted = await cli('submit', 'intake');
  assert.match(submitted.stderr, /after-step action not delivered yet/, 'the 503 is reported and left for a retry');
  assert.equal(local.requests.length, 1);
  const first = local.requests[0];
  const body = JSON.parse(first.body);
  assert.equal(body.delivery.trigger, 'submitted');
  assert.equal(body.story.id, W);
  assert.equal(first.headers['x-sflow-signature'],
    `v1=${createHmac('sha256', SECRET).update(`${first.headers['x-sflow-timestamp']}.${first.body}`).digest('hex')}`);

  const status = JSON.parse((await cli('integrations', 'status', '--json')).stdout);
  assert.deepEqual(status.data.deliveries.map((entry) => [entry.trigger, entry.status]), [['submitted', 'pending']]);
  const retried = JSON.parse((await cli('integrations', 'retry', status.data.deliveries[0].key, '--json')).stdout);
  assert.equal(retried.data.report.delivered.length, 1);
  assert.equal(local.requests[1].headers['idempotency-key'], first.headers['idempotency-key'], 'the retry is the same delivery');

  await cli('approve', 'intake', '--yes');
  const approvedRequest = local.requests.at(-1);
  assert.equal(JSON.parse(approvedRequest.body).delivery.trigger, 'approved');
  assert.equal(local.requests.length, 3, 'one request per delivery, no duplicates');
  const all = JSON.parse((await cli('integrations', 'status', '--all', '--json')).stdout);
  assert.deepEqual(all.data.deliveries.map((entry) => entry.status).sort(), ['delivered', 'delivered']);
  const doctor = await runAsync(process.execPath, [CLI, '--no-model', 'doctor', '--offline', '--json'], root, {}).catch((error) => ({ stdout: String(error.message).split('\n').slice(1).join('\n') }));
  const report = JSON.parse(doctor.stdout.slice(doctor.stdout.indexOf('{')));
  const checks = report.data?.checks ?? report.checks ?? [];
  const integration = checks.find((entry) => entry.id === 'integration-team-events');
  assert.equal(integration?.status, 'warn', 'without the secret in its environment, doctor says this machine cannot sign deliveries');
  assert.match(integration.message, /SFLOW_SECRET_STEP_HOOK is not set on this machine/);
});
