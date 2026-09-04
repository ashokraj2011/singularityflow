/** GDP-M7 binding over the existing durable SGOS process/checkpoint/control runtime. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { validateDeliveryRecord } from './delivery-kernel.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIONS = new Set(['pause', 'halt', 'narrow']);
const PROCESS_STATUSES = new Set([
  'queued', 'running', 'waiting-human', 'blocked', 'paused', 'succeeded', 'failed',
  'cancelled', 'recovery-required'
]);
const FAMILIES = Object.freeze({
  'agent-execution-binding': ['bindingSha256', [
    'schemaVersion', 'kind', 'workId', 'deliverySelectionSha256',
    'completionContractSha256', 'processId', 'processRevision', 'programSha256',
    'policySnapshotSha256', 'candidateSha256', 'executionUnitManifestSha256',
    'sourceProcessSha256', 'runtime', 'status', 'gaps', 'bindingSha256'
  ]],
  'agent-execution-checkpoint': ['executionCheckpointSha256', [
    'schemaVersion', 'kind', 'workId', 'bindingSha256', 'processId',
    'processRevision', 'processStatus', 'checkpointSha256', 'sourceCheckpointSha256',
    'activeExecutionRefs', 'quiescent', 'recoveryRequired', 'status', 'gaps',
    'executionCheckpointSha256'
  ]],
  'agent-steering-decision': ['steeringDecisionSha256', [
    'schemaVersion', 'kind', 'workId', 'bindingSha256', 'processId',
    'priorCheckpointSha256', 'action', 'sourceControlEventSha256', 'requestedBy',
    'reasonSha256', 'status', 'steeringDecisionSha256'
  ]]
});

function fail(message, code = 'GDM_EXECUTION_BINDING_INVALID') {
  const error = new TypeError(`GDP execution bridge: ${message}`);
  error.code = code;
  throw error;
}
function digest(value) { return `sha256:${recordSha256(value)}`; }
function exact(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}
function bounded(value, label) {
  const text = String(value ?? '');
  if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/u.test(text)) fail(`${label} is invalid.`);
  return text;
}
function seal(family, fields) {
  const [hashField] = FAMILIES[family];
  const core = { schemaVersion: currentSchemaVersion(family), kind: family, ...fields };
  return Object.freeze({ ...core, [hashField]: digest(core) });
}
function shaList(values, label) {
  if (!Array.isArray(values) || values.length > 256) fail(`${label} exceeds its bound.`);
  return [...new Set(values.map((value) => exact(value, label)))].sort();
}

export function buildAgentExecutionBinding({
  workId, selection, completionContract, process, executionUnitManifestSha256 = null
} = {}) {
  validateDeliveryRecord('delivery-selection', selection);
  validateDeliveryRecord('completion-contract', completionContract);
  const id = bounded(workId, 'workId');
  if (selection.workId !== id || completionContract.subject.id !== id) {
    fail('delivery records belong to another Work ID.');
  }
  if (!process || typeof process !== 'object' || Array.isArray(process)) fail('process is required.');
  if (process.authorityBinding?.subjectId && process.authorityBinding.subjectId !== id) {
    fail('SGOS Process belongs to another governed subject.');
  }
  if (!PROCESS_STATUSES.has(process.status)) fail(`process status '${process.status}' is unsupported.`);
  const gaps = [];
  const candidateSha256 = exact(
    process.candidate?.candidateSha256 ?? process.candidateSha256, 'candidateSha256', true
  );
  const manifest = exact(executionUnitManifestSha256, 'executionUnitManifestSha256', true);
  if (!candidateSha256) gaps.push('CANDIDATE_UNAVAILABLE');
  if (!manifest) gaps.push('EXECUTION_UNIT_MANIFEST_UNAVAILABLE');
  return seal('agent-execution-binding', {
    workId: id, deliverySelectionSha256: selection.selectionSha256,
    completionContractSha256: completionContract.contractSha256,
    processId: bounded(process.processId, 'processId'),
    processRevision: Number.isSafeInteger(process.revision) && process.revision >= 0 ? process.revision : 0,
    programSha256: exact(process.programSha256, 'programSha256'),
    policySnapshotSha256: exact(process.policySnapshotSha256, 'policySnapshotSha256'),
    candidateSha256, executionUnitManifestSha256: manifest,
    sourceProcessSha256: digest(process), runtime: 'sgos-durable-v2-bridge',
    status: gaps.length ? 'partial' : 'bound', gaps
  });
}

export function buildAgentExecutionCheckpoint({ binding, process, checkpoint = null } = {}) {
  validateExecutionBridgeRecord('agent-execution-binding', binding);
  if (process.processId !== binding.processId) fail('checkpoint Process differs from its binding.');
  const current = exact(process.currentCheckpointSha256, 'currentCheckpointSha256', true);
  const source = checkpoint == null ? null : digest(checkpoint);
  const gaps = [];
  if (!current || !checkpoint) gaps.push('SGOS_CHECKPOINT_UNAVAILABLE');
  if (checkpoint?.checkpointSha256 && current !== checkpoint.checkpointSha256) {
    fail('SGOS checkpoint is not the current Process checkpoint.', 'GDM_EXECUTION_CHECKPOINT_STALE');
  }
  const activeExecutionRefs = shaList((process.activeExecutions ?? []).map((entry) => (
    typeof entry === 'string' && DIGEST.test(entry) ? entry : digest(entry)
  )), 'activeExecutionRefs');
  const quiescent = activeExecutionRefs.length === 0;
  const recoveryRequired = process.status === 'recovery-required';
  return seal('agent-execution-checkpoint', {
    workId: binding.workId, bindingSha256: binding.bindingSha256,
    processId: binding.processId,
    processRevision: Number.isSafeInteger(process.revision) && process.revision >= 0 ? process.revision : 0,
    processStatus: process.status, checkpointSha256: current,
    sourceCheckpointSha256: source, activeExecutionRefs, quiescent, recoveryRequired,
    status: recoveryRequired ? 'recovery-required' : current ? 'observed' : 'unavailable', gaps
  });
}

export function buildAgentSteeringDecision({
  binding, priorCheckpointSha256, action, sourceControlEventSha256, requestedBy,
  reasonSha256, status = 'recorded'
} = {}) {
  validateExecutionBridgeRecord('agent-execution-binding', binding);
  if (!ACTIONS.has(action)) fail(`steering action '${action}' is unsupported.`);
  const actor = {
    kind: requestedBy?.kind,
    identity: requestedBy?.identity == null ? null : bounded(requestedBy.identity, 'requestedBy.identity'),
    authoritySha256: exact(requestedBy?.authoritySha256, 'requestedBy.authoritySha256', true)
  };
  if (!['human', 'policy'].includes(actor.kind)
      || (actor.kind === 'human' && !actor.identity)
      || (actor.kind === 'policy' && !actor.authoritySha256)) fail('requestedBy is invalid.');
  if (status !== 'recorded') fail('Only already-recorded SGOS control events can be bridged.');
  return seal('agent-steering-decision', {
    workId: binding.workId, bindingSha256: binding.bindingSha256,
    processId: binding.processId,
    priorCheckpointSha256: exact(priorCheckpointSha256, 'priorCheckpointSha256'), action,
    sourceControlEventSha256: exact(sourceControlEventSha256, 'sourceControlEventSha256'),
    requestedBy: actor, reasonSha256: exact(reasonSha256, 'reasonSha256'), status
  });
}

export function validateExecutionBridgeRecord(family, value) {
  const descriptor = FAMILIES[family];
  if (!descriptor) fail(`unknown record family '${family}'.`);
  if (canonicalJson(Object.keys(value ?? {}).sort()) !== canonicalJson([...descriptor[1]].sort())) {
    fail(`${family} has an invalid field set.`);
  }
  const readable = readRecord(family, value);
  if (readable.migratedThrough.length || value.kind !== family) fail(`${family} is not current.`);
  const core = structuredClone(value); delete core[descriptor[0]];
  if (value[descriptor[0]] !== digest(core)) fail(`${family} self hash is invalid.`);
  return Object.freeze(structuredClone(value));
}

export const M7_RECORD_FAMILIES = FAMILIES;
