/**
 * Exact SGOS replay and fork lineage for the installed local profile.
 *
 * Replay never erases attempts, receipts, or evidence. It records the exact pre-replay task
 * projection first, then performs one Process CAS that makes a pure suffix runnable again. Tasks
 * that wrote resources, called Devices, or declared external effects are refused: the installed
 * profile has no general idempotency proof for repeating those effects.
 *
 * Forking is initially supported from a genesis checkpoint. That creates an independent Process
 * with the same immutable Program/subject inputs and fresh budgets. A non-genesis checkpoint is
 * refused rather than pretending that parent receipts can be re-authored for the child Process.
 */
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { createSgosReplayPlan, deterministicSgosId, sha256 } from './contracts.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  assertCurrentStoredProcessBinding, startSgosProcess
} from './runtime.mjs';
import {
  listPrivateSidecar, readPrivateSidecar, writeImmutablePrivateSidecar
} from './private-sidecar.mjs';
import {
  mutateSgosProcess, putSgosImmutableRecord, readSgosCheckpoint,
  readSgosImmutableRecord, readSgosProcess, readSgosProgram,
  listSgosImmutableRecordsByField,
  recoverPendingSgosTransition
} from './store.mjs';
import { taskInstancesForSgosProgram } from './materialization.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const PROCESS_ID = /^PROC-[A-Za-z0-9._:-]{6,127}$/;
const MAX_CHECKPOINT_DEPTH = 10_000;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function lineageRoot(root, processId) {
  if (!PROCESS_ID.test(String(processId ?? ''))) {
    fail('Process ID is invalid.', 'SGOS_PROCESS_ID_INVALID', { processId });
  }
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'lineage', processId);
}

function sealLineage(kind, hashField, value) {
  // This is a private SGOS lineage envelope rather than a migration-registry record. Its format
  // version is intentionally not named schemaVersion, and readers accept exactly this version.
  const core = { lineageFormat: 'sflow.sgos.lineage', lineageVersion: 1, kind, ...structuredClone(value) };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

async function writeImmutable(root, target, record, hashField) {
  try {
    await writeImmutablePrivateSidecar(root, target,
      canonicalJson(record), { maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes });
  } catch (error) {
    if (error?.code !== 'SGOS_SIDECAR_RECORD_CONFLICT') throw error;
    fail('Immutable SGOS lineage record conflicts with existing bytes.',
      'SGOS_LINEAGE_RECORD_CONFLICT', { hash: record[hashField] });
  }
  return record;
}

function lineagePath(root, processId, category, digest) {
  if (!HASH.test(String(digest ?? ''))) fail('Lineage digest is invalid.', 'SGOS_LINEAGE_INVALID');
  return path.join(lineageRoot(root, processId), category, `${digest.slice('sha256:'.length)}.json`);
}

async function readLineage(root, processId, category, digest, kind, hashField) {
  return readLineageTarget(root, lineagePath(root, processId, category, digest), {
    digest, kind, hashField
  });
}

async function readLineageTarget(root, target, {
  digest = null, kind, hashField, optional = false
}) {
  let record;
  let raw;
  try {
    const bytes = await readPrivateSidecar(
      root, target,
      { maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes, optional }
    );
    if (bytes === null && optional) return null;
    raw = bytes.toString('utf8');
    record = JSON.parse(raw);
  }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    if (error?.code === 'ENOENT') fail(`SGOS ${kind} was not found.`, 'SGOS_LINEAGE_NOT_FOUND', { digest });
    if (error instanceof SyntaxError || error instanceof TypeError) {
      fail(`SGOS ${kind} is not canonical valid JSON.`, 'SGOS_LINEAGE_CORRUPT', { digest });
    }
    throw error;
  }
  if (record === null && optional) return null;
  const core = structuredClone(record);
  delete core[hashField];
  if (record.lineageFormat !== 'sflow.sgos.lineage' || record.lineageVersion !== 1
      || record.kind !== kind || !HASH.test(String(record[hashField] ?? ''))
      || (digest !== null && record[hashField] !== digest)
      || sha256(core) !== record[hashField]
      || canonicalJson(record) !== raw) {
    fail(`SGOS ${kind} failed its exact content hash.`, 'SGOS_LINEAGE_CORRUPT', { digest });
  }
  return freezeDeep(record);
}

function canonicalLineagePath(root, processId, category, forkPlanSha256) {
  return lineagePath(root, processId, category, forkPlanSha256);
}

