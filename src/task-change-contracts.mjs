/**
 * Closed records for a step added to a started task [ITW:REQ-009, REQ-014, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md].
 *
 * A task's steps are composed from its kind and frozen into its Story's snapshot when it starts. A person may add a
 * requirements, design, plan or review step later, after the current step; a team's `tasks.paths` rule may add its steps
 * when the code step touches its files. Either is one accepted snapshot revision that changes exactly one thing: one
 * step inserted after the current one, with the later steps' inputs and returns following the new order. Done steps and
 * the current step stay byte for byte; nothing is removed; every other part of the Story's policy is unchanged. Adding a
 * step only adds work and approvals, so it needs no approval of its own; the decision names who asked for it, or the
 * team's rule that did. Pure: the snapshot chain (workflow-snapshots.mjs) replays these checks for every accepted change.
 */
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError } from './util.mjs';

export const TASK_CHANGE_DIALECT = 'task-step-added/v1';
export const TASK_CHANGE_ID = /^TSC-[0-9]{3,6}$/u;
/** The resolution keys a task change re-derives from its new steps; every other key stays exactly as it was. */
export const TASK_CHANGE_DERIVED_KEYS = Object.freeze(['policySha256', 'composition', 'phases', 'templates', 'agents', 'plannedClaims', 'obligationGraph']);
/** What a later step may change when a step goes in before it: its place, what it reads and what it returns to. */
const LATER_STEP_CHANGES = Object.freeze(['order', 'inputs']);
const QUALIFIED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INTENTS = new Set(['requirements', 'design', 'plan', 'review']);

function fail(message, code = 'WFA_AMENDMENT_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

const same = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
export const taskChangeDigest = (value) => `sha256:${recordSha256(value)}`;

/** The resolution's own policy digest, as resolutionPolicySha256 computes it. */
export function taskChangePolicyDigest(resolution) {
  const value = structuredClone(resolution ?? {});
  delete value.policySha256;
  return taskChangeDigest(value);
}

const isString = (value, maximum = 4096) => typeof value === 'string' && value.length > 0 && value.length <= maximum;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());

/** The change entry the composition gains: who asked, or the team's rule and its reason. */
function validChange(change, step) {
  const keys = ['change', 'intent', 'at', 'by', ...(change && Object.hasOwn(change, 'rule') ? ['rule', 'because', 'paths'] : [])];
  return exactKeys(change, keys) && change.change === 'add' && change.intent === step?.intent
    && !Number.isNaN(Date.parse(change.at)) && isString(change.by, 512)
    && (!Object.hasOwn(change, 'rule') || (/^paths\[[0-9]{1,3}\]$/u.test(change.rule) && isString(change.because, 2000)
      && Array.isArray(change.paths) && change.paths.length >= 1 && change.paths.length <= 256 && change.paths.every((file) => isString(file, 4096))));
}

/** The decision record's closed shape; its binding to a revision is checked by the snapshot chain. */
export function validateTaskChangeDecisionRecord(decision) {
  try { readRecord('task-change-decision', decision); }
  catch { fail('The task change decision record has an unsupported version.'); }
  const ok = exactKeys(decision, ['schemaVersion', 'kind', 'id', 'workId', 'status', 'approvedAt', 'by', 'step', 'position',
    'afterPhase', 'change', 'from', 'to', 'addedAssets', 'addedAgents'])
    && decision.kind === 'task-change-decision' && TASK_CHANGE_ID.test(decision.id ?? '') && isString(decision.workId)
    && decision.status === 'applied' && !Number.isNaN(Date.parse(decision.approvedAt)) && isString(decision.by, 512)
    && exactKeys(decision.step, ['id', 'intent', 'label']) && STEP_ID.test(decision.step.id ?? '')
    && INTENTS.has(decision.step.intent) && isString(decision.step.label, 256)
    && Number.isSafeInteger(decision.position) && decision.position >= 1 && STEP_ID.test(decision.afterPhase ?? '')
    && validChange(decision.change, decision.step) && decision.change.at === decision.approvedAt && decision.change.by === decision.by
    && exactKeys(decision.from, ['revision', 'snapshotHash', 'policySha256', 'compositionSha256'])
    && Number.isSafeInteger(decision.from.revision) && decision.from.revision >= 1
    && QUALIFIED_SHA256.test(decision.from.snapshotHash ?? '') && QUALIFIED_SHA256.test(decision.from.policySha256 ?? '')
    && QUALIFIED_SHA256.test(decision.from.compositionSha256 ?? '')
    && exactKeys(decision.to, ['revision', 'policySha256', 'compositionSha256'])
    && decision.to.revision === decision.from.revision + 1 && QUALIFIED_SHA256.test(decision.to.policySha256 ?? '')
    && QUALIFIED_SHA256.test(decision.to.compositionSha256 ?? '')
    && Array.isArray(decision.addedAssets) && decision.addedAssets.length <= 16 && decision.addedAssets.every((id) => isString(id, 256))
    && decision.addedAssets.includes(`template:${decision.step.id}`)
    && Array.isArray(decision.addedAgents) && decision.addedAgents.length <= 8 && decision.addedAgents.every((id) => STEP_ID.test(id ?? ''))
    && same([...decision.addedAssets].sort(), [`template:${decision.step.id}`, ...decision.addedAgents.map((id) => `agent:${id}`)].sort());
  if (!ok) fail('The task change decision record is malformed.');
  return decision;
}

