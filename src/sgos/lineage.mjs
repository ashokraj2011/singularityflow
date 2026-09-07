/**
 * Exact SGOS replay and fork lineage for the installed local profile.
 *
 * Replay never erases attempts, receipts, or evidence. It records the exact pre-replay task
 * projection first, then performs one Process CAS that makes the replayable suffix runnable again. Tasks
 * that wrote resources or declared external effects are reopened only when an installed Device
 * can revalidate the original idempotency key and exact postcondition without executing the
 * effect again. Read-only Device tasks remain ordinary replayable work.
 *
 * Forking from genesis creates an independent Process with fresh budgets. A non-genesis fork
 * imports an exact, separately receipted prefix: source attempts and effects remain attributed to
 * the parent while child-local recovery attempts make the inherited budget and outputs explicit.
 */
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import {
  createCandidateSnapshot, createEffectReplayReceipt, createForkPrefixImportReceipt,
  createForkPrefixTaskImport, createGvmCheckpoint, createSgosReplayPlan,
  deterministicSgosId, sha256
} from './contracts.mjs';
import {
  installedDeviceManifests, readSgosToolIntent, readSgosToolResult,
  verifySgosDeviceEffectPostcondition
} from './devices.mjs';
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
import { sgosTaskReadiness } from './scheduler.mjs';
import {
  buildSgosTaskAttempt, buildSgosTaskReceipt, compileSgosActionEvidence
} from './evidence.mjs';
import {
  compileSgosProcessEvidence, verifySgosProcessEvidence
} from './process-evidence.mjs';
import {
  assertSgosProcessPolicyAuthority, withSgosProcessPolicyAuthority
} from './pinned-policy.mjs';

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

function consequentialDeviceManifest(template) {
  if (template?.opcode !== 'DEVICE') return null;
  const manifestSha256 = template.metadata?.deviceManifestSha256;
  return installedDeviceManifests().find((entry) =>
    entry.manifestSha256 === manifestSha256) ?? null;
}

function replayEffectClassification(template) {
  const resources = template.resources ?? {};
  const declaresWrites = (resources.writes?.length ?? 0) > 0
    || (resources.externalEffects?.length ?? 0) > 0;
  const declaresDevices = (resources.devices?.length ?? 0) > 0;
  const manifest = consequentialDeviceManifest(template);
  if (template.opcode === 'DEVICE' && manifest?.effects?.class === 'read-only'
      && !declaresWrites) return Object.freeze({ kind: 'reexecute', manifest: null });
  if (template.opcode === 'DEVICE' && manifest != null
      && manifest.effects?.class !== 'read-only' && declaresWrites) {
    return Object.freeze({ kind: 'reconcile', manifest });
  }
  if (declaresWrites || declaresDevices) {
    return Object.freeze({ kind: 'unsafe', manifest });
  }
  return Object.freeze({ kind: 'reexecute', manifest: null });
}

function assertReplayableSuffix(process, program, taskInstanceIds) {
  const templates = templatesById(program);
  const reconciliationTasks = [];
  for (const taskInstanceId of taskInstanceIds) {
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task?.taskTemplateId);
    if (!task || !template
        || !['succeeded', 'failed', 'blocked', 'cancelled'].includes(task.state)
        || task.attemptIds.length === 0) {
      fail('Replay suffix does not contain only completed Program tasks.',
        'SGOS_REPLAY_PLAN_INVALID');
    }
    const classification = replayEffectClassification(template);
    if (classification.kind === 'unsafe') {
      const resources = template.resources ?? {};
      fail(`Task '${template.taskTemplateId}' has no installed exact effect-replay protocol.`,
        'SGOS_REPLAY_EFFECT_UNSAFE', {
          taskInstanceId,
          writes: resources.writes ?? [],
          devices: resources.devices ?? [],
          externalEffects: resources.externalEffects ?? []
        });
    }
    if (classification.kind === 'reconcile') {
      if (task.state !== 'succeeded' || task.receiptSha256 === null) {
        fail(`Task '${template.taskTemplateId}' has no successful effect to reconcile.`,
          'SGOS_REPLAY_EFFECT_UNSAFE', {
            taskInstanceId, state: task.state, receiptSha256: task.receiptSha256
          });
      }
      reconciliationTasks.push(Object.freeze({ task, template, manifest: classification.manifest }));
    }
  }
  const retained = retainedReplayClosure(process, { taskInstanceIds },
    reconciliationTasks.map((entry) => ({ taskInstanceId: entry.task.taskInstanceId })));
  for (const taskInstanceId of taskInstanceIds) {
    if (retained.has(taskInstanceId)) continue;
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task.taskTemplateId);
    if (task.attemptIds.length >= retryCeiling(template)) {
      fail(`Task '${template.taskTemplateId}' has no remaining governed attempt.`,
        'SGOS_REPLAY_ATTEMPT_CEILING', {
          taskInstanceId, attempts: task.attemptIds.length,
          maximumAttempts: retryCeiling(template)
        });
    }
  }
  return Object.freeze(reconciliationTasks);
}

async function effectReplayReceiptFor(root, process, plan, entry) {
  const { task, template, manifest } = entry;
  const { record: taskReceipt } = await readSgosImmutableRecord(
    root, process.processId, 'gvm-task-receipt', task.receiptSha256
  );
  if (taskReceipt.processId !== process.processId
      || taskReceipt.taskInstanceId !== task.taskInstanceId
      || taskReceipt.attemptId !== task.attemptIds.at(-1)
      || taskReceipt.receiptSha256 !== task.receiptSha256
      || canonicalJson(taskReceipt.outputRefs) !== canonicalJson(task.outputRefs)) {
    fail(`Task '${template.taskTemplateId}' has no exact successful receipt to reconcile.`,
      'SGOS_REPLAY_EFFECT_LINEAGE_INVALID', { taskInstanceId: task.taskInstanceId });
  }
  const references = [...new Set([
    ...(taskReceipt.evidenceRefs ?? []), ...(taskReceipt.effectRefs ?? []),
    ...(taskReceipt.outputRefs ?? [])
  ])];
  const intents = [];
  for (const reference of references) {
    if (!HASH.test(String(reference ?? ''))) continue;
    try { intents.push(await readSgosToolIntent(root, reference)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (intents.length !== 1) {
    fail(`Task '${template.taskTemplateId}' must bind exactly one Tool Intent for effect replay.`,
      'SGOS_REPLAY_EFFECT_LINEAGE_INVALID', {
        taskInstanceId: task.taskInstanceId, intentCount: intents.length
      });
  }
  const intent = intents[0];
  const result = await readSgosToolResult(root, intent.intentSha256);
  const parameters = template.metadata?.parameters ?? {};
  if (intent.processId !== process.processId
      || intent.taskInstanceId !== task.taskInstanceId
      || intent.attemptId !== taskReceipt.attemptId
      || intent.deviceManifestSha256 !== manifest.manifestSha256
      || intent.authorizationSha256 !== manifest.manifestSha256
      || intent.operation !== parameters.operation
      || intent.argumentsSha256 !== sha256(parameters.arguments)
      || intent.scopeSha256 !== sha256(parameters.scope)
      || !taskReceipt.outputRefs.includes(result.resultSha256)
      || !taskReceipt.effectRefs.includes(result.resultSha256)) {
    fail(`Task '${template.taskTemplateId}' effect lineage crosses its compiled Device boundary.`,
      'SGOS_REPLAY_EFFECT_LINEAGE_INVALID', { taskInstanceId: task.taskInstanceId });
  }
  const proof = await verifySgosDeviceEffectPostcondition(root, intent, result);
  return createEffectReplayReceipt({
    processId: process.processId,
    replayPlanSha256: plan.replayPlanSha256,
    taskInstanceId: task.taskInstanceId,
    taskTemplateId: task.taskTemplateId,
    attemptId: taskReceipt.attemptId,
    taskReceiptSha256: taskReceipt.receiptSha256,
    deviceManifestSha256: proof.deviceManifestSha256,
    toolIntentSha256: proof.toolIntentSha256,
    toolResultSha256: proof.toolResultSha256,
    idempotencyKey: proof.idempotencyKey,
    effectSha256: proof.effectSha256,
    postconditionSha256: proof.postconditionSha256,
    outputRefs: taskReceipt.outputRefs,
    reconciledAt: plan.createdAt
  });
}

async function exactEffectReplayReceipts(root, process, program, plan) {
  const templates = templatesById(program);
  const expected = plan.taskInstanceIds.flatMap((taskInstanceId) => {
    const task = process.taskInstances[taskInstanceId];
    const template = templates.get(task?.taskTemplateId);
    const classification = replayEffectClassification(template);
    return classification.kind === 'reconcile'
      ? [{ task, template, manifest: classification.manifest }] : [];
  });
  const stored = await listSgosImmutableRecordsByField(
    root, process.processId, 'effect-replay-receipt',
    'replayPlanSha256', plan.replayPlanSha256
  );
  if (stored.length !== expected.length) {
    fail('Effect replay receipts do not exactly cover the confirmed replay plan.',
      'SGOS_REPLAY_EFFECT_LINEAGE_INVALID', {
        expected: expected.length, actual: stored.length
      });
  }
  const byTask = new Map(stored.map((record) => [record.taskInstanceId, record]));
  if (byTask.size !== stored.length) {
    fail('Effect replay plan contains duplicate task reconciliation receipts.',
      'SGOS_REPLAY_EFFECT_LINEAGE_INVALID');
  }
  const verified = [];
  for (const entry of expected) {
    const current = await effectReplayReceiptFor(root, process, plan, entry);
    const prior = byTask.get(entry.task.taskInstanceId);
    if (prior == null || canonicalJson(current) !== canonicalJson(prior)) {
      fail(`Effect replay postcondition changed for task '${entry.task.taskTemplateId}'.`,
        'SGOS_REPLAY_EFFECT_STALE', { taskInstanceId: entry.task.taskInstanceId });
    }
    verified.push(prior);
  }
  return Object.freeze(verified.sort((left, right) =>
    compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId)));
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

async function planSgosProcessReplayWithinPolicy(root, processId, {
  fromCheckpointSha256,
  createdAt = nowIso()
} = {}) {
  await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.replay.plan', processId
  });
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  assertQuiescent(process);
  const checkpoint = await checkpointInLineage(root, process, fromCheckpointSha256);
  const program = (await readSgosProgram(root, processId, process.programSha256)).record;
  const taskInstanceIds = replayTaskIds(process, checkpoint);
  const reconciliationTasks = assertReplayableSuffix(process, program, taskInstanceIds);
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
  const effectReplayReceipts = [];
  for (const entry of reconciliationTasks) {
    effectReplayReceipts.push(await effectReplayReceiptFor(root, process, plan, entry));
  }
  await putSgosImmutableRecord(root, processId, 'sgos-replay-plan', plan);
  for (const receipt of effectReplayReceipts) {
    await putSgosImmutableRecord(root, processId, 'effect-replay-receipt', receipt);
  }
  return plan;
}

export async function planSgosProcessReplay(root, processId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'process.replay.plan', processId
  }, () => planSgosProcessReplayWithinPolicy(root, processId, options));
}

