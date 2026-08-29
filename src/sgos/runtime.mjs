/**
 * A deliberately small, sequential SGOS interpreter over compiler-produced GVM Programs.
 *
 * The interpreter is structurally coupled only to the public Program IR fields emitted by
 * `sgos/compiler.mjs`.  It never imports compiler implementation details and never writes Story
 * authority: KERNEL handlers must use the existing governed kernel for any lifecycle mutation.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import {
  createCandidateSnapshot,
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
  createSgosProcess,
  listSgosProcesses,
  mutateSgosProcess,
  putSgosImmutableRecord,
  readSgosCheckpoint,
  readSgosImmutableRecord,
  readSgosProcess,
  readSgosProgram,
  sealSgosImmutableRecord,
  sgosProcessDirectory
} from './store.mjs';
import { compareSgosCodePoints } from './order.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HUMAN_REQUEST_TYPES = new Set([
  'clarification', 'approval', 'credential', 'exception', 'policy-choice',
  'conflict-resolution', 'interpretation', 'evidence-review', 'scope-expansion',
  'production-authority', 'scientific-judgment', 'legal-judgment'
]);
const HUMAN_DECISIONS = new Set(['approved', 'rejected', 'selected', 'provided', 'cancelled']);
const SUCCESS_PREDECESSOR_STATES = new Set(['succeeded', 'skipped']);
const PROCESS_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const SUPPORTED_PROGRAM_OPCODES = new Set([
  'NOOP', 'KERNEL', 'VERIFY', 'HUMAN_REQUEST', 'CHECKPOINT', 'END', 'AGENT', 'DEVICE'
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

export const SGOS_SEQUENTIAL_OPCODES = Object.freeze([
  'NOOP', 'KERNEL', 'VERIFY', 'HUMAN_REQUEST', 'CHECKPOINT', 'END'
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
    if (retryCeiling(task) !== 1) {
      fail(`Task '${task.taskTemplateId}' requests retries, but this sequential slice cannot safely reschedule them.`, 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
        semantic: 'retry', taskTemplateId: task.taskTemplateId
      });
    }
    ids.add(task.taskTemplateId);
  }
  if ((program.edges ?? []).some((edge) => edge?.condition != null)) {
    fail('Conditional GVM edges are not supported by the sequential runtime.', 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
      semantic: 'conditional-edge'
    });
  }
  if (joinCount(program.joins) > 0) {
    fail('GVM joins require a parallel runtime and are not supported by this sequential slice.', 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
      semantic: 'join'
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
  if (maximumAttempts != null && maximumAttempts !== 1) {
    fail('Program retries are not supported by this sequential slice.', 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED', {
      semantic: 'retry', maximumAttempts
    });
  }
  return program;
}

async function resolveProgram(root, process, supplied = null) {
  const program = supplied ?? (await readSgosProgram(root, process.processId, process.programSha256)).record;
  assertProgram(program);
  if (program.programSha256 !== process.programSha256
      || program.policySnapshotSha256 !== process.policySnapshotSha256) {
    fail('The loaded Program or policy does not match the Process binding.', 'SGOS_PROGRAM_STALE');
  }
  return program;
}

function edgeDependencies(program) {
  const dependencies = new Map(program.taskTemplates.map((task) => [task.taskTemplateId, new Set(task.dependsOn ?? [])]));
  for (const edge of program.edges ?? []) {
    const from = Array.isArray(edge) ? edge[0] : (edge?.from ?? edge?.source ?? edge?.predecessor);
    const to = Array.isArray(edge) ? edge[1] : (edge?.to ?? edge?.target ?? edge?.successor);
    if (from && to && dependencies.has(to)) dependencies.get(to).add(from);
  }
  return dependencies;
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
  await putSgosCandidateSnapshot(root, process.processId, candidate);
  return (await readSgosCandidateSnapshot(root, process.processId, candidate.candidateSha256)).record;
}

function templateRefs(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => {
    if (typeof value === 'string') return value;
    if (typeof value?.ref === 'string') return value.ref;
    return sgosSha256(value);
  }))].sort();
}

function taskInstancesForProgram(program, processId) {
  const dependencies = edgeDependencies(program);
  const taskIds = new Map(program.taskTemplates.map((task) => [
    task.taskTemplateId,
    stableId('TSK', { processId, taskTemplateId: task.taskTemplateId })
  ]));
  return Object.fromEntries([...program.taskTemplates]
    .sort((left, right) => compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId))
    .map((template) => {
      const taskInstanceId = taskIds.get(template.taskTemplateId);
      const predecessors = [...(dependencies.get(template.taskTemplateId) ?? [])]
        .map((id) => taskIds.get(id))
        .filter(Boolean)
        .sort();
      return [taskInstanceId, {
        taskInstanceId,
        taskTemplateId: template.taskTemplateId,
        state: predecessors.length ? 'waiting' : 'ready',
        predecessorTaskInstanceIds: predecessors,
        inputRefs: templateRefs(template.inputs ?? template.inputRefs ?? []),
        outputRefs: [],
        attemptIds: [],
        receiptSha256: null,
        invalidatedBy: null,
        revision: 1
      }];
    }));
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
  if (['paused', 'blocked', 'failed', 'cancelled', 'succeeded', 'recovery-required'].includes(process.status)
      || process.activeExecutions?.length) return Object.freeze([]);
  const templates = templateById(program);
  const ready = Object.values(process.taskInstances ?? {})
    .filter((task) => ['planned', 'waiting', 'ready'].includes(task.state) && predecessorsSatisfied(process, task))
    .map((task) => ({
      taskInstanceId: task.taskInstanceId,
      taskTemplateId: task.taskTemplateId,
      opcode: templates.get(task.taskTemplateId)?.opcode ?? null
    }))
    .sort((left, right) => compareSgosCodePoints(left.taskTemplateId, right.taskTemplateId)
      || compareSgosCodePoints(left.taskInstanceId, right.taskInstanceId));
  return Object.freeze(ready.map(Object.freeze));
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

function resolveTaskContractSha256({ taskContract = null, taskContractSha256 = null, program }) {
  const reference = taskContractSha256
    ?? taskContract?.taskContractSha256
    ?? taskContract?.contractSha256
    ?? program.taskContractSha256
    ?? (taskContract ? sgosSha256(taskContract) : null);
  return requireSha256('taskContractSha256', reference);
}

function normalizeTrustedAuthority(value, index = 0) {
  const label = `trustedAuthorities[${index}]`;
  ownKeysOnly(value, [
    'kind', 'id', 'principalId', 'principalKind', 'assurance', 'authoritySha256'
  ], label, 'SGOS_AUTHORITY_BINDING_INVALID');
  for (const field of ['kind', 'id', 'principalId', 'principalKind', 'assurance']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      fail(`${label}.${field} must be a non-empty string.`, 'SGOS_AUTHORITY_BINDING_INVALID');
    }
  }
  requireSha256(`${label}.authoritySha256`, value.authoritySha256);
  return {
    kind: value.kind,
    id: value.id,
    principalId: value.principalId,
    principalKind: value.principalKind,
    assurance: value.assurance,
    authoritySha256: value.authoritySha256
  };
}

function normalizeTrustedAuthorities(values = []) {
  if (!Array.isArray(values)) fail('trustedAuthorities must be an array.', 'SGOS_AUTHORITY_BINDING_INVALID');
  const normalized = values.map(normalizeTrustedAuthority).sort((left, right) =>
    compareSgosCodePoints(left.kind, right.kind)
      || compareSgosCodePoints(left.id, right.id)
      || compareSgosCodePoints(left.principalId, right.principalId)
      || compareSgosCodePoints(left.principalKind, right.principalKind));
  const identities = normalized.map((entry) => `${entry.kind}\0${entry.id}\0${entry.principalKind}\0${entry.principalId}`);
  if (new Set(identities).size !== identities.length) {
    fail('trustedAuthorities contains duplicate authority/principal bindings.', 'SGOS_AUTHORITY_BINDING_INVALID');
  }
  return normalized;
}

function currentProcessBinding(root, { processId, subject, supplied = null }) {
  const current = buildSgosProcessBinding(root, {
    processId,
    subjectId: subject.id,
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
  if (stale.length) {
    fail('The supplied Process Binding does not describe the current repository/worktree/branch/HEAD.', 'SGOS_PROCESS_BINDING_STALE', {
      fields: stale
    });
  }
  return validated;
}

function updateReadinessAndStatus(process, program) {
  for (const task of Object.values(process.taskInstances)) {
    if (!['planned', 'waiting', 'ready'].includes(task.state)) continue;
    const next = predecessorsSatisfied(process, task) ? 'ready' : 'waiting';
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
  } else if (Object.values(process.taskInstances).some((task) => task.state === 'blocked')) {
    process.status = 'blocked';
  } else if (Object.values(process.taskInstances).some((task) => task.state === 'failed')) {
    process.status = 'failed';
  } else if (Object.values(process.taskInstances).every((task) => ['succeeded', 'skipped'].includes(task.state))) {
    const templates = templateById(program);
    const endSucceeded = Object.values(process.taskInstances)
      .some((task) => templates.get(task.taskTemplateId)?.opcode === 'END' && task.state === 'succeeded');
    process.status = endSucceeded ? 'succeeded' : 'blocked';
  } else {
    process.status = 'blocked';
  }
}

export async function startSgosProcess(root, {
  program,
  taskContract = null,
  taskContractSha256 = null,
  processId = null,
  subject,
  processBinding = null,
  trustedAuthorities = [],
  clock = null
} = {}) {
  assertProgram(program);
  if (!subject?.id) fail('An SGOS process must bind an existing governed subject.', 'SGOS_SUBJECT_REQUIRED');
  const id = processId ?? stableId('PROC', {
    programSha256: program.programSha256,
    subject: { kind: subject.kind ?? 'story', id: subject.id, branch: subject.branch ?? null }
  });
  const contractSha256 = resolveTaskContractSha256({ taskContract, taskContractSha256, program });
  await assertSafeSgosSidecar(root, id);
  const binding = currentProcessBinding(root, { processId: id, subject, supplied: processBinding });
  const pinnedAuthorities = normalizeTrustedAuthorities(trustedAuthorities);
  const authorityBinding = {
    kind: subject.kind ?? 'story',
    subjectId: subject.id,
    branch: binding.branch,
    baselineRevision: binding.baselineRevision,
    baselineSnapshotSha256: sgosSha256({
      kind: 'sgos-process-baseline',
      processBindingSha256: binding.bindingSha256,
      revision: binding.baselineRevision
    }),
    authority: 'existing-story-lifecycle',
    humanAuthorities: pinnedAuthorities
  };
  const programRecord = (await putSgosImmutableRecord(root, id, 'gvm-program', program)).record;
  const bindingRecord = (await putSgosImmutableRecord(root, id, 'process-binding', binding)).record;
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
      taskInstances: taskInstancesForProgram(program, id),
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
    const checkpoint = existing.currentCheckpointSha256
      ? (await readSgosCheckpoint(root, id, existing.currentCheckpointSha256)).record : null;
    return Object.freeze({ process: existing, program: programRecord, binding: bindingRecord, checkpoint, created: false });
  }

  const checkpoint = buildCheckpoint(created, program, { createdAt, priorCheckpointSha256: null });
  await putSgosImmutableRecord(root, id, 'gvm-checkpoint', checkpoint);
  const process = await mutateSgosProcess(root, id, (draft) => {
    draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
  }, { expectedRevision: created.processRevision, updatedAt: createdAt });
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
  const timedOut = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new SingularityFlowError(`Task exceeded its ${timeoutMs}ms execution ceiling.`, {
        code: 'SGOS_TASK_TIMEOUT', details: { timeoutMs }
      });
      error.uncertainEffect = true;
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => handler(Object.freeze({ ...context, signal: controller.signal }))),
      timedOut
    ]);
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
    createdBy: normalized.createdBy ?? null,
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
    createdBy: { id: 'sgos-runtime', kind: 'system' },
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

async function finalizeHumanRequest(root, begun, task, request, program, clock) {
  await putSgosImmutableRecord(root, begun.processId, 'human-request', request);
  const process = await mutateSgosProcess(root, begun.processId, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    target.state = 'waiting-human';
    target.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== task.attemptId);
    draft.openHumanRequests = [...new Set([...draft.openHumanRequests, request.requestSha256])].sort();
    updateReadinessAndStatus(draft, program);
  }, { expectedRevision: begun.processRevision, expectedProcessSha256: begun.processSha256, updatedAt: instant(clock) });
  return Object.freeze({ status: 'waiting-human', taskInstanceId: task.taskInstanceId, request, process });
}

function executionHandle(process, task, attemptId) {
  return sgosSha256({
    processSha256: process.processSha256,
    taskInstanceId: task.taskInstanceId,
    attemptId
  });
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
  completedAt
}) {
  const attempt = buildSgosTaskAttempt({
    attemptId,
    processId: begun.processId,
    taskInstanceId: task.taskInstanceId,
    attemptNumber,
    parentAttemptId: task.attemptIds.filter((id) => id !== attemptId).at(-1) ?? null,
    reason: attemptNumber === 1 ? 'initial' : 'retry',
    taskContractSha256: begun.taskContractSha256,
    executionHandleSha256: executionHandle(before, task, attemptId),
    status
  });
  await putSgosImmutableRecord(root, begun.processId, 'gvm-task-attempt', attempt);
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
    preState: { processSha256: before.processSha256, processRevision: before.processRevision },
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
  await putSgosImmutableRecord(root, begun.processId, 'action-evidence', evidence);
  return { attempt, evidence };
}

async function finalizeFailure(root, context, error, program, clock) {
  const verification = { status: 'failed', findings: [{
    code: error?.code ?? 'SGOS_TASK_FAILED',
    detail: error?.message ?? String(error)
  }] };
  const completedAt = instant(clock);
  const rawResult = { status: 'failed', error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  const { attempt, evidence } = await persistAttemptAndEvidence(root, {
    ...context,
    status: 'failed',
    rawResult,
    verification,
    completedAt
  });
  const uncertain = error?.uncertainEffect === true
    || (context.template.resources?.externalEffects?.length ?? 0) > 0;
  const process = await mutateSgosProcess(root, context.begun.processId, (draft) => {
    const task = draft.taskInstances[context.task.taskInstanceId];
    task.state = uncertain ? 'recovery-required' : 'failed';
    task.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== context.attemptId);
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: context.begun.processRevision,
    expectedProcessSha256: context.begun.processSha256,
    updatedAt: completedAt
  });
  return Object.freeze({
    status: uncertain ? 'recovery-required' : 'failed',
    taskInstanceId: context.task.taskInstanceId,
    process,
    attempt,
    evidence,
    error: Object.freeze({ code: error?.code ?? 'SGOS_TASK_FAILED', message: error?.message ?? String(error) })
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
  const { attempt, evidence } = await persistAttemptAndEvidence(root, {
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
  await putSgosImmutableRecord(root, context.begun.processId, 'gvm-task-receipt', receipt);
  const process = await mutateSgosProcess(root, context.begun.processId, (draft) => {
    const task = draft.taskInstances[context.task.taskInstanceId];
    task.state = 'succeeded';
    task.outputRefs = outputRefs;
    task.receiptSha256 = receipt.receiptSha256;
    task.revision += 1;
    draft.activeExecutions = draft.activeExecutions.filter((id) => id !== context.attemptId);
    if (checkpoint) draft.currentCheckpointSha256 = checkpoint.checkpointSha256;
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: context.begun.processRevision,
    expectedProcessSha256: context.begun.processSha256,
    updatedAt: completedAt
  });
  return Object.freeze({ status: 'succeeded', taskInstanceId: context.task.taskInstanceId, process, attempt, receipt, evidence, checkpoint });
}

function allOtherTasksTerminal(process, taskInstanceId) {
  return Object.values(process.taskInstances)
    .filter((task) => task.taskInstanceId !== taskInstanceId)
    .every((task) => ['succeeded', 'skipped'].includes(task.state));
}

/** Execute at most one ready task, selected canonically. */
export async function runNextSgosTask(root, processId, {
  program: suppliedProgram = null,
  expectedRevision = null,
  handlers = {},
  captureCandidates = {},
  verifiers = {},
  evidenceContext = {},
  clock = null
} = {}) {
  await assertSafeSgosSidecar(root, processId);
  const before = await readSgosProcess(root, processId);
  const program = await resolveProgram(root, before, suppliedProgram);
  if (expectedRevision != null && before.processRevision !== expectedRevision) {
    fail(`SGOS process '${processId}' changed before dispatch.`, 'SGOS_PROCESS_REVISION_STALE', {
      expectedRevision, actualRevision: before.processRevision
    });
  }
  if (before.activeExecutions.length) {
    fail('An interrupted execution must be reconciled before dispatch can continue.', 'SGOS_EXECUTION_RECOVERY_REQUIRED');
  }
  if (['paused', 'blocked', 'failed', 'cancelled', 'succeeded', 'recovery-required'].includes(before.status)) {
    fail(`SGOS process '${processId}' is ${before.status}; it cannot dispatch.`, 'SGOS_PROCESS_NOT_RUNNABLE');
  }
  const ready = deterministicSgosReadySet(program, before);
  if (!ready.length) return Object.freeze({ status: before.status, taskInstanceId: null, process: before });
  const selected = ready[0];
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
    return blockTask(root, before, task, {
      code: `SGOS_${template.opcode}_HANDLER_REQUIRED`,
      message: `${template.opcode} '${template.operation ?? task.taskTemplateId}' has no governed handler.`
    }, clock);
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
  const begun = await mutateSgosProcess(root, before.processId, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    target.state = template.opcode === 'VERIFY' ? 'verifying' : 'running';
    target.attemptIds = [...target.attemptIds, attemptId];
    target.revision += 1;
    draft.activeExecutions = [...draft.activeExecutions, attemptId];
    draft.status = 'running';
  }, {
    expectedRevision: before.processRevision,
    expectedProcessSha256: before.processSha256,
    updatedAt: instant(clock)
  });
  const context = {
    begun,
    before,
    task: { ...task, attemptId },
    template,
    attemptId,
    attemptNumber,
    evidenceContext,
    handlers,
    handlerKind
  };

  try {
    if (template.opcode === 'HUMAN_REQUEST') {
      const request = humanRequestFor(before, task, template, attemptId, instant(clock));
      return finalizeHumanRequest(root, begun, context.task, request, program, clock);
    }
    if (template.opcode === 'CHECKPOINT') {
      const checkpoint = buildCheckpoint(before, program, {
        priorCheckpointSha256: before.currentCheckpointSha256,
        createdAt: instant(clock)
      });
      await putSgosImmutableRecord(root, before.processId, 'gvm-checkpoint', checkpoint);
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        outputRefs: [checkpoint.checkpointSha256],
        rawResult: { status: 'completed', checkpointSha256: checkpoint.checkpointSha256 }
      }, 'kernel-checkpoint-integrity', instant(clock));
      return finalizeSuccess(root, context, outcome, program, clock, checkpoint);
    }
    if (template.opcode === 'NOOP') {
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        rawResult: { status: 'completed', opcode: 'NOOP' }
      }, 'kernel-noop', instant(clock));
      return finalizeSuccess(root, context, outcome, program, clock);
    }
    if (template.opcode === 'END') {
      const outcome = await trustedRuntimeOutcome(root, begun, context, {
        rawResult: { status: 'completed', opcode: 'END' }
      }, 'kernel-terminal-condition', instant(clock));
      return finalizeSuccess(root, context, outcome, program, clock);
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
    return finalizeSuccess(root, context, outcome ?? {}, program, clock);
  } catch (error) {
    return finalizeFailure(root, context, error, program, clock);
  }
}

