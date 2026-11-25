/** ITW owns the admission and reservation. The Story's committed origin is the recovery witness. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { acquireFileLeaseWithin, inspectFileLease } from './file-lease.mjs';
import { committedFileText, configurationCommitIdentity, gitCommonDir, localRefHeads } from './git.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { readStoryStartJournal, recoverStoryStart } from './story-start-journal.mjs';
import { isTransportIntentId, mapLimit, nowIso, SingularityFlowError } from './util.mjs';
import { workItemWorkflowRelative } from './work-item-location.mjs';

const FAMILY = 'itw-task-admission';
export const taskAdmissionId = /^itw-[a-f0-9]{32}$/u;
const LIMIT = 64 * 1024;
const digest = value => 'sha256:' + recordSha256(value);
const fail = (code, message, details) => new SingularityFlowError(message, { code, details });
const absent = () => fail('TASK_ADMISSION_UNAVAILABLE', 'This task handoff is unavailable for the current identity and repository.');
const privatePath = info => process.platform === 'win32' || (info.uid === process.getuid() && (info.mode & 0o077) === 0);
const invalidStore = () => fail('TASK_ADMISSION_INVALID', 'The task admission record cannot be verified. Its reservation was preserved.');

async function admissionStore(root) {
  const commonDir = await realpath(gitCommonDir(root));
  const { dev, ino } = await stat(commonDir);
  const actor = configurationCommitIdentity(root);
  const scope = digest({ commonDir, dev, ino });
  const principal = digest({ email: actor.email.toLowerCase(), hostedActor: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ?? null });
  const directory = path.join(commonDir, 'singularity-flow', 'task-admissions');
  const file = id => path.join(directory, id + '.json');
  const lock = id => path.join(directory, id + '.lock');
  async function ready(create) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info && (!info.isDirectory() || !privatePath(info) || await realpath(directory) !== directory)) throw invalidStore();
    return Boolean(info);
  }
  async function raw(id) {
    if (!taskAdmissionId.test(id)) throw absent();
    if (process.platform === 'win32') {
      const info = await lstat(file(id)).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) return null;
      if (!info.isFile()) throw invalidStore();
    }
    let handle;
    try { handle = await open(file(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || !privatePath(info) || info.size > LIMIT) throw invalidStore();
      const { record } = readRecord(FAMILY, await handle.readFile());
      if (record.id !== id || record.scope !== scope || record.requestSha256 !== digest(record.request)
          || !['prepared', 'pending', 'accepted', 'refused', 'unknown'].includes(record.status)
          || (record.workId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.workId))) throw invalidStore();
      return record;
    } finally { await handle.close(); }
  }
  async function read(id) {
    const record = await ready(false) ? await raw(id) : null;
    if (!record || record.actor !== principal) throw absent();
    return record;
  }
  async function save(current, fields = {}) {
    const record = { ...current, ...fields, updatedAt: nowIso() };
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > LIMIT) throw fail('TASK_ADMISSION_LIMIT', 'This task handoff is too large to retain. Choose fewer evidence links.');
    const temporary = file(record.id) + '.' + randomUUID() + '.tmp';
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file(record.id));
    } finally { await unlink(temporary).catch(() => {}); }
    return record;
  }
  async function within(id, action, onBusy) {
    const lease = await acquireFileLeaseWithin(lock(id), 2200);
    if (!lease) return onBusy();
    try { return await action(); }
    finally { await lease.release(); }
  }
  return { scope, principal, ready, raw, read, save, within, lock,
    async reservations() {
      const names = await readdir(directory);
      const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(id => taskAdmissionId.test(id));
      const records = await mapLimit(ids, 8, raw);
      return records.flatMap(record => record?.workId ? [record.workId] : []);
    }
  };
}

export function taskAdmissionOrigin(record) {
  return { mode: 'itw-handoff', admissionId: record.id, workId: record.workId, requestSha256: record.requestSha256 };
}

export function matchesTaskAdmission(value, expected) {
  return value?.mode === 'itw-handoff' && value.admissionId === expected.admissionId
    && value.workId === expected.workId && value.requestSha256 === expected.requestSha256;
}

async function observe(root, record) {
  if (!record.workId) return { outcome: null, journal: null, occupied: false };
  const { workId, request } = record;
  const target = request.target;
  const relative = workItemWorkflowRelative(workId, target.workItemRoot);
  const local = `refs/heads/${workId}`;
  const remote = `refs/remotes/${target.remote}/${workId}`;
  const env = { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  const refs = localRefHeads(root, [local, remote]);
  const { storyWorktreeForBranch } = await import('./story-worktree.mjs');
  const checkout = storyWorktreeForBranch(root, workId)?.repositoryPath ?? root;
  const pending = await readPendingPublication(checkout, { kind: 'story', id: workId, migrate: false });
  let conflict = false;
  for (const commit of new Set(refs.values())) {
    const raw = committedFileText(root, commit, relative, { env });
    if (!raw) continue;
    let story;
    try { story = JSON.parse(raw); } catch { conflict = true; continue; }
    if (story.workItem?.id !== workId || story.workItem?.branch !== workId || !matchesTaskAdmission(story.executionOrigin, taskAdmissionOrigin(record))) {
      conflict = true;
      continue;
    }
    const source = committedFileText(root, commit, path.posix.join(path.posix.dirname(relative), 'source.json'), { env });
    if (source === null || createHash('sha256').update(source).digest('hex') !== story.resolution?.sourceSha256) { conflict = true; continue; }
    let bound;
    try { bound = JSON.parse(source).taskHandoff; } catch { conflict = true; continue; }
    if (bound?.admissionId !== record.id || bound.requestSha256 !== record.requestSha256 ||
        digest({ specification: bound.specification, evidence: bound.evidence }) !== digest(request.sources)) { conflict = true; continue; }
    const retry = pending?.record?.intentId;
    return { outcome: { workId, branch: workId, revision: commit, published: refs.get(remote) === commit,
      pendingPush: isTransportIntentId(retry) ? retry : null, publicationPending: Boolean(pending) }, journal: null, occupied: false };
  }
  const journal = await readStoryStartJournal(root, workId);
  const recoverable = journal && pending?.record?.recoveryStage === 'interrupted-before-branch-ref-advanced';
  return { outcome: null, journal, checkout, occupied: conflict || (pending && !recoverable) || (refs.size > 0 && !journal) };
}

/** Preview is a private receipt. It does not reserve a branch or create a Story. */
export async function prepareTaskAdmission(root, request, { key } = {}) {
  const store = await admissionStore(root);
  const requestSha256 = digest(request);
  const id = key ?? 'itw-' + recordSha256([store.scope, store.principal, requestSha256]).slice(0, 32);
  if (!taskAdmissionId.test(id)) throw absent();
  await store.ready(true);
  const exactRequest = existing => {
    if (existing.actor !== store.principal) throw absent();
    if (existing.requestSha256 !== requestSha256) {
      throw fail('TASK_ADMISSION_KEY_CONFLICT', 'This handoff ID already belongs to a different task request. Inspect the original handoff.', { admissionId: id });
    }
    return existing;
  };
  return store.within(id, async () => {
    const existing = await store.raw(id);
    if (existing) return exactRequest(existing);
    return store.save({ schemaVersion: currentSchemaVersion(FAMILY), id, actor: store.principal, scope: store.scope,
      createdAt: nowIso(), request, requestSha256, status: 'prepared', workId: null, outcome: null });
  }, async () => exactRequest(await store.read(id)));
}

