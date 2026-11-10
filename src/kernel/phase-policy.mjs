/** Pure phase interpretation, generation and publication policy. No storage, execution or host dependencies. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { phasePublicationBindingValue } from '../foundation/record-schema.mjs';
import {normalizeSourceBoundary} from './configuration-declarations.mjs';
import { phaseCorrectionTargets } from './approval-fallback.mjs';

const CODE_DELIVERY_ARTIFACT_KINDS = new Set(['implementation-summary']);

/** Recorded counts only. No execution, freshness, quorum or acceptance is implied. */
export function recordedEvidenceSummary(workflow) {
  const phases = (workflow.phaseOrder ?? []).map(id => workflow.phases?.[id]).filter(Boolean);
  const artifacts = phases.flatMap(phase => phase.artifacts ?? []);
  const checks = phases.flatMap(phase => phase.checks ?? []);
  const approvals = phases.flatMap(phase => phase.approvals ?? []).filter(entry => !entry.invalidatedAt);
  return {
    artifacts: { recorded: artifacts.filter(entry => entry.sha256 || entry.recordedAt || entry.status === 'recorded').length, total: artifacts.length },
    checks: { passed: checks.filter(entry => ['passed', 'pass'].includes(entry.status)).length,
      failed: checks.filter(entry => ['failed', 'blocked', 'fail'].includes(entry.status)).length, total: checks.length },
    approvals: { approved: approvals.filter(entry => entry.decision === 'approved').length, total: approvals.length }
  };
}

/** Ordinary status is a diagnostic record read, including incomplete legacy records. */
export function storyStatusSelection(context, inputs) {
  const workflow = context?.workflow, rawId = workflow?.workItem?.id;
  // Native subject indexing canonicalizes legacy scalar IDs while its diagnostic display stays raw.
  const id = ['string', 'number', 'boolean'].includes(typeof rawId) ? String(rawId).trim() : null;
  if (context?.subject?.kind !== 'story' || typeof id !== 'string' || !id || context.subject.id !== id) {
    throw new SingularityFlowError('The status port did not bind a Story.', { code: 'ENGINE_PORT_RESULT_INVALID' });
  }
  if (inputs.workId != null && inputs.workId !== id) throw new SingularityFlowError(
    'Requested Story does not match the status record.', { code: 'ACTIVE_SUBJECT_MISMATCH',
      details: { expectedWorkId: inputs.workId, actualWorkId: id } });
  const diagnostics = [], phases = [], observed = Object.create(null), seen = new Set();
  const order = Array.isArray(workflow.phaseOrder) ? workflow.phaseOrder : [];
  if (!Array.isArray(workflow.phaseOrder)) diagnostics.push({ code: 'status.phase-order.unavailable' });
  for (const phaseId of order) {
    if (typeof phaseId !== 'string' || !phaseId || seen.has(phaseId)) {
      diagnostics.push({ code: 'status.phase-order.invalid' }); continue;
    }
    seen.add(phaseId);
    const phase = Object.hasOwn(workflow.phases ?? {}, phaseId) ? workflow.phases[phaseId] : null;
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
      diagnostics.push({ code: 'status.phase.unavailable', phase: phaseId });
      phases.push({ id: phaseId, status: null, generation: null }); continue;
    }
    const safe = {};
    for (const field of ['artifacts', 'checks', 'approvals']) {
      const entries = Array.isArray(phase[field]) ? phase[field] : [];
      safe[field] = entries.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
      if (!Array.isArray(phase[field]) || safe[field].length !== entries.length) {
        diagnostics.push({ code: 'status.evidence.incomplete', phase: phaseId, field });
      }
    }
    Object.defineProperty(observed, phaseId, { value: safe, enumerable: true });
    phases.push({ id: phaseId, status: typeof phase.status === 'string' ? phase.status : null,
      generation: Number.isSafeInteger(phase.generation) && phase.generation >= 0 ? phase.generation : null });
  }
  const currentPhase = typeof workflow.currentPhase === 'string' ? workflow.currentPhase : null;
  if (currentPhase != null && !seen.has(currentPhase)) diagnostics.push({ code: 'status.current-phase.unlisted', phase: currentPhase });
  return { workId: id, source: context.source, status: typeof workflow.status === 'string' ? workflow.status : null,
    currentPhase, phases, evidence: recordedEvidenceSummary({ phaseOrder: phases.map(phase => phase.id), phases: observed }),
    inventoryComplete: diagnostics.length === 0, diagnostics };
}

/** No retained local publication marker is not proof that a remote accepted a transition. */
export function storyStatusManifest(binding, facts) {
  const bad = () => { throw new SingularityFlowError('The status port returned invalid or differently bound facts.', { code: 'ENGINE_PORT_RESULT_INVALID' }); };
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
  const source = binding.source, publication = facts?.publication;
  if (!exact(source, ['kind', 'revision']) || !['working-tree', 'ref', 'namespace-snapshot'].includes(source.kind)
    || source.revision !== null && (typeof source.revision !== 'string' || !source.revision)
    || source.kind !== 'working-tree' && source.revision === null
    || !exact(facts, ['workId', 'source', 'publication']) || facts.workId !== binding.workId
    || !exact(facts.source, ['kind', 'revision']) || facts.source.kind !== source.kind || facts.source.revision !== source.revision
    || !exact(publication, ['state', 'commit', 'error']) || !['pending', 'unreadable', 'not-retained'].includes(publication.state)
    || publication.commit !== null && (typeof publication.commit !== 'string' || !publication.commit)
    || publication.state !== 'pending' && publication.commit !== null
    || publication.state === 'unreadable' && (!publication.error || typeof publication.error.message !== 'string' || !publication.error.message)
    || publication.state !== 'unreadable' && publication.error !== null) bad();
  return { schemaVersion: 1, contract: 'sflow-story-status/v1', ...binding, publication,
    authorityVerified: false, finalBindingChecked: false, acceptanceChecked: false };
}

/** Latest approved intent change whose contributor acknowledgement is still owed. */
export function pendingIntentAmendmentAcknowledgement(workflow) {
  return [...(workflow?.intentAmendments ?? [])].reverse()
    .find(entry => entry.status === 'approved' && !entry.acknowledgedAt) ?? null;
}

/** Rework and reviewed amendments reopen a phase without relabelling its old publication. */
export function phaseExplicitlyReopened(workflow, phase) {
  return (workflow?.changeRequests ?? []).some(request => request.status === 'open' && request.targetPhase === phase?.id)
    || Boolean(phase?.reworkRevalidation && phaseNeedsGeneration(workflow, phase))
    || Boolean(phase?.skillAmendmentRevalidation?.state === 'affected' && phaseNeedsGeneration(workflow, phase))
    || Boolean(phase?.intentAmendmentRevalidation && !phase.intentAmendmentRevalidation.revalidatedAt);
}

function continuationAction(workflow, phase, kind, fields = {}) {
  return { kind, workId: workflow.workItem.id, phaseId: phase?.id ?? null, ...fields };
}

/** Guidance prerequisites describe obligations; they do not authenticate or authorize execution. */
export function phaseGovernancePlan(workflow, phase) {
  if (!phase) return null;
  const action = (kind, fields) => continuationAction(workflow, phase, kind, fields);
  const amendment = pendingIntentAmendmentAcknowledgement(workflow);
  if (amendment) return { code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED',
    classification: 'amendment-acknowledgement-required', amendmentId: amendment.id,
    actions: [action('acknowledge-intent-amendment', { amendmentId: amendment.id, requires: ['explicit-human-choice'] })] };
  if (!sourceReviewAuthorConflict(workflow, phase)) return null;
  return { code: 'SOURCE_REVIEW_AUTHOR_COLLISION', classification: 'source-review-author-conflict',
    generation: phase.generation, generatedAgent: phase.generatedAgent,
    actions: [
      ...(phase.defaultAgent ? [action('select-phase-author', { agentId: phase.defaultAgent })] : []),
      ...(phase.status === 'awaiting_approval' ? [action('return-phase', { purpose: 'reviewer-authored-generation',
        targetPhase: phase.id, requires: ['authorized-human', 'explicit-reason'] })] : []),
      ...(phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed'
        ? [action('review-code-successor', { purpose: 'reviewer-authored-generation', requires: ['reviewed-draft-digest'] })] : []),
      action('prepare-phase', { purpose: 'reviewer-authored-generation' })
    ] };
}

