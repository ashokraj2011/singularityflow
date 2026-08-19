/**
 * Personal, workspace-scoped outcome goals.
 *
 * A Goal is an advisory navigation record. It may point at governed Stories or Initiatives, but it
 * never advances, approves, publishes, or otherwise owns their lifecycle. Keeping it in the local
 * workspace plane makes the same record visible to the CLI, Copilot, and VS Code without turning a
 * personal intention into repository policy.
 */
import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';

import { identity, localGitDisplayName } from './git.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import {
  activeWorkspaceFile, readActiveWorkspaceContext, workspaceRegistryFile
} from './workspace-context.mjs';
import { readWorkspace, workspaceRepositoryPath } from './workspace.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';

export const GOAL_STATE_SCHEMA_VERSION = currentSchemaVersion('goal-state');
export const GOAL_AUTHORITY = 'personal-advisory';
export const GOAL_STATUSES = Object.freeze(['active', 'achieved', 'abandoned']);
export const GOAL_SUBJECT_KINDS = Object.freeze(['story', 'initiative']);

const GOAL_ID = /^GOL-\d{8}-\d{3}$/;
const STATE_DIRECTORY = '.singularity-flow';
const STATE_FILE = 'goals.json';

function text(value, label, { minimum = 1, maximum = 500 } = {}) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length < minimum) {
    throw new SingularityFlowError(`${label} must contain at least ${minimum} character(s).`, {
      code: 'GOAL_VALUE_REQUIRED', details: { label, minimum }
    });
  }
  if (normalized.length > maximum) {
    throw new SingularityFlowError(`${label} must contain no more than ${maximum} characters.`, {
      code: 'GOAL_VALUE_TOO_LONG', details: { label, maximum }
    });
  }
  return normalized;
}

function portableId(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new SingularityFlowError(`${label} must be a portable identifier.`, {
      code: 'GOAL_IDENTIFIER_INVALID', details: { label }
    });
  }
  return normalized;
}

function normalizedCriteria(values) {
  const criteria = [...new Set((values ?? []).map((value) => text(value, 'Success criterion', {
    minimum: 3, maximum: 500
  })))];
  if (!criteria.length) {
    throw new SingularityFlowError(
      "A Goal needs at least one observable success criterion. Add '--success \"<criterion>\"'.",
      { code: 'GOAL_SUCCESS_CRITERION_REQUIRED' }
    );
  }
  if (criteria.length > 20) {
    throw new SingularityFlowError('A Goal may contain at most 20 success criteria.', {
      code: 'GOAL_SUCCESS_CRITERIA_LIMIT'
    });
  }
  return criteria;
}

function canonicalActor(repositoryPath) {
  const actor = identity(repositoryPath, { offline: true });
  return {
    name: localGitDisplayName(repositoryPath) ?? actor.name,
    email: actor.email ?? null
  };
}

function actorFor(context) {
  if (context.actor?.name) return context.actor;
  const actor = canonicalActor(context.repositoryPath);
  context.actor = actor;
  return actor;
}

function emptyState(workspace) {
  return {
    schemaVersion: GOAL_STATE_SCHEMA_VERSION,
    authority: GOAL_AUTHORITY,
    workspace: { id: workspace.id, name: workspace.name, path: workspace.path },
    revision: 0,
    activeGoalId: null,
    goals: []
  };
}

function assertGoal(goal) {
  if (!goal || !GOAL_ID.test(goal.id ?? '')) throw new SingularityFlowError('Goal state contains an invalid Goal ID.', { code: 'GOAL_STATE_INVALID' });
  if (goal.type !== 'outcome') throw new SingularityFlowError(`Goal '${goal.id}' has unsupported type '${goal.type}'.`, { code: 'GOAL_STATE_INVALID' });
  if (!GOAL_STATUSES.includes(goal.status)) throw new SingularityFlowError(`Goal '${goal.id}' has invalid status '${goal.status}'.`, { code: 'GOAL_STATE_INVALID' });
  text(goal.statement, `Goal '${goal.id}' statement`, { minimum: 3 });
  normalizedCriteria(goal.successCriteria);
  if (!Array.isArray(goal.links)) throw new SingularityFlowError(`Goal '${goal.id}' has invalid links.`, { code: 'GOAL_STATE_INVALID' });
  for (const link of goal.links) {
    if (!GOAL_SUBJECT_KINDS.includes(link.kind) || !link.id || !link.repositoryId) {
      throw new SingularityFlowError(`Goal '${goal.id}' contains an invalid governed-work link.`, { code: 'GOAL_STATE_INVALID' });
    }
  }
}

