/**
 * A deliberately small, sequential SGOS interpreter over compiler-produced GVM Programs.
 *
 * The interpreter is structurally coupled only to the public Program IR fields emitted by
 * `sgos/compiler.mjs`.  It never imports compiler implementation details and never writes Story
 * authority: KERNEL handlers must use the existing governed kernel for any lifecycle mutation.
 */
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { head } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import {
  createCandidateSnapshot,
  createFanoutExpansionReceipt,
  createJoinReceipt,
  createResourceLease,
  validateCandidateSnapshot,
  validateGvmProgram,
  validateProcessBinding
} from './contracts.mjs';
import {
  buildSgosTaskAttempt,
  buildSgosTaskReceipt,
  compileSgosActionEvidence,
  sgosSha256
} from './evidence.mjs';
import {
  buildSgosProcessBinding,
  consumeRootedSgosRecordReservations,
  createSgosProcess,
  listSgosProcesses,
  listSgosImmutableRecordsByField,
  mutateSgosProcess,
  putSgosImmutableRecord,
  readSgosExecutionLease,
  readSgosCheckpoint,
  readSgosImmutableRecord,
  readSgosProcess,
  readSgosProgram,
  readSgosPendingReservedRecordByField,
  recoverPendingSgosTransition,
  reconcileSgosExecutionLeases,
  sealSgosImmutableRecord,
  sgosProcessDirectory,
  removeSgosExecutionLease,
  removeSgosExecutionLeaseIfUnreferenced,
  currentSgosExecutionOwnerFingerprint,
  isSgosExecutionOwnerLive,
  registerSgosExecutionOwner,
  unregisterSgosExecutionOwner,
  writeSgosExecutionLease
} from './store.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import {
  assertSgosProcessMaterialization, taskInstancesForSgosProgram
} from './materialization.mjs';
import {
  currentSgosHumanActor, loadApprovedSgosHumanAuthorityContext
} from './human-authority.mjs';
import {
  assertSgosProgramExecutionAdmission, loadApprovedSgosProgramAuthority,
  assertSgosInstalledProgramLimits, validateSgosProgramStaticSafety
} from './program-trust.mjs';
import {
  assertSgosStoryAuthority, loadSgosStoryAuthority
} from './story-authority.mjs';
import { createSgosBuiltinAdapters } from './builtin-adapters.mjs';
import {
  canonicalSgosResourceEntries
} from './resource-contracts.mjs';
import {
  deterministicSgosDispatchPlan, sgosTaskReadiness
} from './scheduler.mjs';
import { isSgosTerminalTaskState, sgosJoinForTask } from './joins.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RECORD_RESERVATION_BY_RECORD = new WeakMap();

function reservationOf(record) {
  return record != null && typeof record === 'object'
    ? RECORD_RESERVATION_BY_RECORD.get(record) ?? null
    : null;
}
const HUMAN_REQUEST_TYPES = new Set([
  'clarification', 'approval', 'credential', 'exception', 'policy-choice',
  'conflict-resolution', 'interpretation', 'evidence-review', 'scope-expansion',
  'production-authority', 'scientific-judgment', 'legal-judgment'
]);
const HUMAN_DECISIONS = new Set(['approved', 'rejected', 'selected', 'provided', 'cancelled']);
const SUCCESS_PREDECESSOR_STATES = new Set(['succeeded']);
const PROCESS_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const SUBJECT_KINDS = new Set(['story', 'repository']);
const SUPPORTED_PROGRAM_OPCODES = new Set([
  'NOOP', 'KERNEL', 'VERIFY', 'HUMAN_REQUEST', 'JOIN', 'CHECKPOINT', 'END', 'AGENT', 'DEVICE'
]);
const HUMAN_DECISIONS_BY_REQUEST = Object.freeze({
  approval: new Set(['approved', 'rejected', 'cancelled']),
  clarification: new Set(['provided', 'cancelled']),
  credential: new Set(['provided', 'cancelled']),
  exception: new Set(['approved', 'rejected', 'cancelled']),
  'policy-choice': new Set(['selected', 'cancelled']),
  'conflict-resolution': new Set(['selected', 'provided', 'cancelled']),
  interpretation: new Set(['provided', 'cancelled']),
  'evidence-review': new Set(['approved', 'rejected', 'provided', 'cancelled']),
  'scope-expansion': new Set(['approved', 'rejected', 'cancelled']),
  'production-authority': new Set(['approved', 'rejected', 'cancelled']),
  'scientific-judgment': new Set(['approved', 'rejected', 'provided', 'cancelled']),
  'legal-judgment': new Set(['approved', 'rejected', 'provided', 'cancelled'])
});
const RUNTIME_EVIDENCE_KINDS = new Set([
  'attempt', 'task-attempt', 'candidate', 'candidate-snapshot',
  'verification', 'verification-result', 'deterministic-verification',
  'action-evidence', 'receipt', 'task-receipt'
]);
const EXECUTION_LEASE_HEARTBEAT_MS = 5_000;

export const SGOS_SEQUENTIAL_OPCODES = Object.freeze([
  'NOOP', 'KERNEL', 'VERIFY', 'HUMAN_REQUEST', 'JOIN', 'CHECKPOINT', 'END'
]);
export const SGOS_BLOCKED_OPCODES = Object.freeze(['AGENT', 'DEVICE']);

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function clone(value) {
  return structuredClone(value);
}

function instant(clock = null) {
  const value = typeof clock === 'function' ? clock() : (clock ?? nowIso());
  if (!Number.isFinite(Date.parse(value))) fail('SGOS runtime clock returned an invalid timestamp.', 'SGOS_CLOCK_INVALID');
  return new Date(value).toISOString();
}

function operationalInstant() {
  return new Date().toISOString();
}

function requireSha256(label, value) {
  if (!SHA256.test(String(value ?? ''))) fail(`${label} must be an exact sha256 reference.`, 'SGOS_HASH_INVALID', { label });
  return String(value);
}

function ownKeysOnly(value, allowed, label, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`, code);
  }
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${label} contains unsupported field '${key}'.`, code, { field: key });
  }
}

/**
 * Detect pre-existing links in the machine-local SGOS subtree. This closes simple link attacks at
 * the runtime boundary. Atomic no-follow publication belongs in store.mjs; this preflight cannot
 * eliminate a hostile same-machine process racing between this check and a later store write.
 */
