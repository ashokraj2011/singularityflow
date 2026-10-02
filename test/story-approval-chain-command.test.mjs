import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { approvalChainSnapshot, approvalChainText } from '../src/approval-chain.mjs';
import { commandDefinition, resolveOperation } from '../src/command-registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function workflow() {
  return {
    schemaVersion: 2,
    workItem: {
      id: 'PAY-17', title: 'Make payment retries safe', workType: 'feature', branch: 'main'
    },
    status: 'in_progress',
    currentPhase: 'design',
    phaseOrder: ['intake', 'design', 'implementation'],
    resolution: {
      approvalAuthorities: {
        'product-approvers': { label: 'Product governance' },
        'architecture-reviewers': { label: 'Architecture review' }
      }
    },
    phases: {
      intake: {
        id: 'intake', label: 'Intake', status: 'approved', generation: 1,
        requiredArtifact: { path: 'artifacts/intake/intake.md', kind: 'document' },
        artifactSet: null,
        artifacts: [{
          path: 'singularity/work-items/PAY-17/artifacts/intake/intake.md', kind: 'document',
          status: 'published', generation: 1, sha256: 'a'.repeat(64)
        }],
        approvalPolicy: { authorities: ['product-approvers'], minimum: 1 },
        approvals: [{
          decision: 'approved', actor: { name: 'Priya Product' }, authorityGroup: 'product-approvers',
          at: '2026-08-17T01:00:00.000Z', generation: 1
        }]
      },
      design: {
        id: 'design', label: 'Solution design', status: 'awaiting_approval', generation: 2,
        requiredArtifact: { path: 'artifacts/design/design.md', kind: 'document' },
        artifactSet: {
          members: [
            { member: 'Design', path: 'artifacts/design/design.md', role: 'decision' },
            { member: 'Decision log', path: 'artifacts/design/decisions.md', role: 'evidence' }
          ]
        },
        artifacts: [{
          path: 'singularity/work-items/PAY-17/artifacts/design/design.md', kind: 'document',
          status: 'published', generation: 2, sha256: 'b'.repeat(64)
        }],
        approvalPolicy: { authorities: ['architecture-reviewers'], minimum: 2 },
        approvals: [
          {
            decision: 'approved', actor: { name: 'Alex Architect' }, authorityGroup: 'architecture-reviewers',
            at: '2026-08-17T02:00:00.000Z', generation: 2, selfApproval: true
          },
          {
            decision: 'approved', actor: { name: 'Old Reviewer' }, authorityGroup: 'architecture-reviewers',
            at: '2026-08-16T02:00:00.000Z', generation: 1, invalidatedAt: '2026-08-17T00:00:00.000Z'
          }
        ]
      },
      implementation: {
        id: 'implementation', label: 'Implementation', status: 'not_started', generation: 0,
        requiredArtifact: { path: 'artifacts/implementation/implementation.md', kind: 'document' },
        artifacts: [], approvalPolicy: { mode: 'none', authorities: [], minimum: 1 }, approvals: []
      }
    }
  };
}

test('approval chain joins phase documents, pinned authorities, and only active decisions', () => {
  const snapshot = approvalChainSnapshot(workflow());
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.summary, {
    phases: 3, documents: 4, approvalsRequired: 3, approvalsReceived: 2,
    approvalsRemaining: 1, phasesAwaitingApproval: 1
  });
  assert.equal(snapshot.phases[0].documents[0].name, 'intake.md');
  assert.equal(snapshot.phases[0].documents[0].sha256, 'a'.repeat(64));
  assert.deepEqual(snapshot.phases[1].documents.map((entry) => entry.name), ['design.md', 'Decision log']);
  assert.equal(snapshot.phases[1].approval.state, 'awaiting-approval');
  assert.equal(snapshot.phases[1].approval.authorities[0].label, 'Architecture review');
  assert.deepEqual(snapshot.phases[1].approval.approvedBy.map((entry) => entry.name), ['Alex Architect']);
  assert.equal(snapshot.phases[1].approval.approvedBy[0].selfApproval, true);
  assert.equal(snapshot.phases[1].approval.decisions[1].active, false);
  assert.equal(snapshot.phases[2].approval.state, 'not-required');
  assert.equal(snapshot.phases[2].approval.minimum, 0);
});

