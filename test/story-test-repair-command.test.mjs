import assert from 'node:assert/strict';
import test from 'node:test';
import { repairStoryTestReadiness } from '../src/commands/story-test-repair.mjs';
import { sealTrpRecord, trpDigest } from '../src/test-recovery-policy.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';

const BASE = 'a'.repeat(40);
const REPAIR = 'b'.repeat(40);
const PLAN = trpDigest('reviewed readiness plan');
function fixture() {
  const f = createTrpFixture();
  const agreement = sealTrpRecord({ ...f.agreement, repositories: f.agreement.repositories.map(row => ({ ...row, baselineDisposition: 'fix' })) });
  const original = { schemaVersion: 1, evidencePurpose: 'baseline-admission-only', repositories: [
    { repositoryId: 'service', baseCommit: BASE, status: 'unknown', receiptSha256: null }
  ] };
  const workflow = { workItem: { id: 'story-1' }, currentPhase: 'code',
    resolution: { testRecoveryInitialReadiness: structuredClone(original) },
    testRecovery: { agreementSha256: agreement.recordSha256, readiness: structuredClone(original) } };
  const core = { schemaVersion: 1, kind: 'repository-readiness-receipt', scope: 'dependency-test',
    sourceTrackedOnly: true, status: 'pass', sourceCommit: REPAIR,
    sourceManifestSha256: trpDigest('source'), platform: process.platform, arch: process.arch, planId: PLAN,
    structuredTestContract: { commands: [{ id: 'unit', adapter: 'node-tap', minimumDiscovered: 1 }] },
    commandResults: [{ id: 'unit', purpose: 'test', status: 'pass', exitCode: 0 }],
    testObservations: [{ commandId: 'unit', adapter: 'node-tap', status: 'available',
      report: { sha256: trpDigest('report') }, counts: { discovered: 1, passed: 1, failed: 0, skipped: 0 } }] };
  const receipt = { ...core, receiptSha256: trpDigest(core) };
  const calls = [];
  let inTransaction = false;
  const store = {
    async transact(value, event, message, transition, options) {
      calls.push(['transaction', event, message, options]);
      assert.equal(value, workflow);
      inTransaction = true;
      try { return { value: await transition(value), publication: { pending: false, pushed: REPAIR } }; }
      finally { inTransaction = false; }
    },
    async sync(value) { calls.push(['sync', value]); return { pending: false, pushed: REPAIR }; }
  };
  const dependencies = {
    async loadAcceptedStoryExecution() { calls.push(['load']); return { config: {}, workflow }; },
    async verifyWorkflowSnapshot(_root, _config, _workflow, options) {
      assert.equal(options.requireAccepted, true); return { enrolled: true };
    },
    async loadStoryTestRecoveryAgreement() { return agreement; },
    workDir: () => '/repository/.sflow/work/story-1',
    async storyPublicationPending(_root, _config, _id, options) { assert.equal(options.migrate, false); return null; },
    head: () => REPAIR,
    changes: () => [' M test/unit.test.mjs'],
    inspectTrpRepairScope: () => ({ status: 'bounded-readiness-repair', blockers: [], entries: [], changeSetSha256: trpDigest('source-diff') }),
    async previewTrpReadinessRepair(_root, options) {
      calls.push(['preview', options]);
      return { repairCommit: REPAIR, plan: { planId: PLAN, sourceCommit: REPAIR, blockers: [] } };
    },
    async executeRepositoryReadinessPlan(_root, options) {
      calls.push(['execute', options]); return { receipt };
    },
    async withSubjectLock(_root, subject, callback) { calls.push(['lock', subject]); return callback(); },
    createStore: () => store,
    async appendTrpRepairEvidence(_workRoot, value) { assert.equal(inTransaction, true); calls.push(['evidence', value]); return {}; },
    async appendTrpReadinessCheckpoint(_workRoot, value) { assert.equal(inTransaction, true); calls.push(['checkpoint', value]);
      return { relativePath: `context/test-recovery/readiness-checkpoints/${value.checkpointSha256.slice(7)}.json` }; }
  };
  const args = { root: '/repository', workId: 'story-1', repositoryId: 'service' };
  const run = (options = {}, extra = {}) => repairStoryTestReadiness({ ...args, ...options }, { ...dependencies, ...extra });
  return { ...f, agreement, workflow, original, calls, receipt, dependencies, run };
}

