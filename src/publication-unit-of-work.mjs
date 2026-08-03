import { add, branch, commit, head, pushBranch } from './git.mjs';
import {
  appendLedgerIntent,
  clearLedgerOutbox,
  ledgerStatus,
  persistLedgerIntent,
  recordLedgerOutbox
} from './ledger.mjs';
import { assertLifecycleEvent, bindLifecycleEvent } from './lifecycle-event.mjs';
import { readPendingPublication, writePendingPublication } from './publication-pending.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { SingularityFlowError, nowIso } from './util.mjs';

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
    if (state?.write) await state.write(envelope);
    if (fault) await fault('after-state-write', { envelope });
    if (state?.validate) await state.validate(envelope);
    if (beforeCommit) await beforeCommit(envelope);
    let ledgerIntentPath = null;
    if (ledger?.config?.enabled && ledger.intent) {
      ledgerIntentPath = await persistLedgerIntent(root, ledger.intentDirectory, ledger.intent);
    }
    add(root, [...new Set([...allowedPaths, ledgerIntentPath].filter(Boolean))]);
    const sourceCommit = commit(root, commitSpec.message);
    envelope = bindLifecycleEvent(envelope, sourceCommit);
    if (ledger?.intent) {
      ledger.intent.eventId = envelope.eventId;
      ledger.intent.payload = {
        ...(ledger.intent.payload ?? {}),
        lifecycleEvent: envelope
      };
    }
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
            schemaVersion: 2,
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
        const message = `${subject.kind} commit ${sourceCommit.slice(0, 8)} was retained locally but push failed.${error ? ` Git reported: ${error}` : ''}`;
        if (publication.mode === 'warn') return { sha: sourceCommit, pushed: false, pending: true, warning: message, replayed, event: envelope, ledger: null };
        throw new SingularityFlowError(`${message} Run the appropriate sync command after fixing remote access.`);
      }
      pushed = true;
    }
    // Append-only replay can replace the original commit. Event identity always
    // follows the commit that actually became the lifecycle branch head.
    envelope = bindLifecycleEvent(envelope, publishedCommit);
    if (ledger?.intent) {
      ledger.intent.eventId = envelope.eventId;
      ledger.intent.payload = {
        ...(ledger.intent.payload ?? {}),
        lifecycleEvent: envelope
      };
    }
    if (fault) await fault('after-push', { envelope, sourceCommit, publishedCommit, pushed });
    let ledgerResult = null;
    if (ledger?.config?.enabled && ledger.intent) {
      try {
        ledgerResult = await appendLedgerIntent(root, ledger.config, ledger.intent, publishedCommit);
        await clearLedgerOutbox(root, ledger.intent.eventId);
      } catch (error) {
        await recordLedgerOutbox(root, ledgerIntentPath, publishedCommit, error);
        ledgerResult = { pending: true, eventId: ledger.intent.eventId, error: error.message };
        if (ledger.config.behind === 'block') {
          throw new SingularityFlowError(
            `${subject.kind} commit ${publishedCommit.slice(0, 8)} is published, but its required ledger mirror is pending. Reconcile the ledger before another mutation.`
          );
        }
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