async function readCanonicalForkRecord(root, processId, category, forkPlanSha256, kind, hashField, {
  optional = false
} = {}) {
  const record = await readLineageTarget(
    root, canonicalLineagePath(root, processId, category, forkPlanSha256),
    { kind, hashField, optional }
  );
  if (record !== null && record.forkPlanSha256 !== forkPlanSha256) {
    fail(`SGOS ${kind} is stored under a different fork plan.`, 'SGOS_LINEAGE_CORRUPT', {
      forkPlanSha256
    });
  }
  return record;
}

function templatesById(program) {
  return new Map(program.taskTemplates.map((entry) => [entry.taskTemplateId, entry]));
}

function assertQuiescent(process) {
  const active = {
    executions: process.activeExecutions ?? [],
    leases: process.activeLeases ?? [],
    humanRequests: process.openHumanRequests ?? []
  };
  if (active.executions.length || active.leases.length || active.humanRequests.length) {
    fail('Replay/fork requires a quiescent Process with no execution, lease, or Human Request.',
      'SGOS_LINEAGE_NOT_QUIESCENT', active);
  }
}

async function checkpointInLineage(root, process, requestedSha256) {
  if (!HASH.test(String(requestedSha256 ?? ''))) {
    fail('Replay/fork requires an exact checkpoint SHA-256.', 'SGOS_CHECKPOINT_INVALID');
  }
  let cursor = process.currentCheckpointSha256;
  let depth = 0;
  while (cursor != null && depth < MAX_CHECKPOINT_DEPTH) {
    const checkpoint = (await readSgosCheckpoint(root, process.processId, cursor)).record;
    if (checkpoint.processId !== process.processId || checkpoint.programSha256 !== process.programSha256
        || checkpoint.policySnapshotSha256 !== process.policySnapshotSha256
        || checkpoint.processBindingSha256 !== process.processBindingSha256) {
      fail('Checkpoint belongs to another immutable Process boundary.', 'SGOS_CHECKPOINT_INVALID');
    }
    if (cursor === requestedSha256) return checkpoint;
    cursor = checkpoint.priorCheckpointSha256;
    depth += 1;
  }
  if (depth >= MAX_CHECKPOINT_DEPTH) {
    fail('Checkpoint lineage exceeds the installed traversal ceiling.', 'SGOS_LINEAGE_LIMIT');
  }
  fail('Checkpoint is not an ancestor of the current Process boundary.',
    'SGOS_CHECKPOINT_NOT_ANCESTOR', { checkpointSha256: requestedSha256 });
}

function retryCeiling(template) {
  return template.retry?.maximumAttempts ?? template.retry?.maxAttempts ?? 1;
}

function replayTaskIds(process, checkpoint) {
  const ids = Object.keys(process.taskInstances ?? {}).filter((taskInstanceId) => {
    const checkpointState = checkpoint.taskStates?.[taskInstanceId];
    return !['succeeded', 'skipped'].includes(checkpointState);
  }).sort((left, right) =>
    compareSgosCodePoints(process.taskInstances[left].taskTemplateId,
      process.taskInstances[right].taskTemplateId)
      || compareSgosCodePoints(left, right));
  if (!ids.length) {
    fail('The selected checkpoint has no completed suffix to replay.', 'SGOS_REPLAY_SUFFIX_EMPTY');
  }
  return ids;
}

function assertReplayableSuffix(process, program, taskInstanceIds) {
  const templates = templatesById(program);
  for (const taskInstanceId of taskInstanceIds) {
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task?.taskTemplateId);
    if (!task || !template
        || !['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.state)
        || task.attemptIds.length === 0) {
      fail('Replay suffix does not contain only completed Program tasks.',
        'SGOS_REPLAY_PLAN_INVALID');
    }
    const resources = template.resources ?? {};
    const repeatedEffect = task.attemptIds.length > 0 && (
      (resources.writes?.length ?? 0) > 0
      || (resources.devices?.length ?? 0) > 0
      || (resources.externalEffects?.length ?? 0) > 0
    );
    if (repeatedEffect) {
      fail(`Task '${template.taskTemplateId}' cannot be replayed by the installed pure-suffix profile.`,
        'SGOS_REPLAY_EFFECT_UNSAFE', {
          taskInstanceId,
          writes: resources.writes ?? [],
          devices: resources.devices ?? [],
          externalEffects: resources.externalEffects ?? []
        });
    }
    if (task.attemptIds.length >= retryCeiling(template)) {
      fail(`Task '${template.taskTemplateId}' has no remaining governed attempt.`,
        'SGOS_REPLAY_ATTEMPT_CEILING', {
          taskInstanceId, attempts: task.attemptIds.length, maximumAttempts: retryCeiling(template)
        });
    }
  }
}

