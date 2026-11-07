/** Native submission transition extracted intact from the aggregate; not an SDK port contract. */
import { assertStoryNotArchived } from '../governance-archive.mjs';
import { resolveStoryExecutionCatalog } from '../story-execution-context.mjs';
import { loadSession } from '../session.mjs';
import { assertPhaseAgentMayMutate } from '../phase-actor-policy.mjs';
import { assertPhaseGovernanceMayAdvance } from '../phase-governance-routing.mjs';
import { verifyAcceptedTestCommandAmendment } from '../story-test-command-amendment.mjs';
import { assertNoPendingPublication } from '../story-publication-pending.mjs';
import { isConvergencePhase, isVisualVerificationPhase } from '../kernel/phase-policy.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { assertPhaseSequence, phaseNeedsGeneration, enforceSequenceGate } from '../sequence.mjs';
import { assertRequiredStepActionsRecorded } from '../step-action-receipts.mjs';
import { beginTestCommandEpochValidation, recordTestCommandEpochValidation } from '../test-command-epoch.mjs';
import { assertReviewCodeEvidenceFresh, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands, testCommandProvenance, uncoveredTestDeliveryPaths } from '../delivery-evidence.mjs';
import { pendingCodeSubmissionEvidence } from '../code-submission-evidence.mjs';
import { assertMcpPhaseReadiness } from '../mcp-readiness.mjs';
import { verifyPhaseMcpRequirements } from '../mcp-evidence.mjs';
import { workDir, workDirRelative } from '../story-paths.mjs';
import { SingularityFlowError, nowIso, run, readJson, posix, writeJson } from '../util.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import { readSourceReviewStatus } from '../source-review-lifecycle.mjs';
import { evaluateSpecificationGate } from '../specification-gate.mjs';
import { requiredRepoPath } from '../story-state-validation.mjs';
import { requireAstLifecycleReceipt } from '../ast-lifecycle.mjs';
import { storyTestScope } from '../code-delivery-policy.mjs';
import { normalizeRequiredTestCommand, structuredTestCommandRequiredError, parseTestResult, testReceiptPassing, testCommandCoversPath, resolveAffectedModule, configuredTestModuleOverrides } from '../code-delivery-tests.mjs';
import { resolveTrpDeliverySelection } from '../trp-delivery-selection.mjs';
import { evaluateChangeFlightPlanBoundary, persistChangeFlightPlanBoundary } from '../change-flight-plan.mjs';
import { publishedGenerationCommit } from '../generation-boundary.mjs';
import { buildRepositoryChangeSet } from '../repository-change-set.mjs';
import { applicationChangeSetProjection, applicationPathContext, phaseUsesWorkInterval, verifyWorkIntervalBaseline, ensureWorkIntervalBaseline, reconcileWorkInterval, recordFinalReconciliation, closeWorkInterval } from '../work-intervals.mjs';
import { crossPhaseChange, describeCrossPhaseChange } from '../evidence/cross-phase-change.mjs';
import { commitsTouchingSince, remoteContains } from '../git.mjs';
import { workflowPublicationBranch, workflowPublicationMode } from '../story-publication-binding.mjs';
import { retainedStoryTestRisk, beginStoryTestRiskRun, captureStoryTestRiskObservation, assertStoryTestRiskGate } from '../test-recovery-runtime.mjs';
import { recordRunsBeforeRefusal, recordTestAttempt, admitTestAttempts } from '../verification/attempts.mjs';
import { externalCommandText } from '../external-command-policy.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../records.mjs';
import { assertVisualCoverage } from '../visual-coverage.mjs';
import { qualityValidationVerdict } from '../lifecycle-evidence-policy.mjs';
import path from 'node:path';
import { witnessResult, describeWitnessResult } from '../verification/witness-results.mjs';
import { decisionOutcome } from '../workflow-decisions.mjs';
import { completionPhaseOf, beginPhaseSubmission, applyPhaseSubmissionDisposition } from '../kernel/lifecycle-transitions.mjs';
import { supportedWaiverPolicy, evaluateQuickFixWaiver, waiverNotAppliedMessage } from '../quick-fix-policy.mjs';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { retainUnchangedPhases } from '../phase-retention.mjs';
import { saveWorkflow } from '../story-state-write.mjs';

