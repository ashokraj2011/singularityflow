/** Deterministic receipts and trace-to-evidence records for the sequential SGOS slice. */
import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function clone(value) {
  return structuredClone(value);
}

export function sgosSha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function referenceOrHash(value) {
  if (value == null) return null;
  if (typeof value === 'string' && SHA256.test(value)) return value;
  return sgosSha256(value);
}

function normalizedRefs(values = []) {
  const unique = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const reference = typeof value === 'string' && value.trim() ? value : sgosSha256(value);
    unique.add(reference);
  }
  return [...unique].sort();
}

function normalizedVerification(value = { status: 'unavailable' }) {
  const status = ['passed', 'failed', 'unavailable'].includes(value?.status) ? value.status : 'unavailable';
  const details = clone(value ?? {});
  delete details.status;
  const checksSha256 = value?.checksSha256
    ?? (Object.keys(details).length ? sgosSha256(details) : null);
  return checksSha256 == null ? { status } : { status, checksSha256 };
}

function seal(familyId, hashField, value) {
  const core = clone(value ?? {});
  delete core[hashField];
  core.schemaVersion = currentSchemaVersion(familyId);
  return Object.freeze({ ...core, [hashField]: sgosSha256(core) });
}

export function buildSgosTaskAttempt({
  attemptId,
  processId,
  taskInstanceId,
  attemptNumber,
  parentAttemptId = null,
  reason = 'initial',
  taskContractSha256,
  executionHandleSha256 = null,
  status,
  startedAt = null,
  completedAt = null
} = {}) {
  if (!attemptId || !processId || !taskInstanceId || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
    fail('A Task Attempt requires stable attempt/task IDs and a positive attemptNumber.', 'SGOS_ATTEMPT_INVALID');
  }
  if (!SHA256.test(String(taskContractSha256 ?? ''))) {
    fail('A Task Attempt must bind an exact Task Contract.', 'SGOS_ATTEMPT_INVALID');
  }
  return seal('gvm-task-attempt', 'attemptSha256', {
    schemaVersion: currentSchemaVersion('gvm-task-attempt'),
    kind: 'gvm-task-attempt',
    attemptId,
    processId,
    taskInstanceId,
    attemptNumber,
    parentAttemptId,
    reason,
    taskContractSha256,
    executionHandleSha256,
    status,
    startedAt,
    completedAt
  });
}

/**
 * Build the only record that can authorize a task's `succeeded` transition.
 * A successful handler return is deliberately insufficient: verification must explicitly pass.
 */
export function buildSgosTaskReceipt({
  processId,
  taskInstanceId,
  attemptId,
  attemptSha256,
  inputRefs = [],
  outputRefs = [],
  candidateSha256 = null,
  candidate = null,
  evidenceRefs = [],
  effectRefs = [],
  humanDecisionRefs = [],
  verification,
  completedAt = null
} = {}) {
  if (!processId || !taskInstanceId || !attemptId
      || !SHA256.test(String(attemptSha256 ?? ''))) {
    fail('A Task Receipt requires process, task, and exact terminal-attempt identity.', 'SGOS_RECEIPT_INVALID');
  }
  if (verification?.status !== 'passed') {
    fail('A task cannot receive a success receipt until deterministic verification passes.', 'SGOS_RECEIPT_VERIFICATION_REQUIRED');
  }
  const candidateRef = candidateSha256 ?? referenceOrHash(candidate ?? {
    processId, taskInstanceId, attemptId, outputRefs: normalizedRefs(outputRefs)
  });
  if (!SHA256.test(String(candidateRef ?? ''))) fail('A Task Receipt requires an exact candidate hash.', 'SGOS_RECEIPT_INVALID');
  return seal('gvm-task-receipt', 'receiptSha256', {
    schemaVersion: currentSchemaVersion('gvm-task-receipt'),
    kind: 'gvm-task-receipt',
    processId,
    taskInstanceId,
    attemptId,
    attemptSha256,
    inputRefs: normalizedRefs(inputRefs),
    outputRefs: normalizedRefs(outputRefs),
    candidateSha256: candidateRef,
    evidenceRefs: normalizedRefs(evidenceRefs),
    effectRefs: normalizedRefs(effectRefs),
    humanDecisionRefs: normalizedRefs(humanDecisionRefs),
    verification: normalizedVerification(verification),
    completedAt: completedAt ?? nowIso()
  });
}

export function verifySgosTaskReceipt(receipt, {
  processId = null,
  taskInstanceId = null,
  attemptId = null
} = {}) {
  if (receipt?.kind !== 'gvm-task-receipt'
      || receipt.verification?.status !== 'passed'
      || !SHA256.test(String(receipt.receiptSha256 ?? ''))) return false;
  try { readRecord('gvm-task-receipt', receipt); } catch { return false; }
  const core = clone(receipt);
  delete core.receiptSha256;
  if (receipt.receiptSha256 !== sgosSha256(core)) return false;
  if (processId != null && receipt.processId !== processId) return false;
  if (taskInstanceId != null && receipt.taskInstanceId !== taskInstanceId) return false;
  if (attemptId != null && receipt.attemptId !== attemptId) return false;
  return true;
}

function gap(code, field) {
  return `${code}:${field}`;
}

function missingGap(gaps, field, observed) {
  if (!observed) gaps.push(gap(
    `${field.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-unavailable`, field
  ));
}