/** Exact retained Convergence publication shape, independent of source-control or command syntax. */
export function convergenceTransitionPlan(workflow, phase, { needsGeneration = false } = {}) {
  if (!isConvergencePhase(phase) || phase.status !== 'in_progress') return null;
  const action = kind => continuationAction(workflow, phase, kind);
  if (needsGeneration) return { classification: 'generation-required', lifecycleReady: false,
    reasonCode: 'PHASE_GENERATION_REQUIRED', actions: [action('prepare-convergence')] };
  const publications = (phase.generationPublications ?? []).filter(entry => Number(entry?.generation) === phase.generation);
  const publication = publications.length === 1 ? publications[0] : null;
  const relative = publication?.record?.path;
  const recorded = typeof relative === 'string' && relative.length <= 4096
    && !relative.includes('\\') && !relative.startsWith('/') && !/^[A-Za-z]:/u.test(relative)
    && relative.split('/').every(segment => segment && segment !== '.' && segment !== '..')
    && /^sha256:[a-f0-9]{64}$/u.test(publication?.record?.sha256 ?? '');
  if (!recorded) return { classification: 'publication-record-missing', lifecycleReady: false,
    reasonCode: 'PHASE_PUBLICATION_RECORD_MISSING', actions: [action('recover-publication-record')] };
  return { classification: 'convergence-advance-required', lifecycleReady: true,
    reasonCode: 'CONVERGENCE_ADVANCE_REQUIRED', actions: [{ ...action('advance-convergence'), requires: ['reviewed-result-digest', 'explicit-human-choice'] }] };
}

/** Structural authoring milestones contain no model instruction or executable command. */
export function phaseAuthoringPlan(workflow, phase, { draftEvidence = null } = {}) {
  if (!phase || phase.status !== 'in_progress' || workflow.currentPhase !== phase.id
      || !phaseNeedsGeneration(workflow, phase) || phaseUsesDeterministicGeneration(phase)) return null;
  const code = phaseRequiresCodeDelivery(phase), generation = nextPhaseGeneration(phase);
  const open = code && phase.generationIntent?.status === 'open' && Number(phase.generationIntent.generation) === generation;
  let stage;
  if (code && phase.generationIntent?.status === 'consumed' && !consumedByPublishedGeneration(phase)) stage = 'review-successor';
  else if (code && !open) stage = 'open-code-generation';
  else if (draftEvidence?.draftExists && draftEvidence.draftModified) stage = 'validate-existing-draft';
  else stage = draftEvidence?.draftExists ? 'complete-draft' : draftEvidence ? 'create-missing-draft' : 'resume-draft';
  return { stage, generation, codeGenerationOpen: open, code,
    draft: draftEvidence ?? { draftExists: null, draftModified: null } };
}

/** A retained independent review never grants authoring, submission or approval authority. */
export function sourceReviewContinuationPlan(workflow, phase, review = null) {
  const hold = phaseGovernancePlan(workflow, phase);
  const action = (kind, fields) => continuationAction(workflow, phase, kind, fields);
  let classification, actions, generation = Number(phase.generation ?? 0);
  if (hold) { classification = hold.classification; actions = hold.actions; }
  else if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress') {
    classification = 'lifecycle-review-required'; actions = [action('inspect-lifecycle')];
  } else if (phaseNeedsGeneration(workflow, phase) || (review?.status === 'correction-required'
      && (review.findings ?? []).some(finding => finding.code !== 'human-disposition-required'))) {
    classification = 'successor-publication-required'; generation = nextPhaseGeneration(phase);
    actions = phaseRequiresCodeDelivery(phase) && phase.generationIntent?.status === 'consumed' && !phaseExplicitlyReopened(workflow, phase)
      ? [action('review-code-successor', { purpose: 'source-review-correction', requires: ['reviewed-draft-digest'] })]
      : [action('prepare-phase', { purpose: 'source-review-correction', targetGeneration: generation,
        sourceReviewRequired: sourceReviewRequired(workflow, phase.id) })];
  } else if (review?.pendingDispositions?.length) {
    classification = 'human-disposition-required';
    actions = [action('decide-source-review-finding', { findingId: review.pendingDispositions[0].id,
      requires: ['authorized-human', 'explicit-reason'] })];
  } else if (review?.status === 'ready') {
    classification = 'submission-required'; actions = [action('submit-phase', { purpose: 'reviewed-source' })];
  } else { classification = 'source-review-required'; actions = [action('review-published-source')]; }
  return { classification, publishedGeneration: Number(phase.generation ?? 0), targetGeneration: generation,
    automaticAdvance: false, actions };
}

/** Handoff order is policy; host adapters add the wording and their command surfaces. */
export function phaseHandoffPlan(workflow, phase, {
  hasDocuments = phase.generation > 0 && Boolean(phase.requiredArtifact?.path), sourceReviewEvidence = null
} = {}) {
  const hold = phaseGovernancePlan(workflow, phase);
  if (hold) return { classification: hold.classification, actions: hold.actions };
  const view = hasDocuments ? [continuationAction(workflow, phase, 'view-phase-documents', { optional: true })] : [];
  const transition = convergenceTransitionPlan(workflow, phase, { needsGeneration: phaseNeedsGeneration(workflow, phase) });
  if (transition) return { classification: transition.classification, actions: [
    ...transition.actions.map(action => ({...action,transition:{classification:transition.classification,
      lifecycleReady:transition.lifecycleReady,reasonCode:transition.reasonCode}})), ...view] };
  if (workflow.currentPhase === phase.id && phase.status === 'in_progress'
      && (phaseNeedsGeneration(workflow, phase) || sourceReviewEvidence)) {
    const review = sourceReviewContinuationPlan(workflow, phase, sourceReviewEvidence);
    return { classification: review.classification, actions: [...review.actions, ...view] };
  }
  return { classification: sourceReviewRequired(workflow, phase.id) ? 'source-review-status-required' : 'submission-required',
    actions: [
      ...(sourceReviewRequired(workflow, phase.id) ? [continuationAction(workflow, phase, 'check-source-review-status')] : []),
      continuationAction(workflow, phase, 'submit-phase', { purpose: 'published-generation', approvalRequired: phase.approvalPolicy?.mode !== 'none' }),
      ...view
    ] };
}

/** Every guide route is chosen here; supplied progress is a read observation, not permission. */
export function workflowGuidePlan(workflow, { sourceReviewEvidence = null, authoringState = null } = {}) {
  const phase = workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
  const action = (kind, fields) => continuationAction(workflow, phase, kind, fields);
  let classification, actions;
  if (workflow.status === 'cancelled') { classification = 'archived'; actions = [action('view-archived-documents')]; }
  else {
    const hold = phaseGovernancePlan(workflow, phase), pending = workflow.pendingDecision;
    if (hold) { classification = hold.classification; actions = hold.actions; }
    else if (pending) { classification = 'workflow-decision-required'; actions = [
      action('inspect-workflow-decision', { label: pending.label }),
      ...pending.options.map(option => action('choose-workflow-route', { label: pending.label, optionId: option.id,
        optionLabel: option.label, expected: pending.key, requires: ['authorized-human', 'explicit-reason'] }))
    ]; }
    else if (!phase) { classification = 'workflow-inspection'; actions = [action('inspect-workflow-progress')]; }
    else if (phase.status === 'awaiting_approval') { classification = 'approval-required'; actions = [
      action('approve-phase', { requires: ['authorized-human', 'reviewed-submission-binding'] }),
      ...(phaseCorrectionTargets(phase).length ? [action('return-phase', { purpose: 'phase-correction', targetPhase: phase.id,
        requires: ['authorized-human', 'explicit-reason'] })] : [])
    ]; }
    else if (phaseNeedsGeneration(workflow, phase)) {
      const progress = authoringState ?? (phase.generationIntent ? phaseAuthoringPlan(workflow, phase) : null);
      if (progress && progress.available !== false) {
        classification = 'authoring-continuation'; actions = [action('resume-phase-authoring', { stage: progress.stage, generation: progress.generation })];
      } else { classification = 'generation-required'; actions = [action('prepare-phase', { purpose: 'required-generation',
        regenerate: phase.generation > 0, deterministicConvergence: isConvergencePhase(phase) && phaseUsesDeterministicGeneration(phase) })]; }
    } else ({ classification, actions } = phaseHandoffPlan(workflow, phase, { sourceReviewEvidence }));
  }
  if (intentAmendmentSource(workflow)) actions = [...actions, action('propose-intent-amendment', { optional: true,
    requires: ['amended-source', 'explicit-reason', 'scope-authority-review'] })];
  return { schemaVersion: 1, contract: 'sflow-workflow-continuation/v1', workId: workflow.workItem.id,
    phaseId: phase?.id ?? null, classification, actions, authorityGranted: false, finalBindingChecked: false,
    automaticAdvance: false, approvalRecorded: false };
}