function taskLineageProjection(process, taskInstanceIds) {
  return taskInstanceIds.map((taskInstanceId) => {
    const task = process.taskInstances[taskInstanceId];
    return {
      taskInstanceId,
      taskTemplateId: task.taskTemplateId,
      state: task.state,
      revision: task.revision,
      inputRefs: [...task.inputRefs],
      attemptIds: [...task.attemptIds],
      receiptSha256: task.receiptSha256,
      outputRefs: [...task.outputRefs],
      invalidatedBy: task.invalidatedBy
    };
  });
}

export async function planSgosProcessReplay(root, processId, {
  fromCheckpointSha256,
  createdAt = nowIso()
} = {}) {
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  assertQuiescent(process);
  const checkpoint = await checkpointInLineage(root, process, fromCheckpointSha256);
  const program = (await readSgosProgram(root, processId, process.programSha256)).record;
  const taskInstanceIds = replayTaskIds(process, checkpoint);
  assertReplayableSuffix(process, program, taskInstanceIds);
  const plan = createSgosReplayPlan({
    processId,
    expectedProcessRevision: process.processRevision,
    expectedProcessSha256: process.processSha256,
    programSha256: process.programSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    processBindingSha256: process.processBindingSha256,
    fromCheckpointSha256,
    taskInstanceIds,
    priorTasks: taskLineageProjection(process, taskInstanceIds),
    createdAt
  });
  await putSgosImmutableRecord(root, processId, 'sgos-replay-plan', plan);
  return plan;
}

function resetSuffix(draft, plan) {
  const replaySet = new Set(plan.taskInstanceIds);
  for (const taskInstanceId of plan.taskInstanceIds) {
    const task = draft.taskInstances[taskInstanceId];
    const outsideReady = task.predecessorTaskInstanceIds
      .filter((predecessor) => !replaySet.has(predecessor))
      .every((predecessor) => ['succeeded', 'skipped'].includes(draft.taskInstances[predecessor]?.state));
    const hasReplayPredecessor = task.predecessorTaskInstanceIds.some((predecessor) => replaySet.has(predecessor));
    task.state = outsideReady && !hasReplayPredecessor ? 'ready' : 'waiting';
    task.invalidatedBy = plan.replayPlanSha256;
    task.receiptSha256 = null;
    task.outputRefs = [];
    task.revision += 1;
  }
  draft.status = 'running';
  draft.currentCheckpointSha256 = plan.fromCheckpointSha256;
}

