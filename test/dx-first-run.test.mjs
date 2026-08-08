import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runFirstRunGuide } from '../src/first-run-guide.mjs';

test('end-to-end-under-budget', async () => {
  const result = await runFirstRunGuide({ keep: true });
  const boundary = path.dirname(result.repository);
  try {
    assert.equal(result.completed, true);
    assert.equal(result.networkAccess, false);
    assert.equal(result.modelInvocations, 0);
    assert.equal(result.workId, 'TOY-001');
    assert.equal(result.interactionCount, 1);
    assert.equal(result.typedCommandCount, 1);
    assert.match(result.finalStateSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.steps.length, 8);
    assert.ok(result.steps.every((step) => step.output.length <= 4_050));
    const workflow = JSON.parse(await readFile(path.join(
      result.repository,
      'singularity/work-items/TOY-001/workflow.json'
    ), 'utf8'));
    assert.equal(workflow.status, 'complete');
    assert.deepEqual(workflow.phaseOrder, ['implement', 'verify']);
    assert.equal(workflow.phases.implement.approvalPolicy.mode, 'none');
    assert.equal(workflow.phases.verify.approvalPolicy.mode, 'policy');
    const waiver = workflow.history.find((entry) => entry.event === 'phase-approval-waived');
    assert.equal(waiver.policyId, 'quick-fix-low-risk-v1');
    assert.ok(Object.values(waiver.predicates).every(Boolean));
    assert.match(waiver.policyHash, /^[0-9a-f]{64}$/);
    assert.equal(workflow.phases.verify.approvals.length, 0,
      'a deterministic waiver is never represented as a human approval');
    const packets = await Promise.all(workflow.lineage.submissions.map(async (submission) => JSON.parse(
      await readFile(path.join(result.repository, submission.path), 'utf8')
    )));
    assert.deepEqual(
      packets.map((packet) => [packet.phase, packet.status]),
      [['implement', 'complete_no_review'], ['verify', 'policy_waived']],
      'review packets distinguish deterministic completion from a policy waiver'
    );
  } finally {
    await rm(boundary, { recursive: true, force: true });
  }
});

test('successful first run removes its sandbox unless it is explicitly retained', async () => {
  const result = await runFirstRunGuide();
  await assert.rejects(access(path.dirname(result.repository)), { code: 'ENOENT' });
  assert.equal(result.retained, false);
});
