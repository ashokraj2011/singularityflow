/**
 * Machine-local storage for the first SGOS runtime slice.
 *
 * This is deliberately an operational sidecar.  Nothing in this module writes a Story workflow,
 * lifecycle branch, or governed artifact.  The exact Story/Git binding is retained as immutable
 * evidence while the existing lifecycle remains the only authority for Story state.
 */
import { randomUUID } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { branch, gitCommonDir, gitDir, head, repoRoot } from '../git.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError, nowIso } from '../util.mjs';
import { validateSgosRecord } from './contracts.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const PROCESS_STATES = new Set([
  'queued', 'running', 'waiting-human', 'blocked', 'paused', 'succeeded', 'failed',
  'cancelled', 'recovery-required'
]);
const TASK_STATES = new Set([
  'planned', 'waiting', 'ready', 'leased', 'running', 'waiting-human', 'verifying',
  'succeeded', 'failed', 'blocked', 'cancelled', 'invalidated', 'recovery-required', 'skipped'
]);
const MAX_IMMUTABLE_RECORD_SCAN = 10_000;

const IMMUTABLE_FAMILIES = Object.freeze({
  'gvm-program': Object.freeze({ directory: 'programs', hashField: 'programSha256' }),
  'candidate-snapshot': Object.freeze({ directory: 'candidate-snapshots', hashField: 'candidateSha256' }),
  'process-binding': Object.freeze({ directory: 'bindings', hashField: 'bindingSha256' }),
  'gvm-task-attempt': Object.freeze({ directory: 'attempts', hashField: 'attemptSha256' }),
  'gvm-task-receipt': Object.freeze({ directory: 'receipts', hashField: 'receiptSha256' }),
  'gvm-checkpoint': Object.freeze({ directory: 'checkpoints', hashField: 'checkpointSha256' }),
  'human-request': Object.freeze({ directory: 'human-requests', hashField: 'requestSha256' }),
  'human-response': Object.freeze({ directory: 'human-responses', hashField: 'responseSha256' }),
  'action-evidence': Object.freeze({ directory: 'evidence', hashField: 'evidenceSha256' })
});

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function clone(value) {
  return structuredClone(value);
}

function requireId(label, value) {
  const normalized = String(value ?? '');
  if (!ID.test(normalized)) fail(`${label} '${normalized}' is not a safe SGOS identifier.`, 'SGOS_ID_INVALID', { label, value });
  return normalized;
}

function requireProcessId(value) {
  const id = requireId('processId', value);
  if (!/^PROC-[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(id)) {
    fail(`processId '${id}' must be a PROC-prefixed SGOS identifier.`, 'SGOS_ID_INVALID', { label: 'processId', value: id });
  }
  return id;
}

function requireSha256(label, value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!SHA256.test(String(value ?? ''))) {
    fail(`${label} must be an exact sha256 reference.`, 'SGOS_HASH_INVALID', { label, value: value ?? null });
  }
  return String(value);
}

function safeSegment(value) {
  return encodeURIComponent(requireProcessId(value));
}

export function sgosProcessDirectory(root, processId) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'processes', safeSegment(processId));
}

export function sgosProcessStatePath(root, processId) {
  return path.join(sgosProcessDirectory(root, processId), 'state.json');
}

