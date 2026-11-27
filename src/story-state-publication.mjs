/**
 * A state-ref Story's lifecycle authority: its state ref, published with the Story branch, the ledger entry and the
 * entry's pin in one atomic push [SSB:REQ-004, REQ-005, REQ-008; milestone M3, docs/plans/SSB-M3-PLAN.md §2].
 *
 * The state ref is to a state-ref Story what its branch is to a Story on today's layout, and this unit of work is that
 * branch's GitPublicationUnitOfWork for it, behind the same lifecycle authority adapter (sda/story-branch-authority.mjs):
 * - a transition is bound to the state revision it extends (`publication.expectedRemoteSha`), and one `ls-remote` of
 *   every ref it moves refuses it before any write when another clone moved that revision (REVISION_CONFLICT);
 * - its records are written in the state checkout and committed on the state ref, never on the Story branch, so an
 *   approval starts no CI (A2). The commit's trailer names the code commit it is about (REQ-004);
 * - one `git push --atomic` under an exact lease per ref moves the state ref, the Story branch when its tip moved, the
 *   ledger entry and its pin. Nothing lands alone (REQ-005, A3). A host without atomic pushes takes today's order:
 *   the branch, the state ref, then the ledger;
 * - a push refused, cancelled or lost leaves one sealed pending record, the same store today's layout uses, so the
 *   next transition finishes it first and `sync` settles it (§2.4).
 *
 * Loaded only for a state-ref Story.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SingularityFlowError, nowIso } from './util.mjs';
import { recordSha256 } from './records.mjs';
import { STATE_CHECKOUT } from './story-paths.mjs';
import { sourceFileAt, sourceRevision } from './source-inspection.mjs';
import {
  advanceStoryState, ensureStateCheckout, fetchStoryState, prepareStoryStateCommit, publishedStateTip,
  recordStatePublished, refTip, setStoryStateAside, stateContains, storyStateRef
} from './story-state-ref.mjs';
import { headAndBranch, publicationPushOutcome, recordBranchPublication } from './git.mjs';
import { configuredRemoteAuthority, frozenRemoteTransport, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from './git-execution.mjs';
import { assertLifecycleEvent, bindLifecycleEvent } from './lifecycle-event.mjs';
import {
  appendLedgerIntent, clearLedgerOutbox, persistLedgerIntent, prepareLedgerAppend, recordLedgerOutbox, recordStatePublication
} from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { clearPendingPublication, readPendingPublication, subjectSyncCommand, writePendingPublication } from './publication-pending.mjs';
import { capturePublicationPreimage, restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { assertNotCancelled } from './sda/shared-state-contract.mjs';

/** `git push --porcelain` flags that mean a ref is where it was sent: fast-forward, forced, new, already there. */
const LANDED = new Set([' ', '+', '*', '=']);
const DIAGNOSTIC_MAX = 4096;
const STALE = /stale info|non-fast-forward|fetch first/iu;

function diagnostic(...values) {
  const text = redactDiagnosticText(values.filter((value) => value != null && value !== '').join('\n')).trim();
  return Buffer.byteLength(text, 'utf8') <= DIAGNOSTIC_MAX ? text : `${text.slice(0, DIAGNOSTIC_MAX - 16)}…[truncated]`;
}

function porcelainFlags(stdout) {
  const flags = new Map();
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const match = /^([ +\-*!=])\t[^\t]*:([^\t]+)\t/u.exec(line);
    if (match) flags.set(match[2], match[1]);
  }
  return flags;
}

const resume = (id) => ({ executable: 'singularity-flow', argv: ['resume', id, '--fetch'], label: 'Bring in the records another clone published, then do this again' });
const setAside = (id) => ({ executable: 'singularity-flow', argv: ['sync', id, '--set-aside'], label: 'Keep this clone\'s records aside and go on from the published ones' });
const syncAgain = (id) => ({ executable: 'singularity-flow', argv: ['sync', id], label: 'Publish the Story\'s records that are waiting' });
const reachRemote = (remote) => ({ owner: 'person', command: `git ls-remote ${remote}`,
  label: `Check that '${remote}' answers, then publish the waiting records` });
const update = { executable: 'singularity-flow', argv: ['update'], label: 'Update SFlow, then run the command again' };