function validateState(parsed, workspace) {
  parsed = readRecord('goal-state', parsed).record;
  if (parsed?.authority !== GOAL_AUTHORITY
      || !Array.isArray(parsed.goals) || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new SingularityFlowError('The workspace Goal store is invalid. Repair or remove it before continuing.', {
      code: 'GOAL_STATE_INVALID'
    });
  }
  if (parsed.workspace?.id !== workspace.id || path.resolve(parsed.workspace?.path ?? '') !== path.resolve(workspace.path)) {
    throw new SingularityFlowError('The Goal store belongs to a different workspace copy.', {
      code: 'GOAL_WORKSPACE_MISMATCH',
      details: { expected: workspace.id, actual: parsed.workspace?.id ?? null }
    });
  }
  const ids = new Set();
  for (const goal of parsed.goals) {
    assertGoal(goal);
    if (ids.has(goal.id)) throw new SingularityFlowError(`Goal state contains duplicate ID '${goal.id}'.`, { code: 'GOAL_STATE_INVALID' });
    ids.add(goal.id);
  }
  if (parsed.activeGoalId != null) {
    const selected = parsed.goals.find((goal) => goal.id === parsed.activeGoalId);
    if (!selected || selected.status !== 'active') {
      throw new SingularityFlowError('The selected Goal is missing or no longer active.', { code: 'GOAL_STATE_INVALID' });
    }
  }
  return parsed;
}

async function stateFile(workspace, { create = false } = {}) {
  const root = await realpath(workspace.path);
  const directory = path.join(root, STATE_DIRECTORY);
  const current = await lstat(directory).catch(() => null);
  if (current?.isSymbolicLink()) {
    throw new SingularityFlowError(`Goal state directory cannot be a symbolic link: ${directory}`, {
      code: 'GOAL_STATE_PATH_UNSAFE'
    });
  }
  if (current && !current.isDirectory()) {
    throw new SingularityFlowError(`Goal state directory must be a directory: ${directory}`, {
      code: 'GOAL_STATE_PATH_UNSAFE'
    });
  }
  if (!current && create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolvedDirectory = current || create ? await realpath(directory) : directory;
  if (resolvedDirectory !== root && !resolvedDirectory.startsWith(`${root}${path.sep}`)) {
    throw new SingularityFlowError('Goal state resolves outside the selected workspace.', { code: 'GOAL_STATE_PATH_UNSAFE' });
  }
  const file = path.join(resolvedDirectory, STATE_FILE);
  const fileInfo = await lstat(file).catch(() => null);
  if (fileInfo?.isSymbolicLink() || (fileInfo && !fileInfo.isFile())) {
    throw new SingularityFlowError(`Goal state must be a regular file: ${file}`, { code: 'GOAL_STATE_PATH_UNSAFE' });
  }
  return file;
}

export async function activeGoalWorkspace({ env = process.env, home = undefined } = {}) {
  const selected = await readActiveWorkspaceContext(
    activeWorkspaceFile(env, home), workspaceRegistryFile(env, home), { refresh: false }
  );
  if (!selected) {
    throw new SingularityFlowError(
      "No active workspace is selected. Run 'singularity-flow workspace use <WORKSPACE>' before managing Goals.",
      { code: 'GOAL_WORKSPACE_REQUIRED' }
    );
  }
  const workspace = await readWorkspace(selected.workspacePath);
  const lead = workspace.repositories[workspace.leadRepository];
  const leadRepositoryPath = workspaceRepositoryPath(workspace, lead);
  const selectedRepository = workspace.repositories[selected.repositoryId];
  if (!selectedRepository) {
    throw new SingularityFlowError(`Selected repository '${selected.repositoryId}' is not part of workspace '${workspace.name}'.`, {
      code: 'GOAL_REPOSITORY_REQUIRED'
    });
  }
  return {
    workspace,
    selected,
    leadRepositoryPath,
    repositoryPath: workspaceRepositoryPath(workspace, selectedRepository)
  };
}

export async function readGoalState(context) {
  const file = await stateFile(context.workspace);
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { file, state: emptyState(context.workspace) };
    throw new SingularityFlowError(`Unable to read workspace Goals: ${error.message}`, {
      code: 'GOAL_STATE_INVALID', cause: error
    });
  }
  return { file, state: validateState(parsed, context.workspace) };
}

