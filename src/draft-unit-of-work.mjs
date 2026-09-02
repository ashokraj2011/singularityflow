import { branch, governedCommitIdentity, head } from './git.mjs';
import {
  beginPublicationJournal, clearPublicationJournal, updatePublicationJournal
} from './publication-journal.mjs';
import { readPendingPublication, verifyPendingPublicationCommit } from './publication-pending.mjs';
import {
  capturePublicationPreimage, publicationReworkRefNamespace, restorePublicationPreimage
} from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { nowIso, SingularityFlowError, stateFingerprint } from './util.mjs';
import { verifySgosLifecycleCandidateBinding } from './sgos/candidate-lifecycle.mjs';

function nestedPublicationReceipt(value) {
  const candidate = value?.publication ?? value;
  return candidate && typeof candidate === 'object' ? candidate : null;
}

async function verifiedCompletedNestedPublication(root, value, subject, observedHead) {
  const receipt = nestedPublicationReceipt(value);
  if (receipt?.sha !== observedHead || receipt.event?.sourceCommit !== observedHead) return null;
  const identity = governedCommitIdentity(root, observedHead);
  if (!identity) return null;
  const verification = verifyPendingPublicationCommit(root, {
    subject: receipt.event.subject,
    branch: subject.branch,
    remote: '(completed nested publication)',
    commit: observedHead,
    transactionId: identity.transactionId,
    tree: identity.tree,
    eventSha256: identity.eventSha256,
    stateSha256: identity.stateSha256,
    publicationMode: identity.publicationMode,
    candidate: receipt.candidate ?? null,
    event: receipt.event
  }, { subject, branch: subject.branch, allowPublicationOff: true });
  if (!verification.valid) return null;
  if (receipt.candidate != null) {
    try {
      await verifySgosLifecycleCandidateBinding(root, receipt.candidate, {
        publishedCommit: observedHead
      });
    } catch {
      return null;
    }
  }
  return verification;
}

function verifiedPendingNestedPublication(root, pending, subject, observedHead) {
  if (!pending || pending.journal || pending.record?.commit !== observedHead) return null;
  const verification = verifyPendingPublicationCommit(root, pending.record, {
    subject,
    branch: subject.branch
  });
  return verification.valid ? verification : null;
}

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
      const recoveryPreimage = await capturePublicationPreimage(root, allowedPaths, {
        refPrefixes: [publicationReworkRefNamespace(subject)]
      });
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
      let writeResult;
      try {
        // The durable preimage is also the hand-off token for a nested first-publication
        // transaction. Existing callbacks ignore this argument.
        writeResult = await write(recoveryPreimage);
        if (fault) await fault('after-draft-write', { value: writeResult });
        if (validate) await validate(writeResult);
        await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
        return writeResult;
      } catch (error) {
        // A nested publication may have advanced the branch and then failed during transport. Once
        // its exact governed commit is proven, rollback is forbidden: that commit is the stable
        // recovery state and its pending-publication marker (when transport failed) remains
        // authoritative. A moved HEAD by itself proves nothing; treating any movement as nested
        // success erased the only draft preimage after an unrelated/manual commit.
        const observedHead = head(root);
        if (observedHead !== expectedHead) {
          const nestedPending = await readPendingPublication(root, {
            kind: subject.kind,
            id: subject.id
          });
          const verifiedPending = verifiedPendingNestedPublication(
            root, nestedPending, subject, observedHead
          );
          const verifiedCompleted = await verifiedCompletedNestedPublication(
            root, writeResult, subject, observedHead
          );
          if (verifiedPending || verifiedCompleted) {
            await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
            throw error;
          }
          const retained = await updatePublicationJournal(root, subject, {
            stage: 'draft-head-diverged',
            observedHead,
            recoveryAttemptedAt: nowIso(),
            originalError: error?.message ?? String(error)
          }, { transactionId: journal.transactionId });
          throw new SingularityFlowError(
            `${subject.kind} '${subject.id}' failed during ${operation}, and HEAD advanced from `
            + `${expectedHead} to ${observedHead} without an exact verifiable nested governed publication. `
            + 'Automatic rollback and publication were both refused. '
            + `${retained ? 'The durable draft journal was retained.' : 'The draft journal could not be replaced safely.'} `
            + 'Run the appropriate doctor command and inspect the recorded recovery evidence.',
            {
              code: 'DRAFT_RECOVERY_DIVERGED',
              details: {
                subject,
                operation,
                expectedHead,
                observedHead,
                journalRetained: Boolean(retained)
              },
              cause: error
            }
          );
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
