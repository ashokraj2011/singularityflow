/**
 * `singularity-flow work "<words>" [--kind KIND] [--start] [--work-id ID] [--path FILE ...] [--use-agent MARKETPLACE/AGENT] [--use-workflow ID] [--json]` [ITW:REQ-001–007, 011, 020];
 * `singularity-flow work add <STEP> [--work-id ID] [--json]` [ITW:REQ-009]; `singularity-flow work shape big [--work-id ID] [--json]` [ITW:REQ-103];
 * `singularity-flow work "<words>" --plan-only [--json]`, the likely plan, and `singularity-flow work list [--offline] [--json]`,
 * this person's tasks in flight and done this week [FPL:REQ-004, REQ-005, REQ-007].
 *
 * Shows the plan a task's words get, composed from its kind (src/task-composition.mjs), and writes nothing. With
 * `--start` it starts the Story: its ID is a Jira key the words or `--work-id` name, else the next free `<prefix>-<n>`
 * (`tasks.idPrefix`, default TASK); its base is the repository's default branch; its intake is the words. The composed
 * workflow is laid over the definition in memory and recorded on the Story, never written to workflow.yml. `/sf-task`
 * in Copilot runs this with the kind the agent named. When an agent of a trusted marketplace covers the task, the plan
 * offers its workflow (src/task-agents.mjs): `--use-agent` is the yes, `--without-agent` the no. The team's own workflow,
 * or an agent this repository has, comes before any marketplace's (src/task-local.mjs) [ITW:REQ-020]: `--use-workflow`
 * is the yes, `--without-workflow` the no.
 *
 * VS Code's Start Story starts a task too [ITW:REQ-114]: its words are `--description` (and `--title`), or a GitHub Issue
 * or Jira issue's own (`--github`, `--jira`), and the form's Story branch, bases, documents and checkout reach `start` as
 * start's own options (TASK_START_OPTIONS), which start reads and checks as for any Story.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition, WORKFLOW_PATH } from '../config.mjs';
import { loadConfig } from '../state-stores.mjs';
import { branch, commitOfRef, committedFileText, localBranches, remoteBranches, remoteDefaultBranchName } from '../git.mjs';
import { typedChangedPaths, typedMergeBase } from '../git-access.mjs';
import { documentStorageChoices } from '../document-storage-policy.mjs';
import { storyCreatorName } from '../story-presentation.mjs';
import { repoRoot } from '../git-execution.mjs';
import { agentWords, composeTask, kindFromWords, planLine, TASK_KINDS, taskDefinition, taskRules, taskShape } from '../task-composition.mjs';
import { addableSteps, nowAndNext, planChips, planNote, rulesApplied, standsWords, storyEvents, storySteps } from '../work-rows.mjs';
import { walkTaskWorkType } from '../task-walk.mjs';
import { nowIso, optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';
import { STATE_CHECKOUT, storiesDirectory, storiesRoot, storyLocation } from '../story-paths.mjs';

const JIRA_KEY = /\b([A-Z][A-Z0-9_]{1,31}-[1-9][0-9]{0,9})\b/u;

/** The person's words: after `work`, else `--description` (VS Code's Start Story) [ITW:REQ-114]. */
const typedWords = (positionals, options) => positionals.slice(1).join(' ').trim() || (optionString(options, 'description') ?? '').trim();

/** The words a task's kind and plan are read from: its title, when one is given, then its words. */
const planWords = (words, options) => [optionString(options, 'title')?.trim(), words].filter(Boolean).join('\n\n');

function wordsOf(positionals, options) {
  const words = typedWords(positionals, options);
  if (!words) {
    throw new SingularityFlowError('Say what the task is: singularity-flow work "fix the login timeout on slow networks".', {
      code: 'TASK_WORDS_MISSING',
      details: { nextAction: { command: 'singularity-flow work "<what you want done>"', label: 'Say what you want done, in your own words.' } }
    });
  }
  return words;
}

const SKILL_NAME_ONLY = /^\/?(?:sf|sflow)-[a-z][a-z-]*$/u;

function quoted(words) {
  return `"${words.replace(/(["\\$`])/gu, '\\$1')}"`;
}

