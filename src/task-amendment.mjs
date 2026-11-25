/**
 * A started task gains a step [ITW:REQ-009, REQ-014, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * `singularity-flow work add design` re-composes a running task's steps with the step added, from the current step
 * forward: the step goes where its intent goes (task-composition.mjs INTENT_ORDER), which must be after the current
 * step. Done steps and the current step stay exactly as they are; the steps after it read the new step and may return to
 * it; the team's `tasks:` rules still apply last. Nothing is ever taken out after the start. A team's `tasks.paths` rule
 * adds its steps the same way when the code step touches its files (`rule`).
 *
 * The change is one accepted revision of the Story's workflow snapshot (task-change-contracts.mjs, captured by
 * workflow-snapshots.mjs captureWorkflowTaskChange): a decision record naming who asked (or the rule and its reason), the
 * policy with its one step added, the step's template and any agent it brings, the composition's `changes` entry, a
 * history entry and a Story commit. Adding a step only adds work and approvals, so it needs no approval of its own; it is
 * the person's own command (a registered mutation, refused from a read turn).
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';

const same = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);

/** What a step is called in a sentence, for this kind of task. */
function stepNoun(kind, intent) {
  if (intent === 'design') return kind === 'investigate' ? 'investigation' : kind === 'review' ? 'review' : kind === 'docs' ? 'document' : 'design';
  if (intent === 'code') return kind === 'tests' ? 'tests' : 'code';
  if (intent === 'test') return 'tests';
  if (intent === 'review') return 'conformance review';
  return intent;
}
const isPlural = (noun) => ['requirements', 'tests'].includes(noun);
const STEP_WORDS = Object.freeze({ requirements: 'requirements', design: 'design', plan: 'plan', review: 'review' });

function refused(message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code: 'TASK_CHANGE_REFUSED', details: { ...details, nextAction } });
}

const statusAction = (id) => ({ command: `singularity-flow work status ${id}`, label: 'See where the task stands; it carries on with its steps.' });

/** The index a step of `intent` takes among `steps`: after every step whose intent comes before it or is the same. */
function placeFor(steps, intent, order) {
  const rank = order.indexOf(intent);
  const after = steps.findIndex((step) => order.indexOf(step.intent) > rank);
  return after < 0 ? steps.length : after;
}

/** The Story's task composition, or the refusal that says why its steps cannot change. */
async function startedTask(workflow) {
  const { storyComposition } = await import('./task-composition.mjs');
  const id = workflow.workItem.id;
  const composition = storyComposition(workflow);
  if (!composition) {
    throw refused(`${id} was not started as a task, so its steps are its workflow's own.`,
      { command: `singularity-flow status ${id}`, label: `See where ${id} stands.` });
  }
  if (composition.uses) {
    throw refused(`${id} runs as the team's ${composition.uses} workflow, so its steps are that workflow's own.`, statusAction(id));
  }
  if (workflow.status !== 'in_progress' || !workflow.currentPhase) {
    throw refused(`${id} is ${String(workflow.status).replace(/_/gu, ' ')}, so its steps stay as they are.`, statusAction(id));
  }
  if (workflow.pendingDecision) {
    throw refused(`${id} is waiting for a decision after ${workflow.phases?.[workflow.currentPhase]?.label ?? 'its step'}; answer it first, then add the step.`,
      { command: `singularity-flow nextsteps ${id}`, label: 'See the decision it is waiting for.' });
  }
  return composition;
}

/** Refused: a started task only gains steps [ITW:REQ-009]. */
export async function refuseTaskStepRemoval(workflow, intent) {
  const composition = await startedTask(workflow);
  const id = workflow.workItem.id;
  const noun = stepNoun(composition.kind, intent);
  throw refused(`A started task only gains steps, so the ${noun} step stays. Steps are taken out before a task starts (--skip).`,
    statusAction(id), { skip: intent });
}

/**
 * Whether a started task can gain a step of `intent`, and where it goes: after every step whose intent comes before it,
 * which must be after the current step. Refuses in plain words otherwise; reads only the Story.
 */
