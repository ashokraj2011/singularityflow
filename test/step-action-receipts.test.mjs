/**
 * After-step action receipts: what a Story delivered, committed as evidence by
 * `integrations record`. Receipts are made only from deliveries that match what the Story pinned,
 * never while a step awaits approval, and never twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { recordSha256 } from '../src/records.mjs';
import { familyForStoredPath, readRecord } from '../src/schema-migrations.mjs';
import {
  assertReceiptsMayBeRecorded, stepActionReceipt, stepActionReceiptDirectory, stepActionReceiptProblem, stepAwaitingApproval
} from '../src/step-action-receipts.mjs';
import { normalizeIntegrations, normalizeStepActions, pinStepActions, stepActionDeliveryKey } from '../src/step-actions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Receipt Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV, ...env } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Run a command without blocking this process, so the local receiver can answer it. */
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

const integrations = normalizeIntegrations({ targets: { 'team-events': { kind: 'webhook', url: 'https://hooks.example.com/sflow' } } });

function storyFixture({ status = 'approved', generation = 1 } = {}) {
  const afterStep = pinStepActions(normalizeStepActions([{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events' }], integrations, 'intake'), integrations);
  return {
    workItem: { id: 'STORY-9' },
    phaseOrder: ['intake', 'implement'],
    resolution: { phases: [{ id: 'intake', afterStep }, { id: 'implement', afterStep: [] }] },
    phases: { intake: { status, generation }, implement: { status: 'pending', generation: 0 } }
  };
}

function deliveredRecord(workflow, overrides = {}) {
  const action = workflow.resolution.phases[0].afterStep[0];
  const base = { workId: 'STORY-9', phaseId: 'intake', generation: 1, trigger: 'approved' };
  return {
    schema: 'sflow-step-action-delivery@1',
    key: stepActionDeliveryKey({ ...base, actionId: action.id }),
    ...base,
    action: structuredClone(action),
    event: { schema: 'sflow-step-action@1', story: { id: 'STORY-9' }, step: { id: 'intake', generation: 1 } },
    commit: 'HEAD',
    status: 'delivered',
    deliveredAt: '2026-10-04T10:00:02.000Z',
    attempts: [{ at: '2026-10-04T10:00:00.000Z', outcome: 'retry', status: 503 }, { at: '2026-10-04T10:00:02.000Z', outcome: 'delivered', status: 200 }],
    ...overrides
  };
}

test('a receipt binds the delivery, its transition commit and the hashes of what was sent', () => {
  const workflow = storyFixture();
  const record = deliveredRecord(workflow, { commit: 'c'.repeat(40) });
  const receipt = stepActionReceipt(record, { recordedAt: '2026-10-04T11:00:00.000Z', recordedBy: { name: 'Receipt Tester', email: null } });
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    deliveryKey: record.key,
    workId: 'STORY-9', phaseId: 'intake', generation: 1, trigger: 'approved',
    action: { id: 'announce', target: 'team-events', kind: 'webhook', send: 'event' },
    targetSha256: recordSha256(record.action.targetSpec),
    transitionCommit: 'c'.repeat(40),
    eventSha256: recordSha256(record.event),
    artifact: null,
    delivered: { at: '2026-10-04T10:00:02.000Z', attempts: 2, status: 200, detail: null },
    recordedAt: '2026-10-04T11:00:00.000Z',
    recordedBy: { name: 'Receipt Tester', email: null }
  });
  assert.equal(readRecord('step-action-receipt', JSON.stringify(receipt)).record.deliveryKey, record.key);
  const path = `${stepActionReceiptDirectory({}, 'STORY-9')}/${record.key}.json`;
  assert.equal(path, `singularity/work-items/STORY-9/evidence/step-actions/${record.key}.json`);
  assert.equal(familyForStoredPath(path)?.id, 'step-action-receipt', 'the receipt path belongs to its record family');
  assert.equal(familyForStoredPath('singularity/work-items/STORY-9/evidence/step-actions/sad_short.json'), null);
});

test('only a delivery that matches what the Story pinned can become a receipt, and never during review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'base'], root);
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const workflow = storyFixture();
  assert.equal(stepActionReceiptProblem(root, workflow, deliveredRecord(workflow, { commit: head })), null);
  const problem = (overrides) => stepActionReceiptProblem(root, workflow, deliveredRecord(workflow, { commit: head, ...overrides }));
  assert.match(problem({ key: `sad_${'0'.repeat(40)}` }), /key does not match/);
  assert.match(problem({ generation: 2, key: stepActionDeliveryKey({ workId: 'STORY-9', phaseId: 'intake', generation: 2, trigger: 'approved', actionId: 'announce' }) }), /no generation 2/);
  const changed = deliveredRecord(workflow, { commit: head });
  changed.action.targetSpec.url = 'https://elsewhere.example.com/hook';
  assert.match(stepActionReceiptProblem(root, workflow, changed), /differs from what the Story pinned/);
  const other = deliveredRecord(workflow, { commit: head });
  other.action.id = 'unpinned';
  other.key = stepActionDeliveryKey({ workId: 'STORY-9', phaseId: 'intake', generation: 1, trigger: 'approved', actionId: 'unpinned' });
  assert.match(stepActionReceiptProblem(root, workflow, other), /did not pin an action 'unpinned'/);
  assert.match(problem({ commit: 'd'.repeat(40) }), /not in this branch's history/);

  assert.equal(stepAwaitingApproval(workflow), null);
  assert.doesNotThrow(() => assertReceiptsMayBeRecorded(workflow));
  const inReview = storyFixture({ status: 'awaiting_approval' });
  assert.equal(stepAwaitingApproval(inReview), 'intake');
  assert.throws(() => assertReceiptsMayBeRecorded(inReview), (error) => error.code === 'STEP_ACTION_RECEIPTS_DURING_REVIEW'
    && /intake is awaiting approval, and a commit now would require submitting it again/.test(error.message));
});

test('integrations record commits each delivered delivery once, after review, and the Story carries on [after-step actions]', async (t) => {
  const local = await receiver(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-step-action-receipt-story-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => runAsync(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Receipt Tester'], root);
  run('git', ['config', 'user.email', 'receipt@example.test'], root);
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
  config.integrations = { targets: { 'team-events': { kind: 'webhook', url: local.url } } };
  config.phases.intake.afterStep = [{ id: 'announce', on: ['submitted', 'approved'], target: 'team-events' }];
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the receipt fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse((await cli('precheck', '--run', '--scope', 'dependency-test', '--json')).stdout).data.plan;
  await cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');

  const W = 'REC-1';
  await cli('start', W, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Record the deliveries', '--description', 'Receipts.');
  const item = path.join(root, 'singularity/work-items', W);
  const nothing = JSON.parse((await cli('integrations', 'record', '--json')).stdout);
  assert.deepEqual([nothing.data.receipts.length, nothing.data.pending.length, nothing.data.publication], [0, 0, null], 'nothing delivered yet, nothing recorded');
  await cli('prepare', 'intake');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', 'Record each delivery.', '',
    '## Scope and constraints', '', 'Only the receipts.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${W}:AC-001] | A delivery is recorded. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${W}:AC-001\` | \`README.md\` | \`test/fixture.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The fixture.', ''
  ].join('\n'));
  await cli('wm', 'compose', '--phase', 'intake');
  await cli('clarification', 'record', 'intake', '--question', 'Record approvals too?', '--answer', 'Yes.');
  await cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  await cli('submit', 'intake');
  assert.equal(local.requests.length, 1, 'the submit was delivered');

  const preview = JSON.parse((await cli('integrations', 'record', '--dry-run', '--json')).stdout);
  assert.equal(preview.data.awaitingApproval, 'intake');
  assert.deepEqual(preview.data.pending.map((entry) => [entry.phaseId, entry.trigger, entry.action, entry.target]), [['intake', 'submitted', 'announce', 'team-events']]);
  const headBefore = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const refused = await runAsync(process.execPath, [CLI, '--no-model', 'integrations', 'record', '--json'], root, {}, { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /STEP_ACTION_RECEIPTS_DURING_REVIEW/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headBefore, 'nothing is committed while intake awaits approval');

  await cli('approve', 'intake', '--yes');
  assert.equal(local.requests.length, 2, 'the approval was delivered');
  const recorded = JSON.parse((await cli('integrations', 'record', '--json')).stdout);
  assert.equal(recorded.data.receipts.length, 2);
  assert.equal(recorded.data.publication.pushed, true);
  const receiptDirectory = path.join(item, 'evidence/step-actions');
  const files = (await readdir(receiptDirectory)).sort();
  assert.deepEqual(files, recorded.data.receipts.map((receipt) => `${receipt.deliveryKey}.json`).sort());
  const sent = new Map(local.requests.map((request) => [request.headers['idempotency-key'], JSON.parse(request.body)]));
  for (const file of files) {
    const receipt = readRecord('step-action-receipt', await readFile(path.join(receiptDirectory, file))).record;
    assert.equal(receipt.workId, W);
    assert.equal(receipt.eventSha256, recordSha256(sent.get(receipt.deliveryKey)), 'the receipt binds exactly the event the receiver got');
    assert.equal(receipt.delivered.status, 200);
    assert.equal(run('git', ['merge-base', '--is-ancestor', receipt.transitionCommit, 'HEAD'], root).status, 0);
  }
  assert.deepEqual(new Set(recorded.data.receipts.map((receipt) => receipt.trigger)), new Set(['submitted', 'approved']));
  const commit = run('git', ['show', '--name-only', '--format=%s', 'HEAD'], root).stdout.trim().split('\n').filter(Boolean);
  assert.equal(commit[0], `[${W}][integrations][record] after-step action receipts`);
  assert.ok(commit.slice(1).every((file) => file.startsWith(`singularity/work-items/${W}/`)), 'the receipt commit only touches the Story');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), run('git', ['ls-remote', remote, `refs/heads/${run('git', ['branch', '--show-current'], root).stdout.trim()}`], root).stdout.split('\t')[0]);

  const headRecorded = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const again = await cli('integrations', 'record');
  assert.match(again.stdout, /Nothing to record: 2 deliveries already have their receipts\./);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), headRecorded, 'a repeat commits nothing');
  await cli('prepare', 'implement');
  const state = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(state.currentPhase, 'implement', 'the Story carries on after its receipts');
  assert.equal(state.phases.intake.status, 'approved', 'recording receipts left the approval as it was');
});
