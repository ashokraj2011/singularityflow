import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildTestExecutionReceipt, normalizeRequiredTestCommand } from '../src/code-delivery-tests.mjs';
import { canonicalJson } from '../src/records.mjs';
import { newAttemptIdentity } from '../src/verification/attempts.mjs';
import { beginTestCommandEpochValidation, recordTestCommandEpochValidation,
  testCommandEpochRequirement, verifyTestCommandEpochValidation } from '../src/test-command-epoch.mjs';

const digest = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const hash = digest('fixture');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
async function writeRecord(root, relative, record) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), canonicalJson(record));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-test-epoch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { workItemRoot: 'singularity/work-items' };
  const commands = [{ id: 'tests', kind: 'test', argv: ['node', '--test', 'test/a.test.mjs'],
    modelPolicy: 'never', workingDirectory: '.', affectedRoots: ['.'],
    result: { adapter: 'node-tap', path: '.sflow/results/tests.tap', minimumDiscovered: 1, minimumPassed: 1 } }];
  const publication = { generation: 1, resultDigest: hash, record: 'context/generation.json' };
  const marker = { id: 'TCA-001', state: 'required', validationEpoch: 2, generation: 1,
    publicationSha256: digest(publication), commandInventorySha256: digest(commands) };
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Epoch test'); git(root, 'config', 'user.email', 'epoch@example.test');
  git(root, 'commit', '--allow-empty', '-qm', 'Original generation');
  const oldCommit = git(root, 'rev-parse', 'HEAD');
  const decisionPath = 'singularity/work-items/ST-001/context/test-recovery/command-amendments/TCA-001-decision.json';
  const decision = { kind: 'fixture-immutable-amendment' };
  await writeRecord(root, decisionPath, decision);
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Authenticated amendment fixture');
  const phase = { id: 'implementation', generation: 1, generationCommit: oldCommit, generationTask: 'code',
    requiredArtifact: { kind: 'implementation-summary' },
    qualityCommands: commands, generationPublications: [publication], testCommandRevalidation: marker,
    checks: [{ id: 'tests', status: 'passed', requirement: 'required' }],
    deliveryEvidence: { receiptPath: 'singularity/work-items/ST-001/context/code-delivery/implementation-gen1-epoch2.json',
      receiptSha256: hash.slice(7), validation: { status: 'passed', sourceTreeSha256: hash },
      testExecutions: [{ commandId: 'tests', status: 'passed' }] } };
  const workflow = { workItem: { id: 'ST-001' }, resolution: { policySha256: hash },
    testCommandAmendments: [{ id: marker.id, phaseId: phase.id, decisionPath, decisionSha256: digest(decision),
      decidedAt: new Date(Date.now() - 1000).toISOString(),
      to: { validationEpoch: 2, commandInventorySha256: marker.commandInventorySha256, policySha256: hash },
      revalidation: { generation: 1, publicationSha256: marker.publicationSha256 } }] };
  return { root, config, workflow, phase, oldCommit };
}

async function freshRun(value) {
  const { root, workflow, phase } = value;
  const run = beginTestCommandEpochValidation(workflow, phase);
  const at = new Date().toISOString();
  phase.checks = [{ id: 'tests', status: 'passed', requirement: 'required', exitCode: 0,
    sourceCommit: git(root, 'rev-parse', 'HEAD'), sourceTreeSha256: hash, startedAt: at, completedAt: at }];
  const command = normalizeRequiredTestCommand(phase.qualityCommands[0]);
  // Each epoch run is its own immutable attempt, named by its attempt ID.
  const child = buildTestExecutionReceipt(command, phase.checks[0], { adapter: command.result.adapter,
    minimumDiscovered: 1, minimumPassed: 1, tests: { discovered: 1, passed: 1, failed: 0, skipped: 0 },
    result: { path: command.result.path, sha256: hash.slice(7), bytes: 0, files: [] } }, {
    ...newAttemptIdentity(), purpose: 'epoch', epoch: run.suffix, workId: 'ST-001', phase: 'implementation', generation: 1
  });
  const base = 'singularity/work-items/ST-001/context/code-delivery';
  const childPath = `${base}/tests/attempts/implementation/${child.attemptId}.json`;
  await writeRecord(root, childPath, child);
  phase.deliveryEvidence.testExecutions = [{ commandId: 'tests', attemptId: child.attemptId, status: 'passed', receiptPath: childPath,
    receiptSha256: digest(child).slice(7) }];
  const delivery = { testExecutions: structuredClone(phase.deliveryEvidence.testExecutions) };
  phase.deliveryEvidence.receiptPath = `${base}/implementation-gen1-${run.suffix}.json`;
  phase.deliveryEvidence.receiptSha256 = digest(delivery).slice(7);
  await writeRecord(root, phase.deliveryEvidence.receiptPath, delivery);
  return run;
}

