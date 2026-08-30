/**
 * Exact, confirmation-bound retry of one ordinary failed task attempt.
 *
 * A normal pure/read-only failure is already projected as `ready` by the interpreter.  This
 * module does not manufacture a new mutable state or erase that failure.  It freezes the exact
 * retry boundary, then dispatches only that task through the ordinary runtime CAS.  The next
 * attempt therefore keeps the failed attempt as its immutable parent.
 *
 * Consequential Device retries are deliberately refused by this profile.  A verified effect is
 * evidence for reconciliation, not permission to create a different Tool Intent; an uncertain
 * effect is never repeatable.  Installing such a retry requires an adapter whose exact recovery
 * protocol can bind the new attempt to the original idempotency receipt.
 */
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { gitCommonDir } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { sha256 } from './contracts.mjs';
import { installedDeviceManifests } from './devices.mjs';
import { createSgosBuiltinAdapters } from './builtin-adapters.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import {
  assertCurrentStoredProcessBinding, runNextSgosTask
} from './runtime.mjs';
import {
  listSgosImmutableRecordsByField, readSgosProcess, readSgosProgram,
  recoverPendingSgosTransition
} from './store.mjs';
import {
  readPrivateSidecar, writeImmutablePrivateSidecar
} from './private-sidecar.mjs';
import {
  assertSgosProcessPolicyAuthority, withSgosProcessPolicyAuthority
} from './pinned-policy.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const PROCESS_ID = /^PROC-[A-Za-z0-9._:-]{6,127}$/;
const FORMAT = 'sflow.sgos.lineage';
const VERSION = 1;

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

function retryRoot(root, processId) {
  if (!PROCESS_ID.test(String(processId ?? ''))) {
    fail('Process ID is invalid.', 'SGOS_PROCESS_ID_INVALID', { processId });
  }
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'lineage', processId);
}

function retryPath(root, processId, category, digest) {
  if (!HASH.test(String(digest ?? ''))) {
    fail('Task retry digest is invalid.', 'SGOS_TASK_RETRY_PLAN_INVALID');
  }
  return path.join(retryRoot(root, processId), category, `${digest.slice(7)}.json`);
}

function seal(kind, hashField, value) {
  const core = {
    lineageFormat: FORMAT,
    lineageVersion: VERSION,
    kind,
    ...structuredClone(value)
  };
  delete core[hashField];
  return freezeDeep({ ...core, [hashField]: sha256(core) });
}

async function writeImmutable(root, target, record) {
  try {
    await writeImmutablePrivateSidecar(root, target, canonicalJson(record), {
      maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes
    });
  } catch (error) {
    if (error?.code !== 'SGOS_SIDECAR_RECORD_CONFLICT') throw error;
    fail('Immutable task retry lineage conflicts with existing bytes.',
      'SGOS_TASK_RETRY_LINEAGE_CONFLICT');
  }
  return record;
}

