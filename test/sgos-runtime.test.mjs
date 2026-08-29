import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createCandidateSnapshot,
  createIntentIr,
  createGvmProgram,
  createWorkflowIr,
  createWorkflowRatification,
  validateActionEvidence,
  validateCandidateSnapshot,
  validateGvmCheckpoint,
  validateGvmProcess,
  validateGvmTaskAttempt,
  validateGvmTaskReceipt,
  validateHumanRequest,
  validateHumanResponse,
  validateProcessBinding,
  validateWorkObject
} from '../src/sgos/contracts.mjs';
import { compileSgosProgram, registrySnapshotDigest } from '../src/sgos/compiler.mjs';
import { buildSgosTaskReceipt, compileSgosActionEvidence } from '../src/sgos/evidence.mjs';
import { projectSgosWorkObjects } from '../src/sgos/projection.mjs';
import {
  deterministicSgosReadySet,
  listSgosProcesses,
  pauseSgosProcess,
  readySetFromSgosCheckpoint,
  readSgosCandidateSnapshot,
  respondToSgosHumanRequest,
  resumeSgosProcess,
  runNextSgosTask,
  startSgosProcess
} from '../src/sgos/runtime.mjs';
import {
  buildSgosProcessBinding,
  mutateSgosProcess,
  putSgosImmutableRecord,
  readSgosCheckpoint,
  readSgosImmutableRecord,
  readSgosProcess,
  readSgosProgram
} from '../src/sgos/store.mjs';

const HASH = Object.freeze({
  intent: `sha256:${'1'.repeat(64)}`,
  workflow: `sha256:${'2'.repeat(64)}`,
  ratification: `sha256:${'3'.repeat(64)}`,
  policy: `sha256:${'4'.repeat(64)}`,
  registry: `sha256:${'5'.repeat(64)}`,
  storage: `sha256:${'6'.repeat(64)}`,
  contract: `sha256:${'7'.repeat(64)}`,
  candidate: `sha256:${'8'.repeat(64)}`,
  checks: `sha256:${'9'.repeat(64)}`,
  authority: `sha256:${'b'.repeat(64)}`
});
const T0 = '2026-08-29T10:00:00.000Z';
const T1 = '2026-08-29T10:01:00.000Z';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function repository(storyId = 'SGOS-STORY-1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-runtime-'));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'SGOS Tester'], root);
  git(['config', 'user.email', 'sgos@example.test'], root);
  const storyDirectory = path.join(root, 'singularity', 'work-items', storyId);
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: storyId, title: 'Preserved Story authority' },
    currentPhase: 'implement'
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'app.mjs'), 'export const unchanged = true;\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'Story authority fixture'], root);
  return { root, storyId, workflowPath: path.join(storyDirectory, 'workflow.json'), head: git(['rev-parse', 'HEAD'], root) };
}

function task(taskTemplateId, opcode, dependsOn = [], extra = {}) {
  const result = {
    taskTemplateId,
    opcode,
    operation: extra.operation ?? `kernel.${opcode.toLowerCase().replaceAll('_', '-')}`,
    dependsOn,
    resources: extra.resources ?? { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: extra.evidence ?? {},
    authority: extra.authority ?? {},
    recovery: extra.recovery ?? {},
    intentClauseIds: [],
    inputs: extra.inputs ?? [],
    outputs: extra.outputs ?? [],
    retry: { maximumAttempts: 1 },
    policySnapshotSha256: HASH.policy,
    material: extra.material ?? false,
    metadata: extra.metadata ?? { sourceConstruct: 'task' }
  };
  if (extra.timeoutMs != null) result.timeoutMs = extra.timeoutMs;
  return result;
}

function program(taskTemplates) {
  return createGvmProgram({
    intentIrSha256: HASH.intent,
    workflowSha256: HASH.workflow,
    ratificationSha256: HASH.ratification,
    policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: HASH.registry,
    storageProfileSha256: HASH.storage,
    taskTemplates,
    edges: taskTemplates.flatMap((entry) => entry.dependsOn.map((from) => ({ from, to: entry.taskTemplateId }))),
    joins: [],
    budgets: { maximumTasks: taskTemplates.length },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: taskTemplates.at(-1).taskTemplateId }],
    compiler: { id: 'test-gvm-compiler', version: '1' }
  });
}

