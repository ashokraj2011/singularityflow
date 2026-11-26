/**
 * A started task gains a step [ITW:REQ-009, REQ-014, REQ-015, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * `singularity-flow work add design` re-composes a running task's steps with the step added, from the current step
 * forward: the step goes where its intent goes (task-composition.mjs INTENT_ORDER), which must be after the current
 * step. Done steps and the current step stay exactly as they are; the steps after it read the new step and may return to
 * it; the team's `tasks:` rules still apply last. Nothing is ever taken out after the start. A team's `tasks.paths` rule
 * adds its steps the same way when the code step touches its files (`rule`), with a person's approval where a rule gives
 * one. A fix whose code changes the data or a public interface becomes a change (`grow`): its plan goes before the code
 * waiting for approval, which SFlow returns to it. A refactor whose new behaviour a person accepted becomes a change with
 * no step added (changeTaskKind). The versions those returns made due start settled with an undo (`task-grown`).
 *
 * The change is one accepted revision of the Story's workflow snapshot (task-change-contracts.mjs, captured by
 * workflow-snapshots.mjs captureWorkflowTaskChange): a decision record naming who asked (or the rule and its reason), the
 * policy with its one step added, the step's template and any agent it brings, the composition's `changes` entry, a
 * history entry and a Story commit. Adding a step only adds work and approvals, so it needs no approval of its own; it is
 * the person's own command (a registered mutation, refused from a read turn).
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
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
  // A restart's way to end the first task travels beside its next action (restartAction).
  const { cancel = null, ...action } = nextAction ?? {};
  return new SingularityFlowError(message, { code: 'TASK_CHANGE_REFUSED', details: { ...details, nextAction: action, ...(cancel ? { cancel } : {}) } });
}

const statusAction = (id) => ({ command: `singularity-flow work status ${id}`, label: 'See where the task stands; it carries on with its steps.' });

const quoted = (words) => `"${String(words).replace(/(["\\$`])/gu, '\\$1')}"`;
/**
 * The task started again from its own words with the step a person asked for: the complete command for a step this
 * task cannot gain. `work --new` starts it beside the open one, whose own route (`cancel`) ends that one when it is
 * no longer wanted.
 */
function restartAction(workflow, kind, intent) {
  const id = workflow.workItem.id;
  const words = String(workflow.workItem?.title ?? '').trim() || `${kind} ${id}`;
  return { command: `singularity-flow work ${quoted(words)} --kind ${kind} --add ${intent} --new --start`,
    label: `Start the task again with the step; ${id} stays open until cancelled.`,
    cancel: { command: `singularity-flow cancel ${id} --reason "Started again with the step" --confirm ${id}`, label: `Cancel ${id} once the new task has started.` } };
}

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
      { command: `singularity-flow decision show ${id}`, label: 'See the decision it is waiting for.' });
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
 *
 * `grow` (`{ from, to }`, ITW:REQ-014): a fix whose submitted code needs a plan becomes a change; its plan step goes where
 * a plan goes, before the code step that is current and waits for its approval. That step is then returned to the plan
 * (growTaskAfterCode), so the code is never approved before a person approves the plan.
 */