function resetSuffix(draft, plan, retainedEffectTaskIds = new Set()) {
  const replaySet = new Set(plan.taskInstanceIds.filter((id) => !retainedEffectTaskIds.has(id)));
  for (const taskInstanceId of plan.taskInstanceIds) {
    if (retainedEffectTaskIds.has(taskInstanceId)) continue;
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

function retainedReplayClosure(process, plan, effectReplayReceipts) {
  const inPlan = new Set(plan.taskInstanceIds);
  const retained = new Set(effectReplayReceipts.map((entry) => entry.taskInstanceId));
  const pending = [...retained];
  while (pending.length) {
    const taskInstanceId = pending.pop();
    const task = process.taskInstances[taskInstanceId];
    for (const predecessor of task?.predecessorTaskInstanceIds ?? []) {
      if (!inPlan.has(predecessor) || retained.has(predecessor)) continue;
      retained.add(predecessor);
      pending.push(predecessor);
    }
  }
  return retained;
}

async function replaySgosProcessWithinPolicy(root, processId, {
  confirmationSha256,
  clock = null
} = {}) {
  await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.replay', processId
  });
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Replay requires an exact replay-plan confirmation.', 'SGOS_REPLAY_CONFIRMATION_REQUIRED');
  }
  const plan = (await readSgosImmutableRecord(
    root, processId, 'sgos-replay-plan', confirmationSha256
  )).record;
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  const program = (await readSgosProgram(root, processId, process.programSha256)).record;
  const effectReplayReceipts = await exactEffectReplayReceipts(
    root, process, program, plan
  );
  const retainedEffectTaskIds = retainedReplayClosure(
    process, plan, effectReplayReceipts
  );
  const replaySet = new Set(plan.taskInstanceIds.filter((id) => !retainedEffectTaskIds.has(id)));
  const alreadyApplied = process.processRevision === plan.expectedProcessRevision + 1
    && process.status === 'running'
    && process.currentCheckpointSha256 === plan.fromCheckpointSha256
    && plan.priorTasks.every((prior) => {
      const task = process.taskInstances[prior.taskInstanceId];
      if (!task) return false;
      if (retainedEffectTaskIds.has(prior.taskInstanceId)) {
        return canonicalJson(taskLineageProjection(process, [prior.taskInstanceId])[0])
          === canonicalJson(prior);
      }
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
    const ids = replayTaskIds(process, checkpoint);
    if (canonicalJson(ids) !== canonicalJson(plan.taskInstanceIds)
        || canonicalJson(taskLineageProjection(process, ids)) !== canonicalJson(plan.priorTasks)) {
      fail('Replay inputs no longer match the confirmed plan.', 'SGOS_REPLAY_PLAN_STALE');
    }
    assertReplayableSuffix(process, program, ids);
    const replayRecord = await putSgosImmutableRecord(
      root, processId, 'sgos-replay-plan', plan, { reserveExisting: true }
    );
    const effectRecords = [];
    for (const receipt of effectReplayReceipts) {
      effectRecords.push(await putSgosImmutableRecord(
        root, processId, 'effect-replay-receipt', receipt, { reserveExisting: true }
      ));
    }
    try {
      next = await mutateSgosProcess(
        root, processId,
        (draft) => resetSuffix(draft, plan, retainedEffectTaskIds), {
        expectedRevision: process.processRevision,
        expectedProcessSha256: process.processSha256,
        updatedAt: typeof clock === 'string' ? clock : nowIso(),
        recordReservations: [
          replayRecord.reservationToken,
          ...effectRecords.map((entry) => entry.reservationToken)
        ],
        replayPlanSha256: plan.replayPlanSha256,
        effectReplayReceiptSha256s: effectReplayReceipts.map((entry) =>
          entry.effectReplayReceiptSha256)
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
    effectReplayReceiptSha256s: effectReplayReceipts.map((entry) =>
      entry.effectReplayReceiptSha256).sort(compareSgosCodePoints),
    replayedAt: next.updatedAt
  });
  await writeImmutable(root, lineagePath(root, processId, 'replay-receipts', receipt.replayReceiptSha256),
    receipt, 'replayReceiptSha256');
  return Object.freeze({
    process: next, plan, receipt, effectReplayReceipts, recovered: alreadyApplied
  });
}

export async function replaySgosProcess(root, processId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'process.replay', processId
  }, () => replaySgosProcessWithinPolicy(root, processId, options));
}

function processEvidenceProjectionSha256(bundle) {
  return sha256({
    format: bundle.format,
    processId: bundle.processId,
    processSha256: bundle.processSha256,
    programSha256: bundle.programSha256,
    processBindingSha256: bundle.processBindingSha256,
    recordIndexSha256: bundle.recordIndexSha256,
    controlEventSha256: bundle.controlEventSha256,
    records: bundle.records.map((entry) => ({
      family: entry.family, recordSha256: entry.recordSha256
    })),
    controlLineage: bundle.controlLineage.map((entry) => ({
      controlEventSha256: entry.event.controlEventSha256,
      successorSha256: entry.successor.successorSha256
    })),
    tools: bundle.tools.map((entry) => ({
      intentSha256: entry.intentSha256, resultSha256: entry.resultSha256
    }))
  });
}

function processAtEvidenceEvent(bundle, event) {
  const value = {
    schemaVersion: bundle.process.schemaVersion,
    kind: 'gvm-process',
    processId: bundle.process.processId,
    programSha256: bundle.process.programSha256,
    policySnapshotSha256: bundle.process.policySnapshotSha256,
    processBindingSha256: bundle.process.processBindingSha256,
    taskContractSha256: bundle.process.taskContractSha256,
    authorityBinding: structuredClone(bundle.process.authorityBinding),
    createdAt: bundle.process.createdAt,
    ...structuredClone(event.result),
    controlEventSha256: event.controlEventSha256,
    recordIndexSha256: event.recordIndexSha256
  };
  return Object.freeze({ ...value, processSha256: sha256(value) });
}