function compilerProducedProgram() {
  const registryCore = {
    kind: 'registry-snapshot',
    operations: [
      { id: 'core.run', version: '1', status: 'active', manifestSha256: HASH.candidate },
      { id: 'core.verify', version: '1', status: 'active', manifestSha256: HASH.candidate }
    ],
    taskKinds: [],
    devices: []
  };
  const registrySnapshot = {
    ...registryCore,
    registrySnapshotSha256: registrySnapshotDigest(registryCore)
  };
  const intentIr = createIntentIr({
    generation: 1,
    objective: { statement: 'Run one governed kernel operation.', provenance: 'human-confirmed' },
    outcomes: [], successCriteria: [], constraints: [], invariants: [], preferences: [],
    nonGoals: [], assumptions: [], unknowns: [], contradictions: [], risks: [],
    evidenceExpectations: [], authorityRequirements: [], budgets: [], domainCandidates: [],
    workTypeCandidates: [], subjects: []
  });
  const clauseId = `${intentIr.intentId}:objective`;
  const coverage = {
    clauses: { [clauseId]: [{ kind: 'task', targetId: 'kernel' }] },
    tasks: { kernel: [{ kind: 'intent-clause', sourceId: clauseId }] }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1',
    version: '1',
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: HASH.policy,
    metadata: { id: 'runtime-integration', version: '1', domainPack: 'core' },
    spec: {
      inputs: {},
      tasks: {
        kernel: {
          kind: 'task', opcode: 'KERNEL', operation: 'core.run', dependsOn: [],
          resources: { reads: [], writes: [], devices: [], externalEffects: [] },
          evidence: { required: ['task-receipt'] }, authority: {}, recovery: {},
          intentClauseIds: [clauseId], inputs: [{ ref: 'sfref:compiler-input' }], outputs: [],
          retry: { maximumAttempts: 1 }, policySnapshotSha256: HASH.policy, material: true,
          metadata: { operationVersion: '1', verification: { kind: 'kernel', operation: 'core.verify' } }
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['kernel'], material: false }
      },
      joins: {}, terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 }, recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: HASH.storage }, intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intentIr.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    storageProfileSha256: HASH.storage,
    packetSha256: `sha256:${'a'.repeat(64)}`,
    decision: 'ratified',
    principal: { id: 'runtime-tester', kind: 'human' },
    coverage,
    decidedAt: T0
  });
  return compileSgosProgram({
    intentIr, workflow, ratification,
    policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    registrySnapshot,
    storageProfileSha256: HASH.storage
  }).program;
}

async function start(root, storyId, compiled, options = {}) {
  return startSgosProcess(root, {
    program: compiled,
    taskContractSha256: HASH.contract,
    subject: { kind: 'story', id: storyId, branch: 'main', baselineRevision: git(['rev-parse', 'HEAD'], root) },
    trustedAuthorities: options.trustedAuthorities ?? [],
    clock: T0
  });
}

function trustedReviewer(overrides = {}) {
  return {
    kind: 'role',
    id: 'reviewer',
    principalId: 'reviewer',
    principalKind: 'human',
    assurance: 'host-observed',
    authoritySha256: HASH.authority,
    ...overrides
  };
}

