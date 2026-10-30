/**
 * The subject's branch as lifecycle authority: the production adapter of the lifecycle authority
 * contract (SDA M4, ADR 0018 option A).
 *
 * A wrapper, not a new store. A transition is the publication unit of work, unchanged: the subject
 * lock, the publication journal and its preimage, the commit, the atomic push of branch, ledger entry
 * and pin under exact leases, signing, and the pending record a failed push leaves. An observation is
 * one exact `ls-remote` of the subject's branch, or the same question already asked at command start
 * when the caller allows it. Cancellation is honoured before an operation starts; once a push may
 * have reached the remote, the outcome is the push's, never a false `cancelled`.
 *
 * The unit of work loads on the first transition only, so a command that only observes (recovery,
 * test-recovery admission, promotion) never loads the publication writer.
 *
 * No module but this one calls the unit of work or observes a lifecycle branch on the remote
 * (test/sda-lifecycle-boundary.test.mjs).
 */
import { exactRemoteBranchObservationAsync } from '../git.mjs';
import { configuredRemoteAuthority } from '../git-remote-diagnostics.mjs';
import { takeRemoteBranchObservation } from '../remote-observation-prefetch.mjs';
import { assertNotCancelled } from './shared-state-contract.mjs';
import {
  LIFECYCLE_AUTHORITY_CAPABILITIES, lifecycleAuthorityDescriptor, observationState, selectLifecycleAuthority
} from './lifecycle-authority-contract.mjs';

/**
 * The exact URL to observe. The transport is frozen to one URL, so a configured remote's name is
 * resolved here; given as a name it was read as a URL and every observation came back unreachable.
 */
function observedRemote(root, remote) {
  if (/[:/\\]/u.test(remote)) return remote;
  try { return configuredRemoteAuthority(root, remote, { direction: 'fetch' }).url ?? remote; }
  catch { return remote; }
}

export function createStoryBranchAuthority(root) {
  return Object.freeze({
    descriptor: lifecycleAuthorityDescriptor({
      id: 'subject-branch', qualification: 'production', capabilities: LIFECYCLE_AUTHORITY_CAPABILITIES
    }),

    /** The authority's exact revision of `branch` at `remote` (a remote name or its exact URL). */
    async observe({ branch, remote }, { signal = null, allowPrefetched = false } = {}) {
      assertNotCancelled(signal, 'observation');
      const url = observedRemote(root, remote);
      const observed = (allowPrefetched ? await takeRemoteBranchObservation(root, url, branch) : null)
        ?? await exactRemoteBranchObservationAsync(root, url, branch, { signal });
      const state = observationState(observed);
      return Object.freeze({ ...observed, branch, state, revision: state === 'present' ? observed.sha : null });
    },

    async publish(transition, { signal = null } = {}) {
      assertNotCancelled(signal, 'transition');
      const { GitPublicationUnitOfWork } = await import('../publication-unit-of-work.mjs');
      return new GitPublicationUnitOfWork(root).execute(transition);
    },

    async pending(subject, { signal = null } = {}) {
      assertNotCancelled(signal, 'pending-transition read');
      // The retained record itself: its subject, branch, exact commit and push outcome. Loaded here,
      // since pending-publication recovery itself observes through this adapter.
      const { readPendingPublication } = await import('../publication-pending.mjs');
      return (await readPendingPublication(root, { kind: subject.kind, id: subject.id }))?.record ?? null;
    }
  });
}

/** The lifecycle authority of the repository at `root`: each subject's own branch. */
export function lifecycleAuthority(root) {
  return selectLifecycleAuthority(createStoryBranchAuthority(root));
}
