/**
 * A refactor's behaviour change at its code step [ITW:REQ-015, A13, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * The code step runs the repository's tests before its publication, the same tests its test step runs after it, so a
 * refactor that changes behaviour fails there first, where its author would "fix" it on its own: put the old code back, or
 * change what the test expects. Neither is the author's to choose. At each publication of a refactor's code step, every
 * run of the version being written (the gate's and the agent's own `tests run`) is compared with the run before the change
 * that the start's `task.before` kept (failing-tests-return.mjs refactorAfterCheck). A test that passed before and failed
 * in a run of this version is a behaviour change, and while no person decided it the publication stops
 * (REFACTOR_BEHAVIOUR_CHANGED) with the person's two choices, each the person's own step (`work behaviour`,
 * person-step-catalog.mjs OWN_TERMINAL_STEPS, which the Copilot guard refuses to an agent):
 *   - keep the old behaviour: recorded for this version (`behaviourDecisions`), and the author goes on in the code step to
 *     restore it; a run that still fails is then the author's repair, as any failing test;
 *   - accept the new behaviour: the code step goes back to the plan, the task becomes a change and the plan's next version
 *     starts, settled with an undo (task-amendment.mjs acceptBehaviourAtCode); the code waits in its open version.
 * The stop holds when a later run of the version passes again: once SFlow saw this version change behaviour, only the
 * person's choice lets it through. Loaded by the code step's test gate (state.mjs); the person's `work behaviour` is
 * refactor-behaviour-decide.mjs, kept apart so the gate (bundled into VS Code) never reaches the task-change code.
 */
import { SingularityFlowError } from './util.mjs';

export const BEHAVIOUR_CHOICES = Object.freeze(['keep', 'accept']);
export const BEHAVIOUR_CHANGED = 'REFACTOR_BEHAVIOUR_CHANGED';
export const named = (list, limit = 4) => `${list.slice(0, limit).join(', ')}${list.length > limit ? ` and ${list.length - limit} more` : ''}`;
export const stepName = (phase) => phase?.label ?? phase?.id ?? 'the step';

/** The person's two commands at a refactor's behaviour change, each complete. Pure. */
export function behaviourCommands(workId) {
  return { keep: `singularity-flow work behaviour keep --work-id ${workId}`, accept: `singularity-flow work behaviour accept --work-id ${workId}` };
}

/** The person's decisions recorded for version `generation` of `phase`, oldest first. Pure. */
export function behaviourDecisionsOf(workflow, phase, generation) {
  return (workflow?.behaviourDecisions ?? []).filter((entry) => entry?.phase === phase?.id && Number(entry.generation) === Number(generation));
}

/** Whether `phase` is a refactor's code step being written now. Pure. */
async function writtenRefactorCode(workflow, phase) {
  if (workflow?.resolution?.composition?.kind !== 'refactor' || workflow.currentPhase !== phase?.id || phase.status !== 'in_progress') return false;
  return (await import('./code-delivery-policy.mjs')).phaseRequiresCodeDelivery(phase);
}

/**
 * What the version of `phase` being written changed that a person did not decide [ITW:REQ-015]: each test command's latest
 * failed run of this version against its run before the change. `{ generation, changed, undecided, kept }`, where `changed`
 * is afterCheckOf's list and `undecided` the checks (by name) no person decided; null when the Story is not a refactor,
 * `phase` is not its code step being written, or no run of this version failed.
 */
export async function versionBehaviourChange(root, config, workflow, phase) {
  if (!config || !await writtenRefactorCode(workflow, phase)) return null;
  const [{ stepAttempts }, { workDirRelative }, rules] = await Promise.all([import('./verification/attempts.mjs'), import('./story-paths.mjs'),
    import('./failing-tests-return.mjs')]);
  const attempts = await stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id).catch(() => []);
  // The version being written is the newest one runs were kept for beyond the published one.
  const unpublished = attempts.filter((entry) => Number(entry?.generation) > Number(phase.generation ?? 0));
  if (!unpublished.length) return null;
  const generation = Math.max(...unpublished.map((entry) => Number(entry.generation)));
  const ofVersion = (entry) => Number(entry?.generation) === generation && entry.status === 'failed';
  const ids = [...new Set(attempts.filter(ofVersion).map((entry) => entry.commandId))];
  if (!ids.length) return null;
  const check = await rules.refactorAfterCheck(root, config, workflow, phase, ids.map((id) => ({ id })),
    { pick: (runs) => runs.filter(ofVersion).at(-1) });
  if (!check?.changed.length) return null;
  const names = rules.checkNames(check.changed);
  const kept = new Set(behaviourDecisionsOf(workflow, phase, generation).filter((entry) => entry.choice === 'keep').flatMap((entry) => entry.checks ?? []));
  return { generation, changed: check.changed, names, undecided: names.filter((name) => !kept.has(name)), kept: names.filter((name) => kept.has(name)) };
}

/**
 * The code step's publication while its version changed behaviour no person decided: REFACTOR_BEHAVIOUR_CHANGED, naming
 * the change and the person's two complete commands; with every change kept by the person, `refusal` (the run's own
 * failure, now the author's repair) says so. Null when nothing stops it here.
 */
export async function codeStepBehaviourHold(root, config, workflow, phase, { refusal = null } = {}) {
  const found = await versionBehaviourChange(root, config, workflow, phase).catch(() => null);
  if (!found) return refusal;
  const id = workflow.workItem.id;
  if (!found.undecided.length) {
    if (refusal) refusal.message = `${refusal.message} The person kept the old behaviour of ${named(found.kept)}: restore it in this version, so it passes as before the change.`;
    return refusal;
  }
  const { keep, accept } = behaviourCommands(id);
  const changed = named(found.undecided);
  const choices = [
    { id: 'keep-behaviour', label: `Keep the old behaviour: ${stepName(phase)} goes on and restores it`, command: keep },
    { id: 'accept-behaviour', label: 'Accept the new behaviour: the task becomes a change', command: accept }];
  return new SingularityFlowError(`The refactor changed behaviour: ${changed} passed before the change and ${found.undecided.length === 1 ? 'fails' : 'fail'} now. `
    + `Change nothing for it: the person runs ${keep} to keep it, or ${accept} to take the new one.`, {
    code: BEHAVIOUR_CHANGED,
    details: { workId: id, phase: phase.id, generation: found.generation, changed: found.changed, checks: found.undecided, choices,
      nextAction: { command: keep, label: choices[0].label }, recoveryCommands: [{ command: accept, label: choices[1].label }] }
  });
}