/** The append-only summary a task change leaves on the Story, derived from its decision. */
export function taskChangeSummary(decision, { decisionPath, decisionSha256 }) {
  return { schemaVersion: currentSchemaVersion('task-change-summary'), kind: 'task-change-summary', id: decision.id, status: 'applied',
    change: 'add-step', phaseId: decision.step.id, intent: decision.step.intent, decisionPath, decisionSha256,
    from: structuredClone(decision.from), to: structuredClone(decision.to), decidedAt: decision.approvedAt };
}

export function validateTaskChangeSummary(summary) {
  try { readRecord('task-change-summary', summary); }
  catch { fail('A task change summary has an unsupported version.'); }
  const ok = exactKeys(summary, ['schemaVersion', 'kind', 'id', 'status', 'change', 'phaseId', 'intent', 'decisionPath', 'decisionSha256', 'from', 'to', 'decidedAt'])
    && summary.kind === 'task-change-summary' && TASK_CHANGE_ID.test(summary.id ?? '') && summary.status === 'applied'
    && summary.change === 'add-step' && STEP_ID.test(summary.phaseId ?? '') && INTENTS.has(summary.intent)
    && isString(summary.decisionPath) && QUALIFIED_SHA256.test(summary.decisionSha256 ?? '')
    && Number.isSafeInteger(summary.from?.revision) && summary.to?.revision === summary.from.revision + 1;
  if (!ok) fail('A task change summary is malformed.');
  return summary;
}

/**
 * A step's runtime state as every reader sees it: the Story reader fills `remoteOutputs` in when a record written at
 * the start has none (story-state-normalization.mjs), so a step a change kept compares the same either way.
 */
export function stableTaskStepState(phase) {
  return phase ? { ...phase, remoteOutputs: phase.remoteOutputs ?? [] } : null;
}

/** `before`'s steps with `step` at `position`: the only change a task change makes to the step list. */
export function stepsWithInsertion(steps, step, position) {
  const next = structuredClone(steps ?? []);
  next.splice(position, 0, structuredClone(step));
  return next;
}

/** The composition a rule-driven change may grow: the rule it applied, the step it added and the files that set it off. */
function assertCompositionScope(before, after, decision) {
  if (!before || !after) fail('A task change needs the task\'s composition on both sides.');
  if (taskChangeDigest(before) !== decision.from.compositionSha256 || taskChangeDigest(after) !== decision.to.compositionSha256) {
    fail('A task change does not bind the exact composition it changed.');
  }
  if (!same(after.steps, stepsWithInsertion(before.steps, decision.step, decision.position))) {
    fail('A task change\'s steps are not the task\'s steps with exactly the recorded step added.');
  }
  if (!same(after.changes, [...(before.changes ?? []), decision.change])) fail('A task change does not append exactly its own record to the task\'s changes.');
  // Approvals only rise: a person keeps every step they approved, and may gain one (the new step's, or a step the new
  // step would otherwise hand to SFlow, whose pinned settings stay as they were).
  const addedApprovals = (after.personApproves ?? []).filter((intent) => !(before.personApproves ?? []).includes(intent));
  if (!(before.personApproves ?? []).every((intent) => (after.personApproves ?? []).includes(intent))
      || addedApprovals.some((intent) => !after.steps.some((step) => step.intent === intent))) fail('A task change took an approval from a person.');
  // A step a person approved stays theirs when the new step would hand it to SFlow (personKeeps): it only grows, and only
  // with steps the task already had.
  const kept = (after.personKeeps ?? []).filter((id) => !(before.personKeeps ?? []).includes(id));
  if (!(before.personKeeps ?? []).every((id) => (after.personKeeps ?? []).includes(id))
      || kept.some((id) => id === decision.step.id || !before.steps.some((step) => step.id === id))) fail('A task change changed which steps a person keeps.');
  const rule = Object.hasOwn(decision.change, 'rule') ? decision.change : null;
  if (rule) {
    const added = { intent: decision.step.intent, rule: rule.rule, because: rule.because };
    if (!same(after.added, [...(before.added ?? []), added])) fail('A rule\'s task change does not record exactly the step its rule added.');
    const priorRules = before.rules ?? [];
    if (!same((after.rules ?? []).slice(0, priorRules.length), priorRules)
        || (after.rules ?? []).slice(priorRules.length).some((entry) => entry.rule !== rule.rule)) fail('A rule\'s task change applied another rule.');
    if (!same(before.touchedPaths, after.touchedPaths)) fail('A rule\'s task change changed the files the task started with.');
  } else {
    for (const key of ['added', 'rules', 'touchedPaths']) if (!same(before[key], after[key])) fail(`A person's task change changed the task's ${key}.`);
  }
  const rest = (value) => {
    const copy = structuredClone(value);
    for (const key of ['steps', 'changes', 'personApproves', 'personKeeps', 'added', 'rules', 'touchedPaths']) delete copy[key];
    return copy;
  };
  if (!same(rest(before), rest(after))) fail('A task change changed the task\'s kind or workflow.');
}