export async function assertTaskStepAddable(workflow, intent, { grow = null } = {}) {
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
  // The Story's test agreement was confirmed for the steps it started with, so its steps stay those; the task started
  // again with the step confirms its agreement for the new steps [ITW:REQ-009].
  if (workflow.testRecovery) {
    throw refused(`${id}'s test agreement was confirmed for the steps it started with, so its steps stay as they are. Start the task again with the ${noun} step; its agreement is confirmed for the new steps.`,
      restartAction(workflow, grow?.to ?? kind, intent), { add: intent });
  }
  const currentIndex = workflow.phaseOrder.indexOf(workflow.currentPhase);
  const position = placeFor(composition.steps, intent, composer.INTENT_ORDER);
  if (grow) {
    const current = composition.steps[currentIndex];
    if (intent !== 'plan' || kind !== grow.from || current?.intent !== 'code' || workflow.phases[current.id]?.status !== 'awaiting_approval'
        || position !== currentIndex) {
      throw refused(`${id} is not a ${grow.from} whose code waits for its approval, so it does not become a ${grow.to} here.`, statusAction(id), { add: intent });
    }
    return { composition, position };
  }
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
async function taskStepChange(root, definition, workflow, { intent, rule = null, grow = null, touchedPaths = [], changedPaths = [], at, by }) {
  const [composer, config, capabilityContext, phaseRoles, approval, skills, contracts, snapshots, paths, wel, walker] = await Promise.all([
    import('./task-composition.mjs'), import('./config.mjs'), import('./capability-context.mjs'), import('./phase-roles.mjs'),
    import('./approval-authority.mjs'), import('./skill-library.mjs'), import('./task-change-contracts.mjs'),
    import('./workflow-snapshots.mjs'), import('./story-paths.mjs'), import('./wel-policy.mjs'), import('./task-walk.mjs')]);
  const id = workflow.workItem.id;
  const { composition, position } = await assertTaskStepAddable(workflow, intent, { grow });
  const kind = grow?.to ?? composition.kind;
  const restart = restartAction(workflow, kind, intent);
  const noun = STEP_WORDS[intent] ?? intent;
  const stepId = composer.taskStepFor(definition, intent);
  if (!stepId) {
    throw refused(`This repository's workflow has no ${noun} step to add. Add a step whose intent is ${intent} in Workflow Studio.`, statusAction(id), { add: intent });
  }
  const step = { id: stepId, intent, label: composer.taskStepLabel(kind, intent) };
  const files = [...new Set(touchedPaths.map(String))].sort();
  const change = grow ? { change: 'grow', intent, at, by, from: grow.from, to: grow.to, because: grow.because, paths: files }
    : { change: 'add', intent, at, by, ...(rule ? { rule: rule.rule, because: rule.because, paths: files } : {}) };
  const nextComposition = { ...structuredClone(composition), kind, steps: contracts.stepsWithInsertion(composition.steps, step, position),
    changes: [...(composition.changes ?? []), change] };
  if (rule) {
    nextComposition.added = [...(composition.added ?? []), { intent, rule: rule.rule, because: rule.because }];
    if (!(composition.rules ?? []).some((entry) => entry.rule === rule.rule)) nextComposition.rules = [...(composition.rules ?? []), { rule: rule.rule, because: rule.because }];
  } else if (!grow) {
    // The team's rules apply last [ITW:REQ-004]: composed again with every step a person asked for and this one, they
    // give exactly these steps (with those a rule added for the code's files since); an approval a rule gives a person on
    // this kind of step comes with it.
    const asked = (composition.changes ?? []).filter((entry) => entry.change === 'add' && !entry.rule).map((entry) => entry.intent);
    const ruled = new Set((composition.changes ?? []).filter((entry) => entry.change === 'add' && entry.rule).map((entry) => entry.intent));
    // A task that follows a marketplace agent's workflow is composed again from that workflow [ITW:REQ-011].
    const recomposed = composer.composeTask(definition, { kind, touchedPaths: composition.touchedPaths ?? [], add: [...asked, intent],
      skip: (composition.changes ?? []).filter((entry) => entry.change === 'skip').map((entry) => entry.intent),
      ...(composition.agent ? { agent: composition.agent } : {}) });
    const raised = recomposed.personApproves.filter((entry) => !(composition.personApproves ?? []).includes(entry));
    if (!same(recomposed.steps.map((entry) => entry.id), nextComposition.steps.filter((entry) => !ruled.has(entry.intent)).map((entry) => entry.id))
        || raised.some((entry) => entry !== intent)) {
      throw refused(`The team's task rules on this branch changed since ${id} started, so the step cannot be added to the same steps. Start the task again with it.`,
        restart, { add: intent });
    }
    if (raised.length) nextComposition.personApproves = [...(composition.personApproves ?? []), ...raised].sort();
  }
  // An approval the team's rules give a person on this kind of step comes with it [ITW:REQ-004, REQ-005], whoever added
  // it: an `always` rule for the task's kind (the kind it became, when a fix grew), or a `paths` rule for the files the
  // task started with or its code changed since. Only the added step's approval rises; every other step keeps its own.
  if (composer.rulePersonApproves(definition, kind, [...(composition.touchedPaths ?? []), ...changedPaths, ...files]).includes(intent)
      && !(nextComposition.personApproves ?? []).includes(intent)) {
    nextComposition.personApproves = [...(nextComposition.personApproves ?? []), intent].sort();
  }
  // The work type with the step, resolved as the Story's start resolved its own. A step the change would hand from a
  // person to SFlow (an intake that was the plan, once a design step plans) stays a person's: the composition says so
  // (personKeeps), so a change only ever adds approvals and every later reader resolves the same steps. A step that wrote
  // the requirement IDs keeps writing them when the added step writes them too (a plan or requirements step after a fix's
  // intake): the composition says so (clauseKeeps), as a feature's requirements step sits beside its plan.
  const oldPhases = workflow.resolution.phases;
  const keptPhase = (index) => oldPhases[index < position ? index : index - 1];
  const byPerson = (phase) => (phase?.approval?.mode ?? 'required') === 'required' && phase?.approval?.automatic !== 'when-ready';
  const definesClauses = (phase) => composer.CLAUSE_KINDS.includes(phase?.artifact?.kind);
  const resolve = () => {
    const overlay = config.validateDefinition(structuredClone(composer.taskDefinition(definition, nextComposition)));
    return { overlay, resolved: config.assertWorkTypeStartable(config.resolveWorkType(overlay, nextComposition.workType,
      { intentProfile: phaseRoles.storyIntentProfile(workflow.resolution) })) };
  };
  let { overlay: overlaid, resolved } = resolve();
  for (let pass = 0; pass < 3; pass += 1) {
    const others = nextComposition.steps.map((entry, index) => ({ entry, index })).filter(({ index }) => index !== position);
    const kept = others.filter(({ index }) => byPerson(keptPhase(index)) && !byPerson(resolved.phases[index])).map(({ entry }) => entry.id);
    const clauses = others.filter(({ index }) => definesClauses(keptPhase(index)) && !definesClauses(resolved.phases[index])).map(({ entry }) => entry.id);
    if (!kept.length && !clauses.length) break;
    if (kept.length) nextComposition.personKeeps = [...new Set([...(nextComposition.personKeeps ?? []), ...kept])].sort();
    if (clauses.length) nextComposition.clauseKeeps = [...new Set([...(nextComposition.clauseKeeps ?? []), ...clauses])].sort();
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
    throw refused(`The workflow configuration on this branch changed since ${id} started, so the step cannot be added to the same steps. Start the task again with it.`,
      restart, { add: intent });
  }
  const strip = (phase) => {
    const copy = structuredClone(phase);
    for (const key of ['templateSnapshot', 'order', 'inputs']) delete copy[key];
    if (copy.approval) delete copy.approval.rejectTo;
    return copy;
  };
  // Today's definition must give every step the task keeps the settings it pins, so a later reader of the composition
  // reads the same steps: only the place, the inputs and the returns of a later step follow the new order.
  const drifted = nextComposition.steps.flatMap((entry, index) => {
    if (index === position) return [];
    const [before, after] = [strip(oldPhases[index < position ? index : index - 1]), strip(tightened.phases[index])];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key])).sort();
    return keys.length ? [{ step: entry.id, settings: keys }] : [];
  });
  if (drifted.length) {
    throw refused(`The workflow on this branch gives ${id}'s steps other settings than it started with, so the step cannot be added to the same steps. Start the task again with it.`,
      restart, { add: intent, drifted });
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
      throw refused(`The ${noun} step's agent ${agentId} needs skills or files this task did not start with, so the step cannot be added now. Start the task again with it.`,
        restart, { add: intent, agent: agentId });
    }
    newAgents.push(agent);
  }
  for (const agentId of Object.keys(workflow.resolution.agents ?? {})) {
    const agent = catalog.get(agentId);
    if (agent && !same(agentSkillsOn(skills.effectiveLibrarySkills, agent, phaseIdsBefore), agentSkillsOn(skills.effectiveLibrarySkills, agent, phaseIdsAfter))) {
      throw refused(`The agent ${agentId} uses skills on the ${noun} step that this task did not start with, so the step cannot be added now. Start the task again with it.`,
        restart, { add: intent, agent: agentId });
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
    throw refused(`The ${noun} step records checked clauses, which ${id} did not start with, so it cannot be added now. Start the task again with it.`,
      restart, { add: intent });
  }
  proposed.policySha256 = contracts.taskChangePolicyDigest(proposed);
  const changeId = `TSC-${String((workflow.taskChanges ?? []).length + 1).padStart(3, '0')}`;
  const decision = {
    schemaVersion: currentSchemaVersion('task-change-decision'), kind: 'task-change-decision', id: changeId, workId: id, status: 'applied', approvedAt: at, by,
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
  const why = change.decision.change.because ? `: ${change.decision.change.because.replace(/[.\s]+$/u, '')}` : '';
  // A step whose approval the team's rules give a person says so: it is one more yes [ITW:REQ-005].
  const yours = approvals[change.step.id] === 'person' && (change.composition.personApproves ?? []).includes(change.step.intent) ? ' You approve it.' : '';
  return {
    plan: planLine(change.composition, { approvals, pullRequest: change.composition.pullRequest === true }),
    words: `Added a ${change.noun} step ${neighbour}${why}.${yours}`,
    approvedBy: approvals[change.step.id],
    current: workflow.phases[workflow.currentPhase]?.label ?? workflow.currentPhase
  };
}

/**
 * The files the task's latest submitted code changed, as its delivery evidence recorded them (application files only):
 * what a `paths` rule reads after the start [ITW:REQ-014]. Empty before any code was submitted.
 */
async function codeChangedFiles(root, config, workflow, phaseId = null) {
  const [{ applicationPathContext, isApplicationChangeEntry }, path, { readFile }] = await Promise.all([
    import('./application-paths.mjs'), import('node:path'), import('node:fs/promises')]);
  const code = phaseId ? workflow.phases?.[phaseId]
    : [...(workflow.phaseOrder ?? [])].reverse().map((id) => workflow.phases?.[id]).find((phase) => phase?.deliveryEvidence?.changeSetPath);
  const changeSetPath = code?.deliveryEvidence?.changeSetPath;
  if (!changeSetPath) return [];
  const changeSet = JSON.parse(await readFile(path.join(root, changeSetPath), 'utf8'));
  const context = applicationPathContext(config, workflow);
  return [...new Set((changeSet.entries ?? []).filter((entry) => isApplicationChangeEntry(entry, context))
    .flatMap((entry) => [entry.newPath, entry.oldPath]).filter(Boolean).map(String))].sort();
}

/**
 * Add a step to a started task, after its current step. `definition` is the configuration on the Story's branch (its
 * agents and templates); `config` the Story's own accepted execution definition. Returns the change's result.
 */
export async function addTaskStep(root, config, workflow, { intent, definition, rule = null, grow = null, touchedPaths = [], changedPaths = null } = {}) {
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
  const changed = changedPaths ?? await codeChangedFiles(root, config, workflow).catch(() => []);
  const initial = await taskStepChange(root, definition, workflow, { intent, rule, grow, touchedPaths, changedPaths: changed, at, by });
  try {
    const { value, publication } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.CONFIGURATION_CHANGED, phaseId: workflow.currentPhase, generation: null, actor, agent: null,
      payload: { change: 'task-step-added', changeId: initial.decision.id, step: initial.step.id, intent, ...(grow ? { grown: grow.to } : {}) }
    }, `[${id}][task:${grow ? 'grow' : 'add'}] ${initial.decision.id} ${initial.step.id}`, async (current) => {
      const fresh = await taskStepChange(root, definition, current, { intent, rule, grow, touchedPaths, changedPaths: changed, at, by });
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
        detail: `${fresh.decision.id}: added ${fresh.step.label}${where ? ` before ${where}` : ' at the end'}${grow ? `; the ${grow.from} became a ${grow.to}: ${grow.because}`
          : rule ? `, by the team's rule ${rule.rule}: ${rule.because}` : `, asked for by ${by}`}; snapshot revision ${reference.revision}.` });
      return { changeId: fresh.decision.id, workflowSnapshot: reference };
    }, { exactWorkItemPaths: initial.exactWorkItemPaths });
    const said = await changeWords(initial, workflow);
    return {
      schemaVersion: 1, resultType: 'sflow-task-change', status: publication?.pushed === false ? 'publication-pending' : 'applied',
      applied: true, stateChanged: true, id, changeId: value.changeId, change: initial.decision.change,
      added: { ...initial.step, approvedBy: said.approvedBy }, steps: initial.composition.steps.map((entry) => entry.label),
      plan: said.plan, words: said.words, workflowSnapshot: value.workflowSnapshot, publication,
      next: { command: `singularity-flow work status ${id}`, label: `Carry ${id} on: ${said.current} is still the step being worked on.` }
    };
  } finally { PROSPECTIVE.delete(workflow); }
}