export function kindOf(words, options) {
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

/** A plan line's entries no step is given: task-skills.mjs NOT_GIVEN, here so the plan reads it without that module. */
const NOT_GIVEN = new Set(['withheld', 'deprecated', 'deprecated-attached']);

const approvalOf = (phase) => phase.approval?.mode === 'none' ? 'none'
  : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person';

/**
 * The task's plan: composed, checked and walked as a Story start would, with nothing written. `chooseSkills`, given the
 * composed steps, returns the skills each step uses and offers (task-skills.mjs taskSkillChooser) [ITW:REQ-010].
 */
export async function taskPlan(definition, { kind, touchedPaths = [], pullRequest = false, add = [], skip = [], chooseSkills = null, chooseAgent = null } = {}) {
  let composed = composeTask(definition, { kind, touchedPaths, add, skip });
  // A marketplace agent whose stages cover the task is offered; once the person said yes, its steps are the plan [ITW:REQ-011].
  const found = chooseAgent ? await chooseAgent(composed) : null;
  if (found?.chosen) composed = composeTask(definition, { kind, touchedPaths, add, skip, agent: found.chosen });
  // The team's own workflow the person said yes to runs exactly as it is [ITW:REQ-020].
  if (found?.chosenWorkflow) composed = composeTask(definition, { kind, touchedPaths, add, skip, workflow: found.chosenWorkflow });
  const chosen = chooseSkills ? await chooseSkills(composed) : null;
  // The skills a Story uses are part of its composition, so its snapshot freezes their exact text with its steps.
  const composition = { ...composed, ...(chosen?.skills.length ? { skills: chosen.skills } : {}), ...(pullRequest ? { pullRequest: true } : {}) };
  const overlaid = validateDefinition(structuredClone(taskDefinition(definition, composition)));
  const resolved = assertWorkTypeStartable(resolveWorkType(overlaid, composition.workType));
  const walk = await walkTaskWorkType(overlaid, resolved);
  const approvals = Object.fromEntries(resolved.phases.map((phase) => [phase.id, approvalOf(phase)]));
  const byStep = chosen?.byStep ?? {};
  const skillWords = Object.keys(byStep).length ? (await import('../task-skills.mjs')).planSkillWords : null;
  const notes = [...(chosen?.notes ?? []), ...(found?.notes ?? [])];
  return {
    composition,
    plan: planLine(composition, { approvals, pullRequest, skills: byStep, skillWords }),
    steps: composition.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label, approvedBy: approvals[step.id],
      // A skill SFlow's text checks refuse, or its marketplace deprecated, is named in the plan line, never given to the
      // step [OMK:REQ-032, REQ-041] (task-skills.mjs NOT_GIVEN).
      ...(byStep[step.id]?.some((entry) => !NOT_GIVEN.has(entry.status)) ? { skills: byStep[step.id].filter((entry) => !NOT_GIVEN.has(entry.status)).map((entry) => entry.id) } : {}) })),
    walk: walk.outcome,
    ...(chosen ? { skills: chosen.skills, offers: chosen.offers } : {}),
    ...(found?.offer ? { agentOffer: found.offer } : {}),
    // The team's own workflow, used with no question [ITW:REQ-108].
    ...(found?.used ? { usedWorkflow: found.used } : {}),
    ...(notes.length ? { notes } : {})
  };
}

