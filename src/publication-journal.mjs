import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitDir } from './git.mjs';
import { exists, nowIso, readJson, writeAtomic } from './util.mjs';
import { unlink } from 'node:fs/promises';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

const PROCESS_OWNER_ID = randomUUID();

async function writePrivateJson(target, value) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

export function publicationJournalPath(root, kind, id) {
  return path.join(gitDir(root), 'singularity-flow', 'publication-journal', `${kind}--${safeId(id)}.json`);
}

export async function readPublicationJournal(root, subject) {
  const target = publicationJournalPath(root, subject.kind, subject.id);
  if (!(await exists(target))) return null;
  return { path: target, record: readRecord('publication-journal', await readJson(target)).record };
}

export async function beginPublicationJournal(root, {
  subject,
  expectedHead,
  branch,
  remote,
  event,
  recoveryPreimage = null,
  transactionKind = 'publication',
  operation = null
}) {
  const record = {
    schemaVersion: currentSchemaVersion('publication-journal'),
    kind: 'publication-transaction-journal',
    subject,
    expectedHead,
    branch,
    remote,
    event,
    transactionKind,
    operation,
    stage: 'prepared',
    owner: { pid: process.pid, processId: PROCESS_OWNER_ID },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    commit: null,
    recoveryPreimage
  };
  await writePrivateJson(publicationJournalPath(root, subject.kind, subject.id), record);
  return record;
}

export function publicationJournalOwnedByCurrentProcess(record) {
  return record?.owner?.pid === process.pid && record?.owner?.processId === PROCESS_OWNER_ID;
}

export async function updatePublicationJournal(root, subject, updates) {
  const current = await readPublicationJournal(root, subject);
  if (!current) return null;
  const record = { ...current.record, ...updates, updatedAt: nowIso() };
  await writePrivateJson(current.path, record);
  return record;
}

export async function clearPublicationJournal(root, subject) {
  const target = publicationJournalPath(root, subject.kind, subject.id);
  if (await exists(target)) await unlink(target);
}
