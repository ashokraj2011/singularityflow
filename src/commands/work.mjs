/**
 * `singularity-flow work "<words>" [--kind KIND] [--start] [--work-id ID] [--path FILE ...] [--json]` [ITW:REQ-001–007].
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

/** Each approval group as Workflow Studio shows it, for the walk. */
function groupsOf(definition) {
  return new Map(Object.entries(definition.approvalAuthorities ?? {}).map(([id, group]) => [id, { id, label: group.label ?? id,
    status: (group.members ?? []).length ? 'people' : group.allowAnyGitIdentity ? 'anyone' : (group.githubTeams ?? []).length ? 'teams'
      : definition.approvalSecurity?.autoEnrollNewIdentities === false ? 'blocked' : 'auto' }]));
}

const approvalOf = (phase) => phase.approval?.mode === 'none' ? 'none'
  : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person';

/** The task's plan: composed, checked and walked as a Story start would, with nothing written. */
export async function taskPlan(definition, { kind, touchedPaths = [], pullRequest = false, add = [], skip = [] } = {}) {
  const composition = { ...composeTask(definition, { kind, touchedPaths, add, skip }), ...(pullRequest ? { pullRequest: true } : {}) };
  const overlaid = validateDefinition(structuredClone(taskDefinition(definition, composition)));
  const resolved = assertWorkTypeStartable(resolveWorkType(overlaid, composition.workType));
  const { quickWalkResolved, walkHosts } = await import('../workflow-walk/quick.mjs');
  const walk = quickWalkResolved(resolved, { approvalAuthorities: overlaid.approvalAuthorities, groups: groupsOf(overlaid), hosts: walkHosts() });
  if (walk.stops.length) {
    const stop = walk.stops[0];
    throw new SingularityFlowError(`This task's steps would stop before they finish: ${stop.title}${stop.detail ? ` ${stop.detail}` : ''}`, {
      code: 'TASK_PLAN_STOPS',
      details: { stops: walk.stops, nextAction: { command: 'singularity-flow workflow check', label: 'Check the workflow configuration the task is composed from.' } }
    });
  }
  const approvals = Object.fromEntries(resolved.phases.map((phase) => [phase.id, approvalOf(phase)]));
  return {
    composition,
    plan: planLine(composition, { approvals, pullRequest }),
    steps: composition.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label, approvedBy: approvals[step.id] })),
    walk: walk.outcome
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
  for (const folder of ['singularity/work-items', '.sdlc/work-items']) {
    const directory = path.join(root, folder);
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
    details: { nextAction: { command: 'singularity-flow workspace use <WORKSPACE-ID>', label: 'Select the workspace that holds the repository.' } }
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

export const taskPlanForWords = (definition, words, options) => taskPlan(definition, {
  ...options, pullRequest: ASKS_FOR_PULL_REQUEST.test(words)
});

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
    ...(workflow.executionOrigin?.mode === 'itw-handoff' ? { handoff: workflow.executionOrigin } : {}),
    personApproved: steps.filter((step) => step.approvedBy === 'person').map((step) => step.label),
    words: done
      ? `${id} is done: ${steps.map((step) => step.label).join(', ')}, on branch ${workflow.workItem?.branch ?? id}.`
      : `${id} is at ${steps.find((step) => step.status !== 'approved' && step.status !== 'skipped')?.label ?? 'its next step'}.`
  };
}

function titleOf(words) {
  const line = words.split(/\r?\n/u)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

export async function launchTask(id, { words, description = words, preview, base, documents = [], json, admission = null, isolated = false }) {
  const { startTaskStory } = await import('./start.mjs');
  return startTaskStory(['start', id], {
    json, title: titleOf(words), description, base, 'work-type': preview.composition.workType, yes: true,
    ...(documents.length ? { document: documents } : {}), ...(isolated ? { 'isolated-worktree': true } : {})
  }, preview.composition, { plan: preview.plan, admission });
}

export async function workCommand(positionals = [], options = {}) {
  if (positionals[1] === 'handoff') return (await import('../task-handoff.mjs')).workHandoff(positionals, options);
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
  const preview = await taskPlanForWords(definition, words, { kind, touchedPaths,
    add: optionStrings(options, 'add'), skip: optionStrings(options, 'skip') });
  if (!optionBoolean(options, 'start')) {
    return {
      schemaVersion: 1, resultType: 'sflow-task-plan', kind, words, plan: preview.plan, steps: preview.steps,
      rules: preview.composition.rules, added: preview.composition.added,
      next: { command: `singularity-flow work ${quoted(words)} --kind ${kind} --start`, label: 'Start the task.' }
    };
  }
  // A task open on this checkout takes the words as its own: an answer, or the change wanted. Only "new task" (--new)
  // starts another here [ITW:REQ-017]; a model's guess never starts a second Story over the first one.
  const open = openStoryHere(root);
  if (open && !optionBoolean(options, 'new')) {
    throw new SingularityFlowError(`${open} is open on this checkout, so these words are for it: its question's answer, or the change you want.`, {
      code: 'TASK_OPEN_HERE',
      details: { openTask: open, newTask: `singularity-flow work ${quoted(words)} --kind ${kind} --start --new`,
        nextAction: { command: `singularity-flow nextsteps ${open} --for-agent --json`, label: `Carry ${open} on with the person's words.` } }
    });
  }
  const id = workIdFor(root, words, definition, options);
  const remote = definition.git?.remote ?? 'origin';
  const base = optionString(options, 'base') ?? remoteDefaultBranchName(root, definition, remote) ?? 'main';
  const from = optionString(options, 'from');
  const report = from ? reportOf(root, from, remote) : null;
  const documents = optionStrings(options, 'document').map((file) => path.resolve(process.cwd(), file));
  if (!optionBoolean(options, 'json')) console.log(preview.plan);
  return launchTask(id, { words, preview, base, documents, json: optionBoolean(options, 'json'),
    description: report ? `${words}\n\n## Starts from ${from}'s report (${report.artifact})\n\n${report.text}` : words });
}

function printPlan(result) {
  console.log(result.plan);
  for (const step of result.steps) {
    console.log(`  ${step.label}${step.approvedBy === 'person' ? ' — you approve it' : step.approvedBy === 'sflow' ? ' — SFlow approves it when clean' : ''}`);
  }
  for (const added of result.added ?? []) console.log(`Added by the team's rules: ${added.intent} (${added.because})`);
  console.log(`\nStart it: ${result.next.command}`);
}

export async function run(_argv, { positionals = ['work'], options = {} } = {}) {
  const result = await workCommand(positionals, options);
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
