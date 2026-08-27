import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { acquireSubjectLock, releaseSubjectLock } from '../src/subject-lock.mjs';
import { enforceSequenceGate, withConfirmationPort } from '../src/sequence.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function execute(command, args, cwd, { allowFailure = false, agent = 'product-owner', confirm = null } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Sequence Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent })
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
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  // This fixture deliberately lets one synthetic identity drive and approve the whole flow.
  // Keep that POC behavior explicit now that installed workflows default to team-safe approval.
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/agents'], root);
  execute('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  execute('git', ['init', '--bare', '-b', 'main', remote], root);
  execute('git', ['remote', 'add', 'origin', remote], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'SEQ-1', '--from-branch', 'main', '--title', 'Strict sequence']);
  return root;
}

function assertSequenceFailure(result, ...patterns) {
  assert.equal(result.status, 2);
  assert.match(result.stderr, /(?:Out of sequence|Soft sequence warning) \[[A-Za-z]+\]:/);
  assert.match(result.stderr, /Current state:/);

  // The guidance moved from hand-written prose into the narrated result, so these assert the
  // guarantees rather than the old wording: the refusal explains itself with a cataloged reason,
  // states what it preserved — derived from declared effects, not a sentence beside the throw — and
  // offers at least one runnable command instead of a Copilot skill name.
  if (/Out of sequence/.test(result.stderr)) {
    // Hard refusals carry a narrated result. Soft warnings do not yet, and still use the legacy
    // guidance prose; they are asserted below on the wording they still own.
    assert.match(result.stderr, /\nWhy:\n/);
    assert.match(result.stderr, /\nNext:\n/);
    assert.match(result.stderr, /^ {2}NOW\s+\S/m, 'a ranked next action is offered');
    assert.match(result.stderr, /^ {8}singularity-flow \S/m, 'the next action is a runnable command');
    assert.match(result.stderr, /No governed state, files, publications or external systems were changed\./);
  } else {
    assert.match(result.stderr, /Required next action:/);
    // Soft warnings still use the legacy guidance prose, which ranks its actions — "Run next",
    // "Then", "Alternative". What matters is that the runnable command leads the line, whichever
    // rank it carries, rather than sitting under a Copilot skill name.
    assert.match(result.stderr, /^(Run next|Then|Alternative|Run): singularity-flow \S/m,
      'the guidance leads with a runnable command');
    assert.doesNotMatch(result.stderr, /^[A-Za-z ]*in Copilot: \/sf-\S+\n(Run|Then|Alternative)/m,
      'a Copilot skill is headlining a command instead of annotating it');
  }
  for (const pattern of patterns) assert.match(result.stderr, pattern);
}

test('out-of-sequence commands exit before changing workflow, session, or Git state', async () => {
  const root = await repository();
  const workDir = path.join(root, 'singularity/work-items/SEQ-1');
  const workflowFile = path.join(workDir, 'workflow.json');
  const sessionFile = path.join(root, '.git/singularity-flow/session.json');

  const initialWorkflow = await readFile(workflowFile, 'utf8');
  const initialSession = await readFile(sessionFile, 'utf8');
  const initialHead = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  assertSequenceFailure(flow(root, ['submit'], { allowFailure: true }), /no published generation/i, /prepare intake/, /phase publish intake/);
  assert.equal(await readFile(workflowFile, 'utf8'), initialWorkflow);

  assertSequenceFailure(flow(root, ['approve', '--yes'], { allowFailure: true, agent: 'architect' }), /requires status awaiting_approval/, /prepare intake/);
  assert.equal(await readFile(sessionFile, 'utf8'), initialSession);

  assertSequenceFailure(flow(root, ['prepare', 'requirements'], { allowFailure: true }), /Only the current phase 'intake' may change/);
  assert.equal(await readFile(workflowFile, 'utf8'), initialWorkflow);
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), initialHead);
  assert.equal(execute('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('--json emits one parseable structured refusal without terminal logs', async () => {
  const root = await repository();
  const result = flow(root, ['submit', '--json'], { allowFailure: true });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  const refusal = JSON.parse(result.stderr);
  assert.equal(refusal.resultType, 'command-result');
  assert.equal(refusal.outcome.status, 'refused');
  assert.equal(refusal.effects.stateChanged, false);
  assert.doesNotMatch(result.stderr, /command\.failed|Out of sequence|\bNOW\s{2,}/);
});

