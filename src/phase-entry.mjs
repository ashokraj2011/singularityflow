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
  return taskCompletion ? { ...result, taskCompletion } : result;
}