export async function replaySgosProcess(root, processId, {
  confirmationSha256,
  clock = null
} = {}) {
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Replay requires an exact replay-plan confirmation.', 'SGOS_REPLAY_CONFIRMATION_REQUIRED');
  }
  const plan = (await readSgosImmutableRecord(
    root, processId, 'sgos-replay-plan', confirmationSha256
  )).record;
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  const replaySet = new Set(plan.taskInstanceIds);
  const alreadyApplied = process.processRevision === plan.expectedProcessRevision + 1
    && process.status === 'running'
    && process.currentCheckpointSha256 === plan.fromCheckpointSha256
    && plan.priorTasks.every((prior) => {
      const task = process.taskInstances[prior.taskInstanceId];
      if (!task) return false;
      const hasReplayPredecessor = task.predecessorTaskInstanceIds.some((id) => replaySet.has(id));
      const outsideReady = task.predecessorTaskInstanceIds
        .filter((id) => !replaySet.has(id))
        .every((id) => ['succeeded', 'skipped'].includes(process.taskInstances[id]?.state));
      return task.state === (outsideReady && !hasReplayPredecessor ? 'ready' : 'waiting')
        && task.invalidatedBy === plan.replayPlanSha256
        && task.revision === prior.revision + 1
        && canonicalJson(task.inputRefs) === canonicalJson(prior.inputRefs)
        && canonicalJson(task.attemptIds) === canonicalJson(prior.attemptIds)
        && task.receiptSha256 === null
        && canonicalJson(task.outputRefs) === canonicalJson([]);
    });
  let next = process;
  if (!alreadyApplied) {
    if (process.processRevision !== plan.expectedProcessRevision
        || process.processSha256 !== plan.expectedProcessSha256) {
      fail('Process changed after replay preview; create a new exact plan.',
        'SGOS_REPLAY_PLAN_STALE', {
          expectedRevision: plan.expectedProcessRevision,
          actualRevision: process.processRevision
        });
    }
    assertQuiescent(process);
    const checkpoint = await checkpointInLineage(root, process, plan.fromCheckpointSha256);
    const program = (await readSgosProgram(root, processId, process.programSha256)).record;
    const ids = replayTaskIds(process, checkpoint);
    if (canonicalJson(ids) !== canonicalJson(plan.taskInstanceIds)
        || canonicalJson(taskLineageProjection(process, ids)) !== canonicalJson(plan.priorTasks)) {
      fail('Replay inputs no longer match the confirmed plan.', 'SGOS_REPLAY_PLAN_STALE');
    }
    assertReplayableSuffix(process, program, ids);
    const replayRecord = await putSgosImmutableRecord(
      root, processId, 'sgos-replay-plan', plan, { reserveExisting: true }
    );
    try {
      next = await mutateSgosProcess(root, processId, (draft) => resetSuffix(draft, plan), {
        expectedRevision: process.processRevision,
        expectedProcessSha256: process.processSha256,
        updatedAt: typeof clock === 'string' ? clock : nowIso(),
        recordReservations: [replayRecord.reservationToken],
        replayPlanSha256: plan.replayPlanSha256
      });
    } catch (error) {
      if (error?.code !== 'SGOS_TRANSITION_RECOVERED_RETRY') throw error;
      const recovered = await readSgosProcess(root, processId);
      if (recovered.processRevision !== plan.expectedProcessRevision + 1
          || !plan.taskInstanceIds.every((taskInstanceId) =>
            recovered.taskInstances[taskInstanceId]?.invalidatedBy === plan.replayPlanSha256)) {
        throw error;
      }
      next = recovered;
    }
  }
  const receipt = sealLineage('sgos-replay-receipt', 'replayReceiptSha256', {
    processId,
    replayPlanSha256: plan.replayPlanSha256,
    resultingProcessRevision: next.processRevision,
    resultingProcessSha256: next.processSha256,
    replayedAt: next.updatedAt
  });
  await writeImmutable(root, lineagePath(root, processId, 'replay-receipts', receipt.replayReceiptSha256),
    receipt, 'replayReceiptSha256');
  return Object.freeze({ process: next, plan, receipt, recovered: alreadyApplied });
}

export async function planSgosProcessFork(root, processId, {
  fromCheckpointSha256,
  label = 'fork',
  createdAt = nowIso()
} = {}) {
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  assertQuiescent(process);
  const binding = await assertCurrentStoredProcessBinding(root, process);
  const checkpoint = await checkpointInLineage(root, process, fromCheckpointSha256);
  if (checkpoint.priorCheckpointSha256 !== null) {
    fail('The installed fork profile supports only a genesis checkpoint; prefix receipt import is not installed.',
      'SGOS_FORK_CHECKPOINT_UNSUPPORTED', { fromCheckpointSha256 });
  }
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(label)) {
    fail('Fork label must use lower-case kebab case.', 'SGOS_FORK_LABEL_INVALID');
  }
  const childProcessId = deterministicSgosId('PROC', {
    parentProcessId: processId,
    parentProcessSha256: process.processSha256,
    fromCheckpointSha256,
    label
  });
  const plan = sealLineage('sgos-fork-plan', 'forkPlanSha256', {
    parentProcessId: processId,
    expectedParentProcessRevision: process.processRevision,
    expectedParentProcessSha256: process.processSha256,
    fromCheckpointSha256,
    childProcessId,
    programSha256: process.programSha256,
    parentProcessBindingSha256: process.processBindingSha256,
    taskContractSha256: process.taskContractSha256,
    subject: {
      kind: process.authorityBinding.kind,
      id: process.authorityBinding.subjectId,
      branch: binding.branch,
      baselineRevision: binding.baselineRevision
    },
    label,
    createdAt
  });
  await writeImmutable(root, lineagePath(root, processId, 'fork-plans', plan.forkPlanSha256),
    plan, 'forkPlanSha256');
  return plan;
}

function assertForkPlanShape(plan, processId) {
  if (plan.parentProcessId !== processId
      || !PROCESS_ID.test(String(plan.childProcessId ?? ''))
      || !HASH.test(String(plan.expectedParentProcessSha256 ?? ''))
      || !HASH.test(String(plan.fromCheckpointSha256 ?? ''))
      || !HASH.test(String(plan.programSha256 ?? ''))
      || !HASH.test(String(plan.parentProcessBindingSha256 ?? ''))
      || !HASH.test(String(plan.taskContractSha256 ?? ''))
      || !Number.isSafeInteger(plan.expectedParentProcessRevision)
      || plan.expectedParentProcessRevision < 1
      || !['story', 'repository'].includes(plan.subject?.kind)
      || typeof plan.subject?.id !== 'string'
      || typeof plan.subject?.branch !== 'string'
      || !/^[a-f0-9]{40,64}$/.test(String(plan.subject?.baselineRevision ?? ''))
      || typeof plan.createdAt !== 'string') {
    fail('SGOS fork plan failed its installed exact contract.', 'SGOS_LINEAGE_CORRUPT', {
      forkPlanSha256: plan.forkPlanSha256
    });
  }
}

