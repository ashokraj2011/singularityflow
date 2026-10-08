/** Bounded guarded continuation. Only installed publish/submit vectors; never error-supplied shell. */
import { fileURLToPath } from 'node:url';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { branch } from './git.mjs';
import { inspectPhaseJourney } from './phase-journey-inspection.mjs';
import { phaseRepairBinding, repairDigest } from './phase-repair-journal.mjs';
import { appendContinuationEvent, readContinuationJournal } from './phase-continuation-journal.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { run, SingularityFlowError } from './util.mjs';
import { hasPublishedPhaseGeneration } from './code-submission-evidence.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const fail = (message, code, details) => { throw new SingularityFlowError(message, { code, details }); };
const runtime = { load: loadAcceptedStoryExecution, inspect: inspectPhaseJourney, branch,
  execute(root, argv) {
    // Reuse the real CLI transaction, including tests, current policy, publication and races.
    // Do not hold its Story lock: the coordinator has a distinct lock and the child owns its own.
    const result = run(process.execPath, [CLI, '--no-model', ...argv, '--json'], {
      cwd: root, shell: false, allowFailure: true, maxBuffer: 4 * 1024 * 1024, timeoutMs: 2 * 60 * 60 * 1000 + 60000 });
    let body = null;
    try { body = JSON.parse(String(result.stdout)); } catch { /* Unknown outcome is inspected, never replayed. */ }
    return { code: body?.error?.code ?? (result.timedOut ? 'SUBPROCESS_TIMEOUT' : result.status === 0 ? null : 'PHASE_CONTINUATION_OPERATION_FAILED'),
      diagnostic: body?.error ? redactDiagnosticText(JSON.stringify(body.error)).slice(0, 8192) : null };
  } };

function operation(current, observation) {
  const { phase, workflow } = current;
  const journey = observation.journey;
  if (workflow.status !== 'in_progress' || workflow.currentPhase !== phase.id || phase.status !== 'in_progress') return null;
  if (journey.state === 'ready-to-publish') {
    const offered = journey.next?.argv;
    // Closed producer/channel pairs from the installed publisher. Custom/error arguments do
    // not become executable just because a display route contains them.
    if (!Array.isArray(offered) || offered[0] !== 'phase' || offered[1] !== 'publish' || offered[2] !== phase.id) return null;
    const authored = offered[offered.indexOf('--authored') + 1];
    const channel = offered[offered.indexOf('--channel') + 1];
    const pair = `${authored}:${channel}`;
    if (!['governed-agent:copilot-host', 'human:manual-in-place', 'deterministic:kernel-generator'].includes(pair)) return null;
    return { id: 'publish', argv: ['phase', 'publish', phase.id, '--work-id', workflow.workItem.id, '--authored', authored, '--channel', channel] };
  }
  if (journey.state === 'ready-to-submit') {
    const offered = journey.next?.argv;
    if (!Array.isArray(offered) || offered[0] !== 'submit' || offered[1] !== phase.id
        || offered.some(value => /[<>]/u.test(value))) return null;
    return { id: 'submit', argv: ['submit', phase.id, '--work-id', workflow.workItem.id] };
  }
  return null;
}
async function context(root, workId, phaseId, dependencies) {
  const loaded = await dependencies.load(root, workId);
  const workflow = loaded.workflow; const config = loaded.definition ?? loaded.config;
  const phase = workflow.phases?.[phaseId ?? workflow.currentPhase];
  if (!phase || dependencies.branch(root) !== workflow.workItem.branch) fail('Attach the exact selected Story before continuing.', 'PHASE_CONTINUATION_BINDING_INVALID');
  return { root, config, workflow, phase, binding: await phaseRepairBinding(root, workflow, phase) };
}
async function preview(current, dependencies) {
  const observation = await dependencies.inspect(current.root, current.config, current.workflow, current.phase);
  const journal = await readContinuationJournal(current.root, current.binding);
  const action = operation(current, observation);
  const conditionHash = repairDigest({ phase: current.phase, policy: current.workflow.resolution,
    testPolicy: current.workflow.testPolicy ?? null, draft: observation.inspection?.draftFingerprint ?? null,
    recoveryRevision: observation.recovery?.revision ?? null, journey: observation.journey });
  const retryAllowed = Boolean(action && journal.consumed < 3 && !journal.attempts.some(a => a.action === action.id && a.conditionHash === conditionHash));
  const core = { binding: current.binding, journalRevision: journal.revision, conditionHash, action,
    scope: { allowedTransitions: ['publish', 'submit'], maximumOperations: 2, approve: false, humanDecisions: false },
    contractRevision: observation.journey.contractRevision };
  const confirmation = repairDigest(core);
  const blockedAttempt = journal.attempts.find(a => a.action === action?.id && a.conditionHash === conditionHash && a.result?.outcome === 'not-verified');
  const blocked = action && !retryAllowed && !journal.active;
  const journey = blocked ? { ...observation.journey, candidateState: observation.journey.state,
    state: 'operation-review', lastRefusal: blockedAttempt?.result?.code ?? 'PHASE_CONTINUATION_BUDGET_EXHAUSTED',
    diagnostic: blockedAttempt?.result?.diagnostic ?? null,
    transition: { ...observation.journey.transition, publishAllowed: false, submitAllowed: false },
    next: safeCommandGuidance({ executable: 'singularity-flow', argv: ['recover', current.workflow.workItem.id, '--phase', current.phase.id, '--json'] }),
    detail: 'Static readiness is not a successful operation. Review the failed/interrupted operation and change its relevant condition before retrying; manual repair remains available.' } : observation.journey;
  return { ...core, confirmation, status: journal.active ? 'resume-required' : action && retryAllowed ? 'confirmation-required' : journey.state,
    continuationAllowed: !journal.active && retryAllowed, journey, consumed: journal.consumed,
    attemptsRemaining: Math.max(0, 3 - journal.consumed), active: journal.active,
    next: journal.active ? safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'resolve-resume',
      '--work-id', current.workflow.workItem.id, '--phase', current.phase.id, '--json'] })
      : action && retryAllowed ? safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'resolve-run',
      '--work-id', current.workflow.workItem.id, '--phase', current.phase.id, '--confirm', confirmation, '--json'] }) : journey.next,
    mutates: false, modelInvocations: 0, testsRun: false, phaseAdvanced: false,
    humanApprovalAutomatic: false, autoAcceptRisk: false };
}
function verified(action, before, after) {
  // Success text/exit codes do not establish success. Authenticate the retained generation via
  // its normal inspection and verify that the exact generation/intent, not a new one, advanced.
  if (repairDigest(before.binding) !== repairDigest(after.binding)) return false;
  if (action === 'publish') return hasPublishedPhaseGeneration(after.phase)
    && Number(after.phase.generation) === before.binding.generation;
  return after.phase.status === 'awaiting_approval' && Number(after.phase.generation) === before.binding.generation;
}

