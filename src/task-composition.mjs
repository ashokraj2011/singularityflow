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
 */
import { SingularityFlowError } from './util.mjs';

export const TASK_KINDS = Object.freeze(['fix', 'feature', 'change', 'refactor', 'tests', 'docs', 'investigate', 'review', 'chore']);
export const TASK_COMPOSITION_VERSION = 1;
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

/** Where an added step goes: the order a workflow's steps keep. */
const INTENT_ORDER = Object.freeze(['intake', 'requirements', 'design', 'plan', 'code', 'test', 'review']);

/** The packaged step each intent prefers, when the repository still has it for that intent. */
const PREFERRED_STEP = Object.freeze({
  intake: 'intake', requirements: 'requirements', design: 'design', plan: 'implementation-spec',
  code: 'implementation', test: 'verification', review: 'conformance'
});

const KIND_WORDS = Object.freeze({
  fix: 'Fix', chore: 'Chore', change: 'Change', feature: 'Feature', refactor: 'Refactor', tests: 'Tests',
  docs: 'Document', investigate: 'Investigation', review: 'Review'
});

/** A step's label in a task: what it does for this kind, in a developer's words. */
function stepLabel(kind, intent) {
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

/** The team's rules for tasks [ITW:REQ-004]: `tasks:` in workflow.yml, checked; absent means the defaults. */
export function taskRules(definition) {
  const raw = definition?.tasks;
  if (raw === undefined || raw === null) return { idPrefix: 'TASK', always: [], paths: [], use: {} };
  const where = 'workflow.yml tasks';
  const fail = (message) => { throw taskRefusal('TASK_RULES_INVALID', `${where}: ${message}`, {
    command: 'singularity-flow workflow check', label: 'Check the workflow configuration, then fix the tasks: rules it names.' }); };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('must be a mapping.');
  const known = new Set(['idPrefix', 'always', 'paths', 'use']);
  for (const key of Object.keys(raw)) if (!known.has(key)) fail(`'${key}' is not a tasks rule; use idPrefix, always, paths or use.`);
  const idPrefix = raw.idPrefix ?? 'TASK';
  if (typeof idPrefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,15}$/u.test(idPrefix)) fail('idPrefix must be letters and digits, starting with a letter (for example TASK).');
  const intents = (value, label) => {
    const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
    for (const intent of list) if (!INTENT_ORDER.includes(intent)) fail(`${label} names '${intent}'; a step is one of ${INTENT_ORDER.join(', ')}.`);
    return list;
  };
  const kinds = (value, label) => {
    const list = value === undefined ? ['all'] : Array.isArray(value) ? value : [value];
    for (const kind of list) if (kind !== 'all' && !TASK_KINDS.includes(kind)) fail(`${label} names the kind '${kind}'; a kind is one of ${TASK_KINDS.join(', ')}, or all.`);
    return list;
  };
  const rule = (entry, label) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} must be a mapping.`);
    for (const key of Object.keys(entry)) {
      if (!['kinds', 'paths', 'steps', 'personApproves', 'because'].includes(key)) fail(`${label} has '${key}'; a rule has kinds, paths, steps, personApproves and because.`);
    }
    if (typeof entry.because !== 'string' || !entry.because.trim()) fail(`${label} needs a because: the team's reason, shown when the rule adds a step.`);
    return { kinds: kinds(entry.kinds, `${label} kinds`), steps: intents(entry.steps, `${label} steps`),
      personApproves: intents(entry.personApproves, `${label} personApproves`), because: entry.because.trim() };
  };
  const always = (raw.always ?? []);
  if (!Array.isArray(always)) fail('always must be a list of rules.');
  const paths = (raw.paths ?? []);
  if (!Array.isArray(paths)) fail('paths must be a list of rules.');
  const use = raw.use ?? {};
  if (typeof use !== 'object' || Array.isArray(use)) fail('use must map a kind to a workflow.');
  for (const [kind, workType] of Object.entries(use)) {
    if (!TASK_KINDS.includes(kind)) fail(`use names the kind '${kind}'; a kind is one of ${TASK_KINDS.join(', ')}.`);
    if (!definition.workTypes?.[workType]) fail(`use sends ${kind} to '${workType}', which is not a workflow here.`);
  }
  return {
    idPrefix,
    always: always.map((entry, index) => rule(entry, `always[${index}]`)),
    paths: paths.map((entry, index) => {
      const checked = rule(entry, `paths[${index}]`);
      const globs = Array.isArray(entry.paths) ? entry.paths : [entry.paths];
      if (!globs.length || globs.some((glob) => typeof glob !== 'string' || !glob.trim())) fail(`paths[${index}] needs paths: the files it is about.`);
      return { ...checked, paths: globs };
    }),
    use: { ...use }
  };
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
 * The composed task: its kind, its steps in order (each with the repository step it uses), the rules that added to it,
 * and the work type the Story pins. Deterministic: the same kind, definition and touched paths give the same result.
 */