/**
 * Throws unless `next` is `previous` with exactly `decision`'s step added: the composition gains it at its place, done
 * steps and the current step are unchanged, later steps change only their place, inputs and returns, the step brings
 * its own template (and any agent it needs), and nothing else in the policy changes. Replayed for every accepted change.
 */
export function assertTaskChangeScope(previous, next, decision) {
  validateTaskChangeDecisionRecord(decision);
  const strip = (value) => {
    const copy = structuredClone(value ?? {});
    for (const key of TASK_CHANGE_DERIVED_KEYS) delete copy[key];
    return copy;
  };
  if (!same(strip(previous), strip(next))) fail('A task change changed the Story\'s policy beyond its steps.');
  if (previous?.policySha256 !== decision.from.policySha256 || next?.policySha256 !== decision.to.policySha256
      || next.policySha256 !== taskChangePolicyDigest(next) || previous.policySha256 !== taskChangePolicyDigest(previous)) {
    fail('A task change does not bind the exact policies on either side of it.');
  }
  assertCompositionScope(previous.composition, next.composition, decision);
  const before = previous.phases ?? [];
  const after = next.phases ?? [];
  const { position, step } = decision;
  const current = before.findIndex((phase) => phase.id === decision.afterPhase);
  if (current < 0 || position <= current || position > before.length || after.length !== before.length + 1) {
    fail('A task change adds its step after the current step, and only there.');
  }
  if (!same(after.map((phase) => phase.id), next.composition.steps.map((entry) => entry.id))
      || !same(before.map((phase) => phase.id), previous.composition.steps.map((entry) => entry.id))) {
    fail('A task change\'s steps differ from its composition.');
  }
  for (let index = 0; index < position; index += 1) {
    if (!same(before[index], after[index])) fail(`A task change changed the step '${before[index].id}' before the one it added.`);
  }
  for (let index = position; index < before.length; index += 1) {
    const prior = structuredClone(before[index]);
    const later = structuredClone(after[index + 1]);
    if (later.order !== index + 1) fail(`A task change gave the step '${prior.id}' the wrong place.`);
    for (const key of LATER_STEP_CHANGES) { delete prior[key]; delete later[key]; }
    if (prior.approval && later.approval) { delete prior.approval.rejectTo; delete later.approval.rejectTo; }
    if (!same(prior, later)) fail(`A task change changed the later step '${before[index].id}' beyond its place, inputs and returns.`);
  }
  const added = after[position];
  if (added?.id !== step.id || added.intent !== step.intent || added.label !== step.label
      || added.order !== position || before.some((phase) => phase.id === step.id)) fail('The added step is not the one the task change records.');
  const templates = structuredClone(next.templates ?? {});
  const template = templates[step.id];
  delete templates[step.id];
  if (!same(templates, previous.templates) || !template || !same(added.templateSnapshot, template)) {
    fail('A task change adds exactly its own step\'s template, and keeps every other.');
  }
  const agents = structuredClone(next.agents ?? {});
  for (const id of decision.addedAgents) {
    if (!agents[id] || Object.hasOwn(previous.agents ?? {}, id)) fail(`A task change's agent '${id}' is not new to the Story.`);
    delete agents[id];
  }
  if (!same(agents, previous.agents)) fail('A task change changed an agent the Story already had.');
}
