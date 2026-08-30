import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition } from '../src/config.mjs';
import { createGvmProgram } from '../src/sgos/contracts.mjs';
import { SGOS_COMPILER_ID, SGOS_COMPILER_VERSION } from '../src/sgos/compiler.mjs';
import {
  forkSgosProcess, planSgosProcessFork, planSgosProcessReplay, replaySgosProcess
} from '../src/sgos/lineage.mjs';
import {
  pauseSgosProcess, runNextSgosTask, startSgosProcess
} from '../src/sgos/runtime.mjs';
import {
  fsckSgosProcess, readSgosCheckpoint, readSgosProcess,
  setSgosStoreFaultBoundaryForTests, mutateSgosProcess
} from '../src/sgos/store.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

const D = Object.freeze({
  intent: `sha256:${'1'.repeat(64)}`,
  workflow: `sha256:${'2'.repeat(64)}`,
  ratification: `sha256:${'3'.repeat(64)}`,
  policy: `sha256:${'4'.repeat(64)}`,
  registry: `sha256:${'5'.repeat(64)}`,
  storage: `sha256:${'6'.repeat(64)}`,
  contract: `sha256:${'7'.repeat(64)}`,
  manifest: `sha256:${'8'.repeat(64)}`,
  checks: `sha256:${'9'.repeat(64)}`
});
const T0 = '2026-08-30T10:00:00.000Z';
const T1 = '2026-08-30T10:01:00.000Z';
const T2 = '2026-08-30T10:02:00.000Z';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t, storyId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-lineage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Lineage Tester']);
  git(root, ['config', 'user.email', 'lineage@example.test']);
  await initializeDefinition(root);
  const storyDirectory = path.join(root, 'singularity', 'work-items', storyId);
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: storyId, title: 'Replay and fork fixture' },
    currentPhase: 'implementation'
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Lineage fixture']);
  return root;
}

function task(taskTemplateId, opcode, dependsOn = [], resources = null) {
  const material = !['NOOP', 'CHECKPOINT', 'JOIN', 'END'].includes(opcode);
  return {
    taskTemplateId,
    opcode,
    operation: `kernel.${opcode.toLowerCase()}`,
    dependsOn,
    resources: resources ?? { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: material ? { required: ['candidate', 'verification-result'] } : {},
    authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
    retry: { maximumAttempts: 2 }, policySnapshotSha256: D.policy,
    material,
    metadata: {
      sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: D.manifest
    }
  };
}

function program(resources = null) {
  const tasks = [
    task('00-start', 'NOOP'),
    task('10-boundary', 'CHECKPOINT', ['00-start']),
    task('20-work', 'NOOP', ['10-boundary'], resources),
    task('90-end', 'END', ['20-work'])
  ];
  return createGvmProgram({
    intentIrSha256: D.intent,
    workflowSha256: D.workflow,
    ratificationSha256: D.ratification,
    policySnapshotSha256: D.policy,
    registrySnapshotSha256: D.registry,
    storageProfileSha256: D.storage,
    taskTemplates: tasks,
    edges: tasks.flatMap((entry) => entry.dependsOn.map((from) => ({ from, to: entry.taskTemplateId }))),
    joins: [],
    budgets: { maximumTasks: tasks.length, maximumAttempts: 2 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: '90-end', state: 'succeeded' }],
    compiler: { id: SGOS_COMPILER_ID, version: SGOS_COMPILER_VERSION }
  });
}

function replayJoinProgram() {
  const tasks = [
    task('00-start', 'NOOP'),
    task('10-boundary', 'CHECKPOINT', ['00-start']),
    task('20-work', 'KERNEL', ['10-boundary']),
    task('30-join', 'JOIN', ['20-work']),
    task('90-end', 'END', ['30-join'])
  ];
  return createGvmProgram({
    intentIrSha256: D.intent,
    workflowSha256: D.workflow,
    ratificationSha256: D.ratification,
    policySnapshotSha256: D.policy,
    registrySnapshotSha256: D.registry,
    storageProfileSha256: D.storage,
    taskTemplates: tasks,
    edges: tasks.flatMap((entry) => entry.dependsOn.map((from) => ({ from, to: entry.taskTemplateId }))),
    joins: [{
      joinId: 'replay-terminal', taskTemplateId: '30-join', policy: 'all-terminal',
      predecessorTaskTemplateIds: ['20-work']
    }],
    budgets: { maximumTasks: tasks.length, maximumAttempts: 2 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: '90-end', state: 'succeeded' }],
    compiler: { id: SGOS_COMPILER_ID, version: SGOS_COMPILER_VERSION }
  });
}

