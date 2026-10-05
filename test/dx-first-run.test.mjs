import assert from 'node:assert/strict';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { runFirstRunGuide } from '../src/first-run-guide.mjs';
import { loadRepositoryReadinessReceipt } from '../src/initialization/runtime-readiness.mjs';
import { run } from '../src/util.mjs';
import { changedLines } from './helpers/folded-yaml.mjs';

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
    assert.match(await readFile(path.join(result.repository, 'tests/greeting.test.mjs'), 'utf8'), /@ac:TOY-001:AC-001/);
    assert.match(result.finalStateSha256, /^[0-9a-f]{64}$/);
    // Precheck plan and run, start, the five-command scope-and-plan intake, then implement and verify.
    assert.equal(result.steps.length, 15);
    const preview = result.steps[0];
    const executed = result.steps[1];
    const plan = JSON.parse(preview.rawOutput).data.plan;
    const receipt = JSON.parse(executed.rawOutput).data.receipt;
    assert.equal(preview.command, 'singularity-flow precheck --run --scope dependency-test --json');
    assert.equal(executed.command,
      `singularity-flow precheck --run --scope dependency-test --confirm-plan ${plan.planId} --json`);
    assert.match(result.steps[2].command, /^singularity-flow start TOY-001 /u);
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.commands.map((command) => command.purpose), ['test']);
    assert.equal(receipt.status, 'pass');
    assert.equal(receipt.planId, plan.planId);
    assert.equal(receipt.commandResults[0].status, 'pass');
    assert.equal(receipt.testObservations[0].counts.discovered, 1);
    assert.equal(receipt.testObservations[0].counts.passed, 1);
    assert.equal(receipt.testObservations[0].counts.failed, 0);
    const base = run('git', ['rev-parse', 'main'], { cwd: result.repository }).stdout.trim();
    assert.equal(receipt.sourceCommit, base);
    const retained = await loadRepositoryReadinessReceipt(result.repository, {
      commit: base, scope: 'dependency-test'
    });
    assert.equal(retained.receipt.receiptSha256, receipt.receiptSha256);
    const configured = await readFile(path.join(result.repository, 'singularity/workflow.yml'), 'utf8');
    const definition = YAML.parse(configured);
    assert.equal(definition.repositoryReadiness.requiredBeforeStory, false);
    // The guide's two settings are the only lines it changes in the packaged starter.
    assert.deepEqual(changedLines(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'), configured), {
      removed: ['  publish: required', '  grounding: warn'], added: ['  publish: off', '  grounding: off']
    });
    assert.equal(run('git', ['status', '--porcelain'], { cwd: result.repository }).stdout, '');
    assert.ok(result.steps.every((step) => step.output.length <= 4_050));
    const workflow = JSON.parse(await readFile(path.join(
      result.repository,
      'singularity/work-items/TOY-001/workflow.json'
    ), 'utf8'));
    assert.equal(workflow.status, 'closed');
    assert.deepEqual(workflow.phaseOrder, ['intake', 'implement', 'verify']);
    assert.equal(workflow.phases.intake.approvalPolicy.mode, 'required', 'a person signs off the scope and plan');
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
      [['intake', 'awaiting_review'], ['implement', 'complete_no_review'], ['verify', 'policy_waived']],
      'review packets distinguish a reviewed scope, deterministic completion and a policy waiver'
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
