/**
 * `singularity-flow work "<words>" [--kind KIND] [--start] [--work-id ID] [--path FILE ...] [--json]` [ITW:REQ-001–007];
 * `singularity-flow work add <STEP> [--work-id ID] [--json]` [ITW:REQ-009].
 *
 * Shows the plan a task's words get, composed from its kind (src/task-composition.mjs), and writes nothing. With
 * `--start` it starts the Story: its ID is a Jira key the words or `--work-id` name, else the next free `<prefix>-<n>`
 * (`tasks.idPrefix`, default TASK); its base is the repository's default branch; its intake is the words. The composed
 * workflow is laid over the definition in memory and recorded on the Story, never written to workflow.yml. `/sf-task`
 * in Copilot runs this with the kind the agent named.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition, WORKFLOW_PATH } from '../config.mjs';
import { loadConfig } from '../state-stores.mjs';
import { branch, commitOfRef, committedFileText, localBranches, remoteBranches, remoteDefaultBranchName } from '../git.mjs';
import { repoRoot } from '../git-execution.mjs';
import { composeTask, kindFromWords, planLine, TASK_KINDS, taskDefinition, taskRules } from '../task-composition.mjs';
import { walkTaskWorkType } from '../task-walk.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

const JIRA_KEY = /\b([A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,9})\b/u;

function wordsOf(positionals) {
  const words = positionals.slice(1).join(' ').trim();
  if (!words) {
    throw new SingularityFlowError('Say what the task is: singularity-flow work "fix the login timeout on slow networks".', {
      code: 'TASK_WORDS_MISSING',
      details: { nextAction: { command: 'singularity-flow work "<what you want done>"', label: 'Say what you want done, in your own words.' } }
    });
  }
  return words;
}

function quoted(words) {
  return `"${words.replace(/(["\\$`])/gu, '\\$1')}"`;
}

function kindOf(words, options) {
  const named = optionString(options, 'kind');
  if (named) {
    if (!TASK_KINDS.includes(named)) {
      throw new SingularityFlowError(`'${named}' is not a kind of task. A task is one of: ${TASK_KINDS.join(', ')}.`, {
        code: 'TASK_KIND_UNKNOWN',
        details: { kinds: [...TASK_KINDS], nextAction: { command: `singularity-flow work ${quoted(words)} --kind ${kindFromWords(words) ?? 'change'}`, label: 'Use one of the kinds.' } }
      });
    }
    return named;
  }
  const guessed = kindFromWords(words);
  if (guessed) return guessed;
  throw new SingularityFlowError('Say which kind of task this is: the words alone do not say.', {
    code: 'TASK_KIND_NEEDED',
    details: {
      kinds: [...TASK_KINDS],
      choices: TASK_KINDS.map((kind) => ({ kind, command: `singularity-flow work ${quoted(words)} --kind ${kind}` })),
      nextAction: { command: `singularity-flow work ${quoted(words)} --kind change`, label: 'Name the kind of task.' }
    }
  });
}

const approvalOf = (phase) => phase.approval?.mode === 'none' ? 'none'
  : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person';

/**
 * The task's plan: composed, checked and walked as a Story start would, with nothing written. `chooseSkills`, given the
 * composed steps, returns the skills each step uses and offers (task-skills.mjs taskSkillChooser) [ITW:REQ-010].
 */