export async function assertTaskStepAddable(workflow, intent) {
  const composer = await import('./task-composition.mjs');
  const id = workflow.workItem.id;
  const composition = await startedTask(workflow);
  const { kind } = composition;
  const noun = STEP_WORDS[intent] ?? intent;
  if (!composer.ADDABLE.includes(intent)) {
    throw refused(`A task can gain a ${composer.ADDABLE.join(', ')} step, not '${intent}'.`,
      { command: `singularity-flow work add design --work-id ${id}`, label: 'Add one of the steps a task can gain.' }, { add: intent });
  }
  if (composition.steps.some((step) => step.intent === intent)) {
    throw refused(`${id} already has a ${noun} step.`, statusAction(id), { add: intent });
  }
  if (['plan', 'review'].includes(intent) && !composition.steps.some((step) => step.intent === 'code')) {
    throw refused(`A ${noun} step ${intent === 'plan' ? 'plans' : 'reads'} code, and a ${kind} task changes none.`, statusAction(id), { add: intent });
  }
  if (workflow.testRecovery) {
    throw refused(`${id}'s test agreement names its steps, so a step cannot be added after the task started.`, statusAction(id), { add: intent });
  }
  const currentIndex = workflow.phaseOrder.indexOf(workflow.currentPhase);
  const position = placeFor(composition.steps, intent, composer.INTENT_ORDER);
  if (position <= currentIndex) {
    const follower = composition.steps[position];
    const followerNoun = stepNoun(kind, follower.intent);
    const state = workflow.phases[follower.id]?.status === 'in_progress' ? 'being written' : 'written';
    throw refused(`The ${followerNoun} ${isPlural(followerNoun) ? 'are' : 'is'} already ${state}; a ${noun} step goes before ${isPlural(followerNoun) ? 'them' : 'it'}.`,
      statusAction(id), { add: intent, before: follower.id });
  }
  return { composition, position };
}

/** The skills an agent uses on `phaseIds`, as a Story start captures them: its own and those attached to it. */
function agentSkillsOn(effectiveLibrarySkills, agent, phaseIds) {
  return effectiveLibrarySkills(agent).filter((entry) => !entry.phases?.length || entry.phases.some((phase) => phaseIds.has(phase)))
    .map((entry) => entry.id).sort();
}

/**
 * Everything the change writes, computed from the Story as it is and today's definition on its branch, with nothing
 * written: the new composition, the policy with the step added, the runtime state of every step, the decision and the
 * files the commit may hold. The transaction computes it again from the Story it holds and requires the same policy.
 */