/** Runtime overrides are test/installed seams only, never CLI or repository configuration. */
export async function coordinatePhaseContinuation({ root, workId = null, phaseId = null, action = 'preview', confirmation = null, modelEnabled = true } = {}, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  const inspect = dependencies.inspect;
  dependencies.inspect = (...args) => inspect(...args, { modelEnabled });
  const initial = await context(root, workId, phaseId, dependencies);
  if (action === 'preview') return preview(initial, dependencies);
  if (!['run', 'resume'].includes(action)) fail('Choose preview, run or resume.', 'PHASE_CONTINUATION_ACTION_INVALID');
  return withSubjectLock(root, { kind: 'phase-continuation', id: initial.workflow.workItem.id }, async () => {
    let current = await context(root, initial.workflow.workItem.id, initial.phase.id, dependencies);
    let plan = await preview(current, dependencies);
    if (action === 'resume') {
      if (!plan.active) return { ...plan, resumed: false };
      // A interrupted publish/submit may have committed. Reinspect once; never launch it again.
      const okay = verified(plan.active.action, { binding: plan.binding }, current)
        && plan.journey.state !== 'integrity-blocked';
      await appendContinuationEvent(root, initial.binding, { type: 'observed', attempt: plan.active.attempt,
        outcome: okay ? 'verified' : 'not-verified', code: okay ? null : 'PHASE_CONTINUATION_INTERRUPTED', diagnostic: null });
      return { ...await preview(current, dependencies), resumed: true, journalChanged: true,
        result: okay ? 'verified' : 'not-verified', mutates: true, registeredOperationExecuted: false };
    }
    if (confirmation !== plan.confirmation) fail('Review and confirm the exact current continuation. Draft, policy or journal changed.', 'PHASE_CONTINUATION_STALE', { plan });
    if (!plan.continuationAllowed) fail('Follow the returned author, human or owner route. No unchanged retry or automatic approval is available.', 'PHASE_CONTINUATION_NOT_ADMITTED', { plan });
    const executed = [];
    for (let step = 0; step < 2 && plan.continuationAllowed; step += 1) {
      await appendContinuationEvent(root, current.binding, { type: 'reserved', attempt: plan.consumed + 1,
        action: plan.action.id, conditionHash: plan.conditionHash, confirmation: plan.confirmation });
      await overrides.afterReservation?.();
      let errorCode = null; let diagnostic = null;
      try { const result = await dependencies.execute(root, plan.action.argv); errorCode = result?.code ?? null; diagnostic = result?.diagnostic ?? null; }
      catch (error) { errorCode = String(error.code ?? 'PHASE_CONTINUATION_OPERATION_FAILED').slice(0, 128); }
      await overrides.afterOperation?.();
      let after; let afterPlan;
      try {
        after = await context(root, current.workflow.workItem.id, current.phase.id, dependencies);
        afterPlan = await preview(after, dependencies);
      } catch (error) {
        // Reservation survives; resolve-resume authenticates the outcome on a later invocation.
        return { ...plan, status: 'resume-required', journalChanged: true, registeredOperationExecuted: true,
          mutates: true, testsRun: null, testsMayHaveRun: true,
          errorCode: String(error.code ?? 'PHASE_CONTINUATION_INSPECTION_UNAVAILABLE').slice(0, 128), executed,
          next: safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'resolve-resume', '--work-id', current.workflow.workItem.id, '--phase', current.phase.id, '--json'] }) };
      }
      const okay = verified(plan.action.id, current, after) && afterPlan.journey.state !== 'integrity-blocked';
      await appendContinuationEvent(root, current.binding, { type: 'observed', attempt: plan.consumed + 1,
        outcome: okay ? 'verified' : 'not-verified', code: okay ? null : errorCode ?? 'PHASE_CONTINUATION_POSTCONDITION_FAILED',
        diagnostic: diagnostic ? redactDiagnosticText(diagnostic).slice(0, 2048) : null });
      executed.push({ action: plan.action.id, outcome: okay ? 'verified' : 'not-verified', code: errorCode, diagnostic });
      current = after; plan = await preview(current, dependencies);
      if (!okay) break;
    }
    return { ...plan, journalChanged: true, registeredOperationExecuted: executed.length > 0, executed,
      mutates: true, testsRun: executed.length ? null : false,
      stateChanged: executed.some(result => result.outcome === 'verified'), testsMayHaveRun: executed.length > 0 };
  });
}