function checkpointEvidenceState(bundle, checkpoint) {
  const matches = bundle.controlLineage.filter(({ event }) =>
    event.result?.processRevision === checkpoint.processRevision);
  if (matches.length !== 1) {
    fail('The selected checkpoint has no unique historical Process control state.',
      'SGOS_FORK_PREFIX_EVIDENCE_INCOMPLETE', {
        checkpointProcessRevision: checkpoint.processRevision,
        matchingControlEvents: matches.length
      });
  }
  const pair = matches[0];
  const state = processAtEvidenceEvent(bundle, pair.event);
  const taskStates = Object.fromEntries(Object.entries(state.taskInstances)
    .map(([taskInstanceId, task]) => [taskInstanceId, task.state]));
  const readyTaskIds = Object.values(state.taskInstances)
    .filter((task) => task.state === 'ready')
    .map((task) => task.taskInstanceId).sort(compareSgosCodePoints);
  if (pair.successor?.controlEventSha256 !== pair.event.controlEventSha256
      || pair.successor?.beforeProcessSha256 !== pair.event.beforeProcessSha256
      || state.processId !== checkpoint.processId
      || state.programSha256 !== checkpoint.programSha256
      || state.policySnapshotSha256 !== checkpoint.policySnapshotSha256
      || state.processBindingSha256 !== checkpoint.processBindingSha256
      || canonicalJson(taskStates) !== canonicalJson(checkpoint.taskStates)
      || canonicalJson(readyTaskIds) !== canonicalJson(checkpoint.readyTaskIds)
      || state.activeExecutions.length || state.activeLeases.length
      || state.openHumanRequests.length) {
    fail('Checkpoint bytes do not match their exact quiescent historical Process state.',
      'SGOS_FORK_PREFIX_EVIDENCE_INVALID', {
        checkpointSha256: checkpoint.checkpointSha256,
        sourceProcessSha256: state.processSha256
      });
  }
  return Object.freeze({ state, event: pair.event, successor: pair.successor });
}

function evidenceRecordMap(bundle) {
  return new Map(bundle.records.map((entry) => [
    `${entry.family}\u0000${entry.recordSha256}`, entry.record
  ]));
}

function evidenceRecord(bundleRecords, family, recordSha256, detail) {
  const record = bundleRecords.get(`${family}\u0000${recordSha256}`);
  if (record == null) {
    fail(`Fork prefix source is missing ${detail}.`,
      'SGOS_FORK_PREFIX_EVIDENCE_INCOMPLETE', { family, recordSha256, detail });
  }
  return record;
}

function terminalAttemptLineage(bundle, task) {
  const attempts = task.attemptIds.map((attemptId, attemptIndex) => {
    const lineage = bundle.records.filter((entry) =>
      entry.family === 'gvm-task-attempt' && entry.record.attemptId === attemptId)
      .map((entry) => entry.record);
    const running = lineage.filter((entry) => entry.status === 'running');
    const terminal = lineage.filter((entry) => entry.status !== 'running');
    if (running.length !== 1 || terminal.length !== 1
        || running[0].processId !== bundle.processId
        || terminal[0].processId !== bundle.processId
        || running[0].taskInstanceId !== task.taskInstanceId
        || terminal[0].taskInstanceId !== task.taskInstanceId
        || running[0].attemptNumber !== attemptIndex + 1
        || terminal[0].attemptNumber !== attemptIndex + 1
        || running[0].parentAttemptId !== (task.attemptIds[attemptIndex - 1] ?? null)
        || terminal[0].parentAttemptId !== (task.attemptIds[attemptIndex - 1] ?? null)
        || running[0].executionHandleSha256 !== terminal[0].executionHandleSha256) {
      fail(`Fork prefix task '${task.taskTemplateId}' has incomplete attempt lineage.`,
        'SGOS_FORK_PREFIX_EVIDENCE_INCOMPLETE', { attemptId });
    }
    return Object.freeze({ running: running[0], terminal: terminal[0] });
  });
  if (!attempts.length || attempts.at(-1).terminal.status !== 'succeeded') {
    fail(`Fork prefix task '${task.taskTemplateId}' has no terminal successful attempt.`,
      'SGOS_FORK_PREFIX_EVIDENCE_INCOMPLETE');
  }
  return Object.freeze(attempts);
}

