import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { branch, gitCommonDir, governedCommitIdentity, head, refExists, refHead } from './git.mjs';
import { restoreConfigurationState } from './configuration-branch.mjs';
import { restoreAgentSession, restoreCopilotSession } from './session.mjs';
import {
  readPendingPublication, recoverPreparedPublicationBySubject,
  verifyPendingPublicationCandidateAuthority, verifyPendingPublicationCommit
} from './publication-pending.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { exists, nowIso, run, SingularityFlowError, writeAtomic } from './util.mjs';
import { recordSha256 } from './records.mjs';
import { bindLifecycleEvent } from './lifecycle-event.mjs';
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import { verifiedSgosLifecycleCandidateForCommit } from './sgos/candidate-lifecycle.mjs';
import { scavengeStoryDocumentCaptures } from './story-start-documents.mjs';

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
  siblingRepositories = [],
  publicationRemote = null,
  publicationRemoteFingerprint = null,
  publicationExpectedRemoteSha = undefined
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
    publicationRemote,
    publicationRemoteFingerprint,
    ...(publicationExpectedRemoteSha !== undefined
      ? { publicationExpectedRemoteSha }
      : {}),
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

function safeWorkItemRelative(value) {
  const candidate = String(value ?? '').replaceAll('\\', '/');
  const normalized = path.posix.normalize(candidate);
  return candidate && normalized === candidate && !path.posix.isAbsolute(candidate)
    && candidate !== '..' && !candidate.startsWith('../') ? candidate : null;
}

function completionProjection(root, record, commit, identity) {
  const failures = [];
  const workItemRelative = safeWorkItemRelative(record.workItemRelative);
  if (!workItemRelative) {
    return { failures: ['the Story work-item path is invalid'], event: null };
  }
  const result = run('git', [
    'show', `${commit}:${workItemRelative}/workflow.json`
  ], { cwd: root, allowFailure: true });
  if (result.status !== 0) {
    return { failures: ['the exact commit has no Story workflow aggregate'], event: null };
  }
  let workflow;
  try { workflow = JSON.parse(result.stdout); }
  catch { return { failures: ['the exact commit has a malformed Story workflow aggregate'], event: null }; }
  if (workflow?.workItem?.id !== record.subject.id) failures.push('the workflow subject ID is different');
  if (workflow?.workItem?.branch !== record.targetBranch
      || workflow?.lineage?.canonicalBranch !== record.targetBranch) {
    failures.push('the workflow branch binding is different');
  }
  const bindings = (workflow.publicationProjections ?? []).filter((projection) =>
    projection?.event?.type === 'binding'
      && projection.event.subject?.kind === 'story'
      && projection.event.subject.id === record.subject.id
      && projection.event.subject.branch === record.targetBranch
      && `sha256:${recordSha256(projection.event)}` === identity.eventSha256);
  if (bindings.length !== 1) failures.push('the workflow has no unique exact binding projection');
  return { failures, event: bindings.length === 1 ? bindings[0].event : null };
}

function startCompletionRemote(root, record, pendingRecord, publicationMode) {
  const remote = record.publicationRemote ?? pendingRecord?.remote ?? 'origin';
  if (publicationMode === 'off') return { remote, remoteFingerprint: null };
  if (record.publicationRemoteFingerprint) {
    return { remote, remoteFingerprint: record.publicationRemoteFingerprint };
  }
  try {
    const authority = configuredRemoteAuthority(root, remote);
    return { remote, remoteFingerprint: authority?.fingerprint ?? null };
  } catch {
    return { remote, remoteFingerprint: null };
  }
}

/**
 * Older Story-start journals predate `publicationExpectedRemoteSha`. A branch materialized from an
 * existing local or remote Story ref used its accepted base as the push lease, while a newly-created
 * branch used create-only semantics (`null`). Recover only the modes whose persisted checkout result
 * proves materialization; unknown legacy modes remain create-only rather than guessing from the
 * weaker `targetBranchExisted` flag (remote-only branches recorded that flag as false).
 */