test('sequential runtime preserves Story authority and succeeds only through immutable receipts', async () => {
  const fixture = await repository();
  const beforeWorkflow = await readFile(fixture.workflowPath, 'utf8');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('10-checkpoint', 'CHECKPOINT', ['00-noop']),
    task('20-kernel', 'KERNEL', ['10-checkpoint'], { operation: 'story.publish' }),
    task('30-verify', 'VERIFY', ['20-kernel'], { operation: 'story.verify' }),
    task('90-end', 'END', ['30-verify'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  assert.equal(started.created, true);
  validateGvmProcess(started.process);
  validateProcessBinding(started.binding);
  validateGvmCheckpoint(started.checkpoint);
  assert.deepEqual(deterministicSgosReadySet(compiled, started.process).map((entry) => entry.taskTemplateId), ['00-noop']);
  assert.equal((await readSgosProgram(fixture.root, started.process.processId, compiled.programSha256)).record.programSha256, compiled.programSha256);

  const handlers = {
    kernel: {
      'story.publish': async () => ({
        outputRefs: ['sfref:story-submission-packet'],
        rawResult: { status: 'completed', observedWrites: true }
      })
    },
    verify: {
      'story.verify': async ({ template }) => ({
        evidenceRefs: [`sfref:${template.metadata.sourceConstruct}`],
        rawResult: { status: 'completed' }
      })
    }
  };
  const captureCandidates = {
    'story.publish': async () => ({
      resources: [{
        path: 'app.mjs', type: 'file', mode: '100644', contentSha256: HASH.candidate,
        operation: 'modified', renameFrom: null, renameTo: null, deletion: false
      }]
    }),
    'story.verify': async () => ({ resources: [] })
  };
  const verifiers = {
    'story.publish': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }),
    'story.verify': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    })
  };

  const results = [];
  for (let index = 0; index < 5; index += 1) {
    results.push(await runNextSgosTask(fixture.root, started.process.processId, {
      handlers, captureCandidates, verifiers, clock: T1
    }));
  }
  const final = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(final.status, 'succeeded');
  validateGvmProcess(final);
  assert.equal(Object.values(final.taskInstances).every((entry) => entry.state === 'succeeded' && entry.receiptSha256), true);
  for (const entry of Object.values(final.taskInstances)) {
    const { record: receipt } = await readSgosImmutableRecord(
      fixture.root, final.processId, 'gvm-task-receipt', entry.receiptSha256
    );
    validateGvmTaskReceipt(receipt);
    assert.equal(receipt.verification.status, 'passed');
    const { record: candidate } = await readSgosCandidateSnapshot(
      fixture.root, final.processId, receipt.candidateSha256
    );
    validateCandidateSnapshot(candidate);
    assert.equal(candidate.candidateSha256, receipt.candidateSha256);
  }
  for (const result of results) {
    validateGvmTaskAttempt(result.attempt);
    validateGvmTaskReceipt(result.receipt);
    validateActionEvidence(result.evidence);
  }
  assert.equal(await readFile(fixture.workflowPath, 'utf8'), beforeWorkflow, 'SGOS sidecar must not change Story authority bytes');
  assert.equal(git(['status', '--porcelain'], fixture.root), '');
  assert.deepEqual((await listSgosProcesses(fixture.root)).map((entry) => entry.processId), [final.processId]);
});

