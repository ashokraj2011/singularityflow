/** Binding-first entry. Refused/paused reads never import the authoring/recovery graph. */
import { phaseEntryContext } from './phase-entry-context.mjs';
import { recoveryActionGuidance } from './recovery-action-guidance.mjs';
import { phaseContextAdmission } from './phase-entry-admission.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
export { phaseEntryContext };

/** One model-free entry packet; no tests, begin, prepare, commit, push or lifecycle decisions. */
export async function enterPhase({ cwd = process.cwd(), phaseId = null, workId = null,
  compose = false, modelEnabled = true } = {}) {
  let entry;
  try { entry = await measureCommandSpan('phase-entry.binding', () => phaseEntryContext({ cwd, phaseId, workId })); }
  catch (error) {
    // `/sf-code implement <change>` after Implement finished: the named step is not the current one, and the change goes
    // back to it on the person's yes (completed-step-change.mjs, daily run 2026-11-22). Any other step stays refused.
    if (error?.code !== 'PHASE_DRAFT_NOT_ACTIVE' || !phaseId) throw error;
    const current = await phaseEntryContext({ cwd, workId }).catch(() => null);
    const asked = current && !current.packet.paused ? await completedStepChange(current, phaseId) : null;
    if (asked) return asked;
    throw error;
  }
  if (entry.packet.paused) return entry.packet;
  // `/sf-code <change>` while the Story is on a later step that writes no code: the change goes back to the code step that
  // finished, asked first; before, this entered the later step and the person's words were dropped (daily run 2026-11-22).
  if (entry.packet.ready && !phaseId) {
    const asked = await completedStepChange(entry, null);
    if (asked) return asked;
  }
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
  // A published generation, also while the person is asked to start its next one.
  const published = ['retained-generation', 'successor-confirmation-required'].includes(result.authoring?.entry?.status);
  // A document missing here is the task's wait for that input, as every view names it [§8, CVL-REQ-004].
  const missing = taskCompletion?.state === 'blocked' && result.documentReadiness && result.documentReadiness.status !== 'ready'
    ? (await import('./workflow-task-outcome.mjs')).outcomeCode('waiting-input', 'DOCUMENT_REUPLOAD_REQUIRED', entry.workflow, result.documentReadiness.missing?.[0]?.id) : null;
  const taskResume = await resumeWorkflowTask(entry.root, entry.workflow, entry.phase, {
    generation: taskCompletion?.generation ?? (published ? entry.phase.generation : base.inspectionGeneration),
    progress: taskCompletion,
    published, inputsReady: result.documentReadiness?.status === 'ready',
    blocked: taskCompletion?.state === 'blocked' ? { code: missing ?? 'PHASE_ENTRY_NOT_ADMITTED', nextAction: taskCompletion.nextAction } : null
  });
  return { ...result, taskResume, ...(taskCompletion && taskResume ? { taskCompletion: { ...taskCompletion,
    operationId: taskResume.operationId, continuationBudget: taskResume.continuationBudget,
    ...(taskResume.state === 'inspect-interrupted-operation' ? { state: 'blocked', nextAction: taskResume.nextAction,
      instruction: 'Inspect the interrupted operation before any replay. Preserve its draft and original recovery route.' } : {}) } } : {}) };
}

/**
 * The entry for a change the person asked for in a code step that already finished: ask them "Start version 2 of Implement for this
 * change?" (completed-step-change.mjs), its preview the route, and nothing else; null when no such change
 * waits. `named`: the step typed after the work command, or null for the nearest finished code step.
 */
async function completedStepChange(entry, named) {
  const [{ completedCodeStepForChange, completedChangeQuestion, stepName }, { waitingWords }, { gitDir }, { versionPreviewRoute }, { versionProposal }] = await Promise.all([
    import('./completed-step-change.mjs'), import('./asked-for.mjs'), import('./git.mjs'), import('./action-command-map.mjs'), import('./story-version-proposal.mjs')]);
  const code = completedCodeStepForChange(entry.workflow, { named });
  if (!code) return null;
  const requests = await waitingWords(gitDir(entry.root), entry.workflow, code).catch(() => []);
  if (!requests.length) return null;
  const version = versionProposal(entry.workflow, code, { reason: 'requested-change' }).proposal.version;
  const question = completedChangeQuestion(entry.workflow, code, version);
  const current = entry.workflow.phases[entry.workflow.currentPhase];
  const route = versionPreviewRoute(entry.workflow, code);
  const preview = { id: `go-back:${code.id}`, safe: true, automatic: false, confirmation: 'person-yes', ...route, copilotCommand: `${route.skill} ${code.id}`,
    detail: `Preview going back to ${stepName(code)} for the change the person asked for; on their yes, run the confirmation it returns.` };
  return { ...entry.packet, phase: code.id, currentPhase: current.id, status: 'completed-step-change', generatesCode: true,
    effects: { contextCompositionRequested: false, testsRun: false, storyAdvanced: false, committed: false, pushed: false }, modelInvocations: 0,
    authoringAllowed: false, context: null, contextComposition: 'not-requested',
    successor: { targetGeneration: version, question, choices: ['Yes', 'No'], requests, preview, returnsFrom: current.id, automatic: false },
    next: [preview] };
}