/** The kind of SFlow's return of a grown fix's code to its plan, and of the code's next version it starts after the plan. */
export const TASK_GROWN = 'task-grown';
// A data change's own files beside its migrations, and a public interface's contract files [ITW:REQ-014].
const DATA_SCHEMA_FILE = /(?:^|\/)(?:schema\.prisma|db\/schema\.rb|db\/structure\.sql)$/iu;
const INTERFACE_CONTRACT = Object.freeze([/\.(?:proto|graphqls?|gql)$/iu, /(?:^|\/)(?:openapi|swagger|asyncapi)(?:[._-][^/]*)?\.(?:ya?ml|json)$/iu]);

/**
 * Whether a fix's submitted code needs a plan, so the fix is a change [ITW:REQ-014]: among the application files the code
 * changed, not counting tests' own files (`isTest`),
 * - a data change: a migration (`migration`, the folders the delivery receipt names `migration`: application-paths.mjs
 *   MIGRATION_PATH), or the schema file a migration tool keeps (schema.prisma, db/schema.rb, db/structure.sql);
 * - a public interface: its contract file (an OpenAPI, Swagger or AsyncAPI document, a .proto, a GraphQL schema).
 * By path only, so the same files always give the same answer; an exported signature changed in source is not read here
 * (nothing cheap and deterministic knows it). Returns `{ reasons, files, what, because }`, or null. Pure.
 */
