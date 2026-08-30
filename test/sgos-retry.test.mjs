import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition } from '../src/config.mjs';
import { createGvmProgram } from '../src/sgos/contracts.mjs';
import { SGOS_COMPILER_ID } from '../src/sgos/compiler.mjs';
import {
  planSgosTaskRetry, retrySgosTask, retrySgosTaskWithInstalledAdapters
} from '../src/sgos/retry.mjs';
import { compileSgosProcessEvidence } from '../src/sgos/process-evidence.mjs';
import {
  pauseSgosProcess, runNextSgosTask, startSgosProcess
} from '../src/sgos/runtime.mjs';
import {
  fsckSgosProcess, listSgosImmutableRecordsByField, readSgosProcess
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
const T0 = '2026-08-30T12:00:00.000Z';
const T1 = '2026-08-30T12:01:00.000Z';
const T2 = '2026-08-30T12:02:00.000Z';

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function repository(t, storyId) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Retry Tester']);
  git(root, ['config', 'user.email', 'retry@example.test']);
  await initializeDefinition(root);
  const storyDirectory = path.join(root, 'singularity', 'work-items', storyId);
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: storyId, title: 'Retry fixture' },
    currentPhase: 'implementation'
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Retry fixture']);
  return root;
}

function template({ maximumAttempts = 2, resources = null } = {}) {
  return {
    taskTemplateId: '10-work', opcode: 'KERNEL', operation: 'kernel.retry', dependsOn: [],
    resources: resources ?? { reads: ['app.mjs'], writes: [], devices: [], externalEffects: [] },
    evidence: { required: ['candidate', 'verification-result'] }, authority: {},
    recovery: { interruptedExecution: 'retry-safe' }, intentClauseIds: [], inputs: [], outputs: [],
    retry: { maximumAttempts }, policySnapshotSha256: D.policy, material: true,
    metadata: {
      sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: D.manifest
    }
  };
}

function program(options = {}) {
  const work = template(options);
  const end = {
    taskTemplateId: '90-end', opcode: 'END', operation: 'kernel.end', dependsOn: ['10-work'],
    resources: { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: {}, authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
    retry: { maximumAttempts: 1 }, policySnapshotSha256: D.policy, material: false,
    metadata: {
      sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: D.manifest
    }
  };
  return createGvmProgram({
    intentIrSha256: D.intent, workflowSha256: D.workflow,
    ratificationSha256: D.ratification, policySnapshotSha256: D.policy,
    registrySnapshotSha256: D.registry, storageProfileSha256: D.storage,
    taskTemplates: [work, end],
    edges: [{ from: '10-work', to: '90-end' }], joins: [],
    budgets: { maximumTasks: 2, maximumAttempts: Math.max(1, options.maximumAttempts ?? 2) },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: '90-end', state: 'succeeded' }],
    // Retry is orthogonal to Capability Pack selection; use the explicitly supported legacy-core
    // compiler authority so this fixture does not manufacture a signed-pack compilation result.
    compiler: { id: SGOS_COMPILER_ID, version: '2' }
  });
}

async function started(t, storyId, options = {}) {
  const root = await repository(t, storyId);
  const compiled = program(options);
  await publishSgosProgramAuthority(root, compiled);
  const result = await startSgosProcess(root, {
    program: compiled,
    taskContractSha256: D.contract,
    subject: {
      kind: 'story', id: storyId, branch: 'main',
      baselineRevision: git(root, ['rev-parse', 'HEAD'])
    },
    clock: T0
  });
  return { root, compiled, ...result };
}

function governed(handler) {
  return {
    handlers: { kernel: { 'kernel.retry': handler } },
    captureCandidates: { 'kernel.retry': async () => ({ resources: [] }) },
    verifiers: { 'kernel.retry': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: D.checks
    }) }
  };
}

async function failedOnce(fixture) {
  const result = await runNextSgosTask(
    fixture.root, fixture.process.processId,
    { ...governed(async () => { throw new Error('first attempt failed'); }), clock: T1 }
  );
  assert.equal(result.status, 'retry-ready');
  return result;
}

async function lineageBytes(root, processId) {
  const directory = path.join(root, '.git', 'singularity-flow', 'sgos', 'lineage', processId);
  async function walk(current, prefix = '') {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const output = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) output.push(...await walk(path.join(current, entry.name), relative));
      else output.push([relative, await readFile(path.join(current, entry.name), 'utf8')]);
    }
    return output;
  }
  return walk(directory);
}