test('durable checkpoint guards quiescent resume and process revisions are compare-and-swap', async () => {
  const fixture = await repository('SGOS-STORY-CHECKPOINT');
  const compiled = program([
    task('00-checkpoint', 'CHECKPOINT'),
    task('10-noop', 'NOOP', ['00-checkpoint']),
    task('90-end', 'END', ['10-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const firstTask = Object.values(started.process.taskInstances).find((entry) => entry.taskTemplateId === '00-checkpoint');
  await assert.rejects(() => mutateSgosProcess(fixture.root, started.process.processId, (draft) => {
    draft.taskInstances[firstTask.taskInstanceId].state = 'succeeded';
  }, { expectedRevision: started.process.processRevision, updatedAt: T1 }),
  (error) => error.code === 'SGOS_SUCCESS_WITHOUT_RECEIPT');
  assert.equal((await readSgosProcess(fixture.root, started.process.processId)).processSha256, started.process.processSha256);
  const checkpointStep = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
  validateGvmCheckpoint(checkpointStep.checkpoint);
  const persisted = (await readSgosCheckpoint(
    fixture.root, started.process.processId, checkpointStep.checkpoint.checkpointSha256
  )).record;
  assert.deepEqual(readySetFromSgosCheckpoint(persisted), readySetFromSgosCheckpoint(checkpointStep.checkpoint));

  const paused = await pauseSgosProcess(fixture.root, started.process.processId, {
    expectedRevision: checkpointStep.process.processRevision,
    clock: T1
  });
  assert.equal(paused.status, 'paused');
  const resumed = await resumeSgosProcess(fixture.root, started.process.processId, {
    checkpointSha256: paused.currentCheckpointSha256,
    expectedRevision: paused.processRevision,
    clock: T1
  });
  assert.equal(resumed.status, 'running');
  assert.deepEqual(deterministicSgosReadySet(compiled, resumed).map((entry) => entry.taskTemplateId), ['10-noop']);

  const expectedRevision = resumed.processRevision;
  const mutations = await Promise.allSettled([
    mutateSgosProcess(fixture.root, resumed.processId, (draft) => { draft.status = 'paused'; }, { expectedRevision, updatedAt: T1 }),
    mutateSgosProcess(fixture.root, resumed.processId, (draft) => { draft.status = 'paused'; }, { expectedRevision, updatedAt: T1 })
  ]);
  assert.equal(mutations.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = mutations.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'SGOS_PROCESS_REVISION_STALE');
});

test('runtime dispatches actual compiler output and reloads its persisted Program on each step', async () => {
  const fixture = await repository('SGOS-STORY-COMPILER');
  const compiled = compilerProducedProgram();
  const kernelTemplate = compiled.taskTemplates.find((entry) => entry.taskTemplateId === 'kernel');
  assert.equal(kernelTemplate.operation, 'core.run');
  assert.deepEqual(kernelTemplate.inputs, [{ ref: 'sfref:compiler-input' }]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const kernel = await runNextSgosTask(fixture.root, started.process.processId, {
    // Deliberately omit `program`: restart/step loads the exact stored Program by hash.
    handlers: { kernel: { 'core.run': async () => ({
      outputRefs: ['sfref:compiler-output'],
      rawResult: { status: 'completed' }
    }) } },
    captureCandidates: { 'core.run': async () => ({ resources: [] }) },
    verifiers: { 'core.verify': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }) },
    clock: T1
  });
  assert.equal(kernel.status, 'succeeded');
  assert.deepEqual(kernel.receipt.inputRefs, ['sfref:compiler-input']);
  const ended = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
  assert.equal(ended.process.status, 'succeeded');
});

test('operation handlers cannot self-declare verification or an arbitrary candidate digest', async () => {
  const fixture = await repository('SGOS-STORY-UNTRUSTED-HANDLER');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.publish' }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let captureCalled = false;
  let verifierCalled = false;
  const result = await runNextSgosTask(fixture.root, started.process.processId, {
    handlers: { kernel: { 'story.publish': async () => ({
      rawResult: { status: 'completed' },
      verification: { status: 'passed', checksSha256: HASH.checks },
      candidateSha256: HASH.candidate
    }) } },
    captureCandidates: { 'story.publish': async () => { captureCalled = true; return { resources: [] }; } },
    verifiers: { 'story.publish': async ({ candidateSha256 }) => {
      verifierCalled = true;
      return { status: 'passed', candidateSha256, checksSha256: HASH.checks };
    } },
    clock: T1
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SGOS_UNTRUSTED_VERIFICATION_RESULT');
  assert.equal(captureCalled, false);
  assert.equal(verifierCalled, false);
  assert.equal(Object.values(result.process.taskInstances).some((entry) => entry.receiptSha256), false);
});

test('a separate verifier must bind the exact persisted Candidate Snapshot before receipt', async () => {
  const fixture = await repository('SGOS-STORY-CANDIDATE-BINDING');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.publish' }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const result = await runNextSgosTask(fixture.root, started.process.processId, {
    handlers: { kernel: { 'story.publish': async () => ({ rawResult: { status: 'completed' } }) } },
    captureCandidates: { 'story.publish': async () => ({ resources: [] }) },
    verifiers: { 'story.publish': async () => ({
      status: 'passed', candidateSha256: HASH.candidate, checksSha256: HASH.checks
    }) },
    clock: T1
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SGOS_VERIFIER_CANDIDATE_MISMATCH');
  assert.equal(Object.values(result.process.taskInstances).some((entry) => entry.receiptSha256), false);
});

test('required evidence that the sequential profile cannot prove prevents success', async () => {
  const fixture = await repository('SGOS-STORY-EVIDENCE-GAP');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], {
      operation: 'story.publish', evidence: { required: ['provider-proof'] }
    }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const result = await runNextSgosTask(fixture.root, started.process.processId, {
    handlers: { kernel: { 'story.publish': async () => ({ rawResult: { status: 'completed' } }) } },
    captureCandidates: { 'story.publish': async () => ({ resources: [] }) },
    verifiers: { 'story.publish': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }) },
    clock: T1
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SGOS_REQUIRED_EVIDENCE_UNAVAILABLE');
  assert.equal(Object.values(result.process.taskInstances).some((entry) => entry.receiptSha256), false);
});

test('succeeded state revalidates attempt, candidate, and Action Evidence lineage', async () => {
  const missingFixture = await repository('SGOS-STORY-MISSING-ATTEMPT');
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  const missingStarted = await start(missingFixture.root, missingFixture.storyId, compiled);
  const completed = await runNextSgosTask(
    missingFixture.root, missingStarted.process.processId, { clock: T1 }
  );
  const storedAttempt = await readSgosImmutableRecord(
    missingFixture.root, completed.process.processId, 'gvm-task-attempt', completed.attempt.attemptSha256
  );
  await unlink(storedAttempt.path);
  await assert.rejects(
    () => readSgosProcess(missingFixture.root, completed.process.processId),
    (error) => error.code === 'SGOS_RECORD_LINEAGE_INVALID'
  );

  const mismatchFixture = await repository('SGOS-STORY-CANDIDATE-LINEAGE');
  const mismatchStarted = await start(mismatchFixture.root, mismatchFixture.storyId, compiled);
  const original = await runNextSgosTask(
    mismatchFixture.root, mismatchStarted.process.processId, { clock: T1 }
  );
  const originalCandidate = (await readSgosCandidateSnapshot(
    mismatchFixture.root, original.process.processId, original.receipt.candidateSha256
  )).record;
  const otherCandidate = createCandidateSnapshot({
    subject: originalCandidate.subject,
    baseline: originalCandidate.baseline,
    resources: [{
      path: 'different.mjs', type: 'file', mode: '100644', contentSha256: HASH.candidate,
      operation: 'added', renameFrom: null, renameTo: null, deletion: false
    }],
    createdBy: originalCandidate.createdBy,
    createdAt: T1
  });
  await putSgosImmutableRecord(
    mismatchFixture.root, original.process.processId, 'candidate-snapshot', otherCandidate
  );
  const forgedReceipt = buildSgosTaskReceipt({
    processId: original.receipt.processId,
    taskInstanceId: original.receipt.taskInstanceId,
    attemptId: original.receipt.attemptId,
    inputRefs: original.receipt.inputRefs,
    outputRefs: original.receipt.outputRefs,
    candidateSha256: otherCandidate.candidateSha256,
    evidenceRefs: [otherCandidate.candidateSha256, original.evidence.evidenceSha256],
    effectRefs: original.receipt.effectRefs,
    humanDecisionRefs: original.receipt.humanDecisionRefs,
    verification: original.receipt.verification,
    completedAt: original.receipt.completedAt
  });
  await putSgosImmutableRecord(
    mismatchFixture.root, original.process.processId, 'gvm-task-receipt', forgedReceipt
  );
  await assert.rejects(() => mutateSgosProcess(
    mismatchFixture.root,
    original.process.processId,
    (draft) => { draft.taskInstances[original.taskInstanceId].receiptSha256 = forgedReceipt.receiptSha256; },
    { expectedRevision: original.process.processRevision, updatedAt: T1 }
  ), (error) => error.code === 'SGOS_RECEIPT_LINEAGE_INVALID');
  assert.equal(
    (await readSgosProcess(mismatchFixture.root, original.process.processId))
      .taskInstances[original.taskInstanceId].receiptSha256,
    original.receipt.receiptSha256
  );
});

test('typed Human Requests survive restart, reject stale responses, and project without authority', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN');
  const human = (id) => task(id, 'HUMAN_REQUEST', [], {
    operation: 'human.approval',
    authority: {
      kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
    },
    metadata: {
      sourceConstruct: 'human-request',
      humanRequest: {
        requestType: 'approval',
        requestedBy: { id: 'sgos-runtime', kind: 'system' },
        authorityRequired: {
          kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
        },
        prompt: { title: `Approve ${id}`, detail: 'Bind a decision to this exact checkpoint.' },
        options: [
          { id: 'approve', label: 'Approve', consequence: 'The dependent task becomes ready.' },
          { id: 'reject', label: 'Reject', consequence: 'The response remains explicit evidence.' }
        ],
        inputSchema: null,
        sensitiveMode: 'none',
        externalUrl: null,
        secretBroker: null,
        expiresAt: '2026-08-30T00:00:00.000Z'
      }
    }
  });
  const compiled = program([
    human('00-human-a'),
    human('10-human-b'),
    task('90-end', 'END', ['00-human-a', '10-human-b'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled, {
    trustedAuthorities: [trustedReviewer()]
  });
  const first = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  assert.equal(first.status, 'waiting-human');
  assert.equal(first.process.status, 'running', 'an independent ready task may continue');
  const second = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  assert.equal(second.process.status, 'waiting-human');

  const restarted = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(restarted.openHumanRequests.length, 2);
  const requests = [];
  for (const reference of restarted.openHumanRequests) {
    const request = (await readSgosImmutableRecord(fixture.root, restarted.processId, 'human-request', reference)).record;
    validateHumanRequest(request);
    requests.push(request);
  }
  const objects = projectSgosWorkObjects(restarted, { humanRequests: requests });
  assert.equal(objects.length, 2);
  for (const object of objects) validateWorkObject(object);
  assert.throws(() => { objects[0].view.actions.push({}); }, TypeError);
  assert.equal((await readSgosProcess(fixture.root, restarted.processId)).processSha256, restarted.processSha256);

  await assert.rejects(() => respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: restarted.processRevision - 1,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'approved',
    clock: T1
  }), (error) => error.code === 'SGOS_HUMAN_REQUEST_STALE');

  await assert.rejects(() => respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: restarted.processRevision,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'approved',
    clock: '2026-08-31T00:00:00.000Z'
  }), (error) => error.code === 'SGOS_HUMAN_REQUEST_EXPIRED');

  const answered = await respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: restarted.processRevision,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'approved',
    clock: T1
  });
  validateHumanResponse(answered.response);
  validateGvmTaskReceipt(answered.receipt);
  await assert.rejects(() => respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: answered.process.processRevision,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'approved',
    clock: T1
  }), (error) => error.code === 'SGOS_HUMAN_REQUEST_STALE');

  const remaining = requests.find((entry) => entry.requestId !== requests[0].requestId);
  const completedHuman = await respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: remaining.requestId,
    requestSha256: remaining.requestSha256,
    expectedRevision: answered.process.processRevision,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'approved',
    clock: T1
  });
  const ended = await runNextSgosTask(fixture.root, restarted.processId, {
    expectedRevision: completedHuman.process.processRevision,
    clock: T1
  });
  assert.equal(ended.process.status, 'succeeded');
});

