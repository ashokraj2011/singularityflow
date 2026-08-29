import path from 'node:path';
import os from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import {
  branch, changes, commitIsAncestor, gitCommonDir, governedCommitIdentity, head, remoteContains
} from './git.mjs';
import {
  clearPublicationJournal,
  publicationJournalOwnedByCurrentProcess,
  readPublicationJournal,
  updatePublicationJournal
} from './publication-journal.mjs';
import { bindLifecycleEvent } from './lifecycle-event.mjs';
import { recordSha256 } from './records.mjs';
import { exists, readJson, writeJson } from './util.mjs';
import { subjectRef } from './subject-ref.mjs';
import { currentSchemaVersion, readRecord, stampCurrentRecord } from './schema-migrations.mjs';
import { restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { subjectLockPath } from './subject-lock.mjs';
import {
  prepareSharedPublicationStorage, resolveSharedPublicationFile
} from './publication-storage.mjs';

const PENDING_PUBLICATION_FAMILY = 'pending-publication';

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

function displayMarkerPath(root, absolute) {
  if (!absolute) return null;
  const relative = path.relative(root, absolute);
  if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join('/');
  }
  return `pending-publication/${path.basename(absolute)}`;
}

export function localPendingPublicationPath(root, kind, id) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'pending-publication', `${kind}--${safeId(id)}.json`);
}

async function sharedPendingPublication(root, kind, id, { migrate = true } = {}) {
  return resolveSharedPublicationFile(root, {
    directory: 'pending-publication',
    name: `${kind}--${safeId(id)}.json`,
    label: `Pending publication for ${kind} '${id}'`,
    read: async (target) => readRecord(PENDING_PUBLICATION_FAMILY, await readJson(target)).record,
    identity: recordSha256,
    migrate
  });
}

/**
 * Where a pre-kernel release would have left the marker.
 *
 * `workItemRoot` and `initiativeRoot` are configurable, and this hard-coded `singularity/…`, so a
 * repository that keeps its work items anywhere else had markers that no lookup here could see —
 * while every mutation path, which passes its own `legacyPath`, refused to run because of them.
 */
export function defaultLegacyPendingPublicationPath(root, kind, id, roots = {}) {
  const directory = kind === 'initiative'
    ? (roots.initiativeRoot ?? 'singularity/initiatives')
    : (roots.workItemRoot ?? 'singularity/work-items');
  return path.join(root, directory, String(id), 'publication-pending.json');
}

