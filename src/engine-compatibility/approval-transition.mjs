/** Native approval evaluation and transition; one shared gate for preview and recording. */
import { SingularityFlowError, run, nowIso, readJson, writeJson } from '../util.mjs';
import { assertStoryNotArchived } from '../governance-archive.mjs';
import { resolveStoryExecutionCatalog } from '../story-execution-context.mjs';
import { loadSession } from '../session.mjs';
import { assertPhaseAgentMayMutate } from '../phase-transition-routes.mjs';
import { assertPhaseGovernanceMayAdvance } from '../phase-transition-routes.mjs';
import { verifyAcceptedTestCommandAmendment } from '../story-test-command-amendment.mjs';
import { assertNoPendingPublication } from '../story-publication-pending.mjs';
import { storyPublicationPending } from '../story-publication-read.mjs';
import { assertPhaseSequence } from '../sequence.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { assertReviewCodeEvidenceFresh, phaseRequiresCodeDelivery, verifyCodeDeliveryReceipt } from '../delivery-evidence.mjs';
import { isConvergencePhase, currentPhase } from '../kernel/phase-policy.mjs';
import { assertConvergencePublicationReady } from '../convergence-context.mjs';
import { inspectPhaseArtifactQuality, artifactFindingMessage } from '../publication-preflight.mjs';
import { sourceReviewRequired } from '../source-review-policy.mjs';
import { readSourceReviewStatus } from '../source-review-lifecycle.mjs';
import { workflowPublicationBranch } from '../story-publication-binding.mjs';
import { workDirRelative, workDir } from '../story-paths.mjs';
import { verifyTestCommandEpochValidation } from '../test-command-epoch.mjs';
import { verifySkillPhaseApproval } from '../skp-phase-evidence.mjs';
import { assertStoryTestRiskGate } from '../test-recovery-runtime.mjs';
import { head, actionActor } from '../git.mjs';
import { canonicalJson } from '../records.mjs';
import { createHash } from 'node:crypto';
import { qualityValidationVerdict } from '../lifecycle-evidence-policy.mjs';
import { readRecord, phaseApprovalSummaryVersion } from '../schema-migrations.mjs';
import { applicationPathContext, closeWorkInterval, ensureWorkIntervalBaseline } from '../work-intervals.mjs';
import { requiredRepoPath } from '../story-state-validation.mjs';
import { conformanceVerdictGaps } from '../conformance-verdicts.mjs';
import { conformanceGapRefusal, upstreamIssueStates, CONFORMANCE_GAP_RULE } from '../upstream-routes.mjs';
import { conformanceEvidenceReuse } from '../conformance-readiness.mjs';
import { verifyAgentBriefsForReview } from '../agent-briefs.mjs';
import { requireApprovalAuthority, remainingRequiredAuthorities, sameApprover, eligibleApprovers, approvalRequirementsMet } from '../kernel/approval-policy.mjs';
import { evaluateApprovalChecklist, resolvedSpecificationQualityPolicy, approvalChecklistPrompt } from '../specification-gate.mjs';
import { loadActiveSpecRecords } from '../specifications.mjs';
import { evaluateWitnessMappingReview } from '../wel-review.mjs';
import { reviewBindings } from '../implementation-bindings.mjs';
import { phaseUpstream } from '../phase-upstream.mjs';
import { decisionOutcome, describeOutcome } from '../workflow-decisions.mjs';
import { recordPhaseApprovalState } from '../kernel/lifecycle-transitions.mjs';
import { retainUnchangedPhases } from '../phase-retention.mjs';
import { saveWorkflow } from '../story-state-write.mjs';
import { contextBoundaryHandoff } from '../context-policy.mjs';

/** Ends only a failed preview; the sentinel never escapes as an operation refusal. */
const APPROVAL_PREVIEW_STOP = Symbol('approval-preview-stop');