export async function taskPlan(definition, { kind, touchedPaths = [], pullRequest = false, add = [], skip = [], chooseSkills = null } = {}) {
  const composed = composeTask(definition, { kind, touchedPaths, add, skip });
  const chosen = chooseSkills ? await chooseSkills(composed) : null;
  // The skills a Story uses are part of its composition, so its snapshot freezes their exact text with its steps.
  const composition = { ...composed, ...(chosen?.skills.length ? { skills: chosen.skills } : {}), ...(pullRequest ? { pullRequest: true } : {}) };
  const overlaid = validateDefinition(structuredClone(taskDefinition(definition, composition)));
  const resolved = assertWorkTypeStartable(resolveWorkType(overlaid, composition.workType));
  const walk = await walkTaskWorkType(overlaid, resolved);
  const approvals = Object.fromEntries(resolved.phases.map((phase) => [phase.id, approvalOf(phase)]));
  const byStep = chosen?.byStep ?? {};
  const skillWords = Object.keys(byStep).length ? (await import('../task-skills.mjs')).planSkillWords : null;
  return {
    composition,
    plan: planLine(composition, { approvals, pullRequest, skills: byStep, skillWords }),
    steps: composition.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label, approvedBy: approvals[step.id],
      ...(byStep[step.id]?.length ? { skills: byStep[step.id].map((entry) => entry.id) } : {}) })),
    walk: walk.outcome,
    ...(chosen ? { skills: chosen.skills, offers: chosen.offers, ...(chosen.notes?.length ? { notes: chosen.notes } : {}) } : {})
  };
}

/** The next free `<prefix>-<n>` among this repository's branches and Stories. */
export function nextTaskWorkId(root, prefix, { remote = 'origin' } = {}) {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, 'iu');
  const names = new Set();
  const add = (name) => { if (name) names.add(String(name).split('/').pop()); };
  try { localBranches(root).forEach(add); } catch { /* no local branches */ }
  try { add(branch(root)); } catch { /* detached */ }
  try { remoteBranches(root, remote).forEach(add); } catch { /* no remote */ }
  for (const folder of ['singularity/work-items', '.sdlc/work-items']) {
    const directory = path.join(root, folder);
    if (existsSync(directory)) readdirSync(directory).forEach(add);
  }
  let highest = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${highest + 1}`;
}

function workIdFor(root, words, definition, options) {
  const given = optionString(options, 'work-id');
  if (given) return given;
  const key = JIRA_KEY.exec(words)?.[1];
  if (key) return key;
  return nextTaskWorkId(root, taskRules(definition).idPrefix, { remote: definition.git?.remote ?? 'origin' });
}

/**
 * The repository a task is for: the checkout this runs in, else, from a workspace folder that is no repository (VS Code
 * opened on a folder holding the repository), the selected workspace repository's own checkout, as start finds it.
 */
async function taskRepositoryRoot() {
  try { return repoRoot(); } catch { /* not in a checkout: the selected workspace below */ }
  const { activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile } = await import('../workspace-context.mjs');
  const selected = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }).catch(() => null);
  if (selected?.workspacePath && selected.repositoryId) {
    const { readWorkspace, workspaceRepositoryPath } = await import('../workspace-manifest.mjs');
    const workspace = await readWorkspace(selected.workspacePath).catch(() => null);
    const repository = workspace?.repositories?.[selected.repositoryId];
    if (repository) return workspaceRepositoryPath(workspace, repository);
  }
  throw new SingularityFlowError('Run this inside the repository, or select its workspace first, so the task knows which repository it is for.', {
    code: 'TASK_REPOSITORY_UNKNOWN',
    details: { nextAction: { command: 'singularity-flow workspace list', label: 'See the workspaces; select the one that holds the repository.' } }
  });
}

/** The Story in progress on this checkout's branch, if any. */
function openStoryHere(root) {
  let current = null;
  try { current = branch(root); } catch { return null; }
  if (!current) return null;
  for (const folder of ['singularity/work-items', '.sdlc/work-items']) {
    const file = path.join(root, folder, current, 'workflow.json');
    if (!existsSync(file)) continue;
    try {
      const workflow = JSON.parse(readFileSync(file, 'utf8'));
      if (workflow?.status === 'in_progress') return workflow.workItem?.id ?? current;
    } catch { return null; }
  }
  return null;
}

const WORK_ITEMS = ['singularity/work-items', '.sdlc/work-items'];
// "… and open a pull request" in the task's own words: the plan ends with it [ITW:REQ-018].
const ASKS_FOR_PULL_REQUEST = /\b(?:and|then)\s+(?:open|create|raise)\s+(?:a|the)\s+(?:pull request|PR)\b/iu;
const REPORT_LIMIT = 16 * 1024;

/** A Story's record as its own branch holds it (this checkout's copy when it is on that branch). */
function storyRecordOf(root, id, remote = 'origin') {
  for (const folder of WORK_ITEMS) {
    const file = path.join(root, folder, id, 'workflow.json');
    if (existsSync(file) && branchName(root) === id) {
      try { return { workflow: JSON.parse(readFileSync(file, 'utf8')), folder, ref: null }; } catch { return null; }
    }
  }
  for (const ref of [id, `${remote}/${id}`]) {
    if (!commitOfRef(root, ref)) continue;
    for (const folder of WORK_ITEMS) {
      const text = committedFileText(root, ref, `${folder}/${id}/workflow.json`);
      if (text) { try { return { workflow: JSON.parse(text), folder, ref }; } catch { return null; } }
    }
  }
  return null;
}

function branchName(root) { try { return branch(root); } catch { return null; } }

function storyFileText(root, record, id, relative) {
  const inItem = `${record.folder}/${id}/${relative}`;
  if (!record.ref) {
    const file = path.join(root, inItem);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  return committedFileText(root, record.ref, inItem);
}

/** The report an investigation or review left (its last step's document), for a task that starts from it [ITW:REQ-013]. */
function reportOf(root, id, remote) {
  const record = storyRecordOf(root, id, remote);
  if (!record) {
    throw new SingularityFlowError(`There is no task ${id} here to start from.`, {
      code: 'TASK_FROM_UNKNOWN', details: { nextAction: { command: 'singularity-flow work status', label: 'See the task open on this checkout.' } } });
  }
  const last = record.workflow.phaseOrder?.at(-1);
  const artifact = record.workflow.phases?.[last]?.requiredArtifact?.path;
  const text = artifact ? storyFileText(root, record, id, artifact) : null;
  if (!text) {
    throw new SingularityFlowError(`${id} has no report yet to start from: its last step has not written one.`, {
      code: 'TASK_FROM_NO_REPORT', details: { nextAction: { command: `singularity-flow work status ${id}`, label: `See where ${id} stands.` } } });
  }
  return { artifact, text: text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}\n\n[… the report continues in ${id}'s ${artifact}]` : text };
}