async function taskStepChange(root, definition, workflow, { intent, rule = null, touchedPaths = [], at, by }) {
  const [composer, config, capabilityContext, phaseRoles, approval, skills, contracts, snapshots, paths, wel, walker] = await Promise.all([
    import('./task-composition.mjs'), import('./config.mjs'), import('./capability-context.mjs'), import('./phase-roles.mjs'),
    import('./approval-authority.mjs'), import('./skill-library.mjs'), import('./task-change-contracts.mjs'),
    import('./workflow-snapshots.mjs'), import('./story-paths.mjs'), import('./wel-policy.mjs'), import('./task-walk.mjs')]);
  const id = workflow.workItem.id;
  const { composition, position } = await assertTaskStepAddable(workflow, intent);
  const { kind } = composition;
  const noun = STEP_WORDS[intent] ?? intent;
  const stepId = composer.taskStepFor(definition, intent);
  if (!stepId) {
    throw refused(`This repository's workflow has no ${noun} step to add. Add a step whose intent is ${intent} in Workflow Studio.`, statusAction(id), { add: intent });
  }
  const step = { id: stepId, intent, label: composer.taskStepLabel(kind, intent) };
  const change = { change: 'add', intent, at, by, ...(rule ? { rule: rule.rule, because: rule.because } : {}) };
  const nextComposition = { ...structuredClone(composition), steps: contracts.stepsWithInsertion(composition.steps, step, position),
    changes: [...(composition.changes ?? []), change] };
  if (rule) {
    nextComposition.added = [...(composition.added ?? []), { intent, rule: rule.rule, because: rule.because }];
    if (!(composition.rules ?? []).some((entry) => entry.rule === rule.rule)) nextComposition.rules = [...(composition.rules ?? []), { rule: rule.rule, because: rule.because }];
    const files = [...new Set([...(composition.touchedPaths ?? []), ...touchedPaths.map(String)])].sort();
    if (files.length) nextComposition.touchedPaths = files;
  } else {
    // The team's rules apply last [ITW:REQ-004]: composed again with every step a person asked for and this one, they
    // give exactly these steps; an approval a rule gives a person on this kind of step comes with it.
    const asked = (composition.changes ?? []).filter((entry) => entry.change === 'add' && !entry.rule).map((entry) => entry.intent);
    const recomposed = composer.composeTask(definition, { kind, touchedPaths: composition.touchedPaths ?? [], add: [...asked, intent],
      skip: (composition.changes ?? []).filter((entry) => entry.change === 'skip').map((entry) => entry.intent) });
    const raised = recomposed.personApproves.filter((entry) => !(composition.personApproves ?? []).includes(entry));
    if (!same(recomposed.steps.map((entry) => entry.id), nextComposition.steps.map((entry) => entry.id)) || raised.some((entry) => entry !== intent)) {
      throw refused(`The team's task rules on this branch changed since ${id} started, so the step cannot be added to the same steps. Start a new task for it.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent });
    }
    if (raised.length) nextComposition.personApproves = [...(composition.personApproves ?? []), ...raised].sort();
  }
  // The work type with the step, resolved as the Story's start resolved its own. A step the change would hand from a
  // person to SFlow (an intake that was the plan, once a design step plans) stays a person's: the composition says so
  // (personKeeps), so a change only ever adds approvals and every later reader resolves the same steps.
  const oldPhases = workflow.resolution.phases;
  const byPerson = (phase) => (phase?.approval?.mode ?? 'required') === 'required' && phase?.approval?.automatic !== 'when-ready';
  const resolve = () => {
    const overlay = config.validateDefinition(structuredClone(composer.taskDefinition(definition, nextComposition)));
    return { overlay, resolved: config.assertWorkTypeStartable(config.resolveWorkType(overlay, nextComposition.workType,
      { intentProfile: phaseRoles.storyIntentProfile(workflow.resolution) })) };
  };
  let { overlay: overlaid, resolved } = resolve();
  const kept = nextComposition.steps.filter((entry, index) => index !== position
    && byPerson(oldPhases[index < position ? index : index - 1]) && !byPerson(resolved.phases[index])).map((entry) => entry.id);
  if (kept.length) {
    nextComposition.personKeeps = [...new Set([...(nextComposition.personKeeps ?? []), ...kept])].sort();
    ({ overlay: overlaid, resolved } = resolve());
  }
  await walker.walkTaskWorkType(overlaid, resolved);
  const tightened = capabilityContext.applyCapabilityPolicyToWorkResolution(
    { ...resolved, storage: structuredClone(workflow.resolution.storage ?? null) }, workflow.resolution.capability);
  let fresh;
  try { fresh = await config.snapshotResolution(root, overlaid, tightened); }
  catch (error) {
    throw refused(`This branch does not have what the ${noun} step needs: ${error.message}`, statusAction(id), { add: intent });
  }
  if (fresh.configSha256 !== workflow.resolution.configSha256) {
    throw refused(`The workflow configuration on this branch changed since ${id} started, so the step cannot be added to the same steps. Start a new task for it.`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent });
  }
  const strip = (phase) => {
    const copy = structuredClone(phase);
    for (const key of ['templateSnapshot', 'order', 'inputs']) delete copy[key];
    if (copy.approval) delete copy.approval.rejectTo;
    return copy;
  };
  // Today's definition must give every step the task keeps the settings it pins, so a later reader of the composition
  // reads the same steps: only the place, the inputs and the returns of a later step follow the new order.
  const drifted = nextComposition.steps.some((entry, index) => index !== position
    && !same(strip(oldPhases[index < position ? index : index - 1]), strip(tightened.phases[index])));
  if (drifted) {
    throw refused(`The workflow on this branch gives ${id}'s steps other settings than it started with, so the step cannot be added to the same steps. Start a new task for it.`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent });
  }
  const added = tightened.phases[position];
  try { approval.assertApprovalPolicyAttainable(workflow.resolution.approvalAuthorities, added.approval, added.id, { creator: workflow.workItem.createdBy }); }
  catch (error) { throw refused(`Nobody in ${id}'s approval groups could approve the ${noun} step: ${error.message}`, statusAction(id), { add: intent }); }
  const template = fresh.templates?.[added.id];
  if (!template?.path || !template.sha256 || template.source === 'agent') {
    throw refused(`The ${noun} step's template is not one a step can bring after the task started.`, statusAction(id), { add: intent });
  }
  // The agents the step brings, as a start would have taken them, each with nothing of its own to fetch.
  const phaseIdsBefore = new Set(oldPhases.map((phase) => phase.id));
  const phaseIdsAfter = new Set([...phaseIdsBefore, added.id]);
  const catalog = new Map((definition.agentCatalog ?? []).map((agent) => [agent.id, agent]));
  const newAgentIds = Object.keys(fresh.agents ?? {}).filter((agentId) => !Object.hasOwn(workflow.resolution.agents ?? {}, agentId)).sort();
  const newAgents = [];
  for (const agentId of newAgentIds) {
    const agent = catalog.get(agentId);
    if (!agent?.file || agent.sha256 !== fresh.agents[agentId].sha256 || (agent.dependencies ?? []).length
        || agentSkillsOn(skills.effectiveLibrarySkills, agent, phaseIdsAfter).length) {
      throw refused(`The ${noun} step's agent ${agentId} needs skills or files this task did not start with, so the step cannot be added now. Start a new task with it.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent, agent: agentId });
    }
    newAgents.push(agent);
  }
  for (const agentId of Object.keys(workflow.resolution.agents ?? {})) {
    const agent = catalog.get(agentId);
    if (agent && !same(agentSkillsOn(skills.effectiveLibrarySkills, agent, phaseIdsBefore), agentSkillsOn(skills.effectiveLibrarySkills, agent, phaseIdsAfter))) {
      throw refused(`The agent ${agentId} uses skills on the ${noun} step that this task did not start with, so the step cannot be added now. Start a new task with it.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent, agent: agentId });
    }
  }
  const item = paths.workDirRelative(definition, id);
  const blobPath = (sha) => `${item}/config/wfa/blobs/sha256/${sha}`;
  const capturedTemplate = { ...template, source: 'workflow-snapshot', sourcePath: template.path, path: blobPath(template.sha256), sha256: template.sha256 };
  const phases = nextComposition.steps.map((entry, index) => {
    if (index < position) return structuredClone(oldPhases[index]);
    if (index === position) return { ...structuredClone(added), order: index, templateSnapshot: structuredClone(capturedTemplate) };
    const prior = structuredClone(oldPhases[index - 1]);
    const later = tightened.phases[index];
    return { ...prior, order: index, inputs: structuredClone(later.inputs), approval: { ...prior.approval, rejectTo: [...later.approval.rejectTo] } };
  });
  const proposed = structuredClone(workflow.resolution);
  proposed.composition = nextComposition;
  proposed.phases = phases;
  proposed.templates = { ...proposed.templates, [added.id]: structuredClone(capturedTemplate) };
  proposed.agents = { ...proposed.agents, ...Object.fromEntries(newAgentIds.map((agentId) => [agentId, structuredClone(fresh.agents[agentId])])) };
  if (fresh.plannedClaims === undefined) delete proposed.plannedClaims; else proposed.plannedClaims = structuredClone(fresh.plannedClaims);
  if (fresh.obligationGraph) proposed.obligationGraph = structuredClone(fresh.obligationGraph); else delete proposed.obligationGraph;
  if (proposed.wel && !same(wel.buildWelEnrollment({ phases, codeDelivery: proposed.codeDelivery, configurationSource: proposed.configurationSource,
    claimMapContractVersion: proposed.wel.claimMapContractVersion }), proposed.wel)) {
    throw refused(`The ${noun} step records checked clauses, which ${id} did not start with, so it cannot be added now. Start a new task with it.`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind} --add ${intent} --new --start`, label: 'Start a new task with the step.' }, { add: intent });
  }
  proposed.policySha256 = contracts.taskChangePolicyDigest(proposed);
  const changeId = `TSC-${String((workflow.taskChanges ?? []).length + 1).padStart(3, '0')}`;
  const decision = {
    schemaVersion: 1, kind: 'task-change-decision', id: changeId, workId: id, status: 'applied', approvedAt: at, by,
    step, position, afterPhase: workflow.currentPhase, change,
    from: { revision: workflow.workflowSnapshot.revision, snapshotHash: workflow.workflowSnapshot.snapshotHash,
      policySha256: workflow.resolution.policySha256, compositionSha256: contracts.taskChangeDigest(composition) },
    to: { revision: workflow.workflowSnapshot.revision + 1, policySha256: proposed.policySha256,
      compositionSha256: contracts.taskChangeDigest(nextComposition) },
    addedAssets: [`template:${added.id}`, ...newAgentIds.map((agentId) => `agent:${agentId}`)].sort(),
    addedAgents: newAgentIds
  };
  contracts.assertTaskChangeScope(workflow.resolution, proposed, decision);
  const decisionPath = snapshots.taskChangeDecisionPath(definition, id, changeId);
  const policyBlob = createHash('sha256').update(Buffer.from(canonicalJson(proposed))).digest('hex');
  const exactWorkItemPaths = [...new Set([decisionPath,
    `${item}/config/wfa/snapshots/${String(decision.to.revision).padStart(6, '0')}/manifest.json`,
    `${item}/config/wfa/blobs/.gitattributes`, blobPath(policyBlob), blobPath(template.sha256),
    ...newAgents.map((agent) => blobPath(String(agent.sha256).replace(/^sha256:/u, '')))])];
  return { composition: nextComposition, step, position, added, proposed, decision, decisionPath, newAgents, template, capturedTemplate,
    exactWorkItemPaths, noun };
}

/** The step's runtime state for every step of the new order: done and current ones as they are. */
async function runtimePhases(workflow, change) {
  const [{ phaseState }, anchor] = await Promise.all([import('./state.mjs'), import('./story-policy-anchor.mjs')]);
  const phases = {};
  change.composition.steps.forEach((entry, index) => {
    const pinned = change.proposed.phases[index];
    let phase;
    if (index < change.position) phase = workflow.phases[entry.id];
    else if (index === change.position) phase = phaseState(pinned, index);
    else {
      phase = structuredClone(workflow.phases[entry.id]);
      phase.order = index;
      phase.inputs = structuredClone(pinned.inputs ?? []);
      phase.approvalPolicy = structuredClone(pinned.approval);
    }
    if (!same(anchor.currentPhasePolicy(phase), anchor.resolvedPhasePolicy(pinned, phase.order))) {
      throw new SingularityFlowError(`The step '${entry.id}' would not match its pinned settings after the change; nothing was written.`, {
        code: 'TASK_CHANGE_INVALID', details: { nextAction: { command: `singularity-flow work status ${workflow.workItem.id}`, label: 'See where the task stands.' } } });
    }
    phases[entry.id] = phase;
  });
  return phases;
}

/** The plan line and the words for the result. */
async function changeWords(change, workflow) {
  const { planLine } = await import('./task-composition.mjs');
  const approvals = Object.fromEntries(change.proposed.phases.map((phase) => [phase.id, phase.approval?.mode === 'none' ? 'none'
    : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person']));
  const steps = change.composition.steps;
  const kind = change.composition.kind;
  const neighbour = steps[change.position + 1] ? `before the ${stepNoun(kind, steps[change.position + 1].intent)}` : `after the ${stepNoun(kind, steps[change.position - 1].intent)}`;
  const why = change.decision.change.rule ? ` (${change.decision.change.because})` : '';
  return {
    plan: planLine(change.composition, { approvals, pullRequest: change.composition.pullRequest === true }),
    words: `Added a ${change.noun} step ${neighbour}${why}.`,
    approvedBy: approvals[change.step.id],
    current: workflow.phases[workflow.currentPhase]?.label ?? workflow.currentPhase
  };
}

/**
 * Add a step to a started task, after its current step. `definition` is the configuration on the Story's branch (its
 * agents and templates); `config` the Story's own accepted execution definition. Returns the change's result.
 */
export async function addTaskStep(root, config, workflow, { intent, definition, rule = null, touchedPaths = [] } = {}) {
  const [{ identity }, { actorKey, transactStory }, { LIFECYCLE_EVENT }, { prospectiveTestCommandAmendments: PROSPECTIVE }, snapshots, contracts, { storyPublicationPending }] = await Promise.all([
    import('./git.mjs'), import('./state-stores.mjs'), import('./lifecycle-event.mjs'), import('./test-command-amendment-contracts.mjs'),
    import('./workflow-snapshots.mjs'), import('./task-change-contracts.mjs'), import('./story-publication-read.mjs')]);
  const id = workflow.workItem.id;
  await startedTask(workflow);
  if (await storyPublicationPending(root, config, id, { migrate: false })) {
    throw refused(`${id} has a Story commit waiting to be sent; send it first, then add the step.`,
      { command: 'singularity-flow sync', label: 'Send the waiting Story commit.' });
  }
  const actor = identity(root);
  const by = actor?.email || actor?.login ? actorKey(actor) : null;
  if (!by) {
    throw refused('Adding a step records who asked for it: set your Git email first.',
      { command: 'git config user.email "<your email>"', label: 'Set your Git email, then add the step again.' });
  }
  const at = nowIso();
  // A step changes the policy that appeals and accepted risks are tied to: those are settled first, as for an approver refresh.
  const { staleningRecords } = await import('./story-approver-refresh.mjs');
  const blockers = await staleningRecords(root, config, workflow, at);
  if (blockers.length) {
    throw refused(`Adding a step would make ${blockers.length === 1 ? 'a record' : 'records'} tied to ${id}'s workflow out of date: ${blockers.map((entry) => entry.words).join('; ')}.`,
      { command: blockers[0].command, label: 'Settle it first, then add the step.' }, { blockers });
  }
  const initial = await taskStepChange(root, definition, workflow, { intent, rule, touchedPaths, at, by });
  try {
    const { value, publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.CONFIGURATION_CHANGED, phaseId: workflow.currentPhase, generation: null, actor, agent: null,
      payload: { change: 'task-step-added', changeId: initial.decision.id, step: initial.step.id, intent }
    }, `[${id}][task:add] ${initial.decision.id} ${initial.step.id}`, async (current) => {
      const fresh = await taskStepChange(root, definition, current, { intent, rule, touchedPaths, at, by });
      if (fresh.proposed.policySha256 !== initial.proposed.policySha256 || fresh.decision.id !== initial.decision.id) {
        throw refused(`${id} changed while the step was being added. Add it again.`, { command: `singularity-flow work add ${intent} --work-id ${id}`, label: 'Add the step again.' });
      }
      const captured = await snapshots.captureTaskStepAssets(root, config, current, { phaseId: fresh.step.id, template: fresh.template, agents: fresh.newAgents });
      if (!same(captured.template, fresh.capturedTemplate)) {
        throw refused(`The ${fresh.noun} step's template changed while it was being added. Add it again.`, { command: `singularity-flow work add ${intent} --work-id ${id}`, label: 'Add the step again.' });
      }
      const [{ mkdir }, path, { secureRepositoryPath, writeText }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('./util.mjs')]);
      const target = await secureRepositoryPath(root, fresh.decisionPath, { label: 'Task change decision', type: 'file' });
      if (target.exists) throw refused(`${fresh.decision.id} is already recorded for ${id}.`, statusAction(id));
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeText(target.absolute, canonicalJson(fresh.decision));
      const decisionSha256 = contracts.taskChangeDigest(fresh.decision);
      const prior = structuredClone(current);
      const phases = await runtimePhases(current, fresh);
      current.resolution = fresh.proposed;
      current.phaseOrder = fresh.composition.steps.map((entry) => entry.id);
      current.phases = phases;
      current.taskChanges ??= [];
      current.taskChanges.push(contracts.taskChangeSummary(fresh.decision, { decisionPath: fresh.decisionPath, decisionSha256 }));
      const reference = await snapshots.captureWorkflowTaskChange(root, config, prior, current, {
        taskChangeDecision: { path: fresh.decisionPath, sha256: decisionSha256 }, addedAssets: captured.assets });
      current.workflowSnapshot = reference;
      // The changed revision is this transaction's own until its commit is accepted (validateWorkflow).
      PROSPECTIVE.set(current, { reference: structuredClone(reference), policySha256: current.resolution.policySha256 });
      const where = fresh.composition.steps[fresh.position + 1]?.label ?? null;
      current.history.push({ at, actor: by, agent: null, event: 'task_step_added', phase: fresh.step.id,
        detail: `${fresh.decision.id}: added ${fresh.step.label}${where ? ` before ${where}` : ' at the end'}${rule ? `, by the team's rule ${rule.rule}: ${rule.because}` : `, asked for by ${by}`}; snapshot revision ${reference.revision}.` });
      return { changeId: fresh.decision.id, workflowSnapshot: reference };
    }, { exactWorkItemPaths: initial.exactWorkItemPaths });
    const said = await changeWords(initial, workflow);
    return {
      schemaVersion: 1, resultType: 'sflow-task-change', status: publication?.pushed === false ? 'publication-pending' : 'applied',
      applied: true, stateChanged: true, id, changeId: value.changeId, change: initial.decision.change,
      added: { ...initial.step, approvedBy: said.approvedBy }, steps: initial.composition.steps.map((entry) => entry.label),
      plan: said.plan, words: said.words, workflowSnapshot: value.workflowSnapshot, publication,
      next: { command: `singularity-flow nextsteps ${id}`, label: `Carry ${id} on: ${said.current} is still the step being worked on.` }
    };
  } finally { PROSPECTIVE.delete(workflow); }
}