test('review, submit, and approve use the same positional phase grammar', async () => {
  const root = await repository();
  const initialBranch = execute('git', ['branch', '--show-current'], root).stdout.trim();

  const review = flow(root, ['review', 'intake']);
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /intake/i);

  assertSequenceFailure(flow(root, ['submit', 'intake'], { allowFailure: true }), /no published generation/i);

  const positionalApproval = flow(root, ['approve', 'intake', '--yes'], { allowFailure: true, agent: 'architect' });
  assertSequenceFailure(positionalApproval, /requires status awaiting_approval/);
  assert.doesNotMatch(positionalApproval.stderr, /Branch intake does not exist/);

  const explicitWorkItem = flow(root, ['approve', 'intake', '--work-id', 'SEQ-1', '--yes'], { allowFailure: true, agent: 'architect' });
  assertSequenceFailure(explicitWorkItem, /requires status awaiting_approval/);

  const conflictingSubmit = flow(root, ['submit', 'intake', '--phase', 'requirements'], { allowFailure: true });
  assert.notEqual(conflictingSubmit.status, 0);
  assert.match(conflictingSubmit.stderr, /received two different phases/);

  const unknown = flow(root, ['approve', 'intke', '--yes'], { allowFailure: true, agent: 'architect' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /not a configured phase or an available Work ID/);
  assert.match(unknown.stderr, /--work-id <WORK-ID>/);
  assert.equal(execute('git', ['branch', '--show-current'], root).stdout.trim(), initialBranch);
});

test('soft gates require confirmation and audit a confirmed override with the selected agent', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/work-items/SEQ-1/workflow.json');

  // Build a real immutable submission packet, then put only the aggregate status back one step.
  // The soft-gate test may override sequencing, but it must not bypass approval evidence.
  const artifactPath = path.join(root, 'singularity/work-items/SEQ-1/artifacts/intake/intake.md');
  let artifact = await readFile(artifactPath, 'utf8');
  artifact = artifact
    .replace(/TODO:[^\n]*/g, 'The governed sequence fixture has complete, reviewable evidence for this field.')
    .replace(/\bTODO\b/g, 'complete evidence');
  artifact += '\n\nThe scope, expected outcome, review boundary, and recovery behavior are explicit for this sequence-gate fixture.\n';
  await writeFile(artifactPath, artifact);
  flow(root, ['phase', 'publish', 'intake', '--authored', 'human']);
  flow(root, ['submit', 'intake', '--skip-checks']);
  const setup = JSON.parse(await readFile(workflowFile, 'utf8'));
  setup.phases.intake.status = 'in_progress';
  await writeFile(workflowFile, `${JSON.stringify(setup, null, 2)}\n`);
  execute('git', ['add', '.'], root);
  execute('git', ['commit', '-m', 'fixture: restore soft-gate state with immutable evidence'], root);

  const blocked = flow(root, ['approve', '--yes'], { allowFailure: true, agent: 'product-owner' });
  assertSequenceFailure(blocked, /Gate mode: soft/, /interactive terminal/);

  const approved = flow(root, ['approve', '--yes'], { agent: 'product-owner', confirm: 'phaseStatus' });
  assert.match(approved.stderr, /Continuing after confirmed soft gate 'phaseStatus'/);
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');
  assert.equal(workflow.phases.intake.status, 'approved');
  assert.equal(workflow.sequenceOverrides.length, 1);
  assert.equal(workflow.sequenceOverrides[0].gate, 'phaseStatus');
  assert.equal(workflow.sequenceOverrides[0].agent, 'product-owner');
  assert.equal(workflow.sequenceOverrides[0].actor.name, 'Sequence Tester');
  assert.ok(workflow.history.some((event) => event.event === 'sequence_gate_overridden' && event.agent === 'product-owner'));

  const report = flow(root, ['report']);
  assert.match(report.stdout, /Soft sequence overrides/);
  assert.match(report.stdout, /phaseStatus/);
});