function remoteUrl(root, remote) {
  if (/[:/\\]/u.test(remote)) return remote;
  try { return configuredRemoteAuthority(root, remote, { direction: 'fetch' }).url ?? remote; } catch { return remote; }
}

/** One exact `ls-remote` of the named refs: { ok, refs: Map<ref, commit> }. */
export async function observeRemoteRefs(root, url, refs, { signal = null } = {}) {
  const frozen = frozenRemoteTransport(url);
  const listed = await runRemoteGitAsync(['ls-remote', '--', frozen.remote, ...refs], {
    cwd: root, operation: 'remote-probe', env: frozen.env, allowFailure: true, ...(signal ? { signal } : {})
  });
  if (listed.status !== 0) return { ok: false, refs: new Map(), result: listed };
  const found = new Map();
  for (const line of String(listed.stdout ?? '').split(/\r?\n/u)) {
    const match = /^([0-9a-f]{40,64})\t(\S+)$/u.exec(line);
    if (match && refs.includes(match[2])) found.set(match[2], match[1]);
  }
  return { ok: true, refs: found };
}

/** The lifecycle authority's exact revision of a state ref at `remote` (a remote name or its URL). */
export async function observeStoryStateRef(root, { ref, remote }, { signal = null } = {}) {
  const observed = await observeRemoteRefs(root, remoteUrl(root, remote), [ref], { signal });
  const sha = observed.refs.get(ref) ?? null;
  const state = !observed.ok ? 'unreachable' : sha ? 'present' : 'absent';
  return Object.freeze({ ref, reachable: observed.ok, malformed: false, sha, state, revision: state === 'present' ? sha : null });
}

function missingRemote(remote) {
  return new SingularityFlowError(`This checkout has no remote named '${remote}' to publish the Story's records to. Nothing was changed.`, {
    code: 'PUBLICATION_REMOTE_AUTHORITY_MISSING', details: { remote, owner: 'person',
      nextAction: { command: `git remote add ${remote} <url>`, label: `Add the remote '${remote}', then run the command again` } }
  });
}

function pendingRefusal(subject) {
  const route = subjectSyncCommand(subject);
  return new SingularityFlowError(`Story '${subject.id}' has records waiting to be published. Publish them with ${route} before another change.`, {
    code: 'PUBLICATION_PENDING', details: { subject: { kind: subject.kind, id: subject.id }, nextAction: syncAgain(subject.id) }
  });
}

/**
 * What the push moves, from one observation: the state ref under the transition's bound revision, and the Story branch
 * when the remote's tip is not the checkout's. Refuses, before anything is written, a remote another clone moved.
 */
function planLeases(root, { id, ref, branchRef, code, expected, local, observed, ledgerRef = null }) {
  const remoteState = observed.refs.get(ref) ?? null;
  let state = expected ?? null;
  if (remoteState !== state) {
    // Nothing published can be replaced by a create, and a remote behind this clone's records only lacks them.
    if (remoteState === null || (local && stateContains(root, remoteState, local))) state = remoteState;
    else {
      const unpublished = local && local !== expected;
      throw new SingularityFlowError(`Story '${id}' has records on the remote that this clone does not have: another clone published them first. Nothing was changed.`, {
        code: 'STORY_STATE_REMOTE_MOVED', outcomeClass: 'REVISION_CONFLICT',
        details: { ref, expected: expected ?? null, observed: remoteState, nextAction: unpublished ? setAside(id) : resume(id) }
      });
    }
  }
  const remoteBranch = observed.refs.get(branchRef) ?? null;
  let branch = null;
  if (remoteBranch !== code) {
    if (remoteBranch === null || stateContains(root, remoteBranch, code)) branch = { ref: branchRef, value: code, expected: remoteBranch };
    else {
      throw new SingularityFlowError(`Story '${id}' has code on its remote branch that this checkout does not have: another clone pushed to it. Nothing was changed.`, {
        code: 'STORY_PUBLICATION_REMOTE_DIVERGED', outcomeClass: 'REVISION_CONFLICT',
        details: { branch: branchRef, observedRemoteSha: remoteBranch, localParent: code,
          nextAction: { executable: 'singularity-flow', argv: ['refresh-branch'], label: 'Bring the branch\'s new commits in, then do this again' } }
      });
    }
  }
  return { state, branch, ledgerTip: ledgerRef ? observed.refs.get(ledgerRef) ?? null : undefined, remoteState };
}