export function taskGrowth(files, { isTest = () => false, migration = /(?:^|\/)(?:migrations?|db\/migrate)(?:\/|$)/iu } = {}) {
  const own = [...new Set((files ?? []).map(String))].filter((file) => !isTest(file)).sort();
  const data = own.filter((file) => migration.test(file) || DATA_SCHEMA_FILE.test(file));
  const contract = own.filter((file) => !data.includes(file) && INTERFACE_CONTRACT.some((pattern) => pattern.test(file)));
  if (!data.length && !contract.length) return null;
  const named = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
  const what = [data.length ? `the data (${named(data)})` : null, contract.length ? `a public interface (${named(contract)})` : null]
    .filter(Boolean).join(' and ');
  return { reasons: [...(data.length ? ['data'] : []), ...(contract.length ? ['interface'] : [])], files: [...data, ...contract].sort(), what,
    because: `The code changes ${what}, so a person approves a plan for it before the code` };
}

/**
 * SFlow's own return of the grown fix's code, waiting for its approval, to the plan step added before it: the plan is
 * written and approved first, and the code (kept on the branch) comes back after it. A PHASE_REJECTED commit of its own,
 * as failing-tests-opening.mjs returns a test step: no person and no group return it. Null when the code no longer waits.
 */
async function returnCodeToPlan(root, workId, { code, plan, words, files }) {
  const [{ loadAcceptedStoryExecution }, { transactStory, rejectPhase }, { LIFECYCLE_EVENT }, { AUTOMATIC_RETURNER }] = await Promise.all([
    import('./accepted-story-execution.mjs'), import('./state-stores.mjs'), import('./lifecycle-event.mjs'), import('./failing-tests-return.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const phase = workflow.phases?.[code];
  if (workflow.currentPhase !== code || phase?.status !== 'awaiting_approval' || !workflow.phases?.[plan]) return null;
  const returner = { ...AUTOMATIC_RETURNER };
  const { value } = await transactStory(root, config, workflow,
    { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId: code, generation: phase.generation, actor: returner, agent: null, authorityGroup: null,
      payload: { targetPhaseId: plan, automatic: TASK_GROWN } },
    `[${workId}][phase:${code}][reject] the fix became a change: returned automatically to ${plan}`,
    (aggregate) => rejectPhase(root, config, aggregate, { phaseId: code, target: plan, reason: words, actor: returner, agent: null,
      automatic: { kind: TASK_GROWN, files: files.slice(0, 50) } }),
    { eventFromResult: (transition) => ({ actor: returner, agent: null, authorityGroup: null, identityAssurance: 'automatic',
      payload: { targetPhaseId: plan, changeRequestId: transition.changeRequest.id, automatic: TASK_GROWN } }) });
  return { changeRequest: value?.changeRequest?.id ?? null };
}

/**
 * A fix whose code needs a plan becomes a change [ITW:REQ-014]: SFlow says so in one line, adds the plan step before the
 * code (a `grow` task change, TSC-NNN, recorded with why), and returns the code to it, so a person approves the plan
 * before the code; once the plan is approved SFlow starts the code's next version itself (codeVersionAfterGrownPlan).
 * Done steps stay, steps are only added, and nothing asks for an extra yes. When the plan cannot be added the code stays
 * with its approvers and the line says why; when the return cannot be made the line names the person's return.
 */
async function growTaskAfterCode(root, workId, phaseId, growth, definition) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  const loaded = await loadAcceptedStoryExecution(root, workId);
  const grow = { from: 'fix', to: 'change', because: `${growth.because}.` };
  let result;
  try {
    result = await addTaskStep(root, loaded.config ?? loaded.definition, loaded.workflow, { intent: 'plan', definition, grow, touchedPaths: growth.files });
  } catch (error) {
    if (error?.code !== 'TASK_CHANGE_REFUSED') throw error;
    return { lines: [`The code changes ${growth.what}, which needs a plan, but SFlow could not add one: ${error.message}`], added: [],
      refused: { code: error.code, ...(error.details?.drifted ? { drifted: error.details.drifted } : {}), nextAction: error.details?.nextAction ?? null } };
  }
  const added = { id: result.added.id, intent: 'plan', grown: { from: grow.from, to: grow.to }, files: growth.files, changeId: result.changeId };
  const line = `This fix changes ${growth.what}, so it is a change now: a plan comes before the code, and you approve the plan first. The code is kept and comes back for your approval after it.`;
  const words = `${growth.because}. This fix is a change now: write the plan for what the code already does (the change to ${growth.what.replace(/ \(.*$/u, '')}, how it is rolled out and what it keeps working), from the code on the branch. The code is kept; SFlow starts its next version once the plan is approved.`;
  try {
    const returned = await returnCodeToPlan(root, workId, { code: phaseId, plan: result.added.id, words, files: growth.files });
    if (returned) return { lines: [line], added: [added], grown: { ...added, returned: true, changeRequest: returned.changeRequest } };
  } catch (error) {
    if (!error?.code) throw error;
  }
  // The plan is in; the code's submission is out of date now (a configuration change), so its approval waits. Its
  // people return it to the plan themselves.
  const { returnRoute } = await import('./action-command-map.mjs');
  const current = (await loadAcceptedStoryExecution(root, workId)).workflow;
  const route = returnRoute(current, current.phases[phaseId], result.added.id);
  const command = route.command.replace('<reason>', `"${words.replaceAll('"', '\'')}"`);
  return { lines: [line, `SFlow could not return the code to the plan itself. Return it: ${command}`], added: [added],
    grown: { ...added, returned: false, nextAction: { command, skill: route.skill, label: 'Return the code to the plan, so the plan is approved first.' } } };
}

/**
 * After a task's code step is submitted [ITW:REQ-014]:
 * - a fix whose code changes the data or a public interface becomes a change (growTaskAfterCode), first;
 * - the steps a team's `tasks.paths` rule gives the files the code changed are added the same way a person adds one, after
 *   the step being worked on, recorded as the rule's with its `because`, and with a person's approval where a rule gives
 *   one; so are the steps the team's `always` rules give the kind a fix became.
 * A step whose place has passed (a plan once the code is written) is not added, and the line says so; nothing is ever
 * taken out. Returns `{ lines, added, grown? }`, or null when nothing applies.
 */
export async function addRuleStepsAfterCode(root, workId, phaseId) {
  const [{ loadAcceptedStoryExecution }, composer, { loadConfig }, { MIGRATION_PATH }, { isAllowedTestAutomationPath }] = await Promise.all([
    import('./accepted-story-execution.mjs'), import('./task-composition.mjs'), import('./state-stores.mjs'), import('./application-paths.mjs'),
    import('./code-delivery-tests.mjs')]);
  const loaded = await loadAcceptedStoryExecution(root, workId);
  const composition = composer.storyComposition(loaded.workflow);
  const step = composition?.steps?.find((entry) => entry.id === phaseId);
  if (!composition || composition.uses || step?.intent !== 'code' || !loaded.workflow.phases?.[phaseId]?.deliveryEvidence?.changeSetPath) return null;
  const files = await codeChangedFiles(root, loaded.config, loaded.workflow, phaseId);
  const definition = await loadConfig(root);
  const lines = [];
  const added = [];
  let grown = null;
  let notGrown = null;
  const growth = composition.kind === 'fix' && !composition.steps.some((entry) => entry.intent === 'plan')
    ? taskGrowth(files, { isTest: isAllowedTestAutomationPath, migration: MIGRATION_PATH }) : null;
  if (growth) {
    const result = await growTaskAfterCode(root, workId, phaseId, growth, definition);
    lines.push(...result.lines);
    added.push(...result.added);
    grown = result.grown ?? null;
    // Not grown: what stopped it, and the way on, for the caller's result.
    if (result.refused) notGrown = { ...result.refused, reasons: growth.reasons, files: growth.files };
  }
  const kind = grown ? grown.grown.to : composition.kind;
  const applies = (rule) => rule.kinds.includes('all') || rule.kinds.includes(kind);
  const rules = composer.taskRules(definition);
  // The rules that apply now: each `paths` rule whose files the code touched, and each `always` rule of the kind a fix
  // became that the fix's own rules did not already apply.
  const due = [
    ...rules.paths.map((rule, index) => ({ rule, name: `paths[${index}]`, matched: files.filter((file) => rule.paths.some((glob) => composer.pathMatches(glob, file))) }))
      .filter((entry) => applies(entry.rule) && entry.matched.length),
    ...(grown ? rules.always.map((rule, index) => ({ rule, name: `always[${index}]`, matched: grown.files }))
      .filter((entry) => applies(entry.rule) && !(entry.rule.kinds.includes('all') || entry.rule.kinds.includes(composition.kind))) : [])
  ];
  for (const { rule, name, matched } of due) {
    const because = rule.because.replace(/[.\s]+$/u, '');
    for (const intent of rule.steps) {
      const current = await loadAcceptedStoryExecution(root, workId);
      if ((current.workflow.resolution?.composition?.steps ?? []).some((entry) => entry.intent === intent)) continue;
      if (!composer.ADDABLE.includes(intent)) continue;
      try {
        const result = await addTaskStep(root, current.config ?? current.definition, current.workflow,
          { intent, definition, rule: { rule: name, because: rule.because }, touchedPaths: matched, changedPaths: files });
        lines.push(result.words);
        added.push({ id: result.added.id, intent, rule: name, because: rule.because, files: matched, changeId: result.changeId, approvedBy: result.added.approvedBy });
      } catch (error) {
        if (error?.code !== 'TASK_CHANGE_REFUSED') throw error;
        lines.push(`The team's rule (${because}) asks for a ${STEP_WORDS[intent] ?? intent} step, which was not added: ${error.message}`);
      }
    }
  }
  return lines.length ? { lines, added, ...(grown ? { grown } : {}), ...(notGrown ? { notGrown } : {}) } : null;
}

/** The returns that grew a task: SFlow's own (a fix's code to its new plan) and a person's acceptance of a refactor's new behaviour. */
function growthReturns(workflow) {
  const accepted = new Set((workflow?.resolution?.composition?.changes ?? []).filter((entry) => entry?.change === 'grow' && entry.changeRequest)
    .map((entry) => entry.changeRequest));
  return (workflow?.changeRequests ?? []).filter((entry) => entry?.automatic?.kind === TASK_GROWN || accepted.has(entry?.id));
}

/**
 * A step a growth's return reset, when its next version is due [ITW:REQ-014, REQ-015]: the Story reached it again after
 * the plan the return went to was approved (a grown fix's code; a refactor's code and tests once its new behaviour was
 * accepted), nothing of it is open, and SFlow has not started it for this return, or a person undid that. Pure.
 */
export function grownVersionDue(workflow, phase) {
  if (!phase || workflow?.currentPhase !== phase.id || phase.status !== 'in_progress' || !(Number(phase.generation) >= 1)) return null;
  if (Number(phase.versionOpening?.version ?? 0) > Number(phase.generation)) return null;
  const order = workflow.phaseOrder ?? [];
  const at = order.indexOf(phase.id);
  const request = growthReturns(workflow).findLast((entry) => order.indexOf(entry.targetPhase) >= 0 && order.indexOf(entry.targetPhase) < at
    && at <= order.indexOf(entry.sourcePhase));
  const plan = workflow.phases?.[request?.targetPhase];
  if (!request || plan?.status !== 'approved') return null;
  // The version that return left: the step was set back by it and has run none since.
  const reset = phase.reworkRevalidation;
  if (Number(reset?.generation) !== Number(phase.generation) || !(Date.parse(reset?.invalidatedAt) >= Date.parse(request.requestedAt))) return null;
  if ((workflow.settledDecisions ?? []).some((entry) => entry?.kind === TASK_GROWN && entry.phase === phase.id
    && Number(entry.effect?.generation) === Number(phase.generation))) return null;
  return { request, plan };
}

/** Open `phase`'s next version settled for the person, with an undo, as SFlow starts a test step's run again. */
async function openSettledVersion(root, config, workflow, phase, { subject, answer, evidence, effect, actor }) {
  const [opening, { actorKey }, { phaseRequiresCodeDelivery }] = await Promise.all([import('./commands/phase-opening.mjs'), import('./state-stores.mjs'),
    import('./code-delivery-policy.mjs')]);
  const proposed = await opening.proposalNow(root, workflow, phase, { reason: await opening.successorReason(workflow, phase) });
  const next = proposed.proposal.version;
  const settlement = { kind: TASK_GROWN, by: 'sflow', phase: phase.id, subject, answer: answer(next), evidence,
    effect: { generation: Number(phase.generation), toGeneration: next, ...effect } };
  const opened = await opening.openSuccessor(root, config, workflow, phase, { ...proposed,
    settled: { kind: TASK_GROWN, settlement, actor: actor ? actorKey(actor) : null },
    open: phaseRequiresCodeDelivery(phase) ? opening.codeOpening(root, config) : opening.documentOpening() });
  return { phase: phase.id, generation: next, settled: opened.settled ? { id: opened.settled.id, kind: TASK_GROWN } : null };
}

const stepName = (step) => step?.label ?? step?.id;

/**
 * Once the plan of a task that grew is approved, SFlow starts the next version of each step its return set back as the
 * Story reaches it (the code; for a refactor, its tests too), settled with an undo (`task-grown`, settled-decisions.mjs), as
 * it starts a test step's run again (failing-tests-opening.mjs): the return made the version due, so the person is not
 * asked "Start version N?" for it [ITW:REQ-014, REQ-015, no extra yes]. Null when nothing is due; on any refusal the
 * version stays the person's yes, as after any return.
 */
export async function codeVersionAfterGrownPlan(root, workId, { actor = null } = {}) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const phase = workflow.phases?.[workflow.currentPhase];
  const due = grownVersionDue(workflow, phase);
  if (!due) return null;
  const files = (due.request.automatic?.files ?? []).slice(0, 4).join(', ');
  const opened = await openSettledVersion(root, config, workflow, phase, { actor,
    subject: `${phase.id} version ${phase.generation}: its next version once the plan ${due.plan.id} is approved`,
    answer: (next) => `Started version ${next} of ${stepName(phase)} once ${stepName(due.plan)} version ${due.plan.generation} was approved`,
    evidence: [
      { what: due.request.automatic ? `the code changed ${files || 'the data or a public interface'}, so the fix became a change and SFlow returned its code to the plan`
        : 'a person accepted the refactor\'s new behaviour, so it became a change and its plan was revised', where: `${due.request.id}` },
      { what: `${stepName(due.plan)} version ${due.plan.generation} was approved`, where: `${due.plan.id} approval` }],
    effect: { planPhase: due.plan.id, planGeneration: Number(due.plan.generation), changeRequest: due.request.id } });
  return { ...opened, line: `The plan is approved, so SFlow started version ${opened.generation} of ${stepName(phase)}${phase.id === due.request.sourcePhase && due.request.automatic
    ? ': the code comes back for your approval' : ''}.` };
}

/**
 * A refactor whose new behaviour a person accepted becomes a change [ITW:REQ-015]: one accepted revision of its workflow
 * that changes its kind and nothing else (a `grow` task change that adds no step, recorded with the checks whose
 * behaviour changed and the person's return to the plan). Its steps, their settings and their state stay as they are.
 */
export async function changeTaskKind(root, config, workflow, { from, to, because, checks, changeRequest }) {
  const [{ identity }, { actorKey, transactStory }, { LIFECYCLE_EVENT }, { prospectiveTestCommandAmendments: PROSPECTIVE }, snapshots, contracts,
    composer, paths] = await Promise.all([
    import('./git.mjs'), import('./state-stores.mjs'), import('./lifecycle-event.mjs'), import('./test-command-amendment-contracts.mjs'),
    import('./workflow-snapshots.mjs'), import('./task-change-contracts.mjs'), import('./task-composition.mjs'), import('./story-paths.mjs')]);
  const id = workflow.workItem.id;
  const actor = identity(root);
  const by = actor?.email || actor?.login ? actorKey(actor) : 'sflow';
  const at = nowIso();
  const change = (current) => {
    const composition = composer.storyComposition(current);
    const index = (composition?.steps ?? []).findIndex((step) => step.intent === 'plan');
    if (composition?.kind !== from || index < 0) throw refused(`${id} is not a ${from} with a plan, so it does not become a ${to}.`, statusAction(id));
    const entry = { change: 'grow', intent: 'plan', at, by, from, to, because, checks: checks.slice(0, 256), changeRequest };
    // The plan it keeps takes the change's own label ("Plan: what must not change" says nothing a change does), in the
    // composition, its pinned step and its state alike (task-change-contracts.mjs relabeledStep).
    const kept = { step: composition.steps[index], change: entry };
    const next = { ...structuredClone(composition), kind: to, steps: composition.steps.map((step) => contracts.relabeledStep(step, kept)),
      changes: [...(composition.changes ?? []), entry] };
    const proposed = structuredClone(current.resolution);
    proposed.composition = next;
    proposed.phases = (proposed.phases ?? []).map((phase) => contracts.relabeledStep(phase, kept));
    proposed.policySha256 = contracts.taskChangePolicyDigest(proposed);
    const changeId = `TSC-${String((current.taskChanges ?? []).length + 1).padStart(3, '0')}`;
    const decision = { schemaVersion: currentSchemaVersion('task-change-decision'), kind: 'task-change-decision', id: changeId, workId: id, status: 'applied', approvedAt: at, by,
      step: structuredClone(composition.steps[index]), position: index, afterPhase: current.currentPhase, change: entry,
      from: { revision: current.workflowSnapshot.revision, snapshotHash: current.workflowSnapshot.snapshotHash,
        policySha256: current.resolution.policySha256, compositionSha256: contracts.taskChangeDigest(composition) },
      to: { revision: current.workflowSnapshot.revision + 1, policySha256: proposed.policySha256, compositionSha256: contracts.taskChangeDigest(next) },
      addedAssets: [], addedAgents: [] };
    contracts.assertTaskChangeScope(current.resolution, proposed, decision);
    const item = paths.workDirRelative(config, id);
    const decisionPath = snapshots.taskChangeDecisionPath(config, id, changeId);
    const policyBlob = createHash('sha256').update(Buffer.from(canonicalJson(proposed))).digest('hex');
    return { proposed, decision, decisionPath, exactWorkItemPaths: [decisionPath,
      `${item}/config/wfa/snapshots/${String(decision.to.revision).padStart(6, '0')}/manifest.json`,
      `${item}/config/wfa/blobs/.gitattributes`, `${item}/config/wfa/blobs/sha256/${policyBlob}`] };
  };
  const initial = change(workflow);
  try {
    const { value } = await transactStory(root, config, workflow, {
      type: LIFECYCLE_EVENT.CONFIGURATION_CHANGED, phaseId: workflow.currentPhase, generation: null, actor, agent: null,
      payload: { change: 'task-kind-changed', changeId: initial.decision.id, from, to }
    }, `[${id}][task:grow] ${initial.decision.id} ${from} to ${to}`, async (current) => {
      const fresh = change(current);
      if (fresh.proposed.policySha256 !== initial.proposed.policySha256 || fresh.decision.id !== initial.decision.id) {
        throw refused(`${id} changed while it was becoming a ${to}.`, statusAction(id));
      }
      const [{ mkdir }, path, { secureRepositoryPath, writeText }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('./util.mjs')]);
      const target = await secureRepositoryPath(root, fresh.decisionPath, { label: 'Task change decision', type: 'file' });
      if (target.exists) throw refused(`${fresh.decision.id} is already recorded for ${id}.`, statusAction(id));
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeText(target.absolute, canonicalJson(fresh.decision));
      const decisionSha256 = contracts.taskChangeDigest(fresh.decision);
      const prior = structuredClone(current);
      current.resolution = fresh.proposed;
      if (current.phases?.[fresh.decision.step.id]) current.phases[fresh.decision.step.id] = contracts.relabeledStep(current.phases[fresh.decision.step.id], fresh.decision);
      current.taskChanges ??= [];
      current.taskChanges.push(contracts.taskChangeSummary(fresh.decision, { decisionPath: fresh.decisionPath, decisionSha256 }));
      const reference = await snapshots.captureWorkflowTaskChange(root, config, prior, current, {
        taskChangeDecision: { path: fresh.decisionPath, sha256: decisionSha256 }, addedAssets: [] });
      current.workflowSnapshot = reference;
      PROSPECTIVE.set(current, { reference: structuredClone(reference), policySha256: current.resolution.policySha256 });
      current.history.push({ at, actor: by, agent: null, event: 'task_kind_changed', phase: fresh.decision.step.id,
        detail: `${fresh.decision.id}: the ${from} became a ${to} on ${changeRequest}: ${because}; snapshot revision ${reference.revision}.` });
      return { changeId: fresh.decision.id };
    }, { exactWorkItemPaths: initial.exactWorkItemPaths });
    return value;
  } finally { PROSPECTIVE.delete(workflow); }
}

