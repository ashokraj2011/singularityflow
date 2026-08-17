/**
 * Progress for work that will not finish while someone waits. `[INT:REQ-187]` `[INT:IFC-084]`
 *
 * A materialization, a multi-repository query, a bisection or a test run can take minutes. The
 * failure this contract exists to prevent is not slowness — it is a conversational model narrating
 * plausible progress for a job it cannot see `[INT:CON-184]`. So an update is only ever emitted
 * from a kernel step that actually reached a state, and the state vocabulary is closed.
 *
 * Stopping is part of the contract, not an afterthought `[INT:REQ-188]`: a job that cannot be
 * stopped safely has to say so *before* it starts, which is what `cancellationSafety` is for.
 */
import { SingularityFlowError } from '../util.mjs';

export const JOB_SCHEMA_VERSION = 1;

/** The only states a step can be in. Anything else would be narration. `[INT:CON-184]` */
export const STEP_STATES = Object.freeze([
  'queued', 'active', 'blocked', 'completed', 'skipped', 'stopped', 'failed'
]);

const TERMINAL_STATES = new Set(['completed', 'skipped', 'stopped', 'failed']);

/**
 * What stopping this step costs.
 *
 * `safe` can be stopped and leaves nothing behind. `retains-evidence` can be stopped and keeps
 * completed work that the user should know about. `unsafe-mid-write` must not be interrupted, and
 * saying so up front is the difference between a user waiting on purpose and a user force-quitting.
 */
export const CANCELLATION_SAFETY = Object.freeze(['safe', 'retains-evidence', 'unsafe-mid-write']);

/** How much of the work survives a stop, so resuming is a decision rather than a hope. */
export const RESUMABILITY = Object.freeze(['resumable', 'restart-required', 'not-resumable']);

/** Diagnostics are bounded here, at the producer, so an unbounded log cannot become the message. */
export const MAX_DIAGNOSTIC_LENGTH = 500;

function reject(code, detail, details = {}) {
  throw new SingularityFlowError(detail, { code, details });
}

/**
 * One progress update, from one kernel step that reached one state. `[INT:IFC-084]`
 *
 * Every field is required. A partial update is the shape that invites a reader to fill the gap
 * themselves, and the gap is exactly where invented progress goes.
 */
export function progressUpdate({
  jobId,
  subject,
  stepId,
  state,
  currentActivity,
  completedEvidence = [],
  diagnostic = null,
  cancellationSafety,
  resumability
} = {}) {
  if (!jobId) reject('JOB_PROGRESS_INVALID', 'A progress update must name its job.');
  if (!stepId) reject('JOB_PROGRESS_INVALID', 'A progress update must name the step it came from.');
  if (!subject?.kind || !subject?.id) reject('JOB_PROGRESS_INVALID', 'A progress update must name its subject.');
  if (!STEP_STATES.includes(state)) {
    reject('JOB_PROGRESS_INVALID', `state '${state}' is not one of ${STEP_STATES.join(', ')}.`, { state });
  }
  if (!CANCELLATION_SAFETY.includes(cancellationSafety)) {
    reject('JOB_PROGRESS_INVALID', `cancellationSafety '${cancellationSafety}' is not one of ${CANCELLATION_SAFETY.join(', ')}.`);
  }
  if (!RESUMABILITY.includes(resumability)) {
    reject('JOB_PROGRESS_INVALID', `resumability '${resumability}' is not one of ${RESUMABILITY.join(', ')}.`);
  }
  if (!currentActivity) reject('JOB_PROGRESS_INVALID', 'A progress update must say what the step is doing.');
  if (diagnostic != null && String(diagnostic).length > MAX_DIAGNOSTIC_LENGTH) {
    reject('JOB_PROGRESS_INVALID', `A diagnostic must be at most ${MAX_DIAGNOSTIC_LENGTH} characters.`, { length: String(diagnostic).length });
  }
  if (state === 'blocked' && !diagnostic) {
    // Blocked without a reason is the update that makes a user wait for nothing.
    reject('JOB_PROGRESS_INVALID', 'A blocked step must say what it is blocked on.', { stepId });
  }

  return Object.freeze({
    schemaVersion: JOB_SCHEMA_VERSION,
    kind: 'job-progress',
    jobId,
    subject: Object.freeze({ kind: subject.kind, id: subject.id }),
    stepId,
    state,
    terminal: TERMINAL_STATES.has(state),
    currentActivity,
    completedEvidence: Object.freeze([...completedEvidence]),
    diagnostic: diagnostic ?? null,
    cancellationSafety,
    resumability
  });
}

/**
 * Stop a job, and disclose what stopping left behind. `[INT:REQ-188]`
 *
 * Refuses while any step is mid-write. The alternative — stopping anyway and reporting it — is how
 * a half-written publication becomes someone's afternoon.
 */
export function stopJob(jobId, steps = []) {
  const unsafe = steps.filter((step) => step.state === 'active' && step.cancellationSafety === 'unsafe-mid-write');
  if (unsafe.length) {
    reject('JOB_STOP_REFUSED',
      `Cannot stop yet: ${unsafe.map((step) => step.stepId).join(', ')} would be interrupted mid-write.`,
      { jobId, steps: unsafe.map((step) => step.stepId) });
  }
  const retained = steps
    .filter((step) => step.completedEvidence.length || step.cancellationSafety === 'retains-evidence')
    .flatMap((step) => step.completedEvidence);

  return Object.freeze({
    schemaVersion: JOB_SCHEMA_VERSION,
    kind: 'job-stopped',
    jobId,
    stoppedSteps: Object.freeze(steps.filter((step) => step.state === 'active' || step.state === 'queued').map((step) => step.stepId)),
    /** Completed evidence survives a stop, and the user is told it did rather than finding it later. */
    retainedEvidence: Object.freeze([...new Set(retained)]),
    resumable: steps.every((step) => step.resumability !== 'not-resumable')
  });
}

/**
 * What a resumed job must re-check before it continues. `[INT:CON-185]`
 *
 * Returns the fields that moved rather than a verdict, so the caller can refuse with a reason —
 * and so that adding a field to the binding cannot silently narrow what resumption verifies.
 */
export function resumeBlockers(recorded = {}, current = {}) {
  const fields = ['actorId', 'subjectId', 'sourceCommit', 'worktreeHash', 'worktreeAlgorithm', 'policyHash', 'registryHash', 'providerObservation'];
  const drifted = fields.filter((field) => (recorded[field] ?? null) !== (current[field] ?? null));
  const steps = (recorded.completedSteps ?? []).filter((step) => {
    const now = (current.completedSteps ?? []).find((entry) => entry.stepId === step.stepId);
    return !now || now.hash !== step.hash;
  });
  return Object.freeze({
    drifted: Object.freeze(drifted),
    changedSteps: Object.freeze(steps.map((step) => step.stepId)),
    resumable: !drifted.length && !steps.length
  });
}