async function rehashDelivery(value, mutateChild = null, mutateDelivery = null) {
  const { root, phase } = value;
  const delivery = JSON.parse(await readFile(path.join(root, phase.deliveryEvidence.receiptPath), 'utf8'));
  if (mutateChild) {
    const entry = delivery.testExecutions[0];
    const child = JSON.parse(await readFile(path.join(root, entry.receiptPath), 'utf8'));
    mutateChild(child);
    await writeRecord(root, entry.receiptPath, child);
    entry.receiptSha256 = digest(child).slice(7);
  }
  if (mutateDelivery) mutateDelivery(delivery);
  await writeRecord(root, phase.deliveryEvidence.receiptPath, delivery);
  phase.deliveryEvidence.receiptSha256 = digest(delivery).slice(7);
  phase.deliveryEvidence.testExecutions = structuredClone(delivery.testExecutions);
  if (phase.testCommandValidation) {
    const record = JSON.parse(await readFile(path.join(root, phase.testCommandValidation.path), 'utf8'));
    record.deliveryReceipt.sha256 = digest(delivery);
    record.checksSha256 = digest(phase.checks);
    await writeRecord(root, phase.testCommandValidation.path, record);
    phase.testCommandValidation.sha256 = digest(record);
  }
}

test('legacy phases have no additional epoch requirement', () => {
  assert.equal(testCommandEpochRequirement({}, {}), null);
  assert.equal(beginTestCommandEpochValidation({}, {}), null);
});