/**
 * Where a task stands, for its last message [ITW:REQ-018]: each step and who approved it, the branch the change is on,
 * whether the person asked for a pull request, and the documents a person reads for what was checked. Reads only.
 */
export function taskStatus(root, id, { remote = 'origin' } = {}) {
  const record = storyRecordOf(root, id, remote);
  if (!record) {
    throw new SingularityFlowError(`There is no task ${id} here.`, {
      code: 'TASK_UNKNOWN', details: { nextAction: { command: 'singularity-flow work "<what you want done>"', label: 'Start a task.' } } });
  }
  const { workflow } = record;
  const steps = (workflow.phaseOrder ?? []).map((stepId) => {
    const phase = workflow.phases?.[stepId] ?? {};
    const approvedBy = phase.status !== 'approved' ? null
      : phase.approvalDisposition === 'approved_automatically' ? 'sflow' : phase.approvedBy ? 'person' : 'none-needed';
    return { id: stepId, label: phase.label ?? stepId, status: phase.status ?? 'not_started', approvedBy,
      document: phase.requiredArtifact?.path ? `${record.folder}/${id}/${phase.requiredArtifact.path}` : null };
  });
  const composition = workflow.resolution?.composition ?? null;
  const done = steps.length > 0 && steps.every((step) => step.status === 'approved' || step.status === 'skipped');
  return {
    schemaVersion: 1, resultType: 'sflow-task-status', id, kind: composition?.kind ?? null, title: workflow.workItem?.title ?? null,
    status: workflow.status, done, branch: workflow.workItem?.branch ?? id, base: workflow.workItem?.baseBranch ?? null,
    pullRequest: composition?.pullRequest === true, steps,
    personApproved: steps.filter((step) => step.approvedBy === 'person').map((step) => step.label),
    words: done
      ? `${id} is done: ${steps.map((step) => step.label).join(', ')}, on branch ${workflow.workItem?.branch ?? id}.`
      : `${id} is at ${steps.find((step) => step.status !== 'approved' && step.status !== 'skipped')?.label ?? 'its next step'}.`
  };
}

