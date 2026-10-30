/**
 * A deterministic in-memory lifecycle authority for the lifecycle conformance suite (SDA M4).
 *
 * Test-only by qualification, and by place: it lives under test/, which no installed build carries,
 * and selectLifecycleAuthority refuses it. It follows the subject branch's rules so one suite holds
 * both to one behaviour: a transition names the revision it extends, lands only while the authority
 * still holds it, and a transition whose response was lost is retained and holds the subject's next
 * transition until it is recovered.
 */
import { createHash } from 'node:crypto';
import { SingularityFlowError } from '../../src/util.mjs';
import { assertNotCancelled } from '../../src/sda/shared-state-contract.mjs';
import {
  LIFECYCLE_AUTHORITY_CAPABILITIES, lifecycleAuthorityDescriptor
} from '../../src/sda/lifecycle-authority-contract.mjs';

export function createMemoryLifecycleAuthority() {
  const tips = new Map();
  const retained = new Map();
  let counter = 0;
  let loseNext = false;
  const revisionOf = (branch, parent, payload) => createHash('sha1')
    .update(JSON.stringify([branch, parent, payload, ++counter])).digest('hex');
  const subjectKey = (subject) => `${subject.kind}:${subject.id}`;

  return {
    descriptor: lifecycleAuthorityDescriptor({
      id: 'memory-lifecycle', qualification: 'test-only', capabilities: LIFECYCLE_AUTHORITY_CAPABILITIES
    }),

    async observe({ branch }, { signal = null } = {}) {
      assertNotCancelled(signal, 'observation');
      const sha = tips.get(branch) ?? null;
      return Object.freeze({ reachable: true, malformed: false, sha, branch,
        state: sha ? 'present' : 'absent', revision: sha });
    },

    async publish(transition, { signal = null } = {}) {
      assertNotCancelled(signal, 'transition');
      const { subject, publication } = transition;
      if (publication.expectedRemoteSha === undefined && !publication.unleased) {
        throw new SingularityFlowError('The transition names no expected revision.', { code: 'PUSH_EXPECTED_REVISION_REQUIRED' });
      }
      if (retained.has(subjectKey(subject))) {
        throw new SingularityFlowError('The subject has a pending publication.', { code: 'PUBLICATION_PENDING' });
      }
      const current = tips.get(publication.branch) ?? null;
      if (publication.expectedRemoteSha !== undefined && publication.expectedRemoteSha !== current) {
        throw new SingularityFlowError('The authority no longer holds the revision this transition extends.', {
          code: 'PUBLICATION_REMOTE_LEASE_PARENT_MISMATCH'
        });
      }
      const sha = revisionOf(publication.branch, current, transition.event?.payload ?? null);
      tips.set(publication.branch, sha);
      if (loseNext) {
        loseNext = false;
        retained.set(subjectKey(subject), { subject, branch: publication.branch, commit: sha, pushOutcome: 'transport-indeterminate' });
        const lost = new SingularityFlowError('The transition reached the authority, but its response was lost.', {
          outcomeClass: 'OUTCOME_UNKNOWN'
        });
        lost.publicationRefAdvanced = true;
        lost.publicationCommit = sha;
        lost.pushOutcome = 'transport-indeterminate';
        throw lost;
      }
      return { sha, pushed: true, replayed: false, event: transition.event };
    },

    async pending(subject, { signal = null } = {}) {
      assertNotCancelled(signal, 'pending-transition read');
      return retained.get(subjectKey(subject)) ?? null;
    },

    /** Another writer advances `branch` past what this one observed. */
    moveAuthority(branch) {
      const sha = revisionOf(branch, tips.get(branch) ?? null, 'another writer');
      tips.set(branch, sha);
      return sha;
    },

    loseNextResponse() { loseNext = true; }
  };
}