async function assertSafeSgosSidecar(root, processId) {
  const processDirectory = sgosProcessDirectory(root, processId);
  const commonDirectory = path.resolve(processDirectory, '..', '..', '..', '..');
  let commonStats;
  try {
    commonStats = await lstat(commonDirectory);
  } catch (error) {
    fail('The Git common directory cannot be resolved safely.', 'SGOS_SIDECAR_PATH_UNSAFE', { cause: error?.code ?? null });
  }
  if (commonStats.isSymbolicLink() || !commonStats.isDirectory()) {
    fail('The Git common directory is not a real directory.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  let cursor = commonDirectory;
  for (const segment of ['singularity-flow', 'sgos', 'processes', path.basename(processDirectory)]) {
    cursor = path.join(cursor, segment);
    let stats;
    try { stats = await lstat(cursor); } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(`SGOS sidecar ancestor '${cursor}' is not a real directory.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
  }
}

function retryCeiling(template) {
  const maximum = template.retry?.maximumAttempts ?? template.retryPolicy?.maximumAttempts ?? 1;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    fail(`Task '${template.taskTemplateId}' has an invalid retry ceiling.`, 'SGOS_PROGRAM_BUDGET_INVALID');
  }
  return maximum;
}

function joinCount(joins) {
  return Array.isArray(joins) ? joins.length : Object.keys(joins ?? {}).length;
}

function programCoreHash(program) {
  const core = clone(program);
  delete core.programSha256;
  return `sha256:${recordSha256(core)}`;
}

function assertProgram(program) {
  if (program?.kind !== 'gvm-program' || !Array.isArray(program.taskTemplates)) {
    fail('The SGOS runtime requires a compiled gvm-program.', 'SGOS_PROGRAM_INVALID');
  }
  requireSha256('programSha256', program.programSha256);
  requireSha256('policySnapshotSha256', program.policySnapshotSha256);
  try { validateGvmProgram(program); } catch {
    fail('The compiled GVM Program failed its integrity check.', 'SGOS_PROGRAM_CORRUPT');
  }
  assertSgosInstalledProgramLimits(program);
  if (program.programSha256 !== programCoreHash(program)) {
    fail('The compiled GVM Program failed its integrity check.', 'SGOS_PROGRAM_CORRUPT');
  }
  const ids = new Set();
  for (const task of program.taskTemplates) {
    if (!task?.taskTemplateId || ids.has(task.taskTemplateId) || !task.opcode) {
      fail('The compiled GVM Program has duplicate or malformed task templates.', 'SGOS_PROGRAM_INVALID');
    }
    if (!SUPPORTED_PROGRAM_OPCODES.has(task.opcode)) {
      fail(`Opcode '${task.opcode}' requires runtime control-flow semantics that are not installed.`, 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
        opcode: task.opcode, taskTemplateId: task.taskTemplateId
      });
    }
    ids.add(task.taskTemplateId);
  }
  if ((program.edges ?? []).some((edge) => edge?.condition != null)) {
    fail('Conditional GVM edges are not supported by the sequential runtime.', 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
      semantic: 'conditional-edge'
    });
  }
  const maximumTasks = program.budgets?.maximumTasks;
  if (maximumTasks != null && (!Number.isSafeInteger(maximumTasks) || maximumTasks < 1)) {
    fail('Program maximumTasks must be a positive integer.', 'SGOS_PROGRAM_BUDGET_INVALID');
  }
  if (maximumTasks != null && program.taskTemplates.length > maximumTasks) {
    fail('The compiled Program exceeds its maximumTasks ceiling.', 'SGOS_PROGRAM_BUDGET_EXCEEDED', {
      maximumTasks, actualTasks: program.taskTemplates.length
    });
  }
  const maximumAttempts = program.budgets?.maximumAttempts;
  if (maximumAttempts != null && (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1)) {
    fail('Program maximumAttempts must be a positive integer.', 'SGOS_PROGRAM_BUDGET_INVALID');
  }
  for (const task of program.taskTemplates) {
    if (maximumAttempts != null && retryCeiling(task) > maximumAttempts) {
      fail(`Task '${task.taskTemplateId}' exceeds the Program retry ceiling.`, 'SGOS_PROGRAM_BUDGET_EXCEEDED', {
        taskTemplateId: task.taskTemplateId,
        taskMaximumAttempts: retryCeiling(task),
        programMaximumAttempts: maximumAttempts
      });
    }
  }
  return program;
}

async function resolveProgram(root, process, supplied = null) {
  const program = supplied ?? (await readSgosProgram(root, process.processId, process.programSha256)).record;
  assertProgram(program);
  validateSgosProgramStaticSafety(program, {
    supportedOpcodes: [...SUPPORTED_PROGRAM_OPCODES],
    maximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
  });
  if (program.programSha256 !== process.programSha256
      || program.policySnapshotSha256 !== process.policySnapshotSha256) {
    fail('The loaded Program or policy does not match the Process binding.', 'SGOS_PROGRAM_STALE');
  }
  assertSgosProcessMaterialization(program, process);
  // Process creation is not the execution choke point: a corrupt sidecar or a caller importing the
  // low-level store module could otherwise persist a self-consistent Process without ever passing
  // startSgosProcess. Reload the independently approved Program authority on every operation that
  // can dispatch, answer, resume, or recover work, then compare it with the immutable admission
  // receipt pinned into this Process.
  // A remote-tracking ref name is not authority by itself: a local process can update that
  // namespace directly. Every mutating execution boundary therefore refreshes the exact advertised
  // remote authority before trusting its bytes. Remote-less repositories use the explicit offline
  // local-authority profile enforced by authority-trust.mjs.
  const programAuthority = await loadApprovedSgosProgramAuthority(root, program);
  const currentAdmission = assertSgosProgramExecutionAdmission(program, {
    programAuthority,
    supportedOpcodes: [...SUPPORTED_PROGRAM_OPCODES],
    maximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
  });
  const storedAdmission = process.authorityBinding?.executionAdmission;
  ownKeysOnly(storedAdmission, [
    'admitted', 'programId', 'programSha256', 'provenance', 'safety'
  ], 'authorityBinding.executionAdmission', 'SGOS_PROGRAM_ADMISSION_INVALID');
  ownKeysOnly(storedAdmission.provenance, [
    'method', 'programSha256', 'intentIrSha256', 'workflowSha256',
    'ratificationSha256', 'source'
  ], 'authorityBinding.executionAdmission.provenance', 'SGOS_PROGRAM_ADMISSION_INVALID');
  const provenanceMethod = storedAdmission.provenance.method;
  const provenanceMatches = ['approved-program-authority', 'approved-authority+deterministic-recompilation']
    .includes(provenanceMethod)
    && storedAdmission.provenance.programSha256 === program.programSha256
    && storedAdmission.provenance.ratificationSha256 === program.ratificationSha256
    && (provenanceMethod !== 'approved-authority+deterministic-recompilation'
      || (storedAdmission.provenance.intentIrSha256 === program.intentIrSha256
        && storedAdmission.provenance.workflowSha256 === program.workflowSha256))
    && canonicalJson(storedAdmission.provenance.source)
      === canonicalJson(currentAdmission.provenance.source);
  // A start request may include the full registry snapshot and therefore prove `verified:true`.
  // Dispatch deliberately does not accept a caller-supplied registry. Preserve that stronger
  // immutable proof while rechecking every other safety invariant and the exact registry digest.
  const storedSafety = clone(storedAdmission.safety);
  const currentSafety = clone(currentAdmission.safety);
  if (storedSafety?.registry) storedSafety.registry.verified = false;
  if (currentSafety?.registry) currentSafety.registry.verified = false;
  const admissionMatches = storedAdmission.admitted === true
    && storedAdmission.programId === program.programId
    && storedAdmission.programSha256 === program.programSha256
    && provenanceMatches
    && canonicalJson(storedSafety) === canonicalJson(currentSafety)
    && canonicalJson(process.authorityBinding?.configurationAuthority ?? null)
      === canonicalJson(currentAdmission.provenance.source?.configurationAuthority ?? null);
  if (!admissionMatches) {
    fail('The Process does not carry the exact currently approved Program admission.',
      'SGOS_PROGRAM_ADMISSION_INVALID', {
        processId: process.processId,
        programSha256: program.programSha256
      });
  }
  return program;
}

function stableId(prefix, value) {
  return `${prefix}-${recordSha256(value).slice(0, 24).toUpperCase()}`;
}

/** Publish a contract-valid Candidate Snapshot without replacing an existing hash. */
export async function putSgosCandidateSnapshot(root, processId, value) {
  let candidate;
  try { candidate = validateCandidateSnapshot(value); } catch (error) {
    fail('Candidate Snapshot failed its contract or self-hash check.', 'SGOS_CANDIDATE_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  return putSgosImmutableRecord(root, processId, 'candidate-snapshot', candidate);
}

/** Read and revalidate the exact immutable Candidate Snapshot bytes used by verification. */
export async function readSgosCandidateSnapshot(root, processId, candidateSha256) {
  requireSha256('candidateSha256', candidateSha256);
  const stored = await readSgosImmutableRecord(root, processId, 'candidate-snapshot', candidateSha256);
  let candidate;
  try { candidate = validateCandidateSnapshot(stored.record); } catch (error) {
    fail('Candidate Snapshot failed its integrity check.', 'SGOS_CANDIDATE_CORRUPT', { cause: error?.message ?? String(error) });
  }
  if (candidate.candidateSha256 !== candidateSha256) {
    fail('Candidate Snapshot path and self-hash do not match.', 'SGOS_CANDIDATE_CORRUPT');
  }
  return Object.freeze({ ...stored, record: candidate, sha256: candidate.candidateSha256 });
}

function processBaselineSha256(process) {
  return process.authorityBinding?.baselineSnapshotSha256 ?? sgosSha256({
    kind: 'sgos-process-baseline',
    processBindingSha256: process.processBindingSha256,
    revision: process.authorityBinding?.baselineRevision ?? process.processBindingSha256
  });
}

function candidatePrincipal(value = null) {
  const principal = value ?? { id: 'sgos-runtime', kind: 'system' };
  ownKeysOnly(principal, ['id', 'kind', 'name', 'email', 'authoritySha256'], 'Candidate principal', 'SGOS_CANDIDATE_INVALID');
  if (typeof principal.id !== 'string' || !principal.id || typeof principal.kind !== 'string' || !principal.kind) {
    fail('Candidate principal requires id and kind.', 'SGOS_CANDIDATE_INVALID');
  }
  if (principal.authoritySha256 != null) requireSha256('candidate.createdBy.authoritySha256', principal.authoritySha256);
  return clone(principal);
}

async function createAndReloadCandidate(root, process, { resources = [], createdBy = null, createdAt }) {
  const binding = process.authorityBinding ?? {};
  let candidate;
  try {
    candidate = createCandidateSnapshot({
      subject: {
        kind: binding.kind ?? 'story',
        id: binding.subjectId,
        revision: String(binding.baselineRevision),
        sha256: process.processBindingSha256
      },
      baseline: {
        revision: String(binding.baselineRevision),
        snapshotSha256: processBaselineSha256(process)
      },
      resources: clone(resources),
      createdBy: candidatePrincipal(createdBy),
      createdAt
    });
  } catch (error) {
    fail('Trusted candidate capture did not produce a contract-valid resource manifest.', 'SGOS_CANDIDATE_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  const publication = await putSgosCandidateSnapshot(root, process.processId, candidate);
  const reloaded = (await readSgosCandidateSnapshot(
    root, process.processId, candidate.candidateSha256
  )).record;
  if (publication.reservationToken != null) {
    RECORD_RESERVATION_BY_RECORD.set(reloaded, publication.reservationToken);
  }
  return reloaded;
}

function templateById(program) {
  return new Map(program.taskTemplates.map((template) => [template.taskTemplateId, template]));
}

function predecessorsSatisfied(process, task) {
  return task.predecessorTaskInstanceIds.every((id) =>
    SUCCESS_PREDECESSOR_STATES.has(process.taskInstances[id]?.state));
}

/** Same Program + Process checkpoint always produces the same canonically ordered ready set. */
export function deterministicSgosReadySet(program, process) {
  assertProgram(program);
  if (program.programSha256 !== process?.programSha256) fail('Ready-set Program does not match Process.', 'SGOS_PROGRAM_STALE');
  return deterministicSgosDispatchPlan(program, process, { maximumParallel: 1 });
}

export function readySetFromSgosCheckpoint(checkpoint) {
  if (checkpoint?.kind !== 'gvm-checkpoint' || !Array.isArray(checkpoint.readyTaskIds)) {
    fail('A ready set can only be restored from an exact GVM checkpoint.', 'SGOS_CHECKPOINT_INVALID');
  }
  return Object.freeze([...checkpoint.readyTaskIds].sort());
}

function taskStateSummary(process) {
  return Object.fromEntries(Object.entries(process.taskInstances).sort(([left], [right]) => compareSgosCodePoints(left, right))
    .map(([id, task]) => [id, task.state]));
}

function buildCheckpoint(process, program, { priorCheckpointSha256 = null, createdAt }) {
  const readyTaskIds = deterministicSgosReadySet(program, process).map((entry) => entry.taskInstanceId);
  const identity = {
    processId: process.processId,
    processRevision: process.processRevision,
    programSha256: process.programSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    processBindingSha256: process.processBindingSha256,
    taskStates: taskStateSummary(process),
    readyTaskIds,
    activeExecutions: clone(process.activeExecutions),
    openHumanRequests: clone(process.openHumanRequests),
    activeLeases: clone(process.activeLeases),
    priorCheckpointSha256
  };
  return sealSgosImmutableRecord('gvm-checkpoint', {
    schemaVersion: currentSchemaVersion('gvm-checkpoint'),
    kind: 'gvm-checkpoint',
    checkpointId: stableId('CHK', identity),
    ...identity,
    createdAt
  });
}

function fanoutExpansionReceipts(program, process, createdAt) {
  const groups = new Map();
  for (const template of program.taskTemplates) {
    const item = template.metadata?.fanout ?? null;
    const coordinator = template.metadata?.fanoutCoordinator ?? null;
    const metadata = item ?? coordinator;
    if (!metadata?.parentTaskId) continue;
    let group = groups.get(metadata.parentTaskId);
    if (!group) {
      group = {
        parentTaskTemplateId: metadata.parentTaskId,
        collectionSha256: metadata.collectionSha256,
        maximumItems: metadata.maximumItems,
        maximumParallel: metadata.maximumParallel,
        items: []
      };
      groups.set(metadata.parentTaskId, group);
    }
    if (item) {
      const task = Object.values(process.taskInstances)
        .find((entry) => entry.taskTemplateId === template.taskTemplateId);
      if (!task) fail('Fan-out child was not deterministically materialized.',
        'SGOS_FANOUT_MATERIALIZATION_INVALID', { taskTemplateId: template.taskTemplateId });
      group.items.push({
        itemKey: item.itemKey,
        itemSha256: item.itemSha256,
        taskTemplateId: template.taskTemplateId,
        taskInstanceId: task.taskInstanceId
      });
    }
  }
  return [...groups.values()]
    .sort((left, right) => compareSgosCodePoints(
      left.parentTaskTemplateId, right.parentTaskTemplateId
    ))
    .map((group) => createFanoutExpansionReceipt({
      processId: process.processId,
      ...group,
      createdAt
    }));
}

function resolveTaskContractSha256({ taskContract = null, taskContractSha256 = null, program }) {
  const reference = taskContractSha256
    ?? taskContract?.taskContractSha256
    ?? taskContract?.contractSha256
    ?? program.taskContractSha256
    ?? (taskContract ? sgosSha256(taskContract) : null);
  return requireSha256('taskContractSha256', reference);
}

function normalizeHumanAuthorityRequirement(value, index = 0) {
  const label = `humanAuthorityRequirements[${index}]`;
  ownKeysOnly(value, ['kind', 'id', 'minimumAssurance', 'authoritySha256'], label,
    'SGOS_AUTHORITY_BINDING_INVALID');
  for (const field of ['kind', 'id']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      fail(`${label}.${field} must be a non-empty string.`, 'SGOS_AUTHORITY_BINDING_INVALID');
    }
  }
  if (value.minimumAssurance != null
      && (typeof value.minimumAssurance !== 'string' || !value.minimumAssurance.trim())) {
    fail(`${label}.minimumAssurance must be null or a non-empty string.`,
      'SGOS_AUTHORITY_BINDING_INVALID');
  }
  requireSha256(`${label}.authoritySha256`, value.authoritySha256);
  return {
    kind: value.kind,
    id: value.id,
    minimumAssurance: value.minimumAssurance ?? null,
    authoritySha256: value.authoritySha256
  };
}

function normalizeHumanAuthorityRequirements(values = []) {
  if (!Array.isArray(values)) {
    fail('humanAuthorityRequirements must be an array.', 'SGOS_AUTHORITY_BINDING_INVALID');
  }
  const normalized = values.map(normalizeHumanAuthorityRequirement).sort((left, right) =>
    compareSgosCodePoints(left.kind, right.kind) || compareSgosCodePoints(left.id, right.id));
  if (new Set(normalized.map((entry) => `${entry.kind}\0${entry.id}`)).size !== normalized.length) {
    fail('humanAuthorityRequirements contains duplicate authority bindings.',
      'SGOS_AUTHORITY_BINDING_INVALID');
  }
  return normalized;
}

function currentProcessBinding(root, {
  processId, subject, subjectAuthority = null, configurationAuthority = null, supplied = null
}) {
  const current = buildSgosProcessBinding(root, {
    processId,
    subjectId: subject.id,
    subjectAuthority,
    configurationAuthority,
    expectedProcessRevision: 0
  });
  if (subject.branch != null && subject.branch !== current.branch) {
    fail('The requested subject branch is not the current worktree branch.', 'SGOS_PROCESS_BINDING_STALE', {
      expected: current.branch, received: subject.branch
    });
  }
  if (subject.baselineRevision != null && subject.baselineRevision !== current.baselineRevision) {
    fail('The requested subject baseline is not the current worktree HEAD.', 'SGOS_PROCESS_BINDING_STALE', {
      expected: current.baselineRevision, received: subject.baselineRevision
    });
  }
  if (supplied == null) return current;
  let validated;
  try { validated = validateProcessBinding(supplied); } catch (error) {
    fail('The supplied Process Binding failed its contract or self-hash check.', 'SGOS_PROCESS_BINDING_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  const fields = [
    'processId', 'subjectId', 'repositoryIdentity', 'gitCommonDirectory', 'worktreeGitDirectory',
    'canonicalWorktreeRoot', 'branch', 'baselineRevision', 'expectedProcessRevision', 'bindingSha256'
  ];
  const stale = fields.filter((field) => validated[field] !== current[field]);
  if (canonicalJson(validated.subjectAuthority) !== canonicalJson(current.subjectAuthority)) {
    stale.push('subjectAuthority');
  }
  if (canonicalJson(validated.configurationAuthority) !== canonicalJson(current.configurationAuthority)) {
    stale.push('configurationAuthority');
  }
  if (stale.length) {
    fail('The supplied Process Binding does not describe the current repository/worktree/branch/HEAD.', 'SGOS_PROCESS_BINDING_STALE', {
      fields: stale
    });
  }
  return validated;
}

async function assertCurrentStoredProcessBinding(root, process) {
  const { record: stored } = await readSgosImmutableRecord(
    root, process.processId, 'process-binding', process.processBindingSha256
  );
  let subjectAuthority = null;
  if (process.authorityBinding?.kind === 'story') {
    subjectAuthority = loadSgosStoryAuthority(root, {
      subjectId: process.authorityBinding.subjectId,
      revision: stored.baselineRevision
    }).authority;
    assertSgosStoryAuthority(stored.subjectAuthority, subjectAuthority);
    assertSgosStoryAuthority(process.authorityBinding.subjectAuthority, subjectAuthority);
  } else if (stored.subjectAuthority !== null || process.authorityBinding?.subjectAuthority != null) {
    fail('A non-Story Process cannot claim governed Story authority.',
      'SGOS_STORY_AUTHORITY_MISMATCH');
  }
  const current = buildSgosProcessBinding(root, {
    processId: process.processId,
    subjectId: process.authorityBinding?.subjectId,
    subjectAuthority,
    configurationAuthority: stored.configurationAuthority,
    expectedProcessRevision: stored.expectedProcessRevision
  });
  const fields = [
    'processId', 'subjectId', 'repositoryIdentity', 'gitCommonDirectory', 'worktreeGitDirectory',
    'canonicalWorktreeRoot', 'branch', 'baselineRevision'
  ];
  const stale = fields.filter((field) => stored[field] !== current[field]);
  if (canonicalJson(stored.subjectAuthority) !== canonicalJson(current.subjectAuthority)) {
    stale.push('subjectAuthority');
  }
  if (stale.length) {
    fail('The repository, worktree, branch, or HEAD changed after this Process was bound.',
      'SGOS_PROCESS_BINDING_STALE', {
        fields: stale,
        processBindingSha256: process.processBindingSha256
      });
  }
  return stored;
}

function updateReadinessAndStatus(process, program) {
  for (const task of Object.values(process.taskInstances)) {
    if (!['planned', 'waiting', 'ready'].includes(task.state)) continue;
    const readiness = sgosTaskReadiness(program, process, task);
    const next = readiness.impossible ? 'blocked' : readiness.ready ? 'ready' : 'waiting';
    if (task.state !== next) {
      task.state = next;
      task.revision += 1;
    }
  }
  if (process.status === 'paused' || PROCESS_TERMINAL.has(process.status)) return;
  if (Object.values(process.taskInstances).some((task) => task.state === 'recovery-required')) {
    process.status = 'recovery-required';
  } else if (process.activeExecutions.length) {
    process.status = 'running';
  } else if (deterministicSgosReadySet(program, { ...process, status: 'running' }).length) {
    process.status = 'running';
  } else if (process.openHumanRequests.length) {
    process.status = 'waiting-human';
  } else if (Object.values(process.taskInstances).some((task) => task.state === 'cancelled')) {
    process.status = 'cancelled';
  } else if (Object.values(process.taskInstances).some((task) => task.state === 'blocked')) {
    process.status = 'blocked';
  } else if (Object.values(process.taskInstances).some((task) => task.state === 'failed')) {
    process.status = 'failed';
  } else if (Object.values(process.taskInstances).every((task) => task.state === 'succeeded')) {
    const templates = templateById(program);
    const endSucceeded = Object.values(process.taskInstances)
      .some((task) => templates.get(task.taskTemplateId)?.opcode === 'END' && task.state === 'succeeded');
    process.status = endSucceeded ? 'succeeded' : 'blocked';
  } else {
    process.status = 'blocked';
  }
}

async function settlePendingTransitionBeforeMutation(root, processId, operation, {
  allowMissing = false
} = {}) {
  let recovery;
  try { recovery = await recoverPendingSgosTransition(root, processId); } catch (error) {
    if (allowMissing && ['ENOENT', 'SGOS_PROCESS_NOT_FOUND'].includes(error?.code)) return null;
    throw error;
  }
  if (!recovery.recovered) return recovery.process;
  fail(`A prior exact SGOS transition was recovered before '${operation}'. Retry against the recovered revision.`,
    'SGOS_TRANSITION_RECOVERED_RETRY', {
      operation,
      processId,
      processRevision: recovery.process.processRevision,
      processSha256: recovery.process.processSha256,
      intentSha256: recovery.intentSha256
    });
}

export async function startSgosProcess(root, options = {}) {
  if (Object.hasOwn(options, 'trustedAuthorities') || Object.hasOwn(options, 'configurationAuthority')) {
    fail('Caller-supplied Human or configuration authority is not accepted; SGOS loads the exact approved authority itself.',
      'SGOS_AUTHORITY_SELF_CLAIM_REFUSED');
  }
  const {
    program,
    compilerRequest = null,
    taskContract = null,
    taskContractSha256 = null,
    processId = null,
    subject,
    processBinding = null,
    clock = null
  } = options;
  const programAuthority = await loadApprovedSgosProgramAuthority(root, program);
  const humanAuthority = await loadApprovedSgosHumanAuthorityContext(root, program, {
    // Program admission just refreshed and pinned this authority; read the same local ref so the
    // two resolutions form one stable start boundary without a second remote round trip.
    refreshAuthority: false
  });
  const configurationAuthority = humanAuthority.configurationAuthority;
  if (canonicalJson(programAuthority.source.configurationAuthority)
      !== canonicalJson(configurationAuthority)) {
    fail('Approved configuration authority changed between Human authority resolution and Program admission.',
      'SGOS_APPROVED_CONFIGURATION_CHANGED', {
        humanAuthority: configurationAuthority,
        programAuthority: programAuthority.source.configurationAuthority
      });
  }
  const executionAdmission = assertSgosProgramExecutionAdmission(program, {
    compilerRequest,
    programAuthority,
    supportedOpcodes: [...SUPPORTED_PROGRAM_OPCODES],
    maximumAttempts: SGOS_INSTALLED_LIMITS.maximumAttemptsPerTask
  });
  assertProgram(program);
  if (!subject?.id) fail('An SGOS process must bind an existing governed subject.', 'SGOS_SUBJECT_REQUIRED');
  const subjectKind = subject.kind ?? 'story';
  if (!SUBJECT_KINDS.has(subjectKind)) {
    fail(`Unsupported SGOS subject kind '${subjectKind}'. Allowed: story, repository.`,
      'SGOS_SUBJECT_KIND_INVALID', { subjectKind });
  }
  const id = processId ?? stableId('PROC', {
    programSha256: program.programSha256,
    subject: { kind: subjectKind, id: subject.id, branch: subject.branch ?? null }
  });
  const contractSha256 = resolveTaskContractSha256({ taskContract, taskContractSha256, program });
  await assertSafeSgosSidecar(root, id);
  await settlePendingTransitionBeforeMutation(root, id, 'start', { allowMissing: true });
  const baselineRevision = head(root);
  const subjectAuthority = subjectKind === 'story'
    ? loadSgosStoryAuthority(root, { subjectId: subject.id, revision: baselineRevision }).authority
    : null;
  const binding = currentProcessBinding(root, {
    processId: id, subject, subjectAuthority, configurationAuthority, supplied: processBinding
  });
  const pinnedAuthorityRequirements = normalizeHumanAuthorityRequirements(
    humanAuthority.humanAuthorityRequirements
  );
  const authorityBinding = {
    kind: subjectKind,
    subjectId: subject.id,
    subjectAuthority,
    branch: binding.branch,
    baselineRevision: binding.baselineRevision,
    baselineSnapshotSha256: sgosSha256({
      kind: 'sgos-process-baseline',
      processBindingSha256: binding.bindingSha256,
      revision: binding.baselineRevision
    }),
    authority: subjectKind === 'story'
      ? 'existing-story-lifecycle'
      : 'existing-repository-baseline',
    configurationAuthority: clone(configurationAuthority),
    humanAuthorityRequirements: pinnedAuthorityRequirements,
    executionAdmission
  };
  const programPublication = await putSgosImmutableRecord(root, id, 'gvm-program', program);
  const bindingPublication = await putSgosImmutableRecord(
    root, id, 'process-binding', binding
  );
  const programRecord = programPublication.record;
  const bindingRecord = bindingPublication.record;
  const createdAt = instant(clock);
  let created;
  try {
    created = await createSgosProcess(root, {
      schemaVersion: currentSchemaVersion('gvm-process'),
      kind: 'gvm-process',
      processId: id,
      programSha256: programRecord.programSha256,
      policySnapshotSha256: program.policySnapshotSha256,
      processBindingSha256: bindingRecord.bindingSha256,
      status: 'running',
      taskInstances: taskInstancesForSgosProgram(program, id),
      activeExecutions: [],
      openHumanRequests: [],
      activeLeases: [],
      currentCheckpointSha256: null,
      taskContractSha256: contractSha256,
      authorityBinding,
      createdAt,
      updatedAt: createdAt
    });
  } catch (error) {
    if (error?.code !== 'SGOS_PROCESS_EXISTS') throw error;
    const existing = await readSgosProcess(root, id);
    if (existing.programSha256 !== program.programSha256
        || existing.processBindingSha256 !== bindingRecord.bindingSha256
        || existing.taskContractSha256 !== contractSha256
        || canonicalJson(existing.authorityBinding) !== canonicalJson(authorityBinding)) throw error;
    // Genesis may have committed state immediately before reservation cleanup. Exact retry
    // consumes only Program/Binding reservations proven present in rooted index history.
    await consumeRootedSgosRecordReservations(root, id, [
      programPublication.reservationToken,
      bindingPublication.reservationToken
    ]);
    if (existing.currentCheckpointSha256) {
      for (const receipt of fanoutExpansionReceipts(program, existing, existing.createdAt)) {
        const stored = await readSgosImmutableRecord(
          root, id, 'fanout-expansion-receipt', receipt.expansionSha256
        );
        if (canonicalJson(stored.record) !== canonicalJson(receipt)) {
          fail('Stored fan-out expansion does not match the approved Program.',
            'SGOS_FANOUT_MATERIALIZATION_INVALID');
        }
      }
      const checkpoint = (await readSgosCheckpoint(root, id, existing.currentCheckpointSha256)).record;
      return Object.freeze({ process: existing, program: programRecord, binding: bindingRecord, checkpoint, created: false });
    }
    // A crash can occur after Process creation but before the initial checkpoint CAS. Rebuild that
    // exact boundary from the persisted creation time; never leave a half-started Process or invent
    // a second checkpoint identity on retry.
    const checkpoint = buildCheckpoint(existing, program, {
      createdAt: existing.createdAt,
      priorCheckpointSha256: null
    });
    const checkpointPublication = await putSgosImmutableRecord(
      root, id, 'gvm-checkpoint', checkpoint, { reserveExisting: true }
    );
    const fanoutPublications = [];
    for (const receipt of fanoutExpansionReceipts(program, existing, existing.createdAt)) {
      fanoutPublications.push(await putSgosImmutableRecord(
        root, id, 'fanout-expansion-receipt', receipt, { reserveExisting: true }
      ));
    }
    const repaired = await mutateSgosProcess(root, id, (draft) => {
      draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
    }, {
      expectedRevision: existing.processRevision,
      expectedProcessSha256: existing.processSha256,
      updatedAt: existing.updatedAt,
      recordReservations: [
        checkpointPublication.reservationToken,
        ...fanoutPublications.map((publication) => publication.reservationToken)
      ].filter(Boolean)
    });
    return Object.freeze({
      process: repaired, program: programRecord, binding: bindingRecord,
      checkpoint, created: false, recoveredStart: true
    });
  }

  const checkpoint = buildCheckpoint(created, program, { createdAt, priorCheckpointSha256: null });
  const checkpointPublication = await putSgosImmutableRecord(
    root, id, 'gvm-checkpoint', checkpoint
  );
  const fanoutPublications = [];
  for (const receipt of fanoutExpansionReceipts(program, created, createdAt)) {
    fanoutPublications.push(await putSgosImmutableRecord(
      root, id, 'fanout-expansion-receipt', receipt
    ));
  }
  const process = await mutateSgosProcess(root, id, (draft) => {
    draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
  }, {
    expectedRevision: created.processRevision,
    updatedAt: createdAt,
    recordReservations: [
      checkpointPublication.reservationToken,
      ...fanoutPublications.map((publication) => publication.reservationToken)
    ].filter(Boolean)
  });
  return Object.freeze({ process, program: programRecord, binding: bindingRecord, checkpoint, created: true });
}

function operationHandler(handlers, kind, template) {
  const configured = handlers?.[kind];
  if (typeof configured === 'function') return configured;
  const operationId = typeof template.operation === 'string' ? template.operation : template.operation?.id;
  if (configured && typeof configured === 'object') return configured[operationId] ?? null;
  return null;
}

function operationId(template) {
  return typeof template.operation === 'string' ? template.operation : template.operation?.id;
}

function configuredOperationHandler(configured, template, explicitOperation = null) {
  if (typeof configured === 'function') return configured;
  if (configured == null || typeof configured !== 'object') return null;
  return configured[explicitOperation ?? operationId(template)] ?? null;
}

function verifierOperation(template) {
  const verification = template.metadata?.verification ?? template.verification ?? null;
  if (typeof verification === 'string') return verification;
  if (typeof verification?.operation === 'string') return verification.operation;
  if (typeof verification?.operation?.id === 'string') return verification.operation.id;
  return operationId(template);
}

function untrustedOutcome(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail('A task handler must return an observation object.', 'SGOS_HANDLER_RESULT_INVALID');
  }
  for (const field of ['verification', 'candidateSha256', 'candidate', 'candidateSnapshot', 'resources']) {
    if (Object.hasOwn(value, field)) {
      fail(`A task handler cannot declare '${field}'; candidate capture and verification are independent boundaries.`, 'SGOS_UNTRUSTED_VERIFICATION_RESULT', {
        field
      });
    }
  }
  return clone(value);
}

async function invokeHandlerWithTimeout(handler, context, timeoutMs) {
  if (timeoutMs == null) return handler(Object.freeze(context));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    fail('Task timeoutMs must be a positive integer.', 'SGOS_PROGRAM_BUDGET_INVALID');
  }
  const controller = new AbortController();
  let timer;
  const handlerSettlement = Promise.resolve()
    .then(() => handler(Object.freeze({ ...context, signal: controller.signal })))
    .then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error })
    );
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      const error = new SingularityFlowError(`Task exceeded its ${timeoutMs}ms execution ceiling.`, {
        code: 'SGOS_TASK_TIMEOUT', details: { timeoutMs }
      });
      error.uncertainEffect = true;
      // Abort is advisory for an in-process handler. The lease remains owned until the handler
      // actually settles, because removing it sooner would let recovery retry code that still runs.
      controller.abort(error);
      resolve({ status: 'timed-out', error });
    }, timeoutMs);
  });
  try {
    const first = await Promise.race([handlerSettlement, timedOut]);
    if (first.status === 'timed-out') {
      await handlerSettlement;
      throw first.error;
    }
    if (first.status === 'rejected') throw first.error;
    return first.value;
  } finally {
    clearTimeout(timer);
  }
}

async function captureCandidate(root, process, context, observation, captureCandidates, createdAt) {
  const capture = configuredOperationHandler(captureCandidates, context.template);
  if (typeof capture !== 'function') {
    fail(`Task '${context.task.taskTemplateId}' has no trusted Candidate Snapshot capture.`, 'SGOS_CANDIDATE_CAPTURE_REQUIRED');
  }
  const captured = await capture(Object.freeze({
    process: clone(process),
    task: clone(context.task),
    template: clone(context.template),
    rawResult: clone(observation.rawResult ?? observation),
    outputRefs: clone(observation.outputRefs ?? [])
  }));
  const normalized = Array.isArray(captured) ? { resources: captured } : captured;
  ownKeysOnly(normalized, ['resources', 'createdBy'], 'Trusted candidate capture', 'SGOS_CANDIDATE_INVALID');
  if (!Array.isArray(normalized.resources)) {
    fail('Trusted candidate capture must return a resources array.', 'SGOS_CANDIDATE_INVALID');
  }
  return createAndReloadCandidate(root, process, {
    resources: normalized.resources,
    createdBy: normalized.createdBy == null
      ? { id: `sgos-attempt:${context.attemptId}`, kind: 'system' }
      : {
          ...normalized.createdBy,
          name: normalized.createdBy.name
            ?? `SGOS attempt ${context.attemptId}`
        },
    createdAt
  });
}

function boundVerification({ method, candidate, task, programSha256, rawVerdict = null }) {
  const rawChecksSha256 = rawVerdict?.checksSha256 == null
    ? sgosSha256(rawVerdict?.checks ?? rawVerdict ?? { status: 'passed' })
    : requireSha256('verifier.checksSha256', rawVerdict.checksSha256);
  return {
    status: 'passed',
    checksSha256: sgosSha256({
      kind: 'sgos-verifier-binding',
      method,
      programSha256,
      taskInstanceId: task.taskInstanceId,
      candidateSha256: candidate.candidateSha256,
      candidateSnapshotSha256: candidate.candidate.snapshotSha256,
      rawChecksSha256
    })
  };
}

async function verifyCapturedCandidate(process, context, observation, candidate, verifiers) {
  const method = verifierOperation(context.template);
  const verifier = configuredOperationHandler(verifiers, context.template, method);
  const handler = operationHandler(context.handlers, context.handlerKind, context.template);
  if (typeof verifier !== 'function') {
    fail(`Task '${context.task.taskTemplateId}' has no trusted deterministic verifier '${method}'.`, 'SGOS_VERIFIER_REQUIRED');
  }
  if (verifier === handler) {
    fail('The operation handler and deterministic verifier must be separate implementations.', 'SGOS_VERIFIER_NOT_INDEPENDENT');
  }
  const verdict = await verifier(Object.freeze({
    process: clone(process),
    task: clone(context.task),
    template: clone(context.template),
    candidateSnapshot: candidate,
    candidateSha256: candidate.candidateSha256,
    rawResult: clone(observation.rawResult ?? observation)
  }));
  if (verdict == null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    fail('Deterministic verifier returned no typed verdict.', 'SGOS_VERIFIER_RESULT_INVALID');
  }
  ownKeysOnly(verdict, ['status', 'candidateSha256', 'checksSha256', 'checks'], 'Verifier verdict', 'SGOS_VERIFIER_RESULT_INVALID');
  if (verdict.candidateSha256 !== candidate.candidateSha256) {
    fail('Verifier verdict is not bound to the exact persisted Candidate Snapshot.', 'SGOS_VERIFIER_CANDIDATE_MISMATCH', {
      expected: candidate.candidateSha256,
      received: verdict.candidateSha256 ?? null
    });
  }
  if (verdict.status !== 'passed') {
    fail('Task result did not pass deterministic verification.', 'SGOS_TASK_VERIFICATION_FAILED');
  }
  if (verdict.checksSha256 == null && verdict.checks == null) {
    fail('A passing verifier must return deterministic checks or their exact digest.', 'SGOS_VERIFIER_RESULT_INVALID');
  }
  return boundVerification({
    method,
    candidate,
    task: context.task,
    programSha256: process.programSha256,
    rawVerdict: verdict
  });
}

async function trustedHandlerOutcome(root, process, context, rawOutcome, captureCandidates, verifiers, createdAt) {
  const observation = untrustedOutcome(rawOutcome);
  const candidate = await captureCandidate(root, process, context, observation, captureCandidates, createdAt);
  const verification = await verifyCapturedCandidate(process, context, observation, candidate, verifiers);
  return {
    ...observation,
    rawResult: observation.rawResult ?? observation,
    postState: candidate,
    candidateSnapshot: candidate,
    verification
  };
}

async function trustedRuntimeOutcome(root, process, context, outcome, method, createdAt) {
  const candidate = await createAndReloadCandidate(root, process, {
    resources: [],
    createdBy: { id: `sgos-runtime:${context.attemptId}`, kind: 'system' },
    createdAt
  });
  return {
    ...clone(outcome),
    postState: candidate,
    candidateSnapshot: candidate,
    verification: boundVerification({
      method,
      candidate,
      task: context.task,
      programSha256: process.programSha256,
      rawVerdict: { status: 'passed', checks: outcome.rawResult ?? outcome }
    })
  };
}

function blockedOpcodeReason(opcode) {
  if (opcode === 'AGENT') return {
    code: 'SGOS_AGENT_EXECUTION_UNAVAILABLE',
    message: 'AGENT is blocked until a conforming Governed Execution Unit is installed.'
  };
  if (opcode === 'DEVICE') return {
    code: 'SGOS_DEVICE_EXECUTION_UNAVAILABLE',
    message: 'DEVICE is blocked until a conforming governed device is installed.'
  };
  return { code: 'SGOS_OPCODE_UNSUPPORTED', message: `Opcode '${opcode}' is not supported by the sequential runtime.` };
}

async function blockTask(root, process, task, reason, clock) {
  const next = await mutateSgosProcess(root, process.processId, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    target.state = 'blocked';
    target.revision += 1;
    draft.status = 'blocked';
  }, { expectedRevision: process.processRevision, expectedProcessSha256: process.processSha256, updatedAt: instant(clock) });
  return Object.freeze({ status: 'blocked', reason: Object.freeze(reason), taskInstanceId: task.taskInstanceId, process: next });
}

function taskSubjectSha256(process, task) {
  return sgosSha256({
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    taskTemplateId: task.taskTemplateId,
    programSha256: process.programSha256,
    taskContractSha256: process.taskContractSha256,
    checkpointSha256: process.currentCheckpointSha256
  });
}

function humanRequestFor(process, task, template, attemptId, createdAt) {
  const settings = clone(template.metadata?.humanRequest ?? template.humanRequest ?? template.operation?.request ?? {});
  if (settings.authorityRequired == null && template.authority && Object.keys(template.authority).length) {
    settings.authorityRequired = template.authority;
  }
  const requestType = settings.requestType;
  if (!HUMAN_REQUEST_TYPES.has(requestType)) {
    fail(`HUMAN_REQUEST task '${task.taskTemplateId}' has no supported requestType.`, 'SGOS_HUMAN_REQUEST_INVALID');
  }
  if (settings.authorityRequired == null) {
    fail(`HUMAN_REQUEST task '${task.taskTemplateId}' has no explicit authority.`, 'SGOS_HUMAN_REQUEST_AUTHORITY_REQUIRED');
  }
  const pinnedRequirement = process.authorityBinding?.humanAuthorityRequirements?.find((entry) =>
    entry.kind === settings.authorityRequired.kind && entry.id === settings.authorityRequired.id);
  if (pinnedRequirement == null) {
    fail(`HUMAN_REQUEST task '${task.taskTemplateId}' is not bound to an approved Human authority definition.`,
      'SGOS_HUMAN_REQUEST_AUTHORITY_REQUIRED');
  }
  settings.authorityRequired = clone(pinnedRequirement);
  const configurationAuthority = process.authorityBinding?.configurationAuthority;
  if (configurationAuthority == null) {
    fail(`HUMAN_REQUEST task '${task.taskTemplateId}' has no immutable approved configuration authority.`,
      'SGOS_APPROVED_CONFIGURATION_REQUIRED');
  }
  const identity = {
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    attemptId,
    requestType,
    checkpointSha256: process.currentCheckpointSha256,
    subjectSha256: taskSubjectSha256(process, task)
  };
  return sealSgosImmutableRecord('human-request', {
    schemaVersion: currentSchemaVersion('human-request'),
    kind: 'human-request',
    requestId: stableId('HRQ', identity),
    requestType,
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    checkpointSha256: process.currentCheckpointSha256,
    requestedBy: clone(settings.requestedBy ?? { kind: 'system', id: 'sgos-runtime' }),
    authorityRequired: clone(settings.authorityRequired),
    configurationAuthority: clone(configurationAuthority),
    prompt: clone(settings.prompt ?? { title: 'Human decision required', detail: '' }),
    options: clone(settings.options ?? []),
    inputSchema: clone(settings.inputSchema ?? null),
    sensitiveMode: settings.sensitiveMode ?? 'none',
    externalUrl: settings.externalUrl ?? null,
    secretBroker: settings.secretBroker ?? null,
    subjectSha256: identity.subjectSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    status: 'open',
    createdAt,
    expiresAt: settings.expiresAt ?? null
  });
}

async function finalizeHumanRequest(
  root, begun, task, request, program, clock, executionLease, recordReservations = []
) {
  const requestPublication = await putSgosImmutableRecord(
    root, begun.processId, 'human-request', request
  );
  const process = await mutateActiveAttemptWithRetry(root, {
    begun, task, attemptId: task.attemptId, executionLease
  }, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    target.state = 'waiting-human';
    target.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== task.attemptId);
    draft.activeLeases = draft.activeLeases.filter((id) => id !== executionLease.leaseId);
    draft.openHumanRequests = [...new Set([...draft.openHumanRequests, request.requestSha256])].sort();
    updateReadinessAndStatus(draft, program);
  }, {
    updatedAt: instant(clock),
    recordReservations: [
      ...recordReservations, requestPublication.reservationToken
    ].filter(Boolean)
  });
  return Object.freeze({ status: 'waiting-human', taskInstanceId: task.taskInstanceId, request, process });
}

async function mutateActiveAttemptWithRetry(root, context, mutate, options = {}) {
  let current = context.begun;
  const maximumRetries = SGOS_INSTALLED_LIMITS.maximumExecutionLeases + 2;
  for (let retry = 0; retry < maximumRetries; retry += 1) {
    try {
      return await mutateSgosProcess(root, current.processId, mutate, {
        ...options,
        expectedRevision: current.processRevision,
        expectedProcessSha256: current.processSha256
      });
    } catch (error) {
      if (error?.code !== 'SGOS_PROCESS_REVISION_STALE') throw error;
      current = await readSgosProcess(root, current.processId);
      const task = current.taskInstances[context.task.taskInstanceId];
      if (!task || task.attemptIds.at(-1) !== context.attemptId
          || !current.activeExecutions.includes(context.attemptId)
          || !current.activeLeases.includes(context.executionLease.leaseId)
          || !['running', 'verifying'].includes(task.state)) {
        fail('Concurrent Process progress changed this attempt before terminal publication.',
          'SGOS_EXECUTION_RECOVERY_REQUIRED', {
            attemptId: context.attemptId,
            taskInstanceId: context.task.taskInstanceId
          });
      }
    }
  }
  fail('Concurrent Process progress exceeded the bounded terminal CAS retry limit.',
    'SGOS_PROCESS_REVISION_STALE', { attemptId: context.attemptId });
}

function executionHandle(process, task, attemptId) {
  return sgosSha256({
    processSha256: process.processSha256,
    taskInstanceId: task.taskInstanceId,
    attemptId
  });
}

function createExecutionLease(before, task, attemptId) {
  const ownerId = `OWNER-${randomUUID()}`;
  const leaseId = `LEASE-${randomUUID()}`;
  const timestamp = operationalInstant();
  return Object.freeze({
    kind: 'sgos-execution-lease',
    leaseId,
    processId: before.processId,
    attemptId,
    taskInstanceId: task.taskInstanceId,
    ownerId,
    ownerPid: process.pid,
    ownerStartFingerprint: currentSgosExecutionOwnerFingerprint(),
    beforeProcessSha256: before.processSha256,
    beforeProcessRevision: before.processRevision,
    executionHandleSha256: executionHandle(before, task, attemptId),
    acquiredAt: timestamp,
    heartbeatAt: timestamp
  });
}

function createTaskResourceLease(before, task, template, attemptId, acquiredAt) {
  const duration = Math.min(
    24 * 60 * 60 * 1_000,
    Math.max(60_000, (template.timeoutMs ?? 15 * 60 * 1_000) + 60_000)
  );
  return createResourceLease({
    processId: before.processId,
    taskInstanceId: task.taskInstanceId,
    attemptId,
    resources: canonicalSgosResourceEntries(template.resources),
    acquiredAt,
    expiresAt: new Date(Date.parse(acquiredAt) + duration).toISOString()
  });
}

async function assertOwnedExecutionLease(root, context) {
  if (context.heartbeatError?.()) {
    const error = new SingularityFlowError('SGOS execution lease heartbeat could not be persisted.', {
      code: 'SGOS_EXECUTION_LEASE_LOST',
      details: { cause: context.heartbeatError().message ?? String(context.heartbeatError()) }
    });
    error.uncertainEffect = true;
    throw error;
  }
  const lease = await readSgosExecutionLease(
    root, context.begun.processId, context.executionLease.leaseId
  );
  if (!lease || lease.ownerId !== context.executionLease.ownerId
      || lease.attemptId !== context.attemptId || lease.ownerPid !== process.pid
      || lease.ownerStartFingerprint !== context.executionLease.ownerStartFingerprint) {
    const error = new SingularityFlowError('SGOS execution ownership was lost before publication.', {
      code: 'SGOS_EXECUTION_LEASE_LOST',
      details: {
        leaseId: context.executionLease.leaseId,
        leaseAvailable: lease != null,
        ownerMatches: lease?.ownerId === context.executionLease.ownerId,
        attemptMatches: lease?.attemptId === context.attemptId,
        processMatches: lease?.ownerPid === process.pid,
        processStartMatches: lease?.ownerStartFingerprint
          === context.executionLease.ownerStartFingerprint
      }
    });
    error.uncertainEffect = true;
    throw error;
  }
  if (!isSgosExecutionOwnerLive(lease)) {
    const error = new SingularityFlowError('SGOS execution owner is no longer live.', {
      code: 'SGOS_EXECUTION_LEASE_LOST',
      details: { leaseId: lease.leaseId, ownerId: lease.ownerId }
    });
    error.uncertainEffect = true;
    throw error;
  }
  return lease;
}

async function persistAttemptAndEvidence(root, {
  begun,
  before,
  task,
  template,
  attemptId,
  attemptNumber,
  status,
  rawResult,
  verification,
  outcome = {},
  evidenceContext = {},
  attemptReason = null,
  existingAttempt = null,
  executionHandleSha256 = null,
  preState = null,
  startedAt = null,
  completedAt
}) {
  const proposedAttempt = buildSgosTaskAttempt({
    attemptId,
    processId: begun.processId,
    taskInstanceId: task.taskInstanceId,
    attemptNumber,
    parentAttemptId: task.attemptIds.filter((id) => id !== attemptId).at(-1) ?? null,
    reason: attemptReason ?? (attemptNumber === 1 ? 'initial' : 'retry'),
    taskContractSha256: begun.taskContractSha256,
    executionHandleSha256: executionHandleSha256 ?? executionHandle(before, task, attemptId),
    status,
    startedAt,
    completedAt
  });
  if (existingAttempt != null && canonicalJson(existingAttempt) !== canonicalJson(proposedAttempt)) {
    fail('Existing terminal attempt does not exactly match the attempted replay.',
      'SGOS_RECORD_LINEAGE_INVALID', {
        attemptId,
        existingStatus: existingAttempt.status,
        proposedStatus: status
      });
  }
  const attempt = existingAttempt ?? proposedAttempt;
  const recordReservations = [];
  if (existingAttempt == null) {
    const publication = await putSgosImmutableRecord(
      root, begun.processId, 'gvm-task-attempt', attempt
    );
    if (publication.reservationToken != null) {
      recordReservations.push(publication.reservationToken);
    }
  }
  const evidence = compileSgosActionEvidence({
    processId: begun.processId,
    taskInstanceId: task.taskInstanceId,
    attemptId,
    principal: evidenceContext.principal ?? null,
    delegation: evidenceContext.delegation ?? null,
    programSha256: begun.programSha256,
    taskContractSha256: begun.taskContractSha256,
    executionUnitManifest: evidenceContext.executionUnitManifest ?? null,
    deviceManifest: evidenceContext.deviceManifest ?? null,
    arguments: template.operation ?? {},
    preState: preState ?? { processSha256: before.processSha256, processRevision: before.processRevision },
    rawResult,
    postState: outcome.candidateSnapshot?.candidateSha256
      ?? outcome.postState?.candidateSha256
      ?? outcome.candidate?.candidateSha256
      ?? outcome.postState
      ?? outcome.candidate
      ?? null,
    verification,
    cost: outcome.cost ?? evidenceContext.cost ?? null,
    latencyMs: outcome.latencyMs ?? 0,
    evidenceRefs: outcome.evidenceRefs ?? [],
    effectRefs: outcome.effectRefs ?? [],
    humanDecisionRefs: outcome.humanDecisionRefs ?? [],
    executionEvents: outcome.executionEvents ?? null,
    requiresExecutionUnit: template.opcode === 'AGENT',
    requiresDevice: template.opcode === 'DEVICE',
    createdAt: completedAt
  });
  const evidencePublication = await putSgosImmutableRecord(
    root, begun.processId, 'action-evidence', evidence
  );
  if (evidencePublication.reservationToken != null) {
    recordReservations.push(evidencePublication.reservationToken);
  }
  return { attempt, evidence, recordReservations };
}

async function finalizeFailure(root, context, error, program, clock) {
  const verification = { status: 'failed', findings: [{
    code: error?.code ?? 'SGOS_TASK_FAILED',
    detail: error?.message ?? String(error)
  }] };
  const completedAt = instant(clock);
  const rawResult = { status: 'failed', error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  const { attempt, evidence, recordReservations } = await persistAttemptAndEvidence(root, {
    ...context,
    status: 'failed',
    rawResult,
    verification,
    completedAt
  });
  const uncertain = error?.uncertainEffect === true
    || (context.template.resources?.externalEffects?.length ?? 0) > 0
    || (context.template.resources?.writes?.length ?? 0) > 0
    || (context.template.resources?.devices?.length ?? 0) > 0;
  const retryReady = !uncertain && context.attemptNumber < retryCeiling(context.template);
  const process = await mutateActiveAttemptWithRetry(root, context, (draft) => {
    const task = draft.taskInstances[context.task.taskInstanceId];
    task.state = uncertain ? 'recovery-required' : retryReady ? 'ready' : 'failed';
    task.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== context.attemptId);
    draft.activeLeases = draft.activeLeases.filter((id) => id !== context.executionLease.leaseId);
    updateReadinessAndStatus(draft, program);
  }, {
    updatedAt: completedAt,
    recordReservations: [
      ...(context.recordReservations ?? []),
      ...recordReservations,
      reservationOf(context.outcome?.candidateSnapshot ?? context.outcome?.candidate)
    ].filter(Boolean)
  });
  return Object.freeze({
    status: uncertain ? 'recovery-required' : retryReady ? 'retry-ready' : 'failed',
    taskInstanceId: context.task.taskInstanceId,
    process,
    attempt,
    evidence,
    error: Object.freeze({
      code: error?.code ?? 'SGOS_TASK_FAILED',
      message: error?.message ?? String(error),
      details: error?.details ?? null
    })
  });
}

function assertRequiredTaskEvidence(template, outcome) {
  const evidence = template.evidence ?? {};
  const required = Array.isArray(evidence) ? evidence : (evidence.required ?? evidence.requiredEvidence ?? []);
  if (!Array.isArray(required)) {
    fail(`Task '${template.taskTemplateId}' has a malformed required-evidence contract.`, 'SGOS_REQUIRED_EVIDENCE_INVALID');
  }
  const external = new Set(outcome.evidenceRefs ?? []);
  for (const requirement of required) {
    if (typeof requirement !== 'string' || !requirement.trim()) {
      fail(`Task '${template.taskTemplateId}' has an unsupported required-evidence entry.`, 'SGOS_REQUIRED_EVIDENCE_INVALID');
    }
    const normalized = requirement.trim().toLowerCase();
    if (RUNTIME_EVIDENCE_KINDS.has(normalized)) continue;
    if (SHA256.test(requirement) && external.has(requirement)) continue;
    fail(`Task '${template.taskTemplateId}' required evidence '${requirement}' is unavailable.`,
      'SGOS_REQUIRED_EVIDENCE_UNAVAILABLE', { taskTemplateId: template.taskTemplateId, requirement });
  }
}

async function finalizeSuccess(root, context, outcome, program, clock, checkpoint = null) {
  try {
    await assertOwnedExecutionLease(root, context);
    await assertCurrentStoredProcessBinding(root, context.begun);
  } catch (error) {
    if (error?.code === 'SGOS_PROCESS_BINDING_STALE') error.uncertainEffect = true;
    return finalizeFailure(root, { ...context, outcome }, error, program, clock);
  }
  const candidateReservation = reservationOf(outcome.candidateSnapshot);
  let candidate;
  try { candidate = validateCandidateSnapshot(outcome.candidateSnapshot); } catch {
    const error = new SingularityFlowError('Task success has no immutable contract-valid Candidate Snapshot.', {
      code: 'SGOS_CANDIDATE_REQUIRED'
    });
    return finalizeFailure(root, { ...context, outcome }, error, program, clock);
  }
  const verification = clone(outcome.verification ?? { status: 'unavailable' });
  if (verification.status !== 'passed' || !SHA256.test(String(verification.checksSha256 ?? ''))) {
    const error = new SingularityFlowError('Task result did not pass deterministic verification.', {
      code: 'SGOS_TASK_VERIFICATION_FAILED'
    });
    return finalizeFailure(root, { ...context, outcome }, error, program, clock);
  }
  try { assertRequiredTaskEvidence(context.template, outcome); } catch (error) {
    return finalizeFailure(root, { ...context, outcome }, error, program, clock);
  }
  const completedAt = instant(clock);
  const { attempt, evidence, recordReservations } = await persistAttemptAndEvidence(root, {
    ...context,
    status: 'succeeded',
    rawResult: outcome.rawResult ?? outcome,
    verification,
    outcome,
    completedAt
  });
  const evidenceRefs = [...new Set([
    ...(outcome.evidenceRefs ?? []), candidate.candidateSha256, evidence.evidenceSha256
  ])].sort();
  const outputRefs = [...new Set(outcome.outputRefs ?? [])].sort();
  const receipt = buildSgosTaskReceipt({
    processId: context.begun.processId,
    taskInstanceId: context.task.taskInstanceId,
    attemptId: context.attemptId,
    attemptSha256: attempt.attemptSha256,
    inputRefs: context.task.inputRefs,
    outputRefs,
    candidateSha256: candidate.candidateSha256,
    candidate,
    evidenceRefs,
    effectRefs: outcome.effectRefs ?? [],
    humanDecisionRefs: outcome.humanDecisionRefs ?? [],
    verification,
    completedAt
  });
  // The receipt crosses the immutable boundary before the mutable process can say `succeeded`.
  const receiptPublication = await putSgosImmutableRecord(
    root, context.begun.processId, 'gvm-task-receipt', receipt
  );
  const process = await mutateActiveAttemptWithRetry(root, context, (draft) => {
    const task = draft.taskInstances[context.task.taskInstanceId];
    task.state = 'succeeded';
    task.outputRefs = outputRefs;
    task.receiptSha256 = receipt.receiptSha256;
    task.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== context.attemptId);
    draft.activeLeases = draft.activeLeases.filter((id) => id !== context.executionLease.leaseId);
    if (checkpoint) draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
    updateReadinessAndStatus(draft, program);
  }, {
    updatedAt: completedAt,
    recordReservations: [
      ...(context.recordReservations ?? []),
      ...recordReservations,
      candidateReservation,
      receiptPublication.reservationToken
    ].filter(Boolean)
  });
  return Object.freeze({ status: 'succeeded', taskInstanceId: context.task.taskInstanceId, process, attempt, receipt, evidence, checkpoint });
}

function allOtherTasksTerminal(process, taskInstanceId) {
  return Object.values(process.taskInstances)
    .filter((task) => task.taskInstanceId !== taskInstanceId)
    .every((task) => isSgosTerminalTaskState(task.state));
}

function isSgosTransitionRecoveryError(error) {
  return [
    'SGOS_TRANSITION_RECOVERED_RETRY',
    'SGOS_TRANSITION_RECOVERY_REQUIRED'
  ].includes(error?.code);
}

/**
 * Execute at most one ready task, selected canonically.
 *
 * @internal Raw adapter injection is an interpreter test seam. Supported callers use
 * `stepSgosProcess`, which constructs the closed installed adapter registry.
 */
export async function runNextSgosTask(root, processId, {
  program: suppliedProgram = null,
  expectedRevision = null,
  handlers = {},
  captureCandidates = {},
  verifiers = {},
  evidenceContext = {},
  allowConcurrent = false,
  preferredTaskInstanceId = null,
  maximumParallel = 1,
  clock = null
} = {}) {
  await assertSafeSgosSidecar(root, processId);
  await settlePendingTransitionBeforeMutation(root, processId, 'step');
  await reconcileSgosExecutionLeases(root, processId);
  const before = await readSgosProcess(root, processId);
  await assertCurrentStoredProcessBinding(root, before);
  const program = await resolveProgram(root, before, suppliedProgram);
  if (expectedRevision != null && before.processRevision !== expectedRevision) {
    fail(`SGOS process '${processId}' changed before dispatch.`, 'SGOS_PROCESS_REVISION_STALE', {
      expectedRevision, actualRevision: before.processRevision
    });
  }
  if (before.activeExecutions.length && !allowConcurrent) {
    fail('An interrupted execution must be reconciled before dispatch can continue.', 'SGOS_EXECUTION_RECOVERY_REQUIRED');
  }
  if (['paused', 'blocked', 'failed', 'cancelled', 'succeeded', 'recovery-required'].includes(before.status)) {
    fail(`SGOS process '${processId}' is ${before.status}; it cannot dispatch.`, 'SGOS_PROCESS_NOT_RUNNABLE');
  }
  const ready = deterministicSgosDispatchPlan(program, before, {
    maximumParallel: allowConcurrent ? maximumParallel : 1
  });
  if (!ready.length) return Object.freeze({ status: before.status, taskInstanceId: null, process: before });
  const selected = preferredTaskInstanceId == null
    ? ready[0]
    : ready.find((entry) => entry.taskInstanceId === preferredTaskInstanceId);
  if (!selected) {
    return Object.freeze({
      status: 'not-ready', taskInstanceId: preferredTaskInstanceId, process: before
    });
  }
  const task = before.taskInstances[selected.taskInstanceId];
  const template = templateById(program).get(task.taskTemplateId);
  const maximumAttempts = retryCeiling(template);
  if (task.attemptIds.length >= maximumAttempts) {
    return blockTask(root, before, task, {
      code: 'SGOS_TASK_ATTEMPT_CEILING_REACHED',
      message: `Task '${task.taskTemplateId}' exhausted its ${maximumAttempts} declared attempt(s).`
    }, clock);
  }
  if (!SGOS_SEQUENTIAL_OPCODES.includes(template.opcode)) {
    return blockTask(root, before, task, blockedOpcodeReason(template.opcode), clock);
  }
  const handlerKind = template.opcode === 'KERNEL' ? 'kernel' : template.opcode === 'VERIFY' ? 'verify' : null;
  if (handlerKind && !operationHandler(handlers, handlerKind, template)) {
    return Object.freeze({ status: 'unavailable', reason: Object.freeze({
      code: `SGOS_${template.opcode}_HANDLER_REQUIRED`,
      message: `${template.opcode} '${template.operation ?? task.taskTemplateId}' has no governed handler.`
    }), taskInstanceId: task.taskInstanceId, process: before });
  }
  if (template.opcode === 'END' && !allOtherTasksTerminal(before, task.taskInstanceId)) {
    return blockTask(root, before, task, {
      code: 'SGOS_END_PREMATURE',
      message: 'END cannot run while another task is non-terminal.'
    }, clock);
  }

  const attemptNumber = task.attemptIds.length + 1;
  const attemptId = stableId('ATT', {
    processId: before.processId,
    taskInstanceId: task.taskInstanceId,
    attemptNumber
  });
  const pendingRunningAttempt = await readSgosPendingReservedRecordByField(
    root, before.processId, 'gvm-task-attempt', 'attemptId', attemptId
  );
  const startedAt = pendingRunningAttempt?.startedAt ?? instant(clock);
  const executionLeaseSeed = createExecutionLease(before, task, attemptId);
  const runningAttempt = pendingRunningAttempt ?? buildSgosTaskAttempt({
    attemptId,
    processId: before.processId,
    taskInstanceId: task.taskInstanceId,
    attemptNumber,
    parentAttemptId: task.attemptIds.at(-1) ?? null,
    reason: attemptNumber === 1 ? 'initial' : 'retry',
    taskContractSha256: before.taskContractSha256,
    executionHandleSha256: executionLeaseSeed.executionHandleSha256,
    status: 'running',
    startedAt,
    completedAt: null
  });
  if (runningAttempt.processId !== before.processId
      || runningAttempt.taskInstanceId !== task.taskInstanceId
      || runningAttempt.attemptNumber !== attemptNumber
      || runningAttempt.parentAttemptId !== (task.attemptIds.at(-1) ?? null)
      || runningAttempt.taskContractSha256 !== before.taskContractSha256
      || runningAttempt.executionHandleSha256 !== executionLeaseSeed.executionHandleSha256
      || runningAttempt.status !== 'running' || runningAttempt.completedAt !== null) {
    throw new SingularityFlowError('Pending SGOS attempt intent does not match the exact retry boundary.', {
      code: 'SGOS_RECORD_LINEAGE_INVALID',
      details: { attemptId }
    });
  }
  const executionLease = Object.freeze({
    ...executionLeaseSeed,
    attemptSha256: runningAttempt.attemptSha256
  });
  const resourceLease = createTaskResourceLease(
    before, task, template, attemptId, startedAt
  );
  registerSgosExecutionOwner(executionLease);
  let begun;
  try {
    begun = await mutateSgosProcess(root, before.processId, async (draft, current) => {
      const admissible = deterministicSgosDispatchPlan(program, current, {
        maximumParallel: allowConcurrent ? maximumParallel : 1
      }).some((entry) => entry.taskInstanceId === task.taskInstanceId);
      if (!admissible) {
        fail(`Task '${task.taskInstanceId}' no longer has a compatible resource lease.`,
          'SGOS_RESOURCE_LEASE_CONFLICT', { taskInstanceId: task.taskInstanceId });
      }
      // Lease, exact running-attempt intent, and active-state CAS share the Process lock. Competing
      // dispatchers therefore cannot publish divergent records for the same stable attemptId.
      await writeSgosExecutionLease(root, before.processId, executionLease);
      await putSgosImmutableRecord(root, before.processId, 'gvm-task-attempt', runningAttempt);
      await putSgosImmutableRecord(root, before.processId, 'resource-lease', resourceLease);
      const target = draft.taskInstances[task.taskInstanceId];
      target.state = template.opcode === 'VERIFY' ? 'verifying' : 'running';
      target.attemptIds = [...target.attemptIds, attemptId];
      target.revision += 1;
      draft.activeExecutions = [...draft.activeExecutions, attemptId];
      draft.activeLeases = [...draft.activeLeases, executionLease.leaseId];
      draft.status = 'running';
    }, {
      expectedRevision: before.processRevision,
      expectedProcessSha256: before.processSha256,
      updatedAt: startedAt
    });
  } catch (error) {
    unregisterSgosExecutionOwner(executionLease);
    await removeSgosExecutionLeaseIfUnreferenced(root, before.processId, executionLease);
    throw error;
  }
  let heartbeatError = null;
  let heartbeatPromise = Promise.resolve();
  let lastLease = executionLease;
  const heartbeat = setInterval(() => {
    heartbeatPromise = heartbeatPromise.then(async () => {
      lastLease = { ...lastLease, heartbeatAt: operationalInstant() };
      await writeSgosExecutionLease(root, before.processId, lastLease);
    }).catch((error) => { heartbeatError = error; });
  }, EXECUTION_LEASE_HEARTBEAT_MS);
  heartbeat.unref?.();
  const context = {
    begun,
    before,
    task: { ...task, attemptId },
    template,
    attemptId,
    attemptNumber,
    startedAt,
    executionLease,
    resourceLease,
    heartbeatError: () => heartbeatError,
    evidenceContext,
    handlers,
    handlerKind
  };

  try {
    context.recordReservations = [];
    await assertOwnedExecutionLease(root, context);
    if (template.opcode === 'HUMAN_REQUEST') {
      const request = humanRequestFor(before, task, template, attemptId, instant(clock));
      return await finalizeHumanRequest(
        root, begun, context.task, request, program, clock, executionLease,
        context.recordReservations
      );
    }
    if (template.opcode === 'CHECKPOINT') {
      const checkpoint = buildCheckpoint(before, program, {
        priorCheckpointSha256: before.currentCheckpointSha256,
        createdAt: instant(clock)
      });
      const checkpointPublication = await putSgosImmutableRecord(
        root, before.processId, 'gvm-checkpoint', checkpoint
      );
      if (checkpointPublication.reservationToken != null) {
        context.recordReservations.push(checkpointPublication.reservationToken);
      }
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        outputRefs: [checkpoint.checkpointSha256],
        rawResult: { status: 'completed', checkpointSha256: checkpoint.checkpointSha256 }
      }, 'kernel-checkpoint-integrity', instant(clock));
      return await finalizeSuccess(root, context, outcome, program, clock, checkpoint);
    }
    if (template.opcode === 'NOOP') {
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        rawResult: { status: 'completed', opcode: 'NOOP' }
      }, 'kernel-noop', instant(clock));
      return await finalizeSuccess(root, context, outcome, program, clock);
    }
    if (template.opcode === 'JOIN') {
      const join = sgosJoinForTask(program, template.taskTemplateId);
      if (!join) {
        fail(`JOIN task '${template.taskTemplateId}' has no installed join contract.`,
          'SGOS_JOIN_CONTRACT_MISSING');
      }
      // The dispatch CAS proved this exact join was ready. Re-read the immutable predecessor
      // identities from the begun Process so concurrent unrelated completions cannot alter the
      // receipt bytes or make completion timing an input to deterministic lineage.
      const predecessors = task.predecessorTaskInstanceIds.map((taskInstanceId) => {
        const predecessor = begun.taskInstances[taskInstanceId];
        if (!predecessor) {
          fail(`JOIN predecessor '${taskInstanceId}' is missing.`, 'SGOS_JOIN_CONTRACT_MISMATCH');
        }
        return {
          taskInstanceId,
          state: predecessor.state,
          receiptSha256: predecessor.receiptSha256,
          attemptId: predecessor.attemptIds.at(-1) ?? null
        };
      });
      const joinReceipt = createJoinReceipt({
        processId: begun.processId,
        taskInstanceId: task.taskInstanceId,
        attemptId,
        joinId: join.joinId,
        policy: join.policy,
        predecessors,
        outputRefs: predecessors.flatMap((entry) => {
          const predecessor = begun.taskInstances[entry.taskInstanceId];
          return predecessor?.outputRefs ?? [];
        }),
        completedAt: instant(clock)
      });
      const publication = await putSgosImmutableRecord(
        root, begun.processId, 'join-receipt', joinReceipt
      );
      if (publication.reservationToken != null) {
        context.recordReservations.push(publication.reservationToken);
      }
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        outputRefs: [joinReceipt.joinReceiptSha256, ...joinReceipt.outputRefs],
        evidenceRefs: [joinReceipt.joinReceiptSha256],
        rawResult: {
          status: 'completed', opcode: 'JOIN', joinReceiptSha256: joinReceipt.joinReceiptSha256
        }
      }, 'kernel-join-integrity', instant(clock));
      const result = await finalizeSuccess(root, context, outcome, program, clock);
      return Object.freeze({ ...result, joinReceipt });
    }
    if (template.opcode === 'END') {
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        rawResult: { status: 'completed', opcode: 'END' }
      }, 'kernel-terminal-condition', instant(clock));
      return await finalizeSuccess(root, context, outcome, program, clock);
    }
    const handler = operationHandler(handlers, handlerKind, template);
    const rawOutcome = await invokeHandlerWithTimeout(handler, {
      process: clone(before),
      task: clone(task),
      template: clone(template),
      attemptId,
      programSha256: program.programSha256,
      policySnapshotSha256: program.policySnapshotSha256
    }, template.timeoutMs ?? null);
    const outcome = await trustedHandlerOutcome(
      root, begun, context, rawOutcome, captureCandidates, verifiers, instant(clock)
    );
    return await finalizeSuccess(root, context, outcome ?? {}, program, clock);
  } catch (error) {
    if (isSgosTransitionRecoveryError(error)) throw error;
    const pendingTerminalAttempt = await readSgosPendingReservedRecordByField(
      root, before.processId, 'gvm-task-attempt', 'attemptId', attemptId
    );
    if (pendingTerminalAttempt != null && pendingTerminalAttempt.status !== 'running') {
      fail('A terminal SGOS attempt is already durable, but its exact final Process transition did not complete. Recover that immutable terminal lineage before retrying execution.',
        'SGOS_EXECUTION_FINALIZATION_RECOVERY_REQUIRED', {
          attemptId,
          attemptSha256: pendingTerminalAttempt.attemptSha256,
          status: pendingTerminalAttempt.status,
          causeCode: error?.code ?? null
        });
    }
    return await finalizeFailure(root, context, error, program, clock);
  } finally {
    clearInterval(heartbeat);
    await heartbeatPromise;
    unregisterSgosExecutionOwner(executionLease);
    await removeSgosExecutionLeaseIfUnreferenced(root, before.processId, executionLease);
  }
}

/** Execute one canonical step using only installed, manifest-checked adapters. */
export async function stepSgosProcess(root, processId, options = {}) {
  ownKeysOnly(options, ['program', 'expectedRevision'], 'SGOS step options', 'SGOS_STEP_OPTIONS_INVALID');
  return runNextSgosTask(root, processId, {
    program: options.program ?? null,
    expectedRevision: options.expectedRevision ?? null,
    ...createSgosBuiltinAdapters(root)
  });
}

async function dispatchOneParallelTask(root, processId, taskInstanceId, options) {
  const maximumRetries = SGOS_INSTALLED_LIMITS.maximumExecutionLeases + 2;
  for (let retry = 0; retry < maximumRetries; retry += 1) {
    try {
      return await runNextSgosTask(root, processId, {
        ...options,
        expectedRevision: null,
        allowConcurrent: true,
        preferredTaskInstanceId: taskInstanceId
      });
    } catch (error) {
      // A sibling may win the begin-transition CAS. Retrying is safe here because no handler can
      // run until that begin is durable. Terminal CAS retries happen inside runNextSgosTask and
      // never re-invoke a handler.
      if (error?.code !== 'SGOS_PROCESS_REVISION_STALE') throw error;
    }
  }
  fail(`Parallel dispatch of '${taskInstanceId}' exceeded its bounded begin-CAS retry limit.`,
    'SGOS_PROCESS_REVISION_STALE', { taskInstanceId });
}

/**
 * Dispatch one deterministic compatible ready-set and wait for every launched task to quiesce.
 * This is deliberately one wave, not an unbounded run-to-completion loop.
 *
 * @internal Raw adapter injection remains an interpreter test seam. Public callers use
 * public-runtime.mjs, which supplies only the installed adapter registry.
 */
export async function runReadySgosTasks(root, processId, {
  program: suppliedProgram = null,
  expectedRevision = null,
  maximumParallel = 1,
  handlers = {},
  captureCandidates = {},
  verifiers = {},
  evidenceContext = {},
  clock = null
} = {}) {
  if (!Number.isSafeInteger(maximumParallel) || maximumParallel < 1
      || maximumParallel > SGOS_INSTALLED_LIMITS.maximumParallelExecutions) {
    fail('maximumParallel is outside the installed execution bound.', 'SGOS_PARALLEL_LIMIT', {
      maximumParallel, installed: SGOS_INSTALLED_LIMITS.maximumParallelExecutions
    });
  }
  await assertSafeSgosSidecar(root, processId);
  await settlePendingTransitionBeforeMutation(root, processId, 'run');
  await reconcileSgosExecutionLeases(root, processId);
  const before = await readSgosProcess(root, processId);
  await assertCurrentStoredProcessBinding(root, before);
  if (expectedRevision != null && before.processRevision !== expectedRevision) {
    fail(`SGOS process '${processId}' changed before dispatch.`, 'SGOS_PROCESS_REVISION_STALE', {
      expectedRevision, actualRevision: before.processRevision
    });
  }
  if (before.activeExecutions.length) {
    fail('An interrupted execution must be reconciled before a parallel wave can begin.',
      'SGOS_EXECUTION_RECOVERY_REQUIRED');
  }
  const program = await resolveProgram(root, before, suppliedProgram);
  const plan = deterministicSgosDispatchPlan(program, before, { maximumParallel });
  if (!plan.length) {
    return Object.freeze({
      status: before.status, launched: 0, taskInstanceIds: [], results: [], process: before
    });
  }
  const options = {
    program,
    maximumParallel,
    handlers,
    captureCandidates,
    verifiers,
    evidenceContext,
    clock
  };
  const settled = await Promise.allSettled(plan.map((entry) =>
    dispatchOneParallelTask(root, processId, entry.taskInstanceId, options)));
  const rejection = settled.find((entry) => entry.status === 'rejected');
  if (rejection) throw rejection.reason;
  const process = await readSgosProcess(root, processId);
  return Object.freeze({
    status: process.status,
    launched: plan.length,
    taskInstanceIds: Object.freeze(plan.map((entry) => entry.taskInstanceId)),
    results: Object.freeze(settled.map((entry) => entry.value)),
    process
  });
}

/** Execute one deterministic parallel wave using only installed, manifest-checked adapters. */
export async function runSgosProcess(root, processId, options = {}) {
  ownKeysOnly(options, ['program', 'expectedRevision', 'maximumParallel'],
    'SGOS run options', 'SGOS_RUN_OPTIONS_INVALID');
  return runReadySgosTasks(root, processId, {
    program: options.program ?? null,
    expectedRevision: options.expectedRevision ?? null,
    maximumParallel: options.maximumParallel ?? 1,
    ...createSgosBuiltinAdapters(root)
  });
}

function durablePrincipal(actor, authoritySha256 = null) {
  const principal = { id: actor?.id, kind: actor?.kind };
  for (const field of ['name', 'email']) {
    if (actor?.[field] != null) principal[field] = actor[field];
  }
  if (authoritySha256 != null) principal.authoritySha256 = authoritySha256;
  return principal;
}

async function resolveResponseAuthority(request, actor, authorities) {
  if (typeof actor?.id !== 'string' || !actor.id || typeof actor?.kind !== 'string' || !actor.kind) {
    fail('Human Request response requires a typed principal.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  if (!['human', 'service', 'agent', 'system', 'external'].includes(actor.kind)) {
    fail('Human Request actor kind is not a contract principal kind.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  const required = request.authorityRequired;
  const assertion = (authorities ?? []).find((entry) =>
    entry.principalId === actor.id
    && entry.principalKind === actor.kind
    && entry.kind === required.kind
    && entry.id === required.id) ?? null;
  if (assertion == null
      || assertion.principalId !== actor.id
      || assertion.principalKind !== actor.kind
      || assertion.kind !== required.kind
      || assertion.id !== required.id) {
    fail('Actor has no trusted binding for the required authority kind and id.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  // The contract does not define a global ordering across assurance vocabularies. Exact matching is
  // intentionally conservative: a resolver may translate provider-specific levels before return.
  if (required.minimumAssurance != null && assertion.assurance !== required.minimumAssurance) {
    fail('Trusted authority assertion does not meet the exact minimum-assurance vocabulary.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  if (required.authoritySha256 != null && assertion.authoritySha256 !== required.authoritySha256) {
    fail('Trusted authority assertion does not match the authority pinned by the request.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  requireSha256('trusted authoritySha256', assertion.authoritySha256);
  return assertion;
}

const JSON_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'enum', 'const', 'required',
  'properties', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'allOf', 'anyOf', 'oneOf', 'not'
]);

function jsonEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function assertJsonSchemaValue(schema, value, location = '$') {
  ownKeysOnly(schema, [...JSON_SCHEMA_KEYWORDS], `Human Request inputSchema at ${location}`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
  const types = Array.isArray(schema.type) ? schema.type : schema.type == null ? null : [schema.type];
  if (types != null) {
    if (!types.length || types.some((entry) => !['null', 'boolean', 'string', 'number', 'integer', 'array', 'object'].includes(entry))) {
      fail(`Human Request inputSchema has an unsupported type at ${location}.`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
    }
    if (!types.some((type) => schemaTypeMatches(value, type))) {
      fail(`Human response input does not match schema type at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    fail(`Human response input does not match schema const at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
  }
  if (schema.enum != null) {
    if (!Array.isArray(schema.enum) || !schema.enum.some((entry) => jsonEqual(value, entry))) {
      fail(`Human response input is not in schema enum at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] == null) continue;
    if (!Array.isArray(schema[keyword]) || !schema[keyword].length) {
      fail(`Human Request inputSchema ${keyword} must be a non-empty array.`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
    }
    let matches = 0;
    for (const entry of schema[keyword]) {
      try { assertJsonSchemaValue(entry, value, location); matches += 1; } catch (error) {
        if (!['SGOS_HUMAN_RESPONSE_INPUT_INVALID'].includes(error?.code)) throw error;
      }
    }
    if ((keyword === 'allOf' && matches !== schema[keyword].length)
        || (keyword === 'anyOf' && matches === 0)
        || (keyword === 'oneOf' && matches !== 1)) {
      fail(`Human response input does not satisfy schema ${keyword} at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
  }
  if (schema.not != null) {
    let matched = true;
    try { assertJsonSchemaValue(schema.not, value, location); } catch (error) {
      if (error?.code === 'SGOS_HUMAN_RESPONSE_INPUT_INVALID') matched = false;
      else throw error;
    }
    if (matched) fail(`Human response input matches forbidden schema at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) fail(`Human response string is too short at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.maxLength != null && value.length > schema.maxLength) fail(`Human response string is too long at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.pattern != null) {
      let pattern;
      try { pattern = new RegExp(schema.pattern, 'u'); } catch {
        fail(`Human Request inputSchema has an invalid pattern at ${location}.`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
      }
      if (!pattern.test(value)) fail(`Human response string does not match schema at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum != null && value < schema.minimum) fail(`Human response number is below minimum at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.maximum != null && value > schema.maximum) fail(`Human response number is above maximum at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) fail(`Human response number is below exclusiveMinimum at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.exclusiveMaximum != null && value >= schema.exclusiveMaximum) fail(`Human response number is above exclusiveMaximum at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) fail(`Human response array is too short at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.maxItems != null && value.length > schema.maxItems) fail(`Human response array is too long at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    if (schema.items != null) value.forEach((entry, index) => assertJsonSchemaValue(schema.items, entry, `${location}[${index}]`));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
      fail(`Human Request inputSchema properties must be an object at ${location}.`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
    }
    if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
      fail(`Human Request inputSchema required must be a string array at ${location}.`, 'SGOS_HUMAN_INPUT_SCHEMA_UNSUPPORTED');
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) fail(`Human response is missing required input '${key}' at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) assertJsonSchemaValue(properties[key], entry, `${location}.${key}`);
      else if (schema.additionalProperties === false) fail(`Human response contains unknown input '${key}' at ${location}.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        assertJsonSchemaValue(schema.additionalProperties, entry, `${location}.${key}`);
      }
    }
  }
}

function validateSensitiveHandle(request, input) {
  if (request.sensitiveMode === 'none') return;
  if (request.sensitiveMode === 'external-url') {
    ownKeysOnly(input, ['kind', 'url', 'referenceSha256'], 'External sensitive handle', 'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED');
    if (input.kind !== 'external-url' || input.url !== request.externalUrl) {
      fail('Sensitive response must be an exact handle to the declared external URL.', 'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED');
    }
    requireSha256('sensitive referenceSha256', input.referenceSha256);
    return;
  }
  ownKeysOnly(input, ['kind', 'broker', 'handle', 'referenceSha256'], 'Secret-broker handle', 'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED');
  if (input.kind !== 'secret-broker' || input.broker !== request.secretBroker
      || typeof input.handle !== 'string' || !input.handle) {
    fail('Sensitive response must be a typed handle to the declared secret broker.', 'SGOS_HUMAN_RESPONSE_SENSITIVE_VALUE_REFUSED');
  }
  requireSha256('sensitive referenceSha256', input.referenceSha256);
}

function validateHumanDecision(request, decision, input) {
  if (!HUMAN_DECISIONS_BY_REQUEST[request.requestType]?.has(decision)) {
    fail(`Decision '${decision}' is not valid for Human Request type '${request.requestType}'.`, 'SGOS_HUMAN_RESPONSE_INVALID');
  }
  if (decision === 'selected') {
    const selected = input?.optionId ?? input?.option ?? input?.id;
    if (typeof selected !== 'string' || !request.options.some((option) => option.id === selected)) {
      fail('Selected Human Request response must name one of the exact request options.', 'SGOS_HUMAN_RESPONSE_INVALID');
    }
  } else if (decision === 'provided') {
    if (request.inputSchema == null || input == null) {
      fail('A provided Human response requires non-null input and an explicit inputSchema.', 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
    }
  } else if (input != null) {
    fail(`Decision '${decision}' cannot carry untyped input.`, 'SGOS_HUMAN_RESPONSE_INPUT_INVALID');
  }
  validateSensitiveHandle(request, input);
  if (request.inputSchema != null && input != null) assertJsonSchemaValue(request.inputSchema, input);
}

async function openRequestById(root, process, requestId) {
  for (const sha256 of process.openHumanRequests) {
    const { record } = await readSgosImmutableRecord(root, process.processId, 'human-request', sha256);
    if (record.requestId === requestId) return record;
  }
  return null;
}

/** Compare-and-swap a typed response against the exact request, checkpoint, task, and policy. */
export async function respondToSgosHumanRequest(root, processId, options = {}) {
  if (Object.hasOwn(options, 'authorityResolver') || Object.hasOwn(options, 'authorize')) {
    fail('Caller-supplied Human authority resolvers are not accepted; SGOS uses only the approved authority pinned at Process start.',
      'SGOS_AUTHORITY_SELF_CLAIM_REFUSED');
  }
  const {
    requestId,
    requestSha256,
    expectedRevision,
    actor,
    decision,
    input = null,
    program: suppliedProgram = null,
    clock = null
  } = options;
  await assertSafeSgosSidecar(root, processId);
  await settlePendingTransitionBeforeMutation(root, processId, 'respond');
  if (!Number.isInteger(expectedRevision)) fail('Human response requires expectedRevision.', 'SGOS_PROCESS_REVISION_REQUIRED');
  if (!HUMAN_DECISIONS.has(decision)) fail(`Unknown Human Request decision '${decision}'.`, 'SGOS_HUMAN_RESPONSE_INVALID');
  const process = await readSgosProcess(root, processId);
  await assertCurrentStoredProcessBinding(root, process);
  if (process.processRevision !== expectedRevision) {
    fail('Human Request response is stale because the Process revision changed.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const program = await resolveProgram(root, process, suppliedProgram);
  // Persisted Human assertions are a cache, not authority. Recompute membership from the exact
  // approved configuration that resolveProgram just refreshed, require byte-for-byte agreement
  // with the immutable Process binding, and authorize from the fresh proof.
  const freshHumanAuthority = await loadApprovedSgosHumanAuthorityContext(root, program, {
    refreshAuthority: false
  });
  if (canonicalJson(freshHumanAuthority.configurationAuthority)
        !== canonicalJson(process.authorityBinding?.configurationAuthority ?? null)
      || canonicalJson(freshHumanAuthority.humanAuthorityRequirements)
        !== canonicalJson(process.authorityBinding?.humanAuthorityRequirements ?? [])) {
    fail('Pinned Human authority no longer matches the exact approved configuration.',
      'SGOS_HUMAN_AUTHORITY_BINDING_INVALID', { processId: process.processId });
  }
  const request = await openRequestById(root, process, requestId);
  if (!request || request.requestSha256 !== requestSha256) {
    fail('Human Request is no longer open or its exact hash does not match.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const task = process.taskInstances[request.taskInstanceId];
  if (!task || task.state !== 'waiting-human'
      || request.checkpointSha256 !== process.currentCheckpointSha256
      || request.policySnapshotSha256 !== process.policySnapshotSha256
      || canonicalJson(request.configurationAuthority)
        !== canonicalJson(process.authorityBinding?.configurationAuthority ?? null)
      || request.subjectSha256 !== taskSubjectSha256(process, task)) {
    fail('Human Request subject, policy, checkpoint, or task state is stale.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const observedActor = currentSgosHumanActor(root, actor);
  const trustedAuthority = await resolveResponseAuthority(
    request, observedActor, freshHumanAuthority.humanAuthorities
  );
  validateHumanDecision(request, decision, input);
  const responseActor = durablePrincipal(observedActor, trustedAuthority.authoritySha256);
  const priorResponses = await listSgosImmutableRecordsByField(
    root, process.processId, 'human-response', 'requestSha256', requestSha256
  );
  if (priorResponses.length > 1) {
    fail('Human Request has ambiguous immutable response lineage.', 'SGOS_RECORD_LINEAGE_INVALID');
  }
  const priorResponse = priorResponses[0] ?? null;
  // Authorization time is runtime-owned. A caller-injected test clock must never make an expired
  // request answerable; a prior immutable response retains its original durable timestamp.
  const authorizationAt = operationalInstant();
  if (request.expiresAt != null && Date.parse(authorizationAt) >= Date.parse(request.expiresAt)) {
    fail('Human Request has expired and cannot be answered.', 'SGOS_HUMAN_REQUEST_EXPIRED');
  }
  const respondedAt = priorResponse?.respondedAt ?? authorizationAt;
  const responseIdentity = {
    requestSha256,
    actor: responseActor,
    decision,
    input: clone(input)
  };
  const proposedResponse = sealSgosImmutableRecord('human-response', {
    schemaVersion: currentSchemaVersion('human-response'),
    kind: 'human-response',
    responseId: stableId('HRS', responseIdentity),
    requestSha256,
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    actor: responseActor,
    decision,
    input: clone(input),
    respondedAt
  });
  if (priorResponse && canonicalJson(priorResponse) !== canonicalJson(proposedResponse)) {
    fail('Human Request already has a different immutable response.',
      'SGOS_HUMAN_REQUEST_ALREADY_RESPONDED', {
        requestSha256,
        responseSha256: priorResponse.responseSha256
      });
  }
  const response = priorResponse ?? proposedResponse;
  const attemptId = task.attemptIds.at(-1);
  const attemptNumber = task.attemptIds.length;
  const attemptLineage = await listSgosImmutableRecordsByField(
    root, process.processId, 'gvm-task-attempt', 'attemptId', attemptId
  );
  const runningAttempt = attemptLineage.find((record) => record.status === 'running');
  const terminalAttempts = attemptLineage.filter((record) => record.status !== 'running');
  if (!runningAttempt || attemptLineage.filter((record) => record.status === 'running').length !== 1
      || terminalAttempts.length > 1) {
    fail('Human Request attempt lineage is missing or ambiguous.', 'SGOS_RECORD_LINEAGE_INVALID');
  }
  const template = templateById(program).get(task.taskTemplateId);
  const context = {
    begun: process,
    before: process,
    task,
    template,
    attemptId,
    attemptNumber,
    evidenceContext: { principal: responseActor }
  };
  const accepted = ['approved', 'provided', 'selected'].includes(decision);
  const taskOutcome = accepted ? 'succeeded' : decision === 'cancelled' ? 'cancelled' : 'failed';
  const terminalAttempt = terminalAttempts[0] ?? null;
  if (terminalAttempt && terminalAttempt.status !== taskOutcome) {
    fail('Human Request terminal attempt conflicts with its immutable response.',
      'SGOS_RECORD_LINEAGE_INVALID');
  }
  let candidate;
  let verification;
  let attempt;
  let evidence;
  let receipt;
  // Hold the Process CAS lock while publishing every immutable response record.  Concurrent
  // responders must not be able to create divergent terminal lineage for one attemptId before
  // one of their final CAS operations loses.
  const next = await mutateSgosProcess(root, process.processId, async (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    if (target.state !== 'waiting-human' || !draft.openHumanRequests.includes(request.requestSha256)) {
      fail('Human Request changed before its response committed.', 'SGOS_HUMAN_REQUEST_STALE');
    }
    await putSgosImmutableRecord(root, process.processId, 'human-response', response);
    candidate = await createAndReloadCandidate(root, process, {
      resources: [],
      createdBy: {
        ...responseActor,
        name: responseActor.name ?? `SGOS response ${attemptId}`
      },
      createdAt: respondedAt
    });
    verification = boundVerification({
      method: 'typed-human-response-cas',
      candidate,
      task,
      programSha256: process.programSha256,
      rawVerdict: { status: 'passed', checks: { requestSha256, responseSha256: response.responseSha256 } }
    });
    const humanOutcome = {
      evidenceRefs: [response.responseSha256],
      humanDecisionRefs: [response.responseSha256],
      postState: candidate,
      candidateSnapshot: candidate
    };
    assertRequiredTaskEvidence(template, humanOutcome);
    ({ attempt, evidence } = await persistAttemptAndEvidence(root, {
      ...context,
      status: taskOutcome,
      rawResult: response,
      verification,
      outcome: humanOutcome,
      existingAttempt: terminalAttempt,
      executionHandleSha256: runningAttempt.executionHandleSha256,
      startedAt: runningAttempt.startedAt,
      completedAt: respondedAt
    }));
    receipt = accepted ? buildSgosTaskReceipt({
        processId: process.processId,
        taskInstanceId: task.taskInstanceId,
        attemptId,
        attemptSha256: attempt.attemptSha256,
        inputRefs: task.inputRefs,
        outputRefs: [response.responseSha256],
        candidateSha256: candidate.candidateSha256,
        evidenceRefs: [candidate.candidateSha256, evidence.evidenceSha256],
        humanDecisionRefs: [response.responseSha256],
        verification,
        completedAt: respondedAt
      }) : null;
    if (receipt) await putSgosImmutableRecord(root, process.processId, 'gvm-task-receipt', receipt);
    target.state = taskOutcome;
    // A Human Response is durable evidence for every terminal decision, but it is a task output
    // only when the task succeeds.  Failed/cancelled transitions must preserve the empty output
    // and receipt bindings; assertImmutableCore deliberately permits introducing those bindings
    // only on an exact success transition.
    if (accepted) {
      target.outputRefs = [response.responseSha256];
      target.receiptSha256 = receipt.receiptSha256;
    }
    target.revision += 1;
    draft.openHumanRequests = draft.openHumanRequests.filter((sha256) => sha256 !== request.requestSha256);
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: respondedAt
  });
  return Object.freeze({ status: taskOutcome, process: next, request, response, candidate, attempt, receipt, evidence });
}

function interruptedExecution(process, requestedAttemptId = null) {
  if (!process.activeExecutions.length) {
    fail('SGOS recovery requires an interrupted execution.',
      'SGOS_EXECUTION_RECOVERY_INVALID');
  }
  if (requestedAttemptId == null && process.activeExecutions.length !== 1) {
    fail('Parallel SGOS recovery requires an explicit attemptId.',
      'SGOS_EXECUTION_RECOVERY_ATTEMPT_REQUIRED', {
        activeExecutions: [...process.activeExecutions].sort(compareSgosCodePoints)
      });
  }
  const attemptId = requestedAttemptId ?? process.activeExecutions[0];
  if (!process.activeExecutions.includes(attemptId)) {
    fail('The selected interrupted attempt is no longer active.',
      'SGOS_EXECUTION_RECOVERY_STALE', { attemptId });
  }
  const matches = Object.values(process.taskInstances)
    .filter((task) => task.attemptIds.includes(attemptId));
  if (matches.length !== 1) {
    fail('The interrupted execution is not bound to exactly one task.',
      'SGOS_EXECUTION_RECOVERY_INVALID', { attemptId, taskCount: matches.length });
  }
  return { attemptId, task: matches[0] };
}

function recoverableExecution(process, requestedAttemptId = null) {
  if (process.activeExecutions.length) {
    return { ...interruptedExecution(process, requestedAttemptId), active: true };
  }
  const matches = Object.values(process.taskInstances)
    .filter((task) => task.state === 'recovery-required' && task.attemptIds.length > 0);
  const selected = requestedAttemptId == null
    ? matches.length === 1 ? matches[0] : null
    : matches.find((task) => task.attemptIds.at(-1) === requestedAttemptId) ?? null;
  if (!selected) {
    fail(matches.length > 1
      ? 'Parallel SGOS recovery requires an explicit attemptId.'
      : 'SGOS recovery requires exactly one matching active or recovery-required task.',
    matches.length > 1
      ? 'SGOS_EXECUTION_RECOVERY_ATTEMPT_REQUIRED'
      : 'SGOS_EXECUTION_RECOVERY_INVALID', {
      recoveryRequiredAttempts: matches.map((task) => task.attemptIds.at(-1))
        .sort(compareSgosCodePoints)
    });
  }
  return { attemptId: selected.attemptIds.at(-1), task: selected, active: false };
}

function recoveryConfirmation(process, attemptId, resolution) {
  return sgosSha256({
    kind: 'sgos-interrupted-execution-recovery',
    processId: process.processId,
    processSha256: process.processSha256,
    checkpointSha256: process.currentCheckpointSha256,
    attemptId,
    resolution
  });
}

async function recoveryLease(root, process, attemptId) {
  const leases = (await Promise.all(process.activeLeases.map(async (leaseId) => ({
    leaseId,
    lease: await readSgosExecutionLease(root, process.processId, leaseId)
  })))).filter((entry) => entry.lease?.attemptId === attemptId);
  if (leases.length > 1) {
    fail('Interrupted attempt is bound to more than one execution lease.',
      'SGOS_EXECUTION_RECOVERY_INVALID', { attemptId, activeLeases: leases.map((entry) => entry.leaseId) });
  }
  const leaseId = leases[0]?.leaseId ?? null;
  const lease = leases[0]?.lease ?? null;
  if (lease && (lease.attemptId !== attemptId || lease.processId !== process.processId)) {
    fail('The active execution lease is bound to another attempt.',
      'SGOS_EXECUTION_LEASE_CORRUPT', { leaseId, attemptId });
  }
  return Object.freeze({
    leaseId,
    lease,
    status: lease == null ? 'missing' : isSgosExecutionOwnerLive(lease) ? 'live' : 'owner-exited'
  });
}

async function recoveryLineage(root, processId, attemptId) {
  const attempts = await listSgosImmutableRecordsByField(
    root, processId, 'gvm-task-attempt', 'attemptId', attemptId
  );
  const receipts = await listSgosImmutableRecordsByField(
    root, processId, 'gvm-task-receipt', 'attemptId', attemptId
  );
  const evidence = await listSgosImmutableRecordsByField(
    root, processId, 'action-evidence', 'attemptId', attemptId
  );
  const running = attempts.filter((record) => record.status === 'running');
  const terminal = attempts.filter((record) => record.status !== 'running');
  if (running.length > 1 || terminal.length > 1 || receipts.length > 1 || evidence.length > 1) {
    fail('Interrupted execution has ambiguous immutable lineage.',
      'SGOS_RECORD_LINEAGE_INVALID', {
        attemptId, running: running.length, terminal: terminal.length,
        receipts: receipts.length, evidence: evidence.length
      });
  }
  if (receipts.length && terminal[0]?.status !== 'succeeded') {
    fail('Interrupted execution receipt is not bound to one successful terminal attempt.',
      'SGOS_RECORD_LINEAGE_INVALID', { attemptId });
  }
  if (running[0] && terminal[0]
      && running[0].executionHandleSha256 !== terminal[0].executionHandleSha256) {
    fail('Interrupted execution start and terminal records have different handles.',
      'SGOS_RECORD_LINEAGE_INVALID', { attemptId });
  }
  return Object.freeze({
    attempts, running: running[0] ?? null, terminal: terminal[0] ?? null,
    receipt: receipts[0] ?? null, evidence: evidence[0] ?? null
  });
}

async function reassertRecoveryLineageReservations(root, processId, lineage) {
  for (const record of lineage.attempts ?? []) {
    await putSgosImmutableRecord(
      root, processId, 'gvm-task-attempt', record, { reserveExisting: true }
    );
  }
  if (lineage.evidence) {
    await putSgosImmutableRecord(
      root, processId, 'action-evidence', lineage.evidence, { reserveExisting: true }
    );
  }
  if (lineage.receipt) {
    await putSgosImmutableRecord(
      root, processId, 'gvm-task-receipt', lineage.receipt, { reserveExisting: true }
    );
    const { record: candidate } = await readSgosImmutableRecord(
      root, processId, 'candidate-snapshot', lineage.receipt.candidateSha256
    );
    await putSgosImmutableRecord(
      root, processId, 'candidate-snapshot', candidate, { reserveExisting: true }
    );
    for (const responseSha256 of lineage.receipt.humanDecisionRefs ?? []) {
      const { record: response } = await readSgosImmutableRecord(
        root, processId, 'human-response', responseSha256
      );
      await putSgosImmutableRecord(
        root, processId, 'human-response', response, { reserveExisting: true }
      );
    }
  }
}

export async function planSgosProcessRecovery(root, processId, { attemptId = null } = {}) {
  await assertSafeSgosSidecar(root, processId);
  const process = await readSgosProcess(root, processId);
  let bindingStatus = 'current';
  let bindingDetails = null;
  try {
    await assertCurrentStoredProcessBinding(root, process);
  } catch (error) {
    if (error?.code !== 'SGOS_PROCESS_BINDING_STALE') throw error;
    bindingStatus = 'stale';
    bindingDetails = error.details ?? null;
  }
  const recoveryRequiredTasks = Object.values(process.taskInstances)
    .filter((task) => task.state === 'recovery-required');
  if (!process.activeExecutions.length && !recoveryRequiredTasks.length) {
    return Object.freeze({
      processId,
      processRevision: process.processRevision,
      status: process.status,
      bindingStatus,
      bindingDetails,
      interrupted: false,
      actions: []
    });
  }
  const program = await resolveProgram(root, process);
  const selected = recoverableExecution(process, attemptId);
  const selectedAttemptId = selected.attemptId;
  const { task, active } = selected;
  const lease = await recoveryLease(root, process, selectedAttemptId);
  if (active && lease.status === 'live') {
    return Object.freeze({
      processId,
      processRevision: process.processRevision,
      status: process.status,
      bindingStatus,
      bindingDetails,
      interrupted: false,
      executionStatus: 'active',
      attemptId: selectedAttemptId,
      taskInstanceId: task.taskInstanceId,
      leaseId: lease.leaseId,
      actions: []
    });
  }
  const template = templateById(program).get(task.taskTemplateId);
  const attemptNumber = task.attemptIds.indexOf(selectedAttemptId) + 1;
  const lineage = await recoveryLineage(root, process.processId, selectedAttemptId);
  const externalEffects = [...(template.resources?.externalEffects ?? [])];
  const writes = [...(template.resources?.writes ?? [])];
  const devices = [...(template.resources?.devices ?? [])];
  const retryContract = template.recovery?.interruptedExecution ?? null;
  // A failed terminal attempt plus its exact Action Evidence is a complete failure lineage; the
  // mutable Process may still need a final fail transition. Every other terminal-without-receipt
  // shape is incomplete and cannot be reinterpreted or overwritten by recovery.
  const completeTerminalFailure = lineage.terminal?.status === 'failed'
    && lineage.receipt == null && lineage.evidence != null;
  const unresolvedTerminal = lineage.terminal != null
    && lineage.receipt == null && !completeTerminalFailure;
  const retryAllowed = bindingStatus === 'current'
    && lease.lease != null
    && externalEffects.length === 0
    && writes.length === 0
    && devices.length === 0
    && retryContract === 'retry-safe'
    && lineage.receipt == null
    && !unresolvedTerminal
    && attemptNumber < retryCeiling(template);
  const reconcileAllowed = bindingStatus === 'current' && lineage.receipt != null;
  const actions = unresolvedTerminal ? [] : reconcileAllowed ? [{
    resolution: 'reconcile-success',
    confirmationSha256: recoveryConfirmation(process, selectedAttemptId, 'reconcile-success'),
    effect: 'bind-the-existing-verified-receipt-and-complete-the-interrupted-task'
  }] : [{
    resolution: 'fail',
    confirmationSha256: recoveryConfirmation(process, selectedAttemptId, 'fail'),
    effect: 'record-the-interrupted-attempt-and-stop-the-process'
  }];
  if (retryAllowed && !reconcileAllowed) actions.unshift({
    resolution: 'retry-safe',
    confirmationSha256: recoveryConfirmation(process, selectedAttemptId, 'retry-safe'),
    effect: 'record-the-interrupted-attempt-and-return-the-task-to-ready'
  });
  return Object.freeze({
    processId,
    processRevision: process.processRevision,
    status: process.status,
    bindingStatus,
    bindingDetails,
    interrupted: true,
    attemptId: selectedAttemptId,
    taskInstanceId: task.taskInstanceId,
    taskTemplateId: task.taskTemplateId,
    attemptNumber,
    maximumAttempts: retryCeiling(template),
    executionStatus: active
      ? lease.status === 'owner-exited' ? 'owner-exited' : 'lease-missing'
      : 'uncertain-effect',
    leaseId: lease.leaseId,
    externalEffects,
    writes,
    devices,
    retryContract,
    completedReceiptSha256: lineage.receipt?.receiptSha256 ?? null,
    blockedReason: unresolvedTerminal
      ? 'incomplete-terminal-lineage-requires-archival-review'
      : null,
    retryAllowed,
    actions
  });
}

export async function recoverInterruptedSgosExecution(root, processId, {
  attemptId,
  resolution,
  confirmationSha256,
  expectedRevision = null,
  clock = null
} = {}) {
  if (!['retry-safe', 'fail', 'reconcile-success'].includes(resolution)) {
    fail("Interrupted execution recovery requires resolution 'retry-safe', 'reconcile-success', or 'fail'.",
      'SGOS_EXECUTION_RECOVERY_RESOLUTION_REQUIRED');
  }
  await settlePendingTransitionBeforeMutation(root, processId, 'recover');
  const plan = await planSgosProcessRecovery(root, processId, { attemptId });
  if (!plan.interrupted && plan.executionStatus === 'active') {
    fail('The execution owner is still alive; stop it and prove quiescence before recovery.',
      'SGOS_EXECUTION_STILL_ACTIVE', { attemptId: plan.attemptId, leaseId: plan.leaseId });
  }
  if (!plan.interrupted || plan.attemptId !== attemptId) {
    fail('The interrupted execution changed before recovery.', 'SGOS_EXECUTION_RECOVERY_STALE');
  }
  if (expectedRevision != null && expectedRevision !== plan.processRevision) {
    fail('The Process revision changed before recovery.', 'SGOS_PROCESS_REVISION_STALE', {
      expectedRevision,
      actualRevision: plan.processRevision
    });
  }
  const action = plan.actions.find((entry) => entry.resolution === resolution);
  if (!action) {
    fail('Safe retry is unavailable because effects may be uncertain or the retry ceiling was reached.',
      'SGOS_EXECUTION_RETRY_UNSAFE', {
        attemptId,
        externalEffects: plan.externalEffects,
        attemptNumber: plan.attemptNumber,
        maximumAttempts: plan.maximumAttempts
      });
  }
  if (confirmationSha256 !== action.confirmationSha256) {
    fail(`Recovery confirmation must equal ${action.confirmationSha256}.`,
      'SGOS_EXECUTION_RECOVERY_CONFIRMATION_REQUIRED', {
        expected: action.confirmationSha256,
        received: confirmationSha256 ?? null
      });
  }

  const process = await readSgosProcess(root, processId);
  if (resolution !== 'fail') await assertCurrentStoredProcessBinding(root, process);
  const program = await resolveProgram(root, process);
  const current = recoverableExecution(process, attemptId);
  if (current.attemptId !== attemptId || process.processRevision !== plan.processRevision) {
    fail('The interrupted execution changed before recovery committed.', 'SGOS_EXECUTION_RECOVERY_STALE');
  }
  const template = templateById(program).get(current.task.taskTemplateId);
  const leaseState = await recoveryLease(root, process, attemptId);
  if (leaseState.status === 'live') {
    fail('The execution owner is still alive; stop it and prove quiescence before recovery.',
      'SGOS_EXECUTION_STILL_ACTIVE', { leaseId: leaseState.leaseId });
  }
  const lineage = await recoveryLineage(root, processId, attemptId);
  const completedAt = instant(clock);

  if (resolution === 'reconcile-success') {
    if (!lineage.receipt || lineage.terminal?.status !== 'succeeded') {
      fail('The successful immutable receipt changed before reconciliation.',
        'SGOS_EXECUTION_RECOVERY_STALE');
    }
    const next = await mutateSgosProcess(root, processId, async (draft) => {
      await reassertRecoveryLineageReservations(root, processId, lineage);
      const target = draft.taskInstances[current.task.taskInstanceId];
      if ((current.active && !draft.activeExecutions.includes(attemptId))
          || (!current.active && target.state !== 'recovery-required')
          || !target.attemptIds.includes(attemptId)) {
        fail('The interrupted execution changed before recovery committed.',
          'SGOS_EXECUTION_RECOVERY_STALE');
      }
      target.state = 'succeeded';
      target.outputRefs = [...lineage.receipt.outputRefs];
      target.receiptSha256 = lineage.receipt.receiptSha256;
      target.revision += 1;
      draft.activeExecutions = draft.activeExecutions.filter((value) => value !== attemptId);
      draft.activeLeases = draft.activeLeases.filter((value) => value !== leaseState.leaseId);
      updateReadinessAndStatus(draft, program);
    }, {
      expectedRevision: process.processRevision,
      expectedProcessSha256: process.processSha256,
      updatedAt: completedAt
    });
    if (leaseState.leaseId) {
      await removeSgosExecutionLease(root, processId, leaseState.leaseId);
    }
    return Object.freeze({
      status: 'succeeded', resolution, taskInstanceId: current.task.taskInstanceId,
      process: next, attempt: lineage.terminal, receipt: lineage.receipt
    });
  }

  const verification = {
    status: 'failed',
    findings: [{
      code: 'SGOS_EXECUTION_INTERRUPTED',
      detail: `Execution '${attemptId}' ended without a durable result and was resolved as '${resolution}'.`
    }]
  };
  const priorAttempt = lineage.terminal;
  let attempt;
  let evidence;
  // Recovery record publication and the Process transition share one subject lock.  Two recovery
  // callers therefore cannot publish competing terminal records for the same interrupted attempt.
  const next = await mutateSgosProcess(root, processId, async (draft) => {
    const target = draft.taskInstances[current.task.taskInstanceId];
    if ((current.active && !draft.activeExecutions.includes(attemptId))
        || (!current.active && target.state !== 'recovery-required')
        || !target.attemptIds.includes(attemptId)) {
      fail('The interrupted execution changed before recovery committed.', 'SGOS_EXECUTION_RECOVERY_STALE');
    }
    if (priorAttempt?.status === 'failed' && lineage.evidence != null) {
      await reassertRecoveryLineageReservations(root, processId, lineage);
      attempt = priorAttempt;
      evidence = lineage.evidence;
    } else {
      ({ attempt, evidence } = await persistAttemptAndEvidence(root, {
        begun: process,
        before: process,
        task: current.task,
        template,
        attemptId,
        attemptNumber: plan.attemptNumber,
        attemptReason: 'recovery',
        status: 'failed',
        executionHandleSha256: leaseState.lease?.executionHandleSha256
          ?? lineage.running?.executionHandleSha256
          ?? null,
        preState: leaseState.lease == null ? null : {
          processSha256: leaseState.lease.beforeProcessSha256,
          processRevision: leaseState.lease.beforeProcessRevision
        },
        startedAt: lineage.running?.startedAt ?? leaseState.lease?.acquiredAt ?? null,
        rawResult: {
          status: 'failed',
          error: { code: 'SGOS_EXECUTION_INTERRUPTED', resolution }
        },
        verification,
        outcome: { executionEvents: [] },
        completedAt
      }));
    }
    target.state = resolution === 'retry-safe' ? 'ready' : 'failed';
    target.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((value) => value !== attemptId);
    draft.activeLeases = draft.activeLeases.filter((value) => value !== leaseState.leaseId);
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: completedAt
  });
  if (leaseState.leaseId) {
    await removeSgosExecutionLease(root, processId, leaseState.leaseId);
  }
  return Object.freeze({
    status: resolution === 'retry-safe' ? 'retry-ready' : 'failed',
    resolution,
    taskInstanceId: current.task.taskInstanceId,
    process: next,
    attempt,
    evidence
  });
}

export async function pauseSgosProcess(root, processId, { expectedRevision, clock = null } = {}) {
  await settlePendingTransitionBeforeMutation(root, processId, 'pause');
  const process = await readSgosProcess(root, processId);
  await assertCurrentStoredProcessBinding(root, process);
  if (process.activeExecutions.length) fail('Cannot pause while an execution may still be active.', 'SGOS_PROCESS_NOT_QUIESCENT');
  if (PROCESS_TERMINAL.has(process.status)) fail(`Process is already ${process.status}.`, 'SGOS_PROCESS_TERMINAL');
  if (process.status === 'paused') {
    fail('Process is already paused.', 'SGOS_PROCESS_ALREADY_PAUSED');
  }
  return mutateSgosProcess(root, processId, (draft) => { draft.status = 'paused'; }, {
    expectedRevision: expectedRevision ?? process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: instant(clock)
  });
}

export async function resumeSgosProcess(root, processId, {
  checkpointSha256,
  expectedRevision,
  program: suppliedProgram = null,
  clock = null
} = {}) {
  await settlePendingTransitionBeforeMutation(root, processId, 'resume');
  const process = await readSgosProcess(root, processId);
  await assertCurrentStoredProcessBinding(root, process);
  if (process.activeExecutions.length || process.activeLeases.length) {
    fail('Cannot resume while an execution owner may still be active.',
      'SGOS_PROCESS_NOT_QUIESCENT', {
        activeExecutions: process.activeExecutions,
        activeLeases: process.activeLeases
      });
  }
  if (PROCESS_TERMINAL.has(process.status)) {
    fail(`Process is already ${process.status}.`, 'SGOS_PROCESS_TERMINAL');
  }
  if (process.status !== 'paused') {
    fail(`Process is ${process.status}; only a paused Process can resume.`,
      'SGOS_PROCESS_NOT_PAUSED', { status: process.status });
  }
  if (checkpointSha256 !== process.currentCheckpointSha256) {
    fail('Resume requires the exact current checkpoint hash.', 'SGOS_CHECKPOINT_STALE');
  }
  const program = await resolveProgram(root, process, suppliedProgram);
  const { record: checkpoint } = await readSgosCheckpoint(root, processId, checkpointSha256);
  if (checkpoint.programSha256 !== process.programSha256
      || checkpoint.policySnapshotSha256 !== process.policySnapshotSha256
      || checkpoint.processBindingSha256 !== process.processBindingSha256) {
    fail('Checkpoint bindings do not match the current Process.', 'SGOS_CHECKPOINT_STALE');
  }
  return mutateSgosProcess(root, processId, (draft) => {
    if (draft.status !== 'paused' || draft.activeExecutions.length || draft.activeLeases.length) {
      fail('Process changed before it could resume from a quiescent paused state.',
        'SGOS_PROCESS_NOT_QUIESCENT');
    }
    draft.status = 'running';
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: expectedRevision ?? process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: instant(clock)
  });
}

export { listSgosProcesses, readSgosProcess };
export const respondToHumanRequest = respondToSgosHumanRequest;