test('ordinary retry uses an exact plan and creates immutable parent-attempt lineage', async (t) => {
  const fixture = await started(t, 'SGOS-RETRY-LINEAGE');
  const failed = await failedOnce(fixture);
  const task = Object.values(failed.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const plan = await planSgosTaskRetry(
    fixture.root, failed.process.processId, task.taskInstanceId, { createdAt: T1 }
  );
  assert.equal(plan.parentAttemptId, task.attemptIds[0]);
  assert.equal(plan.attemptNumber, 2);
  const result = await retrySgosTask(
    fixture.root, failed.process.processId, task.taskInstanceId,
    {
      confirmationSha256: plan.retryPlanSha256,
      ...governed(async () => ({
        outputRefs: ['sfref:retry-output'], rawResult: { status: 'completed' }
      })),
      clock: T2
    }
  );
  assert.equal(result.status, 'succeeded');
  const retried = result.process.taskInstances[task.taskInstanceId];
  assert.deepEqual(retried.attemptIds, [plan.parentAttemptId, plan.expectedAttemptId]);
  const attempts = await listSgosImmutableRecordsByField(
    fixture.root, result.process.processId, 'gvm-task-attempt',
    'attemptId', plan.expectedAttemptId
  );
  assert.equal(attempts.find((entry) => entry.status === 'succeeded')?.parentAttemptId,
    plan.parentAttemptId);
  const prior = await listSgosImmutableRecordsByField(
    fixture.root, result.process.processId, 'gvm-task-attempt',
    'attemptId', plan.parentAttemptId
  );
  assert.deepEqual(prior.map((entry) => entry.status).sort(), ['failed', 'running']);
  assert.equal((await fsckSgosProcess(fixture.root, result.process.processId)).status, 'ok');
  const portable = await compileSgosProcessEvidence(fixture.root, result.process.processId);
  assert.equal(portable.sourceIntegrity.lineageRecordCount, 2);
  assert.equal(portable.gaps.some((entry) =>
    entry.code === 'private-lineage-records-not-exported'
      && entry.reference === '2'), true);

  const repeated = await retrySgosTask(
    fixture.root, result.process.processId, task.taskInstanceId,
    { confirmationSha256: plan.retryPlanSha256, clock: '2026-08-30T13:00:00.000Z' }
  );
  assert.equal(repeated.recovered, true);
  assert.equal(repeated.receipt.retryReceiptSha256, result.receipt.retryReceiptSha256);
  assert.deepEqual(repeated.process.taskInstances[task.taskInstanceId].attemptIds,
    retried.attemptIds);
});

test('task retry refuses exhausted and effect-unsafe failures without changing bytes', async (t) => {
  const exhausted = await started(t, 'SGOS-RETRY-EXHAUSTED', { maximumAttempts: 1 });
  const failed = await runNextSgosTask(exhausted.root, exhausted.process.processId, {
    ...governed(async () => { throw new Error('only attempt failed'); }), clock: T1
  });
  const exhaustedTask = Object.values(failed.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const beforeExhausted = await lineageBytes(exhausted.root, failed.process.processId);
  await assert.rejects(
    planSgosTaskRetry(exhausted.root, failed.process.processId, exhaustedTask.taskInstanceId),
    (error) => error.code === 'SGOS_TASK_RETRY_ATTEMPTS_EXHAUSTED'
  );
  assert.deepEqual(await lineageBytes(exhausted.root, failed.process.processId), beforeExhausted);
  assert.equal((await readSgosProcess(exhausted.root, failed.process.processId)).processSha256,
    failed.process.processSha256);

  const effectful = await started(t, 'SGOS-RETRY-EFFECT', {
    maximumAttempts: 2,
    resources: { reads: [], writes: ['app.mjs'], devices: [], externalEffects: [] }
  });
  const uncertain = await runNextSgosTask(effectful.root, effectful.process.processId, {
    ...governed(async () => { throw new Error('write outcome uncertain'); }), clock: T1
  });
  const effectTask = Object.values(uncertain.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const beforeEffect = await lineageBytes(effectful.root, uncertain.process.processId);
  await assert.rejects(
    planSgosTaskRetry(effectful.root, uncertain.process.processId, effectTask.taskInstanceId),
    (error) => error.code === 'SGOS_TASK_RETRY_EFFECT_UNSAFE'
      && error.details?.classification === 'writable-or-external-effect'
  );
  assert.deepEqual(await lineageBytes(effectful.root, uncertain.process.processId), beforeEffect);
});

test('retry confirmation is stale after Process or repository authority moves', async (t) => {
  const moved = await started(t, 'SGOS-RETRY-STALE-PROCESS');
  const failed = await failedOnce(moved);
  const task = Object.values(failed.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const plan = await planSgosTaskRetry(moved.root, failed.process.processId, task.taskInstanceId, {
    createdAt: T1
  });
  const paused = await pauseSgosProcess(moved.root, failed.process.processId, {
    expectedRevision: failed.process.processRevision, clock: T2
  });
  await assert.rejects(
    retrySgosTask(moved.root, failed.process.processId, task.taskInstanceId, {
      confirmationSha256: plan.retryPlanSha256,
      ...governed(async () => ({ rawResult: { status: 'completed' } })),
      clock: T2
    }),
    (error) => error.code === 'SGOS_TASK_RETRY_PLAN_STALE'
  );
  assert.equal((await readSgosProcess(moved.root, failed.process.processId)).processSha256,
    paused.processSha256);

  const binding = await started(t, 'SGOS-RETRY-STALE-BINDING');
  const bindingFailed = await failedOnce(binding);
  const bindingTask = Object.values(bindingFailed.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const bindingPlan = await planSgosTaskRetry(
    binding.root, bindingFailed.process.processId, bindingTask.taskInstanceId, { createdAt: T1 }
  );
  await writeFile(path.join(binding.root, 'head-moved.txt'), 'moved\n');
  git(binding.root, ['add', 'head-moved.txt']);
  git(binding.root, ['commit', '-m', 'Move binding after retry preview']);
  await assert.rejects(
    retrySgosTask(binding.root, bindingFailed.process.processId, bindingTask.taskInstanceId, {
      confirmationSha256: bindingPlan.retryPlanSha256,
      ...governed(async () => ({ rawResult: { status: 'completed' } })),
      clock: T2
    }),
    (error) => error.code === 'SGOS_PROCESS_BINDING_STALE'
  );
  assert.equal((await readSgosProcess(binding.root, bindingFailed.process.processId)).processSha256,
    bindingFailed.process.processSha256);
});

test('concurrent retry confirmation dispatches one child attempt and one handler', async (t) => {
  const fixture = await started(t, 'SGOS-RETRY-CONCURRENT');
  const failed = await failedOnce(fixture);
  const task = Object.values(failed.process.taskInstances)
    .find((entry) => entry.taskTemplateId === '10-work');
  const plan = await planSgosTaskRetry(
    fixture.root, failed.process.processId, task.taskInstanceId, { createdAt: T1 }
  );
  let entered;
  let release;
  let calls = 0;
  const startedHandler = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const execute = () => retrySgosTask(
    fixture.root, failed.process.processId, task.taskInstanceId,
    {
      confirmationSha256: plan.retryPlanSha256,
      ...governed(async () => {
        calls += 1;
        entered();
        await held;
        return { rawResult: { status: 'completed' } };
      }),
      clock: T2
    }
  );
  const first = execute();
  await startedHandler;
  await assert.rejects(execute(), (error) =>
    ['SGOS_TASK_RETRY_IN_PROGRESS', 'SGOS_PROCESS_REVISION_STALE']
      .includes(error.code));
  release();
  const winner = await first;
  assert.equal(winner.status, 'succeeded');
  assert.equal(calls, 1);
  assert.deepEqual(winner.process.taskInstances[task.taskInstanceId].attemptIds,
    [plan.parentAttemptId, plan.expectedAttemptId]);
});

test('public retry wrapper refuses accessor, symbol, and Proxy option tricks before repository access', async () => {
  const values = [
    Object.defineProperty({}, 'confirmationSha256', { get() { throw new Error('getter ran'); } }),
    { confirmationSha256: D.intent, [Symbol('hidden')]: true },
    new Proxy({ confirmationSha256: D.intent }, {})
  ];
  for (const options of values) {
    await assert.rejects(
      retrySgosTaskWithInstalledAdapters(
        '/definitely/not/a/repository', 'PROC-RETRY-PUBLIC', 'TASK-1', options
      ),
      (error) => error.code === 'SGOS_PUBLIC_OPTIONS_INVALID'
    );
  }
});
