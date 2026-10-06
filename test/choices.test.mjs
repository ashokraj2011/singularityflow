import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  approvalReviewBinding,
  beginCustomSelectionReceipt,
  consumeSelectionReceipt,
  resolveSelectionReceipt,
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
  // Keep readiness enforced: this documentation-only base needs an inline no-command receipt.
  assert.equal(config.repositoryReadiness.requiredBeforeStory, false);
  // This fixture intentionally exercises the self-approval warning. The shipped normal profile is
  // team-safe; make the test's POC authority explicit instead of weakening production defaults.
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '--initial-branch=main', remote], path.dirname(root));
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

async function submitIntakeForApproval(root, workId) {
  const start = JSON.parse(flow(root, ['choices', 'begin', 'start', workId, '--json']).stdout);
  flow(root, ['choices', 'answer', start.token, 'base-branch', 'main']);
  flow(root, ['choices', 'answer', start.token, 'intake-source', 'manual']);
  flow(root, ['choices', 'answer', start.token, 'workflow-template', 'feature']);
  flow(root, ['start', workId, '--title', 'Review source binding', '--selection-receipt', start.token]);
  const workflowFile = path.join(root, 'singularity', 'work-items', workId, 'workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifactFile = path.join(
    root, 'singularity', 'work-items', workId, workflow.phases.intake.requiredArtifact.path
  );
  const artifact = (await readFile(artifactFile, 'utf8'))
    .replace(/TODO:[^\n]*/g, 'Reviewed scope and measurable acceptance evidence for AC-001.');
  await writeFile(artifactFile, artifact);
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);
  return workflowFile;
}

test('one-time selection receipt lets Copilot start work without a persistent TTY bridge', async () => {
  const root = await repository();
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-101', '--json']).stdout);
  assert.equal(begun.action, 'start');
  assert.equal(begun.workId, 'CHOICE-101');
  assert.deepEqual(begun.choiceSets.map((item) => item.id), ['base-branch', 'intake-source', 'workflow-template']);
  assert.ok(begun.choiceSets.find((item) => item.id === 'workflow-template').options.some((item) => item.id === 'bugfix'));
  const receiptFile = path.join(root, '.git', 'singularity-flow', 'choices', `${begun.token}.json`);
  assert.equal((await stat(receiptFile)).mode & 0o777, 0o600);

  flow(root, ['choices', 'answer', begun.token, 'base-branch', 'main', '--json']);
  flow(root, ['choices', 'answer', begun.token, 'intake-source', 'manual', '--json']);
  const ready = JSON.parse(flow(root, ['choices', 'answer', begun.token, 'workflow-template', 'bugfix', '--json']).stdout);
  assert.equal(ready.ready, true);

  const started = flow(root, ['start', 'CHOICE-101', '--title', 'Receipt-backed start', '--selection-receipt', begun.token]);
  assert.match(started.stdout, /CHOICE-101 — Receipt-backed start/);
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'CHOICE-101');
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity', 'work-items', 'CHOICE-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.workItem.workType, 'bugfix');
  const session = JSON.parse(await readFile(path.join(root, '.git', 'singularity-flow', 'session.json'), 'utf8'));
  assert.equal(session.agent, 'product-owner');
  assert.equal(flow(root, ['choices', 'status', begun.token, '--json'], { allowFailure: true }).status, 1);
});

test('selection receipts reject incomplete, mismatched, invalid, and stale choices', async () => {
  const root = await repository();
  let receipt = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-201', '--json']).stdout);
  const invalid = flow(root, ['choices', 'answer', receipt.token, 'agent', 'not-configured', '--json'], { allowFailure: true });
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).error.message, /has no choice 'agent'/);
  flow(root, ['choices', 'answer', receipt.token, 'base-branch', 'main']);
  const incomplete = flow(root, ['start', 'CHOICE-201', '--title', 'Incomplete', '--selection-receipt', receipt.token], { allowFailure: true });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /incomplete: Intake source/);

  flow(root, ['choices', 'answer', receipt.token, 'intake-source', 'manual']);
  flow(root, ['choices', 'answer', receipt.token, 'workflow-template', 'feature']);
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

