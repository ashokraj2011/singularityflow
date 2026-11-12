/** Ordered continuation rules. Observations describe trusted host facts, never command strings. */
import { phaseNeedsGeneration, isConvergencePhase, effectivePhasePublicationProducer,
  nextPhaseGeneration, workflowGuidePlan, sourceReviewContinuationPlan, sourceReviewRequired,
  phaseAuthoringPlan, phaseRequiresCodeDelivery } from './phase-policy.mjs';
import { nextPhaseAfterSkillAmendment } from './lifecycle-transitions.mjs';
import { decisionAfter, decisionValues, decisionOutcomeFacts, reopenableSteps } from './workflow-decisions.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';

/** A host may observe conditions, but cannot inject actions or commands into this manifest. */
export function workflowNextManifest(workflow, observations) {
  const invalid = () => { throw new SingularityFlowError('The next-step observation has an invalid shape.', { code: 'ENGINE_INPUT_INVALID' }); };
  if (!workflow || !Array.isArray(workflow.phaseOrder) || !workflow.phaseOrder.length || workflow.phaseOrder.length > 4096
      || new Set(workflow.phaseOrder).size !== workflow.phaseOrder.length
      || workflow.phaseOrder.some(id => typeof id !== 'string' || !workflow.phases?.[id] || workflow.phases[id].id !== id)
      || workflow.currentPhase != null && !workflow.phaseOrder.includes(workflow.currentPhase)
      || typeof workflow.status !== 'string') invalid();
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) invalid();
  const booleans = ['publicationPending', 'recoveryRequired', 'modelEnabled', 'manualPullRequest', 'stepActionHold',
    'authoringPreparesPhase', 'decisionHold', 'sheetPresent', 'sheetRoute', 'sheetApproves', 'visualPublished'];
  const counts = ['approvalHoldCount', 'visualRouteCount', 'mcpActionCount'];
  const other = ['recoveryPhase', 'mcpPhase', 'applicability', 'prerequisites', 'sourceReviewEvidence', 'authoringState'];
  if (Object.keys(observations).some(key => ![...booleans, ...counts, ...other].includes(key))) invalid();
  if (typeof observations.modelEnabled !== 'boolean') invalid();
  for (const key of booleans) if (observations[key] !== undefined && typeof observations[key] !== 'boolean') invalid();
  for (const key of counts) if (observations[key] !== undefined
      && (!Number.isSafeInteger(observations[key]) || observations[key] < 0 || observations[key] > 4096)) invalid();
  for (const key of ['recoveryPhase', 'mcpPhase']) if (observations[key] != null && typeof observations[key] !== 'string') invalid();
  const array = (value, allowed, check) => {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 4096) invalid();
    for (const entry of value) if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !allowed.includes(key)) || !check(entry)) invalid();
  };
  array(observations.prerequisites, ['timing', 'preparesPhase'], entry =>
    [null, 'now', 'then', 'optional', 'alternative', 'blocked'].includes(entry.timing)
      && typeof entry.preparesPhase === 'boolean');
  array(observations.applicability, ['responsibility', 'authority'], entry =>
    typeof entry.responsibility === 'string' && (entry.authority == null || typeof entry.authority === 'string'));
  const review = observations.sourceReviewEvidence;
  if (review != null) {
    if (typeof review !== 'object' || Array.isArray(review) || Object.keys(review).some(key => !['status', 'findings', 'pendingDispositions'].includes(key))
        || review.status != null && typeof review.status !== 'string') invalid();
    array(review.findings, ['code'], entry => entry.code == null || typeof entry.code === 'string');
    array(review.pendingDispositions, ['id'], entry => typeof entry.id === 'string');
  }
  const author = observations.authoringState;
  if (author != null && (typeof author !== 'object' || Array.isArray(author)
      || Object.keys(author).some(key => !['available', 'stage', 'generation'].includes(key)) || typeof author.available !== 'boolean'
      || author.stage != null && typeof author.stage !== 'string'
      || author.generation != null && (!Number.isSafeInteger(author.generation) || author.generation < 0))) invalid();
  return { schemaVersion: 1, contract: 'sflow-next-steps/v1', workId: workflow.workItem.id,
    phaseId: workflow.currentPhase ?? null, state: observations.publicationPending ? 'publication_pending'
      : observations.recoveryRequired ? 'recovery_required' : workflow.status,
    actions: workflowNextPlan(workflow, observations), authorityGranted: false, finalBindingChecked: false,
    automaticAdvance: false, approvalRecorded: false };
}

