/**
 * Intent to work [ITW:REQ-002–007, docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]: a task's steps, composed from its kind.
 *
 * The agent names the kind of a person's words (fix, feature, change, refactor, tests, docs, investigate, review,
 * chore); this module turns that kind into a Story's workflow the same way every time. Each step is one of the
 * repository's own steps for an intent (intake, requirements, design, plan, code, test, review), so it keeps that
 * step's agent, template and settings; the composed work type only orders them and names what each returns to. The
 * team's `tasks:` rules in workflow.yml then add steps or a person's approval, and never remove one.
 *
 * Nothing here writes: `taskDefinition` lays the composed work type over a copy of the definition in memory, and the
 * Story records the composition (`composition` on its resolution) so every later command rebuilds the same workflow
 * from the Story's own record, never from workflow.yml.
 *
 * A marketplace agent's workflow can be the plan [ITW:REQ-011]: once its workflow is in the repository (imported through
 * the conversion review) and the person said yes, its steps replace the kind's, in its order and with its own settings,
 * the team's rules still adding to them. The composition records where the steps came from (`agent`).
 *
 * A workflow of the team's own can be the plan too [ITW:REQ-020]: the person's yes to it (`workflow`) runs it exactly as a
 * `use` rule does, its steps in its order with nothing composed into it, and the composition records it (`local`).
 *
 * v1.2 [ITW:REQ-101–106, docs/SPEC-ITW-INTENT-TO-WORK-v1.2.md]: a code task is sized by its requirement. It starts with
 * the requirement (the intake) and one step that implements and tests (`sizing: 'requirement'`); its shape is decided at
 * the requirement's approval (task-shape.mjs), and a big change gains its spec, plan and tests steps then. An analysis
 * (investigate, review, docs) is SFlow's to approve. A refactor keeps the kind's own steps, and a team may keep them for
 * every kind (`tasks.sizing: kind`).
 */
import { DEFAULT_APPROVAL_AUTHORITY } from './approval-authority.mjs';
import { SingularityFlowError } from './util.mjs';

export const TASK_KINDS = Object.freeze(['fix', 'feature', 'change', 'refactor', 'tests', 'docs', 'investigate', 'review', 'chore']);
export const TASK_COMPOSITION_VERSION = 1;
/** How a task's steps are chosen [ITW:REQ-102]: by its requirement (v1.2, the default), or from its kind alone (v1.1). */
export const TASK_SIZINGS = Object.freeze(['requirement', 'kind']);
/** The kinds whose shape (small or big) their requirement decides [ITW:REQ-101]; a refactor is always big. */
export const SIZED_KINDS = Object.freeze(['fix', 'chore', 'change', 'feature', 'tests']);
/** The kinds that change no code: an analysis, which SFlow approves and which ends with follow-ups [ITW:REQ-109]. */
export const ANALYSIS_KINDS = Object.freeze(['investigate', 'review', 'docs']);
/** The steps a big change gains after its requirement, by intent, in order [ITW:REQ-105]; design only for UI or architecture work. */
export const BIG_INTENTS = Object.freeze(['requirements', 'design', 'plan', 'test']);
/** Whether a composition was sized by its requirement (v1.2); a Story started before keeps v1.1's composition. */
export const isSized = (composition) => composition?.sizing === 'requirement';
/** A sized code task that is big: it has a plan (its requirement said big, or it grew). */
export const isBigShape = (composition) => isSized(composition) && SIZED_KINDS.includes(composition.kind)
  && (composition.steps ?? []).some((step) => step.intent === 'plan');
/**
 * The shape a person sees [ITW:REQ-101]: 'analysis', 'small', 'big', or null for a task that runs a named workflow, a
 * refactor or a Story composed before v1.2.
 */
export function taskShape(composition) {
  if (!isSized(composition)) return null;
  if (ANALYSIS_KINDS.includes(composition.kind)) return 'analysis';
  if (!SIZED_KINDS.includes(composition.kind)) return null;
  return isBigShape(composition) ? 'big' : 'small';
}
export const SHAPE_WORDS = Object.freeze({ analysis: 'Analysis', small: 'Small change', big: 'Big change' });
/** The composed work type's ID: never one a person configures, so a Story names where its workflow came from. */
export const taskWorkTypeId = (kind) => `task-${kind}`;
export const isTaskWorkType = (id) => typeof id === 'string' && /^task-[a-z]+$/u.test(id) && TASK_KINDS.includes(id.slice(5));

/** Each kind's steps, by step intent [ITW:REQ-003]. */
const KIND_STEPS = Object.freeze({
  fix: ['intake', 'code', 'test'],
  chore: ['intake', 'code', 'test'],
  change: ['intake', 'plan', 'code', 'test'],
  feature: ['intake', 'requirements', 'plan', 'code', 'test'],
  refactor: ['intake', 'plan', 'code', 'test'],
  tests: ['intake', 'code', 'test'],
  // A document task writes its document as its step's own document, kept with the Story and read by a later task (--from):
  // a code step with no code or tests could leave no evidence for what the intake asks.
  docs: ['intake', 'design'],
  investigate: ['intake', 'design'],
  review: ['intake', 'design']
});

/** The artifact kinds of a step that writes requirement IDs (step-intent-settings.mjs kindWhenWritingRequirementIds). */
export const CLAUSE_KINDS = Object.freeze(['requirements', 'implementation-spec']);
const CLAUSE_KIND_OF = Object.freeze({ intake: 'requirements', requirements: 'requirements', plan: 'implementation-spec' });

/** Where an added step goes: the order a workflow's steps keep. */
export const INTENT_ORDER = Object.freeze(['intake', 'requirements', 'design', 'plan', 'code', 'test', 'review']);

/** The packaged step each intent prefers, when the repository still has it for that intent. */
const PREFERRED_STEP = Object.freeze({
  intake: 'intake', requirements: 'requirements', design: 'design', plan: 'implementation-spec',
  code: 'implementation', test: 'verification', review: 'conformance'
});

const KIND_WORDS = Object.freeze({
  fix: 'Fix', chore: 'Chore', change: 'Change', feature: 'Feature', refactor: 'Refactor', tests: 'Tests',
  docs: 'Document', investigate: 'Investigation', review: 'Review'
});

/**
 * A step's label in a task: what it does for this kind, in a developer's words. `sized`: a v1.2 task, whose intake is its
 * requirement, whose requirements step is its spec, and whose code step implements and tests while it is small.
 */
export function taskStepLabel(kind, intent, { sized = false, big = false } = {}) {
  if (sized && intent === 'intake') return 'Requirement';
  if (sized && intent === 'requirements') return 'Spec';
  if (sized && intent === 'code' && !big && SIZED_KINDS.includes(kind)) return kind === 'tests' ? 'Write and run the tests' : 'Implement and test';
  if (intent === 'intake') return 'Intake';
  if (intent === 'requirements') return 'Requirements';
  if (intent === 'plan') return kind === 'refactor' ? 'Plan: what must not change' : 'Plan';
  if (intent === 'code') return kind === 'tests' ? 'Write the tests' : 'Code';
  if (intent === 'test') return 'Tests';
  if (intent === 'design') return kind === 'review' ? 'Review' : kind === 'investigate' ? 'Investigate' : kind === 'docs' ? 'Write the document' : 'Design';
  if (intent === 'review') return 'Conformance review';
  return intent;
}