export function generationTask(phase) {
  return phase?.generationPolicy?.task ?? phase?.generation?.task ?? null;
}

/** Explicit tasks take precedence over the installed legacy code-artifact contract. */
export function phaseRequiresCodeDelivery(phase) {
  if (!phase) return false;
  const task = generationTask(phase);
  if (task != null) return task === 'code';
  return CODE_DELIVERY_ARTIFACT_KINDS.has(artifactKindOf(phase));
}

/** Deterministic-only generation in Story state, a resolved definition or raw configuration. */
export function deterministicOnlyGeneration(phase) {
  const policy = phase?.generationPolicy
    ?? (phase?.generation && typeof phase.generation === 'object' ? phase.generation : null);
  if (!policy) return false;
  if (Array.isArray(policy.allowedProducers) && policy.allowedProducers.length) {
    return policy.allowedProducers.length === 1 && policy.allowedProducers[0] === 'deterministic';
  }
  return policy.producer === 'deterministic' || policy.defaultProducer === 'deterministic';
}

/** A deterministic summary for a code phase is not completed application authoring. */
export function phaseKernelOwned(phase) {
  const deterministic = phase?.generationPolicy ? phaseUsesDeterministicGeneration(phase) : deterministicOnlyGeneration(phase);
  return Boolean(deterministic) && !phaseRequiresCodeDelivery(phase);
}

/**
 * One predicate for guidance, the submit gate and `review-source`: the step is listed by the
 * pinned policy and still defines the scope or plans the claims. An older pin listing a step that
 * no longer does would otherwise get review routes that refuse and a submit gate that never clears.
 */
export function sourceReviewRequired(workflow, phaseId) {
  const policy = workflow?.resolution?.sourceReview;
  return policy?.mode === 'enforce' && Array.isArray(policy.phases)
    && policy.phases.includes(phaseId) && sourceReviewKind(workflow, phaseId) != null;
}

/** A generation authored by its required reviewer needs an honestly attributed successor. */
export function sourceReviewAuthorConflict(workflow, phase) {
  return Boolean(phase?.generation > 0 && sourceReviewRequired(workflow, phase.id)
    && phase.generatedAgent === workflow.resolution.sourceReview.reviewerAgent);
}

export function phaseNeedsGeneration(workflow, phase) {
  if (sourceReviewAuthorConflict(workflow, phase)) return true;
  // A reviewed skill-version amendment invalidates only its affected phases. Their earlier
  // publication remains in the audit trail but is not fresh evidence under the new WFA pin.
  const amendment = phase?.skillAmendmentRevalidation;
  if (amendment?.state === 'affected') {
    const baseline = amendment.generationAtAdoption;
    if (!Number.isSafeInteger(baseline) || baseline < 0
        || !Number.isSafeInteger(phase.generation) || phase.generation <= baseline) return true;
  }
  if (phase?.generationPolicy?.requirement === 'none') return false;
  if (!phase || phase.generation < 1) return true;
  if (phase.reworkRevalidation
      && phase.generation <= phase.reworkRevalidation.generation) return true;
  // A retained immutable publication is causal evidence of a successor generation. Its logical
  // generation supersedes rework even when an application's clock is coarse or moves backward.
  // Legacy unbound records keep their original timestamp-based compatibility rule below.
  if (phase.reworkRevalidation && phase.generation > phase.reworkRevalidation.generation
      && hasPublishedPhaseGeneration(phase) && Array.isArray(phase.publicationBindings)
      && phase.publicationBindings.some(binding => phasePublicationBindingValue(binding).generation === phase.generation)) return false;
  if (!phase.rejectedAt) return false;
  return !(workflow.history ?? []).some((event) =>
    event.phase === phase.id && event.event === 'phase_generated' && event.at > phase.rejectedAt);
}

export function hasPublishedPhaseGeneration(phase) {
  const generation = Number(phase?.generation);
  if (!Number.isSafeInteger(generation) || generation < 1 || phase.generationIntent?.status === 'open') return false;
  return (phase.generationIntent?.status === 'consumed' && Number(phase.generationIntent.generation) === generation)
    || (phase.generationPublications ?? []).some(entry => Number(entry.generation) === generation && entry.record?.path)
    || (phase.publicationBindings ?? []).some(entry => phasePublicationBindingValue(entry).generation === generation);
}

export function requiresProspectivePhaseInspection(workflow, phase) {
  return phase.status === 'in_progress'
    && (!hasPublishedPhaseGeneration(phase) || phaseNeedsGeneration(workflow, phase));
}

export function phaseInspectionGeneration(workflow, phase) {
  return requiresProspectivePhaseInspection(workflow, phase)
    ? nextPhaseGeneration(phase) : Number(phase.generation ?? 0);
}

/** Capture the local generation boundary before an asynchronous native admission/write. */
export function phaseBeginSelection(workflow,inputs) {
  const id=inputs.phaseId??workflow?.currentPhase;
  const phase=id!=null&&Object.hasOwn(workflow?.phases??{},id)?workflow.phases[id]:null;
  if(!phase)throw new SingularityFlowError(`Unknown or unavailable phase '${id??''}'. Provide a phase ID.`);
  if(inputs.workId!=null&&inputs.workId!==workflow.workItem.id)throw new SingularityFlowError(
    'Requested Story does not match the generation checkout.',{code:'ACTIVE_SUBJECT_MISMATCH',
      details:{expectedWorkId:inputs.workId,actualWorkId:workflow.workItem.id}});
  const existing=phase.generationIntent;
  const namespaced=existing?.profile==='sflow-namespace-generation-intent/v1';
  return {workId:workflow.workItem.id,phase:phase.id,generation:nextPhaseGeneration(phase),
    retained:existing?.status==='open'&&Number(existing.generation)===nextPhaseGeneration(phase),
    existing:existing?namespaced?{profile:existing.profile,id:existing.id??null,sha256:existing.receiptSha256??null,baselineRevision:existing.baselineRevision??null}
      :{id:existing.id??null,sha256:existing.receiptSha256??null,baselineCommit:existing.baseline?.commit??null}:null};
}

