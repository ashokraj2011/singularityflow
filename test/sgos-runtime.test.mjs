import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import {
  createCandidateSnapshot,
  createIntentIr,
  createGvmProgram,
  createResourceLease,
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
import {
  compileSgosProgram, registrySnapshotDigest, SGOS_COMPILER_ID, SGOS_COMPILER_VERSION
} from '../src/sgos/compiler.mjs';
import {
  buildSgosTaskAttempt, buildSgosTaskReceipt, compileSgosActionEvidence, sgosSha256
} from '../src/sgos/evidence.mjs';
import { projectSgosWorkObjects } from '../src/sgos/projection.mjs';
import { SGOS_INSTALLED_LIMITS } from '../src/sgos/limits.mjs';
import { normalizeSgosFanout, sgosFanoutChildTemplateId } from '../src/sgos/fanout.mjs';
import { canonicalSgosResourceEntries } from '../src/sgos/resource-contracts.mjs';
import {
  deterministicSgosReadySet,
  listSgosProcesses,
  pauseSgosProcess,
  planSgosProcessRecovery,
  readySetFromSgosCheckpoint,
  readSgosCandidateSnapshot,
  respondToSgosHumanRequest,
  recoverInterruptedSgosExecution,
  resumeSgosProcess,
  runNextSgosTask,
  runReadySgosTasks,
  startSgosProcess,
  stopSgosProcess
} from '../src/sgos/runtime.mjs';
import { installedExecutionUnitManifests } from '../src/sgos/execution-units.mjs';
import { installedDeviceManifests } from '../src/sgos/devices.mjs';
import {
  buildSgosProcessBinding,
  createSgosProcess,
  currentSgosExecutionOwnerFingerprint,
  fsckSgosProcess,
  inspectSgosControlLineage,
  listSgosImmutableRecordsByField,
  mutateSgosProcess,
  planSgosProcessQuarantine,
  putSgosImmutableRecord,
  quarantineSgosProcess,
  reconcileSgosExecutionLeases,
  registerSgosExecutionOwner,
  readSgosCheckpoint,
  readSgosControlSuccessor,
  readSgosExecutionLease,
  readSgosImmutableRecord,
  readSgosProcess,
  readSgosProgram,
  setSgosStoreFaultBoundaryForTests,
  sgosProcessDirectory,
  sgosProcessStatePath,
  upgradeSgosProcessControlLineage,
  unregisterSgosExecutionOwner,
  writeSgosExecutionLease
} from '../src/sgos/store.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

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
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.approvalAuthorities.reviewer = {
    label: 'SGOS runtime reviewers',
    allowAnyGitIdentity: false,
    members: [{ name: 'SGOS Tester', email: 'sgos@example.test' }]
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
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
  const material = extra.material ?? !['NOOP', 'CHECKPOINT', 'END'].includes(opcode);
  const metadata = {
    sourceConstruct: 'task',
    operationVersion: '1',
    operationManifestSha256: HASH.candidate,
    ...(extra.metadata ?? {})
  };
  const result = {
    taskTemplateId,
    opcode,
    operation: extra.operation ?? `kernel.${opcode.toLowerCase().replaceAll('_', '-')}`,
    dependsOn,
    resources: extra.resources ?? { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: extra.evidence ?? (material ? { required: ['candidate', 'verification-result'] } : {}),
    authority: extra.authority ?? {},
    recovery: extra.recovery ?? {},
    intentClauseIds: [],
    inputs: extra.inputs ?? [],
    outputs: extra.outputs ?? [],
    retry: extra.retry ?? { maximumAttempts: 1 },
    policySnapshotSha256: HASH.policy,
    material,
    metadata
  };
  if (extra.timeoutMs != null) result.timeoutMs = extra.timeoutMs;
  return result;
}

function program(taskTemplates, joins = []) {
  return createGvmProgram({
    intentIrSha256: HASH.intent,
    workflowSha256: HASH.workflow,
    ratificationSha256: HASH.ratification,
    policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: HASH.registry,
    storageProfileSha256: HASH.storage,
    taskTemplates,
    edges: taskTemplates.flatMap((entry) => entry.dependsOn
      .map((from) => ({ from, to: entry.taskTemplateId })))
      .sort((left, right) => left.from < right.from ? -1 : left.from > right.from ? 1
        : left.to < right.to ? -1 : left.to > right.to ? 1 : 0),
    joins,
    budgets: {
      maximumTasks: taskTemplates.length,
      maximumAttempts: Math.max(...taskTemplates.map((entry) => entry.retry?.maximumAttempts ?? 1))
    },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: taskTemplates.at(-1).taskTemplateId, state: 'succeeded' }],
    compiler: { id: SGOS_COMPILER_ID, version: SGOS_COMPILER_VERSION }
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

function compilerProducedAdapterProgram() {
  const agentManifest = installedExecutionUnitManifests()
    .find((entry) => entry.id === 'deterministic-translator');
  const deviceManifest = installedDeviceManifests()
    .find((entry) => entry.id === 'filesystem-read');
  assert.ok(agentManifest);
  assert.ok(deviceManifest);
  const registryCore = {
    kind: 'registry-snapshot',
    operations: [
      { id: 'agent.translate', version: '1', status: 'active', manifestSha256: HASH.candidate },
      { id: 'filesystem.read-file', version: '1', status: 'active', manifestSha256: HASH.candidate }
    ],
    taskKinds: [],
    devices: [{
      id: deviceManifest.id, version: deviceManifest.version, status: 'active',
      manifestSha256: deviceManifest.manifestSha256
    }],
    executionUnits: [{
      id: agentManifest.id, version: agentManifest.version, status: 'active',
      manifestSha256: agentManifest.manifestSha256
    }]
  };
  const registrySnapshot = {
    ...registryCore,
    registrySnapshotSha256: registrySnapshotDigest(registryCore)
  };
  const intentIr = createIntentIr({
    generation: 1,
    objective: { statement: 'Translate one bounded task and inspect its input.', provenance: 'human-confirmed' },
    outcomes: [], successCriteria: [], constraints: [], invariants: [], preferences: [],
    nonGoals: [], assumptions: [], unknowns: [], contradictions: [], risks: [],
    evidenceExpectations: [], authorityRequirements: [], budgets: [], domainCandidates: [],
    workTypeCandidates: [], subjects: []
  });
  const clauseId = `${intentIr.intentId}:objective`;
  const coverage = {
    clauses: {
      [clauseId]: [
        { kind: 'task', targetId: 'agent' },
        { kind: 'task', targetId: 'device' }
      ]
    },
    tasks: {
      agent: [{ kind: 'intent-clause', sourceId: clauseId }],
      device: [{ kind: 'intent-clause', sourceId: clauseId }]
    }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1', version: '1', intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: HASH.policy,
    metadata: { id: 'runtime-adapters', version: '1', domainPack: 'core' },
    spec: {
      inputs: {},
      tasks: {
        agent: {
          kind: 'task', opcode: 'AGENT', operation: 'agent.translate', dependsOn: [],
          resources: { reads: [], writes: [], devices: [], externalEffects: [] },
          evidence: { required: ['candidate', 'verification-result'] }, authority: {}, recovery: {},
          intentClauseIds: [clauseId], inputs: [], outputs: [], retry: { maximumAttempts: 1 },
          policySnapshotSha256: HASH.policy, material: true,
          metadata: {
            executionUnitId: agentManifest.id,
            parameters: { objective: 'Create one deterministic bounded proposal.' }
          }
        },
        device: {
          kind: 'task', opcode: 'DEVICE', operation: 'filesystem.read-file', dependsOn: ['agent'],
          resources: {
            reads: ['app.mjs'], writes: [], devices: [deviceManifest.id], externalEffects: []
          },
          evidence: { required: ['candidate', 'verification-result'] }, authority: {}, recovery: {},
          intentClauseIds: [clauseId], inputs: [], outputs: [], retry: { maximumAttempts: 1 },
          policySnapshotSha256: HASH.policy, material: true,
          metadata: {
            deviceId: deviceManifest.id,
            parameters: {
              operation: 'read-file', arguments: { path: 'app.mjs' }, scope: ['app.mjs']
            }
          }
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['device'], material: false }
      },
      joins: {}, terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 3, maximumAttempts: 1 }, recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: HASH.storage }, intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intentIr.intentIrSha256, workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    storageProfileSha256: HASH.storage, packetSha256: `sha256:${'a'.repeat(64)}`,
    decision: 'ratified', principal: { id: 'runtime-tester', kind: 'human' },
    coverage, decidedAt: T0
  });
  const compiled = compileSgosProgram({
    intentIr, workflow, ratification, policySnapshotSha256: HASH.policy,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256, registrySnapshot,
    storageProfileSha256: HASH.storage
  }).program;
  return { compiled, agentManifest, deviceManifest };
}

async function start(root, storyId, compiled) {
  await publishSgosProgramAuthority(root, compiled);
  return startSgosProcess(root, {
    program: compiled,
    taskContractSha256: HASH.contract,
    subject: { kind: 'story', id: storyId, branch: 'main', baselineRevision: git(['rev-parse', 'HEAD'], root) },
    clock: T0
  });
}

const V2_SOURCE_RECORD_INDEX = new WeakMap();

async function replaceProcessWithV2(root, process) {
  const statePath = sgosProcessStatePath(root, process.processId);
  const processDirectory = path.dirname(statePath);
  await rm(path.join(processDirectory, 'control-events'), { recursive: true, force: true });
  await rm(path.join(processDirectory, 'control-next'), { recursive: true, force: true });
  const legacy = JSON.parse(await readFile(statePath, 'utf8'));
  const sourceRecordIndexSha256 = legacy.recordIndexSha256;
  delete legacy.processSha256;
  delete legacy.controlEventSha256;
  delete legacy.recordIndexSha256;
  legacy.schemaVersion = 2;
  legacy.processSha256 = sgosSha256(legacy);
  V2_SOURCE_RECORD_INDEX.set(legacy, sourceRecordIndexSha256);
  await writeFile(statePath, JSON.stringify(legacy));
  return { legacy, statePath };
}

function v2RootControlEvent(legacy, { beforeProcessSha256 = legacy.processSha256 } = {}) {
  return {
    kind: 'sgos-control-event',
    processId: legacy.processId,
    processCoreSha256: sgosSha256({
      processId: legacy.processId,
      programSha256: legacy.programSha256,
      policySnapshotSha256: legacy.policySnapshotSha256,
      processBindingSha256: legacy.processBindingSha256,
      taskContractSha256: legacy.taskContractSha256,
      authorityBinding: structuredClone(legacy.authorityBinding),
      createdAt: legacy.createdAt
    }),
    priorControlEventSha256: null,
    beforeProcessSha256,
    beforeProcessRevision: legacy.processRevision,
    controlDepth: 1,
    operatorTransitionCount: 0,
    recordIndexSha256: V2_SOURCE_RECORD_INDEX.get(legacy),
    action: 'process-transition',
    result: {
      status: legacy.status,
      taskInstances: structuredClone(legacy.taskInstances),
      activeExecutions: structuredClone(legacy.activeExecutions),
      openHumanRequests: structuredClone(legacy.openHumanRequests),
      activeLeases: structuredClone(legacy.activeLeases),
      currentCheckpointSha256: legacy.currentCheckpointSha256,
      processRevision: legacy.processRevision + 1,
      updatedAt: legacy.updatedAt
    },
    createdAt: legacy.updatedAt
  };
}

function processAtControlEvent(current, event) {
  const result = {
    ...structuredClone(current),
    ...structuredClone(event.result),
    schemaVersion: 3,
    kind: 'gvm-process',
    controlEventSha256: event.controlEventSha256,
    recordIndexSha256: event.recordIndexSha256
  };
  delete result.processSha256;
  result.processSha256 = sgosSha256(result);
  return result;
}

function unrootedSeedAtControlEvent(current, event) {
  const seed = processAtControlEvent(current, event);
  seed.controlEventSha256 = null;
  seed.processRevision = 1;
  delete seed.processSha256;
  seed.processSha256 = sgosSha256(seed);
  return seed;
}

function exitedOwnerPid() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(child.status, 0);
    try { process.kill(child.pid, 0); } catch (error) {
      if (error?.code === 'ESRCH') return child.pid;
      throw error;
    }
  }
  throw new Error('Unable to obtain an exited child PID for the execution-lease fixture.');
}

