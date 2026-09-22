/**
 * Product bridge from the guarded interactive REV pointer to the Story publication transaction.
 *
 * This module deliberately does not accept a caller-supplied Candidate, receipt, loop, phase, or
 * generation. Every authority-bearing value is reconstructed from the active Story's private
 * pointer, append-only journal, content-addressed precheck input, and retained Candidate store.
 */
import { recordSha256 } from '../records.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { head } from '../git.mjs';
import { loadStoryAggregate } from '../state-stores.mjs';
import { currentSubjectLockOwner } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosRevisionCandidateReference, verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';
import {
  readRevisionInteractivePayload, readRevisionInteractiveState
} from './interactive-state.mjs';
import {
  loadActiveRevisionStory, readPinnedRevisionContext, revisionLoopStore
} from './product-context.mjs';
import { assertCurrentRevisionPrecheck } from './precheck.mjs';

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function digest(value) { return `sha256:${recordSha256(value)}`; }

function sameSubject(left, right) {
  return left?.workId === right?.workId
    && left?.phaseId === right?.phaseId
    && left?.phaseGeneration === right?.phaseGeneration;
}

function publicationScope(acceptedExecution) {
  const config = acceptedExecution?.definition ?? acceptedExecution?.config ?? null;
  const workflow = acceptedExecution?.workflow ?? null;
  if (!config || !workflow) {
    fail('REV_PUBLICATION_CONTEXT_REQUIRED',
      'REV publication requires the already accepted Story execution definition and workflow.');
  }
  const phaseId = workflow.currentPhase;
  const phase = workflow.phases?.[phaseId];
  const subject = {
    workId: workflow.workItem.id, phaseId, phaseGeneration: Number(phase?.generation ?? 0)
  };
  return { config, workflow, phaseId, phase, subject };
}

/**
 * Repeat an earlier "no REV" observation while the Story publication lease is held. Interactive
 * pointer writes and loop-journal CAS now share that lease, so absence remains stable through ref
 * advancement instead of becoming a stale, pre-lock permission to bypass a newly opened loop.
 */
export async function assertNoInteractiveRevisionPublication(root, acceptedExecution) {
  const scope = publicationScope(acceptedExecution);
  if (!phaseRequiresCodeDelivery(scope.phase)) return true;
  if (!currentSubjectLockOwner(root, { kind: 'story', id: scope.subject.workId })) {
    fail('REV_PUBLICATION_LOCK_REQUIRED',
      'The no-REV publication check requires the active Story publication lock.');
  }
  const state = await readRevisionInteractiveState(root, scope.subject, { optional: true });
  const journal = await revisionLoopStore({ root, ...scope }).list();
  if (state || journal.length) {
    fail('REV_PUBLICATION_HEAD_UNAVAILABLE',
      'REV state appeared after publication preflight. Recover or publish the exact selected REV head.');
  }
  return true;
}

/**
 * Return null only when this active Code generation has never opened a REV loop. Once either the
 * pointer or journal exists, missing, stale, in-flight, abandoned, or uncertain state is a hard
 * refusal: ordinary publication must not silently bypass a partially established REV selection.
 */