async function readExact(root, target, { kind, hashField, expectedDigest = null, optional = false }) {
  let raw;
  try {
    raw = await readPrivateSidecar(root, target, {
      maximumBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes,
      optional
    });
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (raw == null && optional) return null;
  let record;
  try { record = JSON.parse(raw.toString('utf8')); }
  catch (error) {
    fail(`Task retry lineage is not valid JSON: ${error.message}.`,
      'SGOS_TASK_RETRY_LINEAGE_CORRUPT');
  }
  const core = structuredClone(record);
  delete core[hashField];
  if (record.lineageFormat !== FORMAT || record.lineageVersion !== VERSION
      || record.kind !== kind || !HASH.test(String(record[hashField] ?? ''))
      || (expectedDigest != null && record[hashField] !== expectedDigest)
      || record[hashField] !== sha256(core)
      || canonicalJson(record) !== raw.toString('utf8')) {
    fail('Task retry lineage failed its exact content hash.',
      'SGOS_TASK_RETRY_LINEAGE_CORRUPT', { expectedDigest });
  }
  return freezeDeep(record);
}

function retryCeiling(program, template) {
  const taskMaximum = template.retry?.maximumAttempts
    ?? template.retryPolicy?.maximumAttempts ?? 1;
  const programMaximum = program.budgets?.maximumAttemptsPerTask
    ?? program.budgets?.maximumAttempts ?? SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask;
  return Math.min(taskMaximum, programMaximum, SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask);
}

function stableAttemptId(processId, taskInstanceId, attemptNumber) {
  return `ATT-${recordSha256({ processId, taskInstanceId, attemptNumber })
    .slice(0, 24).toUpperCase()}`;
}

function recoveryPolicy(template) {
  return template.recovery?.failedExecution
    ?? template.recovery?.interruptedExecution
    ?? null;
}

function effectSafety(template) {
  const resources = template.resources ?? {};
  const writes = [...(resources.writes ?? [])];
  const externalEffects = [...(resources.externalEffects ?? [])];
  const devices = [...(resources.devices ?? [])];
  const manifests = new Map(installedDeviceManifests().map((entry) => [entry.id, entry]));
  const readOnlyDevices = devices.length > 0 && devices.every((id) =>
    manifests.get(id)?.effects?.class === 'read-only');
  const safe = writes.length === 0 && externalEffects.length === 0
    && (devices.length === 0 || readOnlyDevices);
  return freezeDeep({
    safe,
    classification: safe
      ? devices.length ? 'verified-read-only-device' : 'pure-or-read-only'
      : devices.length ? 'device-effect-requires-exact-reconciliation' : 'writable-or-external-effect',
    writes,
    devices,
    externalEffects
  });
}

async function exactFailedAttempt(root, process, task) {
  const attemptId = task.attemptIds.at(-1);
  if (attemptId == null) {
    fail('Task retry requires one immutable prior attempt.', 'SGOS_TASK_RETRY_LINEAGE_INVALID');
  }
  const attempts = await listSgosImmutableRecordsByField(
    root, process.processId, 'gvm-task-attempt', 'attemptId', attemptId
  );
  const running = attempts.filter((entry) => entry.status === 'running');
  const terminal = attempts.filter((entry) => entry.status !== 'running');
  const evidence = await listSgosImmutableRecordsByField(
    root, process.processId, 'action-evidence', 'attemptId', attemptId
  );
  const receipts = await listSgosImmutableRecordsByField(
    root, process.processId, 'gvm-task-receipt', 'attemptId', attemptId
  );
  if (running.length !== 1 || terminal.length !== 1 || terminal[0].status !== 'failed'
      || evidence.length !== 1 || receipts.length !== 0
      || terminal[0].parentAttemptId !== (task.attemptIds.at(-2) ?? null)
      || terminal[0].attemptNumber !== task.attemptIds.length
      || terminal[0].taskInstanceId !== task.taskInstanceId
      || terminal[0].processId !== process.processId
      || evidence[0].attemptId !== attemptId
      || evidence[0].taskInstanceId !== task.taskInstanceId
      || evidence[0].processId !== process.processId
      || evidence[0].verification?.status !== 'failed') {
    fail('Task retry requires one exact running→failed attempt and its failed Action Evidence.',
      'SGOS_TASK_RETRY_LINEAGE_INVALID', {
        attemptId, running: running.length, terminal: terminal.length,
        evidence: evidence.length, receipts: receipts.length
      });
  }
  return freezeDeep({ attemptId, running: running[0], terminal: terminal[0], evidence: evidence[0] });
}

async function retryBoundary(root, processId, taskInstanceId) {
  const process = (await recoverPendingSgosTransition(root, processId)).process;
  if (process.activeExecutions.length || process.activeLeases.length
      || process.openHumanRequests.length) {
    fail('Task retry requires a quiescent Process with no open Human Request.',
      'SGOS_TASK_RETRY_NOT_QUIESCENT', { status: process.status });
  }
  await assertCurrentStoredProcessBinding(root, process);
  const program = (await readSgosProgram(root, processId, process.programSha256)).record;
  const task = process.taskInstances?.[taskInstanceId];
  if (!task) {
    fail(`Task '${taskInstanceId}' does not belong to Process '${processId}'.`,
      'SGOS_TASK_NOT_FOUND', { processId, taskInstanceId });
  }
  const template = program.taskTemplates.find((entry) =>
    entry.taskTemplateId === task.taskTemplateId);
  if (!template) {
    fail('Task template is missing from the immutable Program.', 'SGOS_TASK_RETRY_LINEAGE_INVALID');
  }
  const maximumAttempts = retryCeiling(program, template);
  if (task.attemptIds.length >= maximumAttempts) {
    fail(`Task '${taskInstanceId}' exhausted its ${maximumAttempts} governed attempt(s).`,
      'SGOS_TASK_RETRY_ATTEMPTS_EXHAUSTED', {
        attempts: task.attemptIds.length, maximumAttempts
      });
  }
  const policy = recoveryPolicy(template);
  if (policy !== 'retry-safe') {
    fail('Task recovery policy does not explicitly classify retry as safe.',
      'SGOS_TASK_RETRY_POLICY_UNSAFE', { recoveryPolicy: policy });
  }
  const effects = effectSafety(template);
  if (!effects.safe) {
    fail('Task effects cannot be repeated by the installed ordinary-retry profile.',
      'SGOS_TASK_RETRY_EFFECT_UNSAFE', {
        ...effects,
        remediation: effects.devices.length
          ? 'Reconcile the exact original Tool Intent/Result; do not create a new Device attempt.'
          : 'Use an effect-specific idempotency and reconciliation policy.'
      });
  }
  if (process.status !== 'running' || task.state !== 'ready') {
    fail(`Task '${taskInstanceId}' is '${task.state}', not retry-ready.`,
      'SGOS_TASK_RETRY_NOT_READY', {
        taskInstanceId, taskState: task.state, processStatus: process.status
      });
  }
  const prior = await exactFailedAttempt(root, process, task);
  return freezeDeep({ process, program, task, template, maximumAttempts, effects, prior });
}

async function planWithinPolicy(root, processId, taskInstanceId, { createdAt = nowIso() } = {}) {
  await assertSgosProcessPolicyAuthority(root, {
    operation: 'task.retry.plan', processId
  });
  const boundary = await retryBoundary(root, processId, taskInstanceId);
  const attemptNumber = boundary.task.attemptIds.length + 1;
  const plan = seal('sgos-task-retry-plan', 'retryPlanSha256', {
    processId,
    taskInstanceId,
    taskTemplateId: boundary.task.taskTemplateId,
    expectedProcessRevision: boundary.process.processRevision,
    expectedProcessSha256: boundary.process.processSha256,
    programSha256: boundary.process.programSha256,
    policySnapshotSha256: boundary.process.policySnapshotSha256,
    processBindingSha256: boundary.process.processBindingSha256,
    checkpointSha256: boundary.process.currentCheckpointSha256,
    parentAttemptId: boundary.prior.attemptId,
    parentAttemptSha256: boundary.prior.terminal.attemptSha256,
    parentEvidenceSha256: boundary.prior.evidence.evidenceSha256,
    attemptNumber,
    expectedAttemptId: stableAttemptId(processId, taskInstanceId, attemptNumber),
    maximumAttempts: boundary.maximumAttempts,
    effectClassification: boundary.effects.classification,
    createdAt
  });
  await writeImmutable(root,
    retryPath(root, processId, 'task-retry-plans', plan.retryPlanSha256), plan);
  return plan;
}

export async function planSgosTaskRetry(root, processId, taskInstanceId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'task.retry.plan', processId
  }, () => planWithinPolicy(root, processId, taskInstanceId, options));
}

