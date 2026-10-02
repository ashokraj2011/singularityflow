import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { composeEvidenceReceipt, renderEvidenceReceipt } from '../src/evidence-receipt.mjs';
import { storyPullRequestBody } from '../src/pull-request.mjs';
import { run } from '../src/util.mjs';

function git(root, args) { return run('git', args, { cwd: root }); }

test('submission evidence is concise, honest, and reproducible from durable inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-receipt-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Golden Journey']);
  git(root, ['config', 'user.email', 'golden@example.com']);
  await writeFile(path.join(root, 'app.js'), 'export const ready = false;\n');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-q', '-m', 'base']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  git(root, ['checkout', '-q', '-b', 'WRK-1']);
  await writeFile(path.join(root, 'app.js'), 'export const ready = true;\n');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-q', '-m', 'implement']);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  const workflow = {
    workItem: { id: 'WRK-1', branch: 'WRK-1', baseCommit },
    resolution: { spec: { coverage: 'off' } },
    phases: {
      implementation: {
        qualityCommands: [['npm', 'test']],
        approvalPolicy: { mode: 'required', minimum: 2 }
      }
    },
    lineage: { submissions: [{ packetSha256: 'f'.repeat(64), path: 'singularity/work-items/WRK-1/submissions/implementation/f.json' }] }
  };
  const packet = {
    workId: 'WRK-1', phase: 'implementation', generation: 2,
    sourceCommit, sourceTreeSha256: 'tree-sha256', submittedBranch: 'WRK-1',
    packetSha256: 'f'.repeat(64), status: 'awaiting_review',
    authorship: { producer: 'governed-agent' },
    agentBriefs: [{ status: 'ready', integritySha256: 'b'.repeat(64) }],
    checks: [{ id: 'test', status: 'passed' }],
    approvals: [{ decision: 'approved', actor: 'reviewer-1' }]
  };
  const first = await composeEvidenceReceipt(root, { git: { publish: 'required' } }, workflow, packet);
  const replay = await composeEvidenceReceipt(root, { git: { publish: 'required' } }, structuredClone(workflow), structuredClone(packet));
  assert.deepEqual(replay, first);
  assert.equal(first.changes.count, 1);
  assert.equal(first.checks.passed, 1);
  assert.equal(first.approvals.current, 1);
  assert.equal(first.approvals.required, 2);
  assert.equal(first.context.status, 'exact');
  assert.equal(first.publication.state, 'unverified', 'publication policy alone is not publication evidence');
  assert.equal(first.publication.status, 'unavailable');
  assert.equal(first.receiptSha256, first.receiptCoreSha256);
  assert.equal(first.observations.sha256, first.observationSha256);
  git(root, ['update-ref', 'refs/remotes/origin/WRK-1', sourceCommit]);
  const publishedObservation = await composeEvidenceReceipt(
    root, { git: { publish: 'required' } }, structuredClone(workflow), structuredClone(packet)
  );
  assert.equal(publishedObservation.publication.state, 'published');
  assert.equal(publishedObservation.receiptCoreSha256, first.receiptCoreSha256,
    'the immutable receipt identity does not depend on a clone-local remote-tracking ref');
  assert.notEqual(publishedObservation.observationSha256, first.observationSha256,
    'live publication reachability remains independently auditable');
  assert.match(renderEvidenceReceipt(first), /Evidence receipt: WRK-1/);
  const pullRequest = storyPullRequestBody({
    ...workflow,
    workItem: { ...workflow.workItem, title: 'Receipt proof', workType: 'quick-fix' },
    phaseOrder: ['implementation'],
    phases: { implementation: { ...workflow.phases.implementation, id: 'implementation', status: 'awaiting_approval', approvals: [] } }
  }, { story: { acceptanceCriteria: ['Receipt is visible'] } }, { evidenceReceipt: first });
  assert.match(pullRequest, /### Submission evidence receipt/);
  assert.match(pullRequest, new RegExp(first.receiptSha256));
  assert.match(pullRequest, new RegExp(first.reviewPacket.sha256));
  assert.doesNotMatch(JSON.stringify(first), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('every recorded check lands in one count, and accepted risk stays a failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-receipt-counts-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Golden Journey']);
  git(root, ['config', 'user.email', 'golden@example.com']);
  await writeFile(path.join(root, 'app.js'), 'export const ready = true;\n');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-q', '-m', 'base']);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const workflow = {
    workItem: { id: 'WRK-2', branch: 'WRK-2' }, resolution: { spec: { coverage: 'off' } },
    phases: { implementation: { qualityCommands: [['npm', 'test'], ['npm', 'run', 'trp'], ['npm', 'run', 'lint']], approvalPolicy: { mode: 'required', minimum: 1 } } },
    lineage: { submissions: [] }
  };
  const packet = {
    workId: 'WRK-2', phase: 'implementation', generation: 1, sourceCommit, sourceTreeSha256: 'tree',
    packetSha256: 'e'.repeat(64), status: 'awaiting_review', authorship: { producer: 'human' }, approvals: [],
    checks: [
      { id: 'test', status: 'passed' },
      { id: 'trp', status: 'unavailable', requirement: 'required' },
      { id: 'lint', status: 'failed', disposition: 'accepted-risk' }
    ]
  };
  const receipt = await composeEvidenceReceipt(root, { git: { publish: 'off' } }, workflow, packet);
  assert.deepEqual({ ...receipt.checks }, {
    status: 'exact', configured: 3, recorded: 3, passed: 1, failed: 1, unavailable: 1, acceptedRisk: 1
  });
  assert.match(renderEvidenceReceipt(receipt), /Checks: 1 passed · 1 failed · 1 unavailable \(exact\) · 1 under accepted risk/);
});

test('missing source and requirement authorities are unavailable, never zero', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-gjy-receipt-missing-'));
  const receipt = await composeEvidenceReceipt(root, { spec: { coverage: 'enforce' }, git: { publish: 'off' } }, {
    workItem: { id: 'WRK-2', branch: 'WRK-2', baseCommit: 'missing' },
    resolution: { spec: { coverage: 'enforce' } }, phases: { verification: {} }, lineage: { submissions: [] }
  }, {
    phase: 'verification', generation: 1, sourceCommit: 'missing', sourceTreeSha256: null,
    submittedBranch: 'WRK-2', packetSha256: 'a'.repeat(64), status: 'awaiting_review',
    authorship: { producer: 'governed-agent' }, checks: [], approvals: []
  });
  assert.equal(receipt.changes.status, 'unavailable');
  assert.equal(receipt.changes.count, null);
  assert.equal(receipt.requirements.status, 'unavailable');
  assert.equal(receipt.requirements.clauses, null);
  assert.equal(receipt.context.status, 'unavailable');
});