test('approval receipt keeps exact phase confirmation inside Copilot and uses the phase agent', async () => {
  const root = await repository();
  const workId = 'CHOICE-APPROVE-1';
  const start = JSON.parse(flow(root, ['choices', 'begin', 'start', workId, '--json']).stdout);
  flow(root, ['choices', 'answer', start.token, 'base-branch', 'main']);
  flow(root, ['choices', 'answer', start.token, 'intake-source', 'manual']);
  flow(root, ['choices', 'answer', start.token, 'workflow-template', 'feature']);
  flow(root, ['start', workId, '--title', 'Receipt-backed approval', '--selection-receipt', start.token]);

  const workflowFile = path.join(root, 'singularity', 'work-items', workId, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifactFile = path.join(root, 'singularity', 'work-items', workId, workflow.phases.intake.requiredArtifact.path);
  const artifact = (await readFile(artifactFile, 'utf8')).replace(/TODO:[^\n]*/g, 'Reviewed scope and measurable acceptance evidence for AC-001.');
  await writeFile(artifactFile, artifact);
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);

  const displayed = JSON.parse(flow(root, ['phase', 'show', 'intake', '--json']).stdout);
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'approve', workId, '--fetch', '--json']).stdout);
  assert.equal(begun.action, 'approve');
  assert.equal(begun.approvalContext.phase, 'intake');
  assert.equal(begun.approvalContext.generation, 1);
  assert.match(begun.approvalContext.planId, /^[0-9a-f]{24}$/);
  assert.ok(begun.approvalContext.artifacts[0].sha256);
  assert.deepEqual(begun.choiceSets.map((item) => item.id), ['phase-confirmation']);
  assert.deepEqual(displayed.reviewBinding, {
    repositoryPath: await realpath(root),
    repositoryHead: begun.repositoryHead,
    workId,
    phase: begun.approvalContext.phase,
    generation: begun.approvalContext.generation,
    reviewPacketSha256: begun.approvalContext.reviewPacketSha256,
    submittedSourceCommit: begun.approvalContext.submittedSourceCommit
  }, 'the displayed submission and the fresh receipt bind the exact same review');
  assert.ok(displayed.reviewBinding.reviewPacketSha256);
  assert.ok(displayed.reviewBinding.submittedSourceCommit);

  const wrongConfirmation = flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'requirements'], { allowFailure: true });
  assert.equal(wrongConfirmation.status, 1);
  assert.match(wrongConfirmation.stderr, /Allowed: intake/);
  const incomplete = flow(root, ['approve', workId, '--selection-receipt', begun.token], { allowFailure: true });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /incomplete: Exact phase confirmation/);
  const ready = JSON.parse(flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']).stdout);
  assert.equal(ready.ready, true);
  const wrongPhase = flow(root, [
    'approve', 'requirements', '--work-id', workId, '--selection-receipt', begun.token
  ], { allowFailure: true });
  assert.notEqual(wrongPhase.status, 0);
  assert.match(wrongPhase.stderr, /out of sequence|current phase|not active/i);
  assert.equal(JSON.parse(flow(root, ['choices', 'status', begun.token, '--json']).stdout).ready, true);
  const bypass = flow(root, ['approve', workId, '--yes', '--selection-receipt', begun.token], { allowFailure: true });
  assert.equal(bypass.status, 1);
  assert.match(bypass.stderr, /Do not combine --selection-receipt with --yes/);

  const approved = flow(root, ['approve', 'intake', '--work-id', workId, '--fetch', '--selection-receipt', begun.token]);
  assert.match(approved.stdout, /Approval decision committed [0-9a-f]{8} locally/);
  assert.match(approved.stderr, /self-approved; this is not independent review/);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.intake.approvals[0].channel, 'copilot-selection-receipt');
  assert.equal(workflow.phases.intake.approvals[0].actionContext.planId, begun.approvalContext.planId);
  assert.deepEqual(
    workflow.phases.intake.approvals[0].artifactSha256,
    begun.approvalContext.artifacts
  );
  assert.equal(flow(root, ['choices', 'status', begun.token, '--json'], { allowFailure: true }).status, 1);
  const approvedHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const repeated = flow(root, [
    'approve', 'intake', '--work-id', workId, '--selection-receipt', begun.token
  ], { allowFailure: true });
  assert.notEqual(repeated.status, 0);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), approvedHead,
    'a consumed approval cannot create a second decision commit');
  assert.equal(JSON.parse(await readFile(workflowFile, 'utf8')).phases.intake.approvals.length, 1);
});