async function forkEffectReconciliation(root, sourceProcess, task, template, receipt) {
  const classification = replayEffectClassification(template);
  if (classification.kind === 'unsafe') {
    fail(`Fork prefix task '${template.taskTemplateId}' has no installed postcondition protocol.`,
      'SGOS_FORK_PREFIX_EFFECT_UNSAFE', { taskInstanceId: task.taskInstanceId });
  }
  if (classification.kind !== 'reconcile') return null;
  const references = [...new Set([
    ...receipt.evidenceRefs, ...receipt.effectRefs, ...receipt.outputRefs
  ])];
  const intents = [];
  for (const reference of references) {
    if (!HASH.test(String(reference ?? ''))) continue;
    try { intents.push(await readSgosToolIntent(root, reference)); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  if (intents.length !== 1) {
    fail(`Fork prefix task '${template.taskTemplateId}' has no unique Tool Intent.`,
      'SGOS_FORK_PREFIX_EFFECT_INVALID', { intentCount: intents.length });
  }
  const intent = intents[0];
  const result = await readSgosToolResult(root, intent.intentSha256);
  const proof = await verifySgosDeviceEffectPostcondition(root, intent, result);
  if (intent.processId !== sourceProcess.processId
      || intent.taskInstanceId !== task.taskInstanceId
      || intent.attemptId !== receipt.attemptId
      || receipt.outputRefs.includes(result.resultSha256) !== true
      || receipt.effectRefs.includes(result.resultSha256) !== true) {
    fail(`Fork prefix task '${template.taskTemplateId}' crosses its Device effect lineage.`,
      'SGOS_FORK_PREFIX_EFFECT_INVALID');
  }
  return Object.freeze({
    deviceManifestSha256: proof.deviceManifestSha256,
    toolIntentSha256: proof.toolIntentSha256,
    toolResultSha256: proof.toolResultSha256,
    idempotencyKey: proof.idempotencyKey,
    effectSha256: proof.effectSha256,
    postconditionSha256: proof.postconditionSha256
  });
}

async function buildForkPrefixPlan(root, process, checkpoint, childProcessId) {
  const bundle = await compileSgosProcessEvidence(root, process.processId);
  const report = verifySgosProcessEvidence(bundle);
  if (report.integrity !== 'valid' || report.contradictions.length) {
    fail('Parent Process Evidence is not exact enough for prefix import.',
      'SGOS_FORK_PREFIX_EVIDENCE_INVALID', { contradictions: report.contradictions });
  }
  const historical = checkpointEvidenceState(bundle, checkpoint);
  const records = evidenceRecordMap(bundle);
  const program = bundle.program;
  const childTasksByTemplate = new Map(Object.values(
    taskInstancesForSgosProgram(program, childProcessId)
  ).map((task) => [task.taskTemplateId, task]));
  const templates = templatesById(program);
  const prefixTasks = [];
  for (const template of program.taskTemplates) {
    const sourceTask = Object.values(historical.state.taskInstances)
      .find((task) => task.taskTemplateId === template.taskTemplateId);
    if (sourceTask?.state !== 'succeeded') continue;
    const childTask = childTasksByTemplate.get(template.taskTemplateId);
    const receipt = evidenceRecord(
      records, 'gvm-task-receipt', sourceTask.receiptSha256,
      `Task Receipt for '${template.taskTemplateId}'`
    );
    const sourceCandidate = evidenceRecord(
      records, 'candidate-snapshot', receipt.candidateSha256,
      `Candidate Snapshot for '${template.taskTemplateId}'`
    );
    const actionEvidence = receipt.evidenceRefs
      .filter((reference) => records.has(`action-evidence\u0000${reference}`))
      .map((reference) => evidenceRecord(
        records, 'action-evidence', reference,
        `Action Evidence for '${template.taskTemplateId}'`
      ));
    if (!actionEvidence.some((entry) =>
      entry.processId === process.processId
      && entry.taskInstanceId === sourceTask.taskInstanceId
      && entry.attemptId === receipt.attemptId
      && entry.verification?.status === 'passed'
      && entry.verification?.checksSha256 === receipt.verification?.checksSha256
      && (entry.contradictions?.length ?? 0) === 0)) {
      fail(`Fork prefix task '${template.taskTemplateId}' has no exact passing Action Evidence.`,
        'SGOS_FORK_PREFIX_EVIDENCE_INCOMPLETE');
    }
    const attempts = terminalAttemptLineage(bundle, sourceTask);
    if (receipt.processId !== process.processId
        || receipt.taskInstanceId !== sourceTask.taskInstanceId
        || receipt.attemptId !== sourceTask.attemptIds.at(-1)
        || receipt.attemptSha256 !== attempts.at(-1).terminal.attemptSha256
        || canonicalJson(receipt.inputRefs) !== canonicalJson(sourceTask.inputRefs)
        || canonicalJson(receipt.outputRefs) !== canonicalJson(sourceTask.outputRefs)) {
      fail(`Fork prefix task '${template.taskTemplateId}' has crossed receipt lineage.`,
        'SGOS_FORK_PREFIX_EVIDENCE_INVALID');
    }
    const childAttemptIds = attempts.map((entry, attemptIndex) => deterministicSgosId('ATT', {
      fork: 'prefix-import', childProcessId, childTaskInstanceId: childTask.taskInstanceId,
      attemptNumber: attemptIndex + 1, sourceAttemptId: entry.terminal.attemptId
    }));
    prefixTasks.push(Object.freeze({
      taskTemplateId: template.taskTemplateId,
      sourceTaskInstanceId: sourceTask.taskInstanceId,
      childTaskInstanceId: childTask.taskInstanceId,
      sourceTaskRevision: sourceTask.revision,
      inputRefs: [...sourceTask.inputRefs],
      outputRefs: [...sourceTask.outputRefs],
      sourceTaskReceiptSha256: receipt.receiptSha256,
      sourceCandidateSha256: sourceCandidate.candidateSha256,
      sourceActionEvidenceSha256s: actionEvidence.map((entry) => entry.evidenceSha256),
      sourceEvidenceRefs: [...receipt.evidenceRefs],
      sourceEffectRefs: [...receipt.effectRefs],
      sourceHumanDecisionRefs: [...receipt.humanDecisionRefs],
      verificationChecksSha256: receipt.verification.checksSha256,
      attempts: attempts.map((entry, attemptIndex) => ({
        sourceAttemptId: entry.terminal.attemptId,
        childAttemptId: childAttemptIds[attemptIndex],
        sourceRunningAttemptSha256: entry.running.attemptSha256,
        sourceTerminalAttemptSha256: entry.terminal.attemptSha256,
        sourceTerminalStatus: entry.terminal.status
      })),
      effectReconciliation: await forkEffectReconciliation(
        root, process, sourceTask, templates.get(template.taskTemplateId), receipt
      )
    }));
  }
  if (!prefixTasks.length) {
    fail('The selected non-genesis checkpoint contains no successful prefix to import.',
      'SGOS_FORK_PREFIX_EMPTY');
  }
  const importedTemplateIds = new Set(prefixTasks.map((entry) => entry.taskTemplateId));
  for (const entry of prefixTasks) {
    const template = templates.get(entry.taskTemplateId);
    if ((template.dependsOn ?? []).some((dependency) => !importedTemplateIds.has(dependency))) {
      fail(`Fork prefix task '${entry.taskTemplateId}' has a non-successful predecessor.`,
        'SGOS_FORK_PREFIX_EVIDENCE_INVALID');
    }
  }
  return Object.freeze({
    sourceEvidenceProjectionSha256: processEvidenceProjectionSha256(bundle),
    sourceProcessSha256: historical.state.processSha256,
    sourceProcessRevision: historical.state.processRevision,
    sourceControlEventSha256: historical.event.controlEventSha256,
    sourceRecordIndexSha256: historical.event.recordIndexSha256,
    prefixTasks: Object.freeze(prefixTasks)
  });
}

async function planSgosProcessForkWithinPolicy(root, processId, {
  fromCheckpointSha256,
  label = 'fork',
  createdAt = nowIso()
} = {}) {
  await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.fork.plan', processId
  });
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  assertQuiescent(process);
  const binding = await assertCurrentStoredProcessBinding(root, process);
  const checkpoint = await checkpointInLineage(root, process, fromCheckpointSha256);
  if (typeof label !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(label)) {
    fail('Fork label must use lower-case kebab case.', 'SGOS_FORK_LABEL_INVALID');
  }
  const childProcessId = deterministicSgosId('PROC', {
    parentProcessId: processId,
    parentProcessSha256: process.processSha256,
    fromCheckpointSha256,
    label
  });
  const prefix = checkpoint.priorCheckpointSha256 === null
    ? null
    : await buildForkPrefixPlan(root, process, checkpoint, childProcessId);
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
    createdAt,
    ...(prefix ?? {})
  });
  await writeImmutable(root, lineagePath(root, processId, 'fork-plans', plan.forkPlanSha256),
    plan, 'forkPlanSha256');
  return plan;
}

export async function planSgosProcessFork(root, processId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'process.fork.plan', processId
  }, () => planSgosProcessForkWithinPolicy(root, processId, options));
}