function legacyCandidates(root, { kind, id, legacyPath = null, roots = {} } = {}) {
  return [...new Set([
    legacyPath,
    defaultLegacyPendingPublicationPath(root, kind, id, roots),
    // The stock location too, so a repository that moved its roots still finds what an older
    // release left behind before the move.
    defaultLegacyPendingPublicationPath(root, kind, id)
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function recoveryRecord(journal, updates = {}) {
  return {
    schemaVersion: currentSchemaVersion(PENDING_PUBLICATION_FAMILY),
    subject: journal.subject,
    branch: journal.branch,
    remote: journal.remote,
    commit: journal.commit ?? null,
    event: journal.commit ? bindLifecycleEvent(journal.event, journal.commit) : journal.event,
    transactionId: journal.transactionId ?? null,
    tree: journal.tree ?? null,
    eventSha256: journal.eventSha256 ?? null,
    stateSha256: journal.stateSha256 ?? null,
    publicationMode: journal.publicationMode ?? null,
    createdAt: journal.createdAt,
    ...updates
  };
}

function divergentRecovery(journal, reason) {
  return recoveryRecord(journal, {
    recoveryStage: 'publication-recovery-diverged',
    code: 'PUBLICATION_RECOVERY_DIVERGED',
    error: `Automatic recovery stopped because ${reason}. The journal was retained and no ref or remote was changed.`
  });
}

function verifiedJournalCommit(root, journal) {
  if (!journal.transactionId || !journal.commit || !journal.tree || !journal.stateSha256) {
    return { valid: false, reason: 'the journal does not identify one exact transaction commit' };
  }
  const identity = governedCommitIdentity(root, journal.commit);
  if (!identity) return { valid: false, reason: `recorded commit ${journal.commit} is unavailable` };
  const mismatch = [
    [identity.parents.length === 1 && identity.parents[0] === journal.expectedHead, 'parent commit'],
    [identity.tree === journal.tree, 'tree'],
    [identity.transactionId === journal.transactionId, 'transaction ID'],
    [identity.eventSha256 === journal.eventSha256, 'event digest'],
    [identity.stateSha256 === journal.stateSha256, 'state digest'],
    [identity.publicationMode === journal.publicationMode, 'publication mode']
  ].find(([matches]) => !matches);
  return mismatch
    ? { valid: false, reason: `the recorded commit has a different ${mismatch[1]}` }
    : { valid: true, identity };
}

function fullObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function sha256Digest(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/**
 * Verify that a durable post-commit recovery marker names one exact governed transaction.
 *
 * A pending marker is transport authority: `sync` is allowed to move a remote ref solely because
 * this record says a prior governed transaction crossed its local commit boundary. Schema-version
 * validation alone does not prove that claim. Bind every mutable marker field back to the immutable
 * commit object and its trailers before exposing the commit to a push command.
 */
export function verifyPendingPublicationCommit(root, record, {
  subject = null,
  branch: expectedBranch = null,
  remote: expectedRemote = null,
  allowPublicationOff = false
} = {}) {
  const failures = [];
  const publicationModes = allowPublicationOff ? ['off', 'required', 'warn'] : ['required', 'warn'];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return Object.freeze({ valid: false, failures: ['marker is not an object'], identity: null });
  }
  if (!record.subject || typeof record.subject !== 'object' || Array.isArray(record.subject)) {
    failures.push('subject is missing');
  } else {
    if (!['story', 'initiative'].includes(record.subject.kind)) failures.push('subject kind is invalid');
    if (!String(record.subject.id ?? '').trim()) failures.push('subject ID is missing');
    if (subject?.kind && record.subject.kind !== subject.kind) failures.push('subject kind does not match the requested subject');
    if (subject?.id && record.subject.id !== subject.id) failures.push('subject ID does not match the requested subject');
  }
  if (!String(record.branch ?? '').trim()) failures.push('publication branch is missing');
  if (expectedBranch && record.branch !== expectedBranch) failures.push('publication branch does not match the requested branch');
  if (record.subject?.branch && record.subject.branch !== record.branch) failures.push('subject branch does not match the publication branch');
  if (!String(record.remote ?? '').trim()) failures.push('publication remote is missing');
  if (expectedRemote && record.remote !== expectedRemote) failures.push('publication remote does not match the configured remote');
  if (!fullObjectId(record.commit)) failures.push('commit is not a full lowercase Git object ID');
  if (!fullObjectId(record.tree)) failures.push('tree is not a full lowercase Git object ID');
  if (!String(record.transactionId ?? '').trim()) failures.push('transaction ID is missing');
  if (!sha256Digest(record.eventSha256)) failures.push('event digest is invalid');
  if (!sha256Digest(record.stateSha256)) failures.push('state digest is invalid');
  if (!publicationModes.includes(record.publicationMode)) failures.push('publication mode is invalid');
  if (!record.event || typeof record.event !== 'object' || Array.isArray(record.event)) {
    failures.push('bound lifecycle event is missing');
  } else {
    if (record.event.subject?.kind !== record.subject?.kind
      || record.event.subject?.id !== record.subject?.id) failures.push('event subject does not match the marker subject');
    if (record.event.subject?.branch && record.event.subject.branch !== record.branch) {
      failures.push('event branch does not match the publication branch');
    }
    const transactionEvent = {
      ...record.event,
      sourceCommit: null,
      idempotencyKey: null,
      idempotencyHash: null
    };
    const eventSha256 = `sha256:${recordSha256(transactionEvent)}`;
    if (record.eventSha256 !== eventSha256) failures.push('event digest does not match the bound lifecycle event');
    if (fullObjectId(record.commit)) {
      try {
        const rebound = bindLifecycleEvent(transactionEvent, record.commit);
        if (record.event.sourceCommit !== rebound.sourceCommit) failures.push('event source commit does not match the recorded commit');
        if (record.event.idempotencyKey !== rebound.idempotencyKey) failures.push('event idempotency key is invalid');
        if (record.event.idempotencyHash !== rebound.idempotencyHash) failures.push('event idempotency digest is invalid');
      } catch {
        failures.push('event transport binding is invalid');
      }
    }
  }

  const identity = fullObjectId(record.commit) ? governedCommitIdentity(root, record.commit) : null;
  if (!identity) failures.push('recorded commit is unavailable');
  else {
    if (identity.commit !== record.commit) failures.push('commit does not resolve to the exact recorded object ID');
    if (identity.parents.length !== 1) failures.push('governed transaction commit must have exactly one parent');
    if (identity.tree !== record.tree) failures.push('commit tree does not match the marker tree');
    if (identity.transactionId !== record.transactionId) failures.push('commit transaction trailer does not match the marker');
    if (identity.eventSha256 !== record.eventSha256) failures.push('commit event trailer does not match the marker');
    if (identity.stateSha256 !== record.stateSha256) failures.push('commit state trailer does not match the marker');
    if (identity.publicationMode !== record.publicationMode) failures.push('commit publication-mode trailer does not match the marker');
    if (identity.parents.length === 1
      && fullObjectId(record.tree)
      && String(record.transactionId ?? '').trim()
      && sha256Digest(record.eventSha256)
      && publicationModes.includes(record.publicationMode)) {
      const stateSha256 = `sha256:${recordSha256({
        transactionId: record.transactionId,
        expectedHead: identity.parents[0],
        branch: record.branch,
        tree: record.tree,
        eventSha256: record.eventSha256,
        publicationMode: record.publicationMode
      })}`;
      if (record.stateSha256 !== stateSha256) failures.push('state digest does not match the governed transaction identity');
    }
  }
  return Object.freeze({ valid: failures.length === 0, failures: Object.freeze(failures), identity });
}

/**
 * Read the machine-local recovery marker, migrating the pre-kernel governed-tree
 * marker on first access. The rename to .git was deliberately a state-plane
 * change, not permission to forget an unpublished commit created by an older
 * release.
 */
export async function readPendingPublication(root, { kind, id, legacyPath = null, roots = {}, migrate = true } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  const shared = await sharedPendingPublication(root, kind, id, { migrate });
  if (shared) return {
    path: shared.path, record: shared.value, migrated: shared.migrated,
    ...(shared.migratedFrom?.length ? { migratedFrom: shared.migratedFrom } : {})
  };
  const subject = { kind, id };
  const journal = await readPublicationJournal(root, subject, { migrate });
  if (journal) {
    // State validation runs inside the transaction after its journal is durable. That transaction
    // must not diagnose its own marker as a previous crash; every other process still sees it.
    if (publicationJournalOwnedByCurrentProcess(journal.record, root)) return null;
    const recorded = journal.record;
    const currentHead = head(root);
    const currentBranch = branch(root);
    if (currentBranch !== recorded.branch) {
      return {
        path: journal.path,
        record: divergentRecovery(recorded, `the checkout is on branch '${currentBranch}', not transaction branch '${recorded.branch}'`),
        migrated: false,
        journal: true,
        journalRecord: recorded
      };
    }
    if (!recorded.commit) {
      const record = currentHead === recorded.expectedHead
        ? recoveryRecord(recorded, {
            recoveryStage: 'interrupted-before-branch-ref-advanced',
            error: 'The process stopped before the governed commit completed; exact pre-transaction recovery is available.'
          })
        : divergentRecovery(recorded, `HEAD changed from ${recorded.expectedHead} to ${currentHead} without an identified transaction commit`);
      return { path: journal.path, record, migrated: false, journal: true, journalRecord: recorded };
    }
    const verification = verifiedJournalCommit(root, recorded);
    if (!verification.valid) {
      return {
        path: journal.path,
        record: divergentRecovery(recorded, verification.reason),
        migrated: false,
        journal: true,
        journalRecord: recorded
      };
    }
    const refAdvanced = currentHead !== recorded.expectedHead
      && commitIsAncestor(root, recorded.commit, currentHead);
    if (!refAdvanced) {
      if (currentHead !== recorded.expectedHead || recorded.refAdvanced === true) {
        return {
          path: journal.path,
          record: divergentRecovery(recorded, `branch '${recorded.branch}' does not contain the exact transaction commit ${recorded.commit}`),
          migrated: false,
          journal: true,
          journalRecord: recorded
        };
      }
      const record = recoveryRecord(recorded, {
        recoveryStage: 'interrupted-before-branch-ref-advanced',
        error: 'The transaction commit object was created, but the branch ref was not advanced; exact pre-transaction recovery is available.'
      });
      return { path: journal.path, record, migrated: false, journal: true, journalRecord: recorded };
    }
    if (recorded.publicationMode === 'off') {
      if (migrate) await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      return null;
    }
    if (remoteContains(root, recorded.commit, recorded.remote, recorded.branch)) {
      if (migrate) await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      return null;
    }
    const record = recoveryRecord(recorded, {
      recoveryStage: 'branch-ref-advanced-before-publication',
      error: 'The process stopped after creating the exact governed commit and before publication completed.'
    });
    if (migrate) {
      await prepareSharedPublicationStorage(
        root, 'pending-publication', `Pending publication for ${kind} '${id}'`
      );
      await writeJson(local, record);
      await clearPublicationJournal(root, subject, { transactionId: recorded.transactionId });
      return { path: local, record, migrated: true, migratedFrom: journal.path };
    }
    return { path: journal.path, record, migrated: false, journal: true, journalRecord: journal.record };
  }
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath, roots })) {
    if (!(await exists(legacy))) continue;
    const record = readRecord(PENDING_PUBLICATION_FAMILY, await readJson(legacy)).record;
    // `migrate: false` for read-only callers. Migration deletes a tracked file, and a snapshot that
    // mutates the working tree while capturing it fails its own did-anything-change check — so the
    // first snapshot after an upgrade hard-errored, blaming a concurrent writer that did not exist.
    if (!migrate) return { path: legacy, record, migrated: false, pendingMigrationFrom: legacy };
    await prepareSharedPublicationStorage(
      root, 'pending-publication', `Pending publication for ${kind} '${id}'`
    );
    await writeJson(local, record);
    await unlink(legacy);
    return { path: local, record, migrated: true, migratedFrom: legacy };
  }
  return null;
}

export async function hasPendingPublication(root, options) {
  return Boolean(await readPendingPublication(root, options));
}

/** Read-only, fail-closed recovery discovery for Home and other projections. */
export async function inspectPendingPublication(root, options = {}) {
  const subject = subjectRef(options, { code: 'WORK_PENDING_SUBJECT_KEY_REQUIRED' });
  let expectedPath = null;
  try {
    expectedPath = localPendingPublicationPath(root, subject.kind, subject.id);
    const pending = await readPendingPublication(root, { ...options, ...subject, migrate: false });
    if (!pending) return Object.freeze({ status: 'absent', subject, path: displayMarkerPath(root, expectedPath) });
    const recordSubject = pending.record?.subject;
    if (recordSubject?.kind !== subject.kind || recordSubject?.id !== subject.id) {
      const error = new Error('Pending publication marker schema or subject identity is invalid.');
      error.code = 'PUBLICATION_MARKER_UNREADABLE';
      throw error;
    }
    return Object.freeze({
      status: 'pending', subject, path: displayMarkerPath(root, pending.path), record: pending.record
    });
  } catch (error) {
    // A projection fixture or ungoverned directory has no Git-local recovery plane at all. This is
    // distinct from a repository whose marker exists but cannot be read.
    if (/not a git repository/i.test(error?.message ?? '')) {
      return Object.freeze({ status: 'absent', subject, path: null });
    }
    return Object.freeze({
      status: 'unreadable', subject, path: displayMarkerPath(root, expectedPath),
      code: 'PUBLICATION_MARKER_UNREADABLE', error: error?.message ?? 'Marker could not be read.'
    });
  }
}

export async function writePendingPublication(root, { kind, id, record } = {}) {
  await sharedPendingPublication(root, kind, id);
  await prepareSharedPublicationStorage(
    root, 'pending-publication', `Pending publication for ${kind} '${id}'`
  );
  const target = localPendingPublicationPath(root, kind, id);
  await writeJson(target, stampCurrentRecord(PENDING_PUBLICATION_FAMILY, record));
  return target;
}

export async function clearPendingPublication(root, { kind, id, legacyPath = null } = {}) {
  const local = await sharedPendingPublication(root, kind, id);
  if (local) await unlink(local.path);
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath })) {
    if (await exists(legacy)) await unlink(legacy);
  }
  await clearPublicationJournal(root, { kind, id });
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'ESRCH' ? false : null; }
}