export async function currentInteractiveRevisionPublication(root, acceptedExecution) {
  const { config, workflow, phaseId, phase, subject } = publicationScope(acceptedExecution);
  if (!phaseRequiresCodeDelivery(phase)) return null;
  const provisional = { root, config, workflow, phaseId, phase, subject };
  const state = await readRevisionInteractiveState(root, subject, { optional: true });
  const loopStore = revisionLoopStore(provisional);
  const journal = await loopStore.list();
  const loop = journal.length ? await loopStore.read() : null;
  if (!state && !loop) return null;
  const active = await loadActiveRevisionStory(root, {
    definition: config, workflow, workId: workflow.workItem.id
  });
  if (!state || !loop) {
    fail('REV_PUBLICATION_HEAD_UNAVAILABLE',
      'REV publication found an incomplete private pointer/journal pair. Recover the exact loop before phase publication.');
  }
  if (state.status === 'recovery-required'
      || ['opening', 'capturing', 'candidate-frozen', 'abandoning'].includes(state.status)) {
    fail('REV_RECOVERY_REQUIRED',
      'REV publication is blocked while the selected loop has incomplete or uncertain recovery state. Run revision resume/status first.');
  }
  if (state.status !== 'prechecked' || loop.status !== 'open') {
    fail('REV_PUBLICATION_NOT_READY',
      'REV publication requires one explicitly captured, current, prechecked selected head.');
  }
  const latest = journal.at(-1);
  const interval = latest?.transition?.interval;
  const precheckReceipt = latest?.transition?.precheck;
  if (!sameSubject(state.subject, active.subject)
      || !sameSubject(loopStore.scope, active.subject)
      || latest?.transition?.type !== 'commit-interval'
      || latest.revision !== loop.revision
      || latest.entrySha256 !== loop.entrySha256
      || state.loopId !== loop.loopId
      || state.loopRevision !== loop.revision
      || state.resultCandidateId !== loop.head?.candidateId
      || state.resultCandidateId !== interval?.resultCandidate?.candidateId
      || state.precheckSha256 !== precheckReceipt?.precheckSha256
      || loop.precheckSha256 !== precheckReceipt?.precheckSha256
      || !state.precheckInputSha256
      || precheckReceipt?.precheckInputsSha256 !== state.precheckInputSha256) {
    fail('REV_PUBLICATION_HEAD_UNAVAILABLE',
      'The interactive pointer, selected loop head, interval, and precheck do not form one exact current publication chain.');
  }
  if (precheckReceipt.precheckPassed !== true
      || precheckReceipt.publicationEligible !== true
      || precheckReceipt.remainingObligations?.length) {
    fail('REV_PUBLICATION_NOT_READY',
      'The exact current selected REV head still has deterministic publication obligations.');
  }
  const candidateReference = await sgosRevisionCandidateReference(root, state.resultCandidateId);
  if (await verifySgosRevisionCandidateReference(root, candidateReference, {
    subjectId: `${active.subject.workId}:${active.subject.phaseId}`
  }) !== true
      || digest(candidateReference) !== loop.head.candidateRefSha256
      || candidateReference.candidateSha256 !== loop.head.candidateSha256
      || candidateReference.repository.candidateTree !== loop.head.candidateTree) {
    fail('REV_PUBLICATION_CANDIDATE_STALE',
      'The selected REV head is not the exact retained Candidate for this Story phase.');
  }
  const assertPointerCurrent = async () => {
    const current = await readRevisionInteractiveState(root, active.subject, { optional: true });
    if (!current || current.stateSha256 !== state.stateSha256
        || current.status !== 'prechecked' || current.recoveryCode !== null) {
      fail('REV_PUBLICATION_HEAD_UNAVAILABLE',
        'The explicit REV selection pointer changed before phase publication.');
    }
  };
  let preTransactionContextRead = false;
  const readCurrentContext = async () => {
    await assertPointerCurrent();
    if (!preTransactionContextRead) {
      const current = await loadActiveRevisionStory(root, {
        definition: config, workId: active.subject.workId
      });
      if (!sameSubject(current.subject, active.subject)) {
        fail('REV_PUBLICATION_CONTEXT_STALE',
          'The active Story phase or generation changed before REV publication preflight.');
      }
      const pinned = await readPinnedRevisionContext(current, loop.context);
      preTransactionContextRead = true;
      return pinned;
    }
    // The second read runs after the transaction has legitimately advanced generation metadata.
    // The Story lock makes that aggregate write transaction-owned, so do not reinterpret its new
    // workflow hash or generation as external drift. Recheck the independently mutable authority
    // that remains outside the aggregate, while prospective-tree admission below proves every
    // application byte against the retained Candidate.
    const currentWorkflow = await loadStoryAggregate(root, config, active.subject.workId);
    const currentPhase = currentWorkflow.phases?.[currentWorkflow.currentPhase];
    if (Number(currentPhase?.generation) === active.subject.phaseGeneration) {
      return readPinnedRevisionContext(await loadActiveRevisionStory(root, {
        definition: config, workId: active.subject.workId
      }), loop.context);
    }
    if (head(root) !== loop.context.headCommit
        || digest(config) !== loop.context.configSha256
        || currentWorkflow.workItem?.id !== active.subject.workId
        || currentWorkflow.currentPhase !== active.subject.phaseId
        || !phaseRequiresCodeDelivery(currentPhase)
        || Number(currentPhase.generation) !== active.subject.phaseGeneration + 1) {
      fail('REV_PUBLICATION_CONTEXT_STALE',
        'Repository, configuration, or Story phase authority changed during REV publication.');
    }
    return Object.freeze(structuredClone(loop.context));
  };
  const readCurrentPrecheckInput = async () => {
    await assertPointerCurrent();
    const input = await readRevisionInteractivePayload(
      root, active.subject, state.precheckInputSha256);
    assertCurrentRevisionPrecheck(precheckReceipt, input);
    return input;
  };
  // Check the complete immutable and live chain now for early, actionable refusal. The publication
  // unit repeats both readers under the Story lock and validates the admitted prospective tree.
  await readCurrentContext();
  await readCurrentPrecheckInput();
  return Object.freeze({
    loopStore, candidateReference, precheckReceipt,
    readCurrentContext, readCurrentPrecheckInput
  });
}