function durablePrincipal(actor, authoritySha256 = null) {
  const principal = { id: actor?.id, kind: actor?.kind };
  for (const field of ['name', 'email']) {
    if (actor?.[field] != null) principal[field] = actor[field];
  }
  if (authoritySha256 != null) principal.authoritySha256 = authoritySha256;
  return principal;
}

async function resolveResponseAuthority(request, actor, process, authorityResolver) {
  if (typeof actor?.id !== 'string' || !actor.id || typeof actor?.kind !== 'string' || !actor.kind) {
    fail('Human Request response requires a typed principal.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  if (!['human', 'service', 'agent', 'system', 'external'].includes(actor.kind)) {
    fail('Human Request actor kind is not a contract principal kind.', 'SGOS_HUMAN_REQUEST_UNAUTHORIZED');
  }
  const required = request.authorityRequired;
  let assertion;
  if (typeof authorityResolver === 'function') {
    const resolved = await authorityResolver(Object.freeze({
      request: clone(request),
      actor: durablePrincipal(actor),
      authorityBinding: clone(process.authorityBinding)
    }));
    if (resolved == null || typeof resolved !== 'object' || Array.isArray(resolved)) {
      fail('Trusted authority resolver must return a typed authority assertion, never a boolean.', 'SGOS_AUTHORITY_RESOLVER_INVALID');
    }
    assertion = normalizeTrustedAuthority(resolved, 'resolver');
  } else {
    assertion = (process.authorityBinding?.humanAuthorities ?? []).find((entry) =>
      entry.principalId === actor.id
      && entry.principalKind === actor.kind
      && entry.kind === required.kind
      && entry.id === required.id) ?? null;
  }
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
export async function respondToSgosHumanRequest(root, processId, {
  requestId,
  requestSha256,
  expectedRevision,
  actor,
  decision,
  input = null,
  authorityResolver = null,
  authorize = null,
  program: suppliedProgram = null,
  clock = null
} = {}) {
  await assertSafeSgosSidecar(root, processId);
  if (!Number.isInteger(expectedRevision)) fail('Human response requires expectedRevision.', 'SGOS_PROCESS_REVISION_REQUIRED');
  if (!HUMAN_DECISIONS.has(decision)) fail(`Unknown Human Request decision '${decision}'.`, 'SGOS_HUMAN_RESPONSE_INVALID');
  const process = await readSgosProcess(root, processId);
  if (process.processRevision !== expectedRevision) {
    fail('Human Request response is stale because the Process revision changed.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const program = await resolveProgram(root, process, suppliedProgram);
  const request = await openRequestById(root, process, requestId);
  if (!request || request.requestSha256 !== requestSha256) {
    fail('Human Request is no longer open or its exact hash does not match.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const respondedAt = instant(clock);
  if (request.expiresAt != null && Date.parse(respondedAt) >= Date.parse(request.expiresAt)) {
    fail('Human Request has expired and cannot be answered.', 'SGOS_HUMAN_REQUEST_EXPIRED');
  }
  const task = process.taskInstances[request.taskInstanceId];
  if (!task || task.state !== 'waiting-human'
      || request.checkpointSha256 !== process.currentCheckpointSha256
      || request.policySnapshotSha256 !== process.policySnapshotSha256
      || request.subjectSha256 !== taskSubjectSha256(process, task)) {
    fail('Human Request subject, policy, checkpoint, or task state is stale.', 'SGOS_HUMAN_REQUEST_STALE');
  }
  const trustedAuthority = await resolveResponseAuthority(
    request, actor, process, authorityResolver ?? authorize
  );
  validateHumanDecision(request, decision, input);
  const responseActor = durablePrincipal(actor, trustedAuthority.authoritySha256);
  const responseIdentity = {
    requestSha256,
    actor: responseActor,
    decision,
    input: clone(input)
  };
  const response = sealSgosImmutableRecord('human-response', {
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
  await putSgosImmutableRecord(root, process.processId, 'human-response', response);
  const attemptId = task.attemptIds.at(-1);
  const attemptNumber = task.attemptIds.length;
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
  const candidate = await createAndReloadCandidate(root, process, {
    resources: [],
    createdBy: responseActor,
    createdAt: respondedAt
  });
  const verification = boundVerification({
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
  const { attempt, evidence } = await persistAttemptAndEvidence(root, {
    ...context,
    status: 'succeeded',
    rawResult: response,
    verification,
    outcome: humanOutcome,
    completedAt: respondedAt
  });
  const receipt = buildSgosTaskReceipt({
    processId: process.processId,
    taskInstanceId: task.taskInstanceId,
    attemptId,
    inputRefs: task.inputRefs,
    outputRefs: [response.responseSha256],
    candidateSha256: candidate.candidateSha256,
    evidenceRefs: [candidate.candidateSha256, evidence.evidenceSha256],
    humanDecisionRefs: [response.responseSha256],
    verification,
    completedAt: respondedAt
  });
  await putSgosImmutableRecord(root, process.processId, 'gvm-task-receipt', receipt);
  const next = await mutateSgosProcess(root, process.processId, (draft) => {
    const target = draft.taskInstances[task.taskInstanceId];
    if (target.state !== 'waiting-human' || !draft.openHumanRequests.includes(request.requestSha256)) {
      fail('Human Request changed before its response committed.', 'SGOS_HUMAN_REQUEST_STALE');
    }
    target.state = 'succeeded';
    target.outputRefs = [response.responseSha256];
    target.receiptSha256 = receipt.receiptSha256;
    target.revision += 1;
    draft.openHumanRequests = draft.openHumanRequests.filter((sha256) => sha256 !== request.requestSha256);
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: respondedAt
  });
  return Object.freeze({ status: 'succeeded', process: next, request, response, candidate, attempt, receipt, evidence });
}

export async function pauseSgosProcess(root, processId, { expectedRevision, clock = null } = {}) {
  const process = await readSgosProcess(root, processId);
  if (process.activeExecutions.length) fail('Cannot pause while an execution may still be active.', 'SGOS_PROCESS_NOT_QUIESCENT');
  if (PROCESS_TERMINAL.has(process.status)) fail(`Process is already ${process.status}.`, 'SGOS_PROCESS_TERMINAL');
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
  const process = await readSgosProcess(root, processId);
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
  if (process.activeExecutions.length) {
    return mutateSgosProcess(root, processId, (draft) => {
      for (const task of Object.values(draft.taskInstances)) {
        if (task.attemptIds.some((id) => draft.activeExecutions.includes(id))) {
          task.state = 'recovery-required';
          task.revision += 1;
        }
      }
      draft.status = 'recovery-required';
    }, {
      expectedRevision: expectedRevision ?? process.processRevision,
      expectedProcessSha256: process.processSha256,
      updatedAt: instant(clock)
    });
  }
  if (PROCESS_TERMINAL.has(process.status)) fail(`Process is already ${process.status}.`, 'SGOS_PROCESS_TERMINAL');
  return mutateSgosProcess(root, processId, (draft) => {
    if (draft.status === 'paused') draft.status = 'running';
    updateReadinessAndStatus(draft, program);
  }, {
    expectedRevision: expectedRevision ?? process.processRevision,
    expectedProcessSha256: process.processSha256,
    updatedAt: instant(clock)
  });
}

export { listSgosProcesses, readSgosProcess };
export const stepSgosProcess = runNextSgosTask;
export const respondToHumanRequest = respondToSgosHumanRequest;
