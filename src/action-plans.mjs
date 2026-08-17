import path from 'node:path';
import { branch, gitDir, head } from './git.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { SingularityFlowError, ensureDir, nowIso, readJson, run, writeAtomic } from './util.mjs';
import { worktreeFingerprint } from './worktree-fingerprint.mjs';

const PLAN_SCHEMA_VERSION = 2;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function planDirectory(root) {
  return path.join(gitDir(root), 'singularity-flow', 'action-plans');
}

function resultDirectory(root) {
  return path.join(gitDir(root), 'singularity-flow', 'action-results');
}

function tokenize(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  for (const character of String(command)) {
    if (escaped) { token += character; escaped = false; continue; }
    if (character === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (/\s/.test(character)) {
      if (token) { tokens.push(token); token = ''; }
      continue;
    }
    // Angle-bracket placeholders are part of the existing next-action vocabulary. They are kept
    // as data and mark the action non-executable below; this parser never invokes a shell.
    if (';&|`$\n\r'.includes(character)) {
      throw new SingularityFlowError(`Action command contains unsupported shell syntax: ${command}`);
    }
    token += character;
  }
  if (escaped || quote) throw new SingularityFlowError(`Action command contains an unfinished quote or escape: ${command}`);
  if (token) tokens.push(token);
  return tokens;
}

const READ_ONLY_COMMANDS = new Set([
  'about', 'cockpit', 'doctor', 'documents', 'guide', 'help', 'home', 'logs',
  'nextsteps', 'progress', 'report', 'review', 'status'
]);

function effectFor(argv) {
  const command = argv[0] ?? 'unknown';
  if (READ_ONLY_COMMANDS.has(command) || command === 'gate'
    || (command === 'pr' && !argv.includes('--create'))) {
    return { class: 'read', mutatesState: false, externalSideEffect: false, reversible: true };
  }
  if (command === 'sync' || command === 'resume' || command === 'refresh-branch') {
    return { class: 'synchronize', mutatesState: true, externalSideEffect: true, reversible: true };
  }
  if (command === 'approve' || command === 'reject' || command === 'submit'
    || (command === 'initiative' && ['approve', 'reject'].includes(argv[1]))) {
    return { class: 'decision', mutatesState: true, externalSideEffect: true, reversible: false };
  }
  if (command === 'prepare' || command === 'wm' || (command === 'phase' && argv[1] === 'publish')) {
    return { class: 'generation', mutatesState: true, externalSideEffect: command !== 'prepare', reversible: true };
  }
  return { class: 'mutation', mutatesState: true, externalSideEffect: true, reversible: false };
}

/**
 * A read-only preview of a lifecycle action.
 *
 * This is the same parser and effect classifier used when a governed action plan is persisted, but
 * it creates no plan, authorization, file, commit, or publication. Developer surfaces use it to
 * explain an action before the person chooses whether to create the real, revision-bound plan.
 */
export function previewAction(item = {}) {
  const tokens = tokenize(item.command ?? '');
  if (tokens[0] !== 'singularity-flow') {
    throw new SingularityFlowError(`Governed actions must invoke singularity-flow directly: ${item.command ?? ''}`);
  }
  const argv = tokens.slice(1);
  const effect = effectFor(argv);
  return Object.freeze({
    timing: item.timing ?? 'now',
    command: item.command,
    skill: item.skill ?? null,
    reason: item.reason ?? null,
    argv: Object.freeze(argv),
    executable: (item.timing ?? 'now') === 'now' && !argv.some((value) => /<[^>]+>/.test(value)),
    effect: Object.freeze(effect),
    confirmation: Object.freeze({
      required: effect.mutatesState,
      mode: effect.mutatesState ? 'one-time-authorization' : 'none'
    })
  });
}

function normalizeAction(item, index, revision) {
  const tokens = tokenize(item.command);
  if (tokens[0] !== 'singularity-flow') {
    throw new SingularityFlowError(`Governed actions must invoke singularity-flow directly: ${item.command}`);
  }
  const argv = tokens.slice(1);
  const executable = item.timing === 'now' && !argv.some((value) => /<[^>]+>/.test(value));
  const effect = effectFor(argv);
  const references = (item.references ?? []).map((reference) => {
    if (!reference || typeof reference !== 'object' || !/^sfref:v1:(story|initiative):[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[a-f0-9]{12,64}$/.test(reference.handle ?? '')) {
      throw new SingularityFlowError(`Action '${item.command}' contains an invalid governed reference.`);
    }
    return {
      handle: reference.handle,
      purpose: String(reference.purpose ?? 'supporting-evidence'),
      required: reference.required !== false
    };
  });
  const body = {
    order: index + 1,
    timing: item.timing,
    intent: argv[0] ?? 'unknown',
    type: argv.slice(0, 2).join(':'),
    arguments: argv.slice(1),
    skill: item.skill ?? null,
    command: item.command,
    argv,
    reason: item.reason,
    executable,
    effect,
    preconditions: [
      { type: 'branch-equals', expected: revision.branch },
      { type: 'head-equals', expected: revision.head },
      { type: 'worktree-hash-equals', expected: revision.worktreeHash },
      { type: 'lifecycle-hash-equals', expected: revision.lifecycleSha256 },
      { type: 'timing-equals', expected: 'now' }
    ],
    expectedOutcome: { text: item.reason, references }
  };
  const actionId = recordSha256(body).slice(0, 24);
  return {
    ...body,
    actionId,
    confirmation: effect.mutatesState
      ? { required: true, mode: 'one-time-authorization' }
      : { required: false, mode: 'none' },
    idempotencyKey: recordSha256({ revision, actionId, command: item.command })
  };
}

export function repositoryActionRevision(root, lifecycleSnapshot) {
  const workingTree = worktreeFingerprint(root);
  return {
    branch: branch(root),
    head: head(root),
    workingTree,
    // Kept as a compatibility field for existing action-plan consumers. It is now content-aware.
    worktreeHash: workingTree.sha256,
    lifecycleSha256: recordSha256(lifecycleSnapshot)
  };
}

export async function createActionPlan(root, lifecycleSnapshot, {
  ttlMs = DEFAULT_TTL_MS,
  subject: explicitSubject = null
} = {}) {
  const createdAt = nowIso();
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
  const revision = repositoryActionRevision(root, lifecycleSnapshot);
  const subject = explicitSubject ?? lifecycleSnapshot.subject ?? (lifecycleSnapshot.workId
    ? { kind: 'story', id: lifecycleSnapshot.workId }
    : { kind: 'repository', id: null });
  const core = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: 'governed-action-plan',
    subject,
    state: lifecycleSnapshot.state,
    revision,
    basedOn: {
      subject,
      head: revision.head,
      stateHash: revision.lifecycleSha256
    },
    createdAt,
    expiresAt,
    actions: (lifecycleSnapshot.actions ?? []).map((item, index) => normalizeAction(item, index, revision))
  };
  const planHash = recordSha256(core);
  const plan = { ...core, planId: planHash.slice(0, 24), planHash };
  await ensureDir(planDirectory(root));
  await writeAtomic(path.join(planDirectory(root), `${plan.planId}.json`), canonicalJson(plan), { mode: 0o600 });
  return plan;
}

export async function loadActionPlan(root, planId) {
  if (!/^[a-f0-9]{12,64}$/i.test(String(planId ?? ''))) throw new SingularityFlowError('Enter a valid governed action plan ID.');
  const plan = await readJson(path.join(planDirectory(root), `${planId}.json`));
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.kind !== 'governed-action-plan') {
    throw new SingularityFlowError(`Action plan '${planId}' uses an unsupported schema.`);
  }
  const { planHash, planId: storedId, ...core } = plan;
  const actual = recordSha256(core);
  if (actual !== planHash || !actual.startsWith(storedId)) throw new SingularityFlowError(`Action plan '${planId}' failed its content-hash check.`);
  return plan;
}

