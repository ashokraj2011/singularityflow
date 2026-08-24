import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { changes, gitDir, head, remoteContains } from './git.mjs';
import {
  clearPublicationJournal,
  publicationJournalOwnedByCurrentProcess,
  readPublicationJournal
} from './publication-journal.mjs';
import { bindLifecycleEvent } from './lifecycle-event.mjs';
import { exists, readJson, writeJson } from './util.mjs';
import { subjectRef } from './subject-ref.mjs';
import { currentSchemaVersion, readRecord, stampCurrentRecord } from './schema-migrations.mjs';
import { restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';

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
  return path.join(gitDir(root), 'singularity-flow', 'pending-publication', `${kind}--${safeId(id)}.json`);
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

/**
 * Read the machine-local recovery marker, migrating the pre-kernel governed-tree
 * marker on first access. The rename to .git was deliberately a state-plane
 * change, not permission to forget an unpublished commit created by an older
 * release.
 */
export async function readPendingPublication(root, { kind, id, legacyPath = null, roots = {}, migrate = true } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  if (await exists(local)) return { path: local, record: readRecord(PENDING_PUBLICATION_FAMILY, await readJson(local)).record, migrated: false };
  const subject = { kind, id };
  const journal = await readPublicationJournal(root, subject);
  if (journal) {
    // State validation runs inside the transaction after its journal is durable. That transaction
    // must not diagnose its own marker as a previous crash; every other process still sees it.
    if (publicationJournalOwnedByCurrentProcess(journal.record)) return null;
    const currentHead = head(root);
    const advanced = currentHead !== journal.record.expectedHead;
    if (advanced && remoteContains(root, currentHead, journal.record.remote, journal.record.branch)) {
      if (migrate) await clearPublicationJournal(root, subject);
      return null;
    }
    const record = {
      schemaVersion: currentSchemaVersion(PENDING_PUBLICATION_FAMILY),
      subject,
      branch: journal.record.branch,
      remote: journal.record.remote,
      commit: advanced ? currentHead : null,
      event: advanced ? bindLifecycleEvent(journal.record.event, currentHead) : journal.record.event,
      createdAt: journal.record.createdAt,
      recoveryStage: advanced
        ? 'branch-ref-advanced-before-publication'
        : 'interrupted-before-branch-ref-advanced',
      error: advanced
        ? 'The process stopped after creating the local commit and before publication completed.'
        : 'The process stopped before the governed commit completed; inspect and repair the working tree before retrying.'
    };
    if (migrate && advanced) {
      await writeJson(local, record);
      await clearPublicationJournal(root, subject);
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
  const target = localPendingPublicationPath(root, kind, id);
  await writeJson(target, stampCurrentRecord(PENDING_PUBLICATION_FAMILY, record));
  return target;
}

export async function clearPendingPublication(root, { kind, id, legacyPath = null } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  if (await exists(local)) await unlink(local);
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

/**
 * Identify a pre-commit journal whose owning process is still running.
 *
 * A live owner is not an interrupted publication. In particular, a CLI command may be waiting at
 * an interactive confirmation while another surface asks to synchronize the same Story. Calling
 * that an interruption sends the operator toward destructive repair even though the transaction
 * still owns its lock. Recovery callers use this distinction to tell the operator to return to the
 * active command; they still fail closed when liveness is unknown.
 */
export function livePreparedPublicationOwner(pending) {
  const journal = pending?.journalRecord;
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || journal?.stage !== 'prepared'
    || journal?.commit != null
    || processIsAlive(journal.owner?.pid) !== true) return null;
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
  if (!pending?.journal
    || pending.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
    || journal?.stage !== 'prepared'
    || journal?.commit != null
    || head(root) !== journal.expectedHead
    || processIsAlive(journal.owner?.pid) !== false) return null;
  const subject = journal.subject;
  if (!subject?.kind || !subject?.id) return null;
  return withSubjectLock(root, subject, async () => {
    const latest = await readPublicationJournal(root, subject);
    if (!latest
      || latest.record.owner?.processId !== journal.owner?.processId
      || latest.record.expectedHead !== journal.expectedHead
      || latest.record.stage !== 'prepared'
      || latest.record.commit != null
      || head(root) !== journal.expectedHead) return null;
    let restoration = { restored: false, rescuePath: null, preimageSha256: null };
    if (latest.record.recoveryPreimage) {
      restoration = await restorePublicationPreimage(root, latest.record.recoveryPreimage, {
        subject,
        preserveCurrent: true
      });
    } else if (changes(root).trim()) return null;
    await clearPublicationJournal(root, subject);
    return Object.freeze({ recovered: true, ...restoration });
  });
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