test('untracked runner reports do not block receipt preparation or approval and are never committed', async t => {
  const root = await repository();
  t.after(() => rm(root, { recursive: true, force: true }));
  const workId = 'CHOICE-REPORTS';
  const workflowFile = await submitIntakeForApproval(root, workId);
  const resultDirectory = path.join(root, '.sflow', 'results');
  await mkdir(resultDirectory, { recursive: true });
  const reportFile = path.join(resultDirectory, 'node-tests.json');
  await writeFile(reportFile, '{"passed":16}\n');
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'approve', workId, '--fetch', '--json']).stdout);
  flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']);
  await writeFile(reportFile, '{"passed":32}\n');
  // An actual authoring edit still blocks the final receipt-backed action without consuming it.
  await writeFile(path.join(root, 'README.md'), '# Edited after review\n');
  const refused = flow(root, ['approve', 'intake', '--work-id', workId, '--selection-receipt', begun.token, '--json'], { allowFailure: true });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /LIFECYCLE_WORKTREE_REVIEW_REQUIRED/u);
  assert.match(refused.stdout, /sf-recover/u);
  await writeFile(path.join(root, 'README.md'), run('git', ['show', 'HEAD:README.md'], root).stdout);
  const approved = flow(root, ['approve', 'intake', '--work-id', workId, '--fetch', '--selection-receipt', begun.token]);
  assert.equal(approved.status, 0);
  assert.equal(JSON.parse(await readFile(workflowFile, 'utf8')).phases.intake.status, 'approved');
  assert.equal(await readFile(reportFile, 'utf8'), '{"passed":32}\n');
  assert.equal(run('git', ['ls-files', '--error-unmatch', '.sflow/results/node-tests.json'], root, { allowFailure: true }).status, 1);
});

test('approval receipts reject changed generation, packet, artifacts, and repository HEAD', async () => {
  const root = await repository();
  const workId = 'CHOICE-APPROVE-CONTEXT-DRIFT';
  const workflowFile = await submitIntakeForApproval(root, workId);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const definition = YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'));
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'approve', workId, '--fetch', '--json']).stdout);
  flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']);
  const resolve = (current) => resolveSelectionReceipt(root, definition, begun.token, {
    action: 'approve', workId, workflow: current
  });
  assert.equal((await resolve(workflow)).answers['phase-confirmation'], 'intake');
  for (const [change, mutate] of [
    ['generation', (current) => { current.phases.intake.generation += 1; }],
    ['packet', (current) => { current.lineage.submissions.at(-1).packetSha256 = `sha256:${'a'.repeat(64)}`; }],
    ['artifact', (current) => { current.phases.intake.artifacts[0].sha256 = 'b'.repeat(64); }]
  ]) {
    const current = structuredClone(workflow);
    mutate(current);
    await assert.rejects(() => resolve(current), /stale because the action context changed/,
      `${change} drift must require a fresh review`);
    await assert.rejects(() => approvalReviewBinding(root, definition, current),
      /submitted review packet|immutable Git commit/,
      `${change} drift cannot be displayed as a verified review binding`);
  }
  const submittedHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  run('git', ['commit', '--allow-empty', '-m', 'test review-time HEAD drift'], root);
  await assert.rejects(() => resolve(workflow), /stale because the repository HEAD changed/);
  assert.notEqual(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), submittedHead);
  const preserved = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(preserved.currentPhase, 'intake');
  assert.equal(preserved.phases.intake.status, 'awaiting_approval');
  assert.deepEqual(preserved.phases.intake.approvals, []);
  assert.equal(JSON.parse(flow(root, ['choices', 'status', begun.token, '--json']).stdout).ready, true,
    'a refusal does not consume an unrecorded decision');
});

test('approval cannot absorb application source committed after submission', async () => {
  const root = await repository();
  const workId = 'CHOICE-APPROVE-SOURCE-DRIFT';
  const workflowFile = await submitIntakeForApproval(root, workId);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'premature-implementation.mjs'), 'export const premature = true;\n');
  run('git', ['add', 'src/premature-implementation.mjs'], root);
  run('git', ['commit', '-m', 'premature implementation during intake review'], root);

  const begun = JSON.parse(flow(root, [
    'choices', 'begin', 'approve', workId, '--fetch', '--json'
  ]).stdout);
  flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']);
  const refused = flow(root, [
    'approve', 'intake', '--work-id', workId, '--fetch', '--selection-receipt', begun.token
  ], { allowFailure: true });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /application source or tests changed after generation 1 was submitted/i);
  assert.match(refused.stderr, /Approval cannot absorb implementation created during review/i);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'intake');
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');
  assert.deepEqual(workflow.phases.intake.approvals, []);
  assert.equal(JSON.parse(flow(root, ['choices', 'status', begun.token, '--json']).stdout).ready, true);
});