function upcoming(workflow, phase) {
  const decision = phase ? decisionAfter(workflow, phase.id) : null;
  if (!decision) return null;
  let outcome = null;
  if (decision.mode === 'auto' && decisionValues(workflow, phase, decision)) {
    try { outcome = decisionOutcomeFacts(workflow, phase); } catch { outcome = null; }
  }
  return { decision, outcome };
}

/** Planning grants no authority and makes no promise that a later action is currently executable. */
export function workflowNextPlan(workflow, observations = {}) {
  const phase = workflow.currentPhase ? workflow.phases[workflow.currentPhase] : null;
  const workId = workflow.workItem.id;
  const node = (kind, timing = 'now', fields = {}) => ({ kind, workId, phaseId: phase?.id ?? null, timing, ...fields });
  const cancel = () => node('cancel-story', 'alternative', { requires: ['explicit-reason', 'story-confirmation'] });
  const completion = timing => {
    const policy = workflow.lineage?.branchCompletionPolicy ?? workflow.source?.branchCompletionPolicy ?? 'pr';
    const landing = policy === 'direct' ? [
      ...((workflow.lineage?.finalizations ?? []).length ? [] : [node('finalize-story', 'then')]),
      ...((workflow.lineage?.childBranches ?? []).length ? [node('promote-story', 'then')] : [])
    ] : [node('preview-pull-request', 'then'),
      node(observations.manualPullRequest ? 'copy-review-description' : 'create-pull-request', 'then',
        { requires: ['reviewed-preview', 'explicit-human-choice'] })];
    return [node('terminal-check', timing), ...landing, node('story-progress', 'alternative'), node('story-report', 'alternative')];
  };
  const after = withoutApproval => {
    const ahead = upcoming(workflow, phase);
    if (ahead) {
      const { decision, outcome } = ahead;
      if (!outcome || outcome.kind === 'pause') return [node('inspect-routing', 'then',
        { purpose: 'after-completion', decisionId: decision.id, personal: decision.mode === 'ask' || outcome?.kind === 'pause', withoutApproval })];
      if (outcome.kind === 'end' || !outcome.target) return completion('then');
      return [node('prepare-following-phase', 'then', { targetPhase: outcome.target, decisionId: decision.id, outcome, withoutApproval })];
    }
    const target = nextPhaseAfterSkillAmendment(workflow, phase);
    return target ? [node('prepare-following-phase', 'then', { targetPhase: target.id, withoutApproval })] : completion('then');
  };
  const heldActions = actions => {
    if (!observations.decisionHold) return actions;
    const blocked = entry => entry.kind === 'approve-phase'
      || ['none', 'policy'].includes(phase.approvalPolicy?.mode) && entry.kind === 'submit-phase';
    const index = actions.findIndex(blocked);
    return index < 0 ? actions : [...actions.slice(0, index), node('pending-decisions', actions[index].timing,
      { requires: ['recorded-owner-decisions'] }), ...actions.slice(index + 1).filter(entry => !blocked(entry))];
  };
  const observedActions = (kind, count, timing, fields = {}) => Array.from({ length: count }, (_, index) =>
    node(kind, index ? 'alternative' : timing, { index, ...fields }));
  if (observations.publicationPending) return [node('retry-publication'), node('recalculate-next', 'then')];
  if (observations.recoveryRequired) return [node('inspect-recovery', 'now', { targetPhase: observations.recoveryPhase ?? null })];
  if (!phase) return workflow.status === 'cancelled'
    ? [node('list-archived-documents'), node('story-report', 'alternative', { purpose: 'archived' })] : completion('now');
  const pending = workflow.pendingDecision;
  if (pending) return [node('inspect-routing', 'now', { purpose: 'pending' }),
    ...pending.options.map((option, index) => node('choose-workflow-route', index ? 'alternative' : 'then',
      { optionId: option.id, expected: pending.key, requires: ['authorized-human', 'explicit-reason', 'unchanged-question'] })),
    ...reopenableSteps(workflow, pending).slice(0, 1).map(targetPhase => node('reopen-routing-phase', 'alternative',
      { targetPhase, expected: pending.key, requires: ['authorized-human', 'explicit-reason', 'unchanged-question'] })), cancel()];

  const endsHere = phase.status === 'in_progress'
    && ((workflow.phaseOrder ?? []).at(-1) === phase.id || upcoming(workflow, phase)?.outcome?.kind === 'end');
  const submitsEnd = endsHere && !phaseNeedsGeneration(workflow, phase);
  const applicability = timing => (observations.applicability ?? []).map((entry, index) =>
    node('decide-applicability', timing, { index, responsibility: entry.responsibility, authority: entry.authority,
      requires: ['authorized-human', 'explicit-reason'] }));
  const undecided = phase.status === 'awaiting_approval' || submitsEnd ? applicability('now') : [];
  const laterApplicability = endsHere && !submitsEnd ? applicability('then') : [];
  const guide = workflowGuidePlan(workflow, { sourceReviewEvidence: observations.sourceReviewEvidence ?? null,
    authoringState: observations.authoringState ?? null });
  let immediate = guide.actions.map((entry, index) => ({ ...entry, origin: 'guide',
    timing: entry.optional ? 'alternative' : undecided.length ? index ? 'alternative' : 'then'
      : phase.status === 'awaiting_approval' && index > 0 ? 'alternative' : 'now' }));
  if (phase.status === 'awaiting_approval') {
    const actions = [...undecided, ...immediate, ...after(false)];
    const index = actions.findIndex(entry => entry.kind === 'approve-phase');
    const replace = replacement => index < 0 ? actions
      : [...actions.slice(0, index), ...replacement, ...actions.slice(index + 1).filter(entry => entry.kind !== 'approve-phase')];
    if (observations.sheetPresent) return observations.sheetRoute && !observations.sheetApproves
      ? replace([node('step-sheet', index < 0 ? 'now' : actions[index].timing)]) : actions;
    if (observations.decisionHold) return heldActions(actions);
    return observations.approvalHoldCount
      ? replace(observedActions('approval-hold', Math.min(3, observations.approvalHoldCount), index < 0 ? 'now' : actions[index].timing)) : actions;
  }

  // An earlier delivery, MCP setup or published visual gate precedes this phase's own work.
  let external = null;
  if (observations.stepActionHold && phase.status === 'in_progress') external = [node('step-action-hold')];
  else if (observations.mcpActionCount && phase.status === 'in_progress' && observations.mcpPhase === phase.id) {
    external = Array.from({ length: observations.mcpActionCount }, (_, index) => node('mcp-readiness', index ? 'then' : 'now', { index }));
  } else if (observations.visualRouteCount && observations.visualPublished && phase.status === 'in_progress') {
    external = observedActions('visual-coverage', Math.min(3, observations.visualRouteCount), 'now');
  }
  if (external) {
    // Preserve the original recursion: outer host-only gates are absent from the resumed branch.
    const rest = workflowNextPlan(workflow, { ...observations, stepActionHold: false, mcpActionCount: 0,
      visualRouteCount: 0, approvalHoldCount: 0, sheetPresent: false });
    return [...external, ...rest.map(entry => entry.timing === 'now' ? { ...entry, timing: 'then' } : entry)];
  }

  const needsGeneration = phaseNeedsGeneration(workflow, phase) || Boolean(observations.sourceReviewEvidence
    && sourceReviewContinuationPlan(workflow, phase, observations.sourceReviewEvidence).classification === 'successor-publication-required');
  const modelEnabled = observations.modelEnabled !== false;
  const producer = effectivePhasePublicationProducer(phase, { modelEnabled });
  const modelFreeProducer = effectivePhasePublicationProducer(phase, { modelEnabled: false });
  const convergence = isConvergencePhase(phase) && producer === 'deterministic';
  if(needsGeneration&&convergence&&observations.authoringState?.stage==='review-convergence')immediate=[node('inspect-convergence-context','now')];
  else if (needsGeneration && convergence) immediate = immediate.map(entry => ['prepare-phase', 'prepare-convergence'].includes(entry.kind)
    ? node('prepare-deterministic-convergence', entry.timing, { modelEnabled }) : entry);
  const actions = [...(observations.prerequisites ?? []).map((entry, index) => node('prerequisite', entry.timing ?? null, { index,
    ...(entry.preparesPhase ? { preparesPhase: true } : {}) })), ...undecided, ...immediate];
  if (!needsGeneration && workflow.resolution?.applicationReview && workflow.resolution.applicationReview.mode !== 'off'
      && phaseRequiresCodeDelivery(phase)) actions.push(node('review-application', 'alternative'));
  if (needsGeneration && !modelEnabled) {
    if (modelFreeProducer === 'human') actions.push(node('publish-phase', 'then', { producer: 'human', modelEnabled: false }),
      node('import-phase', 'alternative', { producer: 'human', modelEnabled: false, requires: ['authored-file'] }));
    else if (modelFreeProducer === 'deterministic') {
      if (!convergence) actions.push(node('publish-phase', 'then', { producer: 'deterministic', modelEnabled: false }));
    } else actions.unshift(node('model-required', 'blocked'));
  } else if (needsGeneration && !convergence) actions.push(node('publish-phase', 'then', { producer: 'configured', modelEnabled }));

  const resolved = workflow.resolution?.phases?.find(entry => entry.id === phase.id);
  const prepareStage = entry => entry.origin === 'guide' && (['prepare-phase', 'prepare-convergence'].includes(entry.kind)
    || entry.kind === 'resume-phase-authoring' && (observations.authoringPreparesPhase
      ?? ['complete-draft', 'create-missing-draft', 'resume-draft'].includes(entry.stage ?? phaseAuthoringPlan(workflow, phase)?.stage)));
  const preparesHere = actions.some(entry => entry.timing === 'now'
    && (entry.preparesPhase || entry.kind === 'prepare-deterministic-convergence' || prepareStage(entry)));
  if (needsGeneration && !preparesHere && workflow.resolution?.inputsMode === 'enforce' && resolved?.inputs?.length
      && phase.inputContext?.generation !== nextPhaseGeneration(phase)) actions.unshift(node('resolve-phase-inputs'));
  if (needsGeneration && convergence) return [...actions, cancel()];
  if (needsGeneration && observations.visualRouteCount && !observations.visualPublished) {
    const index = actions.findIndex(entry => ['publish-phase', 'import-phase', 'model-required'].includes(entry.kind));
    actions.splice(index < 0 ? actions.length : index, 0,
      ...observedActions('visual-coverage', Math.min(3, observations.visualRouteCount), 'then'));
  }
  actions.push(...laterApplicability);
  const noApproval = phase.approvalPolicy?.mode === 'none';
  if (needsGeneration) actions.push(isConvergencePhase(phase) ? node('advance-convergence', 'then', { purpose: 'after-publication' })
    : sourceReviewRequired(workflow, phase.id) ? node('review-published-source', 'then', { purpose: 'after-publication' })
      : node('submit-phase', 'then', { purpose: 'after-publication', withoutApproval: noApproval }));
  if (!noApproval) actions.push(node('approve-phase', 'then', { purpose: 'after-submission', requires: ['authorized-human', 'reviewed-packet'] }));
  actions.push(cancel(), ...after(noApproval));
  return heldActions(actions);
}