function successfulKernel() {
  return {
    handlers: { kernel: { 'kernel.kernel': async () => ({
      outputRefs: ['sfref:historical-output'], rawResult: { status: 'completed' }
    }) } },
    captureCandidates: { 'kernel.kernel': async () => ({ resources: [] }) },
    verifiers: { 'kernel.kernel': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: D.checks
    }) },
    clock: T1
  };
}

async function start(root, storyId, compiled) {
  await publishSgosProgramAuthority(root, compiled);
  return startSgosProcess(root, {
    program: compiled,
    taskContractSha256: D.contract,
    subject: {
      kind: 'story', id: storyId, branch: 'main', baselineRevision: git(root, ['rev-parse', 'HEAD'])
    },
    clock: T0
  });
}

async function complete(root, processId) {
  for (let index = 0; index < 4; index += 1) {
    await runNextSgosTask(root, processId, { clock: T1 });
  }
  return readSgosProcess(root, processId);
}

async function boundaryLineage(root, process) {
  const current = (await readSgosCheckpoint(
    root, process.processId, process.currentCheckpointSha256
  )).record;
  return {
    boundary: current.checkpointSha256,
    genesis: current.priorCheckpointSha256
  };
}

test('pure suffix replay preserves prior attempts and receipts while reopening only checkpoint descendants', async (t) => {
  const storyId = 'SGOS-LINEAGE-REPLAY';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const completed = await complete(root, started.process.processId);
  assert.equal(completed.status, 'succeeded');
  const { boundary } = await boundaryLineage(root, completed);
  const before = Object.fromEntries(Object.values(completed.taskInstances)
    .map((entry) => [entry.taskTemplateId, structuredClone(entry)]));
  const plan = await planSgosProcessReplay(root, completed.processId, {
    fromCheckpointSha256: boundary, createdAt: T1
  });
  assert.equal(Object.isFrozen(plan.priorTasks), true);
  assert.deepEqual(plan.priorTasks.map((entry) => entry.taskTemplateId),
    ['10-boundary', '20-work', '90-end']);
  const replayed = await replaySgosProcess(root, completed.processId, {
    confirmationSha256: plan.replayPlanSha256, clock: T2
  });
  assert.equal(replayed.process.status, 'running');
  assert.equal((await fsckSgosProcess(root, completed.processId)).status, 'ok');
  assert.equal(replayed.process.taskInstances[before['00-start'].taskInstanceId].state, 'succeeded');
  for (const templateId of ['10-boundary', '20-work', '90-end']) {
    const task = replayed.process.taskInstances[before[templateId].taskInstanceId];
    assert.deepEqual(task.attemptIds, before[templateId].attemptIds);
    assert.equal(task.receiptSha256, null);
    assert.deepEqual(task.outputRefs, []);
    assert.equal(task.invalidatedBy, plan.replayPlanSha256);
  }
  assert.deepEqual(plan.priorTasks.map((entry) => entry.receiptSha256),
    ['10-boundary', '20-work', '90-end'].map((id) => before[id].receiptSha256));
  const recovered = await replaySgosProcess(root, completed.processId, {
    confirmationSha256: plan.replayPlanSha256, clock: T2
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.process.processSha256, replayed.process.processSha256);
  for (let index = 0; index < 3; index += 1) {
    await runNextSgosTask(root, completed.processId, { clock: T2 });
  }
  const rerun = await readSgosProcess(root, completed.processId);
  assert.equal((await fsckSgosProcess(root, completed.processId)).status, 'ok');
  assert.equal(rerun.status, 'succeeded');
  for (const templateId of ['10-boundary', '20-work', '90-end']) {
    const task = rerun.taskInstances[before[templateId].taskInstanceId];
    assert.equal(task.attemptIds.length, before[templateId].attemptIds.length + 1);
    assert.notEqual(task.receiptSha256, before[templateId].receiptSha256);
    assert.equal(task.invalidatedBy, plan.replayPlanSha256);
  }
});

test('replay refuses a completed suffix with writes, Devices, or external effects', async (t) => {
  const storyId = 'SGOS-LINEAGE-EFFECT';
  const root = await repository(t, storyId);
  const compiled = program({ reads: [], writes: ['src'], devices: [], externalEffects: [] });
  const started = await start(root, storyId, compiled);
  const completed = await complete(root, started.process.processId);
  const { boundary } = await boundaryLineage(root, completed);
  await assert.rejects(
    planSgosProcessReplay(root, completed.processId, { fromCheckpointSha256: boundary }),
    (error) => error.code === 'SGOS_REPLAY_EFFECT_UNSAFE'
  );
});

test('generic Process CAS cannot invent replay invalidation authority', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORGED-REPLAY';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const completed = await complete(root, started.process.processId);
  const taskId = Object.values(completed.taskInstances)
    .find((taskInstance) => taskInstance.taskTemplateId === '90-end').taskInstanceId;
  await assert.rejects(
    mutateSgosProcess(root, completed.processId, (draft) => {
      draft.status = 'running';
      draft.taskInstances[taskId].state = 'ready';
      draft.taskInstances[taskId].invalidatedBy = `sha256:${'f'.repeat(64)}`;
      draft.taskInstances[taskId].revision += 1;
    }, {
      expectedRevision: completed.processRevision,
      expectedProcessSha256: completed.processSha256,
      updatedAt: T2
    }),
    (error) => error.code === 'SGOS_TASK_BINDING_CHANGED'
  );
});