export async function evaluateNativeApproval(root, config, workflow, {
  phaseId,
  channel = 'terminal',
  actionContext = null,
  checklist = [],
  witnessMappings = [],
  bindingDecisions = [],
  actor: decisionActor = null,
  agent: decisionAgent = undefined,
  presence = null,
  preview = false
} = {}, collaborators) {
  const {
    actorKey,
    advanceDetail,
    applyCompletionOutcome,
    approvalPath,
    assertFinalCodeSpecificationCoverage,
    assertPassedCodeDeliveryInput,
    assertPlannedSpecificationClaims,
    assertQualifiedConformanceReady,
    assertRecordedHistory,
    assertSkillPhaseHostReady,
    lapsedTestRunRisk,
    logDecision,
    loopBackForDecision,
    markIntentAmendmentRevalidated,
    readArtifactText,
    recordApprovedScopeRevision,
    recordedStepCommits,
    refreshPhaseSpecificationIndex,
    refreshSkillLifecycleArtifactIdentities,
    registerApprovedSnapshot,
    repositoryArtifactSnapshot,
    resolvePhaseChangeRequests,
    retentionDetail,
    reviewHistoryCommits,
    settleRetainedPhases,
    sourceTreeHash,
    testInputTreeHash,
    testRunRiskCarried,
    upcomingAfterOutcome,
    updateArtifactMetadata,
    updateSkippedArtifactMetadata,
    validationCarriedByTestRunRisk,
    writeDecision
  } = collaborators;
  const holds = [];
  const warnings = [];
  const passed = new Set();
  const warn = (line) => (preview ? warnings.push(line) : console.warn(`Warning: ${line}`));
  const stage = async (name, check, { foundation = false, needs = [] } = {}) => {
    if (needs.some((entry) => !passed.has(entry))) return;
    try {
      await check();
      passed.add(name);
    } catch (error) {
      if (!preview || !(error instanceof SingularityFlowError)) throw error;
      holds.push(error);
      if (foundation) throw APPROVAL_PREVIEW_STOP;
    }
  };
  let phase = null;
  let session = null;
  let documentRisks = [];
  let approvedArtifactQualityRisks = [];
  let reviewArtifactSetSha256 = null;
  let submittedReview = null;
  let skillApprovalEvidence = null;
  let currentSourceTreeSha256 = null;
  let riskReference = null;
  let approvalRisk = null;
  let architectureIntentBinding = null;
  let submittedArchitectureDecision = null;
  let carriedChecks = new Set();
  let approvalQualityRisk = null;
  let actor = null;
  let key = null;
  let active = [];
  let authority = null;
  let review = null;
  let submittedWitnessMappings = [];
  let reviewedWitnessMappings = [];
  let reviewHistory = null;
  let rejectedAmendments = [];
  let decision = null;
  let reached = false;
  let approvalOutcome = null;
  try {
    await stage('entry', async () => {
      assertStoryNotArchived(root, workflow);
      if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
      session = decisionActor ? { actor: decisionActor, agent: decisionAgent ?? null } : await loadSession(root, { required: false });
    }, { foundation: true });
    await stage('agent', async () => {
      assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId ?? workflow.currentPhase], session, 'approve');
    });
    await stage('governance', async () => {
      assertPhaseGovernanceMayAdvance(workflow, workflow.phases?.[phaseId ?? workflow.currentPhase]);
    });
    await stage('test-command-amendment', async () => {
      await verifyAcceptedTestCommandAmendment(root, config, workflow);
    });
    await stage('publication', async () => {
      // A preview never publishes: it reports the retained commit that recording would first publish.
      if (!preview) await assertNoPendingPublication(root, config, workflow, 'approve');
      else if (await storyPublicationPending(root, config, workflow.workItem.id)) {
        throw new SingularityFlowError('A retained local lifecycle commit has not reached its configured remote yet; recording publishes it first.', {
          code: 'STORY_PUBLICATION_PENDING', details: { workId: workflow.workItem.id, nextAction: { command: 'singularity-flow sync', label: 'Publish the retained commit.' } } });
      }
    });
    await stage('sequence', async () => {
      phase = await assertPhaseSequence(root, workflow, 'approve', { requestedPhase: phaseId, allowedStatuses: ['awaiting_approval'] });
    }, { foundation: true });
    await stage('application-review', async () => {
      if (workflow.resolution?.applicationReview?.mode === 'required') {
        await (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'application-review.mjs')).href)).assertApplicationReviewComplete(root, config, workflow, phase);
      }
    });
    await stage('repair', async () => {
      const { assertPhaseRepairSettled } = await import('../phase-repair-journal.mjs');
      await assertPhaseRepairSettled(root, workflow, phase);
    });
    await stage('appeals', async () => {
      const { assertPhaseAppealsResolved } = await import('../phase-appeals.mjs');
      await assertPhaseAppealsResolved(root, config, workflow, phase);
    });
    await stage('document-risks', async () => {
      const { assertStoryDocumentRiskGates } = await import('../trp-document-runtime.mjs');
      documentRisks = await assertStoryDocumentRiskGates(root, config, workflow, phase, 'approve');
    });
    await stage('skill-host', async () => {
      await assertSkillPhaseHostReady(workflow, phase, 'approve');
    });
    await stage('conformance-ready', async () => {
      await assertQualifiedConformanceReady(root, config, workflow, phase, 'be approved');
    });
    await stage('code-input', async () => {
      const verifiedCodeInput = await assertPassedCodeDeliveryInput(root, config, workflow, phase);
      await assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput });
    });
    await stage('convergence', async () => {
      if (isConvergencePhase(phase)) {
        await assertConvergencePublicationReady(root, config, workflow, phase);
      }
    });
    await stage('artifact-quality', async () => {
      if (!isConvergencePhase(phase)) {
        // Submission binds exact hashes, but approval is a separate trust boundary and must also prove
        // that every reviewable document is complete now. This is intentionally content-only: source,
        // tests and machine evidence remain governed by their exact hash/schema validators below.
        const content = await inspectPhaseArtifactQuality(root, config, workflow, phase, { transition: 'approve' });
        const contentFindings = content.findings;
        approvedArtifactQualityRisks = (content.risks?.items ?? []).filter(item => item.status === 'active');
        if (contentFindings.length) {
          throw new SingularityFlowError(
            `Phase '${phase.id}' cannot be approved while review artifacts are incomplete:\n- ${contentFindings.map(artifactFindingMessage).join('\n- ')}\n`
            + `Correct the listed artifact(s), publish and submit a new generation, then review that exact evidence.`,
            {
              code: 'ARTIFACT_AUTHORING_INCOMPLETE',
              details: {
                subjectKind: 'story', workId: workflow.workItem.id, phase: phase.id,
                findings: contentFindings
              }
            }
          );
        }
      }
    });
    await stage('source-review', async () => {
      // Re-evaluate the exact retained review at the human decision boundary as well as submission.
      // A modified or superseded report cannot ride on an earlier ready verdict.
      if (sourceReviewRequired(workflow, phase.id)) {
        const review = await readSourceReviewStatus(root, config, workflow, phase.id);
        if (review.status !== 'ready') {
          // A review is made while the step is in progress, so review-source context refuses here: this
          // laptop restores the missing documents, or the step goes back to be reviewed again.
          const restore = review.status === 'documents-required' ? (review.continuation?.actions ?? []).find((entry) => entry?.command) : null;
          const nextAction = restore
            ? { command: restore.command, label: 'Restore each original document on this laptop with the exact file, then approve again; nothing about the step changes.' }
            : phase.status === 'in_progress'
              ? { command: `singularity-flow review-source context ${phase.id} --json`, skill: '/sf-review-source' }
              : { command: `singularity-flow reject ${phase.id} --work-id ${workflow.workItem.id} --fetch --reason <REASON>`, skill: '/sf-reject',
                label: `Return ${phase.id} so its independent source review can be made again while it is in progress.` };
          throw new SingularityFlowError(
            `Phase '${phase.id}' cannot be approved: the independent source review is ${review.status}.\n- `
            + (review.findings?.map((entry) => entry.message).join('\n- ') || 'Review the current source and artifact bindings.'),
            {
              code: 'SOURCE_REVIEW_REQUIRED',
              details: {
                workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
                status: review.status, findings: review.findings ?? [], nextAction,
                ...(restore ? { actions: (review.continuation?.actions ?? []).filter((entry) => entry?.command).map((entry) => ({ command: entry.command, label: entry.reason ?? null })) } : {})
              }
            }
          );
        }
      }
    });
    await stage('packet', async () => {
      const packetEntry = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
        entry.phase === phase.id && Number(entry.generation) === Number(phase.generation));
      if (!packetEntry) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' cannot be approved without an immutable review packet for generation ${phase.generation}.`,
          { code: 'STORY_REVIEW_EVIDENCE_REQUIRED' }
        );
      }
      const { readStoryReviewPacket } = await import('../story-lineage.mjs');
      ({ reviewArtifactSetSha256 } = await import('../story-lineage.mjs'));
      submittedReview = await readStoryReviewPacket(root, config, workflow, packetEntry.packetSha256);
      if (submittedReview.phase !== phase.id || Number(submittedReview.generation) !== Number(phase.generation)) {
        throw new SingularityFlowError(`Phase '${phase.id}' review packet does not bind its current generation.`, {
          code: 'STORY_REVIEW_EVIDENCE_INVALID'
        });
      }
      // A rewritten history changes the source tree too, and every later check blamed that instead.
      // The packet is found on the current history, so the step's recorded commits are what tell.
      assertRecordedHistory(root, workflow, recordedStepCommits(phase),
        { branch: workflowPublicationBranch(root, workflow), remote: config.git?.remote ?? 'origin', itemPath: workDirRelative(config, workflow.workItem.id) });
    }, { foundation: true });
    await stage('test-command-epoch', async () => {
      await verifyTestCommandEpochValidation(root, config, workflow, phase, { packet: submittedReview });
    });
    await stage('skill-evidence', async () => {
      skillApprovalEvidence = await verifySkillPhaseApproval(
        root, config, workflow, phase, submittedReview
      );
    });
    await stage('source-binding', async () => {
      // Every approval, including an artifact-only planning/specification approval, is bound to the
      // exact application tree that was submitted for review. Previously this comparison lived only
      // in the code-delivery branch below. That let a generic editor commit implementation during a
      // planning review and made the later planning approval silently absorb those source bytes.
      currentSourceTreeSha256 = await sourceTreeHash(root, config, workflow);
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(submittedReview.sourceTreeSha256 ?? ''))) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' immutable review packet has no valid application-source binding. Submit a fresh immutable review packet before approval.`,
          {
            code: 'STORY_REVIEW_SOURCE_BINDING_REQUIRED',
            details: {
              workId: workflow.workItem.id,
              phase: phase.id,
              generation: phase.generation,
              reviewPacketSha256: submittedReview.packetSha256
            }
          }
        );
      }
      if (submittedReview.sourceTreeSha256 !== currentSourceTreeSha256) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' application source or tests changed after generation ${phase.generation} was submitted. `
          + 'Approval cannot absorb implementation created during review. '
          // A code step told to move its own changes to "the appropriate code-delivery phase" had nowhere to go (2026-10-28).
          + (phaseRequiresCodeDelivery(phase)
            ? `This step delivers that code: a person who approves it returns it (singularity-flow reject ${phase.id} --reason "<why>"), and the changes are published as its next generation with fresh evidence.`
            : 'Move those changes to the appropriate code-delivery phase and submit fresh evidence.'),
          {
            code: 'STORY_REVIEW_SOURCE_CHANGED',
            details: {
              workId: workflow.workItem.id,
              phase: phase.id,
              generation: phase.generation,
              reviewPacketSha256: submittedReview.packetSha256,
              evidenceCommit: submittedReview.evidenceCommit,
              submittedSourceTreeSha256: submittedReview.sourceTreeSha256,
              currentSourceTreeSha256
            }
          }
        );
      }
    });
    await stage('test-input', async () => {
      const currentTestInputSha256 = await testInputTreeHash(root, config, workflow);
      if (currentTestInputSha256 && submittedReview.testInputSha256 !== currentTestInputSha256) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' separately hashed test inputs changed after submission. Submit a fresh review packet before approval.`,
          { code: 'STORY_REVIEW_TEST_INPUT_CHANGED' }
        );
      }
    });
    await stage('test-risk', async () => {
      riskReference = phase.deliveryEvidence?.testRecovery;
      approvalRisk = riskReference ? await assertStoryTestRiskGate(root, config, workflow, {
        phaseId: phase.id, operation: 'approve', generation: phase.generation,
        observationSha256: riskReference.observationSha256, evidenceCommit: submittedReview.evidenceCommit }) : null;
    });
    await stage('history', async () => {
      reviewHistory = await reviewHistoryCommits(root, config, workflow, phase, submittedReview, {
        reviewedRisks: async () => [approvalRisk, ...documentRisks] });
      rejectedAmendments = reviewHistory.rejectedIntentAmendments;
    }, { needs: ['document-risks', 'test-risk'] });
    await stage('amendment-decision', async () => {
      // An amendment proposed after the submission is decided first; rejecting it keeps the submission.
      if (reviewHistory.pendingIntentAmendmentProposals.length) {
        throw (await import('../approval-check.mjs')).pendingAmendmentRefusal(workflow, phase, reviewHistory.pendingIntentAmendmentProposals);
      }
    }, { needs: ['history'] });
    await stage('history-commits', async () => {
      if (reviewHistory.blocking.length) {
        // Name each commit and route an undecided intent amendment among them to its decision first.
        const { interveningCommitRefusal } = await import('../approval-check.mjs');
        throw interveningCommitRefusal(root, workflow, phase, {
          ...reviewHistory, evidenceCommit: submittedReview.evidenceCommit, currentHead: head(root)
        });
      }
    }, { needs: ['history'] });
    await stage('architecture', async () => {
      // Architecture intent was removed; a binding recorded before then is compared as recorded, never re-resolved.
      architectureIntentBinding = (phase?.generationPublications ?? []).find((entry) =>
        Number(entry.generation) === Number(phase.generation))?.architectureIntent ?? null;
      if (canonicalJson(submittedReview.submissionEvidence?.architectureIntent ?? null)
          !== canonicalJson(architectureIntentBinding)) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' review packet does not bind the architecture intent accepted by generation ${phase.generation}. Submit a fresh immutable review packet.`,
          { code: 'STORY_REVIEW_EVIDENCE_STALE' }
        );
      }
      submittedArchitectureDecision = phase.submissionArchitectureDecision
        && Number(phase.submissionArchitectureDecision.generation) === Number(phase.generation)
        ? phase.submissionArchitectureDecision.identity : null;
      if (canonicalJson(submittedReview.submissionEvidence?.architectureDecision ?? null)
          !== canonicalJson(submittedArchitectureDecision)) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' review packet does not bind the architecture decision checked at submission. Submit again.`,
          { code: 'STORY_REVIEW_EVIDENCE_STALE' }
        );
      }
    });
    await stage('artifacts', async () => {
      const currentArtifacts = [];
      for (const artifact of phase.artifacts ?? []) {
        const current = await repositoryArtifactSnapshot(root, artifact.path);
        if (artifact.exists === false && artifact.sha256 == null) {
          // A delivered removal stays approvable only while the file is still gone [E2G-010].
          if (current.exists) {
            throw new SingularityFlowError(
              `Phase '${phase.id}' removed '${artifact.path}', but it exists again. Submit a fresh generation.`,
              { code: 'STORY_REVIEW_EVIDENCE_STALE' }
            );
          }
          currentArtifacts.push({ path: artifact.path, kind: artifact.kind ?? null, sha256: null, size: artifact.size ?? null, removed: true });
          continue;
        }
        if (!current.exists || !current.sha256) {
          throw new SingularityFlowError(
            `Phase '${phase.id}' artifact '${artifact.path}' is absent or no longer a regular file. Submit a fresh generation.`,
            { code: 'STORY_REVIEW_EVIDENCE_STALE' }
          );
        }
        currentArtifacts.push({
          path: artifact.path,
          kind: artifact.kind ?? null,
          sha256: current.sha256,
          size: current.size
        });
      }
      const currentChecksSha256 = createHash('sha256').update(JSON.stringify(phase.checks ?? [])).digest('hex');
      if (submittedReview.submissionEvidence?.artifactSetSha256 !== reviewArtifactSetSha256(currentArtifacts)
        || submittedReview.submissionEvidence?.checksSha256 !== currentChecksSha256) {
        throw new SingularityFlowError(
          `Phase '${phase.id}' artifacts or quality evidence changed after submission. Submit a fresh immutable review packet.`,
          { code: 'STORY_REVIEW_EVIDENCE_STALE' }
        );
      }
    });
    await stage('validation', async () => {
      const validation = qualityValidationVerdict(submittedReview.checks ?? [], {
        required: (phase.qualityCommands ?? []).some((check) => (check.requirement ?? 'required') === 'required')
      });
      const failedChecks = validation.failed;
      // Runs a step approver accepted could not execute any test stay visible and carry the step [test-run risk].
      carriedChecks = await testRunRiskCarried(workflow, submittedReview.checks);
      const unacceptedFailed = failedChecks.filter(check => (!approvalRisk
        || check.trpObservationSha256 !== riskReference.observationSha256) && !carriedChecks.has(check));
      const unavailableRequiredChecks = validation.unavailableRequired;
      const unacceptedUnavailable = unavailableRequiredChecks.filter(check => (!approvalRisk
        || check.trpObservationSha256 !== riskReference.observationSha256) && !carriedChecks.has(check));
      if (unacceptedFailed.length || unacceptedUnavailable.length) {
        // Runs an accepted test-run risk let through stay failed; when its decision lapsed, its
        // approvers renew it instead of sending working code back for repair.
        const lapsed = await lapsedTestRunRisk(workflow, [...unacceptedFailed, ...unacceptedUnavailable]);
        throw new SingularityFlowError(
          `Phase '${phase.id}' cannot be approved because ${failedChecks.length} quality command(s) failed and ${unavailableRequiredChecks.length} required command(s) were unavailable. `
            + (lapsed ? `${lapsed.words} Otherwise reject it to an allowed repair phase.` : 'Reject it to an allowed repair phase.'),
          { code: 'PHASE_VALIDATION_FAILED', ...(lapsed ? { details: { phase: phase.id, ...lapsed.details } } : {}) }
        );
      }
    }, { needs: ['test-risk'] });
    await stage('code-delivery', async () => {
      if (phaseRequiresCodeDelivery(phase)) {
        const validation = phase.deliveryEvidence?.validation;
        const currentTree = currentSourceTreeSha256;
        if (!validation || (validation.status !== 'passed' && !(approvalRisk
          && validation.status === riskReference.observedOutcome && ['unavailable', 'failed'].includes(validation.status))
          && !await validationCarriedByTestRunRisk(workflow, validation))) {
          const lapsed = validation ? await lapsedTestRunRisk(workflow, validation.checks) : null;
          throw new SingularityFlowError(
            `Phase '${phase.id}' cannot be approved without a passing code-delivery validation receipt.${lapsed ? ` ${lapsed.words}` : ''}`,
            { code: 'CODE_DELIVERY_VALIDATION_REQUIRED', ...(lapsed ? { details: { phase: phase.id, ...lapsed.details } } : {}) }
          );
        }
        const currentTestInput = await testInputTreeHash(root, config, workflow);
        if (validation.sourceTreeSha256 !== currentTree
            || (currentTestInput && validation.testInputSha256 !== currentTestInput)) {
          throw new SingularityFlowError(
            `Phase '${phase.id}' code or tests changed after validation. Submit a fresh validated generation.`,
            { code: 'CODE_DELIVERY_VALIDATION_STALE' }
          );
        }
        const submittedChecksSha256 = createHash('sha256')
          .update(JSON.stringify(submittedReview.checks ?? []))
          .digest('hex');
        if (submittedReview.sourceTreeSha256 !== currentTree
            || submittedReview.submissionEvidence?.checksSha256 !== submittedChecksSha256
            || (submittedReview.checks ?? []).some((check) => ['failed', 'blocked'].includes(check.status)
              && !carriedChecks.has(check)
              && !(approvalRisk && check.trpObservationSha256 === riskReference.observationSha256))) {
          throw new SingularityFlowError(
            `Phase '${phase.id}' immutable review packet does not bind the currently validated source tree and passing checks.`,
            { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
          );
        }
        const receiptPath = submittedReview.submissionEvidence?.codeDelivery?.path;
        const historicalReceipt = receiptPath
          ? run('git', ['show', `${submittedReview.evidenceCommit}:${receiptPath}`], { cwd: root, allowFailure: true })
          : null;
        const receipt = historicalReceipt?.status === 0
          ? readRecord('code-delivery', historicalReceipt.stdout).record
          : null;
        if (!receipt || receipt.legacyV1) {
          // A generation published before code-delivery v2 has only the inline validation checked
          // above. It remains approvable for migration compatibility, but every generation begun by
          // this build has an intent and therefore must take the strict v2 path below.
          if (phase.generationIntent?.id) {
            throw new SingularityFlowError(
              `Phase '${phase.id}' requires a current code-delivery v2 receipt before approval.`,
              { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
            );
          }
          warn(`phase '${phase.id}' uses legacy inline code-delivery validation; regenerate to obtain v2 assurance.`);
        } else {
          const receiptSha256 = createHash('sha256').update(canonicalJson(receipt)).digest('hex');
          const carriedRuns = await testRunRiskCarried(workflow, receipt.testExecutions);
          if (receipt.status !== 'ready'
            || receiptSha256 !== submittedReview.submissionEvidence?.codeDelivery?.sha256
            || receipt.tree?.generationCommit !== phase.generationCommit
            || (receipt.testExecutions ?? []).some((execution) => execution.status !== 'passed' && !carriedRuns.has(execution)
              && !(approvalRisk && execution.kind === 'phase-validation-observation'
                && execution.status === riskReference.observedOutcome && ['unavailable', 'failed'].includes(execution.status)))) {
            throw new SingularityFlowError(
              `Phase '${phase.id}' code-delivery receipt is absent, stale, or does not contain passing test evidence.`,
              { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
            );
          }
          const committedBeforeReview = run('git', [
            'merge-base', '--is-ancestor', receipt.tree.generationCommit, submittedReview.evidenceCommit
          ], { cwd: root, allowFailure: true });
          if (committedBeforeReview.status !== 0) {
            throw new SingularityFlowError(
              `Phase '${phase.id}' immutable review evidence is not descended from its generation commit.`,
              { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
            );
          }
          const replay = await verifyCodeDeliveryReceipt(root, receipt, {
            protectedPaths: [...new Set([
              ...(config.governance?.protectedPaths ?? []),
              ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
            ])],
            configurationSource: workflow.resolution?.configurationSource,
            sourceBoundary: phase.sourceBoundary,
            symlinkPolicy: workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject',
            minimumDiscovered: workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1,
            minimumPassed: workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1,
            requireAffectedModuleCoverage: workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false,
            minimumModelAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
            cornerCasePolicy: workflow.resolution?.codeDelivery?.cornerCaseObligations ?? 'off',
            assertionAdequacyPolicy: workflow.resolution?.codeDelivery?.assertionAdequacy ?? 'off',
            sourceBindingPolicy: workflow.resolution?.plannedClaims?.mode === 'required'
              && phase.sourceBoundary !== 'test-automation'
              ? workflow.resolution?.codeDelivery?.traceability?.sourceBindings ?? 'off' : 'off',
            evidenceCommit: submittedReview.evidenceCommit,
            testRecovery: approvalRisk ? { config, workflow, operation: 'approve' } : null,
            testRunRisks: { workflow, at: nowIso() },
            pathContext: applicationPathContext(config, workflow)
          });
          if (!replay.valid) {
            throw new SingularityFlowError(
              `Phase '${phase.id}' committed code-delivery evidence no longer verifies:\n- ${replay.errors.join('\n- ')}`,
              { code: 'CODE_DELIVERY_VALIDATION_REQUIRED' }
            );
          }
        }
        const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, submittedReview.evidenceCommit);
        for (const line of coverage?.advisory ?? []) warn(line);
        approvalQualityRisk = coverage?.acceptedRisk ?? null;
      }
    }, { needs: ['source-binding', 'test-risk', 'validation'] });
    await stage('conformance-gaps', async () => {
      if (phase.requiredArtifact?.kind === 'conformance-report') {
        // An honest partial or missing verdict published and was submitted as written; approval needs a
        // person's decision on it (the terminal gate asks the same function) [owner decision 2026-10-19].
        const report = await readArtifactText(root, requiredRepoPath(config, workflow, phase));
        const approvedAt = nowIso();
        const verdictGaps = conformanceVerdictGaps(report, { workflow, phaseId: phase.id });
        const refusal = conformanceGapRefusal(workflow, phase.id, verdictGaps,
          { now: approvedAt, reused: await conformanceEvidenceReuse(root, config, workflow, phase.id, approvedAt),
            satisfied: verdictGaps.length ? await (await import('../evidence/clause-outlook.mjs')).clausesReadSatisfied(root, config, workflow) : [] });
        if (refusal) {
          // One plain sentence and the decision list first; each clause's own routes stay in details.
          const { decisionRefusalLead, phaseEndsStory } = await import('../decision-list-facts.mjs');
          const lead = decisionRefusalLead(workflow, phase.id, { gaps: refusal.gaps.map((gap) => ({ ...gap, report: phase.id })),
            issues: upstreamIssueStates(workflow, approvedAt), includeAllIssues: phaseEndsStory(workflow, phase) });
          throw new SingularityFlowError(
            `${lead ? `${lead.headline} ${lead.route}\n` : ''}Phase '${phase.id}' cannot be approved until a person decides each partial or missing clause:\n- `
            + `${refusal.lines.join('\n- ')}\n${CONFORMANCE_GAP_RULE}`,
            { code: 'CONFORMANCE_BLOCKING_VERDICTS', details: { ...refusal.details,
              ...(lead ? { decisions: { count: lead.count, headline: lead.headline }, nextAction: lead.nextAction,
                recoveryCommands: [lead.nextAction, ...refusal.details.recoveryCommands] } : {}) } }
          );
        }
      }
    });
    await stage('briefs', async () => {
      const briefReview = await verifyAgentBriefsForReview(root, workflow, phase, {
        itemRelative: workDirRelative(config, workflow.workItem.id)
      });
      if (!briefReview.valid) {
        throw new SingularityFlowError(
          `Phase ${phase.id} downstream agent-brief review failed:\n- ${briefReview.errors.join('\n- ')}`,
          { code: 'APPROVAL_AGENT_BRIEF_INVALID', details: { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation, errors: briefReview.errors } }
        );
      }
    });
    await stage('identity', async () => {
      // Approval belongs to the current person, not the phase's authoring session. Kernel-owned
      // phases deliberately end that session, and another reviewer may use a different laptop.
      // Keep any selected agent for the role restriction checked above; never manufacture or
      // persist an authoring session merely to preview the same identity the command would use.
      actor = decisionActor ?? actionActor(root);
      session = { ...(session ?? {}), actor, agent: session?.agent ?? null };
      key = actorKey(actor);
      // On a Story SF Guard requires, only a verified or excepted approval counts [SPEC-PSS-v1 REQ-030].
      const counts = await presenceCountsFor(root, workflow);
      active = phase.approvals.filter((item) => !item.invalidatedAt && item.decision === 'approved'
        && (!phase.testCommandRevalidation || item.reviewPacketSha256 === submittedReview.packetSha256) && (!counts || counts(item)));
      authority = requireApprovalAuthority(
        workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
        phase.approvalPolicy,
        actor,
        { preferredAuthorities: remainingRequiredAuthorities(phase.approvalPolicy, active) }
      );
    });
    await stage('distinct-identity', async () => {
      if (active.some((item) => sameApprover(item.actor, actor))) throw new SingularityFlowError(`${key} already approved phase ${phase.id}; approvals require distinct identities.`, { code: 'APPROVAL_IDENTITY_ALREADY_RECORDED', details: { phase: phase.id, workId: workflow.workItem.id,
        ...eligibleApprovers(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, { exclude: active.map((item) => actorKey(item.actor)) }) } });
    }, { needs: ['identity'] });
    await stage('checklist', async () => {
      /**
       * The reviewer's checklist `[SPK:REQ-060]` `[SPK:REQ-061]` `[SPK:REQ-181]` applies only
       * when the pinned phase policy requires it. Evaluate before constructing the approval so legacy
       * Stories cannot record an incomplete checklist and opted-out Stories cannot record stray answers.
       */
      review = evaluateApprovalChecklist({
        policy: resolvedSpecificationQualityPolicy(config, workflow, phase),
        decisions: checklist,
        authorities: workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
        actor
      });
      review.warnings.forEach(warn);
      if (review.errors.length) {
        const answered = new Set(checklist.map((entry) => entry.article));
        throw new SingularityFlowError(
          `Phase ${phase.id} approval is incomplete:\n- ${review.errors.join('\n- ')}\n`
          + (review.mode === 'off'
            ? `Remove --article and --checklist decisions, then retry singularity-flow approve ${phase.id}.`
            : `Record one decision for every article with singularity-flow approve ${phase.id} --article <id>=satisfied|exception|not-applicable [--article-reason TEXT], or --checklist <file.json>.`),
          // Who decides and what, not what is decided: nothing about the work needs repairing.
          { code: 'APPROVAL_CHECKLIST_INCOMPLETE', details: { workId: workflow.workItem.id, phase: phase.id, mode: review.mode,
            articles: (approvalChecklistPrompt(resolvedSpecificationQualityPolicy(config, workflow, phase))?.articles ?? [])
              .map((article) => article.id).filter((id) => !answered.has(id)) } }
        );
      }
    }, { needs: ['identity'] });
    await stage('witness-stale', async () => {
      submittedWitnessMappings = submittedReview.witnessReview?.clauseMappings ?? [];
      if (submittedWitnessMappings.length) {
        const active = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
        const currentClauses = new Map();
        for (const clause of (active.indexes ?? []).flatMap((index) => index.clauses ?? [])) {
          const digest = `sha256:${String(clause.bodySha256 ?? '').replace(/^sha256:/, '')}`;
          if (currentClauses.has(clause.id) && currentClauses.get(clause.id) !== digest) {
            throw new SingularityFlowError(
              `Witness clause '${clause.id}' is ambiguous across active specification records.`,
              { code: 'WEL_WITNESS_MAPPING_STALE' }
            );
          }
          currentClauses.set(clause.id, digest);
        }
        const stale = submittedWitnessMappings.find((mapping) =>
          currentClauses.get(mapping.clauseId) !== mapping.clauseBodySha256);
        if (stale) {
          throw new SingularityFlowError(
            `Witness mapping '${stale.mappingSha256}' no longer matches the active bytes for clause '${stale.clauseId}'. Re-submit the phase after reconciling the specification evidence.`,
            { code: 'WEL_WITNESS_MAPPING_STALE' }
          );
        }
      }
    });
    await stage('witness-review', async () => {
      // Approving accepts every submitted witness as adequate unless the reviewer decided otherwise; an
      // earlier decision on an identical witness carries forward [E2G-014].
      const witnessReview = evaluateWitnessMappingReview({
        mappings: submittedWitnessMappings,
        decisions: witnessMappings,
        prior: [...(phase.approvals ?? [])].reverse().flatMap((entry) => entry.witnessMappings ?? [])
      });
      if (!witnessReview.valid) {
        throw new SingularityFlowError(
          `Phase ${phase.id} witness review is invalid:\n- ${witnessReview.errors.join('\n- ')}\n`
          + `Decide a witness with --witness-mapping <sha256>=exception:<facet>[,<facet>] (with --witness-mapping-reason and --witness-mapping-expires) or <sha256>=not-applicable (with --witness-mapping-reason); every other witness is accepted as adequate.`,
          { code: 'WEL_WITNESS_MAPPING_UNREVIEWED' }
        );
      }
      reviewedWitnessMappings = witnessReview.decisions;
    }, { needs: ['witness-stale'] });
    await stage('decision', async () => {
      // One decision per implementation binding the step submitted [E2G-011, D7].
      const submittedBindings = phaseRequiresCodeDelivery(phase) && phase.deliveryEvidence?.receiptPath
        ? (await readJson(path.join(root, phase.deliveryEvidence.receiptPath)).catch(() => null))?.implementationBindings ?? null
        : null;
      const bindingReview = reviewBindings(submittedBindings, bindingDecisions);
      // What this approval decides over, so rework can retain it when none of it changes [E2G-021, D16].
      const upstream = await phaseUpstream(root, config, workflow, phase).catch(() => null);
      decision = {
        decision: 'approved',
        phase: phase.id,
        at: nowIso(),
        actor,
        agent: session.agent,
        authorityGroup: authority.authorityGroup,
        identityAssurance: authority.identityAssurance,
        channel,
        generation: phase.generation,
        artifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
        // `[SPK:CON-045]`: a reviewer may discuss one member, but the approval binds the whole bundle.
        // Recorded as the single hash of the complete set, so an approval cannot survive a member being
        // regenerated underneath it — the bundle it named no longer exists.
        ...(phase.artifactSet ? { artifactSet: phase.artifactSet.setId, bundleSha256: phase.artifactSet.bundleSha256 } : {}),
        reviewPacketSha256: submittedReview.packetSha256,
        ...((approvalQualityRisk || approvedArtifactQualityRisks.length) ? { qualityRisks: [
          ...(approvalQualityRisk?.items ?? []).filter(item => item.status === 'active'), ...approvedArtifactQualityRisks
        ] } : {}),
        ...(skillApprovalEvidence ? { skillEvidenceSha256: skillApprovalEvidence.evidenceSha256 } : {}),
        evidenceCommit: submittedReview.evidenceCommit,
        // Rejected amendments decided while the step waited: their commits changed nothing it reviewed.
        ...(rejectedAmendments.length ? { rejectedIntentAmendments: structuredClone(rejectedAmendments) } : {}),
        artifactSetSha256: submittedReview.submissionEvidence.artifactSetSha256,
        architectureIntent: structuredClone(architectureIntentBinding),
        architectureDecision: structuredClone(submittedArchitectureDecision),
        // Compatibility alias for consumers introduced with code-delivery v2.
        ...(phaseRequiresCodeDelivery(phase) ? { reviewEvidenceCommit: submittedReview.evidenceCommit } : {}),
        // Recorded on the decision, not on the phase: the articles are what *this reviewer* confirmed,
        // and a second approver's exceptions are their own. The checklist hash travels with them so a
        // later reader knows which version of the articles was answered.
        ...(review.mode === 'off' ? {} : { checklist: review.decisions, checklistSha256: review.checklistSha256 }),
        ...(bindingReview ? { implementationBindings: bindingReview } : {}),
        ...(reviewedWitnessMappings.length ? {
          witnessMappings: reviewedWitnessMappings,
          witnessMappingsSha256: `sha256:${createHash('sha256').update(canonicalJson(reviewedWitnessMappings)).digest('hex')}`
        } : {}),
        ...(actionContext ? { actionContext } : {}),
        ...(upstream ? { upstream } : {}),
        selfApproval: sameApprover(phase.generatedBy ?? {}, actor)
      };
    }, { needs: ['identity', 'checklist', 'witness-review'] });
    await stage('self-approval', async () => {
      if (decision.selfApproval && phase.approvalPolicy.allowSelfApproval === false) {
        throw new SingularityFlowError(`Capability and workflow policy prohibit self-approval for phase '${phase.id}'. Ask another authorized Git identity to approve this generation.`, { code: 'APPROVAL_SELF_APPROVAL_PROHIBITED', details: { phase: phase.id, workId: workflow.workItem.id,
          ...eligibleApprovers(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, { exclude: [key, actor?.email, actor?.login].filter(Boolean) }) } });
      }
    }, { needs: ['decision'] });
    await stage('planned-claims', async () => {
      const counts = await presenceCountsFor(root, workflow);
      const prospectiveApprovals = [...(phase.testCommandRevalidation ? active : phase.approvals.filter((item) => !counts || counts(item))), decision];
      reached = approvalRequirementsMet(phase.approvalPolicy, prospectiveApprovals);
      approvalOutcome = reached ? decisionOutcome(workflow, phase) : null;
      const upcomingForApproval = reached ? upcomingAfterOutcome(workflow, phase, approvalOutcome) : null;
      if (phaseRequiresCodeDelivery(upcomingForApproval)) {
        await assertPlannedSpecificationClaims(root, config, workflow, upcomingForApproval);
      }
    }, { needs: ['decision'] });
  } catch (error) {
    if (error !== APPROVAL_PREVIEW_STOP) throw error;
  }
  // Every check passed: the card (with the verified packet's SF Guard labels), then the approver's
  // touch, over the final record [SPEC-PSS-v1 M2, SPEC-SFG-v1 AC-008].
  if (!preview && presence && decision) {
    const cardLines = submittedReview?.attribution ? (await import('../presence/attribution.mjs')).attributionCardLines(submittedReview.attribution) : [];
    await (await import('../presence/person-records.mjs')).attachPersonPresence(presence, decision, { cardLines });
  }
  return { holds, warnings, ready: !holds.length, config, phase, session, key, decision, reached, approvalOutcome,
    rejectedIntentAmendments: rejectedAmendments };
}

/** The approval-counting predicate SF Guard gives a Story, or null when it does not apply. */
async function presenceCountsFor(root, workflow) {
  return workflow.resolution?.presence ? (await import('../presence/person-records.mjs')).presenceCountsFor(root, workflow) : null;
}

export async function approveNativePhase(root, config, workflow, options = {}, collaborators) {
  const {
    actorKey,
    advanceDetail,
    applyCompletionOutcome,
    approvalPath,
    assertFinalCodeSpecificationCoverage,
    assertPassedCodeDeliveryInput,
    assertPlannedSpecificationClaims,
    assertQualifiedConformanceReady,
    assertRecordedHistory,
    assertSkillPhaseHostReady,
    lapsedTestRunRisk,
    logDecision,
    loopBackForDecision,
    markIntentAmendmentRevalidated,
    readArtifactText,
    recordApprovedScopeRevision,
    recordedStepCommits,
    refreshPhaseSpecificationIndex,
    refreshSkillLifecycleArtifactIdentities,
    registerApprovedSnapshot,
    repositoryArtifactSnapshot,
    resolvePhaseChangeRequests,
    retentionDetail,
    reviewHistoryCommits,
    settleRetainedPhases,
    sourceTreeHash,
    testInputTreeHash,
    testRunRiskCarried,
    upcomingAfterOutcome,
    updateArtifactMetadata,
    updateSkippedArtifactMetadata,
    validationCarriedByTestRunRisk,
    writeDecision
  } = collaborators;
  const { persist = true } = options;
  const checked = await evaluateNativeApproval(root, config, workflow, { ...options, preview: false }, collaborators);
  const { phase, session, key, decision, reached, approvalOutcome } = checked;
  config = checked.config;
  recordPhaseApprovalState(phase,decision,{key,reached});
  let approvalPending = null;
  let retention = null;
  if (reached) {
    closeWorkInterval(workflow, {
      phaseId: phase.id,
      at: decision.at,
      actor: key,
      agent: session.agent
    });
    const resolved = resolvePhaseChangeRequests(workflow, phase, { at: decision.at, actor: key });
    if (resolved.length) decision.resolvedChangeRequests = resolved;
    let upcoming = null;

    if (approvalOutcome?.kind === 'loop') {
      // Going back is rework: the approved facts and the pinned rule chose it, and the approver
      // saw that before approving. It reopens the range exactly as a rejection would.
      await loopBackForDecision(root, config, workflow, phase, approvalOutcome, {
        at: decision.at, actor: session.actor, agent: session.agent, channel: decision.channel,
        authorityGroup: decision.authorityGroup, identityAssurance: decision.identityAssurance
      });
      logDecision(workflow, { outcome: approvalOutcome, at: decision.at, actor: session.actor, agent: session.agent });
    } else {
      if (!approvalOutcome || approvalOutcome.kind === 'next') {
        retention = await retainUnchangedPhases(root, config, workflow, phase, { at: decision.at, actor: session.actor, agent: session.agent });
      }
      ({ upcoming, pending: approvalPending } = applyCompletionOutcome(workflow, phase, approvalOutcome, {
        at: decision.at, actor: session.actor, agent: session.agent
      }));
      await updateSkippedArtifactMetadata(root, config, workflow, approvalOutcome);
    }
    if (upcoming) {
      // Gated with every other durable write here. Under `persist: false` the caller owns
      // persistence, and the publication unit's `phase-approved` branch writes this baseline inside
      // the transaction instead.
      if (persist) {
        await ensureWorkIntervalBaseline(root, config, workflow, {
          phaseId: upcoming.id,
          itemDirectory: workDir(root, config, workflow.workItem.id),
          itemRelative: workDirRelative(config, workflow.workItem.id)
        });
      }
    }
    // A phase the decision sent back is not settled, so it cannot revalidate an amendment yet.
    if (approvalOutcome?.kind !== 'loop') {
      await markIntentAmendmentRevalidated(root, config, workflow, phase, decision.at, session.actor);
      await recordApprovedScopeRevision(root, config, workflow, phase, decision.at);
    }
  }
  workflow.history.push({ at: decision.at, actor: key, agent: session.agent, event: decision.selfApproval ? 'phase_self_approved' : 'phase_approved', phase: phase.id, detail: reached ? `threshold reached${approvalOutcome?.kind === 'loop' ? `; ${describeOutcome(workflow, approvalOutcome)}` : `${retentionDetail(retention)}${advanceDetail(workflow, approvalPending)}`}` : 'approval recorded' });
  if (persist) {
    // A partial threshold decision must not rewrite the artifact under review. Doing so made the
    // next reviewer see different bytes and invalidated the immutable submission packet even
    // though no authored content changed. The workflow and decision receipt record partial votes;
    // managed artifact metadata is rendered only once the threshold is actually reached.
    if (reached) {
      await updateArtifactMetadata(root, config, workflow, phase);
      await registerApprovedSnapshot(root, config, workflow, phase);
      await refreshSkillLifecycleArtifactIdentities(root, config, workflow, phase, {
        stage: 'approved', decision
      });
      await refreshPhaseSpecificationIndex(root, config, workflow, phase);
      for (const retainedPhase of await settleRetainedPhases(root, config, workflow, decision.at)) {
        await writeJson(approvalPath(root, config, workflow.workItem.id, retainedPhase.id), {
          schemaVersion: phaseApprovalSummaryVersion(retainedPhase.approvals), phase: retainedPhase.id, decisions: retainedPhase.approvals
        });
      }
    }
    await writeDecision(root, config, workflow, phase, decision);
    await saveWorkflow(root, config, workflow);
  }
  const next = reached ? currentPhase(workflow) : phase;
  const contextBoundary = reached
    ? contextBoundaryHandoff(workflow.resolution.contextPolicy, phase.id, {
      nextPhase: next?.id ?? null,
      complete: workflow.status === 'closed'
    })
    : null;
  return { phase, next, approval: { approvedBy: key, ...decision }, reached, contextBoundary, decision: approvalOutcome ?? null };
}