test('Human Request authority ignores actor self-claims and accepts only a pinned or resolver assertion', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-AUTHORITY');
  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: {
        kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
      },
      metadata: {
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: {
            kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
          },
          prompt: { title: 'Approve', detail: 'Authority must come from a trusted boundary.' },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2026-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-human'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  const response = {
    requestId: waiting.request.requestId,
    requestSha256: waiting.request.requestSha256,
    expectedRevision: waiting.process.processRevision,
    actor: {
      id: 'reviewer', kind: 'human', authority: 'reviewer', authorities: ['reviewer'],
      authoritySha256: HASH.authority
    },
    decision: 'approved',
    clock: T1
  };
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, response),
    (error) => error.code === 'SGOS_HUMAN_REQUEST_UNAUTHORIZED'
  );
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      ...response, authorityResolver: async () => true
    }),
    (error) => error.code === 'SGOS_AUTHORITY_RESOLVER_INVALID'
  );
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      ...response,
      authorityResolver: async () => trustedReviewer({ assurance: 'self-asserted' })
    }),
    (error) => error.code === 'SGOS_HUMAN_REQUEST_UNAUTHORIZED'
  );
  const answered = await respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
    ...response,
    authorityResolver: async () => trustedReviewer()
  });
  assert.equal(answered.status, 'succeeded');
  assert.equal(answered.response.actor.authoritySha256, HASH.authority);
  assert.equal(answered.receipt.candidateSha256, answered.candidate.candidateSha256);
});