test('approval refuses an unrelated commit even when application bytes are unchanged', async () => {
  const root = await repository();
  const workId = 'CHOICE-APPROVE-HISTORY-DRIFT';
  const workflowFile = await submitIntakeForApproval(root, workId);
  run('git', ['commit', '--allow-empty', '-m', 'unrelated review-time commit'], root);

  const begun = JSON.parse(flow(root, [
    'choices', 'begin', 'approve', workId, '--fetch', '--json'
  ]).stdout);
  flow(root, ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json']);
  const refused = flow(root, [
    'approve', 'intake', '--work-id', workId, '--fetch', '--selection-receipt', begun.token
  ], { allowFailure: true });

  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /repository history changed after its immutable review evidence/i);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'intake');
  assert.equal(workflow.phases.intake.status, 'awaiting_approval');
  assert.deepEqual(workflow.phases.intake.approvals, []);
});

test('concurrent selection answers preserve every choice and leave no mutation lock behind', async () => {
  const root = await repository();
  const receipt = await beginCustomSelectionReceipt(root, {
    action: 'test',
    workId: 'CHOICE-CONCURRENT',
    choiceSets: [
      { id: 'workflow', label: 'Workflow', options: [{ id: 'feature', label: 'Feature' }] },
      { id: 'agent', label: 'Agent', options: [{ id: 'developer', label: 'Developer' }] }
    ]
  });

  await Promise.all([
    flowAsync(root, ['choices', 'answer', receipt.token, 'workflow', 'feature', '--json']),
    flowAsync(root, ['choices', 'answer', receipt.token, 'agent', 'developer', '--json'])
  ]);

  const ready = await selectionReceiptStatus(root, receipt.token);
  assert.equal(ready.ready, true);
  assert.equal(ready.answers.workflow.id, 'feature');
  assert.equal(ready.answers.agent.id, 'developer');
  const directory = path.join(root, '.git', 'singularity-flow', 'choices');
  assert.deepEqual((await readdir(directory)).filter((file) => file.endsWith('.lock')), []);
  await consumeSelectionReceipt(root, receipt.token);
});

test('selection receipt reads reject mismatched tokens, unsupported schemas, and invalid expiry timestamps', async () => {
  const root = await repository();
  const create = () => beginCustomSelectionReceipt(root, {
    action: 'test',
    workId: 'CHOICE-INTEGRITY',
    choiceSets: [{ id: 'agent', label: 'Agent', options: [{ id: 'developer', label: 'Developer' }] }]
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

test('selection receipt storage failures never disclose the bearer token', async () => {
  const root = await repository();
  const receipt = await beginCustomSelectionReceipt(root, {
    action: 'test',
    workId: 'CHOICE-STORAGE',
    choiceSets: [{ id: 'agent', label: 'Agent', options: [{ id: 'developer', label: 'Developer' }] }]
  });
  const file = path.join(root, '.git', 'singularity-flow', 'choices', `${receipt.token}.json`);
  await rm(file);
  await mkdir(file);
  await assert.rejects(() => selectionReceiptStatus(root, receipt.token), (error) => {
    assert.equal(error.code, 'SELECTION_RECEIPT_STORAGE_UNAVAILABLE');
    assert.doesNotMatch(error.message, new RegExp(receipt.token));
    return true;
  });
});

test('a selection receipt made in the launch checkout drives an isolated Story start', async () => {
  const root = await repository();
  const begun = JSON.parse(flow(root, ['choices', 'begin', 'start', 'CHOICE-301', '--json']).stdout);
  flow(root, ['choices', 'answer', begun.token, 'base-branch', 'main', '--json']);
  flow(root, ['choices', 'answer', begun.token, 'intake-source', 'manual', '--json']);
  flow(root, ['choices', 'answer', begun.token, 'workflow-template', 'bugfix', '--json']);
  // Unrelated work in the launch checkout sends the Story to its own worktree.
  await writeFile(path.join(root, 'unfinished.txt'), 'not part of the Story\n');
  const started = JSON.parse(flow(root, [
    'start', 'CHOICE-301', '--json', '--title', 'Isolated receipt start', '--selection-receipt', begun.token
  ]).stdout);
  const result = started.data ?? started;
  const storyRoot = result.worktree?.repositoryPath;
  assert.ok(storyRoot, 'the Story started in its own checkout');
  assert.equal(run('git', ['branch', '--show-current'], storyRoot).stdout.trim(), 'CHOICE-301');
  const workflow = JSON.parse(await readFile(
    path.join(storyRoot, 'singularity', 'work-items', 'CHOICE-301', 'workflow.json'), 'utf8'
  ));
  assert.equal(workflow.workItem.workType, 'bugfix', 'the recorded choices were used');
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main', 'the launch checkout stayed put');
  assert.equal(await readFile(path.join(root, 'unfinished.txt'), 'utf8'), 'not part of the Story\n');
  assert.equal(flow(root, ['choices', 'status', begun.token, '--json'], { allowFailure: true }).status, 1,
    'the receipt was consumed where it was recorded');
});