/** One word per step for the plan line. */
const PLAN_WORDS = Object.freeze({
  intake: null, requirements: 'requirements', design: 'design', plan: 'plan', code: 'code', test: 'tests', review: 'review'
});

function taskRefusal(code, message, nextAction, details = {}) {
  return new SingularityFlowError(message, { code, details: { ...details, ...(nextAction ? { nextAction } : {}) } });
}

/** The repository's step for `intent`: its packaged one when still there, else the first step with that intent. */
export function taskStepFor(definition, intent) {
  const phases = definition?.phases ?? {};
  const preferred = PREFERRED_STEP[intent];
  if (preferred && phases[preferred]?.intent === intent && phases[preferred]?.kind !== 'skill') return preferred;
  for (const [id, phase] of Object.entries(phases)) {
    if (phase?.intent === intent && phase?.kind !== 'skill') return id;
  }
  return null;
}

/** A rule's stable name [FPL:REQ-024]: its `id` when it has one (the Rules place gives every rule it writes one), else its place. */
export const taskRuleName = (rule, section, index) => (typeof rule?.id === 'string' && rule.id ? rule.id : `${section}[${index}]`);
/** A rule's `id`: lower-case words joined by hyphens, as the Rules place makes it from the rule's when and then. */
export const TASK_RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_RULE_KEYS = Object.freeze(['id', 'kinds', 'paths', 'steps', 'personApproves', 'by', 'because']);
/** The approval groups a rule's `by:` may name: the repository's approvalAuthorities, or the one group a repository without them has. */
export const taskApprovalGroups = (definition) => (definition?.approvalAuthorities && typeof definition.approvalAuthorities === 'object'
  && !Array.isArray(definition.approvalAuthorities) ? Object.keys(definition.approvalAuthorities) : [DEFAULT_APPROVAL_AUTHORITY]);

/**
 * The team's rules for tasks [ITW:REQ-004], every problem collected with where it is [FPL:REQ-023]: `rules` holds the rules
 * that are valid (a broken rule is left out of them), `problems` each problem with its field (`tasks.paths[1].because`), the
 * section and place of its rule, and the rule as written. Absent `tasks:` means the defaults. Pure.
 */
export function checkTaskRules(definition) {
  const raw = definition?.tasks;
  const rules = { idPrefix: 'TASK', sizing: 'requirement', always: [], paths: [], use: {}, useRules: {} };
  const problems = [];
  if (raw === undefined || raw === null) return { rules, problems };
  const add = (field, message, where = {}) => problems.push({ code: 'TASK_RULE_INVALID', field, message, ...where });
  if (typeof raw !== 'object' || Array.isArray(raw)) { add('tasks', 'must be a mapping.'); return { rules, problems }; }
  for (const key of Object.keys(raw)) if (!['idPrefix', 'sizing', 'always', 'paths', 'use'].includes(key)) add(`tasks.${key}`, `'${key}' is not a tasks rule; use idPrefix, sizing, always, paths or use.`);
  if (raw.sizing !== undefined) {
    if (!TASK_SIZINGS.includes(raw.sizing)) add('tasks.sizing', `sizing is requirement (a code task's requirement decides small or big) or kind (the kind's own steps).`, { value: raw.sizing });
    else rules.sizing = raw.sizing;
  }
  const idPrefix = raw.idPrefix ?? 'TASK';
  if (typeof idPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,15}$/u.test(idPrefix)) add('tasks.idPrefix', 'idPrefix must be letters and digits, starting with a letter (for example TASK).', { value: idPrefix });
  else rules.idPrefix = idPrefix;
  const ids = new Set();
  const listOf = (value, fallback) => (value === undefined ? fallback : Array.isArray(value) ? value : [value]);
  const rule = (entry, section, index) => {
    const label = `${section}[${index}]`;
    const where = { section, index, rule: entry };
    const before = problems.length;
    const fail = (key, message) => add(`tasks.${label}${key ? `.${key}` : ''}`, message, where);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail(null, `${label} must be a mapping.`); return null; }
    for (const key of Object.keys(entry)) if (!TASK_RULE_KEYS.includes(key)) fail(key, `${label} has '${key}'; a rule has id, kinds, paths, steps, personApproves, by and because.`);
    if (entry.id !== undefined) {
      if (typeof entry.id !== 'string' || !TASK_RULE_ID.test(entry.id) || entry.id.length > 64) fail('id', `${label} id must be lower-case words joined by hyphens, like billing-review.`);
      else if (ids.has(entry.id)) fail('id', `${label} id '${entry.id}' is the id of another rule; each rule's id is its own.`);
      else ids.add(entry.id);
    }
    const kinds = listOf(entry.kinds, ['all']);
    if (!kinds.length) fail('kinds', `${label} kinds names no kind, so it applies to no task; name at least one kind, or all.`);
    for (const kind of kinds) if (kind !== 'all' && !TASK_KINDS.includes(kind)) fail('kinds', `${label} kinds names the kind '${kind}'; a kind is one of ${TASK_KINDS.join(', ')}, or all.`);
    const intents = (key) => {
      const list = listOf(entry[key], []);
      for (const intent of list) if (!INTENT_ORDER.includes(intent)) fail(key, `${label} ${key} names '${intent}'; a step is one of ${INTENT_ORDER.join(', ')}.`);
      return list;
    };
    const steps = intents('steps');
    const personApproves = intents('personApproves');
    // `by`: one of the repository's approval groups, which must also approve the steps the rule gives a person [FPL §11, question 3].
    if (entry.by !== undefined) {
      const groups = taskApprovalGroups(definition);
      if (typeof entry.by !== 'string' || !groups.includes(entry.by)) fail('by', `${label} by names '${entry.by}', which is not one of this repository's approval groups (${groups.join(', ')}).`);
      else if (!personApproves.length) fail('by', `${label} by names who also approves, so it needs personApproves: the steps ${entry.by} approves.`);
    }
    if (typeof entry.because !== 'string' || !entry.because.trim()) fail('because', `${label} needs a because: the team's reason, shown when the rule adds a step.`);
    let globs = null;
    if (section === 'paths') {
      globs = Array.isArray(entry.paths) ? entry.paths : [entry.paths];
      if (!globs.length || globs.some((glob) => typeof glob !== 'string' || !glob.trim())) fail('paths', `${label} needs paths: the files it is about.`);
    }
    if (problems.length > before) return null;
    return { id: typeof entry.id === 'string' ? entry.id : null, kinds, steps, personApproves, because: entry.because.trim(), ...(globs ? { paths: globs } : {}),
      ...(entry.by !== undefined ? { by: entry.by } : {}) };
  };
  for (const section of ['always', 'paths']) {
    const list = raw[section] ?? [];
    if (!Array.isArray(list)) { add(`tasks.${section}`, `${section} must be a list of rules.`); continue; }
    list.forEach((entry, index) => { const checked = rule(entry, section, index); if (checked) rules[section].push({ ...checked, name: taskRuleName(checked, section, index) }); });
  }
  const use = raw.use ?? {};
  if (typeof use !== 'object' || Array.isArray(use)) add('tasks.use', 'use must map a kind to a workflow.');
  else {
    for (const [kind, value] of Object.entries(use)) {
      const where = { section: 'use', kind, rule: value };
      const field = `tasks.use.${kind}`;
      // `use: { change: classic-delivery }`, or the Rules place's `{ workflow, because, id }` [FPL:REQ-020].
      const spelled = value && typeof value === 'object' && !Array.isArray(value) ? value : { workflow: value };
      const before = problems.length;
      if (!TASK_KINDS.includes(kind)) add(field, `use names the kind '${kind}'; a kind is one of ${TASK_KINDS.join(', ')}.`, where);
      for (const key of Object.keys(spelled)) if (!['workflow', 'because', 'id'].includes(key)) add(`${field}.${key}`, `use.${kind} has '${key}'; a use rule has workflow, because and id.`, where);
      if (typeof spelled.workflow !== 'string' || !definition?.workTypes?.[spelled.workflow]) add(`${field}${spelled === value ? '.workflow' : ''}`, `use sends ${kind} to '${spelled.workflow}', which is not a workflow here.`, where);
      if (spelled.because !== undefined && (typeof spelled.because !== 'string' || !spelled.because.trim())) add(`${field}.because`, `use.${kind} because must say the team's reason.`, where);
      if (spelled.id !== undefined) {
        if (typeof spelled.id !== 'string' || !TASK_RULE_ID.test(spelled.id) || spelled.id.length > 64) add(`${field}.id`, `use.${kind} id must be lower-case words joined by hyphens, like release-classic.`, where);
        else if (ids.has(spelled.id)) add(`${field}.id`, `use.${kind} id '${spelled.id}' is the id of another rule; each rule's id is its own.`, where);
        else ids.add(spelled.id);
      }
      if (problems.length > before) continue;
      rules.use[kind] = spelled.workflow;
      rules.useRules[kind] = { workflow: spelled.workflow, because: typeof spelled.because === 'string' ? spelled.because.trim() : null,
        id: typeof spelled.id === 'string' ? spelled.id : null, name: typeof spelled.id === 'string' ? spelled.id : `use.${kind}` };
    }
  }
  return { rules, problems };
}