async function readPlan(root, processId, digest) {
  return readExact(root, retryPath(root, processId, 'task-retry-plans', digest), {
    kind: 'sgos-task-retry-plan', hashField: 'retryPlanSha256', expectedDigest: digest
  });
}

async function readReceipt(root, processId, planSha256) {
  return readExact(root,
    retryPath(root, processId, 'task-retry-receipts', planSha256), {
      kind: 'sgos-task-retry-receipt', hashField: 'retryReceiptSha256', optional: true
    });
}

async function recoverAppliedRetry(root, process, plan) {
  const task = process.taskInstances?.[plan.taskInstanceId];
  if (!task || task.attemptIds[plan.attemptNumber - 1] !== plan.expectedAttemptId
      || task.attemptIds[plan.attemptNumber - 2] !== plan.parentAttemptId) return null;
  const attempts = await listSgosImmutableRecordsByField(
    root, process.processId, 'gvm-task-attempt', 'attemptId', plan.expectedAttemptId
  );
  const running = attempts.filter((entry) => entry.status === 'running');
  const terminal = attempts.filter((entry) => entry.status !== 'running');
  if (running.length !== 1 || terminal.length > 1) {
    fail('Retry attempt lineage is ambiguous.', 'SGOS_TASK_RETRY_LINEAGE_INVALID', {
      attemptId: plan.expectedAttemptId
    });
  }
  const selected = terminal[0] ?? running[0];
  if (selected.parentAttemptId !== plan.parentAttemptId
      || selected.attemptNumber !== plan.attemptNumber
      || selected.taskInstanceId !== plan.taskInstanceId
      || selected.processId !== plan.processId) {
    fail('Retry attempt does not descend from the confirmed failed attempt.',
      'SGOS_TASK_RETRY_LINEAGE_INVALID');
  }
  return freezeDeep({ task, attempt: selected, inProgress: terminal.length === 0 });
}