function journalLeaseIsLive(root, journal) {
  if (!root || !journal?.owner?.lockToken) return processIsAlive(journal?.owner?.pid) === true;
  const directory = subjectLockPath(root, journal.subject);
  let owner;
  try { owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8')); }
  catch { return false; }
  if (owner.lockToken !== journal.owner.lockToken
    || owner.processToken !== journal.owner.processToken
    || owner.host !== journal.owner.host) return false;
  const acquired = Date.parse(owner.acquiredAt ?? '');
  const expires = Date.parse(owner.expiresAt ?? '');
  const ttlMs = Number.isFinite(acquired) && Number.isFinite(expires) ? expires - acquired : 0;
  let heartbeat = 0;
  try {
    heartbeat = statSync(path.join(directory, `heartbeat-${encodeURIComponent(owner.lockToken).replace(/%/g, '_')}`)).mtimeMs;
  } catch { /* Missing exact-token heartbeat cannot extend the recorded lease. */ }
  const deadline = Math.max(Number.isFinite(expires) ? expires : 0, heartbeat + Math.max(0, ttlMs));
  if (Date.now() > deadline) return false;
  if (owner.host === os.hostname() && processIsAlive(owner.pid) !== true) return false;
  return true;
}

/**
 * Identify a pre-commit journal whose owning process is still running.
 *
 * A live owner is not an interrupted publication. In particular, a CLI command may be waiting at
 * an interactive confirmation while another surface asks to synchronize the same Story. Calling
 * that an interruption sends the operator toward destructive repair even though the transaction
 * still owns its lock. Recovery callers use this distinction to tell the operator to return to the
 * active command; they still fail closed when liveness is unknown.
 */
export function livePreparedPublicationOwner(pending, root = null) {
  const journal = pending?.journalRecord;
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(journal?.stage)
    || journal?.refAdvanced === true
    || !journalLeaseIsLive(root, journal)) return null;
  return Object.freeze({
    pid: journal.owner.pid,
    processId: journal.owner.processId ?? null,
    createdAt: journal.createdAt ?? null,
    updatedAt: journal.updatedAt ?? null
  });
}

