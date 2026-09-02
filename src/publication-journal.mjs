import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitCommonDir } from './git.mjs';
import { nowIso, readJson, SingularityFlowError, writeAtomic } from './util.mjs';
import { unlink } from 'node:fs/promises';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { recordSha256 } from './records.mjs';
import { currentSubjectLockOwner } from './subject-lock.mjs';
import {
  prepareSharedPublicationStorage, resolveSharedPublicationFile
} from './publication-storage.mjs';
import { validatePublicationPreimage } from './publication-recovery.mjs';

const PROCESS_OWNER_ID = randomUUID();

async function writePrivateJson(target, value) {
  await writeAtomic(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function safeId(id) {
  return encodeURIComponent(String(id ?? '').trim()).replace(/%/g, '_');
}

function assertJournalSubject(record, requestedSubject, { parent = false, depth = 0 } = {}) {
  if (depth > 32) {
    throw new SingularityFlowError('Publication journal parent chain exceeds its bounded depth.', {
      code: 'PUBLICATION_JOURNAL_SUBJECT_MISMATCH'
    });
  }
  const actual = record?.subject;
  const sameIdentity = actual?.kind === requestedSubject?.kind
    && actual?.id === requestedSubject?.id
    && (!Object.hasOwn(requestedSubject ?? {}, 'branch')
      || actual?.branch === requestedSubject.branch);
  if (!sameIdentity) {
    throw new SingularityFlowError(
      `${parent ? 'Parent publication journal' : 'Publication journal'} subject does not match its requested durable identity.`,
      {
        code: 'PUBLICATION_JOURNAL_SUBJECT_MISMATCH',
        details: {
          expected: {
            kind: requestedSubject?.kind ?? null,
            id: requestedSubject?.id ?? null,
            ...(Object.hasOwn(requestedSubject ?? {}, 'branch')
              ? { branch: requestedSubject.branch }
              : {})
          },
          actual: actual ?? null,
          parent
        }
      }
    );
  }
  if (record.recoveryPreimage) {
    validatePublicationPreimage(record.recoveryPreimage, { subject: requestedSubject });
  }
  if (record.parentJournal) {
    assertJournalSubject(record.parentJournal, requestedSubject, { parent: true, depth: depth + 1 });
  }
}

export function publicationJournalPath(root, kind, id) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'publication-journal', `${kind}--${safeId(id)}.json`);
}

export async function readPublicationJournal(root, subject, { migrate = true } = {}) {
  const resolved = await resolveSharedPublicationFile(root, {
    directory: 'publication-journal',
    name: `${subject.kind}--${safeId(subject.id)}.json`,
    label: `Publication journal for ${subject.kind} '${subject.id}'`,
    read: async (target) => readRecord('publication-journal', await readJson(target)).record,
    identity: recordSha256,
    migrate
  });
  if (!resolved) return null;
  // The filename is selected from `subject`; its bytes cannot nominate a different Story and then
  // use that identity to acquire a lock or restore that Story's private refs. Nested journals have
  // the same subject lease and are checked recursively before the record leaves the reader.
  assertJournalSubject(resolved.value, subject);
  return {
    path: resolved.path,
    record: resolved.value,
    migrated: resolved.migrated,
    ...(resolved.migratedFrom?.length ? { migratedFrom: resolved.migratedFrom } : {})
  };
}

