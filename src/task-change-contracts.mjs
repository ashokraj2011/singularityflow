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
import { taskStepLabel } from './task-composition.mjs';
import { SingularityFlowError } from './util.mjs';

export const TASK_CHANGE_DIALECT = 'task-step-added/v1';
export const TASK_CHANGE_ID = /^TSC-[0-9]{3,6}$/u;
/** The resolution keys a task change re-derives from its new steps; every other key stays exactly as it was. */
export const TASK_CHANGE_DERIVED_KEYS = Object.freeze(['policySha256', 'composition', 'phases', 'templates', 'agents', 'plannedClaims', 'obligationGraph', 'sourceReview']);
/** What a later step may change when a step goes in before it: its place, what it reads and what it returns to. */
const LATER_STEP_CHANGES = Object.freeze(['order', 'inputs']);
const QUALIFIED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const STEP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// A big change gains its tests step too [ITW:REQ-105, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]; a person adds the first four.
const INTENTS = new Set(['requirements', 'design', 'plan', 'review', 'test']);

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

/**
 * What a task may become [ITW:REQ-014, REQ-015], the only kind changes a task change makes:
 * - a fix whose code changes the data or a public interface is a change, with the plan step it gains (`adds`), recorded
 *   with the files that made it one (`paths`);
 * - a refactor whose new behaviour a person accepted is a change, with no step added: its own plan is revised (the
 *   person's return to it), recorded with the checks whose behaviour changed (`checks`) and that return (`changeRequest`).
 */
export const TASK_GROWTHS = Object.freeze([
  Object.freeze({ from: 'fix', to: 'change', intent: 'plan', adds: true }),
  Object.freeze({ from: 'refactor', to: 'change', intent: 'plan', adds: false }),
  // A small change of another sized kind whose code turns out bigger keeps its kind and gains its plan [ITW:REQ-106].
  ...['chore', 'change', 'feature', 'tests'].map((kind) => Object.freeze({ from: kind, to: kind, intent: 'plan', adds: true }))]);
const growthOf = (change) => TASK_GROWTHS.find((entry) => entry.from === change?.from && entry.to === change?.to && entry.intent === change?.intent) ?? null;
const isGrow = (change) => change?.change === 'grow';
/** Whether a decision adds its step (every change but a kind change that keeps the steps). */
export const addsStep = (decision) => !isGrow(decision?.change) || growthOf(decision.change)?.adds !== false;

/**
 * The label a kind change gives the step it keeps [ITW:REQ-015]: a refactor's "Plan: what must not change" becomes the
 * change's own plan label, in its composition, its pinned step and its state alike, so every reader names the same step.
 * Null for a change that adds a step. A kind change recorded before 2026-11-26 kept the old label, which still replays.
 */
export function keptStepLabel(decision) {
  return addsStep(decision) ? null : taskStepLabel(decision.change.to, decision.step.intent);
}

/** `phase` (a pinned step or a step's state) with the label a kind change gives it, when it is the step the change keeps. */
export function relabeledStep(phase, decision) {
  const label = keptStepLabel(decision);
  return label && phase?.id === decision.step.id ? { ...phase, label } : phase;
}

// The code step's label while a sized task is small; a big one names it as the kind's code step [ITW:REQ-105].
const SMALL_CODE_LABELS = new Set(['Implement and test', 'Write and run the tests']);
/** A step of a sized task as a big change names it: its code step "Code" (or "Write the tests") beside its tests step. */
export function bigShapeStep(step, kind) {
  return step?.intent === 'code' && SMALL_CODE_LABELS.has(step.label) ? { ...step, label: taskStepLabel(kind, 'code') } : step;
}
/** Whether a change to a sized task names its later code step as a big change's (`before`: the composition it changes). */
const relabelsCode = (before, decision) => before?.sizing === 'requirement'
  && (decision.change?.shape === 'big' || isGrow(decision.change) || (before.steps ?? []).some((step) => step.intent === 'plan'));

/**
 * The change entry the composition gains: who asked, the team's rule and its reason (a `paths` rule for the files the
 * code changed, or an `always` rule of the kind a fix became), a fix grown into a change with why and the files, or a
 * step of a big change with why it is big (`shape`).
 */