test('replay retry completes one exact pending suffix transition without applying it twice', async (t) => {
  const storyId = 'SGOS-LINEAGE-REPLAY-CRASH';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const completed = await complete(root, started.process.processId);
  const { boundary } = await boundaryLineage(root, completed);
  const plan = await planSgosProcessReplay(root, completed.processId, {
    fromCheckpointSha256: boundary, createdAt: T1
  });
  setSgosStoreFaultBoundaryForTests('state', { code: 'EIO' });
  try {
    await assert.rejects(
      replaySgosProcess(root, completed.processId, {
        confirmationSha256: plan.replayPlanSha256, clock: T2
      }),
      (error) => error.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED'
        && error.details?.causeCode === 'EIO'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  const recovered = await replaySgosProcess(root, completed.processId, {
    confirmationSha256: plan.replayPlanSha256, clock: T2
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.process.processRevision, completed.processRevision + 1);
  assert.equal((await fsckSgosProcess(root, completed.processId)).status, 'ok');
});

test('genesis fork creates an independent Process and refuses unsupported prefix import', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const completed = await complete(root, started.process.processId);
  const { boundary, genesis } = await boundaryLineage(root, completed);
  await assert.rejects(
    planSgosProcessFork(root, completed.processId, {
      fromCheckpointSha256: boundary, label: 'unsupported-prefix'
    }),
    (error) => error.code === 'SGOS_FORK_CHECKPOINT_UNSUPPORTED'
  );
  const plan = await planSgosProcessFork(root, completed.processId, {
    fromCheckpointSha256: genesis, label: 'independent-study', createdAt: T1
  });
  const forked = await forkSgosProcess(root, completed.processId, {
    confirmationSha256: plan.forkPlanSha256, clock: T2
  });
  assert.notEqual(forked.child.processId, completed.processId);
  assert.equal(forked.child.programSha256, completed.programSha256);
  assert.equal(forked.child.status, 'running');
  assert.equal(Object.values(forked.child.taskInstances).every((entry) => entry.attemptIds.length === 0), true);
  assert.equal((await readSgosProcess(root, completed.processId)).processSha256, completed.processSha256);
  await runNextSgosTask(root, forked.child.processId, { clock: T2 });
  const repeated = await forkSgosProcess(root, completed.processId, {
    confirmationSha256: plan.forkPlanSha256, clock: '2026-08-30T11:00:00.000Z'
  });
  assert.equal(repeated.created, false);
  assert.equal(repeated.recovered, true);
  assert.equal(repeated.receipt.forkReceiptSha256, forked.receipt.forkReceiptSha256);
  const receiptDirectory = path.join(root, '.git', 'singularity-flow', 'sgos', 'lineage',
    completed.processId, 'fork-receipts');
  assert.equal((await readdir(receiptDirectory)).length, 1);
  const fsck = await fsckSgosProcess(root, completed.processId);
  assert.equal(fsck.status, 'ok');
  assert.equal(fsck.lineage.incompleteForkPlans.length, 0);
});

test('fork confirmation cannot be reused after the repository baseline changes', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-STALE';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const completed = await complete(root, started.process.processId);
  const { genesis } = await boundaryLineage(root, completed);
  const plan = await planSgosProcessFork(root, completed.processId, {
    fromCheckpointSha256: genesis, label: 'stale-baseline', createdAt: T1
  });
  await writeFile(path.join(root, 'after-plan.txt'), 'repository moved\n');
  git(root, ['add', 'after-plan.txt']);
  git(root, ['commit', '-m', 'Move repository after fork preview']);
  await assert.rejects(
    forkSgosProcess(root, completed.processId, {
      confirmationSha256: plan.forkPlanSha256, clock: T2
    }),
    (error) => error.code === 'SGOS_FORK_PLAN_STALE'
  );
});

test('replayed failure cannot leak its historical successful outputs into an all-terminal join', async (t) => {
  const storyId = 'SGOS-LINEAGE-REPLAY-JOIN';
  const root = await repository(t, storyId);
  const compiled = replayJoinProgram();
  const started = await start(root, storyId, compiled);
  await runNextSgosTask(root, started.process.processId, { clock: T1 });
  await runNextSgosTask(root, started.process.processId, { clock: T1 });
  const firstWork = await runNextSgosTask(root, started.process.processId, successfulKernel());
  assert.deepEqual(firstWork.process.taskInstances[firstWork.taskInstanceId].outputRefs,
    ['sfref:historical-output']);
  await runNextSgosTask(root, started.process.processId, { clock: T1 });
  await runNextSgosTask(root, started.process.processId, { clock: T1 });
  const completed = await readSgosProcess(root, started.process.processId);
  const { boundary } = await boundaryLineage(root, completed);
  const plan = await planSgosProcessReplay(root, completed.processId, {
    fromCheckpointSha256: boundary, createdAt: T1
  });
  await replaySgosProcess(root, completed.processId, {
    confirmationSha256: plan.replayPlanSha256, clock: T2
  });
  await runNextSgosTask(root, completed.processId, { clock: T2 });
  const failed = await runNextSgosTask(root, completed.processId, {
    handlers: { kernel: { 'kernel.kernel': async () => {
      throw new Error('expected replay failure');
    } } },
    clock: T2
  });
  assert.equal(failed.status, 'failed');
  const failedTask = failed.process.taskInstances[failed.taskInstanceId];
  assert.equal(failedTask.receiptSha256, null);
  assert.deepEqual(failedTask.outputRefs, []);
  const joined = await runNextSgosTask(root, completed.processId, { clock: T2 });
  assert.equal(joined.joinReceipt.predecessors[0].state, 'failed');
  assert.equal(joined.joinReceipt.predecessors[0].receiptSha256, null);
  assert.deepEqual(joined.joinReceipt.outputRefs, []);
  assert.equal((await fsckSgosProcess(root, completed.processId)).status, 'ok');
});

test('fork apply settles a pending parent transition and refuses the now-stale plan', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-PENDING';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const plan = await planSgosProcessFork(root, started.process.processId, {
    fromCheckpointSha256: started.checkpoint.checkpointSha256,
    label: 'pending-parent', createdAt: T1
  });
  setSgosStoreFaultBoundaryForTests('state', { code: 'EIO' });
  try {
    await assert.rejects(
      pauseSgosProcess(root, started.process.processId, {
        expectedRevision: started.process.processRevision, clock: T2
      }),
      (error) => error.code === 'SGOS_TRANSITION_RECOVERY_REQUIRED'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  await assert.rejects(
    forkSgosProcess(root, started.process.processId, {
      confirmationSha256: plan.forkPlanSha256, clock: T2
    }),
    (error) => error.code === 'SGOS_FORK_PLAN_STALE'
  );
  assert.equal((await readSgosProcess(root, started.process.processId)).status, 'paused');
  assert.equal(await readProcessIfMissingForTest(root, plan.childProcessId), null);
});