const statePath = (relative) => path.posix.relative(STATE_CHECKOUT, relative.split(path.sep).join('/'));

async function appendLedgerAfter(root, config, intent, codeCommit, intentPath, { atomic = true } = {}) {
  try {
    const recorded = await appendLedgerIntent(root, config, intent, codeCommit, { atomic });
    await clearLedgerOutbox(root, intent.eventId);
    return recorded;
  } catch (error) {
    const reason = diagnostic(error?.message ?? String(error));
    if (intentPath) await recordLedgerOutbox(root, intentPath, codeCommit, new Error(reason)).catch(() => {});
    const message = `The Story's records are saved, but their ledger entry is waiting: ${reason} Run 'singularity-flow ledger reconcile' to complete it.`;
    console.warn(`Warning: ${message}`);
    return { pending: true, blocking: config.behind === 'block', eventId: intent.eventId, error: reason, message };
  }
}

/**
 * Push a retained state publication: atomically when the host can, else in today's order. Returns `{ pushed: true }`
 * with the ledger's result, or throws (or, under `warn`, returns) the retained outcome.
 */
async function publishRecord(root, record, { authority, intent, ledgerConfig, leases, fromSync = false }) {
  const id = record.subject.id;
  const branchRef = `refs/heads/${record.branch}`;
  const updates = [];
  if (leases.branch) updates.push([branchRef, leases.branch.value, leases.branch.expected]);
  if (leases.remoteState !== record.commit) updates.push([record.stateRef, record.commit, leases.state]);
  let audit = null;
  if (intent && ledgerConfig && ledgerConfig.remote === record.remote && leases.ledgerTip !== undefined) {
    audit = await prepareLedgerAppend(root, ledgerConfig, intent, record.codeCommit, { initializeIfAbsent: true }).catch(() => null);
    // A ledger tip this clone has not seen: the entry follows the push, which fetches it first.
    if (audit && (audit.expectedRemoteSha ?? null) !== (leases.ledgerTip ?? null)) audit = null;
    if (audit) {
      updates.push([`refs/heads/${ledgerConfig.branch}`, audit.ledgerCommit, audit.expectedRemoteSha ?? null]);
      if (audit.pinRef) updates.push([audit.pinRef, record.codeCommit, null]);
    }
  }
  const frozen = frozenRemoteTransport(authority.url, { push: true });
  const push = (list, atomic) => runRemoteGitAsync([
    'push', ...(atomic ? ['--atomic'] : []), '--porcelain',
    ...list.map(([ref, , expected]) => `--force-with-lease=${ref}:${expected ?? ''}`),
    frozen.remote, ...list.map(([ref, value]) => `${value}:${ref}`)
  ], { cwd: root, operation: 'remote-push', env: frozen.env, allowFailure: true });
  const landed = (result, list) => result.status === 0 && list.every(([ref]) => LANDED.has(porcelainFlags(result.stdout).get(ref)));
  let result = updates.length ? await push(updates, true) : { status: 0, stdout: '', stderr: '' };
  let pushed = updates.length ? landed(result, updates) : true;
  let sequentialLedger = !audit;
  if (!pushed && /does not support (?:the )?--atomic/iu.test(String(result.stderr ?? ''))) {
    // Today's order on a host without atomic pushes: the branch, the state ref, then the ledger.
    sequentialLedger = true;
    pushed = true;
    for (const update of updates.filter(([ref]) => ref === branchRef || ref === record.stateRef)) {
      result = await push([update], false);
      if (!landed(result, [update])) { pushed = false; break; }
      if (update[0] === branchRef) recordBranchPublication(root, record.branch, record.codeCommit, record.remote);
    }
  }
  if (!pushed) {
    const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const flags = porcelainFlags(result.stdout);
    const refused = updates.some(([ref]) => flags.get(ref) === '!');
    const pushOutcome = refused ? 'rejected' : publicationPushOutcome(result);
    const conflict = pushOutcome === 'rejected' && STALE.test(text);
    const retained = { ...record, pushOutcome, error: diagnostic(result.stderr, result.stdout), retainedAt: nowIso() };
    await writePendingPublication(root, { kind: 'story', id, record: retained });
    const message = `Story '${id}' records were saved here (${record.commit.slice(0, 8)}) but not published: `
      + (conflict ? 'another clone moved the remote first, so nothing moved there.'
        : pushOutcome === 'transport-indeterminate' ? 'the push\'s answer was lost, so the remote may hold them.'
          : 'the remote refused the push, so nothing moved there.')
      + (retained.error ? ` Git reported: ${retained.error}` : '');
    if (record.publicationMode === 'warn') return { pushed: false, pending: true, warning: message };
    const failure = new SingularityFlowError(message, {
      code: conflict ? 'STORY_STATE_PUBLICATION_CONFLICT' : 'STORY_STATE_PUBLICATION_RETAINED',
      outcomeClass: pushOutcome === 'transport-indeterminate' ? 'OUTCOME_UNKNOWN' : conflict ? 'REVISION_CONFLICT' : null,
      details: { ref: record.stateRef, commit: record.commit, pushOutcome,
        nextAction: conflict ? setAside(id) : pushOutcome === 'transport-indeterminate' && !fromSync ? syncAgain(id) : reachRemote(record.remote) }
    });
    failure.publicationRefAdvanced = true;
    failure.publicationCommit = record.commit;
    failure.pushOutcome = pushOutcome;
    throw failure;
  }
  recordStatePublished(root, id, record.remote, record.commit);
  if (leases.branch) recordBranchPublication(root, record.branch, record.codeCommit, record.remote);
  let ledger = null;
  if (audit && !sequentialLedger) {
    await recordStatePublication(root, ledgerConfig, audit.ledgerCommit, audit.expectedRemoteSha).catch(() => {});
    await clearLedgerOutbox(root, intent.eventId).catch(() => {});
    ledger = { duplicate: false, eventId: audit.eventId, entryHash: audit.entryHash, sequence: audit.sequence, ledgerCommit: audit.ledgerCommit };
  }
  await clearPendingPublication(root, { kind: 'story', id });
  if (intent && ledgerConfig && !ledger) {
    ledger = await appendLedgerAfter(root, ledgerConfig, intent, record.codeCommit,
      record.ledgerIntentPath ? `${STATE_CHECKOUT}/${record.ledgerIntentPath}` : null, { atomic: !sequentialLedger });
  }
  return { pushed: true, ledger };
}