/**
 * Recover a dead pre-commit transaction under the same subject lock used by publication.
 *
 * New journals carry a durable preimage and can restore a partially written governed directory.
 * Legacy journals have no such proof and retain the old clean-tree-only recovery rule. The journal
 * remains in place on every refusal or restore failure, so retrying recovery is idempotent.
 */
export async function recoverPreparedPublication(root, pending) {
  const journal = pending?.journalRecord;
  const commitIsVerifiedPreRef = journal?.commit == null
    || (journal?.refAdvanced !== true && verifiedJournalCommit(root, journal).valid);
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(journal?.stage)
    || !commitIsVerifiedPreRef
    || head(root) !== journal.expectedHead
    || branch(root) !== journal.branch
    || journalLeaseIsLive(root, journal)) return null;
  const subject = journal.subject;
  if (!subject?.kind || !subject?.id) return null;
  return withSubjectLock(root, subject, async () => {
    const latest = await readPublicationJournal(root, subject);
    if (!latest
      || latest.record.owner?.processId !== journal.owner?.processId
      || latest.record.expectedHead !== journal.expectedHead
      || latest.record.transactionId !== journal.transactionId
      || !['prepared', 'commit-created', 'restoring', 'rollback-failed'].includes(latest.record.stage)
      || latest.record.refAdvanced === true
      || head(root) !== journal.expectedHead) return null;
    let restoration = { restored: false, rescuePath: null, preimageSha256: null };
    try {
      if (!latest.record.recoveryPreimage && changes(root).trim()) return null;
      await updatePublicationJournal(root, subject, {
        stage: 'restoring', recoveryAttemptedAt: new Date().toISOString()
      }, { transactionId: journal.transactionId });
      if (latest.record.recoveryPreimage) {
        restoration = await restorePublicationPreimage(root, latest.record.recoveryPreimage, {
          subject,
          preserveCurrent: true
        });
      }
    } catch (error) {
      await updatePublicationJournal(root, subject, {
        stage: 'rollback-failed',
        rollbackError: error?.message ?? String(error),
        rollbackFailedAt: new Date().toISOString()
      }, { transactionId: journal.transactionId }).catch(() => {});
      throw error;
    }
    await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
    return Object.freeze({ recovered: true, ...restoration });
  });
}

