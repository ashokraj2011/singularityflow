/** Pure aggregate transitions shared by native lifecycle writers, simulation and portable hosts.
 * These helpers grant no permission, verify no evidence and perform no I/O. The runtime
 * owner must finish its existing publication/reviewer/receipt checks before applying accepted
 * lifecycle changes; input normalization may run earlier without changing the aggregate.
 */
import { SingularityFlowError } from '../foundation/failures.mjs';
import {decisionFedBy,decisionInputsHint,normalizeDecisionInputValues,recordedDecisionValues} from './workflow-decisions.mjs';

function phaseIndex(workflow, phaseId) {
  const order = workflow.phaseOrder;
  const index = Array.isArray(order) ? order.indexOf(phaseId) : -1;
  if (index < 0 || new Set(order).size !== order.length
      || order.some((id) => !workflow.phases?.[id] || workflow.phases[id].id !== id)) {
    throw new SingularityFlowError('Lifecycle transition requires an existing selected phase.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  return index;
}

export function nextPhaseAfterSkillAmendment(workflow, phase) {
  const start = phaseIndex(workflow, phase.id);
  const amendment = [...(workflow.skillVersionAmendments ?? [])].reverse().find((entry) =>
    entry.status === 'approved' && entry.affectedPhaseIds.includes(phase.id));
  for (let index = start + 1; index < workflow.phaseOrder.length; index += 1) {
    const candidate = workflow.phases[workflow.phaseOrder[index]];
    // Only an accepted amendment's verified independence proof preserves existing approval.
    if (amendment?.preservedPhaseIds.includes(candidate.id) && candidate.status === 'approved') continue;
    // A phase whose approval rework retained by rule [E2G-021] is already complete.
    if (candidate.status === 'approved' && candidate.retention?.generation === candidate.generation) continue;
    return candidate;
  }
  return null;
}

/**
 * Called only after the owner has established the source phase's completion.
 *
 * `outcome` is what the phase's decision chose (workflow-decisions.mjs), or null where no decision
 * follows it, which keeps the linear path. A loop is not applied here: going back is rework, and
 * the rework owner records it with its change request and invalidations.
 */
export function advanceCompletedPhase(workflow, phase, at, outcome = null) {
  if (outcome?.kind === 'loop') {
    throw new SingularityFlowError('A decision that goes back is applied as rework, not as an advance.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  if (outcome?.kind === 'pause') {
    if (!outcome.pending) {
      throw new SingularityFlowError('A paused decision needs its pending record.', { code: 'LIFECYCLE_TRANSITION_INVALID' });
    }
    // The phase stays current and approved; nothing is active until a person chooses.
    workflow.pendingDecision = outcome.pending; workflow.currentPhase = phase.id; workflow.status = 'in_progress';
    return null;
  }
  // Absent unless a decision is waiting, so Stories that never use one keep their exact shape.
  delete workflow.pendingDecision;
  if (outcome?.kind === 'forward' || outcome?.kind === 'end') {
    skipPhaseRange(workflow, outcome.skipped ?? [], { at, decision: outcome.decision, route: outcome.route });
    const target = outcome.kind === 'forward' ? workflow.phases[outcome.target] : null;
    if (outcome.kind === 'forward' && (!target || workflow.phaseOrder.indexOf(target.id) <= phaseIndex(workflow, phase.id))) {
      throw new SingularityFlowError('A decision may only skip ahead to a later phase.', { code: 'LIFECYCLE_TRANSITION_INVALID' });
    }
    if (target) {
      target.status = 'in_progress'; target.startedAt = at; workflow.currentPhase = target.id;
    } else { workflow.currentPhase = null; workflow.status = 'closed'; }
    return target;
  }
  const upcoming = nextPhaseAfterSkillAmendment(workflow, phase);
  if (upcoming) {
    upcoming.status = 'in_progress'; upcoming.startedAt = at; workflow.currentPhase = upcoming.id;
  } else { workflow.currentPhase = null; workflow.status = 'closed'; }
  return upcoming;
}

/**
 * Mark phases a decision passed over. Only phases that have not started are skipped: a phase an
 * accepted skill amendment preserved as approved keeps its approval rather than being downgraded.
 */
export function skipPhaseRange(workflow, phaseIds, { at, decision, route }) {
  const skipped = [];
  for (const id of phaseIds) {
    const target = workflow.phases?.[id];
    if (!target || target.status !== 'not_started') continue;
    target.status = 'skipped'; target.skippedAt = at; target.skippedBy = { decision, route };
    skipped.push(id);
  }
  return skipped;
}

/**
 * Send one phase back for rework. Every path that reopens a phase (a rejection or a decision's
 * loop, reopening completed work, promoting a design source, detaching a document its work used)
 * applies exactly this: its decisions are invalidated, its review and approval are cleared, it
 * needs a new generation, and nothing recorded about its previous completion carries over. The
 * caller adds what only it records, such as who rejected the phase or which decision invalidated it.
 *
 * `retainable` marks an approved phase whose approval may be retained when the Story reaches it
 * again and nothing it decided over changed (src/phase-retention.mjs).
 */
export function resetPhaseForRework(phase, { at, status, invalidation = {}, retainable = false }) {
  const approved = phase.status === 'approved';
  for (const approval of phase.approvals ?? []) {
    if (!approval.invalidatedAt) Object.assign(approval, { invalidatedAt: at, ...invalidation });
  }
  phase.status = status;
  phase.submittedAt = null; phase.approvedAt = null; phase.approvedBy = null;
  phase.submissionArchitectureDecision = null;
  phase.reworkRevalidation = { generation: phase.generation, invalidatedAt: at, ...(retainable && approved ? { retainable: true } : {}) };
  delete phase.retention;
  clearDecisionState(phase);
  clearApprovalDisposition(phase);
}

/**
 * Reset the target and every phase after it for rework, and make the target current. The whole
 * range is reset, not just dependency descendants: what a later phase depends on is known only once
 * the phases before it complete again. With `retain`, approved phases after the target may keep
 * their approval then, when nothing they decided over changed. Nothing changes when any phase in
 * the range is malformed.
 */
export function resetPhaseRangeForRework(workflow, { targetId, at, invalidation = {}, retain = false, loopDecision = null }) {
  const targetIndex = phaseIndex(workflow, targetId);
  const affectedIds = workflow.phaseOrder.slice(targetIndex);
  if (affectedIds.some((id) => !Array.isArray(workflow.phases[id].approvals)
      || workflow.phases[id].approvals.some((approval) => !approval || typeof approval !== 'object'))) {
    throw new SingularityFlowError('Lifecycle rework requires an existing decision collection.',
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  for (const [index, id] of affectedIds.entries()) {
    resetPhaseForRework(workflow.phases[id], { at, status: index === 0 ? 'in_progress' : 'not_started', invalidation, retainable: retain && index > 0 });
  }
  // Reopened phases run again, so their decisions are taken again; a question still waiting
  // after one of them no longer describes the Story.
  if (workflow.pendingDecision && affectedIds.includes(workflow.pendingDecision.after)) delete workflow.pendingDecision;
  resetDecisionRounds(workflow, affectedIds, loopDecision);
  // A reopened Story finishes again, and its final evaluation is made again over the new evidence.
  delete workflow.completion;
  workflow.currentPhase = targetId; workflow.status = 'in_progress';
  return affectedIds;
}

/**
 * A rejection, a reopen or a decision's loop: the range is reset and the target records who sent it
 * back and why. A loop passes no `retain`: each round gets its own evidence [E2G-023].
 */
export function reopenPhaseRange(workflow, { targetId, at, actor, reason, retain = false, loopDecision = null }) {
  const affectedIds = resetPhaseRangeForRework(workflow, { targetId, at, retain, loopDecision });
  const target = workflow.phases[targetId];
  target.rejectedAt = at; target.rejectedBy = actor; target.rejectionReason = reason;
  return affectedIds;
}

/**
 * A decision whose step runs again from an earlier start counts its rounds afresh; only its own
 * loop (`keep`) adds to them. They only grew, so after a rework the first "go back" said its
 * rounds were used (2026-10-28).
 */
export function resetDecisionRounds(workflow, phaseIds, keep = null) {
  for (const decision of workflow.resolution?.decisions ?? []) {
    if (decision.id !== keep && phaseIds.includes(decision.after)) delete workflow.decisionRounds?.[decision.id];
  }
}

/** A phase that runs again records its decision values again and is no longer skipped. */
export function clearDecisionState(phase) {
  delete phase.skippedAt; delete phase.skippedBy; delete phase.decisionInputs;
}

/**
 * Only an automatic completion records a disposition ('policy_waived' or 'not_required') and a
 * policy waiver. Once the phase is sent back, submitted for people to review, or approved by one,
 * the record describes an earlier completion. Kept, the governance gate would replay an earlier
 * round's waiver against the current generation.
 */
export function clearApprovalDisposition(phase) {
  delete phase.approvalDisposition; delete phase.approvalWaiver;
}

/**
 * The automatic disposition of the phase's current completion, or null. Older builds never cleared
 * the record, so a phase reopened, or approved by people, after an automatic completion may still
 * carry one that no longer describes it; a current human approval wins.
 */
export function automaticApprovalDisposition(phase) {
  if (phase?.status !== 'approved') return null;
  if ((phase.approvals ?? []).some((item) => !item.invalidatedAt && item.decision === 'approved')) return null;
  return phase.approvalDisposition ?? null;
}

/**
 * The phase that completed a Story: its last phase, unless a decision finished the Story early or
 * skipped its tail, in which case the last phase that actually ran.
 */
export function completionPhaseOf(workflow) {
  const id = [...(workflow.phaseOrder ?? [])].reverse().find((phaseId) => workflow.phases?.[phaseId]?.status !== 'skipped')
    ?? workflow.phaseOrder?.at(-1);
  return id ? workflow.phases?.[id] ?? null : null;
}

/** The phase a completion will start: the decision's target, or the linear successor. */
export function upcomingAfterOutcome(workflow, phase, outcome) {
  if (!outcome || outcome.kind === 'next') return nextPhaseAfterSkillAmendment(workflow, phase);
  return outcome.kind === 'forward' ? workflow.phases[outcome.target] ?? null : null;
}

export function resolvePhaseChangeRequests(workflow, phase, { at, actor, completionDisposition = null }) {
  const resolved = (workflow.changeRequests ?? []).filter((request) =>
    request.status === 'open' && request.targetPhase === phase.id);
  for (const request of resolved) {
    request.status = 'resolved';
    request.resolvedAt = at;
    request.resolvedBy = actor;
    request.resolution = {
      phase: phase.id,
      generation: phase.generation,
      artifactSha256: (phase.artifacts ?? []).map((artifact) => ({
        path: artifact.path, sha256: artifact.sha256 ?? null
      })),
      ...(completionDisposition ? { completedAt: at, completionDisposition } : { approvalDecisionAt: at })
    };
  }
  return resolved.map((request) => request.id);
}


/** Called at the existing native checkpoint. Clock and verified evidence remain host observations. */
export function beginPhaseSubmission(phase, at) {
  phase.submissionArchitectureDecision = null;
  phase.submittedAt = at;
}

/**
 * Apply only the submitted phase's disposition after the owner's tests, policy and application
 * review checks. This does not evaluate a waiver, authenticate a reviewer, advance the Story or
 * persist any record. Historical votes and evidence remain unchanged.
 */
export function applyPhaseSubmissionDisposition(phase, {reviewableFailure,applicationReviewPending,waiver}) {
  const completed = !reviewableFailure && !applicationReviewPending && (phase.approvalPolicy.mode === 'none' || waiver?.eligible);
  if (completed) {
    phase.status = 'approved';
    phase.approvedAt = phase.submittedAt;
    phase.approvedBy = null;
    phase.approvalDisposition = waiver?.eligible ? 'policy_waived' : 'not_required';
    phase.approvalWaiver = waiver?.eligible ? {
      policyId: waiver.policyId,
      policySha256: waiver.policyHash,
      sourceCommit: waiver.sourceCommit,
      reconciliationSha256: phase.workIntervalReconciliation?.reconciliationSha256 ?? null,
      predicates: waiver.predicates,
      waivedAt: phase.submittedAt
    } : null;
  } else {
    phase.status = 'awaiting_approval';
    clearApprovalDisposition(phase);
  }
  return Boolean(completed);
}

/** Normalize once before the host samples its clock/actor; retain exact earlier records on retry. */
export function submittedDecisionInputPlan(workflow, phase, supplied) {
  const decision = decisionFedBy(workflow, phase.id);
  const given = supplied && Object.keys(supplied).length ? supplied : null;
  if (!decision) {
    if (given) throw new SingularityFlowError(
      `Phase '${phase.id}' feeds no decision that records values; submit it without --decision.`, {code:'DECISION_INPUT_UNKNOWN'});
    return {kind:'none',record:null};
  }
  if (!given) {
    if (recordedDecisionValues(phase,decision)) return {kind:'retained',record:phase.decisionInputs};
    throw new SingularityFlowError(
      `Decision '${decision.label}' after '${phase.id}' reads values this submission must record. Submit with ${decisionInputsHint(decision)}.`,
      {code:'DECISION_INPUTS_MISSING',details:{decision:decision.id,inputs:decision.inputs}});
  }
  return {kind:'record',decisionId:decision.id,values:normalizeDecisionInputValues(decision,given)};
}

/** A record update over trusted observations only; identity authority is never derived here. */
export function applySubmittedDecisionInput(phase, plan, {at,actorId}) {
  phase.decisionInputs = {schemaVersion:1,decision:plan.decisionId,values:plan.values,recordedAt:at,recordedBy:actorId};
  return phase.decisionInputs;
}

/** Record only an already-checked human vote. Identity, quorum proof and persistence stay outside. */
export function recordPhaseApprovalState(phase, decision, {key,reached}) {
  phase.approvals.push(decision);
  clearApprovalDisposition(phase);
  if (reached) {
    phase.status = 'approved'; phase.approvedAt = decision.at; phase.approvedBy = key;
  }
}
/** Publication mutations apply only after the owner has completed its unchanged admission checks. */
export function beginGenerationPublication(phase, { targetGeneration, actor, agent, producer }) {
  phase.generation = targetGeneration; phase.generatedBy = actor;
  phase.submissionArchitectureDecision = null;
  phase.generatedAgent = producer === 'governed-agent' ? agent : null;
  phase.authorship ??= [];
}

export function appendGenerationAuthorship(phase, effectiveAuthorship, publishedAt) {
  phase.authorship.push({ ...structuredClone(effectiveAuthorship), generation: phase.generation, publishedAt });
}

/** Only live submission bindings are cleared; immutable previous publications remain retained. */
export function resetGenerationDeliveryBindings(phase) {
    if (phase.claimMaps) delete phase.claimMaps.observed;
    phase.generationCommit = null;
    phase.publicationCommit = null;
    phase.submittedAt = null;
}

/** Construct the original delivery record from explicit verified observations; no I/O or clock. */
export function codeDeliveryPublicationReceipt(workflow, phase, deliveryPreflight, {
  schemaVersion, changeSetPath, workingStateDigest, testInputSha256, effectiveAuthorship,
  codeModelObservation, codeModelAssurance, autoCandidate, autoCandidateVerification, publishedAt
}) {
  return {
      schemaVersion: schemaVersion,
      kind: 'code-delivery',
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      generationIntentId: deliveryPreflight.generationIntentId,
      changeSet: {
        path: changeSetPath,
        digest: deliveryPreflight.changeSet.digest,
        sourcePaths: deliveryPreflight.sourcePaths,
        deletedSourcePaths: deliveryPreflight.deletedSourcePaths,
        configurationPaths: deliveryPreflight.configurationPaths,
        executableTestPaths: deliveryPreflight.testPaths,
        supportingTestPaths: deliveryPreflight.supportingTestPaths
      },
      changeClassification: {
        ...deliveryPreflight.changeClassification,
        declaredOrigins: [...(effectiveAuthorship.changeOrigins ?? [])]
      },
      ...(deliveryPreflight.documentationCorrection ? {
        documentationCorrection: structuredClone(deliveryPreflight.documentationCorrection)
      } : {}),
      ...(deliveryPreflight.testingRepair ? {
        testingRepair: structuredClone(deliveryPreflight.testingRepair)
      } : {}),
      traceability: {
        required: deliveryPreflight.acceptanceCriteria.required,
        bound: deliveryPreflight.acceptanceCriteria.tagged,
        missing: deliveryPreflight.acceptanceCriteria.missing,
        ambiguous: deliveryPreflight.acceptanceCriteria.ambiguous,
        bindings: deliveryPreflight.acceptanceCriteria.bindings,
        // Which exact test each criterion tag sits on, read by the module adapter [E2G-015].
        witnesses: deliveryPreflight.acceptanceCriteria.witnesses ?? [],
        unattachedTags: deliveryPreflight.acceptanceCriteria.unattachedTags ?? [],
        adapterProfiles: deliveryPreflight.acceptanceCriteria.profiles ?? [],
        ...(deliveryPreflight.sourceBindings.mode === 'enforce' ? {
          sourceRequired: deliveryPreflight.sourceBindings.required,
          sourceBindings: deliveryPreflight.sourceBindings.bindings
        } : {})
      },
      ...(deliveryPreflight.fulfillment?.length ? { fulfillment: { obligations: structuredClone(deliveryPreflight.fulfillment) } } : {}),
      ...(deliveryPreflight.implementationBindings ? { implementationBindings: structuredClone(deliveryPreflight.implementationBindings) } : {}),
      ...(deliveryPreflight.cornerCaseMatrix ? { cornerCaseMatrix: structuredClone(deliveryPreflight.cornerCaseMatrix) } : {}),
      ...(deliveryPreflight.excludedChanges?.length ? { excludedChanges: [...deliveryPreflight.excludedChanges] } : {}),
      testExecutions: [],
      ...(deliveryPreflight.testRecovery ? { testRecovery: structuredClone(deliveryPreflight.testRecovery) } : {}),
      ...(autoCandidate ? { autoCandidate: structuredClone(autoCandidate) } : {}),
      ...(autoCandidateVerification ? {
        autoCandidateVerification: structuredClone(autoCandidateVerification)
      } : {}),
      tree: { workingStateDigest, ...(testInputSha256 ? { testInputSha256 } : {}),
        generationCommit: null, generationTree: null },
      model: {
        task: 'code',
        required: effectiveAuthorship.producer === 'governed-agent',
        authorshipProducer: effectiveAuthorship.producer,
        minimumAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
        mappingRevision: codeModelObservation?.mappingRevision ?? null,
        provider: codeModelObservation?.provider ?? null,
        requestedModel: codeModelObservation?.requestedModel ?? null,
        resolvedModel: codeModelObservation?.resolvedModel ?? null,
        assurance: codeModelAssurance,
        invocationIds: codeModelObservation ? [codeModelObservation.invocationId] : [],
        host: codeModelObservation?.host ?? null,
        observationSource: codeModelObservation?.source ?? null,
        observationIntegrity: codeModelObservation?.observationIntegrity ?? 'unverified-local',
        observedAt: codeModelObservation?.observedAt ?? null,
        generation: codeModelObservation?.generation ?? null
      },
      status: 'pending-tests',
      capturedAt: publishedAt
    };
}

/** Called at the same checkpoint as the receipt's accepted write, rather than before that await. */
export function recordCodeDeliveryPublication(phase, deliveryPreflight, {
  receiptPath, changeSetPath, workingStateDigest, testInputSha256, effectiveAuthorship,
  autoCandidate, autoCandidateVerification, publishedAt
}) {
  phase.deliveryEvidence = {
      ...deliveryPreflight,
      changeClassification: {
        ...deliveryPreflight.changeClassification,
        declaredOrigins: [...(effectiveAuthorship.changeOrigins ?? [])]
      },
      generation: phase.generation,
      receiptPath,
      changeSetPath,
      sourceTreeSha256: workingStateDigest,
      ...(testInputSha256 ? { testInputSha256 } : {}),
      ...(autoCandidate ? { autoCandidate: structuredClone(autoCandidate) } : {}),
      ...(autoCandidateVerification ? {
        autoCandidateVerification: structuredClone(autoCandidateVerification)
      } : {}),
      status: 'pending-tests',
      capturedAt: publishedAt,
      validation: null
    };
}

export function recordGenerationAstGate(phase, astReceipt) {
  if (astReceipt) {
    phase.astGates = [
      ...(phase.astGates ?? []).filter((record) => record.generation !== phase.generation),
      astReceipt
    ].sort((left, right) => left.generation - right.generation);
  }
}

export function recordGenerationClarification(phase, clarification, answeredMarkers) {
  if (clarification.record) {
    phase.clarifications ??= [];
    phase.clarifications = [
      ...phase.clarifications.filter((record) => record.generation !== phase.generation),
      {
        generation: phase.generation,
        path: clarification.path,
        sha256: clarification.sha256,
        promptSha256: clarification.record.promptSha256,
        responses: clarification.record.responses.length,
        // Which artifact markers this batch answered `[SPK:REQ-066]`. Kept on the summary so the
        // gate can tell a resolved marker from a deleted one without reading every record off disk
        // on a path that already does a lot of I/O.
        markers: answeredMarkers,
        recordedAt: clarification.record.recordedAt,
        recordedBy: structuredClone(clarification.record.recordedBy)
      }
    ];
  }
}

export function recordGenerationMarkers(phase, gate, publishedAt) {
  if (gate.applies && gate.record) {
    phase.markers = [
      ...(phase.markers ?? []).filter((record) => record.generation !== phase.generation),
      { ...gate.record, generation: phase.generation, recordedAt: publishedAt }
    ].sort((left, right) => left.generation - right.generation);
  }
}

export function recordGenerationTelemetry(phase, summary) {
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== phase.generation), summary];
}

export function recordGenerationAgentBriefs(phase, agentBriefs) {
  if (agentBriefs.length) {
    phase.agentBriefs = [
      ...(phase.agentBriefs ?? []).filter((entry) => entry.generation !== phase.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
  }
}

export function recordGenerationArtifactSet(phase, catalog, diff) {
  phase.artifactSet = {
      ...catalog,
      generation: phase.generation,
      preserved: diff.preserved.map((member) => member.path),
      changed: diff.changed.map((member) => member.path),
      // Member names, not repository paths: this block is read beside `reopen.members`, which is
      // the list the reviewer wrote, and the two have to be comparable at a glance.
      ...(phase.surgicalReopen ? { reopen: { ...phase.surgicalReopen, incidental: diff.incidental.map((member) => member.member) } } : {})
    };
  // Consumed by this generation so later publications do not disclose the same reopen again.
  delete phase.surgicalReopen;
}

export function recordGenerationPublication(phase, generationPublication) {
  phase.generationPublications = [
    ...(phase.generationPublications ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    generationPublication
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
}
