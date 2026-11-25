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
 * person's choice lets it through. Loaded by the code step's test gate (state.mjs) and by `work behaviour` only.
 */
import { nowIso, SingularityFlowError } from './util.mjs';

export const BEHAVIOUR_CHOICES = Object.freeze(['keep', 'accept']);
export const BEHAVIOUR_CHANGED = 'REFACTOR_BEHAVIOUR_CHANGED';
const named = (list, limit = 4) => `${list.slice(0, limit).join(', ')}${list.length > limit ? ` and ${list.length - limit} more` : ''}`;
const stepName = (phase) => phase?.label ?? phase?.id ?? 'the step';

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

function refused(code, message, nextAction) {
  return new SingularityFlowError(message, { code, details: { nextAction } });
}

/**
 * `work behaviour keep|accept` [ITW:REQ-015]: the person's choice at a refactor's behaviour change in its code step. Keep
 * records it for the version being written (`behaviourDecisions`, a DECISION_MADE commit) and the author goes on; accept
 * returns the code step to the plan and the task becomes a change (task-amendment.mjs acceptBehaviourAtCode). The step's
 * approvers decide it, as they would return it. Refused, with where the task stands, when nothing waits for it.
 */
export async function decideBehaviour(root, choice, { workId = null } = {}) {
  const [{ loadAcceptedStoryExecution }, { identity }] = await Promise.all([import('./accepted-story-execution.mjs'), import('./git.mjs')]);
  let { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const id = workflow.workItem.id;
  const status = { command: `singularity-flow work status ${id}`, label: `See where ${id} stands.` };
  if (!BEHAVIOUR_CHOICES.includes(choice)) {
    throw refused('TASK_BEHAVIOUR_CHOICE_UNKNOWN', `Say keep or accept: singularity-flow work behaviour keep --work-id ${id} keeps the old behaviour, accept takes the new one.`,
      { command: behaviourCommands(id).keep, label: 'Keep the old behaviour.' });
  }
  const phase = workflow.phases?.[workflow.currentPhase];
  const found = phase ? await versionBehaviourChange(root, config, workflow, phase) : null;
  if (!found?.undecided.length) {
    throw refused('TASK_BEHAVIOUR_NOTHING_TO_DECIDE', `${id} has no behaviour change waiting for a person: ${workflow.resolution?.composition?.kind === 'refactor'
      ? `no run of ${stepName(phase)}'s version being written changed what passed before the change, or it is decided` : `it is not a refactor (${workflow.resolution?.composition?.kind ?? 'not a task'})`}.`, status);
  }
  const actor = identity(root);
  const [{ requireApprovalAuthority }, { actorKey }] = await Promise.all([import('./approval-authority.mjs'), import('./state-stores.mjs')]);
  // The step's approvers decide it, as they would return it.
  const authority = requireApprovalAuthority(workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const checks = found.undecided;
  if (choice === 'accept') {
    const accepted = await (await import('./task-amendment.mjs')).acceptBehaviourAtCode(root, workflow.workItem.id, phase.id, { checks, actor });
    ({ workflow } = await loadAcceptedStoryExecution(root, id));
    return behaviourResult(workflow, { choice, checks, words: accepted.line, changeId: accepted.changeId, changeRequest: accepted.changeRequest });
  }
  const [{ LIFECYCLE_EVENT }, { transactStory }] = await Promise.all([import('./lifecycle-event.mjs'), import('./state-stores.mjs')]);
  const by = actorKey(actor);
  const { value: record } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: phase.id, generation: found.generation, actor, agent: null,
    authorityGroup: authority.authorityGroup, payload: { decision: 'refactor-behaviour', choice }
  }, `[${id}][phase:${phase.id}][behaviour] keep the old behaviour`, async (aggregate) => {
    aggregate.behaviourDecisions ??= [];
    const entry = { id: `BHV-${String(aggregate.behaviourDecisions.length + 1).padStart(3, '0')}`, phase: phase.id, generation: found.generation, choice,
      checks, actor: by, authorityGroup: authority.authorityGroup ?? null, at: nowIso() };
    aggregate.behaviourDecisions.push(entry);
    aggregate.history.push({ at: entry.at, actor: by, agent: null, event: 'refactor_behaviour_kept', phase: phase.id,
      detail: `${entry.id}: the old behaviour of ${named(checks)} is kept; ${stepName(phase)} version ${found.generation} restores it.` });
    return entry;
  }, { exactWorkItemPaths: [] });
  ({ workflow } = await loadAcceptedStoryExecution(root, id));
  return behaviourResult(workflow, { choice, checks, decision: record.id,
    words: `You kept the old behaviour: ${named(checks)} must pass as ${checks.length === 1 ? 'it did' : 'they did'} before the change. ${stepName(phase)} goes on and restores it.` });
}

/** The result of the person's choice: their words and the task's next step, as the step's own route names it. */
async function behaviourResult(workflow, { choice, checks, words, ...rest }) {
  const [{ stepRoute }, { withTaskRoute }] = await Promise.all([import('./step-decision.mjs'), import('./safe-command-guidance.mjs')]);
  const phase = workflow.phases?.[workflow.currentPhase] ?? null;
  const route = phase ? withTaskRoute(workflow, stepRoute(workflow, phase)) : null;
  return { schemaVersion: 1, resultType: 'sflow-task-behaviour', id: workflow.workItem.id, kind: workflow.resolution?.composition?.kind ?? null, choice, checks,
    ...rest, words, phase: phase?.id ?? null,
    ...(route?.command ? { nextAction: { command: route.command, copilotCommand: route.copilotCommand ?? route.skill ?? null,
      label: `Carry ${workflow.workItem.id} on: ${stepName(phase)}.` } } : {}) };
}
