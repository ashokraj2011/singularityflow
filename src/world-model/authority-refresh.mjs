import path from 'node:path';

import { exactRemoteBranchObservationAsync, hasRemote, refHead, validBranch } from '../git.mjs';
import { runRemoteGitAsync } from '../git-execution.mjs';
import { configuredRemoteAuthority, configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { posix, run, SingularityFlowError } from '../util.mjs';
import { worldModelStateAuthority } from './authority-config.mjs';

function configuredAuthority(config) {
  const authority = worldModelStateAuthority(config.definition ?? {}, {
    branch: config.stateBranch,
    remote: config.remote
  });
  const stateBranch = authority.branch;
  const remote = authority.remote;
  return Object.freeze({ stateBranch, remote, remoteRef: `refs/remotes/${remote}/${stateBranch}` });
}

function refreshFailure(root, config, observed, { cached }) {
  const { stateBranch, remote } = configuredAuthority(config);
  if (observed?.timedOut) {
    return Object.freeze({
      status: cached ? 'timeout-cached' : 'unavailable', configured: true,
      failure: 'network-transient', stateBranch, remote
    });
  }
  const classification = observed?.failure?.classification ?? 'unknown';
  if (['offline', 'network-transient'].includes(classification)) {
    return Object.freeze({
      status: cached ? 'offline-cached' : 'unavailable', configured: true,
      failure: classification, stateBranch, remote
    });
  }
  throw new SingularityFlowError(
    'The registered World-Model state authority could not be observed safely.',
    {
      code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
      details: {
        classification,
        retryable: observed?.failure?.retryable === true,
        stateBranch,
        remote
      }
    }
  );
}

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function trackingRefFailure(stateBranch, remote, classification, retryable = true) {
  const message = classification === 'tracking-ref-raced'
    ? 'The remote state branch is absent, but its stale tracking ref changed while it was being cleared.'
    : 'The remote state branch is absent, but its stale tracking ref could not be cleared safely.';
  return new SingularityFlowError(message, {
    code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
    details: { classification, retryable, stateBranch, remote }
  });
}

function observeExactTrackingRef(root, ref, runLocalGit) {
  try {
    const options = { cwd: root, allowFailure: true };
    const symbolic = runLocalGit('git', ['symbolic-ref', '-q', ref], options);
    if (symbolic.status === 0 && !symbolic.error && !symbolic.timedOut && !symbolic.signal) {
      return { kind: 'symbolic' };
    }
    if (symbolic.status !== 1 || symbolic.error || symbolic.timedOut || symbolic.signal) {
      return { kind: 'unknown' };
    }
    // `show-ref --verify` returns 128 for an absent ref on supported Git versions, the same
    // status used for malformed/unavailable reads. A framed listing distinguishes absence.
    const listed = runLocalGit('git', [
      'for-each-ref', '--format=%(refname)%00%(objectname)', ref
    ], options);
    if (listed.status !== 0 || listed.error || listed.timedOut || listed.signal
        || typeof listed.stdout !== 'string') return { kind: 'unknown' };
    if (listed.stdout === '') return { kind: 'absent' };
    const match = /^([^\0\r\n]+)\0([0-9a-f]{40}|[0-9a-f]{64})\n$/u.exec(listed.stdout);
    if (!match || match[1] !== ref || !FULL_OID.test(match[2])) return { kind: 'unknown' };
    return { kind: 'oid', oid: match[2] };
  } catch {
    return { kind: 'unknown' };
  }
}

/** Only the explicit World-Model authority refresh issues this closed local-ref deletion. */
function clearAbsentAuthorityTrackingRef(root, { stateBranch, remote, remoteRef }, runLocalGit) {
  const before = observeExactTrackingRef(root, remoteRef, runLocalGit);
  if (before.kind === 'symbolic') throw trackingRefFailure(stateBranch, remote, 'tracking-ref-symbolic', false);
  if (before.kind === 'unknown') throw trackingRefFailure(stateBranch, remote, 'tracking-ref-unverified');
  if (before.kind === 'absent') return false;

  const request = Object.freeze({
    kind: 'world-model-absent-authority-tracking-ref-delete',
    ref: remoteRef,
    expectedOldOid: before.oid
  });
  if (!Object.isFrozen(request)
      || Object.keys(request).sort().join('\0') !== ['expectedOldOid', 'kind', 'ref'].join('\0')
      || request.kind !== 'world-model-absent-authority-tracking-ref-delete'
      || request.ref !== `refs/remotes/${remote}/${stateBranch}`
      || !FULL_OID.test(request.expectedOldOid)) {
    throw trackingRefFailure(stateBranch, remote, 'tracking-ref-unverified', false);
  }
  let removed;
  try {
    removed = runLocalGit('git', [
      'update-ref', '--no-deref', '-d', request.ref, request.expectedOldOid
    ], { cwd: root, allowFailure: true });
  } catch {
    // An exception or lost child acknowledgement cannot prove whether Git installed the deletion.
    throw trackingRefFailure(stateBranch, remote, 'tracking-ref-outcome-unknown');
  }
  const after = observeExactTrackingRef(root, request.ref, runLocalGit);
  const acknowledged = removed?.status === 0 && !removed.error && !removed.timedOut && !removed.signal;
  if (acknowledged && after.kind === 'absent') return true;
  if (after.kind === 'symbolic') throw trackingRefFailure(stateBranch, remote, 'tracking-ref-symbolic', false);
  if (after.kind === 'oid' && (acknowledged || after.oid !== request.expectedOldOid)) {
    throw trackingRefFailure(stateBranch, remote, 'tracking-ref-raced');
  }
  // The ref can be absent even if Git failed to acknowledge the deletion. Never promote that
  // observation to an authoritative remote-absent success without an acknowledged exact CAS.
  throw trackingRefFailure(stateBranch, remote, 'tracking-ref-outcome-unknown');
}

/**
 * Compare the configured remote authority with the materialized tracking ref without changing it.
 *
 * `wm ensure`, status surfaces, and Plan previews are registered reads. They may observe a remote,
 * but they must never turn that read into `git fetch`. A stale result points to the separately
 * registered refresh mutation below.
 */
export async function inspectWorldModelV4Authority(root, config) {
  const { stateBranch, remote, remoteRef } = configuredAuthority(config);
  if (!stateBranch || !hasRemote(root, remote)) return { status: 'no-remote', configured: false };
  validBranch(root, stateBranch);
  validBranch(root, remote);
  const cachedCommit = refHead(root, remoteRef);
  const cached = cachedWorldModelV4AuthorityPresent(root, config);
  const configured = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (configured.ambiguous) {
    throw new SingularityFlowError(
      'The registered World-Model state authority has more than one configured fetch endpoint.',
      {
        code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
        details: { classification: 'ambiguous-remote', retryable: false, stateBranch, remote }
      }
    );
  }
  const effective = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
  if (!configured.configured || !configured.url || !effective.url) {
    throw new SingularityFlowError(
      'The registered World-Model state authority does not resolve to one exact fetch endpoint.',
      {
        code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
        details: { classification: 'remote-unavailable', retryable: false, stateBranch, remote }
      }
    );
  }
  const observed = await exactRemoteBranchObservationAsync(root, effective.url, stateBranch);
  if (!observed.reachable) return refreshFailure(root, config, observed.result, { cached });
  if (observed.malformed) {
    throw new SingularityFlowError(
      'The registered World-Model state authority returned an ambiguous branch advertisement.',
      {
        code: 'WMB_STATE_AUTHORITY_REFRESH_FAILED',
        details: { classification: 'ambiguous-ref', retryable: false, stateBranch, remote }
      }
    );
  }
  if (observed.sha == null) {
    return Object.freeze({
      status: 'remote-absent', configured: true, stateBranch, remote,
      remoteCommit: null, cachedCommit: cachedCommit ?? null, cached
    });
  }
  return Object.freeze({
    status: cachedCommit === observed.sha ? 'current' : 'stale',
    configured: true, stateBranch, remote,
    remoteCommit: observed.sha, cachedCommit: cachedCommit ?? null, cached
  });
}

/** Explicitly materialize the one configured state authority tracking ref. */
export async function refreshWorldModelV4Authority(root, config, {
  refreshRemote = true, runLocalGit = run
} = {}) {
  const { stateBranch, remote, remoteRef } = configuredAuthority(config);
  if (!stateBranch || !hasRemote(root, remote)) return { status: 'no-remote', configured: false };
  if (!refreshRemote) {
    const commit = refHead(root, remoteRef);
    return commit
      ? { status: 'cached', configured: true, stateBranch, remote, commit }
      : {
          status: 'refresh-required', configured: true, stateBranch, remote,
          commit: null
        };
  }
  validBranch(root, stateBranch);
  validBranch(root, remote);
  const timeoutMs = config.stateFetchTimeoutMs
    ?? config.definition?.worldModel?.stateFetchTimeoutMs
    ?? 10_000;
  const fetched = await runRemoteGitAsync([
    'fetch', '--no-tags', remote, `+refs/heads/${stateBranch}:${remoteRef}`
  ], { cwd: root, operation: 'remote-configuration', timeoutMs });
  if (fetched.status === 0) {
    return Object.freeze({
      status: 'refreshed', configured: true, stateBranch, remote,
      commit: refHead(root, remoteRef) ?? null
    });
  }
  if (/couldn.t find remote ref|remote ref does not exist/i.test(`${fetched.stderr}\n${fetched.stdout}`)) {
    // A reachable remote that advertises no state branch is authoritative. Remove only the exact
    // configured tracking ref so a later read cannot mistake an old cached projection for current
    // state. The optional old value makes concurrent ref movement fail closed.
    const removedCachedRef = clearAbsentAuthorityTrackingRef(
      root, { stateBranch, remote, remoteRef }, runLocalGit
    );
    return Object.freeze({
      status: 'remote-absent', configured: true, stateBranch, remote,
      commit: null, removedCachedRef
    });
  }
  return refreshFailure(root, config, fetched, {
    cached: cachedWorldModelV4AuthorityPresent(root, config)
  });
}

export function cachedWorldModelV4AuthorityPresent(root, config) {
  const { stateBranch, remote } = configuredAuthority(config);
  if (!stateBranch) return false;
  const manifest = posix(path.join(config.outputDir, 'manifest.json'));
  // Only the last fetched remote-tracking ref is a verified cache. A local state branch can be an
  // unpublished or rewritten projection and must never become authority merely because the
  // network is unavailable at an authoring boundary.
  const ref = `refs/remotes/${remote}/${stateBranch}`;
  return run('git', ['cat-file', '-e', `${ref}:${manifest}`], {
    cwd: root, allowFailure: true
  }).status === 0;
}