export async function beginPublicationJournal(root, {
  subject,
  expectedHead,
  branch,
  remote,
  remoteFingerprint = null,
  event,
  recoveryPreimage = null,
  transactionKind = 'publication',
  operation = null,
  publicationMode = null,
  expectedRemoteSha = undefined,
  pendingMetadata = null,
  transactionId = randomUUID(),
  lockOwner = currentSubjectLockOwner(root, subject)
}) {
  if (recoveryPreimage) validatePublicationPreimage(recoveryPreimage, { subject });
  // Surface or consolidate any worktree-private journal before the shared record is replaced. A
  // divergent legacy transaction is a recovery decision, never stale scratch to overwrite.
  const existing = await readPublicationJournal(root, subject);
  if (existing?.record?.recoveryPreimage) {
    validatePublicationPreimage(existing.record.recoveryPreimage, { subject });
  }
  const parentJournal = existing && publicationJournalOwnedByCurrentProcess(existing.record, root)
    ? existing.record
    : null;
  if (existing && !parentJournal) {
    throw new SingularityFlowError(
      `${subject.kind} '${subject.id}' already has a publication journal owned by another transaction. `
      + 'Recover it before starting another write.',
      { code: 'PUBLICATION_JOURNAL_CONFLICT', details: { subject, path: existing.path } }
    );
  }
  await prepareSharedPublicationStorage(
    root, 'publication-journal', `Publication journal for ${subject.kind} '${subject.id}'`
  );
  const record = {
    schemaVersion: currentSchemaVersion('publication-journal'),
    kind: 'publication-transaction-journal',
    subject,
    expectedHead,
    branch,
    remote,
    remoteFingerprint,
    event,
    transactionKind,
    transactionId,
    operation,
    publicationMode,
    ...(expectedRemoteSha !== undefined ? { expectedRemoteSha } : {}),
    ...(pendingMetadata && typeof pendingMetadata === 'object'
      ? { pendingMetadata: structuredClone(pendingMetadata) }
      : {}),
    eventSha256: event == null ? null : `sha256:${recordSha256(event)}`,
    // Schema v2 makes the SGOS Candidate boundary durable before branch advancement. Legacy
    // transactions migrate with `null` and remain explicitly unverified during exact recovery.
    candidate: null,
    tree: null,
    stateSha256: null,
    refAdvanced: false,
    stage: 'prepared',
    owner: {
      pid: process.pid,
      processId: PROCESS_OWNER_ID,
      host: lockOwner?.host ?? null,
      processToken: lockOwner?.processToken ?? null,
      lockToken: lockOwner?.lockToken ?? null
    },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    commit: null,
    recoveryPreimage,
    // A draft may deliberately hand its preimage to the first governed publication. Both
    // transactions share the subject lease, but not the same crash boundary. Preserve the outer
    // journal durably before replacing the one shared path so clearing the nested transaction
    // restores its parent instead of erasing it.
    parentJournal
  };
  await writePrivateJson(publicationJournalPath(root, subject.kind, subject.id), record);
  return record;
}

export function publicationJournalOwnedByCurrentProcess(record, root = null) {
  if (record?.owner?.pid !== process.pid || record?.owner?.processId !== PROCESS_OWNER_ID) return false;
  if (!root || !record?.owner?.lockToken) return true;
  const inherited = currentSubjectLockOwner(root, record.subject);
  return inherited?.lockToken === record.owner.lockToken
    && inherited?.processToken === record.owner.processToken;
}

export async function updatePublicationJournal(root, subject, updates, { transactionId = null } = {}) {
  const current = await readPublicationJournal(root, subject);
  if (!current) return null;
  if (transactionId && current.record.transactionId !== transactionId) return null;
  const record = { ...current.record, ...updates, updatedAt: nowIso() };
  await writePrivateJson(current.path, record);
  return record;
}

export async function clearPublicationJournal(root, subject, { transactionId = null } = {}) {
  const current = await readPublicationJournal(root, subject);
  if (!current) return false;
  if (transactionId) {
    if (current.record.transactionId !== transactionId) return false;
  }
  if (current.record.parentJournal) {
    const parent = current.record.parentJournal;
    const sameSubject = parent.subject?.kind === subject.kind && parent.subject?.id === subject.id;
    const sameLease = parent.owner?.lockToken === current.record.owner?.lockToken
      && parent.owner?.processToken === current.record.owner?.processToken;
    if (!sameSubject || !sameLease || !String(parent.transactionId ?? '').trim()
      || parent.transactionId === current.record.transactionId) {
      throw new SingularityFlowError(
        `Nested publication journal for ${subject.kind} '${subject.id}' has an invalid parent recovery record. `
        + 'The journal was retained and must be inspected before another mutation.',
        { code: 'PUBLICATION_JOURNAL_PARENT_INVALID', details: { subject, path: current.path } }
      );
    }
    await writePrivateJson(current.path, parent);
    return true;
  }
  await unlink(current.path);
  return true;
}