test('typed Human Response schema and sensitive-channel handles fail closed', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-SECRET');
  const handleSchema = {
    type: 'object',
    required: ['kind', 'broker', 'handle', 'referenceSha256'],
    additionalProperties: false,
    properties: {
      kind: { const: 'secret-broker' },
      broker: { const: 'vault:test' },
      handle: { type: 'string', minLength: 1 },
      referenceSha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
    }
  };
  const compiled = program([
    task('00-secret', 'HUMAN_REQUEST', [], {
      operation: 'human.credential',
      authority: {
        kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
      },
      metadata: {
        humanRequest: {
          requestType: 'credential',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: {
            kind: 'role', id: 'reviewer', minimumAssurance: 'host-observed', authoritySha256: HASH.authority
          },
          prompt: { title: 'Credential handle', detail: 'Return only an external broker handle.' },
          options: [], inputSchema: handleSchema, sensitiveMode: 'secret-broker',
          externalUrl: null, secretBroker: 'vault:test', expiresAt: '2026-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-secret'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled, {
    trustedAuthorities: [trustedReviewer()]
  });
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  const base = {
    requestId: waiting.request.requestId,
    requestSha256: waiting.request.requestSha256,
    expectedRevision: waiting.process.processRevision,
    actor: { id: 'reviewer', kind: 'human' },
    decision: 'provided',
    clock: T1
  };
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      ...base, input: { token: 'raw-secret' }
    }),
    (error) => error.code === 'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED'
  );
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      ...base, decision: 'approved', input: null
    }),
    (error) => error.code === 'SGOS_HUMAN_RESPONSE_INVALID'
  );
  const answered = await respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
    ...base,
    input: {
      kind: 'secret-broker', broker: 'vault:test', handle: 'secret/sgos/42',
      referenceSha256: HASH.candidate
    }
  });
  assert.equal(answered.status, 'succeeded');
});