test('repair plan is read-only, binds the original/current checkpoint and gives one exact legal run action', async () => {
  const f = fixture();
  const plan = await f.run();
  assert.equal(plan.status, 'ready-for-confirmation');
  assert.equal(plan.originalBaseCommit, BASE);
  assert.equal(plan.repairCommit, REPAIR);
  assert.equal(plan.readinessPlanId, PLAN);
  assert.deepEqual(plan.preserved.originalReadiness, f.original);
  assert.ok(plan.legalActions[0].args.includes(plan.confirmation));
  assert.deepEqual(f.calls.map(call => call[0]), ['load', 'preview']);
  assert.deepEqual(f.workflow.testRecovery.readiness, f.original);
});

test('repair refuses missing or stale confirmation before executing any command', async () => {
  const f = fixture();
  await assert.rejects(f.run({ execute: true }), { code: 'TRP_REPAIR_CONFIRMATION_REQUIRED' });
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.run({ execute: true, confirmation: trpDigest('stale') }), { code: 'TRP_REPAIR_CONFIRMATION_MISMATCH' });
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
});

test('passing repair appends exact evidence inside one normal transaction and preserves original readiness', async () => {
  const f = fixture();
  const plan = await f.run();
  const result = await f.run({ execute: true, confirmation: plan.confirmation });
  assert.equal(result.status, 'recorded');
  assert.equal(result.evidencePurpose, 'baseline-admission-only');
  const transaction = f.calls.find(call => call[0] === 'transaction');
  assert.equal(transaction[1].type, 'test-readiness-repaired');
  assert.equal(transaction[3].expectedLocalHead, REPAIR);
  assert.deepEqual(f.calls.find(call => call[0] === 'execute')[1], { confirmation: PLAN, scope: 'dependency-test' });
  assert.deepEqual(f.workflow.resolution.testRecoveryInitialReadiness, f.original);
  assert.deepEqual(f.workflow.testRecovery.readinessHistory, [f.original]);
  assert.equal(f.workflow.testRecovery.readiness.repositories[0].originalBaseCommit, BASE);
  assert.equal(f.workflow.testRecovery.readiness.repositories[0].featureBaseCommit, REPAIR);
  assert.deepEqual(f.calls.filter(call => ['execute', 'transaction', 'evidence', 'checkpoint'].includes(call[0])).map(call => call[0]),
    ['execute', 'transaction', 'evidence', 'checkpoint']);
});

test('exact repeated repair is idempotent and resumes only pending transport without rerunning tests', async () => {
  const f = fixture();
  const plan = await f.run();
  await f.run({ execute: true, confirmation: plan.confirmation });
  f.calls.length = 0;
  const repeated = await f.run({ execute: true, confirmation: plan.confirmation });
  assert.equal(repeated.status, 'already-recorded');
  assert.equal(repeated.executed, false);
  assert.equal(f.calls.some(call => call[0] === 'execute' || call[0] === 'transaction'), false);
  f.calls.length = 0;
  const synced = await f.run({ execute: true, confirmation: plan.confirmation }, { storyPublicationPending: async () => ({ commit: REPAIR }) });
  assert.equal(synced.reused, true);
  assert.equal(f.calls.filter(call => call[0] === 'sync').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'execute' || call[0] === 'transaction'), false);
  assert.equal(f.workflow.testRecovery.readinessHistory.length, 1);
});

test('dirty setup/test source is shown for review without executing, staging, cleaning or claiming a pass', async () => {
  for (const code of ['REPOSITORY_READINESS_TRACKED_DIRTY', 'REPOSITORY_READINESS_UNTRACKED_SOURCE']) {
    const f = fixture();
    const previewTrpReadinessRepair = async () => { throw Object.assign(new Error('dirty'), { code }); };
    const result = await f.run({}, { previewTrpReadinessRepair });
    assert.equal(result.status, 'needs-checkpoint');
    assert.deepEqual(result.workingTree, [' M test/unit.test.mjs']);
    assert.equal(f.calls.some(call => call[0] === 'execute' || call[0] === 'transaction'), false);
    assert.deepEqual(f.workflow.testRecovery.readiness, f.original);
  }
});

