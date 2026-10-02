import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runFirstRunGuide } from '../src/first-run-guide.mjs';
import { loadDefinition } from '../src/config.mjs';
import { runGovernanceGate } from '../src/governance.mjs';
import { verifyPhaseApprovalWaiver } from '../src/approval-waiver.mjs';
import { assertReviewCodeEvidenceFresh } from '../src/delivery-evidence.mjs';
import { readStoryReviewPacket } from '../src/story-lineage.mjs';
import { run } from '../src/util.mjs';

test('first-run completion has replayable authority and verification cannot replace tested bytes', async (t) => {
  const result = await runFirstRunGuide({ keep: true });
  const root = result.repository;
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const config = await loadDefinition(root);
  const workflow = JSON.parse(await readFile(path.join(root, 'singularity/work-items/TOY-001/workflow.json'), 'utf8'));
  const phase = workflow.phases.verify;
  const git = (...args) => run('git', args, { cwd: root });
  const guard = () => assertReviewCodeEvidenceFresh(root, config, workflow, phase);

  await t.test('automatic completion and the retained waiver satisfy the terminal gate', async () => {
    assert.equal(workflow.phases.implement.approvalPolicy.minimum, 0);
    assert.equal(phase.approvalDisposition, 'policy_waived');
    assert.equal(phase.approvals.length, 0);
    const gate = await runGovernanceGate(root, config, workflow, { terminal: true });
    assert.deepEqual(gate.errors, []);
    assert.ok(gate.passes.includes('policy waiver verified: verify'));
  });

  await t.test('waiver replay refuses changed policy, checks, predicates, digest and generation', async () => {
    for (const change of [
      (value) => { value.approvalPolicy.maximumChangedPaths = 999; },
      (value) => { value.checks[0].status = 'failed'; },
      (value) => { value.approvalWaiver.predicates.checksPassing = false; },
      (value) => { value.approvalWaiver.policySha256 = '0'.repeat(64); },
      (value) => { value.generation += 1; },
      (value) => { value.approvalDisposition = null; }
    ]) {
      const altered = structuredClone(phase);
      change(altered);
      const replay = await verifyPhaseApprovalWaiver(root, config, workflow, altered);
      assert.equal(replay.valid, false, JSON.stringify(altered));
      assert.ok(replay.errors.length);
    }
  });

  await t.test('review permits ordinary project notes and refuses unstaged, staged and committed source changes', async () => {
    await writeFile(path.join(root, 'README.md'), '# Review notes\nThe existing executable test covers the greeting.\n');
    assert.equal((await guard()).sourcePhase, 'implement');
    git('add', 'README.md'); git('commit', '-m', 'Add review notes');
    const file = path.join(root, 'greeting.txt');
    const approved = await readFile(file, 'utf8');
    await writeFile(file, 'Incorrect untested greeting.\n');
    const refuses = (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('greeting.txt');
    await assert.rejects(guard, refuses);
    git('add', 'greeting.txt');
    await assert.rejects(guard, refuses);
    git('commit', '-m', 'Commit an untested source change');
    await assert.rejects(guard, refuses);
    await writeFile(file, approved); git('add', 'greeting.txt'); git('commit', '-m', 'Restore the tested source');
    assert.equal((await guard()).sourcePhase, 'implement');
  });

  await t.test('new tests and source renamed to documentation still require Code rework', async () => {
    const newTest = path.join(root, 'tests/new.test.mjs');
    await writeFile(newTest, "import test from 'node:test'; test('not executed', () => {});\n");
    await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('tests/new.test.mjs'));
    await rm(newTest);
    await rename(path.join(root, 'greeting.txt'), path.join(root, 'NOTICE.txt'));
    git('add', 'greeting.txt', 'NOTICE.txt');
    await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
      && error.details.changedPaths.includes('greeting.txt'));
    await rename(path.join(root, 'NOTICE.txt'), path.join(root, 'greeting.txt'));
    git('add', 'greeting.txt', 'NOTICE.txt');
  });

  await t.test('tracked generated-looking paths are source and recovery commands match lifecycle status', async () => {
    for (const relative of ['build/runtime.mjs', 'coverage/runtime.test.mjs', 'dist/runtime.mjs', 'vendor/runtime.mjs']) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), 'export const untested = true;\n');
      git('add', '-f', relative);
      await assert.rejects(guard, (error) => error.code === 'PRIOR_CODE_TEST_EVIDENCE_STALE'
        && error.details.changedPaths.includes(relative)
        && error.details.repairCommand.includes('reopen TOY-001 --to implement'));
      const active = structuredClone(workflow);
      active.status = 'in_progress'; active.currentPhase = 'verify';
      for (const status of ['in_progress', 'awaiting_approval']) {
        active.phases.verify.status = status;
        await assert.rejects(() => assertReviewCodeEvidenceFresh(root, config, active, active.phases.verify), (error) => {
          assert.match(error.details.repairCommand, /reject verify --to implement/);
          assert.equal(error.details.repairCommand.includes('--repair'), status === 'in_progress');
          return true;
        });
      }
      active.lineage.submissions = active.lineage.submissions.filter((entry) => entry.phase !== 'implement');
      await assert.rejects(() => assertReviewCodeEvidenceFresh(root, config, active, active.phases.verify),
        (error) => error.details.repairCommand === null && /Restore the original governed Code submission/.test(error.message));
      git('rm', '--cached', relative); await rm(path.join(root, relative));
    }
  });

  await t.test('a hash-valid copied submission cannot bless corrupted committed reconciliation evidence', async () => {
    const packet = await readStoryReviewPacket(root, config, workflow);
    const selected = workflow.lineage.submissions.at(-1);
    const raw = JSON.parse(git('show', `${packet.evidenceCommit}:${selected.path}`).stdout);
    const reference = phase.workIntervalReconciliation;
    const report = JSON.parse(git('show', `${packet.evidenceCommit}:${reference.path}`).stdout);
    report.summary.unplanned += 1;
    await writeFile(path.join(root, reference.path), JSON.stringify(report));
    // The counterfeit packet has a valid content hash, so the sealed reconciliation must be
    // independently replayed rather than trusting its summary or the aggregate's waiver flag.
    const { packetSha256: ignored, ...base } = raw;
    base.submittedBy = { ...base.submittedBy, name: 'Counterfeit replay' };
    const digest = createHash('sha256').update(JSON.stringify(base)).digest('hex');
    const relative = selected.path.replace(selected.packetSha256, digest);
    await writeFile(path.join(root, relative), JSON.stringify({ ...base, packetSha256: digest }));
    git('add', reference.path, relative); git('commit', '-m', 'Counterfeit waiver evidence fixture');
    const forged = structuredClone(workflow);
    forged.lineage.submissions[forged.lineage.submissions.length - 1] = { ...selected,
      packetSha256: digest, path: relative };
    const replay = await verifyPhaseApprovalWaiver(root, config, forged, forged.phases.verify);
    assert.equal(replay.valid, false);
    assert.match(replay.errors.join('\n'), /reconciliation hash mismatch/i);
  });
});