/** The next free `<prefix>-<n>` among this repository's branches and Stories. */
export function nextTaskWorkId(root, prefix, { remote = 'origin', reserved = [] } = {}) {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`, 'iu');
  const names = new Set();
  const add = (name) => { if (name) names.add(String(name).split('/').pop()); };
  try { localBranches(root).forEach(add); } catch { /* no local branches */ }
  try { add(branch(root)); } catch { /* detached */ }
  try { remoteBranches(root, remote).forEach(add); } catch { /* no remote */ }
  for (const folder of WORK_ITEMS) {
    const directory = storiesDirectory(root, { workItemRoot: folder });
    if (existsSync(directory)) readdirSync(directory).forEach(add);
  }
  reserved.forEach(add);
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
  for (const folder of WORK_ITEMS) {
    const file = storyLocation(root, { workItemRoot: folder }, current).workflowFile;
    if (!existsSync(file)) continue;
    try {
      const workflow = JSON.parse(readFileSync(file, 'utf8'));
      if (workflow?.status === 'in_progress') return workflow.workItem?.id ?? current;
    } catch { return null; }
  }
  return null;
}

// SFlow's Stories folder, and the office SDLC marketplace's work items, read the same way.
const WORK_ITEMS = [storiesRoot(), '.sdlc/work-items'];
// "… and open a pull request" in the task's own words: the plan ends with it [ITW:REQ-018].
const ASKS_FOR_PULL_REQUEST = /\b(?:and|then)\s+(?:open|create|raise)\s+(?:a|the)\s+(?:pull request|PR)\b/iu;
const REPORT_LIMIT = 16 * 1024;

export const taskPlanForWords = (definition, words, options) => taskPlan(definition, {
  ...options, pullRequest: ASKS_FOR_PULL_REQUEST.test(words)
});

/** The branch a Story's record says it is on. */
const recordBranch = (workflow) => workflow?.lineage?.canonicalBranch ?? workflow?.workItem?.branch ?? workflow?.workItem?.id ?? null;

/**
 * A Story's record as its own branch holds it (this checkout's copy when it is on that branch). A Story whose branch is
 * not named after its ID (a classic Story) is found on this checkout by the branch its record names, else where the Story
 * list's state index points: from this clone when its objects are here, else read from its remote as Needs you reads it
 * (`away`: nothing of it is checked out or kept) [FPL:REQ-006].
 */
async function storyRecordOf(root, id, remote = 'origin', { definition = null } = {}) {
  const current = branchName(root);
  // A state-ref Story checked out here keeps its record in its state checkout, and its folder is that checkout [SSB M3].
  const stateFile = storyLocation(root, null, id, { layout: 'state-ref' }).workflowFile;
  if (existsSync(stateFile)) {
    try {
      const workflow = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (workflow?.workItem?.id === id && (current === id || recordBranch(workflow) === current)) return { workflow, folder: null, item: STATE_CHECKOUT, ref: null };
    } catch { /* not this Story's */ }
  }
  for (const folder of WORK_ITEMS) {
    const file = storyLocation(root, { workItemRoot: folder }, id).workflowFile;
    if (!existsSync(file)) continue;
    let workflow = null;
    try { workflow = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    if (current === id || (current && workflow?.workItem?.id === id && recordBranch(workflow) === current)) return { workflow, folder, ref: null };
  }
  for (const ref of [id, `${remote}/${id}`]) {
    if (!commitOfRef(root, ref)) continue;
    for (const folder of WORK_ITEMS) {
      const text = committedFileText(root, ref, storyLocation(null, { workItemRoot: folder }, id).object('workflow.json').path);
      if (text) { try { return { workflow: JSON.parse(text), folder, ref }; } catch { return null; } }
    }
  }
  if (!definition?.ledger) return null;
  try {
    const { ledgerStoryPointers } = await import('../ledger.mjs');
    const pointer = (await ledgerStoryPointers(root, definition.ledger, { offline: true })).items.find((item) => item.id === id);
    if (!pointer?.commitOid) return null;
    const relative = storyLocation(null, definition, id).object('workflow.json').path;
    const text = commitOfRef(root, pointer.commitOid) ? committedFileText(root, pointer.commitOid, relative) : null;
    if (text) return { workflow: JSON.parse(text), folder: path.posix.dirname(path.posix.dirname(relative)), ref: pointer.commitOid };
    // Not on this computer: read where the Story list points, as Needs you and session candidates read it; nothing is
    // checked out. Its files are not here, so its changed files are not either.
    const { discoverRemoteStoryCandidates } = await import('../session-story-discovery.mjs');
    const roster = await discoverRemoteStoryCandidates(root, definition, { fetch: true, includeState: true, skip: (entry) => entry.id !== id });
    const found = (roster.items ?? []).find((item) => item.id === id && item.state);
    return found ? { workflow: found.state, folder: path.posix.dirname(path.posix.dirname(found.path ?? relative)), ref: found.commitOid, away: true } : null;
  } catch { return null; }
}

function branchName(root) { try { return branch(root); } catch { return null; } }

/** The Story's folder as the checkout or its commit names it: `<Stories folder>/<ID>`, or a state-ref Story's state checkout. */
const itemOf = (record, id) => record.item ?? `${record.folder}/${id}`;

function storyFileText(root, record, id, relative) {
  const inItem = `${itemOf(record, id)}/${relative}`;
  if (!record.ref) {
    const file = path.join(root, inItem);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }
  return committedFileText(root, record.ref, inItem);
}

/** The report an investigation or review left (its last step's document), for a task that starts from it [ITW:REQ-013]. */
async function reportOf(root, id, remote) {
  const record = await storyRecordOf(root, id, remote);
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
 * whether the person asked for a pull request, and the documents a person reads for what was checked. Once it is done,
 * `checksOf` (task-checks.mjs) adds the checks that ran and, for a refactor, what its plan says must not change that no
 * check covered [ITW:REQ-015, A13]. Reads only.
 */
export async function taskStatus(root, id, { remote = 'origin', checksOf = null, definition = null, now = new Date() } = {}) {
  const record = await storyRecordOf(root, id, remote, { definition });
  if (!record) {
    throw new SingularityFlowError(`There is no task ${id} here.`, {
      code: 'TASK_UNKNOWN', details: { nextAction: { command: 'singularity-flow work "<what you want done>"', label: 'Start a task.' } } });
  }
  const { workflow } = record;
  const steps = storySteps(workflow, record.folder, id, itemOf(record, id));
  const composition = workflow.resolution?.composition ?? null;
  const done = steps.length > 0 && steps.every((step) => step.status === 'approved' || step.status === 'skipped');
  // What its checks ran and, for a refactor, what its plan says must not change that none covered [ITW:REQ-015, A13, A20].
  const read = (relative) => (record.ref ? committedFileText(root, record.ref, relative)
    : existsSync(path.join(root, relative)) ? readFileSync(path.join(root, relative), 'utf8') : null);
  const checks = done && checksOf ? checksOf.taskChecks(workflow, read, { item: itemOf(record, id) }) : null;
  // A done analysis offers its follow-ups, each with the command that starts it [ITW:REQ-109].
  const followUps = done && taskShape(composition) === 'analysis' ? await analysisFollowUps(root, record, id, workflow, composition) : [];
  // What the change does, once a code step is published: the page's line and where it is, for the task view [CSP:REQ-008].
  const changePage = `${itemOf(record, id)}/CHANGE-STORY.md`;
  const changeText = read(changePage);
  const changeRead = changeText ? await import('../change-story-read.mjs') : null;
  const changeSummary = changeRead?.changeStorySummaryOf(changeText) ?? null;
  return {
    ...(changeSummary ? { changeStory: { path: changePage, summary: changeSummary, command: changeRead.changeStoryCommand(id) } } : {}),
    schemaVersion: 1, resultType: 'sflow-task-status', id, kind: composition?.kind ?? null, shape: taskShape(composition), title: workflow.workItem?.title ?? null,
    status: workflow.status, done, branch: workflow.workItem?.branch ?? id, base: workflow.workItem?.baseBranch ?? null,
    pullRequest: composition?.pullRequest === true, steps,
    // Whose steps they are, when they are not the kind's own [ITW:REQ-011, REQ-020].
    ...(composition?.local ? { planFrom: `your team's workflow ${composition.local.label ?? composition.local.workflow}` }
      : composition?.agent?.marketplace ? { planFrom: agentWords(composition.agent) } : {}),
    ...(workflow.executionOrigin?.mode === 'itw-handoff' ? { handoff: workflow.executionOrigin } : {}),
    personApproved: steps.filter((step) => step.approvedBy === 'person').map((step) => step.label),
    ...(checks ? { checks } : {}),
    ...(followUps.length ? { followUps, ask: (await import('../task-followups.mjs')).FOLLOW_UP_ASK } : {}),
    words: done
      ? `${id} is done: ${steps.map((step) => step.label).join(', ')}, on branch ${workflow.workItem?.branch ?? id}.${checks ? checksOf.checksWords(checks) : ''}`
      : standsWords(id, steps, false),
    // The task page [FPL:REQ-006]: who started it and when, the plan as chips, where its steps came from, what happened,
    // now and next, the rules that applied, the steps `work add` can give it and the files it changed against its base.
    task: Boolean(composition), startedAt: workflow.workItem?.createdAt ?? null, startedBy: storyCreatorName(workflow.workItem?.createdBy),
    chips: planChips(workflow, steps), planNote: planNote(workflow), events: storyEvents(workflow, { now }), ...nowAndNext(steps),
    rulesApplied: rulesApplied(workflow), addable: addableSteps(workflow), changed: changedFiles(root, record, workflow, remote)
  };
}