function forkIntentFor(plan, parent) {
  return sealLineage('sgos-fork-intent', 'forkIntentSha256', {
    forkPlanSha256: plan.forkPlanSha256,
    parentProcessId: plan.parentProcessId,
    parentProcessSha256: plan.expectedParentProcessSha256,
    childProcessId: plan.childProcessId,
    programSha256: plan.programSha256,
    parentProcessBindingSha256: plan.parentProcessBindingSha256,
    taskContractSha256: parent.taskContractSha256,
    subject: plan.subject,
    createdAt: plan.createdAt
  });
}

async function readProcessIfPresent(root, processId) {
  try { return await readSgosProcess(root, processId); }
  catch (error) {
    if (['ENOENT', 'SGOS_PROCESS_NOT_FOUND'].includes(error?.code)) return null;
    throw error;
  }
}

function assertForkChildCore(plan, parent, child, binding) {
  if (child.processId !== plan.childProcessId
      || child.programSha256 !== plan.programSha256
      || child.policySnapshotSha256 !== parent.policySnapshotSha256
      || child.taskContractSha256 !== plan.taskContractSha256
      || child.createdAt !== plan.createdAt
      || binding.processId !== child.processId
      || binding.subjectId !== plan.subject.id
      || binding.branch !== plan.subject.branch
      || binding.baselineRevision !== plan.subject.baselineRevision
      || child.processBindingSha256 !== binding.bindingSha256
      || child.authorityBinding?.kind !== plan.subject.kind
      || child.authorityBinding?.subjectId !== plan.subject.id
      || child.authorityBinding?.branch !== plan.subject.branch
      || child.authorityBinding?.baselineRevision !== plan.subject.baselineRevision) {
    fail('Existing fork child does not match the exact confirmed genesis authority.',
      'SGOS_FORK_CHILD_CONFLICT', { childProcessId: plan.childProcessId });
  }
}

async function assertExactForkGenesis(root, plan, parent, started, program) {
  const child = started.process;
  const binding = (await readSgosImmutableRecord(
    root, child.processId, 'process-binding', child.processBindingSha256
  )).record;
  assertForkChildCore(plan, parent, child, binding);
  const expectedTasks = taskInstancesForSgosProgram(program, child.processId);
  if (child.processRevision !== 3 || child.status !== 'running'
      || child.updatedAt !== plan.createdAt
      || child.currentCheckpointSha256 !== started.checkpoint.checkpointSha256
      || child.activeExecutions.length || child.activeLeases.length
      || child.openHumanRequests.length
      || canonicalJson(child.taskInstances) !== canonicalJson(expectedTasks)
      || started.checkpoint.priorCheckpointSha256 !== null
      || started.checkpoint.processRevision !== 2
      || started.checkpoint.processBindingSha256 !== child.processBindingSha256
      || canonicalJson(started.checkpoint.taskStates)
        !== canonicalJson(Object.fromEntries(Object.entries(expectedTasks)
          .map(([id, task]) => [id, task.state])))) {
    fail('Fork child exists but is not the exact unexecuted genesis created by this plan.',
      'SGOS_FORK_CHILD_NOT_GENESIS', { childProcessId: plan.childProcessId });
  }
  return Object.freeze({ child, binding, checkpoint: started.checkpoint });
}

