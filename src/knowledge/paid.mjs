/**
 * What a model was paid to write, kept on this machine [WMR:REQ-018, REQ-019]: a model-written brief, a brief's
 * phrasing and plain-language explanations.
 *
 * They live in `knowledge/paid/`, apart from the analysis entries the knowledge cache prunes, and are kept by their
 * own count: the newest 30, the oldest going first. Each is keyed by the analysis it was written from (a key without
 * the commit, store.mjs) and what was sent, so a commit that changes no read path keeps it in use. Files an earlier
 * version kept beside the analysis entries are moved here the first time this folder is used, so none is lost.
 * Rule drafts (`knowledge/rule-proposals.json`) are not kept here and are never pruned.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { repositoryGitPath } from '../git-directory.mjs';

export const KEEP_PAID_ENTRIES = 30;
/** The names paid output is kept under: `brief-…`, `brief-polish-…`, `explanations-…`. */
const PAID_ENTRY = /^(?:brief|brief-polish|explanations)-[0-9a-f]+\.json$/u;
const moved = new Set();

function knowledgeDirectory(root) {
  return repositoryGitPath(root, 'singularity-flow', 'knowledge');
}

export function paidFile(root, name) {
  return path.join(knowledgeDirectory(root), 'paid', name);
}

/** Move paid files an earlier version kept beside the analysis entries; once per folder and process. */
async function moveEarlierPaid(root) {
  const directory = knowledgeDirectory(root);
  if (moved.has(directory)) return;
  moved.add(directory);
  const names = (await readdir(directory).catch(() => [])).filter((name) => PAID_ENTRY.test(name));
  if (!names.length) return;
  await mkdir(path.join(directory, 'paid'), { recursive: true });
  for (const name of names) {
    const target = path.join(directory, 'paid', name);
    const there = await stat(target).catch(() => null);
    if (there) await rm(path.join(directory, name), { force: true });
    else await rename(path.join(directory, name), target).catch(() => {});
  }
}

async function prunePaid(directory, keep = KEEP_PAID_ENTRIES) {
  const names = (await readdir(directory).catch(() => [])).filter((name) => PAID_ENTRY.test(name));
  if (names.length <= keep) return;
  const dated = await Promise.all(names.map(async (name) => ({ name, at: (await stat(path.join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  for (const entry of dated.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name, 'en')).slice(keep)) await rm(path.join(directory, entry.name), { force: true });
}

export async function readPaid(root, name) {
  await moveEarlierPaid(root);
  return readFile(paidFile(root, name), 'utf8').then(JSON.parse).catch(() => null);
}

export async function writePaid(root, name, record) {
  await moveEarlierPaid(root);
  const file = paidFile(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record));
  await rename(temporary, file);
  await prunePaid(path.dirname(file));
  return file;
}