function assertForkPlanShape(plan, processId) {
  const prefixFields = [
    'sourceEvidenceProjectionSha256', 'sourceProcessSha256', 'sourceProcessRevision',
    'sourceControlEventSha256', 'sourceRecordIndexSha256', 'prefixTasks'
  ];
  const presentPrefixFields = prefixFields.filter((field) => plan[field] != null);
  if (![0, prefixFields.length].includes(presentPrefixFields.length)) {
    fail('SGOS fork plan has a partial prefix-import boundary.', 'SGOS_LINEAGE_CORRUPT', {
      forkPlanSha256: plan.forkPlanSha256, presentPrefixFields
    });
  }
  const prefix = presentPrefixFields.length === 0 ? null : {
    sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
    sourceProcessSha256: plan.sourceProcessSha256,
    sourceProcessRevision: plan.sourceProcessRevision,
    sourceControlEventSha256: plan.sourceControlEventSha256,
    sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
    prefixTasks: plan.prefixTasks
  };
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
      || typeof plan.createdAt !== 'string'
      || (prefix !== null && (
        !HASH.test(String(prefix.sourceEvidenceProjectionSha256 ?? ''))
        || !HASH.test(String(prefix.sourceProcessSha256 ?? ''))
        || !Number.isSafeInteger(prefix.sourceProcessRevision)
        || prefix.sourceProcessRevision < 2
        || !HASH.test(String(prefix.sourceControlEventSha256 ?? ''))
        || !HASH.test(String(prefix.sourceRecordIndexSha256 ?? ''))
        || !Array.isArray(prefix.prefixTasks)
        || prefix.prefixTasks.length < 1
        || prefix.prefixTasks.length > SGOS_INSTALLED_LIMITS.maximumTasks
      ))) {
    fail('SGOS fork plan failed its installed exact contract.', 'SGOS_LINEAGE_CORRUPT', {
      forkPlanSha256: plan.forkPlanSha256
    });
  }
  if (prefix !== null) {
    const sourceTasks = new Set();
    const childTasks = new Set();
    const templates = new Set();
    const sourceAttempts = new Set();
    const childAttempts = new Set();
    for (const entry of prefix.prefixTasks) {
      if (typeof entry?.taskTemplateId !== 'string'
          || typeof entry?.sourceTaskInstanceId !== 'string'
          || typeof entry?.childTaskInstanceId !== 'string'
          || !Number.isSafeInteger(entry?.sourceTaskRevision)
          || !Array.isArray(entry?.attempts) || !entry.attempts.length
          || entry.attempts.length > SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
          || !HASH.test(String(entry?.sourceTaskReceiptSha256 ?? ''))
          || !HASH.test(String(entry?.sourceCandidateSha256 ?? ''))
          || !HASH.test(String(entry?.verificationChecksSha256 ?? ''))
          || !Array.isArray(entry?.inputRefs) || !Array.isArray(entry?.outputRefs)
          || !Array.isArray(entry?.sourceActionEvidenceSha256s)
          || !Array.isArray(entry?.sourceEvidenceRefs)
          || !Array.isArray(entry?.sourceEffectRefs)
          || !Array.isArray(entry?.sourceHumanDecisionRefs)
          || !entry.sourceActionEvidenceSha256s.length
          || entry.sourceActionEvidenceSha256s.some((value) => !HASH.test(String(value)))
          || (entry.effectReconciliation !== null && (
            typeof entry.effectReconciliation !== 'object'
            || [
              'deviceManifestSha256', 'toolIntentSha256', 'toolResultSha256',
              'idempotencyKey', 'effectSha256', 'postconditionSha256'
            ].some((field) => !HASH.test(String(entry.effectReconciliation?.[field] ?? '')))
          ))
          || entry.attempts.some((attempt) =>
            !/^ATT-[A-Za-z0-9._:-]{6,127}$/.test(String(attempt?.sourceAttemptId ?? ''))
            || !/^ATT-[A-Za-z0-9._:-]{6,127}$/.test(String(attempt?.childAttemptId ?? ''))
            || !HASH.test(String(attempt?.sourceRunningAttemptSha256 ?? ''))
            || !HASH.test(String(attempt?.sourceTerminalAttemptSha256 ?? ''))
            || !['succeeded', 'failed', 'blocked', 'cancelled', 'recovery-required']
              .includes(attempt?.sourceTerminalStatus))) {
        fail('SGOS fork prefix plan failed its exact bounded task contract.',
          'SGOS_LINEAGE_CORRUPT', { forkPlanSha256: plan.forkPlanSha256 });
      }
      sourceTasks.add(entry.sourceTaskInstanceId);
      childTasks.add(entry.childTaskInstanceId);
      templates.add(entry.taskTemplateId);
      for (const attempt of entry.attempts) {
        sourceAttempts.add(attempt.sourceAttemptId);
        childAttempts.add(attempt.childAttemptId);
      }
      if (entry.attempts.at(-1).sourceTerminalStatus !== 'succeeded') {
        fail('SGOS fork prefix plan has no terminal successful source attempt.',
          'SGOS_LINEAGE_CORRUPT', { forkPlanSha256: plan.forkPlanSha256 });
      }
    }
    const attemptCount = prefix.prefixTasks.reduce((sum, entry) =>
      sum + entry.attempts.length, 0);
    if (sourceTasks.size !== prefix.prefixTasks.length
        || childTasks.size !== prefix.prefixTasks.length
        || templates.size !== prefix.prefixTasks.length
        || sourceAttempts.size !== attemptCount || childAttempts.size !== attemptCount) {
      fail('SGOS fork prefix plan contains duplicate task or attempt identities.',
        'SGOS_LINEAGE_CORRUPT', { forkPlanSha256: plan.forkPlanSha256 });
    }
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
    ...(plan.sourceEvidenceProjectionSha256 == null ? {} : {
      sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
      sourceProcessSha256: plan.sourceProcessSha256,
      sourceProcessRevision: plan.sourceProcessRevision,
      sourceControlEventSha256: plan.sourceControlEventSha256,
      sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
      prefixTasksSha256: sha256(plan.prefixTasks)
    }),
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

async function assertForkGenesisAncestor(root, plan, parent, child, program) {
  const binding = (await readSgosImmutableRecord(
    root, child.processId, 'process-binding', child.processBindingSha256
  )).record;
  assertForkChildCore(plan, parent, child, binding);
  let checkpoint = (await readSgosCheckpoint(
    root, child.processId, child.currentCheckpointSha256
  )).record;
  for (let depth = 0; checkpoint.priorCheckpointSha256 !== null; depth += 1) {
    if (depth >= MAX_CHECKPOINT_DEPTH) {
      fail('Fork child checkpoint lineage exceeds the installed traversal ceiling.',
        'SGOS_LINEAGE_LIMIT');
    }
    checkpoint = (await readSgosCheckpoint(
      root, child.processId, checkpoint.priorCheckpointSha256
    )).record;
  }
  const tasks = taskInstancesForSgosProgram(program, child.processId);
  if (checkpoint.processRevision !== 2
      || checkpoint.processId !== child.processId
      || checkpoint.programSha256 !== child.programSha256
      || checkpoint.policySnapshotSha256 !== child.policySnapshotSha256
      || checkpoint.processBindingSha256 !== child.processBindingSha256
      || checkpoint.createdAt !== plan.createdAt
      || checkpoint.activeExecutions.length || checkpoint.activeLeases.length
      || checkpoint.openHumanRequests.length
      || canonicalJson(checkpoint.taskStates)
        !== canonicalJson(Object.fromEntries(Object.entries(tasks)
          .map(([taskInstanceId, task]) => [taskInstanceId, task.state])))
      || canonicalJson(checkpoint.readyTaskIds)
        !== canonicalJson(Object.values(tasks).filter((task) => task.state === 'ready')
          .map((task) => task.taskInstanceId).sort(compareSgosCodePoints))) {
    fail('Fork child does not retain the exact genesis checkpoint for this plan.',
      'SGOS_FORK_CHILD_NOT_GENESIS', { childProcessId: child.processId });
  }
  return Object.freeze({ child, binding, checkpoint });
}

function topologicalForkPrefix(program, prefixTasks) {
  const pending = new Map(prefixTasks.map((entry) => [entry.taskTemplateId, entry]));
  const imported = new Set();
  const ordered = [];
  while (pending.size) {
    const eligible = [...pending.values()].filter((entry) => {
      const template = program.taskTemplates.find((candidate) =>
        candidate.taskTemplateId === entry.taskTemplateId);
      return template && (template.dependsOn ?? []).every((dependency) => imported.has(dependency));
    }).sort((left, right) => compareSgosCodePoints(
      left.taskTemplateId, right.taskTemplateId
    ));
    if (!eligible.length) {
      fail('Fork prefix is not a closed acyclic predecessor set.',
        'SGOS_FORK_PREFIX_EVIDENCE_INVALID');
    }
    for (const entry of eligible) {
      pending.delete(entry.taskTemplateId);
      imported.add(entry.taskTemplateId);
      ordered.push(entry);
    }
  }
  return ordered;
}

function refreshForkReadiness(process, program) {
  for (const task of Object.values(process.taskInstances)) {
    if (!['planned', 'waiting', 'ready'].includes(task.state)) continue;
    const readiness = sgosTaskReadiness(program, process, task);
    const state = readiness.impossible ? 'blocked' : readiness.ready ? 'ready' : 'waiting';
    if (task.state !== state) {
      task.state = state;
      task.revision += 1;
    }
  }
  process.status = 'running';
}

function assertForkImportBoundary(child, prefixTasks) {
  const prefixIds = new Set(prefixTasks.map((entry) => entry.childTaskInstanceId));
  for (const task of Object.values(child.taskInstances)) {
    if (prefixIds.has(task.taskInstanceId)) continue;
    if (task.attemptIds.length || task.receiptSha256 !== null || task.outputRefs.length
        || !['planned', 'waiting', 'ready'].includes(task.state)) {
      fail('Fork child advanced outside the exact imported prefix before receipt publication.',
        'SGOS_FORK_CHILD_CONFLICT', { taskInstanceId: task.taskInstanceId });
    }
  }
}

function importedCandidate(child, sourceCandidate, importedAt) {
  return createCandidateSnapshot({
    subject: {
      kind: child.authorityBinding.kind,
      id: child.authorityBinding.subjectId,
      revision: child.authorityBinding.baselineRevision,
      sha256: child.processBindingSha256
    },
    baseline: {
      revision: child.authorityBinding.baselineRevision,
      snapshotSha256: child.authorityBinding.baselineSnapshotSha256
    },
    resources: sourceCandidate.resources,
    createdBy: { id: 'sgos-fork-prefix-import', kind: 'system' },
    createdAt: importedAt
  });
}

function importedAttemptRecords(plan, child, entry, attemptIndex) {
  const mapping = entry.attempts[attemptIndex];
  const target = child.taskInstances[entry.childTaskInstanceId];
  const parentAttemptId = entry.attempts[attemptIndex - 1]?.childAttemptId ?? null;
  const handle = sha256({
    kind: 'sgos-fork-prefix-import-handle', forkPlanSha256: plan.forkPlanSha256,
    childProcessId: child.processId, childAttemptId: mapping.childAttemptId
  });
  const common = {
    attemptId: mapping.childAttemptId, processId: child.processId,
    taskInstanceId: target.taskInstanceId, attemptNumber: attemptIndex + 1,
    parentAttemptId, reason: 'recovery', taskContractSha256: child.taskContractSha256,
    executionHandleSha256: handle, startedAt: plan.createdAt
  };
  return Object.freeze({
    running: buildSgosTaskAttempt({
      ...common, status: 'running', completedAt: null
    }),
    terminal: buildSgosTaskAttempt({
      ...common, status: mapping.sourceTerminalStatus, completedAt: plan.createdAt
    })
  });
}

async function importForkPrefixTask(root, plan, child, program, entry) {
  const template = program.taskTemplates.find((candidate) =>
    candidate.taskTemplateId === entry.taskTemplateId);
  if (!template) fail('Fork prefix names a task outside the immutable Program.',
    'SGOS_FORK_PREFIX_EVIDENCE_INVALID');
  const sourceCandidate = (await readSgosImmutableRecord(
    root, plan.parentProcessId, 'candidate-snapshot', entry.sourceCandidateSha256
  )).record;
  for (let attemptIndex = 0; attemptIndex < entry.attempts.length; attemptIndex += 1) {
    child = (await recoverPendingSgosTransition(root, child.processId)).process;
    assertForkImportBoundary(child, plan.prefixTasks);
    const target = child.taskInstances[entry.childTaskInstanceId];
    const mapping = entry.attempts[attemptIndex];
    if (!target || target.taskTemplateId !== entry.taskTemplateId
        || canonicalJson(target.inputRefs) !== canonicalJson(entry.inputRefs)) {
      fail(`Fork prefix task '${entry.taskTemplateId}' no longer matches the child Program.`,
        'SGOS_FORK_CHILD_CONFLICT');
    }
    if (target.attemptIds.length > attemptIndex) {
      if (target.attemptIds[attemptIndex] !== mapping.childAttemptId) {
        fail(`Fork prefix task '${entry.taskTemplateId}' has conflicting attempt lineage.`,
          'SGOS_FORK_CHILD_CONFLICT');
      }
      continue;
    }
    if (target.attemptIds.length !== attemptIndex
        || !['ready', 'waiting'].includes(target.state)) {
      fail(`Fork prefix task '${entry.taskTemplateId}' is not at its exact import cursor.`,
        'SGOS_FORK_CHILD_CONFLICT', { attemptIndex });
    }
    const { running, terminal } = importedAttemptRecords(
      plan, child, entry, attemptIndex
    );
    const final = attemptIndex === entry.attempts.length - 1;
    const candidate = final ? importedCandidate(child, sourceCandidate, plan.createdAt) : null;
    const taskImport = final ? createForkPrefixTaskImport({
      forkPlanSha256: plan.forkPlanSha256,
      parentProcessId: plan.parentProcessId,
      childProcessId: child.processId,
      sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
      sourceProcessSha256: plan.sourceProcessSha256,
      sourceControlEventSha256: plan.sourceControlEventSha256,
      sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
      fromCheckpointSha256: plan.fromCheckpointSha256,
      sourceTaskInstanceId: entry.sourceTaskInstanceId,
      childTaskInstanceId: entry.childTaskInstanceId,
      taskTemplateId: entry.taskTemplateId,
      sourceTaskRevision: entry.sourceTaskRevision,
      inputRefs: entry.inputRefs, outputRefs: entry.outputRefs,
      attempts: entry.attempts.map((attempt, index) => {
        const records = importedAttemptRecords(plan, child, entry, index);
        return {
          ...attempt,
          childRunningAttemptSha256: records.running.attemptSha256,
          childTerminalAttemptSha256: records.terminal.attemptSha256
        };
      }),
      sourceTaskReceiptSha256: entry.sourceTaskReceiptSha256,
      sourceCandidateSha256: entry.sourceCandidateSha256,
      sourceActionEvidenceSha256s: entry.sourceActionEvidenceSha256s,
      sourceEvidenceRefs: entry.sourceEvidenceRefs,
      sourceEffectRefs: entry.sourceEffectRefs,
      sourceHumanDecisionRefs: entry.sourceHumanDecisionRefs,
      verificationChecksSha256: entry.verificationChecksSha256,
      effectReconciliation: entry.effectReconciliation,
      importedAt: plan.createdAt
    }) : null;
    const evidence = final ? compileSgosActionEvidence({
      processId: child.processId, taskInstanceId: target.taskInstanceId,
      attemptId: mapping.childAttemptId,
      principal: { id: 'sgos-fork-prefix-import', kind: 'system' },
      delegation: {
        forkPlanSha256: plan.forkPlanSha256,
        sourceTaskReceiptSha256: entry.sourceTaskReceiptSha256
      },
      programSha256: child.programSha256,
      taskContractSha256: child.taskContractSha256,
      executionUnitManifest: template.metadata?.executionUnitManifestSha256 ?? null,
      deviceManifest: template.metadata?.deviceManifestSha256 ?? null,
      arguments: template.operation ?? {},
      preState: { sourceProcessSha256: plan.sourceProcessSha256 },
      rawResult: {
        status: 'completed', imported: true,
        sourceTaskReceiptSha256: entry.sourceTaskReceiptSha256
      },
      postState: candidate.candidateSha256,
      verification: { status: 'passed', checksSha256: entry.verificationChecksSha256 },
      cost: { status: 'not-invoked', amount: 0 }, latencyMs: 0,
      evidenceRefs: [taskImport.forkTaskImportSha256], effectRefs: [],
      humanDecisionRefs: [], executionEvents: [],
      requiresExecutionUnit: false, requiresDevice: false,
      createdAt: plan.createdAt
    }) : null;
    const receipt = final ? buildSgosTaskReceipt({
      processId: child.processId, taskInstanceId: target.taskInstanceId,
      attemptId: mapping.childAttemptId, attemptSha256: terminal.attemptSha256,
      inputRefs: entry.inputRefs, outputRefs: entry.outputRefs,
      candidateSha256: candidate.candidateSha256,
      evidenceRefs: [
        candidate.candidateSha256, evidence.evidenceSha256, taskImport.forkTaskImportSha256
      ],
      effectRefs: [], humanDecisionRefs: [],
      verification: { status: 'passed', checksSha256: entry.verificationChecksSha256 },
      completedAt: plan.createdAt
    }) : null;
    child = await mutateSgosProcess(root, child.processId, async (draft) => {
      await putSgosImmutableRecord(root, child.processId, 'gvm-task-attempt', running,
        { reserveExisting: true });
      await putSgosImmutableRecord(root, child.processId, 'gvm-task-attempt', terminal,
        { reserveExisting: true });
      if (final) {
        await putSgosImmutableRecord(root, child.processId, 'candidate-snapshot', candidate,
          { reserveExisting: true });
        await putSgosImmutableRecord(root, child.processId, 'fork-prefix-task-import', taskImport,
          { reserveExisting: true });
        await putSgosImmutableRecord(root, child.processId, 'action-evidence', evidence,
          { reserveExisting: true });
        await putSgosImmutableRecord(root, child.processId, 'gvm-task-receipt', receipt,
          { reserveExisting: true });
      }
      const mutable = draft.taskInstances[target.taskInstanceId];
      mutable.attemptIds = [...mutable.attemptIds, mapping.childAttemptId];
      if (final) {
        mutable.state = 'succeeded';
        mutable.outputRefs = [...entry.outputRefs];
        mutable.receiptSha256 = receipt.receiptSha256;
      }
      mutable.revision += 1;
      refreshForkReadiness(draft, program);
    }, {
      expectedRevision: child.processRevision,
      expectedProcessSha256: child.processSha256,
      updatedAt: plan.createdAt
    });
  }
  const completed = child.taskInstances[entry.childTaskInstanceId];
  if (completed.state !== 'succeeded'
      || canonicalJson(completed.attemptIds)
        !== canonicalJson(entry.attempts.map((attempt) => attempt.childAttemptId))
      || canonicalJson(completed.outputRefs) !== canonicalJson(entry.outputRefs)
      || !HASH.test(String(completed.receiptSha256 ?? ''))) {
    fail(`Fork prefix task '${entry.taskTemplateId}' did not converge on its exact import.`,
      'SGOS_FORK_CHILD_CONFLICT');
  }
  return child;
}

async function finalizeForkPrefixImport(root, plan, child, genesis) {
  assertForkImportBoundary(child, plan.prefixTasks);
  const tasks = [];
  for (const entry of plan.prefixTasks) {
    const task = child.taskInstances[entry.childTaskInstanceId];
    if (!task || task.state !== 'succeeded') {
      fail('Fork prefix cannot finalize before every imported task succeeds.',
        'SGOS_FORK_CHILD_CONFLICT');
    }
    const receipt = (await readSgosImmutableRecord(
      root, child.processId, 'gvm-task-receipt', task.receiptSha256
    )).record;
    const imports = await listSgosImmutableRecordsByField(
      root, child.processId, 'fork-prefix-task-import',
      'childTaskInstanceId', task.taskInstanceId
    );
    if (imports.length !== 1 || !receipt.evidenceRefs.includes(imports[0].forkTaskImportSha256)) {
      fail('Fork prefix task does not retain one exact import receipt.',
        'SGOS_FORK_PREFIX_EVIDENCE_INVALID');
    }
    tasks.push({
      taskTemplateId: entry.taskTemplateId,
      sourceTaskInstanceId: entry.sourceTaskInstanceId,
      childTaskInstanceId: entry.childTaskInstanceId,
      forkTaskImportSha256: imports[0].forkTaskImportSha256,
      childTaskReceiptSha256: receipt.receiptSha256,
      attemptCount: entry.attempts.length,
      outputRefs: entry.outputRefs
    });
  }
  let current = (await recoverPendingSgosTransition(root, child.processId)).process;
  if (current.currentCheckpointSha256 !== genesis.checkpointSha256) {
    const existing = await listSgosImmutableRecordsByField(
      root, child.processId, 'fork-prefix-import-receipt',
      'forkPlanSha256', plan.forkPlanSha256
    );
    if (existing.length !== 1
        || current.currentCheckpointSha256 !== existing[0].childImportedCheckpointSha256) {
      fail('Fork child checkpoint advanced outside the confirmed import.',
        'SGOS_FORK_CHILD_CONFLICT');
    }
    return Object.freeze({ child: current, checkpoint: (await readSgosCheckpoint(
      root, child.processId, current.currentCheckpointSha256
    )).record, importReceipt: existing[0] });
  }
  const checkpoint = createGvmCheckpoint({
    processId: current.processId,
    processRevision: current.processRevision,
    programSha256: current.programSha256,
    policySnapshotSha256: current.policySnapshotSha256,
    processBindingSha256: current.processBindingSha256,
    taskStates: Object.fromEntries(Object.entries(current.taskInstances)
      .map(([taskInstanceId, task]) => [taskInstanceId, task.state])),
    readyTaskIds: Object.values(current.taskInstances).filter((task) => task.state === 'ready')
      .map((task) => task.taskInstanceId).sort(compareSgosCodePoints),
    activeExecutions: [], openHumanRequests: [], activeLeases: [],
    priorCheckpointSha256: genesis.checkpointSha256,
    createdAt: plan.createdAt
  });
  const importReceipt = createForkPrefixImportReceipt({
    forkPlanSha256: plan.forkPlanSha256,
    parentProcessId: plan.parentProcessId,
    childProcessId: current.processId,
    sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
    sourceProcessSha256: plan.sourceProcessSha256,
    sourceControlEventSha256: plan.sourceControlEventSha256,
    sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
    fromCheckpointSha256: plan.fromCheckpointSha256,
    childGenesisCheckpointSha256: genesis.checkpointSha256,
    childImportedCheckpointSha256: checkpoint.checkpointSha256,
    tasks, importedAt: plan.createdAt
  });
  current = await mutateSgosProcess(root, current.processId, async (draft) => {
    await putSgosImmutableRecord(root, current.processId, 'gvm-checkpoint', checkpoint,
      { reserveExisting: true });
    await putSgosImmutableRecord(
      root, current.processId, 'fork-prefix-import-receipt', importReceipt,
      { reserveExisting: true }
    );
    draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
  }, {
    expectedRevision: current.processRevision,
    expectedProcessSha256: current.processSha256,
    updatedAt: plan.createdAt
  });
  return Object.freeze({ child: current, checkpoint, importReceipt });
}

async function importForkPrefix(root, plan, parent, started, program) {
  const recovered = await recoverPendingSgosTransition(root, started.process.processId);
  let child = recovered.process;
  const genesis = await assertForkGenesisAncestor(root, plan, parent, child, program);
  assertForkImportBoundary(child, plan.prefixTasks);
  for (const entry of topologicalForkPrefix(program, plan.prefixTasks)) {
    child = await importForkPrefixTask(root, plan, child, program, entry);
  }
  return finalizeForkPrefixImport(root, plan, child, genesis.checkpoint);
}

async function validateCanonicalForkReceipt(root, plan, parent, receipt) {
  const prefix = plan.sourceEvidenceProjectionSha256 != null;
  if (receipt.parentProcessId !== plan.parentProcessId
      || receipt.parentProcessSha256 !== plan.expectedParentProcessSha256
      || receipt.fromCheckpointSha256 !== plan.fromCheckpointSha256
      || receipt.forkPlanSha256 !== plan.forkPlanSha256
      || receipt.childProcessId !== plan.childProcessId
      || !HASH.test(String(receipt.forkIntentSha256 ?? ''))
      || !HASH.test(String(receipt.childProcessSha256 ?? ''))
      || !HASH.test(String(receipt.childProcessBindingSha256 ?? ''))
      || !HASH.test(String(receipt.childGenesisCheckpointSha256 ?? ''))
      || !Number.isSafeInteger(receipt.childProcessRevision)
      || receipt.childProcessRevision < 3
      || (!prefix && receipt.childProcessRevision !== 3)
      || (prefix && (
        receipt.sourceEvidenceProjectionSha256 !== plan.sourceEvidenceProjectionSha256
        || receipt.sourceProcessSha256 !== plan.sourceProcessSha256
        || receipt.sourceControlEventSha256 !== plan.sourceControlEventSha256
        || receipt.sourceRecordIndexSha256 !== plan.sourceRecordIndexSha256
        || !HASH.test(String(receipt.childImportedCheckpointSha256 ?? ''))
        || !HASH.test(String(receipt.forkImportReceiptSha256 ?? ''))
      ))
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
  if (prefix) {
    const importedCheckpoint = (await readSgosCheckpoint(
      root, child.processId, receipt.childImportedCheckpointSha256
    )).record;
    const importRecord = (await readSgosImmutableRecord(
      root, child.processId, 'fork-prefix-import-receipt',
      receipt.forkImportReceiptSha256
    )).record;
    if (importRecord.forkPlanSha256 !== plan.forkPlanSha256
        || importRecord.parentProcessId !== plan.parentProcessId
        || importRecord.childProcessId !== child.processId
        || importRecord.childGenesisCheckpointSha256 !== genesis.checkpointSha256
        || importRecord.childImportedCheckpointSha256 !== importedCheckpoint.checkpointSha256
        || importedCheckpoint.priorCheckpointSha256 !== genesis.checkpointSha256) {
      fail('Canonical SGOS fork receipt has invalid prefix-import lineage.',
        'SGOS_LINEAGE_CORRUPT');
    }
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

async function forkSgosProcessWithinPolicy(root, processId, {
  confirmationSha256,
  clock = null
} = {}) {
  await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.fork', processId
  });
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
    const imported = plan.sourceEvidenceProjectionSha256 != null;
    const importReceipt = imported ? (await readSgosImmutableRecord(
      root, child.processId, 'fork-prefix-import-receipt',
      existingReceipt.forkImportReceiptSha256
    )).record : null;
    const checkpoint = imported ? (await readSgosCheckpoint(
      root, child.processId, existingReceipt.childImportedCheckpointSha256
    )).record : null;
    return Object.freeze({
      parent, child, plan, receipt: existingReceipt, created: false, recovered: true,
      ...(imported ? { imported: true, importReceipt, checkpoint } : {})
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
  const sourceCheckpoint = await checkpointInLineage(root, parent, plan.fromCheckpointSha256);
  if (plan.sourceEvidenceProjectionSha256 != null) {
    const currentPrefix = await buildForkPrefixPlan(
      root, parent, sourceCheckpoint, plan.childProcessId
    );
    const plannedPrefix = {
      sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
      sourceProcessSha256: plan.sourceProcessSha256,
      sourceProcessRevision: plan.sourceProcessRevision,
      sourceControlEventSha256: plan.sourceControlEventSha256,
      sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
      prefixTasks: plan.prefixTasks
    };
    if (canonicalJson(currentPrefix) !== canonicalJson(plannedPrefix)) {
      fail('Parent prefix evidence changed after fork preview; create a new exact plan.',
        'SGOS_FORK_PLAN_STALE');
    }
  }
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
  const startOptions = {
    program,
    taskContractSha256: parent.taskContractSha256,
    processId: plan.childProcessId,
    subject: plan.subject,
    // Fork genesis is a pure function of the previewed plan, not confirmation wall-clock time.
    clock: plan.createdAt
  };
  let started;
  try {
    started = await startSgosProcess(root, startOptions);
  } catch (error) {
    if (error?.code !== 'SGOS_TRANSITION_RECOVERED_RETRY') throw error;
    // A prior fork-import CAS can be fully durable while its caller only saw an interrupted state
    // publication. `start` owns exact transition recovery and deliberately asks ordinary callers
    // to retry. Fork apply is itself the confirmation-bound recovery operation, so repeat only
    // this idempotent start boundary once and then continue from its verified checkpoint.
    started = await startSgosProcess(root, startOptions);
  }
  void clock;
  const prefix = plan.sourceEvidenceProjectionSha256 == null
    ? null
    : await importForkPrefix(root, plan, parent, started, program);
  const genesis = prefix == null
    ? await assertExactForkGenesis(root, plan, parent, started, program)
    : await assertForkGenesisAncestor(root, plan, parent, prefix.child, program);
  const receiptChild = prefix?.child ?? started.process;
  const receipt = sealLineage('sgos-fork-receipt', 'forkReceiptSha256', {
    parentProcessId: processId,
    parentProcessSha256: plan.expectedParentProcessSha256,
    fromCheckpointSha256: plan.fromCheckpointSha256,
    forkPlanSha256: plan.forkPlanSha256,
    forkIntentSha256: intent.forkIntentSha256,
    childProcessId: receiptChild.processId,
    childProcessSha256: receiptChild.processSha256,
    childProcessBindingSha256: genesis.binding.bindingSha256,
    childGenesisCheckpointSha256: genesis.checkpoint.checkpointSha256,
    childProcessRevision: receiptChild.processRevision,
    ...(prefix == null ? {} : {
      sourceEvidenceProjectionSha256: plan.sourceEvidenceProjectionSha256,
      sourceProcessSha256: plan.sourceProcessSha256,
      sourceControlEventSha256: plan.sourceControlEventSha256,
      sourceRecordIndexSha256: plan.sourceRecordIndexSha256,
      childImportedCheckpointSha256: prefix.checkpoint.checkpointSha256,
      forkImportReceiptSha256: prefix.importReceipt.forkImportReceiptSha256
    }),
    forkedAt: plan.createdAt
  });
  await writeImmutable(root,
    canonicalLineagePath(root, processId, 'fork-receipts', plan.forkPlanSha256),
    receipt, 'forkReceiptSha256');
  return Object.freeze({
    parent, child: receiptChild, plan, receipt, created: started.created,
    ...(prefix == null ? {} : {
      imported: true, checkpoint: prefix.checkpoint, importReceipt: prefix.importReceipt
    })
  });
}

export async function forkSgosProcess(root, processId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'process.fork', processId
  }, () => forkSgosProcessWithinPolicy(root, processId, options));
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
  }),
  'task-retry-plans': Object.freeze({
    kind: 'sgos-task-retry-plan', hashField: 'retryPlanSha256', key: 'self'
  }),
  'task-retry-receipts': Object.freeze({
    kind: 'sgos-task-retry-receipt', hashField: 'retryReceiptSha256', key: 'retryPlanSha256'
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
        if (contract.key === 'retryPlanSha256' && record.retryPlanSha256 !== keyDigest) {
          fail('Canonical task retry receipt key does not match retryPlanSha256.',
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
  const retryPlans = new Map([...records.entries()]
    .filter(([identity]) => identity.startsWith('task-retry-plans\u0000'))
    .map(([, record]) => [record.retryPlanSha256, record]));
  const retryReceipts = new Map([...records.entries()]
    .filter(([identity]) => identity.startsWith('task-retry-receipts\u0000'))
    .map(([, record]) => [record.retryPlanSha256, record]));
  for (const [retryPlanSha256, plan] of retryPlans) {
    if (plan.processId !== processId
        || !HASH.test(String(plan.expectedProcessSha256 ?? ''))
        || !HASH.test(String(plan.programSha256 ?? ''))
        || !HASH.test(String(plan.policySnapshotSha256 ?? ''))
        || !HASH.test(String(plan.processBindingSha256 ?? ''))
        || !HASH.test(String(plan.checkpointSha256 ?? ''))
        || !HASH.test(String(plan.parentAttemptSha256 ?? ''))
        || !HASH.test(String(plan.parentEvidenceSha256 ?? ''))
        || typeof plan.taskInstanceId !== 'string'
        || typeof plan.taskTemplateId !== 'string'
        || typeof plan.parentAttemptId !== 'string'
        || typeof plan.expectedAttemptId !== 'string'
        || !Number.isSafeInteger(plan.expectedProcessRevision)
        || !Number.isSafeInteger(plan.attemptNumber)
        || !Number.isSafeInteger(plan.maximumAttempts)
        || plan.attemptNumber < 2 || plan.attemptNumber > plan.maximumAttempts
        || !['pure-or-read-only', 'verified-read-only-device']
          .includes(plan.effectClassification)
        || typeof plan.createdAt !== 'string') {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Task retry plan violates its exact bounded contract.',
        retryPlanSha256
      }));
    }
  }
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
    const expected = plan == null ? null : forkIntentFor(plan, {
      taskContractSha256: plan.taskContractSha256
    });
    if (!plan || canonicalJson(intent) !== canonicalJson(expected)) {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Fork intent is orphaned from its exact fork plan.', forkPlanSha256
      }));
    }
  }
  for (const [forkPlanSha256, receipt] of receipts) {
    const plan = plans.get(forkPlanSha256);
    const intent = intents.get(forkPlanSha256);
    const prefix = plan?.sourceEvidenceProjectionSha256 != null;
    const prefixMatches = !prefix
      ? [
        'sourceEvidenceProjectionSha256', 'sourceProcessSha256',
        'sourceControlEventSha256', 'sourceRecordIndexSha256',
        'childImportedCheckpointSha256', 'forkImportReceiptSha256'
      ].every((field) => receipt?.[field] == null)
      : receipt?.sourceEvidenceProjectionSha256 === plan.sourceEvidenceProjectionSha256
        && receipt?.sourceProcessSha256 === plan.sourceProcessSha256
        && receipt?.sourceControlEventSha256 === plan.sourceControlEventSha256
        && receipt?.sourceRecordIndexSha256 === plan.sourceRecordIndexSha256
        && HASH.test(String(receipt?.childImportedCheckpointSha256 ?? ''))
        && HASH.test(String(receipt?.forkImportReceiptSha256 ?? ''));
    if (!plan || !intent || receipt.parentProcessId !== processId
        || receipt.parentProcessSha256 !== plan.expectedParentProcessSha256
        || receipt.fromCheckpointSha256 !== plan.fromCheckpointSha256
        || receipt.forkPlanSha256 !== plan.forkPlanSha256
        || receipt.childProcessId !== plan.childProcessId
        || receipt.forkIntentSha256 !== intent.forkIntentSha256
        || receipt.childProcessBindingSha256 == null
        || receipt.childGenesisCheckpointSha256 == null
        || !prefixMatches
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
  for (const [retryPlanSha256, receipt] of retryReceipts) {
    const plan = retryPlans.get(retryPlanSha256);
    if (!plan || plan.processId !== processId || receipt.processId !== processId
        || receipt.taskInstanceId !== plan.taskInstanceId
        || receipt.parentAttemptId !== plan.parentAttemptId
        || receipt.attemptId !== plan.expectedAttemptId
        || !HASH.test(String(receipt.attemptSha256 ?? ''))
        || !['failed', 'succeeded', 'cancelled'].includes(receipt.attemptStatus)
        || typeof receipt.recordedAt !== 'string') {
      errors.push(Object.freeze({
        code: 'SGOS_LINEAGE_CORRUPT',
        message: 'Task retry receipt is orphaned from its exact retry plan.',
        retryPlanSha256
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
