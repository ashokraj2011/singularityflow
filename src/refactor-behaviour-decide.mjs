/**
 * `work behaviour keep|accept` [ITW:REQ-015]: the person's choice at a refactor's behaviour change in its code step
 * (refactor-behaviour.mjs finds the change and stops the code step's publication). Apart from that module so the code
 * step's gate, which VS Code's runtime bundles through state.mjs, never reaches the task-change code (task-amendment.mjs).
 */
import { nowIso, SingularityFlowError } from './util.mjs';
import { BEHAVIOUR_CHOICES, behaviourCommands, named, stepName, versionBehaviourChange } from './refactor-behaviour.mjs';

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
