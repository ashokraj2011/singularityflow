/**
 * `singularity-flow work "<words>" [--kind KIND] [--start] [--work-id ID] [--path FILE ...] [--json]` [ITW:REQ-001–007].
 *
 * Shows the plan a task's words get, composed from its kind (src/task-composition.mjs), and writes nothing. With
 * `--start` it starts the Story: its ID is a Jira key the words or `--work-id` name, else the next free `<prefix>-<n>`
 * (`tasks.idPrefix`, default TASK); its base is the repository's default branch; its intake is the words. The composed
 * workflow is laid over the definition in memory and recorded on the Story, never written to workflow.yml. `/sf-task`
 * in Copilot runs this with the kind the agent named.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition, WORKFLOW_PATH } from '../config.mjs';
import { loadConfig } from '../state-stores.mjs';
import { branch, localBranches, remoteBranches, remoteDefaultBranchName } from '../git.mjs';
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

/** Each approval group as Workflow Studio shows it, for the walk. */
function groupsOf(definition) {
  return new Map(Object.entries(definition.approvalAuthorities ?? {}).map(([id, group]) => [id, { id, label: group.label ?? id,
    status: (group.members ?? []).length ? 'people' : group.allowAnyGitIdentity ? 'anyone' : (group.githubTeams ?? []).length ? 'teams'
      : definition.approvalSecurity?.autoEnrollNewIdentities === false ? 'blocked' : 'auto' }]));
}

const approvalOf = (phase) => phase.approval?.mode === 'none' ? 'none'
  : phase.approval?.automatic === 'when-ready' ? 'sflow' : 'person';

/** The task's plan: composed, checked and walked as a Story start would, with nothing written. */
export async function taskPlan(definition, { kind, touchedPaths = [] } = {}) {
  const composition = composeTask(definition, { kind, touchedPaths });
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
    plan: planLine(composition, { approvals }),
    steps: composition.steps.map((step) => ({ id: step.id, intent: step.intent, label: step.label, approvedBy: approvals[step.id] })),
    walk: walk.outcome
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
    details: { nextAction: { command: 'singularity-flow workspace use <WORKSPACE-ID>', label: 'Select the workspace that holds the repository.' } }
  });
}

function titleOf(words) {
  const line = words.split(/\r?\n/u)[0].trim();
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

export async function workCommand(positionals = [], options = {}) {
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
  const preview = await taskPlan(definition, { kind, touchedPaths });
  if (!optionBoolean(options, 'start')) {
    return {
      schemaVersion: 1, resultType: 'sflow-task-plan', kind, words, plan: preview.plan, steps: preview.steps,
      rules: preview.composition.rules, added: preview.composition.added,
      next: { command: `singularity-flow work ${quoted(words)} --kind ${kind} --start`, label: 'Start the task.' }
    };
  }
  const id = workIdFor(root, words, definition, options);
  const remote = definition.git?.remote ?? 'origin';
  const base = optionString(options, 'base') ?? remoteDefaultBranchName(root, definition, remote) ?? 'main';
  const startOptions = {
    ...(optionBoolean(options, 'json') ? { json: true } : {}),
    title: titleOf(words),
    description: words,
    'work-type': preview.composition.workType,
    base,
    yes: true
  };
  if (!optionBoolean(options, 'json')) console.log(preview.plan);
  const { startTaskStory } = await import('./start.mjs');
  return startTaskStory(['start', id], startOptions, preview.composition, { plan: preview.plan });
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
  if (result?.resultType === 'sflow-task-plan') {
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else printPlan(result);
  }
  return result;
}