/**
 * Recover a dead pre-commit transaction using only its Git-local subject identity.
 *
 * This deliberately does not load workflow.json or state.json. A process can die halfway through
 * writing either aggregate, and requiring that damaged file to parse before its own write-ahead
 * journal can be read makes the recovery path unreachable at the exact failure it exists for.
 */
export async function recoverPreparedPublicationBySubject(root, subject) {
  const pending = await readPendingPublication(root, { ...subject, migrate: false });
  if (!pending?.journal || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced') {
    return Object.freeze({ status: pending ? 'not-precommit' : 'absent', subject, pending });
  }
  const active = livePreparedPublicationOwner(pending, root);
  if (active) return Object.freeze({ status: 'active', subject, active, pending });
  const recovery = await recoverPreparedPublication(root, pending);
  return recovery
    ? Object.freeze({ status: 'recovered', subject, ...recovery })
    : Object.freeze({ status: 'manual', subject, pending });
}

/** Backward-compatible boolean wrapper used by older clean-journal recovery callers and tests. */
export async function discardCleanPreparedPublication(root, pending) {
  return Boolean(await recoverPreparedPublication(root, pending));
}

/** Find legacy markers that no active subject read has migrated. */
export async function findLegacyPendingPublications(root, roots = {}) {
  // Every configured root, not just `singularity/`. A marker for a Story that has since been
  // deleted is never migrated by a subject read, so this scan is the only thing that can surface
  // it — and it was blind to exactly the repositories that had moved their roots.
  const bases = [...new Set([
    path.join(root, 'singularity'),
    path.join(root, roots.workItemRoot ?? 'singularity/work-items'),
    path.join(root, roots.initiativeRoot ?? 'singularity/initiatives')
  ].map((base) => path.resolve(base)))]
    .filter((base, _index, all) => !all.some((other) => other !== base && base.startsWith(`${other}${path.sep}`)));
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === 'publication-pending.json') found.push(absolute);
    }
  }
  for (const base of bases) if (await exists(base)) await visit(base);
  return found.sort();
}
