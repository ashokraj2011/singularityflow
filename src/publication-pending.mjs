import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { exists, readJson, writeJson } from './util.mjs';

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

export function localPendingPublicationPath(root, kind, id) {
  return path.join(gitDir(root), 'singularity-flow', 'pending-publication', `${kind}--${safeId(id)}.json`);
}

export async function readPendingPublication(root, { kind, id, legacyPath = null } = {}) {
  const local = localPendingPublicationPath(root, kind, id);
  if (await exists(local)) return { path: local, record: await readJson(local), migrated: false };
  if (!legacyPath || !(await exists(legacyPath))) return null;
  const record = await readJson(legacyPath);
  await writeJson(local, record);
  await unlink(legacyPath);
  return { path: local, record, migrated: true };
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
  if (legacyPath && await exists(legacyPath)) await unlink(legacyPath);
}
