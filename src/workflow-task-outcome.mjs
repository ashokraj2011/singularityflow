/**
 * SPEC-OSA v1.1 §8 and plan section 5 ("Task stages"): a durable task outcome for the version being written. When a check
 * stops the step at a boundary its author cannot cross alone, the task record keeps where it stopped, so every surface and
 * every later turn, chat or laptop names the same continuation, and nothing repeats the same route meanwhile:
 *   - `waiting-person`: a person's decision (a Node to pin for a failed required test);
 *   - `waiting-environment`: the environment stopped the run (a person accepts the risk, or it is fixed);
 *   - `waiting-input`: an input that is not on this laptop;
 *   - `repair-required`: the step's own repair, within its configured budget, then a person's decision;
 *   - `publication-pending`: the step's commit is made here and waits to reach the shared Story branch. It is read from the
 *     sealed pending-publication record (publication-pending.mjs), which keeps the exact commit, branch, remote and lease
 *     across an interruption; its continuation sends that commit and nothing is written again.
 *
 * The record is progress, never authority (workflow-task.mjs): the outcome is kept as its `blockedCode`,
 * `<outcome>:<original code>:<lifecycle mark>`, so an older reader sees an ordinary blocked task. The lifecycle mark is the
 * Story record's history as it was then: any lifecycle event since (the person's decision on the card, a publication)
 * makes the outcome stale, and the kernel decides from the Story again [§4.1, plan section 5 "After mutations"].
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';

const OUTCOMES = new Set(['running', 'waiting-input', 'waiting-environment', 'waiting-person', 'repair-required']);
const PATTERN = /^(running|waiting-input|waiting-environment|waiting-person|repair-required):([A-Za-z0-9_.-]{1,80}):([a-f0-9]{12})$/u;

/** The Story record's lifecycle as a short mark: its history's length and last entry. */
export function lifecycleMark(workflow) {
  const history = Array.isArray(workflow?.history) ? workflow.history : [];
  const last = history.at(-1) ?? null;
  return createHash('sha256').update(JSON.stringify([history.length, last?.at ?? null, last?.event ?? null, last?.phase ?? null])).digest('hex').slice(0, 12);
}

/** The code a task record keeps for an outcome, or null for an outcome or code it cannot keep. */
export function outcomeCode(outcome, code, workflow) {
  if (!OUTCOMES.has(outcome) || !/^[A-Za-z0-9_.-]{1,80}$/u.test(String(code ?? ''))) return null;
  return `${outcome}:${code}:${lifecycleMark(workflow)}`;
}

/**
 * The kernel's task fact from a task record (`StepSnapshot/v1` step.task), or null: no outcome kept, or one the Story
 * moved past since. `repairs` is the record's spent repair budget against its configured maximum.
 */
export function taskOutcomeOf(record, workflow) {
  if (!record || record.state !== 'blocked') return null;
  const match = PATTERN.exec(String(record.blockedCode ?? ''));
  if (!match || match[3] !== lifecycleMark(workflow)) return null;
  return { id: record.id ?? null, outcome: match[1], code: match[2], stage: record.state,
    repairs: { used: Number(record.repairConsumed ?? 0), budget: Number(record.maximumContinuations ?? 0) } };
}

/** Which outcome a refused check stops the step at, from the refusal's own facts; null when it names none. */
export function refusalOutcome(refusal) {
  if (refusal?.code !== 'CODE_TEST_FAILED') return null;
  const details = refusal.details ?? {};
  // A Node to pin is one person's choice on the decisions card.
  if (details.nodePin?.version) return 'waiting-person';
  // The environment stopped the run: a person accepts the risk, or the environment is fixed.
  if (details.testRunRisk?.eligible || details.testRunCause) return 'waiting-environment';
  return 'repair-required';
}

/**
 * Keep where a refused check stopped the version being written, in its task record; never fails the refusal it follows.
 * Returns the outcome kept, or null.
 */
export async function recordRefusalOutcome(root, workflow, phase, refusal) {
  const outcome = refusalOutcome(refusal);
  if (!outcome) return null;
  // The mark of the Story record as it stays on disk: a refused transaction may have changed the one in memory.
  let kept = workflow;
  try {
    const [{ readFile }, path, { readRecord }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('./schema-migrations.mjs')]);
    kept = readRecord('story-workflow', await readFile(path.join(root, workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id, 'workflow.json'), 'utf8')).record;
  } catch { kept = workflow; }
  const blockedCode = outcomeCode(outcome, refusal.code, kept);
  if (!blockedCode) return null;
  try {
    const store = await import('./workflow-task-store.mjs');
    await store.observeWorkflowTask(root, workflow, phase, { state: 'blocked', blockedCode });
    return outcome;
  } catch { return null; }
}

/**
 * The kernel's `publication-pending` task fact from a pending-publication record (readPendingPublication or
 * inspectPendingPublication), with its original resources: the retained commit and its transaction. `true` (a caller
 * that only knows one is pending) gives the fact without them.
 */