/** Verify the same owner at the last Story start boundary, including in a linked worktree. */
export async function assertTaskAdmissionOwner(root, expected) {
  const store = await admissionStore(root);
  const current = await store.read(expected.id);
  if (current.status !== 'pending' || current.workId !== expected.workId || current.requestSha256 !== expected.requestSha256) throw invalidStore();
}

export async function inspectTaskAdmission(root, id) {
  const store = await admissionStore(root);
  const record = await store.read(id);
  if (!record.workId || record.status === 'accepted') return record;
  const proof = await observe(root, record);
  if (proof.outcome) return { ...record, status: 'accepted', outcome: proof.outcome };
  if (record.status === 'pending' && !(await inspectFileLease(store.lock(id))).active) return { ...record, status: 'unknown' };
  return record;
}

/** Only the existing Story start owns creation. A replay keeps this receipt's reserved Work ID. */
export async function admitTask(root, id, { validate, reserve, dispatch }) {
  const store = await admissionStore(root);
  await store.read(id);
  return store.within(id, async () => {
    let record = await store.read(id);
    if (record.status === 'accepted') return record;
    let proof = await observe(root, record);
    const accepted = outcome => store.save(record, { status: 'accepted', outcome, diagnostic: null });
    const unknown = (code, message) => store.save(record, { status: 'unknown', diagnostic: { code, message } });
    if (proof.outcome) return accepted(proof.outcome);
    if (proof.occupied || (proof.journal && !matchesTaskAdmission(proof.journal.record.taskAdmission, taskAdmissionOrigin(record)))) {
      return unknown('TASK_ADMISSION_OUTCOME_UNKNOWN', 'The reserved Story has unverified state. Inspect the existing Story before retrying this handoff.');
    }
    if (proof.journal) {
      try { await recoverStoryStart(proof.checkout, record.workId); }
      catch (error) { return unknown(error.code ?? 'STORY_START_RECOVERY_FAILED', redactDiagnosticText(error.message)); }
      proof = await observe(root, record);
      if (proof.outcome) return accepted(proof.outcome);
      if (proof.occupied || proof.journal) return unknown('TASK_ADMISSION_OUTCOME_UNKNOWN', 'Story-start recovery has not settled the reservation.');
    }
    let validated;
    try { validated = await validate(record.request); }
    catch (error) {
      return store.save(record, { status: 'refused', diagnostic: { code: error.code ?? 'TASK_ADMISSION_REFUSED', message: redactDiagnosticText(error.message),
        ownerAction: error.details?.nextAction ?? null } });
    }
    const pending = workId => store.save(record, { status: 'pending', workId, diagnostic: null });
    if (record.workId) record = await pending(record.workId);
    else record = await store.within('reservation', async () => pending(await reserve(record.request, await store.reservations())),
      () => { throw fail('TASK_ADMISSION_BUSY', 'Another task is reserving its Story ID. Retry this handoff.'); });

    try {
      const result = await dispatch(record, validated);
      proof = await observe(root, record);
      if (proof.outcome) return accepted({ ...proof.outcome, published: result?.data?.publication?.pushed ?? proof.outcome.published });
      return unknown('TASK_ADMISSION_OUTCOME_UNKNOWN', 'Story start returned without a verifiable Story for this reservation. Inspect the task before retrying.');
    } catch (error) {
      proof = await observe(root, record);
      if (proof.outcome) return accepted(proof.outcome);
      const diagnostic = { code: error.code ?? 'TASK_START_FAILED', message: redactDiagnosticText(error.message), ownerAction: error.details?.nextAction ?? null };
      return store.save(record, { status: proof.occupied || proof.journal ? 'unknown' : 'refused', diagnostic });
    }
  }, () => inspectTaskAdmission(root, id));
}