/** Local receipts expose logical provenance; native staging paths and actor presentation stay private. */
export function phaseBeginResult(binding,facts) {
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=4096;
  const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===allowed.length&&Object.keys(value).every(key=>allowed.includes(key));
  const namespaced=facts?.intent?.profile==='sflow-namespace-generation-intent/v1',
    fields=namespaced?['profile','id','sha256','baselineRevision','status']:['id','sha256','baselineCommit','status'],
    identity=namespaced?['profile','id','sha256','baselineRevision']:['id','sha256','baselineCommit'];
  if(!keys(facts,['workId','phase','generation','intent'])||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||facts.generation!==binding.generation||!keys(facts.intent,fields)
    ||!text(facts.intent.id)||!/^sha256:[a-f0-9]{64}$/u.test(facts.intent.sha256??'')
    ||!text(facts.intent[namespaced?'baselineRevision':'baselineCommit'])||facts.intent.status!=='open'
    ||binding.retained&&identity.some(key=>facts.intent[key]!==binding.existing[key])) {
    throw new SingularityFlowError('The generation port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return facts.intent;
}

/** A rollover selects a successor without yet authorizing adoption of its current bytes. */
export function phaseRolloverSelection(workflow,inputs) {
  const {workId,phase,generation}=phaseBeginSelection(workflow,inputs);
  return {workId,phase,generation,fromGeneration:Number(workflow.phases[phase].generation??0)};
}

export function phaseRolloverPlan(binding,facts) {
  const fields=['workId','phase','fromGeneration','toGeneration','confirmation','changeSetDigest','currentResultDigest'];
  const digest=value=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/u.test(value);
  if(!facts||typeof facts!=='object'||Array.isArray(facts)||Object.keys(facts).length!==fields.length
    ||Object.keys(facts).some(key=>!fields.includes(key))||facts.workId!==binding.workId||facts.phase!==binding.phase
    ||facts.fromGeneration!==binding.fromGeneration||facts.toGeneration!==binding.generation
    ||!digest(facts.confirmation)||!digest(facts.currentResultDigest)
    ||facts.changeSetDigest!==null&&!digest(facts.changeSetDigest)
    ||facts.confirmation!==(facts.changeSetDigest??facts.currentResultDigest)) {
    throw new SingularityFlowError('The rollover port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});
  }
  return {schemaVersion:1,contract:'sflow-generation-rollover-plan/v1',...facts,
    finalBindingChecked:false,mutationAuthorityGranted:false,approvalRecorded:false};
}

/** Confirming a local successor never constitutes phase or human-evidence approval. */
export function assertPhaseRolloverConfirmation(plan,confirm) {
  if(confirm&&confirm!==plan.confirmation)throw new SingularityFlowError(
    `Generation rollover confirmation must equal the current digest ${plan.confirmation}. Re-run the preview if files are still changing.`,
    {code:'GENERATION_ROLLOVER_STALE',details:plan});
}

/** Terminal-capable read hosts require an explicit historical target, never an invented phase. */
export function assertHistoricalReviewPhase(workflow,requested) {
  if(workflow.currentPhase!==null||requested!=null)return;
  const workId=workflow.workItem.id,phases=Object.keys(workflow.phases);
  throw new SingularityFlowError('This Story has no active phase. Select a retained phase to review.',{
    code:'ENGINE_PHASE_SELECTION_REQUIRED',details:{workId,status:workflow.status,phases,
      actions:phases.map(phaseId=>({operation:'phase.review',inputs:{workId,phaseId}}))}});
}

/** Historical review is allowed; phase authoring admission is a separate operation. */
export function phaseReviewSelection(workflow, requested=null) {
  const id=requested??workflow.currentPhase;
  const phase=id!=null&&Object.hasOwn(workflow.phases??{},id)?workflow.phases[id]:null;
  if(!phase)throw new SingularityFlowError(`Unknown or unavailable phase '${id??''}'. Provide a phase ID.`);
  return {workId:workflow.workItem.id,phase:phase.id,generation:Number(phase.generation??0),status:phase.status,
    current:phase.id===workflow.currentPhase,
    retained:[...(phase.artifacts??[]).filter(item=>item.path).map(item=>({sourceKey:item.path,role:'artifact',
      sha256:item.sha256??null,bytes:item.size??null})),...phaseReviewBriefRecords(workflow,phase).filter(brief=>brief.renderedPath)
      .map(brief=>({sourceKey:brief.renderedPath,role:'agent-brief',sha256:brief.renderedSha256??null,bytes:null}))]};
}

/** The immutable submitted brief list takes precedence over mutable phase projections. */
export function phaseReviewBriefRecords(workflow,phase) {
  const generation=Number(phase?.generation??0);
  if(!phase?.id||generation<1)return [];
  const submitted=[...(workflow.lineage?.submissions??[])].reverse()
    .find(entry=>entry.phase===phase.id&&entry.generation===generation);
  return Array.isArray(submitted?.projection?.agentBriefs)?submitted.projection.agentBriefs
    :(phase.agentBriefs??[]).filter(brief=>brief.generation===generation);
}

/** A read plan contains retained references and byte-verification facts, never model instructions. */
export function phaseReviewManifest(binding,facts) {
  const bad=()=>{throw new SingularityFlowError('The phase review port returned invalid or differently bound facts.',{code:'ENGINE_PORT_RESULT_INVALID'});};
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=512;
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  const bytes=value=>Number.isSafeInteger(value)&&value>=0;
  if(!facts||Object.keys(facts).some(key=>!['workId','phase','generation','status','revision','budgets','documents','reviewBinding'].includes(key))
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation||facts.status!==binding.status
    ||!text(facts.revision)||!facts.budgets||Object.keys(facts.budgets).length!==3
    ||!['previewBytes','sourcePreviewBytes','sourceFullBytes'].every(key=>bytes(facts.budgets[key]))||!Array.isArray(facts.documents))bad();
  const identity=item=>JSON.stringify([item.role,item.sourceKey]);
  const ids=new Set(),references=new Set(),members=new Set();
  const retained=new Map(binding.retained.map(item=>[identity(item),item]));
  if(retained.size!==binding.retained.length)bad();
  const items=facts.documents.map(document=>{
    if(!document||Object.keys(document).some(key=>!['id','reference','sourceKey','role','kind','mimeType','generation','primary','expected','observed','error'].includes(key))
      ||!text(document.id)||ids.has(document.id)||!text(document.reference)||references.has(document.reference)
      ||!text(document.sourceKey)||members.has(identity(document))
      ||!['artifact','agent-brief'].includes(document.role)||!text(document.kind)||!text(document.mimeType)
      ||document.generation!==binding.generation||typeof document.primary!=='boolean'
      ||document.expected!==null&&(!document.expected||Object.keys(document.expected).length!==2
        ||!digest(document.expected.sha256)||document.expected.bytes!==null&&!bytes(document.expected.bytes)))bad();
    ids.add(document.id);references.add(document.reference);
    members.add(identity(document));
    const bound=retained.get(identity(document));
    if(bound?.sha256?document.expected?.sha256!==bound.sha256||document.expected?.bytes!==bound.bytes:document.expected!==null)bad();
    const observed=document.observed;
    if(observed!==null&&(!observed||Object.keys(observed).length!==3||!digest(observed.sha256)||!bytes(observed.bytes)
      ||typeof observed.binary!=='boolean'))bad();
    if(document.error!==null&&(!document.error||typeof document.error!=='object'||Array.isArray(document.error)
      ||typeof document.error.message!=='string'||!document.error.message))bad();
    if((observed===null)!==(document.error!==null))bad();
    const integrity=document.error?'unavailable':!document.expected?'unbound'
      :observed.sha256===document.expected.sha256&&(document.expected.bytes===null||observed.bytes===document.expected.bytes)?'matched':'changed';
    return {id:document.id,reference:{kind:'phase-document',id:document.reference,workId:binding.workId,phase:binding.phase,
      generation:binding.generation},role:document.role,kind:document.kind,mimeType:document.mimeType,primary:document.primary,
      expected:document.expected,observed,integrity,error:document.error};
  }).sort((left,right)=>Number(right.primary)-Number(left.primary)
    ||(left.role===right.role?0:left.role==='artifact'?-1:1)||(left.id<right.id?-1:left.id>right.id?1:0))
    .map((item,index)=>({order:index+1,...item}));
  if([...retained.keys()].some(key=>!members.has(key)))bad();
  const candidate=facts.reviewBinding;
  if(candidate!==null&&(!candidate||Object.keys(candidate).some(key=>!['workId','phase','generation','packetSha256','sourceRevision','observedRevision'].includes(key))
    ||candidate.workId!==binding.workId||candidate.phase!==binding.phase||candidate.generation!==binding.generation
    ||!digest(candidate.packetSha256)||!text(candidate.sourceRevision)||!text(candidate.observedRevision)
    ||!binding.current||binding.generation<1||binding.status!=='awaiting_approval'))bad();
  const integrity=items.some(item=>item.integrity==='unavailable')?'unavailable':items.some(item=>item.integrity==='changed')?'changed'
    :!items.length||items.some(item=>item.integrity==='unbound')?'unbound':'matched';
  return {schemaVersion:1,contract:'sflow-phase-review-manifest/v1',purpose:'phase-review',
    workId:binding.workId,phase:binding.phase,generation:binding.generation,phaseStatus:binding.status,
    observedRevision:facts.revision,budgets:facts.budgets,integrity,items,
    reviewBinding:integrity==='matched'?candidate:null,humanReviewRecorded:false,approvalRecorded:false};
}

/** Exact shared resource references for a retained review; no paths, prose or human decisions. */
export function phaseReviewResourcesManifest(binding,facts) {
  const bad=()=>{throw new SingularityFlowError('The review resources port returned another retained review.',{code:'ENGINE_PORT_RESULT_INVALID'});};
  const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=2048;
  const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  if(!exact(facts,['workId','phase','generation','revision','submission','resources','reviewBinding'])
    ||facts.workId!==binding.workId||facts.phase!==binding.phase||facts.generation!==binding.generation||!text(facts.revision)
    ||!exact(facts.submission,['packetSha256','sourceRevision'])||!digest(facts.submission.packetSha256)||!text(facts.submission.sourceRevision)
    ||!Array.isArray(facts.resources)||!facts.resources.length)bad();
  const ids=new Set(),references=new Set();
  for(const item of facts.resources) {
    if(!exact(item,['id','reference','phase','generation','kind','mimeType','expected'])||!text(item.id)||ids.has(item.id)
      ||!text(item.phase)||!Number.isSafeInteger(item.generation)||item.generation<1||!text(item.kind)||!text(item.mimeType)
      ||!exact(item.expected,['sha256','bytes'])||!digest(item.expected.sha256)||!Number.isSafeInteger(item.expected.bytes)||item.expected.bytes<0)bad();
    const ref=item.reference;
    if(ref?.kind==='story-document') {
      if(!exact(ref,['kind','id','workId'])||ref.id!==item.id||ref.workId!==binding.workId)bad();
    }else if(ref?.kind==='phase-document') {
      if(!exact(ref,['kind','id','workId','phase','generation'])||!text(ref.id)||ref.workId!==binding.workId||ref.phase!==item.phase||ref.generation!==item.generation)bad();
    }else bad();
    const key=JSON.stringify(ref);if(references.has(key))bad();ids.add(item.id);references.add(key);
  }
  const primary=facts.resources[0];
  if(primary.kind!=='review-packet'||primary.phase!==binding.phase||primary.generation!==binding.generation
    ||primary.expected.sha256!==facts.submission.packetSha256||primary.expected.bytes<1)bad();
  const review=facts.reviewBinding;
  if(review!==null&&(!exact(review,['workId','phase','generation','packetSha256','sourceRevision','observedRevision'])
    ||review.workId!==binding.workId||review.phase!==binding.phase||review.generation!==binding.generation
    ||review.packetSha256!==facts.submission.packetSha256||review.sourceRevision!==facts.submission.sourceRevision
    ||review.observedRevision!==facts.revision||!binding.current||binding.status!=='awaiting_approval'))bad();
  return {schemaVersion:1,contract:'sflow-phase-review-resources/v1',purpose:'phase-review-resources',workId:binding.workId,phase:binding.phase,
    generation:binding.generation,observedRevision:facts.revision,submission:facts.submission,resources:facts.resources,
    reviewBinding:review,humanReviewRecorded:false,approvalRecorded:false};
}

/**
 * What a workflow step is for, read from its structure and never from its name [E2G-001].
 *
 * A step's id is the author's word for it, and a renamed copy of a step must be governed exactly
 * like the original. Every rule that used to ask "is this the step called convergence?" asks one of
 * these questions instead, so renaming a step changes nothing about how it is governed and naming a
 * step after a packaged one confers nothing.
 *
 * Pure and import-free: it reads Story state (`requiredArtifact`), a resolved definition or raw
 * configuration (`artifact`) alike, so the engine, Workflow Studio and simulation agree.
 */

/** The artifact kind of the engine's convergence report: the step a person reviews to advance. */
export const CONVERGENCE_ARTIFACT_KIND = 'convergence-report';

/** The artifact kind of a conformance report: the final account of every clause against the code. */
export const CONFORMANCE_ARTIFACT_KIND = 'conformance-report';

/** The artifact kind of visual verification evidence: screens checked against declared profiles. */
export const VISUAL_EVIDENCE_ARTIFACT_KIND = 'visual-test-evidence';

const TEST_EVIDENCE_KINDS = new Set(['test-evidence', VISUAL_EVIDENCE_ARTIFACT_KIND]);
// Read-side interpretation, installed only after the accepted closure has been verified. It is
// deliberately not serialized into a Story, copied into a pin, or read from caller-provided flags.
const acceptedKinds = new WeakMap();
const acceptedResponsibilities = new WeakMap();

/** Internal boundary used by the verified execution-catalog reader. */
export function bindAcceptedPhaseInterpretation(workflow, kinds, responsibilities) {
  for (const [id, kind] of Object.entries(kinds)) {
    if (workflow.phases?.[id]) acceptedKinds.set(workflow.phases[id], kind);
  }
  acceptedResponsibilities.set(workflow, responsibilities);
}

function interpretedKind(phase) {
  return phase && acceptedKinds.has(phase) ? acceptedKinds.get(phase) : artifactKindOf(phase);
}

/** The kind of a step's required artifact, from Story state, a resolved definition or configuration. */
export function artifactKindOf(phase) {
  return phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
}

/**
 * The convergence step: the engine reconciles the specification, the plan, the code and its tests
 * into one report, and only an explicit human advancement and approval move the Story past it.
 */
export function isConvergencePhase(phase) {
  return interpretedKind(phase) === CONVERGENCE_ARTIFACT_KIND;
}

/** A Story's convergence step: the active one when it is a convergence step, otherwise the first. */
export function convergencePhaseOf(workflow) {
  const current = workflow?.phases?.[workflow?.currentPhase];
  if (isConvergencePhase(current)) return current;
  for (const id of workflow?.phaseOrder ?? []) {
    if (isConvergencePhase(workflow.phases?.[id])) return workflow.phases[id];
  }
  return null;
}

/** The responsibilities one step of a Story holds, as the obligation graph pinned at its start says. */
export function stepResponsibilities(workflow, phaseId) {
  return acceptedResponsibilities.get(workflow)?.[phaseId]
    ?? workflow?.resolution?.obligationGraph?.nodes?.find((node) => node.id === phaseId)?.responsibilities ?? [];
}

/** Scope guidance follows verified responsibilities, with the same explicit legacy fallback. */
export function phaseOwnsScope(workflow, phase) {
  if (stepResponsibilities(workflow, phase?.id).includes('scope')) return true;
  return !workflow?.resolution?.obligationGraph
    && phase?.kind !== 'skill' && phase?.skillBinding == null
    && ['requirements', 'implementation-spec'].includes(artifactKindOf(phase));
}

/** The latest step before `phaseId` in the Story's order that passes `test`, or null. */
export function latestStepBefore(workflow, phaseId, test) {
  const order = workflow?.phaseOrder ?? [];
  const end = order.indexOf(phaseId);
  for (let index = (end < 0 ? order.length : end) - 1; index >= 0; index -= 1) {
    const phase = workflow.phases?.[order[index]];
    if (phase && test(phase)) return phase;
  }
  return null;
}

/**
 * What a source review of a step checks: a step that defines the scope is reviewed as a
 * specification, one that plans the claims as a plan, and any other step has no source review.
 */
export function reviewKindForResponsibilities(responsibilities = []) {
  if (responsibilities.includes('scope')) return 'specification';
  if (responsibilities.includes('plan')) return 'planning';
  return null;
}

/** The source-review kind of one step of a Story, from its pinned responsibilities. */
export function sourceReviewKind(workflow, phaseId) {
  return workflow?.phases?.[phaseId] ? reviewKindForResponsibilities(stepResponsibilities(workflow, phaseId)) : null;
}

/** The id of the step that defines a Story's scope: the first step that holds it, whatever it is called. */
function scopeStepIdOf(workflow) {
  return (workflow?.phaseOrder ?? []).find((id) => stepResponsibilities(workflow, id).includes('scope')) ?? null;
}

/** The step that defines a Story's scope. */
export function scopeStepOf(workflow) {
  const id = scopeStepIdOf(workflow);
  return id ? workflow.phases?.[id] ?? null : null;
}

/**
 * Any active step may propose a reviewed amendment to its approved scope. This is a kernel
 * capability, not a work-type opt-in: no convergence finding or configured rework loop is needed.
 * Before scope approval, edit/review its draft instead; closed or cancelled Stories must use their
 * ordinary reopen route. A proposal never approves itself or silently changes pinned policy.
 */
export function intentAmendmentSource(workflow, phaseId = workflow?.currentPhase) {
  const scope = scopeStepOf(workflow);
  const phase = workflow?.phases?.[phaseId];
  const order = workflow?.phaseOrder ?? [];
  return Boolean(scope && phase && phaseId === workflow.currentPhase
    && !['completed', 'complete', 'cancelled', 'archived'].includes(workflow.status)
    && scope.status === 'approved' && Number(scope.generation) >= 1
    && ['in_progress', 'awaiting_approval'].includes(phase.status)
    && order.indexOf(phaseId) > order.indexOf(scope.id)
    && order.includes(scope.id));
}

/** A step whose output is a conformance report, whatever it is called. */
export function isConformancePhase(phase) {
  return interpretedKind(phase) === CONFORMANCE_ARTIFACT_KIND;
}

/** Every conformance step of a Story, in order. */
export function conformancePhasesOf(workflow) {
  return (workflow?.phaseOrder ?? []).map((id) => workflow.phases?.[id]).filter(isConformancePhase);
}

/** A Story's final conformance step: the last one in order. */
export function conformancePhaseOf(workflow) {
  return conformancePhasesOf(workflow).filter((phase) => phase.status !== 'skipped').at(-1) ?? null;
}

/** A step that verifies screens against declared profiles, whatever it is called. */
export function isVisualVerificationPhase(phase) {
  return interpretedKind(phase) === VISUAL_EVIDENCE_ARTIFACT_KIND;
}

/** A Story's visual verification step, or null. */
export function visualVerificationPhaseOf(workflow, phaseId = workflow?.currentPhase) {
  if (phaseId && isVisualVerificationPhase(workflow.phases?.[phaseId])) return workflow.phases[phaseId];
  const phases = (workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {}))
    .map((id) => workflow.phases?.[id]).filter((phase) => isVisualVerificationPhase(phase) && phase.status !== 'skipped');
  // Older pins may have multiple stages. Never silently borrow one stage's evidence for another.
  return phases.length === 1 ? phases[0] : null;
}

/** A step whose output is test evidence, the record that the change was verified. */
export function isTestEvidencePhase(phase) {
  return TEST_EVIDENCE_KINDS.has(interpretedKind(phase));
}

/** Pure publication authorship rules shared by the SDK and legacy host compatibility APIs. */

export const AUTHORSHIP_PRODUCERS = Object.freeze([
  'human', 'governed-agent', 'deterministic', 'external-tool', 'legacy-unspecified'
]);

export const AUTHORSHIP_CHANNELS = Object.freeze([
  'manual-in-place', 'manual-import', 'copilot-host', 'kernel-model', 'kernel-generator', 'external-tool', 'legacy'
]);

export const CHANGE_ORIGINS = Object.freeze([
  'human', 'copilot', 'mixed', 'formatter', 'compiler', 'migration-tool',
  'test-generator', 'code-generator', 'external-tool'
]);

const CHANNELS_BY_PRODUCER = Object.freeze({
  human: new Set(['manual-in-place', 'manual-import']),
  'governed-agent': new Set(['copilot-host', 'kernel-model']),
  deterministic: new Set(['kernel-generator']),
  'external-tool': new Set(['external-tool']),
  'legacy-unspecified': new Set(['legacy'])
});

function defaultChannel(producer, imported) {
  if (producer === 'human') return imported ? 'manual-import' : 'manual-in-place';
  if (producer === 'governed-agent') return 'copilot-host';
  if (producer === 'deterministic') return 'kernel-generator';
  if (producer === 'external-tool') return 'external-tool';
  return 'legacy';
}

function configuredPublicationProducer(phase) {
  const policy = phase?.generationPolicy;
  const legacy = policy?.producer;
  return policy?.defaultProducer
    ?? (legacy === 'agent' ? 'governed-agent' : legacy === 'manual' ? 'human' : legacy)
    ?? 'governed-agent';
}

export function allowedPublicationProducers(phase) {
  const policy = phase?.generationPolicy;
  if (policy?.allowedProducers?.length) return policy.allowedProducers;
  // Historical Story snapshots stored only the legacy `producer` field. Match the configuration
  // normalizer exactly so an upgraded in-flight `producer: agent` phase retains its long-standing
  // governed-agent *and* human routes instead of silently losing manual recovery.
  if (policy?.producer === 'manual') return ['human'];
  if (policy?.producer === 'deterministic') return ['deterministic'];
  if (policy?.producer === 'agent') return ['governed-agent', 'human'];
  if (policy?.defaultProducer === 'governed-agent') return ['governed-agent', 'human'];
  if (policy?.defaultProducer) return [configuredPublicationProducer(phase)];
  return ['governed-agent', 'human'];
}

/** The exact producer/channel pair pinned by a phase's generation contract. */
export function phasePublicationAuthorship(phase, { producer = null, imported = false } = {}) {
  const selected = producer ?? configuredPublicationProducer(phase);
  assertProducerAllowed(phase, selected);
  return Object.freeze({ producer: selected, channel: defaultChannel(selected, imported) });
}

export function phaseUsesDeterministicGeneration(phase) {
  return phasePublicationAuthorship(phase).producer === 'deterministic';
}

/** One producer resolver for next, nextsteps, fast-path, prompts, and publication guidance. */
export function effectivePhasePublicationProducer(phase, {
  modelEnabled = true, requestedProducer = null
} = {}) {
  if (isConvergencePhase(phase)) {
    const allowed = allowedPublicationProducers(phase);
    if (allowed.length !== 1 || allowed[0] !== 'deterministic') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' is a convergence phase and must permit only deterministic authorship because its artifact is a kernel-owned projection.`,
        { code: 'CONVERGENCE_GENERATION_POLICY_INVALID' }
      );
    }
    if (requestedProducer != null && requestedProducer !== 'deterministic') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' is a convergence phase and records deterministic authorship only; human and model review decisions are separate records.`,
        { code: 'CONVERGENCE_AUTHORSHIP_INVALID' }
      );
    }
    return 'deterministic';
  }
  if (requestedProducer != null) return phasePublicationAuthorship(phase, { producer: requestedProducer }).producer;
  const configured = configuredPublicationProducer(phase);
  if (modelEnabled !== false) return phasePublicationAuthorship(phase, { producer: configured }).producer;
  const allowed = allowedPublicationProducers(phase);
  // The convergence artifact remains a deterministic kernel projection even when an optional
  // assisted pass supplied candidates. Prefer it over a manual/external fallback in no-model mode.
  if (['human', 'deterministic', 'external-tool'].includes(configured)) return configured;
  const fallback = allowed.find((producer) => ['human', 'deterministic', 'external-tool'].includes(producer));
  return fallback ?? configured;
}

