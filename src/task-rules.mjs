/**
 * The Rules place [FPL:REQ-019 to REQ-026, docs/SPEC-FPL-FOUR-PLACES-v1.md §3.4]: the team's `tasks:` rules in plain when
 * and then, the changes Workflow Studio makes to them, what a change would do to each kind of task, and the check every
 * way of changing them runs.
 *
 * Rules only add: a step, or a person's approval of a step, or (for one kind) a workflow followed as it is. Built-in and
 * custom workflows run as they are [owner, 2026-11-26]; nothing here changes how a chosen workflow's steps run.
 *
 * - `rulesRead(root)`: `rules --json` (`sflow-rules`): the built-in rules, every rule of the approved configuration as when
 *   and then with its because, the proposals waiting for review that change them, the ID prefix, how a task is composed,
 *   and the guidance lines (lessons, tasks in flight). It writes nothing.
 * - `applyTaskRuleChange(document, change)`: the `tasks.*` Studio operations, written into workflow.yml's YAML document in
 *   place, so its formatting and comments stay [FPL:REQ-022]. A rule written here gets an `id` [FPL:REQ-024].
 * - `taskRuleChecks(before, after)`: every problem of the rules after a change, each with its field; one in a rule the change
 *   adds or changes, or one the change brings, refuses it, and one already there in a rule it did not touch is a warning,
 *   so an approved configuration never turns red [FPL:REQ-023]. Studio, `configuration save` and `configuration approve`
 *   run it; `workflow check` reports every problem.
 * - `previewRuleChanges(definition, text, changeSet)`: `rules preview` [FPL:REQ-021]: every kind composed with and without
 *   the change, in memory, with no marketplace and no network.
 */
import YAML from 'yaml';

import {
  approvalWords, checkTaskRules, composeTask, INTENT_ORDER, isTaskWorkType, kindSteps, pathMatches, TASK_KINDS, TASK_RULE_ID, taskDefinition, taskRuleName,
  taskStepLabel
} from './task-composition.mjs';
import { SingularityFlowError } from './util.mjs';

export const RULES_RESULT = 'sflow-rules';
export const RULES_PREVIEW_RESULT = 'sflow-rules-preview';
export const TASK_RULE_OPERATIONS = Object.freeze(['tasks.rule.add', 'tasks.rule.change', 'tasks.rule.remove', 'tasks.idPrefix.set']);
/** The steps a rule can add, as the form offers them [FPL:REQ-020]. */
export const RULE_STEPS = Object.freeze(['requirements', 'design', 'plan', 'review', 'test']);

const KIND_NOUN = Object.freeze({ fix: 'a fix', feature: 'a feature', change: 'a change', refactor: 'a refactor', tests: 'a tests task',
  docs: 'a document task', investigate: 'an investigation', review: 'a review', chore: 'a chore' });
const STEP_NOUN = Object.freeze({ intake: 'an intake', requirements: 'a requirements step', design: 'a design step', plan: 'a plan', code: 'a code step',
  test: 'tests', review: 'a review' });
const APPROVES_NOUN = Object.freeze({ intake: 'the intake', requirements: 'the requirements', design: 'the design', plan: 'the plan', code: 'the code',
  test: 'the test results', review: 'the review' });
const RULES_ROUTE = Object.freeze({ command: 'singularity-flow rules', label: 'See the team\'s rules and each problem with where it is.' });