/** The follow-ups of a done analysis, from its last step's document [ITW:REQ-109]. */
async function analysisFollowUps(root, record, id, workflow, composition) {
  const last = workflow.phaseOrder?.at(-1);
  const artifact = workflow.phases?.[last]?.requiredArtifact?.path;
  const report = artifact ? storyFileText(root, record, id, artifact) : null;
  if (!report) return [];
  const { taskFollowUps } = await import('../task-followups.mjs');
  return taskFollowUps({ id, kind: composition.kind, report, document: `${itemOf(record, id)}/${artifact}`, title: workflow.workItem?.title });
}

/**
 * The files a Story changed against its base, with lines added and removed [FPL:REQ-006]: its branch against where it left
 * the base, and on its own checkout the work not yet committed too. Its own records are its documents, listed apart.
 */
function changedFiles(root, record, workflow, remote) {
  const base = workflow.workItem?.baseBranch ?? null;
  if (!base || record.away) return null;
  try {
    const baseRef = [`${remote}/${base}`, base].find((ref) => commitOfRef(root, ref));
    const head = record.ref ?? 'HEAD';
    if (!baseRef || !commitOfRef(root, head)) return null;
    const from = typedMergeBase(root, baseRef, head);
    if (!from) return null;
    // A state-ref Story's branch holds no record of it, so nothing is left out [SSB M3].
    const own = record.folder ? `${record.folder}/` : null;
    const found = typedChangedPaths(root, from, record.ref, { max: 500 });
    const files = found.entries.filter((entry) => !own || !entry.path.startsWith(own)).slice(0, 200)
      .map((entry) => ({ path: entry.path, added: entry.added, removed: entry.removed, ...(entry.binary ? { binary: true } : {}) }));
    return { base, files, total: found.entries.filter((entry) => !own || !entry.path.startsWith(own)).length + (found.truncated ? found.total - found.entries.length : 0) };
  } catch { return null; }
}

/** The command that starts this task with the options the person gave, and `extra` after them. */
function startCommand(words, kind, options, extra = []) {
  const repeated = (name) => optionStrings(options, name).map((value) => `--${name} ${/^[\w./@:-]+$/u.test(value) ? value : quoted(value)}`);
  const single = (name) => { const value = optionString(options, name); return value ? [`--${name} ${/^[\w./@:-]+$/u.test(value) ? value : quoted(value)}`] : []; };
  const flag = (name) => (optionBoolean(options, name) ? [`--${name}`] : []);
  // Start Story's own options [ITW:REQ-114] go with it, so the route starts the same Story the form asked for.
  return ['singularity-flow work', ...(words ? [quoted(words)] : []), `--kind ${kind}`, '--start', ...single('work-id'), ...single('title'), ...single('base'), ...single('from'), ...single('finding'),
    ...repeated('path'), ...repeated('document'), ...repeated('add'), ...repeated('skip'), ...flag('new'),
    ...repeated('use-skill'), ...repeated('without-skill'), ...repeated('use-agent'), ...repeated('without-agent'),
    ...repeated('use-workflow'), ...repeated('without-workflow'), ...single('ref'), ...repeated('from-branch'), ...repeated('document-name'), ...repeated('document-store'),
    ...single('acceptance-criteria'), ...repeated('address'), ...single('github'), ...flag('jira'), ...flag('isolated-worktree'), ...extra].join(' ');
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

/** Finding N of a report's Follow-ups, as the follow-up's intake carries it; refused with the findings there are. */
async function findingOf(from, report, wanted, { words, kind, options }) {
  if (wanted === null || wanted === undefined) return null;
  const { findingIntake, reportFollowUps } = await import('../task-followups.mjs');
  const items = reportFollowUps(report.text);
  const item = items.find((entry) => String(entry.n) === String(wanted));
  if (item) return findingIntake(from, report.artifact, item);
  const first = items[0];
  throw new SingularityFlowError(items.length ? `${from}'s report has no finding ${wanted}; its follow-ups are ${items.map((entry) => `${entry.n}) ${entry.title}`).join(', ')}.`
    : `${from}'s report lists no follow-ups, so there is no finding ${wanted} to start from.`, {
    code: 'TASK_FROM_NO_FINDING',
    details: { followUps: items, nextAction: first
      ? { command: startCommand(first.title, kind, { ...options, finding: String(first.n) }), label: `Start a story from finding 1: ${first.title}.` }
      : { command: startCommand(words, kind, { ...options, finding: undefined }), label: `Start from ${from}'s whole report.` } }
  });
}

