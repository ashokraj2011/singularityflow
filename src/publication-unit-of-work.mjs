import path from 'node:path';
import { rm } from 'node:fs/promises';
import { branch, commitIsolated, head, pushBranch } from './git.mjs';
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
  fault = null
  } = {}) {
  const root = this.root;
  let envelope = assertLifecycleEvent(event, subject);
  if (!commitSpec?.message) throw new SingularityFlowError('Publication requires commit.message.');
  if (!publication?.branch) throw new SingularityFlowError('Publication requires a target branch.');
  return withSubjectLock(root, subject, async () => {
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
    await beginPublicationJournal(root, {
      subject,
      expectedHead: publicationHead,
      branch: publication.branch,
      remote: publication.remote ?? 'origin',
      event: envelope
    });
    let wroteState = false;
    let ledgerIntentPath = null;
    const unwind = async (error) => {
      if (ledgerIntentPath) await rm(path.join(root, ledgerIntentPath), { force: true });
      let restoreFailure = null;
      if (wroteState && state?.rollback) {
        try { await state.rollback(); } catch (failure) { restoreFailure = failure; }
      }
      // The journal is cleared on every path out, including a failed restore. Rethrowing before this
      // left a `prepared` journal whose expectedHead still matched HEAD, which every later process
      // reads as an interrupted publication: `assertNoPendingPublication` then blocks every mutation
      // and `syncPublication` hard-refuses. Combined with a half-restored working tree, that left
      // the subject unusable with no route out except deleting a file inside `.git` by hand — the
      // worst possible response to a rollback that had already gone wrong.
      await clearPublicationJournal(root, subject);
      if (restoreFailure) {
        throw new SingularityFlowError(
          `${subject.kind} '${subject.id}' failed to publish and its state could not be restored: ${restoreFailure.message}. `
          + `Inspect the work item before running another governed command. `
          + `The original failure was: ${error.message}`
        );
      }
      throw error;
    };

    try {
      // Set before the call, not after. `wroteState` has to mean "the write may have reached disk",
      // because that is the question rollback answers — and `state.write` is not one write. It saves
      // `workflow.json` and then `STATUS.md`, and the approval path ahead of those rewrites artifact
      // metadata, registers a snapshot and writes the decision files. A throw anywhere in there left
      // the flag false and skipped the undo entirely, which is precisely the durable record of an
      // event that never happened this block exists to prevent. Rolling back a write that had not
      // started yet is harmless: it restores the state that is already on disk.
      if (state?.write) { wroteState = true; await state.write(envelope); }
      if (fault) await fault('after-state-write', { envelope });
      if (state?.validate) await state.validate(envelope);
      if (beforeCommit) await beforeCommit(envelope);
    } catch (error) { await unwind(error); }

    if (ledger?.config?.enabled && ledger.intent) {
      // The event is attached before the intent is written, so the file and any entry appended from
      // it carry the same payload. It is deliberately the unbound event: the commit it belongs to
      // cannot exist yet, and the entry records it as `transport.publishedCommit` regardless. When
      // this was attached afterwards and only in memory, a direct append and a later reconcile of
      // the same intent produced two different entry bodies — and therefore two different chain
      // hashes — decided by whether the network happened to be up.
      ledger.intent.payload = { ...(ledger.intent.payload ?? {}), lifecycleEvent: envelope };
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
        fault
      });
    } catch (error) {
      if (!error.publicationRefAdvanced) await unwind(error);
      sourceCommit = error.publicationCommit ?? head(root);
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
            error: error.message,
            ...(pendingRecord?.({ sourceCommit, error: error.message, envelope }) ?? {})
          }
        });
      }
      await clearPublicationJournal(root, subject);
      throw error;
    }
    await updatePublicationJournal(root, subject, { stage: 'committed', commit: sourceCommit });
    // The envelope this function returns is bound to the commit; the intent's payload deliberately
    // is not, so that it matches the file already committed above.
    envelope = bindLifecycleEvent(envelope, sourceCommit);
    if (publication.mode === 'off') await clearPublicationJournal(root, subject);
    if (fault) await fault('after-commit', { envelope, sourceCommit });
    let pushed = false;
    let replayed = false;
    let publishedCommit = sourceCommit;
    if (publication.mode !== 'off') {
      let result = pushBranch(root, publication.remote ?? 'origin', publication.branch);
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
            event: envelope,
            createdAt: nowIso(),
            error,
            ...(pendingRecord?.({ sourceCommit, error, envelope }) ?? {})
          }
        });
        await clearPublicationJournal(root, subject);
        const message = `${subject.kind} commit ${sourceCommit.slice(0, 8)} was retained locally but push failed.${error ? ` Git reported: ${error}` : ''}`;
        if (publication.mode === 'warn') return { sha: sourceCommit, pushed: false, pending: true, warning: message, replayed, event: envelope, ledger: null };
        throw new SingularityFlowError(`${message} Run the appropriate sync command after fixing remote access.`);
      }
      pushed = true;
      await updatePublicationJournal(root, subject, { stage: 'pushed', commit: publishedCommit });
      await clearPublicationJournal(root, subject);
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
