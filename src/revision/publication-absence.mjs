/** Narrow locked no-REV check; no installed-runtime hashing when no REV journal exists. */
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { currentSubjectLockOwner } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readRevisionInteractiveState } from './interactive-state.mjs';
import { hasRevisionLoopJournal } from './loop-store.mjs';

export function revisionPublicationScope(acceptedExecution) {
  const config = acceptedExecution?.definition ?? acceptedExecution?.config ?? null;
  const workflow = acceptedExecution?.workflow ?? null;
  if (!config || !workflow) throw new SingularityFlowError(
    'REV publication requires the already accepted Story execution definition and workflow.', { code: 'REV_PUBLICATION_CONTEXT_REQUIRED' });
  const phaseId = workflow.currentPhase, phase = workflow.phases?.[phaseId];
  return { config, workflow, phaseId, phase, subject: {
    workId: workflow.workItem.id, phaseId, phaseGeneration: Number(phase?.generation ?? 0)
  } };
}

export async function assertNoInteractiveRevisionPublication(root, acceptedExecution) {
  const scope = revisionPublicationScope(acceptedExecution);
  if (!phaseRequiresCodeDelivery(scope.phase)) return true;
  if (!currentSubjectLockOwner(root, { kind: 'story', id: scope.subject.workId })) throw new SingularityFlowError(
    'The no-REV publication check requires the active Story publication lock.', { code: 'REV_PUBLICATION_LOCK_REQUIRED' });
  const state = await readRevisionInteractiveState(root, scope.subject, { optional: true });
  const journalPresent = await hasRevisionLoopJournal(root, scope.subject);
  if (state || journalPresent) {
    // A present/corrupt REV is never treated as absent or a cached permission to publish.
    return (await import('./publication-adapter.mjs')).verifyNoInteractiveRevisionPublication(root, acceptedExecution);
  }
  return true;
}
