/** Durable coordination of closed repairs; repository/error text is never an executable action. */
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { branch } from './git.mjs';
import { loadSession } from './session.mjs';
import { phasePrepublish } from './phase-prepublish.mjs';
import { phaseDraftCheck } from './phase-draft-check.mjs';
import { requiresProspectivePhaseInspection } from './code-submission-evidence.mjs';
import { recoveryPlan, applyRecovery } from './collaboration.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import { phaseResolutionProjection, repairLoopAdmission } from './phase-resolution.mjs';
import { storyUsesStepActions } from './step-action-delivery.mjs';
import { appendPhaseRepairEvent, phaseRepairBinding, phaseRepairLoopSummary, readPhaseRepairJournal, repairDigest } from './phase-repair-journal.mjs';
import { SingularityFlowError } from './util.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
/** Progress means changed findings, not padding, moved line numbers or unrelated source edits. */
export function phaseRepairConditionHash({ ready, findings, pending = null }) {
  const identities = findings.map(({ code, path, value, details }) => ({ code, path: path ?? null,
    value: value ?? details?.clauseId ?? null, sourceCode: details?.sourceCode ?? null }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return repairDigest({ ready, findings: identities, pending });
}
async function inspect(root, config, workflow, phase, { modelEnabled = true } = {}) {
  const session = await loadSession(root, { required: false });
  const inspection = requiresProspectivePhaseInspection(workflow, phase) ? await phasePrepublish(root, config, workflow, phase, { session, modelEnabled })
    : await phaseDraftCheck(root, config, workflow, phase, { session, modelEnabled });
  const recovery = await recoveryPlan(root, config, workflow, { phaseId: phase.id, inspectActivePhase: true, modelEnabled });
  const findings = [...inspection.findings, ...recovery.blockers];
  const unique = [...new Map(findings.map(finding => [
    [finding.code, finding.path, finding.line, finding.value, finding.details?.clauseId].join('\0'), finding
  ])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // A repair journal hold is coordination, not the condition being repaired. Keeping it in the
  // fingerprint would make reservation itself appear to be progress on the underlying blocker.
  const underlying = unique.filter(finding => (finding.details?.sourceCode ?? finding.code) !== 'PHASE_REPAIR_RECHECK_REQUIRED');
  const coordinationOnly = unique.length > 0 && underlying.length === 0;
  const ready = underlying.length === 0 && (inspection.status === 'ready'
    || (coordinationOnly && inspection.readiness?.lifecycle === true && inspection.readiness?.authoring === true));
  const conditionHash = phaseRepairConditionHash({ ready, findings: underlying,
    pending: recovery.publicationRecovery?.status === 'pending' ? repairDigest(recovery.publicationRecovery.record) : null });
  return { inspection, recovery, findings: underlying, ready, conditionHash,
    resolution: phaseResolutionProjection(workflow, phase, underlying) };
}
const runtime = { load: loadAcceptedStoryExecution, inspect, branch, lock: withSubjectLock,
  sync: (root, config, workflow, plan) => applyRecovery(root, config, workflow,
    { ...plan, actions: plan.actions.filter(action => action.id === 'publish' && action.command === 'singularity-flow sync') }, { confirm: plan.planId }) };

async function context(root, workId, phaseId, dependencies) {
  const loaded = await dependencies.load(root, workId);
  const config = loaded.definition ?? loaded.config; const workflow = loaded.workflow;
  const phase = workflow.phases?.[phaseId ?? workflow.currentPhase];
  if (!phase || workflow.currentPhase !== phase.id || workflow.status !== 'in_progress'
      || !['in_progress', 'awaiting_approval'].includes(phase.status)) fail('Select the current active phase. Published history and completed phases are never repaired in place.', 'PHASE_REPAIR_LIFECYCLE');
  const binding = await phaseRepairBinding(root, workflow, phase);
  return { root, config, workflow, phase, binding };
}
const policyHash = ({ config, workflow, phase }, observation) => repairDigest({ resolution: workflow.resolution ?? null,
  testPolicy: workflow.testPolicy ?? null, approvalPolicy: phase.approvalPolicy ?? null,
  generationPolicy: phase.generationPolicy ?? null, repairBudget: phase.repairBudget ?? null,
  governance: config.governance ?? null, producer: observation.inspection.producer ?? null,
  owner: observation.inspection.ownership ?? null });
const AUTHOR_FINDING_CATEGORIES = new Set(['authoring', 'artifact', 'traceability', 'artifact-set',
  'specification-quality', 'specification-index', 'planning-table']);
function actionFor(observation, { phase, workflow, config }) {
  const recovery = observation.recovery;
  // Only retry a retained, already governed publication. No fresh publish, generic push, fetch,
  // integration delivery, test command, arbitrary shell, approval or discard is registered here.
  if (!storyUsesStepActions(workflow) && !(workflow.resolution?.ledger ?? config.ledger)?.enabled
      && recovery.pendingPublication && recovery.publicationRecovery?.status === 'pending'
      && recovery.publicationRecovery.record?.recoveryStage !== 'interrupted-before-branch-ref-advanced'
      && recovery.actions.some(action => action.id === 'publish' && action.automatic === true
        && action.command === 'singularity-flow sync')) {
    return { id: 'sync-retained-publication', mode: 'automatic',
      pendingHash: repairDigest(recovery.publicationRecovery.record),
      detail: 'Synchronize only the exact retained lifecycle publication, then rerun the phase gates.' };
  }
  if (!recovery.pendingPublication && !recovery.publicationRecovery
      && phase.status === 'in_progress' && observation.inspection.correction?.sameTurn === true
      && observation.inspection.ownership?.proven === true
      && observation.inspection.correction.class === 'agent-authoring'
      && observation.findings.length > 0
      && observation.findings.every(finding => AUTHOR_FINDING_CATEGORIES.has(finding.category))) {
    return { id: 'owned-producer-repair', mode: 'producer-handoff', pendingHash: null,
      skill: observation.inspection.correction.skill,
      detail: 'The bound producer repairs only the returned owned draft/source findings, then resumes this same attempt. No nested model is launched.' };
  }
  return null;
}
async function preview(current, dependencies) {
  const { root, config, workflow, phase, binding } = current;
  const journal = await readPhaseRepairJournal(root, binding);
  const observation = await dependencies.inspect(root, config, workflow, phase);
  const action = actionFor(observation, current);
  const maximum = Math.min(3, journal.maximum, phase.repairBudget?.maxAttempts ?? 3);
  const admission = journal.active ? { allowed: false, reason: 'resume-recorded-attempt' }
    : action ? repairLoopAdmission(journal.attempts, { actionId: action.id, conditionHash: observation.conditionHash }, { maximumAttempts: maximum })
      : { allowed: false, reason: observation.ready ? 'already-ready' : 'human-or-owner-route' };
  const core = { schemaVersion: 1, binding, policyHash: policyHash(current, observation), journalRevision: journal.revision,
    revisionHash: repairDigest(observation.recovery.revision), conditionHash: observation.conditionHash,
    draftFingerprint: observation.inspection.draftFingerprint ?? null,
    action, maximum, attempt: journal.consumed + 1 };
  return { status: journal.active ? 'resume-required' : observation.ready ? 'ready-for-next-check'
      : admission.allowed ? 'confirmation-required' : 'needs-human-or-owner',
    ...core, confirmation: repairDigest(core), admission, inspection: observation.inspection,
    resolution: observation.resolution, observation, journal,
    commands: { run: `singularity-flow appeal repair-run --phase ${phase.id} --confirm ${repairDigest(core)} --json`,
      resume: `singularity-flow appeal repair-resume --phase ${phase.id} --json` },
    testsRun: false, phaseAdvanced: false, autoAcceptRisk: false };
}
function publicPlan(plan) { const { observation, journal, ...data } = plan; return { ...data,
  consumed: journal.consumed, attemptsRemaining: Math.max(0, plan.maximum - journal.consumed) }; }
function unavailable(current, error, consumed) {
  return { status: 'needs-human-or-owner', binding: current.binding, journalChanged: true, consumed,
    reason: 'The repair outcome or next plan could not be inspected. No passing evidence was recorded.',
    code: error.code ?? 'PHASE_REPAIR_INSPECTION_UNAVAILABLE',
    command: `singularity-flow recover ${current.workflow.workItem.id} --phase ${current.phase.id} --json`, skill: '/sf-recover',
    testsRun: false, phaseAdvanced: false, autoAcceptRisk: false };
}
async function sealUnavailable(current, attempt, error) {
  const journal = await appendPhaseRepairEvent(current.root, current.binding, { type: 'rechecked', attempt: attempt.attempt,
    conditionHash: null, ready: false, outcome: 'inspection-unavailable', code: String(error.code ?? 'PHASE_REPAIR_INSPECTION_UNAVAILABLE').slice(0, 128) });
  return unavailable(current, error, journal.consumed);
}
async function finish(current, dependencies, attempt, { operationError = null, outcome = null } = {}) {
  let observed;
  try { observed = await dependencies.inspect(current.root, current.config, current.workflow, current.phase); }
  catch (error) {
    return sealUnavailable(current, attempt, error);
  }
  const result = outcome ?? (operationError ? 'operation-failed' : observed.ready ? 'ready'
    : observed.conditionHash === attempt.conditionHash ? 'unchanged-condition' : 'changed-condition');
  await appendPhaseRepairEvent(current.root, current.binding, { type: 'rechecked', attempt: attempt.attempt,
    conditionHash: observed.conditionHash, ready: result === 'ready', outcome: result,
    code: operationError ? String(operationError.code ?? 'PHASE_REPAIR_OPERATION_FAILED').slice(0, 128) : null });
  let plan;
  try { plan = await preview(current, dependencies); }
  catch (error) { return { ...unavailable(current, error, attempt.attempt), result }; }
  return { ...publicPlan(plan), status: result === 'ready' ? 'ready-for-next-check'
      : result === 'changed-condition' ? plan.status : 'needs-human-or-owner',
    result, journalChanged: true,
    reason: result === 'unchanged-condition' ? 'No relevant condition changed. Do not repeat this repair; use the returned human/owner route.'
      : result === 'operation-failed' ? 'The registered operation failed. Its attempt remains consumed; no blind retry or passing evidence was recorded.' : null };
}
async function finishRegisteredRepair(current, dependencies, attempt, operationError, executed) {
  const transport = { registeredOperationExecuted: true,
    transportOutcome: executed?.postconditionsMet === true ? 'verified' : 'not-verified' };
  let reloaded;
  try {
    reloaded = await context(current.root, current.workflow.workItem.id, current.phase.id, dependencies);
    if (dependencies.branch(current.root) !== current.workflow.workItem.branch) {
      fail('The checkout changed after the registered repair. Inspect the selected Story before continuing.', 'PHASE_REPAIR_BRANCH_MISMATCH');
    }
  } catch (error) {
    return { ...await sealUnavailable(current, attempt, error), ...transport };
  }
  if (repairDigest(reloaded.binding) !== repairDigest(current.binding)) {
    const journal = await appendPhaseRepairEvent(current.root, current.binding, { type: 'rechecked', attempt: attempt.attempt,
      conditionHash: null, ready: false, outcome: 'binding-changed', code: 'PHASE_REPAIR_BINDING_CHANGED' });
    return { ...unavailable(current, { code: 'PHASE_REPAIR_BINDING_CHANGED' }, journal.consumed),
      result: 'binding-changed', ...transport };
  }
  return { ...await finish(reloaded, dependencies, attempt, { operationError }), ...transport };
}

/** Overrides are installed runtime/test seams, never read from CLI arguments or repository files. */
export async function coordinatePhaseRepair({ root, workId = null, phaseId = null, action = 'plan', confirmation = null, modelEnabled = true } = {}, overrides = {}) {
  const dependencies = { ...runtime, ...overrides };
  const inspectWithOptions = dependencies.inspect;
  dependencies.inspect = (...args) => inspectWithOptions(...args, { modelEnabled });
  const initial = await context(root, workId, phaseId, dependencies);
  if (action === 'status') return phaseRepairLoopSummary(root, initial.workflow, initial.phase);
  if (action === 'plan') return publicPlan(await preview(initial, dependencies));
  if (!['run', 'resume'].includes(action)) fail('Unknown repair coordination action.', 'PHASE_REPAIR_ACTION_INVALID');
  return dependencies.lock(root, { kind: 'story', id: initial.workflow.workItem.id }, async () => {
    const current = await context(root, initial.workflow.workItem.id, initial.phase.id, dependencies);
    if (dependencies.branch(root) !== current.workflow.workItem.branch) fail('Resume the selected Story checkout before repairing it.', 'PHASE_REPAIR_BRANCH_MISMATCH');
    let plan;
    try { plan = await preview(current, dependencies); }
    catch (error) {
      if (action !== 'resume') throw error;
      const journal = await readPhaseRepairJournal(root, current.binding);
      if (!journal.active) throw error;
      return { ...await sealUnavailable(current, journal.active, error), resumed: true };
    }
    if (action === 'resume') {
      const active = plan.journal.active;
      if (!active) return { ...publicPlan(plan), journalChanged: false, resumed: false };
      if (active.policyHash !== policyHash(current, plan.observation)) return finish(current, dependencies, active, { outcome: 'binding-changed' });
      // A crashed transport retry has an unknown outcome. Inspect first. Replay is permitted only
      // for the same idempotent retained publication, same private reservation and exact revision.
      if (active.actionId === 'sync-retained-publication' && plan.action?.id === active.actionId
          && plan.action.pendingHash === active.pendingHash && plan.revisionHash === active.revisionHash) {
        let error = null;
        let executed;
        try { executed = await dependencies.sync(root, current.config, current.workflow, plan.observation.recovery); }
        catch (failure) { error = failure; }
        return { ...await finishRegisteredRepair(current, dependencies, active, error, executed), resumed: true };
      }
      return { ...await finish(current, dependencies, active,
        active.actionId === 'sync-retained-publication' && plan.observation.recovery.pendingPublication
          ? { outcome: 'binding-changed' } : {}), resumed: true };
    }
    if (confirmation !== plan.confirmation) fail('Review the current exact repair plan and confirm its digest. Source, policy, journal or repository state moved.', 'PHASE_REPAIR_PLAN_STALE', { plan: publicPlan(plan) });
    if (!plan.admission.allowed) fail('A new repair cannot start. Resume the recorded attempt or follow the named human/owner route; its budget was not reset.', 'PHASE_REPAIR_ADMISSION_REFUSED', { plan: publicPlan(plan) });
    const journal = await appendPhaseRepairEvent(root, current.binding, { type: 'reserved', attempt: plan.attempt,
      maximum: plan.maximum, actionId: plan.action.id, conditionHash: plan.conditionHash,
      confirmation: plan.confirmation, policyHash: plan.policyHash, revisionHash: plan.revisionHash, pendingHash: plan.action.pendingHash });
    await overrides.afterReservation?.();
    if (plan.action.id === 'owned-producer-repair') return { ...publicPlan(plan), status: 'awaiting-producer-repair',
      consumed: journal.consumed, attemptsRemaining: Math.max(0, plan.maximum - journal.consumed), journalChanged: true,
      next: plan.commands.resume, skill: plan.action.skill, modelInvocations: 0,
      guidance: 'Repair the returned owned findings with the bound producer, then repair-resume. Do not reserve another attempt, launch a nested model, publish, submit or approve.' };
    let error = null; let executed;
    try { executed = await dependencies.sync(root, current.config, current.workflow, plan.observation.recovery); }
    catch (failure) { error = failure; }
    await overrides.afterAction?.();
    return finishRegisteredRepair(current, dependencies, journal.active, error, executed);
  });
}