/** The team's rules for tasks [ITW:REQ-004]: `tasks:` in workflow.yml, checked; absent means the defaults. A problem refuses, naming every one. */
export function taskRules(definition) {
  const { rules, problems } = checkTaskRules(definition);
  if (!problems.length) return rules;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more: ${problems.slice(1, 4).map((problem) => problem.field).join(', ')})` : '';
  throw taskRefusal('TASK_RULES_INVALID', `workflow.yml tasks: ${problems[0].message}${more}`, {
    command: 'singularity-flow rules', label: 'See the team\'s rules and each problem with where it is.' },
  { problems: problems.map(({ field, message }) => ({ field, message })) });
}

function globPattern(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') { source += '.*'; index += 1; if (glob[index + 1] === '/') index += 1; }
    else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${source}$`, 'u');
}

/** Whether a repository path matches a rule's glob (`src/auth/**`, `*.sql`, `db/migrations/*`). */
export function pathMatches(glob, file) {
  const normalized = String(file).replace(/\\/gu, '/').replace(/^\.\//u, '');
  return globPattern(glob.replace(/^\.\//u, '')).test(normalized);
}

/**
 * The steps whose approval the team's rules give a person on a task of `kind` [ITW:REQ-004, REQ-005]: every `always`
 * rule for the kind, and every `paths` rule for the kind whose files the task touched (`touchedPaths`: the files it
 * started with and those its code changed since). By intent; whether the task has such a step is the caller's question.
 */
export function rulePersonApproves(definition, kind, touchedPaths = []) {
  const rules = taskRules(definition);
  const applies = (rule) => rule.kinds.includes('all') || rule.kinds.includes(kind);
  const touched = [...new Set(touchedPaths.map(String))];
  const given = new Set();
  for (const rule of rules.always) if (applies(rule)) rule.personApproves.forEach((intent) => given.add(intent));
  for (const rule of rules.paths) {
    if (applies(rule) && touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) rule.personApproves.forEach((intent) => given.add(intent));
  }
  return [...given].sort();
}

/**
 * The approval groups the team's rules add on a task of `kind` (`by:`, FPL §11 question 3), found as rulePersonApproves finds
 * its steps: each `{ intent, group, label, rule, because }`, once per intent and group.
 */
export function ruleGroupApproves(definition, kind, touchedPaths = []) {
  const rules = taskRules(definition);
  const applies = (rule) => rule.kinds.includes('all') || rule.kinds.includes(kind);
  const touched = [...new Set(touchedPaths.map(String))];
  const found = [];
  const take = (rule, name) => { if (rule.by) for (const intent of rule.personApproves) found.push({ intent, group: rule.by, rule: name, because: rule.because }); };
  rules.always.forEach((rule, index) => { if (applies(rule)) take(rule, rule.name ?? taskRuleName(rule, 'always', index)); });
  rules.paths.forEach((rule, index) => {
    if (applies(rule) && touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) take(rule, rule.name ?? taskRuleName(rule, 'paths', index));
  });
  return groupsAdded(definition, found, () => true).groupApproves ?? [];
}

/**
 * The rules that give a person a step's approval on a task of `kind`, found as rulePersonApproves finds its steps: each
 * `{ intent, rule, because }`, once per intent and rule, so a step's approval says the reason of every rule that gave it
 * [ITW:REQ-113].
 */
export function ruleApprovalReasons(definition, kind, touchedPaths = []) {
  const rules = taskRules(definition);
  const applies = (rule) => rule.kinds.includes('all') || rule.kinds.includes(kind);
  const touched = [...new Set(touchedPaths.map(String))];
  const found = [];
  const take = (rule, name) => { for (const intent of rule.personApproves) found.push({ intent, rule: name, because: rule.because }); };
  rules.always.forEach((rule, index) => { if (applies(rule)) take(rule, rule.name ?? taskRuleName(rule, 'always', index)); });
  rules.paths.forEach((rule, index) => {
    if (applies(rule) && touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) take(rule, rule.name ?? taskRuleName(rule, 'paths', index));
  });
  return approvalRulesOf(found, () => true).approvalRules ?? [];
}

/** `approvalRules` for a composition: each rule that gives a person a step's approval, once per intent and rule [ITW:REQ-113]. */
function approvalRulesOf(entries, has) {
  const seen = new Set();
  const approvalRules = [];
  for (const entry of entries) {
    const key = `${entry.intent}\u0000${entry.rule}`;
    if (!has(entry.intent) || seen.has(key)) continue;
    seen.add(key);
    approvalRules.push(entry);
  }
  return approvalRules.length ? { approvalRules } : {};
}

/**
 * The reasons of the rules that gave a person the approval of a step of `intent`, each once, in the order the rules apply
 * [ITW:REQ-113]; null for a composition recorded before it kept them (`approvalRules`), whose readers keep their words.
 */
export function approvalReasons(composition, intent) {
  if (!Array.isArray(composition?.approvalRules)) return null;
  return [...new Set(composition.approvalRules.filter((entry) => entry?.intent === intent && typeof entry.because === 'string')
    .map((entry) => entry.because.trim()).filter(Boolean))];
}

/** The `because` a composed step's person approval pins: its own rules' reasons, or, recorded before them, the first rule's. */
function approvalBecause(composition, intent) {
  const reasons = approvalReasons(composition, intent);
  if (reasons?.length) return reasons.join(' ');
  return (composition.rules.find((entry) => entry.because) ?? { because: 'The team\'s task rules give this step to a person.' }).because;
}

/** `groupApproves` for a composition: each group a rule adds, once per step intent the task has, with the group's label. */
function groupsAdded(definition, entries, has) {
  const seen = new Set();
  const groupApproves = [];
  for (const entry of entries) {
    const key = `${entry.intent}\u0000${entry.group}`;
    if (!has(entry.intent) || seen.has(key)) continue;
    seen.add(key);
    groupApproves.push({ ...entry, label: String(definition?.approvalAuthorities?.[entry.group]?.label ?? entry.group) });
  }
  return groupApproves.length ? { groupApproves } : {};
}

/** The groups each step's approval must also have (config.mjs resolveWorkType adds them), from the composition's `groupApproves`. */
function ruleApproversOf(composition) {
  const byStep = {};
  for (const step of composition.steps) {
    const groups = [...new Set((composition.groupApproves ?? []).filter((entry) => entry.intent === step.intent).map((entry) => entry.group))];
    if (groups.length) byStep[step.id] = groups;
  }
  return Object.keys(byStep).length ? { ruleApprovers: byStep } : {};
}

/** The steps a person may add to a task, or take out of it before it starts, by intent [ITW:REQ-009]. */
export const ADDABLE = Object.freeze(['requirements', 'design', 'plan', 'review']);

/**
 * The composed task: its kind, its steps in order (each with the repository step it uses), the rules that added to it,
 * and the work type the Story pins. Deterministic: the same kind, definition and touched paths give the same result.
 */
export function composeTask(definition, { kind, touchedPaths = [], add = [], skip = [], agent = null, workflow = null, rules: checked = null,
  sizing = null, shape = null, design = false } = {}) {
  if (!TASK_KINDS.includes(kind)) {
    throw taskRefusal('TASK_KIND_UNKNOWN', `'${kind}' is not a kind of task. A task is one of: ${TASK_KINDS.join(', ')}.`,
      { command: 'singularity-flow work "<what you want done>" --kind change', label: 'Name one of the kinds of task.' }, { kinds: [...TASK_KINDS] });
  }
  // `rules`: rules already checked (the Rules place's preview composes with the valid ones beside a broken one).
  const rules = checked ?? taskRules(definition);
  const used = rules.use[kind];
  if (agent) {
    if (used) {
      throw taskRefusal('TASK_AGENT_NOT_COVERING', `This team runs every ${kind} task as the ${definition.workTypes[used].label ?? used} workflow, so an agent's workflow is not its plan.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Plan the task as the team\'s workflow.' }, { agent: agentId(agent) });
    }
    return composeAgentTask(definition, rules, { kind, agent, touchedPaths, add, skip });
  }
  if (workflow) {
    if (used) {
      throw taskRefusal('TASK_AGENT_NOT_COVERING', `This team runs every ${kind} task as the ${definition.workTypes[used].label ?? used} workflow, so another workflow is not its plan.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Plan the task as the team\'s workflow.' }, { workflow: workflow.workflow });
    }
    return composeLocalTask(definition, rules, { kind, workflow, skip, touchedPaths, add });
  }
  if (used) {
    const named = rules.useRules?.[kind];
    const rule = { rule: named?.name ?? `use.${kind}`, because: named?.because ?? `This team runs every ${kind} task as the ${definition.workTypes[used].label ?? used} workflow.` };
    // The team's rules add to the workflow a `use` rule picks [ITW:REQ-107]; with nothing to add it runs exactly as it is.
    const ruled = composeOnWorkflow(definition, rules, { kind, workflowId: used, touchedPaths, add, skip,
      words: `the ${definition.workTypes[used].label ?? used} workflow`, record: { local: { workflow: used, label: definition.workTypes[used].label ?? used, by: 'use' } }, lead: rule });
    if (ruled.added.length || ruled.personApproves.length || ruled.groupApproves?.length || (ruled.changes ?? []).length) return ruled;
    return { schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: used, uses: used, steps: (definition.workTypes[used].phases ?? []).map((id) => ({
      id, intent: definition.phases?.[id]?.intent ?? null, label: definition.phases?.[id]?.label ?? id })), added: [], personApproves: [], rules: [rule] };
  }
  // v1.2 [ITW:REQ-102, REQ-104, REQ-105, REQ-109]: a code task starts with its requirement and one step that implements and
  // tests, then SFlow's own run of the tests (the tests step, which SFlow approves when they pass: the evidence the Story's
  // final check reads); a big one (`shape: 'big'`, as a started task's composition is rebuilt) has the spec, design when
  // asked, and plan too. An analysis keeps its steps. A refactor, and a team that sizes by kind, keep the kind's own steps.
  const sized = (sizing ?? rules.sizing ?? 'requirement') === 'requirement' && (SIZED_KINDS.includes(kind) || ANALYSIS_KINDS.includes(kind));
  const big = sized && SIZED_KINDS.includes(kind) && shape === 'big';
  const intents = sized && SIZED_KINDS.includes(kind)
    ? ['intake', ...(big ? BIG_INTENTS.filter((intent) => intent !== 'design' && intent !== 'test' || (intent === 'design' && design)) : []), 'code', 'test']
    : [...KIND_STEPS[kind]];
  const changes = [];
  // The person's own changes come first; the team's rules are applied after them, so no rule's step is taken out.
  for (const intent of [...new Set(add)]) {
    if (!ADDABLE.includes(intent)) throw taskRefusal('TASK_CHANGE_REFUSED', `A task can gain a ${ADDABLE.join(', ')} step, not '${intent}'.`,
      { command: 'singularity-flow work "<what you want done>" --add design', label: 'Add one of the steps a task can gain.' }, { add: intent });
    if ((intent === 'review') && !intents.includes('code')) continue;
    // A plan step plans a code step; added to a task with none, it would follow the report and take its approval.
    if (intent === 'plan' && !intents.includes('code')) {
      throw taskRefusal('TASK_CHANGE_REFUSED', `A plan step plans code, and a ${kind} task changes none.`,
        { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the task\'s own steps.' }, { add: intent });
    }
    if (!intents.includes(intent)) { intents.push(intent); changes.push({ change: 'add', intent }); }
  }
  const wantedOut = new Set(skip);
  for (const intent of wantedOut) {
    if (!intents.includes(intent)) continue;
    const kept = intent === 'intake' ? 'Every task starts with its intake.'
      : intent === 'code' && intents.includes('code') ? `A ${kind} task is its change; a task with no change is an investigate task.`
        : intent === 'test' && intents.includes('code') ? 'Every code change gets a test step.'
          : intent === 'design' && ['investigate', 'review', 'docs'].includes(kind) ? `A ${kind} task's ${kind === 'docs' ? 'document' : 'report'} is its design step.` : null;
    const keptSized = kept ?? (big && BIG_INTENTS.includes(intent) ? `A big change has a spec, a plan and tests.` : null);
    if (keptSized) throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: ${keptSized}`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the step.' }, { skip: intent });
    intents.splice(intents.indexOf(intent), 1);
    changes.push({ change: 'skip', intent });
  }
  const added = [];
  const personApproves = new Set();
  const reasons = [];
  const groups = [];
  const applied = [];
  const apply = (rule, name) => {
    for (const intent of rule.steps) {
      if (wantedOut.has(intent)) {
        throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: ${rule.because}`,
          { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the step the team\'s rule adds.' }, { skip: intent, rule: name });
      }
      // Only a code task gets a plan, test or review step from a rule: those steps plan or read code.
      if ((intent === 'plan' || intent === 'test' || intent === 'review') && !intents.includes('code')) continue;
      if (!intents.includes(intent)) { intents.push(intent); added.push({ intent, rule: name, because: rule.because }); }
    }
    for (const intent of rule.personApproves) { personApproves.add(intent); reasons.push({ intent, rule: name, because: rule.because }); }
    if (rule.by) for (const intent of rule.personApproves) groups.push({ intent, group: rule.by, rule: name, because: rule.because });
    applied.push({ rule: name, because: rule.because });
  };
  rules.always.forEach((rule, index) => {
    if (rule.kinds.includes('all') || rule.kinds.includes(kind)) apply(rule, rule.name ?? taskRuleName(rule, 'always', index));
  });
  const touched = [...new Set(touchedPaths.map(String))].sort();
  rules.paths.forEach((rule, index) => {
    if (!(rule.kinds.includes('all') || rule.kinds.includes(kind))) return;
    if (touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) apply(rule, rule.name ?? taskRuleName(rule, 'paths', index));
  });
  intents.sort((left, right) => INTENT_ORDER.indexOf(left) - INTENT_ORDER.indexOf(right));
  const steps = intents.map((intent) => {
    const id = taskStepFor(definition, intent);
    if (!id) {
      throw taskRefusal('TASK_STEP_UNAVAILABLE',
        `This repository's workflow has no ${intent} step, which a ${kind} task needs. Add a step whose intent is ${intent} in Workflow Studio, or start the Story with a workflow of your own.`,
        { command: 'singularity-flow workflow list', label: 'Start the Story with one of these workflows.' },
        { kind, intent });
    }
    return { id, intent, label: taskStepLabel(kind, intent, { sized, big }) };
  });
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) {
    throw taskRefusal('TASK_STEP_UNAVAILABLE', `This repository's workflow uses one step for two intents (${ids.join(', ')}), so a ${kind} task cannot be composed from it.`,
      { command: 'singularity-flow workflow list', label: 'Start the Story with one of these workflows.' }, { kind });
  }
  return {
    schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: taskWorkTypeId(kind), steps,
    added, personApproves: [...personApproves].filter((intent) => intents.includes(intent)).sort(), rules: applied,
    ...approvalRulesOf(reasons, (intent) => intents.includes(intent)),
    ...groupsAdded(definition, groups, (intent) => intents.includes(intent)),
    ...(changes.length ? { changes } : {}),
    ...(touched.length ? { touchedPaths: touched } : {}),
    ...(sized ? { sizing: 'requirement' } : {})
  };
}