async function safeSgosDirectory(root, directory, { create = false } = {}) {
  const commonDirectory = path.resolve(gitCommonDir(root));
  const targetDirectory = path.resolve(directory);
  const relative = path.relative(commonDirectory, targetDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('SGOS store path escapes the Git common directory.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  let commonStats;
  try { commonStats = await lstat(commonDirectory); } catch (error) {
    if (error?.code === 'ENOENT') fail('Git common directory is unavailable.', 'SGOS_SIDECAR_PATH_UNSAFE');
    throw error;
  }
  if (commonStats.isSymbolicLink() || !commonStats.isDirectory()) {
    fail('Git common directory is not a real directory.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  let cursor = commonDirectory;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stats;
    try {
      stats = await lstat(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !create) throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      stats = await lstat(cursor);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      fail(`SGOS store ancestor '${cursor}' is not a real directory.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
  }
  return targetDirectory;
}

async function readSafeFile(root, target) {
  await safeSgosDirectory(root, path.dirname(target));
  let handle;
  try {
    handle = await open(target, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) fail(`SGOS store target '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    return await handle.readFile('utf8');
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`SGOS store target '${target}' is a symbolic link.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSafeAtomic(root, target, bytes) {
  await safeSgosDirectory(root, path.dirname(target), { create: true });
  const temporary = `${target}.pending-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const staged = await lstat(temporary);
    if (staged.isSymbolicLink() || !staged.isFile()) {
      fail('Mutable SGOS staging target is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    await safeSgosDirectory(root, path.dirname(target));
    try {
      const existing = await lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        fail(`SGOS store target '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporary, target);
    await safeSgosDirectory(root, path.dirname(target));
    const published = await lstat(target);
    if (published.isSymbolicLink() || !published.isFile()) {
      fail(`SGOS store publication '${target}' is not a real file.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function immutableLocation(root, processId, familyId, sha256) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  const reference = requireSha256(family.hashField, sha256);
  return path.join(sgosProcessDirectory(root, processId), family.directory, `${reference.slice('sha256:'.length)}.json`);
}

function hashWithout(record, hashField) {
  const core = clone(record);
  delete core[hashField];
  return `sha256:${recordSha256(core)}`;
}

/** Stamp and content-address one immutable SGOS record. */
export function sealSgosImmutableRecord(familyId, value) {
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID', { family: familyId });
  const core = clone(value ?? {});
  delete core[family.hashField];
  core.schemaVersion = currentSchemaVersion(familyId);
  const sealed = { ...core, [family.hashField]: `sha256:${recordSha256(core)}` };
  return Object.freeze(sealed);
}

function sealProcess(value) {
  const core = clone(value);
  delete core.processSha256;
  core.schemaVersion = currentSchemaVersion('gvm-process');
  return { ...core, processSha256: `sha256:${recordSha256(core)}` };
}

function assertProcessShape(state) {
  if (state?.kind !== 'gvm-process') fail('SGOS process state has the wrong kind.', 'SGOS_PROCESS_CORRUPT');
  requireProcessId(state.processId);
  requireSha256('programSha256', state.programSha256);
  requireSha256('policySnapshotSha256', state.policySnapshotSha256);
  requireSha256('processBindingSha256', state.processBindingSha256);
  requireSha256('taskContractSha256', state.taskContractSha256, { nullable: true });
  requireSha256('currentCheckpointSha256', state.currentCheckpointSha256, { nullable: true });
  if (!PROCESS_STATES.has(state.status)) fail(`Unknown SGOS process status '${state.status}'.`, 'SGOS_PROCESS_CORRUPT');
  if (!Number.isInteger(state.processRevision) || state.processRevision < 1) {
    fail('SGOS process revision must be a positive integer.', 'SGOS_PROCESS_CORRUPT');
  }
  if (!state.taskInstances || typeof state.taskInstances !== 'object' || Array.isArray(state.taskInstances)) {
    fail('SGOS process taskInstances must be an object.', 'SGOS_PROCESS_CORRUPT');
  }
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (task?.taskInstanceId !== taskId || !TASK_STATES.has(task?.state)) {
      fail(`SGOS task instance '${taskId}' is malformed.`, 'SGOS_PROCESS_CORRUPT');
    }
    if (!Array.isArray(task.predecessorTaskInstanceIds) || !Array.isArray(task.attemptIds)) {
      fail(`SGOS task instance '${taskId}' has malformed lineage.`, 'SGOS_PROCESS_CORRUPT');
    }
    if (task.state === 'succeeded' && !SHA256.test(String(task.receiptSha256 ?? ''))) {
      fail(`SGOS task '${taskId}' cannot succeed without an exact receipt.`, 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
  }
  for (const field of ['activeExecutions', 'openHumanRequests', 'activeLeases']) {
    if (!Array.isArray(state[field])) fail(`SGOS process ${field} must be an array.`, 'SGOS_PROCESS_CORRUPT');
  }
  if (state.status === 'succeeded') {
    const incomplete = Object.values(state.taskInstances).filter((task) => !['succeeded', 'skipped'].includes(task.state));
    if (incomplete.length || state.activeExecutions.length || state.openHumanRequests.length) {
      fail('A succeeded SGOS process must have only receipted terminal tasks and no active work.', 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
  }
  return state;
}

function assertImmutableCore(before, after) {
  const fields = [
    'processId', 'programSha256', 'policySnapshotSha256', 'processBindingSha256',
    'taskContractSha256', 'authorityBinding', 'createdAt'
  ];
  for (const field of fields) {
    if (JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null)) {
      fail(`SGOS process mutation attempted to replace immutable '${field}'.`, 'SGOS_PROCESS_BINDING_CHANGED', { field });
    }
  }
  const beforeIds = Object.keys(before.taskInstances).sort();
  const afterIds = Object.keys(after.taskInstances ?? {}).sort();
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
    fail('The sequential SGOS runtime cannot add or remove compiled task instances.', 'SGOS_TASK_SET_CHANGED');
  }
  for (const id of beforeIds) {
    const stableFields = ['taskInstanceId', 'taskTemplateId', 'predecessorTaskInstanceIds'];
    for (const field of stableFields) {
      if (JSON.stringify(before.taskInstances[id][field] ?? null) !== JSON.stringify(after.taskInstances[id]?.[field] ?? null)) {
        fail(`SGOS task '${id}' attempted to replace immutable '${field}'.`, 'SGOS_TASK_BINDING_CHANGED', { taskInstanceId: id, field });
      }
    }
  }
}

async function withProcessLock(root, processId, callback, timeoutMs = 2_000) {
  await safeSgosDirectory(root, sgosProcessDirectory(root, processId), { create: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await withSubjectLock(root, { kind: 'sgos-process', id: processId }, callback);
    } catch (error) {
      if (error?.code !== 'SUBJECT_LOCK_BUSY' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/**
 * Construct the exact local/Git binding without granting the sidecar any Story authority.
 */
export function buildSgosProcessBinding(root, {
  processId,
  subjectId,
  repositoryIdentity = null,
  canonicalWorktreeRoot = null,
  branchName = null,
  baselineRevision = null,
  expectedProcessRevision = 0
} = {}) {
  const id = requireProcessId(processId);
  const subject = requireId('subjectId', subjectId);
  const common = gitCommonDir(root);
  const worktreeRoot = canonicalWorktreeRoot == null ? repoRoot(root) : path.resolve(canonicalWorktreeRoot);
  const core = {
    schemaVersion: currentSchemaVersion('process-binding'),
    kind: 'process-binding',
    processId: id,
    subjectId: subject,
    repositoryIdentity: repositoryIdentity ?? `sha256:${recordSha256({ gitCommonDirectory: common })}`,
    gitCommonDirectory: common,
    worktreeGitDirectory: gitDir(root),
    canonicalWorktreeRoot: worktreeRoot,
    branch: branchName ?? branch(root),
    baselineRevision: baselineRevision ?? head(root),
    expectedProcessRevision
  };
  return sealSgosImmutableRecord('process-binding', core);
}

/** Write a content-addressed record once; equal writers converge on the same bytes. */
export async function putSgosImmutableRecord(root, processId, familyId, value) {
  const id = requireProcessId(processId);
  const sealed = sealSgosImmutableRecord(familyId, value);
  try { validateSgosRecord(sealed); } catch (error) {
    fail(`SGOS ${familyId} failed its strict contract.`, 'SGOS_RECORD_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  if (sealed.processId != null && sealed.processId !== id) {
    fail(`SGOS ${familyId} belongs to another process.`, 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  const family = IMMUTABLE_FAMILIES[familyId];
  const target = immutableLocation(root, id, familyId, sealed[family.hashField]);
  await safeSgosDirectory(root, path.dirname(target), { create: true });
  const bytes = canonicalJson(sealed);
  const temporary = `${target}.pending-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    const temporaryStats = await lstat(temporary);
    if (temporaryStats.isSymbolicLink() || !temporaryStats.isFile()) {
      fail('Immutable SGOS staging target is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    try {
      // A hard link publishes a fully-written file and, unlike rename, never replaces an existing
      // record.  The temporary name is removed after the directory entry exists.
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readSafeFile(root, target);
      if (existing !== bytes) fail(`Immutable SGOS ${familyId} hash collision.`, 'SGOS_IMMUTABLE_CONFLICT');
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  await safeSgosDirectory(root, path.dirname(target));
  const publishedStats = await lstat(target);
  if (publishedStats.isSymbolicLink() || !publishedStats.isFile()) {
    fail('Immutable SGOS publication is not a real file.', 'SGOS_SIDECAR_PATH_UNSAFE');
  }
  return Object.freeze({ record: sealed, sha256: sealed[family.hashField], path: target });
}

export async function readSgosImmutableRecord(root, processId, familyId, sha256) {
  const id = requireProcessId(processId);
  const family = IMMUTABLE_FAMILIES[familyId];
  if (!family) fail(`'${familyId}' is not an SGOS immutable-store family.`, 'SGOS_RECORD_FAMILY_INVALID');
  const target = immutableLocation(root, id, familyId, sha256);
  let raw;
  try {
    raw = await readSafeFile(root, target);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`SGOS ${familyId} '${sha256}' is unavailable.`, 'SGOS_RECORD_NOT_FOUND', { family: familyId, sha256 });
    throw error;
  }
  const record = readRecord(familyId, raw).record;
  const expected = requireSha256(family.hashField, record[family.hashField]);
  if (expected !== sha256 || hashWithout(record, family.hashField) !== expected) {
    fail(`SGOS ${familyId} '${sha256}' failed its integrity check.`, 'SGOS_RECORD_CORRUPT');
  }
  if (record.processId != null && record.processId !== id) {
    fail(`SGOS ${familyId} '${sha256}' belongs to another process.`, 'SGOS_RECORD_PROCESS_MISMATCH');
  }
  try { validateSgosRecord(record); } catch (error) {
    fail(`SGOS ${familyId} '${sha256}' failed its strict contract.`, 'SGOS_RECORD_CORRUPT', {
      cause: error?.message ?? String(error)
    });
  }
  return Object.freeze({ record, sha256: expected, path: target });
}

async function findSgosImmutableRecord(root, processId, familyId, field, value) {
  const family = IMMUTABLE_FAMILIES[familyId];
  const directory = path.join(sgosProcessDirectory(root, processId), family.directory);
  await safeSgosDirectory(root, directory);
  const entries = await readdir(directory, { withFileTypes: true });
  const records = entries.filter((entry) => /^[a-f0-9]{64}\.json$/.test(entry.name));
  if (records.length > MAX_IMMUTABLE_RECORD_SCAN) {
    fail(`SGOS ${familyId} lookup exceeded its bounded record ceiling.`, 'SGOS_RECORD_SCAN_LIMIT', {
      maximum: MAX_IMMUTABLE_RECORD_SCAN, actual: records.length
    });
  }
  const matches = [];
  for (const entry of records) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail(`SGOS ${familyId} contains a non-file record entry.`, 'SGOS_SIDECAR_PATH_UNSAFE');
    }
    const reference = `sha256:${entry.name.slice(0, -'.json'.length)}`;
    const { record } = await readSgosImmutableRecord(root, processId, familyId, reference);
    if (record[field] === value) matches.push(record);
  }
  if (matches.length !== 1) {
    fail(`SGOS ${familyId} '${value}' has ${matches.length} immutable lineage records; expected exactly one.`,
      'SGOS_RECORD_LINEAGE_INVALID', { family: familyId, field, value, matches: matches.length });
  }
  return matches[0];
}

async function assertReferencedRecords(root, state) {
  for (const [taskId, task] of Object.entries(state.taskInstances)) {
    if (task.state !== 'succeeded') continue;
    const { record } = await readSgosImmutableRecord(root, state.processId, 'gvm-task-receipt', task.receiptSha256);
    if (record.taskInstanceId !== taskId || record.processId !== state.processId
        || record.verification?.status !== 'passed'
        || task.attemptIds.at(-1) !== record.attemptId
        || canonicalJson(record.inputRefs) !== canonicalJson(task.inputRefs)
        || canonicalJson(record.outputRefs) !== canonicalJson(task.outputRefs)) {
      fail(`SGOS task '${taskId}' does not have a valid passing receipt.`, 'SGOS_SUCCESS_WITHOUT_RECEIPT');
    }
    const attempt = await findSgosImmutableRecord(
      root, state.processId, 'gvm-task-attempt', 'attemptId', record.attemptId
    );
    if (attempt.processId !== state.processId || attempt.taskInstanceId !== taskId
        || attempt.taskContractSha256 !== state.taskContractSha256 || attempt.status !== 'succeeded') {
      fail(`SGOS task '${taskId}' receipt is not bound to its successful immutable attempt.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    const { record: candidate } = await readSgosImmutableRecord(
      root, state.processId, 'candidate-snapshot', record.candidateSha256
    );
    if (!record.evidenceRefs.includes(candidate.candidateSha256)
        || candidate.subject?.sha256 !== state.processBindingSha256
        || candidate.subject?.id !== state.authorityBinding?.subjectId) {
      fail(`SGOS task '${taskId}' receipt is not bound to its immutable Candidate Snapshot.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    let boundEvidence = null;
    for (const reference of record.evidenceRefs) {
      if (reference === candidate.candidateSha256 || !SHA256.test(reference)) continue;
      try {
        const { record: evidence } = await readSgosImmutableRecord(
          root, state.processId, 'action-evidence', reference
        );
        if (evidence.processId === state.processId && evidence.taskInstanceId === taskId
            && evidence.attemptId === record.attemptId
            && evidence.programSha256 === state.programSha256
            && evidence.taskContractSha256 === state.taskContractSha256
            && evidence.postStateSha256 === candidate.candidateSha256
            && evidence.verification?.status === 'passed'
            && evidence.verification?.checksSha256 === record.verification?.checksSha256
            && (evidence.contradictions?.length ?? 0) === 0) {
          boundEvidence = evidence;
          break;
        }
      } catch (error) {
        if (error?.code !== 'SGOS_RECORD_NOT_FOUND') throw error;
      }
    }
    if (!boundEvidence) {
      fail(`SGOS task '${taskId}' receipt has no exact passing Action Evidence lineage.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
    }
    for (const responseSha256 of record.humanDecisionRefs ?? []) {
      const { record: response } = await readSgosImmutableRecord(
        root, state.processId, 'human-response', responseSha256
      );
      if (response.processId !== state.processId || response.taskInstanceId !== taskId) {
        fail(`SGOS task '${taskId}' receipt references another task's Human Response.`, 'SGOS_RECEIPT_LINEAGE_INVALID');
      }
    }
  }
  if (state.currentCheckpointSha256) {
    await readSgosImmutableRecord(root, state.processId, 'gvm-checkpoint', state.currentCheckpointSha256);
  }
  for (const requestSha256 of state.openHumanRequests) {
    const { record } = await readSgosImmutableRecord(root, state.processId, 'human-request', requestSha256);
    if (record.status !== 'open') fail(`Open Human Request '${requestSha256}' is not open.`, 'SGOS_HUMAN_REQUEST_CORRUPT');
  }
}

export async function createSgosProcess(root, value) {
  const processId = requireProcessId(value?.processId);
  return withProcessLock(root, processId, async () => {
    const target = sgosProcessStatePath(root, processId);
    try {
      await readSafeFile(root, target);
      fail(`SGOS process '${processId}' already exists.`, 'SGOS_PROCESS_EXISTS');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const timestamp = value.createdAt ?? nowIso();
    const sealed = sealProcess(assertProcessShape({
      ...clone(value),
      schemaVersion: currentSchemaVersion('gvm-process'),
      kind: 'gvm-process',
      processRevision: 1,
      createdAt: timestamp,
      updatedAt: value.updatedAt ?? timestamp
    }));
    await assertReferencedRecords(root, sealed);
    await writeSafeAtomic(root, target, canonicalJson(sealed));
    return Object.freeze(sealed);
  });
}

export async function readSgosProcess(root, processId) {
  const id = requireProcessId(processId);
  let raw;
  try {
    raw = await readSafeFile(root, sgosProcessStatePath(root, id));
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`SGOS process '${id}' is unavailable.`, 'SGOS_PROCESS_NOT_FOUND');
    throw error;
  }
  const state = readRecord('gvm-process', raw).record;
  assertProcessShape(state);
  if (state.processId !== id || state.processSha256 !== hashWithout(state, 'processSha256')) {
    fail(`SGOS process '${id}' failed its integrity check.`, 'SGOS_PROCESS_CORRUPT');
  }
  await assertReferencedRecords(root, state);
  return Object.freeze(state);
}

/**
 * Subject-locked compare-and-swap.  The revision is always incremented by this function, never by
 * callers, and every succeeded task is checked against its immutable receipt before publication.
 */
export async function mutateSgosProcess(root, processId, mutate, {
  expectedRevision,
  expectedProcessSha256 = null,
  updatedAt = null
} = {}) {
  const id = requireProcessId(processId);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    fail('SGOS process mutation requires an exact expectedRevision.', 'SGOS_PROCESS_REVISION_REQUIRED');
  }
  return withProcessLock(root, id, async () => {
    const current = await readSgosProcess(root, id);
    if (current.processRevision !== expectedRevision
        || (expectedProcessSha256 != null && current.processSha256 !== expectedProcessSha256)) {
      fail(`SGOS process '${id}' changed before this operation could commit.`, 'SGOS_PROCESS_REVISION_STALE', {
        expectedRevision,
        actualRevision: current.processRevision,
        expectedProcessSha256,
        actualProcessSha256: current.processSha256
      });
    }
    const draft = clone(current);
    const returned = await mutate(draft, current);
    const next = returned ?? draft;
    assertImmutableCore(current, next);
    next.schemaVersion = currentSchemaVersion('gvm-process');
    next.kind = 'gvm-process';
    next.processRevision = current.processRevision + 1;
    next.updatedAt = updatedAt ?? nowIso();
    delete next.processSha256;
    assertProcessShape(next);
    await assertReferencedRecords(root, next);
    const sealed = sealProcess(next);
    await writeSafeAtomic(root, sgosProcessStatePath(root, id), canonicalJson(sealed));
    return Object.freeze(sealed);
  });
}

export async function readSgosCheckpoint(root, processId, checkpointSha256) {
  return readSgosImmutableRecord(root, processId, 'gvm-checkpoint', checkpointSha256);
}

export async function readSgosProgram(root, processId, programSha256) {
  return readSgosImmutableRecord(root, processId, 'gvm-program', programSha256);
}

/** A bounded, deterministic local-runtime listing; it never scans or interprets Story authority. */
export async function listSgosProcesses(root) {
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'processes');
  let entries;
  try {
    await safeSgosDirectory(root, directory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze([]);
    throw error;
  }
  const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => {
    try { return decodeURIComponent(entry.name); } catch { return null; }
  }).filter((id) => id && ID.test(id)).sort();
  const states = [];
  for (const id of ids) states.push(await readSgosProcess(root, id));
  return Object.freeze(states);
}

export const SGOS_IMMUTABLE_RECORD_FAMILIES = Object.freeze(Object.keys(IMMUTABLE_FAMILIES));