test('runtime rejects stale Process Bindings, unsupported control flow, and execution timeouts', async () => {
  const bindingFixture = await repository('SGOS-STORY-BINDING');
  const simple = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  await assert.rejects(() => startSgosProcess(bindingFixture.root, {
    program: simple,
    taskContractSha256: HASH.contract,
    subject: {
      kind: 'story', id: bindingFixture.storyId, branch: 'main',
      baselineRevision: '0000000000000000000000000000000000000000'
    },
    clock: T0
  }), (error) => error.code === 'SGOS_PROCESS_BINDING_STALE');

  const processId = 'PROC-STALE-BINDING1';
  const foreignBranch = buildSgosProcessBinding(bindingFixture.root, {
    processId,
    subjectId: bindingFixture.storyId,
    branchName: 'other',
    baselineRevision: bindingFixture.head
  });
  await assert.rejects(() => startSgosProcess(bindingFixture.root, {
    processId,
    program: simple,
    taskContractSha256: HASH.contract,
    subject: {
      kind: 'story', id: bindingFixture.storyId, branch: 'main', baselineRevision: bindingFixture.head
    },
    processBinding: foreignBranch,
    clock: T0
  }), (error) => error.code === 'SGOS_PROCESS_BINDING_STALE');

  const semanticFixture = await repository('SGOS-STORY-SEMANTICS');
  const unsupported = program([
    task('00-merge', 'MERGE'),
    task('90-end', 'END', ['00-merge'])
  ]);
  await assert.rejects(
    () => start(semanticFixture.root, semanticFixture.storyId, unsupported),
    (error) => error.code === 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED'
  );

  const timeoutFixture = await repository('SGOS-STORY-TIMEOUT');
  const timed = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.slow', timeoutMs: 5 }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(timeoutFixture.root, timeoutFixture.storyId, timed);
  const timedOut = await runNextSgosTask(timeoutFixture.root, started.process.processId, {
    handlers: { kernel: { 'story.slow': async () => new Promise((resolve) => {
      setTimeout(() => resolve({ rawResult: { status: 'completed' } }), 30);
    }) } },
    captureCandidates: { 'story.slow': async () => ({ resources: [] }) },
    verifiers: { 'story.slow': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }) },
    clock: T1
  });
  assert.equal(timedOut.status, 'recovery-required');
  assert.equal(timedOut.error.code, 'SGOS_TASK_TIMEOUT');
  assert.equal(Object.values(timedOut.process.taskInstances).some((entry) => entry.receiptSha256), false);
});