export function assertActionPlanFresh(root, plan, lifecycleSnapshot) {
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new SingularityFlowError(`Action plan '${plan.planId}' expired; create a fresh plan.`);
  const current = repositoryActionRevision(root, lifecycleSnapshot);
  for (const field of ['branch', 'head', 'worktreeHash', 'lifecycleSha256']) {
    if (current[field] !== plan.revision[field]) {
      throw new SingularityFlowError(
        `Action plan '${plan.planId}' is stale because ${field} changed. Re-run singularity-flow action plan.`
      );
    }
  }
  return current;
}

export function selectPlannedAction(plan, actionId = null) {
  if (actionId) {
    const selected = plan.actions.find((action) => action.actionId === actionId || action.actionId.startsWith(actionId));
    if (!selected) throw new SingularityFlowError(`Action '${actionId}' is not part of plan '${plan.planId}'.`);
    if (!selected.executable) throw new SingularityFlowError(`Action '${selected.actionId}' is not executable yet (${selected.timing}).`);
    return selected;
  }
  const executable = plan.actions.filter((action) => action.executable);
  if (executable.length !== 1) {
    throw new SingularityFlowError(
      `Plan '${plan.planId}' has ${executable.length} executable actions. Pass --action <id> after reviewing the plan.`
    );
  }
  return executable[0];
}

export async function readActionResult(root, plan, action) {
  const key = recordSha256({ planHash: plan.planHash, actionId: action.actionId });
  try { return await readJson(path.join(resultDirectory(root), `${key}.json`)); }
  catch (error) {
    if (error.message?.startsWith('Required file not found:')) return null;
    throw error;
  }
}

export async function recordActionResult(root, plan, action, result) {
  const key = recordSha256({ planHash: plan.planHash, actionId: action.actionId });
  const record = {
    schemaVersion: 1,
    kind: 'governed-action-result',
    key,
    planId: plan.planId,
    planHash: plan.planHash,
    actionId: action.actionId,
    command: action.command,
    completedAt: nowIso(),
    result
  };
  await ensureDir(resultDirectory(root));
  await writeAtomic(path.join(resultDirectory(root), `${key}.json`), canonicalJson(record), { mode: 0o600 });
  return record;
}