/** The ledger intent a retained state commit carries, or null. */
function retainedIntent(root, record) {
  if (!record.ledgerIntentPath) return null;
  const shown = sourceFileAt(root, record.commit, record.ledgerIntentPath, { offline: true });
  if (shown.status !== 'present') return null;
  try { return JSON.parse(shown.value); } catch { return null; }
}

export class StoryStateUnitOfWork {
  constructor(root) { this.root = root; }

  async execute({
    subject, event, commit: commitSpec, publication = {}, ledger = null, state = null, beforeCommit = null,
    afterOwnedWrites = null, fault = null, transactionId: givenTransaction = null, storage = {}, signal = null
  } = {}) {
    const root = this.root;
    // A transition names its transaction as the branch's journal does, so its records and its commit carry one ID.
    const transactionId = givenTransaction ?? randomUUID();
    let envelope = assertLifecycleEvent(event, subject);
    if (!commitSpec?.message || !publication.branch) {
      throw new SingularityFlowError('This change to the Story names no commit message or branch, so nothing was changed.', {
        code: 'PUBLICATION_TRANSITION_INCOMPLETE', details: { nextAction: update }
      });
    }
    const id = subject.id;
    const definition = storage.definition ?? null;
    const mode = publication.mode ?? 'required';
    const remote = publication.remote ?? 'origin';
    const authority = mode === 'off' ? null : publication.authority ?? configuredRemoteAuthority(root, remote);
    if (mode !== 'off' && !authority?.url) throw missingRemote(remote);
    // Every governed push names the revision it replaces, or null to create (SDA-AC-025).
    if (mode !== 'off' && publication.expectedRemoteSha === undefined) {
      throw new SingularityFlowError(`Story '${id}' publication names no expected revision of its records. Nothing was changed.`, {
        code: 'PUSH_EXPECTED_REVISION_REQUIRED', details: { branch: publication.branch }
      });
    }
    const ledgerConfig = ledger?.config?.enabled ? normalizeLedgerConfig(ledger.config) : null;
    const intent = ledgerConfig && ledger.intent ? ledger.intent : null;
    return withSubjectLock(root, subject, async () => {
      const { branch: current, head: code } = headAndBranch(root);
      if (current !== publication.branch) {
        throw new SingularityFlowError(`Current branch ${current} must match story branch ${publication.branch}.`, {
          code: 'PUBLICATION_BRANCH_MISMATCH', details: { nextAction: { owner: 'person', command: `git switch ${publication.branch}`, label: 'Go back to the Story\'s branch, then run the command again' } }
        });
      }
      if (await readPendingPublication(root, { kind: subject.kind, id })) throw pendingRefusal(subject);
      await ensureStateCheckout(root, id, { definition });
      const ref = storyStateRef(id, definition);
      const parent = refTip(root, ref);
      const branchRef = `refs/heads/${publication.branch}`;
      const ledgerRef = ledgerConfig && ledgerConfig.remote === remote ? `refs/heads/${ledgerConfig.branch}` : null;
      let leases = null;
      if (mode !== 'off') {
        const observed = await observeRemoteRefs(root, authority.url, [ref, branchRef, ...(ledgerRef ? [ledgerRef] : [])]);
        if (observed.ok) {
          leases = planLeases(root, { id, ref, branchRef, code, expected: publication.expectedRemoteSha, local: parent, observed, ledgerRef });
        }
      }
      // Cancelled while it waited for the lock or observed: nothing is written yet.
      assertNotCancelled(signal, 'transition');
      const preimage = await capturePublicationPreimage(root, [STATE_CHECKOUT]);
      const undo = async (error) => {
        if (state?.rollback) await state.rollback(preimage);
        else await restorePublicationPreimage(root, preimage, { subject });
        throw error;
      };
      let ledgerIntentPath = null;
      let prepared;
      try {
        if (intent) intent.payload = { ...(intent.payload ?? {}), lifecycleEvent: envelope, storyState: { ref, parent } };
        if (state?.write) {
          // The commit this transition extends is the state ref's; the code commit it is about is named beside it.
          const written = await state.write(envelope, { transactionId, expectedHead: parent, codeHead: code, branch: publication.branch });
          if (written?.event) envelope = assertLifecycleEvent(written.event, subject);
        }
        if (fault) await fault('after-state-write', { envelope });
        if (state?.validate) await state.validate(envelope);
        if (beforeCommit) await beforeCommit(envelope);
        if (intent) {
          intent.payload = { ...(intent.payload ?? {}), lifecycleEvent: envelope };
          // Committed with the records, so recovery reads the entry it owes from the state commit.
          ledgerIntentPath = await persistLedgerIntent(root, STATE_CHECKOUT, intent);
        }
        if (afterOwnedWrites) await afterOwnedWrites(envelope, { ledgerIntentPath });
        if (fault) await fault('before-state-commit', { envelope });
        assertNotCancelled(signal, 'transition');
        // REQ-004: the state commit names the code commit it is about, and its event; its transaction trailers are a
        // governed commit's, so a record's commit is verified as on the branch.
        prepared = prepareStoryStateCommit(root, id, `${commitSpec.message}\n\nStory-Code-Commit: ${code}\nStory-Event: ${envelope.eventId}`
          + `\nSingularity-Flow-Transaction: ${transactionId}\nSingularity-Flow-Event-SHA256: sha256:${recordSha256(envelope)}`
          + `\nSingularity-Flow-Publication-Mode: ${mode}`, { definition, expected: parent });
      } catch (error) { await undo(error); }
      const commit = prepared.commit;
      const record = mode === 'off' ? null : {
        schemaVersion: currentSchemaVersion('pending-publication'),
        layout: 'state-ref', subject, branch: publication.branch, remote, remoteFingerprint: authority.fingerprint ?? null,
        stateRef: ref, commit, parent, expectedRemoteSha: leases ? leases.state : publication.expectedRemoteSha ?? null,
        codeCommit: code, ledgerIntentPath: ledgerIntentPath ? statePath(ledgerIntentPath) : null,
        event: bindLifecycleEvent(envelope, commit), transactionId, createdAt: nowIso(), publicationMode: mode,
        recoveryStage: 'state-ref-advanced-before-publication', pushOutcome: 'not-attempted'
      };
      // Recorded before the ref moves, so a process that stops between the two leaves a record recovery can read.
      try {
        if (record) await writePendingPublication(root, { kind: subject.kind, id, record });
        if (prepared.committed) advanceStoryState(root, id, prepared, commitSpec.message);
      } catch (error) {
        if (record) await clearPendingPublication(root, { kind: subject.kind, id }).catch(() => {});
        await undo(error);
      }
      envelope = bindLifecycleEvent(envelope, commit);
      const result = { sha: commit, replayed: false, event: envelope, candidate: null,
        state: { ref, commit, parent, committed: prepared.committed, codeCommit: code } };
      if (fault) await fault('after-commit', { envelope, sourceCommit: commit });
      if (!record) {
        const recorded = intent ? await appendLedgerAfter(root, ledgerConfig, intent, code, ledgerIntentPath) : null;
        return { ...result, pushed: false, ledger: recorded, state: { ...result.state, published: false } };
      }
      // The last boundary at which a cancellation is honoured: the commit is the ref's, retained for sync (SDA §7.3).
      if (signal?.aborted) {
        const cancelled = new SingularityFlowError(`Story '${id}' records were saved here (${commit.slice(0, 8)}) and not published: the command was cancelled before its push.`, {
          code: 'PUBLICATION_CANCELLED_BEFORE_PUSH', details: { nextAction: subjectSyncCommand(subject) }
        });
        cancelled.publicationRefAdvanced = true;
        cancelled.publicationCommit = commit;
        cancelled.pushOutcome = 'not-attempted';
        throw cancelled;
      }
      if (!leases) {
        const observed = await observeRemoteRefs(root, authority.url, [ref, branchRef, ...(ledgerRef ? [ledgerRef] : [])]);
        if (observed.ok) leases = planLeases(root, { id, ref, branchRef, code, expected: record.expectedRemoteSha, local: commit, observed, ledgerRef });
      }
      if (!leases) {
        // The remote did not answer: nothing was sent, and sync sends it.
        const message = `Story '${id}' records were saved here (${commit.slice(0, 8)}) but not published: '${remote}' did not answer.`;
        await writePendingPublication(root, { kind: subject.kind, id, record: { ...record, pushOutcome: 'rejected', error: message } });
        if (mode === 'warn') return { ...result, pushed: false, pending: true, warning: message, ledger: null };
        const failure = new SingularityFlowError(message, { code: 'STORY_STATE_PUBLICATION_RETAINED', details: { nextAction: reachRemote(remote) } });
        failure.publicationRefAdvanced = true;
        failure.publicationCommit = commit;
        failure.pushOutcome = 'rejected';
        throw failure;
      }
      const published = await publishRecord(root, record, { authority, intent, ledgerConfig, leases });
      return { ...result, ...published, state: { ...result.state, published: published.pushed === true } };
    });
  }
}

