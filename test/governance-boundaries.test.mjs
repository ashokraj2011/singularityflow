import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  approvedConfigurationMaterializations,
  generationAuthorship,
  generationReachedReview,
  generationRequiresGrounding
} from '../src/governance.mjs';
import {
  gateRecoveryReopenPlan,
  verifyGateRecoveryReopenPlan
} from '../src/gate-recovery.mjs';

test('protected configuration materialization is exempt only at its pinned regular-file digest', () => {
  const matching = 'a'.repeat(64);
  const changed = 'b'.repeat(64);
  const workflow = { resolution: { configurationSource: { files: {
    'singularity/workflow.yml': matching,
    '.github/agents/developer.agent.md': matching,
    'singularity/templates/common/implementation.md': matching
  } } } };
  const changeSet = { entries: [
    {
      status: 'modified', oldPath: 'singularity/workflow.yml', newPath: 'singularity/workflow.yml',
      newContent: { kind: 'regular-file', sha256: `sha256:${matching}` }
    },
    {
      status: 'modified', oldPath: '.github/agents/developer.agent.md', newPath: '.github/agents/developer.agent.md',
      newContent: { kind: 'regular-file', sha256: `sha256:${changed}` }
    },
    {
      status: 'modified', oldPath: 'singularity/templates/common/implementation.md', newPath: 'singularity/templates/common/implementation.md',
      newContent: { kind: 'symlink', sha256: `sha256:${matching}` }
    }
  ] };
  assert.deepEqual([...approvedConfigurationMaterializations(changeSet, workflow)], ['singularity/workflow.yml']);
});

test('final grounding mirrors publication authorship and does not invent a model dependency', () => {
  const phase = { authorship: [
    { generation: 1, producer: 'governed-agent' },
    { generation: 2, producer: 'human' },
    { generation: 3, producer: 'deterministic' }
  ] };
  assert.equal(generationAuthorship(phase, 2).producer, 'human');
  assert.equal(generationRequiresGrounding(phase, 1), true);
  assert.equal(generationRequiresGrounding(phase, 2), false);
  assert.equal(generationRequiresGrounding(phase, 3), false);
  assert.equal(generationRequiresGrounding(phase, 4), true, 'unattributed legacy work remains fail-closed');
});

test('submission-grade delivery evidence excludes drafts superseded before review', () => {
  const phase = {
    id: 'implementation', generation: 4, status: 'approved', submittedAt: '2026-08-27T12:00:00.000Z',
    approvals: [
      { generation: 1, decision: 'approved', invalidatedAt: '2026-08-27T13:00:00.000Z' },
      { generation: 4, decision: 'approved' }
    ]
  };
  const workflow = { lineage: { submissions: [
    { phase: 'implementation', generation: 1 },
    { phase: 'implementation', generation: 4 }
  ] } };
  assert.equal(generationReachedReview(workflow, phase, 1), true);
  assert.equal(generationReachedReview(workflow, phase, 2), false);
  assert.equal(generationReachedReview(workflow, phase, 3), false);
  assert.equal(generationReachedReview(workflow, phase, 4), true);
});

test('gate-recovery reopen confirmation is bound to HEAD, target, state, and exact findings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gate-reopen-'));
  t.after(() => execFileSync('rm', ['-rf', root]));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Gate Tester'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'gate@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# gate\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: root });
  const workflow = {
    workItem: { id: 'GATE-1' }, status: 'complete', currentPhase: null,
    phases: { convergence: { id: 'convergence' }, release: { id: 'release' } }
  };
  const finding = {
    code: 'gate.validation.failed', blocking: true, phase: 'convergence', generation: 1,
    details: { message: 'convergence phase-input record does not match' },
    recovery: { requiresReopen: true }
  };
  const plan = gateRecoveryReopenPlan(root, workflow, [finding], 'convergence');
  assert.equal(plan.allowed, true);
  assert.equal(verifyGateRecoveryReopenPlan(root, workflow, plan), true);
  assert.equal(gateRecoveryReopenPlan(root, workflow, [finding], 'release').allowed, false);

  const tampered = structuredClone(plan);
  tampered.findings[0].message = 'different finding';
  assert.equal(verifyGateRecoveryReopenPlan(root, workflow, tampered), false);

  const changedWorkflow = structuredClone(workflow);
  changedWorkflow.phases.convergence.status = 'approved';
  assert.equal(verifyGateRecoveryReopenPlan(root, changedWorkflow, plan), false);

  await writeFile(path.join(root, 'README.md'), '# changed\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'advance'], { cwd: root });
  assert.equal(verifyGateRecoveryReopenPlan(root, workflow, plan), false);
});
