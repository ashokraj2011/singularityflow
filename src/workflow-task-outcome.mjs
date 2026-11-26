/**
 * SPEC-OSA v1.1 §8 and plan section 5 ("Task stages"): a durable task outcome for the version being written. When a check
 * stops the step at a boundary its author cannot cross alone, the task record keeps where it stopped, so every surface and
 * every later turn, chat or laptop names the same continuation, and nothing repeats the same route meanwhile:
 *   - `waiting-person`: a person's decision (a Node to pin for a failed required test);
 *   - `waiting-environment`: the environment stopped the run (a person accepts the risk, or it is fixed), kept with its
 *     own error: the cause class a test-run risk names, or the environment that blocked the run before it started;
 *   - `waiting-input`: an input that is not on this laptop, kept with its identity (a local document's ID);
 *   - `repair-required`: the step's own repair, within its configured budget, then a person's decision;
 *   - `publication-pending`: the step's commit is made here and waits to reach the shared Story branch. It is read from the
 *     sealed pending-publication record (publication-pending.mjs), which keeps the exact commit, branch, remote and lease
 *     across an interruption; its continuation sends that commit and nothing is written again.
 *
 * The record is progress, never authority (workflow-task.mjs): the outcome is kept as its `blockedCode`,
 * `<outcome>:<original code>:<lifecycle mark>[:<input>]`, so an older reader sees an ordinary blocked task. The lifecycle mark is the
 * Story record's history as it was then: any lifecycle event since (the person's decision on the card, a publication)
 * makes the outcome stale, and the kernel decides from the Story again [§4.1, plan section 5 "After mutations"].
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';
import { storyLocation, storiesRoot } from './story-paths.mjs';

const OUTCOMES = new Set(['running', 'waiting-input', 'waiting-environment', 'waiting-person', 'repair-required']);
const PATTERN = /^(running|waiting-input|waiting-environment|waiting-person|repair-required):([A-Za-z0-9_.-]{1,80}):([a-f0-9]{12})(?::([A-Za-z0-9_.-]{1,40}))?$/u;

/** The Story record's lifecycle as a short mark: its history's length and last entry. */
export function lifecycleMark(workflow) {
  const history = Array.isArray(workflow?.history) ? workflow.history : [];
  const last = history.at(-1) ?? null;
  return createHash('sha256').update(JSON.stringify([history.length, last?.at ?? null, last?.event ?? null, last?.phase ?? null])).digest('hex').slice(0, 12);
}

/** The code a task record keeps for an outcome, and the input it waits for, or null for an outcome or code it cannot keep. */
export function outcomeCode(outcome, code, workflow, input = null) {
  if (!OUTCOMES.has(outcome) || !/^[A-Za-z0-9_.-]{1,80}$/u.test(String(code ?? ''))) return null;
  const kept = `${outcome}:${code}:${lifecycleMark(workflow)}`;
  // A task record keeps at most 128 characters of code (workflow-task.mjs): an input that does not fit is left out.
  return input != null && /^[A-Za-z0-9_.-]{1,40}$/u.test(String(input)) && kept.length + String(input).length < 128 ? `${kept}:${input}` : kept;
}

/**
 * The kernel's task fact from a task record (`StepSnapshot/v1` step.task), or null: no outcome kept, or one the Story
 * moved past since. `repairs` is the record's spent repair budget against its configured maximum.
 */
export function taskOutcomeOf(record, workflow) {
  if (!record || record.state !== 'blocked') return null;
  const match = PATTERN.exec(String(record.blockedCode ?? ''));
  if (!match || match[3] !== lifecycleMark(workflow)) return null;
  return { id: record.id ?? null, outcome: match[1], code: match[2], ...(match[4] ? { input: match[4] } : {}), stage: record.state,
    repairs: { used: Number(record.repairConsumed ?? 0), budget: Number(record.maximumContinuations ?? 0) } };
}

// A run blocked before it started because the environment is not set up here: its file is missing or in use, none is
// bound, its policy gives no local run its values, or its command is not an exact argv. No code edit passes any of them.
const ENVIRONMENT_BLOCKS = new Set(['ENV_FILE_MISSING', 'ENV_FILE_IN_USE', 'ENVIRONMENT_BINDING_UNAVAILABLE',
  'ENVIRONMENT_ISOLATED_RUNNER_REQUIRED', 'ENVIRONMENT_ARGV_REQUIRED']);

/**
 * Where a refused check stops the step, from the refusal's own facts: `{ outcome, code, input }`, or null when it names
 * none [§8, CVL-REQ-004]. The code kept is the native one where there is one.
 */