/**
 * A task whose plan is a workflow of the team's own, which the person said yes to [ITW:REQ-020]: that workflow exactly
 * as it is, as a `use` rule runs it (its steps, in its order, nothing composed into it, none taken out). Its offer
 * covered the steps the team's rules add, so none is lost; a step the person asks to skip that it has stays.
 */
function composeLocalTask(definition, rules, { kind, workflow, skip, touchedPaths = [], add = [] }) {
  const own = definition.workTypes?.[workflow.workflow];
  if (!own || !Array.isArray(own.phases) || !own.phases.length) {
    throw taskRefusal('TASK_WORKFLOW_UNKNOWN', `There is no workflow '${workflow.workflow}' of your team's in the configuration this task reads.`,
      { command: 'singularity-flow workflow list', label: 'See the workflows in this repository.' }, { workflow: workflow.workflow });
  }
  const label = own.label ?? workflow.workflow;
  const local = { workflow: workflow.workflow, label, ...(workflow.from ? { from: { agent: workflow.from.agent, path: workflow.from.path } } : {}) };
  // The team's rules add to it [ITW:REQ-107]; with nothing to add it runs exactly as it is.
  const lead = { rule: 'plan', because: `Your team's workflow ${label} covers this task, so it is the plan.` };
  const ruled = composeOnWorkflow(definition, rules, { kind, workflowId: workflow.workflow, touchedPaths, add, skip, words: `your team's workflow ${label}`,
    record: { local }, lead, skipAction: { command: `singularity-flow work "<what you want done>" --kind ${kind} --without-workflow ${workflow.workflow}`,
      label: 'Plan the task with its own steps, which a step can be taken out of.' } });
  if (ruled.added.length || ruled.personApproves.length || ruled.groupApproves?.length || (ruled.changes ?? []).length) return ruled;
  const steps = own.phases.map((id) => ({ id, intent: definition.phases?.[id]?.intent ?? null, label: definition.phases?.[id]?.label ?? id }));
  for (const intent of new Set(skip)) {
    if (!steps.some((step) => step.intent === intent)) continue;
    throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: your team's workflow ${label} is followed as it is.`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind} --without-workflow ${workflow.workflow}`, label: 'Plan the task with its own steps, which a step can be taken out of.' },
      { skip: intent, workflow: workflow.workflow });
  }
  return { schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: workflow.workflow, uses: workflow.workflow, steps, added: [], personApproves: [],
    rules: [lead], local };
}

