/**
 * Refusals for retrying a retained publication, each naming its way forward.
 *
 * A retained commit blocks every later change to its subject until it reaches the remote, and a
 * retry (`sync`) can only send that exact commit again. When the remote refuses it under a rule, a
 * server hook or push protection, the same push fails the same way every time: the refusal must
 * say so and name what a person resolves before retrying, never offer the retry as the repair.
 * When the configured remote changed after the commit was retained, the refusal names the change
 * and, for a sealed marker, offers a rebind to the new URL that the person confirms by digest.
 */
import { createHash } from 'node:crypto';

import { remoteNames } from './git.mjs';
import {
  classifyGitRemoteFailure, configuredRemoteAuthority, redactDiagnosticText, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { canonicalJson } from './foundation/record-schema.mjs';
import { SingularityFlowError } from './util.mjs';

// What a person resolves before the same commit can be sent again, by remote classification.
const PUSH_REPAIR = Object.freeze({
  'policy-rejected': 'The remote refused this exact commit under a repository rule, a server hook or push protection '
    + '(for example a flagged secret, an unsigned commit, a commit-message rule or a protected branch), so sending it '
    + 'again fails the same way. Resolve what the provider message names first: have the provider allow a flagged secret '
    + 'through its own review, or ask the repository owner to admit this commit to the branch. When the commit itself must '
    + 'change (its content, signature or message), keep the retained commit and do not rewrite the branch by hand: inspect '
    + 'the recovery plan and doctor --json for the exact commit and decide the repair with the repository owner.',
  'authorization-denied': 'Your Git identity cannot write to this branch. Ask the repository owner for write access to it; '
    + 'the same commit is then sent unchanged.',
  'remote-not-found': 'The configured remote repository was not found. Correct the remote URL or your access to it; '
    + 'the same commit is then sent unchanged.',
  unknown: 'The remote refused the retained commit. When another clone published to this branch first, the same commit '
    + 'cannot be sent unchanged: inspect the recovery plan, which names a replay or a set-aside. Otherwise resolve what '
    + 'the provider message names before retrying.'
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The remote's own words, redacted and bounded: they name what the provider wants changed. Both
 * streams: a porcelain push says why each ref was refused (`stale info`, `fetch first`) on stdout,
 * and without it recover never saw a moved remote after a retry and offered sync again (2026-11-01).
 */
export function publicationPushDiagnostic(result) {
  const raw = [result?.stderr, result?.stdout].map((text) => String(text ?? '').trim()).filter(Boolean).join('\n');
  return raw ? redactDiagnosticText(raw).slice(0, 2000) : '';
}

/**
 * The refusal for a retry the remote still refuses. Keeps one code for every outcome (callers
 * branch on it) and carries the classification, so a deterministic refusal names a manual repair
 * and only a transient failure leads with the retry.
 */
export function publicationPushRefusal({
  prefix = 'Push still fails',
  code = 'PUBLICATION_PUSH_FAILED',
  result,
  outcome = null,
  subject = null,
  commit = null,
  branch = null,
  remote = null,
  retryCommand = null,
  inspectCommand = null,
  extraDetails = {}
} = {}) {
  const classified = result?.failure ?? classifyGitRemoteFailure(result);
  const remoteFailure = {
    code: classified.code ?? 'REMOTE_UNKNOWN',
    classification: classified.classification ?? 'unknown',
    retryable: classified.retryable === true,
    advice: classified.advice ?? null,
    ...(classified.hook ? { hook: classified.hook } : {})
  };
  const diagnostic = publicationPushDiagnostic(result);
  // A transport that may have accepted the push before losing its answer is retried as it is.
  const retryable = remoteFailure.retryable || outcome === 'transport-indeterminate';
  const repair = retryable ? null
    : PUSH_REPAIR[remoteFailure.classification] ?? remoteFailure.advice ?? PUSH_REPAIR.unknown;
  const recoveryCommands = retryable
    ? [retryCommand && { command: retryCommand,
      label: `${remoteFailure.advice ?? 'Restore remote access.'} Then send the same retained commit again.` }]
    : [
        inspectCommand && { command: inspectCommand,
          label: 'Inspect the retained commit and what blocks it; nothing is pushed.' },
        retryCommand && { command: retryCommand,
          label: 'Only after the provider accepts this exact commit: send it again.' }
      ];
  const guidance = retryable
    ? remoteFailure.advice ?? 'Restore remote access, then retry.'
    : repair;
  return new SingularityFlowError(
    `${prefix}${diagnostic ? `: ${diagnostic}` : ''}. ${guidance}`,
    {
      code,
      details: {
        ...extraDetails,
        ...(subject ? { subject } : {}),
        ...(commit ? { commit } : {}),
        ...(branch ? { branch } : {}),
        ...(remote ? { remote } : {}),
        outcome,
        retryable,
        remoteFailure,
        recoveryCommands: recoveryCommands.filter(Boolean),
        ...(repair ? { actions: [{ label: repair }] } : {})
      }
    }
  );
}

function configuredRemoteNames(root) {
  try { return remoteNames(root); } catch { return []; }
}

/** What changed about the remote a retained commit was bound to, credential-free. */
export function describePublicationRemoteChange(root, record) {
  const remote = String(record?.remote ?? 'origin');
  let current = null;
  let unsafe = false;
  try { current = configuredRemoteAuthority(root, remote); } catch { unsafe = true; }
  let matchingRemote = null;
  if (record?.remoteFingerprint) {
    for (const name of configuredRemoteNames(root)) {
      if (name === remote) continue;
      try {
        if (configuredRemoteAuthority(root, name).fingerprint === record.remoteFingerprint) {
          matchingRemote = name;
          break;
        }
      } catch { /* A credential-bearing remote is never a match. */ }
    }
  }
  const change = unsafe ? 'credentials'
    : !current?.url ? 'removed'
      : !record?.remoteFingerprint ? 'unrecorded' : 'url-changed';
  return {
    change,
    remote,
    currentUrl: current?.url ? sanitizeRemote(current.url) : null,
    currentFingerprint: current?.fingerprint ?? null,
    recordedFingerprint: record?.remoteFingerprint ?? null,
    matchingRemote
  };
}

/** The digest a person confirms to bind a retained commit to the remote's current URL. */
export function publicationRemoteRebindConfirmation(subject, record, currentFingerprint) {
  return `sha256:${sha256(canonicalJson({
    kind: 'pending-publication-remote-rebind',
    subject: { kind: subject?.kind ?? null, id: subject?.id ?? null },
    commit: record?.commit ?? null,
    branch: record?.branch ?? null,
    remote: record?.remote ?? null,
    from: record?.remoteFingerprint ?? null,
    to: currentFingerprint ?? null
  }))}`;
}

/**
 * Whether a confirmed rebind applies to this exact marker and remote. Only a machine-sealed marker
 * may move, and only to a credential-free URL still configured under the same remote name.
 */
export function acceptPublicationRemoteRebind(root, { subject, record, integrityVerified, confirmation }) {
  if (!confirmation || integrityVerified !== true) return null;
  const change = describePublicationRemoteChange(root, record);
  if (!['url-changed', 'unrecorded'].includes(change.change) || !change.currentFingerprint) return null;
  const expected = publicationRemoteRebindConfirmation(subject, record, change.currentFingerprint);
  return confirmation === expected ? { ...change, confirmation: expected } : null;
}

/** Name the remote change and offer the confirmed rebind (when one is safe) or the restore. */
export function publicationRemoteChangedRefusal(root, {
  label, subject, record, markerPath = null, integrityVerified = false,
  rebindCommand = null, confirmationGiven = null, message = null
}) {
  const change = describePublicationRemoteChange(root, record);
  const what = {
    credentials: `remote '${change.remote}' now carries credentials in its URL, which publication never uses`,
    removed: `remote '${change.remote}' is no longer configured`,
    unrecorded: `the retained commit recorded no URL fingerprint for remote '${change.remote}'`,
    'url-changed': `remote '${change.remote}' now points to ${change.currentUrl}, not the URL the commit was retained for`
  }[change.change];
  const rebindable = Boolean(rebindCommand) && integrityVerified === true
    && ['url-changed', 'unrecorded'].includes(change.change) && Boolean(change.currentFingerprint);
  const confirmation = rebindable
    ? publicationRemoteRebindConfirmation(subject, record, change.currentFingerprint) : null;
  const restore = change.matchingRemote
    ? `The URL it was retained for is still configured as remote '${change.matchingRemote}'. Point '${change.remote}' back at it (git remote set-url), then retry.`
    : `Point '${change.remote}' back at the URL the commit was retained for (git remote set-url), then retry.`;
  const rebind = rebindable
    ? ` If ${change.currentUrl} is the same repository (for example the remote moved from HTTPS to SSH), confirm the rebind to send the retained commit there instead.`
    : '';
  const stale = confirmationGiven && confirmationGiven !== confirmation
    ? ' The rebind confirmation given does not match this marker and remote; review the current one.' : '';
  return new SingularityFlowError(
    `${message ?? `${label} publication remote '${change.remote}' changed after the commit was retained`}: ${what}. `
    + `The marker was retained and no ref was pushed. ${restore}${rebind}${stale}`,
    {
      code: 'PENDING_PUBLICATION_REMOTE_CHANGED',
      details: {
        subject,
        ...(markerPath ? { markerPath } : {}),
        remoteChange: { ...change, rebindConfirmation: confirmation },
        recoveryCommands: rebindable ? [{
          command: `${rebindCommand} --rebind-remote ${confirmation}`,
          label: `Only when ${change.currentUrl} is the same repository: bind the retained commit to it and send it there.`
        }] : [],
        actions: [{ label: restore }]
      }
    }
  );
}