test('SGOS immutable store refuses symbolic-link ancestors before publication', async () => {
  const fixture = await repository('SGOS-STORY-SYMLINK');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-outside-'));
  await symlink(outside, path.join(fixture.root, '.git', 'singularity-flow'), 'dir');
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  await assert.rejects(
    () => putSgosImmutableRecord(fixture.root, 'PROC-SYMLINK-STORE1', 'gvm-program', compiled),
    (error) => error.code === 'SGOS_SIDECAR_PATH_UNSAFE'
  );
  assert.equal((await readFile(path.join(outside, '.keep'), 'utf8').catch(() => null)), null);
});

test('SGOS immutable store opens final record targets without following symbolic links', async () => {
  const fixture = await repository('SGOS-STORY-SYMLINK-RECORD');
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const stored = await readSgosProgram(
    fixture.root, started.process.processId, started.process.programSha256
  );
  await unlink(stored.path);
  await symlink('/etc/passwd', stored.path);
  await assert.rejects(
    () => readSgosProgram(fixture.root, started.process.processId, started.process.programSha256),
    (error) => error.code === 'SGOS_SIDECAR_PATH_UNSAFE'
  );
});

test('AGENT and DEVICE opcodes fail closed without a success receipt', async () => {
  const fixture = await repository('SGOS-STORY-UNSUPPORTED');
  for (const opcode of ['AGENT', 'DEVICE']) {
    const compiled = program([
      task(`00-${opcode.toLowerCase()}`, opcode, [], {
        operation: opcode === 'AGENT' ? 'agent.execute' : 'device.execute',
        resources: {
          reads: [], writes: [],
          devices: opcode === 'DEVICE' ? ['device:test'] : [],
          externalEffects: []
        }
      }),
      task('90-end', 'END', [`00-${opcode.toLowerCase()}`])
    ]);
    const started = await start(fixture.root, `${fixture.storyId}-${opcode}`, compiled);
    const result = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason.code.includes(opcode), true);
    assert.equal(Object.values(result.process.taskInstances).some((entry) => entry.receiptSha256), false);
  }
});

test('Action Evidence hashes unavailable observations and keeps gaps and contradictions visible', () => {
  const evidence = compileSgosActionEvidence({
    processId: 'PROC-EVIDENCE1',
    taskInstanceId: 'task-1',
    attemptId: 'ATT-EVIDENCE1',
    programSha256: HASH.workflow,
    taskContractSha256: HASH.contract,
    rawResult: { claimedComplete: true, toolResults: [{}], observedWrites: false },
    preState: { revision: 1 },
    postState: { revision: 2 },
    verification: { status: 'failed', checksSha256: HASH.checks },
    createdAt: T1
  });
  validateActionEvidence(evidence);
  assert.equal(evidence.gaps.some((entry) => entry.startsWith('principal-sha256-unavailable')), true);
  assert.equal(evidence.gaps.includes('execution-events-unavailable:executionEvents'), true);
  assert.equal(evidence.contradictions.some((entry) => entry.startsWith('completion-claim-not-verified')), true);
  assert.equal(evidence.contradictions.some((entry) => entry.startsWith('tool-result-without-intent')), true);
  assert.equal(evidence.contradictions.includes('state-changed-with-no-observed-write'), true);
});