test('a policy-mode phase reads as policy approved only when the waiver completed it', () => {
  const state = (phase) => {
    const story = workflow();
    story.phases.design = {
      ...story.phases.design,
      approvalPolicy: { mode: 'policy', policy: 'quick-fix-low-risk-v1', authorities: ['architecture-reviewers'], minimum: 1 },
      approvals: [], ...phase
    };
    return approvalChainSnapshot(story).phases[1].approval;
  };
  const approver = { decision: 'approved', actor: { name: 'Alex Architect' }, authorityGroup: 'architecture-reviewers', at: '2026-08-17T02:00:00.000Z', generation: 2 };
  const waived = state({ status: 'approved', approvalDisposition: 'policy_waived' });
  assert.deepEqual([waived.state, waived.minimum, waived.received], ['policy-approved', 0, 0]);
  assert.equal(state({ status: 'in_progress' }).state, 'policy-pending');
  // The waiver did not cover this generation, so people decide it like any other phase.
  const reviewing = state({ status: 'awaiting_approval' });
  assert.deepEqual([reviewing.state, reviewing.minimum, reviewing.remaining], ['awaiting-approval', 1, 1]);
  const approved = state({ status: 'approved', approvals: [approver] });
  assert.deepEqual([approved.state, approved.minimum, approved.received], ['approved', 1, 1]);
  // A waiver an earlier round recorded does not relabel a phase people approved since.
  assert.equal(state({ status: 'approved', approvalDisposition: 'policy_waived', approvals: [approver] }).state, 'approved');
  assert.equal(state({ status: 'rejected' }).state, 'returned-for-rework');
  const story = workflow();
  story.phases.design = { ...story.phases.design, status: 'approved', approvalPolicy: { mode: 'policy', authorities: ['architecture-reviewers'], minimum: 1 }, approvals: [approver] };
  assert.match(approvalChainText(approvalChainSnapshot(story)), /Approvals: 1\/1 · approved/);
});

test('a phase still waiting for a required group is not shown approved, and a cancelled Story is not complete', () => {
  const policy = { mode: 'required', minimum: 1, authorities: ['reviewers', 'security'], requiredAuthorities: ['security'] };
  const approvals = [{ decision: 'approved', authorityGroup: 'reviewers', actor: { login: 'alice', name: 'Alice' }, at: '2026-10-01T00:00:00Z', generation: 1 }];
  const story = (status, currentPhase, phaseStatus) => ({
    workItem: { id: 'CHAIN-9', title: 'Waiting for security', workType: 'feature', branch: 'CHAIN-9' }, status, currentPhase,
    phaseOrder: ['design'],
    phases: { design: { id: 'design', label: 'Design', status: phaseStatus, generation: 1, approvals, approvalPolicy: policy, artifacts: [] } },
    resolution: { approvalAuthorities: { reviewers: { label: 'Reviewers', members: [] }, security: { label: 'Security', members: [] } } },
    history: []
  });
  const waiting = approvalChainSnapshot(story('in_progress', 'design', 'awaiting_approval'));
  assert.equal(waiting.phases[0].approval.state, 'awaiting-approval');
  assert.equal(waiting.phases[0].approval.remaining, 1);
  assert.deepEqual(waiting.phases[0].approval.waitingFor.map((entry) => entry.id), ['security']);
  assert.equal(waiting.summary.approvalsRemaining, 1);
  assert.match(approvalChainText(waiting), /still needs Security/);

  const cancelled = approvalChainText(approvalChainSnapshot(story('cancelled', null, 'awaiting_approval')));
  assert.match(cancelled, /current phase: none — cancelled/);
  assert.doesNotMatch(cancelled, /current phase: complete/);
});

test('human rendering names documents, approval counts, authorities, approvers, and invalidation history', () => {
  const output = approvalChainText(approvalChainSnapshot(workflow()));
  assert.match(output, /Approval chain — PAY-17: Make payment retries safe/);
  assert.match(output, /intake\.md/);
  assert.match(output, /design\.md, Decision log/);
  assert.match(output, /Architecture review/);
  assert.match(output, /Alex Architect ⚠ self/);
  assert.match(output, /2\/3 required human approval\(s\) recorded; 1 remaining/);
  assert.match(output, /1 earlier decision\(s\) were invalidated/);
});

test('approvals is a read-only structured command and approval-chain is its alias', () => {
  const command = commandDefinition('approval-chain');
  assert.equal(command.name, 'approvals');
  assert.equal(command.classification, 'read');
  assert.equal(command.output, 'human-or-json');
  const operation = resolveOperation({ requestedCommand: 'approval-chain', positionals: ['approvals', 'PAY-17'], options: {} });
  assert.equal(operation.id, 'approvals');
  assert.equal(operation.classification, 'read');
  assert.equal(operation.modelPolicy, 'never');
});

test('the CLI renders the approval chain without changing repository state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-approvals-'));
  t.after(() => spawnSync('rm', ['-rf', root]));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Approval Tester'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'approval@example.com'], { cwd: root });
  const directory = path.join(root, 'singularity', 'work-items', 'PAY-17');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'workflow.json'), `${JSON.stringify(workflow(), null, 2)}\n`);
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;

  const human = spawnSync(process.execPath, [cli, 'approvals', 'PAY-17'], { cwd: root, encoding: 'utf8' });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Solution design/);
  assert.match(human.stdout, /Decision log/);

  const structured = spawnSync(process.execPath, [cli, 'approval-chain', 'PAY-17', '--json'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(structured.status, 0, structured.stderr);
  const payload = JSON.parse(structured.stdout);
  assert.equal(payload.operation.id, 'approvals');
  assert.equal(payload.data.approvalChain.workItem.id, 'PAY-17');
  assert.equal(payload.data.approvalChain.phases[1].approval.remaining, 1);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, before);
});