async function mutate(context, callback, { now = () => new Date() } = {}) {
  return withSubjectLock(context.leadRepositoryPath, {
    kind: 'goal-store', id: `${context.workspace.id}:${path.resolve(context.workspace.path)}`
  }, async () => {
    const { file, state } = await readGoalState(context);
    const outcome = await callback(structuredClone(state));
    if (!outcome.changed) return outcome.value;
    outcome.state.revision = state.revision + 1;
    outcome.state.updatedAt = now().toISOString();
    validateState(outcome.state, context.workspace);
    const writableFile = await stateFile(context.workspace, { create: true });
    if (writableFile !== file) {
      throw new SingularityFlowError('Goal state path changed while the update was being prepared.', {
        code: 'GOAL_STATE_PATH_UNSAFE'
      });
    }
    await writeAtomic(writableFile, `${JSON.stringify(outcome.state, null, 2)}\n`, { mode: 0o600 });
    return outcome.value;
  });
}

function nextId(goals, date) {
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  const prefix = `GOL-${day}-`;
  const highest = goals
    .filter((goal) => goal.id.startsWith(prefix))
    .map((goal) => Number.parseInt(goal.id.slice(prefix.length), 10))
    .filter(Number.isInteger)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  if (highest >= 999) throw new SingularityFlowError(`The Goal ID sequence for ${day} is exhausted.`, { code: 'GOAL_ID_EXHAUSTED' });
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

function goalById(state, reference = null, { activeOnly = false } = {}) {
  const requested = String(reference ?? state.activeGoalId ?? '').trim();
  if (!requested) {
    throw new SingularityFlowError("No active Goal is selected. Create one with 'singularity-flow goal create'.", {
      code: 'GOAL_SELECTION_REQUIRED'
    });
  }
  const goal = state.goals.find((candidate) => candidate.id === requested);
  if (!goal) throw new SingularityFlowError(`Goal '${requested}' does not exist in this workspace.`, { code: 'GOAL_NOT_FOUND' });
  if (activeOnly && goal.status !== 'active') {
    throw new SingularityFlowError(`Goal '${goal.id}' is ${goal.status} and cannot be changed.`, { code: 'GOAL_NOT_ACTIVE' });
  }
  return goal;
}

export async function createGoal(context, {
  statement, successCriteria, initialLink = null
} = {}, { now = () => new Date() } = {}) {
  const normalizedStatement = text(statement, 'Goal statement', { minimum: 3 });
  const criteria = normalizedCriteria(successCriteria);
  const actor = actorFor(context);
  return mutate(context, async (state) => {
    const created = now();
    const createdAt = created.toISOString();
    const goal = {
      schemaVersion: 1,
      id: nextId(state.goals, created),
      type: 'outcome',
      authority: GOAL_AUTHORITY,
      statement: normalizedStatement,
      successCriteria: criteria,
      status: 'active',
      links: initialLink ? [initialLink] : [],
      createdAt,
      updatedAt: createdAt,
      createdBy: actor
    };
    state.goals.push(goal);
    state.activeGoalId = goal.id;
    return { changed: true, state, value: { goal, state } };
  }, { now });
}

export async function selectGoal(context, reference, options = {}) {
  return mutate(context, async (state) => {
    const goal = goalById(state, reference, { activeOnly: true });
    if (state.activeGoalId === goal.id) return { changed: false, state, value: { goal, state, changed: false } };
    state.activeGoalId = goal.id;
    return { changed: true, state, value: { goal, state, changed: true } };
  }, options);
}

export async function linkGoal(context, reference, link, options = {}) {
  const normalized = {
    kind: GOAL_SUBJECT_KINDS.includes(link?.kind) ? link.kind : null,
    id: portableId(link?.id, 'Linked work ID'),
    repositoryId: portableId(link?.repositoryId, 'Repository ID'),
    branch: link?.branch ? String(link.branch) : null,
    title: link?.title ? text(link.title, 'Linked work title', { maximum: 500 }) : link.id,
    linkedAt: link?.linkedAt ?? new Date().toISOString()
  };
  if (!normalized.kind) throw new SingularityFlowError(`Goal links support ${GOAL_SUBJECT_KINDS.join(' or ')}.`, { code: 'GOAL_SUBJECT_KIND_INVALID' });
  return mutate(context, async (state) => {
    const goal = goalById(state, reference, { activeOnly: true });
    const existing = goal.links.find((item) => item.kind === normalized.kind
      && item.id === normalized.id && item.repositoryId === normalized.repositoryId);
    if (existing) return { changed: false, state, value: { goal, state, link: existing, changed: false } };
    goal.links.push(normalized);
    goal.updatedAt = options.now?.().toISOString() ?? new Date().toISOString();
    return { changed: true, state, value: { goal, state, link: normalized, changed: true } };
  }, options);
}

export async function unlinkGoal(context, reference, { kind, id, repositoryId = null } = {}, options = {}) {
  const normalizedId = portableId(id, 'Linked work ID');
  return mutate(context, async (state) => {
    const goal = goalById(state, reference, { activeOnly: true });
    const matches = goal.links.filter((item) => item.kind === kind && item.id === normalizedId
      && (!repositoryId || item.repositoryId === repositoryId));
    if (!matches.length) throw new SingularityFlowError(`Goal '${goal.id}' is not linked to ${kind} '${normalizedId}'.`, { code: 'GOAL_LINK_NOT_FOUND' });
    if (matches.length > 1 && !repositoryId) {
      throw new SingularityFlowError(`Work '${normalizedId}' is linked from more than one repository. Add --repository.`, { code: 'GOAL_LINK_AMBIGUOUS' });
    }
    const selected = matches[0];
    goal.links = goal.links.filter((item) => item !== selected);
    goal.updatedAt = options.now?.().toISOString() ?? new Date().toISOString();
    return { changed: true, state, value: { goal, state, link: selected } };
  }, options);
}

function nextActiveGoal(state, excludedId) {
  return [...state.goals]
    .filter((goal) => goal.status === 'active' && goal.id !== excludedId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))[0]?.id ?? null;
}

