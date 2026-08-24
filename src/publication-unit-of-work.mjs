import path from 'node:path';
import { rm } from 'node:fs/promises';
import { branch, commitIsolated, head, pushCommitToBranch } from './git.mjs';
import {
  appendLedgerIntent,
  clearLedgerOutbox,
  ledgerStatus,
  persistLedgerIntent,
  recordLedgerOutbox
} from './ledger.mjs';
import { assertLifecycleEvent, bindLifecycleEvent } from './lifecycle-event.mjs';
import { readPendingPublication, writePendingPublication } from './publication-pending.mjs';
import {
  beginPublicationJournal, clearPublicationJournal, updatePublicationJournal
} from './publication-journal.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { SingularityFlowError, nowIso, stateFingerprint } from './util.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { capturePublicationPreimage, restorePublicationPreimage } from './publication-recovery.mjs';
import { recordSha256 } from './records.mjs';

export class GitPublicationUnitOfWork {
  constructor(root) { this.root = root; }

  async execute({
  subject,
  expectedRevision = null,
  allowedPaths = [],
  event,
  commit: commitSpec,
  publication,
  pendingRecord,
  ledger = null,
  conflictStrategy = null,
  state = null,
  beforeCommit = null,
  fault = null,
  transactionId = null,
  recoveryPreimage: suppliedRecoveryPreimage = null
  } = {}) {
  const root = this.root;
  let envelope = assertLifecycleEvent(event, subject);
  if (!commitSpec?.message) throw new SingularityFlowError('Publication requires commit.message.');
  if (!publication?.branch) throw new SingularityFlowError('Publication requires a target branch.');
  return withSubjectLock(root, subject, async (lockOwner) => {
    if (branch(root) !== publication.branch) {
      throw new SingularityFlowError(`Current branch ${branch(root)} must match ${subject.kind} branch ${publication.branch}.`);
    }
    if (expectedRevision?.head && head(root) !== expectedRevision.head) {
      throw new SingularityFlowError(`${subject.kind} '${subject.id}' changed before publication. Reload it and retry.`);
    }
    // HEAD only moves on a commit, and plenty of commands write the aggregate without committing —
    // `artifact scan`, `documents upload`, packet submission. So the check above could not see a
    // second process editing the same work item, and this process would then save its own stale
    // in-memory copy over that work and attest to the artifact set as it was before. The fingerprint
    // is refreshed by `saveWorkflow` on every write this process makes, so a mismatch here means
    // somebody else wrote the file.
    if (expectedRevision?.statePath && expectedRevision.stateSha256 !== undefined) {
      const current = stateFingerprint(expectedRevision.statePath);
      if (current !== expectedRevision.stateSha256) {
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' was modified by another process while this command was running `
          + `(${expectedRevision.statePath}). Reload it and retry; nothing was changed.`
        );
      }
    }
    if (await readPendingPublication(root, { kind: subject.kind, id: subject.id })) {
      throw new SingularityFlowError(`${subject.kind} '${subject.id}' has a pending publication. Synchronize it before another mutation.`);
    }
    if (ledger?.config?.enabled && ledger.config.behind === 'block') {
      const status = await ledgerStatus(root, ledger.config, { offline: true });
      if ((status.outbox ?? 0) > 0 || (status.pending?.length ?? 0) > 0) {
        throw new SingularityFlowError(
          `The capability ledger has ${status.outbox ?? 0} local outbox record(s) and ${status.pending?.length ?? 0} unpublished intent(s). Reconcile it before mutating ${subject.kind} '${subject.id}'.`
        );
      }
    }
    /*
     * Everything from the state write to the commit is one step or none.
     *
     * `state.write` persists the aggregate — including a `publicationProjections` entry carrying the
     * whole ledger-intent recipe — and every step after it can throw. Nothing put it back, so a
     * failed publication left a durable, committable record of an event that never happened. The
     * repair the tool itself recommends then commits the projection, and the next sync appends it
     * to the append-only capability ledger: an approval nobody gave, in the record that exists to
     * be trusted.
     */
    const publicationHead = head(root);
    // Persist the exact pre-transaction bytes before the journal authorizes the first state write.
    // An ordinary exception can use the same preimage immediately; a hard process death leaves it
    // in the journal for the next `sync` to restore after reclaiming the dead owner's lock.
    const recoveryPreimage = suppliedRecoveryPreimage
      ?? (state?.captureRecovery
        ? await state.captureRecovery()
        : await capturePublicationPreimage(root, allowedPaths));
    const journal = await beginPublicationJournal(root, {
      subject,
      expectedHead: publicationHead,
      branch: publication.branch,
      remote: publication.remote ?? 'origin',
      event: envelope,
      recoveryPreimage,
      publicationMode: publication.mode ?? 'required',
      ...(transactionId ? { transactionId } : {}),
      lockOwner
    });
    let wroteState = false;
    let ledgerIntentPath = null;
    let transactionTree = null;
    let transactionStateSha256 = null;
    let transactionEventSha256 = journal.eventSha256;
    const unwind = async (error) => {
      if (ledgerIntentPath) await rm(path.join(root, ledgerIntentPath), { force: true });
      let restoreFailure = null;
      let restoration = null;
      if (wroteState) {
        try {
          await updatePublicationJournal(root, subject, {
            stage: 'restoring',
            recoveryAttemptedAt: nowIso(),
            originalError: error?.message ?? String(error)
          }, { transactionId: journal.transactionId });
          restoration = state?.rollback
            ? await state.rollback(recoveryPreimage, { preserveCurrent: true })
            : await restorePublicationPreimage(root, recoveryPreimage, { subject, preserveCurrent: true });
        } catch (failure) { restoreFailure = failure; }
      }
      if (restoreFailure) {
        // The preimage is the only authoritative route back after a failed restore. Keep it and
        // make the failure explicit; clearing this journal would destroy the recovery path exactly
        // when it is needed most. A later subject-first `sync` can retry without parsing the damaged
        // aggregate and will preserve the then-current partial bytes before doing so.
        await updatePublicationJournal(root, subject, {
          stage: 'rollback-failed',
          rollbackError: restoreFailure.message,
          rollbackFailedAt: nowIso(),
          rescuePath: restoration?.rescuePath ?? null
        }, { transactionId: journal.transactionId }).catch(() => {});
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' failed to publish and its state could not be restored: ${restoreFailure.message}. `
          + 'The durable recovery journal was retained. Run the appropriate sync command to retry exact restoration. '
          + `The original failure was: ${error.message}`,
          { code: 'PUBLICATION_ROLLBACK_FAILED', details: { subject, originalError: error.message, rollbackError: restoreFailure.message } }
        );
      }
      await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
      throw error;
    };

    if (ledger?.config?.enabled && ledger.intent) {
      // This exact intent is captured in authoritative lifecycle state by `state.write` and then
      // persisted as a durable projection below. Enrich it before either write so the replay recipe
      // and the committed file cannot differ merely because they observed two different moments in
      // this transaction. The event remains deliberately unbound: its commit does not exist yet.
      ledger.intent.payload = { ...(ledger.intent.payload ?? {}), lifecycleEvent: envelope };
    }

    try {
      // Set before the call, not after. `wroteState` has to mean "the write may have reached disk",
      // because that is the question rollback answers — and `state.write` is not one write. It saves
      // `workflow.json` and then `STATUS.md`, and the approval path ahead of those rewrites artifact
      // metadata, registers a snapshot and writes the decision files. A throw anywhere in there left
      // the flag false and skipped the undo entirely, which is precisely the durable record of an
      // event that never happened this block exists to prevent. Rolling back a write that had not
      // started yet is harmless: it restores the state that is already on disk.
      if (state?.write) {
        wroteState = true;
        const writeResult = await state.write(envelope);
        // A transition may allocate its authoritative actor, decision, or evidence identifiers only
        // while it owns the transaction lock. In that case state.write finalizes the same envelope
        // object before returning. Re-hash and persist it before validation or commit so recovery
        // proves the event that actually describes the result, not the earlier planning intent.
        if (writeResult?.event) envelope = assertLifecycleEvent(writeResult.event, subject);
        transactionEventSha256 = `sha256:${recordSha256(envelope)}`;
        if (transactionEventSha256 !== journal.eventSha256) {
          await updatePublicationJournal(root, subject, {
            event: envelope,
            eventSha256: transactionEventSha256
          }, { transactionId: journal.transactionId });
        }
        if (ledger?.config?.enabled && ledger.intent) {
          ledger.intent.payload = { ...(ledger.intent.payload ?? {}), lifecycleEvent: envelope };
        }
      }
      if (fault) await fault('after-state-write', { envelope });
      if (state?.validate) await state.validate(envelope);
      if (beforeCommit) await beforeCommit(envelope);
    } catch (error) { await unwind(error); }

    if (ledger?.config?.enabled && ledger.intent) {
      // The event was attached before state.write, so the file, aggregate replay recipe, and any
      // entry appended from it all carry the same payload. A direct append and a later reconcile
      // must never produce different chain bodies based on whether the network happened to be up.
      try {
        ledgerIntentPath = await persistLedgerIntent(root, ledger.intentDirectory, ledger.intent);
      } catch (error) { await unwind(error); }
    }
    // The commit is bounded by the same set that was staged. `allowedPaths` named a containment the
    // bare commit never delivered: it staged these and then committed the whole index, so anything
    // the person at the keyboard had staged rode into the governed commit and was pushed, pinned and
    // attested to.
    const staged = [...new Set([...allowedPaths, ledgerIntentPath].filter(Boolean))];
    let sourceCommit;
    try {
      sourceCommit = await commitIsolated(root, commitSpec.message, staged, {
        expectedHead: publicationHead,
        sign: commitSpec.sign === true,
        signingKey: commitSpec.signingKey ?? null,
        fault,
        transaction: {
          id: journal.transactionId,
          eventSha256: transactionEventSha256,
          publicationMode: journal.publicationMode,
          stateSha256ForTree: (tree) => `sha256:${recordSha256({
            transactionId: journal.transactionId,
            expectedHead: publicationHead,
            branch: publication.branch,
            tree,
            eventSha256: transactionEventSha256,
            publicationMode: journal.publicationMode
          })}`
        },
        onCommitCreated: async ({ sourceCommit: createdCommit, tree, transaction }) => {
          transactionTree = tree;
          transactionStateSha256 = transaction.stateSha256;
          await updatePublicationJournal(root, subject, {
            stage: 'commit-created',
            commit: createdCommit,
            tree,
            stateSha256: transaction.stateSha256
          }, { transactionId: journal.transactionId });
        },
        onRefAdvanced: async ({ sourceCommit: advancedCommit }) => {
          await updatePublicationJournal(root, subject, {
            stage: 'ref-advanced',
            commit: advancedCommit,
            refAdvanced: true,
            recoveryPreimage: null
          }, { transactionId: journal.transactionId });
        }
      });
    } catch (error) {
      if (!error.publicationRefAdvanced) await unwind(error);
      sourceCommit = error.publicationCommit;
      if (!sourceCommit) {
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' advanced its ref without recording the exact transaction commit. `
          + 'Recovery was stopped to avoid publishing an unrelated HEAD.',
          { code: 'PUBLICATION_COMMIT_IDENTITY_MISSING', cause: error }
        );
      }
      envelope = bindLifecycleEvent(envelope, sourceCommit);
      if (publication.mode !== 'off') {
        await writePendingPublication(root, {
          kind: subject.kind,
          id: subject.id,
          record: {
            schemaVersion: currentSchemaVersion('pending-publication'),
            subject,
            branch: publication.branch,
            remote: publication.remote ?? 'origin',
            commit: sourceCommit,
            event: envelope,
            createdAt: nowIso(),
            recoveryStage: 'branch-ref-advanced-before-publication',
            transactionId: journal.transactionId,
            tree: error.publicationTree ?? transactionTree,
            eventSha256: transactionEventSha256,
            stateSha256: transactionStateSha256,
            publicationMode: journal.publicationMode,
            error: error.message,
            ...(pendingRecord?.({ sourceCommit, error: error.message, envelope }) ?? {})
          }
        });
      }
      await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
      throw error;
    }
    // The branch ref is now the durable recovery boundary. Drop the potentially large preimage as
    // the journal advances: rollback is forbidden after this point, and a later failure must retain
    // and publish the commit instead of carrying authored bytes through every journal rewrite.
    await updatePublicationJournal(root, subject, {
      stage: 'committed', commit: sourceCommit, recoveryPreimage: null
    }, { transactionId: journal.transactionId });
    // The envelope this function returns is bound to the commit; the intent's payload deliberately
    // is not, so that it matches the file already committed above.
    envelope = bindLifecycleEvent(envelope, sourceCommit);
    if (publication.mode === 'off') {
      await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
    }
    if (fault) await fault('after-commit', { envelope, sourceCommit });
    let pushed = false;
    let replayed = false;
    let publishedCommit = sourceCommit;
    if (publication.mode !== 'off') {
      // Publish the exact commit this transaction created. HEAD is mutable repository state: a
      // hook, another subject transaction, or a person at the keyboard may advance it after our
      // compare-and-swap commit and before this push. Using HEAD here would let those unrelated
      // bytes inherit this transaction's lifecycle event and recovery identity.
      let result = pushCommitToBranch(
        root,
        publication.remote ?? 'origin',
        sourceCommit,
        publication.branch
      );
      if (result.status !== 0 && conflictStrategy) {
        const resolved = await conflictStrategy({ sourceCommit, result, envelope });
        result = resolved.result;
        replayed = resolved.replayed === true;
        publishedCommit = resolved.publishedCommit ?? head(root);
      }
      if (result.status !== 0) {
        const error = (result.stderr || result.stdout).trim();
        await writePendingPublication(root, {
          kind: subject.kind,
          id: subject.id,
          record: {
            schemaVersion: currentSchemaVersion('pending-publication'),
            subject,
            branch: publication.branch,
            remote: publication.remote ?? 'origin',
            commit: sourceCommit,
            transactionId: journal.transactionId,
            tree: transactionTree,
            // state.write may finalize actor/document identities inside the transaction. Bind the
            // recovery marker to that exact event, just like the governed commit trailer and the
            // ref-advancement recovery path, rather than to the pre-result journal intent.
            eventSha256: transactionEventSha256,
            stateSha256: transactionStateSha256,
            publicationMode: journal.publicationMode,
            event: envelope,
            createdAt: nowIso(),
            error,
            ...(pendingRecord?.({ sourceCommit, error, envelope }) ?? {})
          }
        });
        await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
        const message = `${subject.kind} commit ${sourceCommit.slice(0, 8)} was retained locally but push failed.${error ? ` Git reported: ${error}` : ''}`;
        if (publication.mode === 'warn') return { sha: sourceCommit, pushed: false, pending: true, warning: message, replayed, event: envelope, ledger: null };
        throw new SingularityFlowError(`${message} Run the appropriate sync command after fixing remote access.`);
      }
      pushed = true;
      await updatePublicationJournal(root, subject, {
        stage: 'pushed', commit: publishedCommit
      }, { transactionId: journal.transactionId });
      await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
    }
    // Append-only replay can replace the original commit. Event identity always
    // follows the commit that actually became the lifecycle branch head. The intent's payload is
    // left as committed — the entry records where it landed in `transport.publishedCommit`.
    envelope = bindLifecycleEvent(envelope, publishedCommit);
    if (fault) await fault('after-push', { envelope, sourceCommit, publishedCommit, pushed });
    let ledgerResult = null;
    if (ledger?.config?.enabled && ledger.intent) {
      try {
        ledgerResult = await appendLedgerIntent(root, ledger.config, ledger.intent, publishedCommit);
        await clearLedgerOutbox(root, ledger.intent.eventId);
      } catch (error) {
        await recordLedgerOutbox(root, ledgerIntentPath, publishedCommit, error);
        const blocking = ledger.config.behind === 'block';
        const detail = `${subject.kind} commit ${publishedCommit.slice(0, 8)} is published, but its ledger mirror is pending: ${error.message}`;
        ledgerResult = {
          pending: true,
          blocking,
          eventId: ledger.intent.eventId,
          error: error.message,
          message: blocking
            ? `${detail} Reconcile the ledger before another mutation.`
            : `${detail} Run 'singularity-flow ledger reconcile' to complete the attestation.`
        };
        // Reported, not thrown, and never silent.
        //
        // Under `behind: block` this used to throw — after the commit had landed, after the push had
        // succeeded and after the journal was cleared. That skipped the caller's whole tail: the
        // revision update, `clearPendingPublication`, and the lifecycle notifications. The reviewer
        // saw a red error and reasonably concluded the approval had failed, while it sat on the
        // remote for CI and the pull-request gate to act on. What `behind: block` actually
        // guarantees is that the *next* mutation is refused, and the preflight above already
        // enforces that from the outbox — the throw was never what provided it.
        //
        // The warning matters just as much: no caller inspects `result.ledger`, so a non-blocking
        // append failure left the operator told the transition succeeded while the append-only
        // attestation quietly had not happened.
        console.warn(`Warning: ${ledgerResult.message}`);
      }
    }
    if (fault) await fault('after-ledger', { envelope, sourceCommit, publishedCommit, ledgerResult });
    return { sha: publishedCommit, pushed, replayed, event: envelope, ledger: ledgerResult };
  });
  }
}

export function publishLifecycleChange(root, specification) {
  return new GitPublicationUnitOfWork(root).execute(specification);
}