/** The steps a person may add to a task before it starts, or take out of it, by intent [ITW:REQ-009]. */
const ADDABLE = Object.freeze(['requirements', 'design', 'plan', 'review']);

export function composeTask(definition, { kind, touchedPaths = [], add = [], skip = [] } = {}) {
  if (!TASK_KINDS.includes(kind)) {
    throw taskRefusal('TASK_KIND_UNKNOWN', `'${kind}' is not a kind of task. A task is one of: ${TASK_KINDS.join(', ')}.`,
      { command: 'singularity-flow work "<what you want done>" --kind change', label: 'Name one of the kinds of task.' }, { kinds: [...TASK_KINDS] });
  }
  const rules = taskRules(definition);
  const used = rules.use[kind];
  if (used) {
    return { schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: used, uses: used, steps: (definition.workTypes[used].phases ?? []).map((id) => ({
      id, intent: definition.phases?.[id]?.intent ?? null, label: definition.phases?.[id]?.label ?? id })), added: [], personApproves: [], rules: [
      { rule: `use.${kind}`, because: `This team runs every ${kind} task as the ${definition.workTypes[used].label ?? used} workflow.` }] };
  }
  const intents = [...KIND_STEPS[kind]];
  const changes = [];
  // The person's own changes come first; the team's rules are applied after them, so no rule's step is taken out.
  for (const intent of [...new Set(add)]) {
    if (!ADDABLE.includes(intent)) throw taskRefusal('TASK_CHANGE_REFUSED', `A task can gain a ${ADDABLE.join(', ')} step, not '${intent}'.`,
      { command: 'singularity-flow work "<what you want done>" --add design', label: 'Add one of the steps a task can gain.' }, { add: intent });
    if ((intent === 'review') && !intents.includes('code')) continue;
    if (!intents.includes(intent)) { intents.push(intent); changes.push({ change: 'add', intent }); }
  }
  const wantedOut = new Set(skip);
  for (const intent of wantedOut) {
    if (!intents.includes(intent)) continue;
    const kept = intent === 'intake' ? 'Every task starts with its intake.'
      : intent === 'code' && intents.includes('code') ? `A ${kind} task is its change; a task with no change is an investigate task.`
        : intent === 'test' && intents.includes('code') ? 'Every code change gets a test step.'
          : intent === 'design' && ['investigate', 'review', 'docs'].includes(kind) ? `A ${kind} task's ${kind === 'docs' ? 'document' : 'report'} is its design step.` : null;
    if (kept) throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: ${kept}`,
      { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the step.' }, { skip: intent });
    intents.splice(intents.indexOf(intent), 1);
    changes.push({ change: 'skip', intent });
  }
  const added = [];
  const personApproves = new Set();
  const applied = [];
  const apply = (rule, name) => {
    for (const intent of rule.steps) {
      if (wantedOut.has(intent)) {
        throw taskRefusal('TASK_CHANGE_REFUSED', `The ${intent} step stays: ${rule.because}`,
          { command: `singularity-flow work "<what you want done>" --kind ${kind}`, label: 'Keep the step the team\'s rule adds.' }, { skip: intent, rule: name });
      }
      // Only a code task gets a test or review step from a rule: a step that reads code needs code to read.
      if ((intent === 'test' || intent === 'review') && !intents.includes('code')) continue;
      if (!intents.includes(intent)) { intents.push(intent); added.push({ intent, rule: name, because: rule.because }); }
    }
    for (const intent of rule.personApproves) personApproves.add(intent);
    applied.push({ rule: name, because: rule.because });
  };
  rules.always.forEach((rule, index) => {
    if (rule.kinds.includes('all') || rule.kinds.includes(kind)) apply(rule, `always[${index}]`);
  });
  const touched = [...new Set(touchedPaths.map(String))].sort();
  rules.paths.forEach((rule, index) => {
    if (!(rule.kinds.includes('all') || rule.kinds.includes(kind))) return;
    if (touched.some((file) => rule.paths.some((glob) => pathMatches(glob, file)))) apply(rule, `paths[${index}]`);
  });
  intents.sort((left, right) => INTENT_ORDER.indexOf(left) - INTENT_ORDER.indexOf(right));
  const steps = intents.map((intent) => {
    const id = taskStepFor(definition, intent);
    if (!id) {
      throw taskRefusal('TASK_STEP_UNAVAILABLE',
        `This repository's workflow has no ${intent} step, which a ${kind} task needs. Add a step whose intent is ${intent} in Workflow Studio, or start the Story with a workflow of your own.`,
        { command: 'singularity-flow start <ID> --work-type <workflow>', label: 'Start the Story with one of the repository\'s workflows instead.' },
        { kind, intent });
    }
    return { id, intent, label: stepLabel(kind, intent) };
  });
  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) {
    throw taskRefusal('TASK_STEP_UNAVAILABLE', `This repository's workflow uses one step for two intents (${ids.join(', ')}), so a ${kind} task cannot be composed from it.`,
      { command: 'singularity-flow start <ID> --work-type <workflow>', label: 'Start the Story with one of the repository\'s workflows instead.' }, { kind });
  }
  return {
    schemaVersion: TASK_COMPOSITION_VERSION, kind, workType: taskWorkTypeId(kind), steps,
    added, personApproves: [...personApproves].filter((intent) => intents.includes(intent)).sort(), rules: applied,
    ...(changes.length ? { changes } : {}),
    ...(touched.length ? { touchedPaths: touched } : {})
  };
}