/**
 * `sync` for a state-ref Story [§2.4]: the retained publication is fetched against, then finished (the remote holds
 * it: the tracking refs and the ledger entry are completed), pushed again under fresh leases, or refused with its
 * set-aside when another clone moved the remote past it. Returns syncPublication's shape.
 */
export async function syncStoryStatePublication(root, config, workflow) {
  const id = workflow.workItem.id;
  const subject = { kind: 'story', id };
  const none = { pending: false, pushed: null, noOp: true, capabilityPublished: [], ledger: null };
  return withSubjectLock(root, subject, async () => {
    const pending = await readPendingPublication(root, subject);
    if (!pending || pending.record?.layout !== 'state-ref') return none;
    const record = pending.record;
    const local = refTip(root, record.stateRef);
    // Stopped between the commit object and the ref move: the commit never became the records', so nothing is owed.
    if (local !== record.commit && !stateContains(root, record.commit, local)) {
      await clearPendingPublication(root, subject);
      return { ...none, recoveredPrepared: true, restoredPrepared: false };
    }
    const authority = configuredRemoteAuthority(root, record.remote);
    if (!authority?.url) throw missingRemote(record.remote);
    const ledgerConfig = normalizeLedgerConfig(workflow.resolution?.ledger ?? config.ledger ?? {});
    const ledgerRef = ledgerConfig.enabled && ledgerConfig.remote === record.remote ? `refs/heads/${ledgerConfig.branch}` : null;
    const branchRef = `refs/heads/${record.branch}`;
    const observed = await observeRemoteRefs(root, authority.url, [record.stateRef, branchRef, ...(ledgerRef ? [ledgerRef] : [])]);
    if (!observed.ok) {
      throw new SingularityFlowError(`'${record.remote}' did not answer, so Story '${id}' records are still waiting to be published. Nothing was changed.`, {
        code: 'STORY_STATE_REMOTE_UNREACHABLE', details: { remote: record.remote, nextAction: reachRemote(record.remote) }
      });
    }
    const intent = ledgerConfig.enabled ? retainedIntent(root, record) : null;
    const remoteState = observed.refs.get(record.stateRef) ?? null;
    // The remote's state may be one this clone has never fetched: bring it in to tell.
    if (remoteState && sourceRevision(root, `${remoteState}^{commit}`, { offline: true }).status !== 'present') {
      await fetchStoryState(root, id, { remote: record.remote, definition: config }).catch(() => null);
    }
    if (remoteState && (remoteState === record.commit || stateContains(root, record.commit, remoteState))) {
      // It landed: the push's answer was lost, or this clone stopped before it cleared the record.
      recordStatePublished(root, id, record.remote, remoteState);
      if ((observed.refs.get(branchRef) ?? null) === record.codeCommit) recordBranchPublication(root, record.branch, record.codeCommit, record.remote);
      await clearPendingPublication(root, subject);
      const ledger = intent ? await appendLedgerAfter(root, ledgerConfig, intent, record.codeCommit,
        `${STATE_CHECKOUT}/${record.ledgerIntentPath}`) : null;
      return { pending: false, pushed: record.commit, remote: record.remote, branch: record.stateRef, capabilityPublished: [], ledger,
        ...(remoteState !== record.commit ? { remoteBuiltOn: remoteState } : {}) };
    }
    const leases = planLeases(root, { id, ref: record.stateRef, branchRef, code: record.codeCommit,
      expected: record.expectedRemoteSha, local: record.commit, observed, ledgerRef });
    const published = await publishRecord(root, { ...record, publicationMode: 'required' }, { authority, intent, ledgerConfig: ledgerConfig.enabled ? ledgerConfig : null, leases, fromSync: true });
    return { pending: false, pushed: record.commit, remote: record.remote, branch: record.stateRef, capabilityPublished: [], ledger: published.ledger };
  });
}

