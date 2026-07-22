import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false, persona = 'product-owner', confirm = null } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Sequence Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona })
  };
  if (confirm) env.SINGULARITY_FLOW_TEST_SEQUENCE_CONFIRM = confirm;
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) {
  return execute(process.execPath, [bin, ...args], root, options);
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sequence-'));
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Sequence Tester'], root);
  execute('git', ['config', 'user.email', 'sequence@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Sequence test\n');
  flow(root, ['init']);
  const configPath = path.join(root, '.singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', '.singularity'], root);
  execute('git', ['commit', '-m', 'initialize'], root);
  flow(root, ['start', 'SEQ-1', '--title', 'Strict sequence']);
  return root;
}

function assertSequenceFailure(result, ...patterns) {
  assert.equal(result.status, 2);
  assert.match(result.stderr, /(?:Out of sequence|Soft sequence warning) \[[A-Za-z]+\]:/);
  assert.match(result.stderr, /Current state:/);
  assert.match(result.stderr, /Required next action:/);
  assert.match(result.stderr, /singularity-flow nextsteps SEQ-1/);
  assert.match(result.stderr, /(?:No workflow files, commits, or remote state were changed|Nothing was changed)/);
  for (const pattern of patterns) assert.match(result.stderr, pattern);
}

test('out-of-sequence commands exit before changing workflow, session, or Git state', async () => {
  const root = await repository();
  const workDir = path.join(root, '.singularity/work-items/SEQ-1');
  const workflowFile = path.join(workDir, 'workflow.json');
  const sessionFile = path.join(root, '.git/singularity-flow/session.json');

  const initialWorkflow = await readFile(workflowFile, 'utf8');
  const initialSession = await readFile(sessionFile, 'utf8');
  const initialHead = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  assertSequenceFailure(flow(root, ['submit'], { allowFailure: true }), /no published generation/i, /prepare intake/, /phase publish intake/);
  assert.equal(await readFile(workflowFile, 'utf8'), initialWorkflow);

  assertSequenceFailure(flow(root, ['approve', '--yes'], { allowFailure: true, persona: 'architect' }), /requires status awaiting_approval/, /prepare intake/);
  assert.equal(await readFile(sessionFile, 'utf8'), initialSession);

  assertSequenceFailure(flow(root, ['prepare', 'requirements'], { allowFailure: true }), /Only the current phase 'intake' may change/);
  assert.equal(await readFile(workflowFile, 'utf8'), initialWorkflow);
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), initialHead);
  assert.equal(execute('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('soft gates require confirmation and audit a confirmed override with the selected persona', async () => {
  const root = await repository();
  const workflowFile = path.join(root, '.singularity/work-items/SEQ-1/workflow.json');

  const blocked = flow(root, ['approve', '--yes'], { allowFailure: true, persona: 'product-owner' });
  assertSequenceFailure(blocked, /Gate mode: soft/, /interactive terminal/);

  const approved = flow(root, ['approve', '--yes'], { persona: 'product-owner', confirm: 'phaseStatus' });
  assert.match(approved.stderr, /Continuing after confirmed soft gate 'phaseStatus'/);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.intake.status, 'approved');
  assert.equal(workflow.sequenceOverrides.length, 1);
  assert.equal(workflow.sequenceOverrides[0].gate, 'phaseStatus');
  assert.equal(workflow.sequenceOverrides[0].persona, 'product-owner');
  assert.equal(workflow.sequenceOverrides[0].actor.name, 'Sequence Tester');
  assert.ok(workflow.history.some((event) => event.event === 'sequence_gate_overridden' && event.persona === 'product-owner'));

  const report = flow(root, ['report']);
  assert.match(report.stdout, /Soft sequence overrides/);
  assert.match(report.stdout, /phaseStatus/);
});

test('sequence gate policy is immutable after work-item creation', async () => {
  const root = await repository();
  const workflowFile = path.join(root, '.singularity/work-items/SEQ-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.resolution.sequenceGates.phaseStatus = 'hard';
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const validation = flow(root, ['validate'], { allowFailure: true });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Sequence gate policy differs from the immutable work-type configuration snapshot/);
});

test('Copilot session persona policy is immutable after work-item creation', async () => {
  const root = await repository();
  const workflowFile = path.join(root, '.singularity/work-items/SEQ-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.resolution.session.requireBeforeTools = false;
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const validation = flow(root, ['validate'], { allowFailure: true });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Session persona policy differs from the immutable configuration snapshot/);
});

test('submitted work blocks generation mutations and rejection requires regeneration', async () => {
  const root = await repository();
  const workDir = path.join(root, '.singularity/work-items/SEQ-1');
  const workflowFile = path.join(workDir, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifact = path.join(workDir, workflow.phases.intake.requiredArtifact.path);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete and measurable intake evidence for strict lifecycle sequencing.'));
  flow(root, ['phase', 'publish', 'intake']);

  assertSequenceFailure(flow(root, ['approve', '--yes'], { allowFailure: true, persona: 'architect' }), /submit --phase intake/);
  flow(root, ['submit']);

  const submittedWorkflow = await readFile(workflowFile, 'utf8');
  const submittedHead = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  assertSequenceFailure(flow(root, ['prepare', 'intake'], { allowFailure: true }), /approve SEQ-1 --fetch/, /reject SEQ-1 --fetch/);
  assertSequenceFailure(flow(root, ['phase', 'publish', 'intake'], { allowFailure: true }), /approve SEQ-1 --fetch/);
  assertSequenceFailure(flow(root, ['documents', 'upload', artifact], { allowFailure: true }), /cannot upload documents/, /awaiting_approval/);
  assertSequenceFailure(flow(root, ['agents', 'refresh-output', 'external-result'], { allowFailure: true }), /cannot refresh remote generated output/);
  assertSequenceFailure(flow(root, ['wm', 'inject', '--phase', 'intake'], { allowFailure: true }), /cannot compose and record a generation prompt/);
  assert.equal(await readFile(workflowFile, 'utf8'), submittedWorkflow);
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), submittedHead);

  flow(root, ['reject', '--to', 'intake', '--reason', 'Regenerate with corrected evidence']);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.status, 'in_progress');
  assert.equal(workflow.phases.intake.generation, 1);
  const rejectedWorkflow = await readFile(workflowFile, 'utf8');
  assertSequenceFailure(flow(root, ['submit'], { allowFailure: true }), /returned for correction and has not been regenerated/, /Regenerate and publish phase 'intake'/);
  assert.equal(await readFile(workflowFile, 'utf8'), rejectedWorkflow);
  assert.equal(execute('git', ['status', '--porcelain'], root).stdout.trim(), '');
});
