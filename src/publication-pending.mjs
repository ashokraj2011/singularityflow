import path from 'node:path';
import { readdir, unlink } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { exists, readJson, writeJson } from './util.mjs';

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

export function localPendingPublicationPath(root, kind, id) {
  return path.join(gitDir(root), 'singularity-flow', 'pending-publication', `${kind}--${safeId(id)}.json`);
}

export function defaultLegacyPendingPublicationPath(root, kind, id) {
  const directory = kind === 'initiative' ? 'initiatives' : 'work-items';
  return path.join(root, 'singularity', directory, String(id), 'publication-pending.json');
}

function legacyCandidates(root, { kind, id, legacyPath = null } = {}) {
  return [...new Set([
    legacyPath,
    defaultLegacyPendingPublicationPath(root, kind, id)
  ].filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

/**
 * Read the machine-local recovery marker, migrating the pre-kernel governed-tree
 * marker on first access. The rename to .git was deliberately a state-plane
 * change, not permission to forget an unpublished commit created by an older
 * release.
 */
export async function readPendingPublication(root, { kind, id, legacyPath = null } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  if (await exists(local)) return { path: local, record: await readJson(local), migrated: false };
  for (const legacy of legacyCandidates(root, { kind, id, legacyPath })) {
    if (!(await exists(legacy))) continue;
    const record = await readJson(legacy);
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
}

/** Find legacy markers that no active subject read has migrated. */
export async function findLegacyPendingPublications(root) {
  const singularity = path.join(root, 'singularity');
  if (!(await exists(singularity))) return [];
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name === 'publication-pending.json') found.push(absolute);
    }
  }
  await visit(singularity);
  return found.sort();
}