async function markSgosExecutionInterrupted(root, process, taskTemplateId) {
  const before = await readSgosProcess(root, process.processId);
  const storedProgram = await readSgosProgram(root, before.processId, before.programSha256);
  const task = Object.values(before.taskInstances)
    .find((entry) => entry.taskTemplateId === taskTemplateId);
  assert.ok(task, taskTemplateId);
  const template = storedProgram.record.taskTemplates
    .find((entry) => entry.taskTemplateId === task.taskTemplateId);
  assert.ok(template, task.taskTemplateId);
  const attemptId = `ATT-crashed-${before.processId.slice('PROC-'.length)}`;
  const leaseId = `LEASE-crashed-${before.processId.slice('PROC-'.length)}`;
  const executionHandleSha256 = sgosSha256({
    processSha256: before.processSha256,
    taskInstanceId: task.taskInstanceId,
    attemptId
  });
  const runningAttempt = buildSgosTaskAttempt({
    attemptId,
    processId: before.processId,
    taskInstanceId: task.taskInstanceId,
    attemptNumber: task.attemptIds.length + 1,
    parentAttemptId: task.attemptIds.at(-1) ?? null,
    reason: task.attemptIds.length ? 'retry' : 'initial',
    taskContractSha256: before.taskContractSha256,
    executionHandleSha256,
    status: 'running',
    startedAt: T0,
    completedAt: null
  });
  const lease = {
    kind: 'sgos-execution-lease',
    leaseId,
    processId: before.processId,
    attemptId,
    taskInstanceId: task.taskInstanceId,
    ownerId: `OWNER-crashed-${before.processId.slice('PROC-'.length)}`,
    ownerPid: exitedOwnerPid(),
    ownerStartFingerprint: HASH.authority,
    beforeProcessSha256: before.processSha256,
    beforeProcessRevision: before.processRevision,
    executionHandleSha256,
    attemptSha256: runningAttempt.attemptSha256,
    acquiredAt: T0,
    heartbeatAt: T0
  };
  await writeSgosExecutionLease(root, before.processId, lease);
  const runningPublication = await putSgosImmutableRecord(
    root, before.processId, 'gvm-task-attempt', runningAttempt
  );
  const resourcePublication = await putSgosImmutableRecord(
    root, before.processId, 'resource-lease', createResourceLease({
      processId: before.processId,
      taskInstanceId: task.taskInstanceId,
      attemptId,
      resources: canonicalSgosResourceEntries(template.resources),
      acquiredAt: T0,
      expiresAt: '2099-01-01T00:00:00.000Z'
    })
  );
  const interrupted = await mutateSgosProcess(root, before.processId, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    target.state = 'running';
    target.attemptIds = [...target.attemptIds, attemptId];
    target.revision += 1;
    draft.activeExecutions = [attemptId];
    draft.activeLeases = [leaseId];
    draft.status = 'running';
  }, {
    expectedRevision: before.processRevision,
    expectedProcessSha256: before.processSha256,
    updatedAt: T0,
    recordReservations: [
      runningPublication.reservationToken,
      resourcePublication.reservationToken
    ]
  });
  return { before, interrupted, task, attemptId, lease, runningAttempt };
}