/** The command that starts this task with the options the person gave, and `extra` after them. */
function startCommand(words, kind, options, extra = []) {
  const repeated = (name) => optionStrings(options, name).map((value) => `--${name} ${/^[\w./@:-]+$/u.test(value) ? value : quoted(value)}`);
  const single = (name) => { const value = optionString(options, name); return value ? [`--${name} ${/^[\w./@:-]+$/u.test(value) ? value : quoted(value)}`] : []; };
  return ['singularity-flow work', quoted(words), `--kind ${kind}`, '--start', ...single('work-id'), ...single('base'), ...single('from'),
    ...repeated('path'), ...repeated('document'), ...repeated('add'), ...repeated('skip'), ...(optionBoolean(options, 'new') ? ['--new'] : []),
    ...repeated('use-skill'), ...repeated('without-skill'), ...extra].join(' ');
}

/** What the person is asked about a skill offered for a step, and the option each answer adds to the start. */
function skillOffer(offer, composition) {
  const steps = offer.steps.map((id) => composition.steps.find((step) => step.id === id)?.label ?? id).map((label) => label.toLowerCase());
  const where = `for the ${steps.join(' and ')} step${steps.length > 1 ? 's' : ''}`;
  const ask = offer.new
    ? `Add ${offer.id} from ${offer.marketplace} to this repository's skills and use it ${where}${offer.state ? ` (the marketplace marks it ${offer.state})` : ''}?`
    : `Use ${offer.id} ${where}? It is marked ${offer.state}.`;
  return {
    id: offer.id, steps: offer.steps, source: offer.source, marketplace: offer.marketplace, new: offer.new, state: offer.state, why: offer.why, ask,
    // A new one's text is shown before the yes, and the yes imports it as any import is added (its addCommand).
    ...(offer.new ? { show: `singularity-flow import preview ${quoted(`market:${offer.marketplace}/${offer.id}`)} --as skill --json` } : {}),
    yes: `--use-skill ${offer.id}`, no: `--without-skill ${offer.id}`
  };
}