/**
 * `sync <ID> --set-aside` for a state-ref Story, previewed: the remote's records are fetched into the tracking ref and
 * compared with this clone's. `needed` when this clone holds state commits the remote's records do not contain.
 */
export async function planStoryStateSetAside(root, config, workflow) {
  const id = workflow.workItem.id;
  const remote = config.git?.remote ?? 'origin';
  const fetched = await fetchStoryState(root, id, { remote, definition: config });
  const ref = storyStateRef(id, config);
  const local = refTip(root, ref);
  const published = publishedStateTip(root, id, remote);
  const needed = Boolean(local && published && local !== published && !stateContains(root, local, published));
  return { workId: id, layout: 'state-ref', ref, local, published, needed, fetched: fetched.action,
    nextAction: needed
      ? { executable: 'singularity-flow', argv: ['sync', id, '--set-aside', '--confirm', local], label: 'Set this clone\'s records aside and go on from the published ones' }
      : { executable: 'singularity-flow', argv: ['resume', id], label: 'Open the Story from its records' } };
}

/**
 * The set-aside itself, confirmed by the local state commit the preview named: this clone's unpublished state commits
 * are kept on `refs/singularity/state-aside/<ID>/<time>`, and the Story goes on from what was published.
 */
export async function setAsideStoryStatePublication(root, config, workflow, { confirm } = {}) {
  const id = workflow.workItem.id;
  const subject = { kind: 'story', id };
  const remote = config.git?.remote ?? 'origin';
  return withSubjectLock(root, subject, async () => {
    const plan = await planStoryStateSetAside(root, config, workflow);
    if (!plan.needed) return { ...plan, setAside: false };
    if (String(confirm ?? '').toLowerCase() !== plan.local) {
      throw new SingularityFlowError(`Story '${id}' records changed since the preview (${String(plan.local).slice(0, 12)} now). Nothing was set aside.`, {
        code: 'STORY_STATE_SET_ASIDE_CHANGED', details: { ref: plan.ref, local: plan.local,
          nextAction: { executable: 'singularity-flow', argv: ['sync', id, '--set-aside'], label: 'Preview the set-aside again' } }
      });
    }
    const result = setStoryStateAside(root, id, { definition: config, remote });
    await clearPendingPublication(root, subject);
    return { ...plan, ...result, nextAction: { executable: 'singularity-flow', argv: ['resume', id], label: 'Open the Story from the published records' } };
  });
}
