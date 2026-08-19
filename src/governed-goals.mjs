/**
 * Repository-owned governed Goal Executions.
 *
 * Personal Goals deliberately remain in goals.mjs. A promotion copies explicitly selected fields
 * into a new GEX identity and publishes that identity on its own lifecycle branch. Mutations are
 * prepared in detached temporary worktrees, so Goal administration never switches or dirties the
 * developer's current Story checkout.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { branch, head, identity } from './git.mjs';
import {
  clearPendingPublication, readPendingPublication, writePendingPublication
} from './publication-pending.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SingularityFlowError, run } from './util.mjs';

export const GOVERNED_GOAL_AUTHORITY = 'governed-execution';
export const GOVERNED_GOAL_ID = /^GEX-[0-9A-HJKMNP-TV-Z]{26}$/;
export const GOVERNED_GOAL_STATES = Object.freeze([
  'draft', 'planned', 'awaiting-plan-approval', 'ready', 'running', 'waiting',
  'verifying', 'achieved', 'not-achieved', 'abandoned', 'failed'
]);
export const GOVERNED_GOAL_ORACLE_TYPES = Object.freeze([
  'governed-work', 'registered-check', 'evidence-receipt', 'metric-threshold', 'human-judgment'
]);
export const GOVERNED_GOAL_ASSURANCE_LEVELS = Object.freeze([
  'unassessed', 'acknowledged', 'mixed', 'verified'
]);
export const GOAL_CONTRACT_SCHEMA_VERSION = currentSchemaVersion('governed-goal-contract');
export const GOAL_STATE_SCHEMA_VERSION = currentSchemaVersion('governed-goal-state');
export const GOAL_PLAN_SCHEMA_VERSION = currentSchemaVersion('governed-goal-plan');
export const GOAL_RECORD_SCHEMA_VERSION = currentSchemaVersion('governed-goal-record');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ZERO_SHA = '0'.repeat(40);

function nowIso(now = () => new Date()) { return now().toISOString(); }

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function recordHash(value) {
  const copy = structuredClone(value);
  delete copy.recordSha256;
  return hash(copy);
}

function withRecordHash(value) { return { ...value, recordSha256: recordHash(value) }; }

function encodeBase32(number, length) {
  let remaining = BigInt(number);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result = CROCKFORD[Number(remaining & 31n)] + result;
    remaining >>= 5n;
  }
  return result;
}

export function createGovernedGoalId({ now = () => new Date(), random = randomBytes } = {}) {
  const timestamp = encodeBase32(BigInt(now().getTime()), 10);
  const bytes = random(10);
  let entropy = 0n;
  for (const byte of bytes) entropy = (entropy << 8n) | BigInt(byte);
  return `GEX-${timestamp}${encodeBase32(entropy, 16)}`;
}

export function assertGovernedGoalId(value) {
  const id = String(value ?? '').trim().toUpperCase();
  if (!GOVERNED_GOAL_ID.test(id)) {
    throw new SingularityFlowError(
      "A governed Goal ID must use 'GEX-' followed by a 26-character ULID.",
      { code: 'GOVERNED_GOAL_ID_INVALID', details: { id } }
    );
  }
  return id;
}

export function governedGoalRelative(id, suffix = '') {
  const goalId = assertGovernedGoalId(id);
  return `singularity/goals/${goalId}${suffix ? `/${suffix}` : ''}`;
}

function git(root, args, { allowFailure = false } = {}) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  if (!allowFailure && result.status !== 0) {
    throw new SingularityFlowError(
      `Git could not ${args[0]} the governed Goal: ${(result.stderr || result.stdout).trim() || 'unknown error'}`,
      { code: 'GOVERNED_GOAL_GIT_FAILED', details: { operation: args[0], status: result.status } }
    );
  }
  return result;
}

function refSha(root, ref) {
  const result = git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isAncestor(root, older, newer) {
  return git(root, ['merge-base', '--is-ancestor', older, newer], { allowFailure: true }).status === 0;
}

function publicationPolicy(config = {}) {
  return {
    remote: config.git?.remote ?? 'origin',
    mode: config.git?.publish ?? 'required'
  };
}

function fetchGoalBranch(root, id, policy, { required = false } = {}) {
  if (policy.mode === 'off') return { fetched: false, error: null };
  const refspec = `+refs/heads/${id}:refs/remotes/${policy.remote}/${id}`;
  const result = git(root, ['fetch', '--no-tags', policy.remote, refspec], { allowFailure: true });
  if (result.status !== 0 && required) {
    throw new SingularityFlowError(
      `Governed Goal '${id}' could not refresh ${policy.remote}/${id}: ${(result.stderr || result.stdout).trim()}. No files were changed.`,
      { code: 'GOVERNED_GOAL_REMOTE_UNAVAILABLE', details: { id, remote: policy.remote } }
    );
  }
  return { fetched: result.status === 0, error: result.status === 0 ? null : (result.stderr || result.stdout).trim() };
}

function resolveGoalRevision(root, id, policy, { refresh = true, mutation = false } = {}) {
  if (refresh) fetchGoalBranch(root, id, policy, { required: mutation && policy.mode === 'required' });
  const localRef = `refs/heads/${id}`;
  const remoteRef = `refs/remotes/${policy.remote}/${id}`;
  const local = refSha(root, localRef);
  const remote = refSha(root, remoteRef);
  if (!local && !remote) {
    throw new SingularityFlowError(`Governed Goal '${id}' was not found locally or on ${policy.remote}.`, {
      code: 'GOVERNED_GOAL_NOT_FOUND', details: { id, remote: policy.remote }
    });
  }
  if (local && remote && local !== remote && !isAncestor(root, local, remote) && !isAncestor(root, remote, local)) {
    throw new SingularityFlowError(
      `Governed Goal '${id}' has divergent local and ${policy.remote} lifecycle branches. Reconcile them before continuing.`,
      { code: 'GOVERNED_GOAL_BRANCH_DIVERGED', details: { id, local, remote } }
    );
  }
  const commit = local && (!remote || isAncestor(root, remote, local)) ? local : remote;
  return { commit, local, remote, localRef, remoteRef };
}

function readJsonAtRef(root, ref, relative, family) {
  const result = git(root, ['show', `${ref}:${relative}`], { allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(`Governed Goal record '${relative}' is missing at ${ref.slice(0, 12)}.`, {
      code: 'GOVERNED_GOAL_RECORD_MISSING', details: { ref, relative }
    });
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) {
    throw new SingularityFlowError(`Governed Goal record '${relative}' is invalid JSON: ${error.message}`, {
      code: 'GOVERNED_GOAL_RECORD_INVALID', cause: error
    });
  }
  return readRecord(family, parsed).record;
}

function validateRecordHash(record, label) {
  if (record.recordSha256 !== recordHash(record)) {
    throw new SingularityFlowError(`${label} failed its integrity check.`, {
      code: 'GOVERNED_GOAL_INTEGRITY_INVALID'
    });
  }
}

function validateContract(contract, id) {
  if (contract.id !== id || contract.authority !== GOVERNED_GOAL_AUTHORITY) {
    throw new SingularityFlowError(`Governed Goal '${id}' has an invalid contract identity.`, {
      code: 'GOVERNED_GOAL_RECORD_INVALID'
    });
  }
  validateRecordHash(contract, `Governed Goal '${id}' contract`);
  const calculated = hash({ ...contract, contractSha256: undefined, recordSha256: undefined });
  if (contract.contractSha256 !== calculated) {
    throw new SingularityFlowError(`Governed Goal '${id}' contract hash does not match its contents.`, {
      code: 'GOVERNED_GOAL_CONTRACT_DRIFT'
    });
  }
  if (!Array.isArray(contract.criteria) || !contract.criteria.length
      || contract.criteria.some((criterion) => !GOVERNED_GOAL_ORACLE_TYPES.includes(criterion.oracle?.type))) {
    throw new SingularityFlowError(`Governed Goal '${id}' must bind every criterion to one typed oracle.`, {
      code: 'GOVERNED_GOAL_ORACLE_REQUIRED'
    });
  }
  for (const criterion of contract.criteria) {
    if (criterion.oracle.type === 'governed-work'
        && (!criterion.oracle.subject?.kind || !criterion.oracle.subject?.id
          || !criterion.oracle.subject?.repositoryId || !criterion.oracle.allowedTerminalStates?.length)) {
      throw new SingularityFlowError(`Governed Goal '${id}' criterion '${criterion.id}' has an incomplete governed-work oracle.`, {
        code: 'GOVERNED_GOAL_ORACLE_INVALID'
      });
    }
    if (criterion.oracle.type === 'human-judgment'
        && (!criterion.oracle.authority || !criterion.oracle.question)) {
      throw new SingularityFlowError(`Governed Goal '${id}' criterion '${criterion.id}' has an incomplete human-judgment oracle.`, {
        code: 'GOVERNED_GOAL_ORACLE_INVALID'
      });
    }
  }
}

function validateState(state, id) {
  if (state.id !== id || state.authority !== GOVERNED_GOAL_AUTHORITY
      || !GOVERNED_GOAL_STATES.includes(state.status)
      || !GOVERNED_GOAL_ASSURANCE_LEVELS.includes(state.assurance)) {
    throw new SingularityFlowError(`Governed Goal '${id}' has an invalid operational state.`, {
      code: 'GOVERNED_GOAL_RECORD_INVALID'
    });
  }
  validateRecordHash(state, `Governed Goal '${id}' state`);
}

export function planSha256(plan) {
  const copy = structuredClone(plan);
  delete copy.planSha256;
  delete copy.recordSha256;
  return hash(copy);
}

function validatePlan(plan, id) {
  if (plan.goalId !== id || plan.planSha256 !== planSha256(plan)) {
    throw new SingularityFlowError(
      `Governed Goal '${id}' plan generation ${plan.generation ?? '?'} has drifted and requires a new generation.`,
      { code: 'GOVERNED_GOAL_PLAN_DRIFT' }
    );
  }
  validateRecordHash(plan, `Governed Goal '${id}' plan`);
}

export function proposalForGoal(context, { statement, successCriteria, links = [] } = {}) {
  const normalizedStatement = String(statement ?? '').replace(/\s+/g, ' ').trim();
  const criteria = [...new Set((successCriteria ?? []).map((item) => String(item).replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (normalizedStatement.length < 3) throw new SingularityFlowError('A governed Goal proposal needs an outcome.', { code: 'GOVERNED_GOAL_OUTCOME_REQUIRED' });
  if (!criteria.length) throw new SingularityFlowError('A governed Goal proposal needs at least one observable success criterion.', { code: 'GOVERNED_GOAL_CRITERION_REQUIRED' });
  return {
    schemaVersion: 1,
    mode: GOVERNED_GOAL_AUTHORITY,
    readOnly: true,
    outcome: normalizedStatement,
    successCriteria: criteria,
    workspace: { id: context.workspace.id, name: context.workspace.name },
    leadRepository: context.workspace.leadRepository,
    repositories: [...new Set(links.map((link) => link.repositoryId))],
    linkedWork: links.map((link) => ({ kind: link.kind, id: link.id, repositoryId: link.repositoryId })),
    unresolvedDecisions: links.length ? [] : ['Select at least one existing Story or Initiative before deterministic plan approval.'],
    plannedEffects: { branches: 0, files: 0, externalWrites: 0 },
    next: 'govern'
  };
}

function oracleFor(criterion, link, actor) {
  if (link) {
    return {
      type: 'governed-work', subject: { kind: link.kind, id: link.id, repositoryId: link.repositoryId },
      allowedTerminalStates: ['complete', 'completed', 'archived']
    };
  }
  return {
    type: 'human-judgment', authority: 'goal-owner', question: criterion,
    owner: actor.email ?? actor.name
  };
}

function createContract(context, personalGoal, id, actor, createdAt) {
  const links = personalGoal.links.map((link) => ({
    kind: link.kind, id: link.id, repositoryId: link.repositoryId,
    branch: link.branch ?? null, title: link.title ?? link.id
  }));
  const contract = {
    schemaVersion: GOAL_CONTRACT_SCHEMA_VERSION,
    id,
    authority: GOVERNED_GOAL_AUTHORITY,
    lifecycleBranch: id,
    workspace: { id: context.workspace.id, name: context.workspace.name },
    leadRepository: context.workspace.leadRepository,
    outcome: { statement: personalGoal.statement },
    criteria: personalGoal.successCriteria.map((statement, index) => ({
      id: `criterion-${String(index + 1).padStart(3, '0')}`,
      clauseId: `${id}:AC-${String(index + 1).padStart(3, '0')}`,
      statement,
      oracle: oracleFor(statement, links[index] ?? null, actor)
    })),
    linkedWork: links,
    constraints: [],
    executionMode: 'guided',
    owner: actor,
    source: { mode: 'promotion', personalGoalId: personalGoal.id, copiedFields: ['statement', 'successCriteria', 'links'] },
    createdAt,
    createdBy: actor
  };
  contract.contractSha256 = hash({ ...contract, contractSha256: undefined });
  return withRecordHash(contract);
}

function createState(context, contract, actor, createdAt, baseCommit) {
  return withRecordHash({
    schemaVersion: GOAL_STATE_SCHEMA_VERSION,
    id: contract.id,
    authority: GOVERNED_GOAL_AUTHORITY,
    status: 'draft',
    contractSha256: contract.contractSha256,
    planGeneration: 0,
    currentPlan: null,
    approvedPlan: null,
    currentStepId: null,
    completedStepIds: [],
    assurance: 'unassessed',
    paused: null,
    revision: 1,
    workspace: contract.workspace,
    repository: { id: context.workspace.leadRepository, baseCommit },
    createdAt,
    updatedAt: createdAt,
    history: [{ event: 'governed-goal-created', at: createdAt, actor }]
  });
}

function goalMarkdown(contract, state) {
  return `# ${contract.id} — ${contract.outcome.statement}\n\n`
    + `Status: **${state.status}**  \nAuthority: **${GOVERNED_GOAL_AUTHORITY}**  \nLifecycle branch: \`${contract.lifecycleBranch}\`\n\n`
    + `## Outcome\n\n${contract.outcome.statement} [${contract.id}:REQ-001]\n\n`
    + `## Success criteria\n\n${contract.criteria.map((criterion) =>
      `- **${criterion.id}** ${criterion.statement} [${criterion.clauseId}] (\`${criterion.oracle.type}\`)`).join('\n')}\n\n`
    + `## Linked governed work\n\n${contract.linkedWork.length
      ? contract.linkedWork.map((link) => `- ${link.kind} \`${link.id}\` in \`${link.repositoryId}\``).join('\n')
      : '- None yet'}\n`;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function writeGoalProjection(worktree, contract, state) {
  const directory = path.join(worktree, governedGoalRelative(contract.id));
  await mkdir(directory, { recursive: true });
  await writeJson(path.join(directory, 'contract.json'), contract);
  await writeJson(path.join(directory, 'state.json'), state);
  await writeFile(path.join(directory, 'goal.md'), goalMarkdown(contract, state), 'utf8');
}

async function commitDetached(root, baseCommit, id, policy, message, writer) {
  if (branch(root) === id) {
    throw new SingularityFlowError(
      `Governed Goal '${id}' is checked out in this repository. Switch to a working branch before mutating it; the Goal writer will update its lifecycle branch without changing your checkout.`,
      { code: 'GOVERNED_GOAL_BRANCH_CHECKED_OUT' }
    );
  }
  if (policy.mode === 'required') {
    const preflight = git(root, ['push', '--dry-run', policy.remote, `${baseCommit}:refs/heads/${id}`], { allowFailure: true });
    if (preflight.status !== 0) {
      throw new SingularityFlowError(
        `Governed Goal '${id}' publication preflight failed: ${(preflight.stderr || preflight.stdout).trim()}. No files were changed.`,
        { code: 'GOVERNED_GOAL_PUBLICATION_PREFLIGHT_FAILED' }
      );
    }
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-gex-'));
  let worktreeAdded = false;
  try {
    git(root, ['worktree', 'add', '--detach', temporary, baseCommit]);
    worktreeAdded = true;
    await writer(temporary);
    const relative = governedGoalRelative(id);
    git(temporary, ['add', '--', relative]);
    const changed = git(temporary, ['diff', '--cached', '--quiet'], { allowFailure: true }).status !== 0;
    if (!changed) return { commit: baseCommit, pushed: policy.mode === 'off' ? false : null, changed: false };
    git(temporary, ['commit', '-m', message, '--', relative]);
    const commit = head(temporary);
    const localRef = `refs/heads/${id}`;
    const expectedLocal = refSha(root, localRef) ?? ZERO_SHA;
    const advanced = git(root, ['update-ref', localRef, commit, expectedLocal], { allowFailure: true });
    if (advanced.status !== 0) {
      throw new SingularityFlowError(`Governed Goal '${id}' changed while this update was prepared. Reload and retry.`, {
        code: 'GOVERNED_GOAL_STALE_REVISION'
      });
    }
    if (policy.mode === 'off') return { commit, pushed: false, changed: true };
    const pushed = git(root, ['push', policy.remote, `${commit}:refs/heads/${id}`], { allowFailure: true });
    if (pushed.status !== 0) {
      await writePendingPublication(root, { kind: 'goal', id, record: {
        schemaVersion: currentSchemaVersion('pending-publication'),
        subject: { kind: 'goal', id }, branch: id, remote: policy.remote, commit,
        createdAt: new Date().toISOString(), recoveryStage: 'commit-retained-before-publication',
        error: (pushed.stderr || pushed.stdout).trim()
      } });
      throw new SingularityFlowError(
        `Governed Goal commit ${commit.slice(0, 8)} was retained on local branch ${id}, but publication to ${policy.remote}/${id} failed: ${(pushed.stderr || pushed.stdout).trim()}. Run 'singularity-flow goal sync ${id}' after remote access is restored.`,
        { code: 'GOVERNED_GOAL_PUBLICATION_PENDING', details: { id, commit, remote: policy.remote } }
      );
    }
    await clearPendingPublication(root, { kind: 'goal', id });
    return { commit, pushed: true, changed: true };
  } finally {
    if (worktreeAdded) git(root, ['worktree', 'remove', '--force', temporary], { allowFailure: true });
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createGovernedGoal(context, personalGoal, {
  id = null, config = {}, now = () => new Date()
} = {}) {
  const root = context.leadRepositoryPath;
  const goalId = id ? assertGovernedGoalId(id) : createGovernedGoalId({ now });
  const policy = publicationPolicy(config);
  fetchGoalBranch(root, goalId, policy, { required: false });
  if (refSha(root, `refs/heads/${goalId}`) || refSha(root, `refs/remotes/${policy.remote}/${goalId}`)) {
    throw new SingularityFlowError(`Governed Goal '${goalId}' already exists. Inspect it instead of overwriting it.`, {
      code: 'GOVERNED_GOAL_EXISTS'
    });
  }
  const actor = identity(root, { offline: true });
  const createdAt = nowIso(now);
  const baseCommit = head(root);
  const contract = createContract(context, personalGoal, goalId, actor, createdAt);
  const state = createState(context, contract, actor, createdAt, baseCommit);
  const publication = await commitDetached(root, baseCommit, goalId, policy,
    `Create governed Goal ${goalId}`,
    async (worktree) => {
      await writeGoalProjection(worktree, contract, state);
      await writeJson(path.join(worktree, governedGoalRelative(goalId, 'records/0001-created.json')), withRecordHash({
        schemaVersion: GOAL_RECORD_SCHEMA_VERSION, goalId, sequence: 1,
        event: 'governed-goal-created', at: createdAt, actor,
        contractSha256: contract.contractSha256, source: contract.source
      }));
    });
  return { contract, state, publication };
}

export function loadGovernedGoal(context, id, { config = {}, refresh = true } = {}) {
  const goalId = assertGovernedGoalId(id);
  const root = context.leadRepositoryPath;
  const policy = publicationPolicy(config);
  const revision = resolveGoalRevision(root, goalId, policy, { refresh });
  const contract = readJsonAtRef(root, revision.commit, governedGoalRelative(goalId, 'contract.json'), 'governed-goal-contract');
  const state = readJsonAtRef(root, revision.commit, governedGoalRelative(goalId, 'state.json'), 'governed-goal-state');
  validateContract(contract, goalId);
  validateState(state, goalId);
  let plan = null;
  if (state.currentPlan?.generation) {
    plan = readJsonAtRef(root, revision.commit,
      governedGoalRelative(goalId, `plans/generation-${state.currentPlan.generation}.json`), 'governed-goal-plan');
    validatePlan(plan, goalId);
  }
  return { contract, state, plan, revision, policy };
}

export function listGovernedGoals(context, { config = {}, refresh = true } = {}) {
  const root = context.leadRepositoryPath;
  const policy = publicationPolicy(config);
  if (refresh && policy.mode !== 'off') {
    git(root, ['fetch', '--no-tags', policy.remote,
      '+refs/heads/GEX-*:refs/remotes/' + policy.remote + '/GEX-*'], { allowFailure: true });
  }
  const result = git(root, ['for-each-ref', '--format=%(refname:short)',
    'refs/heads/GEX-*', `refs/remotes/${policy.remote}/GEX-*`], { allowFailure: true });
  const ids = [...new Set(result.stdout.split('\n').map((line) => line.trim().split('/').at(-1))
    .filter((id) => GOVERNED_GOAL_ID.test(id)))].sort();
  const goals = [];
  const unreadable = [];
  for (const id of ids) {
    try {
      const loaded = loadGovernedGoal(context, id, { config, refresh: false });
      goals.push({
        id,
        statement: loaded.contract.outcome.statement,
        status: loaded.state.status,
        assurance: loaded.state.assurance,
        planGeneration: loaded.state.planGeneration,
        planApproved: Boolean(loaded.state.approvedPlan),
        linkedWork: loaded.contract.linkedWork.length,
        revision: loaded.revision.commit
      });
    } catch (error) {
      unreadable.push({ id, error: error.message, code: error.code ?? 'GOVERNED_GOAL_RECORD_INVALID' });
    }
  }
  return { goals, unreadable, remote: policy.remote };
}

async function mutateGovernedGoal(context, id, config, message, mutate, { now = () => new Date() } = {}) {
  const root = context.leadRepositoryPath;
  const pending = await readPendingPublication(root, { kind: 'goal', id, migrate: false });
  if (pending) {
    throw new SingularityFlowError(
      `Governed Goal '${id}' has an unpublished commit ${pending.record.commit?.slice(0, 8) ?? 'unknown'}. Run 'singularity-flow goal sync ${id}' before another mutation.`,
      { code: 'GOVERNED_GOAL_PUBLICATION_PENDING', details: { id, commit: pending.record.commit ?? null } }
    );
  }
  const loaded = loadGovernedGoal(context, id, { config, refresh: true });
  const { contract } = loaded;
  const state = structuredClone(loaded.state);
  const additions = [];
  const at = nowIso(now);
  const actor = identity(root, { offline: true });
  const outcome = await mutate({ contract, state, plan: loaded.plan, additions, at, actor });
  state.revision += 1;
  state.updatedAt = at;
  state.history.push({ event: outcome.event, at, actor, ...(outcome.detail ? { detail: outcome.detail } : {}) });
  const stateWithHash = withRecordHash(state);
  const publication = await commitDetached(root, loaded.revision.commit, contract.id, loaded.policy, message,
    async (worktree) => {
      await writeGoalProjection(worktree, contract, stateWithHash);
      for (const addition of additions) await writeJson(path.join(worktree, governedGoalRelative(contract.id, addition.path)), addition.value);
      await writeJson(path.join(worktree, governedGoalRelative(contract.id, `records/${String(state.revision).padStart(4, '0')}-${outcome.event}.json`)), withRecordHash({
        schemaVersion: GOAL_RECORD_SCHEMA_VERSION, goalId: contract.id, sequence: state.revision,
        event: outcome.event, at, actor, detail: outcome.detail ?? null,
        contractSha256: contract.contractSha256,
        planSha256: outcome.planSha256 ?? state.currentPlan?.planSha256 ?? null
      }));
    });
  return { contract, state: stateWithHash, plan: outcome.plan ?? loaded.plan, publication, value: outcome.value ?? null };
}

export async function syncGovernedGoal(context, id, { config = {} } = {}) {
  const goalId = assertGovernedGoalId(id);
  const root = context.leadRepositoryPath;
  const policy = publicationPolicy(config);
  if (policy.mode === 'off') {
    return { id: goalId, changed: false, pushed: false, mode: 'off', commit: refSha(root, `refs/heads/${goalId}`) };
  }
  const pending = await readPendingPublication(root, { kind: 'goal', id: goalId, migrate: false });
  const local = refSha(root, `refs/heads/${goalId}`);
  if (!local) throw new SingularityFlowError(`Governed Goal '${goalId}' has no retained local lifecycle branch.`, { code: 'GOVERNED_GOAL_NOT_FOUND' });
  if (pending?.record.commit && pending.record.commit !== local) {
    throw new SingularityFlowError(`Governed Goal '${goalId}' recovery marker does not match its local branch. Inspect it before publishing.`, {
      code: 'GOVERNED_GOAL_RECOVERY_MISMATCH'
    });
  }
  fetchGoalBranch(root, goalId, policy, { required: false });
  const remote = refSha(root, `refs/remotes/${policy.remote}/${goalId}`);
  if (remote === local) {
    await clearPendingPublication(root, { kind: 'goal', id: goalId });
    return { id: goalId, changed: Boolean(pending), pushed: true, commit: local, remote: policy.remote };
  }
  if (remote && !isAncestor(root, remote, local)) {
    throw new SingularityFlowError(`Governed Goal '${goalId}' remote branch diverged; automatic recovery was refused.`, {
      code: 'GOVERNED_GOAL_BRANCH_DIVERGED'
    });
  }
  const pushed = git(root, ['push', policy.remote, `${local}:refs/heads/${goalId}`], { allowFailure: true });
  if (pushed.status !== 0) {
    throw new SingularityFlowError(`Governed Goal '${goalId}' is still pending publication: ${(pushed.stderr || pushed.stdout).trim()}`, {
      code: 'GOVERNED_GOAL_PUBLICATION_PENDING'
    });
  }
  await clearPendingPublication(root, { kind: 'goal', id: goalId });
  return { id: goalId, changed: true, pushed: true, commit: local, remote: policy.remote };
}

export async function compileGovernedGoalPlan(context, id, { config = {}, assisted = false, now } = {}) {
  if (assisted) {
    throw new SingularityFlowError(
      'Assisted governed Goal planning is not enabled. The deterministic compiler is available without a model.',
      { code: 'GOVERNED_GOAL_ASSISTED_UNAVAILABLE' }
    );
  }
  return mutateGovernedGoal(context, id, config, `Compile governed Goal plan ${id}`, ({ contract, state, additions, at }) => {
    if (['abandoned', 'achieved'].includes(state.status)) throw new SingularityFlowError(`Governed Goal '${id}' is ${state.status}.`, { code: 'GOVERNED_GOAL_TERMINAL' });
    const generation = state.planGeneration + 1;
    const steps = contract.linkedWork.map((link, index) => ({
      id: `step-${String(index + 1).padStart(3, '0')}`,
      kind: 'governed-operation',
      operation: link.kind === 'story' ? 'story.next' : 'initiative.next',
      subject: { kind: link.kind, id: link.id, repositoryId: link.repositoryId },
      dependsOn: index ? [`step-${String(index).padStart(3, '0')}`] : [],
      arguments: { workId: link.id },
      inputReferences: [{ type: 'governed-subject', kind: link.kind, id: link.id, repositoryId: link.repositoryId }],
      expectedOutputs: [{ type: 'legal-next-action', subjectId: link.id }],
      preconditions: [{ type: 'subject-resolves', subjectId: link.id }],
      completionPredicate: { type: 'subject-terminal', subjectId: link.id },
      timeoutMs: 30_000,
      retryPolicy: { mode: 'never', maximumAttempts: 1 },
      modelPolicy: 'forbidden',
      riskClass: 'read-navigation',
      confirmationClass: 'explicit-only',
      writeSet: [],
      stoppingPoint: 'underlying-governed-boundary'
    }));
    if (!steps.length) {
      throw new SingularityFlowError(`Governed Goal '${id}' has no resolved work to plan. Link work to the personal Goal before promotion.`, {
        code: 'GOVERNED_GOAL_PLAN_EMPTY'
      });
    }
    let plan = {
      schemaVersion: GOAL_PLAN_SCHEMA_VERSION,
      goalId: contract.id,
      contractSha256: contract.contractSha256,
      generation,
      executionMode: contract.executionMode,
      repositories: [...new Set(contract.linkedWork.map((link) => link.repositoryId))],
      budgets: { maximumSteps: steps.length, maximumRetriesPerStep: 0, modelCalls: 0, externalWrites: 0 },
      steps,
      oracleBindings: contract.criteria.map((criterion) => ({ criterionId: criterion.id, oracle: criterion.oracle })),
      plannedWriteSet: [governedGoalRelative(contract.id)],
      requiredApprovals: [{ type: 'plan-hash', authority: 'goal-owner' }],
      createdAt: at,
      compiler: { id: 'singularity-flow-deterministic-goal-plan', version: 1 }
    };
    plan.planSha256 = planSha256(plan);
    plan = withRecordHash(plan);
    additions.push({ path: `plans/generation-${generation}.json`, value: plan });
    state.planGeneration = generation;
    state.currentPlan = { generation, planSha256: plan.planSha256 };
    state.approvedPlan = null;
    state.currentStepId = null;
    state.completedStepIds = [];
    state.status = 'awaiting-plan-approval';
    return { event: 'plan-compiled', plan, planSha256: plan.planSha256, detail: `generation ${generation}` };
  }, { now });
}

export async function approveGovernedGoalPlan(context, id, {
  config = {}, generation, confirmation, now
} = {}) {
  return mutateGovernedGoal(context, id, config, `Approve governed Goal plan ${id}`, ({ contract, state, plan, additions, at, actor }) => {
    if (!plan || Number(generation) !== plan.generation) {
      throw new SingularityFlowError(`Approve the current plan generation ${plan?.generation ?? 'after compiling one'}.`, {
        code: 'GOVERNED_GOAL_PLAN_GENERATION_INVALID'
      });
    }
    validatePlan(plan, contract.id);
    if (confirmation !== plan.planSha256) {
      throw new SingularityFlowError(`Plan approval requires exact confirmation '${plan.planSha256}'.`, {
        code: 'GOVERNED_GOAL_PLAN_CONFIRMATION_REQUIRED', details: { planSha256: plan.planSha256 }
      });
    }
    const receipt = withRecordHash({
      schemaVersion: GOAL_RECORD_SCHEMA_VERSION, goalId: contract.id,
      decision: 'approved', generation: plan.generation, planSha256: plan.planSha256,
      contractSha256: contract.contractSha256, at, actor
    });
    additions.push({ path: `approvals/plan-generation-${plan.generation}-${plan.planSha256}.json`, value: receipt });
    state.approvedPlan = { generation: plan.generation, planSha256: plan.planSha256, approvedAt: at, approvedBy: actor };
    state.status = 'ready';
    return { event: 'plan-approved', plan, planSha256: plan.planSha256, detail: `generation ${plan.generation}` };
  }, { now });
}

function assertExecutable(state, plan, id) {
  if (state.paused) throw new SingularityFlowError(`Governed Goal '${id}' is paused. Resume it before execution.`, { code: 'GOVERNED_GOAL_PAUSED' });
  if (!plan || !state.approvedPlan || state.approvedPlan.planSha256 !== plan.planSha256
      || state.approvedPlan.generation !== plan.generation) {
    throw new SingularityFlowError(`Governed Goal '${id}' has no current exact-hash plan approval.`, {
      code: 'GOVERNED_GOAL_PLAN_NOT_APPROVED'
    });
  }
  validatePlan(plan, id);
}

export async function runGovernedGoalNext(context, id, linkStates, { config = {}, now } = {}) {
  return mutateGovernedGoal(context, id, config, `Advance governed Goal ${id}`, ({ contract, state, plan, additions, at, actor }) => {
    assertExecutable(state, plan, contract.id);
    const completed = new Set(state.completedStepIds);
    for (const step of plan.steps) {
      const live = linkStates.find((item) => item.kind === step.subject.kind && item.id === step.subject.id
        && item.repositoryId === step.subject.repositoryId);
      if (live?.terminal) completed.add(step.id);
    }
    state.completedStepIds = [...completed];
    const step = plan.steps.find((candidate) => !completed.has(candidate.id));
    if (!step) {
      state.status = 'verifying';
      state.currentStepId = null;
      return { event: 'plan-steps-completed', plan, planSha256: plan.planSha256, detail: 'all linked work is terminal' };
    }
    const live = linkStates.find((item) => item.kind === step.subject.kind && item.id === step.subject.id
      && item.repositoryId === step.subject.repositoryId);
    if (!live || live.availability !== 'available') {
      state.status = 'waiting';
      state.currentStepId = step.id;
      return { event: 'step-blocked', plan, planSha256: plan.planSha256, detail: `${step.id}: linked work unavailable`, value: { step, live } };
    }
    if (state.status === 'waiting' && state.currentStepId === step.id) {
      return { event: 'step-rechecked', plan, planSha256: plan.planSha256, detail: `${step.id}: still waiting`, value: { step, live, alreadyDelegated: true } };
    }
    const attemptId = `attempt-${state.revision + 1}-${step.id}`;
    const idempotencyKey = hash({ goalId: contract.id, planSha256: plan.planSha256, stepId: step.id, subject: step.subject });
    additions.push({ path: `runs/${attemptId}.json`, value: withRecordHash({
      schemaVersion: GOAL_RECORD_SCHEMA_VERSION, goalId: contract.id, attemptId, idempotencyKey,
      planSha256: plan.planSha256, step, status: 'delegated', at, actor,
      note: 'The Goal delegated navigation only; the underlying lifecycle retains authority.'
    }) });
    state.status = 'waiting';
    state.currentStepId = step.id;
    return { event: 'step-delegated', plan, planSha256: plan.planSha256, detail: step.id, value: { step, live, attemptId } };
  }, { now });
}

export async function verifyGovernedGoal(context, id, linkStates, { config = {}, criterionId = null, now } = {}) {
  return mutateGovernedGoal(context, id, config, `Verify governed Goal ${id}`, ({ contract, state, plan, additions, at, actor }) => {
    assertExecutable(state, plan, contract.id);
    const selected = criterionId ? contract.criteria.filter((criterion) => criterion.id === criterionId) : contract.criteria;
    if (!selected.length) throw new SingularityFlowError(`Governed Goal '${id}' has no criterion '${criterionId}'.`, { code: 'GOVERNED_GOAL_CRITERION_NOT_FOUND' });
    const evaluations = selected.map((criterion) => {
      if (criterion.oracle.type === 'governed-work') {
        const subject = criterion.oracle.subject;
        const live = linkStates.find((item) => item.kind === subject.kind && item.id === subject.id
          && item.repositoryId === subject.repositoryId);
        const passed = Boolean(live?.terminal && criterion.oracle.allowedTerminalStates.includes(String(live.status).toLowerCase()));
        return { criterionId: criterion.id, oracle: criterion.oracle, outcome: passed ? 'passed' : 'not-passed', assurance: 'observed', source: live ?? null };
      }
      if (criterion.oracle.type === 'human-judgment') {
        return { criterionId: criterion.id, oracle: criterion.oracle, outcome: 'human-decision-required', assurance: 'judgment', source: null };
      }
      throw new SingularityFlowError(
        `Oracle '${criterion.oracle.type}' is schema-valid but has no registered evaluator in this build.`,
        { code: 'GOVERNED_GOAL_ORACLE_EVALUATOR_UNAVAILABLE', details: { criterionId: criterion.id, oracle: criterion.oracle.type } }
      );
    });
    const evidence = withRecordHash({
      schemaVersion: GOAL_RECORD_SCHEMA_VERSION, goalId: contract.id,
      contractSha256: contract.contractSha256, planSha256: plan.planSha256,
      oracleVersion: 1, evaluatedAt: at, actor, evaluations
    });
    const evidenceId = hash(evidence);
    additions.push({ path: `evidence/${evidenceId}.json`, value: evidence });
    const deterministic = evaluations.filter((item) => item.assurance !== 'judgment');
    const allPassed = deterministic.length > 0 && deterministic.every((item) => item.outcome === 'passed');
    const hasJudgment = evaluations.some((item) => item.assurance === 'judgment');
    state.assurance = allPassed ? (hasJudgment ? 'mixed' : 'verified') : hasJudgment ? 'acknowledged' : 'unassessed';
    state.status = allPassed && !hasJudgment ? 'achieved' : allPassed ? 'waiting' : 'not-achieved';
    return { event: 'criteria-evaluated', plan, planSha256: plan.planSha256, detail: evidenceId, value: { evidenceId, evaluations } };
  }, { now });
}

export async function pauseGovernedGoal(context, id, { config = {}, reason, now } = {}) {
  const detail = String(reason ?? '').trim();
  if (detail.length < 3) throw new SingularityFlowError('Pausing a governed Goal requires a reason.', { code: 'GOVERNED_GOAL_REASON_REQUIRED' });
  return mutateGovernedGoal(context, id, config, `Pause governed Goal ${id}`, ({ state, at, actor, plan }) => {
    if (['abandoned', 'achieved'].includes(state.status)) throw new SingularityFlowError(`Governed Goal '${id}' is ${state.status}.`, { code: 'GOVERNED_GOAL_TERMINAL' });
    if (state.paused) throw new SingularityFlowError(`Governed Goal '${id}' is already paused.`, { code: 'GOVERNED_GOAL_ALREADY_PAUSED' });
    state.paused = { at, actor, reason: detail, previousStatus: state.status };
    state.status = 'waiting';
    return { event: 'goal-paused', plan, detail };
  }, { now });
}

export async function resumeGovernedGoal(context, id, { config = {}, now } = {}) {
  return mutateGovernedGoal(context, id, config, `Resume governed Goal ${id}`, ({ state, plan }) => {
    if (!state.paused) throw new SingularityFlowError(`Governed Goal '${id}' is not paused.`, { code: 'GOVERNED_GOAL_NOT_PAUSED' });
    state.status = state.paused.previousStatus === 'waiting'
      ? (state.approvedPlan ? 'ready' : 'awaiting-plan-approval') : state.paused.previousStatus;
    state.paused = null;
    return { event: 'goal-resumed', plan };
  }, { now });
}

export async function abandonGovernedGoal(context, id, { config = {}, confirmation, reason, now } = {}) {
  const goalId = assertGovernedGoalId(id);
  if (confirmation !== goalId) throw new SingularityFlowError(`Abandoning a governed Goal requires exact confirmation '${goalId}'.`, { code: 'GOVERNED_GOAL_CONFIRMATION_REQUIRED' });
  const detail = String(reason ?? '').trim();
  if (detail.length < 3) throw new SingularityFlowError('Abandoning a governed Goal requires a reason.', { code: 'GOVERNED_GOAL_REASON_REQUIRED' });
  return mutateGovernedGoal(context, goalId, config, `Abandon governed Goal ${goalId}`, ({ state, plan }) => {
    if (state.status === 'abandoned') throw new SingularityFlowError(`Governed Goal '${goalId}' is already abandoned.`, { code: 'GOVERNED_GOAL_TERMINAL' });
    state.status = 'abandoned';
    state.paused = null;
    return { event: 'goal-abandoned', plan, detail };
  }, { now });
}

export function governedGoalImpact(loaded, linkStates) {
  return {
    goalId: loaded.contract.id,
    contractSha256: loaded.contract.contractSha256,
    planSha256: loaded.plan?.planSha256 ?? null,
    repositories: [...new Set(loaded.contract.linkedWork.map((link) => link.repositoryId))],
    linkedWork: loaded.contract.linkedWork.map((link) => ({
      ...link,
      live: linkStates.find((item) => item.kind === link.kind && item.id === link.id && item.repositoryId === link.repositoryId) ?? null,
      classification: 'unchanged'
    })),
    plannedWriteSet: loaded.plan?.plannedWriteSet ?? [governedGoalRelative(loaded.contract.id)],
    externalWrites: 0,
    modelCalls: 0
  };
}

export function governedGoalTrace(loaded, { criterionId = null } = {}) {
  const criteria = criterionId
    ? loaded.contract.criteria.filter((criterion) => criterion.id === criterionId)
    : loaded.contract.criteria;
  if (!criteria.length) throw new SingularityFlowError(`Governed Goal '${loaded.contract.id}' has no criterion '${criterionId}'.`, { code: 'GOVERNED_GOAL_CRITERION_NOT_FOUND' });
  return {
    goalId: loaded.contract.id,
    lifecycleBranch: loaded.contract.lifecycleBranch,
    revision: loaded.revision.commit,
    contractSha256: loaded.contract.contractSha256,
    plan: loaded.plan ? { generation: loaded.plan.generation, planSha256: loaded.plan.planSha256 } : null,
    approval: loaded.state.approvedPlan,
    criteria: criteria.map((criterion) => ({ criterionId: criterion.id, oracle: criterion.oracle }))
  };
}
