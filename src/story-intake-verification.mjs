/**
 * Story start admission for an intake receipt: verify what the readiness preview saw. `[perf]`
 *
 * Without a receipt a start learns its inputs one at a time: approved authority, then the remote it
 * names, then the base and destination, then publication permission, and it fetches the base again.
 * A receipt already names every one of them, so start can observe all of them at once and, where
 * nothing moved, use what the preview left behind. Nothing here is trusted from the receipt alone:
 *
 * - locally, the receipt must be this repository's, this checkout's, this build's and this exact
 *   request's; the base it names must already be the fetched tracking ref, fully present, in a
 *   complete (not shallow) repository; and the Story name must still be free;
 * - then one concurrent wave: approved authority and the application remote are each observed once
 *   (once in total when they are the same URL), publication permission is dry-run afresh, and each
 *   reference repository's branch is resolved to the commit the start will pin.
 *
 * Every mismatch returns a reason and start takes its full path. A moved state tip is the one
 * difference repaired here, with a fetch of that ref alone. Readiness is always recomputed by start.
 */
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { CONFIGURATION_BRANCH, STATE_CONFIGURATION_BRANCH } from './configuration-branch.mjs';
import { GitRemoteSession, runRemoteGitAsync } from './git-execution.mjs';
import { configuredRemoteAuthority, frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { gitCommonDir, refExists, refHead } from './git.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';
import { processResultSucceeded } from './process-result.mjs';
import { resolveReferenceRepositoryPins } from './reference-repositories.mjs';
import { claimStoryIntakeReceipt } from './story-intake-receipt.mjs';
import { run } from './util.mjs';

/** How long the wave's authority observation stands in for start's own pre-mutation check. */
export const STORY_INTAKE_AUTHORITY_REUSE_MS = 30_000;

/** Process-private proof that the wave ran. Never serialized; a forged object is not one of these. */
const PROOFS = new WeakSet();

export function isStoryIntakeProof(value) {
  return Boolean(value && typeof value === 'object' && PROOFS.has(value));
}

function objectPresent(root, commit) {
  const result = run('git', ['cat-file', '-e', `${commit}^{commit}`], {
    cwd: root, allowFailure: true, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  });
  return result.status === 0;
}

function completeRepository(root) {
  const result = run('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, allowFailure: true });
  return result.status === 0 && result.stdout.trim() === 'false';
}

/**
 * Claim the receipt and check everything that needs no network. On success the caller owns the
 * claim and must `consume()` it once a durable Story commit exists, or `release()` it.
 */
export async function admitStoryIntakeReceipt(root, id, { inputs, workId, remote, baseBranch, now = Date.now() }) {
  const claimed = await claimStoryIntakeReceipt(root, id, { inputs, now });
  if (claimed.status !== 'claimed') return claimed;
  const refuse = async (reason) => {
    await claimed.release();
    return { status: 'rejected', reason };
  };
  const { receipt } = claimed;
  if (receipt.repositories.length !== 1) return refuse('capability');
  const [repository] = receipt.repositories;
  if (repository.remote !== remote || repository.baseBranch !== baseBranch
      || repository.destinationRef !== `refs/heads/${workId}`
      || receipt.authority.branch !== CONFIGURATION_BRANCH) return refuse('inputs');
  if (refExists(root, `refs/heads/${workId}`) || refExists(root, `refs/remotes/${remote}/${workId}`)) {
    return refuse('story-exists');
  }
  const fetch = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
  const push = configuredRemoteAuthority(root, remote, { direction: 'push' });
  if (fetch.url !== repository.fetch.url || fetch.fingerprint !== repository.fetch.fingerprint
      || (repository.push && (push.url !== repository.push.url
        || push.fingerprint !== repository.push.fingerprint))) return refuse('remote');
  const baseRef = `refs/remotes/${remote}/${baseBranch}`;
  if (refHead(root, baseRef) !== repository.baseCommit || !objectPresent(root, repository.baseCommit)
      || !completeRepository(root)) return refuse('base-not-local');
  return {
    status: 'admitted',
    receipt,
    repository,
    consume: claimed.consume,
    release: claimed.release
  };
}

/**
 * Observe every governed input the receipt names, all at once, and compare. Returns the proof the
 * start stages reuse, or the reason to take the full path. The admission's claim is not settled here.
 */
export async function verifyStoryIntakeWave(root, admission, {
  workId, references = [], session = new GitRemoteSession({ cwd: root }), runGit = runRemoteGitAsync,
  now = () => Date.now()
}) {
  const { receipt, repository } = admission;
  const storyRef = `refs/heads/${workId}`;
  const baseRef = `refs/heads/${repository.baseBranch}`;
  const stateRef = repository.state ? `refs/heads/${repository.state.branch}` : null;
  const authorityRefs = [`refs/heads/${CONFIGURATION_BRANCH}`, `refs/heads/${STATE_CONFIGURATION_BRANCH}`];
  const applicationRefs = [storyRef, baseRef, ...(stateRef ? [stateRef] : [])];
  const shared = receipt.authority.remote === repository.fetch.url;
  const startedAt = now();
  const dryRun = repository.push
    ? (() => {
      const transport = frozenRemoteTransport(repository.push.url, { push: true });
      return runGit([
        'push', '--dry-run', '--porcelain', transport.remote,
        `refs/remotes/${repository.remote}/${repository.baseBranch}:${repository.destinationRef}`
      ], { cwd: root, operation: 'remote-push', allowFailure: true, env: transport.env });
    })()
    : Promise.resolve(null);
  let application;
  let authority;
  let pushed;
  let referencePins;
  try {
    [application, authority, pushed, referencePins] = await Promise.all([
      session.observeAsync(repository.fetch.url, {
        includeHead: true, refs: shared ? [...authorityRefs, ...applicationRefs] : applicationRefs, refresh: true
      }),
      shared ? null : session.observeAsync(receipt.authority.remote, {
        includeHead: false, refs: authorityRefs, refresh: true
      }),
      dryRun,
      // A branch that is gone or unreachable fails the wave; the ordinary start then refuses it
      // with its own exact message.
      references.length ? resolveReferenceRepositoryPins(references, { localNamespace: workId }) : []
    ]);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  authority ??= application;
  incrementCommandCounter('story.intake-receipt-wave');
  if (!application?.ok || !authority?.ok) return { ok: false, reason: 'unreachable' };
  if (authority.refs.get(authorityRefs[0]) !== receipt.authority.commit) {
    return { ok: false, reason: 'configuration-moved' };
  }
  if (application.refs.get(baseRef) !== repository.baseCommit) return { ok: false, reason: 'base-moved' };
  if (application.refs.has(storyRef)) return { ok: false, reason: 'story-exists' };
  if (pushed && !processResultSucceeded(pushed)) return { ok: false, reason: 'publication-refused' };

  // The state ledger moves whenever anything is published. Bring just that ref up to date.
  let stateCommit = null;
  if (stateRef) {
    stateCommit = application.refs.get(stateRef) ?? null;
    const trackingRef = `refs/remotes/${repository.remote}/${repository.state.branch}`;
    if (stateCommit && refHead(root, trackingRef) !== stateCommit) {
      const transport = frozenRemoteTransport(repository.fetch.url);
      const fetched = await runGit([
        'fetch', transport.remote, `+${stateRef}:${trackingRef}`
      ], { cwd: root, operation: 'remote-configuration', allowFailure: true, env: transport.env });
      incrementCommandCounter('story.intake-receipt-state-fetch');
      if (!processResultSucceeded(fetched) || refHead(root, trackingRef) !== stateCommit) {
        return { ok: false, reason: 'state-moved' };
      }
    } else if (!stateCommit && refHead(root, trackingRef) !== null) {
      return { ok: false, reason: 'state-moved' };
    }
  }
  const proof = Object.freeze({
    receiptId: receipt.id,
    session,
    observedAt: startedAt,
    sourceCommonDir: await realpath(gitCommonDir(root)),
    remote: repository.remote,
    baseBranch: repository.baseBranch,
    baseCommit: repository.baseCommit,
    stateBranch: repository.state?.branch ?? null,
    stateCommit,
    fetch: Object.freeze({ ...repository.fetch }),
    referencePins: Object.freeze(referencePins.map((pin) => Object.freeze({ ...pin }))),
    application: Object.freeze({ url: repository.fetch.url, observation: application }),
    authority: Object.freeze({ remote: receipt.authority.remote, commit: receipt.authority.commit }),
    dryRun: repository.push ? Object.freeze({
      pushUrl: repository.push.url,
      pushFingerprint: repository.push.fingerprint,
      destinationRef: repository.destinationRef,
      baseCommit: repository.baseCommit
    }) : null,
    nonce: randomBytes(8).toString('hex')
  });
  PROOFS.add(proof);
  return { ok: true, proof };
}