function validChange(change, step) {
  const paths = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 256 && value.every((file) => isString(file, 4096));
  const timed = change && !Number.isNaN(Date.parse(change.at)) && isString(change.by, 512) && change.intent === step?.intent;
  if (isGrow(change)) {
    const growth = growthOf(change);
    return Boolean(growth) && timed && isString(change.because, 2000) && (growth.adds
      ? exactKeys(change, ['change', 'intent', 'at', 'by', 'from', 'to', 'because', 'paths']) && paths(change.paths)
      : exactKeys(change, ['change', 'intent', 'at', 'by', 'from', 'to', 'because', 'checks', 'changeRequest']) && paths(change.checks)
        && /^CR-[0-9]{3,6}$/u.test(change.changeRequest ?? ''));
  }
  if (change && Object.hasOwn(change, 'shape')) {
    return exactKeys(change, ['change', 'intent', 'at', 'by', 'shape', 'because']) && change.change === 'add' && change.shape === 'big'
      && timed && isString(change.because, 2000);
  }
  const keys = ['change', 'intent', 'at', 'by', ...(change && Object.hasOwn(change, 'rule') ? ['rule', 'because', 'paths'] : [])];
  return exactKeys(change, keys) && change.change === 'add' && change.intent !== 'test' && timed
    && (!Object.hasOwn(change, 'rule') || (/^(?:paths|always)\[[0-9]{1,3}\]$/u.test(change.rule) && isString(change.because, 2000) && paths(change.paths)));
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
    && Array.isArray(decision.addedAgents) && decision.addedAgents.length <= 8 && decision.addedAgents.every((id) => STEP_ID.test(id ?? ''))
    // A kind change that keeps the steps brings nothing; a step added brings its template and the agents it needs.
    && (addsStep(decision) ? decision.addedAssets.includes(`template:${decision.step.id}`)
      && same([...decision.addedAssets].sort(), [`template:${decision.step.id}`, ...decision.addedAgents.map((id) => `agent:${id}`)].sort())
      : !decision.addedAssets.length && !decision.addedAgents.length);
  if (!ok) fail('The task change decision record is malformed.');
  return decision;
}

/** The append-only summary a task change leaves on the Story, derived from its decision. */
export function taskChangeSummary(decision, { decisionPath, decisionSha256 }) {
  return { schemaVersion: currentSchemaVersion('task-change-summary'), kind: 'task-change-summary', id: decision.id, status: 'applied',
    change: addsStep(decision) ? 'add-step' : 'kind', phaseId: decision.step.id, intent: decision.step.intent, decisionPath, decisionSha256,
    from: structuredClone(decision.from), to: structuredClone(decision.to), decidedAt: decision.approvedAt };
}

export function validateTaskChangeSummary(summary) {
  try { readRecord('task-change-summary', summary); }
  catch { fail('A task change summary has an unsupported version.'); }
  const ok = exactKeys(summary, ['schemaVersion', 'kind', 'id', 'status', 'change', 'phaseId', 'intent', 'decisionPath', 'decisionSha256', 'from', 'to', 'decidedAt'])
    && summary.kind === 'task-change-summary' && TASK_CHANGE_ID.test(summary.id ?? '') && summary.status === 'applied'
    && ['add-step', 'kind'].includes(summary.change) && STEP_ID.test(summary.phaseId ?? '') && INTENTS.has(summary.intent)
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
  const adds = addsStep(decision);
  const kept = adds ? null : before.steps.map((step) => relabeledStep(step, decision));
  const inserted = adds ? stepsWithInsertion(before.steps, decision.step, decision.position)
    .map((step, index) => (index > decision.position && relabelsCode(before, decision) ? bigShapeStep(step, after.kind) : step)) : null;
  if (!(adds ? same(after.steps, inserted) : same(after.steps, kept) || same(after.steps, before.steps))
      || (!adds && !same(before.steps[decision.position], decision.step))) {
    fail(adds ? 'A task change\'s steps are not the task\'s steps with exactly the recorded step added.' : 'A kind change changed the task\'s steps.');
  }
  if (!same(after.changes, [...(before.changes ?? []), decision.change])) fail('A task change does not append exactly its own record to the task\'s changes.');
  // Approvals only rise: a person keeps every step they approved, and may gain the new step's (a rule gives it to them), or
  // keep a step the new step would otherwise hand to SFlow (personKeeps, below), whose pinned settings stay as they were.
  const addedApprovals = (after.personApproves ?? []).filter((intent) => !(before.personApproves ?? []).includes(intent));
  if (!(before.personApproves ?? []).every((intent) => (after.personApproves ?? []).includes(intent))) fail('A task change took an approval from a person.');
  if (addedApprovals.some((intent) => !adds || intent !== decision.step.intent)) fail('A task change gave a person the approval of a step it did not add.');
  // A step a person approved stays theirs when the new step would hand it to SFlow (personKeeps): it only grows, and only
  // with steps the task already had.
  // So does a step that wrote the requirement IDs before the new step took that role (clauseKeeps).
  for (const key of ['personKeeps', 'clauseKeeps']) {
    const kept = (after[key] ?? []).filter((id) => !(before[key] ?? []).includes(id));
    if (!(before[key] ?? []).every((id) => (after[key] ?? []).includes(id))
        || (kept.length && !adds) || kept.some((id) => id === decision.step.id || !before.steps.some((step) => step.id === id))) {
      fail(key === 'personKeeps' ? 'A task change changed which steps a person keeps.' : 'A task change changed which steps keep the requirement IDs.');
    }
  }
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
  // A grown fix is a change from here on: its kind moves exactly as the change says, and only then [ITW:REQ-014].
  const grown = isGrow(decision.change) ? growthOf(decision.change) : null;
  if (grown ? before.kind !== grown.from || after.kind !== grown.to : before.kind !== after.kind) fail('A task change changed the task\'s kind.');
  const rest = (value) => {
    const copy = structuredClone(value);
    for (const key of ['kind', 'steps', 'changes', 'personApproves', 'personKeeps', 'clauseKeeps', 'added', 'rules', 'touchedPaths']) delete copy[key];
    return copy;
  };
  if (!same(rest(before), rest(after))) fail('A task change changed the task\'s kind or workflow.');
}