const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);
const joined = (items, word) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}`);
const listOf = (value, fallback = []) => (value === undefined || value === null ? fallback : Array.isArray(value) ? value : [value]);
const stable = (value) => JSON.stringify(value ?? null, (key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((name) => [name, entry[name]])) : entry));

function refusal(code, message, details = {}) {
  return new SingularityFlowError(message, { code, details: { nextAction: RULES_ROUTE, ...details } });
}

// ---------------------------------------------------------------------------------------------------- words

/** Who a rule is about: "any code changes", "a task is a fix or a change", "a task touches src/auth/**". */
export function whenWords({ section, kinds = ['all'], paths = [], kind = null }) {
  if (section === 'use') return `a task is ${KIND_NOUN[kind] ?? kind}`;
  const all = !kinds.length || kinds.includes('all');
  const who = all ? 'a task' : joined(kinds.map((entry) => KIND_NOUN[entry] ?? entry), 'or');
  if (section === 'paths') return `${who} touches ${joined(paths.map(String), 'or')}`;
  return all ? 'any code changes' : `a task is ${who}`;
}

/** What a rule does: "add a review", "a person approves the code", "follow the workflow Classic delivery". */
export function thenWords({ section, steps = [], personApproves = [], workflow = null }, labelOf = (id) => id) {
  if (section === 'use') return `follow the workflow ${labelOf(workflow)}`;
  const parts = [];
  if (steps.length) parts.push(`add ${joined(steps.map((intent) => STEP_NOUN[intent] ?? intent), 'and')}`);
  if (personApproves.length) parts.push(`a person approves ${joined(personApproves.map((intent) => APPROVES_NOUN[intent] ?? intent), 'and')}`);
  return parts.length ? parts.join(', and ') : 'add nothing';
}

/** The three rules SFlow keeps for every task; they have no Change (ITW §9, question 3) [FPL:REQ-019]. */
export const BUILT_IN_RULES = Object.freeze([
  { id: 'built-in-tests', when: 'any code changes', then: 'add tests', because: 'Every code change gets a test step; "skip the tests" is refused.' },
  { id: 'built-in-code-approval', when: 'a task changes code', then: 'a person approves the code', because: 'What a task delivers is approved by a person.' },
  { id: 'built-in-plan-approval', when: 'a task has a plan', then: 'a person approves the plan', because: 'A plan is approved by a person before its code is written.' }
].map((rule) => Object.freeze({ ...rule, builtIn: true, words: `When ${rule.when}: ${rule.then}.` })));

/** One rule as written, in plain when and then, with what the form needs to change it. */
function ruleView(entry, { section, index = null, kind = null, labelOf }) {
  if (section === 'use') {
    const spelled = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { workflow: entry };
    const name = typeof spelled.id === 'string' && spelled.id ? spelled.id : `use.${kind}`;
    const fields = { kinds: [kind], paths: [], steps: [], personApproves: [], workflow: spelled.workflow ?? null };
    const because = typeof spelled.because === 'string' && spelled.because.trim() ? spelled.because.trim()
      : `This team runs every ${kind} task as the ${labelOf(spelled.workflow)} workflow.`;
    const when = whenWords({ section, kind });
    const then = thenWords({ section, workflow: spelled.workflow }, labelOf);
    return { id: name, ruleId: spelled.id ?? null, section, kind, when, then, because, words: `When ${when}: ${then}.`, fields };
  }
  const fields = { kinds: listOf(entry?.kinds, ['all']).map(String), paths: section === 'paths' ? listOf(entry?.paths).map(String) : [],
    steps: listOf(entry?.steps).map(String), personApproves: listOf(entry?.personApproves).map(String), workflow: null };
  const when = whenWords({ section, ...fields });
  const then = thenWords({ section, ...fields });
  return { id: taskRuleName(entry, section, index), ruleId: typeof entry?.id === 'string' ? entry.id : null, section, index, when, then,
    because: typeof entry?.because === 'string' ? entry.because.trim() : '', words: `When ${when}: ${then}.`, fields };
}

/** Every rule of a `tasks:` section as written, broken ones too (each with its problems). */
export function ruleViews(tasks, { labelOf = (id) => id, problems = [] } = {}) {
  const views = [];
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return views;
  for (const section of ['always', 'paths']) {
    const list = Array.isArray(tasks[section]) ? tasks[section] : [];
    list.forEach((entry, index) => views.push(ruleView(entry, { section, index, labelOf })));
  }
  if (tasks.use && typeof tasks.use === 'object' && !Array.isArray(tasks.use)) {
    for (const [kind, value] of Object.entries(tasks.use)) views.push(ruleView(value, { section: 'use', kind, labelOf }));
  }
  return views.map((view) => ({ ...view, problems: problems.filter((problem) => problemOf(problem, view)).map(({ field, message }) => ({ field, message })) }));
}

const problemOf = (problem, view) => (view.section === 'use' ? problem.section === 'use' && problem.kind === view.kind
  : problem.section === view.section && problem.index === view.index);

// ---------------------------------------------------------------------------------------------------- changes

/** A rule as the change set sends it, and the section it belongs in. */
function ruleInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw refusal('TASK_RULE_CHANGE_INVALID', 'A rule names when it applies, what it adds and why: kinds or paths, steps, personApproves or workflow, and because.');
  }
  const rule = {
    kinds: listOf(value.kinds, ['all']).map(String), paths: listOf(value.paths).map((glob) => String(glob).trim()).filter(Boolean),
    steps: listOf(value.steps).map(String), personApproves: listOf(value.personApproves).map(String),
    workflow: value.workflow == null || value.workflow === '' ? null : String(value.workflow), because: String(value.because ?? '').replace(/\s+/gu, ' ').trim(),
    id: value.id == null || value.id === '' ? null : String(value.id)
  };
  const section = rule.workflow ? 'use' : rule.paths.length ? 'paths' : 'always';
  if (section === 'use') {
    const kinds = rule.kinds.filter((kind) => kind !== 'all');
    if (kinds.length !== 1 || rule.kinds.length !== 1 || rule.paths.length || rule.steps.length || rule.personApproves.length) {
      throw refusal('TASK_RULE_CHANGE_INVALID', 'A rule that follows a workflow is about one kind of task, and adds nothing else: choose one kind, and the workflow.');
    }
  }
  return { rule, section };
}

/** The YAML a rule is written as: `kinds`, `paths` and `steps` as flow lists, as the tasks topic shows them. */
function ruleNode(document, rule, section) {
  if (section === 'use') return document.createNode({ workflow: rule.workflow, because: rule.because, ...(rule.id ? { id: rule.id } : {}) });
  const all = rule.kinds.length === 1 && rule.kinds[0] === 'all';
  const node = document.createNode({ ...(rule.id ? { id: rule.id } : {}), ...(all ? {} : { kinds: rule.kinds }),
    ...(section === 'paths' ? { paths: rule.paths } : {}), ...(rule.steps.length ? { steps: rule.steps } : {}),
    ...(rule.personApproves.length ? { personApproves: rule.personApproves } : {}), because: rule.because });
  for (const pair of node.items) if (YAML.isSeq(pair.value)) pair.value.flow = true;
  return node;
}

/** Every rule ID in `tasks:` as written. */
function ruleIds(tasks) {
  const ids = new Set();
  for (const section of ['always', 'paths']) for (const entry of listOf(tasks?.[section])) if (typeof entry?.id === 'string') ids.add(entry.id);
  for (const value of Object.values(tasks?.use && typeof tasks.use === 'object' ? tasks.use : {})) if (typeof value?.id === 'string') ids.add(value.id);
  return ids;
}

/** A rule's ID from its when and then [FPL:REQ-024]: "fix-change-touching-src-billing-adds-review", its own in this file. */
export function ruleSlug(rule, taken = new Set()) {
  const words = [];
  const kinds = rule.kinds.filter((kind) => kind !== 'all');
  words.push(...kinds);
  if (rule.paths.length) words.push('touching', ...String(rule.paths[0]).split(/[^A-Za-z0-9]+/u).filter(Boolean).slice(0, 4));
  if (rule.workflow) words.push('follows', rule.workflow);
  if (rule.steps.length) words.push('adds', ...rule.steps);
  if (rule.personApproves.length) words.push('person', 'approves', ...rule.personApproves);
  const base = (words.join('-').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'rule').slice(0, 56).replace(/-+$/u, '');
  let id = base;
  for (let number = 2; taken.has(id); number += 1) id = `${base}-${number}`;
  return id;
}

/** Where a rule is: by its `id`, or by its place (`always[0]`, `paths[1]`, `use.change`). */
export function findTaskRule(tasks, reference) {
  const wanted = String(reference ?? '').trim();
  if (!wanted || !tasks || typeof tasks !== 'object') return null;
  for (const section of ['always', 'paths']) {
    const list = Array.isArray(tasks[section]) ? tasks[section] : [];
    const index = list.findIndex((entry, at) => entry?.id === wanted || `${section}[${at}]` === wanted);
    if (index >= 0) return { section, index, entry: list[index] };
  }
  for (const [kind, value] of Object.entries(tasks.use && typeof tasks.use === 'object' ? tasks.use : {})) {
    if (value?.id === wanted || `use.${kind}` === wanted) return { section: 'use', kind, entry: value };
  }
  return null;
}

function removeAt(document, place) {
  if (place.section === 'use') document.deleteIn(['tasks', 'use', place.kind]);
  else document.deleteIn(['tasks', place.section, place.index]);
  const tasks = document.toJS()?.tasks ?? {};
  for (const section of ['always', 'paths', 'use']) {
    const value = tasks[section];
    if (value !== undefined && (Array.isArray(value) ? !value.length : value && typeof value === 'object' && !Object.keys(value).length)) document.deleteIn(['tasks', section]);
  }
  const left = document.toJS()?.tasks;
  if (left && typeof left === 'object' && !Object.keys(left).length) document.deleteIn(['tasks']);
}

function addAt(document, rule, section, tasks) {
  if (section === 'use') {
    const kind = rule.kinds[0];
    if (tasks?.use && typeof tasks.use === 'object' && Object.hasOwn(tasks.use, kind)) {
      throw refusal('TASK_RULE_EXISTS', `A rule already says how every ${kind} task runs; change that rule instead.`,
        { nextAction: { command: 'singularity-flow rules', label: `See the rule for ${kind} tasks, and change it in the Rules place.` } });
    }
    document.setIn(['tasks', 'use', kind], ruleNode(document, rule, section));
    return;
  }
  const node = ruleNode(document, rule, section);
  if (Array.isArray(tasks?.[section])) { document.addIn(['tasks', section], node); return; }
  const list = new YAML.YAMLSeq();
  list.items.push(node);
  document.setIn(['tasks', section], list);
}

/**
 * One `tasks.*` operation on workflow.yml's YAML document [FPL:REQ-022]: written in place, so the file keeps its formatting.
 * Returns the summary line. A problem in what it writes is the check's to name with its field (taskRuleChecks), so a form's
 * every problem is said at once; this refuses only what it cannot write.
 */
export function applyTaskRuleChange(document, change, { labelOf = (id) => id } = {}) {
  const tasks = document.toJS()?.tasks;
  if (change.op === 'tasks.idPrefix.set') {
    const value = String(change.idPrefix ?? '').trim();
    document.setIn(['tasks', 'idPrefix'], value);
    return `Tasks are named ${value}-<n> from now on; tasks already started keep their IDs.`;
  }
  if (change.op === 'tasks.rule.add') {
    const { rule, section } = ruleInput(change.rule);
    rule.id ??= ruleSlug(rule, ruleIds(tasks));
    addAt(document, rule, section, tasks);
    return `Rule ${rule.id} added: when ${whenWords({ section, ...rule, kind: rule.kinds[0] })}, ${thenWords({ section, ...rule }, labelOf)}.`;
  }
  const place = findTaskRule(tasks, change.id);
  if (!place) {
    throw refusal('TASK_RULE_UNKNOWN', `There is no team rule '${String(change.id ?? '')}' in the configuration this change is made on. Read the rules again; another change may have moved it.`);
  }
  if (change.op === 'tasks.rule.remove') {
    removeAt(document, place);
    return `Rule ${change.id} removed: tasks started after this is approved no longer get what it added.`;
  }
  if (change.op === 'tasks.rule.change') {
    const { rule, section } = ruleInput(change.rule);
    const others = ruleIds(tasks);
    if (typeof place.entry?.id === 'string') others.delete(place.entry.id);
    rule.id ??= typeof place.entry?.id === 'string' ? place.entry.id : ruleSlug(rule, others);
    if (section === place.section && section !== 'use') document.setIn(['tasks', section, place.index], ruleNode(document, rule, section));
    else if (section === 'use' && place.section === 'use' && place.kind === rule.kinds[0]) document.setIn(['tasks', 'use', place.kind], ruleNode(document, rule, section));
    else { removeAt(document, place); addAt(document, rule, section, document.toJS()?.tasks); }
    return `Rule ${rule.id} changed: when ${whenWords({ section, ...rule, kind: rule.kinds[0] })}, ${thenWords({ section, ...rule }, labelOf)}.`;
  }
  throw refusal('STUDIO_CHANGE_UNKNOWN', `Unknown task rule change '${change.op}'. A rule change is one of ${TASK_RULE_OPERATIONS.join(', ')}.`);
}

// ---------------------------------------------------------------------------------------------------- the check

/** A problem as a refusal or a warning lists it: what, and where in workflow.yml. */
export const taskProblemLine = (problem) => `${problem.message} (${problem.field})`;

/**
 * Every problem of the rules `after` a change, against `before` [FPL:REQ-023]. `refused`: a problem in a rule the change
 * adds or changes, or one it brings (a workflow a `use` rule names, removed); `warnings`: one already there in a rule the
 * change left as it was. Each keeps its field. `before` and `after` are definitions (or workflow.yml as parsed).
 */
export function taskRuleChecks(before, after) {
  const was = checkTaskRules(before ?? {}).problems;
  const now = checkTaskRules(after ?? {}).problems;
  const key = (problem) => stable([problem.section ?? problem.field, problem.kind ?? null, problem.rule ?? null,
    String(problem.message).replace(/\[\d+\]/gu, '[]')]);
  const seen = new Set(was.map(key));
  const tasksBefore = before?.tasks && typeof before.tasks === 'object' ? before.tasks : {};
  const tasksAfter = after?.tasks && typeof after.tasks === 'object' ? after.tasks : {};
  const written = (section) => new Set(listOf(Array.isArray(tasksBefore[section]) ? tasksBefore[section] : []).map(stable));
  const lists = { always: written('always'), paths: written('paths') };
  const touched = (problem) => {
    if (problem.section === 'always' || problem.section === 'paths') return !lists[problem.section].has(stable(problem.rule));
    if (problem.section === 'use') return stable(tasksBefore.use?.[problem.kind]) !== stable(problem.rule);
    const top = String(problem.field).split('.')[1] ?? null;
    return top ? stable(tasksBefore[top]) !== stable(tasksAfter[top]) : stable(before?.tasks) !== stable(after?.tasks);
  };
  const refused = now.filter((problem) => touched(problem) || !seen.has(key(problem)));
  return {
    refused: refused.map(({ code, field, message }) => ({ code, field, message })),
    warnings: now.filter((problem) => !refused.includes(problem)).map(({ code, field, message }) => ({ code, field, message }))
  };
}

/** The refusal for problems a change brings to the team's rules: every one, with where it is. */
export function taskRulesRefusal(refused, { what, code, nextAction = RULES_ROUTE }) {
  return new SingularityFlowError(`${what}: the team's task rules would have ${refused.length === 1 ? 'a problem' : `${refused.length} problems`}. Nothing was changed.\n`
    + refused.map((problem) => `- ${taskProblemLine(problem)}`).join('\n'), { code, details: { problems: refused, nextAction } });
}

