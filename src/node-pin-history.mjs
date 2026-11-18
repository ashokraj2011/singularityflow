/**
 * The Node pins this repository's Stories already chose, read from files only [owner, 2026-11-18].
 *
 * Settled decisions belong to one Story, and a `.nvmrc` a Story wrote lives on its own branch, so on one repository the
 * same Node question was answered three times (Stories new-graph-plot, new-grapj and new-ash-graph). A pin an earlier
 * Story of the same repository chose or settled is evidence for the next one: SFlow keeps each beside the repository's Git
 * data when it lands, and reads the `.nvmrc` of the Stories checked out beside this one. Never authority: it only lets
 * the next Story settle the same answer with its evidence and undo (node-version-settle.mjs). Reads and writes no Story
 * record, runs no Git command, and names a Story by its branch, never by a folder on this machine.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';

const MAJOR = /^\d{1,4}$/u;
const KEPT = 50;
const keptFile = (root) => path.join(gitCommonDir(root), 'singularity-flow', 'node-pins.json');
const majorOf = (text) => String(text ?? '').trim().replace(/^v/u, '').split('.')[0];

/** Keep a pin that landed for a Story of this repository (settled by SFlow or chosen by a person); never fails its caller. */
export async function keepNodePin(root, { version, workId = null, by = 'sflow' }) {
  if (!MAJOR.test(String(version ?? ''))) return;
  const file = keptFile(root);
  const kept = await readFile(file, 'utf8').then(JSON.parse, () => null);
  const pins = (Array.isArray(kept?.pins) ? kept.pins : []).filter((entry) => entry?.workId !== workId);
  pins.push({ version: String(version), workId: workId == null ? null : String(workId).slice(0, 128), by: by === 'person' ? 'person' : 'sflow',
    at: new Date().toISOString() });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: 1, // schema-transient: disposable machine-local evidence; an unreadable or older file is read as none
    pins: pins.slice(-KEPT)
  };
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The pins other Stories of this repository hold, `{ version, workId, where }`, newest kept first, then the `.nvmrc` of each
 * Story checked out beside this one (a Git worktree of the same repository). `workId`: this Story, left out.
 */
export async function earlierStoryNodePins(root, { workId = null, branch = null } = {}) {
  const common = gitCommonDir(root);
  const found = [];
  const kept = await readFile(keptFile(root), 'utf8').then(JSON.parse, () => null);
  for (const entry of [...(Array.isArray(kept?.pins) ? kept.pins : [])].reverse()) {
    if (MAJOR.test(String(entry?.version ?? '')) && entry.workId && entry.workId !== workId) {
      found.push({ version: String(entry.version), workId: entry.workId, where: `the pin Story ${entry.workId} ${entry.by === 'person' ? 'chose' : 'settled'}` });
    }
  }
  const here = path.resolve(root);
  for (const name of (await readdir(path.join(common, 'worktrees')).catch(() => [])).slice(0, 200)) {
    const entry = path.join(common, 'worktrees', name);
    const gitdir = (await readFile(path.join(entry, 'gitdir'), 'utf8').catch(() => '')).trim();
    if (!gitdir) continue;
    const checkout = path.dirname(path.resolve(entry, gitdir));
    if (checkout === here) continue;
    const head = (await readFile(path.join(entry, 'HEAD'), 'utf8').catch(() => '')).trim();
    const story = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
    if (!story || story === branch || story === workId) continue;
    const version = majorOf(await readFile(path.join(checkout, '.nvmrc'), 'utf8').catch(() => ''));
    if (MAJOR.test(version)) found.push({ version, workId: story, where: `.nvmrc on branch ${story}` });
  }
  return found;
}