export function publicationPendingFact(pending) {
  if (!pending) return null;
  const record = pending === true ? {} : pending.record ?? {};
  const word = (value, pattern) => (pattern.test(String(value ?? '')) ? String(value) : null);
  return { id: word(record.transactionId, /^[A-Za-z0-9._:-]{1,128}$/u), outcome: 'publication-pending', code: 'PUBLICATION_PENDING',
    stage: word(record.recoveryStage, /^[a-z][a-z-]{0,80}$/u), commit: word(record.commit, /^[0-9a-f]{40,64}$/u) };
}

/**
 * `running`: another process on this machine holds the Story's lease and its heartbeat is renewed (a long quality or test
 * run under the subject lock). Observed as it is, never called damaged and never started again [§8, OSA:REQ-051]. This
 * process's own lease, or one whose owner cannot be read here, is not an execution to observe.
 */
export function runningExecutionFact(lease) {
  const liveness = lease?.liveness;
  if (!lease?.held || liveness?.state !== 'alive' || liveness.reason === 'this-process' || liveness.heartbeat !== 'fresh') return null;
  return { id: null, outcome: 'running', code: 'STORY_LEASE_HELD', stage: 'execution', progressReference: liveness.lastHeartbeatAt ?? null };
}

/**
 * The kernel's task fact for the current step: a retained publication first (it survives any interruption in its sealed
 * record), then a running execution's live lease, else the step's task record. Private files only, no Git; null on any doubt.
 * Every view reads it (next steps, submission readiness, phase show through readiness) and hands it to the kernel's decision
 * (step-decision.mjs stepDecisionOf), so beside it goes `askedFor`: what the person typed that a step nobody approves still
 * owes an account, which its submission waits for, so every view leads with its author's account [SCS:REQ-042].
 */
export async function readTaskOutcome(root, workflow, phase, options = {}) {
  if (phase?.id !== workflow.currentPhase) return null;
  const task = await taskFactOf(root, workflow, phase, options);
  const owed = await askedForOwed(workflow, phase);
  return owed.length ? { ...(task ?? {}), askedFor: owed } : task;
}

/** The instructions the submission of a step nobody approves waits to see accounted for, read from the CLI source; [] on any doubt. */
async function askedForOwed(workflow, phase) {
  if (!(workflow.askedFor ?? []).some((entry) => entry.phase === phase.id)) return [];
  try {
    return await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'asked-for-records.mjs')).href)).owedAtSubmission(workflow, phase);
  } catch { return []; }
}

async function taskFactOf(root, workflow, phase, { pending } = {}) {
  try {
    const retained = pending !== undefined ? pending : await (await import('./publication-pending.mjs')).readPendingPublication(root,
      { kind: 'story', id: workflow.workItem.id, migrate: false, roots: { workItemRoot: workflow.resolution?.workItemRoot ?? 'singularity/work-items' } }).catch(() => null);
    if (retained) return publicationPendingFact(retained);
    const running = runningExecutionFact(await (await import('./subject-lock.mjs')).inspectSubjectLease(root, { kind: 'story', id: workflow.workItem.id }));
    if (running) return running;
  } catch { /* neither read: the task record below */ }
  try {
    const [{ readWorkflowTask }, { workflowTaskApplies, workflowTaskHasGeneration }] = await Promise.all([
      import('./workflow-task-store.mjs'), import('./workflow-task.mjs')]);
    if (!workflowTaskApplies(phase) || !workflowTaskHasGeneration(workflow, phase)) return null;
    return taskOutcomeOf(await readWorkflowTask(root, workflow, phase), workflow);
  } catch { return null; }
}

/**
 * The same task fact for the edit guard and the phase entry [OSA:REQ-010]: one basis with every view, read from private
 * files only, never Git or history [OSA:REQ-041]. `files`: the task record file it stands on, which the guard stamps, so a
 * spent repair budget recorded later derives the turn again and stops its writes through the kernel. Only the repair and
 * running stages are handed on: a wait for an input, the environment or a person is named by every view, but the turn
 * that asked keeps the version's writes while the person decides (journey E), as before Stage 5 (an owner decision,
 * docs/osa/stage5.md section 9). A publication left pending is not read here: the views name `sync`, and the CLI's
 * publication gate refuses the next lifecycle mutation.
 */
const GUARD_STAGES = new Set(['repair-required', 'running']);
export async function readGuardTaskOutcome(root, workflow, phase) {
  if (!phase || phase.id !== workflow?.currentPhase || phase.status !== 'in_progress') return { task: null, files: [] };
  let task = null, files = [];
  try {
    const [store, { workflowTaskApplies, workflowTaskHasGeneration }] = await Promise.all([import('./workflow-task-store.mjs'), import('./workflow-task.mjs')]);
    if (workflowTaskApplies(phase) && workflowTaskHasGeneration(workflow, phase)) {
      files = [store.workflowTaskRecordFile(root, workflow, phase)];
      const kept = taskOutcomeOf(await store.readWorkflowTask(root, workflow, phase), workflow);
      task = GUARD_STAGES.has(kept?.outcome) ? kept : null;
    }
  } catch { task = null; }
  if (task) return { task, files };
  try {
    const running = runningExecutionFact(await (await import('./subject-lock.mjs')).inspectSubjectLease(root, { kind: 'story', id: workflow.workItem.id }));
    if (running) return { task: running, files };
  } catch { /* no execution observed */ }
  return { task: null, files };
}
