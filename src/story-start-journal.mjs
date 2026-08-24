import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { branch, gitCommonDir, governedCommitIdentity, head, refExists, refHead } from './git.mjs';
import { restoreConfigurationState } from './configuration-branch.mjs';
import { restoreAgentSession, restoreCopilotSession } from './session.mjs';
import {
  readPendingPublication, recoverPreparedPublicationBySubject
} from './publication-pending.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { exists, nowIso, run, SingularityFlowError, writeAtomic } from './util.mjs';
import { recordSha256 } from './records.mjs';

const FAMILY = 'story-start-journal';

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

export function storyStartJournalPath(root, id) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'story-start', `${safeId(id)}.json`);
}

async function writePrivate(target, record) {
  await writeAtomic(target, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function serializeConfigurationRestorePoint(captured) {
  if (!(captured instanceof Map)) return null;
  return [...captured.entries()].map(([relative, entry]) => ({
    path: relative,
    mode: entry.mode,
    contentsBase64: Buffer.from(entry.contents).toString('base64')
  }));
}

function configurationRestorePoint(entries) {
  return new Map((entries ?? []).map((entry) => [entry.path, {
    mode: entry.mode,
    contents: Buffer.from(entry.contentsBase64, 'base64')
  }]));
}

export async function readStoryStartJournal(root, id) {
  const target = storyStartJournalPath(root, id);
  if (!(await exists(target))) return null;
  return { path: target, record: readRecord(FAMILY, await readFile(target)).record };
}

export async function listStoryStartJournals(root) {
  const directory = path.join(gitCommonDir(root), 'singularity-flow', 'story-start');
  const names = await readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const target = path.join(directory, name);
    try { records.push({ path: target, record: readRecord(FAMILY, await readFile(target)).record }); }
    catch (error) { records.push({ path: target, error: error.message }); }
  }
  return records;
}

export async function beginStoryStartJournal(root, {
  id,
  targetBranch,
  targetBranchExisted,
  originalBranch,
  originalHead,
  baseCommit,
  originalSession = null,
  originalCopilotSession = null,
  siblingRepositories = []
}) {
  const target = storyStartJournalPath(root, id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: currentSchemaVersion(FAMILY),
    kind: 'story-start-transaction',
    transactionId: randomUUID(),
    subject: { kind: 'story', id, branch: targetBranch },
    targetBranch,
    targetBranchExisted: targetBranchExisted === true,
    originalBranch,
    originalHead,
    baseCommit,
    workItemRelative: null,
    configurationRestorePoint: null,
    originalSession,
    originalCopilotSession,
    siblingRepositories,
    stage: 'prepared',
    owner: { pid: process.pid, host: os.hostname() },
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new SingularityFlowError(
        `Story '${id}' has an unfinished start transaction. Re-run start to recover it before creating new state.`,
        { code: 'STORY_START_RECOVERY_REQUIRED' }
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return record;
}

export async function updateStoryStartJournal(root, id, transactionId, updates) {
  const current = await readStoryStartJournal(root, id);
  if (!current || current.record.transactionId !== transactionId) return null;
  const record = { ...current.record, ...updates, updatedAt: nowIso() };
  await writePrivate(current.path, record);
  return record;
}

export async function clearStoryStartJournal(root, id, transactionId = null) {
  const current = await readStoryStartJournal(root, id);
  if (!current || (transactionId && current.record.transactionId !== transactionId)) return false;
  await unlink(current.path);
  return true;
}

function processAlive(owner) {
  if (owner?.host !== os.hostname() || !Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch { return false; }
}

function workflowAtTarget(root, record) {
  if (!record.workItemRelative || !refExists(root, `refs/heads/${record.targetBranch}`)) return false;
  const commits = run('git', [
    'rev-list', '--first-parent', `refs/heads/${record.targetBranch}`,
    ...(record.baseCommit ? [`^${record.baseCommit}`] : [])
  ], { cwd: root, allowFailure: true }).stdout.split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const identity = governedCommitIdentity(root, commit);
    if (identity?.transactionId !== record.transactionId) continue;
    const result = run('git', [
      'show', `${commit}:${record.workItemRelative}/workflow.json`
    ], { cwd: root, allowFailure: true });
    if (result.status !== 0) continue;
    try {
      const workflow = JSON.parse(result.stdout);
      if (workflow?.workItem?.id !== record.subject.id) continue;
      const binding = (workflow.publicationProjections ?? []).find((projection) =>
        projection.event?.type === 'binding'
          && projection.event?.subject?.id === record.subject.id
          && `sha256:${recordSha256(projection.event)}` === identity.eventSha256);
      if (binding) return true;
    } catch { /* A malformed aggregate is not proof of a completed start. */ }
  }
  return false;
}

function restoreRepositoryCheckout(repository, targetBranch) {
  if (!repository?.target || !repository?.from) return null;
  const current = run('git', ['branch', '--show-current'], { cwd: repository.target, allowFailure: true });
  if (current.status !== 0) return `${repository.repository}: repository is unavailable`;
  const currentBranch = current.stdout.trim();
  if (currentBranch !== targetBranch && currentBranch !== repository.from) {
    return `${repository.repository}: checkout moved to '${currentBranch}'`;
  }
  if (currentBranch === targetBranch) {
    const targetHead = run('git', ['rev-parse', 'HEAD'], { cwd: repository.target, allowFailure: true }).stdout.trim();
    if (!repository.targetBranchExisted && repository.baseCommit && targetHead !== repository.baseCommit) {
      return `${repository.repository}: Story branch contains an unrecognized commit`;
    }
    const switched = run('git', ['switch', repository.from], { cwd: repository.target, allowFailure: true });
    if (switched.status !== 0) return `${repository.repository}: ${(switched.stderr || switched.stdout).trim() || 'switch failed'}`;
  }
  if (!repository.targetBranchExisted && refExists(repository.target, `refs/heads/${targetBranch}`)) {
    const removed = run('git', ['branch', '-D', targetBranch], { cwd: repository.target, allowFailure: true });
    if (removed.status !== 0) return `${repository.repository}: ${(removed.stderr || removed.stdout).trim() || 'branch cleanup failed'}`;
  }
  return null;
}

/** Recover all mutations that can precede the ordinary Story publication journal. */
export async function recoverStoryStart(root, id, { force = false } = {}) {
  const current = await readStoryStartJournal(root, id);
  if (!current) return { status: 'absent' };
  const record = current.record;
  if (!force && processAlive(record.owner)) {
    throw new SingularityFlowError(
      `Story '${id}' is still being started by PID ${record.owner.pid} on ${record.owner.host}.`,
      { code: 'STORY_START_ACTIVE' }
    );
  }

  const subject = record.subject;
  const publication = await readPendingPublication(root, { ...subject, migrate: false });
  if (publication?.record?.recoveryStage === 'publication-recovery-diverged') {
    throw new SingularityFlowError(publication.record.error, {
      code: 'PUBLICATION_RECOVERY_DIVERGED', details: publication.record
    });
  }
  if (publication?.record?.recoveryStage === 'interrupted-before-branch-ref-advanced') {
    const recovered = await recoverPreparedPublicationBySubject(root, subject);
    if (recovered.status === 'active') {
      throw new SingularityFlowError(`Story '${id}' still has an active publication transaction.`, {
        code: 'STORY_START_ACTIVE'
      });
    }
    if (recovered.status === 'manual') {
      throw new SingularityFlowError(`Story '${id}' start needs manual publication recovery.`, {
        code: 'STORY_START_RECOVERY_DIVERGED', details: recovered
      });
    }
  } else if (publication || workflowAtTarget(root, record)) {
    await clearStoryStartJournal(root, id, record.transactionId);
    return { status: 'completed', preserved: true };
  }

  if (record.configurationRestorePoint) {
    await restoreConfigurationState(root, configurationRestorePoint(record.configurationRestorePoint));
  }
  await restoreAgentSession(root, record.originalSession ?? null);
  await restoreCopilotSession(root, record.originalCopilotSession ?? null);

  const failures = [];
  for (const repository of [...(record.siblingRepositories ?? [])].reverse()) {
    const failure = restoreRepositoryCheckout(repository, record.targetBranch);
    if (failure) failures.push(failure);
  }

  const currentBranch = branch(root);
  if (currentBranch !== record.targetBranch && currentBranch !== record.originalBranch) {
    failures.push(`root checkout moved to '${currentBranch}'`);
  } else if (currentBranch === record.targetBranch) {
    const targetHead = head(root);
    if (!record.targetBranchExisted && record.baseCommit && targetHead !== record.baseCommit) {
      failures.push('root Story branch contains an unrecognized commit');
    } else {
      const switched = run('git', ['switch', record.originalBranch], { cwd: root, allowFailure: true });
      if (switched.status !== 0) failures.push((switched.stderr || switched.stdout).trim() || 'root switch failed');
    }
  }
  if (!failures.length && !record.targetBranchExisted && refExists(root, `refs/heads/${record.targetBranch}`)) {
    const targetHead = refHead(root, `refs/heads/${record.targetBranch}`);
    if (record.baseCommit && targetHead !== record.baseCommit) failures.push('root Story ref no longer matches its start base');
    else {
      const removed = run('git', ['branch', '-D', record.targetBranch], { cwd: root, allowFailure: true });
      if (removed.status !== 0) failures.push((removed.stderr || removed.stdout).trim() || 'root branch cleanup failed');
    }
  }
  if (failures.length) {
    await updateStoryStartJournal(root, id, record.transactionId, {
      stage: 'recovery-diverged', recoveryErrors: failures
    });
    throw new SingularityFlowError(
      `Story '${id}' start recovery stopped safely: ${failures.join('; ')}. The journal was retained.`,
      { code: 'STORY_START_RECOVERY_DIVERGED', details: { failures } }
    );
  }
  await clearStoryStartJournal(root, id, record.transactionId);
  return { status: 'recovered', restored: true };
}