function titleOf(words) {
  const line = words.split(/\r?\n/u)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

/**
 * Start's own options a task's start hands on as the person gave them [ITW:REQ-114]: the Story's branch, its bases (one for
 * all, `<repository>=<branch>` for some), each document's name and where it is kept, its acceptance criteria, the findings
 * it addresses, its GitHub Issue or Jira issue and its own checkout. `start` reads and checks each as for any Story.
 */
export const TASK_START_OPTIONS = Object.freeze(['ref', 'from-branch', 'document-name', 'document-store', 'acceptance-criteria', 'address',
  'github', 'jira', 'isolated-worktree']);

export async function launchTask(id, { words, title = titleOf(words), description = words, preview, base, documents = [], json, admission = null, isolated = false,
  passOn = {}, source = null, notes = null }) {
  const { startTaskStory } = await import('./start.mjs');
  // An issue is the Story's source as it is, so the words and the title are its own; what SFlow asks of the task goes with it.
  return startTaskStory(['start', id], {
    json, ...(source ? {} : { title, description }), ...(passOn['from-branch'] ? {} : { base }), 'work-type': preview.composition.workType, yes: true,
    ...(documents.length ? { document: documents } : {}), ...(isolated ? { 'isolated-worktree': true } : {}), ...passOn
  }, preview.composition, { plan: preview.plan, admission, source, notes });
}

/** The GitHub Issue or Jira issue a task starts from, read once with start's own readers; null for typed words. */
async function issueOf(options, id) {
  const github = optionString(options, 'github');
  if (github) return (await import('../work-source.mjs')).getGitHubIssue(github);
  if (!optionBoolean(options, 'jira')) return null;
  if (!id) {
    throw new SingularityFlowError('Name the Jira issue the task starts from: its key is the task\'s ID.', {
      code: 'TASK_JIRA_KEY_MISSING', details: { nextAction: { command: 'singularity-flow work --jira --work-id <NEW-WORK-ID> --start', label: 'Give the Jira key.' } } });
  }
  const [{ getIssue }, { normalizeWorkSource }] = await Promise.all([import('../jira.mjs'), import('../work-source.mjs')]);
  return normalizeWorkSource(await getIssue(id), { rawRef: id, fetchedAt: nowIso() });
}

/** An issue's words, as a task's words: its title, its description and its acceptance criteria. */
const issueWords = (source) => [source.title, source.description, ...(source.acceptanceCriteria ?? [])].map((line) => String(line ?? '').trim()).filter(Boolean).join('\n\n');

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

/**
 * `work shape big` [ITW:REQ-103]: the person makes the sized task open on this checkout a big change, at its requirement's
 * approval (its spec, design when its analysis asks, plan and tests are added after the requirement, which still waits for
 * the person's Yes). A big change stays big: steps are only added.
 */
async function shapeCommand(positionals, options) {
  const root = await taskRepositoryRoot();
  const id = optionString(options, 'work-id') ?? openStoryHere(root);
  if (!id) {
    throw new SingularityFlowError('There is no task open on this checkout to make a big change. Check out its branch, or name it with --work-id.', {
      code: 'TASK_UNKNOWN', details: { nextAction: { command: 'singularity-flow work status', label: 'See the task open on this checkout.' } } });
  }
  const status = { command: `singularity-flow work status ${id}`, label: `See where ${id} stands; it carries on with its steps.` };
  if (positionals[2] !== 'big') {
    throw new SingularityFlowError(`A task's requirement makes it small or big, and a big change stays big: say "singularity-flow work shape big".`, {
      code: 'TASK_CHANGE_REFUSED', details: { nextAction: { command: `singularity-flow work shape big --work-id ${id}`, label: 'Make it a big change.' } } });
  }
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { workflow } = await loadAcceptedStoryExecution(root, id);
  const shape = await import('../task-shape.mjs');
  const decided = await shape.decideShapeAfterRequirement(root, id, workflow.currentPhase, { force: 'big', by: 'person' });
  if (!decided) {
    throw new SingularityFlowError(`${id} is not a sized task whose requirement waits for its approval, so it does not become a big change here.`, {
      code: 'TASK_CHANGE_REFUSED', details: { nextAction: status } });
  }
  const after = (await loadAcceptedStoryExecution(root, id)).workflow;
  const { planLine } = await import('../task-composition.mjs');
  return { schemaVersion: 1, resultType: 'sflow-task-change', applied: decided.added.length > 0, stateChanged: decided.added.length > 0, id,
    shape: 'big', added: decided.added, words: decided.lines.join(' ') || `${id} is a big change.`,
    plan: planLine(after.resolution.composition, { approvals: Object.fromEntries(after.resolution.phases.map((phase) => [phase.id,
      phase.approval?.mode === 'none' ? 'none' : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person'])) }),
    question: shape.taskApprovalQuestion(after, after.phases[after.currentPhase]), next: status };
}

/**
 * `work behaviour keep|accept` [ITW:REQ-015]: the person's choice when a refactor's code step changed what passed before the
 * change (src/refactor-behaviour.mjs). A person's own step: the Copilot guard refuses it to an agent.
 */
async function behaviourCommand(positionals, options) {
  const root = await taskRepositoryRoot();
  const id = optionString(options, 'work-id') ?? openStoryHere(root);
  if (!id) {
    throw new SingularityFlowError('There is no task open on this checkout. Check out its branch, or name it with --work-id.', {
      code: 'TASK_UNKNOWN', details: { nextAction: { command: 'singularity-flow work status', label: 'See the task open on this checkout.' } } });
  }
  return (await import('../refactor-behaviour-decide.mjs')).decideBehaviour(root, positionals[2], { workId: id });
}

/**
 * `work "<words>" --plan-only` [FPL:REQ-004]: the likely plan for the Work box, composed from the kind the words name
 * (`kindFromWords`) and the team's rules, with no skill or agent chooser and no network. When SFlow cannot tell the kind,
 * or the repository has no SFlow yet, there is no plan (`plan: null`) and nothing is refused: the box shows no line.
 */
async function likelyPlan(positionals, options) {
  const typed = typedWords(positionals, options);
  // Start Story's title is read with its words [ITW:REQ-114].
  const words = planWords(typed, options);
  const none = (why, extra = {}) => ({ schemaVersion: 1, resultType: 'sflow-task-likely-plan', words, kind: null, plan: null, why, ...extra });
  let root = null;
  try { root = await taskRepositoryRoot(); } catch { return none('Open the repository, or select its workspace, to see a plan.'); }
  if (!existsSync(path.join(root, WORKFLOW_PATH))) return none('This repository does not use SFlow yet.');
  let definition = null;
  try { definition = await loadConfig(root); } catch (error) { return none(error?.message ?? 'SFlow could not read this repository\'s workflows.'); }
  // Where Start Story keeps a task's documents: the repository's policy, or the plan's workflow's once it has one [ITW:REQ-114].
  const kept = { documentStorage: documentStorageChoices(definition.documents) };
  if (!typed || SKILL_NAME_ONLY.test(typed)) return none('Say what you want done.', kept);
  const named = optionString(options, 'kind');
  const kind = named && TASK_KINDS.includes(named) ? named : kindFromWords(words);
  // Start Story then shows the kinds, as the chat names one [ITW:REQ-114].
  if (!kind) return none('SFlow cannot tell the kind of task from these words; the chat names it.', { ...kept, kindNeeded: true, kinds: [...TASK_KINDS] });
  try {
    const pullRequest = ASKS_FOR_PULL_REQUEST.test(words);
    const composition = { ...composeTask(definition, { kind, touchedPaths: optionStrings(options, 'path') }), ...(pullRequest ? { pullRequest: true } : {}) };
    const overlaid = validateDefinition(structuredClone(taskDefinition(definition, composition)));
    const resolved = assertWorkTypeStartable(resolveWorkType(overlaid, composition.workType));
    const approvals = Object.fromEntries(resolved.phases.map((phase) => [phase.id, approvalOf(phase)]));
    return { schemaVersion: 1, resultType: 'sflow-task-likely-plan', words, kind, plan: planLine(composition, { approvals, pullRequest }),
      steps: composition.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label, approvedBy: approvals[step.id] })),
      documentStorage: documentStorageChoices(resolved.documents) };
  } catch (error) {
    return none(error?.message ?? 'SFlow could not compose a plan here.', kept);
  }
}

export async function workCommand(positionals = [], options = {}) {
  if (positionals[1] === 'handoff') return (await import('../task-handoff.mjs')).workHandoff(positionals, options);
  if (positionals[1] === 'add' || positionals[1] === 'skip') return changeTask(positionals, options);
  if (positionals[1] === 'shape') return shapeCommand(positionals, options);
  if (positionals[1] === 'behaviour') return behaviourCommand(positionals, options);
  if (positionals[1] === 'list' && positionals.length === 2) {
    return (await import('../work-list.mjs')).workList({ offline: optionBoolean(options, 'offline') });
  }
  if (positionals[1] === 'status') {
    const root = await taskRepositoryRoot();
    const definition = existsSync(path.join(root, WORKFLOW_PATH)) ? await loadConfig(root) : {};
    const id = positionals[2] ?? openStoryHere(root) ?? branchName(root);
    // Its checks are read only for a task that is done, from their own module (task-checks.mjs).
    const status = await taskStatus(root, id, { remote: definition.git?.remote ?? 'origin', checksOf: await import('../task-checks.mjs'), definition });
    // Who carries the /sf-task turn on: the hooks, or the skill where none ran [ITW:REQ-111].
    return status.task ? { ...status, taskTurn: { carriedBy: await (await import('../task-turn.mjs')).taskTurnCarrier(root) } } : status;
  }
  if (optionBoolean(options, 'plan-only')) return likelyPlan(positionals, options);
  // A GitHub Issue or Jira issue is a task's source, and its words when none are typed [ITW:REQ-114].
  const fromIssue = Boolean(optionString(options, 'github')) || optionBoolean(options, 'jira');
  const typed = fromIssue ? typedWords(positionals, options) : wordsOf(positionals, options);
  const root = await taskRepositoryRoot();
  // A skill's name alone ("/sf-task" typed with nothing after it) says what to run, not what to do: it never names a
  // task. With a task open on this checkout it means "carry that one on" (a chat its hooks did not bind, 2026-11-25).
  if (SKILL_NAME_ONLY.test(typed)) {
    const openTask = openStoryHere(root);
    throw new SingularityFlowError(openTask
      ? `${openTask} is open on this checkout; "${typed}" carries it on and starts nothing new.`
      : 'Say what the task is, in your own words: a skill\'s name alone is not a task.', {
      code: openTask ? 'TASK_OPEN_HERE' : 'TASK_WORDS_MISSING',
      details: openTask
        ? { openTask, nextAction: { command: `singularity-flow work status ${openTask}`, label: `Carry ${openTask} on.` } }
        : { nextAction: { command: 'singularity-flow work "<what you want done>"', label: 'Say what you want done, in your own words.' } }
    });
  }
  const issue = fromIssue ? await issueOf(options, optionString(options, 'work-id')) : null;
  // What the kind and the plan are read from: the title and the words, then the issue's own.
  const words = [typed ? planWords(typed, options) : '', issue ? issueWords(issue) : ''].filter(Boolean).join('\n\n');
  const kind = kindOf(words, options);
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
  const [{ taskSkillChooser }, { namedAgents, namedWorkflows, taskAgentFinder }] = await Promise.all([import('../task-skills.mjs'), import('../task-agents.mjs')]);
  const useAgent = namedAgents(optionStrings(options, 'use-agent'));
  const withoutAgent = namedAgents(optionStrings(options, 'without-agent'));
  const useWorkflow = namedWorkflows(optionStrings(options, 'use-workflow'));
  const withoutWorkflow = namedWorkflows(optionStrings(options, 'without-workflow'));
  if (useAgent.length + useWorkflow.length > 1) {
    const [first, flag] = useAgent.length ? [useAgent[0], 'use-agent'] : [useWorkflow[0], 'use-workflow'];
    throw new SingularityFlowError('One workflow is a task\'s plan: say yes to one.', {
      code: useAgent.length ? 'TASK_AGENT_UNKNOWN' : 'TASK_WORKFLOW_UNKNOWN',
      details: { agents: useAgent, workflows: useWorkflow, nextAction: { command: startCommand(typed, kind, { ...options, 'use-agent': [], 'use-workflow': [], [flag]: [first] }), label: `Start the task with ${first}'s workflow.` } }
    });
  }
  // The start without the plan named: with the task's own steps, the named one's no added [ITW:REQ-011, REQ-020].
  const withoutPlan = () => startCommand(typed, kind, { ...options, 'use-agent': [], 'without-agent': [...withoutAgent, ...useAgent],
    'use-workflow': [], 'without-workflow': [...withoutWorkflow, ...useWorkflow] });
  const preview = await taskPlanForWords(definition, words, { kind, touchedPaths,
    add: optionStrings(options, 'add'), skip: optionStrings(options, 'skip'),
    chooseAgent: taskAgentFinder(root, definition, { touchedPaths, use: useAgent, without: withoutAgent, useWorkflow, withoutWorkflow, words, folders: WORK_ITEMS }),
    chooseSkills: taskSkillChooser(root, definition, { words, touchedPaths, use, without }) }).catch((error) => {
    // A yes to an agent whose workflow is not in the repository yet: its import is the next thing, through the conversion
    // review, and the task can also start with its own steps now [ITW:REQ-011, REQ-020].
    if (['TASK_AGENT_IMPORT_NEEDED', 'TASK_AGENT_NOT_COVERING', 'TASK_AGENT_UNKNOWN', 'TASK_WORKFLOW_UNKNOWN'].includes(error?.code) && (useAgent.length || useWorkflow.length)) {
      error.details.start = startCommand(typed, kind, options);
      error.details.withoutAgent = withoutPlan();
      if (error.code === 'TASK_AGENT_NOT_COVERING') error.details.nextAction = { command: error.details.withoutAgent, label: 'Start the task with its own steps.' };
    }
    // A yes to a marketplace skill whose import is not in the library yet (it waits for its review): this task starts
    // without it, and the next one finds it there.
    if (error?.code === 'TASK_SKILL_NOT_IN_LIBRARY') {
      const skill = error.details.skill;
      const rest = { ...options, 'use-skill': use.filter((id) => id !== skill), 'without-skill': [...without, skill] };
      error.details.nextAction = { command: startCommand(typed, kind, rest), label: `Start the task without ${skill} for now.` };
    }
    throw error;
  });
  const start = startCommand(typed, kind, options);
  const offers = preview.offers.map((offer) => skillOffer(offer, preview.composition));
  const agentOffer = preview.agentOffer ?? null;
  const agent = preview.composition.agent ?? null;
  if (!optionBoolean(options, 'start')) {
    return {
      schemaVersion: 1, resultType: 'sflow-task-plan', kind, words, plan: preview.plan, steps: preview.steps,
      rules: preview.composition.rules, added: preview.composition.added,
      ...(agent ? { agent: { id: `${agent.marketplace}/${agent.agent}`, marketplace: agent.marketplace, agent: agent.agent, version: agent.version, workflow: agent.workflow } } : {}),
      ...(preview.composition.local ? { workflow: { id: preview.composition.local.workflow, label: preview.composition.local.label } } : {}),
      // Used with no question; its no starts the task with its own steps [ITW:REQ-108].
      ...(preview.usedWorkflow ? { usedWorkflow: { id: preview.usedWorkflow.workflow, label: preview.usedWorkflow.label, why: preview.usedWorkflow.why,
        without: startCommand(typed, kind, { ...options, 'without-workflow': [...withoutWorkflow, preview.usedWorkflow.workflow] }) } } : {}),
      ...(agentOffer ? { agentOffer } : {}),
      ...(preview.skills.length ? { skills: preview.skills } : {}), ...(offers.length ? { offers } : {}),
      ...(preview.notes?.length ? { notes: preview.notes } : {}),
      next: { command: start, label: agentOffer ? `Start the task after a yes or no to the ${agentOffer.source === 'workflow' ? 'workflow' : 'agent'} offered.`
        : offers.length ? 'Start the task after a yes or no to each skill offered.' : 'Start the task.' }
    };
  }
  // A task open on this checkout takes the words as its own: an answer, or the change wanted. Only "new task" (--new)
  // starts another here [ITW:REQ-017]; a model's guess never starts a second Story over the first one.
  // A start in a checkout of its own (VS Code's Start Story) leaves this checkout's task as it is [ITW:REQ-114].
  const open = optionBoolean(options, 'isolated-worktree') ? null : openStoryHere(root);
  if (open && !optionBoolean(options, 'new')) {
    throw new SingularityFlowError(`${open} is open on this checkout, so these words are for it: its question's answer, or the change you want.`, {
      code: 'TASK_OPEN_HERE',
      details: { openTask: open, newTask: startCommand(typed, kind, options, ['--new']),
        nextAction: { command: `singularity-flow work status ${open}`, label: `Carry ${open} on with the person's words.` } }
    });
  }
  // A marketplace agent whose stages cover the task is asked about first [ITW:REQ-011]: a yes replaces the composed
  // steps (and the skills chosen for them), a no keeps them. A shown one's yes confirms the import its review proposed.
  if (agentOffer) {
    throw new SingularityFlowError(`${preview.plan} ${agentOffer.ask} The task starts once you say yes or no.`, {
      code: 'TASK_AGENT_YES_NEEDED',
      details: { plan: preview.plan, agentOffer, start,
        nextAction: agentOffer.show
          ? { command: agentOffer.show, label: `Show its conversion review, then ask the person: ${agentOffer.ask}` }
          : { command: `${start} ${agentOffer.yes}`, label: `If the person says yes to: ${agentOffer.ask} (if no, add ${agentOffer.no} instead)` } }
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
  // Start Story's bases go to start as they are (--from-branch); otherwise the task starts from the default branch.
  const base = optionStrings(options, 'from-branch').length ? null : optionString(options, 'base') ?? remoteDefaultBranchName(root, definition, remote) ?? 'main';
  const from = optionString(options, 'from');
  const report = from ? await reportOf(root, from, remote) : null;
  // One finding of an analysis, not the whole report [ITW:REQ-109].
  const finding = report ? await findingOf(from, report, optionString(options, 'finding'), { words: typed, kind, options }) : null;
  const documents = optionStrings(options, 'document').map((file) => path.resolve(process.cwd(), file));
  if (!optionBoolean(options, 'json')) console.log(preview.plan);
  // What SFlow asks of a sized task's requirement (its clauses, analysis and size) or of an analysis (its follow-ups),
  // beside the person's words in its intake [ITW:REQ-102, REQ-109].
  const guidance = preview.composition.sizing ? (await import('../task-shape.mjs')).taskIntakeGuidance(preview.composition) : null;
  const description = [finding ? `${typed}\n\n${finding}` : report ? `${typed}\n\n## Starts from ${from}'s report (${report.artifact})\n\n${report.text}` : typed, guidance].filter(Boolean).join('\n\n');
  // An issue's own text is its Story's; the words typed beside it and what SFlow asks go in its notes [ITW:REQ-114].
  const passOn = Object.fromEntries(TASK_START_OPTIONS.filter((name) => Object.hasOwn(options, name)).map((name) => [name, options[name]]));
  return launchTask(id, { words: typed || words, title: optionString(options, 'title') ?? titleOf(typed || words), preview, base, documents,
    json: optionBoolean(options, 'json'), description, passOn, source: issue, notes: issue ? description || null : null }).catch((error) => {
    // The plan read a skill this checkout has but the Story's base does not, or has otherwise: started without it.
    if (error?.code === 'TASK_SKILL_CHANGED' && error.details?.skill) {
      error.details.nextAction = { command: startCommand(typed, kind, { ...options, 'use-skill': use.filter((skill) => skill !== error.details.skill),
        'without-skill': [...without, error.details.skill] }), label: `Start the task without ${error.details.skill}.` };
    }
    // The agent's workflow is in this checkout but not in the configuration the Story starts from: started without it.
    if (['TASK_AGENT_IMPORT_NEEDED', 'TASK_WORKFLOW_UNKNOWN'].includes(error?.code) && (useAgent.length || useWorkflow.length)) {
      error.details.start = startCommand(typed, kind, options);
      error.details.withoutAgent = withoutPlan();
      error.details.nextAction = { command: error.details.withoutAgent, label: 'Start the task with its own steps for now.' };
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
  if (result.agentOffer) {
    const offer = result.agentOffer;
    console.log(`${offer.ask} ${offer.why[0].toUpperCase()}${offer.why.slice(1)}.`);
    if (offer.review) console.log(`  See its conversion review: ${offer.review}`);
    console.log(`  Yes: add ${offer.yes} to the start${offer.imported ? '' : ', once its workflow is in this repository'}. No: add ${offer.no}.`);
  }
  if (result.usedWorkflow) console.log(`Your team's workflow ${result.usedWorkflow.label} covers this task (${result.usedWorkflow.why}), so it is the plan. Its own steps instead: ${result.usedWorkflow.without}`);
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
  if (result?.resultType === 'sflow-task-behaviour') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.words);
      if (result.nextAction) console.log(`Next: ${result.nextAction.label}\n- Copilot: ${result.nextAction.copilotCommand ?? 'not available'}\n- Shell: ${result.nextAction.command}`);
    }
    return result;
  }
  if (result?.resultType === 'sflow-task-handoff') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result));
    else {
      console.log(result.message);
      if (result.plan) console.log(result.plan);
      if (result.specification) console.log(`${result.specification.reference} · ${result.specification.clauseIds.join(', ') || 'whole revision'}`);
      if (result.diagnostic) console.log(`${result.diagnostic.code} · ${result.diagnostic.message}`);
      for (const action of result.actions) console.log(action.label + '\n- Shell: ' + action.command);
    }
    return result;
  }
  if (result?.resultType === 'sflow-task-status') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.words);
      if (result.planFrom) console.log(`Its steps are from ${result.planFrom}.`);
      for (const step of result.steps) console.log(`  ${step.label}: ${step.status.replace(/_/gu, ' ')}${step.approvedBy === 'person' ? ', approved by a person' : step.approvedBy === 'sflow' ? ', approved by SFlow' : ''}`);
    }
    return result;
  }
  if (result?.resultType === 'sflow-work-list') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else process.stdout.write((await import('../work-list.mjs')).workListText(result));
    return result;
  }
  if (result?.resultType === 'sflow-task-likely-plan') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(result.plan ? `Likely plan: ${result.plan}` : result.why);
    return result;
  }
  if (result?.resultType === 'sflow-task-plan') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printPlan(result);
  }
  return result;
}