async function validateCanonicalForkReceipt(root, plan, parent, receipt) {
  if (receipt.parentProcessId !== plan.parentProcessId
      || receipt.parentProcessSha256 !== plan.expectedParentProcessSha256
      || receipt.fromCheckpointSha256 !== plan.fromCheckpointSha256
      || receipt.forkPlanSha256 !== plan.forkPlanSha256
      || receipt.childProcessId !== plan.childProcessId
      || !HASH.test(String(receipt.forkIntentSha256 ?? ''))
      || !HASH.test(String(receipt.childProcessSha256 ?? ''))
      || !HASH.test(String(receipt.childProcessBindingSha256 ?? ''))
      || !HASH.test(String(receipt.childGenesisCheckpointSha256 ?? ''))
      || receipt.childProcessRevision !== 3
      || receipt.forkedAt !== plan.createdAt) {
    fail('Canonical SGOS fork receipt does not match its confirmed plan.',
      'SGOS_LINEAGE_CORRUPT', { forkPlanSha256: plan.forkPlanSha256 });
  }
  const intent = await readCanonicalForkRecord(
    root, plan.parentProcessId, 'fork-intents', plan.forkPlanSha256,
    'sgos-fork-intent', 'forkIntentSha256'
  );
  if (intent.forkIntentSha256 !== receipt.forkIntentSha256
      || canonicalJson(intent) !== canonicalJson(forkIntentFor(plan, parent))) {
    fail('Canonical SGOS fork receipt has no exact predecessor intent.',
      'SGOS_LINEAGE_CORRUPT', { forkPlanSha256: plan.forkPlanSha256 });
  }
  const child = await readSgosProcess(root, plan.childProcessId);
  const binding = (await readSgosImmutableRecord(
    root, child.processId, 'process-binding', child.processBindingSha256
  )).record;
  assertForkChildCore(plan, parent, child, binding);
  if (binding.bindingSha256 !== receipt.childProcessBindingSha256) {
    fail('Canonical SGOS fork receipt names a different child binding.',
      'SGOS_LINEAGE_CORRUPT');
  }
  const genesis = (await readSgosCheckpoint(
    root, child.processId, receipt.childGenesisCheckpointSha256
  )).record;
  if (genesis.priorCheckpointSha256 !== null || genesis.processRevision !== 2
      || genesis.programSha256 !== child.programSha256
      || genesis.processBindingSha256 !== child.processBindingSha256) {
    fail('Canonical SGOS fork receipt does not bind the exact child genesis checkpoint.',
      'SGOS_LINEAGE_CORRUPT');
  }
  if (child.processSha256 !== receipt.childProcessSha256) {
    const successors = await listSgosImmutableRecordsByField(
      root, child.processId, 'sgos-control-event',
      'beforeProcessSha256', receipt.childProcessSha256
    );
    if (successors.length !== 1) {
      fail('Canonical SGOS fork child does not descend from its exact recorded genesis.',
        'SGOS_LINEAGE_CORRUPT', { childProcessId: child.processId });
    }
  }
  return child;
}

export async function forkSgosProcess(root, processId, {
  confirmationSha256,
  clock = null
} = {}) {
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Fork requires an exact fork-plan confirmation.', 'SGOS_FORK_CONFIRMATION_REQUIRED');
  }
  const plan = await readLineage(root, processId, 'fork-plans', confirmationSha256,
    'sgos-fork-plan', 'forkPlanSha256');
  assertForkPlanShape(plan, processId);
  const parent = (await recoverPendingSgosTransition(root, processId)).process;
  const existingReceipt = await readCanonicalForkRecord(
    root, processId, 'fork-receipts', plan.forkPlanSha256,
    'sgos-fork-receipt', 'forkReceiptSha256', { optional: true }
  );
  if (existingReceipt !== null) {
    const child = await validateCanonicalForkReceipt(root, plan, parent, existingReceipt);
    return Object.freeze({
      parent, child, plan, receipt: existingReceipt, created: false, recovered: true
    });
  }
  if (parent.processRevision !== plan.expectedParentProcessRevision
      || parent.processSha256 !== plan.expectedParentProcessSha256
      || parent.processBindingSha256 !== plan.parentProcessBindingSha256
      || parent.taskContractSha256 !== plan.taskContractSha256) {
    fail('Parent Process changed after fork preview; create a new exact plan.', 'SGOS_FORK_PLAN_STALE');
  }
  assertQuiescent(parent);
  let parentBinding;
  try { parentBinding = await assertCurrentStoredProcessBinding(root, parent); }
  catch (error) {
    if (error?.code !== 'SGOS_PROCESS_BINDING_STALE') throw error;
    fail('Repository baseline changed after fork preview; create a new exact plan.',
      'SGOS_FORK_PLAN_STALE', { cause: error.message, ...error.details });
  }
  if (parentBinding.branch !== plan.subject.branch
      || parentBinding.baselineRevision !== plan.subject.baselineRevision) {
    fail('Parent immutable subject binding does not match the confirmed fork plan.',
      'SGOS_FORK_PLAN_STALE');
  }
  await checkpointInLineage(root, parent, plan.fromCheckpointSha256);
  const expectedIntent = forkIntentFor(plan, parent);
  let intent = await readCanonicalForkRecord(
    root, processId, 'fork-intents', plan.forkPlanSha256,
    'sgos-fork-intent', 'forkIntentSha256', { optional: true }
  );
  if (intent === null) {
    if (await readProcessIfPresent(root, plan.childProcessId) !== null) {
      fail('Fork child already exists without the confirmed predecessor intent.',
        'SGOS_FORK_CHILD_PREEXISTING', { childProcessId: plan.childProcessId });
    }
    await writeImmutable(root,
      canonicalLineagePath(root, processId, 'fork-intents', plan.forkPlanSha256),
      expectedIntent, 'forkIntentSha256');
    intent = expectedIntent;
  } else if (canonicalJson(intent) !== canonicalJson(expectedIntent)) {
    fail('Fork predecessor intent conflicts with the confirmed parent and plan.',
      'SGOS_LINEAGE_RECORD_CONFLICT', { forkPlanSha256: plan.forkPlanSha256 });
  }
  const program = (await readSgosProgram(root, processId, plan.programSha256)).record;
  const started = await startSgosProcess(root, {
    program,
    taskContractSha256: parent.taskContractSha256,
    processId: plan.childProcessId,
    subject: plan.subject,
    // Fork genesis is a pure function of the previewed plan, not confirmation wall-clock time.
    clock: plan.createdAt
  });
  void clock;
  const genesis = await assertExactForkGenesis(root, plan, parent, started, program);
  const receipt = sealLineage('sgos-fork-receipt', 'forkReceiptSha256', {
    parentProcessId: processId,
    parentProcessSha256: plan.expectedParentProcessSha256,
    fromCheckpointSha256: plan.fromCheckpointSha256,
    forkPlanSha256: plan.forkPlanSha256,
    forkIntentSha256: intent.forkIntentSha256,
    childProcessId: started.process.processId,
    childProcessSha256: started.process.processSha256,
    childProcessBindingSha256: genesis.binding.bindingSha256,
    childGenesisCheckpointSha256: genesis.checkpoint.checkpointSha256,
    childProcessRevision: started.process.processRevision,
    forkedAt: plan.createdAt
  });
  await writeImmutable(root,
    canonicalLineagePath(root, processId, 'fork-receipts', plan.forkPlanSha256),
    receipt, 'forkReceiptSha256');
  return Object.freeze({ parent, child: started.process, plan, receipt, created: started.created });
}