/**
 * What an agent's own publication records: governed-agent wherever the phase permits it, in every
 * model mode. `--no-model` turns off the kernel's model, not the host's agent, so the manual
 * fallback above had Copilot publish its own draft as `--authored human` and skip the checks an
 * agent's draft gets: the clarification record and the agent's session (live reruns, 2026-11-01).
 * Null where the phase permits no agent authorship, which stays the person's to publish.
 */
export function agentPublicationProducer(phase) {
  if (isConvergencePhase(phase)) return null;
  return allowedPublicationProducers(phase).includes('governed-agent') ? 'governed-agent' : null;
}

function defaultChangeOrigins(producer) {
  if (producer === 'human') return ['human'];
  if (producer === 'governed-agent') return ['copilot'];
  if (producer === 'deterministic') return ['code-generator'];
  if (producer === 'external-tool') return ['external-tool'];
  return [];
}

export function normalizeAuthorshipOptions({
  producer, channel, imported = false, externalAiUse = null, changeOrigins = null
} = {}) {
  const normalizedProducer = producer ?? 'legacy-unspecified';
  if (!AUTHORSHIP_PRODUCERS.includes(normalizedProducer)) {
    throw new SingularityFlowError(`Unknown authorship producer '${normalizedProducer}'. Expected ${AUTHORSHIP_PRODUCERS.join(', ')}.`, { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  const normalizedChannel = channel ?? defaultChannel(normalizedProducer, imported);
  if (!AUTHORSHIP_CHANNELS.includes(normalizedChannel) || !CHANNELS_BY_PRODUCER[normalizedProducer].has(normalizedChannel)) {
    throw new SingularityFlowError(`Authorship channel '${normalizedChannel}' is incompatible with producer '${normalizedProducer}'.`, { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if (externalAiUse != null && !['none', 'assisted'].includes(externalAiUse)) {
    throw new SingularityFlowError('--external-ai must be none or assisted when supplied.');
  }
  const origins = [...new Set((changeOrigins ?? defaultChangeOrigins(normalizedProducer))
    .map((value) => String(value).trim()).filter(Boolean))];
  const unknownOrigins = origins.filter((value) => !CHANGE_ORIGINS.includes(value));
  if (unknownOrigins.length) {
    throw new SingularityFlowError(
      `Unknown change origin '${unknownOrigins[0]}'. Expected ${CHANGE_ORIGINS.join(', ')}.`,
      { code: 'MANUAL_AUTHORSHIP_REQUIRED' }
    );
  }
  return Object.freeze({
    producer: normalizedProducer, channel: normalizedChannel, externalAiUse,
    changeOrigins: Object.freeze(origins)
  });
}

export function assertProducerAllowed(phase, producer) {
  const allowed = allowedPublicationProducers(phase);
  if (isConvergencePhase(phase) && producer !== 'deterministic') {
    throw new SingularityFlowError(
      `Phase '${phase.id}' is a convergence phase and records deterministic authorship only; human and model review decisions are separate records.`,
      { code: 'CONVERGENCE_AUTHORSHIP_INVALID', details: { phase: phase.id, producer } }
    );
  }
  // Historical unspecified provenance remains readable for upgraded agent/manual phases. It must
  // never authorize a new deterministic-only publication, because that would also bypass the
  // exact deterministic convergence integrity path selected by the producer contract.
  const legacyCompatible = producer === 'legacy-unspecified'
    && configuredPublicationProducer(phase) !== 'deterministic';
  if (!allowed.includes(producer) && !legacyCompatible) {
    throw new SingularityFlowError(`Phase '${phase.id}' does not permit '${producer}' authorship. Allowed producers: ${allowed.join(', ')}.`, {
      code: 'MANUAL_ARTIFACT_INVALID', details: { phase: phase.id, producer, allowedProducers: allowed }
    });
  }
}

/** Pure selection, shared with the persistence API without importing that API. */
export function currentPhase(workflow) {
  if (!workflow.currentPhase) return null;
  const phase = workflow.phases[workflow.currentPhase];
  if (!phase) throw new SingularityFlowError(`Unknown current phase ${workflow.currentPhase}.`);
  return phase;
}

/**
 * Whether a consumed generation intent is simply the receipt of the step's current published
 * generation: the state a return for rework leaves. Any other consumed intent is reviewed through
 * recovery first.
 */
export function consumedByPublishedGeneration(phase) {
  const intent = phase?.generationIntent;
  return intent?.status === 'consumed' && Number(phase.generation) > 0
    && Number(intent.generation) === Number(phase.generation);
}

/**
 * A restored checkpoint selects earlier evidence; it does not make later publication identities
 * reusable. Keep the allocation watermark separate from the generation currently being reviewed.
 */
export function nextPhaseGeneration(phase) {
  const values = [phase?.generation, phase?.generationHighWatermark].map((value) => value === undefined ? 0 : value);
  const counters = values.map((value) => typeof value === 'string' && /^(0|[1-9]\d*)$/u.test(value)
    ? Number(value) : value);
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0)
      || Math.max(...counters) >= Number.MAX_SAFE_INTEGER) {
    throw new SingularityFlowError('Phase generation counters must be nonnegative safe integers with room for a new generation.', {
      code: 'GENERATION_COUNTER_INVALID'
    });
  }
  return Math.max(...counters) + 1;
}

export function buildGenerationAuthorship({
  options, actor, governedAgentContext, source, kernelInvocationIds = [], kernelInvocations = [], generation = null
}) {
  const kernelInvoked = kernelInvocationIds.length > 0;
  return Object.freeze({
    schemaVersion: 1,
    producer: options.producer,
    channel: options.channel,
    actor: structuredClone(actor),
    governedAgentContext: governedAgentContext == null
      ? null
      : typeof governedAgentContext === 'string'
        ? { agentId: governedAgentContext }
        : structuredClone(governedAgentContext),
    kernelModel: {
      invoked: kernelInvoked, status: 'exact', invocationIds: [...kernelInvocationIds],
      ...(kernelInvocations.length ? {
        observations: kernelInvocations.map((record) => ({
          invocationId: record.id,
          task: record.routing?.task ?? null,
          mappingRevision: record.routing?.mappingRevision ?? null,
          provider: record.provider ?? null,
          requestedModel: null,
          resolvedModel: record.routing?.resolvedModel ?? record.model ?? null,
          assurance: record.observationIntegrity !== 'external-host-attested'
            ? 'unavailable'
            : record.routing?.task ? 'policy-selected'
              : record.status === 'completed' && record.provider && record.model ? 'host-observed' : 'unavailable',
          observationIntegrity: record.observationIntegrity ?? 'unverified-local',
          host: 'singularity-flow-kernel',
          source: 'model-invocation-audit',
          observedAt: record.completedAt ?? record.startedAt ?? null,
          generation
        }))
      } : {})
    },
    externalAiUse: options.externalAiUse == null
      ? { value: 'unknown', status: 'unavailable' }
      : { value: options.externalAiUse, status: 'self-reported' },
    changeOrigins: [...(options.changeOrigins ?? [])],
    source: structuredClone(source),
    // SF Guard: the author's presence signature over this claim, or the exception that covers them.
    ...(options.presence ? { presence: structuredClone(options.presence) } : {})
  });
}

/**
 * Whether the Story may leave convergence `[SPK:REQ-183]`.
 *
 * Separated from the projection so the refusal can be raised at the transition rather than computed
 * into a document nobody reads at the moment of advancing.
 */
export function advancementBlocked(projection) {
  const reasons = [];
  if (!projection) return ['convergence has not been run for the current implementation generation'];
  for (const id of projection.unresolvedBlockers ?? []) {
    const finding = (projection.findings ?? []).find((entry) => entry.id === id);
    reasons.push(`${id} is dispositioned '${finding?.disposition ?? 'rework'}'${finding?.clauseIds?.length ? ` for ${finding.clauseIds.join(', ')}` : ''}`);
  }
  const disposed = new Set((projection.findings ?? []).map((finding) => finding.itemId));
  const undisposed = [...(projection.facts ?? []), ...(projection.candidates ?? [])].filter((item) => !disposed.has(item.id));
  if (undisposed.length) {
    reasons.push(`${undisposed.length} convergence item${undisposed.length === 1 ? ' has' : 's have'} no recorded human disposition: ${undisposed.slice(0, 5).map((item) => item.id).join(', ')}`);
  }
  return reasons;
}



export const PHASE_SEMANTICS_PROFILE = 'sflow-phase-semantics/v1';

export const ARA_PHASE_SEMANTICS_PROFILE = 'sflow-phase-semantics/ara-v1';


// Code-delivery and application-review phase facts; host offers and wording stay in adapters.

/** Which tests a Story's gates run, widest first [TCE:REQ-090]. */
export const TEST_SCOPES = Object.freeze(['all-configured', 'changed-and-affected', 'new-and-changed']);

/** The test scope a Story runs under now: its latest change, else what intake chose [TCE:REQ-090]. */
export function storyTestScope(workflow) {
  return workflow?.testScopeChanges?.at(-1)?.to ?? workflow?.resolution?.testExecutionMode ?? 'changed-and-affected';
}

/**
 * Project the code-generation contract of one resolved workflow.
 *
 * Callers must pass the result of `resolveWorkType`, not raw work-type phase ids: generation task
 * overrides and the legacy implementation-summary inference are resolved at the phase boundary.
 * Keeping this projection beside `phaseRequiresCodeDelivery` prevents CLI and editor surfaces from
 * inventing a second, phase-name-based definition of "generates code".
 */
export function workflowCodeGeneration(resolvedWorkflow) {
  const phases = Array.isArray(resolvedWorkflow) ? resolvedWorkflow : resolvedWorkflow?.phases;
  const codePhases = Array.isArray(phases)
    ? phases.filter((phase) => phaseRequiresCodeDelivery(phase)).map((phase) => phase.id)
    : [];
  return { generatesCode: codePhases.length > 0, codePhases };
}

/**
 * Deterministic convergence, read from Story state (`generationPolicy`), a resolved definition or raw
 * configuration, so Workflow Studio shows the same fixed route a Story uses.
 */
export function deterministicConvergence(phase) {
  if (!isConvergencePhase(phase)) return false;
  if (phase.generationPolicy) return phaseUsesDeterministicGeneration(phase);
  return deterministicOnlyGeneration(phase);
}

/**
 * The authoring skill a step names. In a Story it comes from the pinned resolution, which is hashed
 * and anchored to the Story's creation commit, never from the mutable step state; outside a Story
 * (a resolved workflow being validated, simulated or shown) it comes from the resolved step.
 */
export function configuredAuthoringSkill(phase, workflow = null) {
  if (workflow?.resolution) {
    const pinned = (workflow.resolution.phases ?? []).find((entry) => entry?.id === phase?.id);
    return typeof pinned?.authoringSkill === 'string' ? pinned.authoringSkill : null;
  }
  return typeof phase?.authoringSkill === 'string' ? phase.authoringSkill : null;
}

/** Later reporting phases inspect the latest delivered code, rather than starting a non-code review. */
export function applicationReviewPhase(workflow) {
  if (phaseRequiresCodeDelivery(workflow.phases?.[workflow.currentPhase])) return workflow.currentPhase;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const current = order.indexOf(workflow.currentPhase);
  return order.slice(0, current < 0 ? order.length : current).findLast(id => phaseRequiresCodeDelivery(workflow.phases?.[id])
    && workflow.phases[id].generation > 0) ?? workflow.currentPhase;
}

export function phaseTopologyFindings(resolved) {
  const phases = resolved?.phases ?? [];
  const findings = [];
  const add = (code, phase, message) => findings.push({ code, phaseId: phase.id, severity: 'error', message,
    resolvingAction: 'Edit the effective workflow in Configuration Center, then validate it before starting a Story.' });
  const convergence = phases.filter(isConvergencePhase);
  if (convergence.length > 1) add('WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED', convergence[1],
    'Only one Convergence step is supported: iteration storage must not be shared by separate review stages.');
  for (const phase of convergence) {
    if (!phases.slice(0, phases.indexOf(phase)).some(phaseRequiresCodeDelivery)) {
      add('WORKFLOW_CONVERGENCE_CODE_SOURCE_MISSING', phase, `Convergence '${phase.id}' needs an earlier code-delivery step and its reconciliation. Use an ordinary document review for a workflow that produces no code.`);
    }
  }
  const visual = phases.filter(isVisualVerificationPhase);
  if (visual.length > 1) add('WORKFLOW_VISUAL_MULTIPLE_UNSUPPORTED', visual[1],
    'Only one visual-evidence stage is supported by this workflow contract. Split stages into separate workflows until independent receipt namespaces are supported.');
  for (const phase of phases) {
    if ((isConvergencePhase(phase) || isConformancePhase(phase) || isVisualVerificationPhase(phase))
        && (phase.generationPolicy ?? phase.generation)?.requirement === 'none') {
      add('WORKFLOW_PROOF_OUTPUT_REQUIRED', phase,
        `Proof-producing step '${phase.id}' cannot be sign-off-only. Keep its report generation required; use an ordinary review step to review existing outputs.`);
    } else if ((phase.generationPolicy ?? phase.generation)?.requirement === 'none') {
      add('WORKFLOW_REVIEW_RECEIPT_UNSUPPORTED', phase,
        `Step '${phase.id}' declares no output generation, but this execution contract requires a publication receipt. Use a required deterministic or authored review artifact; a no-output review receipt is not supported yet.`);
    }
  }
  return findings;
}

export function workflowStartIssues(resolved) {
  const topology=phaseTopologyFindings(resolved);
  if(topology.length)return topology;
  if(resolved?.plannedClaims?.mode==='migration-required')return [{code:'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED',severity:'error',message:'The selected workflow has no current planned-claim contract.'}];
  return (resolved?.obligationGraph?.findings??[]).filter(entry=>entry.severity==='error');
}

export function pinnedTestEvidenceSource(workflow, phase) {
  return workflow.resolution?.phases?.find((entry) => entry.id === phase?.id)?.testEvidenceFrom ?? null;
}

/** The Code step whose tests a review relies on: its pinned source, else the closest approved one. */
export function reviewCodeSource(workflow, phase) {
  if (!phase || phaseRequiresCodeDelivery(phase)) return null;
  const pinned = pinnedTestEvidenceSource(workflow, phase);
  if (pinned) return workflow.phases?.[pinned] ?? null;
  const order = workflow.phaseOrder ?? [];
  return order.slice(0, Math.max(0, order.indexOf(phase.id))).reverse().map((id) => workflow.phases?.[id])
    .find((candidate) => candidate?.status === 'approved' && phaseRequiresCodeDelivery(candidate)) ?? null;
}

/** A review whose own approval policy may send its source or test edits back to this Code step. */
export function reviewMayReturnToCode(review, code) {
  return Boolean(review && code) && !phaseRequiresCodeDelivery(review) && phaseRequiresCodeDelivery(code)
    && (review.approvalPolicy?.rejectTo ?? []).includes(code.id);
}

/**
 * The approved Code step an in-progress review may hand its source or test edits back to through
 * the guarded `reject <review> --to <code> --repair` route, or null when no such return exists.
 */
export function reviewRepairTarget(workflow, phase) {
  const code = reviewCodeSource(workflow, phase);
  return code?.status === 'approved' && workflow.status !== 'closed'
    && workflow.currentPhase === phase.id && phase.status === 'in_progress'
    && reviewMayReturnToCode(phase, code) ? code : null;
}

/**
 * The open change request a person's rejection or reopen recorded when it returned this already
 * published code step for rework, from the step itself or a later one, or null. It must be the
 * newest open return into this step, its decision must still stand, and its reset must be the one
 * that reopened this exact generation, so an older or unrelated request never qualifies.
 */
export function reworkReturnRequest(workflow, phase) {
  const generation = Number(phase?.generation ?? 0);
  const evidence = phase?.deliveryEvidence;
  if (!(generation > 0) || !phase.generationCommit || evidence?.status !== 'ready' || !evidence.receiptSha256) return null;
  const request = [...(workflow.changeRequests ?? [])].reverse().find((candidate) =>
    candidate.status === 'open' && candidate.targetPhase === phase.id);
  const source = workflow.phases?.[request?.sourcePhase];
  const order = workflow.phaseOrder ?? [];
  // A decision's loop has no person's return to cite, and a confirmed repair keeps its own binding.
  if (!request || request.decision || request.testingRepair || !source || !order.includes(source.id)
      || order.indexOf(source.id) < order.indexOf(phase.id)) return null;
  const decided = (source.approvals ?? []).some((decision) => ['rejected', 'reopened'].includes(decision.decision)
    && !decision.invalidatedAt && decision.target === phase.id && decision.changeRequestId === request.id);
  const reset = phase.reworkRevalidation;
  return decided && Number(reset?.generation) === generation && reset.invalidatedAt === request.requestedAt
    ? request : null;
}

/**
 * The return to a step before this one that reset this published code step: an upstream issue's
 * return, or a rejection sent further back. What it corrects (the plan, the scope) may need no code
 * change, yet the next generation was refused as unchanged, so the Story could go on only with a
 * fake edit (2026-10-28). That generation carries the previous one's exact source and tests and runs
 * them again, as an intent revalidation does; whatever the corrected plan still owes is judged as for
 * any generation. Only the reset that reopened this exact generation qualifies.
 */
export function earlierReturnRequest(workflow, phase) {
  const generation = Number(phase?.generation ?? 0);
  const evidence = phase?.deliveryEvidence;
  const reset = phase?.reworkRevalidation;
  if (!(generation > 0) || !phase.generationCommit || evidence?.status !== 'ready' || !evidence.receiptSha256
      || Number(reset?.generation) !== generation) return null;
  const order = workflow.phaseOrder ?? [];
  const request = [...(workflow.changeRequests ?? [])].reverse().find((candidate) => candidate.requestedAt === reset.invalidatedAt) ?? null;
  if (!request || request.decision || request.testingRepair || order.indexOf(request.targetPhase) < 0
      || order.indexOf(request.targetPhase) >= order.indexOf(phase.id)) return null;
  return request;
}

/**
 * The source boundary a review may repair inside its own generations. Only a review that writes
 * source, confines itself to an explicit boundary and produces its own test evidence qualifies.
 * One that consumes another step's tests (testEvidenceFrom) or may write anywhere still needs a
 * Code generation to retest every source or test change.
 */
export function reviewOwnRepairBoundary(workflow, phase) {
  if (!phase || phaseRequiresCodeDelivery(phase)
      || (phase.writeScope ?? 'artifact-only') !== 'source-and-artifact'
      || pinnedTestEvidenceSource(workflow, phase)) return null;
  const boundary = normalizeSourceBoundary(phase.sourceBoundary, phase.id);
  return boundary === 'unrestricted' ? null : boundary;
}

/** Presentation-free recovery offer for a refused unchanged/test-only generation. */
export function codeDeliveryRepairRoute(workflow,phase,{unchanged,testOnly}) {
  const generation=Number(phase.generation??0);
  const request=[...(workflow.changeRequests??[])].reverse().find(candidate=>candidate.status==='open'&&candidate.targetPhase===phase.id)??null;
  if(unchanged&&generation>0&&request?.forwardCheckpoint&&!request.decision&&!request.testingRepair)
    return {kind:'withdraw-return',generation,changeRequestId:request.id,sourcePhase:request.sourcePhase};
  if(!testOnly)return null;
  if(generation===0)return {kind:'first-generation',owner:workflow.resolution?.plannedClaims?.owners?.[phase.id]??'<EARLIER>'};
  return {kind:'return-required',generation,changeRequestId:request?.id??null,
    reason:!request?'no-return':request.decision?'decision-loop':'not-reopened',decisionId:request?.decision?.id??null};
}
export function codeCandidateScopeRequired(workflow,phase) {
  return phaseRequiresCodeDelivery(phase)&&workflow?.resolution?.plannedClaims?.mode==='required';
}




/** Resolve responsibilities from the accepted workflow, never from a packaged phase name. */
export function plannedDeliveryCodeSteps(workflow, phase) {
  if (!phase) return [];
  const policy = workflow?.resolution?.plannedClaims;
  if (policy) return policy.mode === 'required' ? Object.entries(policy.owners ?? {})
    .filter(([codeId, ownerId]) => ownerId === phase.id && phaseRequiresCodeDelivery(workflow.phases?.[codeId]))
    .map(([codeId]) => codeId).sort() : [];
  const order = workflow?.phaseOrder ?? workflow?.resolution?.phases?.map(entry => entry.id)
    ?? Object.keys(workflow?.phases ?? {});
  const position = order.indexOf(phase.id);
  if (position < 0) return [];
  const next = order[position + 1];
  return phaseRequiresCodeDelivery(workflow?.phases?.[next]) ? [next] : [];
}
