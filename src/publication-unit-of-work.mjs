import path from 'node:path';
import { rm } from 'node:fs/promises';
import {
  admitGovernedPublication, branch, commitIsolated, head, publicationPushOutcome,
  pushCommitToBranch
} from './git.mjs';
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
import { configuredRemoteAuthority } from './git-remote-diagnostics.mjs';
import {
  freezeAndVerifySgosLifecycleCandidate, sgosLifecycleCandidateBinding,
  sgosLifecycleCandidateIdentity
} from './sgos/candidate-lifecycle.mjs';

function lifecycleCandidateCreator(event) {
  const actor = event?.actor ?? {};
  const actorId = actor.email ?? actor.login ?? actor.githubLogin ?? actor.id ?? actor.name ?? null;
  const id = actorId ?? event?.agent ?? 'singularity-flow-kernel';
  const actorKinds = new Set(['human', 'service', 'agent', 'system', 'external']);
  return {
    // `event.agent` is execution context, not the decision principal. A human approval may name a
    // governed agent while still being authored by the Git identity in `actor`; never relabel that
    // person's email as an agent identity.
    kind: actorId ? (actorKinds.has(actor.kind) ? actor.kind : 'human')
      : event?.agent ? 'agent' : 'system',
    id: String(id),
    ...(actor.name ? { name: String(actor.name) } : {}),
    ...(actor.email ? { email: String(actor.email) } : {})
  };
}

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
  pendingMetadata = null,
  retainPendingOnSuccess = false,
  ledger = null,
  conflictStrategy = null,
  state = null,
  beforeCommit = null,
  stabilityGuard = null,
  fault = null,
  transactionId = null,
  recoveryPreimage: suppliedRecoveryPreimage = null
  } = {}) {
  const root = this.root;
  let envelope = assertLifecycleEvent(event, subject);
  const universalCandidate = ['story', 'initiative', 'adhoc', 'goal'].includes(subject?.kind);
  // Candidate identity is allocated only after state.write finalizes the event. Some transitions
  // derive document IDs, approval principals, or generations inside that callback; preallocating
  // from the draft event would bind the Candidate to bytes different from the governed commit.
  if (!commitSpec?.message) throw new SingularityFlowError('Publication requires commit.message.');
    if (!publication?.branch) throw new SingularityFlowError('Publication requires a target branch.');
    const publicationRemote = publication.remote ?? 'origin';
    const configuredPublicationAuthority = publication.mode === 'off'
      ? null
      : configuredRemoteAuthority(root, publicationRemote);
    const suppliedPublicationAuthority = publication.mode === 'off'
      ? null
      : publication.authority ?? null;
    if (suppliedPublicationAuthority) {
      const authorityMatches = Object.isFrozen(suppliedPublicationAuthority)
        && suppliedPublicationAuthority.remote === publicationRemote
        && suppliedPublicationAuthority.direction === 'push'
        && suppliedPublicationAuthority.url
        && suppliedPublicationAuthority.url === configuredPublicationAuthority?.url
        && suppliedPublicationAuthority.fingerprint === configuredPublicationAuthority?.fingerprint;
      if (!authorityMatches) {
        throw new SingularityFlowError(
          `Publication remote '${publicationRemote}' changed after its exact push authority was observed. Nothing was changed.`,
          { code: 'PUBLICATION_REMOTE_AUTHORITY_CHANGED' }
        );
      }
    }
    const publicationAuthority = suppliedPublicationAuthority ?? configuredPublicationAuthority;
    const publicationRemoteFingerprint = publicationAuthority?.fingerprint ?? null;
    if (publication.mode !== 'off' && !publicationAuthority?.url) {
      throw new SingularityFlowError(
        `Publication remote '${publicationRemote}' is not configured with one exact credential-free push authority. Nothing was changed.`,
        { code: 'PUBLICATION_REMOTE_AUTHORITY_MISSING' }
      );
    }
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
    if (publication.expectedLocalHead !== undefined
      && String(publication.expectedLocalHead).toLowerCase() !== publicationHead.toLowerCase()) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' local branch moved before its governed publication transaction began. `
        + 'Reload the lifecycle state and retry; nothing was changed.',
        {
          code: 'PUBLICATION_LOCAL_PARENT_CHANGED',
          details: {
            expectedLocalHead: publication.expectedLocalHead,
            publicationHead
          }
        }
      );
    }
    if (publication.expectedRemoteSha !== undefined
      && publication.expectedRemoteSha !== null
      && String(publication.expectedRemoteSha).toLowerCase() !== publicationHead.toLowerCase()) {
      throw new SingularityFlowError(
        `${subject.kind} '${subject.id}' publication lease does not match the local parent this transaction would extend. `
        + 'Reload the lifecycle state and retry; nothing was changed.',
        {
          code: 'PUBLICATION_REMOTE_LEASE_PARENT_MISMATCH',
          details: {
            expectedRemoteSha: publication.expectedRemoteSha,
            publicationHead
          }
        }
      );
    }
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
      remoteFingerprint: publicationRemoteFingerprint,
      event: envelope,
      recoveryPreimage,
      publicationMode: publication.mode ?? 'required',
      ...(publication.expectedRemoteSha !== undefined
        ? { expectedRemoteSha: publication.expectedRemoteSha }
        : {}),
      pendingMetadata,
      ...(transactionId ? { transactionId } : {}),
      lockOwner
    });
    let wroteState = false;
    let ledgerIntentPath = null;
    let transactionTree = null;
    let transactionStateSha256 = null;
    let transactionEventSha256 = journal.eventSha256;
    let candidateBinding = null;
    const unwind = async (error) => {
      if (ledgerIntentPath) await rm(path.join(root, ledgerIntentPath), { force: true });
      let restoreFailure = null;
      let restoration = null;
      if (wroteState) {
        // Secret admission is a non-retention boundary, not merely a no-commit boundary.  Keeping
        // the rejected working bytes in a machine-local rescue would persist the credential after
        // correctly refusing its Candidate.  Binary/unreadable prospective blobs receive the same
        // treatment because the scanner could not prove them free of secrets.
        const preserveRejectedBytes = !['SECRET_DETECTED', 'SECRET_SCAN_UNREADABLE']
          .includes(error?.code);
        try {
          await updatePublicationJournal(root, subject, {
            stage: 'restoring',
            recoveryAttemptedAt: nowIso(),
            originalError: error?.message ?? String(error)
          }, { transactionId: journal.transactionId });
          restoration = state?.rollback
            ? await state.rollback(recoveryPreimage, { preserveCurrent: preserveRejectedBytes })
            : await restorePublicationPreimage(root, recoveryPreimage, {
              subject, preserveCurrent: preserveRejectedBytes
            });
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
        const writeResult = await state.write(envelope, {
          transactionId: journal.transactionId,
          expectedHead: publicationHead,
          branch: publication.branch
        });
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
    // This is both the isolated commit scope and the Candidate scope. Define it once so the
    // reviewed tree and the committed tree cannot disagree about an optional ledger intent path.
    let staged;
    try {
      // Secret, pre-staged-overlap, optional-path, and deletion admission must precede Candidate
      // retention. `commitIsolated` repeats this exact kernel function to catch later races.
      staged = admitGovernedPublication(
        root, [...allowedPaths, ledgerIntentPath].filter(Boolean), { expectedHead: publicationHead }
      );
      if (universalCandidate) {
        const boundary = await freezeAndVerifySgosLifecycleCandidate(root, {
          event: envelope,
          paths: staged,
          createdBy: lifecycleCandidateCreator(envelope),
          expectedBaseline: publicationHead,
          expectedCandidateTree: staged.prospectiveTree,
          lifecycleAdmission: {
            normalizedEventSha256: sgosLifecycleCandidateIdentity(envelope).normalizedEventSha256,
            subject: { kind: subject.kind, id: subject.id },
            eventType: envelope.type,
            scopeAdmission: 'passed',
            stateValidation: state?.validate ? 'passed' : 'not-required',
            beforeCommitValidation: beforeCommit ? 'passed' : 'not-required'
          }
        });
        candidateBinding = sgosLifecycleCandidateBinding(boundary);
        await updatePublicationJournal(root, subject, {
          stage: 'candidate-verified', candidate: candidateBinding
        }, { transactionId: journal.transactionId });
        if (fault) await fault('after-candidate-verification', {
          envelope, candidate: candidateBinding
        });
      }
    } catch (error) { await unwind(error); }
    // The commit is bounded by the same set that was staged. `allowedPaths` named a containment the
    // bare commit never delivered: it staged these and then committed the whole index, so anything
    // the person at the keyboard had staged rode into the governed commit and was pushed, pinned and
    // attested to.
    let sourceCommit;
    try {
      sourceCommit = await commitIsolated(root, commitSpec.message, staged, {
        expectedHead: publicationHead,
        expectedRef: `refs/heads/${publication.branch}`,
        expectedTree: candidateBinding?.candidateTree ?? null,
        sign: commitSpec.sign === true,
        signingKey: commitSpec.signingKey ?? null,
        fault,
        stabilityGuard,
        transaction: {
          id: journal.transactionId,
          eventSha256: transactionEventSha256,
          publicationMode: journal.publicationMode,
          candidate: candidateBinding,
          stateSha256ForTree: (tree) => `sha256:${recordSha256({
            transactionId: journal.transactionId,
            expectedHead: publicationHead,
            branch: publication.branch,
            tree,
            eventSha256: transactionEventSha256,
            publicationMode: journal.publicationMode,
            ...(candidateBinding ? { candidate: candidateBinding } : {}),
            ...(publicationRemoteFingerprint ? { remoteFingerprint: publicationRemoteFingerprint } : {}),
            ...(publication.expectedRemoteSha !== undefined
              ? { expectedRemoteSha: publication.expectedRemoteSha }
              : {})
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
            // Extension metadata is descriptive only. Apply the transaction authority afterwards
            // so a current or future callback cannot replace the exact commit, Candidate, event,
            // lease, or destination that recovery is allowed to publish.
            ...(pendingRecord?.({ sourceCommit, error: error.message, envelope }) ?? {}),
            schemaVersion: currentSchemaVersion('pending-publication'),
            subject,
            branch: publication.branch,
            remote: publication.remote ?? 'origin',
            remoteFingerprint: publicationRemoteFingerprint,
            commit: sourceCommit,
            event: envelope,
            createdAt: nowIso(),
            recoveryStage: 'branch-ref-advanced-before-publication',
            pushOutcome: 'not-attempted',
            transactionId: journal.transactionId,
            tree: error.publicationTree ?? transactionTree,
            eventSha256: transactionEventSha256,
            stateSha256: transactionStateSha256,
            publicationMode: journal.publicationMode,
            candidate: candidateBinding,
            error: error.message,
            ...(publication.expectedRemoteSha !== undefined
              ? { expectedRemoteSha: publication.expectedRemoteSha }
              : {})
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
    if (publication.mode === 'off' && retainPendingOnSuccess) {
      // A local-only publication still has an operational tail outside Git (for example the ad hoc
      // session receipt and active-session pointer). Retain the exact Candidate-bound commit before
      // clearing the journal so a failed tail write can be retried without recreating authority.
      await writePendingPublication(root, {
        kind: subject.kind,
        id: subject.id,
        record: {
          ...(pendingMetadata ?? {}),
          schemaVersion: currentSchemaVersion('pending-publication'),
          subject,
          branch: publication.branch,
          remote: publication.remote ?? 'origin',
          remoteFingerprint: null,
          commit: sourceCommit,
          transactionId: journal.transactionId,
          tree: transactionTree,
          eventSha256: transactionEventSha256,
          stateSha256: transactionStateSha256,
          publicationMode: journal.publicationMode,
          candidate: candidateBinding,
          event: envelope,
          createdAt: nowIso(),
          localCommitted: true,
          pushOutcome: 'not-attempted'
        }
      });
    }
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
      // Once this durable stage is written, a process death can no longer prove whether the remote
      // accepted the update before the transport disappeared. Recovery may reconcile exact remote
      // equality only from this indeterminate state, never from a known rejection.
      await updatePublicationJournal(root, subject, {
        stage: 'publishing', pushOutcome: 'transport-indeterminate'
      }, { transactionId: journal.transactionId });
      let result = publicationAuthority?.url
        ? pushCommitToBranch(
          root,
          publicationRemote,
          sourceCommit,
          publication.branch,
          {
            expectedRemoteSha: publication.expectedRemoteSha,
            transportRemote: publicationAuthority.url,
            upstreamRemote: publicationAuthority.remote
          }
        )
        : {
            status: 1, stdout: '', signal: null,
            stderr: `Publication remote '${publicationRemote}' is not configured with a credential-free authority.`
          };
      const initialPushOutcome = result.status === 0 ? 'published' : publicationPushOutcome(result);
      // An ambiguous transport may already have advanced the ref. Local replay after that boundary
      // would replace the only ownership receipt with a different commit/error and permanently lose
      // the ability to reconcile the exact commit this process may have installed.
      if (result.status !== 0 && initialPushOutcome !== 'transport-indeterminate'
        && conflictStrategy && publicationAuthority?.url) {
        const resolved = await conflictStrategy({
          sourceCommit, result, envelope,
          transportRemote: publicationAuthority.url,
          upstreamRemote: publicationRemote
        });
        result = resolved.result;
        replayed = resolved.replayed === true;
        publishedCommit = resolved.publishedCommit ?? head(root);
      }
      if (result.status !== 0) {
        const error = (result.stderr || result.stdout).trim();
        const pushOutcome = publicationPushOutcome(result);
        await updatePublicationJournal(root, subject, {
          stage: pushOutcome === 'transport-indeterminate' ? 'push-indeterminate' : 'push-rejected',
          pushOutcome
        }, { transactionId: journal.transactionId });
        await writePendingPublication(root, {
          kind: subject.kind,
          id: subject.id,
          record: {
            ...(pendingRecord?.({ sourceCommit, error, envelope }) ?? {}),
            schemaVersion: currentSchemaVersion('pending-publication'),
            subject,
            branch: publication.branch,
            remote: publication.remote ?? 'origin',
            remoteFingerprint: publicationRemoteFingerprint,
            commit: sourceCommit,
            transactionId: journal.transactionId,
            tree: transactionTree,
            // state.write may finalize actor/document identities inside the transaction. Bind the
            // recovery marker to that exact event, just like the governed commit trailer and the
            // ref-advancement recovery path, rather than to the pre-result journal intent.
            eventSha256: transactionEventSha256,
            stateSha256: transactionStateSha256,
            publicationMode: journal.publicationMode,
            candidate: candidateBinding,
            event: envelope,
            createdAt: nowIso(),
            error,
            pushOutcome,
            ...(publication.expectedRemoteSha !== undefined
              ? { expectedRemoteSha: publication.expectedRemoteSha }
              : {})
          }
        });
        await clearPublicationJournal(root, subject, { transactionId: journal.transactionId });
        const message = `${subject.kind} commit ${sourceCommit.slice(0, 8)} was retained locally but push failed.${error ? ` Git reported: ${error}` : ''}`;
        if (publication.mode === 'warn') return { sha: sourceCommit, pushed: false, pending: true, warning: message, replayed, event: envelope, ledger: null, candidate: candidateBinding };
        throw new SingularityFlowError(`${message} Run the appropriate sync command after fixing remote access.`);
      }
      pushed = true;
      await updatePublicationJournal(root, subject, {
        stage: 'pushed', commit: publishedCommit
      }, { transactionId: journal.transactionId });
      if (retainPendingOnSuccess) {
        // The publication journal already carries `pendingMetadata`, so a hard death in this exact
        // root-ref-to-tail-marker window is recoverable. Keep a named fault boundary for the
        // child-process regression that proves it rather than only testing the easier post-marker
        // interruption.
        if (fault) await fault('after-push-before-pending-retention', {
          envelope, sourceCommit, publishedCommit, pushed
        });
        if (replayed || publishedCommit !== sourceCommit) {
          throw new SingularityFlowError(
            `${subject.kind} '${subject.id}' cannot retain a post-publication recovery tail after commit replay.`,
            { code: 'PUBLICATION_RECOVERY_TAIL_REPLAYED' }
          );
        }
        await writePendingPublication(root, {
          kind: subject.kind,
          id: subject.id,
          record: {
            ...(pendingMetadata ?? {}),
            schemaVersion: currentSchemaVersion('pending-publication'),
            subject,
            branch: publication.branch,
            remote: publication.remote ?? 'origin',
            remoteFingerprint: publicationRemoteFingerprint,
            commit: publishedCommit,
            transactionId: journal.transactionId,
            tree: transactionTree,
            eventSha256: transactionEventSha256,
            stateSha256: transactionStateSha256,
            publicationMode: journal.publicationMode,
            candidate: candidateBinding,
            event: envelope,
            createdAt: nowIso(),
            rootPublished: true,
            pushOutcome: 'not-attempted',
            ...(publication.expectedRemoteSha !== undefined
              ? { expectedRemoteSha: publication.expectedRemoteSha }
              : {})
          }
        });
      }
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
    return {
      sha: publishedCommit, pushed, replayed, event: envelope, ledger: ledgerResult,
      candidate: candidateBinding
    };
  });
  }
}

export function publishLifecycleChange(root, specification) {
  return new GitPublicationUnitOfWork(root).execute(specification);
}
