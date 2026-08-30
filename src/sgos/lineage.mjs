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
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { branch, gitCommonDir, head } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso, writeAtomic } from '../util.mjs';
import { createSgosReplayPlan, deterministicSgosId, sha256 } from './contracts.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { startSgosProcess } from './runtime.mjs';
import {
  mutateSgosProcess, putSgosImmutableRecord, readSgosCheckpoint,
  readSgosImmutableRecord, readSgosProcess, readSgosProgram,
  recoverPendingSgosTransition
} from './store.mjs';

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

async function writeImmutable(target, record, hashField) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  let existing = null;
  try { existing = JSON.parse(await readFile(target, 'utf8')); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && canonicalJson(existing) !== canonicalJson(record)) {
    fail('Immutable SGOS lineage record conflicts with existing bytes.',
      'SGOS_LINEAGE_RECORD_CONFLICT', { hash: record[hashField] });
  }
  if (!existing) await writeAtomic(target, canonicalJson(record), { mode: 0o600 });
  return record;
}

function lineagePath(root, processId, category, digest) {
  if (!HASH.test(String(digest ?? ''))) fail('Lineage digest is invalid.', 'SGOS_LINEAGE_INVALID');
  return path.join(lineageRoot(root, processId), category, `${digest.slice('sha256:'.length)}.json`);
}

async function readLineage(root, processId, category, digest, kind, hashField) {
  let record;
  try { record = JSON.parse(await readFile(lineagePath(root, processId, category, digest), 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') fail(`SGOS ${kind} was not found.`, 'SGOS_LINEAGE_NOT_FOUND', { digest });
    throw error;
  }
  const core = structuredClone(record);
  delete core[hashField];
  if (record.lineageFormat !== 'sflow.sgos.lineage' || record.lineageVersion !== 1
      || record.kind !== kind || record[hashField] !== digest || sha256(core) !== digest) {
    fail(`SGOS ${kind} failed its exact content hash.`, 'SGOS_LINEAGE_CORRUPT', { digest });
  }
  return freezeDeep(record);
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
        && task.receiptSha256 === prior.receiptSha256
        && canonicalJson(task.outputRefs) === canonicalJson(prior.outputRefs);
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
  await writeImmutable(lineagePath(root, processId, 'replay-receipts', receipt.replayReceiptSha256),
    receipt, 'replayReceiptSha256');
  return Object.freeze({ process: next, plan, receipt, recovered: alreadyApplied });
}

export async function planSgosProcessFork(root, processId, {
  fromCheckpointSha256,
  label = 'fork',
  createdAt = nowIso()
} = {}) {
  const process = await readSgosProcess(root, processId);
  assertQuiescent(process);
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
    subject: {
      kind: process.authorityBinding.kind,
      id: process.authorityBinding.subjectId,
      branch: branch(root),
      baselineRevision: head(root)
    },
    label,
    createdAt
  });
  await writeImmutable(lineagePath(root, processId, 'fork-plans', plan.forkPlanSha256),
    plan, 'forkPlanSha256');
  return plan;
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
  const parent = await readSgosProcess(root, processId);
  if (parent.processRevision !== plan.expectedParentProcessRevision
      || parent.processSha256 !== plan.expectedParentProcessSha256) {
    fail('Parent Process changed after fork preview; create a new exact plan.', 'SGOS_FORK_PLAN_STALE');
  }
  assertQuiescent(parent);
  await checkpointInLineage(root, parent, plan.fromCheckpointSha256);
  const observedSubject = { branch: branch(root), baselineRevision: head(root) };
  if (observedSubject.branch !== plan.subject.branch
      || observedSubject.baselineRevision !== plan.subject.baselineRevision) {
    fail('Repository baseline changed after fork preview; create a new exact plan.',
      'SGOS_FORK_PLAN_STALE', {
        expected: {
          branch: plan.subject.branch,
          baselineRevision: plan.subject.baselineRevision
        },
        observed: observedSubject
      });
  }
  const program = (await readSgosProgram(root, processId, plan.programSha256)).record;
  const started = await startSgosProcess(root, {
    program,
    taskContractSha256: parent.taskContractSha256,
    processId: plan.childProcessId,
    subject: plan.subject,
    clock: typeof clock === 'string' ? clock : null
  });
  const receipt = sealLineage('sgos-fork-receipt', 'forkReceiptSha256', {
    parentProcessId: processId,
    parentProcessSha256: parent.processSha256,
    fromCheckpointSha256: plan.fromCheckpointSha256,
    forkPlanSha256: plan.forkPlanSha256,
    childProcessId: started.process.processId,
    childProcessSha256: started.process.processSha256,
    childProcessRevision: started.process.processRevision,
    forkedAt: typeof clock === 'string' ? clock : nowIso()
  });
  await writeImmutable(lineagePath(root, processId, 'fork-receipts', receipt.forkReceiptSha256),
    receipt, 'forkReceiptSha256');
  return Object.freeze({ parent, child: started.process, plan, receipt, created: started.created });
}
