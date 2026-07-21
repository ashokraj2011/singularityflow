import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function exec(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return result;
}

function flow(cwd, ...args) {
  return exec(process.execPath, [bin, ...args], cwd);
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-test-'));
  exec('git', ['init', '-b', 'main'], root);
  exec('git', ['config', 'user.name', 'Singularity Flow Test'], root);
  exec('git', ['config', 'user.email', 'singularity-flow@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Test\n');
  flow(root, 'init');
  exec('git', ['add', 'README.md', '.sdlc/config.json'], root);
  exec('git', ['commit', '-m', 'initial'], root);
  return root;
}

const completedRequirements = `# TEST-101 — Requirements

## Work item

- Title: Test workflow
- Source: Manual identifier
- ID: TEST-101

## Problem statement

The team needs an automated proof that the personal Copilot skills can rely on a deterministic npm utility for branch creation, durable lifecycle state, artifact registration, approval snapshots, and phase advancement.

## Scope

### In scope

- Create an exact-ID branch and workflow state.
- Submit and approve the requirements artifact.

### Out of scope

- Network access, deployment, merge, and repository push.

## Acceptance criteria

- Branch TEST-101 is checked out.
- Requirements submission records this file.
- Approval creates a commit and advances to design.

## Dependencies and assumptions

- Git identity and Node.js are available.

## Risks and open questions

- No unresolved issue remains for this automated test.
`;

test('start, submit, and approve create durable Git state', async () => {
  const root = await repository();
  flow(root, 'start', 'TEST-101', '--title', 'Test workflow');
  assert.equal(exec('git', ['branch', '--show-current'], root).stdout.trim(), 'TEST-101');

  const requirement = path.join(root, '.sdlc', 'work-items', 'TEST-101', 'artifacts', 'requirements', 'requirements.md');
  await writeFile(requirement, completedRequirements);
  flow(root, 'artifact', 'scan');
  flow(root, 'submit');

  let workflow = JSON.parse(await readFile(path.join(root, '.sdlc', 'work-items', 'TEST-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.requirements.status, 'awaiting_approval');
  assert.equal(workflow.phases.requirements.artifacts.length, 1);

  flow(root, 'approve', '--yes', '--commit', '--by', 'Test Approver');
  workflow = JSON.parse(await readFile(path.join(root, '.sdlc', 'work-items', 'TEST-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.requirements.status, 'approved');
  assert.equal(workflow.currentPhase, 'design');
  assert.equal(workflow.phases.design.status, 'in_progress');
  assert.equal(workflow.phases.requirements.approvedBy, 'Test Approver');

  const approval = JSON.parse(await readFile(path.join(root, '.sdlc', 'work-items', 'TEST-101', 'approvals', 'requirements.json'), 'utf8'));
  assert.equal(approval.phase, 'requirements');
  assert.equal(approval.artifacts[0].path, '.sdlc/work-items/TEST-101/artifacts/requirements/requirements.md');
  assert.match(exec('git', ['log', '-1', '--pretty=%s'], root).stdout.trim(), /^TEST-101 approve requirements$/);
  assert.equal(exec('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('submission blocks placeholder artifacts', async () => {
  const root = await repository();
  flow(root, 'start', 'TEST-102');
  const result = exec(process.execPath, [bin, 'submit'], root, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TODO\/TBD\/template placeholders/);
});

function completedPhaseDocument(id, phase, title) {
  const narrative = `This ${phase} artifact records a complete, reviewed outcome for ${title}. It defines concrete responsibilities, observable results, explicit boundaries, operational considerations, verification evidence, and decisions that a subsequent contributor can understand without relying on an earlier chat session. The artifact is intentionally detailed enough to satisfy the workflow completeness guard and contains no unresolved template instructions. `;
  return `# ${id} — ${phase}\n\n## Outcome\n\n${narrative.repeat(3)}\n\n## Evidence and decisions\n\n${narrative.repeat(2)}\n`;
}

test('complete lifecycle advances through every configured phase', async () => {
  const root = await repository();
  flow(root, 'start', 'TEST-200', '--title', 'Complete lifecycle');

  for (const phaseId of ['requirements', 'design', 'implementation', 'verification', 'review', 'release']) {
    const workflowFile = path.join(root, '.sdlc', 'work-items', 'TEST-200', 'workflow.json');
    let workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    assert.equal(workflow.currentPhase, phaseId);
    const phase = workflow.phases[phaseId];
    flow(root, 'prepare', phaseId);
    const artifact = path.join(root, '.sdlc', 'work-items', 'TEST-200', phase.requiredArtifact.path);
    await writeFile(artifact, completedPhaseDocument('TEST-200', phase.label, 'Complete lifecycle'));

    if (phaseId === 'implementation') {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'feature.mjs'), 'export const featureEnabled = true;\n');
    }

    flow(root, 'artifact', 'scan');
    flow(root, 'submit');
    flow(root, 'approve', '--yes', '--commit', '--by', 'Lifecycle Approver');

    workflow = JSON.parse(await readFile(workflowFile, 'utf8'));
    assert.equal(workflow.phases[phaseId].status, 'approved');
  }

  const finalWorkflow = JSON.parse(await readFile(path.join(root, '.sdlc', 'work-items', 'TEST-200', 'workflow.json'), 'utf8'));
  assert.equal(finalWorkflow.status, 'complete');
  assert.equal(finalWorkflow.currentPhase, null);
  assert.equal(exec(process.execPath, [bin, 'validate', '--strict'], root).status, 0);
  assert.equal(exec(process.execPath, [bin, 'gate', '--terminal'], root).status, 0);
  assert.equal(exec('git', ['status', '--porcelain'], root).stdout.trim(), '');
  assert.equal(Number(exec('git', ['rev-list', '--count', 'HEAD'], root).stdout.trim()), 7);

  const approvedRequirements = path.join(root, '.sdlc', 'work-items', 'TEST-200', 'artifacts', 'requirements', 'requirements.md');
  await writeFile(approvedRequirements, `${await readFile(approvedRequirements, 'utf8')}\nChanged after approval.\n`);
  const stale = exec(process.execPath, [bin, 'gate', '--terminal'], root, { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /STALE requirements approval/);
});