export async function completeGoal(context, reference, {
  confirmation, completionNote = null, linkStates = []
} = {}, options = {}) {
  const actor = actorFor(context);
  return mutate(context, async (state) => {
    const goal = goalById(state, reference, { activeOnly: true });
    if (confirmation !== goal.id) {
      throw new SingularityFlowError(`Completing a Goal requires exact confirmation '${goal.id}'.`, {
        code: 'GOAL_CONFIRMATION_REQUIRED', details: { goalId: goal.id }
      });
    }
    const unresolved = linkStates.filter((item) => item.availability !== 'available' || item.terminal !== true);
    if (unresolved.length) {
      throw new SingularityFlowError(
        `Goal '${goal.id}' still has ${unresolved.length} unresolved or active governed-work link(s). Complete, abandon, or unlink them first.`,
        { code: 'GOAL_LINKS_OPEN', details: { links: unresolved.map((item) => ({ kind: item.kind, id: item.id, status: item.status })) } }
      );
    }
    const completedAt = options.now?.().toISOString() ?? new Date().toISOString();
    goal.status = 'achieved';
    goal.updatedAt = completedAt;
    goal.completedAt = completedAt;
    goal.completion = {
      acknowledgedBy: actor,
      note: completionNote ? text(completionNote, 'Completion note', { maximum: 1000 }) : null,
      linkedWork: linkStates.map((item) => ({
        kind: item.kind, id: item.id, repositoryId: item.repositoryId, status: item.status, commit: item.commit ?? null
      }))
    };
    if (state.activeGoalId === goal.id) state.activeGoalId = nextActiveGoal(state, goal.id);
    return { changed: true, state, value: { goal, state } };
  }, options);
}

export async function abandonGoal(context, reference, { confirmation, reason } = {}, options = {}) {
  const actor = actorFor(context);
  return mutate(context, async (state) => {
    const goal = goalById(state, reference, { activeOnly: true });
    if (confirmation !== goal.id) {
      throw new SingularityFlowError(`Abandoning a Goal requires exact confirmation '${goal.id}'.`, {
        code: 'GOAL_CONFIRMATION_REQUIRED', details: { goalId: goal.id }
      });
    }
    const abandonedAt = options.now?.().toISOString() ?? new Date().toISOString();
    goal.status = 'abandoned';
    goal.updatedAt = abandonedAt;
    goal.abandonedAt = abandonedAt;
    goal.abandonedBy = actor;
    goal.abandonReason = text(reason, 'Abandon reason', { minimum: 3, maximum: 1000 });
    if (state.activeGoalId === goal.id) state.activeGoalId = nextActiveGoal(state, goal.id);
    return { changed: true, state, value: { goal, state } };
  }, options);
}

export function findGoal(state, reference = null, options = {}) {
  return goalById(state, reference, options);
}

export function listGoals(state, status = 'active') {
  if (![...GOAL_STATUSES, 'all'].includes(status)) {
    throw new SingularityFlowError(`Goal status must be ${[...GOAL_STATUSES, 'all'].join(', ')}.`, {
      code: 'GOAL_STATUS_INVALID'
    });
  }
  return [...state.goals]
    .filter((goal) => status === 'all' || goal.status === status)
    .sort((left, right) => {
      if (left.id === state.activeGoalId) return -1;
      if (right.id === state.activeGoalId) return 1;
      return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
    });
}

export function goalWorkspaceSummary(context) {
  return { id: context.workspace.id, name: context.workspace.name, path: context.workspace.path };
}

export function goalActor(context) { return { ...actorFor(context) }; }