test('soft-gate session audit resolves the real Git directory in a linked worktree', async () => {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-sequence-worktree-main-'));
  const linked = await mkdtemp(path.join(os.tmpdir(), 'sflow-sequence-worktree-linked-'));
  execute('git', ['init', '-b', 'main'], repositoryRoot);
  execute('git', ['config', 'user.name', 'Worktree Tester'], repositoryRoot);
  execute('git', ['config', 'user.email', 'worktree@example.com'], repositoryRoot);
  await writeFile(path.join(repositoryRoot, 'README.md'), '# linked worktree\n');
  execute('git', ['add', 'README.md'], repositoryRoot);
  execute('git', ['commit', '-m', 'initialize'], repositoryRoot);
  execute('git', ['worktree', 'add', '-b', 'linked-story', linked], repositoryRoot);
  const localGitDirectory = execute('git', ['rev-parse', '--absolute-git-dir'], linked).stdout.trim();
  await mkdir(path.join(localGitDirectory, 'singularity-flow'), { recursive: true });
  await writeFile(path.join(localGitDirectory, 'singularity-flow', 'session.json'), JSON.stringify({
    actor: { name: 'Linked Worktree User' }, agent: 'developer'
  }));
  const workflow = {
    workItem: { id: 'LINKED-1' }, currentPhase: 'implementation', status: 'active',
    phases: { implementation: { id: 'implementation', status: 'in_progress', generation: 1 } },
    resolution: { sequenceGates: { phaseStatus: 'soft' } }, history: []
  };
  await withConfirmationPort(async () => true, () => enforceSequenceGate(
    linked, workflow, 'phaseStatus', 'test linked worktree audit', { requestedPhase: 'implementation' }
  ));
  assert.equal(workflow.sequenceOverrides[0].actor.name, 'Linked Worktree User');
  assert.equal(workflow.sequenceOverrides[0].agent, 'developer');
});

test('sequence gate policy is immutable after work-item creation', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/work-items/SEQ-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.resolution.sequenceGates.phaseStatus = 'hard';
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const validation = flow(root, ['validate'], { allowFailure: true });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Sequence gate policy differs from the immutable work-type configuration snapshot/);
});

test('Copilot session agent policy is immutable after work-item creation', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/work-items/SEQ-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  workflow.resolution.session.requireBeforeTools = true;
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const validation = flow(root, ['validate'], { allowFailure: true });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Session governed-agent policy differs from the immutable configuration snapshot/);
});

test('incomplete schema-2 session snapshots are rejected instead of migrated', async () => {
  const root = await repository();
  const workflowFile = path.join(root, 'singularity/work-items/SEQ-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  delete workflow.resolution.session.workItemSelection;
  await writeFile(workflowFile, `${JSON.stringify(workflow, null, 2)}\n`);
  const validation = flow(root, ['validate'], { allowFailure: true });
  assert.equal(validation.status, 2);
  assert.match(validation.stderr, /Session governed-agent policy differs from the immutable configuration snapshot/);
});

test('submitted work blocks generation mutations and rejection requires regeneration', async () => {
  const root = await repository();
  const workDir = path.join(root, 'singularity/work-items/SEQ-1');
  const workflowFile = path.join(workDir, 'workflow.json');
  let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  const artifact = path.join(workDir, workflow.phases.intake.requiredArtifact.path);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete and measurable intake evidence for strict lifecycle sequencing.'));
  flow(root, ['phase', 'publish', 'intake']);
  const exactGenerationCommit = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeFile(path.join(root, 'unrelated.txt'), 'A later commit cannot impersonate the generation by reusing its subject.\n');
  execute('git', ['add', 'unrelated.txt'], root);
  execute('git', ['commit', '-m', '[SEQ-1][phase:intake][generated:1] decoy subject'], root);

  assertSequenceFailure(flow(root, ['approve', '--yes'], { allowFailure: true, agent: 'architect' }), /submit intake/);
  flow(root, ['submit']);
  workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(workflow.phases.intake.generationCommit, exactGenerationCommit,
    'a later commit with the same generation subject replaced the transaction-bound generation commit');

  const submittedWorkflow = await readFile(workflowFile, 'utf8');
  const submittedHead = execute('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  // A repeated host action is a read-only success before the publication unit opens. Holding the
  // mutation lock proves the retry neither tries to take that lock nor creates a journal while it
  // reports the already-committed state.
  const subject = { kind: 'story', id: 'SEQ-1', branch: 'SEQ-1' };
  const owner = await acquireSubjectLock(root, subject);
  const repeated = flow(root, ['submit']);
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /intake is already awaiting approval/i);
  assert.equal(await readFile(workflowFile, 'utf8'), submittedWorkflow);
  assert.equal(execute('git', ['rev-parse', 'HEAD'], root).stdout.trim(), submittedHead);
  assertSequenceFailure(flow(root, ['prepare', 'intake'], { allowFailure: true }), /approve intake --work-id SEQ-1 --fetch/, /reject intake --work-id SEQ-1 --fetch/);
  assertSequenceFailure(flow(root, ['phase', 'publish', 'intake'], { allowFailure: true }), /approve intake --work-id SEQ-1 --fetch/);
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