const LINEAGE_CATEGORIES = Object.freeze({
  'replay-receipts': Object.freeze({
    kind: 'sgos-replay-receipt', hashField: 'replayReceiptSha256', key: 'self'
  }),
  'fork-plans': Object.freeze({
    kind: 'sgos-fork-plan', hashField: 'forkPlanSha256', key: 'self'
  }),
  'fork-intents': Object.freeze({
    kind: 'sgos-fork-intent', hashField: 'forkIntentSha256', key: 'forkPlanSha256'
  }),
  'fork-receipts': Object.freeze({
    kind: 'sgos-fork-receipt', hashField: 'forkReceiptSha256', key: 'forkPlanSha256'
  })
});

/**
 * Bounded no-follow census for private replay/fork receipts. The mutable Process fsck calls this
 * and supplies the replay plans rooted in its record index; no Process/store read occurs here, so
 * the census is safe while the caller holds the parent Process lock.
 */
export async function inspectSgosLineageIntegrity(root, processId, {
  rootedReplayPlanSha256s = new Set()
} = {}) {
  const errors = [];
  const records = new Map();
  let recordCount = 0;
  let bytes = 0;
  let rootEntries = [];
  try { rootEntries = await listPrivateSidecar(root, lineageRoot(root, processId), { optional: true }); }
  catch (error) {
    errors.push(Object.freeze({
      code: error?.code ?? 'SGOS_LINEAGE_CORRUPT', message: error?.message ?? String(error)
    }));
  }
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !Object.hasOwn(LINEAGE_CATEGORIES, entry.name)) {
      errors.push(Object.freeze({
        code: 'SGOS_SIDECAR_PATH_UNSAFE',
        message: `Unrecognized SGOS lineage entry '${entry.name}'.`
      }));
    }
  }
  for (const [category, contract] of Object.entries(LINEAGE_CATEGORIES)) {
    const directory = path.join(lineageRoot(root, processId), category);
    let entries;
    try { entries = await listPrivateSidecar(root, directory, { optional: true }); }
    catch (error) {
      errors.push(Object.freeze({
        code: error?.code ?? 'SGOS_LINEAGE_CORRUPT',
        message: error?.message ?? String(error), category
      }));
      continue;
    }
    if (recordCount + entries.length > SGOS_INSTALLED_LIMITS.maximumControlRecords) {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_LIMIT',
        message: 'Private SGOS lineage exceeds its installed record ceiling.'
      }));
      break;
    }
    for (const entry of entries) {
      recordCount += 1;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
        errors.push(Object.freeze({
          code: 'SGOS_SIDECAR_PATH_UNSAFE',
          message: `Unrecognized ${category} entry '${entry.name}'.`, category
        }));
        continue;
      }
      const keyDigest = `sha256:${entry.name.slice(0, -'.json'.length)}`;
      const target = path.join(directory, entry.name);
      try {
        const raw = await readPrivateSidecar(root, target, {
          maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes
        });
        bytes += raw.length;
        if (bytes > SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes) {
          fail('Private SGOS lineage exceeds its installed byte ceiling.', 'SGOS_LINEAGE_LIMIT');
        }
        const record = await readLineageTarget(root, target, {
          digest: contract.key === 'self' ? keyDigest : null,
          kind: contract.kind,
          hashField: contract.hashField
        });
        if (contract.key === 'forkPlanSha256' && record.forkPlanSha256 !== keyDigest) {
          fail('Canonical fork lineage key does not match forkPlanSha256.',
            'SGOS_LINEAGE_CORRUPT');
        }
        const identity = `${category}\u0000${keyDigest}`;
        records.set(identity, record);
      } catch (error) {
        errors.push(Object.freeze({
          code: error?.code ?? 'SGOS_LINEAGE_CORRUPT',
          message: error?.message ?? String(error), category, keyDigest
        }));
      }
    }
  }

  const plans = new Map([...records.entries()]
    .filter(([identity]) => identity.startsWith('fork-plans\u0000'))
    .map(([, record]) => [record.forkPlanSha256, record]));
  const intents = new Map([...records.entries()]
    .filter(([identity]) => identity.startsWith('fork-intents\u0000'))
    .map(([, record]) => [record.forkPlanSha256, record]));
  const receipts = new Map([...records.entries()]
    .filter(([identity]) => identity.startsWith('fork-receipts\u0000'))
    .map(([, record]) => [record.forkPlanSha256, record]));
  for (const [forkPlanSha256, plan] of plans) {
    try { assertForkPlanShape(plan, processId); }
    catch (error) {
      errors.push(Object.freeze({
        code: error?.code ?? 'SGOS_LINEAGE_CORRUPT', message: error?.message ?? String(error),
        forkPlanSha256
      }));
    }
  }
  for (const [forkPlanSha256, intent] of intents) {
    const plan = plans.get(forkPlanSha256);
    if (!plan || intent.parentProcessId !== processId
        || intent.childProcessId !== plan.childProcessId
        || intent.parentProcessSha256 !== plan.expectedParentProcessSha256
        || intent.programSha256 !== plan.programSha256
        || intent.parentProcessBindingSha256 !== plan.parentProcessBindingSha256
        || intent.taskContractSha256 !== plan.taskContractSha256
        || canonicalJson(intent.subject) !== canonicalJson(plan.subject)
        || intent.createdAt !== plan.createdAt) {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Fork intent is orphaned from its exact fork plan.', forkPlanSha256
      }));
    }
  }
  for (const [forkPlanSha256, receipt] of receipts) {
    const plan = plans.get(forkPlanSha256);
    const intent = intents.get(forkPlanSha256);
    if (!plan || !intent || receipt.parentProcessId !== processId
        || receipt.parentProcessSha256 !== plan.expectedParentProcessSha256
        || receipt.childProcessId !== plan.childProcessId
        || receipt.forkIntentSha256 !== intent.forkIntentSha256
        || receipt.forkedAt !== plan.createdAt) {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Fork receipt is orphaned from its exact plan and predecessor intent.',
        forkPlanSha256
      }));
    }
  }
  for (const record of records.values()) {
    if (record.kind === 'sgos-replay-receipt'
        && (record.processId !== processId
          || !rootedReplayPlanSha256s.has(record.replayPlanSha256))) {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Replay receipt is not bound to a replay plan rooted by this Process.',
        replayReceiptSha256: record.replayReceiptSha256
      }));
    }
  }
  const incompleteForkPlans = [...intents.keys()]
    .filter((forkPlanSha256) => !receipts.has(forkPlanSha256))
    .sort(compareSgosCodePoints);
  return Object.freeze({
    status: errors.length ? 'failed' : incompleteForkPlans.length ? 'attention' : 'ok',
    recordCount,
    bytes,
    incompleteForkPlans: Object.freeze(incompleteForkPlans),
    errors: Object.freeze(errors)
  });
}
