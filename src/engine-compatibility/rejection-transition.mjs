/** Native rejection records and rework effects, reachable only through the compatibility aggregate. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { head } from '../git.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { SingularityFlowError } from '../foundation/failures.mjs';
import { assertRejectionComment, rejectionTarget } from '../kernel/approval-policy.mjs';

/**
 * A repair preview computed earlier in the same operation is reused only while its digest still
 * matches its own content, the confirmation, this Story and step, and HEAD. Anything else is
 * previewed again, so the confirmation check below always compares against current bytes.
 */
function currentTestingRepairPlan(root, workflow, plan, { phaseId, target, confirmation }) {
  if (!plan || typeof plan !== 'object') return null;
  const { confirmation: digest, ...core } = plan;
  return digest === confirmation
    && digest === `sha256:${createHash('sha256').update(canonicalJson(core)).digest('hex')}`
    && core.workId === workflow.workItem.id && core.phase === phaseId && core.targetPhase === target
    && Number(core.testingGeneration) === Number(workflow.phases?.[phaseId]?.generation)
    && core.head === head(root) ? plan : null;
}

export async function rejectNativePhase(root, config, workflow, {
  phaseId, target, reason, clauseIds = [], members = [], convergenceRework = null,
  testingRepairConfirm = null, testingRepairPlan = null, channel = 'terminal', actionContext = null,
  actor = null, agent = undefined, upstreamIssue = null, presence = null
} = {}, collaborators) {
  const {
    resolveStoryExecutionCatalog,
    assertNoPendingPublication,
    previewTestingRepair,
    loadVerifiedConvergenceProjection,
    assertPhaseSequence,
    loadSession,
    assertPhaseAgentMayMutate,
    requireApprovalAuthority,
    loadActiveSpecRecords,
    workDir,
    posix,
    resolvedArtifactSet,
    workDirRelative,
    memberRoot,
    nowIso,
    actorKey,
    repairBudgetPhaseForRejection,
    consumeRepairAttempt,
    createReworkForwardCheckpoint,
    reopenPhaseRange,
    updateArtifactMetadata,
    ensureWorkIntervalBaseline,
    writeDecision,
    saveWorkflow,
    contextBoundaryHandoff
  } = collaborators;
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  await assertNoPendingPublication(root, config, workflow, 'reject');
  const testingRepair = testingRepairConfirm
    ? currentTestingRepairPlan(root, workflow, testingRepairPlan, {
      phaseId, target, confirmation: testingRepairConfirm
    }) ?? await previewTestingRepair(root, config, workflow)
    : null;
  if (testingRepair && (phaseId !== testingRepair.phase || target !== testingRepair.targetPhase
      || testingRepair.confirmation !== testingRepairConfirm || convergenceRework)) {
    throw new SingularityFlowError(
      `Testing repair requires the current change-set confirmation: --confirm ${testingRepair.confirmation}.`,
      { code: 'TESTING_REPAIR_CONFIRMATION_REQUIRED', details: { preview: testingRepair } }
    );
  }
  /**
   * Governed rework out of convergence `[SPK:REQ-182]`.
   *
   * Convergence is `in_progress` when its findings are adjudicated — nobody has submitted it, and
   * asking a reviewer to approve a phase so that it can immediately be rejected would put a second
   * person in the loop for a decision the first already made.
   *
   * So this is the one caller that may reject an unsubmitted phase, and the exception is narrow on
   * purpose: it is honoured only when the projection it names actually carries blocking rework
   * findings. The flag cannot be used to skip an approval, because a phase with nothing to rework
   * has nothing to authorise it. Everything after this line is the ordinary rejection path — the
   * same authority check, change request, invalidation and transition `[SPK:REQ-082]`.
   */
  let reworkBlockers = convergenceRework?.findingIds ?? convergenceRework?.unresolvedBlockers ?? [];
  if (convergenceRework) {
    const verified = await loadVerifiedConvergenceProjection(root, config, workflow);
    if (Number(convergenceRework.iteration) !== Number(verified.projection.iteration)
        || convergenceRework.convergenceSha256 !== verified.projection.convergenceSha256) {
      throw new SingularityFlowError(
        'Convergence rework does not match the exact current projection.',
        { code: 'CONVERGENCE_REWORK_BINDING_MISMATCH' }
      );
    }
    const currentRework = (verified.projection.findings ?? [])
      .filter((finding) => finding.disposition === 'rework')
      .map((finding) => finding.id)
      .sort();
    const supplied = [...new Set(reworkBlockers)].sort();
    if (!currentRework.length || canonicalJson(currentRework) !== canonicalJson(supplied)) {
      throw new SingularityFlowError(
        'Convergence rework must name every and only the current findings dispositioned as rework.',
        { code: 'CONVERGENCE_REWORK_BINDING_MISMATCH' }
      );
    }
    reworkBlockers = currentRework;
  }
  if (convergenceRework && !reworkBlockers.length) {
    throw new SingularityFlowError('Convergence rework needs at least one finding dispositioned as rework.');
  }
  const phase = await assertPhaseSequence(root, workflow, 'reject', {
    requestedPhase: phaseId,
    // An upstream issue's return is decided by the earlier step's owners, so the step that found
    // the defect need not be submitted first [UIF-M2].
    allowedStatuses: reworkBlockers.length || testingRepair || upstreamIssue
      ? ['awaiting_approval', 'in_progress'] : ['awaiting_approval']
  });
  assertRejectionComment(phase, reason, testingRepair);
  const session = actor
    ? { actor, agent: agent ?? null }
    : await loadSession(root);
  assertPhaseAgentMayMutate(config, workflow, phase, session, 'reject');
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    (upstreamIssue ? workflow.phases[target]?.approvalPolicy : null) ?? phase.approvalPolicy,
    session.actor
  );
  const { targetId, targetIndex } = rejectionTarget(workflow, phase, target, upstreamIssue);
  const requestedClauses = [...new Set(clauseIds)];
  if (requestedClauses.length) {
    const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
    const known = new Set(records.indexes.flatMap((index) => (index.clauses ?? []).map((clause) => clause.id)));
    const unknown = requestedClauses.filter((id) => !known.has(id));
    if (unknown.length) throw new SingularityFlowError(`Change request references unknown specification clause(s): ${unknown.join(', ')}.`);
  }
  /**
   * Surgical reopen `[SPK:REQ-111]`.
   *
   * A rejection may name the members it expects to be regenerated. That is a promise, and the next
   * publication checks it: unchanged members must still hash the same, and anything else that moved
   * is disclosed. Naming a member that is not in the set is refused here rather than silently
   * ignored — a typo that quietly widens the promise to "nothing in particular" would make the whole
   * disclosure vacuous.
   *
   * Members are checked against the *target* phase's set, because that is where the promise is
   * recorded and the phase whose next publication keeps it. Rejecting `planning` back to
   * `specification` reopens `spec.md`; checking `plan.md` against the planning set would accept a
   * member the reopened phase does not own and refuse the one it does.
   */
  const requestedMembers = [...new Set(members.map((member) => posix(String(member).trim())).filter(Boolean))];
  if (requestedMembers.length) {
    const reopened = workflow.phases[targetId];
    const set = resolvedArtifactSet(config, workflow, reopened);
    if (!set) {
      throw new SingularityFlowError(`Rejection target '${targetId}' has no artifact set, so it has no members to reopen.`, {
        code: 'REJECT_MEMBER_UNKNOWN', details: { sourcePhase: phase.id, targetPhase: targetId, members: requestedMembers, known: [] }
      });
    }
    const known = new Set(set.members.flatMap((member) => [
      member.path, posix(path.posix.join(workDirRelative(config, workflow.workItem.id), memberRoot(reopened), member.path))
    ]));
    const unknown = requestedMembers.filter((member) => !known.has(member));
    if (unknown.length) {
      throw new SingularityFlowError(`Artifact set '${set.id}' of rejection target '${targetId}' has no member(s): ${unknown.join(', ')}. Members are ${set.members.map((member) => member.path).join(', ')}.`, {
        code: 'REJECT_MEMBER_UNKNOWN',
        details: { sourcePhase: phase.id, targetPhase: targetId, artifactSet: set.id, members: unknown, known: set.members.map((member) => member.path) }
      });
    }
  }

  const timestamp = nowIso(); const key = actorKey(session.actor);
  workflow.changeRequests ??= [];
  const changeRequest = {
    schemaVersion: 1,
    id: `CR-${String(workflow.changeRequests.length + 1).padStart(3, '0')}`,
    status: 'open',
    sourcePhase: phase.id,
    sourceGeneration: phase.generation,
    targetPhase: targetId,
    clauseIds: requestedClauses,
    // The convergence iteration this rework came out of, so the next one can be read against it
    // `[SPK:REQ-083]` and the prior findings stay reachable rather than merely preserved on disk.
    ...(convergenceRework ? {
      convergence: {
        iteration: convergenceRework.iteration,
        convergenceSha256: convergenceRework.convergenceSha256 ?? null,
        findingIds: reworkBlockers
      }
    } : {}),
    ...(requestedMembers.length ? { members: requestedMembers } : {}),
    ...(upstreamIssue ? { [String(upstreamIssue.id).startsWith('FAM-') ? 'forwardAmendment' : 'upstreamIssue']: upstreamIssue.id } : {}),
    ...(testingRepair ? { testingRepair: {
      confirmation: testingRepair.confirmation,
      changeSetDigest: testingRepair.changeSetDigest,
      changedPaths: testingRepair.changedPaths,
      codeGeneration: testingRepair.codeGeneration,
      codeGenerationCommit: testingRepair.codeGenerationCommit,
      codeReceiptSha256: testingRepair.codeReceiptSha256,
      codeEvidenceCommit: testingRepair.codeEvidenceCommit,
      sourceTreeSha256: testingRepair.sourceTreeSha256
    } } : {}),
    comment: reason?.trim() || 'Changes requested.',
    requestedAt: timestamp,
    requestedBy: session.actor,
    agent: session.agent,
    channel,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    sourceArtifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: null,
    resolution: null
  };
  const budgetPhase = repairBudgetPhaseForRejection(workflow, phase, targetId);
  const budgetPreview = budgetPhase
    ? { ...workflow, repairBudgets: structuredClone(workflow.repairBudgets ?? {}) }
    : null;
  const repairBudget = budgetPhase ? consumeRepairAttempt(budgetPreview, budgetPhase, {
    targetPhase: targetId,
    sourcePhase: phase,
    actor: structuredClone(session.actor),
    at: timestamp,
    changeRequestId: changeRequest.id
  }) : null;
  // Exhaustion is a read-only refusal. A forward checkpoint may create a retained Git ref, so
  // validate a separate in-memory budget preview first; commit it only after the checkpoint works.
  changeRequest.forwardCheckpoint = await createReworkForwardCheckpoint(root, config, workflow, {
    changeRequestId: changeRequest.id,
    sourcePhase: phase.id,
    targetPhase: targetId,
    targetIndex,
    createdAt: timestamp
  });
  if (budgetPreview) workflow.repairBudgets = budgetPreview.repairBudgets;
  // Approved phases after the target may keep their approval when nothing they decided over changes.
  for (const id of reopenPhaseRange(workflow, {
    targetId, at: timestamp, actor: key, reason: changeRequest.comment, retain: true
  })) await updateArtifactMetadata(root, config, workflow, workflow.phases[id]);
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: targetId,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  const packet = workflow.lineage?.submissions?.findLast?.((entry) =>
    entry.phase === phase.id && entry.generation === phase.generation
  ) ?? [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && entry.generation === phase.generation
  );
  changeRequest.reviewPacketSha256 = packet?.packetSha256 ?? null;
  workflow.changeRequests.push(changeRequest);
  const decision = {
    decision: 'rejected',
    phase: phase.id,
    target: targetId,
    reason: changeRequest.comment,
    changeRequestId: changeRequest.id,
    clauseIds: requestedClauses,
    at: timestamp,
    actor: session.actor,
    agent: session.agent,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    channel,
    generation: phase.generation,
    artifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: packet?.packetSha256 ?? null,
    ...(phase.artifactSet ? { artifactSet: phase.artifactSet.setId, bundleSha256: phase.artifactSet.bundleSha256 } : {}),
    ...(requestedMembers.length ? { members: requestedMembers } : {}),
    ...(repairBudget ? { repairBudget: { consumed: repairBudget.attempts.length, maximum: repairBudget.maximum } } : {}),
    ...(actionContext ? { actionContext } : {})
  };
  // The card, then the approver's touch, over the final record [SPEC-PSS-v1 M2].
  if (presence) await (await import('../presence/person-records.mjs')).attachPersonPresence(presence, decision);
  phase.approvals.push(decision); await writeDecision(root, config, workflow, phase, decision);
  // The promise the next generation has to keep `[SPK:REQ-111]`. Recorded on the *target* phase,
  // which is the one that will regenerate — rejecting `verification` back to `specification` means
  // the specification is what gets reopened.
  if (requestedMembers.length) {
    workflow.phases[targetId].surgicalReopen = {
      changeRequestId: changeRequest.id,
      members: requestedMembers,
      requestedAt: timestamp,
      requestedBy: structuredClone(session.actor),
      reason: changeRequest.comment
    };
  }
  workflow.history.push({ at: timestamp, actor: key, agent: session.agent, event: 'phase_rejected', phase: phase.id, detail: `${changeRequest.id} returned to ${targetId}: ${changeRequest.comment}` });
  await saveWorkflow(root, config, workflow);
  return {
    ...workflow.phases[targetId],
    changeRequest,
    ...(repairBudget ? { repairBudget } : {}),
    contextBoundary: contextBoundaryHandoff(workflow.resolution.contextPolicy, phase.id, {
      event: 'rejection',
      nextPhase: targetId
    })
  };
}