/**
 * The review policy a task change may change [ITW:REQ-105, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]: none at all, or the
 * step it adds reviewed as the Story's other authored steps are (a document or a code review), so SFlow can approve it when
 * its reviewer says ready. Every other part of the policy stays exactly as it was.
 */
function assertReviewScope(previous, next, decision) {
  const before = previous?.sourceReview ?? null;
  const after = next?.sourceReview ?? null;
  if (same(before, after)) return;
  const id = decision.step.id;
  const rest = (policy) => { const copy = structuredClone(policy ?? {}); delete copy.phases; delete copy.kinds; return copy; };
  const others = (policy) => Object.fromEntries(Object.entries(policy?.kinds ?? {}).filter(([phase]) => phase !== id));
  const grown = addsStep(decision) && before?.mode === 'enforce' && after?.mode === 'enforce' && !(before.phases ?? []).includes(id)
    && (after.phases ?? []).includes(id) && same((after.phases ?? []).filter((phase) => phase !== id), before.phases ?? [])
    && same(others(after), before.kinds ?? {}) && ['document', 'code'].includes(after.kinds?.[id]) && same(rest(before), rest(after));
  if (!grown) fail('A task change changed the Story\'s review policy beyond reviewing the step it added.');
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
  assertReviewScope(previous, next, decision);
  if (previous?.policySha256 !== decision.from.policySha256 || next?.policySha256 !== decision.to.policySha256
      || next.policySha256 !== taskChangePolicyDigest(next) || previous.policySha256 !== taskChangePolicyDigest(previous)) {
    fail('A task change does not bind the exact policies on either side of it.');
  }
  assertCompositionScope(previous.composition, next.composition, decision);
  const before = previous.phases ?? [];
  const after = next.phases ?? [];
  // A kind change that keeps the steps keeps every pinned step, template and agent exactly as they were, but the label it
  // gives the step it keeps.
  if (!addsStep(decision)) {
    const relabeled = same(next.composition.steps, previous.composition.steps) ? before : before.map((phase) => relabeledStep(phase, decision));
    if (!same(relabeled, after) || !['templates', 'agents', 'plannedClaims', 'obligationGraph'].every((key) => same(previous[key], next[key]))
        || !before.some((phase) => phase.id === decision.afterPhase)) fail('A kind change changed the Story\'s steps.');
    return;
  }
  const { position, step } = decision;
  const current = before.findIndex((phase) => phase.id === decision.afterPhase);
  // A grown fix's plan goes where a plan goes, before the code step that is current (its code waits for approval, and is
  // returned to the plan next); every other added step goes after the current step.
  const earliest = isGrow(decision.change) ? current : current + 1;
  if (current < 0 || position < earliest || position > before.length || after.length !== before.length + 1) {
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
    // A sized task's code step is named as a big change's, and only that [ITW:REQ-105]. A pinned step carries no intent:
    // the composition says which is the code step.
    const coded = (previous.composition?.steps ?? []).some((step) => step.id === prior.id && step.intent === 'code');
    if (relabelsCode(previous.composition, decision) && coded && bigShapeStep({ ...prior, intent: 'code' }, next.composition.kind).label === later.label) {
      delete prior.label; delete later.label;
    }
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