/**
 * A person's return of a refactor's test step to its plan, where the test step stopped on a behaviour change, is their
 * acceptance of the new behaviour [ITW:REQ-015]: the task becomes a change (changeTaskKind) and SFlow starts the plan's
 * next version, the revised plan, settled with an undo, so they are not asked "Start version N?" for the return they made.
 * The code and its tests follow it, each started by SFlow when the Story reaches it (codeVersionAfterGrownPlan). Null when
 * the return was anything else.
 */
export async function acceptBehaviourAfterReturn(root, workId, phaseId, changeRequestId, { actor = null } = {}) {
  const [{ loadAcceptedStoryExecution }, composer, rules] = await Promise.all([import('./accepted-story-execution.mjs'), import('./task-composition.mjs'),
    import('./failing-tests-return.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const composition = composer.storyComposition(workflow);
  const plan = composition?.steps?.find((step) => step.intent === 'plan');
  const request = (workflow.changeRequests ?? []).find((entry) => entry.id === changeRequestId);
  const test = workflow.phases?.[phaseId];
  if (composition?.kind !== 'refactor' || !plan || request?.automatic || request?.targetPhase !== plan.id || request.sourcePhase !== phaseId
    || workflow.currentPhase !== plan.id || test?.validationVerdict !== 'failed') return null;
  const failed = rules.failingTestChecks(test);
  const check = failed ? await rules.refactorAfterCheck(root, config, workflow, test, failed) : null;
  if (!check?.changed.length) return null;
  return becomeChange(root, workId, { plan, request, from: test, checks: rules.checkNames(check.changed), actor });
}

/**
 * A person's acceptance of a refactor's new behaviour while its code step is written, before any version of it was
 * published (refactor-behaviour.mjs) [ITW:REQ-015]: the code step goes back to the plan by the person's own return, its
 * open version and code kept in place for it (amended-drafts.mjs holdReturnedCode), and the task becomes a change as at
 * the test step (becomeChange). The code step's author then goes on in that same version once the plan is approved.
 */
export async function acceptBehaviourAtCode(root, workId, phaseId, { checks, actor, decision = null }) {
  const [{ loadAcceptedStoryExecution }, composer, { rejectPhase, transactStory }, { LIFECYCLE_EVENT }] = await Promise.all([
    import('./accepted-story-execution.mjs'), import('./task-composition.mjs'), import('./state-stores.mjs'), import('./lifecycle-event.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const composition = composer.storyComposition(workflow);
  const plan = composition?.steps?.find((step) => step.intent === 'plan');
  const code = workflow.phases?.[phaseId];
  if (composition?.kind !== 'refactor' || !plan || workflow.currentPhase !== phaseId || !(workflow.phaseOrder ?? []).includes(plan.id)) {
    throw refused(`${workflow.workItem.id} is not a refactor with a plan whose code is being written, so it does not become a change from here.`, statusAction(workflow.workItem.id));
  }
  const listed = `${checks.slice(0, 4).join(', ')}${checks.length > 4 ? ` and ${checks.length - 4} more` : ''}`;
  const reason = `Accept the new behaviour: ${listed} behave differently after the change, as the person chose. Revise the plan to say what changes; the code and its tests follow it.`;
  const { value: returned } = await transactStory(root, config, workflow,
    { type: LIFECYCLE_EVENT.PHASE_REJECTED, phaseId, generation: code.generation, actor, agent: null, authorityGroup: null, payload: { targetPhaseId: plan.id } },
    `[${workflow.workItem.id}][phase:${phaseId}][reject] return to ${plan.id}: the refactor's new behaviour accepted`,
    async (aggregate) => {
      const transition = await rejectPhase(root, config, aggregate, { phaseId, target: plan.id, reason, actor, agent: null, behaviourChange: { checks } });
      // The person's record of the acceptance, beside the return it makes, in the same write SF Guard signs.
      const recorded = decision ? decision(aggregate, { changeRequest: transition.changeRequest.id }) : null;
      return { ...transition, ...(recorded ? { behaviourDecision: recorded.id } : {}) };
    },
    { eventFromResult: (transition) => ({ payload: { targetPhaseId: plan.id, changeRequestId: transition.changeRequest.id } }) });
  const { workflow: after } = await loadAcceptedStoryExecution(root, workId);
  const request = (after.changeRequests ?? []).find((entry) => entry.id === returned.changeRequest?.id);
  const accepted = await becomeChange(root, workId, { plan, request, from: code, checks, actor });
  // The plan's agent takes the session, as after any return (reject).
  const current = await loadAcceptedStoryExecution(root, workId);
  await (await import('./session.mjs')).activateWorkItemSession(root, current.config, current.workflow).catch(() => null);
  return { ...accepted, ...(returned.behaviourDecision ? { decision: returned.behaviourDecision } : {}) };
}

/**
 * Once a person returned a refactor to its plan to accept its new behaviour: the task becomes a change (changeTaskKind)
 * and SFlow starts the plan's next version, the revised plan, settled with an undo [ITW:REQ-015].
 */
async function becomeChange(root, workId, { plan, request, from, checks, actor }) {
  const { loadAcceptedStoryExecution } = await import('./accepted-story-execution.mjs');
  let { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  const listed = `${checks.slice(0, 4).join(', ')}${checks.length > 4 ? ` and ${checks.length - 4} more` : ''}`;
  const changed = await changeTaskKind(root, config, workflow, { from: 'refactor', to: 'change', changeRequest: request.id,
    because: `A person accepted the new behaviour: ${listed} behave differently after the change.`, checks });
  ({ config, workflow } = await loadAcceptedStoryExecution(root, workId));
  const step = workflow.phases[plan.id];
  let opened = null;
  try {
    opened = await openSettledVersion(root, config, workflow, step, { actor,
      subject: `${plan.id} version ${step.generation}: its revision for the refactor's accepted new behaviour`,
      answer: (next) => `Started version ${next} of ${stepName(step)} to say what changes`,
      evidence: [{ what: `a person returned ${stepName(from)} to ${stepName(step)} to accept the new behaviour of ${listed}`, where: request.id }],
      effect: { changeRequest: request.id } });
  } catch (error) {
    if (!error?.code) throw error;
  }
  return { changeId: changed.changeId, kind: 'change', checks, changeRequest: request.id, ...(opened ? { opened } : {}),
    line: `The refactor is a change now: you accepted the new behaviour of ${listed}. ${opened ? `SFlow started version ${opened.generation} of ${stepName(step)}, which says what changes` : `Revise ${stepName(step)} to say what changes`}; the code and its tests follow it.` };
}
