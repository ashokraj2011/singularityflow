import { branch, head } from './git.mjs';
import {
  beginPublicationJournal, clearPublicationJournal, updatePublicationJournal
} from './publication-journal.mjs';
import { readPendingPublication } from './publication-pending.mjs';
import { capturePublicationPreimage, restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { nowIso, SingularityFlowError, stateFingerprint } from './util.mjs';

/**
 * Durable local-authoring transaction.
 *
 * Preparing an artifact or opening a generation is intentionally not lifecycle authority and does
 * not create a Git commit. It still writes several governed files, however, so it needs the same
 * hard-crash boundary as publication: preimage before first write, subject lock, exact rollback,
 * and a Git-local journal recoverable without parsing the aggregate it may have partially written.
 */
export class DraftUnitOfWork {
  constructor(root) { this.root = root; }

  async execute({
    subject,
    expectedRevision = null,
    allowedPaths = [],
    operation,
    write,
    validate = null,
    fault = null
  } = {}) {
    const root = this.root;
    if (!subject?.kind || !subject?.id || !subject?.branch) {
      throw new SingularityFlowError('Draft transaction requires a complete subject identity.');
    }
    if (!operation) throw new SingularityFlowError('Draft transaction requires an operation name.');
    if (typeof write !== 'function') throw new SingularityFlowError('Draft transaction requires a write function.');
    return withSubjectLock(root, subject, async (lockOwner) => {
      if (branch(root) !== subject.branch) {
        throw new SingularityFlowError(`Current branch ${branch(root)} must match ${subject.kind} branch ${subject.branch}.`);
      }
      if (expectedRevision?.head && head(root) !== expectedRevision.head) {
        throw new SingularityFlowError(`${subject.kind} '${subject.id}' changed before ${operation}. Reload it and retry.`);
      }
      if (expectedRevision?.statePath && expectedRevision.stateSha256 !== undefined
          && stateFingerprint(expectedRevision.statePath) !== expectedRevision.stateSha256) {
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' was modified by another process before ${operation}. Reload it and retry.`
        );
      }
      if (await readPendingPublication(root, { kind: subject.kind, id: subject.id })) {
        throw new SingularityFlowError(`${subject.kind} '${subject.id}' has pending recovery. Synchronize it before ${operation}.`);
      }
      const expectedHead = head(root);
      const recoveryPreimage = await capturePublicationPreimage(root, allowedPaths);
      const journal = await beginPublicationJournal(root, {
        subject,
        expectedHead,
        branch: subject.branch,
        remote: null,
        event: null,
        recoveryPreimage,
        transactionKind: 'draft',
        operation,
        lockOwner
      });
      try {
        // The durable preimage is also the hand-off token for a nested first-publication
        // transaction. Existing callbacks ignore this argument.
        const value = await write(recoveryPreimage);
        if (fault) await fault('after-draft-write', { value });
        if (validate) await validate(value);
        await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
        return value;
      } catch (error) {
        // A nested publication may have advanced the branch and then failed during transport. Once
        // HEAD moves, rollback is forbidden: the exact commit is the stable recovery state and its
        // pending-publication marker must remain authoritative.
        if (head(root) !== expectedHead) {
          await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
          throw error;
        }
        let restoration = null;
        try {
          await updatePublicationJournal(root, subject, {
            stage: 'restoring', recoveryAttemptedAt: nowIso(), originalError: error?.message ?? String(error)
          }, { transactionId: journal.transactionId });
          restoration = await restorePublicationPreimage(root, recoveryPreimage, {
            subject,
            preserveCurrent: true
          });
        } catch (restoreFailure) {
          await updatePublicationJournal(root, subject, {
            stage: 'rollback-failed',
            rollbackError: restoreFailure.message,
            rollbackFailedAt: nowIso(),
            rescuePath: restoration?.rescuePath ?? null
          }, { transactionId: journal.transactionId }).catch(() => {});
          throw new SingularityFlowError(
            `${subject.kind} '${subject.id}' failed during ${operation} and its draft state could not be restored: ${restoreFailure.message}. `
            + 'The durable journal was retained; run the appropriate sync command.',
            {
              code: 'DRAFT_ROLLBACK_FAILED',
              details: { subject, operation, originalError: error.message, rollbackError: restoreFailure.message }
            }
          );
        }
        await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
        throw error;
      }
    });
  }
}

export function runDraftTransaction(root, specification) {
  return new DraftUnitOfWork(root).execute(specification);
}