function governedKernel(operation, handler) {
  return {
    handlers: { kernel: { [operation]: handler } },
    captureCandidates: { [operation]: async () => ({ resources: [] }) },
    verifiers: { [operation]: async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }) },
    clock: T1
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
  assert.deepEqual(started.process.authorityBinding.subjectAuthority, started.binding.subjectAuthority);
  assert.equal(started.binding.subjectAuthority.kind, 'governed-story-baseline');
  assert.equal(started.binding.subjectAuthority.subjectId, fixture.storyId);
  assert.equal(started.binding.subjectAuthority.revision, fixture.head);
  assert.equal(started.binding.subjectAuthority.path,
    `singularity/work-items/${fixture.storyId}/workflow.json`);
  assert.match(started.binding.subjectAuthority.blobSha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(started.binding.subjectAuthority.stateSha256, /^sha256:[a-f0-9]{64}$/);
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

test('opt-in parallel wave launches one deterministic compatible ready set and quiesces all handlers', async () => {
  const fixture = await repository('SGOS-STORY-PARALLEL-WAVE');
  const compiled = program([
    task('10-alpha', 'KERNEL', [], {
      operation: 'story.alpha', resources: {
        reads: ['repo/input/alpha'], writes: ['repo/output/alpha'],
        devices: [], externalEffects: []
      }
    }),
    task('20-beta', 'KERNEL', [], {
      operation: 'story.beta', resources: {
        reads: ['repo/input/beta'], writes: ['repo/output/beta'],
        devices: [], externalEffects: []
      }
    }),
    task('90-end', 'END', ['10-alpha', '20-beta'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let enteredCount = 0;
  let bothEntered;
  const entered = new Promise((resolve) => { bothEntered = resolve; });
  const calls = [];
  const handler = (name) => async () => {
    calls.push(name);
    enteredCount += 1;
    if (enteredCount === 2) bothEntered();
    await held;
    return { rawResult: { status: 'completed', name } };
  };
  const adapters = {
    handlers: { kernel: {
      'story.alpha': handler('alpha'),
      'story.beta': handler('beta')
    } },
    captureCandidates: {
      'story.alpha': async () => ({ resources: [] }),
      'story.beta': async () => ({ resources: [] })
    },
    verifiers: {
      'story.alpha': async ({ candidateSha256 }) => ({
        status: 'passed', candidateSha256, checksSha256: HASH.checks
      }),
      'story.beta': async ({ candidateSha256 }) => ({
        status: 'passed', candidateSha256, checksSha256: HASH.checks
      })
    },
    clock: T1
  };
  const running = runReadySgosTasks(fixture.root, started.process.processId, {
    program: compiled, maximumParallel: 2, ...adapters
  });
  await entered;
  const active = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(active.activeExecutions.length, 2);
  assert.equal(active.activeLeases.length, 2);
  const leases = await Promise.all(active.activeExecutions.map((attemptId) =>
    listSgosImmutableRecordsByField(
      fixture.root, active.processId, 'resource-lease', 'attemptId', attemptId
    )));
  assert.equal(leases.every((entries) => entries.length === 1), true);
  release();
  const wave = await running;
  assert.equal(wave.launched, 2);
  assert.deepEqual(wave.taskInstanceIds.map((taskInstanceId) =>
    wave.process.taskInstances[taskInstanceId].taskTemplateId), ['10-alpha', '20-beta']);
  assert.deepEqual(calls.sort(), ['alpha', 'beta']);
  assert.deepEqual(wave.process.activeExecutions, []);
  assert.equal(Object.values(wave.process.taskInstances)
    .filter((entry) => entry.taskTemplateId !== '90-end')
    .every((entry) => entry.state === 'succeeded'), true);
  const ended = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
  assert.equal(ended.process.status, 'succeeded');
});

test('all-success JOIN persists one exact receipt after every predecessor succeeds', async () => {
  const fixture = await repository('SGOS-STORY-JOIN');
  const compiled = program([
    task('10-alpha', 'NOOP'),
    task('20-beta', 'NOOP'),
    task('30-join', 'JOIN', ['10-alpha', '20-beta'], {
      material: false, evidence: {}, metadata: { joinPolicy: 'all-success' }
    }),
    task('90-end', 'END', ['30-join'])
  ], [{
    joinId: 'join-main', taskTemplateId: '30-join', policy: 'all-success',
    predecessorTaskTemplateIds: ['10-alpha', '20-beta']
  }]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const predecessors = await runReadySgosTasks(fixture.root, started.process.processId, {
    program: compiled, maximumParallel: 2, clock: T1
  });
  assert.equal(predecessors.launched, 2);
  const joined = await runNextSgosTask(fixture.root, started.process.processId, {
    program: compiled, clock: T1
  });
  assert.equal(joined.status, 'succeeded');
  assert.equal(joined.joinReceipt.policy, 'all-success');
  assert.deepEqual(joined.joinReceipt.predecessors.map((entry) => entry.state),
    ['succeeded', 'succeeded']);
  const stored = await listSgosImmutableRecordsByField(
    fixture.root, started.process.processId, 'join-receipt',
    'attemptId', joined.joinReceipt.attemptId
  );
  assert.equal(stored.length, 1);
  assert.equal(stored[0].joinReceiptSha256, joined.joinReceipt.joinReceiptSha256);
  assert.equal(joined.process.taskInstances[joined.taskInstanceId].outputRefs
    .includes(joined.joinReceipt.joinReceiptSha256), true);
  const ended = await runNextSgosTask(fixture.root, started.process.processId, {
    program: compiled, clock: T1
  });
  assert.equal(ended.process.status, 'succeeded');
  assert.equal((await fsckSgosProcess(fixture.root, started.process.processId)).status, 'ok');
});

test('all-terminal JOIN converges deterministically after a predecessor failure', async () => {
  const fixture = await repository('SGOS-STORY-JOIN-TERMINAL');
  const compiled = program([
    task('10-fails', 'KERNEL', [], {
      operation: 'story.expected-failure',
      resources: { reads: ['repo/input'], writes: [], devices: [], externalEffects: [] }
    }),
    task('20-succeeds', 'NOOP'),
    task('30-join', 'JOIN', ['10-fails', '20-succeeds'], {
      material: false, evidence: {}, metadata: { joinPolicy: 'all-terminal' }
    }),
    task('90-end', 'END', ['30-join'])
  ], [{
    joinId: 'join-terminal', taskTemplateId: '30-join', policy: 'all-terminal',
    predecessorTaskTemplateIds: ['10-fails', '20-succeeds']
  }]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const predecessors = await runReadySgosTasks(fixture.root, started.process.processId, {
    program: compiled,
    maximumParallel: 2,
    handlers: { kernel: { 'story.expected-failure': async () => {
      throw new Error('expected terminal failure');
    } } },
    clock: T1
  });
  assert.equal(predecessors.launched, 2);
  const joined = await runNextSgosTask(fixture.root, started.process.processId, {
    program: compiled, clock: T1
  });
  assert.equal(joined.status, 'succeeded');
  assert.equal(joined.joinReceipt.policy, 'all-terminal');
  assert.deepEqual(joined.joinReceipt.predecessors.map((entry) => entry.state).sort(),
    ['failed', 'succeeded']);
  const ended = await runNextSgosTask(fixture.root, started.process.processId, {
    program: compiled, clock: T1
  });
  assert.equal(ended.status, 'succeeded');
  assert.equal(ended.process.status, 'failed',
    'the terminal boundary completes, while the Process retains its failed outcome');
  assert.equal((await fsckSgosProcess(fixture.root, started.process.processId)).status, 'ok');
});

test('finite fan-out start roots one exact expansion receipt and executes only bounded children', async () => {
  const fixture = await repository('SGOS-STORY-FANOUT');
  const fanout = normalizeSgosFanout({
    taskId: '30-fanout', maximumItems: 2, maximumParallel: 2,
    items: [{ key: 'b', value: { id: 2 } }, { key: 'a', value: { id: 1 } }]
  });
  const children = fanout.items.map((item) => task(
    sgosFanoutChildTemplateId('30-fanout', item.itemKey, item.itemSha256),
    'NOOP', [], {
      material: false,
      metadata: { fanout: {
        parentTaskId: '30-fanout', itemKey: item.itemKey,
        itemSha256: item.itemSha256, itemValue: item.value,
        collectionSha256: fanout.collectionSha256,
        maximumItems: fanout.maximumItems, maximumParallel: fanout.maximumParallel
      } }
    }
  ));
  const childIds = children.map((entry) => entry.taskTemplateId).sort();
  const templates = [
    ...children,
    task('30-fanout', 'JOIN', childIds, {
      material: false,
      metadata: {
        joinPolicy: 'all-success',
        fanoutCoordinator: {
          parentTaskId: '30-fanout', collectionSha256: fanout.collectionSha256,
          maximumItems: fanout.maximumItems, maximumParallel: fanout.maximumParallel
        }
      }
    }),
    task('90-end', 'END', ['30-fanout'])
  ].sort((left, right) => left.taskTemplateId.localeCompare(right.taskTemplateId));
  const compiled = program(templates, [{
    joinId: '30-fanout', taskTemplateId: '30-fanout', policy: 'all-success',
    predecessorTaskTemplateIds: childIds
  }]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const expansions = await listSgosImmutableRecordsByField(
    fixture.root, started.process.processId,
    'fanout-expansion-receipt', 'processId', started.process.processId
  );
  assert.equal(expansions.length, 1);
  assert.equal(expansions[0].collectionSha256, fanout.collectionSha256);
  assert.deepEqual(expansions[0].items.map((entry) => entry.itemKey), ['a', 'b']);
  const wave = await runReadySgosTasks(fixture.root, started.process.processId, {
    program: compiled, maximumParallel: 8, clock: T1
  });
  assert.equal(wave.launched, 2, 'fan-out maximumParallel narrows the wider process run bound');
  await runNextSgosTask(fixture.root, started.process.processId, { program: compiled, clock: T1 });
  const ended = await runNextSgosTask(
    fixture.root, started.process.processId, { program: compiled, clock: T1 }
  );
  assert.equal(ended.process.status, 'succeeded');
  assert.equal((await fsckSgosProcess(fixture.root, started.process.processId)).status, 'ok');
});

test('Process start refuses nonexistent and mismatched Story subjects before even a NOOP can run', async () => {
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);

  const missing = await repository('SGOS-STORY-EXISTS');
  await assert.rejects(
    () => start(missing.root, 'SGOS-STORY-MISSING', compiled),
    (error) => error.code === 'SGOS_STORY_STATE_UNAVAILABLE'
  );
  assert.deepEqual(await listSgosProcesses(missing.root), []);

  const mismatched = await repository('SGOS-STORY-EXPECTED');
  await writeFile(mismatched.workflowPath, `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'SGOS-STORY-OTHER', title: 'Wrong Story authority' },
    currentPhase: 'implement'
  }, null, 2)}\n`);
  git(['add', '.'], mismatched.root);
  git(['commit', '-m', 'Commit mismatched Story identity'], mismatched.root);
  await assert.rejects(
    () => start(mismatched.root, mismatched.storyId, compiled),
    (error) => error.code === 'SGOS_STORY_STATE_SUBJECT_MISMATCH'
  );
  assert.deepEqual(await listSgosProcesses(mismatched.root), []);
});

test('start retry consumes exact Program and Binding reservations left after genesis state commit', async () => {
  const fixture = await repository('SGOS-STORY-GENESIS-CLEANUP');
  const compiled = program([
    task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])
  ]);
  await publishSgosProgramAuthority(fixture.root, compiled);
  const startOptions = {
    program: compiled,
    taskContractSha256: HASH.contract,
    subject: {
      kind: 'story', id: fixture.storyId, branch: 'main',
      baselineRevision: git(['rev-parse', 'HEAD'], fixture.root)
    },
    clock: T0
  };
  setSgosStoreFaultBoundaryForTests('genesis-state', { code: 'EIO' });
  try {
    await assert.rejects(
      () => startSgosProcess(fixture.root, startOptions),
      (error) => error.code === 'EIO'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  const recovered = await startSgosProcess(fixture.root, startOptions);
  assert.equal(recovered.created, false);
  assert.equal(recovered.recoveredStart, true);
  const report = await fsckSgosProcess(fixture.root, recovered.process.processId);
  assert.equal(report.status, 'ok', canonicalJson(report));
  assert.deepEqual(report.pendingReservations, []);
  assert.deepEqual(report.orphans, []);
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
  (error) => error.code === 'SGOS_TASK_TRANSITION_INVALID');
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
  await assert.rejects(
    () => pauseSgosProcess(fixture.root, started.process.processId, {
      expectedRevision: paused.processRevision,
      clock: T1
    }),
    (error) => error.code === 'SGOS_PROCESS_ALREADY_PAUSED'
  );
  const afterRepeatedPause = await readSgosProcess(fixture.root, paused.processId);
  assert.equal(afterRepeatedPause.processRevision, paused.processRevision);
  assert.equal(afterRepeatedPause.processSha256, paused.processSha256,
    'a repeated pause must not consume revision or control-lineage capacity');
  const resumed = await resumeSgosProcess(fixture.root, started.process.processId, {
    checkpointSha256: paused.currentCheckpointSha256,
    expectedRevision: paused.processRevision,
    clock: T1
  });
  assert.equal(resumed.status, 'running');
  assert.deepEqual(deterministicSgosReadySet(compiled, resumed).map((entry) => entry.taskTemplateId), ['10-noop']);

  await assert.rejects(
    () => resumeSgosProcess(fixture.root, resumed.processId, {
      checkpointSha256: resumed.currentCheckpointSha256,
      expectedRevision: resumed.processRevision,
      clock: T1
    }),
    (error) => error.code === 'SGOS_PROCESS_NOT_PAUSED'
  );
  assert.equal((await readSgosProcess(fixture.root, resumed.processId)).processSha256,
    resumed.processSha256, 'a repeated resume must not mutate a running Process');

  const expectedRevision = resumed.processRevision;
  const mutations = await Promise.allSettled([
    mutateSgosProcess(fixture.root, resumed.processId, (draft) => { draft.status = 'paused'; }, { expectedRevision, updatedAt: T1 }),
    mutateSgosProcess(fixture.root, resumed.processId, (draft) => { draft.status = 'paused'; }, { expectedRevision, updatedAt: T1 })
  ]);
  assert.equal(mutations.filter((entry) => entry.status === 'fulfilled').length, 1);
  const rejected = mutations.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'SGOS_PROCESS_REVISION_STALE');
});

test('immutable control lineage replays an exact pause rollback without mutating on read', async () => {
  const fixture = await repository('SGOS-STORY-PAUSE-ROLLBACK');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const statePath = sgosProcessStatePath(fixture.root, started.process.processId);
  const beforePauseBytes = await readFile(statePath, 'utf8');
  const paused = await pauseSgosProcess(fixture.root, started.process.processId, {
    expectedRevision: started.process.processRevision,
    clock: T1
  });
  await writeFile(statePath, beforePauseBytes);

  const replayed = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(replayed.processSha256, paused.processSha256);
  assert.equal(replayed.status, 'paused');
  assert.equal(await readFile(statePath, 'utf8'), beforePauseBytes,
    'read-only reconciliation must not rewrite the rolled-back state file');
  await assert.rejects(
    () => runNextSgosTask(fixture.root, replayed.processId, { expectedRevision: replayed.processRevision }),
    (error) => error.code === 'SGOS_PROCESS_NOT_RUNNABLE'
  );
});

test('public task execution recovers one exact successful transition across every durable publication boundary', async () => {
  const boundaries = [
    'transition-intent', 'record-index', 'control-event',
    'control-successor', 'state', 'reservation-cleanup', 'intent-removal'
  ];
  for (const boundary of boundaries) {
    const fixture = await repository(`SGOS-STORY-SUCCESS-CRASH-${boundary}`);
    const compiled = program([
      task('00-kernel', 'KERNEL', [], { operation: 'crash.success' }),
      task('90-end', 'END', ['00-kernel'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    let handlerCalls = 0;
    const adapters = governedKernel('crash.success', async () => {
      handlerCalls += 1;
      return { rawResult: { status: 'completed', boundary } };
    });
    setSgosStoreFaultBoundaryForTests(boundary, { occurrence: 2, code: 'EIO' });
    try {
      await assert.rejects(
        () => runNextSgosTask(fixture.root, started.process.processId, adapters),
        (error) => error.details?.causeCode === 'EIO'
          && error.code === (boundary === 'intent-removal'
            ? 'SGOS_TRANSITION_RECOVERED_RETRY'
            : 'SGOS_TRANSITION_RECOVERY_REQUIRED'),
        boundary
      );
      assert.equal(handlerCalls, 1, `${boundary}: governed handler runs once`);
      if (boundary !== 'intent-removal') {
        await assert.rejects(
          () => runNextSgosTask(fixture.root, started.process.processId, adapters),
          (error) => error.code === 'SGOS_TRANSITION_RECOVERED_RETRY',
          boundary
        );
      }
      assert.equal(handlerCalls, 1, `${boundary}: recovery never replays the handler`);
      const recovered = await readSgosProcess(fixture.root, started.process.processId);
      assert.equal(recovered.status, 'running', boundary);
      const completedTask = Object.values(recovered.taskInstances)
        .find((entry) => entry.taskTemplateId === '00-kernel');
      assert.equal(completedTask.state, 'succeeded', boundary);
      const attempts = await listSgosImmutableRecordsByField(
        fixture.root, recovered.processId, 'gvm-task-attempt',
        'attemptId', completedTask.attemptIds[0]
      );
      assert.deepEqual(attempts.map((attempt) => attempt.status).sort(),
        ['running', 'succeeded'], `${boundary}: no conflicting failed terminal attempt`);
      const evidence = await listSgosImmutableRecordsByField(
        fixture.root, recovered.processId, 'action-evidence',
        'attemptId', completedTask.attemptIds[0]
      );
      assert.equal(evidence.length, 1, `${boundary}: one exact success evidence record`);
      assert.equal(evidence[0].verification.status, 'passed', boundary);
      await reconcileSgosExecutionLeases(fixture.root, recovered.processId);
      const report = await fsckSgosProcess(fixture.root, recovered.processId);
      assert.equal(report.status, 'ok', `${boundary}: ${canonicalJson(report)}`);
      assert.equal(report.transitionIntent, null, boundary);
      assert.deepEqual(report.pendingReservations, [], boundary);
      assert.deepEqual(report.orphans, [], boundary);
    } finally {
      setSgosStoreFaultBoundaryForTests(null);
    }
  }
});

test('public task execution never invokes a handler when execution-start publication is interrupted', async () => {
  const boundaries = [
    'transition-intent', 'record-index', 'control-event',
    'control-successor', 'state', 'reservation-cleanup', 'intent-removal'
  ];
  for (const boundary of boundaries) {
    const fixture = await repository(`SGOS-STORY-START-CRASH-${boundary}`);
    const compiled = program([
      task('00-kernel', 'KERNEL', [], { operation: 'crash.start' }),
      task('90-end', 'END', ['00-kernel'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    let handlerCalls = 0;
    const adapters = governedKernel('crash.start', async () => {
      handlerCalls += 1;
      return { rawResult: { status: 'completed', boundary } };
    });
    setSgosStoreFaultBoundaryForTests(boundary, { code: 'EIO' });
    try {
      await assert.rejects(
        () => runNextSgosTask(fixture.root, started.process.processId, adapters),
        (error) => error.details?.causeCode === 'EIO'
          && error.code === (boundary === 'intent-removal'
            ? 'SGOS_TRANSITION_RECOVERED_RETRY'
            : 'SGOS_TRANSITION_RECOVERY_REQUIRED'),
        boundary
      );
      assert.equal(handlerCalls, 0, `${boundary}: no handler before committed execution start`);
      if (boundary !== 'intent-removal') {
        await assert.rejects(
          () => runNextSgosTask(fixture.root, started.process.processId, adapters),
          (error) => error.code === 'SGOS_TRANSITION_RECOVERED_RETRY',
          boundary
        );
      }
      assert.equal(handlerCalls, 0, `${boundary}: transition recovery is side-effect free`);
      const recovered = await readSgosProcess(fixture.root, started.process.processId);
      assert.equal(recovered.activeExecutions.length, 1, boundary);
      const attemptId = recovered.activeExecutions[0];
      const attempts = await listSgosImmutableRecordsByField(
        fixture.root, recovered.processId, 'gvm-task-attempt', 'attemptId', attemptId
      );
      assert.deepEqual(attempts.map((attempt) => attempt.status), ['running'], boundary);
      const evidence = await listSgosImmutableRecordsByField(
        fixture.root, recovered.processId, 'action-evidence', 'attemptId', attemptId
      );
      assert.deepEqual(evidence, [], boundary);
      const report = await fsckSgosProcess(fixture.root, recovered.processId);
      assert.equal(report.status, 'ok', `${boundary}: ${canonicalJson(report)}`);
      assert.equal(report.transitionIntent, null, boundary);
      assert.deepEqual(report.pendingReservations, [], boundary);
      assert.deepEqual(report.orphans, [], boundary);
    } finally {
      setSgosStoreFaultBoundaryForTests(null);
    }
  }
});

test('fsck returns a structured failure when the current control head is missing', async () => {
  const fixture = await repository('SGOS-STORY-FSCK-MISSING-HEAD');
  const compiled = program([
    task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const eventPath = path.join(
    path.dirname(sgosProcessStatePath(fixture.root, started.process.processId)),
    'control-events', `${started.process.controlEventSha256.slice('sha256:'.length)}.json`
  );
  await unlink(eventPath);
  const report = await fsckSgosProcess(fixture.root, started.process.processId);
  assert.equal(report.status, 'failed');
  assert.equal(report.cumulativeInfrastructureBytes, null);
  assert.equal(report.cumulativeInfrastructureRecords, null);
  assert.ok(report.errors.some((error) =>
    ['SGOS_RECORD_NOT_FOUND', 'SGOS_CONTROL_LINEAGE_INVALID'].includes(error.code)));
});

test('fsck rejects self-rehashed mutable state that does not reconstruct from its control head', async () => {
  const fixture = await repository('SGOS-STORY-FSCK-STATE-DRIFT');
  const compiled = program([
    task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const statePath = sgosProcessStatePath(fixture.root, started.process.processId);
  const changed = JSON.parse(await readFile(statePath, 'utf8'));
  delete changed.processSha256;
  changed.status = 'paused';
  changed.processSha256 = `sha256:${recordSha256(changed)}`;
  await writeFile(statePath, canonicalJson(changed));

  await assert.rejects(
    () => readSgosProcess(fixture.root, started.process.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
  const report = await fsckSgosProcess(fixture.root, started.process.processId);
  assert.equal(report.status, 'failed');
  assert.ok(report.errors.some((error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'));
});

test('only an unreplayable transition intent can be moved byte-for-byte to quarantine', async () => {
  const fixture = await repository('SGOS-STORY-INTENT-QUARANTINE');
  const compiled = program([
    task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  setSgosStoreFaultBoundaryForTests('transition-intent', { code: 'EIO' });
  try {
    await assert.rejects(
      () => pauseSgosProcess(fixture.root, started.process.processId, {
        expectedRevision: started.process.processRevision, clock: T1
      }),
      (error) => error.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  await assert.rejects(
    () => planSgosProcessQuarantine(fixture.root, started.process.processId),
    (error) => error.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED'
  );
  const processDirectory = sgosProcessDirectory(fixture.root, started.process.processId);
  const corruptIntentBytes = Buffer.from('not a valid transition intent\n');
  await writeFile(path.join(processDirectory, 'transition-intent.json'), corruptIntentBytes);
  const plan = await planSgosProcessQuarantine(fixture.root, started.process.processId);
  assert.equal(plan.reason, 'unreplayable-transition-intent');
  assert.equal(plan.transitionIntent.failureCode, 'SGOS_TRANSITION_INTENT_CORRUPT');
  assert.equal(plan.retryable, false);
  assert.equal(plan.resumable, false);
  assert.equal(plan.successClaimed, false);
  const quarantined = await quarantineSgosProcess(fixture.root, started.process.processId, {
    confirmationSha256: plan.confirmationSha256
  });
  const quarantineDirectory = path.join(
    fixture.root, '.git', 'singularity-flow',
    ...quarantined.quarantine.slice('$git/'.length).split('/')
  );
  assert.deepEqual(
    await readFile(path.join(quarantineDirectory, 'transition-intent.json')),
    corruptIntentBytes
  );
});

test('every public Process mutator settles an older transition before semantic preconditions', async () => {
  for (const operation of ['start', 'respond', 'recover', 'pause', 'resume']) {
    const fixture = await repository(`SGOS-STORY-PREFLIGHT-${operation}`);
    const compiled = program([
      task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    setSgosStoreFaultBoundaryForTests('transition-intent', { code: 'EIO' });
    try {
      await assert.rejects(
        () => pauseSgosProcess(fixture.root, started.process.processId, {
          expectedRevision: started.process.processRevision, clock: T1
        }),
        (error) => error.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED'
      );
    } finally {
      setSgosStoreFaultBoundaryForTests(null);
    }
    const invoke = {
      start: () => startSgosProcess(fixture.root, {
        program: compiled,
        taskContractSha256: HASH.contract,
        subject: {
          kind: 'story', id: fixture.storyId, branch: 'main',
          baselineRevision: git(['rev-parse', 'HEAD'], fixture.root)
        },
        clock: T0
      }),
      respond: () => respondToSgosHumanRequest(
        fixture.root, started.process.processId, {
          requestId: 'HRQ-NOTOPEN', requestSha256: HASH.intent,
          expectedRevision: started.process.processRevision,
          actor: { id: 'sgos@example.test', kind: 'human' },
          decision: 'approved', clock: T1
        }
      ),
      recover: () => recoverInterruptedSgosExecution(
        fixture.root, started.process.processId, {
          attemptId: 'ATT-NOTINTERRUPTED', resolution: 'fail',
          confirmationSha256: HASH.intent,
          expectedRevision: started.process.processRevision, clock: T1
        }
      ),
      pause: () => pauseSgosProcess(fixture.root, started.process.processId, {
        expectedRevision: started.process.processRevision, clock: T1
      }),
      resume: () => resumeSgosProcess(fixture.root, started.process.processId, {
        checkpointSha256: started.process.currentCheckpointSha256,
        expectedRevision: started.process.processRevision,
        program: compiled, clock: T1
      })
    }[operation];
    await assert.rejects(
      invoke,
      (error) => error.code === 'SGOS_TRANSITION_RECOVERED_RETRY'
        && error.details?.operation === operation,
      operation
    );
    const recovered = await readSgosProcess(fixture.root, started.process.processId);
    assert.equal(recovered.status, 'paused', operation);
    assert.equal((await fsckSgosProcess(fixture.root, recovered.processId)).status, 'ok', operation);
  }
});

test('current control-lineage inspection is O(1) after many prior transitions', async () => {
  const fixture = await repository('SGOS-STORY-CONTROL-LOOKUP');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let current = started.process;
  for (let index = 0; index < 50; index += 1) {
    current = await mutateSgosProcess(fixture.root, current.processId, (draft) => {
      draft.status = draft.status === 'paused' ? 'running' : 'paused';
    }, {
      expectedRevision: current.processRevision,
      expectedProcessSha256: current.processSha256,
      updatedAt: T1
    });
  }
  const inspection = await inspectSgosControlLineage(fixture.root, current.processId);
  assert.equal(inspection.replayedTransitions, 0);
  assert.equal(inspection.successorLookups, 1,
    'a current Process checks only its exact successor edge, not every historical event');
});

test('operator pause-resume churn is refused before consuming reserved control capacity', async () => {
  const fixture = await repository('SGOS-STORY-OPERATOR-CONTROL-CAP');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let current = started.process;
  for (let index = 0; index < SGOS_INSTALLED_LIMITS.maximumOperatorControlTransitions; index += 1) {
    current = await mutateSgosProcess(fixture.root, current.processId, (draft) => {
      draft.status = draft.status === 'paused' ? 'running' : 'paused';
    }, {
      expectedRevision: current.processRevision,
      expectedProcessSha256: current.processSha256,
      updatedAt: T1
    });
  }
  const beforeEvents = await listSgosImmutableRecordsByField(
    fixture.root, current.processId, 'sgos-control-event', 'processId', current.processId
  );
  await assert.rejects(
    () => mutateSgosProcess(fixture.root, current.processId, (draft) => {
      draft.status = draft.status === 'paused' ? 'running' : 'paused';
    }, {
      expectedRevision: current.processRevision,
      expectedProcessSha256: current.processSha256,
      updatedAt: T1
    }),
    (error) => error.code === 'SGOS_OPERATOR_CONTROL_LIMIT'
  );
  const after = await readSgosProcess(fixture.root, current.processId);
  const afterEvents = await listSgosImmutableRecordsByField(
    fixture.root, current.processId, 'sgos-control-event', 'processId', current.processId
  );
  assert.equal(after.processSha256, current.processSha256);
  assert.equal(afterEvents.length, beforeEvents.length,
    'capacity refusal must happen before event publication');
});

test('a current Process head is refused when its authoritative successor edge is deleted', async () => {
  const fixture = await repository('SGOS-STORY-CONTROL-EDGE-DELETED');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const head = (await readSgosImmutableRecord(
    fixture.root, started.process.processId, 'sgos-control-event',
    started.process.controlEventSha256
  )).record;
  const successorPath = path.join(
    path.dirname(sgosProcessStatePath(fixture.root, started.process.processId)),
    'control-next', `${head.beforeProcessSha256.slice('sha256:'.length)}.json`
  );
  await unlink(successorPath);
  await assert.rejects(
    () => readSgosProcess(fixture.root, started.process.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
});

test('a genesis state and event without their exact successor are not authoritative', async () => {
  const fixture = await repository('SGOS-STORY-GENESIS-EDGE-MISSING');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const roots = await listSgosImmutableRecordsByField(
    fixture.root, started.process.processId, 'sgos-control-event',
    'priorControlEventSha256', null
  );
  const genesis = roots.find((event) => event.beforeProcessRevision === 1);
  assert.ok(genesis);
  const rooted = processAtControlEvent(started.process, genesis);
  const processDirectory = path.dirname(sgosProcessStatePath(fixture.root, rooted.processId));
  await unlink(path.join(
    processDirectory, 'control-next',
    `${genesis.beforeProcessSha256.slice('sha256:'.length)}.json`
  ));
  await writeFile(sgosProcessStatePath(fixture.root, rooted.processId), canonicalJson(rooted));
  await assert.rejects(
    () => readSgosProcess(fixture.root, rooted.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
});

test('a strict successor record that points at another event cannot authorize the head', async () => {
  const fixture = await repository('SGOS-STORY-CONTROL-EDGE-MISMATCH');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const head = (await readSgosImmutableRecord(
    fixture.root, started.process.processId, 'sgos-control-event',
    started.process.controlEventSha256
  )).record;
  const roots = await listSgosImmutableRecordsByField(
    fixture.root, started.process.processId, 'sgos-control-event',
    'priorControlEventSha256', null
  );
  const other = roots.find((event) => event.controlEventSha256 !== head.controlEventSha256);
  assert.ok(other);
  const successorPath = path.join(
    path.dirname(sgosProcessStatePath(fixture.root, started.process.processId)),
    'control-next', `${head.beforeProcessSha256.slice('sha256:'.length)}.json`
  );
  const successor = JSON.parse(await readFile(successorPath, 'utf8'));
  successor.controlEventSha256 = other.controlEventSha256;
  successor.controlDepth = other.controlDepth;
  successor.operatorTransitionCount = other.operatorTransitionCount;
  delete successor.successorSha256;
  successor.successorSha256 = sgosSha256(successor);
  await writeFile(successorPath, canonicalJson(successor));
  await assert.rejects(
    () => readSgosProcess(fixture.root, started.process.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
});

test('a rooted Process resumes safely after a crash before its initial checkpoint CAS', async () => {
  const fixture = await repository('SGOS-STORY-GENESIS-CHECKPOINT-CRASH');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const roots = await listSgosImmutableRecordsByField(
    fixture.root, started.process.processId, 'sgos-control-event',
    'priorControlEventSha256', null
  );
  const genesis = roots.find((event) => event.beforeProcessRevision === 1);
  assert.ok(genesis, 'creation must publish one rev1 genesis event');
  const rooted = processAtControlEvent(started.process, genesis);
  assert.equal(rooted.processRevision, 2);
  assert.equal(rooted.currentCheckpointSha256, null);
  const statePath = sgosProcessStatePath(fixture.root, rooted.processId);
  const checkpointSuccessor = path.join(
    path.dirname(statePath), 'control-next', `${rooted.processSha256.slice('sha256:'.length)}.json`
  );
  await unlink(checkpointSuccessor);
  await writeFile(statePath, canonicalJson(rooted));

  const interrupted = await readSgosProcess(fixture.root, rooted.processId);
  assert.equal(interrupted.processSha256, rooted.processSha256);
  assert.equal(interrupted.currentCheckpointSha256, null);
  const recovered = await startSgosProcess(fixture.root, {
    program: compiled,
    taskContractSha256: HASH.contract,
    subject: {
      kind: 'story', id: fixture.storyId, branch: 'main',
      baselineRevision: git(['rev-parse', 'HEAD'], fixture.root)
    },
    clock: T0
  });
  assert.equal(recovered.recoveredStart, true);
  assert.match(recovered.process.currentCheckpointSha256, /^sha256:/);
  assert.notEqual(recovered.process.controlEventSha256, null);
  assert.equal((await readSgosProcess(fixture.root, rooted.processId)).processSha256,
    recovered.process.processSha256);
});

test('unrooted creation seeds cannot fabricate skipped completion or mutable authority', async () => {
  for (const mode of ['skipped-succeeded', 'open-request', 'checkpoint']) {
    const fixture = await repository(`SGOS-STORY-GENESIS-TAMPER-${mode.toUpperCase()}`);
    const compiled = program([
      task('00-noop', 'NOOP'),
      task('90-end', 'END', ['00-noop'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    const roots = await listSgosImmutableRecordsByField(
      fixture.root, started.process.processId, 'sgos-control-event',
      'priorControlEventSha256', null
    );
    const genesis = roots.find((event) => event.beforeProcessRevision === 1);
    assert.ok(genesis, mode);
    const honestSeed = unrootedSeedAtControlEvent(started.process, genesis);
    const tampered = structuredClone(honestSeed);
    if (mode === 'skipped-succeeded') {
      tampered.status = 'succeeded';
      for (const task of Object.values(tampered.taskInstances)) {
        task.state = 'skipped';
        task.receiptSha256 = null;
      }
    } else if (mode === 'open-request') {
      tampered.openHumanRequests = [HASH.intent];
    } else {
      tampered.currentCheckpointSha256 = HASH.candidate;
    }
    delete tampered.processSha256;
    tampered.processSha256 = sgosSha256(tampered);
    const statePath = sgosProcessStatePath(fixture.root, tampered.processId);
    await writeFile(statePath, canonicalJson(tampered));

    await assert.rejects(
      () => readSgosProcess(fixture.root, tampered.processId),
      (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID',
      mode
    );
    const listed = await listSgosProcesses(fixture.root);
    const unavailable = listed.find((entry) => entry.processId === tampered.processId);
    assert.equal(unavailable?.kind, 'sgos-process-unavailable', mode);
    assert.equal(unavailable?.error?.code, 'SGOS_CONTROL_LINEAGE_INVALID', mode);
    assert.equal(unavailable?.successClaimed, false, mode);
    assert.equal(unavailable?.resumable, false, mode);
    const requested = structuredClone(honestSeed);
    delete requested.processSha256;
    await assert.rejects(
      () => createSgosProcess(fixture.root, requested),
      (error) => error.code === 'SGOS_PROCESS_CREATION_SEED_CONFLICT',
      mode
    );
  }
});

test('v2 Process reads fail closed until an exact lock-bound control upgrade', async () => {
  const fixture = await repository('SGOS-STORY-V2-CONTROL-UPGRADE');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const { legacy, statePath } = await replaceProcessWithV2(fixture.root, started.process);
  await assert.rejects(
    () => readSgosProcess(fixture.root, legacy.processId),
    (error) => error.code === 'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED'
      && error.details?.expectedProcessSha256 === legacy.processSha256
  );
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion, 2);

  const upgraded = await upgradeSgosProcessControlLineage(fixture.root, legacy.processId, {
    expectedProcessSha256: legacy.processSha256
  });
  assert.equal(upgraded.schemaVersion, 3);
  assert.match(upgraded.controlEventSha256, /^sha256:/);
  assert.equal(upgraded.processRevision, legacy.processRevision + 1);
  assert.equal((await readSgosProcess(fixture.root, legacy.processId)).processSha256,
    upgraded.processSha256);
  const idempotent = await upgradeSgosProcessControlLineage(fixture.root, legacy.processId, {
    expectedProcessSha256: legacy.processSha256
  });
  assert.equal(idempotent.processSha256, upgraded.processSha256);
});

test('v2 control upgrade refuses forged binding and Program materialization before publication', async () => {
  for (const mode of ['binding', 'skipped-task']) {
    const fixture = await repository(`SGOS-STORY-V2-FORGED-${mode.toUpperCase()}`);
    const compiled = program([
      task('00-noop', 'NOOP'),
      task('90-end', 'END', ['00-noop'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    const { legacy, statePath } = await replaceProcessWithV2(fixture.root, started.process);
    delete legacy.processSha256;
    if (mode === 'binding') {
      legacy.authorityBinding.branch = 'forged-branch';
    } else {
      Object.values(legacy.taskInstances)[0].state = 'skipped';
    }
    legacy.processSha256 = sgosSha256(legacy);
    await writeFile(statePath, JSON.stringify(legacy));

    await assert.rejects(
      () => upgradeSgosProcessControlLineage(fixture.root, legacy.processId, {
        expectedProcessSha256: legacy.processSha256
      }),
      (error) => error.code === (mode === 'binding'
        ? 'SGOS_PROCESS_BINDING_INVALID'
        : 'SGOS_PROCESS_MATERIALIZATION_INVALID'),
      mode
    );
    assert.equal(
      await readSgosControlSuccessor(fixture.root, legacy.processId, legacy.processSha256),
      null,
      mode
    );
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), legacy, mode);
  }
});

test('an unrelated orphan control event cannot authorize an unupgraded v2 Process', async () => {
  const fixture = await repository('SGOS-STORY-V2-ORPHAN-EVENT');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const { legacy } = await replaceProcessWithV2(fixture.root, started.process);
  await putSgosImmutableRecord(fixture.root, legacy.processId, 'sgos-control-event',
    v2RootControlEvent(legacy, { beforeProcessSha256: `sha256:${'a'.repeat(64)}` }));

  await assert.rejects(
    () => readSgosProcess(fixture.root, legacy.processId),
    (error) => error.code === 'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED'
  );
  const upgraded = await upgradeSgosProcessControlLineage(fixture.root, legacy.processId, {
    expectedProcessSha256: legacy.processSha256
  });
  assert.match(upgraded.controlEventSha256, /^sha256:/);
  assert.equal(upgraded.processRevision, legacy.processRevision + 1);
});

test('v2 upgrade resumes an exact event-before-successor crash without a null head', async () => {
  const fixture = await repository('SGOS-STORY-V2-EVENT-CRASH');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const { legacy } = await replaceProcessWithV2(fixture.root, started.process);
  const staged = await putSgosImmutableRecord(
    fixture.root, legacy.processId, 'sgos-control-event', v2RootControlEvent(legacy)
  );

  await assert.rejects(
    () => readSgosProcess(fixture.root, legacy.processId),
    (error) => error.code === 'SGOS_PROCESS_CONTROL_UPGRADE_REQUIRED'
  );
  const upgraded = await upgradeSgosProcessControlLineage(fixture.root, legacy.processId, {
    expectedProcessSha256: legacy.processSha256
  });
  assert.notEqual(upgraded.controlEventSha256, staged.record.controlEventSha256);
  assert.notEqual(upgraded.controlEventSha256, null);
  assert.equal((await readSgosProcess(fixture.root, legacy.processId)).processSha256,
    upgraded.processSha256);
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

test('dispatch independently rejects a forged Process admission even when low-level storage was used', async () => {
  const fixture = await repository('SGOS-STORY-DISPATCH-ADMISSION');
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const processId = 'PROC-FORGED-ADMISSION-1';
  const binding = buildSgosProcessBinding(fixture.root, {
    processId,
    subjectId: fixture.storyId,
    subjectAuthority: started.binding.subjectAuthority,
    configurationAuthority: started.binding.configurationAuthority,
    branchName: started.binding.branch,
    baselineRevision: started.binding.baselineRevision,
    expectedProcessRevision: 0
  });
  await putSgosImmutableRecord(fixture.root, processId, 'gvm-program', compiled);
  await putSgosImmutableRecord(fixture.root, processId, 'process-binding', binding);
  const forged = structuredClone(started.process);
  delete forged.processSha256;
  forged.processId = processId;
  forged.processBindingSha256 = binding.bindingSha256;
  forged.currentCheckpointSha256 = null;
  forged.authorityBinding.baselineSnapshotSha256 = sgosSha256({
    kind: 'sgos-process-baseline',
    processBindingSha256: binding.bindingSha256,
    revision: binding.baselineRevision
  });
  const remappedIds = new Map(Object.values(forged.taskInstances).map((instance) => [
    instance.taskInstanceId,
    `TSK-${sgosSha256({
      processId, taskTemplateId: instance.taskTemplateId
    }).slice('sha256:'.length, 'sha256:'.length + 24).toUpperCase()}`
  ]));
  forged.taskInstances = Object.fromEntries(Object.values(forged.taskInstances).map((instance) => {
    const taskInstanceId = remappedIds.get(instance.taskInstanceId);
    return [taskInstanceId, {
      ...instance,
      taskInstanceId,
      predecessorTaskInstanceIds: instance.predecessorTaskInstanceIds.map((id) => remappedIds.get(id))
    }];
  }));
  // Keep the admission contract-valid while binding it to authority bytes that were never loaded
  // from the approved configuration. A public record constructor must not turn this into authority.
  forged.authorityBinding.executionAdmission.provenance.source.blobSha256 = HASH.authority;
  const created = await createSgosProcess(fixture.root, forged);
  await assert.rejects(
    () => runNextSgosTask(fixture.root, processId, { clock: T1 }),
    (error) => error.code === 'SGOS_PROGRAM_ADMISSION_INVALID'
  );
  const after = await readSgosProcess(fixture.root, processId);
  assert.equal(after.processRevision, created.processRevision);
  assert.deepEqual(after.activeExecutions, []);
});

test('dispatch refuses a low-level Process mutation that removes or skips compiled work', async () => {
  for (const mode of ['remove', 'skip']) {
    const fixture = await repository(`SGOS-STORY-MATERIALIZATION-${mode.toUpperCase()}`);
    const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    const first = Object.values(started.process.taskInstances)
      .find((entry) => entry.taskTemplateId === '00-noop');
    if (mode === 'remove') {
      await assert.rejects(
        () => mutateSgosProcess(fixture.root, started.process.processId, (draft) => {
          delete draft.taskInstances[first.taskInstanceId];
        }, { expectedRevision: started.process.processRevision, updatedAt: T1 }),
        (error) => error.code === 'SGOS_TASK_SET_CHANGED'
      );
      const unchanged = await readSgosProcess(fixture.root, started.process.processId);
      assert.equal(unchanged.processRevision, started.process.processRevision);
      continue;
    }
    await assert.rejects(
      () => mutateSgosProcess(fixture.root, started.process.processId, (draft) => {
        draft.taskInstances[first.taskInstanceId].state = 'skipped';
      }, { expectedRevision: started.process.processRevision, updatedAt: T1 }),
      (error) => error.code === 'SGOS_TASK_TRANSITION_INVALID',
      mode
    );
    const after = await readSgosProcess(fixture.root, started.process.processId);
    assert.equal(after.processRevision, started.process.processRevision);
    assert.deepEqual(after.activeExecutions, []);
  }
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
    (error) => ['SGOS_RECORD_LINEAGE_INVALID', 'SGOS_RECEIPT_LINEAGE_INVALID'].includes(error.code)
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
    attemptSha256: original.receipt.attemptSha256,
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
  ), (error) => ['SGOS_RECORD_LINEAGE_INVALID', 'SGOS_RECEIPT_LINEAGE_INVALID'].includes(error.code));
  assert.equal((await readSgosProcess(
    mismatchFixture.root, original.process.processId
  )).processSha256, original.process.processSha256);
  const fsck = await fsckSgosProcess(mismatchFixture.root, original.process.processId);
  assert.equal(fsck.status, 'attention');
  assert.ok(fsck.orphans.some((entry) =>
    entry.family === 'gvm-task-receipt'
      && entry.recordSha256 === forgedReceipt.receiptSha256));
});

test('typed Human Requests survive restart, reject stale responses, and project without authority', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN');
  const human = (id) => task(id, 'HUMAN_REQUEST', [], {
    operation: 'human.approval',
    authority: {
      kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
    },
    metadata: {
      sourceConstruct: 'human-request',
      humanRequest: {
        requestType: 'approval',
        requestedBy: { id: 'sgos-runtime', kind: 'system' },
        authorityRequired: {
          kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
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
        expiresAt: '2099-08-30T00:00:00.000Z'
      }
    }
  });
  const compiled = program([
    human('00-human-a'),
    human('10-human-b'),
    task('90-end', 'END', ['00-human-a', '10-human-b'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
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
  assert.equal(objects[0].view.actions[0].id, 'request.respond');
  assert.equal(objects[0].view.actions[0].operation, 'request.respond');
  assert.throws(() => { objects[0].view.actions.push({}); }, TypeError);
  assert.equal((await readSgosProcess(fixture.root, restarted.processId)).processSha256, restarted.processSha256);

  await assert.rejects(() => respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: restarted.processRevision - 1,
    actor: { id: 'sgos@example.test', kind: 'human' },
    decision: 'approved',
    clock: T1
  }), (error) => error.code === 'SGOS_HUMAN_REQUEST_STALE');

  const answered = await respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: restarted.processRevision,
    actor: { id: 'sgos@example.test', kind: 'human' },
    decision: 'approved',
    clock: T1
  });
  validateHumanResponse(answered.response);
  validateGvmTaskReceipt(answered.receipt);
  await assert.rejects(() => respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: requests[0].requestId,
    requestSha256: requests[0].requestSha256,
    expectedRevision: answered.process.processRevision,
    actor: { id: 'sgos@example.test', kind: 'human' },
    decision: 'approved',
    clock: T1
  }), (error) => error.code === 'SGOS_HUMAN_REQUEST_STALE');

  const remaining = requests.find((entry) => entry.requestId !== requests[0].requestId);
  const completedHuman = await respondToSgosHumanRequest(fixture.root, restarted.processId, {
    requestId: remaining.requestId,
    requestSha256: remaining.requestSha256,
    expectedRevision: answered.process.processRevision,
    actor: { id: 'sgos@example.test', kind: 'human' },
    decision: 'approved',
    clock: T1
  });
  const ended = await runNextSgosTask(fixture.root, restarted.processId, {
    expectedRevision: completedHuman.process.processRevision,
    clock: T1
  });
  assert.equal(ended.process.status, 'succeeded');
});

test('concurrent Human Request responders publish exactly one terminal attempt lineage', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-RACE');
  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: {
        kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
      },
      metadata: {
        sourceConstruct: 'human-request',
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: {
            kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
          },
          prompt: {
            title: 'Choose one terminal response',
            detail: 'Concurrent responders must not create divergent attempt lineage.'
          },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2099-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-human'])
  ]);
  await assert.rejects(() => startSgosProcess(fixture.root, {
    program: compiled,
    taskContractSha256: HASH.contract,
    subject: {
      kind: 'story', id: fixture.storyId, branch: 'main',
      baselineRevision: git(['rev-parse', 'HEAD'], fixture.root)
    },
    // These legacy caller assertions are deliberately unsupported and cannot change the pinned
    // approved configuration or add a principal.
    trustedAuthorities: [{
      kind: 'role', id: 'reviewer', principalId: 'forged@example.test',
      principalKind: 'human', assurance: 'configured-local', authoritySha256: HASH.authority
    }],
    configurationAuthority: {
      kind: 'approved-configuration-ref', ref: 'refs/heads/sflow/config',
      commit: '0'.repeat(40), workflowBlobSha256: HASH.authority
    },
    clock: T0
  }), (error) => error.code === 'SGOS_AUTHORITY_SELF_CLAIM_REFUSED');
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  const expectedRevision = waiting.process.processRevision;
  const attemptId = waiting.process.taskInstances[waiting.taskInstanceId].attemptIds.at(-1);
  const response = (decision) => respondToSgosHumanRequest(
    fixture.root, waiting.process.processId, {
      requestId: waiting.request.requestId,
      requestSha256: waiting.request.requestSha256,
      expectedRevision,
      actor: { id: 'sgos@example.test', kind: 'human' },
      decision,
      clock: T1
    }
  );
  const results = await Promise.allSettled([response('approved'), response('rejected')]);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  const rejected = results.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    ['SGOS_PROCESS_REVISION_STALE', 'SGOS_HUMAN_REQUEST_STALE',
      'SGOS_HUMAN_REQUEST_ALREADY_RESPONDED']
      .includes(rejected[0].reason?.code),
    rejected[0].reason?.code
  );

  const winner = fulfilled[0].value;
  const final = await readSgosProcess(fixture.root, waiting.process.processId);
  const taskState = final.taskInstances[waiting.taskInstanceId];
  assert.equal(taskState.state, winner.status);
  assert.deepEqual(final.openHumanRequests, []);
  const attempts = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'gvm-task-attempt', 'attemptId', attemptId
  );
  assert.deepEqual(attempts.map((entry) => entry.status).sort(), ['running', winner.status].sort());
  assert.equal(attempts.filter((entry) => entry.status !== 'running').length, 1);
  const responses = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'human-response', 'requestSha256', waiting.request.requestSha256
  );
  assert.equal(responses.length, 1);
  assert.equal(responses[0].responseSha256, winner.response.responseSha256);
  const receipts = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'gvm-task-receipt', 'attemptId', attemptId
  );
  assert.equal(receipts.length, winner.status === 'succeeded' ? 1 : 0);
});

test('rejected and cancelled Human Requests terminate without publishing success outputs', async () => {
  for (const decision of ['rejected', 'cancelled']) {
    const fixture = await repository(`SGOS-STORY-HUMAN-${decision.toUpperCase()}`);
    const compiled = program([
      task('00-human', 'HUMAN_REQUEST', [], {
        operation: 'human.approval',
        authority: {
          kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
        },
        metadata: {
          sourceConstruct: 'human-request',
          humanRequest: {
            requestType: 'approval',
            requestedBy: { id: 'sgos-runtime', kind: 'system' },
            authorityRequired: {
              kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
            },
            prompt: {
              title: 'Choose a non-success response',
              detail: 'The response remains evidence without becoming a successful task output.'
            },
            options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
            secretBroker: null, expiresAt: '2099-08-30T00:00:00.000Z'
          }
        }
      }),
      task('90-end', 'END', ['00-human'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
    const attemptId = waiting.process.taskInstances[waiting.taskInstanceId].attemptIds.at(-1);
    const answered = await respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      requestId: waiting.request.requestId,
      requestSha256: waiting.request.requestSha256,
      expectedRevision: waiting.process.processRevision,
      actor: { id: 'sgos@example.test', kind: 'human' },
      decision,
      clock: T1
    });

    const expectedStatus = decision === 'cancelled' ? 'cancelled' : 'failed';
    assert.equal(answered.status, expectedStatus);
    assert.equal(answered.process.status, expectedStatus);
    assert.equal(answered.process.taskInstances[waiting.taskInstanceId].state, expectedStatus);
    assert.deepEqual(answered.process.taskInstances[waiting.taskInstanceId].outputRefs, []);
    assert.equal(answered.process.taskInstances[waiting.taskInstanceId].receiptSha256, null);
    assert.deepEqual(answered.process.openHumanRequests, []);
    assert.equal(answered.receipt, null);

    const attempts = await listSgosImmutableRecordsByField(
      fixture.root, answered.process.processId, 'gvm-task-attempt', 'attemptId', attemptId
    );
    assert.deepEqual(attempts.map((entry) => entry.status).sort(), ['running', expectedStatus].sort());
    const responses = await listSgosImmutableRecordsByField(
      fixture.root, answered.process.processId, 'human-response', 'requestSha256', waiting.request.requestSha256
    );
    assert.equal(responses.length, 1);
    assert.equal(responses[0].responseSha256, answered.response.responseSha256);
    const receipts = await listSgosImmutableRecordsByField(
      fixture.root, answered.process.processId, 'gvm-task-receipt', 'attemptId', attemptId
    );
    assert.deepEqual(receipts, []);
    const report = await fsckSgosProcess(fixture.root, answered.process.processId);
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.orphans, []);
  }
});

test('Human Request authority ignores actor and resolver forgeries and accepts only the runtime-observed pinned identity', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-AUTHORITY');
  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: {
        kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
      },
      metadata: {
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: {
            kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
          },
          prompt: { title: 'Approve', detail: 'Authority must come from a trusted boundary.' },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2099-08-30T00:00:00.000Z'
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
      ...response,
      authorityResolver: async () => ({
        kind: 'role', id: 'reviewer', principalId: 'reviewer', principalKind: 'human',
        assurance: 'configured-local', authoritySha256: HASH.authority
      }),
      authorize: async () => true
    }),
    (error) => error.code === 'SGOS_AUTHORITY_SELF_CLAIM_REFUSED'
  );
  const answered = await respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
    ...response,
    actor: { id: 'sgos@example.test', kind: 'human' }
  });
  assert.equal(answered.status, 'succeeded');
  assert.equal(answered.response.actor.authoritySha256,
    started.process.authorityBinding.humanAuthorityRequirements[0].authoritySha256);
  assert.equal(answered.receipt.candidateSha256, answered.candidate.candidateSha256);
});

test('a different currently authorized reviewer can answer a request without inheriting the starter identity', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-HANDOFF');
  const workflow = YAML.parse(await readFile(fixture.workflowPath.replace(
    `/work-items/${fixture.storyId}/workflow.json`, '/workflow.yml'
  ), 'utf8'));
  workflow.approvalAuthorities.reviewer.members.push({
    name: 'Second Reviewer', email: 'second-reviewer@example.test'
  });
  await writeFile(path.join(fixture.root, 'singularity', 'workflow.yml'), YAML.stringify(workflow));
  git(['add', 'singularity/workflow.yml'], fixture.root);
  git(['commit', '-m', 'Authorize second SGOS reviewer'], fixture.root);

  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
      metadata: {
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
          prompt: { title: 'Approve handoff', detail: 'Any currently authorized reviewer may answer.' },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2099-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-human'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  git(['config', 'user.name', 'Second Reviewer'], fixture.root);
  git(['config', 'user.email', 'second-reviewer@example.test'], fixture.root);

  const answered = await respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
    requestId: waiting.request.requestId,
    requestSha256: waiting.request.requestSha256,
    expectedRevision: waiting.process.processRevision,
    actor: { id: 'second-reviewer@example.test', kind: 'human' },
    decision: 'approved',
    clock: T1
  });
  assert.equal(answered.status, 'succeeded');
  assert.equal(answered.response.actor.id, 'second-reviewer@example.test');
  assert.equal(answered.response.actor.authoritySha256,
    started.process.authorityBinding.humanAuthorityRequirements[0].authoritySha256);
});

test('Human Request expiry uses the runtime clock and cannot be bypassed by a caller clock', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-EXPIRED');
  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
      metadata: {
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
          prompt: { title: 'Expired request', detail: 'This request is intentionally expired.' },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2000-01-01T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-human'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, waiting.process.processId, {
      requestId: waiting.request.requestId,
      requestSha256: waiting.request.requestSha256,
      expectedRevision: waiting.process.processRevision,
      actor: { id: 'sgos@example.test', kind: 'human' },
      decision: 'approved',
      clock: '1999-01-01T00:00:00.000Z'
    }),
    (error) => error.code === 'SGOS_HUMAN_REQUEST_EXPIRED'
  );
});

test('Human Request response re-derives authority and rejects forged persisted membership', async () => {
  const fixture = await repository('SGOS-STORY-HUMAN-PERSISTED-FORGERY');
  const compiled = program([
    task('00-human', 'HUMAN_REQUEST', [], {
      operation: 'human.approval',
      authority: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
      metadata: {
        humanRequest: {
          requestType: 'approval',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
          prompt: { title: 'Approve', detail: 'Persisted assertions are not authority.' },
          options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
          secretBroker: null, expiresAt: '2099-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-human'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  const forged = structuredClone(waiting.process);
  delete forged.processSha256;
  forged.authorityBinding.humanAuthorityRequirements[0].authoritySha256 = HASH.authority;
  forged.processSha256 = sgosSha256(forged);
  // Simulate direct machine-local sidecar tampering, bypassing mutateSgosProcess's immutable-field
  // guard. Runtime authorization must still derive membership from approved configuration.
  await writeFile(sgosProcessStatePath(fixture.root, forged.processId), canonicalJson(forged));
  await assert.rejects(
    () => respondToSgosHumanRequest(fixture.root, forged.processId, {
      requestId: waiting.request.requestId,
      requestSha256: waiting.request.requestSha256,
      expectedRevision: forged.processRevision,
      actor: { id: 'sgos@example.test', kind: 'human' },
      decision: 'approved',
      clock: T1
    }),
    (error) => ['SGOS_HUMAN_AUTHORITY_BINDING_INVALID', 'SGOS_CONTROL_LINEAGE_INVALID']
      .includes(error.code)
  );
  await assert.rejects(
    () => readSgosProcess(fixture.root, forged.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
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
        kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
      },
      metadata: {
        humanRequest: {
          requestType: 'credential',
          requestedBy: { id: 'sgos-runtime', kind: 'system' },
          authorityRequired: {
            kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local'
          },
          prompt: { title: 'Credential handle', detail: 'Return only an external broker handle.' },
          options: [], inputSchema: handleSchema, sensitiveMode: 'secret-broker',
          externalUrl: null, secretBroker: 'vault:test', expiresAt: '2099-08-30T00:00:00.000Z'
        }
      }
    }),
    task('90-end', 'END', ['00-secret'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const waiting = await runNextSgosTask(fixture.root, started.process.processId, { clock: T0 });
  const base = {
    requestId: waiting.request.requestId,
    requestSha256: waiting.request.requestSha256,
    expectedRevision: waiting.process.processRevision,
    actor: { id: 'sgos@example.test', kind: 'human' },
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
  await publishSgosProgramAuthority(bindingFixture.root, simple);
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

test('timeout aborts and awaits an in-process handler before releasing its lease or exposing recovery', async () => {
  const fixture = await repository('SGOS-STORY-TIMEOUT-QUIESCENCE');
  const operation = 'story.abort-ignoring';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], {
      operation,
      timeoutMs: 5,
      retry: { maximumAttempts: 2 },
      recovery: { interruptedExecution: 'retry-safe' }
    }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let observedSignal = null;
  let reportAbort;
  let releaseHandler;
  let lateMutations = 0;
  const aborted = new Promise((resolve) => { reportAbort = resolve; });
  const held = new Promise((resolve) => {
    releaseHandler = () => {
      lateMutations += 1;
      resolve({ rawResult: { status: 'completed-after-timeout' } });
    };
  });
  const running = runNextSgosTask(fixture.root, started.process.processId, {
    handlers: { kernel: { [operation]: async ({ signal }) => {
      observedSignal = signal;
      if (signal.aborted) reportAbort();
      else signal.addEventListener('abort', reportAbort, { once: true });
      return held;
    } } },
    captureCandidates: { [operation]: async () => ({ resources: [] }) },
    verifiers: { [operation]: async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: HASH.checks
    }) },
    clock: T1
  });
  await Promise.race([
    aborted,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('handler was not abort-signaled')), 1_000))
  ]);
  assert.equal(observedSignal.aborted, true);

  const active = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(active.activeExecutions.length, 1);
  assert.equal(active.activeLeases.length, 1);
  const whileRunning = await planSgosProcessRecovery(fixture.root, active.processId);
  assert.equal(whileRunning.executionStatus, 'active');
  assert.equal(whileRunning.interrupted, false);
  assert.deepEqual(whileRunning.actions, []);
  const premature = await Promise.race([
    running.then(() => 'returned'),
    new Promise((resolve) => setTimeout(() => resolve('still-running'), 50))
  ]);
  assert.equal(premature, 'still-running', 'timeout must not return while ignored abort work is live');

  releaseHandler();
  const timedOut = await running;
  assert.equal(lateMutations, 1, 'the post-deadline mutation must settle before command return');
  assert.equal(timedOut.status, 'recovery-required');
  assert.equal(timedOut.error.code, 'SGOS_TASK_TIMEOUT');
  assert.deepEqual(timedOut.process.activeExecutions, []);
  assert.deepEqual(timedOut.process.activeLeases, []);
  assert.equal(await readSgosExecutionLease(fixture.root, active.processId, active.activeLeases[0]), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lateMutations, 1, 'no handler mutation may occur after the command has returned');

  const recovery = await planSgosProcessRecovery(fixture.root, active.processId);
  assert.equal(recovery.interrupted, true);
  assert.equal(recovery.executionStatus, 'uncertain-effect');
  assert.equal(recovery.retryAllowed, false);
  assert.equal(recovery.actions.some((action) => action.resolution === 'retry-safe'), false);
});

test('dispatch-time binding rejects HEAD drift without creating an attempt or changing Process state', async () => {
  const fixture = await repository('SGOS-STORY-DISPATCH-BINDING');
  const compiled = program([task('00-noop', 'NOOP'), task('90-end', 'END', ['00-noop'])]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const before = await readSgosProcess(fixture.root, started.process.processId);

  await writeFile(path.join(fixture.root, 'advanced-after-start.mjs'), 'export const advanced = true;\n');
  git(['add', 'advanced-after-start.mjs'], fixture.root);
  git(['commit', '-m', 'Advance HEAD after SGOS Process start'], fixture.root);

  await assert.rejects(
    () => runNextSgosTask(fixture.root, started.process.processId, { clock: T1 }),
    (error) => error.code === 'SGOS_PROCESS_BINDING_STALE'
      && error.details?.fields?.includes('baselineRevision')
  );
  const after = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(after.processRevision, before.processRevision);
  assert.equal(after.processSha256, before.processSha256);
  assert.deepEqual(after.activeExecutions, []);
  assert.deepEqual(Object.values(after.taskInstances).flatMap((entry) => entry.attemptIds), []);

  const recovery = await planSgosProcessRecovery(fixture.root, started.process.processId);
  assert.equal(recovery.interrupted, false);
  assert.equal(recovery.bindingStatus, 'stale');
  assert.deepEqual(recovery.bindingDetails.fields, ['baselineRevision']);
  await assert.rejects(
    () => pauseSgosProcess(fixture.root, started.process.processId, { expectedRevision: after.processRevision }),
    (error) => error.code === 'SGOS_PROCESS_BINDING_STALE'
  );
});

test('a live execution lease cannot be planned or authorized as interrupted recovery', async () => {
  const fixture = await repository('SGOS-STORY-LIVE-LEASE');
  const operation = 'story.live-observation';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let enter;
  let release;
  let handlerCalls = 0;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const running = runNextSgosTask(fixture.root, started.process.processId,
    governedKernel(operation, async () => {
      handlerCalls += 1;
      enter();
      await held;
      return { rawResult: { status: 'completed' } };
    }));
  await entered;

  const active = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(active.activeExecutions.length, 1);
  assert.equal(active.activeLeases.length, 1);
  await assert.rejects(
    () => resumeSgosProcess(fixture.root, active.processId, {
      checkpointSha256: active.currentCheckpointSha256,
      expectedRevision: active.processRevision,
      clock: T1
    }),
    (error) => error.code === 'SGOS_PROCESS_NOT_QUIESCENT'
  );
  const afterResumeRefusal = await readSgosProcess(fixture.root, active.processId);
  assert.equal(afterResumeRefusal.processSha256, active.processSha256);
  assert.deepEqual(afterResumeRefusal.activeLeases, active.activeLeases);
  assert.notEqual(await readSgosExecutionLease(
    fixture.root, active.processId, active.activeLeases[0]
  ), null);
  const plan = await planSgosProcessRecovery(fixture.root, active.processId);
  assert.equal(plan.interrupted, false);
  assert.equal(plan.executionStatus, 'active');
  assert.equal(plan.attemptId, active.activeExecutions[0]);
  assert.deepEqual(plan.actions, []);
  await assert.rejects(
    () => recoverInterruptedSgosExecution(fixture.root, active.processId, {
      attemptId: active.activeExecutions[0],
      resolution: 'fail',
      confirmationSha256: HASH.candidate,
      expectedRevision: active.processRevision,
      clock: T1
    }),
    (error) => error.code === 'SGOS_EXECUTION_STILL_ACTIVE'
  );

  release();
  const completed = await running;
  assert.equal(completed.status, 'succeeded');
  assert.equal(handlerCalls, 1);
  assert.equal(await readSgosExecutionLease(fixture.root, active.processId, active.activeLeases[0]), null);
});

test('dispatch lock-reconciles dead orphan leases but refuses a live process-instance owner', async () => {
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const deadFixture = await repository('SGOS-STORY-DEAD-ORPHAN-LEASE');
  const deadStarted = await start(deadFixture.root, deadFixture.storyId, compiled);
  const deadLease = {
    kind: 'sgos-execution-lease',
    leaseId: 'LEASE-dead-orphan-owner',
    processId: deadStarted.process.processId,
    attemptId: 'ATT-dead-orphan-owner',
    taskInstanceId: Object.keys(deadStarted.process.taskInstances)[0],
    ownerId: 'OWNER-dead-orphan-owner',
    ownerPid: exitedOwnerPid(),
    ownerStartFingerprint: HASH.authority,
    beforeProcessSha256: deadStarted.process.processSha256,
    beforeProcessRevision: deadStarted.process.processRevision,
    executionHandleSha256: HASH.candidate,
    attemptSha256: HASH.intent,
    acquiredAt: T0,
    heartbeatAt: T0
  };
  await writeSgosExecutionLease(deadFixture.root, deadStarted.process.processId, deadLease);
  const completed = await runNextSgosTask(
    deadFixture.root, deadStarted.process.processId, { clock: T1 }
  );
  assert.equal(completed.status, 'succeeded');
  assert.equal(await readSgosExecutionLease(
    deadFixture.root, deadStarted.process.processId, deadLease.leaseId
  ), null);

  const liveFixture = await repository('SGOS-STORY-LIVE-ORPHAN-LEASE');
  const liveStarted = await start(liveFixture.root, liveFixture.storyId, compiled);
  const liveLease = {
    kind: 'sgos-execution-lease',
    leaseId: 'LEASE-live-orphan-owner',
    processId: liveStarted.process.processId,
    attemptId: 'ATT-live-orphan-owner',
    taskInstanceId: Object.keys(liveStarted.process.taskInstances)[0],
    ownerId: 'OWNER-live-orphan-owner',
    ownerPid: process.pid,
    ownerStartFingerprint: currentSgosExecutionOwnerFingerprint(),
    beforeProcessSha256: liveStarted.process.processSha256,
    beforeProcessRevision: liveStarted.process.processRevision,
    executionHandleSha256: HASH.candidate,
    attemptSha256: HASH.intent,
    acquiredAt: T0,
    heartbeatAt: T0
  };
  registerSgosExecutionOwner({ ...liveLease, schemaVersion: 1 });
  await writeSgosExecutionLease(liveFixture.root, liveStarted.process.processId, liveLease);
  await assert.rejects(
    () => runNextSgosTask(liveFixture.root, liveStarted.process.processId, { clock: T1 }),
    (error) => error.code === 'SGOS_EXECUTION_LEASE_BUSY'
  );
  assert.equal((await readSgosProcess(liveFixture.root, liveStarted.process.processId)).processSha256,
    liveStarted.process.processSha256);
  assert.notEqual(await readSgosExecutionLease(
    liveFixture.root, liveStarted.process.processId, liveLease.leaseId
  ), null);
  unregisterSgosExecutionOwner(liveLease);
  const reconciled = await reconcileSgosExecutionLeases(
    liveFixture.root, liveStarted.process.processId
  );
  assert.deepEqual(reconciled.removed, [liveLease.leaseId]);
});

test('dispatch refuses an unbounded execution-lease sidecar before any Process mutation', async () => {
  const fixture = await repository('SGOS-STORY-LEASE-CAPACITY');
  const compiled = program([
    task('00-noop', 'NOOP'),
    task('90-end', 'END', ['00-noop'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const deadPid = exitedOwnerPid();
  const taskInstanceId = Object.keys(started.process.taskInstances)[0];
  for (let index = 0; index <= SGOS_INSTALLED_LIMITS.maximumExecutionLeases; index += 1) {
    await writeSgosExecutionLease(fixture.root, started.process.processId, {
      kind: 'sgos-execution-lease',
      leaseId: `LEASE-capacity-${String(index).padStart(2, '0')}`,
      processId: started.process.processId,
      attemptId: `ATT-capacity-${String(index).padStart(2, '0')}`,
      taskInstanceId,
      ownerId: `OWNER-capacity-${String(index).padStart(2, '0')}`,
      ownerPid: deadPid,
      ownerStartFingerprint: HASH.authority,
      beforeProcessSha256: started.process.processSha256,
      beforeProcessRevision: started.process.processRevision,
      executionHandleSha256: HASH.candidate,
      attemptSha256: HASH.intent,
      acquiredAt: T0,
      heartbeatAt: T0
    });
  }
  await assert.rejects(
    () => runNextSgosTask(fixture.root, started.process.processId, { clock: T1 }),
    (error) => error.code === 'SGOS_EXECUTION_LEASE_LIMIT'
      && error.details?.maximum === SGOS_INSTALLED_LIMITS.maximumExecutionLeases
  );
  assert.equal((await readSgosProcess(fixture.root, started.process.processId)).processSha256,
    started.process.processSha256);
});

test('terminal CAS retries do not rerun a handler after a concurrent unrelated Process revision', async () => {
  const fixture = await repository('SGOS-STORY-CONDITIONAL-LEASE-CLEANUP');
  const operation = 'story.conditional-cleanup';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const running = runNextSgosTask(fixture.root, started.process.processId,
    governedKernel(operation, async () => {
      enter();
      await held;
      throw new Error('handler ended after concurrent Process revision');
    }));
  await entered;
  const active = await readSgosProcess(fixture.root, started.process.processId);
  await mutateSgosProcess(fixture.root, active.processId, () => {}, {
    expectedRevision: active.processRevision,
    expectedProcessSha256: active.processSha256,
    updatedAt: T1
  });
  release();
  const failed = await running;
  assert.equal(failed.status, 'failed');
  const completed = await readSgosProcess(fixture.root, active.processId);
  assert.deepEqual(completed.activeExecutions, []);
  assert.deepEqual(completed.activeLeases, []);
  assert.equal(await readSgosExecutionLease(
    fixture.root, completed.processId, active.activeLeases[0]
  ), null, 'cleanup removes the owner lease only after the retried terminal CAS is durable');
});

test('active execution and lease state survive exact rollback and reject self-hashed clearing', async () => {
  const fixture = await repository('SGOS-STORY-ACTIVE-ROLLBACK');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.active-rollback' }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const statePath = sgosProcessStatePath(fixture.root, started.process.processId);
  const beforeExecutionBytes = await readFile(statePath, 'utf8');
  const crashed = await markSgosExecutionInterrupted(
    fixture.root, started.process, '00-kernel'
  );
  await writeFile(statePath, beforeExecutionBytes);
  const replayed = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(replayed.processSha256, crashed.interrupted.processSha256);
  assert.deepEqual(replayed.activeExecutions, [crashed.attemptId]);
  assert.deepEqual(replayed.activeLeases, [crashed.lease.leaseId]);

  const forged = structuredClone(replayed);
  delete forged.processSha256;
  forged.activeExecutions = [];
  forged.activeLeases = [];
  forged.status = 'running';
  forged.processSha256 = sgosSha256(forged);
  await writeFile(statePath, canonicalJson(forged));
  await assert.rejects(
    () => readSgosProcess(fixture.root, forged.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
});

test('recovery-required state cannot be rolled back or forged into retry-ready state', async () => {
  const fixture = await repository('SGOS-STORY-RECOVERY-ROLLBACK');
  const operation = 'story.uncertain-write';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], {
      operation,
      resources: { reads: [], writes: ['src'], devices: [], externalEffects: [] }
    }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const statePath = sgosProcessStatePath(fixture.root, started.process.processId);
  const beforeExecutionBytes = await readFile(statePath, 'utf8');
  const failed = await runNextSgosTask(fixture.root, started.process.processId,
    governedKernel(operation, async () => { throw new Error('uncertain write failure'); }));
  assert.equal(failed.status, 'recovery-required');
  assert.equal(failed.process.status, 'recovery-required');

  await writeFile(statePath, beforeExecutionBytes);
  const replayed = await readSgosProcess(fixture.root, started.process.processId);
  assert.equal(replayed.processSha256, failed.process.processSha256);
  assert.equal(replayed.status, 'recovery-required');
  await assert.rejects(
    () => runNextSgosTask(fixture.root, replayed.processId, {
      expectedRevision: replayed.processRevision
    }),
    (error) => error.code === 'SGOS_PROCESS_NOT_RUNNABLE'
  );

  const forged = structuredClone(replayed);
  delete forged.processSha256;
  const target = Object.values(forged.taskInstances)
    .find((entry) => entry.taskTemplateId === '00-kernel');
  target.state = 'ready';
  target.revision += 1;
  forged.status = 'running';
  forged.processSha256 = sgosSha256(forged);
  await writeFile(statePath, canonicalJson(forged));
  await assert.rejects(
    () => readSgosProcess(fixture.root, forged.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
});

test('HEAD drift during a handler prevents a success receipt and moves the task to recovery', async () => {
  const fixture = await repository('SGOS-STORY-MIDFLIGHT-BINDING');
  const operation = 'story.midflight-observation';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const running = runNextSgosTask(fixture.root, started.process.processId,
    governedKernel(operation, async () => {
      enter();
      await held;
      return { rawResult: { status: 'completed' } };
    }));
  await entered;
  await writeFile(path.join(fixture.root, 'advanced-during-handler.mjs'), 'export const advanced = true;\n');
  git(['add', 'advanced-during-handler.mjs'], fixture.root);
  git(['commit', '-m', 'Advance HEAD during SGOS handler'], fixture.root);
  release();

  const result = await running;
  assert.equal(result.status, 'recovery-required');
  assert.equal(result.error.code, 'SGOS_PROCESS_BINDING_STALE');
  assert.equal(result.process.status, 'recovery-required');
  const taskState = result.process.taskInstances[result.taskInstanceId];
  assert.equal(taskState.state, 'recovery-required');
  assert.equal(taskState.receiptSha256, null);
  assert.deepEqual(result.process.activeExecutions, []);
  assert.deepEqual(result.process.activeLeases, []);
  assert.deepEqual(await listSgosImmutableRecordsByField(
    fixture.root, result.process.processId, 'gvm-task-receipt', 'attemptId', result.attempt.attemptId
  ), []);
  const plan = await planSgosProcessRecovery(fixture.root, result.process.processId);
  assert.equal(plan.interrupted, true);
  assert.equal(plan.executionStatus, 'uncertain-effect');
  assert.equal(plan.bindingStatus, 'stale');
  assert.deepEqual(plan.actions.map((entry) => entry.resolution), ['fail']);
  const stabilized = await recoverInterruptedSgosExecution(fixture.root, result.process.processId, {
    attemptId: result.attempt.attemptId,
    resolution: 'fail',
    confirmationSha256: plan.actions[0].confirmationSha256,
    expectedRevision: plan.processRevision,
    clock: T1
  });
  assert.equal(stabilized.status, 'failed');
  assert.equal(stabilized.process.status, 'failed');
});

test('an owner-exited execution can be failed exactly once with immutable start and terminal lineage', async () => {
  const fixture = await repository('SGOS-STORY-EXITED-LEASE');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.crashed-observation' }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const crashed = await markSgosExecutionInterrupted(
    fixture.root, started.process, '00-kernel'
  );
  const plan = await planSgosProcessRecovery(fixture.root, crashed.interrupted.processId);
  assert.equal(plan.interrupted, true);
  assert.equal(plan.executionStatus, 'owner-exited');
  assert.equal(plan.retryAllowed, false);
  assert.deepEqual(plan.actions.map((entry) => entry.resolution), ['fail']);

  const failed = await recoverInterruptedSgosExecution(
    fixture.root, crashed.interrupted.processId, {
      attemptId: crashed.attemptId,
      resolution: 'fail',
      confirmationSha256: plan.actions[0].confirmationSha256,
      expectedRevision: plan.processRevision,
      clock: T1
    }
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.process.status, 'failed');
  assert.deepEqual(failed.process.activeExecutions, []);
  assert.deepEqual(failed.process.activeLeases, []);
  assert.equal(await readSgosExecutionLease(
    fixture.root, failed.process.processId, crashed.lease.leaseId
  ), null);
  const attempts = await listSgosImmutableRecordsByField(
    fixture.root, failed.process.processId, 'gvm-task-attempt', 'attemptId', crashed.attemptId
  );
  assert.deepEqual(attempts.map((entry) => entry.status).sort(), ['failed', 'running']);
  assert.equal(new Set(attempts.map((entry) => entry.executionHandleSha256)).size, 1);
});

test('recovery fails closed when a terminal attempt exists without its required receipt', async () => {
  const fixture = await repository('SGOS-STORY-TERMINAL-WITHOUT-RECEIPT');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation: 'story.crashed-after-terminal' }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const crashed = await markSgosExecutionInterrupted(
    fixture.root, started.process, '00-kernel'
  );
  const terminal = buildSgosTaskAttempt({
    attemptId: crashed.attemptId,
    processId: crashed.interrupted.processId,
    taskInstanceId: crashed.task.taskInstanceId,
    attemptNumber: 1,
    parentAttemptId: null,
    reason: 'initial',
    taskContractSha256: crashed.interrupted.taskContractSha256,
    executionHandleSha256: crashed.lease.executionHandleSha256,
    status: 'succeeded',
    startedAt: T0,
    completedAt: T1
  });
  await putSgosImmutableRecord(
    fixture.root, crashed.interrupted.processId, 'gvm-task-attempt', terminal
  );
  const plan = await planSgosProcessRecovery(fixture.root, crashed.interrupted.processId);
  assert.equal(plan.interrupted, true);
  assert.equal(plan.blockedReason,
    'incomplete-terminal-lineage-requires-archival-review');
  assert.equal(plan.retryAllowed, false);
  assert.deepEqual(plan.actions, []);
  await assert.rejects(
    () => recoverInterruptedSgosExecution(fixture.root, crashed.interrupted.processId, {
      attemptId: crashed.attemptId,
      resolution: 'fail',
      confirmationSha256: HASH.candidate,
      expectedRevision: plan.processRevision,
      clock: T1
    }),
    (error) => error.code === 'SGOS_EXECUTION_RETRY_UNSAFE'
  );
  const after = await readSgosProcess(fixture.root, crashed.interrupted.processId);
  assert.equal(after.processRevision, plan.processRevision);
  assert.deepEqual(after.activeExecutions, [crashed.attemptId]);
});

test('interrupted retry requires an explicit read-only retry-safe contract', async () => {
  const cases = [
    { name: 'undeclared', recovery: {}, resources: { reads: [], writes: [], devices: [], externalEffects: [] }, allowed: false },
    {
      name: 'writes', recovery: { interruptedExecution: 'retry-safe' },
      resources: { reads: [], writes: ['src'], devices: [], externalEffects: [] }, allowed: false
    },
    {
      name: 'read-only', recovery: { interruptedExecution: 'retry-safe' },
      resources: { reads: ['src'], writes: [], devices: [], externalEffects: [] }, allowed: true
    }
  ];
  for (const entry of cases) {
    const fixture = await repository(`SGOS-STORY-RETRY-${entry.name.toUpperCase()}`);
    const compiled = program([
      task('00-kernel', 'KERNEL', [], {
        operation: `story.${entry.name}`,
        resources: entry.resources,
        recovery: entry.recovery,
        retry: { maximumAttempts: 2 }
      }),
      task('90-end', 'END', ['00-kernel'])
    ]);
    const started = await start(fixture.root, fixture.storyId, compiled);
    const crashed = await markSgosExecutionInterrupted(
      fixture.root, started.process, '00-kernel'
    );
    const plan = await planSgosProcessRecovery(fixture.root, crashed.interrupted.processId);
    assert.equal(plan.retryAllowed, entry.allowed, entry.name);
    assert.equal(plan.actions.some((action) => action.resolution === 'retry-safe'), entry.allowed, entry.name);
    if (!entry.allowed) {
      await assert.rejects(
        () => recoverInterruptedSgosExecution(fixture.root, crashed.interrupted.processId, {
          attemptId: crashed.attemptId,
          resolution: 'retry-safe',
          confirmationSha256: HASH.candidate,
          expectedRevision: plan.processRevision,
          clock: T1
        }),
        (error) => error.code === 'SGOS_EXECUTION_RETRY_UNSAFE',
        entry.name
      );
      continue;
    }
    const action = plan.actions.find((candidate) => candidate.resolution === 'retry-safe');
    const retried = await recoverInterruptedSgosExecution(
      fixture.root, crashed.interrupted.processId, {
        attemptId: crashed.attemptId,
        resolution: 'retry-safe',
        confirmationSha256: action.confirmationSha256,
        expectedRevision: plan.processRevision,
        clock: T1
      }
    );
    assert.equal(retried.status, 'retry-ready');
    assert.equal(retried.process.status, 'running');
    assert.equal(retried.process.taskInstances[crashed.task.taskInstanceId].state, 'ready');
    assert.deepEqual(retried.process.activeExecutions, []);
    assert.deepEqual(retried.process.activeLeases, []);
  }
});

test('concurrent recovery resolutions publish one terminal attempt and cannot poison lineage', async () => {
  const fixture = await repository('SGOS-STORY-RECOVERY-RACE');
  const compiled = program([
    task('00-kernel', 'KERNEL', [], {
      operation: 'story.concurrent-recovery',
      resources: { reads: ['src'], writes: [], devices: [], externalEffects: [] },
      recovery: { interruptedExecution: 'retry-safe' },
      retry: { maximumAttempts: 2 }
    }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const crashed = await markSgosExecutionInterrupted(
    fixture.root, started.process, '00-kernel'
  );
  const plan = await planSgosProcessRecovery(fixture.root, crashed.interrupted.processId);
  const failAction = plan.actions.find((entry) => entry.resolution === 'fail');
  const retryAction = plan.actions.find((entry) => entry.resolution === 'retry-safe');
  assert.ok(failAction);
  assert.ok(retryAction);
  const apply = (resolution, confirmationSha256) => recoverInterruptedSgosExecution(
    fixture.root, crashed.interrupted.processId, {
      attemptId: crashed.attemptId,
      resolution,
      confirmationSha256,
      expectedRevision: plan.processRevision,
      clock: T1
    }
  );
  const results = await Promise.allSettled([
    apply('retry-safe', retryAction.confirmationSha256),
    apply('fail', failAction.confirmationSha256)
  ]);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  const rejected = results.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    ['SGOS_PROCESS_REVISION_STALE', 'SGOS_EXECUTION_RECOVERY_STALE',
      'SGOS_EXECUTION_RECOVERY_INVALID'].includes(rejected[0].reason?.code),
    rejected[0].reason?.code
  );

  const winner = fulfilled[0].value;
  const final = await readSgosProcess(fixture.root, crashed.interrupted.processId);
  const taskState = final.taskInstances[crashed.task.taskInstanceId];
  assert.equal(taskState.state, winner.resolution === 'retry-safe' ? 'ready' : 'failed');
  assert.equal(final.status, winner.resolution === 'retry-safe' ? 'running' : 'failed');
  assert.deepEqual(final.activeExecutions, []);
  assert.deepEqual(final.activeLeases, []);
  const attempts = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'gvm-task-attempt', 'attemptId', crashed.attemptId
  );
  assert.deepEqual(attempts.map((entry) => entry.status).sort(), ['failed', 'running']);
  assert.equal(attempts.filter((entry) => entry.status !== 'running').length, 1);
  assert.equal(new Set(attempts.map((entry) => entry.executionHandleSha256)).size, 1);
  const evidence = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'action-evidence', 'attemptId', crashed.attemptId
  );
  assert.equal(evidence.length, 1);
  const receipts = await listSgosImmutableRecordsByField(
    fixture.root, final.processId, 'gvm-task-receipt', 'attemptId', crashed.attemptId
  );
  assert.deepEqual(receipts, []);
});

test('mutable rollback cannot fabricate an interrupted success-reconciliation boundary', async () => {
  const fixture = await repository('SGOS-STORY-RECONCILE-SUCCESS');
  const operation = 'story.reconcile-observation';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], { operation }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  const completed = await runNextSgosTask(
    fixture.root, started.process.processId,
    governedKernel(operation, async () => ({ rawResult: { status: 'completed' } }))
  );
  assert.equal(completed.status, 'succeeded');
  const taskState = completed.process.taskInstances[completed.taskInstanceId];
  const leaseId = `LEASE-reconcile-${completed.process.processId.slice('PROC-'.length)}`;
  const deadLease = {
    kind: 'sgos-execution-lease',
    leaseId,
    processId: completed.process.processId,
    attemptId: completed.attempt.attemptId,
    taskInstanceId: completed.taskInstanceId,
    ownerId: `OWNER-reconcile-${completed.process.processId.slice('PROC-'.length)}`,
    ownerPid: exitedOwnerPid(),
    ownerStartFingerprint: HASH.authority,
    beforeProcessSha256: completed.process.processSha256,
    beforeProcessRevision: completed.process.processRevision,
    executionHandleSha256: completed.attempt.executionHandleSha256,
    attemptSha256: completed.attempt.attemptSha256,
    acquiredAt: T0,
    heartbeatAt: T0
  };
  await writeSgosExecutionLease(fixture.root, completed.process.processId, deadLease);
  // Reconstruct the exact crash boundary: the verified receipt reached durable immutable storage,
  // but the final mutable-state CAS did not. Public mutation APIs correctly refuse rolling a
  // succeeded task backwards, so this fixture writes a self-hashed interrupted snapshot directly.
  const interrupted = structuredClone(completed.process);
  delete interrupted.processSha256;
  const target = interrupted.taskInstances[completed.taskInstanceId];
  target.state = 'running';
  target.outputRefs = [];
  target.receiptSha256 = null;
  target.revision += 1;
  for (const candidate of Object.values(interrupted.taskInstances)) {
    if (candidate.taskInstanceId !== target.taskInstanceId && candidate.state === 'ready') {
      candidate.state = 'waiting';
      candidate.revision += 1;
    }
  }
  interrupted.activeExecutions = [completed.attempt.attemptId];
  interrupted.activeLeases = [leaseId];
  interrupted.status = 'running';
  interrupted.processRevision += 1;
  interrupted.updatedAt = T1;
  interrupted.processSha256 = sgosSha256(interrupted);
  await writeFile(
    sgosProcessStatePath(fixture.root, completed.process.processId),
    canonicalJson(interrupted)
  );
  assert.equal(interrupted.taskInstances[completed.taskInstanceId].receiptSha256, null);

  await assert.rejects(
    () => planSgosProcessRecovery(fixture.root, interrupted.processId),
    (error) => error.code === 'SGOS_CONTROL_LINEAGE_INVALID'
  );
  assert.notEqual(completed.process.taskInstances[completed.taskInstanceId].receiptSha256, null);
  assert.equal(taskState.attemptIds.length, 1);
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
    const started = await start(fixture.root, fixture.storyId, compiled);
    const result = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason.code.includes(opcode), true);
    assert.equal(Object.values(result.process.taskInstances).some((entry) => entry.receiptSha256), false);
  }
});

test('exact deterministic AGENT and read-only DEVICE manifests execute through GVM receipts', async () => {
  const fixture = await repository('SGOS-STORY-INSTALLED-ADAPTERS');
  const { compiled, agentManifest, deviceManifest } = compilerProducedAdapterProgram();
  const started = await start(fixture.root, fixture.storyId, compiled);
  const agent = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
  assert.equal(agent.status, 'succeeded');
  assert.match(agent.receipt.outputRefs[0], /^sha256:/);
  const afterAgent = await fsckSgosProcess(fixture.root, started.process.processId);
  assert.deepEqual(afterAgent.errors, []);
  const device = await runNextSgosTask(fixture.root, started.process.processId, { clock: T1 });
  assert.equal(device.status, 'succeeded');
  assert.match(device.receipt.outputRefs[0], /^sha256:/);
  const evidence = await listSgosImmutableRecordsByField(
    fixture.root, device.process.processId, 'action-evidence', 'attemptId', device.attempt.attemptId
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].deviceManifestSha256, deviceManifest.manifestSha256);
  assert.equal(evidence[0].gaps.some((entry) => entry.includes('device-manifest-unavailable')), false);
});

test('process stop records pause before quiescence and prevents late handler success', async () => {
  const fixture = await repository('SGOS-STORY-STOP-QUIESCENCE');
  const operation = 'story.stop-aware';
  const compiled = program([
    task('00-kernel', 'KERNEL', [], {
      operation,
      retry: { maximumAttempts: 2 },
      resources: { reads: [], writes: [], devices: [], externalEffects: [] }
    }),
    task('90-end', 'END', ['00-kernel'])
  ]);
  const started = await start(fixture.root, fixture.storyId, compiled);
  let observedAbort = false;
  const running = runNextSgosTask(fixture.root, started.process.processId,
    governedKernel(operation, ({ signal }) => new Promise((resolve) => {
      const finish = () => {
        observedAbort = signal.aborted;
        resolve({ rawResult: { status: 'completed-after-stop' } });
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', () => setTimeout(finish, 10), { once: true });
    })));
  let active;
  for (let tries = 0; tries < 200; tries += 1) {
    active = await readSgosProcess(fixture.root, started.process.processId);
    if (active.activeExecutions.length) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(active.activeExecutions.length, 1);
  const requested = await stopSgosProcess(fixture.root, started.process.processId);
  assert.equal(requested.status, 'stop-requested');
  assert.equal(requested.quiescent, false);
  assert.equal(requested.process.status, 'paused');
  const settled = await running;
  assert.equal(observedAbort, true);
  assert.notEqual(settled.status, 'succeeded');
  assert.equal(settled.process.status, 'paused');
  assert.deepEqual(settled.process.activeExecutions, []);
  assert.deepEqual(settled.process.activeLeases, []);
  assert.equal(settled.receipt, undefined);
  const quiescent = await stopSgosProcess(fixture.root, started.process.processId);
  assert.equal(quiescent.changed, false);
  assert.equal(quiescent.quiescent, true);
  await assert.rejects(
    stopSgosProcess(fixture.root, started.process.processId, {
      expectedRevision: quiescent.process.processRevision - 1
    }),
    (error) => error.code === 'SGOS_PROCESS_REVISION_STALE'
  );
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