test('runner failure, source movement and malformed passing reports cannot create a checkpoint', async () => {
  for (const kind of ['failed', 'moved', 'malformed']) {
    const f = fixture();
    const plan = await f.run();
    let headReads = 0;
    const extra = kind === 'failed'
      ? { executeRepositoryReadinessPlan: async () => { throw Object.assign(new Error('test failed'), { code: 'REPOSITORY_READINESS_FAILED' }); } }
      : kind === 'moved'
        ? { head: () => ++headReads === 1 ? REPAIR : 'c'.repeat(40) }
        : { executeRepositoryReadinessPlan: async () => ({ receipt: { ...f.receipt, testObservations: [] } }) };
    await assert.rejects(f.run({ execute: true, confirmation: plan.confirmation }, extra), {
      code: kind === 'failed' ? 'REPOSITORY_READINESS_FAILED' : kind === 'moved' ? 'TRP_REPAIR_CHECKPOINT_STALE' : 'TRP_REPAIR_EVIDENCE_INVALID'
    });
    assert.equal(f.calls.some(call => call[0] === 'transaction'), false);
    assert.deepEqual(f.workflow.testRecovery.readiness, f.original);
  }
});

test('legacy/unaccepted Stories and mismatched repository selection cannot enter repair execution', async () => {
  const f = fixture();
  await assert.rejects(f.run({}, { verifyWorkflowSnapshot: async () => ({ enrolled: false }) }), { code: 'TRP_REPAIR_SNAPSHOT_REQUIRED' });
  await assert.rejects(f.run({}, { loadStoryTestRecoveryAgreement: async () => null }), { code: 'TRP_NOT_ENABLED' });
  await assert.rejects(f.run({ repositoryId: 'other' }), { code: 'TRP_READINESS_REPOSITORY_INVALID' });
  assert.equal(f.calls.some(call => call[0] === 'execute' || call[0] === 'transaction'), false);
});

test('multi-repository and pending-publication prerequisites are explicit and cannot secretly run commands', async () => {
  const f = fixture();
  const multi = sealTrpRecord({ ...f.agreement, repositories: [...f.agreement.repositories,
    { ...f.agreement.repositories[0], repositoryId: 'ui' }] });
  const coordinated = await f.run({}, { loadStoryTestRecoveryAgreement: async () => multi });
  assert.equal(coordinated.status, 'external-prerequisite');
  assert.deepEqual(coordinated.requiredRepositories, ['service', 'ui']);
  const pending = await f.run({}, { storyPublicationPending: async () => ({ commit: REPAIR }) });
  assert.equal(pending.status, 'publication-pending');
  assert.equal(pending.legalActions[0].command, 'recover');
  assert.equal(f.calls.some(call => call[0] === 'preview' || call[0] === 'execute' || call[0] === 'transaction'), false);
});

test('readiness changes invalidate the reviewed outer confirmation even when runner commands are unchanged', async () => {
  const f = fixture();
  const before = await f.run();
  f.workflow.testRecovery.readiness.repositories[0].status = 'failing-tests';
  const after = await f.run();
  assert.notEqual(before.confirmation, after.confirmation);
  await assert.rejects(f.run({ execute: true, confirmation: before.confirmation }), { code: 'TRP_REPAIR_CONFIRMATION_MISMATCH' });
  assert.equal(f.calls.some(call => call[0] === 'execute'), false);
});

test('out-of-scope repair diff returns its owned review prerequisite and cannot run', async () => {
  const f = fixture();
  const extra = { inspectTrpRepairScope: () => ({ blockers: [{ oldPath: 'src/product.mjs', newPath: 'src/product.mjs' }] }) };
  const plan = await f.run({}, extra);
  assert.equal(plan.status, 'scope-review-required');
  assert.equal(plan.owner, 'story-owner');
  await assert.rejects(f.run({ execute: true, confirmation: trpDigest('anything') }, extra), { code: 'TRP_REPAIR_PREREQUISITE' });
  assert.equal(f.calls.some(call => call[0] === 'execute' || call[0] === 'transaction'), false);
});
