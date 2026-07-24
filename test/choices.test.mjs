import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  beginCustomSelectionReceipt,
  consumeSelectionReceipt,
  selectionReceiptStatus
} from '../src/choices.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Choice Tester' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options) {
  return run(process.execPath, [bin, ...args], root, options);
}

function flowAsync(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Choice Tester' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) resolve({ stdout, stderr });
      else reject(new Error(`choices process exited ${status}\n${stdout}\n${stderr}`));
    });
  });
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-choices-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Choice Tester'], root);
  run('git', ['config', 'user.email', 'choice@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Selection receipt test\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('one-time selection receipt lets Copilot start work without a persistent TTY bridge', async () => {
  const root = await repository();
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-101', '--json']).stdout);
  assert.equal(begun.action, 'start');
  assert.equal(begun.workId, 'CHOICE-101');
  assert.deepEqual(begun.choiceSets.map((item) => item.id), ['intake-source', 'workflow-template', 'persona']);
  assert.ok(begun.choiceSets.find((item) => item.id === 'workflow-template').options.some((item) => item.id === 'bugfix'));
  const receiptFile = path.join(root, '.git', 'singularity-flow', 'choices', `${begun.token}.json`);
  assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);

  flow(root, ['choices', 'answer', begun.token, 'intake-source', 'manual', '--json']);
  flow(root, ['choices', 'answer', begun.token, 'workflow-template', 'bugfix', '--json']);
  const ready = JSON.parse(flow(root, ['choices', 'answer', begun.token, 'persona', 'developer', '--json']).stdout);
  assert.equal(ready.ready, true);

  const started = flow(root, ['start', 'CHOICE-101', '--title', 'Receipt-backed start', '--selection-receipt', begun.token]);
  assert.match(started.stdout, /CHOICE-101 — Receipt-backed start/);
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'CHOICE-101');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity', 'work-items', 'CHOICE-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.workItem.workType, 'bugfix');
  const session = JSON.parse(await readFile(path.join(root, '.git', 'singularity-flow', 'session.json'), 'utf8'));
  assert.equal(session.persona, 'developer');
  assert.equal(flow(root, ['choices', 'status', begun.token, '--json'], { allowFailure: true }).status, 1);
});

test('selection receipts reject incomplete, mismatched, invalid, and stale choices', async () => {
  const root = await repository();
  let receipt = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-201', '--json']).stdout);
  const invalid = flow(root, ['choices', 'answer', receipt.token, 'persona', 'not-configured', '--json'], { allowFailure: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown persona/);
  const incomplete = flow(root, ['start', 'CHOICE-201', '--title', 'Incomplete', '--selection-receipt', receipt.token], { allowFailure: true });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /incomplete: Intake source/);

  flow(root, ['choices', 'answer', receipt.token, 'intake-source', 'manual']);
  flow(root, ['choices', 'answer', receipt.token, 'workflow-template', 'feature']);
  flow(root, ['choices', 'answer', receipt.token, 'persona', 'architect']);
  const mismatch = flow(root, ['start', 'OTHER-201', '--title', 'Mismatch', '--selection-receipt', receipt.token], { allowFailure: true });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /for start CHOICE-201, not start OTHER-201/);

  receipt = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-202', '--json']).stdout);
  await writeFile(path.join(root, 'HEAD-CHANGED.md'), '# changed\n');
  run('git', ['add', 'HEAD-CHANGED.md'], root);
  run('git', ['commit', '-m', 'change head'], root);
  const stale = flow(root, ['start', 'CHOICE-202', '--title', 'Stale', '--selection-receipt', receipt.token], { allowFailure: true });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stale because the repository HEAD changed/);
});