/** The team's workflow a task runs (a `use` rule's, or the team's own it chose), whether or not the rules added to it. */
export const namedWorkflowOf = (composition) => composition?.uses ?? composition?.local?.workflow ?? null;

/** A marketplace agent as `MARKETPLACE/AGENT`, as `workflow from-agent` names it. */
export const agentId = (agent) => `${agent.marketplace}/${agent.agent}`;
/** An agent in a person's words: "acme's web-feature agent". */
export const agentWords = (agent) => `${agent.marketplace}'s ${String(agent.agent).replace(/-agent$/u, '')} agent`;
// Where a step of an intent the order does not name (document, release, report) goes: after the review.
const intentRank = (intent) => (INTENT_ORDER.includes(intent) ? INTENT_ORDER.indexOf(intent) : INTENT_ORDER.length);

/**
 * A task whose plan is a marketplace agent's workflow [ITW:REQ-011]: that workflow's steps in its order, as the
 * repository has it once its import was reviewed, then the steps the person asked for and the team's rules add, each
 * the repository's own step for its intent, placed where its intent goes. A step the agent's workflow has is never taken
 * out: the workflow is followed as it is.
 */
function composeAgentTask(definition, rules, { kind, agent, touchedPaths, add, skip }) {
  const own = definition.workTypes?.[agent.workflow];
  if (!own || !Array.isArray(own.phases) || !own.phases.length) {
    throw taskRefusal('TASK_AGENT_IMPORT_NEEDED', `${agentWords(agent)}'s workflow is not in this repository's configuration, so a task cannot follow it yet. It comes in through its conversion review, as a reviewed configuration change.`,
      { command: `singularity-flow workflow from-agent ${agentId(agent)} --propose`, label: 'Import its workflow through its conversion review.' },
      { agent: agentId(agent) });
  }
  return composeOnWorkflow(definition, rules, { kind, workflowId: agent.workflow, touchedPaths, add, skip, words: `${agentWords(agent)}'s workflow`,
    record: { agent: { marketplace: agent.marketplace, agent: agent.agent, version: agent.version ?? null, workflow: agent.workflow,
      ...(agent.commit ? { commit: agent.commit } : {}) } },
    skipAction: { command: `singularity-flow work "<what you want done>" --kind ${kind} --without-agent ${agentId(agent)}`, label: 'Plan the task with its own steps, which a step can be taken out of.' },
    skipDetails: { agent: agentId(agent) } });
}