function recoveryExpectedRemoteSha(record) {
  if (Object.hasOwn(record, 'publicationExpectedRemoteSha')) {
    return record.publicationExpectedRemoteSha;
  }
  return ['already-current', 'checked-out-local', 'tracked-remote'].includes(record.checkoutMode)
    ? record.baseCommit ?? null
    : null;
}

/**
 * Prove that the target ref is the exact Candidate-bound Story-start transaction before treating
 * an interrupted outer start as complete. Transaction/event trailers alone are descriptive: a
 * new commit can copy them while changing the tree or omitting an initial document. Reopen the
 * retained Candidate and receipt, recompute the transaction state digest, and bind the one parent
 * to the journal's accepted base before clearing any recovery authority.
 */
async function completedWorkflowAtTarget(root, record, pending = null) {
  const targetRef = `refs/heads/${record.targetBranch}`;
  if (!record.workItemRelative || !refExists(root, targetRef)) {
    return { completed: false, failures: [] };
  }
  const commit = refHead(root, targetRef);
  const identity = governedCommitIdentity(root, commit);
  if (identity?.transactionId !== record.transactionId) {
    return {
      completed: false,
      failures: commit !== record.baseCommit
        ? ['the Story branch advanced without the exact start transaction'] : []
    };
  }
  const failures = [];
  if (identity.parents.length !== 1 || identity.parents[0] !== record.baseCommit) {
    failures.push('the governed start parent does not equal the accepted Story base');
  }
  const projection = completionProjection(root, record, commit, identity);
  failures.push(...projection.failures);

  let publicationRecord = pending?.record ?? null;
  if (publicationRecord) {
    if (publicationRecord.commit !== commit) failures.push('the pending publication names a different commit');
    if (publicationRecord.transactionId !== record.transactionId) {
      failures.push('the pending publication names a different transaction');
    }
  } else if (projection.event) {
    let candidate = null;
    try {
      candidate = (await verifiedSgosLifecycleCandidateForCommit(root, commit)).binding;
    } catch (error) {
      failures.push(`the exact retained Candidate or receipt is unavailable (${error?.code ?? 'invalid'})`);
    }
    const publication = startCompletionRemote(root, record, null, identity.publicationMode);
    publicationRecord = {
      subject: record.subject,
      branch: record.targetBranch,
      remote: publication.remote,
      remoteFingerprint: publication.remoteFingerprint,
      commit,
      transactionId: record.transactionId,
      tree: identity.tree,
      eventSha256: identity.eventSha256,
      stateSha256: identity.stateSha256,
      publicationMode: identity.publicationMode,
      candidate,
      event: bindLifecycleEvent(projection.event, commit),
      ...(identity.publicationMode !== 'off' ? {
        // The normal publication unit clears its pending marker only after a successful push. If
        // the outer Story-start process dies before clearing this journal, transport is therefore
        // known to have crossed its success boundary even though the journal itself does not store
        // the porcelain output. Use the closed recovery vocabulary; this field is not part of the
        // governed transaction digest.
        pushOutcome: 'transport-indeterminate',
        expectedRemoteSha: recoveryExpectedRemoteSha(record)
      } : {})
    };
  }

  if (publicationRecord && projection.event) {
    const publication = startCompletionRemote(
      root, record, publicationRecord, publicationRecord.publicationMode
    );
    const verification = verifyPendingPublicationCommit(root, publicationRecord, {
      subject: record.subject,
      branch: record.targetBranch,
      remote: publication.remote,
      allowPublicationOff: true
    });
    if (!verification.valid) failures.push(...verification.failures);
    if (!verification.candidateVerified) failures.push('the governed start has no verified Candidate binding');
    const candidateAuthority = await verifyPendingPublicationCandidateAuthority(root, publicationRecord);
    if (!candidateAuthority.valid || !candidateAuthority.candidateVerified) {
      failures.push(...candidateAuthority.failures);
      if (!candidateAuthority.candidateVerified && candidateAuthority.failures.length === 0) {
        failures.push('the exact Candidate verification receipt is unavailable');
      }
    } else {
      const admission = candidateAuthority.lifecycleAdmission;
      if (admission?.subject?.kind !== 'story'
          || admission.subject.id !== record.subject.id
          || admission.eventType !== 'binding'
          || admission.normalizedEventSha256 !== publicationRecord.candidate?.normalizedEventSha256) {
        failures.push('the Candidate receipt does not authorize this exact Story binding');
      }
    }
  } else if (projection.event) {
    failures.push('the governed start publication identity is unavailable');
  }
  return { completed: failures.length === 0, failures: [...new Set(failures)], commit };
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

/** Prove every checkout is still at a state recovery understands before writing any plane. */
function inspectRepositoryCheckout(repository, targetBranch) {
  if (!repository?.target || !repository?.from) return `${repository?.repository ?? 'repository'}: recovery record is incomplete`;
  const current = run('git', ['branch', '--show-current'], { cwd: repository.target, allowFailure: true });
  if (current.status !== 0) return `${repository.repository}: repository is unavailable`;
  const currentBranch = current.stdout.trim();
  if (currentBranch !== targetBranch && currentBranch !== repository.from) {
    return `${repository.repository}: checkout moved to '${currentBranch}'`;
  }
  if (!repository.targetBranchExisted && refExists(repository.target, `refs/heads/${targetBranch}`)) {
    const targetHead = refHead(repository.target, `refs/heads/${targetBranch}`);
    if (repository.baseCommit && targetHead !== repository.baseCommit) {
      return `${repository.repository}: Story branch contains an unrecognized commit`;
    }
  }
  return null;
}

/** Recover all mutations that can precede the ordinary Story publication journal. */
export async function recoverStoryStart(root, id, { force = false } = {}) {
  const current = await readStoryStartJournal(root, id);
  if (!current) return { status: 'absent' };
  // A prior process may have died after privately capturing Story-birth evidence but before its
  // journal could be completed. The scavenger is confined to validated leases in this repository's
  // Git common directory; malformed, live, foreign, and symlinked entries are retained.
  await scavengeStoryDocumentCaptures(root);
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
  } else {
    const completion = await completedWorkflowAtTarget(root, record, publication);
    if (completion.completed) {
      await clearStoryStartJournal(root, id, record.transactionId);
      return { status: 'completed', preserved: true, commit: completion.commit };
    }
    if (publication || completion.failures.length) {
      const failures = completion.failures.length
        ? completion.failures : ['the pending publication is not the exact Story-start commit'];
      await updateStoryStartJournal(root, id, record.transactionId, {
        stage: 'recovery-diverged', recoveryErrors: failures
      });
      throw new SingularityFlowError(
        `Story '${id}' start recovery stopped safely: ${failures.join('; ')}. The journal was retained.`,
        { code: 'STORY_START_RECOVERY_DIVERGED', details: { failures } }
      );
    }
  }

  const failures = [];
  // This is deliberately a read-only preflight. A diverged checkout must not receive restored
  // configuration/session bytes before the operator has reviewed it.
  const currentBranch = branch(root);
  if (currentBranch !== record.targetBranch && currentBranch !== record.originalBranch) {
    failures.push(`root checkout moved to '${currentBranch}'`);
  } else if (currentBranch === record.targetBranch) {
    const targetHead = head(root);
    if (record.baseCommit && targetHead !== record.baseCommit) {
      failures.push('root Story branch contains an unrecognized commit');
    }
  }
  for (const repository of [...(record.siblingRepositories ?? [])].reverse()) {
    const failure = inspectRepositoryCheckout(repository, record.targetBranch);
    if (failure) failures.push(failure);
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

  // Configuration materialization only happens after the root is on the Story branch. If a prior
  // recovery already returned to the original branch, replaying these bytes there would corrupt a
  // stable checkout.
  if (currentBranch === record.targetBranch && record.configurationRestorePoint) {
    await restoreConfigurationState(root, configurationRestorePoint(record.configurationRestorePoint));
  }
  await restoreAgentSession(root, record.originalSession ?? null);
  await restoreCopilotSession(root, record.originalCopilotSession ?? null);

  for (const repository of [...(record.siblingRepositories ?? [])].reverse()) {
    const failure = restoreRepositoryCheckout(repository, record.targetBranch);
    if (failure) failures.push(failure);
  }

  if (currentBranch === record.targetBranch) {
    const targetHead = head(root);
    if (record.baseCommit && targetHead !== record.baseCommit) {
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