function retryReceipt(plan, process, applied) {
  void process;
  return seal('sgos-task-retry-receipt', 'retryReceiptSha256', {
    retryPlanSha256: plan.retryPlanSha256,
    processId: plan.processId,
    taskInstanceId: plan.taskInstanceId,
    parentAttemptId: plan.parentAttemptId,
    attemptId: plan.expectedAttemptId,
    attemptSha256: applied.attempt.attemptSha256,
    attemptStatus: applied.attempt.status,
    recordedAt: applied.attempt.completedAt ?? applied.attempt.startedAt
  });
}

async function retryWithinPolicy(root, processId, taskInstanceId, {
  confirmationSha256,
  ...runtimeOptions
} = {}) {
  await assertSgosProcessPolicyAuthority(root, { operation: 'task.retry', processId });
  if (!HASH.test(String(confirmationSha256 ?? ''))) {
    fail('Task retry requires an exact retry-plan confirmation.',
      'SGOS_TASK_RETRY_CONFIRMATION_REQUIRED');
  }
  const plan = await readPlan(root, processId, confirmationSha256);
  if (plan.processId !== processId || plan.taskInstanceId !== taskInstanceId) {
    fail('Task retry plan belongs to another Process or task.', 'SGOS_TASK_RETRY_PLAN_INVALID');
  }
  let process = (await recoverPendingSgosTransition(root, processId)).process;
  const existingReceipt = await readReceipt(root, processId, plan.retryPlanSha256);
  if (existingReceipt != null) {
    if (existingReceipt.retryPlanSha256 !== plan.retryPlanSha256
        || existingReceipt.processId !== processId
        || existingReceipt.taskInstanceId !== taskInstanceId
        || existingReceipt.attemptId !== plan.expectedAttemptId
        || existingReceipt.parentAttemptId !== plan.parentAttemptId) {
      fail('Task retry receipt is not bound to its confirmed plan.',
        'SGOS_TASK_RETRY_LINEAGE_CORRUPT');
    }
    const applied = await recoverAppliedRetry(root, process, plan);
    if (applied == null || applied.attempt.attemptSha256 !== existingReceipt.attemptSha256) {
      fail('Task retry receipt no longer has its exact immutable attempt.',
        'SGOS_TASK_RETRY_LINEAGE_CORRUPT');
    }
    return freezeDeep({ process, plan, receipt: existingReceipt, recovered: true });
  }
  const appliedBefore = await recoverAppliedRetry(root, process, plan);
  if (appliedBefore?.inProgress) {
    fail('The confirmed retry attempt is still executing.', 'SGOS_TASK_RETRY_IN_PROGRESS', {
      attemptId: plan.expectedAttemptId
    });
  }
  if (appliedBefore != null) {
    const receipt = retryReceipt(plan, process, appliedBefore);
    await writeImmutable(root,
      retryPath(root, processId, 'task-retry-receipts', plan.retryPlanSha256), receipt);
    return freezeDeep({ process, plan, receipt, recovered: true });
  }
  if (process.processRevision !== plan.expectedProcessRevision
      || process.processSha256 !== plan.expectedProcessSha256
      || process.programSha256 !== plan.programSha256
      || process.policySnapshotSha256 !== plan.policySnapshotSha256
      || process.processBindingSha256 !== plan.processBindingSha256
      || process.currentCheckpointSha256 !== plan.checkpointSha256) {
    fail('Process changed after task retry preview; create a new exact plan.',
      'SGOS_TASK_RETRY_PLAN_STALE', {
        expectedRevision: plan.expectedProcessRevision,
        actualRevision: process.processRevision
      });
  }
  const boundary = await retryBoundary(root, processId, taskInstanceId);
  if (boundary.prior.attemptId !== plan.parentAttemptId
      || boundary.prior.terminal.attemptSha256 !== plan.parentAttemptSha256
      || boundary.prior.evidence.evidenceSha256 !== plan.parentEvidenceSha256
      || boundary.maximumAttempts !== plan.maximumAttempts
      || boundary.effects.classification !== plan.effectClassification) {
    fail('Task retry evidence or policy changed after preview.', 'SGOS_TASK_RETRY_PLAN_STALE');
  }
  const result = await runNextSgosTask(root, processId, {
    ...runtimeOptions,
    expectedRevision: plan.expectedProcessRevision,
    preferredTaskInstanceId: taskInstanceId
  });
  if (result.taskInstanceId !== taskInstanceId
      || ['not-ready', 'unavailable', 'blocked'].includes(result.status)) {
    fail('Confirmed task retry did not dispatch the exact planned task.',
      'SGOS_TASK_RETRY_NOT_DISPATCHED', {
        status: result.status, taskInstanceId: result.taskInstanceId
      });
  }
  process = await readSgosProcess(root, processId);
  const applied = await recoverAppliedRetry(root, process, plan);
  if (applied == null || applied.inProgress) {
    fail('Retry dispatch ended without one exact terminal child attempt.',
      'SGOS_TASK_RETRY_LINEAGE_INVALID', { attemptId: plan.expectedAttemptId });
  }
  const receipt = retryReceipt(plan, process, applied);
  await writeImmutable(root,
    retryPath(root, processId, 'task-retry-receipts', plan.retryPlanSha256), receipt);
  return freezeDeep({ ...result, process, plan, receipt, recovered: false });
}