/**
 * A task that follows a named workflow [ITW:REQ-011, REQ-107]: that workflow's steps in its order, then the steps the person
 * asked for and the team's rules add, each the repository's own step for its intent, placed where its intent goes. A step
 * the workflow has is never taken out and never added twice. `record` says whose workflow it is (`agent` or `local`), and
 * `lead` the rule that picked it, first among those applied.
 */
function composeOnWorkflow(definition, rules, { kind, workflowId, touchedPaths = [], add = [], skip = [], words, record, lead = null, skipAction = null, skipDetails = {} }) {
  const own = definition.workTypes[workflowId];
  const steps = own.phases.map((id) => ({ id, intent: definition.phases?.[id]?.intent ?? null, label: definition.phases?.[id]?.label ?? id }));
  const has = (intent) => steps.some((step) => step.intent === intent);
  const insert = (intent) => {
    const id = taskStepFor(definition, intent);
    if (!id || steps.some((step) => step.id === id)) {
      throw taskRefusal('TASK_STEP_UNAVAILABLE',
        `This repository's workflow has no ${intent} step of its own to add to ${words}. Add a step whose intent is ${intent} in Workflow Studio.`,
        { command: 'singularity-flow workflow list', label: 'See the workflows and their steps.' }, { kind, intent, ...skipDetails });
    }
    const at = steps.findIndex((step) => intentRank(step.intent) > intentRank(intent));
    steps.splice(at < 0 ? steps.length : at, 0, { id, intent, label: taskStepLabel(kind, intent) });
  };
  const changes = [];
  for (const intent of [...new Set(add)]) {
    if (!ADDABLE.includes(intent)) throw taskRefusal('TASK_CHANGE_REFUSED', `A task can gain a ${ADDABLE.join(', ')} step, not '${intent}'.`,
      { command: 'singularity-flow work "<what you want done>" --add design', label: 'Add one of the steps a task can gain.' }, { add: intent });
    if ((intent === 'review' || intent === 'plan') && !has('code')) continue;
    if (!has(intent)) { insert(intent); changes.push({ change: 'add', intent }); }
  }
  for (const intent of new Set(skip)) {
    if (!has(intent)) continue;
    throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: ${words} is followed as it is.`,
      skipAction ?? { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the step.' }, { skip: intent, ...skipDetails });
  }
  const added = [];
  const personApproves = new Set();
  const reasons = [];
  const groups = [];
  const applied = lead ? [lead] : [];
  const apply = (rule, name) => {
    for (const intent of rule.steps) {
      if ((intent === 'plan' || intent === 'test' || intent === 'review') && !has('code')) continue;
      if (!has(intent)) { insert(intent); added.push({ intent, rule: name, because: rule.because }); }
    }
    for (const intent of rule.personApproves) { personApproves.add(intent); reasons.push({ intent, rule: name, because: rule.because }); }
    if (rule.by) for (const intent of rule.personApproves) groups.push({ intent, group: rule.by, rule: name, because: rule.because });
    applied.push({ rule: name, because: rule.because });
  };
  rules.always.forEach((rule, index) => { if (rule.kinds.includes('all') || rule.kinds.includes(kind)) apply(rule, rule.name ?? taskRuleName(rule, 'always', index)); });
  const touched = [...new Set(touchedPaths.map(String))].sort();
  rules.paths.forEach((rule, index) => {
    if (!(rule.kinds.includes('all') || rule.kinds.includes(kind))) return;
    if (touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) apply(rule, rule.name ?? taskRuleName(rule, 'paths', index));
  });
  return {
    schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: taskWorkTypeId(kind), steps,
    added, personApproves: [...personApproves].filter((intent) => has(intent)).sort(), rules: applied,
    ...approvalRulesOf(reasons, has),
    ...groupsAdded(definition, groups, has),
    ...structuredClone(record),
    ...(changes.length ? { changes } : {}),
    ...(touched.length ? { touchedPaths: touched } : {})
  };
}

/**
 * The work type of a task that follows a marketplace agent's workflow: that workflow as the repository has it (its
 * decisions and settings), with the steps a person or a rule added, each reading and returning to the steps before it.
 */
function agentWorkType(definition, composition) {
  const workflowId = composition.agent?.workflow ?? composition.local.workflow;
  const own = definition.workTypes?.[workflowId];
  if (!own && !composition.agent) {
    throw taskRefusal('TASK_WORKFLOW_UNKNOWN', `There is no workflow '${workflowId}' of your team's in the configuration this task reads (its base branch, or the approved configuration).`,
      { command: 'singularity-flow workflow list', label: 'See the workflows in this repository.' }, { workflow: workflowId });
  }
  if (!own) {
    throw taskRefusal('TASK_AGENT_IMPORT_NEEDED', `${agentWords(composition.agent)}'s workflow is not in the configuration this task reads (its base branch, or the approved configuration).`,
      { command: `singularity-flow workflow from-agent ${agentId(composition.agent)} --propose`, label: 'Import its workflow through its conversion review.' },
      { agent: agentId(composition.agent) });
  }
  const ownSteps = new Set(own.phases ?? []);
  const ids = composition.steps.map((step) => step.id);
  const phaseOverrides = Object.fromEntries(Object.entries(structuredClone(own.phaseOverrides ?? {})).filter(([id]) => ids.includes(id)));
  composition.steps.forEach((step, index) => {
    const override = phaseOverrides[step.id] ?? {};
    if (!ownSteps.has(step.id)) {
      override.label = step.label;
      override.approval = { ...(override.approval ?? {}), rejectTo: ids.slice(0, index + 1) };
      override.inputs = ids.slice(0, index);
    }
    if (composition.personApproves.includes(step.intent)) {
      override.approval = { ...(override.approval ?? {}), automatic: 'off' };
      override.because = { ...(override.because ?? {}), 'approval.automatic': approvalBecause(composition, step.intent) };
    } else if ((composition.personKeeps ?? []).includes(step.id)) {
      override.approval = { ...(override.approval ?? {}), automatic: 'off' };
    }
    if (Object.keys(override).length) phaseOverrides[step.id] = override;
  });
  const { composedTask: _composed, ...kept } = structuredClone(own);
  return {
    ...kept,
    label: `${own.label ?? workflowId} (task)`,
    description: composition.agent
      ? `Composed by /sf-task from ${agentWords(composition.agent)}${composition.agent.version ? ` ${composition.agent.version}` : ''}: ${composition.steps.map((step) => step.label).join(' → ')}.`
      : `Composed by /sf-task from your team's workflow ${composition.local.label ?? workflowId} and the team's rules: ${composition.steps.map((step) => step.label).join(' → ')}.`,
    phases: ids,
    phaseOverrides,
    ...ruleApproversOf(composition)
  };
}