/**
 * Compile one action's trace without converting unknowns into success.  Missing observations and
 * contradictions remain first-class, hash-bound fields in the evidence record.
 */
export function compileSgosActionEvidence({
  processId = null,
  taskInstanceId = null,
  attemptId = null,
  principal = null,
  delegation = null,
  programSha256 = null,
  taskContractSha256 = null,
  executionUnitManifest = null,
  deviceManifest = null,
  arguments: actionArguments = null,
  preState = null,
  rawResult = null,
  postState = null,
  verification = { status: 'unavailable' },
  cost = null,
  latencyMs = 0,
  evidenceRefs = [],
  effectRefs = [],
  humanDecisionRefs = [],
  executionEvents = null,
  requiresExecutionUnit = false,
  requiresDevice = false,
  createdAt = null
} = {}) {
  const unavailable = (field) => sgosSha256({ status: 'unavailable', field });
  const observed = {
    principalSha256: referenceOrHash(principal),
    delegationSha256: referenceOrHash(delegation),
    programSha256,
    taskContractSha256,
    executionUnitManifestSha256: referenceOrHash(executionUnitManifest),
    deviceManifestSha256: referenceOrHash(deviceManifest),
    argumentsSha256: referenceOrHash(actionArguments),
    preStateSha256: referenceOrHash(preState),
    rawResultSha256: referenceOrHash(rawResult),
    postStateSha256: referenceOrHash(postState)
  };
  const principalSha256 = observed.principalSha256 ?? unavailable('principalSha256');
  const delegationSha256 = observed.delegationSha256 ?? unavailable('delegationSha256');
  const executionUnitManifestSha256 = observed.executionUnitManifestSha256 ?? unavailable('executionUnitManifestSha256');
  const deviceManifestSha256 = observed.deviceManifestSha256 ?? unavailable('deviceManifestSha256');
  const argumentsSha256 = observed.argumentsSha256 ?? unavailable('argumentsSha256');
  const preStateSha256 = observed.preStateSha256 ?? unavailable('preStateSha256');
  const rawResultSha256 = observed.rawResultSha256 ?? unavailable('rawResultSha256');
  const postStateSha256 = observed.postStateSha256 ?? unavailable('postStateSha256');
  const boundProgramSha256 = programSha256 ?? unavailable('programSha256');
  const boundTaskContractSha256 = taskContractSha256 ?? unavailable('taskContractSha256');
  const gaps = [];
  const contradictions = [];

  for (const field of ['principalSha256', 'delegationSha256', 'programSha256', 'taskContractSha256', 'argumentsSha256', 'preStateSha256', 'rawResultSha256', 'postStateSha256']) {
    missingGap(gaps, field, observed[field]);
  }
  if (requiresExecutionUnit && observed.executionUnitManifestSha256 == null) {
    gaps.push(gap('execution-unit-manifest-unavailable', 'executionUnitManifestSha256'));
  }
  if ((requiresDevice || effectRefs.length) && observed.deviceManifestSha256 == null) {
    gaps.push(gap('device-manifest-unavailable', 'deviceManifestSha256'));
  }
  if (executionEvents == null) {
    gaps.push(gap('execution-events-unavailable', 'executionEvents'));
  } else {
    const sequences = executionEvents.map((event) => event?.sequence).filter(Number.isInteger).sort((a, b) => a - b);
    for (let index = 1; index < sequences.length; index += 1) {
      if (sequences[index] !== sequences[index - 1] + 1) {
        gaps.push(`execution-event-gap:${sequences[index - 1]}-${sequences[index]}`);
      }
    }
  }
  if (cost == null || (cost.amount == null && cost.status == null)) {
    gaps.push(gap('cost-unavailable', 'cost'));
  }
  if ((rawResult?.claimedComplete === true || rawResult?.status === 'completed')
      && verification?.status !== 'passed') {
    contradictions.push(`completion-claim-not-verified:${verification?.status ?? 'unavailable'}`);
  }
  if (rawResult?.toolResults && !rawResult?.toolIntents) {
    contradictions.push(`tool-result-without-intent:${rawResult.toolResults.length}`);
  }
  if (preStateSha256 && postStateSha256 && preStateSha256 !== postStateSha256
      && rawResult?.observedWrites === false) {
    contradictions.push('state-changed-with-no-observed-write');
  }

  return seal('action-evidence', 'evidenceSha256', {
    schemaVersion: currentSchemaVersion('action-evidence'),
    kind: 'action-evidence',
    processId,
    taskInstanceId,
    attemptId,
    principalSha256,
    delegationSha256,
    programSha256: boundProgramSha256,
    taskContractSha256: boundTaskContractSha256,
    executionUnitManifestSha256,
    deviceManifestSha256,
    argumentsSha256,
    preStateSha256,
    rawResultSha256,
    postStateSha256,
    verification: normalizedVerification(verification),
    cost: clone(cost ?? { status: 'unavailable', amount: null }),
    latencyMs: Math.max(0, Math.trunc(Number.isFinite(latencyMs) ? latencyMs : 0)),
    evidenceRefs: normalizedRefs(evidenceRefs),
    effectRefs: normalizedRefs(effectRefs),
    humanDecisionRefs: normalizedRefs(humanDecisionRefs),
    gaps,
    contradictions,
    createdAt: createdAt ?? nowIso()
  });
}