async function readProcessIfMissingForTest(root, processId) {
  try { return await readSgosProcess(root, processId); }
  catch (error) {
    if (['ENOENT', 'SGOS_PROCESS_NOT_FOUND'].includes(error?.code)) return null;
    throw error;
  }
}

test('fork cannot retroactively claim a deterministic child created before its intent', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-PREEXISTING';
  const root = await repository(t, storyId);
  const compiled = program();
  const started = await start(root, storyId, compiled);
  const plan = await planSgosProcessFork(root, started.process.processId, {
    fromCheckpointSha256: started.checkpoint.checkpointSha256,
    label: 'preexisting-child', createdAt: T1
  });
  await startSgosProcess(root, {
    program: compiled,
    taskContractSha256: started.process.taskContractSha256,
    processId: plan.childProcessId,
    subject: plan.subject,
    clock: plan.createdAt
  });
  await assert.rejects(
    forkSgosProcess(root, started.process.processId, {
      confirmationSha256: plan.forkPlanSha256, clock: T2
    }),
    (error) => error.code === 'SGOS_FORK_CHILD_PREEXISTING'
  );
});

test('fork retry completes the exact child genesis after a crash following predecessor intent', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-CRASH';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const plan = await planSgosProcessFork(root, started.process.processId, {
    fromCheckpointSha256: started.checkpoint.checkpointSha256,
    label: 'crash-retry', createdAt: T1
  });
  setSgosStoreFaultBoundaryForTests('genesis-state', { code: 'EIO' });
  try {
    await assert.rejects(
      forkSgosProcess(root, started.process.processId, {
        confirmationSha256: plan.forkPlanSha256, clock: T2
      }),
      (error) => error.code === 'EIO'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  const recovered = await forkSgosProcess(root, started.process.processId, {
    confirmationSha256: plan.forkPlanSha256, clock: T2
  });
  assert.equal(recovered.child.processRevision, 3);
  assert.equal(recovered.child.createdAt, plan.createdAt);
  assert.equal(Object.values(recovered.child.taskInstances)
    .every((taskInstance) => taskInstance.attemptIds.length === 0), true);
  const repeated = await forkSgosProcess(root, started.process.processId, {
    confirmationSha256: plan.forkPlanSha256, clock: '2026-08-30T12:00:00.000Z'
  });
  assert.equal(repeated.receipt.forkReceiptSha256, recovered.receipt.forkReceiptSha256);
});