export async function submitNativePhase(root, config, workflow, {
  phaseId, runChecks = true, persist = true, submissionContext = null,
  actor = null, agent = undefined, decisionValues = null
} = {}, collaborators) {
  const {
    CONFIRMED_CONVERGENCE_SUBMISSION,
    actorKey,
    advanceDetail,
    applyCompletionOutcome,
    assertFinalCodeSpecificationCoverage,
    assertPassedCodeDeliveryInput,
    assertPlannedSpecificationClaims,
    assertQualifiedConformanceReady,
    assertRequiredAssignment,
    assertRequiredConvergenceApproval,
    assertSkillPhaseHostReady,
    attachRequiredTestExecution,
    convergenceAdvanceRequired,
    inspectRequiredArtifactRegistration,
    isolatedRunHint,
    markIntentAmendmentRevalidated,
    mayReuseUnchangedRuns,
    pruneTransientArtifactRegistrations,
    qualityChecks,
    qualityCommandResults,
    recordApprovedScopeRevision,
    recordSubmittedDecisionInputs,
    refreshObservedSpecificationClaims,
    refreshPhaseSpecificationIndex,
    refreshRequiredArtifact,
    refreshSkillLifecycleArtifactIdentities,
    registerApprovedSnapshot,
    repairRequiredArtifactRegistration,
    resolvePhaseChangeRequests,
    restoreTransientQualityResult,
    retentionDetail,
    settleRetainedPhases,
    skippedReason,
    sourceTreeHash,
    storyScopedTestCommands,
    testInputTreeHash,
    testRunRiskCover,
    testRunRiskRefusal,
    uncoveredTestPathsError,
    upcomingAfterOutcome,
    updateArtifactMetadata,
    validatePhase,
    verifyAcceptedSkillAmendmentRevalidation
  } = collaborators;
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  let session = actor ? { actor, agent: agent ?? null } : await loadSession(root, { required: false });
  assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId ?? workflow.currentPhase], session, 'submit');
  assertPhaseGovernanceMayAdvance(workflow, workflow.phases?.[phaseId ?? workflow.currentPhase]);
  const verifiedAmendment = await verifyAcceptedSkillAmendmentRevalidation(root, config, workflow);
  await verifyAcceptedTestCommandAmendment(root, config, workflow, verifiedAmendment);
  if (workflow.resolution?.presence) await (await import('../story-test-command-amendment.mjs')).assertSignedTestCommandAmendments(workflow);
  await assertNoPendingPublication(root, config, workflow, 'submit for approval');
  const requestedPhase = workflow.phases?.[phaseId ?? workflow.currentPhase] ?? null;
  // Keep this guard in the domain transition as well as the CLI. Alternate hosts and future
  // command services therefore cannot advance convergence by calling `submitPhase` directly. It
  // precedes even soft sequence reconciliation, pruning, or any other in-memory mutation.
  if (isConvergencePhase(requestedPhase)) {
    if (submissionContext !== CONFIRMED_CONVERGENCE_SUBMISSION) {
      throw convergenceAdvanceRequired(workflow, { phase: requestedPhase.id });
    }
    assertRequiredConvergenceApproval(requestedPhase);
    await assertConvergencePublicationReady(root, config, workflow, requestedPhase);
  }
  const phase = await assertPhaseSequence(root, workflow, 'submit for approval', { requestedPhase: phaseId });
  const { assertPhaseRepairSettled } = await import('../phase-repair-journal.mjs');
  await assertPhaseRepairSettled(root, workflow, phase);
  const { assertPhaseAppealsResolved } = await import('../phase-appeals.mjs');
  await assertPhaseAppealsResolved(root, config, workflow, phase);
  await assertRequiredStepActionsRecorded(root, config, workflow, `${phase.id} cannot be submitted`);
  const { assertStoryDocumentRiskGates } = await import('../trp-document-runtime.mjs');
  await assertStoryDocumentRiskGates(root, config, workflow, phase, 'submit');
  const testCommandEpochRun = beginTestCommandEpochValidation(workflow, phase);
  await assertSkillPhaseHostReady(workflow, phase, 'submit');
  await assertQualifiedConformanceReady(root, config, workflow, phase, 'submit for approval');
  const verifiedCodeInput = await assertPassedCodeDeliveryInput(root, config, workflow, phase);
  await assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput });
  const pendingSubmissionEvidence = await pendingCodeSubmissionEvidence(root, config, workflow, phase);
  if (phaseRequiresCodeDelivery(phase) && phase.generationCommit && !pendingSubmissionEvidence) {
    const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, phase.generationCommit, { boundary: 'submitted' });
    for (const line of coverage?.advisory ?? []) console.warn(`Warning: ${line}`);
  }
  session ??= await loadSession(root);
  recordSubmittedDecisionInputs(workflow, phase, decisionValues, session.actor);
  // Repair legacy generations whose raw reporter output was registered as a phase artifact. The
  // normalized test-execution receipt is durable evidence; `.sflow/results/**` is disposable
  // command transport and commonly changes timestamps on every otherwise identical test run.
  pruneTransientArtifactRegistrations(phase);
  assertRequiredAssignment(workflow, phase);
  await assertMcpPhaseReadiness(root, workflow, phase);
  const mcpEvidence = await verifyPhaseMcpRequirements(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    targetGeneration: phase.generation
  });
  if (mcpEvidence.errors.length) throw new SingularityFlowError(`Phase ${phase.id} MCP evidence is not ready:\n- ${mcpEvidence.errors.join('\n- ')}`, { code: 'MCP_EVIDENCE_REQUIRED' });
  if (phaseNeedsGeneration(workflow, phase)) await enforceSequenceGate(root, workflow, 'freshGeneration', 'submit for approval', {
    requestedPhase: phase.id,
    reason: phase.generation < 1 ? 'The phase has no published generation.' : 'The phase was returned for correction and has not been regenerated.'
  });
  // This is an opt-in policy pinned with the Story, so older in-flight Stories retain their
  // accepted contract. The reviewer is a different governed agent and its report is bound to
  // exact current Story inputs, artifact bytes and generation. A human must explicitly dispose
  // of exclusions before submission; a reviewer cannot approve their own omissions.
  if (sourceReviewRequired(workflow, phase.id)) {
    const review = await readSourceReviewStatus(root, config, workflow, phase.id);
    if (review.status !== 'ready') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' cannot be submitted until an independent source-grounded review is ready. `
        + `Run singularity-flow review-source context ${phase.id} --json, use its pinned reviewer instructions without changing the shared author, `
        + `check the staged report with review-source check before retaining it, and resolve the listed findings before retrying.\n- `
        + (review.findings?.map((entry) => entry.message).join('\n- ') || `Review status: ${review.status}.`),
        {
          code: 'SOURCE_REVIEW_REQUIRED',
          details: {
            workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
            status: review.status, findings: review.findings ?? [],
            pendingDispositions: review.pendingDispositions ?? [],
            nextAction: { command: `singularity-flow review-source context ${phase.id} --json`, skill: '/sf-review-source' }
          }
        }
      );
    }
  }
  /**
   * The same gate again, at the other boundary `[SPK:REQ-065]` names.
   *
   * Placed here rather than beside the quality commands so it precedes every assignment in this
   * function: `[SPK:REQ-065]` says a blocking marker stops submission *before any state mutation*,
   * and `phase.generationCommit` on the next line is one. The freshness gate above it is not a
   * mutation and has to come first — telling someone about an unresolved question in a phase that
   * has nothing to submit yet would be answering a question they have not reached.
   *
   * Not redundant with the publication check either: a generation may have been published while the
   * policy was `warn` and the policy tightened since. Reading the artifact from disk rather than
   * trusting `phase.markers` keeps the verdict about the artifact as it stands.
   */
  const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
    generation: phase.generation,
    artifactRelativePath: requiredRepoPath(config, workflow, phase),
    namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null
  });
  gate.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (gate.errors.length) {
    throw new SingularityFlowError(`Phase ${phase.id} cannot be submitted for approval:\n- ${gate.errors.join('\n- ')}`);
  }
  // Legacy AST receipts are observed diagnostically. Their absence or invalidity cannot prevent
  // submission because normal repository file access is the permanent fallback.
  await requireAstLifecycleReceipt(root, config, workflow, phase, { generation: phase.generation });
  const codeDeliveryRequired = phaseRequiresCodeDelivery(phase);
  if (phase.storyTestCommands || workflow.testCommandDecisions) (await import('../story-test-commands.mjs')).assertStoryTestCommands(workflow);
  let deliveryCommands = await resolveDeliveryQualityCommands(root, phase,
    { executionMode: storyTestScope(workflow) });
  let trpSelection = null;
  let requiredTestCommands = [];
  if (codeDeliveryRequired) {
    const evidence = phase.deliveryEvidence;
    if (!evidence || Number(evidence.generation) !== Number(phase.generation)) {
      throw new SingularityFlowError(
        `Phase ${phase.id} cannot be submitted because generation ${phase.generation} has no code-delivery receipt. Republish it with source and acceptance-mapped tests.`,
        { code: 'CODE_DELIVERY_RECEIPT_MISSING' }
      );
    }
    const currentTree = await sourceTreeHash(root, config, workflow);
    const currentTestInput = await testInputTreeHash(root, config, workflow);
    if (evidence.sourceTreeSha256 !== currentTree || (currentTestInput && evidence.testInputSha256 !== currentTestInput)) {
      throw new SingularityFlowError(
        `Phase ${phase.id} code or separately hashed test inputs changed after publication. Open a fresh generation with singularity-flow phase rollover ${phase.id}, then publish it before submission.`,
        // Named exactly: publish refuses a consumed generation, so "publish" sent the author round in two hops.
        { code: 'CODE_DELIVERY_RECEIPT_STALE', details: { phase: phase.id, nextAction: { command: `singularity-flow phase rollover ${phase.id}`,
          label: 'Open a fresh generation for the changed code, then publish it.' } } }
      );
    }
    requiredTestCommands = deliveryCommands
      .filter((command) => command && typeof command === 'object' && !Array.isArray(command) && command.kind === 'test')
      .map((command, index) => ({
        ...normalizeRequiredTestCommand(command, index),
        provenance: testCommandProvenance(phase, command)
      }))
      .map((command) => ({
        ...command,
        result: {
          ...command.result,
          minimumDiscovered: Math.max(
            command.result.minimumDiscovered,
            workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1
          ),
          minimumPassed: Math.max(
            command.result.minimumPassed,
            workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1
          )
        }
      }));
    if (!requiredTestCommands.length) {
      throw structuredTestCommandRequiredError(phase, { workId: workflow.workItem.id, paths: evidence?.sourcePaths });
    }
    if (workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true) {
      trpSelection = await resolveTrpDeliverySelection(root, config, workflow, phase, evidence, [
        ...deliveryCommands.filter((command) => !command || typeof command !== 'object' || Array.isArray(command) || command.kind !== 'test'),
        ...requiredTestCommands
      ], { persist: true });
      deliveryCommands = trpSelection.commands;
      requiredTestCommands = deliveryCommands.filter((command) => command?.kind === 'test');
      if (trpSelection.reference) evidence.trpSelection = trpSelection.reference;
    }
  }
  // A Change Flight Plan is advisory until accepted, then becomes an exact scope binding. Compute
  // actual-versus-expected before the first submission mutation so an unexamined expansion cannot
  // be hidden by a later workflow write. The receipt itself is persisted only after every ordinary
  // submission gate below has passed.
  const flightPlanBoundary = evaluateChangeFlightPlanBoundary(root, workflow, { phaseId: phase.id });

  const exactGenerationCommit = publishedGenerationCommit(root, workflow, phase);
  if (!exactGenerationCommit) await enforceSequenceGate(root, workflow, 'generationCommit', 'submit for approval', {
    requestedPhase: phase.id,
    reason: `Generation commit is missing for generation ${phase.generation}.`
  });
  // Artifact-only phases review documents; they never authorize application changes. A plain Git
  // commit made after publication used to disappear from `changedFiles()` and could therefore be
  // swept into the later submission/approval history. Compare the complete repository state with
  // the exact generation commit so committed, staged, unstaged, renamed, deleted, and untracked
  // application paths all fail before the first submission mutation.
  if (!codeDeliveryRequired && exactGenerationCommit) {
    const postPublication = await buildRepositoryChangeSet(root, {
      baseCommit: exactGenerationCommit,
      subject: {
        workId: workflow.workItem.id,
        phase: phase.id,
        generation: phase.generation,
        kind: 'artifact-only-submission'
      }
    });
    const applicationChanges = applicationChangeSetProjection(
      postPublication, applicationPathContext(config, workflow)
    ).entries;
    if (applicationChanges.length) {
      const changedPaths = [...new Set(applicationChanges.flatMap((entry) => [
        entry.oldPath, entry.newPath
      ]).filter(Boolean))].sort();
      const change = await crossPhaseChange(root, config, workflow, phase, changedPaths);
      const described = describeCrossPhaseChange(change, { code: 'PHASE_SOURCE_CHANGED_AFTER_PUBLICATION', gate: 'submission', workflow, phase });
      // No earlier code step owns them, so "move them to the code step" named nothing a person could
      // run (2026-10-28): take them out of this step now and bring them back in the code step ahead.
      const ahead = change.returns.length ? null : (workflow.phaseOrder ?? []).slice((workflow.phaseOrder ?? []).indexOf(phase.id) + 1)
        .find((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]));
      const held = ahead ? commitsTouchingSince(root, exactGenerationCommit, changedPaths) : null;
      const shortList = (commits) => commits.map((commit) => commit.slice(0, 12)).join(' ');
      const takeOut = held ? [
        ...(held.commits.length ? [`git revert --no-edit ${shortList([...held.commits].reverse())} now, and git cherry-pick ${shortList(held.commits)} once ${ahead} is prepared`] : []),
        ...(held.uncommitted.length ? [`git stash push --include-untracked -- ${held.uncommitted.join(' ')} now, and git stash pop once ${ahead} is prepared`] : [])
      ] : [];
      throw new SingularityFlowError(
        `Phase '${phase.id}' is artifact-only, but application source or tests changed after generation ${phase.generation} was published: `
        + `${changedPaths.join(', ')}. `
        + (takeOut.length ? `No earlier code step owns them; ${ahead} will deliver them. Take them out of ${phase.id}: ${takeOut.join('; ')}. Then submit the unchanged ${phase.id} generation again.`
          : `Move them to the code step that owns them, then submit the unchanged ${phase.id} generation again. ${described.text}`),
        {
          code: 'PHASE_SOURCE_CHANGED_AFTER_PUBLICATION',
          details: {
            workId: workflow.workItem.id,
            phase: phase.id,
            generation: phase.generation,
            generationCommit: exactGenerationCommit,
            changedPaths,
            crossPhase: change,
            gate: described.gate,
            ...(takeOut.length ? { codeStepAhead: ahead, heldCommits: held.commits, heldUncommitted: held.uncommitted, recoveryCommands: takeOut } : {})
          }
        }
      );
    }
  }
  const publicationBranch = workflowPublicationBranch(root, workflow);
  const publicationMode = workflowPublicationMode(config, workflow);
  const exactPublicationCommit = exactGenerationCommit
    && (publicationMode === 'off' || remoteContains(root, exactGenerationCommit, config.git?.remote ?? 'origin', publicationBranch))
    ? exactGenerationCommit
    : null;
  if (publicationMode !== 'off' && !exactPublicationCommit) await enforceSequenceGate(root, workflow, 'remoteGeneration', 'submit for approval', {
    requestedPhase: phase.id,
    reason: exactGenerationCommit ? `Generation commit ${exactGenerationCommit.slice(0, 8)} is not published.` : 'No generation commit is available on the configured remote.'
  });
  const registration = await inspectRequiredArtifactRegistration(root, config, workflow, phase, {
    generationCommit: exactGenerationCommit
  });
  if (registration.status === 'unsafe') {
    const digest = (value) => value ? `sha256:${String(value).replace(/^sha256:/, '')}` : 'unavailable';
    if (registration.reason === 'authored-content-changed') {
      throw new SingularityFlowError(
        `Phase ${phase.id} authored content changed after its published generation. `
        + `Published authored hash: ${digest(registration.publishedAuthoredSha256)}. `
        + `Current authored hash: ${digest(registration.currentAuthoredSha256)}. `
        + `The change was not registered or submitted. Publish it as the next generation with `
        + `singularity-flow phase publish ${phase.id}, then submit; or inspect the other routes with `
        + `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id}.`,
        {
          code: 'ARTIFACT_AUTHORED_BYTES_CHANGED_AFTER_PUBLICATION',
          details: {
            path: registration.path,
            generation: phase.generation,
            generationCommit: registration.generationCommit,
            publishedAuthoredSha256: registration.publishedAuthoredSha256,
            currentAuthoredSha256: registration.currentAuthoredSha256,
            nextAction: `singularity-flow phase publish ${phase.id}`,
            recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id}`
          }
        }
      );
    }
    throw new SingularityFlowError(
      `Phase ${phase.id} required artifact cannot be safely reconciled (${registration.reason}). `
      + `SFlow did not rewrite or register it. Inspect the recovery path with: `
      + `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id}.`
      + (registration.inputFindings?.length ? `\n- ${registration.inputFindings.join('\n- ')}` : ''),
      {
        code: 'ARTIFACT_MANAGED_CONTENT_INVALID',
        details: {
          path: registration.path,
          reason: registration.reason,
          recoveryCommand: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id}`
        }
      }
    );
  }
  if (registration.status === 'repairable') repairRequiredArtifactRegistration(workflow, phase, registration, session);
  phase.generationCommit = exactGenerationCommit;
  phase.publicationCommit = exactPublicationCommit;
  if (testCommandEpochRun && phaseUsesWorkInterval(phase)
    && workflow.workIntervals?.current?.status === 'reconciled') {
    const retainedBaseline = await verifyWorkIntervalBaseline(root, config, workflow, {
      phaseId: phase.id, itemDirectory: workDir(root, config, workflow.workItem.id), allowReconciled: true
    });
    await ensureWorkIntervalBaseline(root, config, workflow, { phaseId: phase.id,
      itemDirectory: workDir(root, config, workflow.workItem.id), itemRelative: workDirRelative(config, workflow.workItem.id),
      sourceBaseCommit: retainedBaseline.sourceBaseCommit, baselineTag: testCommandEpochRun.suffix });
  }
  if (codeDeliveryRequired && !runChecks) {
    throw new SingularityFlowError(
      `Phase ${phase.id} is a code delivery and cannot skip validation commands.`,
      { code: 'CODE_DELIVERY_TESTS_CANNOT_BE_SKIPPED' }
    );
  }
  const retainedRisk = codeDeliveryRequired ? await retainedStoryTestRisk(root, config, workflow, phase, {
    operation: 'submit', generation: phase.generation, selection: trpSelection?.selection }) : null;
  if (retainedRisk && testCommandEpochRun) {
    throw new SingularityFlowError('A runner amendment requires fresh passing validation; retained failed or unavailable validation cannot satisfy its new epoch.', { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' });
  }
  const riskRun = codeDeliveryRequired && !retainedRisk
    ? await beginStoryTestRiskRun(root, config, workflow, phase, { commands: requiredTestCommands, selection: trpSelection?.selection }) : null;
  // A verification step whose workflow asks for it also runs the repository's own tests.
  const repositoryTests = !codeDeliveryRequired && runChecks
    ? await (await import('../verification/repository-tests.mjs')).verificationRepositoryTests(root, config, workflow, phase, deliveryCommands)
    : null;
  if (repositoryTests?.commands.length) deliveryCommands = [...deliveryCommands, ...repositoryTests.commands];
  const pins = codeDeliveryRequired && !retainedRisk && runChecks
    ? await (await import('../test-command-pins.mjs')).gateTestCommandPins(root, config, workflow, phase, requiredTestCommands, phase.deliveryEvidence) : null;
  // A runner amendment's epoch needs its own fresh run of the whole command.
  if (codeDeliveryRequired && !retainedRisk && !testCommandEpochRun) {
    requiredTestCommands = await storyScopedTestCommands(root, workflow, phase, requiredTestCommands, phase.deliveryEvidence);
    const selected = new Map(requiredTestCommands.filter((command) => command.testScope?.files).map((command) => [command.id, command]));
    deliveryCommands = deliveryCommands.map((command) => (command?.kind === 'test' && selected.get(command.id)) || command);
  }
  phase.checks = runChecks ? await qualityChecks(root, phase, config, workflow,
    retainedRisk ? deliveryCommands.filter(command => command?.kind !== 'test') : deliveryCommands, {
    // Assign provenance from trusted resolution identity, never a field supplied by configuration.
    commandProvenance: new Map(deliveryCommands.map((command) => [command,
      trpSelection && command?.kind === 'test' ? command.provenance
        : testCommandProvenance(phase, command)])),
    reuseUnchanged: mayReuseUnchangedRuns(workflow) && !testCommandEpochRun,
    ...(pins ? { pinOf: (id) => pins.attempt(id).pin?.sha256 ?? null } : {}),
    onMutation: (ran) => recordRunsBeforeRefusal(root, workDirRelative(config, workflow.workItem.id), codeDeliveryRequired ? requiredTestCommands : repositoryTests?.commands ?? [], ran, { pins,
      purpose: testCommandEpochRun ? 'epoch' : 'submission', workId: workflow.workItem.id, phaseId: phase.id, generation: phase.generation, epoch: testCommandEpochRun?.suffix ?? null,
      delivery: codeDeliveryRequired ? phase.deliveryEvidence : null })
  }) : [];
  if (retainedRisk) {
    const observation = retainedRisk.observation;
    phase.checks.push({ id: observation.obligationId, command: externalCommandText(requiredTestCommands[0], 0),
      kind: 'test', requirement: 'required', status: observation.observedOutcome, exitCode: observation.processExitCode,
      sourceCommit: observation.sourceRevision, sourceTreeSha256: observation.sourceManifestSha256,
      startedAt: observation.startedAt, completedAt: observation.completedAt,
      trpObservationSha256: observation.recordSha256,
      evidenceUse: observation.observedOutcome === 'failed' ? 'reused' : 'retained-unavailable-attempt',
      stdout: '', stderr: observation.diagnostics.join('\n') });
  }
  if (!codeDeliveryRequired) {
    // What the repository's tests ran is an attempt like a code step's, so nothing reruns it on the same code [TCE:REQ-080].
    for (const command of repositoryTests?.commands ?? []) {
      const check = phase.checks.find((entry) => entry.id === command.id);
      if (check && !check.unchangedRun && check.status !== 'skipped-warning') await recordTestAttempt(root, workDirRelative(config, workflow.workItem.id), {
        command, check, purpose: 'submission', workId: workflow.workItem.id, phaseId: phase.id, generation: phase.generation });
    }
    // These phases validate the process exit, not a fresh structured test receipt. An exit-zero
    // command may emit no report at all, so it cannot authorize discarding a preserved report.
    for (const check of phase.checks) await restoreTransientQualityResult(check);
    if (repositoryTests?.commands.length) await admitTestAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
  }
  const repositoryTestFailures = repositoryTests
    ? (await import('../verification/repository-tests.mjs')).settleRepositoryTestChecks(phase.checks, repositoryTests) : [];
  const testExecutions = [];
  const attemptHistory = [];
  const submittedAttempts = new Map();
  if (codeDeliveryRequired) {
    const recordedRuns = new Map();
    let refusal = null;
    const otherFailed = [];
    try {
      // As at publication: every suite's attempt is recorded before any result is judged [E2G-016].
      for (const command of requiredTestCommands) {
        if (retainedRisk && command.id === retainedRisk.observation.obligationId) continue;
        const check = phase.checks.find((entry) => entry.id === command.id);
        const recorded = check ? await recordTestAttempt(root, workDirRelative(config, workflow.workItem.id), {
          command, check, purpose: testCommandEpochRun ? 'epoch' : 'submission', workId: workflow.workItem.id,
          phaseId: phase.id, generation: phase.generation, epoch: testCommandEpochRun?.suffix ?? null, delivery: phase.deliveryEvidence, ...pins?.attempt(command.id)
        }) : null;
        recordedRuns.set(command.id, recorded);
        if (recorded) attemptHistory.push({ commandId: command.id, attemptId: recorded.attempt.attemptId, status: recorded.attempt.status });
      }
      for (const command of requiredTestCommands) {
        const check = phase.checks.find((entry) => entry.id === command.id);
        if (retainedRisk && command.id === retainedRisk.observation.obligationId) {
          const observation = retainedRisk.observation;
          const receiptPath = `${workDirRelative(config, workflow.workItem.id)}/context/test-recovery/runs/${observation.id}.json`;
          testExecutions.push({ commandId: command.id, receiptPath,
            receiptSha256: createHash('sha256').update(canonicalJson(observation)).digest('hex'),
            kind: 'phase-validation-observation', status: observation.observedOutcome, affectedRoots: command.affectedRoots });
          continue;
        }
        let parsed;
        let receipt;
        const recorded = recordedRuns.get(command.id);
        // Past the first refusal a suite is only read for the report: nothing can let the step through now.
        if (refusal) {
          otherFailed.push((await import('../test-run-risk.mjs')).otherFailedTest(workflow, phase, command, recorded?.attempt, { at: nowIso() }));
          continue;
        }
        let runRisk = null;
        try {
          if (!check || check.status === 'skipped-warning') {
            throw new SingularityFlowError(`Required test command '${command.id}' was skipped.${skippedReason(check)}`, { code: 'CODE_TEST_SKIPPED' });
          }
          if (['blocked', 'failed'].includes(check.status)) {
            const observation = riskRun ? await captureStoryTestRiskObservation(root, config, workflow, phase,
              { run: riskRun, check, result: qualityCommandResults.get(check) }) : null;
            if (observation) await assertStoryTestRiskGate(root, config, workflow, { phaseId: phase.id,
              operation: 'submit', generation: phase.generation, observationSha256: observation.recordSha256 });
            // A step approver may have accepted that this command cannot run here [test-run risk].
            runRisk = observation ? null : await testRunRiskCover(workflow, phase, recorded?.attempt);
            if (!runRisk) throw await testRunRiskRefusal(workflow, phase, recorded?.attempt,
              new SingularityFlowError(`Required test command '${command.id}' was blocked.`, { code: 'CODE_TEST_FAILED' }));
          }
          if (runRisk) {
            check.testRunRisk = runRisk;
          } else {
            if (check.status !== 'passed' || check.exitCode !== 0) {
              throw new SingularityFlowError(`Required test command '${command.id}' failed.`, { code: 'CODE_TEST_FAILED' });
            }
            parsed = recorded.parsed ?? await parseTestResult(root, command, { startedAt: check.startedAt });
            if (parsed.tests.skipped > 0 && riskRun && workflow.resolution.testRecovery.enabledRiskCategories.includes('reduced-coverage')) {
              const observation = await captureStoryTestRiskObservation(root, config, workflow, phase,
                { run: riskRun, check, result: qualityCommandResults.get(check) });
              if (observation) await assertStoryTestRiskGate(root, config, workflow, { phaseId: phase.id,
                operation: 'submit', generation: phase.generation, observationSha256: observation.recordSha256 });
            }
            receipt = recorded.attempt;
            const minimumPassed = Math.max(
              parsed.minimumPassed,
              workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1
            );
            if (receipt.tests.discovered < parsed.minimumDiscovered) {
              throw new SingularityFlowError(`Required test command '${command.id}' discovered zero or too few tests.`, { code: 'CODE_TEST_ZERO_DISCOVERED' });
            }
            if (!testReceiptPassing(receipt, parsed.minimumDiscovered, minimumPassed)) {
              // Every discovered test skipped: no test executed, so the test-run risk route applies.
              runRisk = await testRunRiskCover(workflow, phase, receipt);
              if (!runRisk) throw await testRunRiskRefusal(workflow, phase, receipt,
                new SingularityFlowError(`Required test command '${command.id}' did not produce passing executable-test evidence.`, { code: 'CODE_TEST_FAILED' }));
              // The run exited 0 yet no test ran: it is recorded as not passing, carried by the decision.
              check.testRunRisk = runRisk;
              check.status = 'failed';
            } else {
              const narrowed = pins?.narrowed(receipt, 'submit');
              if (narrowed) check.testNarrowing = narrowed;
            }
          }
        } catch (error) {
          refusal = isolatedRunHint(await attachRequiredTestExecution(error, root, command, check, { workId: workflow.workItem.id }), check);
          continue;
        }
        if (runRisk) {
          // The attempt is bound like a passing one, with the decision that let it through.
          testExecutions.push({ commandId: command.id, attemptId: recorded.attempt.attemptId, receiptPath: recorded.path,
            receiptSha256: recorded.sha256, status: recorded.attempt.status, affectedRoots: command.affectedRoots,
            testRunRisk: runRisk });
          continue;
        }
        testExecutions.push({
          commandId: command.id, attemptId: receipt.attemptId, receiptPath: recorded.path,
          receiptSha256: recorded.sha256,
          status: receipt.status,
          affectedRoots: command.affectedRoots,
          ...(check.testNarrowing ? { testNarrowing: check.testNarrowing } : {})
        });
        submittedAttempts.set(command.id, receipt);
      }
      if (refusal) throw (await import('../test-run-risk.mjs')).withOtherFailedTests(refusal, otherFailed);
    } finally {
      const acceptedIds = new Set(testExecutions.map((execution) => execution.commandId));
      for (const check of phase.checks) await restoreTransientQualityResult(check, {
        accepted: acceptedIds.has(check.id)
      });
    }
    if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
      // Judged by the commands that ran, with their provenance [TCE:REQ-052].
      const uncovered = uncoveredTestDeliveryPaths(phase.deliveryEvidence, phase.sourceBoundary,
        requiredTestCommands.filter((command) => testExecutions.some((execution) => execution.commandId === command.id)));
      if (uncovered.length) {
        throw uncoveredTestPathsError(`No passing test command covers affected paths: ${uncovered.join(', ')}`, uncovered);
      }
    }
    await pins?.record(workflow, testExecutions.map((execution) => execution.commandId), { at: nowIso() });
    // The submission commits these attempts and every earlier kept attempt of the step, failed
    // ones included, so a later failure can never hide behind the pass it was retried into [E2G-016].
    attemptHistory.splice(0, attemptHistory.length,
      ...await admitTestAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id));
  }
  if (isVisualVerificationPhase(phase)) await assertVisualCoverage(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  if (isConvergencePhase(phase)) {
    await assertConvergencePublicationReady(root, config, workflow, phase);
  }
  const errors = await validatePhase(root, config, workflow, phase, {
    placeholders: !isConvergencePhase(phase),
    content: true
  });
  const validation = qualityValidationVerdict(phase.checks);
  const { failed, unavailable, unavailableRequired } = validation;
  const unacceptedFailed = failed.filter(check => (!retainedRisk
    || check.trpObservationSha256 !== retainedRisk.observation.recordSha256) && !check.testRunRisk);
  // A failing run of the repository's own tests goes to its reviewer, who returns the step to repair.
  const repositoryTestsFailed = phase.approvalPolicy?.mode !== 'none' && unacceptedFailed.length > 0
    && unacceptedFailed.every((check) => repositoryTestFailures.includes(check));
  const reviewableFailure = Boolean((phase.repairBudget || repositoryTestsFailed) && unacceptedFailed.length);
  if (unacceptedFailed.length && !reviewableFailure) errors.push(`Quality command failed: ${unacceptedFailed.map((check) => check.command).join(', ')}`);
  const unacceptedUnavailable = unavailableRequired.filter(check => (!retainedRisk
    || check.trpObservationSha256 !== retainedRisk.observation.recordSha256) && !check.testRunRisk);
  if (unacceptedUnavailable.length) {
    errors.push(`Required quality command was unavailable: ${unacceptedUnavailable.map((check) => check.command).join(', ')}`);
  }
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} is not ready:\n- ${errors.join('\n- ')}`);
  if (repositoryTestsFailed) {
    console.warn(`Warning: the repository's tests failed: ${unacceptedFailed.map((check) => check.command).join(', ')}. `
      + `${phase.id} goes to its reviewer, who cannot approve it and returns it to the step that repairs it.`);
  }
  phase.validationVerdict = validation.verdict;
  if (codeDeliveryRequired) {
    const validatedSourceTreeSha256 = await sourceTreeHash(root, config, workflow);
    const validatedTestInputSha256 = await testInputTreeHash(root, config, workflow);
    const changedAfterCheck = phase.checks.find((check) =>
      check.sourceTreeSha256 && (check.sourceTreeSha256 !== validatedSourceTreeSha256
        || (validatedTestInputSha256 && check.testInputSha256 !== validatedTestInputSha256)));
    if (changedAfterCheck) {
      throw new SingularityFlowError(
        `Quality command '${changedAfterCheck.id}' no longer describes the current source tree. `
        + 'Publish a fresh generation and rerun submission.',
        {
          code: 'QUALITY_COMMAND_SOURCE_MUTATION',
          details: {
            commandId: changedAfterCheck.id,
            beforeSha256: changedAfterCheck.sourceTreeSha256,
            afterSha256: validatedSourceTreeSha256
          }
        }
      );
    }
    const generationTree = phase.generationCommit
      ? run('git', ['rev-parse', `${phase.generationCommit}^{tree}`], { cwd: root }).stdout.trim()
      : null;
    phase.deliveryEvidence.validation = {
      sourceCommit: phase.generationCommit,
      sourceTreeSha256: validatedSourceTreeSha256,
      ...(validatedTestInputSha256 ? { testInputSha256: validatedTestInputSha256 } : {}),
      commands: deliveryCommands.map((command, index) => ({
        id: phase.checks[index]?.id ?? `quality-${index + 1}`,
        command: externalCommandText(command, index)
      })),
      checks: phase.checks.map((check) => ({ id: check.id, status: check.status,
        ...(check.testRuntime ? { testRuntime: check.testRuntime } : {}),
        ...(check.testRunRisk ? { testRunRisk: check.testRunRisk } : {}),
        sourceTreeSha256: check.sourceTreeSha256,
        ...(check.testInputSha256 ? { testInputSha256: check.testInputSha256 } : {}) })),
      status: failed.length ? 'failed' : unavailableRequired.length ? 'unavailable' : 'passed',
      validatedAt: nowIso()
    };
    phase.deliveryEvidence.status = 'ready';
    if (retainedRisk) phase.deliveryEvidence.testRecovery = {
      observationSha256: retainedRisk.observation.recordSha256, observedOutcome: retainedRisk.observation.observedOutcome,
      evidenceUse: retainedRisk.observation.observedOutcome === 'failed' ? 'reused' : 'retained-unavailable-attempt',
      disposition: 'accepted-risk', evaluationSha256: retainedRisk.evaluation.recordSha256 };
    phase.deliveryEvidence.testExecutions = testExecutions;
    phase.deliveryEvidence.attemptHistory = attemptHistory;
    const deliveryReceipt = await readJson(path.join(root, phase.deliveryEvidence.receiptPath));
    const traceabilityBindings = [];
    for (const binding of deliveryReceipt.traceability?.bindings ?? []) {
      // The command publication tied the test to (a package's end-to-end run, not its unit run) while it covers it.
      const tied = deliveryReceipt.traceability?.witnesses?.find((witness) => witness.clauseId === binding.clauseId && witness.testSource === binding.testSource)?.commandId;
      const covers = (candidate) => testCommandCoversPath(requiredTestCommands.find((command) => command.id === candidate.commandId) ?? candidate, binding.testSource);
      const execution = testExecutions.find((candidate) => candidate.commandId === tied && covers(candidate)) ?? testExecutions.find(covers);
      if (!execution) {
        throw new SingularityFlowError(
          `Acceptance clause '${binding.clauseId}' is not bound to a passing command for '${binding.testSource}'.`,
          { code: 'AC_BINDING_MISSING' }
        );
      }
      // The approved configured test commands own their affected roots, as they did at resolution.
      const module = await resolveAffectedModule(root, binding.testSource, {
        overrides: configuredTestModuleOverrides([...(phase.qualityCommands ?? []), ...(phase.storyTestCommands ?? [])])
      }).catch((error) => {
        // The deterministic direct-node fallback is an explicit root-module adapter for
        // repositories that intentionally have executable .mjs tests but no package manifest.
        // It is valid only when the passing command names the repository root as its affected root.
        if (error?.code === 'TEST_MODULE_UNCOVERED' && execution.affectedRoots.includes('.')) {
          return { root: '.', system: 'node-direct' };
        }
        throw error;
      });
      traceabilityBindings.push({
        ...binding,
        testIdentity: null,
        moduleRoot: module.root,
        commandId: execution.commandId,
        executionAssurance: 'module-executed',
        testcaseExecutionProven: false,
        assuranceNotice: 'module executed; tagged test execution not independently proven'
      });
    }
    // Each witness is judged against the submission attempt of the command that covers its file.
    const witnesses = (deliveryReceipt.traceability?.witnesses ?? []).map((witness) => ({
      ...witness,
      commandId: traceabilityBindings.find((binding) => binding.clauseId === witness.clauseId
        && binding.testSource === witness.testSource)?.commandId ?? witness.commandId ?? null
    }));
    const readyReceipt = {
      ...deliveryReceipt,
      traceability: { ...deliveryReceipt.traceability, bindings: traceabilityBindings, witnesses },
      testExecutions: testExecutions.map(({ affectedRoots, ...entry }) => ({ ...entry,
        ...(entry.kind === 'phase-validation-observation' ? { affectedRoots } : {}) })),
      ...(retainedRisk ? { testRecovery: structuredClone(phase.deliveryEvidence.testRecovery) } : {}),
      tree: {
        ...deliveryReceipt.tree,
        workingStateDigest: validatedSourceTreeSha256,
        generationCommit: phase.generationCommit,
        generationTree
      },
      status: 'ready',
      validatedAt: phase.deliveryEvidence.validation.validatedAt
    };
    const validatedReceiptPath = testCommandEpochRun
      ? posix(path.join(workDirRelative(config, workflow.workItem.id), 'context', 'code-delivery',
        `${phase.id}-gen${phase.generation}-${testCommandEpochRun.suffix}.json`))
      : phase.deliveryEvidence.receiptPath;
    await writeJson(path.join(root, validatedReceiptPath), readyReceipt);
    phase.deliveryEvidence.receiptPath = validatedReceiptPath;
    // Exposed now, judged at the end: a criterion whose own test did not pass keeps the Story from
    // completing until it passes or its risk is accepted [E2G-016, E2G-028].
    for (const witness of witnesses) {
      const result = witnessResult(witness, submittedAttempts.get(witness.commandId) ?? null);
      if (result.status !== 'met') console.warn(`Acceptance evidence: ${witness.clauseId}: ${describeWitnessResult(result)}; it does not verify the criterion.`);
    }
    phase.deliveryEvidence.receiptSha256 = createHash('sha256').update(canonicalJson(readyReceipt)).digest('hex');
    await recordTestCommandEpochValidation(root, config, workflow, phase, testCommandEpochRun);
    await refreshObservedSpecificationClaims(root, config, workflow, phase, readyReceipt);
  }
  if (phaseUsesWorkInterval(phase)) {
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const itemRelative = workDirRelative(config, workflow.workItem.id);
    const interval = workflow.workIntervals?.current;
    if (!interval || interval.phaseId !== phase.id || interval.status !== 'open') {
      throw new SingularityFlowError(
        `Phase '${phase.id}' has no open work interval. Run singularity-flow prepare ${phase.id} before changing source or submitting.`
      , { details: { nextAction: { executable: 'singularity-flow', argv: ['phase', 'enter', phase.id, '--for-agent', '--json'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
    }
    const reconciliation = await reconcileWorkInterval(root, config, workflow, {
      phaseId: phase.id,
      itemDirectory,
      requireCleanTarget: true
    });
    if (!reconciliation.decision.eligibleForSubmission) {
      const target = reconciliation.decision.escalationTarget;
      throw new SingularityFlowError(
        `Phase ${phase.id} exceeds its work interval:\n- ${reconciliation.decision.reasons.join('\n- ')}\n`
        + (target
          ? `Review the non-destructive escalation plan with singularity-flow story interval escalate --to ${target}.`
          : 'Use a stronger configured workflow before submitting.')
      );
    }
    const final = await recordFinalReconciliation(root, workflow, reconciliation, { itemRelative });
    phase.workIntervalReconciliation = {
      reconciliationSha256: final.reconciliationSha256,
      baselineSha256: final.baselineSha256,
      path: final.path,
      status: final.decision.status,
      summaryStatus: final.decision.summaryStatus,
      targetHead: final.target.head,
      summary: final.summary,
      decision: final.decision,
      baseline: final.baseline
    };
  }
  const automaticOutcome = phase.approvalPolicy.mode === 'none' || phase.approvalPolicy.mode === 'policy'
    ? decisionOutcome(workflow, phase) : null;
  const automaticUpcoming = upcomingAfterOutcome(workflow, phase, automaticOutcome);
  if (phaseRequiresCodeDelivery(automaticUpcoming)
      && (phase.approvalPolicy.mode === 'none' || phase.approvalPolicy.mode === 'policy')) {
    await assertPlannedSpecificationClaims(root, config, workflow, automaticUpcoming);
  }
  // Do not let the last phase enter human review when approval still could not complete the Story.
  // Run this only after ordinary submission validation has refreshed tests, observed claim maps,
  // conformance and interval evidence; running it earlier can mistake not-yet-recorded fresh test
  // evidence for claim-map corruption. It remains before submittedAt/status/history mutations and
  // is rerun against the exact final state inside approval.
  if (completionPhaseOf(workflow)?.id === phase.id) {
    const { assertTerminalReadiness } = await import('../evidence/terminal.mjs');
    await assertTerminalReadiness(root, config, workflow);
  }
  beginPhaseSubmission(phase, nowIso());
  // Waive only under a policy the gate can replay; any other policy leaves the phase to people.
  const waiverPolicy = supportedWaiverPolicy(phase.approvalPolicy);
  if (phase.approvalPolicy.mode === 'policy' && !waiverPolicy) {
    console.warn(`Warning: phase '${phase.id}' names approval policy '${phase.approvalPolicy.policy}', which this build cannot evaluate, so it waives nothing; the phase needs human approval.`);
  }
  const waiver = waiverPolicy ? evaluateQuickFixWaiver(root, config, workflow, phase, waiverPolicy) : null;
  if (waiver && !waiver.eligible) console.warn(`Warning: ${waiverNotAppliedMessage(phase.id, waiver)}`);
  let applicationReviewPending = false;
  if (workflow.resolution?.applicationReview?.mode === 'required' && phaseRequiresCodeDelivery(phase)) {
    try { await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'application-review.mjs')).href)).assertApplicationReviewComplete(root, config, workflow, phase); }
    catch (error) {
      if (error.code !== 'ARA_REVIEW_REQUIRED') throw error;
      // Pin the authoritative submission first. Human review must never deadlock by requiring
      // acceptance of a test packet that this same submission has not produced yet.
      applicationReviewPending = true;
    }
  }
  if (applyPhaseSubmissionDisposition(phase, {reviewableFailure,applicationReviewPending,waiver})) {
    closeWorkInterval(workflow, {
      phaseId: phase.id,
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent
    });
    resolvePhaseChangeRequests(workflow, phase, {
      at: phase.submittedAt, actor: actorKey(session.actor),
      completionDisposition: phase.approvalDisposition
    });
    const automaticRetention = !automaticOutcome || automaticOutcome.kind === 'next'
      ? await retainUnchangedPhases(root, config, workflow, phase, { at: phase.submittedAt, actor: session.actor, agent: session.agent })
      : null;
    const { upcoming, pending: automaticPending } = applyCompletionOutcome(workflow, phase, automaticOutcome, {
      at: phase.submittedAt, actor: session.actor, agent: session.agent
    });
    if (upcoming) {
      await ensureWorkIntervalBaseline(root, config, workflow, {
        phaseId: upcoming.id,
        itemDirectory: workDir(root, config, workflow.workItem.id),
        itemRelative: workDirRelative(config, workflow.workItem.id)
      });
    }
    await markIntentAmendmentRevalidated(root, config, workflow, phase, phase.submittedAt, session.actor);
    await recordApprovedScopeRevision(root, config, workflow, phase, phase.submittedAt);
    workflow.history.push(waiver?.eligible ? {
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent,
      event: 'phase-approval-waived',
      phase: phase.id,
      policyId: waiver.policyId,
      policyHash: waiver.policyHash,
      sourceCommit: waiver.sourceCommit,
      reconciliationSha256: phase.workIntervalReconciliation?.reconciliationSha256 ?? null,
      changedPathsHash: waiver.changedPathsHash,
      predicates: waiver.predicates,
      detail: `deterministic policy waiver${retentionDetail(automaticRetention)}${advanceDetail(workflow, automaticPending)}`
    } : { at: phase.submittedAt, actor: actorKey(session.actor), agent: session.agent, event: 'phase_completed_without_approval', phase: phase.id, detail: `approval mode none${retentionDetail(automaticRetention)}${advanceDetail(workflow, automaticPending)}` });
  } else {
    workflow.history.push({
      at: phase.submittedAt,
      actor: actorKey(session.actor),
      agent: session.agent,
      event: reviewableFailure ? 'phase_validation_failed' : 'phase_submitted',
      phase: phase.id,
      detail: reviewableFailure
        ? `${failed.length} quality command(s) failed; human rejection may authorize bounded repair`
        : `${phase.artifacts.length} artifacts`
    });
  }
  await updateArtifactMetadata(root, config, workflow, phase);
  await refreshRequiredArtifact(root, config, workflow, phase);
  await refreshSkillLifecycleArtifactIdentities(root, config, workflow, phase, {
    stage: 'submitted'
  });
  // A phase completed by an explicit no-approval contract or deterministic policy is still an
  // approved producer for downstream dataflow. Bind the final managed artifact bytes exactly as a
  // human approval would; otherwise an approved phase paradoxically appears "unapproved" to its
  // consumer because no artifact hash was promoted.
  if (phase.status === 'approved') {
    await registerApprovedSnapshot(root, config, workflow, phase);
    await refreshPhaseSpecificationIndex(root, config, workflow, phase);
    await settleRetainedPhases(root, config, workflow, phase.submittedAt);
  }
  if (persist && flightPlanBoundary) {
    await persistChangeFlightPlanBoundary(root, config, workflow, flightPlanBoundary);
  }
  if (persist) await saveWorkflow(root, config, workflow);
  return phase;
}
