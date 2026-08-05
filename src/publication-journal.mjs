import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitDir } from './git.mjs';
import { exists, nowIso, readJson, writeJson } from './util.mjs';
import { unlink } from 'node:fs/promises';

const PROCESS_OWNER_ID = randomUUID();

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

export function publicationJournalPath(root, kind, id) {
  return path.join(gitDir(root), 'singularity-flow', 'publication-journal', `${kind}--${safeId(id)}.json`);
}

export async function readPublicationJournal(root, subject) {
  const target = publicationJournalPath(root, subject.kind, subject.id);
  if (!(await exists(target))) return null;
  return { path: target, record: await readJson(target) };
}

export async function beginPublicationJournal(root, {
  subject,
  expectedHead,
  branch,
  remote,
  event
}) {
  const record = {
    schemaVersion: 1,
    kind: 'publication-transaction-journal',
    subject,
    expectedHead,
    branch,
    remote,
    event,
    stage: 'prepared',
    owner: { pid: process.pid, processId: PROCESS_OWNER_ID },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    commit: null
  };
  await writeJson(publicationJournalPath(root, subject.kind, subject.id), record);
  return record;
}

export function publicationJournalOwnedByCurrentProcess(record) {
  return record?.owner?.pid === process.pid && record?.owner?.processId === PROCESS_OWNER_ID;
}

export async function updatePublicationJournal(root, subject, updates) {
  const current = await readPublicationJournal(root, subject);
  if (!current) return null;
  const record = { ...current.record, ...updates, updatedAt: nowIso() };
  await writeJson(current.path, record);
  return record;
}

export async function clearPublicationJournal(root, subject) {
  const target = publicationJournalPath(root, subject.kind, subject.id);
  if (await exists(target)) await unlink(target);
}