/** The work type a composition pins: its steps in order, each returning to any earlier step, labelled for the task. */
export function composedWorkType(definition, composition) {
  if (composition.uses) return structuredClone(definition.workTypes[composition.uses]);
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
      const rule = composition.rules.find((entry) => entry.because) ?? { because: 'The team\'s task rules give this step to a person.' };
      override.because = { ...(override.because ?? {}), 'approval.automatic': rule.because };
    }
    phaseOverrides[step.id] = override;
  });
  return {
    label: `${KIND_WORDS[composition.kind]} (task)`,
    description: `Composed by /sf-task from the kind ${composition.kind}: ${composition.steps.map((step) => step.label).join(' → ')}.`,
    phases: ids,
    phaseOverrides
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
  const chosen = [];
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

/** What a step is called in the plan line. */
function planWord(kind, step) {
  if (step.intent === 'design') return kind === 'investigate' ? 'investigate' : kind === 'review' ? 'review' : kind === 'docs' ? 'write the document' : 'design';
  if (step.intent === 'code') return kind === 'tests' ? 'write the tests' : 'code';
  return PLAN_WORDS[step.intent] ?? null;
}

/** What a person approves, named as they know it: the intake of a task with no plan step is its plan. */
function approvedWord(kind, step, composition) {
  if (step.intent === 'intake') return composition.steps.some((other) => other.intent === 'plan' || other.intent === 'requirements')
    ? 'the intake' : composition.steps.some((other) => other.intent === 'code') ? 'the plan in the intake' : 'the intake';
  if (step.intent === 'code') return kind === 'tests' ? 'the tests' : 'the code';
  if (step.intent === 'design') return kind === 'investigate' ? 'the report' : kind === 'review' ? 'the findings' : kind === 'docs' ? 'the document' : 'the design';
  if (step.intent === 'plan') return 'the plan';
  if (step.intent === 'test') return 'the test results';
  return `the ${step.intent}`;
}

/**
 * The one plan line a person reads [ITW:REQ-012]: the steps after the intake, then what the person approves.
 * `approvals` maps a step to 'person' where a person approves it.
 */
export function planLine(composition, { approvals = {}, pullRequest = false } = {}) {
  const words = composition.steps.map((step) => planWord(composition.kind, step)).filter(Boolean);
  if (composition.kind === 'investigate') words.push('report');
  if (composition.kind === 'review') words.push('findings');
  if (pullRequest) words.push('pull request');
  const approved = composition.steps.filter((step) => approvals[step.id] === 'person').map((step) => approvedWord(composition.kind, step, composition));
  const who = approved.length ? ` You approve ${approved.length > 1 ? `${approved.slice(0, -1).join(', ')} and ${approved.at(-1)}` : approved[0]}.` : '';
  return `Plan: ${words.join(' → ')}.${who} Say "add a design step" to change it.`;
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
