import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { gitDir, head, remoteContains } from './git.mjs';
import {
  clearPublicationJournal,
  publicationJournalOwnedByCurrentProcess,
  readPublicationJournal
} from './publication-journal.mjs';
import { bindLifecycleEvent } from './lifecycle-event.mjs';
import { exists, readJson, writeJson } from './util.mjs';

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
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
  if (await exists(local)) return { path: local, record: await readJson(local), migrated: false };
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
      schemaVersion: 2,
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
    return { path: journal.path, record, migrated: false, journal: true };
  }
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath, roots })) {
    if (!(await exists(legacy))) continue;
    const record = await readJson(legacy);
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

export async function writePendingPublication(root, { kind, id, record } = {}) {
  const target = localPendingPublicationPath(root, kind, id);
  await writeJson(target, record);
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