export function refusalStop(refusal) {
  const details = refusal?.details ?? {};
  // An input the step needs is not on this laptop: the first document to restore, by its ID.
  if (refusal?.code === 'DOCUMENT_REUPLOAD_REQUIRED') return { outcome: 'waiting-input', code: refusal.code, input: details.documentReadiness?.missing?.[0]?.id ?? null };
  if (refusal?.code !== 'CODE_TEST_FAILED') return null;
  const execution = details.requiredTestExecution ?? {};
  // A Node to pin is one person's choice on the decisions card, unless the evidence names it: then SFlow settles it before
  // the next run, and the run is the step's own again (node-version-settle.mjs).
  if (details.nodePin?.version && !details.nodePin.settles) return { outcome: 'waiting-person', code: refusal.code };
  // The environment stopped the run: a person accepts the risk, or the environment is fixed; kept with the environment's name.
  if (ENVIRONMENT_BLOCKS.has(execution.errorCode)) return { outcome: 'waiting-environment', code: execution.errorCode, input: execution.environment ?? null };
  const cause = String(details.testRunRisk?.causeClass ?? '').replaceAll('+', '.');
  if (details.testRunRisk?.eligible) return { outcome: 'waiting-environment', code: /^[a-z.-]{1,80}$/u.test(cause) ? cause : refusal.code };
  // A code cause, or one nothing names (a timeout among them), is the step's own repair: no environment decision covers it.
  return { outcome: 'repair-required', code: refusal.code };
}

/** Which outcome a refused check stops the step at; null when it names none. */
export function refusalOutcome(refusal) {
  return refusalStop(refusal)?.outcome ?? null;
}

/**
 * Keep where a refused check stopped the version being written, in its task record; never fails the refusal it follows.
 * Returns the outcome kept, or null.
 */
export async function recordRefusalOutcome(root, workflow, phase, refusal) {
  const stop = refusalStop(refusal);
  if (!stop) return null;
  // The mark of the Story record as it stays on disk: a refused transaction may have changed the one in memory.
  let kept = workflow;
  try {
    const [{ readFile }, path, { readRecord }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('./schema-migrations.mjs')]);
    kept = readRecord('story-workflow', await readFile(storyLocation(root, workflow, workflow.workItem.id).file('workflow.json'), 'utf8')).record;
  } catch { kept = workflow; }
  const blockedCode = outcomeCode(stop.outcome, stop.code, kept, stop.input);
  if (!blockedCode) return null;
  try {
    const store = await import('./workflow-task-store.mjs');
    await store.observeWorkflowTask(root, workflow, phase, { state: 'blocked', blockedCode });
    return stop.outcome;
  } catch { return null; }
}

/**
 * After a local document is restored: the step's wait for an input is answered, or it waits for the next one still
 * missing. Only a kept `waiting-input` changes; private files only. `readiness`: the step's document readiness now.
 */
export async function settleInputWait(root, workflow, readiness) {
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!phase || readiness?.phase !== phase.id) return null;
  const store = await import('./workflow-task-store.mjs');
  const kept = PATTERN.exec(String((await store.readWorkflowTask(root, workflow, phase).catch(() => null))?.blockedCode ?? ''));
  if (kept?.[1] !== 'waiting-input' || kept[3] !== lifecycleMark(workflow)) return null;
  const next = readiness.missing?.[0]?.id ?? null;
  await store.observeWorkflowTask(root, workflow, phase, { blockedCode: next ? outcomeCode('waiting-input', kept[2], workflow, next) : null });
  return next ? 'waiting-input' : null;
}

/** After a restore (documents.mjs): the current step's input wait, settled against its readiness now; never fails the restore. */
export async function settleRestoredInput(root, config, workflow) {
  if (!workflow.currentPhase) return null;
  try {
    return await settleInputWait(root, workflow, await (await import('./document-runtime.mjs')).phaseDocumentReadiness(root, config, workflow, workflow.currentPhase));
  } catch { return null; }
}

/**
 * Whether an entry keeps the stop its task record holds [§8]: a wait for an input, the environment or a person, or a spent
 * repair, which entering the step again does not settle. A wait for an input the entry found present (`inputsReady`) is
 * settled by it; a repair within its budget is the entry's own work; any lifecycle event since makes it stale.
 */
export function entryKeepsStop(record, workflow, { inputsReady = false } = {}) {
  const kept = taskOutcomeOf(record, workflow);
  if (!kept || kept.outcome === 'running' || (kept.outcome === 'waiting-input' && inputsReady)) return false;
  return kept.outcome !== 'repair-required' || kept.repairs.used >= kept.repairs.budget;
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
 * (step-decision.mjs stepDecisionOf), so beside it go `changeRequested`: the person's typed words wait for the published
 * step's next version, and every view asks its version question as the entry and the edit guard do [daily run 2026-11-17];
 * and `askedFor`: what the person typed that a step nobody approves still owes an account, which its submission waits for,
 * so every view leads with its author's account [SCS:REQ-042].
 */
export async function readTaskOutcome(root, workflow, phase, options = {}) {
  if (phase?.id !== workflow.currentPhase) return null;
  const task = await taskFactOf(root, workflow, phase, options);
  const changed = await changeWaits(root, workflow, phase);
  const owed = await askedForOwed(workflow, phase);
  return changed || owed.length ? { ...(task ?? {}), ...(changed ? { changeRequested: true } : {}), ...(owed.length ? { askedFor: owed } : {}) } : task;
}

/** The typed words a published step's next version waits for, read as the entry reads them (from the CLI source). */
async function changeWaits(root, workflow, phase) {
  if (phase.status !== 'in_progress' || !(Number(phase.generation) > 0)) return false;
  try {
    return (await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'requested-successor.mjs')).href))
      .requestedChanges(root, workflow, phase)).length > 0;
  } catch { return false; }
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
      { kind: 'story', id: workflow.workItem.id, migrate: false, roots: { workItemRoot: storiesRoot(workflow) } }).catch(() => null);
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