function titleOf(words) {
  const line = words.split(/\r?\n/u)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

/**
 * `work add <STEP>` [ITW:REQ-009]: the task open on this checkout (or --work-id) gains a step after its current one,
 * recorded as a new revision of its pinned workflow (src/task-amendment.mjs). `work skip <STEP>` on a started task is
 * refused: after the start a task only gains steps.
 */
async function changeTask(positionals, options) {
  const verb = positionals[1];
  const intent = positionals[2];
  if (!intent) {
    throw new SingularityFlowError(`Say which step: singularity-flow work ${verb} design. A task can gain a requirements, design, plan or review step.`, {
      code: 'TASK_STEP_MISSING', details: { nextAction: { command: `singularity-flow work ${verb} design`, label: 'Name the step.' } } });
  }
  const root = await taskRepositoryRoot();
  const id = optionString(options, 'work-id') ?? openStoryHere(root);
  if (!id) {
    throw new SingularityFlowError('There is no task open on this checkout to change. Check out its branch, or name it with --work-id.', {
      code: 'TASK_UNKNOWN', details: { nextAction: { command: 'singularity-flow work status', label: 'See the task open on this checkout.' } } });
  }
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const loaded = await loadAcceptedStoryExecution(root, id);
  const amendment = await import('../task-amendment.mjs');
  if (verb === 'skip') return amendment.refuseTaskStepRemoval(loaded.workflow, intent);
  return amendment.addTaskStep(root, loaded.config ?? loaded.definition, loaded.workflow, { intent, definition: await loadConfig(root) });
}

export async function workCommand(positionals = [], options = {}) {
  if (positionals[1] === 'add' || positionals[1] === 'skip') return changeTask(positionals, options);
  if (positionals[1] === 'status') {
    const root = await taskRepositoryRoot();
    const definition = existsSync(path.join(root, WORKFLOW_PATH)) ? await loadConfig(root) : {};
    const id = positionals[2] ?? openStoryHere(root) ?? branchName(root);
    return taskStatus(root, id, { remote: definition.git?.remote ?? 'origin' });
  }
  const words = wordsOf(positionals);
  const kind = kindOf(words, options);
  const root = await taskRepositoryRoot();
  if (!existsSync(path.join(root, WORKFLOW_PATH))) {
    throw new SingularityFlowError('This repository does not use SFlow yet, so a task has no steps to use. Set it up first.', {
      code: 'TASK_REPOSITORY_NOT_SET_UP',
      details: { nextAction: { command: 'singularity-flow init', label: 'Set up SFlow in this repository.' } }
    });
  }
  const definition = await loadConfig(root);
  const touchedPaths = optionStrings(options, 'path');
  const use = optionStrings(options, 'use-skill');
  const without = optionStrings(options, 'without-skill');
  const { taskSkillChooser } = await import('../task-skills.mjs');
  const preview = await taskPlan(definition, { kind, touchedPaths, pullRequest: ASKS_FOR_PULL_REQUEST.test(words),
    add: optionStrings(options, 'add'), skip: optionStrings(options, 'skip'),
    chooseSkills: taskSkillChooser(root, definition, { words, touchedPaths, use, without }) }).catch((error) => {
    // A yes to a marketplace skill whose import is not in the library yet (it waits for its review): this task starts
    // without it, and the next one finds it there.
    if (error?.code === 'TASK_SKILL_NOT_IN_LIBRARY') {
      const skill = error.details.skill;
      const rest = { ...options, 'use-skill': use.filter((id) => id !== skill), 'without-skill': [...without, skill] };
      error.details.nextAction = { command: startCommand(words, kind, rest), label: `Start the task without ${skill} for now.` };
    }
    throw error;
  });
  const start = startCommand(words, kind, options);
  const offers = preview.offers.map((offer) => skillOffer(offer, preview.composition));
  if (!optionBoolean(options, 'start')) {
    return {
      schemaVersion: 1, resultType: 'sflow-task-plan', kind, words, plan: preview.plan, steps: preview.steps,
      rules: preview.composition.rules, added: preview.composition.added,
      ...(preview.skills.length ? { skills: preview.skills } : {}), ...(offers.length ? { offers } : {}),
      ...(preview.notes?.length ? { notes: preview.notes } : {}),
      next: { command: start, label: offers.length ? 'Start the task after a yes or no to each skill offered.' : 'Start the task.' }
    };
  }
  // A task open on this checkout takes the words as its own: an answer, or the change wanted. Only "new task" (--new)
  // starts another here [ITW:REQ-017]; a model's guess never starts a second Story over the first one.
  const open = openStoryHere(root);
  if (open && !optionBoolean(options, 'new')) {
    throw new SingularityFlowError(`${open} is open on this checkout, so these words are for it: its question's answer, or the change you want.`, {
      code: 'TASK_OPEN_HERE',
      details: { openTask: open, newTask: `singularity-flow work ${quoted(words)} --kind ${kind} --start --new`,
        nextAction: { command: `singularity-flow work status ${open}`, label: `Carry ${open} on with the person's words.` } }
    });
  }
  // A skill that needs the person's yes is asked before the Story starts: its snapshot then freezes what they chose
  // [ITW:REQ-010]. The question names each skill and the step it is for; a no starts the task without it.
  if (offers.length) {
    const [first] = offers;
    throw new SingularityFlowError(`${preview.plan} The task starts once you say yes or no to ${offers.length > 1 ? 'each skill it offers' : `${first.id}`}: ${offers.map((offer) => offer.ask).join(' ')}`, {
      code: 'TASK_SKILL_YES_NEEDED',
      details: { plan: preview.plan, offers, start,
        nextAction: first.show
          ? { command: first.show, label: `Show ${first.id}'s text, then ask the person: ${first.ask}` }
          : { command: `${start} ${first.yes}`, label: `If the person says yes to: ${first.ask} (if no, add ${first.no} instead)` } }
    });
  }
  const id = workIdFor(root, words, definition, options);
  const remote = definition.git?.remote ?? 'origin';
  const base = optionString(options, 'base') ?? remoteDefaultBranchName(root, definition, remote) ?? 'main';
  const from = optionString(options, 'from');
  const report = from ? reportOf(root, from, remote) : null;
  const documents = optionStrings(options, 'document').map((file) => path.resolve(process.cwd(), file));
  const startOptions = {
    ...(optionBoolean(options, 'json') ? { json: true } : {}),
    title: titleOf(words),
    // A task that starts from an investigation carries its report as its intake [ITW:REQ-013]: nothing is asked again.
    description: report ? `${words}\n\n## Starts from ${from}'s report (${report.artifact})\n\n${report.text}` : words,
    // A document the task is about, pinned at the version it starts with [ITW:REQ-016].
    ...(documents.length ? { document: documents } : {}),
    'work-type': preview.composition.workType,
    base,
    yes: true
  };
  if (!optionBoolean(options, 'json')) console.log(preview.plan);
  const { startTaskStory } = await import('./start.mjs');
  return startTaskStory(['start', id], startOptions, preview.composition, { plan: preview.plan }).catch((error) => {
    // The plan read a skill this checkout has but the Story's base does not, or has otherwise: started without it.
    if (error?.code === 'TASK_SKILL_CHANGED' && error.details?.skill) {
      error.details.nextAction = { command: startCommand(words, kind, { ...options, 'use-skill': use.filter((skill) => skill !== error.details.skill),
        'without-skill': [...without, error.details.skill] }), label: `Start the task without ${error.details.skill}.` };
    }
    throw error;
  });
}

function printPlan(result) {
  console.log(result.plan);
  for (const step of result.steps) {
    console.log(`  ${step.label}${step.approvedBy === 'person' ? ' — you approve it' : step.approvedBy === 'sflow' ? ' — SFlow approves it when clean' : ''}${step.skills?.length ? `; skills: ${step.skills.join(', ')}` : ''}`);
  }
  for (const added of result.added ?? []) console.log(`Added by the team's rules: ${added.intent} (${added.because})`);
  for (const skill of result.skills ?? []) console.log(`Skill ${skill.id}: ${skill.why}.`);
  for (const offer of result.offers ?? []) {
    console.log(`${offer.ask} ${offer.why}.`);
    if (offer.show) console.log(`  Read its text first: ${offer.show}`);
    console.log(`  Yes: add ${offer.yes} to the start. No: add ${offer.no}.`);
  }
  for (const note of result.notes ?? []) console.log(`Note: ${note}`);
  console.log(`\nStart it: ${result.next.command}`);
}

export async function run(_argv, { positionals = ['work'], options = {} } = {}) {
  const result = await workCommand(positionals, options);
  if (result?.resultType === 'sflow-task-change') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`${result.words}\n${result.plan}`);
    return result;
  }
  if (result?.resultType === 'sflow-task-status') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.words);
      for (const step of result.steps) console.log(`  ${step.label}: ${step.status.replace(/_/gu, ' ')}${step.approvedBy === 'person' ? ', approved by a person' : step.approvedBy === 'sflow' ? ', approved by SFlow' : ''}`);
    }
    return result;
  }
  if (result?.resultType === 'sflow-task-plan') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printPlan(result);
  }
  return result;
}