test('fork preview uses the immutable parent baseline and refuses a moved repository', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-MOVED-BEFORE-PREVIEW';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  await writeFile(path.join(root, 'moved-before-preview.txt'), 'moved\n');
  git(root, ['add', 'moved-before-preview.txt']);
  git(root, ['commit', '-m', 'Move before fork preview']);
  await assert.rejects(
    planSgosProcessFork(root, started.process.processId, {
      fromCheckpointSha256: started.checkpoint.checkpointSha256,
      label: 'wrong-moving-head', createdAt: T1
    }),
    (error) => error.code === 'SGOS_PROCESS_BINDING_STALE'
  );
});

test('fork lineage refuses symlink redirection and fsck reports an interrupted canonical intent', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-SIDECAR';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const lineage = path.join(common, 'singularity-flow', 'sgos', 'lineage', started.process.processId);
  const escaped = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-lineage-escaped-'));
  t.after(() => rm(escaped, { recursive: true, force: true }));
  await mkdir(lineage, { recursive: true });
  await symlink(escaped, path.join(lineage, 'fork-plans'));
  await assert.rejects(
    planSgosProcessFork(root, started.process.processId, {
      fromCheckpointSha256: started.checkpoint.checkpointSha256,
      label: 'unsafe-sidecar', createdAt: T1
    }),
    (error) => error.code === 'SGOS_SIDECAR_PATH_UNSAFE'
  );
  assert.deepEqual(await readdir(escaped), []);
});

test('fsck includes canonical fork lineage and exposes a missing receipt as recoverable attention', async (t) => {
  const storyId = 'SGOS-LINEAGE-FORK-FSCK';
  const root = await repository(t, storyId);
  const started = await start(root, storyId, program());
  const plan = await planSgosProcessFork(root, started.process.processId, {
    fromCheckpointSha256: started.checkpoint.checkpointSha256,
    label: 'fsck-lineage', createdAt: T1
  });
  await forkSgosProcess(root, started.process.processId, {
    confirmationSha256: plan.forkPlanSha256, clock: T2
  });
  const common = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  const receipt = path.join(common, 'singularity-flow', 'sgos', 'lineage',
    started.process.processId, 'fork-receipts', `${plan.forkPlanSha256.slice(7)}.json`);
  await unlink(receipt);
  const report = await fsckSgosProcess(root, started.process.processId);
  assert.equal(report.status, 'attention');
  assert.deepEqual(report.lineage.incompleteForkPlans, [plan.forkPlanSha256]);
});