// ---------------------------------------------------------------------------------------------------- what a change adds

/** A file a glob names, for the preview's "a fix touching src/billing/x.ts". */
export function samplePath(glob) {
  const text = String(glob).replace(/^\.\//u, '');
  const sample = text.replace(/\*\*\//gu, '').replace(/\*\*/gu, 'x.ts').replace(/\*/gu, 'x').replace(/\?/gu, 'x');
  return pathMatches(text, sample) ? sample : text;
}

function composed(definition, rules, kind, touchedPaths) {
  try { return composeTask(definition, { kind, touchedPaths, rules }); } catch (error) { return { error: error.message }; }
}

const intentsOf = (composition) => (composition.error ? null : composition.steps.map((step) => step.intent));
const sameComposition = (left, right) => stable([left.error ?? null, left.workType, intentsOf(left), left.personApproves])
  === stable([right.error ?? null, right.workType, intentsOf(right), right.personApproves]);

/** Who approves each step of a composition, as the plan line says it; '' when SFlow cannot resolve it here. */
async function approvalSentence(definition, composition) {
  try {
    const { resolveWorkType, validateDefinition } = await import('./config.mjs');
    const resolved = resolveWorkType(validateDefinition(structuredClone(taskDefinition(definition, composition))), composition.workType);
    const approvals = Object.fromEntries(resolved.phases.map((phase) => [phase.id,
      phase.approval?.mode === 'none' ? 'none' : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person']));
    return approvalWords(composition, approvals);
  } catch { return ''; }
}

/**
 * What a change to the team's rules does to each kind of task [FPL:REQ-021]: every kind composed with the rules before and
 * after, for no files and for a file each changed `paths` rule is about; one line per kind and file that changes, the added
 * steps marked, and for a removed rule each step it stops adding. Pure but for reading the definition it is given.
 */
export async function ruleChangeLines(definition, afterTasks) {
  const before = checkTaskRules(definition).rules;
  const afterDefinition = { ...definition, tasks: afterTasks };
  const after = checkTaskRules(afterDefinition).rules;
  const globs = new Set();
  const changedPaths = (left, right) => {
    const kept = new Set(left.map((rule) => stable({ ...rule, name: null, id: null })));
    for (const rule of right) if (!kept.has(stable({ ...rule, name: null, id: null }))) for (const glob of rule.paths ?? []) globs.add(glob);
  };
  changedPaths(before.paths, after.paths);
  changedPaths(after.paths, before.paths);
  const situations = [null, ...[...globs].sort().map(samplePath)];
  const lines = [];
  for (const kind of TASK_KINDS) {
    for (const touching of situations) {
      const files = touching ? [touching] : [];
      const was = composed(definition, before, kind, files);
      const now = composed(afterDefinition, after, kind, files);
      if (sameComposition(was, now)) continue;
      const subject = capital(`${KIND_NOUN[kind]}${touching ? ` touching ${touching}` : ''}`);
      if (now.error) { lines.push({ kind, touching, words: `${subject}: cannot be composed after this change. ${now.error}`, refused: true }); continue; }
      const wasIntents = intentsOf(was) ?? [];
      const added = now.steps.filter((step) => !wasIntents.includes(step.intent)).map((step) => step.label);
      const removed = (was.steps ?? []).filter((step) => !intentsOf(now).includes(step.intent)).map((step) => step.label);
      const path = now.steps.map((step) => (wasIntents.includes(step.intent) || was.error ? step.label : `${step.label} (added)`)).join(' → ');
      const approves = await approvalSentence(afterDefinition, now);
      const from = now.uses ? ` It follows the workflow ${definition.workTypes?.[now.uses]?.label ?? now.uses}, as it is.` : '';
      lines.push({ kind, touching, before: (was.steps ?? []).map((step) => step.label), after: now.steps.map((step) => step.label), added, removed,
        words: `${subject}: ${path}.${approves}${from}${removed.length ? ` No longer adds ${joined(removed, 'and')}.` : ''}` });
    }
  }
  return lines;
}

/**
 * `rules preview --change-set -` [FPL:REQ-021]: a Studio change set of `tasks.*` operations applied to workflow.yml's text in
 * memory, every problem with its field, and what it does to each kind. `definition` is the configuration it is made on.
 */
export async function previewRuleChanges(definition, text, changeSet) {
  const problems = [];
  if (!changeSet || typeof changeSet !== 'object' || !Array.isArray(changeSet.changes)) {
    throw refusal('TASK_RULE_CHANGE_INVALID', 'A rules preview reads a Studio change set: {"schema":"sflow-studio-change-set@1","changes":[{"op":"tasks.rule.add",…}]}.');
  }
  const document = YAML.parseDocument(String(text ?? ''));
  const labelOf = (id) => definition.workTypes?.[id]?.label ?? id;
  const summary = [];
  for (const change of changeSet.changes) {
    if (!TASK_RULE_OPERATIONS.includes(change?.op)) {
      problems.push({ code: 'TASK_RULE_CHANGE_INVALID', field: 'changes', message: `A rules preview takes only ${TASK_RULE_OPERATIONS.join(', ')}; '${change?.op}' is Workflow Studio's to preview.` });
      continue;
    }
    try { summary.push(applyTaskRuleChange(document, change, { labelOf })); }
    catch (error) { problems.push({ code: error.code ?? 'TASK_RULE_CHANGE_INVALID', field: change.id ? String(change.id) : 'tasks', message: error.message }); }
  }
  const afterTasks = document.toJS()?.tasks;
  const { refused, warnings } = taskRuleChecks(definition, { ...definition, tasks: afterTasks });
  const lines = problems.length || refused.length ? [] : await ruleChangeLines(definition, afterTasks);
  const changes = lines.length;
  return {
    schemaVersion: 1, resultType: RULES_PREVIEW_RESULT, valid: !problems.length && !refused.length,
    problems: [...problems, ...refused], warnings, summary, lines,
    others: problems.length || refused.length ? null : changes ? 'No other kind changes.' : 'No kind of task changes.'
  };
}

// ---------------------------------------------------------------------------------------------------- the read

/** How a proposal changes the team's rules, or null [FPL:REQ-019]: rules added, changed and removed, and the ID prefix. */
export function taskRulesChange(beforeRaw, afterRaw) {
  const tasksBefore = beforeRaw?.tasks ?? null;
  const tasksAfter = afterRaw?.tasks ?? null;
  if (stable(tasksBefore) === stable(tasksAfter)) return null;
  const labelOf = (id) => afterRaw?.workTypes?.[id]?.label ?? beforeRaw?.workTypes?.[id]?.label ?? id;
  const viewsBefore = ruleViews(tasksBefore, { labelOf });
  const viewsAfter = ruleViews(tasksAfter, { labelOf });
  const content = (view) => stable([view.section, view.fields, view.because]);
  const changes = [];
  for (const view of viewsAfter) {
    if (viewsBefore.some((other) => content(other) === content(view))) continue;
    const earlier = viewsBefore.find((other) => other.ruleId && other.ruleId === view.ruleId);
    changes.push({ change: earlier ? 'changed' : 'added', id: view.id, words: view.words, because: view.because });
  }
  for (const view of viewsBefore) {
    if (viewsAfter.some((other) => content(other) === content(view) || (view.ruleId && other.ruleId === view.ruleId))) continue;
    changes.push({ change: 'removed', id: view.id, words: view.words, because: view.because });
  }
  const prefix = (raw) => (raw && typeof raw === 'object' ? raw.idPrefix ?? 'TASK' : 'TASK');
  return { changes, ...(prefix(tasksBefore) !== prefix(tasksAfter) ? { idPrefix: { before: prefix(tasksBefore), after: prefix(tasksAfter) } } : {}) };
}

/** How a proposal's change to the rules is said: "Proposed by Priya: add the rule When … ." */
function waitingView(proposal) {
  const change = proposal.taskRules;
  const lines = (change.changes ?? []).map((entry) => `${entry.change === 'added' ? 'Adds' : entry.change === 'removed' ? 'Removes' : 'Changes'}: ${entry.words}`);
  if (change.idPrefix) lines.push(`Name tasks ${change.idPrefix.after}-<n> instead of ${change.idPrefix.before}-<n>`);
  return { branch: proposal.branch, proposer: typeof proposal.proposer?.name === 'string' ? proposal.proposer.name : null, changes: change.changes ?? [],
    lines, words: `Waiting for review${proposal.proposer?.name ? `, proposed by ${proposal.proposer.name}` : ''}.` };
}

/**
 * The tasks in flight among a repository's Stories [FPL:REQ-025]: each keeps the rules it started with (its composition is
 * recorded with it), so a change applies to tasks started after it is approved.
 */
export function inFlightOf(items = []) {
  const count = items.filter((item) => item?.status === 'in_progress' && isTaskWorkType(item.workType)).length;
  return { count, words: count ? `${count === 1 ? '1 task in flight keeps' : `${count} tasks in flight keep`} the rules ${count === 1 ? 'it' : 'they'} started with; a change applies to tasks started after it is approved.` : null };
}

/** Tasks in flight in this repository, from the Story list on this computer (no fetch); null when it cannot be read. */
async function tasksInFlight(root, definition) {
  try {
    const { discoverRemoteStoryCandidates } = await import('./session-story-discovery.mjs');
    return inFlightOf((await discoverRemoteStoryCandidates(root, definition, { fetch: false })).items ?? []);
  } catch { return null; }
}

/** The lessons the team made team guidance (LRN `lessons rule`): agents read them; they add no step [FPL:REQ-026]. */
async function guidanceCount(root) {
  try {
    const { activeLessons, isLesson, readAllLessons } = await import('./story-lessons.mjs');
    const { entries } = await readAllLessons(root);
    const count = activeLessons(entries).filter((entry) => isLesson(entry) && entry.record.lesson?.trust === 'rule').length;
    return { count, words: `Guidance the agents read: ${count === 1 ? '1 lesson' : `${count} lessons`}.`, command: 'singularity-flow lessons' };
  } catch { return null; }
}

/** The form's lists [FPL:REQ-020]: only what `taskRules` accepts, and only this repository's workflows. */
export function ruleForm(definition) {
  return {
    kinds: TASK_KINDS.map((kind) => ({ id: kind, words: KIND_NOUN[kind] })),
    steps: RULE_STEPS.map((intent) => ({ id: intent, words: STEP_NOUN[intent] })),
    approves: INTENT_ORDER.map((intent) => ({ id: intent, words: APPROVES_NOUN[intent] })),
    workflows: Object.entries(definition?.workTypes ?? {}).filter(([id, type]) => !isTaskWorkType(id) && !type?.composedTask)
      .map(([id, type]) => ({ id, label: String(type?.label ?? id) })).sort((left, right) => left.label.localeCompare(right.label))
  };
}

/** How SFlow composes a task: each kind's steps before any rule [FPL:REQ-019]. */
export const composeWords = () => TASK_KINDS.map((kind) => ({ kind,
  words: `${capital(KIND_NOUN[kind])}: ${kindSteps(kind).map((intent) => taskStepLabel(kind, intent)).join(' → ')}` }));

/**
 * `rules [--offline] --json` [FPL:REQ-019, REQ-025, REQ-026]: the Rules place's read, of the approved configuration. Without
 * `--offline` it reads the configuration proposals too, for the rules waiting for review; it never writes.
 */
export async function rulesRead(root, { offline = false, proposals = null } = {}) {
  const [{ withApprovedConfigurationRead, INSPECTION_READ }, { loadDefinition, WORKFLOW_PATH }, { configurationReadRoot }, { readFile }, path, { createHash }] = await Promise.all([
    import('./approved-configuration-reader.mjs'), import('./config.mjs'), import('./configuration-read-scope.mjs'), import('node:fs/promises'),
    import('node:path'), import('node:crypto')]);
  let authority = null;
  let text = '';
  const definition = await withApprovedConfigurationRead(root, async (seen) => {
    authority = seen;
    text = await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8');
    return loadDefinition(root);
    // --offline: the approved configuration as this clone last saw it, with no fetch.
  }, { preferAuthority: true, ...INSPECTION_READ, ...(offline ? { refreshAuthority: false } : {}) });
  const raw = (() => { try { return YAML.parse(text) ?? {}; } catch { return {}; } })();
  const { problems } = checkTaskRules({ ...definition, tasks: raw.tasks });
  const labelOf = (id) => definition.workTypes?.[id]?.label ?? id;
  const lines = [];
  let waiting = [];
  if (!offline) {
    try {
      const listed = proposals ?? await (await import('./configuration-proposal.mjs')).listWorkflowConfigurationProposals(root, { includeMerged: false, includeDiff: false });
      waiting = listed.filter((proposal) => proposal?.taskRules && !proposal.merged).map(waitingView);
    } catch (error) {
      lines.push(`The proposals waiting for review could not be read: ${String(error?.message ?? error).split('\n')[0]}`.slice(0, 300));
    }
  } else lines.push('Read offline: proposals waiting for review are not shown.');
  const idPrefix = checkTaskRules({ ...definition, tasks: raw.tasks }).rules.idPrefix;
  return {
    schemaVersion: 1, resultType: RULES_RESULT,
    authority: { kind: authority?.kind ?? 'working-tree', ref: authority?.ref ?? null, commit: authority?.commit ?? null,
      remoteFingerprint: authority?.remoteFingerprint ?? null, sourceCommit: authority?.sourceCommit ?? null },
    base: { workflowSha256: createHash('sha256').update(text).digest('hex') },
    builtIn: BUILT_IN_RULES.map((rule) => ({ ...rule })),
    rules: ruleViews(raw.tasks, { labelOf, problems }),
    waiting,
    idPrefix: { value: idPrefix, words: `Tasks are named ${idPrefix}-<n>.` },
    compose: composeWords(),
    workflows: { words: 'For work a team must always do one way, use a workflow: Workflow Studio, under Advanced.', command: 'singularity-flow workflow list' },
    guidance: await guidanceCount(root),
    inFlight: await tasksInFlight(root, definition),
    links: { people: 'People and approval groups', constitution: 'The Constitution' },
    problems: problems.map(({ field, message }) => ({ field, message })),
    form: ruleForm(definition),
    lines
  };
}

/** `rules` in a terminal, in the Rules page's order and words. */
export function rulesText(result) {
  const out = ['Built in (SFlow keeps these for every task)'];
  for (const rule of result.builtIn) out.push(`  When ${rule.when}: ${rule.then}.`);
  out.push('', 'Your team\'s rules');
  if (!result.rules.length) out.push('  None yet. Add one in VS Code (Rules), or propose a change to singularity/workflow.yml.');
  for (const rule of result.rules) {
    out.push(`  ${rule.words}`, `    Because: ${rule.because || 'no reason given'}  (${rule.id})`);
    for (const problem of rule.problems ?? []) out.push(`    Problem: ${taskProblemLine(problem)}`);
  }
  if (result.waiting.length) {
    out.push('', 'Waiting for review');
    for (const proposal of result.waiting) out.push(`  ${proposal.words} (${proposal.branch})`, ...proposal.lines.map((line) => `    ${line}`));
  }
  out.push('', result.idPrefix.words, '', 'How SFlow composes a task', ...result.compose.map((entry) => `  ${entry.words}`));
  out.push('', result.workflows.words);
  if (result.guidance) out.push(`${result.guidance.words} (${result.guidance.command})`);
  if (result.inFlight?.words) out.push(result.inFlight.words);
  const loose = result.problems.filter((problem) => !result.rules.some((rule) => (rule.problems ?? []).some((own) => own.field === problem.field)));
  if (loose.length) out.push('', 'Problems', ...loose.map((problem) => `  ${taskProblemLine(problem)}`));
  out.push(...result.lines.map((line) => `${line}`));
  out.push('', 'Change a rule in VS Code (Rules), or edit singularity/workflow.yml and run:',
    '  singularity-flow configuration save singularity/workflow.yml --propose < singularity/workflow.yml');
  return `${out.join('\n')}\n`;
}

/** `rules preview` in a terminal. */
export function rulesPreviewText(result) {
  const out = [result.valid ? 'What this change does' : 'This change cannot be proposed yet:'];
  for (const problem of result.problems) out.push(`  Problem: ${taskProblemLine(problem)}`);
  for (const line of result.summary) out.push(`  ${line}`);
  for (const line of result.lines) out.push(`  ${line.words}`);
  if (result.others) out.push(`  ${result.others}`);
  for (const warning of result.warnings) out.push(`  Already there, not changed by this: ${taskProblemLine(warning)}`);
  return `${out.join('\n')}\n`;
}

export { TASK_RULE_ID };