test('approval receipt keeps persona selection and exact phase confirmation inside Copilot', async () => {
  const root = await repository();
  const workId = 'CHOICE-APPROVE-1';
  const start = JSON.parse(flow(root, ['choices', 'begin', 'start', workId, '--json']).stdout);
  flow(root, ['choices', 'answer', start.token, 'intake-source', 'manual']);
  flow(root, ['choices', 'answer', start.token, 'workflow-template', 'feature']);
  flow(root, ['choices', 'answer', start.token, 'persona', 'product-owner']);
  flow(root, ['start', workId, '--title', 'Receipt-backed approval', '--selection-receipt', start.token]);

  const workflowFile = path.join(root, 'singularity', 'work-items', workId, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifactFile = path.join(root, 'singularity', 'work-items', workId, workflow.phases.intake.requiredArtifact.path);
  const artifact = (await readFile(artifactFile, 'utf8')).replace(/TODO:[^\n]*/g, 'Reviewed scope and measurable acceptance evidence for AC-001.');
  await writeFile(artifactFile, artifact);
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);

  const begun = JSON.parse(flow(root, ['choices', 'begin', 'approve', workId, '--fetch', '--json']).stdout);
  assert.equal(begun.action, 'approve');
  assert.equal(begun.approvalContext.phase, 'intake');
  assert.equal(begun.approvalContext.generation, 1);
  assert.ok(begun.approvalContext.artifacts[0].sha256);
  assert.deepEqual(begun.choiceSets.map((item) => item.id), ['persona', 'phase-confirmation']);
  assert.deepEqual(begun.choiceSets[0].options.map((item) => item.id), ['product-owner']);

  const wrongConfirmation = flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'requirements'], { allowFailure: true });
  assert.equal(wrongConfirmation.status, 1);
  assert.match(wrongConfirmation.stderr, /Allowed: intake/);
  flow(root, ['choices', 'answer', begun.token, 'persona', 'product-owner']);
  const incomplete = flow(root, ['approve', workId, '--selection-receipt', begun.token], { allowFailure: true });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /incomplete: Exact phase confirmation/);
  const ready = JSON.parse(flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']).stdout);
  assert.equal(ready.ready, true);
  const bypass = flow(root, ['approve', workId, '--yes', '--selection-receipt', begun.token], { allowFailure: true });
  assert.equal(bypass.status, 1);
  assert.match(bypass.stderr, /Do not combine --selection-receipt with --yes/);

  const approved = flow(root, ['approve', workId, '--fetch', '--selection-receipt', begun.token]);
  assert.match(approved.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  assert.match(approved.stderr, /self-approved; this is not independent review/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.intake.approvals[0].channel, 'copilot-selection-receipt');
  assert.equal(flow(root, ['choices', 'status', begun.token, '--json'], { allowFailure: true }).status, 1);
});

test('concurrent selection answers preserve every choice and leave no mutation lock behind', async () => {
  const root = await repository();
  const receipt = await beginCustomSelectionReceipt(root, {
    action: 'test',
    workId: 'CHOICE-CONCURRENT',
    choiceSets: [
      { id: 'workflow', label: 'Workflow', options: [{ id: 'feature', label: 'Feature' }] },
      { id: 'persona', label: 'Persona', options: [{ id: 'developer', label: 'Developer' }] }
    ]
  });

  await Promise.all([
    flowAsync(root, ['choices', 'answer', receipt.token, 'workflow', 'feature', '--json']),
    flowAsync(root, ['choices', 'answer', receipt.token, 'persona', 'developer', '--json'])
  ]);

  const ready = await selectionReceiptStatus(root, receipt.token);
  assert.equal(ready.ready, true);
  assert.equal(ready.answers.workflow.id, 'feature');
  assert.equal(ready.answers.persona.id, 'developer');
  const directory = path.join(root, '.git', 'singularity-flow', 'choices');
  assert.deepEqual((await readdir(directory)).filter((file) => file.endsWith('.lock')), []);
  await consumeSelectionReceipt(root, receipt.token);
});

test('selection receipt reads reject mismatched tokens, unsupported schemas, and invalid expiry timestamps', async () => {
  const root = await repository();
  const create = () => beginCustomSelectionReceipt(root, {
    action: 'test',
    workId: 'CHOICE-INTEGRITY',
    choiceSets: [{ id: 'persona', label: 'Persona', options: [{ id: 'developer', label: 'Developer' }] }]
  });

  let receipt = await create();
  let file = path.join(root, '.git', 'singularity-flow', 'choices', `${receipt.token}.json`);
  await writeFile(file, JSON.stringify({ ...receipt, token: '11111111-1111-4111-8111-111111111111' }));
  await assert.rejects(() => selectionReceiptStatus(root, receipt.token), /token does not match/i);

  receipt = await create();
  file = path.join(root, '.git', 'singularity-flow', 'choices', `${receipt.token}.json`);
  await writeFile(file, JSON.stringify({ ...receipt, schemaVersion: 999 }));
  await assert.rejects(() => selectionReceiptStatus(root, receipt.token), /version 999/i);

  receipt = await create();
  file = path.join(root, '.git', 'singularity-flow', 'choices', `${receipt.token}.json`);
  await writeFile(file, JSON.stringify({ ...receipt, expiresAt: 'not-a-date' }));
  await assert.rejects(() => selectionReceiptStatus(root, receipt.token), /expiry.*invalid/i);
});
