import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planRevisionCodeChecks } from '../src/revision/code-check-plan.mjs';
import { projectRevisionCodeCheckResult } from '../src/revision/code-check-result.mjs';
import { probeRevisionCodeChecks, verifyRevisionCodeCheckRunPlan } from '../src/revision/code-check-runner.mjs';
import { sgosRevisionCandidateReference } from '../src/revision/candidate-adapter.mjs';
import { freezeSgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

async function fixture(t, qualityCommands) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-code-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Revision Test');
  git('config', 'user.email', 'revision@example.com');
  await writeFile(path.join(root, 'app.txt'), 'before\n');
  git('add', 'app.txt');
  git('commit', '-m', 'baseline');
  await writeFile(path.join(root, 'app.txt'), 'candidate\n');
  const retained = await freezeSgosCandidate(root, {
    subjectId: 'PAY-142:implementation',
    createdBy: { kind: 'human', id: 'revision@example.com' }
  });
  const candidateReference = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  const phase = { id: 'implementation', generation: 1, qualityCommands };
  const proofProfileSha256 = H('b');
  const environmentSha256 = H('c');
  const plan = await planRevisionCodeChecks({
    root, candidateReference, phase, proofProfileSha256, environmentSha256
  });
  return { root, candidateReference, phase, proofProfileSha256, environmentSha256, plan };
}

const check = {
  id: 'unit-tests', kind: 'test', argv: ['npm', 'test', '--', '--runInBand'],
  modelPolicy: 'never',
  workingDirectory: '.', affectedRoots: ['src', 'test'],
  result: { adapter: 'junit-xml', path: '.sflow/results/unit.xml' }, timeoutMs: 1000
};

test('Code-check probe rebuilds the exact plan before any executor callback', async (t) => {
  const base = await fixture(t, [check]);
  let calls = 0;
  const executeIsolatedCheck = async () => { calls += 1; return { exitCode: 0, stdout: '', stderr: '' }; };
  await assert.rejects(probeRevisionCodeChecks({
    ...base, plan: { ...base.plan, checks: [{ ...base.plan.checks[0], argv: ['sh', '-c', 'true'] }] },
    executeIsolatedCheck
  }), { code: 'REV_CODE_CHECK_PLAN_STALE' });
  await assert.rejects(probeRevisionCodeChecks({
    ...base, candidateReference: { ...base.candidateReference, candidateSha256: H('0') },
    executeIsolatedCheck
  }), { code: 'REV_CODE_CHECK_PLAN_INVALID' });
  assert.equal(calls, 0);
  assert.deepEqual(await verifyRevisionCodeCheckRunPlan(base), base.plan);
});

test('missing executor and unregistered checks fail closed without inventing a pass', async (t) => {
  const configured = await fixture(t, [check]);
  await assert.rejects(probeRevisionCodeChecks(configured), {
    code: 'REV_CODE_CHECK_EXECUTOR_UNAVAILABLE'
  });
  const empty = await fixture(t, []);
  const result = await probeRevisionCodeChecks({ ...empty, executeIsolatedCheck: () => {
    throw new Error('No check may run.');
  } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.receiptSha256, null);
  assert.equal(result.publicationEligibilityEstablished, false);
});

test('bounded executor observations are explicitly non-authoritative and omit raw output', async (t) => {
  const base = await fixture(t, [check]);
  let seen;
  const result = await probeRevisionCodeChecks({
    ...base,
    executeIsolatedCheck: async (request, signal) => {
      seen = request;
      assert.equal(signal.aborted, false);
      assert.deepEqual(request.argv, check.argv);
      assert.equal(request.candidateTree, base.candidateReference.repository.candidateTree);
      return { exitCode: 0, stdout: 'secret test output', stderr: '' };
    }
  });
  assert.equal(seen.kind, 'revision-code-check-probe-request');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'ISOLATION_AND_RECEIPT_PROVENANCE_UNVERIFIED');
  assert.equal(result.observations[0].status, 'observed-unverified');
  assert.equal(result.observations[0].observedExitCode, 0);
  assert.match(result.observations[0].stdoutSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('secret test output'), false);
  assert.equal(result.receiptSha256, null);
  assert.equal(result.publicationEligibilityEstablished, false);
  assert.equal(result.testingVerificationStatus, 'not-established-by-code-probe');
  assert.throws(() => { seen.argv[0] = 'sh'; }, TypeError);
});

test('timeout and oversized output cannot produce a receipt', async (t) => {
  const base = await fixture(t, [{ ...check, timeoutMs: 1000 }]);
  await assert.rejects(probeRevisionCodeChecks({
    ...base, executeIsolatedCheck: () => new Promise(() => {})
  }), { code: 'REV_CODE_CHECK_TIMEOUT_UNVERIFIED' });
  await assert.rejects(probeRevisionCodeChecks({
    ...base, executeIsolatedCheck: async () => ({
      exitCode: 0, stdout: 'x'.repeat(1024 * 1024 + 1), stderr: ''
    })
  }), { code: 'REV_CODE_CHECK_OUTPUT_OVERFLOW' });
});

test('the planner-only check lacks result receipt bindings; no hashes are synthesized', async (t) => {
  const base = await fixture(t, [check]);
  await assert.rejects(projectRevisionCodeCheckResult({
    candidateReference: base.candidateReference, verifyCandidate: async () => true,
    phaseId: base.phase.id, phaseGeneration: base.phase.generation,
    configSha256: H('d'), proofProfileSha256: base.proofProfileSha256,
    environmentSha256: base.environmentSha256,
    registeredChecks: base.plan.checks,
    readVerifiedReceipt: async () => { throw new Error('No receipt reader should be reached.'); }
  }), { code: 'REV_CODE_RESULT_INPUT' });
});
