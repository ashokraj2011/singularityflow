/** Binding-first entry. Refused/paused reads never import the authoring/recovery graph. */
import { phaseEntryContext } from './phase-entry-context.mjs';
import { recoveryActionGuidance } from './recovery-action-guidance.mjs';
import { phaseContextAdmission } from './phase-entry-admission.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
export { phaseEntryContext };

/** One model-free entry packet; no tests, begin, prepare, commit, push or lifecycle decisions. */
export async function enterPhase({ cwd = process.cwd(), phaseId = null, workId = null,
  compose = false, modelEnabled = true } = {}) {
  const entry = await measureCommandSpan('phase-entry.binding', () => phaseEntryContext({ cwd, phaseId, workId }));
  if (entry.packet.paused) return entry.packet;
  const base = { ...entry.packet,
    effects: { contextCompositionRequested: compose, testsRun: false, storyAdvanced: false,
      committed: false, pushed: false }, modelInvocations: 0 };
  if (!base.ready) return { ...base, status: 'binding-required', context: null,
    contextAdmission: phaseContextAdmission({ ready: false }),
    next: [recoveryActionGuidance(entry.session.phaseAgent?.handoff ?? {
      id: 'select-story', safe: true, automatic: false, confirmation: 'none', skill: '/sf-session',
      command: `singularity-flow session attach ${entry.workflow.workItem.id} --json`,
      detail: 'This session has not selected a Story; attach the one this checkout holds.'
    })], authoringAllowed: false };
  const { completePhaseEntry } = await measureCommandSpan('phase-entry.authoring-load', () => import('./phase-entry-authoring.mjs'));
  const result = await completePhaseEntry(entry, base, { compose, modelEnabled });
  const taskCompletion = (await import('./phase-authoring-progress.mjs')).phaseTaskCompletion(result);
  const { resumeWorkflowTask } = await import('./workflow-task-store.mjs');
  const taskResume = await resumeWorkflowTask(entry.root, entry.workflow, entry.phase, {
    generation: taskCompletion?.generation ?? (result.authoring?.entry?.status === 'retained-generation' ? entry.phase.generation : base.inspectionGeneration),
    progress: taskCompletion,
    published: result.authoring?.entry?.status === 'retained-generation',
    blocked: taskCompletion?.state === 'blocked' ? { code: result.documentReadiness?.status === 'ready'
      ? 'PHASE_ENTRY_NOT_ADMITTED' : result.documentReadiness ? 'DOCUMENT_REUPLOAD_REQUIRED' : 'PHASE_ENTRY_NOT_ADMITTED',
    nextAction: taskCompletion.nextAction } : null
  });
  return { ...result, taskResume, ...(taskCompletion && taskResume ? { taskCompletion: { ...taskCompletion,
    operationId: taskResume.operationId, continuationBudget: taskResume.continuationBudget,
    ...(taskResume.state === 'inspect-interrupted-operation' ? { state: 'blocked', nextAction: taskResume.nextAction,
      instruction: 'Inspect the interrupted operation before any replay. Preserve its draft and original recovery route.' } : {}) } } : {}) };
}