/** The work type a composition pins: its steps in order, each returning to any earlier step, labelled for the task. */
export function composedWorkType(definition, composition) {
  if (composition.uses) return structuredClone(definition.workTypes[composition.uses]);
  if (composition.agent || composition.local) return agentWorkType(definition, composition);
  const ids = composition.steps.map((step) => step.id);
  const phaseOverrides = {};
  composition.steps.forEach((step, index) => {
    const earlier = ids.slice(0, index);
    const override = { label: step.label, approval: { rejectTo: ids.slice(0, index + 1) } };
    const base = definition.phases?.[step.id] ?? {};
    // A step reads every earlier step it can use; the steps named in its own definition may not be in this task.
    if (index > 0) override.inputs = earlier;
    if (Array.isArray(base.inputs) && index === 0) override.inputs = [];
    if (composition.personApproves.includes(step.intent)) {
      override.approval = { ...override.approval, automatic: 'off' };
      override.because = { ...(override.because ?? {}), 'approval.automatic': approvalBecause(composition, step.intent) };
    } else if ((composition.personKeeps ?? []).includes(step.id)) {
      // A step a person approved before the task gained a later step stays theirs, exactly as it was [ITW:REQ-009].
      override.approval = { ...override.approval, automatic: 'off' };
    } else if (isSized(composition) && ANALYSIS_KINDS.includes(composition.kind)) {
      // An analysis is SFlow's to approve when it is clean: nobody is asked until it offers its follow-ups [ITW:REQ-109].
      override.approval = { ...override.approval, automatic: 'when-ready' };
      override.because = { ...(override.because ?? {}), 'approval.automatic': 'An analysis changes no code: SFlow approves it when its reviewer and checks say it is ready, and the person chooses a follow-up at its end.' };
    }
    // A step that wrote the requirement IDs before a later-added step took that role keeps its kind (clauseKeeps).
    if ((composition.clauseKeeps ?? []).includes(step.id) && CLAUSE_KIND_OF[step.intent]) override.artifact = { kind: CLAUSE_KIND_OF[step.intent] };
    // A sized task's requirement asks only what the words leave open [ITW:REQ-102]: with nothing open its approval is next.
    if (isSized(composition) && step.intent === 'intake') override.clarification = { mode: 'when-needed' };
    phaseOverrides[step.id] = override;
  });
  // A plan step that writes its own requirement IDs (the packaged implementation specification does, for the technical
  // details) keeps doing so beside a requirements step, as the packaged feature workflow says.
  const requirementsStep = composition.steps.find((step) => step.intent === 'requirements');
  const planStep = composition.steps.find((step) => step.intent === 'plan');
  const codeStep = composition.steps.find((step) => step.intent === 'code');
  const planWritesIds = planStep && definition.phases?.[planStep.id]?.artifact?.kind === 'implementation-spec';
  // A step that wrote the requirement IDs before a step added later took that role keeps writing them beside it
  // (clauseKeeps, task-amendment.mjs): the step that writes them now is a requirements step, else the plan, as the
  // workflow rules choose (step-intent-settings.mjs workflowIntentFacts), and it plans the code unless a plan or a design
  // nearer the code does.
  const keeps = (composition.clauseKeeps ?? []).filter((id) => ids.includes(id));
  const scopeStep = requirementsStep ?? planStep ?? null;
  const before = codeStep ? composition.steps.slice(0, ids.indexOf(codeStep.id)).reverse() : [];
  const planner = before.find((step) => step.intent === 'plan') ?? before.find((step) => step.intent === 'design') ?? scopeStep;
  const clausePhases = [...new Set([...(requirementsStep && planWritesIds ? [requirementsStep.id, planStep.id] : []),
    ...(keeps.length && scopeStep ? [...keeps, scopeStep.id] : [])])].sort((left, right) => ids.indexOf(left) - ids.indexOf(right));
  const plannedClaims = clausePhases.length && codeStep ? {
    plannedClaims: { mode: 'required', clausePhases, owners: { [codeStep.id]: requirementsStep && planWritesIds ? planStep.id : planner.id } },
    because: { plannedClaims: keeps.length && !(requirementsStep && planWritesIds)
      ? 'The step that wrote the requirement IDs before a later step was added keeps them, beside the requirement IDs of the step that writes them now.'
      : 'The implementation specification adds its own requirement IDs for the technical details, beside the requirements step\'s.' }
  } : {};
  return {
    ...plannedClaims,
    label: `${KIND_WORDS[composition.kind]} (task)`,
    description: `Composed by /sf-task from the kind ${composition.kind}: ${composition.steps.map((step) => step.label).join(' → ')}.`,
    phases: ids,
    phaseOverrides,
    ...ruleApproversOf(composition)
  };
}

/** A copy of `definition` with the composed work type added, in memory only; workflow.yml is never written. */
export function taskDefinition(definition, composition) {
  if (!composition) return definition;
  if (composition.uses) return definition;
  if (definition.workTypes?.[composition.workType] && !definition.workTypes[composition.workType].composedTask) {
    throw taskRefusal('TASK_WORK_TYPE_TAKEN', `This repository already has a workflow named '${composition.workType}', so a task cannot use that name. Rename that workflow in Workflow Studio.`,
      { command: 'singularity-flow workflow check', label: 'Check the workflow configuration.' });
  }
  const copy = structuredClone(definition);
  copy.workTypes = { ...copy.workTypes, [composition.workType]: { ...composedWorkType(definition, composition), composedTask: true } };
  return copy;
}

/**
 * The configured workflows whose closure carries what a composed task's steps need (agents, templates), for the copy
 * of the approved configuration on the Story's branch; null (the whole configuration) when a step is in none of them.
 */