test('fresh same-generation attempts are append-only and bind the exact current record', async t => {
  const value = await fixture(t); const { root, config, workflow, phase } = value;
  const first = await freshRun(value);
  const reference = await recordTestCommandEpochValidation(root, config, workflow, phase, first);
  const bytes = await readFile(path.join(root, reference.path));
  const verified = await verifyTestCommandEpochValidation(root, config, workflow, phase);
  assert.equal(verified.generation, 1);
  assert.equal(verified.validationEpoch, 2);
  await assert.rejects(recordTestCommandEpochValidation(root, config, workflow, phase, first),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
  const second = await freshRun(value);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.suffix, first.suffix);
  const secondReference = await recordTestCommandEpochValidation(root, config, workflow, phase, second);
  assert.notEqual(secondReference.path, reference.path);
  assert.deepEqual(await readFile(path.join(root, reference.path)), bytes);
  await verifyTestCommandEpochValidation(root, config, workflow, phase);
  await assert.rejects(verifyTestCommandEpochValidation(root, config, workflow, phase,
    { packet: { submissionEvidence: { testCommandEpoch: reference } } }),
  { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
});

test('optional skipped checks remain visible and do not impersonate mandatory test success', async t => {
  const value = await fixture(t); const { root, config, workflow, phase } = value;
  const run = await freshRun(value);
  phase.checks.push({ id: 'optional-model', status: 'skipped-warning', requirement: 'advisory' });
  await recordTestCommandEpochValidation(root, config, workflow, phase,
    run);
  await verifyTestCommandEpochValidation(root, config, workflow, phase);
  assert.equal(phase.checks[1].status, 'skipped-warning');
});

test('an unrelated later phase amendment preserves exact earlier fresh epoch evidence', async t => {
  const value = await fixture(t); const { root, config, workflow, phase } = value;
  await recordTestCommandEpochValidation(root, config, workflow, phase,
    await freshRun(value));
  const original = await verifyTestCommandEpochValidation(root, config, workflow, phase);
  workflow.resolution.policySha256 = digest('later phase command policy');
  workflow.testCommandAmendments.push({ id: 'TCA-002', phaseId: 'integration',
    to: { validationEpoch: 3, policySha256: workflow.resolution.policySha256 } });
  const retained = await verifyTestCommandEpochValidation(root, config, workflow, phase);
  assert.deepEqual(retained, original);
  // A new epoch for the source phase itself cannot borrow that prior validation.
  const newSourceAmendment = structuredClone(workflow.testCommandAmendments[0]);
  newSourceAmendment.id = 'TCA-003';
  newSourceAmendment.to.validationEpoch = 4;
  newSourceAmendment.to.policySha256 = digest('new source epoch');
  workflow.testCommandAmendments.push(newSourceAmendment);
  phase.testCommandRevalidation.id = 'TCA-003';
  phase.testCommandRevalidation.validationEpoch = 4;
  await assert.rejects(verifyTestCommandEpochValidation(root, config, workflow, phase),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
});

test('a new attempt cannot relabel historical passing receipt paths', async t => {
  const value = await fixture(t);
  const first = await freshRun(value);
  await recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, first);
  const second = beginTestCommandEpochValidation(value.workflow, value.phase);
  await assert.rejects(recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, second),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
  await assert.rejects(recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, { ...first }),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
});

test('new epoch paths and a newly hashed aggregate cannot hide pre-amendment execution', async t => {
  const value = await fixture(t); const run = await freshRun(value);
  value.phase.checks[0].sourceCommit = value.oldCommit;
  await assert.rejects(recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, run),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
});

for (const [label, mutateChild, mutateDelivery] of [
  ['historical argv', child => { child.argvSha256 = digest(['node', '--test', 'test/old.test.mjs']).slice(7); }],
  ['another epoch', child => { child.epoch = 'epoch1-00000000-0000-4000-8000-000000000000'; }],
  ['a submission attempt', child => { child.purpose = 'submission'; }],
  ['wrong working directory', child => { child.workingDirectory = 'other'; }],
  ['wrong adapter', child => { child.adapter = 'junit-xml'; }],
  ['reduced module coverage', child => { child.affectedRoots = ['src/narrow']; }],
  ['empty passed cohort', child => { child.tests = { discovered: 0, passed: 0, failed: 0, skipped: 0 }; }],
  ['omitted required test command', null, delivery => { delivery.testExecutions = []; }]
]) {
  test(`replay rejects self-hashed replacement with ${label}`, async t => {
    const value = await fixture(t);
    await recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, await freshRun(value));
    await rehashDelivery(value, mutateChild, mutateDelivery);
    await assert.rejects(verifyTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase),
      { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
  });
}

test('replay rejects self-hashed old-source checks even when every receipt is relabelled', async t => {
  const value = await fixture(t);
  await recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, await freshRun(value));
  value.phase.checks[0].sourceCommit = value.oldCommit;
  await rehashDelivery(value);
  await assert.rejects(verifyTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase),
    { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
});

for (const [label, mutate] of [
  ['required unavailable check', value => value.phase.checks.push({ id: 'lint', status: 'unavailable', requirement: 'required' })],
  ['failed advisory check', value => value.phase.checks.push({ id: 'lint', status: 'failed', requirement: 'advisory' })],
  ['missing execution', value => { value.phase.deliveryEvidence.testExecutions = []; }],
  ['failed execution', value => { value.phase.deliveryEvidence.testExecutions[0].status = 'failed'; }],
  ['historical epoch', value => { value.phase.testCommandRevalidation.validationEpoch = 1; }],
  ['changed command', value => { value.phase.qualityCommands[0].argv.push('--changed'); }]
]) {
  test(`fresh validation refuses ${label}`, async t => {
    const value = await fixture(t);
    const run = await freshRun(value);
    mutate(value);
    await assert.rejects(recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase, run),
      { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
    assert.equal(value.phase.testCommandValidation, undefined);
  });
}

for (const [label, mutate] of [
  ['new source', value => { value.phase.deliveryEvidence.validation.sourceTreeSha256 = digest('new source'); }],
  ['replacement receipt', value => { value.phase.deliveryEvidence.receiptSha256 = digest('new receipt').slice(7); }],
  ['new checks', value => { value.phase.checks[0].completedAt = '2026-10-02T00:00:00.000Z'; }],
  ['different generation', value => { value.phase.generation = 2; }],
  ['new source-phase policy', value => { value.workflow.testCommandAmendments[0].to.policySha256 = digest('new policy'); }],
  ['wrong marker amendment', value => { value.phase.testCommandRevalidation.id = 'TCA-002'; }]
]) {
  test(`record replay refuses ${label}`, async t => {
    const value = await fixture(t);
    await recordTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase,
      await freshRun(value));
    mutate(value);
    await assert.rejects(verifyTestCommandEpochValidation(value.root, value.config, value.workflow, value.phase),
      { code: 'TCA_EPOCH_VALIDATION_REQUIRED' });
  });
}