/**
 * Internal interpreter entry point. Public callers must use the closed runtime wrapper/CLI so raw
 * handlers cannot become an authority injection seam.
 */
export async function retrySgosTask(root, processId, taskInstanceId, options = {}) {
  return withSgosProcessPolicyAuthority(root, {
    operation: 'task.retry', processId
  }, () => retryWithinPolicy(root, processId, taskInstanceId, options));
}

/** Public closed-vocabulary retry entry point; no raw handler or clock injection is accepted. */
export async function retrySgosTaskWithInstalledAdapters(
  root, processId, taskInstanceId, options = {}
) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)
      || utilTypes.isProxy(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    fail('Public task retry options must be a plain object.', 'SGOS_PUBLIC_OPTIONS_INVALID');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const unexpected = Reflect.ownKeys(options).filter((key) =>
    typeof key !== 'string' || key !== 'confirmationSha256');
  if (unexpected.length) {
    fail('Public task retry accepts only confirmationSha256.', 'SGOS_PUBLIC_OPTIONS_INVALID', {
      unexpected: unexpected.map(String).sort()
    });
  }
  const descriptor = descriptors.confirmationSha256;
  if (descriptor != null && (!Object.hasOwn(descriptor, 'value')
      || typeof descriptor.get === 'function' || typeof descriptor.set === 'function')) {
    fail('Public task retry options cannot contain accessors.',
      'SGOS_PUBLIC_OPTIONS_INVALID');
  }
  return retrySgosTask(root, processId, taskInstanceId, {
    confirmationSha256: descriptor?.value,
    ...createSgosBuiltinAdapters(root)
  });
}