export function taskClosureWorkTypes(definition, composition) {
  if (composition.uses) return [composition.uses];
  // A marketplace agent's workflow carries its own steps, agent and skills; an added step brings the workflow it is in.
  const chosen = composition.agent ? [composition.agent.workflow] : composition.local ? [composition.local.workflow] : [];
  for (const step of composition.steps) {
    if (chosen.some((id) => definition.workTypes?.[id]?.phases?.includes(step.id))) continue;
    const owner = Object.entries(definition.workTypes ?? {}).find(([id, workType]) => !isTaskWorkType(id) && workType?.phases?.includes(step.id));
    if (!owner) return null;
    chosen.push(owner[0]);
  }
  return chosen;
}

/** The Story's composition, when its workflow was composed by a task [ITW:REQ-006]. */
export function storyComposition(workflow) {
  const composition = workflow?.resolution?.composition;
  return composition && isTaskWorkType(composition.workType) && Array.isArray(composition.steps) ? composition : null;
}

/** The definition a Story's own workflow resolves against: the composed work type laid over, for a task's Story. */
export function definitionForStory(definition, workflow) {
  const composition = storyComposition(workflow);
  return composition ? taskDefinition(definition, composition) : definition;
}

/** What a step is called in the plan line; a sized task names its requirement, its spec, and its code as one step with its tests. */
function planWord(kind, step, composition = null) {
  if (isSized(composition)) {
    if (step.intent === 'intake') return 'requirement';
    if (step.intent === 'requirements') return 'spec';
    if (step.intent === 'code' && SIZED_KINDS.includes(kind) && !isBigShape(composition)) return kind === 'tests' ? 'write and run the tests' : 'implement and test';
    // The tests step of a small change is SFlow's own run of what the code step wrote.
    if (step.intent === 'test' && SIZED_KINDS.includes(kind) && !isBigShape(composition)) return 'SFlow runs the tests';
  }
  if (step.intent === 'design') return kind === 'investigate' ? 'investigate' : kind === 'review' ? 'review' : kind === 'docs' ? 'write the document' : 'design';
  if (step.intent === 'code') return kind === 'tests' ? 'write the tests' : 'code';
  return PLAN_WORDS[step.intent] ?? null;
}

/** What a person approves, named as they know it: the intake of a task with no plan step is its plan. */
function approvedWord(kind, step, composition) {
  if (step.intent === 'intake' && isSized(composition)) return 'the requirement';
  if (step.intent === 'intake') return composition.steps.some((other) => other.intent === 'plan' || other.intent === 'requirements')
    ? 'the intake' : composition.steps.some((other) => other.intent === 'code') ? 'the plan in the intake' : 'the intake';
  if (step.intent === 'code') return kind === 'tests' ? 'the tests' : 'the code';
  if (step.intent === 'design') return kind === 'investigate' ? 'the report' : kind === 'review' ? 'the findings' : kind === 'docs' ? 'the document' : 'the design';
  if (step.intent === 'plan') return 'the plan';
  if (step.intent === 'test') return 'the test results';
  return `the ${step.intent}`;
}

/** What a person approves, as the plan line says it (" You approve the plan and the code."), or '' when SFlow approves every step. */
export function approvalWords(composition, approvals = {}) {
  const approved = composition.steps.filter((step) => approvals[step.id] === 'person').map((step) => approvedWord(composition.kind, step, composition));
  return approved.length ? ` You approve ${approved.length > 1 ? `${approved.slice(0, -1).join(', ')} and ${approved.at(-1)}` : approved[0]}.` : '';
}

/** What each approval group a team's rule adds also approves, as the plan line says it (" Security approves the code."). */
export function groupApprovalWords(composition) {
  const byGroup = new Map();
  for (const entry of composition.groupApproves ?? []) {
    const step = composition.steps.find((candidate) => candidate.intent === entry.intent);
    if (!step) continue;
    const words = byGroup.get(entry.label ?? entry.group) ?? [];
    const word = approvedWord(composition.kind, step, composition);
    if (!words.includes(word)) words.push(word);
    byGroup.set(entry.label ?? entry.group, words);
  }
  return [...byGroup].map(([label, words]) => ` ${label} approves ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}.`).join('');
}

/** Each kind's steps by intent, as a task of that kind is composed before the team's rules [ITW:REQ-003]. */
export const kindSteps = (kind) => [...(KIND_STEPS[kind] ?? [])];

/**
 * The one plan line a person reads [ITW:REQ-012]: the steps after the intake, each with the skills it uses or offers
 * [ITW:REQ-010], then what the person approves. `approvals` maps a step to 'person' where a person approves it;
 * `skills` maps a step to its skills and `skillWords` says them (task-skills.mjs planSkillWords).
 */
export function planLine(composition, { approvals = {}, pullRequest = false, skills = {}, skillWords = null } = {}) {
  const words = planSteps(composition).map((step) => {
    const said = skillWords && skills[step.id]?.length ? skillWords(skills[step.id]) : '';
    const word = step.word ?? (said ? step.intent : null);
    return word ? `${word}${said}` : null;
  }).filter(Boolean);
  if (composition.kind === 'investigate') words.push('report');
  if (composition.kind === 'review') words.push('findings');
  if (pullRequest) words.push('pull request');
  const who = `${approvalWords(composition, approvals)}${groupApprovalWords(composition)}`;
  // A marketplace agent's workflow, or the team's own, as the plan says whose it is [ITW:REQ-011, REQ-020].
  const whose = composition.agent ? `, from ${agentWords(composition.agent)}` : composition.local ? `, from your team's workflow ${composition.local.label}` : '';
  // A sized code task says its shape: small until its requirement says big [ITW:REQ-101, REQ-103].
  const shape = taskShape(composition);
  const sized = shape === 'small' ? ' Small or big is decided with the requirement.' : '';
  return `Plan${whose}: ${words.join(' → ')}.${who}${sized} Say "add a design step" to change it.`;
}

/**
 * The steps the plan line names, each with its word: a step of an intent the plan has no word for (an agent's or the
 * team's own workflow's document, release or report step) is named by its label.
 */
export function planSteps(composition) {
  return composition.steps.map((step) => ({ ...step,
    word: planWord(composition.kind, step, composition) ?? ((composition.agent || composition.local) && step.intent !== 'intake' ? String(step.label ?? step.id).toLowerCase() : null) }));
}

/** A first guess at the kind from the words, for the terminal when no agent named it: the first kind they name, by priority. */
export function kindFromWords(words) {
  const text = ` ${String(words ?? '').toLowerCase()} `;
  const hits = [
    ['investigate', /\b(why|investigate|investigation|find out|root cause|diagnose)\b/u],
    ['review', /\b(review|audit)\b/u],
    ['refactor', /\b(refactor|restructure|clean ?up|tidy|simplify)\b/u],
    ['docs', /\b(docs?|document|documentation|spec|specification|write up)\b/u],
    ['tests', /\b(tests?|test coverage|unit tests?)\b/u],
    ['fix', /\b(fix|bug|broken|crash|error|fails?|failing|wrong)\b/u],
    ['feature', /\b(add|new|feature|support|build|implement|create)\b/u],
    ['chore', /\b(bump|upgrade|update dependencies|rename|chore|lint)\b/u],
    ['change', /\b(change|make|move|replace|switch|use)\b/u]
  ].filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  return hits[0] ?? null;
}
