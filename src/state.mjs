import { formatCommandRouteLines } from './model-free-commands.mjs';
import { resolvedPhasePolicy, currentPhasePolicy, resolutionPolicySha256, storyHistoryCommits, initialWorkflowRecord, verifiedInitialPolicyAnchor, committedResolutionPolicySha256, committedResolutionPolicy, PROSPECTIVE_SKILL_AMENDMENT } from './story-policy-anchor.mjs';
import { validateId, statusPath, legacyPendingPublicationPath, storyStatusMarkdown, saveWorkflow } from './story-state-write.mjs';
export { validateId, statusPath, storyStatusMarkdown, saveWorkflow };
import { workflowPublicationMode, workflowPublicationBranch, storyLedgerSummary } from './story-publication-binding.mjs';
export { workflowPublicationBranch };
import { repairRetainedPublication, assertNoPendingPublication, TRANSITION_REPAIR_SWITCH } from './story-publication-pending.mjs';
export { assertNoPendingPublication };
import { validateWorkflow, requiredRepoPath } from './story-state-validation.mjs';
export { validateWorkflow };
import { commitAndPublish, stepActionLogger } from './story-publication-service.mjs';
export { commitAndPublish };
export { validatePhase, refreshPhaseSpecificationIndex, refreshSkillLifecycleArtifactIdentities, registerApprovedSnapshot, settleRetainedPhases, updateArtifactMetadata, writeDecision };
import { assertStoryNotArchived } from './governance-archive.mjs';
import { normalizeCurrentWorkflow } from './story-state-normalization.mjs';
import { workDir, workDirRelative, workflowPath, workflowBranchNames, workflowBranchAllowed } from './story-paths.mjs';
export { workDir, workDirRelative, workflowPath, workflowBranchNames, workflowBranchAllowed } from './story-paths.mjs';
import { loadWorkflow, attachLegacyGovernedRoots } from './story-workflow-read.mjs';
export { loadWorkflow } from './story-workflow-read.mjs';
import { pinnedResolutionVerification } from './pinned-policy-read.mjs';
export { pinnedResolutionVerification } from './pinned-policy-read.mjs';
import { storyPublicationPending } from './story-publication-read.mjs';
export { storyPublicationPending } from './story-publication-read.mjs';
import {
  convergencePhaseOf, intentAmendmentSource, isConformancePhase, isConvergencePhase, isVisualVerificationPhase, scopeStepOf,
  stepResponsibilities
} from './phase-roles.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { phaseCorrectionTargets } from './phase-finding-policy.mjs';
import { reservePreparedDocumentSuccessor } from './prepared-document-successor.mjs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gateTestEnvironmentModule, normalizeTestRuntime, testRuntimeEnvironment, testRuntimeIdentity } from './test-runtime.mjs';
import { baselineDeferralAllowed, baselineObservationPending, intakeBaselineChoice } from './intake-baseline.mjs';
import os from 'node:os';
import path from 'node:path';
import { nodeTestReporterEnvironment } from './verification/node-test-observation.mjs';
import { prepareInferredSwiftTestReports } from './verification/swift-reports.mjs';
import { pathToFileURL } from 'node:url';
import {
  SingularityFlowError, ensureSecureRepositoryDirectory, exists, gitHeadIsUnborn, gitReadOutput, invariant,
  nowIso, posix, readJson, repoRelative, run, secureRepositoryPath, snapshot, stateFingerprint, truncate,
  writeBytes, writeJson, writeText
} from './util.mjs';
import { validatePortableWorkId } from './work-id.mjs';
import { storyTestReadinessDocument } from './story-test-readiness-document.mjs';
import { detectBaseStory, inheritFromBaseStory } from './story-base-lineage.mjs';
import { initialTestRecoveryAgreement, normalizeTestRecoveryPolicy, prepareTestRecoveryIntake } from './test-recovery-intake.mjs';
import { authorizeTrpIntake, materializeTrpIntake, qualifiedTrpIntakeDecisions } from './test-recovery-admission.mjs';
import { appendTrpRecord, appendTrpOriginalBaseline, readTrpRecord, readTrpRepairEvidence, readTrpReadinessCheckpoint, readTrpOriginalBaseline } from './test-recovery-store.mjs';
import { assertTrpFeatureAdmission, completeTrpReadinessRepair } from './test-recovery-repair.mjs';
import { assertTrpRepairCohortRetained, inspectTrpRepairScope } from './test-recovery-repair-scope.mjs';
import { trpDigest } from './test-recovery-policy.mjs';
import { assertStoryTestRiskGate, beginStoryTestRiskRun, captureStoryTestRiskObservation,
  retainedStoryTestRisk, verifiedStoryTestRiskReviewCommits } from './test-recovery-runtime.mjs';
import { trpCaseInventoryDeclaration, trpExecutionEnvironment, trpNativeReportCapture } from './test-recovery-adapters.mjs';
import { inspectRepositoryReadinessReceipt, loadRepositoryTestBaseline } from './initialization/runtime-readiness.mjs';
import {
  actionActor, artifactChangeInventory, branch, changedFiles, commitIsAncestor, commitsTouchingSince, committedChangedPaths, headTreeEntries, refHead, exactChangedPathsBetweenObjects, exactFileAtObject, exactRemoteBranchObservationAsync, gitCommonDir, governedCommitIdentity, head, identity,
  publicationPushOutcome, pushCommitToBranchAsync, refreshStalePublishedIndex, remoteContains, shallowBoundaryCommit, untrackedFiles
} from './git.mjs';
import {
  WORKFLOW_PATH, assertWorkTypeStartable, loadDefinition, normalizeArtifactTemplateCompatibility, normalizeSequenceGates,
  normalizeSessionPolicy, renderArtifactTemplate, resolveWorkType, snapshotResolution
} from './config.mjs';
import { loadSession } from './session.mjs';
import { buildArtifactSidecar, serializeArtifactSidecar, sidecarRelativePath } from './artifact-sidecar.mjs';
import { createAgentBriefs, planAgentBriefs, verifyAgentBriefsForReview } from './agent-briefs.mjs';
import {
  applyInputsBlock, collectInputs, extractInputsBlock, inputReadinessFindings, phaseInputsNotReadyError, recordInputs,
  renderInputsBlock, resolvedPhaseInputs, verifyInputsIntegrity, workflowInputsMode
} from './inputs.mjs';
import { prepareRemoteOutputs, updateRemoteOutputRenderedHashes } from './agents.mjs';
import {
  assertPhaseSequence, enforceSequenceGate, phaseExplicitlyReopened, phaseNeedsGeneration, phasePublicationCommandForMode
} from './sequence.mjs';
import { assertPhasePublicationReadiness } from './phase-publication-readiness.mjs';
import { answeredMarkerHashes, resolvedClarificationPolicy } from './clarifications.mjs';
import {
  artifactSetDiff, catalogArtifactSet, disclosureLines, memberRoot, resolvedArtifactSet,
  unpublishableRequiredArtifactSetMembers
} from './artifact-sets.mjs';
import {
  citedArticleIds, constitutionIndex, constitutionPin, loadConstitution, validateCitations
} from './constitution.mjs';
import {
  approvalChecklistPrompt, evaluateApprovalChecklist, evaluateSpecificationGate, markerSummary,
  resolvedSpecificationQualityPolicy, specificationGateDiagnostics
} from './specification-gate.mjs';
import {
  beginTelemetryCapture, collectCopilotUsage, phaseTelemetrySummary, recordPhaseTelemetry, telemetryCaptureGap
} from './telemetry.mjs';
import { amendmentRetentionCandidates, retainUnchangedPhases } from './phase-retention.mjs';
import { retainedByRule } from './evidence/equivalence-rules.mjs';
import { forwardAmendmentDecision, nextForwardAmendmentProposal, pendingAmendmentRevalidations, pendingForwardAmendments } from './forward-amendments.mjs';
import { phaseUpstream } from './phase-upstream.mjs';
import { contextBoundaryHandoff, normalizeContextPolicy } from './context-policy.mjs';
import {
  approvalRequirementsMet, assertApprovalPolicyAttainable, DEFAULT_APPROVAL_AUTHORITY, normalizeApprovalAuthorities,
  eligibleApprovers, normalizeApprovalSecurity, remainingRequiredAuthorities, requireApprovalAuthority,
  sameApprover
} from './approval-authority.mjs';
import { assertSourceBoundary, normalizeSourceBoundary } from './source-boundary.mjs';
import { classifySupportingChange } from './supporting-changes.mjs';
import { assertIntentAmendmentAcknowledged, pendingIntentAmendmentAcknowledgement, sourceReviewRequired } from './source-review-policy.mjs';
import { assertPhaseAgentMayMutate } from './phase-actor-policy.mjs';
import { assertPhaseGovernanceMayAdvance } from './phase-governance-routing.mjs';
import { readSourceReviewStatus } from './source-review-lifecycle.mjs';
import {
  assertReviewCodeEvidenceFresh, evaluateCodeDeliveryPreflight, phaseRequiresCodeDelivery, resolveDeliveryQualityCommands,
  reviewRepairTarget, storyMergedBaseChanges, testCommandProvenance, uncoveredTestDeliveryPaths,
  verifyCodeDeliveryReceipt
} from './delivery-evidence.mjs';
import { generationSkillForPhase, pinCodeDeliveryTask, storyTestScope, TEST_SCOPES } from './code-delivery-policy.mjs';
import { pendingCodeSubmissionEvidence } from './code-submission-evidence.mjs';
import { resolveTrpDeliverySelection } from './trp-delivery-selection.mjs';
import { prospectiveTestCommandAmendment, verifyAcceptedTestCommandAmendment } from './story-test-command-amendment.mjs';
import { beginTestCommandEpochValidation, recordTestCommandEpochValidation, verifyTestCommandEpochValidation } from './test-command-epoch.mjs';
import { directCopilotSkill } from './copilot-guidance.mjs';
import {
  beginCodeGeneration, consumeGenerationIntent, persistGenerationPublicationRecord,
  publishedGenerationCommit, verifyOpenGenerationIntent
} from './generation-boundary.mjs';
import { conformanceVerdictGaps } from './conformance-verdicts.mjs';
import { CONFORMANCE_GAP_RULE, conformanceGapRefusal, reopenAuthorityStep, upstreamIssueStates } from './upstream-routes.mjs';
import { conformanceEvidenceReuse, inspectPhaseQualifiedConformance, withSelfApprovalDisclosures, withVerdictSummary } from './conformance-readiness.mjs';
import { runQualityCommand, withoutHostSurfaceVariables } from './quality-command-runner.mjs';
import { classifyRequiredTestFailure, requiredTestFailureExamples } from './test-execution-diagnostics.mjs';
import {
  ENVIRONMENT_IDENTIFIER, loadEnvironmentDeclaration, validateEnvironmentQualityCommandCatalog
} from './environment-declaration.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import { createLedgerIntent, ledgerLog, ledgerStatus, reconcileLedger, refreshLedgerRemoteView } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { storyLifecycleProgress } from './session-roster.mjs';
import { currentSchemaVersion, phaseApprovalSummaryVersion, readRecord } from './schema-migrations.mjs';
import { compareRepositoryIdentity } from './repository-change-set.mjs';
import {
  applyCapabilityPolicyToWorkResolution,
  assertCapabilitySource,
  resolveLifecycleCapability
} from './capability-context.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { verifyGateRecoveryReopenPlan } from './gate-recovery.mjs';
import {
  clearPendingPublication,
  completePendingStoryBranchPromotion,
  ensurePendingRevisionAttestation,
  hasPendingPublication,
  isPendingStoryBranchPromotion,
  activePublicationRefusal,
  livePreparedPublicationOwner,
  localPendingPublicationPath,
  readPendingPublication,
  recoverPreparedPublication,
  remoteBranchHolds,
  retainedPublicationOutcome,
  verifyPendingPublicationCandidateAuthority,
  verifyPendingPublicationCommit,
  writePendingPublication,
} from './publication-pending.mjs';
import { publicationReworkRefNamespace, restorePublicationPreimage } from './publication-recovery.mjs';
import { withSubjectLock } from './subject-lock.mjs';
import {
  capabilityPublicationEntrySha256, capabilityPublicationPlanSha256,
  publishCapabilityRepositoriesDurably,
  verifyCapabilityPublicationRecoveryPlan
} from './capability-publication-recovery.mjs';
import { configuredRemoteAuthority, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { prefetchRemoteBranchObservation, takeRemoteBranchObservation } from './remote-observation-prefetch.mjs';
import { executeGitQuery } from './git-query.mjs';
import { LIFECYCLE_EVENT, lifecycleEvent, projectedLedgerIntentFile, recordPublicationProjection } from './lifecycle-event.mjs';
import { lifecycleAuthority } from './sda/story-branch-authority.mjs';
import { captureAggregateRecovery, restoreAggregateRecovery } from './aggregate-recovery.mjs';
import { validateDocumentPublicationTree } from './document-publication.mjs';
import {
  prepareRevisionPublicationSelection, verifyPreparedRevisionPublicationSelection
} from './revision/publication-selection.mjs';
import { assertNoInteractiveRevisionPublication } from './revision/publication-adapter.mjs';
import {
  deliverStepActions, releaseWaitingStepActions, runStepActionsAfterTransition, stepActionWarning, storyUsesStepActions
} from './step-action-delivery.mjs';
import { assertRequiredStepActionsRecorded, storyRequiresStepActions } from './step-action-receipts.mjs';
import { repositoryLogger } from './logging.mjs';
import { deliverLifecycleNotifications, warnNotificationFailures } from './notifications.mjs';
import {
  approvedStoryApprovalAuthorities, inspectApprovedSkillPackage,
  readConfigurationSource, resolveApprovedStoryWorkType
} from './configuration-branch.mjs';
import { buildDesignSourceSet, classifyDesignSourceCandidates, approvedDesignSourceBinding } from './design-sources.mjs';
import { verifyMcpEvidence, verifyPhaseMcpRequirements } from './mcp-evidence.mjs';
import { assertMcpPhaseReadiness } from './mcp-readiness.mjs';
import { assertVisualCoverage } from './visual-coverage.mjs';
import { planRowsOf } from './plan-amendments.mjs';
import {
  buildSpecIndex, changedRepositoryPaths, clauseReferences, deriveObservedClaimMap, derivePlannedClaimMap, planSupportingFiles, validatePlannedEvidenceTypes,
  evaluateSpecAcceptance, evaluateSpecCoverage, extractClauses, isSpecificationDefinitionPhase, mergePlannedClaimRecords,
  codeCoverageEnforcement, loadActiveSpecRecords, loadBoundActiveSpecRecords, normalizeClaimMap, normalizeSpecPolicy,
  readBoundSpecificationClaimMap,
  predecessorSpecClauses, plannedClaimsForObservedPhase
} from './specifications.mjs';
import { activeClauseCapsule } from './active-clause-capsule.mjs';
import { phasePlansDelivery, plannedDeliveryCodeSteps, scaffoldPlanningRows } from './phase-authoring-contract.mjs';
import { addMissingSections, artifactTokens, requiredArtifactSections } from './artifact-required-sections.mjs';
import { acceptedClauses, recordScopeRevision, staleClausesOf } from './scope/revisions.mjs';
import { reviewBindings } from './implementation-bindings.mjs';
import { codeCandidateScope, outsideEveryCandidate } from './candidate-scope.mjs';
import { candidateIsolationNeed, importIsolatedReport, materializeCandidate } from './candidate-isolation.mjs';
import { sourcePathPolicy, isSeparatelyHashedTestInput } from './source-path-policy.mjs';
import {
  hydrateImpactPlan, impactImplementationGate, initializeStoryImpact, invalidateImpactReceipt
} from './impact.mjs';
import { evaluateQuickFixWaiver, supportedWaiverPolicy, waiverNotAppliedMessage } from './quick-fix-policy.mjs';
import {
  applicationChangeSetProjection, applicationPathContext, closeWorkInterval, ensureWorkIntervalBaseline,
  isApplicationChangePath, isApplicationPath,
  isGeneratedOutputPath, isTransientTestResultPath, phaseUsesWorkInterval, reconcileWorkInterval,
  recordFinalReconciliation, verifyWorkIntervalBaseline
} from './work-intervals.mjs';
import { operationContext } from './operation-context.mjs';
import { normalizeQualityGateMode, qualityRiskStatus } from './phase-quality-risk.mjs';
import {
  evaluateExternalCommandForModelMode, externalCommandText, normalizeExternalCommand, withCommandLiteralEnvironment
} from './external-command-policy.mjs';
import { assertProducerAllowed, buildGenerationAuthorship, normalizeAuthorshipOptions, phasePublicationCommand } from './manual-authorship.mjs';
import { consumeRepairAttempt, repairBudgetPhaseForRejection } from './repair-budget.mjs';
import {
  advanceCompletedPhase, cancelledStoryRefusal, clearApprovalDisposition, clearDecisionState, completionPhaseOf,
  nextPhaseAfterSkillAmendment, reopenPhaseRange, resetDecisionRounds, resetPhaseRangeForRework
} from './lifecycle-transitions.mjs';
import {
  assertChoiceKeepsDependencies, decisionFedBy, decisionInputsHint, decisionOutcome, describeOutcome,
  normalizeDecisionInputValues, pendingDecisionRecord, recordedDecisionValues, resolveDecisionChoice
} from './workflow-decisions.mjs';
export { completionPhaseOf, nextPhaseAfterSkillAmendment } from './lifecycle-transitions.mjs';
import { qualityValidationVerdict } from './lifecycle-evidence-policy.mjs';
export { qualityValidationVerdict } from './lifecycle-evidence-policy.mjs';
import { mcpTargetOriginServers, storyStartTargetOrigin } from './mcp-target.mjs';
import { referenceRevision, registerReference } from './harness-imports.mjs';
import {
  assertAstLifecycleGate, evaluateAstLifecycleGate, persistAstLifecycleReceipt,
  requireAstLifecycleReceipt
} from './ast-lifecycle.mjs';
import {
  evaluateChangeFlightPlanBoundary, persistChangeFlightPlanBoundary
} from './change-flight-plan.mjs';
import { normalizeTokenEconomy } from './token-economy.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { buildWelEnrollment, validateWelEnrollment } from './wel-policy.mjs';
import {
  captureWorkflowSnapshot, captureWorkflowSnapshotAmendment, finalizeDraftWorkflowSnapshot,
  verifyWorkflowSnapshot, verifyRejectedSkillVersionReviews
} from './workflow-snapshots.mjs';
import {
  referenceRepositoryContextMarkdown, storyReferenceRepositories, verifyReferenceRepositories,
  writeReferenceRepositoryManifest
} from './reference-repositories.mjs';
import {
  assertAutoCandidateMatches, autoCandidatePublicationFromEnvironment,
  observeAutoCandidateWorktree
} from './auto/auto-candidate.mjs';
import {
  configuredTestModuleOverrides, normalizeRequiredTestCommand, parseTestResult,
  resolveAffectedModule, runEnvironmentSha256, structuredTestCommandRequiredError, testCommandCoversPath, testReceiptPassing
} from './code-delivery-tests.mjs';
import { admitTestAttempts, recordRunsBeforeRefusal, recordTestAttempt, unchangedTestRun } from './verification/attempts.mjs';
import { describeWitnessResult, witnessResult } from './verification/witness-results.mjs';
import { parseVerificationContracts } from './verification/contracts.mjs';
import { assertPlannedTestsRunnable, assertStoryBaselineDisposition, sealStoryTestPolicy } from './verification/test-policy.mjs';
import { evaluateWitnessMappingReview } from './wel-review.mjs';
import {
  buildRepositoryChangeSet, buildRepositoryTreeChangeSet, evaluateProtectedPaths,
  repositoryCaseInsensitivePaths
} from './repository-change-set.mjs';
import { assertNoHiddenWorktreeChanges, withoutConfiguredFilters } from './worktree-fingerprint.mjs';
import {
  artifactFindingMessage, authoredArtifactFingerprint, authoredArtifactText,
  inspectPhaseAuthoredReviewContent, inspectPhaseArtifactQuality, inspectRequiredArtifactText, requiredArtifactRepoPath,
  repairPreparedArtifactMetadata,
  validatePhaseAuthoredReviewContent as validatePhaseAuthoredReviewContentPreflight
} from './publication-preflight.mjs';
import { artifactBytesAreText, artifactTextCheckoutMatches } from './artifact-review-read.mjs';
import {
  assertConvergencePublicationReady, loadVerifiedConvergenceProjection
} from './convergence-context.mjs';
import {
  resolveStoryExecutionCatalog, resolveStoryExecutionContext, storyExecutionVerified
} from './story-execution-context.mjs';
import { resolveStorySkillPackage } from './story-execution-context.mjs';
import { needsAcceptedPhaseInterpretation } from './phase-semantics.mjs';
import {
  verifySkillPhaseApproval, verifySkillPhasePublication
} from './skp-phase-evidence.mjs';
import { planSkillAmendmentEvidence } from './skp-amendment-plan.mjs';
import { captureSkillConfigurationAncestry } from './skp-amendment-audit.mjs';
import { gateRefusal } from './evidence/gate-refusal.mjs';
import { crossPhaseChange, describeCrossPhaseChange } from './evidence/cross-phase-change.mjs';
import { obligationId } from './evidence/vocabulary.mjs';

export const CONFIG_PATH = WORKFLOW_PATH;
export const loadConfig = loadDefinition;
const DEFAULT_QUALITY_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
// Convergence is the one lifecycle boundary whose deterministic result must be acknowledged by
// an explicit `story advance --confirm`. Generic phase submission never receives this private
// symbol; only the combined confirmation-and-transition operation below can enter that path.
const CONFIRMED_CONVERGENCE_SUBMISSION = Symbol('confirmed-convergence-submission');
// Only the exact aggregate mutated by the locked publication owner may present an uncommitted
// amendment revision for validation. Ordinary readers must prove the accepted Git chain instead.
const MODEL_ASSURANCE_RANK = Object.freeze({
  unavailable: 0, 'host-observed': 1, 'provider-reported': 2, 'policy-selected': 3
});

async function assertSkillPhaseHostReady(workflow, phase, operation) {
  const pinned = workflow.resolution?.phases?.find((entry) => entry.id === phase?.id);
  if (pinned?.kind !== 'skill' && phase?.kind !== 'skill') return;
  const { diagnoseSkillHostReadiness } = await import('./skp-host-readiness.mjs');
  // M2 pins and verifies skill bytes and phase evidence, but does not grant execution authority.
  // In particular, a model host or direct CLI call cannot reinterpret the accepted SKILL.md as
  // instructions until the qualified containment and delivery-receipt boundary is installed.
  const skillId = pinned?.skillBinding?.bindingRefs?.skill?.id
    ?? pinned?.skill?.id ?? phase?.skillBinding?.bindingRefs?.skill?.id ?? phase?.skill?.id;
  throw new SingularityFlowError(
    `Cannot ${operation} skill phase '${phase.id}': the qualified skill host and delivery receipt are not installed. `
    + 'The approved Story package remains pinned; no template or live skill folder was used.',
    { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE', details: {
      phase: phase.id, operation, workId: workflow.workItem?.id,
      ...(typeof skillId === 'string' ? { skillId } : {}),
      hostReadiness: diagnoseSkillHostReadiness()
    } }
  );
}

function requiredModelAssuranceRank(value) {
  return ({ unavailable: 0, observed: 1, 'provider-reported': 2, 'policy-selected': 3 })[value] ?? 1;
}

function convergenceAdvanceRequired(workflow, details = {}) {
  const workId = workflow?.workItem?.id ?? details.workId ?? '<WORK-ID>';
  return new SingularityFlowError(
    `Convergence can be submitted only through explicit human advancement. Run singularity-flow story advance --work-id ${workId} to review the deterministic result and receive its digest-bound confirmation command.`,
    {
      code: 'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED',
      details: { workId, ...details, nextAction: `singularity-flow story advance --work-id ${workId}` }
    }
  );
}

function assertRequiredConvergenceApproval(phase) {
  if (phase?.approvalPolicy?.mode === 'required') return;
  throw new SingularityFlowError(
    `Convergence phase '${phase?.id ?? ''}' requires a non-waivable human approval after explicit advancement; approval modes 'none' and 'policy' are not permitted.`,
    {
      code: 'CONVERGENCE_HUMAN_APPROVAL_REQUIRED',
      details: { mode: phase?.approvalPolicy?.mode ?? null }
    }
  );
}

async function assertConvergenceConfirmation(root, config, workflow, phase, confirmation) {
  if (typeof confirmation !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(confirmation)) {
    throw convergenceAdvanceRequired(workflow, { phase: phase?.id ?? null });
  }
  assertRequiredConvergenceApproval(phase);
  const verified = await assertConvergencePublicationReady(root, config, workflow, phase);
  if (confirmation !== verified.snapshotSha256) {
    throw new SingularityFlowError(
      `The convergence result changed after preview. Review the current result and confirm ${verified.snapshotSha256}.`,
      {
        code: 'CONVERGENCE_ADVANCE_CONFIRMATION_STALE',
        details: {
          workId: workflow.workItem.id,
          supplied: confirmation,
          expected: verified.snapshotSha256
        }
      }
    );
  }
  return verified;
}


export function sourcePath(root, config, id) { return path.join(workDir(root, config, id), 'source.json'); }
export function userStoryPath(root, config, id) { return path.join(workDir(root, config, id), 'USER-STORY.md'); }
export function approvalPath(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', `${phase}.json`); }
export function decisionDir(root, config, id, phase) { return path.join(workDir(root, config, id), 'approvals', phase); }
export function pendingPublicationPath(root, _config, id) { return localPendingPublicationPath(root, 'story', id); }
/**
 * @param migrate `false` for read-only callers. Migration deletes a tracked file, and the snapshot
 *   coordinator's did-anything-change check fails when a capture mutates the working tree — which
 *   made the first snapshot after an upgrade error out blaming a concurrent writer that never existed.
 */

/**
 * The one identity string every governed record uses.
 *
 * Exported because a second surface needed it and the alternative was a second copy of the
 * precedence rule — the kind of duplication that stays correct until someone adds a field.
 */
export function actorKey(actor) { return actor.login ?? actor.email ?? actor.name; }




/**
 * Ask for the Story branch's remote tip that `commitAndPublish` checks before publishing, now, so
 * the answer arrives while the command's own checks run (remote-observation-prefetch.mjs).
 */
export function prefetchStoryPublicationObservation(root, config, workflow) {
  try {
    if (workflowPublicationMode(config, workflow) === 'off') return;
    const url = configuredRemoteAuthority(root, config.git?.remote ?? 'origin')?.url;
    if (url) prefetchRemoteBranchObservation(root, url, workflowPublicationBranch(root, workflow), exactRemoteBranchObservationAsync);
  } catch { /* commitAndPublish asks, and refuses, exactly as before */ }
}


function markdownValue(value) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `- ${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  return String(value);
}

function sourceSection(label, value, fallback = null) {
  const text = markdownValue(value);
  return text || fallback ? `\n## ${label}\n\n${text || fallback}\n` : '';
}

/** An attached specification slice (SPEC-SPA v1.3 §6.2): the clauses delivered, the decisions settled, the rest. */
function specificationSection(slices, inherited = false) {
  if (!Array.isArray(slices) || !slices.length) return '';
  return `\n## ${inherited ? 'Inherited specification constraints' : 'Specification slice'}\n\n${slices.map((slice) => [
    `### ${slice.revision}${slice.title ? ` — ${slice.title}` : ''}`, '',
    `Manifest \`${slice.manifestSha256}\` at state commit \`${String(slice.stateCommit ?? '').slice(0, 12)}\`.`, '',
    inherited ? 'Required constraints from the parent specification:' : 'Delivered by this Story:', '', ...(slice.clauses ?? []).map((clause) => `- ${clause.anchor} ${String(clause.text).replace(/\s+/gu, ' ')}`),
    ...(slice.decisions?.length ? ['', 'Settled decisions:', '', ...slice.decisions.map((entry) => `- ${entry.gap}: ${entry.outcome}`)] : []),
    ...(slice.originBindings?.length ? ['', 'Pinned parent links:', '', ...slice.originBindings.map(origin => '- ' + origin.revision + ' (' + origin.relationship + ')')] : []),
    ...(slice.inheritedSpecifications?.length ? ['', 'Inherited requirements (constraints, not a delivery claim):', specificationSection(slice.inheritedSpecifications, true)] : []),
    ...(slice.sources?.length ? ['', 'Supporting sources (original files stay local; upload the matching original if unavailable):', '', ...slice.sources.map(source => '- ' + source.name + ': `' + source.readCommand + '`')] : []),
    ...(slice.notThisStory?.length ? ['', 'Not this Story:', '', ...slice.notThisStory.map((entry) => `- ${entry.anchor} ${entry.firstLine}`)] : [])
  ].join('\n')).join('\n\n')}\n`;
}

function sourceMarkdown(source) {
  const details = [
    `- Source: ${source.type}`, source.url ? `- URL: ${source.url}` : null,
    source.targetOrigin ? `- Authorized target origin: ${source.targetOrigin}` : null,
    source.status ? `- Status: ${source.status}` : null,
    source.priority ? `- Priority: ${source.priority}` : null,
    source.storyPoints != null ? `- Story points: ${source.storyPoints}` : null,
    source.assignee ? `- Assignee: ${source.assignee}` : null
  ].filter(Boolean).join('\n');
  const subtasks = source.subtasks?.length ? source.subtasks.map((item) => `- ${item.key}${item.status ? ` [${item.status}]` : ''}${item.title ? ` — ${item.title}` : ''}`).join('\n') : '_None._';
  return `# ${source.key ?? source.id} — ${source.title}\n\n${details}\n`
    + sourceSection('User or audience', source.user ?? source.audience)
    + sourceSection('Description', source.description ?? source.problem, '_No description provided._')
    + sourceSection('Desired outcome', source.desiredOutcome)
    + sourceSection('Scope', source.scope)
    + sourceSection('Out of scope', source.outOfScope)
    + sourceSection('Stakeholders', source.stakeholders)
    + sourceSection('Priority and urgency', source.urgency ?? source.priority)
    + sourceSection('Constraints', source.constraints)
    + sourceSection('Dependencies', source.dependencies)
    + sourceSection('Acceptance criteria', source.acceptanceCriteria, '_Not provided._')
    + sourceSection('Risks', source.risks)
    + sourceSection('Notes', source.notes)
    + specificationSection(source.specification)
    + `\n## Subtasks\n\n${subtasks}\n`;
}

function phaseState(definition, index) {
  const requiredArtifact = structuredClone(definition.artifact);
  return {
    id: definition.id,
    label: definition.label,
    order: index,
    ...(definition.kind === 'skill' ? {
      kind: 'skill', skillBinding: structuredClone(definition.skillBinding)
    } : {}),
    defaultAgent: definition.defaultAgent ?? null,
    status: index === 0 ? 'in_progress' : 'not_started',
    requiredArtifact,
    template: definition.template,
    worldModel: structuredClone(definition.worldModel ?? {}),
    writeScope: definition.writeScope ?? 'artifact-only',
    sourceBoundary: normalizeSourceBoundary(definition.sourceBoundary, definition.id),
    comparison: structuredClone(definition.comparison ?? {}),
    mcp: structuredClone(definition.mcp ?? { requiredServers: [], requireSmoke: false, evidence: [] }),
    repairBudget: structuredClone(definition.repairBudget ?? null),
    inputs: structuredClone(definition.inputs ?? []),
    generationPolicy: structuredClone(definition.generation ?? { requirement: 'required', producer: 'agent' }),
    approvalPolicy: structuredClone(definition.approval ?? { authorities: [DEFAULT_APPROVAL_AUTHORITY], minimum: 1, rejectTo: [definition.id] }),
    qualityCommands: [...(definition.qualityCommands ?? [])],
    startedAt: index === 0 ? nowIso() : null,
    submittedAt: null,
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    generation: 0,
    generatedBy: null,
    generatedAgent: null,
    authorship: [],
    usage: [],
    telemetry: [],
    approvals: [],
    generationPublications: [],
    submissionArchitectureDecision: null,
    designSourceSets: [],
    artifactRegistrationRepairs: [],
    artifacts: [],
    checks: []
  };
}

/**
 * Operational phase policy appears twice in the aggregate: the immutable resolved definition and
 * the mutable execution state. Keep one canonical projection so a hand-edited workflow cannot
 * weaken approval, generation, scope, test, or artifact requirements by changing the latter.
 */



/**
 * The commits a read-only Story history query names, or a refusal when Git could not answer.
 *
 * These reads decide authority: no commit means a Story was never accepted, or that nothing was
 * committed after its review evidence. A failed read used to give the same empty answer, so an
 * accepted Story read as an unaccepted draft and a history Git could not walk passed the
 * intervening-commit gate. Only before the first commit is an empty history real.
 */

/**
 * What each lifecycle commit does to a step awaiting approval [SPEC-OAP M2], keyed by its event
 * type, and for a person's decision by `decision-made:<kind>`:
 * - `review-safe`: may sit between the submission and its approval once its commit verifies as
 *   exactly that kind (reviewHistoryCommits), because it changes nothing the review saw;
 * - `returns-step`: returns the step itself, so no submission is left to make stale;
 * - `refused-during-review`: refused while the step awaits approval, naming the way round;
 * - `stales-submission`: recorded, and approval then needs a fresh submission; the approval
 *   refusal names the commit.
 * A review-safe decision names each list it appends to, with that list's history event; a command
 * that records the same decision kind into any other list fails verification and stales the
 * submission. A decision kind no entry names is a workflow decision, which only follows an
 * approved step. Every event type and decision kind has one entry: the guard in
 * test/oap-m2-review-effects.test.mjs fails on a new one.
 */
export const REVIEW_EFFECTS = Object.freeze({
  [LIFECYCLE_EVENT.BINDING]: 'stales-submission',
  [LIFECYCLE_EVENT.CONFIGURATION_CHANGED]: 'stales-submission',
  [LIFECYCLE_EVENT.TEST_COMMAND_AMENDED]: 'stales-submission',
  [LIFECYCLE_EVENT.TEST_SELECTION_CONFIRMED]: 'stales-submission',
  [LIFECYCLE_EVENT.TEST_READINESS_REPAIRED]: 'stales-submission',
  // A verified review of the risk the approval relies on (verifiedStoryTestRiskReviewCommits).
  [LIFECYCLE_EVENT.TEST_RISK_ATTESTED]: 'review-safe',
  [LIFECYCLE_EVENT.TEST_RISK_ACCEPTED]: 'review-safe',
  [LIFECYCLE_EVENT.TEST_RISK_REVOKED]: 'review-safe',
  [LIFECYCLE_EVENT.ARTIFACT_GENERATED]: 'stales-submission',
  [LIFECYCLE_EVENT.APPROVAL_REQUESTED]: 'stales-submission',
  // Another approver's approval of the same submission.
  [LIFECYCLE_EVENT.PHASE_APPROVED]: 'review-safe',
  [LIFECYCLE_EVENT.PHASE_REJECTED]: 'returns-step',
  // Proposing, rejecting and acknowledging only add amendment records (approval-check.mjs): an
  // undecided proposal holds the approval until a person decides it, a rejected one passes with its
  // rejection as one pair, and an acknowledgement passes on its own. The approval that installs an
  // amendment reopens the step awaiting approval.
  [LIFECYCLE_EVENT.INTENT_AMENDMENT_PROPOSED]: 'review-safe',
  [LIFECYCLE_EVENT.INTENT_AMENDMENT_APPROVED]: 'returns-step',
  [LIFECYCLE_EVENT.INTENT_AMENDMENT_REJECTED]: 'review-safe',
  [LIFECYCLE_EVENT.INTENT_AMENDMENT_ACKNOWLEDGED]: 'review-safe',
  [LIFECYCLE_EVENT.SKILL_AMENDMENT_PROPOSED]: 'stales-submission',
  [LIFECYCLE_EVENT.SKILL_AMENDMENT_APPROVED]: 'stales-submission',
  [LIFECYCLE_EVENT.SKILL_AMENDMENT_REJECTED]: 'stales-submission',
  [LIFECYCLE_EVENT.WORKFLOW_REOPENED]: 'stales-submission',
  [LIFECYCLE_EVENT.REWORK_ROLLED_FORWARD]: 'stales-submission',
  [LIFECYCLE_EVENT.SEQUENCE_OVERRIDE]: 'stales-submission',
  // Only the exact Auto human-boundary checkpoint of this submission, or a document upload offered
  // only to other steps (approval-check.mjs), verifies; other evidence stales it.
  [LIFECYCLE_EVENT.EVIDENCE_RECORDED]: 'review-safe',
  // A document fetch offered only to other steps, and a child-branch link, each verify as their exact
  // record change (approval-check.mjs); any other synchronization or link stales the submission.
  [LIFECYCLE_EVENT.EXTERNAL_SYNCHRONIZED]: 'stales-submission',
  [LIFECYCLE_EVENT.BRANCH_LINKED]: 'stales-submission',
  [LIFECYCLE_EVENT.TELEMETRY_RECORDED]: 'stales-submission',
  [LIFECYCLE_EVENT.PROJECTION_RECONCILED]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_CLASSIFIED]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_OPTED_OUT]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_EXPOSURE_RECORDED]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_EVIDENCE_COLLECTED]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_EVIDENCE_IMPORTED]: 'stales-submission',
  [LIFECYCLE_EVENT.IMPACT_FINALIZED]: 'stales-submission',
  [LIFECYCLE_EVENT.WORK_CANCELLED]: 'stales-submission',
  [LIFECYCLE_EVENT.WORK_COMPLETED]: 'stales-submission',
  [LIFECYCLE_EVENT.ADHOC_LANDED]: 'stales-submission',
  [LIFECYCLE_EVENT.DESIGN_SOURCE_PROMOTED]: 'stales-submission',
  'decision-made:applicability': { effect: 'review-safe', lists: { applicability: 'applicability_decided' } },
  'decision-made:scope': { effect: 'review-safe', lists: { scopeDispositions: 'scope_decided' } },
  'decision-made:completeness': { effect: 'review-safe', lists: { completenessReviews: 'completeness_reviewed' } },
  'decision-made:plan': { effect: 'review-safe', lists: { planAmendments: 'plan_amended' } },
  'decision-made:risk': { effect: 'review-safe', lists: { riskDecisions: 'risk_decided' } },
  // A step approver's test-run risk decision, revocation or renewal (`decision test-risk`).
  'decision-made:test-risk': { effect: 'review-safe', lists: { testRunRisks: 'risk_decided' } },
  // A step approver's acceptance of a narrowed test run, or its revocation (`decision test-narrowing`).
  'decision-made:test-narrowing': { effect: 'review-safe', lists: { testNarrowings: 'narrowing_decided' } },
  // A step approver's reuse of an earlier step's recorded test run, or its revocation (`decision evidence-reuse`).
  'decision-made:evidence-reuse': { effect: 'review-safe', lists: { evidenceReuses: 'evidence_reuse_decided' } },
  // A change of which tests the Story's gates run (`story test-policy scope`): what was recorded stays as it was.
  'decision-made:test-scope': { effect: 'review-safe', lists: { testScopeChanges: 'test_scope_changed' } },
  // A visual step approver's decision that one of its screen sizes does not apply, or its revocation (`decision visual-profile`).
  'decision-made:visual-profile': { effect: 'review-safe', lists: { visualProfileDecisions: 'visual_profile_decided' } },
  'decision-made:witness-exception': { effect: 'review-safe', lists: { witnessExceptionRenewals: 'witness_exception_renewed' } },
  // Members the approved configuration added to the Story's own groups (approval-check.mjs verifies the commit).
  'decision-made:approver-refresh': { effect: 'review-safe', lists: { approverRefreshes: 'approvers_refreshed' } },
  'decision-made:quality-risk': { effect: 'review-safe', lists: { qualityRiskDecisions: 'quality_risk_decided' } },
  'decision-made:witness': { effect: 'review-safe', lists: { witnessRecords: 'witness_recorded' } },
  'decision-made:upstream-issue': { effect: 'review-safe',
    lists: { upstreamIssues: 'upstream_issue_raised', upstreamIssueDecisions: 'upstream_issue_decided' } },
  'decision-made:forward-amendment': { effect: 'review-safe', lists: { amendmentRevalidations: 'amendment_revalidated' } },
  // It changes what the submitted review ran (TEST_COMMAND_DECISION_DURING_REVIEW names returning the step).
  'decision-made:test-command': 'refused-during-review',
  'decision-made:phase-appeal': 'stales-submission',
  'decision-made:evidence-contract-correction': 'stales-submission',
  'decision-made:target-origin': 'stales-submission',
  'decision-made:workflow': 'refused-during-review'
});

/** Each list a review-safe decision appends to, with its history event and decision kind. */
const REVIEW_SAFE_DECISION_LISTS = Object.freeze(Object.entries(REVIEW_EFFECTS)
  .filter(([key, entry]) => key.startsWith('decision-made:') && entry?.effect === 'review-safe')
  .flatMap(([key, entry]) => Object.entries(entry.lists).map(([list, event]) => Object.freeze({
    list, event, decision: key.slice('decision-made:'.length)
  }))));

/**
 * One single-parent governed commit's Story state on either side of it, or null when it is not one
 * or cannot be read. `ownPaths` are the files every such commit writes: workflow.json, STATUS.md and,
 * with the ledger on, the ledger intent of its own event, which must be new and exact.
 */
export function governedStateChange(root, config, workflow, commit) {
  const identity = governedCommitIdentity(root, commit);
  if (identity?.parents.length !== 1 || !identity.eventSha256) return null;
  const [parent] = identity.parents;
  const item = workDirRelative(config, workflow.workItem.id);
  const stateFile = `${item}/workflow.json`;
  let changed;
  try { changed = exactChangedPathsBetweenObjects(root, parent, identity.commit); } catch { return null; }
  if (!changed.includes(stateFile)) return null;
  let before;
  let after;
  try {
    before = JSON.parse(exactFileAtObject(root, parent, stateFile)?.toString('utf8') ?? 'null');
    after = JSON.parse(exactFileAtObject(root, identity.commit, stateFile)?.toString('utf8') ?? 'null');
  } catch { return null; }
  if (!before || !after) return null;
  const intentFile = projectedLedgerIntentFile(item, after.publicationProjections?.at(-1));
  if (intentFile && changed.includes(intentFile.path)) {
    try {
      if (exactFileAtObject(root, parent, intentFile.path)
        || recordSha256(JSON.parse(exactFileAtObject(root, identity.commit, intentFile.path)?.toString('utf8') ?? 'null'))
          !== recordSha256(intentFile.intent)) return null;
    } catch { return null; }
  }
  return {
    identity, parent, item, changed, before, after,
    ownPaths: [stateFile, `${item}/STATUS.md`, ...(intentFile ? [intentFile.path] : [])],
    event: after.publicationProjections?.at(-1)?.event ?? null
  };
}

/** Whether a state change touches no top-level key but `keys`. */
export function stateChangesOnly({ before, after }, keys) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].every((key) =>
    keys.includes(key) || recordSha256(before[key] ?? null) === recordSha256(after[key] ?? null));
}

/**
 * The screenshot a sign-off may commit with its record: its own visual file in the Story's evidence
 * folder, with exactly the bytes the record binds. Null for anything else, so the rest fails closed.
 */
export function witnessEvidenceFile(item, record, committedBytes) {
  const file = record?.file;
  if (record?.method !== 'visual' || typeof file !== 'string' || !file.startsWith(`${item}/evidence/`)
      || file.split('/').some((part) => !part || part === '.' || part === '..') || !committedBytes) return null;
  return `sha256:${createHash('sha256').update(committedBytes).digest('hex')}` === record.sha256 ? file : null;
}

/**
 * Whether a commit is exactly one review-safe decision (REVIEW_EFFECTS), such as an applicability
 * decision [E2G-005]: a person recording why a left-out responsibility does not apply changes
 * nothing a review saw, so it may sit between a phase's submission and its approval. Anything more
 * in the commit fails closed.
 */
function applicabilityDecisionCommit(root, config, workflow, commit, workflowTaskDeltaSafe) {
  const change = governedStateChange(root, config, workflow, commit);
  if (!change) return false;
  const { identity, before, after } = change;
  // Each review-safe decision appends to its own list only.
  const kind = REVIEW_SAFE_DECISION_LISTS.find(({ list }) => recordSha256(before[list] ?? null) !== recordSha256(after[list] ?? null));
  // With the ledger on, the decision also adds the ledger intent of its own event. A sign-off also
  // commits the screenshot it binds when that image sits in the Story's evidence folder, with exactly
  // the bytes its record names: what a person looked at, never product source (outcome review).
  const witnessed = kind?.list === 'witnessRecords' ? after.witnessRecords?.at(-1) : null;
  const evidence = witnessed && change.changed.includes(witnessed.file)
    ? witnessEvidenceFile(change.item, witnessed, exactFileAtObject(root, identity.commit, witnessed.file)) : null;
  if (change.changed.some((file) => !change.ownPaths.includes(file) && file !== evidence)) return false;
  if (!kind || !workflowTaskDeltaSafe(change.before, change.after)
      || !stateChangesOnly(change, [kind.list, 'history', 'publicationProjections', 'taskOperations'])) return false;
  // Each list keeps what it had and gains exactly one entry; earlier decisions only gain a withdrawal.
  const appendsOne = (key) => {
    const prior = before[key] ?? [];
    const next = after[key] ?? [];
    return Array.isArray(next) && next.length === prior.length + 1
      && recordSha256(next.slice(0, prior.length).map((entry) => key === kind.list ? { ...entry, withdrawnAt: undefined } : entry))
        === recordSha256(prior.map((entry) => key === kind.list ? { ...entry, withdrawnAt: undefined } : entry));
  };
  if (![kind.list, 'history', 'publicationProjections'].every(appendsOne)) return false;
  if (after.history.at(-1)?.event !== kind.event) return false;
  const event = after.publicationProjections.at(-1)?.event ?? null;
  return Boolean(event)
    && event.type === LIFECYCLE_EVENT.DECISION_MADE
    && event.payload?.decision === kind.decision
    && event.subject?.id === workflow.workItem.id
    && identity.eventSha256 === `sha256:${recordSha256(event)}`;
}

/**
 * The commits after `from` up to `to` when each is one human governance decision, else null.
 *
 * Auto stops where a person must decide: why an omitted responsibility does not apply, a scope
 * disposition, a risk. Each such decision is one append-only commit that changes nothing Auto
 * authored or a reviewer saw (`applicabilityDecisionCommit`), so a flight may resume over exactly
 * those. The range must be a straight line from `from`; anything else, or any other commit,
 * returns null and the flight stays stopped.
 */
export async function onlyHumanDecisionCommits(root, config, workflow, from, to) {
  if (!from || !to || from === to) return null;
  let commits;
  try {
    commits = storyHistoryCommits(root, ['rev-list', '--reverse', '--topo-order', `${from}..${to}`], 'Auto decision range');
  } catch { return null; }
  if (!commits.length) return null;
  const { workflowTaskDeltaSafe } = await import('./workflow-task.mjs');
  let parent = from;
  for (const commit of commits) {
    const identity = governedCommitIdentity(root, commit);
    if (identity?.parents.length !== 1 || identity.parents[0] !== parent) return null;
    if (!applicabilityDecisionCommit(root, config, workflow, commit, workflowTaskDeltaSafe)) return null;
    parent = commit;
  }
  return parent === to ? commits : null;
}




/** The creation commit's migrated policy identity, with the commit that holds it. */

const PINNED_RESOLUTION_VERIFICATIONS = new Map();

/**
 * Whether a Story's pinned resolution is the one it was created with, or the one its accepted
 * amendment chain produced. This is the anchor `validateWorkflow` checks before every publication;
 * read commands that decide behaviour from pinned policy, such as which skill drafts a step, check
 * it without running every other lifecycle rule.
 *
 * Loading a WFA-enrolled Story already proved its resolution against the accepted closure, so that
 * proof is reused instead of repeating a full-history search on every phase show, publish, submit
 * and approve. A Story without a snapshot is compared with its creation commit once per process for
 * each resolution it presents.
 */
export async function legacyPinnedResolutionVerification(root, config, workflow) {
  if (workflow.workflowSnapshot && storyExecutionVerified(root, config, workflow)) {
    return { verified: true, reason: null };
  }
  const key = `${path.resolve(root)}\0${workflow.workItem.id}\0${resolutionPolicySha256(workflow.resolution)}\0${canonicalJson(workflow.workflowSnapshot ?? null)}`;
  if (!PINNED_RESOLUTION_VERIFICATIONS.has(key)) {
    PINNED_RESOLUTION_VERIFICATIONS.set(key, await verifyPinnedResolution(root, config, workflow));
  }
  return PINNED_RESOLUTION_VERIFICATIONS.get(key);
}

async function verifyPinnedResolution(root, config, workflow) {
  if (Number(workflow.workflowSnapshot?.revision ?? 1) > 1) {
    try {
      const status = await verifyWorkflowSnapshot(root, config, workflow, { requireAccepted: true });
      if (status.enrolled) return { verified: true, reason: null };
    } catch (error) {
      return { verified: false, reason: `Workflow snapshot: ${error.message}` };
    }
  }
  try {
    const creation = committedResolutionPolicy(root, config, workflow.workItem.id);
    // In a shallow clone the oldest commit that adds the Story record may be only the clone's
    // boundary, not its creation; WFA-enrolled Stories already refuse to load from such history.
    if (creation && shallowBoundaryCommit(root, creation.commit)) {
      return { verified: false, reason: 'Story history is shallow, so its creation commit cannot be proven. Fetch the full history (git fetch --unshallow), then retry.' };
    }
    if (creation && creation.sha256 !== resolutionPolicySha256(workflow.resolution)) {
      return { verified: false, reason: 'Resolved Story policy differs from the immutable creation commit. Run singularity-flow validate to see the difference.' };
    }
    return { verified: true, reason: null };
  } catch (error) {
    return { verified: false, reason: `Story policy anchor: ${error.message}` };
  }
}

/** Classify WEL only from the immutable creation commit; migrated working-tree defaults never enroll. */
export function storyWelEnrollmentStatus(root, config, workId) {
  let initial;
  try { initial = initialWorkflowRecord(root, config, workId); }
  catch (error) {
    return {
      classification: 'legacy', mode: 'disabled', reason: error?.code ?? 'creation-record-unavailable',
      creationCommit: null
    };
  }
  if (!initial) return {
    classification: 'legacy', mode: 'disabled', reason: 'creation-record-unavailable', creationCommit: null
  };
  const storedVersion = initial.record?.schemaVersion ?? 1;
  if (!Number.isInteger(storedVersion) || storedVersion < 3) return {
    classification: 'legacy', mode: 'disabled', reason: `created-with-story-workflow-v${storedVersion}`,
    creationCommit: initial.commit
  };
  if (storedVersion > currentSchemaVersion('story-workflow')) return {
    classification: 'legacy', mode: 'disabled', reason: `unsupported-story-workflow-v${storedVersion}`,
    creationCommit: initial.commit
  };
  if (initial.anchor == null) return {
    classification: 'legacy', mode: 'disabled', reason: 'creation-anchor-missing',
    creationCommit: initial.commit
  };
  if (typeof initial.anchor !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(initial.anchor)) return {
    classification: 'legacy', mode: 'disabled', reason: 'creation-anchor-malformed',
    creationCommit: initial.commit
  };
  if (initial.anchor !== resolutionPolicySha256(initial.record.resolution)) return {
    classification: 'legacy', mode: 'disabled', reason: 'creation-anchor-mismatch',
    creationCommit: initial.commit
  };
  const validation = validateWelEnrollment(initial.record?.resolution?.wel);
  if (!validation.valid) return {
    classification: 'legacy', mode: 'disabled', reason: validation.reason,
    creationCommit: initial.commit
  };
  let expectedEnrollment;
  try {
    expectedEnrollment = buildWelEnrollment({
      phases: initial.record.resolution?.phases,
      codeDelivery: initial.record.resolution?.codeDelivery,
      configurationSource: initial.record.resolution?.configurationSource,
      // Reproduce the contract that was pinned at creation. A later claim-map schema bump must not
      // silently reclassify an in-flight Story merely because the current writer moved forward.
      claimMapContractVersion: initial.record.resolution.wel.claimMapContractVersion
    });
  } catch {
    return {
      classification: 'legacy', mode: 'disabled', reason: 'component-policy-invalid',
      creationCommit: initial.commit
    };
  }
  if (canonicalJson(expectedEnrollment) !== canonicalJson(initial.record.resolution.wel)) return {
    classification: 'legacy', mode: 'disabled', reason: 'component-policy-mismatch',
    creationCommit: initial.commit
  };
  return {
    classification: 'enrolled',
    mode: initial.record.resolution.wel.mode,
    reason: null,
    creationCommit: initial.commit,
    enrollment: structuredClone(initial.record.resolution.wel)
  };
}

export function storyArtifactMetadata(workflow, phase) {
  return {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    phase: phase.id,
    generation: phase.generation,
    status: phase.status,
    generatedBy: phase.generatedBy,
    generatedAgent: phase.generatedAgent,
    authorship: [...(phase.authorship ?? [])].reverse().find((record) => record.generation === phase.generation) ?? {
      schemaVersion: 1, producer: 'legacy-unspecified', channel: 'legacy', governedAgentContext: null,
      kernelModel: { invoked: false, status: 'unavailable', invocationIds: [] },
      externalAiUse: { value: 'unknown', status: 'unavailable' }, source: null
    },
    sourceCommit: phase.sourceCommit ?? null,
    generationCommit: phase.generationCommit ?? null,
    publicationCommit: phase.publicationCommit ?? null,
    configSha256: workflow.resolution.configSha256,
    sourceSha256: workflow.resolution.sourceSha256 ?? null,
    template: workflow.resolution.templates[phase.id],
    inputs: phase.inputContext ?? null,
    designSources: {
      sets: phase.designSourceSets ?? [],
      approved: [...(phase.approvals ?? [])].reverse().find((approval) => !approval.invalidatedAt && approval.designSourceSet)?.designSourceSet ?? null
    },
    remoteAgent: phase.agentContext ?? null,
    clarification: [...(phase.clarifications ?? [])].reverse().find((record) => record.generation === phase.generation) ?? null,
    telemetry: phase.telemetry ?? [],
    remoteOutputs: (phase.remoteOutputs ?? []).map((output) => ({
      agent: output.agent,
      resource: output.resource,
      target: output.target,
      url: output.url,
      sourceSha256: output.sourceSha256,
      generation: output.generation
    })),
    usage: phase.usage,
    sequenceOverrides: (workflow.sequenceOverrides ?? []).filter((override) =>
      override.requestedPhase === phase.id || override.before?.currentPhase === phase.id),
    // SKP's post-approval raw output and bundle hashes are recorded in the decision/aggregate,
    // but cannot be embedded in the primary artifact's own managed metadata: doing so would
    // change the bytes they hash and create an impossible self-referential digest.
    approvals: phase.approvals.map((approval) => {
      const {
        skillOutputIdentityVersion, skillApprovedOutputs, skillApprovedBundleSha256,
        ...metadataApproval
      } = approval;
      return metadataApproval;
    }),
    selfApproval: phase.approvals.some((approval) => approval.selfApproval && !approval.invalidatedAt),
    conformanceTree: phase.conformanceTree ?? null
  };
}

export function artifactMetadataBlock(metadata) {
  return `<!-- singularity-flow:metadata\n${JSON.stringify(metadata, null, 2)}\n-->`;
}

async function updateArtifactMetadata(root, config, workflow, phase) {
  const file = path.join(workDir(root, config, workflow.workItem.id), phase.requiredArtifact.path);
  if (!(await exists(file))) return;
  const bytes = await readFile(file);
  // A binary artifact (PDF, DOCX, PNG) never carries the comment; its step record holds the metadata.
  if (!artifactBytesAreText(bytes)) return;
  const text = bytes.toString('utf8');
  const block = artifactMetadataBlock(storyArtifactMetadata(workflow, phase));
  const pattern = /^<!-- singularity-flow:metadata\r?\n[\s\S]*?\r?\n-->/;
  let updated = pattern.test(text) ? text.replace(pattern, block) : `${block}\n\n${text}`;
  const lf = updated.replaceAll('\r\n', '\n');
  // Freeze the same governed text that Git will retain, before its registration/review hashes
  // are captured. Otherwise a mixed editor draft can publish, yet its submission packet names
  // bytes that no commit ever contained. No user filter or alternate encoding is executed here.
  if (updated !== lf && !/[\r\0\uFFFD]/u.test(lf) && !lf.startsWith('\uFEFF')
      && artifactGitNormalizesText(root, requiredRepoPath(config, workflow, phase))) updated = lf;
  await writeText(file, updated);
  // Managed metadata is part of the durable artifact bytes. Any lifecycle transition that rewrites
  // it must keep an existing registration in lockstep, otherwise a later submit compares the new
  // engine-owned bytes with the pre-transition digest and incorrectly reports user tampering. Do
  // not create a registration during preparation: first registration remains the scanner's job.
  await refreshRequiredArtifact(root, config, workflow, phase, { registerIfMissing: false });
}



export async function createWorkflow(root, config, {
  id, title, source, baseBranch, baseCommit = null, baseRemote = null,
  repositoryId = null,
  canonicalBranch = id, workType, agent, resolved, capabilityId = null,
  capabilityMapSha256 = null,
  referenceRepositories = [],
  repositoryReadiness = null,
  readinessBaseline = 'reuse',
  testExecutionMode = 'changed-and-affected',
  qualityGateMode = 'hard',
  readinessRepositories = [],
  repositoryBases: suppliedRepositoryBases = null,
  repositoryBaseSources = null,
  testRecoveryPlan = null,
  executionOrigin = null,
  approvedConfigurationSnapshot = null,
  baselineFailures = null
} = {}) {
  validateId(config, id);
  assertStoryNotArchived(root, { workItem: { id, baseBranch, baseRemote } });
  intakeBaselineChoice(readinessBaseline);
  normalizeQualityGateMode(qualityGateMode);
  // Prove the configured storage boundary before any capability materialization or generated
  // artifact can create files beneath it. A symlinked Story root is never a repository namespace.
  await secureRepositoryPath(root, config.workItemRoot ?? 'singularity/work-items', {
    label: 'Story state root'
  });
  // Story creation does not switch branches. Capture this mutable repository fact once so the
  // aggregate, lineage, diagnostic, and history all bind to the same observed branch without four
  // redundant Git processes or a mixed answer if an external checkout races this operation.
  const currentBranch = branch(root);
  if (currentBranch !== canonicalBranch) {
    throw new SingularityFlowError(`Current branch ${currentBranch} must match the canonical Story branch ${canonicalBranch}.`);
  }
  if (await exists(workflowPath(root, config, id))) throw new SingularityFlowError(`${id} already exists. Use singularity-flow resume ${id}.`);
  // An archived workflow is not offered to a new Story, nor chosen for one (docs/SPEC-WORKFLOW-RETIREMENT-v1.md).
  const archive = await import('./workflow-archive.mjs');
  const archived = await archive.readWorkflowArchive(root);
  const selectedType = workType ?? archive.firstLiveStoryWorkflow(config.workTypes, archived) ?? Object.keys(config.workTypes)[0];
  archive.assertWorkflowNotArchived(archived, selectedType);
  // The resolver compares the digest against the exact secure byte buffer it parses, before its
  // capability-free early return. This keeps a vanished or collection-only replacement map from
  // silently downgrading a preflighted delivery Story.
  const capability = await resolveLifecycleCapability(root, {
    capabilityId,
    expectedMapSha256: capabilityMapSha256
  });
  assertCapabilitySource(capability, source);
  const readinessRepositoryId = readinessRepositories.length === 1 && readinessRepositories[0].id !== 'lifecycle'
    ? readinessRepositories[0].id : null;
  const launchRepositoryId = repositoryId ?? readinessRepositoryId ?? capability?.repositoryId ?? null;
  const { recordStoryRepositoryBases } = await import('./capability-branches.mjs');
  const repositoryBases = recordStoryRepositoryBases(suppliedRepositoryBases ?? readinessRepositories, {
    repositoryId: launchRepositoryId, baseBranch, baseCommit, baseRemote, storyBranch: canonicalBranch,
    sources: repositoryBaseSources
  });
  const selectedResolution = assertWorkTypeStartable(resolved ?? resolveWorkType(config, selectedType));
  // Pinned below for every server a step smoke-checks against it; the POC workflow requires it.
  const targetOrigin = storyStartTargetOrigin(source?.targetOrigin, selectedResolution.phases, { workType: selectedType });
  const resolution = applyCapabilityPolicyToWorkResolution(
    { ...selectedResolution, storage: structuredClone(config.storage ?? null) },
    capability
  );
  if (!TEST_SCOPES.includes(testExecutionMode)) throw new SingularityFlowError(
    `Test execution mode must be one of ${TEST_SCOPES.join(', ')}.`, { code: 'TEST_POLICY_INVALID' });
  resolution.testExecutionMode = testRecoveryPlan?.choices?.executionMode ?? testExecutionMode;
  // Caller-supplied preview JSON cannot enable TRP or weaken the approved Story policy.
  // Rebuild its exact base/workflow/receipt binding before any Story files are written.
  const trpDefinition = approvedConfigurationSnapshot?.definition ?? config;
  if (readinessBaseline === 'defer' && ((!readinessRepositories.length
      && !baselineDeferralAllowed(trpDefinition, readinessBaseline))
      || readinessRepositories.some(repository => !baselineDeferralAllowed(trpDefinition, readinessBaseline,
        repositoryReadiness?.repositories?.[repository.id]?.sourceCommit === repository.baseCommit
          ? repositoryReadiness.repositories[repository.id] : null)))) {
    throw new SingularityFlowError('Required non-test prerequisites lack current exact-base proof. Test baseline deferral does not waive those prerequisites.',
      { code: 'STORY_REPOSITORY_READINESS_REQUIRED' });
  }
  const trpPolicy = normalizeTestRecoveryPolicy(trpDefinition.testRecovery);
  if (trpPolicy) resolution.testRecovery = structuredClone(trpPolicy);
  else delete resolution.testRecovery;
  const freshTrpPlan = await prepareTestRecoveryIntake(root, { definition: trpDefinition, workId: id,
    workType: selectedType, repositories: readinessRepositories, repositoryReadiness,
    choices: testRecoveryPlan?.choices ?? {}, phaseDefinitions: resolution.phases });
  if (freshTrpPlan.enabled && (!testRecoveryPlan || !freshTrpPlan.ready
    || canonicalJson(freshTrpPlan) !== canonicalJson(testRecoveryPlan))) {
    throw new SingularityFlowError('The exact Story test-policy preview must be explicitly confirmed and current before creation.',
      { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED', details: { testRecovery: freshTrpPlan } });
  }
  if (!freshTrpPlan.enabled && testRecoveryPlan != null) {
    throw new SingularityFlowError('The approved workflow does not enable this Story test policy.', { code: 'TRP_NOT_ENABLED' });
  }
  // Seal testing intent, not a claim that the repository or this candidate passes tests.
  const sealedTestPolicy = await sealStoryTestPolicy(root, {
    workId: id, baseCommit, phases: resolution.phases ?? [], baselineFailures,
    trpChoices: freshTrpPlan.enabled ? freshTrpPlan.choices : null,
    executionMode: resolution.testExecutionMode, baselineChoice: readinessBaseline,
    intakeOnly: true,
    baselinePending: readinessRepositories.some(repository => {
      const receipt = repositoryReadiness?.repositories?.[repository.id];
      const exact = receipt?.sourceCommit === repository.baseCommit ? receipt : null;
      return baselineObservationPending(exact) && baselineDeferralAllowed(trpDefinition, readinessBaseline, exact);
    }),
    testRuntime: resolution.testRuntime
  });
  const initialTrpRows = [];
  const originalTrpBaselines = [];
  if (freshTrpPlan.enabled) {
    for (const selectedRepository of readinessRepositories) {
      const repositoryId = selectedRepository.id ?? selectedRepository.repository;
      const supplied = repositoryReadiness?.repositories?.[repositoryId];
      const exactBase = supplied?.sourceCommit === selectedRepository.baseCommit;
      const testConfigurationPending = freshTrpPlan.repositories.find(row => row.repository === repositoryId)?.testConfigurationPending === true;
      let status = exactBase ? supplied.status : 'unknown';
      if (status === 'pass') {
        // This rollout can qualify this checkout only. Multi-repository proof requires
        // each repository's resolved host boundary, never another repository's receipt.
        const inspected = readinessRepositories.length === 1 ? await inspectRepositoryReadinessReceipt(root, {
          commit: selectedRepository.baseCommit, scope: supplied.scope ?? 'dependency-test', recompute: false,
          testRuntime: resolution.testRuntime
        }) : null;
        if (inspected?.status !== 'pass' || inspected.receipt.receiptSha256 !== supplied.receiptSha256) {
          throw new SingularityFlowError('Passing intake evidence is not qualified for this exact base and execution host. Refresh the readiness preview.',
            { code: 'TRP_INTAKE_EVIDENCE_STALE', details: { repositoryId, baseCommit: selectedRepository.baseCommit } });
        }
      }
      // A no-op/prerequisite receipt is not a test pass. Keep unobserved test admission
      // portable without making later phases depend on this host's no-test receipt.
      if (status === 'pass' && testConfigurationPending) status = 'not-checked';
      if (status === 'accepted-known-failures') status = 'failing-tests';
      if (freshTrpPlan.choices.baselineDisposition === 'accept-known-failures') status = 'failing-tests';
      if (readinessRepositories.length === 1 && supplied?.baselineSha256) {
        const loaded = await loadRepositoryTestBaseline(root, {
          commit: selectedRepository.baseCommit, scope: supplied.scope ?? 'dependency-test'
        });
        if (loaded?.baseline?.baselineSha256 === supplied.baselineSha256) originalTrpBaselines.push(loaded.baseline);
      }
      initialTrpRows.push({ repositoryId, baseCommit: selectedRepository.baseCommit, status,
        receiptSha256: exactBase ? supplied?.receiptSha256 ?? null : null,
        baselineSha256: exactBase ? supplied?.baselineSha256 ?? null : null,
        testConfigurationPending,
        scope: supplied?.scope ?? 'dependency-test' });
    }
  }
  const referenceMode = resolution.referenceRepositoryPolicy?.mode ?? 'optional';
  if (referenceMode === 'off' && referenceRepositories.length) {
    throw new SingularityFlowError(
      `Work type '${selectedType}' does not allow reference repositories.`,
      { code: 'REFERENCE_REPOSITORIES_NOT_ALLOWED' }
    );
  }
  if (referenceMode === 'required' && !referenceRepositories.length) {
    throw new SingularityFlowError(
      `Work type '${selectedType}' requires at least one read-only reference repository at intake. `
      + 'Pass paired --reference-repository ID=URL and --reference-branch ID=BRANCH options.',
      { code: 'REFERENCE_REPOSITORIES_REQUIRED' }
    );
  }
  const snapshotState = await snapshotResolution(root, config, resolution);
  snapshotState.qualityGateMode = qualityGateMode;
  const creator = identity(root);
  const pinnedApprovalAuthorities = structuredClone(snapshotState.approvalAuthorities
    ?? resolution.approvalAuthorities
    ?? normalizeApprovalAuthorities(config.approvalAuthorities));
  if (normalizeApprovalSecurity(config.approvalSecurity ?? {}).autoEnrollNewIdentities) {
    const email = String(creator.email ?? '').trim().toLowerCase();
    const githubLogin = String(creator.login ?? creator.githubLogin ?? '').trim();
    for (const authority of Object.values(pinnedApprovalAuthorities)) {
      authority.members ??= [];
      const enrolled = authority.members.some((member) =>
        (email && String(member.email ?? '').trim().toLowerCase() === email)
        || (githubLogin && String(member.githubLogin ?? '').trim().toLowerCase() === githubLogin.toLowerCase()));
      if (!enrolled && (email || githubLogin)) {
        authority.members.push({
          name: String(creator.name ?? '').trim() || null,
          email: email || null,
          githubLogin: githubLogin || null
        });
      }
    }
  }
  for (const phase of resolution.phases) {
    assertApprovalPolicyAttainable(pinnedApprovalAuthorities, phase.approval, phase.id, { creator });
  }
  snapshotState.configurationSource = await readConfigurationSource(root, { verify: true });
  // The registered World Model was removed; every Story pins its grounding off.
  snapshotState.worldModelGrounding = 'off';
  snapshotState.worldModelStaleness = resolution.worldModelStaleness ?? config.worldModel?.staleness ?? 'warn';
  snapshotState.storage = structuredClone(resolution.storage ?? null);
  snapshotState.capability = capability;
  snapshotState.referenceRepositories = structuredClone(referenceRepositories.map((reference) => {
    const durable = { ...reference };
    delete durable.materialization;
    return durable;
  }));
  /**
   * Pin the constitution this Story is held to `[SPK:REQ-091]`.
   *
   * Pinned once, here, and never refreshed: `[SPK:CON-039]` says an active Story keeps its pinned
   * constitution while `sflow/config` advances, so the rules someone is judged against are the ones
   * that were in force when they started. Refusing an integrity problem at *start* rather than
   * later is the same reasoning — a Story should not begin under a constitution that already
   * disagrees with itself.
   */
  if (resolution.constitution?.mode !== 'off') {
    const constitution = await loadConstitution(root, resolution.constitution.path, { resolution });
    if (!constitution) {
      if (resolution.constitution.mode === 'enforce') {
        throw new SingularityFlowError(
          `Work type '${selectedType}' requires a constitution at ${resolution.constitution.path} and none exists. `
          + 'Copy examples/constitution/constitution.md there, replace the sample articles, and run singularity-flow constitution generate.'
        , { details: { nextAction: { executable: 'singularity-flow', argv: ['constitution', '--help'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
      }
      console.warn(`Warning: no constitution at ${resolution.constitution.path}; this Story pins none.`);
    } else {
      const blocking = constitution.findings.filter((finding) => ['hand-edited', 'stale-policy', 'judged-prose-changed', 'unresolved-policy'].includes(finding.kind));
      if (blocking.length && resolution.constitution.mode === 'enforce') {
        throw new SingularityFlowError(`The constitution at ${constitution.path} is not consistent with the approved policy:\n- ${blocking.map((finding) => finding.message).join('\n- ')}`);
      }
      constitution.findings.forEach((finding) => console.warn(`Warning: constitution ${finding.kind}: ${finding.message}`));
      snapshotState.constitutionPin = constitutionPin({
        constitution,
        index: constitutionIndex({
          articles: constitution.articles, path: constitution.path, fileSha256: constitution.fileSha256,
          configurationCommit: snapshotState.configurationSource?.commit ?? null, resolution
        }),
        configurationCommit: snapshotState.configurationSource?.commit ?? null,
        resolution
      });
    }
  }
  const actor = creator;
  const phases = resolution.phases.map(phaseState);
  const createdAt = nowIso();
  const workflow = {
    // A selected skill phase introduces a different immutable phase contract, but all newly
    // written Stories use the current record version. Legacy template records remain readable
    // through the identity migration without being reinterpreted as skill phases.
    schemaVersion: currentSchemaVersion('story-workflow'),
    ...(executionOrigin ? { executionOrigin: structuredClone(executionOrigin) } : {}),
    mcpAuthorizations: targetOrigin ? Object.fromEntries(mcpTargetOriginServers(resolution.phases).map((server) => [server,
      { schemaVersion: currentSchemaVersion('mcp-authorization'), origins: [targetOrigin], source: 'story-intake', pinnedAt: createdAt }
    ])) : {},
    workItem: {
      id, title: title || id, workType: selectedType, workTypeLabel: resolution.label,
      branch: currentBranch, baseBranch,
      ...(baseCommit ? { baseCommit } : {}),
      ...(baseRemote ? { baseRemote } : {}),
      ...(launchRepositoryId ? { repositoryId: launchRepositoryId } : {}),
      ...(repositoryBases.length ? { repositoryBases } : {}),
      createdAt, createdBy: actor, source: {
      type: source.type,
      stableId: source.stableId ?? null,
      key: source.key ?? null,
      rawRef: source.rawRef ?? null,
      url: source.url ?? null,
      fetchedAt: source.fetchedAt ?? null,
      contentSha256: source.contentSha256 ?? null,
      risk: source.risk ?? null,
      repositoryCount: repositoryBases.length || source.repositoryCount || 1,
      publicInterfaceChange: source.publicInterfaceChange ?? null,
      dataMigration: source.dataMigration ?? null,
      securityBoundaryChange: source.securityBoundaryChange ?? null,
      regulatedDataChange: source.regulatedDataChange ?? null,
      targetOrigin,
      deploymentPolicyChange: source.deploymentPolicyChange ?? null,
      crossRepositoryChange: source.crossRepositoryChange ?? null
      }
    },
    lineage: {
      schemaVersion: currentSchemaVersion('story-lineage'),
      canonicalBranch: currentBranch,
      parentStoryId: id,
      epicId: source.epicId ?? source.parent?.key ?? null,
      planId: source.planId ?? null,
      jiraIssueId: source.id ?? null,
      sourceStableId: source.stableId ?? null,
      initialJiraKey: source.key ?? (source.type === 'jira' ? id : null),
      currentJiraKey: source.key ?? (source.type === 'jira' ? id : null),
      branchCompletionPolicy: source.branchCompletionPolicy ?? 'pr',
      requiredChecks: [...new Set([
        ...(source.requiredChecks ?? []),
        ...(capability?.policy?.requiredChecks ?? [])
      ])],
      childBranches: []
    },
    resolution: {
      ...snapshotState,
      workType: selectedType,
      workTypeLabel: resolution.label,
      approvalAuthorities: structuredClone(pinnedApprovalAuthorities),
      sequenceGates: snapshotState.sequenceGates ?? resolution.sequenceGates ?? { default: 'hard' },
      documents: structuredClone(resolution.documents ?? config.documents ?? {}),
      collaboration: structuredClone(config.collaboration ?? { assignmentMode: 'off', notifications: ['terminal'] }),
      session: normalizeSessionPolicy(config.session ?? {}),
      contextPolicy: snapshotState.contextPolicy ?? normalizeContextPolicy(config.contextPolicy ?? {}, { phaseIds: Object.keys(config.phases ?? {}) }),
      tokenEconomy: structuredClone(snapshotState.tokenEconomy ?? normalizeTokenEconomy(config.tokenEconomy ?? {})),
      ledger: structuredClone(snapshotState.ledger ?? normalizeLedgerConfig(config.ledger ?? {})),
      sourceSha256: createHash('sha256').update(`${JSON.stringify(source, null, 2)}\n`).digest('hex'),
      // Sealed in the test policy since intake chose it, and never read by a gate until it was also here [TCE:REQ-091].
      testExecutionMode: resolution.testExecutionMode,
      ...(snapshotState.repositoryCommitPolicy == null ? {} : { repositoryCommitPolicy: structuredClone(snapshotState.repositoryCommitPolicy) }),
      phases: resolution.phases
    },
    status: 'in_progress',
    currentPhase: phases[0]?.id ?? null,
    phaseOrder: phases.map((phase) => phase.id),
    phases: Object.fromEntries(phases.map((phase) => [phase.id, phase])),
    usage: {
      mode: config.tokens?.mode ?? 'exact-or-unavailable', totalTokens: 0, records: 0,
      exactRecords: 0, unavailableRecords: 0, byPhase: {}, byAgent: {}, byWorkType: {}, byWorkItem: {}
    },
    telemetry: { schemaVersion: currentSchemaVersion('work-item-telemetry'), mode: 'work-item-sanitized' },
    documents: { count: 0, updatedAt: null },
    collaboration: { assignments: {}, notifications: [] },
    sequenceOverrides: [],
    changeRequests: [],
    history: [{ at: createdAt, actor: actorKey(actor), agent: agent ?? null, event: 'work_started', phase: phases[0]?.id ?? null, detail: `Created ${selectedType} branch ${currentBranch}` }]
  };
  // Cut from another Story's branch: keep that Story as this one's base Story and take its Epic.
  // The new branch still points at the base, so HEAD is the commit when none was supplied.
  inheritFromBaseStory(workflow.lineage, detectBaseStory(root, config, {
    baseBranch, baseCommit: baseCommit ?? head(root), workId: id
  }));
  // SF Guard's policy as this Story starts (SPEC-PSS-v1 REQ-040): a later change never affects it.
  // A repository that never opted in has no policy file, and the Story carries no pin. Pinned before the
  // test-recovery intake review, which is signed on it (§10.10).
  const presencePin = await (await import('./presence/person-records.mjs')).presencePinForStart(root, { configurationSnapshot: approvedConfigurationSnapshot });
  if (presencePin) workflow.resolution.presence = presencePin;
  if (presencePin?.status === 'required' && workflow.resolution.applicationReview && workflow.resolution.applicationReview.mode !== 'off') {
    throw new SingularityFlowError('Application review needs a signed person-presence adapter for this repository. This build does not provide it; use a compatible workflow or runtime. No unsigned acceptance was enabled.', { code: 'ARA_AUTHORITY_ADAPTER_UNAVAILABLE' });
  }
  if (freshTrpPlan.enabled) {
    const agreement = initialTestRecoveryAgreement(freshTrpPlan, {
      workId: id, principal: String(actor.email ?? actor.login ?? actor.name), createdAt,
      phaseIds: workflow.phaseOrder
    });
    const agreementPath = `${workDirRelative(config, id)}/context/test-recovery/agreements/revision-${agreement.revision}.json`;
    const pin = { id: agreement.id, revision: agreement.revision,
      agreementSha256: agreement.recordSha256, agreementPath, policyAuthoritySha256: agreement.policyAuthoritySha256 };
    const readiness = { schemaVersion: 1, evidencePurpose: 'baseline-admission-only', repositories: initialTrpRows };
    workflow.resolution.testRecoveryAgreement = structuredClone(pin);
    workflow.resolution.testRecoveryInitialReadiness = structuredClone(readiness);
    workflow.testRecovery = { schemaVersion: 1, ...pin, validationEpoch: 1,
      confirmedPlanSha256: freshTrpPlan.planDigest, readiness: structuredClone(readiness), readinessHistory: [],
      route: freshTrpPlan.choices.baselineDisposition === 'accept-known-failures' ? 'baseline-risk-publication'
        : initialTrpRows.every((row) => row.status === 'pass' || row.testConfigurationPending) ? 'feature-coding' : 'readiness-repair' };
    const intakeReview = await authorizeTrpIntake(root, workflow, agreement, freshTrpPlan);
    // Review cannot turn a changed source, runtime or policy into the approved intake.
    if (intakeReview) {
      const reviewed = await prepareTestRecoveryIntake(root, { definition: trpDefinition, workId: id,
        workType: selectedType, repositories: readinessRepositories, repositoryReadiness,
        choices: freshTrpPlan.choices, phaseDefinitions: resolution.phases });
      if (!reviewed.ready || canonicalJson(reviewed) !== canonicalJson(freshTrpPlan)) {
        throw new SingularityFlowError('The baseline changed during human review. No Story was created.', { code: 'TRP_INTAKE_EVIDENCE_STALE' });
      }
    }
    await ensureSecureRepositoryDirectory(root, workDirRelative(config, id), { label: 'Story test policy' });
    await appendTrpRecord(workDir(root, config, id), agreement);
    await materializeTrpIntake(root, config, workflow, intakeReview);
    for (const baseline of originalTrpBaselines) await appendTrpOriginalBaseline(workDir(root, config, id), baseline);
  }
  if (capability?.policy?.maxDocumentBytes) {
    workflow.resolution.documents.maxFileBytes = Math.min(
      workflow.resolution.documents.maxFileBytes ?? capability.policy.maxDocumentBytes,
      capability.policy.maxDocumentBytes
    );
  }
  workflow.resolution.wel = buildWelEnrollment({
    phases: workflow.resolution.phases,
    codeDelivery: workflow.resolution.codeDelivery,
    configurationSource: workflow.resolution.configurationSource
  });
  const referenceManifest = await writeReferenceRepositoryManifest(
    root, config, id, workflow.resolution.referenceRepositories ?? []
  );
  await initializeStoryImpact(root, config, workflow, source);
  for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
    if (template.source !== 'agent' || !template.cachePath) continue;
    const destination = path.join(workDir(root, config, id), 'context/agent-templates', template.agent, `${template.resource}-${template.sha256}.md`);
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(template.cachePath, destination);
    template.path = posix(path.relative(root, destination)); delete template.cachePath;
    workflow.resolution.phases.find((phase) => phase.id === phaseId).templateSnapshot = { ...template };
  }
  // Capture before accepted Story state is written. This rewrites phase-template references to
  // immutable blobs and stamps the exact resulting effective-policy digest.
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow, {
    approvedConfigurationSnapshot
  });
  await writeJson(sourcePath(root, config, id), source);
  await writeText(userStoryPath(root, config, id), sourceMarkdown(source));
  if (repositoryReadiness && readinessRepositories.length) {
    await writeJson(
      path.join(workDir(root, config, id), 'context/repository-test-readiness.json'),
      storyTestReadinessDocument(id, readinessRepositories, repositoryReadiness, {
        required: false,
        baselineChoice: readinessBaseline
      })
    );
  }
  await writeJson(path.join(workDir(root, config, id), sealedTestPolicy.relativePath), sealedTestPolicy.record);
  workflow.testPolicy = { path: sealedTestPolicy.relativePath, sha256: sealedTestPolicy.sha256 };
  await writeText(path.join(workDir(root, config, id), 'README.md'), `# ${id} — ${workflow.workItem.title}\n\nDurable ${selectedType} workflow state for branch \`${id}\`.\n\n- [workflow.json](./workflow.json) — machine state and accepted workflow-snapshot reference\n- [config/wfa/](./config/wfa/) — immutable effective policy, phase templates, and agent bytes\n- [STATUS.md](./STATUS.md) — human status\n- [source.json](./source.json) — source context\n- [USER-STORY.md](./USER-STORY.md) — ${source.type === 'jira' ? 'Jira' : 'manual'} story snapshot\n- [context/test-policy.json](./context/test-policy.json) — sealed test policy and the repository's test capability at creation\n${repositoryReadiness && readinessRepositories.length ? '- [context/repository-test-readiness.json](./context/repository-test-readiness.json) — pinned pre-code test tools and existing-failure disposition\n' : ''}${referenceManifest ? '- [context/reference-repositories.json](./context/reference-repositories.json) — immutable read-only source repository pins\n' : ''}- [documents.json](./documents.json) — supporting-document catalog (created on first upload)\n- [inputs/](./inputs/) — uploaded files (created on first upload)\n- [context/](./context/) — per-generation prompt-grounding audit records\n- [telemetry/](./telemetry/) — sanitized per-generation model, token, and cost records\n- [artifacts/](./artifacts/) — generated phase artifacts\n- [approvals/](./approvals/) — append-only decisions\n`);
  const firstPhaseNeedsReadinessRepair = (['readiness-repair', 'baseline-risk-publication'].includes(workflow.testRecovery?.route)
    || sealedTestPolicy.record.baselineFailures === 'resolve-outside') && phaseRequiresCodeDelivery(phases[0]);
  if (!firstPhaseNeedsReadinessRepair) await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phases[0]?.id,
    itemDirectory: workDir(root, config, id),
    itemRelative: workDirRelative(config, id)
  });
  await saveWorkflow(root, config, workflow);
  // Story activation may pin a selected skill package before the qualified host exists. Keep its
  // first phase at an honest generation-zero state; automatic preparation must not surface or run
  // untrusted package instructions through the legacy template/agent path.
  if (phases[0]?.kind !== 'skill' && !firstPhaseNeedsReadinessRepair) await preparePhase(root, config, workflow, phases[0]?.id);
  await saveWorkflow(root, config, workflow);
  return workflow;
}




export async function resolveWorkItem(root, config, idOrRef = branch(root), { mutation = false, creation = false } = {}) {
  const requested = String(idOrRef ?? '').trim();
  if (!requested) throw new SingularityFlowError('Enter a Work ID or canonical/child branch reference.');
  const index = await buildRepositorySubjectIndex(root, { definition: config });
  const indexed = resolveContext(index, { reference: requested, kind: 'story', required: false });
  if (indexed) {
    const workflow = attachLegacyGovernedRoots(normalizeCurrentWorkflow(indexed.state), config);
    if (needsAcceptedPhaseInterpretation(workflow)) await resolveStoryExecutionCatalog(root, config, workflow);
    return {
      workId: workflow.workItem.id,
      branch: indexed.canonicalBranch,
      selectedBranch: indexed.selectedBranch,
      workflow,
      source: indexed.source
    };
  }

  const ledgerConfig = normalizeLedgerConfig(config.ledger ?? {});
  if (ledgerConfig.enabled) {
    try {
      // Ledger bindings are evidence-only and never enter RepositorySubjectIndex. Keep their
      // mutation guard here, where the caller's requested access and the ledger source are both
      // explicit; a ref-backed lifecycle subject is materializable by resume and is not read-only.
      const entries = await ledgerLog(root, ledgerConfig, { limit: 1000000 });
      const binding = entries.find((entry) =>
        entry.eventType === 'binding'
        && (entry.subject?.workId === requested || entry.subject?.branch === requested));
      if (binding) {
        if (mutation) {
          throw new SingularityFlowError(`Work item '${binding.subject.workId}' is known only from the capability ledger. Fetch its lifecycle branch before mutating it.`);
        }
        return {
          workId: binding.subject.workId,
          branch: binding.subject.branch ?? binding.subject.workId,
          workflow: null,
          source: 'ledger',
          readOnly: true,
          entryHash: binding.hash
        };
      }
    } catch (error) {
      if (mutation || ledgerConfig.enforcement === 'required') {
        throw new SingularityFlowError(`Work-item binding cannot be verified from the capability ledger: ${error.message}`);
      }
    }
  }
  if (creation) return { workId: requested, branch: requested, workflow: null, source: 'creation-fallback' };
  throw new SingularityFlowError(`No Story matches '${requested}'. Use a creation command to reserve a new Work ID.`);
}

import { currentPhase } from './phase-generation.mjs';
export { currentPhase };


/**
 * Finish a Story's retained publication before a transition, when that is an ordinary retry.
 *
 * A lifecycle command that committed locally but could not push leaves the exact commit and its
 * remote lease retained. Publishing it is what that command already asked for, so the next
 * transition completes it instead of refusing. It uses the same exact-lease sync as
 * `singularity-flow sync`. An interrupted pre-commit publication is never rolled back here, and any
 * failure leaves the sequence gate to refuse exactly as before.
 */



/** The artifact's text, or empty when it is not there yet — a missing artifact is `validatePhase`'s. */
async function readArtifactText(root, relative) {
  const info = await repositoryArtifactSnapshot(root, relative);
  return info.exists ? readRepositoryArtifactText(root, relative) : '';
}

function specificationPolicy(config, workflow) {
  return normalizeSpecPolicy(workflow.resolution?.spec ?? config.spec ?? {});
}

function plannedClaimsPolicy(workflow) {
  const value = workflow.resolution?.plannedClaims;
  return value && typeof value === 'object' ? value : null;
}

function plannedClaimsEnforced(workflow, specPolicy) {
  const policy = plannedClaimsPolicy(workflow);
  // New Story resolutions pin the specific early-planning obligation. Historical snapshots do
  // not have this field, so retain their original spec.mode behavior instead of retroactively
  // changing an in-flight lifecycle.
  return policy ? policy.mode === 'required' : specPolicy.mode === 'enforce';
}

function explicitPlannedClaimsRequired(workflow) {
  return plannedClaimsPolicy(workflow)?.mode === 'required';
}

function phaseDefinesSpecificationClaims(workflow, phase) {
  const policy = plannedClaimsPolicy(workflow);
  if (policy?.mode === 'required' && Array.isArray(policy.clausePhases)) {
    // Configuration validation already proves the kind, but re-check it at runtime because the
    // pinned Story snapshot is the actual authority and may predate that validator.
    return policy.clausePhases.includes(phase.id) && isSpecificationDefinitionPhase(phase);
  }
  return isSpecificationDefinitionPhase(phase);
}

function specificationClauseIds(records) {
  return [...new Set((records.indexes ?? []).flatMap((index) =>
    (index.clauses ?? []).map((clause) => String(clause.id).toUpperCase())))].sort();
}

function plannedRecordsForCodePhase(workflow, codePhase, records) {
  const plannedPolicy = plannedClaimsPolicy(workflow);
  if (plannedPolicy?.mode !== 'required') return records.planned ?? [];
  const ownerId = plannedPolicy.owners?.[codePhase.id];
  return ownerId
    ? (records.planned ?? []).filter((record) => record.phase === ownerId)
    : [];
}

async function authoritativePlannedRecordsForCodePhase(root, config, workflow, codePhase, records, policy) {
  const candidates = plannedRecordsForCodePhase(workflow, codePhase, records);
  const owner = planningOwnerForCode(workflow, codePhase);
  const pointer = owner?.claimMaps?.planned;
  if (!owner || !pointer) return explicitPlannedClaimsRequired(workflow) ? [] : candidates;
  let record;
  try {
    record = await readBoundSpecificationClaimMap(
      root,
      workDir(root, config, workflow.workItem.id),
      workflow,
      owner,
      'planned',
      { clauseIds: specificationClauseIds(records), policy }
    );
  } catch (error) {
    // Preserve the lifecycle-facing recovery code while sharing the terminal-grade verifier.
    if (error?.code === 'SPECIFICATION_CLAIM_MAP_BINDING_STALE') {
      throw new SingularityFlowError(error.message, { code: 'SPEC_PLANNED_CLAIM_MAP_STALE' });
    }
    throw error;
  }
  return [record];
}

/** A refusal at implementation entry, in the one gate shape: the plan or scope obligations it lacks. */
function implementationEntryRefusal(workflow, phaseId, { code, message, checkpoint, recoveryCommand, missing }) {
  const workId = workflow.workItem.id;
  return gateRefusal({
    code, gate: 'implementation-entry',
    subject: { workId, phase: phaseId, generation: workflow.phases?.[phaseId]?.generation ?? null },
    evaluation: { rows: [{ obligations: missing.map(([responsibility, subject]) => ({
      id: obligationId(workId, responsibility, subject), responsibility, subject, status: 'missing', owningSteps: [checkpoint].filter(Boolean)
    })) }], findings: [] },
    findings: [{ code, message }],
    checkpoint,
    actions: [recoveryCommand]
  });
}

function noSpecificationClausesError(workflow, phaseId) {
  const clausePhases = plannedClaimsPolicy(workflow)?.clausePhases ?? [];
  const target = clausePhases.at(-1) ?? phaseId;
  const message = `No authoritative specification clauses exist before code phase '${phaseId}'. `
    + `Return to '${target}' and add stable fully qualified anchors such as [${workflow.workItem.id}:AC-001] before planning tests.`;
  const recoveryCommand = `singularity-flow recover ${workflow.workItem.id} --phase ${target}`;
  return new SingularityFlowError(
    message,
    {
      code: 'SPECIFICATION_CLAUSE_SOURCE_REQUIRED',
      details: {
        phase: phaseId,
        clausePhases,
        recoveryCommand,
        gate: implementationEntryRefusal(workflow, phaseId, {
          code: 'SPECIFICATION_CLAUSE_SOURCE_REQUIRED', message, checkpoint: target, recoveryCommand, missing: [['scope', 'story']]
        })
      }
    }
  );
}

function claimMapRelativePath(config, workflow, phase, kind) {
  return posix(path.join(
    workDirRelative(config, workflow.workItem.id), 'context', 'claims',
    `${phase.id}-gen${phase.generation}-${kind}.json`
  ));
}

function claimMapSha256(record) {
  return createHash('sha256').update(canonicalJson(record)).digest('hex');
}

function bindPhaseClaimMap(phase, kind, relative, sha256) {
  phase.claimMaps ??= {};
  phase.claimMaps[kind] = {
    generation: phase.generation,
    path: relative,
    sha256
  };
}

function assertClaimIdentity(record, workflow, phase, kind) {
  if (record.kind !== kind
      || record.workId !== workflow.workItem.id
      || record.phase !== phase.id
      || Number(record.generation) !== Number(phase.generation)) {
    throw new SingularityFlowError(
      `${kind} specification claim map does not bind ${workflow.workItem.id}/${phase.id} generation ${phase.generation}.`,
      { code: 'SPECIFICATION_CLAIM_MAP_IDENTITY_INVALID' }
    );
  }
}

async function existingClaimMap(root, relative, workflow, phase, kind, clauseIds, policy, plannedClaims = {}) {
  if (!(await exists(path.join(root, relative)))) return null;
  const raw = await readJson(path.join(root, relative));
  const record = readRecord('specification-claim-map', raw).record;
  assertClaimIdentity(record, workflow, phase, kind);
  // Schema migration proves readability; normalization proves the semantic path and clause limits.
  normalizeClaimMap(record, { kind, clauseIds, policy, plannedClaims });
  return { raw, record, sha256: claimMapSha256(raw) };
}

function plannedTestGaps(records, policy) {
  return evaluateSpecAcceptance(records, { ...policy, acceptance: 'presence' }).missingPlannedTests;
}

function placeholderTestReason(reason) {
  const value = String(reason ?? '').trim();
  return !value
    || /\b(?:todo|tbd|fixme|placeholder|to be determined|to be defined)\b/i.test(value)
    || /^<[^>]+>$/.test(value)
    || /^(?:specific|concrete)\s+reason$/i.test(value);
}

/**
 * Materialize the reviewed planning contract before the lifecycle can enter a code phase.
 * The exact table is deterministic; prose and later test files are never guessed into a claim.
 */
/** The code step a definition step plans claims for, with the policy that judges the plan, or null. */
function plannedClaimsTarget(config, workflow, phase) {
  const policy = specificationPolicy(config, workflow);
  const codeSteps = plannedDeliveryCodeSteps(workflow, phase);
  const upcoming = workflow.phases[codeSteps[0]];
  if (policy.mode === 'off' || policy.acceptance === 'off' || !phaseRequiresCodeDelivery(upcoming)) return null;
  return { policy, upcoming, codeSteps, enforce: plannedClaimsEnforced(workflow, policy) };
}

/**
 * The planned-test contract an authored definition states, refused exactly as publishing it is:
 * placeholder not-applicable reasons always, and missing planned tests when the contract is enforced.
 * `subject`, `where` and `again` name the act being refused, so an intent amendment is told to propose again.
 */
function plannedClaimContract(phase, authored, {
  clauseIds, clauses = [], policy, enforce, artifactPath, codeSteps = [],
  subject = `Phase ${phase.id} cannot publish`, where = `in ${artifactPath}`, again = 'publish again'
}) {
  const evidenceRoot = artifactPath?.split('/artifacts/')[0];
  const derived = derivePlannedClaimMap(authored, { clauseIds, clauses, policy,
    evidenceRoot: evidenceRoot ? `${evidenceRoot}/evidence` : null });
  if (evidenceRoot) validatePlannedEvidenceTypes(derived.claimMap.claims, { evidenceRoot: `${evidenceRoot}/evidence` });
  const placeholderReasons = Object.entries(derived.claimMap.claims)
    .filter(([, claim]) => claim.testDisposition === 'not-applicable' && placeholderTestReason(claim.testReason))
    .map(([id]) => id)
    .sort();
  if (placeholderReasons.length) {
    throw new SingularityFlowError(
      `${subject} because not-applicable test reasons are placeholders for: ${placeholderReasons.join(', ')}. `
      + `Replace TODO/TBD/template text with the concrete reviewed reason ${where}.`,
      { code: 'SPEC_PLANNED_TEST_BINDING_REQUIRED', details: { phase: phase.id, clauses: placeholderReasons } }
    );
  }
  // An obligation is allocated to the code steps that implement it [E2G-009]; one this plan does not
  // plan for could never be delivered.
  const misallocated = Object.entries(derived.claimMap.claims)
    .flatMap(([id, claim]) => (claim.steps ?? []).filter((step) => !codeSteps.includes(step)).map((step) => `${id} to ${step}`));
  if (misallocated.length) {
    throw new SingularityFlowError(
      `${subject} because it allocates obligations to steps it does not plan for: ${misallocated.join(', ')}. `
      + `Allocate each to one of: ${codeSteps.join(', ')}.`,
      { code: 'SPEC_PLANNED_ALLOCATION_INVALID', details: { phase: phase.id, misallocated, codeSteps } }
    );
  }
  // Every code step the plan plans for delivers something: a step left with no obligation would
  // publish nothing it could be held to.
  const claimsList = Object.values(derived.claimMap.claims);
  const idle = codeSteps.length > 1
    ? codeSteps.filter((step) => !claimsList.some((claim) => !(claim.steps ?? []).length || claim.steps.includes(step)))
    : [];
  if (idle.length) {
    throw new SingularityFlowError(
      `${subject} because no obligation is allocated to ${idle.join(', ')}. Allocate at least one row to each code step it plans for.`,
      { code: 'SPEC_PLANNED_ALLOCATION_INVALID', details: { phase: phase.id, idle, codeSteps } }
    );
  }
  // Each criterion's verification contract is validated with the plan, before any code exists [E2G-013].
  let contracts;
  try {
    contracts = parseVerificationContracts(authored, { clauseIds, plannedClaims: derived.claimMap.claims });
  } catch (error) {
    throw new SingularityFlowError(`${subject} because its verification contracts are invalid: ${error.message} Fix the 'Verification contracts' table ${where} and ${again}.`, {
      code: error.code ?? 'SPEC_VERIFICATION_CONTRACT_INVALID', details: { phase: phase.id, ...(error.details ?? {}) }
    });
  }
  const gaps = [...new Set([...derived.missingClauseIds, ...derived.missingTestClauseIds])].sort();
  if (gaps.length && enforce) {
    throw new SingularityFlowError(
      `${subject} because its planned-test contract is incomplete:\n- `
      + gaps.map((id) => `clause ${id} has no exact planned test or reviewed not-applicable reason`).join('\n- ')
      + `\nComplete the 'Clause | Expected paths | Planned tests' table ${where} and ${again}.`,
      { code: 'SPEC_PLANNED_TEST_BINDING_REQUIRED', details: { phase: phase.id, clauses: gaps } }
    );
  }
  return { derived, gaps, contracts };
}

/**
 * Refuse an intent-amendment proposal whose specification would not plan its clauses [E2G-008]. It
 * is the contract publication enforces, checked before anyone decides, so an approved amendment
 * never fails on its own plan.
 */
export async function assertAmendedPlannedClaims(root, config, workflow, phase, proposedText, proposedClauseIds) {
  const target = plannedClaimsTarget(config, workflow, phase);
  if (!target) return null;
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const clauseIds = [...new Set([
    ...specificationClauseIds({ indexes: records.indexes.filter((index) => index.phase !== phase.id) }),
    ...proposedClauseIds.map((id) => String(id).toUpperCase())
  ])].sort();
  if (!clauseIds.length) return null;
  return plannedClaimContract(phase, authoredArtifactText(proposedText), {
    clauseIds, clauses: [...records.indexes.filter(index => index.phase !== phase.id).flatMap(index => index.clauses ?? []),
      ...extractClauses(proposedText)],
    policy: target.policy, enforce: target.enforce, artifactPath: requiredRepoPath(config, workflow, phase), codeSteps: target.codeSteps,
    subject: 'The amended specification cannot be proposed', where: 'in the proposed file', again: 'propose it again'
  });
}

/** Amendments must satisfy the same pinned authoring contract as ordinary publication. */
export async function assertAmendedScopeContent(root, config, workflow, phase, proposedText, proposedClauseIds) {
  const findings = inspectRequiredArtifactText(proposedText, phase, {
    path: requiredRepoPath(config, workflow, phase), generation: nextPhaseGeneration(phase)
  });
  if (findings.length) throw new SingularityFlowError(
    `The amended specification is incomplete:\n- ${findings.map(artifactFindingMessage).join('\n- ')}\n`
    + 'Correct the proposed file before requesting approval; the approved scope remains unchanged.',
    { code: 'ARTIFACT_AUTHORING_INCOMPLETE', details: { phase: phase.id, findings } }
  );
  return assertAmendedPlannedClaims(root, config, workflow, phase, proposedText, proposedClauseIds);
}

async function refreshPlannedSpecificationClaims(root, config, workflow, phase) {
  const target = plannedClaimsTarget(config, workflow, phase);
  if (!target) return null;
  const { policy, upcoming, enforce, codeSteps } = target;

  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const clauseIds = specificationClauseIds(records);
  if (!clauseIds.length) {
    // Zero-clause refusal is the new topology contract. Historical enforce-mode Stories did not
    // require an index before this field existed and must retain their pinned behavior.
    if (explicitPlannedClaimsRequired(workflow)) throw noSpecificationClausesError(workflow, upcoming.id);
    return null;
  }
  const relative = claimMapRelativePath(config, workflow, phase, 'planned');
  const artifactPath = requiredRepoPath(config, workflow, phase);
  const artifact = await repositoryArtifactSnapshot(root, artifactPath);
  const authored = authoredArtifactText(await readRepositoryArtifactText(root, artifactPath));
  const { derived, gaps, contracts } = plannedClaimContract(phase, authored, {
    clauseIds, clauses: records.indexes.flatMap(index => index.clauses ?? []), policy, enforce, artifactPath, codeSteps
  });
  // A planned test that could never run here is named now, not first at publication [§12 #18].
  try {
    await assertPlannedTestsRunnable(root, workflow, {
      subject: `Phase ${phase.id} cannot publish`, codeSteps, claims: derived.claimMap.claims,
      contracts: new Map(contracts.map((entry) => [entry.clauseId, entry]))
    });
  } catch (error) {
    if (enforce || error?.code !== 'TEST_CAPABILITY_UNSUPPORTED') throw error;
    console.warn(`Warning: ${error.message}`);
  }
  if (gaps.length) {
    console.warn(`Warning: phase ${phase.id} planned-test contract is incomplete for ${gaps.join(', ')}.`);
  }

  // A manually seeded claim file is never authority over the reviewed artifact. Derive the
  // complete expected projection first, then permit a retained retry file only when its canonical
  // JSON is byte-for-byte the same projection. Preserve its original timestamp so a failed
  // publication can be retried without manufacturing a false difference from the clock.
  const existing = await existingClaimMap(root, relative, workflow, phase, 'planned', clauseIds, policy);
  const record = {
    ...derived.claimMap,
    ...(contracts.length ? { verificationContracts: contracts } : {}),
    ...(existing ? { recordedAt: existing.record.recordedAt } : {}),
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.generation,
    source: { path: artifactPath, sha256: artifact.sha256, bytes: artifact.size }
  };
  if (existing && canonicalJson(existing.raw) !== canonicalJson(record)) {
    throw new SingularityFlowError(
      `Existing planned claim map ${relative} does not match the reviewed Markdown in ${artifactPath}. `
      + 'Remove the uncommitted seeded claim map and publish again so Singularity Flow can derive it.',
      { code: 'SPEC_PLANNED_CLAIM_MAP_SOURCE_MISMATCH', details: { phase: phase.id, path: relative, source: artifactPath } }
    );
  }
  if (!existing) {
    await writeJson(path.join(root, relative), record);
  }
  const digest = existing?.sha256 ?? claimMapSha256(record);

  const effective = { ...records, planned: [record] };
  const effectiveGaps = plannedTestGaps(effective, policy);
  if (effectiveGaps.length && enforce) {
    throw new SingularityFlowError(
      `Phase ${phase.id} cannot advance toward implementation:\n- `
      + effectiveGaps.map((id) => `clause ${id} has no planned test`).join('\n- '),
      { code: 'SPEC_PLANNED_TEST_BINDING_REQUIRED', details: { phase: phase.id, clauses: effectiveGaps } }
    );
  }
  bindPhaseClaimMap(phase, 'planned', relative, digest);
  return record;
}

function planningOwnerForCode(workflow, codePhase) {
  const configured = plannedClaimsPolicy(workflow)?.owners?.[codePhase.id];
  if (configured) return workflow.phases[configured] ?? null;
  const index = workflow.phaseOrder.indexOf(codePhase.id);
  if (index <= 0) return null;
  return workflow.phases[workflow.phaseOrder[index - 1]] ?? null;
}

/** Refuse at implementation entry/publish, rather than surprising the Story at its terminal gate. */
export async function assertPlannedSpecificationClaims(root, config, workflow, codePhase) {
  const policy = specificationPolicy(config, workflow);
  if (policy.mode === 'off' || policy.acceptance === 'off' || !phaseRequiresCodeDelivery(codePhase)) return;
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const clauseIds = specificationClauseIds(records);
  if (!clauseIds.length) {
    if (explicitPlannedClaimsRequired(workflow)) throw noSpecificationClausesError(workflow, codePhase.id);
    return;
  }
  const owner = planningOwnerForCode(workflow, codePhase);
  const ownedPlanned = await authoritativePlannedRecordsForCodePhase(
    root, config, workflow, codePhase, records, policy
  );
  const scopedRecords = { ...records, planned: ownedPlanned };
  const gaps = plannedTestGaps(scopedRecords, policy);
  if (!ownedPlanned.length || gaps.length) {
    const ownerId = owner?.id ?? 'the planning phase';
    const message = !ownedPlanned.length
      ? `No reviewed planned-test claim map exists before phase '${codePhase.id}'.`
      : `Planned-test evidence is missing for ${gaps.join(', ')}.`;
    if (!plannedClaimsEnforced(workflow, policy)) {
      console.warn(`Warning: ${message}`);
      return;
    }
    const recoveryCommand = owner
      ? `singularity-flow recover ${workflow.workItem.id} --phase ${owner.id}`
      : `singularity-flow recover ${workflow.workItem.id} --phase ${codePhase.id}`;
    const refusalMessage = `${message} Return to '${ownerId}', complete its exact clause/path/test table, publish, and approve it before starting implementation.`;
    throw new SingularityFlowError(
      refusalMessage,
      {
        code: 'SPEC_PLANNED_CLAIM_MAP_REQUIRED',
        details: {
          phase: codePhase.id,
          ownerPhase: owner?.id ?? null,
          clauses: gaps,
          recoveryCommand,
          gate: implementationEntryRefusal(workflow, codePhase.id, {
            code: 'SPEC_PLANNED_CLAIM_MAP_REQUIRED', message: refusalMessage, checkpoint: owner?.id ?? null, recoveryCommand,
            missing: (ownedPlanned.length ? gaps : clauseIds).map((clause) => ['plan', clause])
          })
        }
      }
    );
  }
}

async function refreshObservedSpecificationClaims(root, config, workflow, phase, deliveryReceipt) {
  const policy = specificationPolicy(config, workflow);
  if (policy.mode === 'off' || policy.acceptance === 'off') return null;
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  const clauseIds = specificationClauseIds(records);
  const ownedPlanned = await authoritativePlannedRecordsForCodePhase(
    root, config, workflow, phase, records, policy
  );
  if (!clauseIds.length || !ownedPlanned.length) return null;
  const planned = {
    claims: Object.assign({}, ...ownedPlanned.map((entry) => entry.claims ?? {}))
  };
  const derived = deriveObservedClaimMap(planned, deliveryReceipt, {
    clauseIds,
    policy,
    requireSourceBindings: phase.sourceBoundary !== 'test-automation'
      && workflow.resolution?.plannedClaims?.mode === 'required'
      && workflow.resolution?.codeDelivery?.traceability?.sourceBindings === 'enforce',
    generationCommit: phase.generationCommit
  });
  const relative = claimMapRelativePath(config, workflow, phase, 'observed');
  const existing = await existingClaimMap(root, relative, workflow, phase, 'observed', clauseIds, policy, planned.claims);
  let record;
  let digest;
  if (existing) {
    if (canonicalJson(existing.record.claims) !== canonicalJson(derived.claims)) {
      throw new SingularityFlowError(
        `Observed specification claim map for ${phase.id} generation ${phase.generation} conflicts with the finalized delivery evidence.`,
        { code: 'SPEC_OBSERVED_CLAIM_MAP_CONFLICT' }
      );
    }
    ({ record, sha256: digest } = existing);
  } else {
    record = {
      ...derived,
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      source: {
        path: phase.deliveryEvidence.receiptPath,
        sha256: phase.deliveryEvidence.receiptSha256,
        changeSetDigest: deliveryReceipt.changeSet?.digest ?? null
      }
    };
    await writeJson(path.join(root, relative), record);
    digest = claimMapSha256(record);
  }
  bindPhaseClaimMap(phase, 'observed', relative, digest);
  return record;
}

/**
 * The final code approval is the last human boundary before convergence. A passing test command
 * and a valid receipt prove execution, but neither proves that every approved clause was covered.
 * Use only this Story's pinned, committed specification/plan/observation bindings and the exact
 * submitted code revision. Earlier code phases may accumulate evidence and are not final gates.
 */
export async function assertFinalCodeSpecificationCoverage(root, config, workflow, phase, evidenceCommit, { boundary = 'approved' } = {}) {
  try { return await assertStrictCodeSpecificationCoverage(root, config, workflow, phase, evidenceCommit, { boundary }); }
  catch (error) {
    if (error.code !== 'SPEC_COVERAGE_INCOMPLETE') throw error;
    const risk = await qualityRiskStatus(root, config, workflow, phase, error,
      { transition: boundary === 'submitted' ? 'submit' : 'approve' });
    if (risk.excepted) return { ...error.details?.coverage, complete: false, acceptedRisk: risk };
    error.details = { ...error.details, qualityRisk: risk,
      recoveryCommands: [...(error.details?.recoveryCommands ?? []), `singularity-flow appeal preflight --phase ${phase.id} --json`] };
    throw error;
  }
}

export async function assertStrictCodeSpecificationCoverage(root, config, workflow, phase, evidenceCommit, { boundary = 'approved' } = {}) {
  const policy = specificationPolicy(config, workflow);
  const enforcement = codeCoverageEnforcement(policy);
  if (!enforcement
      || !explicitPlannedClaimsRequired(workflow)
      || !phaseRequiresCodeDelivery(phase)) return null;
  const codePhases = (workflow.phaseOrder ?? []).filter((id) =>
    phaseRequiresCodeDelivery(workflow.phases?.[id]));
  const finalStep = codePhases.at(-1) === phase.id;
  const records = await loadBoundActiveSpecRecords(
    root, workDir(root, config, workflow.workItem.id), workflow, policy,
    { requireCommitted: true, throughPhase: finalStep ? null : phase.id }
  );
  // An earlier code step answers for the rows the plan allocates to it by name [E2G-009]; the last
  // one answers for everything.
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const allocatedHere = Object.entries(planned).filter(([, claim]) => (claim.steps ?? []).includes(phase.id)).map(([id]) => id);
  if (!finalStep && !allocatedHere.length) return null;
  const changedPaths = changedRepositoryPaths(root, {
    base: workflow.workItem.baseCommit
      ?? workflow.phases?.[workflow.phaseOrder?.[0]]?.sourceCommit
      ?? workflow.workItem.baseBranch,
    target: evidenceCommit,
    pathContext: applicationPathContext(config, workflow)
  });
  const coverageResult = evaluateSpecCoverage(records, changedPaths, policy, { root, workflow });
  // Observations accumulate across code phases, but a later phase can restore a previously
  // changed file to its pre-Story bytes. A still-existing file is not proof that its observed
  // implementation survived in the exact code revision being approved. Deletions remain valid
  // because Git includes their paths in the base-to-submission change set.
  const finalChangedPaths = new Set(changedPaths);
  // Existing behaviour is cited unchanged and a removal is evidenced by absence, so neither is
  // expected in the change set [E2G-010].
  const revertedClaims = [...new Set(records.observed.flatMap((record) => {
    const ownPlan = plannedClaimsForObservedPhase(workflow, record.phase, records.planned);
    return Object.entries(record.claims ?? {}).filter(([id]) => !['existing', 'removed', 'evidence'].includes(ownPlan[id]?.fulfillment)).flatMap(([id, claim]) =>
      (claim.observedPaths ?? [])
        .filter((candidate) => !finalChangedPaths.has(candidate))
        .map((candidate) => `${id} references source evidence absent from the final change set: ${candidate}`)
    );
  }))].sort();
  const coverage = revertedClaims.length
    ? { ...coverageResult,
        invalidEvidence: [...new Set([...coverageResult.invalidEvidence, ...revertedClaims])].sort(),
        complete: false, severity: 'error' }
    : coverageResult;
  if (!finalStep) {
    const open = coverage.unimplemented.filter((id) => allocatedHere.includes(id));
    if (!open.length) return coverage;
    if (enforcement !== 'enforce') {
      return { ...coverage, advisory: open.map((id) => `clause ${id}, which the plan allocates to ${phase.id}, is not fully implemented; this Story's ending refuses it unless a later step delivers it`) };
    }
    throw new SingularityFlowError(
      `Phase '${phase.id}' cannot be ${boundary} because rows the plan allocates to it are not implemented:\n- `
      + open.map((id) => `clause ${id} is not fully implemented`).join('\n- ')
      + '\nReturn this phase for correction, complete their source and test evidence, then publish and submit a new generation.',
      { code: 'SPEC_COVERAGE_INCOMPLETE', details: { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
        evidenceCommit, allocated: allocatedHere, open, coverage: { ...coverage, unimplemented: open } } }
    );
  }
  if (coverage.complete) return coverage;
  // Recorded coverage is told what a qualified ending refuses: all of this but unclaimed paths.
  if (enforcement !== 'enforce') {
    const advisory = [
      ...coverage.unimplemented.map((id) => `clause ${id} is not fully implemented`),
      ...coverage.withdrawnButClaimed.map((id) => `withdrawn clause still has an observed claim: ${id}`),
      ...coverage.invalidEvidence.map((message) => `invalid clause evidence: ${message}`)
    ].map((line) => `${line}; this Story's ending refuses it unless a later step corrects it`);
    return advisory.length ? { ...coverage, advisory } : coverage;
  }
  const findings = [
    ...coverage.unimplemented.map((id) => `clause ${id} is not fully implemented`),
    ...coverage.unclaimedChangedPaths.map((candidate) => `changed path is not claimed by a clause: ${candidate}; add it to a row with singularity-flow decision plan --add-location <clause>=${candidate} --reason <why>, or list it as a supporting change`),
    ...coverage.withdrawnButClaimed.map((id) => `withdrawn clause still has an observed claim: ${id}`),
    ...coverage.invalidEvidence.map((message) => `invalid clause evidence: ${message}`)
  ];
  throw new SingularityFlowError(
    `Phase '${phase.id}' cannot be ${boundary} because specification coverage is incomplete:\n- ${findings.join('\n- ')}\n`
    + `Run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json. Correct delivery evidence in a reviewed new generation, or use singularity-flow decision plan to amend exact planned locations without regenerating application code. Screenshots belong to fulfillment evidence with a visual/inspection contract, not product source or executable tests. Never hand-edit an observed claim map.`,
    {
      code: 'SPEC_COVERAGE_INCOMPLETE',
      details: {
        workId: workflow.workItem.id, phase: phase.id, generation: phase.generation,
        evidenceCommit, coverage,
        // An unplanned path is accounted for by a narrow plan amendment, not by deleting it [E2G-012].
        // Which row is the approver's choice, so the rows go with it: nobody should have to open the plan to find them.
        ...(coverage.unclaimedChangedPaths.length ? {
          recoveryCommands: coverage.unclaimedChangedPaths.slice(0, 3).map((candidate) =>
            `singularity-flow decision plan ${workflow.workItem.id} --add-location <clause>=${candidate} --reason <why>`),
          planRows: planRowsOf(planned)
        } : {})
      }
    }
  );
}


export async function preparePhase(root, config, workflow, requested = undefined) {
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  const result = await preparePhaseInputs(root, config, workflow, requested);
  return result.path;
}

/** Load an immutable agreement only through the Story's sealed effective-policy pin. */
export async function loadStoryTestRecoveryAgreement(root, config, workflow) {
  const pin = workflow.resolution?.testRecoveryAgreement;
  if (!pin && !workflow.testRecovery && workflow.resolution?.testRecovery?.enabled !== true) return null;
  if (!pin || !workflow.testRecovery || workflow.resolution?.testRecovery?.enabled !== true
    || pin.agreementSha256 !== workflow.testRecovery.agreementSha256
    || pin.agreementPath !== workflow.testRecovery.agreementPath
    || pin.id !== workflow.testRecovery.id || pin.revision !== workflow.testRecovery.revision
    || pin.agreementPath !== `${workDirRelative(config, workflow.workItem.id)}/context/test-recovery/agreements/revision-${pin.revision}.json`) {
    throw new SingularityFlowError('The Story test-policy reference differs from its immutable workflow snapshot.', { code: 'TRP_AGREEMENT_REQUIRED' });
  }
  const snapshot = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: Number(workflow.workflowSnapshot?.revision ?? 1) > 1
  });
  if (snapshot.status !== 'ready' || snapshot.closure !== 'verified') {
    throw new SingularityFlowError('The Story workflow snapshot must verify before loading test policy.', { code: 'TRP_AGREEMENT_REQUIRED' });
  }
  const agreement = await readTrpRecord(workDir(root, config, workflow.workItem.id), {
    kind: 'story-test-recovery-agreement', id: pin.id, revision: pin.revision, recordSha256: pin.agreementSha256
  });
  if (agreement.subject.workId !== workflow.workItem.id
    || agreement.policyAuthoritySha256 !== pin.policyAuthoritySha256
    || agreement.confirmedPlanSha256 !== workflow.testRecovery.confirmedPlanSha256) {
    throw new SingularityFlowError('The agreement does not match the Story policy or confirmed creation plan.', { code: 'TRP_AGREEMENT_REQUIRED' });
  }
  return agreement;
}

/** Feature admission is independent of the later phase publication/test-evidence gates. */
const testRecoveryEnrollmentByWorkflow = new WeakMap();

function hasTestRecoveryPolicy(policy) {
  return policy?.testRecovery?.enabled === true || policy?.testRecoveryAgreement != null
    || policy?.testRecoveryInitialReadiness != null;
}

async function storyHasTestRecovery(root, config, workflow) {
  if (workflow.testRecovery != null || hasTestRecoveryPolicy(workflow.resolution)) return true;
  if (!workflow.workflowSnapshot) return false;
  // Absent mutable fields cannot establish legacy status for an enrolled Story.
  // Accepted CLI callers already carry the catalog's private verified capability;
  // direct callers verify once. Only the enrollment fact is cached, scoped to this
  // exact object, repository and immutable reference, never evidence or authority.
  const identity = canonicalJson({ root: path.resolve(root), workId: workflow.workItem?.id,
    snapshot: workflow.workflowSnapshot });
  const retained = testRecoveryEnrollmentByWorkflow.get(workflow);
  if (retained?.identity === identity) return retained.enabled;
  const catalog = await resolveStoryExecutionCatalog(root, config, workflow);
  const enabled = hasTestRecoveryPolicy(catalog.policy);
  testRecoveryEnrollmentByWorkflow.set(workflow, { identity, enabled });
  return enabled;
}

export async function assertStoryTestRecoveryFeatureAdmission(root, config, workflow, phase) {
  if (phaseRequiresCodeDelivery(phase)) await assertStoryBaselineDisposition(root, config, workflow);
  if (!await storyHasTestRecovery(root, config, workflow)) return { enabled: false, featureCodingAllowed: true };
  if (!phaseRequiresCodeDelivery(phase)) return { enabled: true, featureCodingAllowed: true, applicable: false };
  const agreement = await loadStoryTestRecoveryAgreement(root, config, workflow);
  const initial = workflow.resolution.testRecoveryInitialReadiness;
  let readiness = workflow.testRecovery.readiness;
  if (!initial || !Array.isArray(initial.repositories)) {
    throw new SingularityFlowError('The initial readiness binding is absent from the Story snapshot.', { code: 'TRP_READINESS_EVIDENCE_REQUIRED' });
  }
  if (readiness?.checkpointSha256) {
    const retainedCheckpoint = await readTrpReadinessCheckpoint(workDir(root, config, workflow.workItem.id), readiness.checkpointSha256);
    const checkpointPath = `${workDirRelative(config, workflow.workItem.id)}/context/test-recovery/readiness-checkpoints/${readiness.checkpointSha256.slice(7)}.json`;
    const committedCheckpoint = exactFileAtObject(root, head(root), checkpointPath);
    if (canonicalJson(retainedCheckpoint) !== canonicalJson(readiness)
      || !committedCheckpoint || committedCheckpoint.toString('utf8') !== canonicalJson(readiness)) {
      throw new SingularityFlowError('The exact readiness checkpoint must be committed before feature admission.', { code: 'TRP_REPAIR_PUBLICATION_REQUIRED' });
    }
    const originals = Object.fromEntries(initial.repositories.map((row) => [row.repositoryId, row.baseCommit]));
    const repairCommits = Object.fromEntries((readiness.repositories ?? []).map((row) => [row.repositoryId, row.featureBaseCommit]));
    const retained = {};
    for (const row of readiness.repositories ?? []) {
      const workRoot = workDir(root, config, workflow.workItem.id);
      const original = initial.repositories.find((candidate) => candidate.repositoryId === row.repositoryId);
      retained[row.repositoryId] = await readTrpRepairEvidence(workRoot, row.receiptSha256);
      const scope = inspectTrpRepairScope(root, { workflow, workRoot,
        baseCommit: original?.baseCommit, repairCommit: row.featureBaseCommit });
      if (scope.blockers.length) {
        throw new SingularityFlowError('The repair checkpoint includes product or baseline-test edits outside the bounded repair scope.',
          { code: 'TRP_REPAIR_SCOPE_UNAVAILABLE', details: { repositoryId: row.repositoryId, scope } });
      }
      const baseline = original?.baselineSha256 ? await readTrpOriginalBaseline(workRoot, original.baselineSha256) : null;
      assertTrpRepairCohortRetained(baseline, retained[row.repositoryId]);
    }
    const expected = completeTrpReadinessRepair({ agreement, currentReadiness: { repositories: retained },
      baseCommit: originals, repairCommit: repairCommits, originalReadiness: initial });
    if (canonicalJson(expected) !== canonicalJson(readiness)) {
      throw new SingularityFlowError('The readiness repair checkpoint no longer matches its exact retained evidence.', { code: 'TRP_REPAIR_EVIDENCE_INVALID' });
    }
  } else if (canonicalJson(readiness) !== canonicalJson(initial)) {
    throw new SingularityFlowError('Initial readiness cannot be changed without a verified repair checkpoint.', { code: 'TRP_READINESS_EVIDENCE_REQUIRED' });
  }
  const qualifiedRows = [];
  for (const row of readiness.repositories ?? []) {
    if (row.status !== 'pass') { qualifiedRows.push(row); continue; }
    const inspected = readiness.repositories.length === 1 ? await inspectRepositoryReadinessReceipt(root, {
      commit: row.featureBaseCommit ?? row.baseCommit, scope: row.scope ?? 'dependency-test', recompute: false
    }) : null;
    qualifiedRows.push(inspected?.status === 'pass' && inspected.receipt.receiptSha256 === row.receiptSha256
      ? row : { ...row, status: 'unavailable-on-current-host' });
  }
  const qualified = { ...workflow, workId: workflow.workItem.id,
    testRecovery: { ...workflow.testRecovery, readiness: { ...readiness, repositories: qualifiedRows } } };
  const decisions = await qualifiedTrpIntakeDecisions(root, config, workflow, agreement, phase);
  const admission = assertTrpFeatureAdmission(qualified, phase, { agreement, ...decisions });
  return { ...admission, ...(readiness?.checkpointSha256 && qualifiedRows.length === 1 ? {
    featureBaseCommit: qualifiedRows[0].featureBaseCommit, readinessCheckpointSha256: readiness.checkpointSha256
  } : {}) };
}

/** Only verified repair admission can move an unopened first feature baseline. */
async function ensureStoryFeatureWorkInterval(root, config, workflow, phase, admission) {
  const options = { phaseId: phase.id, itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id) };
  if (admission.featureBaseCommit && phaseRequiresCodeDelivery(phase)) {
    const codePhases = Object.values(workflow.phases ?? {}).filter(phaseRequiresCodeDelivery);
    const hasPublishedFeature = codePhases.some((candidate) => Number(candidate.generation ?? 0) > 0);
    if (!hasPublishedFeature) {
      const current = workflow.workIntervals?.current;
      const samePhase = current?.phaseId === phase.id && current.status === 'open';
      if (codePhases.some((candidate) => candidate.generationIntent)
        && (!samePhase || current.sourceBaseCommit !== admission.featureBaseCommit)) {
        throw new SingularityFlowError('A readiness repair cannot change an already-open feature generation boundary.',
          { code: 'TRP_FEATURE_BASE_ALREADY_OPEN' });
      }
      options.sourceBaseCommit = admission.featureBaseCommit;
      options.baselineTag = `trp-repair-${admission.readinessCheckpointSha256.slice(7, 39)}`;
      if (samePhase && current.sourceBaseCommit !== admission.featureBaseCommit) {
        // Keep the original file and history entry intact. The new baseline has a
        // distinct path and ordinal, and is still checked by ordinary interval integrity.
        workflow.workIntervals.current = null;
      }
    }
  }
  return ensureWorkIntervalBaseline(root, config, workflow, options);
}

function committedArtifactBaseline(root, relativePath) {
  const result = run('git', ['show', `HEAD:${relativePath}`], {
    cwd: root, allowFailure: true, maxBuffer: 16 * 1024 * 1024
  });
  return result.status === 0 ? result.stdout : null;
}

export async function beginPhaseGeneration(root, config, workflow, {
  phaseId = workflow.currentPhase,
  adoptExisting = false,
  confirm = null
} = {}) {
  assertStoryNotArchived(root, workflow);
  const session = await loadSession(root, { required: false });
  assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId], session, 'begin');
  assertIntentAmendmentAcknowledged(workflow);
  await assertNoPendingPublication(root, config, workflow, 'begin code generation');
  const phase = await assertPhaseSequence(root, workflow, 'begin code generation', { requestedPhase: phaseId });
  await assertDocumentInputs(root, config, workflow, phase);
  const testAdmission = await assertStoryTestRecoveryFeatureAdmission(root, config, workflow, phase);
  const riskInput = workflow.resolution?.phases?.find(item => item.id === phase.id)?.testEvidenceFrom;
  if (riskInput && workflow.phases[riskInput]?.deliveryEvidence?.testRecovery) await assertPassedCodeDeliveryInput(root, config, workflow, phase);
  await assertSkillPhaseHostReady(workflow, phase, 'begin code generation for');
  if (!phaseRequiresCodeDelivery(phase)) {
    throw new SingularityFlowError(`Phase '${phase.id}' is not a code-generation phase.`, { code: 'GENERATION_INTENT_NOT_APPLICABLE' });
  }
  await assertPlannedSpecificationClaims(root, config, workflow, phase);
  await ensureStoryFeatureWorkInterval(root, config, workflow, phase, testAdmission);
  return beginCodeGeneration(root, config, workflow, phase, {
    adoptExisting,
    confirm,
    actor: session?.actor ?? null,
    agent: session?.agent ?? null
  });
}

export async function preparePhaseInputs(root, config, workflow, requested = undefined, {
  dryRun = false
} = {}) {
  if (!dryRun) assertStoryNotArchived(root, workflow);
  const session = await loadSession(root, { required: false });
  if (!dryRun) assertPhaseAgentMayMutate(config, workflow,
    workflow.phases?.[requested ?? workflow.currentPhase],
    session, 'prepare');
  if (!dryRun) assertIntentAmendmentAcknowledged(workflow);
  await verifyAcceptedTestCommandAmendment(root, config, workflow);
  if (!dryRun) await assertNoPendingPublication(root, config, workflow, 'prepare or change phase inputs');
  const phase = await assertPhaseSequence(root, workflow, 'prepare', { requestedPhase: requested });
  await (await import('./document-runtime.mjs')).requirePhaseDocuments(root, config, workflow, phase.id);
  // A required after-step action holds every later step (prepare, publish, submit) until its
  // approved delivery has a receipt.
  if (!dryRun) await assertRequiredStepActionsRecorded(root, config, workflow, `${phase.id} cannot be prepared`);
  await assertDocumentInputs(root, config, workflow, phase);
  const testAdmission = await assertStoryTestRecoveryFeatureAdmission(root, config, workflow, phase);
  const riskInput = workflow.resolution?.phases?.find(item => item.id === phase.id)?.testEvidenceFrom;
  if (riskInput && workflow.phases[riskInput]?.deliveryEvidence?.testRecovery) await assertPassedCodeDeliveryInput(root, config, workflow, phase);
  if (!dryRun) await assertSkillPhaseHostReady(workflow, phase, 'prepare');
  let references = [];
  if (!dryRun) {
    references = await storyReferenceRepositories(root, config, workflow);
    const referenceStatus = await verifyReferenceRepositories(root, references);
    if (referenceStatus.status === 'blocked') {
      const materialize = referenceStatus.nextAction?.replace('<WORK-ID>', workflow.workItem.id);
      throw new SingularityFlowError(
        `Phase ${phase.id} reference repositories are not ready. ${materialize
          ? `Run: ${materialize}`
          : 'Inspect them with singularity-flow story references list --work-id '
            + `${workflow.workItem.id}.`}`,
        { code: 'REFERENCE_REPOSITORIES_NOT_READY', details: referenceStatus }
      );
    }
  }
  const explicitlyReopened = phaseExplicitlyReopened(workflow, phase);
  if (!dryRun
      && phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed'
      && Number(phase.generationIntent.generation) === Number(phase.generation)
      && !explicitlyReopened) {
    throw new SingularityFlowError(
      `Phase '${phase.id}' generation ${phase.generation} is already published. `
      + `Run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json, `
      + 'then execute its exact phase-begin action before preparing the next generation.',
      { code: 'GENERATION_INTENT_ALREADY_CONSUMED', details: {
        nextAction: { command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json`, skill: '/sf-recover' }
      } }
    );
  }
  await assertMcpPhaseReadiness(root, workflow, phase);
  await hydrateImpactPlan(root, workflow);
  const impactGate = impactImplementationGate(workflow, phase.id);
  if (impactGate) throw new SingularityFlowError(impactGate);
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  if (!dryRun) {
    if (phaseRequiresCodeDelivery(phase)) {
      await assertPlannedSpecificationClaims(root, config, workflow, phase);
    }
    await ensureStoryFeatureWorkInterval(root, config, workflow, phase, testAdmission);
  }
  const targetRelative = posix(path.relative(root, path.join(itemDirectory, phase.requiredArtifact.path)));
  const securedTarget = await secureRepositoryPath(root, targetRelative, {
    label: `Required artifact for phase '${phase.id}'`
  });
  const target = securedTarget.absolute;
  const artifactExistedBeforePreparation = securedTarget.exists;
  const canonicalMetadata = artifactMetadataBlock(storyArtifactMetadata(workflow, phase));
  let preparedArtifactText = null;
  let metadataRepair = null;
  const binaryArtifact = !dryRun && artifactExistedBeforePreparation && !artifactBytesAreText(await readFile(target));
  if (!dryRun && artifactExistedBeforePreparation && !binaryArtifact) {
    const currentArtifactText = await readFile(target, 'utf8');
    const repaired = repairPreparedArtifactMetadata(currentArtifactText, {
      canonicalMetadata,
      baselineText: committedArtifactBaseline(root, targetRelative)
    });
    if (!repaired) {
      throw new SingularityFlowError(
        `Phase ${phase.id} artifact metadata is malformed and its author-owned boundary cannot be recovered safely. `
        + 'The artifact was preserved unchanged; inspect the recovery report before retrying prepare.',
        { code: 'ARTIFACT_METADATA_REPAIR_UNSAFE', details: { path: targetRelative } }
      );
    }
    preparedArtifactText = repaired.text;
    metadataRepair = repaired.status;
  }
  const executionCatalog = workflow.workflowSnapshot
    ? await resolveStoryExecutionCatalog(root, config, workflow)
    : null;
  const executionContext = executionCatalog && session?.agent
    ? await resolveStoryExecutionContext(root, config, workflow, {
        agentId: session.agent, phaseId: phase.id, executionCatalog
      })
    : null;
  const inputs = await collectInputs(root, workflow, phase, { definition: config, itemDirectory, itemRelative });
  // A dry run reports which inputs stop the phase; only a real preparation refuses on them.
  if (inputs.errors.length && !dryRun) throw phaseInputsNotReadyError(workflow, phase, inputs);
  if (dryRun) inputs.findings = inputReadinessFindings(inputs);
  const rendered = renderInputsBlock(inputs);
  if (!dryRun) {
    if (phaseRequiresCodeDelivery(phase)) {
      if (phase.generationIntent?.status !== 'open') {
        await beginCodeGeneration(root, config, workflow, phase, {
          actor: session?.actor ?? null,
          agent: session?.agent ?? null,
          inputRenderedSha256: rendered.sha256
        });
      }
    } else if (phase.generationPolicy?.producer !== 'deterministic') {
      // Deterministic phases do not open a Copilot usage interval. Besides being misleading, a
      // cursor is machine-local state outside the Story draft rollback boundary; a later corrupt
      // projection or assisted-model refusal could leave that cursor behind and attribute an
      // unrelated retry to the failed attempt. Assisted convergence records its invocation through
      // the model audit boundary itself.
      await beginTelemetryCapture(root, workflow, phase);
    }
  }
  const remote = dryRun ? { outputs: [], warnings: [] } : await prepareRemoteOutputs(
    root, workflow, phase, session,
    { itemDirectory, executionContext }
  );
  if (remote.outputs.length) {
    phase.remoteOutputs = [...(phase.remoteOutputs ?? []).filter((entry) => !remote.outputs.some((output) => output.resource === entry.resource && output.generation === entry.generation)), ...remote.outputs];
  }
  if (!dryRun) {
    if (isConvergencePhase(phase)
        && phase.generationPolicy?.producer === 'deterministic'
        && artifactExistedBeforePreparation) {
      // The convergence kernel already rendered this artifact from its sealed projection. A
      // publication retry still refreshes declared input records and managed metadata, but must
      // never replace the canonical body with the generic deterministic phase scaffold.
      let canonicalArtifact = preparedArtifactText;
      canonicalArtifact = applyInputsBlock(canonicalArtifact, rendered.text, inputs.mode);
      await writeText(target, canonicalArtifact);
      if (phase.kind === 'skill'
          || (workflowInputsMode(workflow) !== 'off' && resolvedPhaseInputs(workflow, phase).length)) {
        const recorded = await recordInputs(root, workflow, phase, inputs, { itemDirectory });
        phase.inputContext = {
          generation: inputs.generation,
          path: recorded.path,
          sha256: recorded.sha256,
          renderedSha256: recorded.record.renderedSha256,
          mode: inputs.mode
        };
        await updateArtifactMetadata(root, config, workflow, phase);
      }
      if (remote.outputs.length) {
        phase.agentContext = {
          agent: session.agent,
          generation: nextPhaseGeneration(phase),
          outputs: remote.outputs.map((item) => item.resource),
          warnings: remote.warnings
        };
        await updateArtifactMetadata(root, config, workflow, phase);
        await updateRemoteOutputRenderedHashes(root, workflow, phase, {
          itemDirectory, generation: nextPhaseGeneration(phase)
        });
      }
      reservePreparedDocumentSuccessor(workflow, phase, nowIso());
      return {
        phase,
        path: posix(path.relative(root, target)),
        ...inputs,
        renderedSha256: rendered.sha256,
        metadataRepair,
        remoteOutputs: remote.outputs,
        remoteWarnings: remote.warnings
      };
    }
    let text;
    // A binary artifact (PDF, DOCX, PNG) keeps its exact bytes: it carries no template, sections,
    // inputs block or metadata. Rebuilding its "text" here overwrote it on every publish (2026-10-29);
    // its inputs are still recorded below, in the Story's context.
    if (binaryArtifact) text = null;
    else if (phase.generationPolicy?.producer === 'deterministic') {
      const { specificationClaimLines, storyChangedPathLines } = await import('./deterministic-summary-facts.mjs');
      const pathContext = applicationPathContext(config, workflow);
      const uncommitted = changedFiles(root).map(posix)
        .filter((candidate) => isApplicationPath(candidate, pathContext));
      // What the Story changed, not only what is uncommitted now: a step after a commit listed nothing.
      const storyBase = workflow.workItem.baseCommit ?? workflow.workItem.baseBranch ?? null;
      let committed = null;
      try {
        committed = storyBase ? changedRepositoryPaths(root, { base: storyBase, target: 'HEAD', pathContext }) : null;
      } catch {
        // A shallow clone or missing base: the summary says only uncommitted paths are listed.
      }
      const checks = (phase.qualityCommands ?? []).length
        ? phase.qualityCommands.map((command, index) => `- \`${externalCommandText(command, index)}\``).join('\n')
        : '- No mandatory commands are configured for this phase.';
      const specRecords = specificationPolicy(config, workflow).mode === 'off' ? undefined
        : await loadActiveSpecRecords(itemDirectory, workflow).catch(() => null);
      text = [
        `# ${phase.label}`,
        '',
        '> Deterministically assembled by Singularity Flow. No model call was used.',
        '',
        '## Work item',
        '',
        `- ID: **${workflow.workItem.id}**`,
        `- Title: ${workflow.workItem.title}`,
        `- Work type: ${workflow.workItem.workType}`,
        `- Phase: ${phase.id}`,
        `- Source commit: \`${head(root)}\``,
        '',
        '## Changed paths',
        '',
        ...storyChangedPathLines(workflow, { committed, uncommitted }),
        '',
        '## Configured checks',
        '',
        checks,
        '',
        '## Specification claims',
        '',
        ...(specRecords === undefined ? ['- Specification tracking is off for this Story.'] : specificationClaimLines(specRecords, workflow)),
        '',
        '## Governed inputs',
        '',
        rendered.text || '_No phase inputs are declared._',
        ''
      ].join('\n');
    } else if (artifactExistedBeforePreparation) {
      text = normalizeArtifactTemplateCompatibility(preparedArtifactText, {
        id: workflow.workItem.id
      });
    }
    else text = await renderArtifactTemplate(root, config, workflow.resolution.phases.find((item) => item.id === phase.id), {
      id: workflow.workItem.id,
      title: workflow.workItem.title,
      workType: workflow.workItem.workType,
      inputs: rendered.text,
      templateSnapshot: workflow.resolution.templates?.[phase.id],
      retainedTemplate: executionCatalog?.phaseTemplates?.[phase.id]
    });
    if (!artifactExistedBeforePreparation && phasePlansDelivery(workflow, phase)) {
      const { capsule } = await activeClauseCapsule(itemDirectory, workflow, phase, null, { root });
      text = scaffoldPlanningRows(text, (capsule?.clauses ?? []).map(clause => clause.id));
    }
    // A repository template can predate (or have edited away) a section this phase is checked for;
    // copy it from the packaged template so the author fills a section instead of inventing one.
    // An existing draft gains it too: preparation always opens a new, unpublished generation, and
    // only missing sections are inserted, so no authored or published byte is changed. A Story
    // prepared before this rule (stuck at "Add ## Scenario coverage") recovers on its next prepare.
    if (!binaryArtifact && phase.generationPolicy?.producer !== 'deterministic') {
      const resolvedPhase = workflow.resolution.phases.find((item) => item.id === phase.id);
      text = addMissingSections(text, requiredArtifactSections(resolvedPhase), {
        ownRef: resolvedPhase?.template, tokens: artifactTokens({ workItem: workflow.workItem, phase: resolvedPhase })
      }).text;
    }
    if (!binaryArtifact) text = applyInputsBlock(text, rendered.text, inputs.mode);
    // The immutable reference set is already captured by the WFA snapshot and its Story manifest.
    // Put only its bounded identifiers and local detached paths into a newly created phase artifact
    // so every authoring surface can find the sources without searching home or copying content
    // into prompts. Never inject this block into an existing, user-authored artifact on a retry.
    const referenceContext = referenceRepositoryContextMarkdown(references);
    if (!artifactExistedBeforePreparation && phase.requiredArtifact?.kind === 'conformance-report') {
      text = withSelfApprovalDisclosures(text, workflow);
    }
    // One verdict source: every prepare writes, or refreshes in an existing draft, the engine-owned
    // Verdict summary read from the clause table, so no prose has to restate a verdict.
    if (!binaryArtifact && phase.requiredArtifact?.kind === 'conformance-report') {
      text = withVerdictSummary(text, workflow, phase.id, { reused: await conformanceEvidenceReuse(root, config, workflow, phase.id) });
    }
    if (!artifactExistedBeforePreparation && referenceContext) text = `${referenceContext}\n\n${text}`;
    if (!artifactExistedBeforePreparation) {
      const initialized = repairPreparedArtifactMetadata(text, { canonicalMetadata });
      if (!initialized) {
        throw new SingularityFlowError(
          `Phase ${phase.id} template contains malformed Singularity Flow metadata. `
          + 'The artifact was not written; refresh the approved template before retrying prepare.',
          { code: 'ARTIFACT_TEMPLATE_METADATA_INVALID', details: { path: targetRelative } }
        );
      }
      text = initialized.text;
      metadataRepair = initialized.status;
    }
    if (!binaryArtifact) await writeText(target, text);
    const targetGeneration = nextPhaseGeneration(phase);
    // Capture only bytes the kernel itself just rendered. Capturing an existing generation-one
    // artifact after an upgrade or repeated prepare would redefine completed authoring as the
    // baseline and make a valid artifact fail until it changed again. Every path that actually
    // creates the template captures it, including the lower-level input-preparation path.
    if (!artifactExistedBeforePreparation
        && targetGeneration === 1
        && phase.generationPolicy?.producer !== 'deterministic'
        && phase.authoringBaseline?.generation !== targetGeneration) {
      const authored = authoredArtifactText(text);
      phase.authoringBaseline = {
        generation: targetGeneration,
        path: phase.requiredArtifact.path,
        fingerprint: authoredArtifactFingerprint(authored),
        bytes: Buffer.byteLength(authored)
      };
    }
    if (phase.kind === 'skill'
        || (workflowInputsMode(workflow) !== 'off' && resolvedPhaseInputs(workflow, phase).length)) {
      const recorded = await recordInputs(root, workflow, phase, inputs, { itemDirectory });
      phase.inputContext = { generation: inputs.generation, path: recorded.path, sha256: recorded.sha256, renderedSha256: recorded.record.renderedSha256, mode: inputs.mode };
      await updateArtifactMetadata(root, config, workflow, phase);
    }
    if (remote.outputs.length) {
      phase.agentContext = { agent: session.agent, generation: nextPhaseGeneration(phase), outputs: remote.outputs.map((output) => output.resource), warnings: remote.warnings };
      await updateArtifactMetadata(root, config, workflow, phase);
      await updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory, generation: nextPhaseGeneration(phase) });
    }
    reservePreparedDocumentSuccessor(workflow, phase, nowIso());
  }
  await (await import('./workflow-task-store.mjs')).observeWorkflowTask(root, workflow, phase, {
    state: 'author-draft', checkpoint: 'prepared', fingerprint: rendered.sha256
  }, { generation: inputs.generation ?? nextPhaseGeneration(phase) });
  return {
    phase, path: posix(path.relative(root, target)), ...inputs,
    renderedSha256: rendered.sha256, metadataRepair,
    remoteOutputs: remote.outputs, remoteWarnings: remote.warnings
  };
}

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.clj', '.cljc', '.cljs', '.cpp', '.cs', '.css', '.ex', '.exs', '.fs',
  '.fsi', '.fsx', '.go', '.groovy', '.gsh', '.gvy', '.gy', '.h', '.hpp', '.html',
  '.java', '.js', '.jsx', '.kt', '.kts', '.lua', '.mjs', '.php', '.pl', '.proto',
  '.py', '.r', '.rb', '.rs', '.scala', '.scss', '.sh', '.sol', '.sql', '.swift',
  '.ts', '.tsx', '.vue', '.zig'
]);
export function inferKind(relativePath) {
  const value = relativePath.toLowerCase();
  if (value.includes('/implementation-spec')) return 'implementation-spec';
  if (value.includes('/spec-code-comparison')) return 'conformance-report';
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/.test(value) || /\.(test|spec)\.[^.]+$/.test(value)) return 'test';
  if (SOURCE_EXTENSIONS.has(path.extname(value))) return 'code';
  if (/\.(md|mdx|txt|adoc|rst)$/.test(value)) return 'document';
  if (/\.(json|ya?ml|toml|ini|properties)$/.test(value)) return 'configuration';
  return 'file';
}

function artifactFor(phase, relativePath) { return phase.artifacts.find((item) => item.path === relativePath); }

/**
 * Snapshot a repository artifact without ever following its final symlink.
 *
 * Git records a symbolic link's link text, not the bytes of its target.  Treating a symlink like a
 * regular file here used to let registration, approval, and generation hashing read arbitrary
 * files outside the repository.  Link text may still be indexed as evidence, but every caller that
 * needs authored text must use readRepositoryArtifactText(), which requires a regular file.
 */
async function repositoryArtifactSnapshot(root, relativePath) {
  const secured = await secureRepositoryPath(root, relativePath, {
    label: 'Artifact',
    allowFinalSymlink: true
  });
  if (!secured.entry) return { exists: false, size: 0, sha256: null };
  if (secured.entry.isSymbolicLink()) {
    const link = Buffer.from(await readlink(secured.absolute));
    return {
      exists: true,
      size: link.length,
      sha256: createHash('sha256').update(link).digest('hex'),
      symbolicLink: true
    };
  }
  if (!secured.entry.isFile()) {
    return { exists: true, size: secured.entry.size, sha256: null };
  }
  return snapshot(secured.absolute);
}

async function readRepositoryArtifactText(root, relativePath) {
  const secured = await secureRepositoryPath(root, relativePath, {
    label: 'Artifact',
    mustExist: true,
    type: 'file'
  });
  return readFile(secured.absolute, 'utf8');
}

const ARTIFACT_METADATA_PATTERN = /^<!-- singularity-flow:metadata\r?\n[\s\S]*?\r?\n-->/;

function exactAuthoredArtifactSha256(text) {
  return `sha256:${createHash('sha256').update(authoredArtifactText(text)).digest('hex')}`;
}

/** Git may normalize a mixed editor draft; prove that policy without executing clean filters. */
function artifactGitTextCheckoutMatches(root, relativePath, published, current) {
  if (artifactTextCheckoutMatches(published, current)) return true;
  const canonical = value => value.replaceAll('\r\n', '\n');
  const left = canonical(published), right = canonical(current);
  if (left !== right || left.includes('\r') || left.includes('\0') || left.includes('\uFFFD') || left.startsWith('\uFEFF')) return false;
  return artifactGitNormalizesText(root, relativePath);
}

/** Prove only Git's built-in text conversion; never invoke repository clean filters. */
function artifactGitNormalizesText(root, relativePath) {
  const output = gitReadOutput(run('git', ['check-attr', '-z', 'text', 'eol', 'filter', 'working-tree-encoding', '--', relativePath], {
    cwd: root, allowFailure: true, timeoutMs: 5_000, maxBuffer: 128 * 1024
  }), 'Artifact checkout attributes');
  const fields = output.split('\0');
  if (fields.at(-1) !== '' || fields.length !== 13) return false;
  const attributes = {};
  for (let index = 0; index < fields.length - 1; index += 3) {
    if (fields[index] !== relativePath || Object.hasOwn(attributes, fields[index + 1])) return false;
    attributes[fields[index + 1]] = fields[index + 2];
  }
  if (!['unspecified', 'unset'].includes(attributes.filter)
      || attributes['working-tree-encoding'] !== 'unspecified' || attributes.text === 'unset') return false;
  if (['set', 'auto'].includes(attributes.text) || ['lf', 'crlf'].includes(attributes.eol)) return true;
  if (attributes.text !== 'unspecified') return false;
  const autocrlf = gitReadOutput(run('git', ['config', '--get', 'core.autocrlf'], {
    cwd: root, allowFailure: true, timeoutMs: 5_000, maxBuffer: 4096
  }), 'Artifact checkout conversion', { absentStatus: 1 });
  return ['true', 'input'].includes(String(autocrlf ?? '').trim().toLowerCase());
}

function artifactMetadataCandidate(workflow, phase, overrides = {}) {
  const candidate = structuredClone(phase);
  Object.assign(candidate, overrides);
  return artifactMetadataBlock(storyArtifactMetadata(workflow, candidate));
}

/**
 * Classify the required artifact against the immutable generation before submission mutates state.
 *
 * Registration is only an index. The generation commit remains the authority for author-owned
 * bytes, while current workflow state remains the authority for engine-owned metadata. This split
 * lets SFlow repair its own stale index without ever blessing contributor edits made after publish.
 */
export async function inspectRequiredArtifactRegistration(root, config, workflow, phase, {
  generationCommit = null
} = {}) {
  const relativePath = requiredRepoPath(config, workflow, phase);
  const registered = artifactFor(phase, relativePath) ?? null;
  const current = await repositoryArtifactSnapshot(root, relativePath);
  if (Number(phase.generation) < 1) return { status: 'not-applicable', reason: 'unpublished', path: relativePath, registered, current };
  if (phaseNeedsGeneration(workflow, phase)) {
    return { status: 'not-applicable', reason: 'fresh-generation-required', path: relativePath, registered, current };
  }
  if (!current.exists) return { status: 'unsafe', reason: 'missing', path: relativePath, registered, current };

  const exactCommit = generationCommit ?? publishedGenerationCommit(root, workflow, phase);
  if (!exactCommit) return { status: 'unavailable', reason: 'generation-commit-missing', path: relativePath, registered, current };
  const publishedResult = run('git', ['show', `${exactCommit}:${relativePath}`], { cwd: root, allowFailure: true });
  if (publishedResult.status !== 0) return {
    status: 'unsafe', reason: 'published-artifact-missing', path: relativePath, registered, current,
    generationCommit: exactCommit
  };

  // A binary artifact (PDF, DOCX, PNG) carries no managed metadata or inputs block, so it reconciles
  // only as the exact bytes its generation published; reading it as text refused every submit.
  const securedCurrent = await secureRepositoryPath(root, relativePath, { label: 'Artifact', mustExist: true, type: 'file' });
  const currentBytes = await readFile(securedCurrent.absolute);
  if (!artifactBytesAreText(currentBytes)) {
    const publishedBytes = exactFileAtObject(root, exactCommit, relativePath, { maximumBytes: currentBytes.length + 1 });
    const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const binaryBase = { path: relativePath, registered, current, generationCommit: exactCommit,
      currentAuthoredSha256: digest(currentBytes), publishedAuthoredSha256: publishedBytes ? digest(publishedBytes) : null };
    if (!publishedBytes || !publishedBytes.equals(currentBytes)) return { ...binaryBase, status: 'unsafe', reason: 'authored-content-changed' };
    const registeredCurrent = Boolean(registered) && registered.exists === current.exists
      && registered.size === current.size && registered.sha256 === current.sha256;
    return { ...binaryBase, status: registeredCurrent ? 'current' : 'repairable', reason: registeredCurrent ? null : 'managed-registration-stale' };
  }
  const currentText = currentBytes.toString('utf8');
  const publishedText = publishedResult.stdout;
  const currentAuthoredSha256 = exactAuthoredArtifactSha256(currentText);
  const publishedAuthoredSha256 = exactAuthoredArtifactSha256(publishedText);
  const base = {
    path: relativePath, registered, current, generationCommit: exactCommit,
    currentAuthoredSha256, publishedAuthoredSha256
  };
  if (currentAuthoredSha256 !== publishedAuthoredSha256
      && !artifactGitTextCheckoutMatches(root, relativePath, authoredArtifactText(publishedText), authoredArtifactText(currentText))) {
    return { ...base, status: 'unsafe', reason: 'authored-content-changed' };
  }

  const metadata = currentText.match(ARTIFACT_METADATA_PATTERN)?.[0]?.replaceAll('\r\n', '\n') ?? null;
  const canonicalMetadata = new Set([
    artifactMetadataCandidate(workflow, phase),
    artifactMetadataCandidate(workflow, phase, { generationCommit: exactCommit }),
    artifactMetadataCandidate(workflow, phase, { publicationCommit: exactCommit }),
    artifactMetadataCandidate(workflow, phase, {
      generationCommit: exactCommit,
      publicationCommit: exactCommit
    })
  ]);
  // A runner-only amendment preserves the already published artifact, including the old
  // engine metadata. Accept those exact reviewed bytes under the authenticated amendment;
  // never infer permission from mutable phase flags or accept a merely similar metadata block.
  if (metadata && !canonicalMetadata.has(metadata)
    && phase.testCommandRevalidation?.generation === phase.generation) {
    await verifyAcceptedTestCommandAmendment(root, config, workflow);
    const summary = (workflow.testCommandAmendments ?? []).findLast(entry => entry.phaseId === phase.id);
    const reviewBytes = summary?.reviewPath
      ? exactFileAtObject(root, head(root), summary.reviewPath, { maximumBytes: 1024 * 1024 }) : null;
    if (reviewBytes && `sha256:${createHash('sha256').update(reviewBytes).digest('hex')}` === summary.reviewSha256) {
      const review = JSON.parse(reviewBytes.toString('utf8'));
      const currentSha256 = `sha256:${createHash('sha256').update(currentText).digest('hex')}`;
      if (review.revalidation?.generation === phase.generation
        && review.preserved?.draftSha256 === currentSha256) canonicalMetadata.add(metadata);
    }
  }
  if (!metadata || !canonicalMetadata.has(metadata)) {
    return { ...base, status: 'unsafe', reason: 'managed-metadata-invalid' };
  }

  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  const declarations = phase.kind === 'skill'
    ? (await resolveStorySkillPackage(root, config, workflow, { phaseId: phase.id })).bindingRefs.inputs ?? []
    : resolvedPhaseInputs(workflow, phase);
  // A skill phase can legitimately declare zero inputs. It must not accept an attacker-authored
  // managed input block in that case merely because skill phases always use receipt validation.
  if (phase.kind === 'skill' && !declarations.length && extractInputsBlock(currentText)) {
    return { ...base, status: 'unsafe', reason: 'unexpected-managed-inputs' };
  }
  if (phase.kind !== 'skill' && (workflowInputsMode(workflow) === 'off' || !declarations.length)) {
    if (extractInputsBlock(currentText)) return { ...base, status: 'unsafe', reason: 'unexpected-managed-inputs' };
  } else {
    const integrity = await verifyInputsIntegrity(root, workflow, phase, {
      definition: config, itemDirectory, itemRelative
    });
    if (integrity.errors.length || integrity.warnings.length) {
      return {
        ...base, status: 'unsafe', reason: 'managed-inputs-invalid',
        inputFindings: [...integrity.errors, ...integrity.warnings]
      };
    }
  }

  const registrationCurrent = Boolean(registered)
    && registered.exists === current.exists
    && registered.size === current.size
    && registered.sha256 === current.sha256;
  return { ...base, status: registrationCurrent ? 'current' : 'repairable', reason: registrationCurrent ? null : 'managed-registration-stale' };
}

function repairRequiredArtifactRegistration(workflow, phase, inspection, session) {
  const timestamp = nowIso();
  const existing = inspection.registered;
  const previousSha256 = existing?.sha256 ?? null;
  const record = {
    path: inspection.path,
    kind: existing?.kind ?? phase.requiredArtifact.kind ?? inferKind(inspection.path),
    status: existing?.status ?? 'pending',
    exists: inspection.current.exists,
    size: inspection.current.size,
    sha256: inspection.current.sha256,
    registeredAt: existing?.registeredAt ?? timestamp,
    updatedAt: timestamp
  };
  if (existing) Object.assign(existing, record);
  else phase.artifacts.push(record);
  phase.artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const repair = {
    generation: phase.generation,
    path: inspection.path,
    reason: inspection.reason,
    previousSha256,
    currentSha256: inspection.current.sha256,
    authoredSha256: inspection.currentAuthoredSha256,
    generationCommit: inspection.generationCommit,
    repairedAt: timestamp
  };
  phase.artifactRegistrationRepairs ??= [];
  phase.artifactRegistrationRepairs.push(repair);
  phase.artifactRegistrationRepairs = phase.artifactRegistrationRepairs.slice(-25);
  workflow.history.push({
    at: timestamp,
    actor: actorKey(session.actor),
    agent: session.agent,
    event: 'artifact_registration_repaired',
    phase: phase.id,
    detail: `${inspection.path}: ${repair.previousSha256 ?? 'unregistered'} → ${repair.currentSha256}`
  });
  return repair;
}

export async function registerArtifact(root, workflow, candidate, { phaseId, kind, config = null } = {}) {
  assertStoryNotArchived(root, workflow);
  const phase = await assertPhaseSequence(root, workflow, 'register artifacts', { requestedPhase: phaseId });
  const absolute = path.resolve(root, candidate); const relativePath = repoRelative(root, absolute);
  const itemRoot = workDirRelative(config ?? workflow.resolution ?? {}, workflow.workItem.id);
  const phaseArtifacts = `${itemRoot}/artifacts/`;
  if (!relativePath.startsWith(phaseArtifacts)
      && !isApplicationPath(relativePath, applicationPathContext(config, workflow))) {
    throw new SingularityFlowError(
      `Artifact '${relativePath}' is outside Story '${workflow.workItem.id}' ownership. Register `
        + `application source or a file below ${phaseArtifacts}; another Story, Initiative, template, `
        + 'world-model, or configuration path cannot be adopted by this phase.',
      {
        code: 'ARTIFACT_PATH_OUTSIDE_STORY',
        details: { path: relativePath, workId: workflow.workItem.id, artifactRoot: phaseArtifacts }
      }
    );
  }
  const info = await repositoryArtifactSnapshot(root, relativePath); const existing = artifactFor(phase, relativePath); const timestamp = nowIso();
  const record = { path: relativePath, kind: kind ?? inferKind(relativePath), status: 'pending', exists: info.exists, size: info.size, sha256: info.sha256, registeredAt: existing?.registeredAt ?? timestamp, updatedAt: timestamp };
  if (existing) Object.assign(existing, record); else phase.artifacts.push(record);
  phase.artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return record;
}

function ignored(config, workflow, relativePath, { untracked = false } = {}) {
  if (isTransientTestResultPath(relativePath)) return true;
  if (untracked && isGeneratedOutputPath(relativePath)) return true;
  if ([WORKFLOW_PATH, 'singularity/config.json', 'singularity/worldmodel.json'].includes(relativePath)) return true;
  if (relativePath.startsWith('singularity/world-model/')) return true;
  if (['.git/', '.idea/', '.vscode/'].some((prefix) => relativePath.startsWith(prefix))) return true;
  const itemRoot = workDirRelative(config, workflow.workItem.id);
  if (relativePath.startsWith(`${itemRoot}/artifacts/`)) return false;
  if (relativePath.startsWith(`${itemRoot}/`)) return true;
  return !isApplicationChangePath(relativePath, {
    ...applicationPathContext(config, workflow), untracked
  });
}

export async function scanArtifacts(root, config, workflow, phaseId = undefined) {
  await assertNoPendingPublication(root, config, workflow, 'scan or register artifacts');
  const phase = await assertPhaseSequence(root, workflow, 'scan artifacts', { requestedPhase: phaseId }); const records = [];
  const skillPackage = phase.kind === 'skill'
    ? await resolveStorySkillPackage(root, config, workflow, { phaseId: phase.id }) : null;
  const skillOutputKinds = new Map((skillPackage?.bindingRefs?.outputs ?? []).map((output) => [
    posix(path.posix.join(workDirRelative(config, workflow.workItem.id), output.path)), output.kind
  ]));
  pruneTransientArtifactRegistrations(phase);
  const inventory = artifactChangeInventory(root);
  const untracked = inventory.untracked;
  // `prepare` creates the required phase artifact on purpose. Calling that expected output an
  // "adopted" file makes the ordinary authoring path look like accidental scope expansion and, on
  // a failed publication retry, repeats the same alarming warning indefinitely. Still register it
  // below — it is governed evidence — but reserve the adoption warning for files the phase did not
  // explicitly declare.
  const requiredArtifact = requiredRepoPath(config, workflow, phase);
  const adopted = [];
  const discovered = inventory.paths.filter((item) => !ignored(config, workflow, item, { untracked: untracked.has(item) }));
  const discoveredPaths = new Set(discovered);
  // A code step adopts only what its plan names [E2G-027]; every other changed application file is
  // excluded: left where it is, never registered and never committed.
  const scope = await codeCandidateScope(workDir(root, config, workflow.workItem.id), workflow, phase);
  const pathContext = applicationPathContext(config, workflow);
  const excluded = new Set(scope ? discovered.filter((file) => isApplicationPath(file, pathContext) && !scope.allows(file)) : []);
  if (scope) {
    phase.artifacts = phase.artifacts.filter((artifact) => !excluded.has(artifact.path));
    if (excluded.size) phase.excludedChanges = [...excluded].sort(); else delete phase.excludedChanges;
  }
  for (const file of discovered) {
    if (excluded.has(file)) continue;
    records.push(await registerArtifact(root, workflow, file, {
      phaseId: phase.id, kind: skillOutputKinds.get(file), config
    }));
    if (untracked.has(file) && file !== requiredArtifact) adopted.push(file);
  }
  // A prior SFlow build or lifecycle transition may have committed managed metadata while leaving
  // an older registration in workflow.json. Such a file is clean in Git, so changedFiles() cannot
  // discover it and the documented `artifact scan` recovery used to be a permanent no-op. Refresh
  // every already-governed path whose exact bytes no longer match; this repairs legacy state while
  // retaining the explicit scan boundary for contributor-authored changes.
  for (const artifact of phase.artifacts.filter((entry) => !isTransientTestResultPath(entry.path))) {
    if (discoveredPaths.has(artifact.path)) continue;
    const current = await repositoryArtifactSnapshot(root, artifact.path);
    if (current.exists === artifact.exists && current.size === artifact.size && current.sha256 === artifact.sha256) continue;
    Object.assign(artifact, { ...current, updatedAt: nowIso() });
    records.push(artifact);
  }
  // Untracked files are registered on purpose: a brand-new source file is a legitimate part of a
  // source-and-artifact generation, and excluding it would silently drop real work from the governed
  // commit — a worse failure than including scratch. But this is also exactly how a stray notes file
  // or an un-ignored output directory becomes a phase artifact: committed, pinned, and attested by
  // the approval's `artifactSha256`. Name them, so adopting them is a decision rather than an
  // accident.
  if (excluded.size) {
    console.warn(`${phase.id} has ${excluded.size} changed file(s) outside its planned candidate that need reconciliation before publication:`);
    [...excluded].sort().forEach((file) => console.warn(`  ${file}`));
    console.warn('Account for Story edits with singularity-flow decision plan. Preserve unrelated edits through the confirmed private-copy action in recovery, then scan again. No file was discarded or added automatically.');
  }
  if (adopted.length) {
    console.warn(`Warning: ${phase.id} is adopting ${adopted.length} untracked file(s) as artifacts:`);
    adopted.forEach((file) => console.warn(`  ${file}`));
    console.warn('Delete or .gitignore anything above that is not part of this change, then scan again.');
  }
  return records;
}

async function refreshSkillLifecycleArtifactIdentities(root, config, workflow, phase, {
  stage, decision = null
} = {}) {
  const selected = workflow.resolution?.phases?.find((entry) => entry.id === phase.id);
  if (selected?.kind !== 'skill') return;
  // Only a verified accepted closure may name the output set. In particular, a live skill folder
  // or mutable phase field must not redefine a reviewed bundle at submission/approval time.
  const skill = await resolveStorySkillPackage(root, config, workflow, { phaseId: phase.id });
  const set = resolvedArtifactSet(config, workflow, phase);
  if (set) {
    const prior = phase.artifactSet;
    if (!prior || Number(prior.generation) !== Number(phase.generation)) {
      throw new SingularityFlowError(
        `Skill phase '${phase.id}' has no published artifact-set identity to advance to ${stage}.`,
        { code: 'SKP_ARTIFACT_SET_INVALID' }
      );
    }
    const current = await catalogArtifactSet(
      root, workDirRelative(config, workflow.workItem.id), phase, set
    );
    phase.artifactSet = {
      ...prior, ...current, generation: phase.generation,
      publicationBundleSha256: prior.publicationBundleSha256 ?? prior.bundleSha256,
      ...(stage === 'approved' ? { submittedBundleSha256: prior.bundleSha256 } : {})
    };
    if (stage === 'approved' && decision) {
      decision.skillApprovedBundleSha256 = current.bundleSha256;
    }
  }
  if (stage === 'approved' && decision) {
    const itemRoot = workDirRelative(config, workflow.workItem.id);
    decision.skillOutputIdentityVersion = 1;
    decision.skillApprovedOutputs = [];
    for (const output of skill.bindingRefs.outputs ?? []) {
      const relativePath = posix(path.posix.join(itemRoot, output.path));
      const current = await repositoryArtifactSnapshot(root, relativePath);
      if (current.symbolicLink || current.exists && !current.sha256
          || output.required && !current.exists) {
        throw new SingularityFlowError(
          `Skill phase '${phase.id}' approved output '${output.id}' is unavailable or unsafe.`,
          { code: 'SKP_OUTPUT_INVALID', details: { output: output.id, path: relativePath } }
        );
      }
      decision.skillApprovedOutputs.push({
        id: output.id, path: relativePath, exists: current.exists,
        sha256: current.sha256, bytes: current.exists ? current.size : null
      });
    }
  }
}

function pruneTransientArtifactRegistrations(phase) {
  const transient = new Set((phase.artifacts ?? [])
    .filter((artifact) => isTransientTestResultPath(artifact.path))
    .map((artifact) => artifact.path));
  if (!transient.size) return [];
  phase.artifacts = (phase.artifacts ?? []).filter((artifact) => !transient.has(artifact.path));
  phase.sidecars = (phase.sidecars ?? []).filter((sidecar) => !transient.has(sidecar.artifact));
  return [...transient].sort();
}

async function validatePhase(root, config, workflow, phase, { placeholders = true, content = true, generation = null, transition = null } = {}) {
  const errors = content
    ? await validatePhaseAuthoredReviewContentPreflight(root, config, workflow, phase, { placeholders, generation, ...(transition ? { transition } : {}) })
    : [];
  if (content && !errors.length) {
    errors.push(...(await inspectPhaseQualifiedConformance(root, config, workflow, phase))
      .map((finding) => finding.message));
  }
  const required = requiredRepoPath(config, workflow, phase);
  if (!errors.some((error) => error.startsWith('Required artifact missing:')) && !artifactFor(phase, required)) {
    errors.push(`Required artifact is not registered to ${phase.id}: ${required}`);
  }
  for (const artifact of phase.artifacts.filter((entry) => !isTransientTestResultPath(entry.path))) {
    const current = await repositoryArtifactSnapshot(root, artifact.path);
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) errors.push(`Artifact changed after registration: ${artifact.path}. Run singularity-flow artifact scan.`);
  }
  /**
   * The bundle still has to be the bundle. `[SPK:CON-045]`
   *
   * The registered-artifact check above covers whatever someone chose to register. A set member is
   * owed whether or not it was registered — an unregistered `tasks.md` edited between publication
   * and submission would otherwise pass every check while the approval named a bundle that no
   * longer exists. Publication re-catalogues before this runs, so this can only fire on a change
   * made outside a generation.
   */
  if (phase.artifactSet?.bundleSha256) {
    const set = resolvedArtifactSet(config, workflow, phase);
    const current = set ? await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, set) : null;
    if (current && current.bundleSha256 !== phase.artifactSet.bundleSha256) {
      const moved = artifactSetDiff(phase.artifactSet, current).changed.map((member) => member.path);
      errors.push(`Artifact set '${current.setId}' changed after generation ${phase.artifactSet.generation}: ${moved.join(', ')}. Publish a new generation so the bundle and its approval agree.`);
    }
  }
  return errors;
}

async function assertQualifiedConformanceReady(root, config, workflow, phase, action) {
  const findings = await inspectPhaseQualifiedConformance(root, config, workflow, phase);
  if (!findings.length) return;
  throw new SingularityFlowError(
    `Phase '${phase.id}' cannot ${action} while its conformance comparison is incomplete:\n- `
      + findings.map((finding) => finding.message).join('\n- '),
    {
      code: 'CONFORMANCE_REPORT_INCOMPLETE',
      details: { subjectKind: 'story', workId: workflow.workItem.id, phase: phase.id, findings }
    }
  );
}

function normalizeUsage(raw, session, generation = null) {
  const startedAt = raw?.startedAt ?? nowIso(); const completedAt = raw?.completedAt ?? nowIso();
  const inputExact = Number.isFinite(raw?.inputTokens);
  const outputExact = Number.isFinite(raw?.outputTokens);
  const totalExact = Number.isFinite(raw?.totalTokens);
  const status = ['exact', 'partial', 'unavailable'].includes(raw?.status)
    ? raw.status
    : inputExact && outputExact ? 'exact'
      : (inputExact || outputExact || totalExact) ? (totalExact ? 'exact' : 'partial') : 'unavailable';
  const usage = {
    status, source: raw?.source ?? (status !== 'unavailable' ? 'provider' : 'copilot-unavailable'),
    provider: raw?.provider ?? null, model: raw?.model ?? null,
    requestedModel: raw?.requestedModel ?? null,
    resolvedModel: raw?.resolvedModel ?? null,
    resolvedModelAssurance: raw?.resolvedModelAssurance ?? (raw?.resolvedModel ? 'host-observed' : 'unavailable'),
    inputTokens: raw?.inputTokens ?? null, outputTokens: raw?.outputTokens ?? null,
    cachedInputTokens: raw?.cachedInputTokens ?? null, cacheWriteInputTokens: raw?.cacheWriteInputTokens ?? null,
    totalTokens: raw?.totalTokens ?? (inputExact && outputExact ? raw.inputTokens + raw.outputTokens : null),
    providerCost: Number.isFinite(raw?.providerCost) ? raw.providerCost : null,
    costStatus: raw?.costStatus ?? (Number.isFinite(raw?.providerCost) ? 'exact' : 'unavailable'),
    observations: raw?.observations ? structuredClone(raw.observations) : undefined,
    spans: Number.isInteger(raw?.spans) ? raw.spans : null,
    startedAt, completedAt, agent: session.agent, generation
  };
  return usage;
}

function addUsageAggregate(workflow, phase, usage) {
  const increment = (collection, key) => {
    const aggregate = collection[key] ??= { records: 0, exactRecords: 0, unavailableRecords: 0, totalTokens: 0 };
    aggregate.records += 1;
    aggregate[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
    aggregate.totalTokens += usage.totalTokens ?? 0;
  };
  workflow.usage.records += 1;
  workflow.usage[usage.status === 'exact' ? 'exactRecords' : 'unavailableRecords'] += 1;
  workflow.usage.totalTokens += usage.totalTokens ?? 0;
  increment(workflow.usage.byPhase, phase.id);
  increment(workflow.usage.byAgent, usage.agent);
  increment(workflow.usage.byWorkType, workflow.workItem.workType);
  increment(workflow.usage.byWorkItem, workflow.workItem.id);
}

function rebuildUsageAggregates(workflow) {
  workflow.usage = {
    mode: workflow.usage?.mode ?? 'exact-or-unavailable',
    totalTokens: 0,
    records: 0,
    exactRecords: 0,
    unavailableRecords: 0,
    byPhase: {},
    byAgent: {},
    byWorkType: {},
    byWorkItem: {}
  };
  for (const phaseId of workflow.phaseOrder) {
    const phase = workflow.phases[phaseId];
    for (const usage of phase.usage ?? []) addUsageAggregate(workflow, phase, usage);
  }
}

const TEST_INPUT_SELECTION = Symbol('test-input-selection');

export async function sourceTreeHash(root, ...governanceSources) {
  const selection = governanceSources.at(-1) === TEST_INPUT_SELECTION ? 'test-input' : 'application';
  if (selection === 'test-input') governanceSources.pop();
  assertNoHiddenWorktreeChanges(root, 'Application source hashing');
  const pathContext = applicationPathContext(...governanceSources);
  // The candidate is HEAD plus the uncommitted changes some step's plan names [E2G-027, D9]. A file
  // no plan names counts as committed: its uncommitted edits stay in the worktree outside every
  // generation and verification runs without them, while committing it changes the bound tree.
  const [governanceConfig, governanceWorkflow] = governanceSources;
  const sourcePolicy = sourcePathPolicy(governanceWorkflow?.resolution?.capability?.sourceScope
    ?? governanceWorkflow?.resolution?.worldModelSourceScope);
  const separatelyHashed = (relative) => isSeparatelyHashedTestInput(relative, sourcePolicy);
  const selected = (relative, untracked = false) => isApplicationChangePath(relative, { ...pathContext, untracked })
    && (selection === 'test-input' ? separatelyHashed(relative) : !separatelyHashed(relative));
  const keptOut = (governanceWorkflow?.workItem?.id && governanceConfig
    ? await outsideEveryCandidate(workDir(root, governanceConfig, governanceWorkflow.workItem.id), governanceWorkflow)
    : null) ?? (() => false);
  // The index is a byte-framed Git record, not a UTF-8 line. Decode through the registered
  // parser so a malformed record or an unrepresentable filename cannot silently change the
  // sealed application-source digest. The object format must be observed before parsing OIDs.
  const objectFormat = executeGitQuery(root, 'repository.object-format');
  const indexEntries = executeGitQuery(root, 'repository.index-detail', { objectFormat }).entries
    .map((entry) => {
      if (entry.path.kind !== 'utf8') {
        throw new SingularityFlowError(
          'Application source hashing cannot represent a non-UTF-8 Git index path.',
          { code: 'SOURCE_TREE_PATH_UNREPRESENTABLE' }
        );
      }
      // Git's path is already repository-relative with '/' separators. Running it through the
      // host-native path normalizer would rewrite a literal POSIX backslash filename.
      return { path: entry.path.value, mode: entry.mode, object: entry.oid, stage: entry.stage };
    });
  if (selection === 'test-input') {
    const tracked = new Map(indexEntries.filter(entry => entry.stage === 0).map(entry => [entry.path, entry]));
    const unavailable = sourcePolicy.testConfigurationPaths.filter(relative =>
      !['100644', '100755'].includes(tracked.get(relative)?.mode));
    if (unavailable.length) throw new SingularityFlowError(
      `Declared test configuration must be tracked regular files in the repository: ${unavailable.join(', ')}.`,
      { code: 'TEST_CONFIGURATION_PATH_UNAVAILABLE', details: { paths: unavailable } }
    );
  }
  const indexed = indexEntries.filter((entry) => entry.stage === 0 && selected(entry.path));
  // Reuse one fresh filter-policy snapshot for these read-only Git calls. Built-in text/encoding
  // conversion must match staging, but a freshness check must never execute a repository filter.
  const filterOverrides = withoutConfiguredFilters(root, [], { fresh: true });
  const unstaged = new Set(run('git', [...filterOverrides,
    'diff', '--name-only', '-z', '--ignore-submodules=none', 'HEAD', '--'
  ], { cwd: root }).stdout.split('\0').filter(Boolean).map(posix));
  const byPath = new Map(indexed.map((entry) => [entry.path, entry]));
  const uncommittedOutside = indexed.filter((entry) => unstaged.has(entry.path) && keptOut(entry.path)).map((entry) => entry.path);
  const committedOutside = headTreeEntries(root, uncommittedOutside);
  for (const relative of uncommittedOutside) {
    unstaged.delete(relative);
    const atHead = committedOutside.get(relative);
    if (atHead) byPath.set(relative, { path: relative, mode: atHead.mode, object: atHead.object, stage: 0 });
    else byPath.delete(relative);
  }
  for (const relative of untrackedFiles(root).filter((candidate) => selected(candidate, true)
    && !keptOut(candidate))) {
    byPath.set(relative, { path: relative, mode: null, object: null, stage: 0, untracked: true });
    unstaged.add(relative);
  }
  const manifest = [];
  const regularFiles = [];
  const blobObject = (bytes) => createHash(objectFormat)
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
  for (const entry of [...byPath.values()].sort((left, right) => (
    compareRepositoryIdentity(left.path, right.path)
  ))) {
    if (!entry.untracked && !unstaged.has(entry.path)) {
      manifest.push({
        path: entry.path,
        mode: entry.mode,
        kind: entry.mode === '120000' ? 'symlink'
          : entry.mode === '160000' ? 'gitlink' : 'git-object',
        object: entry.object
      });
      continue;
    }
    const secured = await secureRepositoryPath(root, entry.path, {
      label: 'Application source path',
      allowFinalSymlink: true
    });
    const absolute = secured.absolute;
    const info = secured.entry;
    if (!info) {
      // The final committed tree does not contain a deleted path. Omitting it now makes the
      // working-state manifest stable when Git commits the exact deletion a moment later.
      continue;
    } else if (entry.mode === '160000' && info.isDirectory()) {
      const nestedHead = executeGitQuery(absolute, 'repository.head');
      const nestedStatus = run('git', [
        'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'
      ], { cwd: absolute, allowFailure: true });
      if (!nestedHead || !/^[a-f0-9]{40,64}$/u.test(nestedHead)) {
        throw new SingularityFlowError(
          `Application source hashing cannot resolve submodule '${entry.path}' to an exact commit.`,
          { code: 'SOURCE_TREE_SUBMODULE_UNAVAILABLE', details: { path: entry.path } }
        );
      }
      if (nestedStatus.status !== 0 || nestedStatus.stdout.trim()) {
        throw new SingularityFlowError(
          `Application source hashing cannot represent uncommitted files inside submodule '${entry.path}'.`,
          { code: 'SOURCE_TREE_DIRTY_SUBMODULE', details: { path: entry.path } }
        );
      }
      manifest.push({
        path: entry.path, mode: '160000', kind: 'gitlink', object: nestedHead
      });
    } else if (info.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      manifest.push({
        path: entry.path, mode: '120000', kind: 'symlink',
        object: blobObject(target)
      });
    } else if (info.isFile()) {
      const record = { path: entry.path,
        mode: process.platform === 'win32' && ['100644', '100755'].includes(entry.mode)
          ? entry.mode : (info.mode & 0o111) ? '100755' : '100644',
        kind: 'git-object', object: null };
      manifest.push(record);
      regularFiles.push(record);
    } else {
      manifest.push({ path: entry.path, mode: String(info.mode), kind: 'non-regular', object: null });
    }
  }
  if (regularFiles.length) {
    // --stdin-paths applies Git's built-in EOL/encoding/ident conversions without -w or staging.
    // Git C-quotes are byte-oriented: quote every non-ASCII/control byte as octal so spaces,
    // Unicode, literal backslashes and POSIX newline names cannot become extra input records.
    const quoted = regularFiles.map(entry => '"' + [...Buffer.from(entry.path)].map(byte =>
      byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, '0')}`).join('') + '"');
    const hashed = run('git', [...filterOverrides, 'hash-object', '--stdin-paths'], {
      cwd: root, input: `${quoted.join('\n')}\n`
    }).stdout.trimEnd().split('\n');
    const objectPattern = objectFormat === 'sha256' ? /^[a-f0-9]{64}$/u : /^[a-f0-9]{40}$/u;
    if (hashed.length !== regularFiles.length || hashed.some(value => !objectPattern.test(value))) {
      throw new SingularityFlowError('Git did not return one exact source object per selected file.', {
        code: 'SOURCE_TREE_HASH_UNAVAILABLE'
      });
    }
    regularFiles.forEach((entry, index) => { entry.object = hashed[index]; });
  }
  return `sha256:${createHash('sha256').update(canonicalJson(selection === 'test-input'
    ? { policy: sourcePolicy, manifest } : manifest)).digest('hex')}`;
}

/** A separate, exact binding for approved excluded directories and test configuration files. */
export async function testInputTreeHash(root, ...governanceSources) {
  const workflow = governanceSources[1];
  const policy = sourcePathPolicy(workflow?.resolution?.capability?.sourceScope
    ?? workflow?.resolution?.worldModelSourceScope);
  const hasInputs = policy.sourceHashExcludedRoots.length || policy.testConfigurationPaths.length;
  const runtimeProfile = workflow?.resolution?.testRuntime;
  if (!hasInputs && !runtimeProfile) return null;
  const files = hasInputs ? await sourceTreeHash(root, ...governanceSources, TEST_INPUT_SELECTION) : null;
  // A Story predating runtime profiles retains its original test-input identity. Only new
  // resolutions that explicitly pin a profile acquire the additional profile binding.
  if (!runtimeProfile) return files;
  return `sha256:${createHash('sha256').update(canonicalJson({ files,
    runtimeProfile: normalizeTestRuntime(runtimeProfile) })).digest('hex')}`;
}

export async function generationResultDigest(root, config, workflow, phase, bindings = null) {
  // This digest belongs to the authoring interval. Submission, review, telemetry and reconciliation
  // legitimately rewrite kernel projections after publication, so none of those files may make a
  // clean submitted generation appear consumed-and-changed.
  const required = requiredRepoPath(config, workflow, phase);
  const declaredPaths = [...new Set([
    ...(phase.artifacts ?? []).map((entry) => entry.path),
    ...(phase.clarifications ?? [])
      .filter((entry) => entry.generation === phase.generation).map((entry) => entry.path)
  ].filter(Boolean))].sort();
  const publicationFiles = [];
  for (const relative of declaredPaths) {
    const current = await repositoryArtifactSnapshot(root, relative);
    if (relative === required && current.exists) {
      publicationFiles.push({
        path: relative,
        exists: true,
        authoredSha256: authoredArtifactFingerprint(await readRepositoryArtifactText(root, relative))
      });
    } else {
      publicationFiles.push({ path: relative, exists: current.exists, sha256: current.sha256, bytes: current.size });
    }
  }
  const generationPublication = (phase.generationPublications ?? []).find((entry) =>
    Number(entry.generation) === Number(phase.generation));
  const architectureIntent = bindings && Object.hasOwn(bindings, 'architectureIntent')
    ? bindings.architectureIntent : generationPublication?.architectureIntent ?? null;
  const architectureDecision = bindings && Object.hasOwn(bindings, 'architectureDecision')
    ? bindings.architectureDecision : generationPublication?.architectureDecision ?? null;
  const resultDigestVersion = bindings?.resultDigestVersion
    ?? phase.generationIntent?.publication?.resultDigestVersion
    ?? generationPublication?.resultDigestVersion
    ?? 3;
  return `sha256:${createHash('sha256').update(canonicalJson({
    sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    publicationFiles,
    bindings: {
      phase: phase.id,
      generation: phase.generation,
      artifactSet: phase.artifactSet?.bundleSha256 ?? null,
      deliveryChangeSet: phase.deliveryEvidence?.changeSet?.digest ?? null,
      generationIntentId: phase.generationIntent?.id ?? null,
      generationStartSha256: phase.generationIntent?.receiptSha256 ?? null,
      generationBaseline: phase.generationIntent?.baseline ?? null,
      ...(resultDigestVersion >= 3 ? { architectureIntent, architectureDecision } : {})
    }
  })).digest('hex')}`;
}

/**
 * Compatibility for generations published before the author-owned digest boundary was introduced.
 * Prove their current application bytes and authored artifact against the exact generation commit;
 * managed metadata changes alone are then an idempotent retry instead of a forced rollover.
 */
export async function generationResultMatches(root, config, workflow, phase) {
  const expected = phase.generationIntent?.publication?.resultDigest ?? null;
  const current = await generationResultDigest(root, config, workflow, phase);
  if (!expected || expected === current) return expected === current;
  if (Number(phase.generationIntent?.publication?.resultDigestVersion ?? 1) >= 2) return false;
  let generationCommit;
  try { generationCommit = publishedGenerationCommit(root, workflow, phase, phase.generation); }
  catch { return false; }
  if (!generationCommit) return false;
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: generationCommit,
    subject: {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation: phase.generation,
      generationIntentId: phase.generationIntent?.id ?? null
    }
  });
  if (applicationChangeSetProjection(
    changeSet, applicationPathContext(config, workflow)
  ).entries.length) return false;
  const required = requiredRepoPath(config, workflow, phase);
  const committed = run('git', ['show', `${generationCommit}:${required}`], {
    cwd: root, allowFailure: true
  });
  let currentText;
  try { currentText = await readRepositoryArtifactText(root, required); }
  catch { return false; }
  if (committed.status !== 0
      || authoredArtifactFingerprint(committed.stdout) !== authoredArtifactFingerprint(currentText)) return false;
  if (phase.artifactSet?.bundleSha256) {
    const set = resolvedArtifactSet(config, workflow, phase);
    const catalog = set
      ? await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, set)
      : null;
    if (catalog && catalog.bundleSha256 !== phase.artifactSet.bundleSha256) return false;
  }
  return true;
}

function assertRequiredAssignment(workflow, phase) {
  if (workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[phase.id]) {
    throw new SingularityFlowError(`Phase '${phase.id}' requires an assignment. Run singularity-flow assign ${phase.id} <assignee> before publishing.`, {
      details: { nextAction: `singularity-flow assign ${phase.id} <assignee>` }
    });
  }
}

/**
 * A review phase may require the *committed* passing test receipts from an earlier code phase.
 * The declarative source lives in the pinned resolution, never in mutable phase state or prose.
 * Replaying the immutable review packet also protects a later Testing/Code checking approval from
 * a stale or fabricated "tests passed" paragraph.
 */
async function assertDocumentInputs(root, config, workflow, phase) {
  const declared = workflow.resolution?.phases?.find(item => item.id === phase.id)?.inputs ?? phase.inputs ?? [];
  const ids = declared.map(item => typeof item === 'string' ? item : item.phaseId ?? item.phase).filter(Boolean);
  const { assertStoryDocumentRiskGates } = await import('./trp-document-runtime.mjs');
  for (const id of new Set(ids)) {
    const source = workflow.phases?.[id];
    if (source?.status === 'approved') await assertStoryDocumentRiskGates(root, config, workflow, source, 'downstream');
  }
}

export async function assertPassedCodeDeliveryInput(root, config, workflow, phase) {
  await assertDocumentInputs(root, config, workflow, phase);
  const sourceId = workflow.resolution?.phases?.find((entry) => entry.id === phase.id)?.testEvidenceFrom;
  if (!sourceId) return null;
  const source = workflow.phases?.[sourceId];
  const riskReference = source?.deliveryEvidence?.testRecovery;
  const refuse = (reason, details = {}) => new SingularityFlowError(
    `Phase '${phase.id}' needs verified, committed passing tests from '${sourceId}': ${reason}`,
    { code: 'PRIOR_CODE_TEST_EVIDENCE_REQUIRED', details: { phase: phase.id, sourcePhase: sourceId, ...details } }
  );
  if (!source || source.status !== 'approved' || source.deliveryEvidence?.status !== 'ready'
      || (source.deliveryEvidence?.validation?.status !== 'passed'
        && !(riskReference && ['unavailable', 'failed'].includes(source.deliveryEvidence.validation?.status)
          && source.deliveryEvidence.validation.status === riskReference.observedOutcome)
        && !await validationCarriedByTestRunRisk(workflow, source.deliveryEvidence?.validation))) {
    // An approved step whose accepted test-run risk lapsed is renewed by its approvers, not redone.
    const lapsed = source?.status === 'approved' && source.deliveryEvidence?.status === 'ready'
      ? await lapsedTestRunRisk(workflow, source.deliveryEvidence?.validation?.checks) : null;
    throw lapsed ? refuse(lapsed.words, lapsed.details)
      : refuse('finish and approve the Code phase with passing structured tests first.');
  }
  const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find((item) =>
    item.phase === sourceId && Number(item.generation) === Number(source.generation));
  if (!entry) throw refuse('the approved generation has no immutable submission packet.');
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
  if (riskReference) await assertStoryTestRiskGate(root, config, workflow, { phaseId: source.id,
    generation: source.generation, operation: 'downstream', observationSha256: riskReference.observationSha256,
    evidenceCommit: packet.evidenceCommit });
  const binding = packet.submissionEvidence?.codeDelivery;
  const approved = (source.approvals ?? []).some((decision) =>
    decision.decision === 'approved' && !decision.invalidatedAt
      && Number(decision.generation) === Number(source.generation)
      && decision.evidenceCommit === packet.evidenceCommit);
  if (!approved || packet.workId !== workflow.workItem.id || packet.phase !== sourceId
      || Number(packet.generation) !== Number(source.generation)
      || !binding?.path || !binding.sha256 || !packet.evidenceCommit) {
    throw refuse('the approval does not bind a current code-delivery receipt.');
  }
  // Prior code evidence remains authoritative only for its exact accepted runner epoch.
  // A later unrelated policy amendment does not rewrite this source phase's policy binding.
  await verifyTestCommandEpochValidation(root, config, workflow, source, { packet });
  // A rewritten branch history (rebase, force-push) drops the approval commit: named, not "absent".
  assertRecordedHistory(root, workflow, [...recordedStepCommits(source), { commit: packet.evidenceCommit, label: `${sourceId}'s approved code evidence` }],
    { branch: workflowPublicationBranch(root, workflow), remote: config.git?.remote ?? 'origin', itemPath: workDirRelative(config, workflow.workItem.id) });
  const historical = run('git', ['show', `${packet.evidenceCommit}:${binding.path}`], {
    cwd: root, allowFailure: true
  });
  if (historical.status !== 0) throw refuse('the test receipt is absent from the approval commit.');
  let receipt;
  try {
    const raw = JSON.parse(historical.stdout);
    const digest = createHash('sha256').update(canonicalJson(raw)).digest('hex');
    if (digest !== String(binding.sha256).replace(/^sha256:/u, '')
        || digest !== String(source.deliveryEvidence.receiptSha256).replace(/^sha256:/u, '')) {
      throw new Error('its committed digest differs from the approval and Story state');
    }
    receipt = readRecord('code-delivery', raw).record;
  } catch (error) {
    throw refuse(`the committed test receipt is invalid: ${error.message}.`);
  }
  const carriedRuns = await testRunRiskCarried(workflow, receipt.testExecutions);
  const receiptMismatch = receipt.status !== 'ready' || receipt.workId !== workflow.workItem.id || receipt.phase !== sourceId
      || Number(receipt.generation) !== Number(source.generation)
      || receipt.tree?.generationCommit !== source.generationCommit
      || !Array.isArray(receipt.testExecutions) || !receipt.testExecutions.length;
  if (receiptMismatch
      || receipt.testExecutions.some((execution) => execution.status !== 'passed' && !carriedRuns.has(execution)
        && !(riskReference && execution.kind === 'phase-validation-observation'
          && execution.status === riskReference.observedOutcome && ['unavailable', 'failed'].includes(execution.status)))) {
    const lapsed = receiptMismatch ? null : await lapsedTestRunRisk(workflow, receipt.testExecutions);
    throw lapsed ? refuse(lapsed.words, lapsed.details)
      : refuse('the receipt does not describe the approved generation and passing executions.');
  }
  const currentTestInput = await testInputTreeHash(root, config, workflow);
  if (receipt.tree.workingStateDigest !== await sourceTreeHash(root, config, workflow)
      || (currentTestInput && receipt.tree.testInputSha256 !== currentTestInput)) {
    const repairTarget = reviewRepairTarget(workflow, phase);
    // Main's own changes, merged in after the code was approved, read as this Story's edits
    // (2026-10-28). The approved tests still never ran with them, so the return stays; the cause is named.
    const itemPrefix = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/`;
    const merged = storyMergedBaseChanges(root, config, workflow,
      committedChangedPaths(root, packet.evidenceCommit).filter((file) => !file.startsWith(itemPrefix)));
    const mergedCause = merged?.paths.length
      ? ` ${merged.paths.slice(0, 5).join(', ')}${merged.paths.length > 5 ? ` and ${merged.paths.length - 5} more` : ''} came from ${workflow.workItem.baseBranch} through a merge after ${sourceId} was approved, not from this Story; `
        + `its approved tests never ran with them, so ${sourceId} runs its tests again on the merged code, or the merge waits until ${workflow.workItem.id} ends.`
      : '';
    const testingRepairRoute = repairTarget
      ? ` Review the exact repair preview. The confirmed return preserves changed bytes and requires new Code tests.\n${formatCommandRouteLines({ copilotCommand: '/sf-reject', command: `singularity-flow reject ${phase.id} --to ${repairTarget.id} --repair --reason <REASON>` }).join('\n')}`
      : ' Return to Code.';
    throw refuse(`application source or separately hashed test inputs changed after the approved execution.${mergedCause}${testingRepairRoute}`);
  }
  const replay = await verifyCodeDeliveryReceipt(root, receipt, {
    protectedPaths: [...new Set([
      ...(config.governance?.protectedPaths ?? []),
      ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
    ])],
    configurationSource: workflow.resolution?.configurationSource,
    sourceBoundary: source.sourceBoundary,
    symlinkPolicy: workflow.resolution?.codeDelivery?.changeSet?.symlinks ?? 'reject',
    minimumDiscovered: workflow.resolution?.codeDelivery?.tests?.minimumDiscovered ?? 1,
    minimumPassed: workflow.resolution?.codeDelivery?.tests?.minimumPassed ?? 1,
    requireAffectedModuleCoverage: workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false,
    minimumModelAssurance: workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable',
    cornerCasePolicy: workflow.resolution?.codeDelivery?.cornerCaseObligations ?? 'off',
    assertionAdequacyPolicy: workflow.resolution?.codeDelivery?.assertionAdequacy ?? 'off',
    sourceBindingPolicy: workflow.resolution?.plannedClaims?.mode === 'required'
      && source.sourceBoundary !== 'test-automation'
      ? workflow.resolution?.codeDelivery?.traceability?.sourceBindings ?? 'off' : 'off',
    evidenceCommit: packet.evidenceCommit,
    testRecovery: riskReference ? { config, workflow, operation: 'downstream' } : null,
    testRunRisks: { workflow, at: nowIso() },
    pathContext: applicationPathContext(config, workflow)
  });
  if (!replay.valid || !replay.executions.length) {
    throw refuse(`the committed executions do not replay: ${replay.errors.join('; ') || 'none were found'}.`);
  }
  // Reaching here proves the current application tree is the one these executions tested; the
  // review freshness check of the same operation reuses that proof instead of replaying it.
  return { sourcePhase: sourceId, evidenceCommit: packet.evidenceCommit, receiptPath: binding.path,
    receiptSha256: binding.sha256, packetSha256: entry.packetSha256, applicationTreeTested: true };
}

async function assertRequiredArtifactSetPublishable(root, phase, catalog) {
  const paths = [...new Set([
    ...catalog.missingRequired,
    ...await unpublishableRequiredArtifactSetMembers(root, catalog)
  ])];
  if (!paths.length) return;
  throw new SingularityFlowError(
    `Phase ${phase.id} is missing required artifact-set member(s) or contains evidence Git cannot publish: ${paths.join(', ')}. Complete them before publication.`,
    { code: 'ARTIFACT_SET_REQUIRED_MEMBER_MISSING', details: { phase: phase.id, paths } }
  );
}

/**
 * What a phase that delivers no code may change, refused exactly as its publication refuses it:
 * protected process paths, files outside an artifact-only phase's artifacts, its source boundary,
 * and application source, tests or migrations no approved code phase governs. Publication and
 * prepublish run this one function, so a draft prepublish calls ready is not refused at publish for
 * a change it never mentioned [gate parity].
 */
export async function assertPhaseChangeScope(root, config, workflow, phase) {
  const changed = changedFiles(root);
  const untracked = new Set(untrackedFiles(root));
  const protectedPaths = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const caseInsensitivePaths = repositoryCaseInsensitivePaths(root);
  const comparePath = (value) => caseInsensitivePaths ? value.toLocaleLowerCase('en-US') : value;
  const protectedChange = protectedPaths.find((protectedPath) => changed.some((file) => {
    const candidate = comparePath(file);
    const guard = comparePath(protectedPath.replace(/\/$/, ''));
    return candidate === guard || candidate.startsWith(`${guard}/`);
  }));
  if (protectedChange) {
    throw new SingularityFlowError(`Generation cannot modify protected process path: ${protectedChange}`,
      // The code-delivery refusal's code and shape, so recovery routes both the same way.
      { code: 'CHANGE_SET_POLICY_VIOLATION', details: { violationKind: 'protected-process-path', workId: workflow.workItem.id,
        phase: phase.id, paths: [protectedChange],
        diagnosticAction: { command: `singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json` } } });
  }
  if ((phase.writeScope ?? 'artifact-only') === 'artifact-only') {
    const allowed = `${workDirRelative(config, workflow.workItem.id)}/artifacts/${phase.id}/`;
    const outside = changed.filter((file) => !ignored(config, workflow, file, { untracked: untracked.has(file) }) && !file.startsWith(allowed));
    if (outside.length) {
      const change = await crossPhaseChange(root, config, workflow, phase, outside);
      const described = describeCrossPhaseChange(change, { code: 'PHASE_ARTIFACT_ONLY_CHANGES', gate: 'submission', workflow, phase });
      throw new SingularityFlowError(`Phase ${phase.id} is artifact-only, but files outside its artifacts changed: ${outside.join(', ')}. ${described.text}`,
        { code: 'PHASE_ARTIFACT_ONLY_CHANGES', details: { phase: phase.id, changedPaths: outside, crossPhase: change, gate: described.gate } });
    }
  } else {
    const allowedArtifact = `${workDirRelative(config, workflow.workItem.id)}/artifacts/${phase.id}/`;
    const sourceChanges = changed.filter((file) => !ignored(config, workflow, file, { untracked: untracked.has(file) }) && !file.startsWith(allowedArtifact));
    assertSourceBoundary(phase.sourceBoundary, sourceChanges, { phaseId: phase.id });
    // A phase that is not a code phase may change application source only after an approved code
    // phase, whose review-freshness rules then govern the change. With none before it, nothing
    // would: such a phase may change only what needs no requirement — dependency locks, build and
    // CI configuration, repository metadata and documentation.
    const governedByCode = workflow.phaseOrder.slice(0, workflow.phaseOrder.indexOf(phase.id))
      .some((id) => phaseRequiresCodeDelivery(workflow.phases[id]) && workflow.phases[id]?.status === 'approved');
    if (!governedByCode) {
      const ungoverned = sourceChanges.filter((file) => classifySupportingChange(file).refused);
      if (ungoverned.length) {
        // Another phase's artifact is a Story record, not application source, so name it as one.
        const storyArtifacts = `${workDirRelative(config, workflow.workItem.id)}/artifacts/`;
        const otherArtifacts = ungoverned.filter((file) => file.startsWith(storyArtifacts));
        const source = ungoverned.filter((file) => !file.startsWith(storyArtifacts));
        throw new SingularityFlowError([
          source.length ? `Phase ${phase.id} is not a code phase and no approved code phase comes before it, so it cannot publish application source, tests or migrations: ${source.join(', ')}. `
            + 'Make this change in a Story whose workflow has a code phase (for example quick-fix), or limit this phase to dependency, build, CI, repository metadata and documentation files.' : null,
          otherArtifacts.length ? `Phase ${phase.id} changed another phase's artifact, which only that phase publishes: ${otherArtifacts.join(', ')}. Restore it, or return to that phase to change it.` : null
        ].filter(Boolean).join(' '),
        { code: 'PHASE_SOURCE_CHANGE_UNGOVERNED', details: { phase: phase.id, paths: ungoverned, otherPhaseArtifacts: otherArtifacts } });
      }
    }
  }
}

/**
 * A plan in a workflow with no code step lists only what that workflow can publish. Its later
 * steps refuse application source, tests and migrations (assertPhaseChangeScope), so the plan's
 * `## Supporting files` is held to the same classifier when the plan is published, not first when
 * a later step's publication refuses the files it named.
 */
export async function assertUncodedPlanSupportingFiles(root, config, workflow, phase) {
  if (!stepResponsibilities(workflow, phase.id).includes('plan')) return;
  if (workflow.phaseOrder.some((id) => phaseRequiresCodeDelivery(workflow.phases[id]))) return;
  const artifactPath = requiredRepoPath(config, workflow, phase);
  const text = await readArtifactText(root, artifactPath);
  if (!text) return;
  try {
    planSupportingFiles(text);
  } catch (error) {
    if (error?.code !== 'SPEC_SUPPORTING_FILE_INVALID') throw error;
    throw new SingularityFlowError(`Phase ${phase.id} cannot publish: ${error.message} This workflow has no code step, so no later step `
      + 'could publish it: plan only those files here, and make a source, test or migration change in a Story whose workflow has a code phase (for example quick-fix).',
    { code: error.code, details: { ...(error.details ?? {}), phase: phase.id, path: artifactPath } });
  }
}

export async function publishGeneration(root, config, workflow, {
  phaseId, usage: rawUsage, authorship = null, persist = true, publicationTransaction = null
} = {}) {
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  const selectedSession = await loadSession(root, { required: false });
  assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId ?? workflow.currentPhase],
    selectedSession, 'publish');
  assertIntentAmendmentAcknowledged(workflow);
  if (authorship?.governedAgentContext?.agentId) assertPhaseAgentMayMutate(config, workflow,
    workflow.phases?.[phaseId ?? workflow.currentPhase], { agent: authorship.governedAgentContext.agentId }, 'publish');
  await verifyAcceptedTestCommandAmendment(root, config, workflow);
  if (workflow.resolution?.presence) await (await import('./story-test-command-amendment.mjs')).assertSignedTestCommandAmendments(workflow);
  await assertNoPendingPublication(root, config, workflow, 'publish a generation');
  const phase = await assertPhaseSequence(root, workflow, 'publish a generation', { requestedPhase: phaseId });
  await (await import('./document-runtime.mjs')).requirePhaseDocuments(root, config, workflow, phase.id);
  const { assertStoryDocumentRiskGates } = await import('./trp-document-runtime.mjs');
  await assertStoryDocumentRiskGates(root, config, workflow, phase, 'publish');
  await assertStoryTestRecoveryFeatureAdmission(root, config, workflow, phase);
  await assertSkillPhaseHostReady(workflow, phase, 'publish');
  // Deterministic generation is kernel-owned and deliberately carries no phase-agent session.
  // Its explicit authorship still binds the human Git identity that invoked the publication.
  const session = authorship?.producer === 'deterministic'
    ? { actor: authorship.actor ?? identity(root), agent: null }
    : selectedSession ?? await loadSession(root);
  if (phaseRequiresCodeDelivery(phase)
      && phase.generationIntent?.status === 'consumed'
      && Number(phase.generationIntent.generation) === Number(phase.generation)) {
    if (!phaseNeedsGeneration(workflow, phase)
        && await generationResultMatches(root, config, workflow, phase)) return phase;
    throw new SingularityFlowError(
      `Generation intent ${phase.generationIntent.id} was already consumed and the source or artifact bytes now differ. Run singularity-flow phase rollover ${phase.id} to preview the exact guarded next-generation command.`,
      { code: 'GENERATION_INTENT_ALREADY_CONSUMED', details: { nextAction: `singularity-flow phase rollover ${phase.id}` } }
    );
  }
  const generationIntent = await verifyOpenGenerationIntent(root, workflow, phase);
  assertRequiredAssignment(workflow, phase);
  const verifiedCodeInput = await assertPassedCodeDeliveryInput(root, config, workflow, phase);
  await assertReviewCodeEvidenceFresh(root, config, workflow, phase, { verifiedCodeInput });
  // Resolve and validate authorship before any content, test, brief, input, telemetry, or lifecycle
  // write. A wrong producer is a preflight refusal and must not leave partial recovery state.
  let effectiveAuthorship = authorship ?? {
    schemaVersion: currentSchemaVersion('artifact-authorship'), producer: 'legacy-unspecified', channel: 'legacy', actor: structuredClone(session.actor),
    governedAgentContext: session.agent ? { agentId: session.agent } : null,
    kernelModel: { invoked: false, status: 'unavailable', invocationIds: [] },
    externalAiUse: { value: 'unknown', status: 'unavailable' }, source: null
  };
  if (workflow.executionOrigin?.mode === 'auto') {
    effectiveAuthorship = {
      ...effectiveAuthorship,
      executionOrigin: structuredClone(workflow.executionOrigin)
    };
  }
  assertProducerAllowed(phase, effectiveAuthorship.producer);
  // Convergence is a kernel-owned projection regardless of which legacy/mixed producer label an
  // upgraded workflow carried. Never let an alternate or omitted producer bypass exact review,
  // source, fact, and artifact validation.
  const deterministicConvergence = isConvergencePhase(phase);
  if (deterministicConvergence) {
    await assertConvergencePublicationReady(root, config, workflow, phase);
  }
  // Template completeness is a publication preflight, not a late transaction failure. In
  // particular, do this before `preparePhaseInputs` records context or the generation counter,
  // sidecars and telemetry begin to move. An untouched prepared template should cost the author one
  // clear correction, not leave a half-started generation that produces the same adoption warning
  // on every retry.
  // Use the same authored-byte boundary as manual import and recovery. Report every deterministic
  // authoring blocker together so a host can repair the artifact once instead of chasing one
  // first-error failure per retry.
  // The convergence body is a byte-for-byte kernel projection and may legitimately quote text such
  // as "TODO remains" from evidence. Its exact projection check above supersedes human-template
  // placeholder heuristics; asking a user to edit those bytes would itself violate the contract.
  const contentFindings = deterministicConvergence
    ? []
    : await inspectPhaseAuthoredReviewContent(root, config, workflow, phase,
      { transition: 'publish', generation: publicationTransaction?.publicationEvent?.generation ?? null });
  if (contentFindings.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} generation is not publishable:\n- ${contentFindings.map(artifactFindingMessage).join('\n- ')}\n`
      + `Complete the listed review artifact(s), then run singularity-flow recover ${workflow.workItem.id} --phase ${phase.id} --json. `
      + 'A Copilot host may re-author and retry publication once only after the artifact fingerprint changes.',
      {
        code: 'ARTIFACT_AUTHORING_INCOMPLETE',
        details: {
          subjectKind: 'story',
          workId: workflow.workItem.id,
          phase: phase.id,
          findings: contentFindings,
          fingerprint: contentFindings.find((finding) => finding.fingerprint)?.fingerprint ?? null,
          retry: {
            skill: directCopilotSkill(generationSkillForPhase(phase, workflow)), maximumAttempts: 1, requiresFingerprintChange: true,
            command: phasePublicationCommandForMode(phase) ?? phasePublicationCommand(phase)
          }
        }
      }
    );
  }
  // Specification structure/markers are preflight too: before managed input rendering, tests,
  // telemetry or generation writes. The gate reads the recorded clarification for this generation.
  const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
    generation: nextPhaseGeneration(phase),
    artifactRelativePath: requiredRepoPath(config, workflow, phase),
    namespace: (workflow.resolution?.spec ?? config.spec)?.namespace ?? null
  });
  gate.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (gate.errors.length) {
    const clarification = specificationGateDiagnostics(gate, requiredRepoPath(config, workflow, phase)).findings.some(finding => finding.category === 'clarification');
    throw new SingularityFlowError(
      `Phase ${phase.id} is not publishable:\n- ${gate.errors.join('\n- ')}\n`
      + (clarification
        ? resolvedClarificationPolicy(config, workflow, phase).mode === 'off'
          ? `Replace each cited clarification marker with content sourced from the pinned evidence; clarification is off for ${phase.id}, so no question is recorded.`
          : `Resolve only the cited clarification questions and record their actual answers with singularity-flow clarification record ${phase.id}; do not invent or repeat answered questions.`
        : `Repair the listed specification draft structure from the pinned source and clarifications, then rerun singularity-flow phase prepublish ${phase.id} --json. Missing scenarios are author corrections, not a new clarification interview.`),
      // A draft-structure refusal gets a code of its own, so its plan names the recheck rather than
      // the generic recover/doctor route; a clarification refusal keeps its own wording.
      clarification ? undefined : { code: 'SPEC_PUBLICATION_GATE_REFUSED', details: { phase: phase.id } }
    );
  }
  // Required artifact-set members are part of the declared publication bundle. Refuse before
  // inputs, briefs, telemetry, or generation state are written; a warning after cataloguing is
  // too late for the author to repair this generation safely.
  const requiredSet = resolvedArtifactSet(config, workflow, phase);
  if (requiredSet) {
    const catalog = await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, requiredSet);
    await assertRequiredArtifactSetPublishable(root, phase, catalog);
  }
  await assertQualifiedConformanceReady(root, config, workflow, phase, 'publish a generation');
  await assertUncodedPlanSupportingFiles(root, config, workflow, phase);
  // A code-generation phase must deliver code and acceptance-mapped tests. This is deliberately
  // before prompt/input preparation and telemetry capture: an artifact-only attempt is a refused
  // preflight, not a half-started generation that has to be repaired in durable state.
  if (phaseRequiresCodeDelivery(phase)) {
    await assertPlannedSpecificationClaims(root, config, workflow, phase);
  }
  let deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { requireReconciled: true });
  const dependencyOptions = { producer: effectiveAuthorship.producer,
    generation: nextPhaseGeneration(phase), agent: session.agent };
  let dependencies = await assertPhasePublicationReadiness(root, config, workflow, phase, dependencyOptions);
  // Execute the exact structured test command before consuming the generation intent. Submission
  // reuses this run while nothing it depends on moved [TCE:REQ-080], and command inference, test discovery, and
  // result-adapter incompatibility must be found while the current generation is still editable.
  // Otherwise the only way to repair a bad adapter is to mutate bytes after publication and enter
  // generation recovery for a failure the kernel could have detected earlier.
  if (deliveryPreflight) {
    await preflightCodeDeliveryTests(root, config, workflow, phase, deliveryPreflight);
    const testedSelection = deliveryPreflight.trpSelection ?? null;
    const testedRisk = deliveryPreflight.testRecovery ?? null;
    const testedAttempts = deliveryPreflight.preflightAttempts ?? [];
    const testedRunRisks = deliveryPreflight.testRunRisks ?? null;
    // Tests are repository-owned programs and may generate or rewrite files. Rebind delivery
    // evidence after they finish so publication never commits bytes that were absent from the
    // preflight change set or retains hashes for bytes the test command changed.
    deliveryPreflight = await evaluateCodeDeliveryPreflight(root, config, workflow, phase, { requireReconciled: true });
    if (testedSelection) {
      const commands = await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence: deliveryPreflight },
        { executionMode: storyTestScope(workflow) });
      const refreshed = await resolveTrpDeliverySelection(root, config, workflow, phase, deliveryPreflight, commands,
        { previewOnly: true });
      // The selector owns the semantic source/command binding. Its own generated
      // manifest and volatile capture timestamps must not invalidate that binding.
      if (!refreshed.preview?.ready || refreshed.preview.planDigest !== testedSelection.planDigest) {
        throw new SingularityFlowError('The candidate changed after its approved test selection ran. Review the new selection before publication.',
          { code: 'TRP_TEST_SELECTION_STALE' });
      }
      deliveryPreflight.trpSelection = testedSelection;
    }
    if (testedRisk) deliveryPreflight.testRecovery = testedRisk;
    if (testedRunRisks) deliveryPreflight.testRunRisks = testedRunRisks;
    deliveryPreflight.preflightAttempts = testedAttempts;
  }
  // Auto adds an exact constraint to the ordinary Story transaction; it never owns a second
  // publication path. Re-read the immutable Candidate after all preflight tests and before the
  // first Story mutation so test/source drift cannot be adopted as a new Candidate implicitly.
  const autoPublication = await autoCandidatePublicationFromEnvironment(root);
  const autoCandidate = autoPublication?.binding ?? null;
  const autoCandidateVerification = autoPublication?.verification ?? null;
  if (autoCandidate) {
    if (!deliveryPreflight) {
      throw new SingularityFlowError(
        'Auto Candidate publication requires a code-delivery phase with exact source evidence.',
        { code: 'AUTO_CANDIDATE_DELIVERY_REQUIRED' }
      );
    }
    assertAutoCandidateMatches(autoCandidate, await observeAutoCandidateWorktree(
      root, autoCandidate, applicationPathContext(config, workflow)
    ));
  }
  // Downstream briefs are derived later from the exact published bytes, but their authored
  // heading contract can be validated now. This keeps ambiguity, missing preserved sections, and
  // size-bound failures on the no-mutation side of the publication boundary.
  await planAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id),
    generation: nextPhaseGeneration(phase)
  });
  // Repository-owned tests may change dependency bytes too. Recheck before input/Story writes.
  if (deliveryPreflight) dependencies = await assertPhasePublicationReadiness(root, config, workflow, phase, dependencyOptions);
  dependencies.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  const { clarification } = dependencies;
  await preparePhaseInputs(root, config, workflow, phase.id);
  // Grounding and telemetry preserve the existing legacy behavior. Clarification is narrower:
  // only explicit governed-agent authorship proves that an interactive model path ran and must
  // therefore carry a generation-bound human response. Never guess that from legacy provenance.
  const modelAssisted = ['governed-agent', 'legacy-unspecified'].includes(effectiveAuthorship.producer);
  // Code delivery has already evaluated protected paths and source boundaries against its one
  // baseline-aware, rename-aware RepositoryChangeSet. Reconstructing those facts from a name-only
  // dirty-tree list here would both disagree on committed changes and reintroduce rename bypasses.
  if (!deliveryPreflight) await assertPhaseChangeScope(root, config, workflow, phase);
  /**
   * Constitution citations `[SPK:REQ-101]`.
   *
   * Validated against the Story's **pin**, not the file on disk. An article added since the Story
   * started exists today and did not when the author wrote the citation, so accepting it would
   * record a reference to a rule nobody read. Checked here, beside the marker gate, so a citation
   * problem costs the same as a marker: the answer, and nothing else.
   */
  const citations = validateCitations(
    workflow.resolution?.constitutionPin ?? null,
    citedArticleIds(await readArtifactText(root, requiredRepoPath(config, workflow, phase))),
    { label: `Phase ${phase.id}` }
  );
  citations.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (citations.errors.length && (workflow.resolution?.constitution?.mode ?? 'off') === 'enforce') {
    throw new SingularityFlowError(`Phase ${phase.id} is not publishable:\n- ${citations.errors.join('\n- ')}`,
      { code: 'CONSTITUTION_CITATION_INVALID', details: { phase: phase.id, errors: citations.errors, cited: citations.cited } });
  }
  citations.errors.forEach((error) => console.warn(`Warning: ${error}`));

  const codeModelObservation = effectiveAuthorship.kernelModel?.observations
    ?.find((observation) => observation.task === 'code') ?? null;
  const codeModelAssurance = codeModelObservation?.assurance ?? 'unavailable';
  if (deliveryPreflight && effectiveAuthorship.producer === 'governed-agent') {
    const minimum = workflow.resolution?.codeDelivery?.model?.minimumAssurance ?? 'unavailable';
    if ((MODEL_ASSURANCE_RANK[codeModelAssurance] ?? -1) < requiredModelAssuranceRank(minimum)) {
      throw new SingularityFlowError(
        `Code generation requires ${minimum} model assurance; the host supplied ${codeModelAssurance}.`,
        { code: 'CODE_MODEL_ASSURANCE_REQUIRED' }
      );
    }
    if (codeModelAssurance !== 'unavailable' && !codeModelObservation?.invocationId) {
      throw new SingularityFlowError('Observed code-model assurance requires a host invocation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
    if (codeModelAssurance !== 'unavailable' && (!codeModelObservation?.provider
        || !codeModelObservation?.resolvedModel
        || codeModelObservation?.host !== 'singularity-flow-kernel'
        || codeModelObservation?.source !== 'model-invocation-audit'
        || !codeModelObservation?.observedAt
        || codeModelObservation?.observationIntegrity !== 'external-host-attested'
        || Number(codeModelObservation?.generation) !== Number(nextPhaseGeneration(phase)))) {
      throw new SingularityFlowError('Code-model assurance is missing its provider, model, host audit source, timestamp, or generation binding.', {
        code: 'CODE_MODEL_ASSURANCE_REQUIRED'
      });
    }
  }

  // AST is optional. This boundary may collect structural diagnostics, but it never blocks or
  // mutates publication when AST, a language pack, an adapter, or its evidence store is absent.
  const astGate = await evaluateAstLifecycleGate(root, config, workflow, phase, {
    generation: nextPhaseGeneration(phase)
  });
  assertAstLifecycleGate(astGate, `publication of phase '${phase.id}'`);

  const capture = !modelAssisted
    ? { source: 'not-invoked', usage: [], spans: 0, rawBytes: 0, pending: false, warnings: [] }
    : rawUsage
    ? { source: 'usage-json', usage: Array.isArray(rawUsage) ? rawUsage : [rawUsage], spans: 0, rawBytes: 0, startedAt: rawUsage.startedAt, completedAt: rawUsage.completedAt, warnings: [] }
    : { source: 'copilot-otel', ...await collectCopilotUsage(root, workflow, phase, { readTelemetry: false }) };
  capture.pending = modelAssisted && !rawUsage && capture.usage.length === 0;
  // Only a launch SFlow started can still be exporting its turn; say so only when one ran.
  if (capture.pending) capture.warnings.push(telemetryCaptureGap(capture, null) === 'awaiting-export'
    ? 'Copilot usage is not read during the work; run singularity-flow telemetry reconcile to record it.'
    : 'No Copilot activity was captured for this phase.');
  capture.warnings.forEach((warning) => console.warn(`Telemetry warning: ${warning}`));
  const normalizedUsage = modelAssisted
    ? (capture.usage.length ? capture.usage : [{ source: 'copilot-otel-unavailable' }]).map((record) => normalizeUsage(record, session, nextPhaseGeneration(phase)))
    : [];
  const capabilityBudget = workflow.resolution?.capability?.policy?.tokenBudget;
  if (capabilityBudget) {
    const used = Object.values(workflow.phases).flatMap((entry) => entry.usage ?? [])
      .reduce((total, record) => total + (record.totalTokens ?? 0), 0)
      + normalizedUsage.reduce((total, record) => total + (record.totalTokens ?? 0), 0);
    if (used > capabilityBudget) {
      throw new SingularityFlowError(`Capability '${workflow.resolution.capability.id}' token budget exceeded: ${used}/${capabilityBudget}.`);
    }
  }
  const targetGeneration = nextPhaseGeneration(phase);
  // Architecture intent was removed with the registered World Model; publications record no
  // intent binding or decision, exactly as when it was disabled.
  const architectureIntentBinding = null;
  const architectureDecision = null;
  phase.generation = targetGeneration; phase.generatedBy = session.actor;
  phase.submissionArchitectureDecision = null;
  phase.generatedAgent = effectiveAuthorship.producer === 'governed-agent' ? session.agent : null;
  phase.authorship ??= [];
  const publishedAt = nowIso();
  phase.authorship.push({ ...structuredClone(effectiveAuthorship), generation: phase.generation, publishedAt });
  if (deliveryPreflight) {
    // These are live submission bindings, not publication history. A successor starts without
    // observed evidence; immutable prior claim maps/publications remain in Git and lineage.
    if (phase.claimMaps) delete phase.claimMaps.observed;
    phase.generationCommit = null;
    phase.publicationCommit = null;
    phase.submittedAt = null;
    const deliveryRoot = posix(path.join(
      workDirRelative(config, workflow.workItem.id), 'context', 'code-delivery'
    ));
    const receiptPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}.json`;
    const changeSetPath = `${deliveryRoot}/${phase.id}-gen${phase.generation}-changes.json`;
    await writeJson(path.join(root, changeSetPath), deliveryPreflight.changeSet);
    const workingStateDigest = await sourceTreeHash(root, config, workflow);
    const testInputSha256 = await testInputTreeHash(root, config, workflow);
    const receipt = {
      schemaVersion: currentSchemaVersion('code-delivery'),
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
    await writeJson(path.join(root, receiptPath), receipt);
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
    if (autoCandidate && publicationTransaction?.publicationEvent?.payload) {
      publicationTransaction.publicationEvent.payload.autoCandidate = {
        candidateId: autoCandidate.candidateId,
        candidateSha256: autoCandidate.candidateSha256,
        bindingSha256: autoCandidate.bindingSha256,
        attemptId: autoCandidate.attemptId,
        verificationReceiptSha256: autoCandidateVerification.verificationReceiptSha256
      };
    }
  }
  const astReceipt = await persistAstLifecycleReceipt(root, config, workflow, phase, astGate);
  if (astReceipt) {
    phase.astGates = [
      ...(phase.astGates ?? []).filter((record) => record.generation !== phase.generation),
      astReceipt
    ].sort((left, right) => left.generation - right.generation);
  }

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
        markers: answeredMarkerHashes(clarification.record),
        recordedAt: clarification.record.recordedAt,
        recordedBy: structuredClone(clarification.record.recordedBy)
      }
    ];
  }
  /**
   * What this generation left open, so the next one can tell resolution from deletion.
   *
   * `[SPK:REQ-067]` only works if there is a prior list to have vanished from: without it, quietly
   * removing a question is indistinguishable from answering it.
   */
  if (gate.applies && gate.record) {
    phase.markers = [
      ...(phase.markers ?? []).filter((record) => record.generation !== phase.generation),
      { ...gate.record, generation: phase.generation, recordedAt: publishedAt }
    ].sort((left, right) => left.generation - right.generation);
  }
  phase.sourceCommit = head(root);
  // Every conformance report is bound to the tree it compared, so any of them can be checked for freshness.
  if (isConformancePhase(phase)) phase.conformanceTree = await sourceTreeHash(root, config, workflow);
  phase.usage.push(...normalizedUsage);
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, normalizedUsage, capture, {
    itemDirectory: workDir(root, config, workflow.workItem.id), itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== phase.generation), phaseTelemetrySummary(telemetry)];
  await updateArtifactMetadata(root, config, workflow, phase);
  await scanArtifacts(root, config, workflow, phase.id);
  /**
   * Canonical provenance for this generation's final artifacts `[SPK:REQ-043]`.
   *
   * Capture only after lifecycle metadata and checkout representation have settled. The kernel
   * owns `context/sidecars/`, outside the artifact-only scope already checked above [SPK:CON-023].
   */
  const sidecarDir = workDirRelative(config, workflow.workItem.id);
  phase.sidecars = [];
  for (const artifact of phase.artifacts ?? []) {
    if (!artifact.sha256) continue;
    const relative = sidecarRelativePath(sidecarDir, phase.id, phase.generation, artifact.path);
    const record = buildArtifactSidecar({
      subject: { kind: 'story', id: workflow.workItem.id },
      phase: phase.id,
      generation: phase.generation,
      artifact: { path: artifact.path, sha256: artifact.sha256, bytes: artifact.size ?? null, role: artifact.kind ?? null },
      configuration: { sha256: workflow.resolution?.configSha256 ?? null, revision: workflow.resolution?.configurationSource?.commit ?? null },
      template: {
        path: workflow.resolution?.templates?.[phase.id]?.path ?? null,
        sha256: workflow.resolution?.templates?.[phase.id]?.sha256 ?? null
      },
      inputs: (phase.inputs ?? []).map((entry) => ({ path: entry.path, sha256: entry.sha256 ?? null, kind: entry.kind ?? null })),
      producer: {
        kind: effectiveAuthorship.producer,
        actor: session.actor?.email ?? session.actor?.name ?? null,
        agent: phase.generatedAgent
      },
      // The commit is not known until the publication transaction closes.
      publication: { commit: null, branch: workflow.workItem.branch ?? null, publishedAt }
    });
    await writeText(path.join(root, relative), serializeArtifactSidecar(record));
    phase.sidecars.push({ path: relative, artifact: artifact.path, integritySha256: record.integritySha256 });
  }
  // Generate the downstream projection from the exact generation bytes that this publication
  // commits. Submission later binds these hashes into its immutable review packet; subsequent
  // approval metadata must not redefine what the reviewer and downstream consumer received.
  const agentBriefs = await createAgentBriefs(root, workflow, phase, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (agentBriefs.length) {
    phase.agentBriefs = [
      ...(phase.agentBriefs ?? []).filter((entry) => entry.generation !== phase.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
  }
  /**
   * The typed artifact set `[SPK:REQ-110]` `[SPK:REQ-111]`.
   *
   * Catalogued after the scan, so the set describes the bundle as published. Required members are
   * checked again here because tests and other publication work ran after the initial preflight.
   *
   * When the phase was reopened for named members, this is also where the promise is checked. The
   * clause asks that incidental change be *disclosed*, not forbidden — a regeneration that reflowed
   * a neighbouring paragraph is usually harmless, and refusing it would push people into rewriting
   * the whole bundle, which is the outcome surgical reopen exists to avoid.
   */
  const artifactSet = resolvedArtifactSet(config, workflow, phase);
  if (artifactSet) {
    const previous = phase.artifactSet ?? null;
    const catalog = await catalogArtifactSet(root, workDirRelative(config, workflow.workItem.id), phase, artifactSet);
    await assertRequiredArtifactSetPublishable(root, phase, catalog);
    const diff = artifactSetDiff(previous, catalog, { declared: phase.surgicalReopen?.members ?? [] });
    for (const line of disclosureLines(diff)) console.warn(`Warning: ${line}`);
    phase.artifactSet = {
      ...catalog,
      generation: phase.generation,
      preserved: diff.preserved.map((member) => member.path),
      changed: diff.changed.map((member) => member.path),
      // Member names, not repository paths: this block is read beside `reopen.members`, which is
      // the list the reviewer wrote, and the two have to be comparable at a glance.
      ...(phase.surgicalReopen ? { reopen: { ...phase.surgicalReopen, incidental: diff.incidental.map((member) => member.member) } } : {})
    };
    // Consumed by the generation that answered it. A reopen that stayed on the phase would keep
    // re-disclosing the same incidental change at every later generation.
    delete phase.surgicalReopen;
  }

  await refreshPhaseSpecificationIndex(root, config, workflow, phase);
  await refreshPlannedSpecificationClaims(root, config, workflow, phase);
  await updateRemoteOutputRenderedHashes(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  const errors = await validatePhase(root, config, workflow, phase, {
    placeholders: !deterministicConvergence,
    content: true, generation: targetGeneration, transition: 'publish'
  });
  if (errors.length) throw new SingularityFlowError(`Phase ${phase.id} generation is not publishable:\n- ${errors.join('\n- ')}`);
  // This is an evidence check only. Host admission above remains closed until a qualified
  // containment/delivery boundary can prove how the selected skill was executed.
  await verifySkillPhasePublication(root, config, workflow, phase);
  if (generationIntent) {
    const resultDigest = await generationResultDigest(root, config, workflow, phase, {
      architectureIntent: architectureIntentBinding,
      architectureDecision,
      resultDigestVersion: 3
    });
    await consumeGenerationIntent(root, phase, {
      generation: phase.generation,
      publishedAt,
      changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
      resultDigest,
      resultDigestVersion: 3
    });
  }
  const generationPublication = {
    generation: phase.generation,
    publishedAt,
    changeSetDigest: deliveryPreflight?.changeSet?.digest ?? null,
    resultDigest: generationIntent?.publication?.resultDigest
      ?? await generationResultDigest(root, config, workflow, phase, {
        architectureIntent: architectureIntentBinding,
        architectureDecision,
        resultDigestVersion: 3
      }),
    resultDigestVersion: Math.max(generationIntent?.publication?.resultDigestVersion ?? 0, 3),
    architectureIntent: structuredClone(architectureIntentBinding),
    architectureDecision: structuredClone(architectureDecision),
    record: null
  };
  phase.generationPublications = [
    ...(phase.generationPublications ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    generationPublication
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
  if (publicationTransaction) {
    await persistGenerationPublicationRecord(root, workflow, phase, {
      ...publicationTransaction,
      workDirectory: workDirRelative(config, workflow.workItem.id)
    });
  }
  normalizedUsage.forEach((usage) => addUsageAggregate(workflow, phase, usage));
  workflow.history.push({ at: nowIso(), actor: actorKey(session.actor), agent: session.agent, event: 'phase_generated', phase: phase.id, detail: `generation ${phase.generation}` });
  if (persist) await saveWorkflow(root, config, workflow);
  return phase;
}

export async function reconcilePhaseTelemetry(root, config, workflow, { phaseId } = {}) {
  assertStoryNotArchived(root, workflow);
  const phase = phaseId ? workflow.phases[phaseId] : currentPhase(workflow);
  if (!phase) return { updated: false, reason: 'No active phase is available.' };
  const generation = phase.generation;
  const context = (phase.telemetry ?? []).find((item) => item.generation === generation);
  if (!context) return { updated: false, phase: phase.id, generation, reason: 'No telemetry record exists for the current generation.' };
  if (context.status !== 'pending') return { updated: false, phase: phase.id, generation, status: context.status, reason: `Telemetry is already ${context.status}.` };

  const capture = { source: 'copilot-otel', ...await collectCopilotUsage(root, workflow, phase, { generation }) };
  if (!capture.usage.length) return {
    updated: false,
    pending: true,
    phase: phase.id,
    generation,
    status: 'pending',
    reason: capture.warnings.at(-1) ?? 'The completed Copilot turn is not available yet.',
    warnings: capture.warnings
  };

  const session = await loadSession(root, { required: false });
  const usageSession = { agent: phase.generatedAgent ?? session?.agent ?? null };
  const normalizedUsage = capture.usage.map((record) => normalizeUsage(record, usageSession, generation));
  phase.usage = [...(phase.usage ?? []).filter((item) => item.generation !== generation), ...normalizedUsage];
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, normalizedUsage, capture, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  phase.telemetry = [...(phase.telemetry ?? []).filter((item) => item.generation !== generation), phaseTelemetrySummary(telemetry)];
  rebuildUsageAggregates(workflow);
  workflow.history.push({
    at: nowIso(),
    actor: actorKey(session?.actor ?? phase.generatedBy ?? {}) ?? 'unknown',
    agent: session?.agent ?? phase.generatedAgent ?? null,
    event: 'phase_telemetry_reconciled',
    phase: phase.id,
    detail: `generation ${generation}: ${telemetry.status}`
  });
  await updateArtifactMetadata(root, config, workflow, phase);
  await refreshRequiredArtifact(root, config, workflow, phase);
  await saveWorkflow(root, config, workflow);
  return {
    updated: true,
    phase: phase.id,
    generation,
    status: telemetry.status,
    models: telemetry.models,
    usage: normalizedUsage,
    providerCost: telemetry.providerCost,
    activity: telemetry.activity,
    prompt: telemetry.prompt,
    path: telemetry.path
  };
}

function boundedQualityDiagnostic(value, max = 2000) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const marker = '\n… diagnostic output truncated …\n';
  const remaining = max - marker.length;
  const first = Math.ceil(remaining / 2);
  return `${text.slice(0, first)}${marker}${text.slice(-(remaining - first))}`;
}

function requiredTestExecutionDiagnostic(root, command, check) {
  const cwd = path.resolve(root, command.workingDirectory);
  const captured = (stream) => {
    const value = String(check?.[stream] ?? '');
    return {
      text: redactDiagnosticText(boundedQualityDiagnostic(value)).trimEnd(),
      bytes: Number.isInteger(check?.[`${stream}Bytes`]) ? check[`${stream}Bytes`] : Buffer.byteLength(value),
      truncated: check?.[`${stream}Truncated`] === true || value.length > 2000
    };
  };
  return {
    commandId: command.id,
    hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    argv: command.provenance !== 'configured' ? [...command.argv] : null,
    argvWithheld: command.provenance === 'configured',
    provenance: command.provenance ?? 'configured',
    cwd,
    workingDirectory: command.workingDirectory,
    exitCode: Number.isInteger(check?.exitCode) ? check.exitCode : null,
    status: check?.status ?? 'not-run',
    resultPath: path.resolve(cwd, command.result.path),
    configuredResultPath: command.result.path,
    resultAdapter: command.result.adapter,
    stdout: captured('stdout'),
    stderr: captured('stderr')
  };
}

async function attachRequiredTestExecution(error, root, command, check, { workId = null } = {}) {
  if (!(error instanceof SingularityFlowError) && !(error instanceof SyntaxError)) return error;
  const refusal = error instanceof SingularityFlowError
    ? error
    : new SingularityFlowError(
      `Required test command '${command.id}' produced an unreadable structured result. `
      + 'See error.requiredTestExecution in --json for the command and bounded output.',
      { code: 'CODE_TEST_RESULT_REQUIRED', cause: error }
    );
  // Capture this invocation's report before transient output is restored. A report left in the
  // checkout after refusal may belong to an earlier run and must never explain the current exit.
  let report = { status: 'unavailable', reason: 'This invocation did not produce an isolated test report.' };
  if (check?.resultIsolated) {
    try {
      const parsed = await parseTestResult(root, command, { startedAt: check.startedAt });
      const failureExamples = await requiredTestFailureExamples(parsed, command.result.adapter).catch(() => []);
      const failedSuites = (await import('./test-case-messages.mjs')).failedSuiteMessages(command.result.adapter, (parsed.rawReports ?? []).map((entry) => entry.contents)).length;
      report = {
        status: 'observed', tests: parsed.tests,
        ...(failureExamples.length ? { failureExamples } : {}),
        ...(failedSuites ? { failedSuites } : {}),
        sha256: parsed.result.sha256, bytes: parsed.result.bytes,
        failedTestcases: (parsed.testcaseObservation?.occurrences ?? [])
          .filter((entry) => entry.outcome === 'failed').slice(0, 20)
          .map((entry) => ({
            name: boundedQualityDiagnostic([entry.className, entry.name].filter(Boolean)
              .map((part) => redactDiagnosticText(boundedQualityDiagnostic(part, 300))).join('::'), 300),
            status: 'failed'
          }))
      };
    } catch (reportError) {
      report = { status: 'unavailable',
        reason: redactDiagnosticText(boundedQualityDiagnostic(reportError.message, 500)) };
    }
  }
  refusal.details = {
    ...(refusal.details ?? {}),
    // The Story's own ID: without it the refusal's steps could not name the base run or the decision list.
    ...(workId && !refusal.details?.workId ? { workId } : {}),
    requiredTestExecution: {
      ...requiredTestExecutionDiagnostic(root, command, check),
      report,
      failure: classifyRequiredTestFailure(refusal.code, check, report)
    }
  };
  if (refusal.code === 'CODE_TEST_FAILED') {
    const stage = /before publication/u.test(refusal.message) ? ' before publication' : '';
    const outcome = check?.status === 'blocked' ? 'was blocked'
      : check?.status === 'passed' ? 'did not produce passing test evidence' : 'failed';
    const exit = Number.isInteger(check?.exitCode) ? ` (exit ${check.exitCode})` : '';
    refusal.message = `Required test command '${command.id}' ${outcome}${stage}${exit}. `
      + `See error.requiredTestExecution in --json for the command and bounded output. To see whether it also fails without this change: singularity-flow tests base --work-id ${workId ?? '<WORK-ID>'} --command ${command.id}.`
      + ((refusal.details?.testRunRisk ?? refusal.details?.testRunCause)?.guidance ? ` ${(refusal.details.testRunRisk ?? refusal.details.testRunCause).guidance}` : '');
    // The Node here is what stops it, and another is installed: the way through is one person's choice.
    const pin = await (await import('./node-pin.mjs')).nodePinOffer(root, [command], { attempts: [{ commandId: command.id, status: check?.status ?? 'failed', cause: refusal.details?.testRunRisk ?? refusal.details?.testRunCause ?? null }] }).catch(() => null);
    if (pin) {
      refusal.details.nodePin = { file: pin.file, version: pin.version, node: pin.node, running: pin.running ?? null, words: pin.words };
      refusal.message += ` ${pin.words} A person can choose Pin Node ${pin.version} on the decision list: singularity-flow decisions ${workId ?? '<WORK-ID>'}. It creates ${pin.file} and amends the plan in one step.`;
    } else {
      // Nothing here says the Node is at fault, but another one is installed: a command answers that, with no chain of shell commands.
      const other = await (await import('./node-pin.mjs')).otherInstalledNode(root, command).catch(() => null);
      if (other) refusal.details.otherNode = other;
    }
  }
  return refusal;
}

const transientQualityResultRestorers = new WeakMap();
const qualityCommandResults = new WeakMap();

async function qualityResultDirectoryFiles(absolute, adapter, depth = 0, state = { files: 0, bytes: 0 }, {
  clearing = false
} = {}) {
  if (depth > 8) {
    throw new SingularityFlowError('Structured test result directory exceeds depth 8.', {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const extension = adapter === 'dotnet-trx' ? /\.trx$/iu : /\.xml$/iu;
  const files = [];
  for (const entry of await readdir(absolute, { withFileTypes: true })) {
    const target = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...await qualityResultDirectoryFiles(target, adapter, depth + 1, state, { clearing }));
    } else if (extension.test(entry.name)) {
      // The parser never follows report symlinks. Do not clear one and then let a test command
      // write through it to an unrelated target outside the configured result directory.
      if (entry.isSymbolicLink() && !clearing) {
        throw new SingularityFlowError(`Structured test result is a symlink: ${target}`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      if (entry.isSymbolicLink()) {
        files.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await lstat(target);
      if (!clearing && (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)) {
        throw new SingularityFlowError(`Structured test result cannot be safely staged: ${target}`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      state.files += 1;
      state.bytes += info.size;
      if (!clearing && (state.files > 1_000 || state.bytes > 64 * 1024 * 1024)) {
        throw new SingularityFlowError('Structured test results exceed safe staging limits.', {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
      files.push(target);
    }
  }
  return files;
}

async function stageTransientQualityResult(root, commandRoot, resultPath, adapter) {
  const absolute = path.resolve(commandRoot, resultPath);
  const relative = repoRelative(root, absolute);
  const transient = isTransientTestResultPath(relative);
  if (!transient) {
    const compared = relative.toLocaleLowerCase('en-US');
    const overlapping = executeGitQuery(root, 'repository.tracked-paths').find((candidate) => {
      const tracked = candidate.toLocaleLowerCase('en-US');
      return compared === '.' || tracked === compared || tracked.startsWith(`${compared}/`);
    });
    if (overlapping) {
      throw new SingularityFlowError(
        `Configured test result path overlaps tracked repository content: ${resultPath} (${overlapping}).`,
        { code: 'CODE_TEST_RESULT_REQUIRED' }
      );
    }
  }
  const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isFile() && !info.isDirectory())) {
    throw new SingularityFlowError(`Structured test result cannot be safely staged: ${resultPath}`, {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  if (info?.isDirectory() && (absolute === root || absolute === commandRoot)) {
    throw new SingularityFlowError(`Test result directory cannot be a repository or command root: ${resultPath}`, {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  if (info?.isDirectory() && !['junit-xml', 'dotnet-trx'].includes(adapter)) {
    throw new SingularityFlowError(`Test result adapter '${adapter}' requires a file path: ${resultPath}`, {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  if (info?.isFile() && (info.nlink !== 1 || info.size > 16 * 1024 * 1024)) {
    throw new SingularityFlowError(`Structured test result cannot be safely staged: ${resultPath}`, {
      code: 'CODE_TEST_RESULT_REQUIRED'
    });
  }
  const originals = info?.isDirectory()
    ? await qualityResultDirectoryFiles(absolute, adapter)
    : info?.isFile() ? [absolute] : [];
  const temporary = originals.length ? await mkdtemp(path.join(os.tmpdir(), 'sflow-test-result-')) : null;
  const backup = temporary ? path.join(temporary, 'result') : null;
  try {
    for (const file of originals) {
      const saved = path.join(backup, path.relative(absolute, file));
      await mkdir(path.dirname(saved), { recursive: true });
      await cp(file, saved, { preserveTimestamps: true });
      const copied = await lstat(saved);
      if (!copied.isFile() || copied.nlink !== 1 || copied.size > 16 * 1024 * 1024) {
        throw new SingularityFlowError(`Structured test result changed while being staged: ${file}`, {
          code: 'CODE_TEST_RESULT_REQUIRED'
        });
      }
    }
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  let restored = false;
  const restore = async ({ accepted = false } = {}) => {
    if (restored) return;
    try {
      // Native report locations retain the successful runner's fresh files. Only a refused or
      // failed execution needs its preexisting report bytes put back.
      if (accepted && !transient) {
        restored = true;
        return;
      }
      // Disposable .sflow reports retain their former behavior; native report directories keep
      // unrelated files while originals are overlaid byte-for-byte after failed execution.
      if (transient) {
        const current = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (current?.isDirectory()) {
          if (!['junit-xml', 'dotnet-trx'].includes(adapter)) {
            throw new SingularityFlowError(`Test result adapter '${adapter}' requires a file path: ${resultPath}`, {
              code: 'CODE_TEST_RESULT_REQUIRED'
            });
          }
          for (const file of await qualityResultDirectoryFiles(absolute, adapter, 0, {
            files: 0, bytes: 0
          }, { clearing: true })) {
            await rm(file, { force: true });
          }
        } else {
          await rm(absolute, { force: true });
        }
      }
      for (const file of originals) {
        const parent = await secureRepositoryPath(root, path.relative(root, path.dirname(file)), {
          label: 'Original structured test result parent', mustExist: false
        });
        await mkdir(parent.absolute, { recursive: true });
        await secureRepositoryPath(root, path.relative(root, parent.absolute), {
          label: 'Original structured test result parent', mustExist: true, type: 'directory'
        });
        const current = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
        if (current?.isDirectory()) {
          throw new SingularityFlowError(`Cannot restore original test result over a directory: ${file}. Backup remains at ${backup}.`, {
            code: 'CODE_TEST_RESULT_REQUIRED'
          });
        }
        // A runner may replace the report with a symlink. Unlink that final entry without
        // following it, then revalidate the destination before copying the original bytes.
        await rm(file, { force: true });
        const safe = await secureRepositoryPath(root, path.relative(root, file), {
          label: 'Original structured test result', mustExist: false
        });
        await cp(path.join(backup, path.relative(absolute, file)), safe.absolute, {
          preserveTimestamps: true
        });
      }
      restored = true;
    } finally {
      if (restored && temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  };
  return {
    clear: async () => {
      // Only clear parser-visible report files from a directory. Clearing the directory itself
      // could temporarily erase source files or unrelated generated artifacts at a configured path.
      for (const file of originals) await rm(file, { force: true });
    },
    restore: transient || originals.length ? restore : null
  };
}

async function restoreTransientQualityResult(check, { accepted = false } = {}) {
  const restore = transientQualityResultRestorers.get(check);
  if (!restore) return;
  await restore({ accepted });
  transientQualityResultRestorers.delete(check);
}

function safeEnvironmentFingerprint(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/^sha256:/, '');
  return /^[a-f0-9]{64}$/.test(normalized) ? `sha256:${normalized}` : null;
}

const PUBLIC_ENVIRONMENT_BINDING_SOURCES = Object.freeze([
  'none', 'private-binding', 'private-binding+declaration-defaults', 'declaration-defaults'
]);
let environmentBindingRuntimePromise = null;

async function resolveEnvironmentBinding(root, environmentId, options) {
  // Private binding values are needed only when a quality command reaches its execution gate.
  // Keep their store/validation implementation out of every long-lived VS Code gateway bundle;
  // PACKAGE_ROOT resolves the repository source in development and the staged CLI in a VSIX.
  const runtimeUrl = pathToFileURL(path.join(
    PACKAGE_ROOT, 'src', 'environment-bindings.mjs'
  )).href;
  environmentBindingRuntimePromise ??= import(runtimeUrl);
  const runtime = await environmentBindingRuntimePromise;
  return runtime.resolveEnvironmentBinding(root, environmentId, options);
}

function safeEnvironmentMetadata(value, fallbackName = null) {
  const name = ENVIRONMENT_IDENTIFIER.test(String(value?.name ?? fallbackName ?? ''))
    ? String(value?.name ?? fallbackName)
    : null;
  if (!name) return null;
  const boundNames = Array.isArray(value?.boundNames)
    ? [...new Set(value.boundNames
      .map((entry) => String(entry))
      .filter((entry) => /^[A-Z][A-Z0-9_]*$/.test(entry)))].sort()
    : [];
  const source = PUBLIC_ENVIRONMENT_BINDING_SOURCES.includes(value?.source)
    ? value.source
    : 'none';
  const bindingRevision = /^envb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(value?.bindingRevision ?? ''))
    ? String(value.bindingRevision)
    : null;
  const secretsPresent = Array.isArray(value?.secretsPresent)
    ? [...new Set(value.secretsPresent
      .map((entry) => String(entry))
      .filter((entry) => /^[A-Z][A-Z0-9_]*$/.test(entry)))].sort()
    : [];
  return {
    name,
    declarationSha256: safeEnvironmentFingerprint(value?.declarationSha256),
    boundNames,
    endpointsSha256: safeEnvironmentFingerprint(value?.endpointsSha256),
    secretsPresent,
    source,
    bindingRevision,
    fingerprintSha256: safeEnvironmentFingerprint(value?.fingerprintSha256)
  };
}

/** The blocked check an environment-linked command records instead of running. */
function environmentBlockedCheck(policy, { environment, errorCode, reason, sourceCommit, sourceTreeSha256, startedAt }) {
  return {
    id: policy.id,
    command: policy.command ?? policy.argv.join(' '),
    kind: policy.kind,
    // An environment prerequisite is a fail-closed execution requirement even when an older
    // command happened to label the command itself advisory.
    requirement: 'required',
    externalModelPolicy: policy.modelPolicy,
    workingDirectory: policy.workingDirectory,
    timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
    sourceCommit,
    sourceTreeSha256,
    startedAt,
    completedAt: nowIso(),
    status: 'blocked',
    errorCode,
    exitCode: null,
    stdout: '',
    stderr: reason,
    stdoutBytes: 0,
    stderrBytes: Buffer.byteLength(reason),
    stdoutTruncated: false,
    stderrTruncated: false,
    environment: environment ?? safeEnvironmentMetadata({}, policy.environment) ?? null
  };
}

/**
 * Environment-bound quality commands fail closed unless the Story's capability policy
 * `localIntegrationEvidence` is `allowed` [RUN M3, docs/ENVIRONMENT-BINDINGS.md]. Then, and only
 * for a complete binding and an argv command, the gate says `run`: the values are materialized
 * at the runner boundary for that process only and the run is recorded as `local-integration`.
 * The resolver returns public metadata only; durable checks retain the public environment
 * identifier and its value-independent binding fingerprint, never a value.
 *
 * `localIntegration` is passed only when the policy is allowed: { listed (command ID -> the
 * capability's tests[].environments), requested (a person's --environment for a local run) }.
 * Without it the result is exactly what this boundary returned before the policy existed.
 */
export async function environmentQualityCommandGate(root, policy, {
  sourceCommit,
  sourceTreeSha256,
  startedAt,
  resolver = resolveEnvironmentBinding,
  localIntegration = null
} = {}) {
  let resolution = null;
  let resolutionFailed = false;
  try {
    resolution = await resolver(root, policy?.environment ?? null, { commandId: policy?.id });
  } catch {
    // Declaration, private-store, and resolver failures are all unavailable at this execution
    // boundary. Raw resolver errors may contain provider or host details and are never copied into
    // a governed check.
    resolutionFailed = true;
  }
  let environment = safeEnvironmentMetadata(resolution?.environment, policy?.environment ?? null);
  // The checks mapping or the command's own field: the one environment whose run counts.
  const linked = environment?.name ?? null;
  const listed = localIntegration?.listed?.get(policy?.id) ?? [];
  let chosen = linked;
  if (localIntegration && !resolutionFailed && (listed.length || linked)) {
    const allowed = listed.length ? listed : [linked];
    // A gate runs the linked environment, the one whose run counts. A person's local run uses the
    // one they named, else the first the command lists, as the capability declares it.
    chosen = localIntegration.requested && allowed.includes(localIntegration.requested)
      ? localIntegration.requested : localIntegration.local ? allowed[0] : linked ?? listed[0];
    if (chosen !== linked) {
      // Another declared environment of this command: resolved by itself, never through the mapping.
      try { resolution = await resolver(root, chosen, {}); }
      catch { resolution = null; resolutionFailed = true; }
      environment = safeEnvironmentMetadata(resolution?.environment, chosen);
    }
  }
  // A command with neither an explicit environment nor a declaration check mapping remains an
  // ordinary quality command. A resolver failure still blocks because a malformed declaration
  // could otherwise hide a command-to-environment mapping.
  if (!environment && !policy?.environment && !resolutionFailed) return { block: null, run: null };
  const shellCommandRefused = Boolean(policy?.command) && Boolean(environment || policy?.environment);
  const bound = resolution?.status === 'bound';
  if (localIntegration && bound && !shellCommandRefused && environment && !resolutionFailed) {
    return { block: null, run: {
      environmentId: environment.name, environment, linked, listed: [...listed],
      countsForStep: linked ? environment.name === linked : true
    } };
  }
  const errorCode = shellCommandRefused
    ? 'ENVIRONMENT_ARGV_REQUIRED'
    : bound
      ? 'ENVIRONMENT_ISOLATED_RUNNER_REQUIRED'
      : 'ENVIRONMENT_BINDING_UNAVAILABLE';
  const reason = resolutionFailed && !environment && !policy?.environment
    ? `Environment requirements could not be resolved safely for quality command '${policy.id}'. The command was not executed.`
    : shellCommandRefused
      ? `Environment '${environment?.name ?? policy.environment}' is assigned to quality command '${policy.id}', but environment-bound commands must use an exact argv declaration. The shell command was not executed.`
      : bound
        ? `Environment '${environment?.name ?? policy.environment}' is bound, but quality command '${policy.id}' requires an approved isolated runner. No environment values were materialized and the command was not executed.`
          + ' To run it on this machine as labelled local-integration evidence, the capability policy localIntegrationEvidence must be allowed; it changes through a capability proposal.'
        : `Environment '${environment?.name ?? policy.environment}' is unavailable for quality command '${policy.id}'. Bind the declared environment before retrying; the command was not executed.`;
  return { block: environmentBlockedCheck(policy, { environment, errorCode, reason, sourceCommit, sourceTreeSha256, startedAt }), run: null };
}

/** The pre-policy boundary: the blocked check, or null when the command is not environment-linked. */
export async function environmentQualityCommandBlock(root, policy, options = {}) {
  return (await environmentQualityCommandGate(root, policy, { ...options, localIntegration: null })).block;
}

/**
 * What an allowed local-integration run needs to know for this Story, or null when the pinned
 * capability policy is off (the default), in which case nothing else is read at all.
 */
async function storyLocalIntegration(root, workflow, localRun = null) {
  if (workflow?.resolution?.capability?.policy?.localIntegrationEvidence !== 'allowed') return null;
  const listed = new Map();
  try {
    // Read only for an allowed Story, and kept out of the long-lived VS Code bundles like the bindings.
    const runtimeUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'capability-application-context.mjs')).href;
    const { resolveCapabilityApplication } = await import(runtimeUrl);
    const application = await resolveCapabilityApplication(root, { capabilityId: workflow.resolution.capability.id ?? null });
    for (const entry of application.application.tests) if (entry.environments.length) listed.set(entry.use, [...entry.environments]);
  } catch { /* no declared test environments: only checks-linked commands qualify */ }
  const session = localRun?.ranBy ? null : await loadSession(root, { required: false }).catch(() => null);
  return {
    listed,
    local: Boolean(localRun),
    requested: localRun?.requestedEnvironment ?? null,
    ranBy: localRun?.ranBy ?? (session?.actor ? actorKey(session.actor) ?? null : null)
  };
}

async function materializeQualityEnvironment(root, environmentId, files) {
  const runtimeUrl = pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'environment-bindings.mjs')).href;
  environmentBindingRuntimePromise ??= import(runtimeUrl);
  return (await environmentBindingRuntimePromise).materializeEnvironmentBinding(root, environmentId, { files });
}

export function effectiveEnvironmentQualityCommandCatalog(
  phase, workflow, commands = phase?.qualityCommands ?? []
) {
  // Delivery adapters may infer or strengthen a repository-native command after Story acceptance.
  // The actual current-phase execution set is authoritative for that phase; combine it with every
  // *other* pinned phase so inferred commands cannot evade cross-phase duplicate-ID or explicit
  // environment checks, without treating a strengthened current command as a second definition.
  const pinnedOtherPhaseCommands = (workflow?.resolution?.phases ?? [])
    .filter((entry) => entry.id !== phase?.id)
    .flatMap((entry) => entry.qualityCommands ?? []);
  return [...pinnedOtherPhaseCommands, ...commands]
    .map((entry, index) => normalizeExternalCommand(entry, index));
}

/**
 * A check that ran on the isolated candidate failed: say which files no plan names it ran without,
 * because a candidate that needs one of them is incomplete until the plan accounts for it [D9].
 */
function isolatedRunHint(error, check) {
  if (!check?.excludedFromRun?.length || !/^CODE_TEST_/u.test(String(error?.code ?? ''))) return error;
  error.message = `${error.message} It ran on the candidate without these files no plan names: ${check.excludedFromRun.join(', ')}. `
    + 'If the candidate needs one of them, account for it with singularity-flow decision plan --add-location <clause>=<path> --reason <why>.';
  return error;
}

/** Whether a structured test command's report is its own stdout, captured to the result path. */
function stdoutReportCaptured(policy) {
  return policy.kind === 'test' && Array.isArray(policy.argv) && (policy.result?.adapter === 'go-test-json'
    || policy.result?.adapter === 'node-tap'
    || policy.result?.adapter === 'karma-text'
    || (policy.result?.adapter === 'cargo-json' && /^cargo(?:\.exe)?$/iu.test(path.basename(policy.argv[0])))
    || (policy.result?.adapter === 'junit-xml'
      && policy.argv.some((argument) => argument === '--test-reporter=junit')));
}

/**
 * The kernel pieces the local test runs share with the gates, so `tests run` runs exactly what
 * publication runs (src/local-test-runs.mjs, loaded only by that command) [RUN M2].
 */
export const localTestRunKernel = Object.freeze({
  qualityChecks: (...args) => qualityChecks(...args),
  stageTransientQualityResult: (...args) => stageTransientQualityResult(...args),
  restoreTransientQualityResult: (...args) => restoreTransientQualityResult(...args),
  environmentQualityCommandGate: (...args) => environmentQualityCommandGate(...args),
  mayReuseUnchangedRuns: (workflow) => mayReuseUnchangedRuns(workflow),
  stdoutReportCaptured, boundedQualityDiagnostic, defaultTimeoutMs: DEFAULT_QUALITY_COMMAND_TIMEOUT_MS
});

async function qualityChecks(root, phase, config, workflow, commands = phase.qualityCommands ?? [], {
  commandProvenance = new Map(), localRun = null, reuseUnchanged = false, pinOf = null, candidateRoot = null, candidateIsOtherCode = false, onMutation = null
} = {}) {
  const checks = [];
  // Null unless the pinned capability policy allows local integration evidence [RUN M3].
  const localIntegration = await storyLocalIntegration(root, workflow, localRun);
  const declaration = await loadEnvironmentDeclaration(root, { optional: true });
  const catalog = effectiveEnvironmentQualityCommandCatalog(phase, workflow, commands);
  validateEnvironmentQualityCommandCatalog(declaration, catalog);
  const sourceCommit = head(root);
  // A base run's worktree holds other code by design: what must not change is that worktree's own.
  const sourceTreeSha256 = await sourceTreeHash(candidateIsOtherCode ? candidateRoot : root, config, workflow);
  const testInputSha256 = await testInputTreeHash(candidateIsOtherCode ? candidateRoot : root, config, workflow);
  const modelEnabled = operationContext()?.modelMode?.enabled !== false;
  const unknownStrictness = config.noModel?.unknownExternalCommands ?? 'warn';
  let activeTransientRestore = null;
  let isolatedResultRestore = null;
  // Changed files no plan names stay in the worktree, and verification runs on exactly the
  // candidate in a worktree materialized beside it [E2G-027, D9].
  const isolationNeed = commands.length && !candidateRoot ? await candidateIsolationNeed(root, config, workflow) : null;
  // An Auto Candidate brings its own isolated worktree, which its verification removes [TCE:REQ-084].
  let isolation = candidateRoot ? { root: candidateRoot, dispose: async () => {} } : null;
  if (isolationNeed?.excluded.length) {
    isolation = workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true
      ? { available: false, reason: 'the test-recovery pilot captures reports from this worktree' }
      : await materializeCandidate(root, { included: isolationNeed.included, treeHash: (directory) => sourceTreeHash(directory, config, workflow) });
    if (!isolation.available) {
      throw new SingularityFlowError(
        `Phase ${phase.id} has changed files no plan names, and the checks cannot run without them because ${isolation.reason}: ${isolationNeed.excluded.join(', ')}. `
        + 'Account for each that belongs with singularity-flow decision plan, or move it out of the worktree, then try again.',
        { code: 'GENERATION_EXCLUSIONS_UNSAFE', details: { phase: phase.id, paths: isolationNeed.excluded, isolation: isolation.reason,
          recoveryCommands: isolationNeed.excluded.slice(0, 3).map((candidate) =>
            `singularity-flow decision plan ${workflow.workItem.id} --add-location <clause>=${candidate} --reason <why>`) } }
      );
    }
  }
  try {
  for (const [index, value] of commands.entries()) {
    const policy = evaluateExternalCommandForModelMode(value, { modelEnabled, unknownStrictness, index });
    const command = policy.command ?? policy.argv.join(' ');
    const startedAt = nowIso();
    const environmentGate = await environmentQualityCommandGate(root, policy, {
      sourceCommit, sourceTreeSha256, startedAt, localIntegration
    });
    if (environmentGate.block) {
      checks.push(environmentGate.block);
      continue;
    }
    // The runner boundary: values for this one process, never a durable field [RUN rule 3].
    let materialized = null;
    if (environmentGate.run) {
      // Its environment files are placed in the checkout the command runs in [ENVF]; a missing one blocks it.
      materialized = await materializeQualityEnvironment(root, environmentGate.run.environmentId, { checkout: isolation?.root ?? root,
        sourceRoots: workflow?.resolution?.capability?.sourceScope?.sourceRoots ?? [], workingDirectory: policy.workingDirectory })
        .catch((error) => (String(error?.code).startsWith('ENV_FILE_') ? { refusal: error } : null));
      if (materialized?.status !== 'bound') {
        checks.push(environmentBlockedCheck(policy, {
          environment: safeEnvironmentMetadata(materialized?.environment, environmentGate.run.environmentId),
          errorCode: materialized?.refusal?.code ?? 'ENVIRONMENT_BINDING_UNAVAILABLE',
          reason: materialized?.refusal?.message ?? `Environment '${environmentGate.run.environmentId}' is unavailable for quality command '${policy.id}'. Bind the declared environment before retrying; the command was not executed.`,
          sourceCommit, sourceTreeSha256, startedAt
        }));
        continue;
      }
    }
    if (policy.action === 'block') throw new SingularityFlowError(policy.reason, { code: 'EXTERNAL_MODEL_POLICY_BLOCKED' });
    if (policy.action === 'skip') {
      checks.push({
        id: policy.id, command, requirement: policy.requirement,
        externalModelPolicy: policy.modelPolicy, sourceCommit, sourceTreeSha256,
        ...(testInputSha256 ? { testInputSha256 } : {}),
        startedAt, completedAt: nowIso(), status: 'skipped-warning', exitCode: null,
        stdout: '', stderr: policy.reason
      });
      continue;
    }
    const commandTarget = await secureRepositoryPath(
      root,
      policy.workingDirectory && policy.workingDirectory !== '.' ? policy.workingDirectory : '.',
      { label: `Quality command '${policy.id}' working directory`, mustExist: true, type: 'directory' }
    );
    const commandRoot = commandTarget.absolute;
    // Reports are staged and read in the worktree; the command itself runs on the candidate.
    const executionRoot = isolation
      ? (await secureRepositoryPath(isolation.root, policy.workingDirectory || '.', {
        label: 'Isolated command working directory', mustExist: true, type: 'directory'
      })).absolute
      : commandRoot;
    let restoreTransientResult = null;
    let structuredResultTarget = null;
    if (policy.kind === 'test' && policy.result?.path) {
      const resultTarget = path.resolve(commandRoot, policy.result.path);
      // `secureRepositoryPath` resolves macOS' /var -> /private/var alias. Compare the result to the
      // same canonical root; mixing the caller's lexical root with the secured real path falsely
      // classified repository-contained reports as external.
      const repositoryTarget = await secureRepositoryPath(root, '.', {
        label: 'Repository root', mustExist: true, type: 'directory'
      });
      if (resultTarget !== repositoryTarget.absolute
          && !resultTarget.startsWith(`${repositoryTarget.absolute}${path.sep}`)) {
        throw new SingularityFlowError(`Test result path resolves outside the repository: ${policy.result.path}`, { code: 'CODE_TEST_RESULT_REQUIRED' });
      }
      await secureRepositoryPath(root, path.relative(repositoryTarget.absolute, resultTarget), {
        label: `Test result '${policy.result.path}'`, mustExist: false
      });
      await mkdir(path.dirname(resultTarget), { recursive: true });
      await secureRepositoryPath(root, path.relative(repositoryTarget.absolute, path.dirname(resultTarget)), {
        label: `Test result parent '${policy.result.path}'`, mustExist: true, type: 'directory'
      });
      const stagedResult = await stageTransientQualityResult(
        repositoryTarget.absolute, commandRoot, policy.result.path, policy.result.adapter
      );
      restoreTransientResult = stagedResult.restore;
      activeTransientRestore = restoreTransientResult;
      // A timestamp is not execution evidence: remove prior report files before execution so
      // anything parsed afterwards must have been created by this invocation. Directory paths
      // may contain unrelated files, so the staging helper clears only parser-visible reports.
      await stagedResult.clear();
      structuredResultTarget = resultTarget;
      if (isolation) {
        const isolatedTarget = await secureRepositoryPath(isolation.root,
          path.relative(isolation.root, path.resolve(executionRoot, policy.result.path)),
          { label: 'Isolated test result', mustExist: false });
        await mkdir(path.dirname(isolatedTarget.absolute), { recursive: true });
        const stagedCandidateResult = await stageTransientQualityResult(
          isolation.root, executionRoot, policy.result.path, policy.result.adapter
        );
        isolatedResultRestore = stagedCandidateResult.restore;
        await stagedCandidateResult.clear();
        structuredResultTarget = isolatedTarget.absolute;
      }
    }
    await prepareInferredSwiftTestReports(isolation?.root ?? root, policy);
    // A CLI invoked from Node's own test runner inherits NODE_TEST_CONTEXT. Passing that private
    // harness marker to a nested `node --test` process makes Node treat the required repository
    // test as an internal child and emit no reporter events. External quality commands are a new
    // execution boundary, so they receive the ordinary process environment without the parent's
    // test-runner control marker.
    const failedRiskCommand = workflow?.resolution?.testRecovery?.enabledRiskCategories?.some(category => ['new-test-failure', 'known-test-failure', 'reduced-coverage'].includes(category))
      && workflow.resolution.testRecovery.caseInventory?.some(entry => entry.phaseId === phase.id && entry.commandId === policy.id);
    const riskDeclaration = failedRiskCommand ? trpCaseInventoryDeclaration(workflow, phase, policy) : null;
    // CI=1, and no inherited variable that narrows the run unseen [TCE:REQ-030].
    const gateRun = policy.kind === 'test' ? (await gateTestEnvironmentModule()).gateTestEnvironment(process.env, { declared: policy.env ?? null }) : null;
    const inherited = gateRun?.environment ?? process.env;
    let commandEnvironment = failedRiskCommand ? trpExecutionEnvironment(riskDeclaration, inherited, { cwd: commandRoot }) : { ...inherited };
    if (policy.kind === 'test') commandEnvironment = testRuntimeEnvironment(workflow?.resolution?.testRuntime, commandEnvironment);
    if (policy.kind === 'test' && policy.result?.adapter === 'node-tap') {
      commandEnvironment = await nodeTestReporterEnvironment(commandEnvironment, isolation?.root ?? root, { argv: policy.argv, cwd: executionRoot });
    }
    delete commandEnvironment.NODE_TEST_CONTEXT;
    // Variables a host sets to run the CLI itself (VS Code's ELECTRON_RUN_AS_NODE) are not the
    // tests' environment, in a local run or at publication and submission alike.
    commandEnvironment = withoutHostSurfaceVariables(commandEnvironment);
    // The Node the repository asks for, for a build as for a test [TCE:REQ-035].
    const requestedNode = await (await gateTestEnvironmentModule()).withProjectNodeVersion(commandEnvironment, { cwd: executionRoot, root: isolation?.root ?? root });
    commandEnvironment = withCommandLiteralEnvironment(requestedNode.environment, policy);
    if (materialized) commandEnvironment = materialized.childEnvironment(commandEnvironment);
    if (policy.kind === 'test' && policy.result?.adapter === 'playwright-json'
        && structuredResultTarget) {
      // The JSON reporter otherwise writes to stdout. Bind its report to the exact secured,
      // freshly cleared path that the delivery parser will inspect, on every host platform.
      for (const key of Object.keys(commandEnvironment)) {
        if (key.toLocaleUpperCase('en-US') === 'PLAYWRIGHT_JSON_OUTPUT_FILE') {
          delete commandEnvironment[key];
        }
      }
      commandEnvironment.PLAYWRIGHT_JSON_OUTPUT_FILE = structuredResultTarget;
    }
    gateRun?.observe(policy, { cwd: executionRoot, environment: commandEnvironment, bound: materialized?.environment, nodeVersion: requestedNode.nodeVersion });
    // A passing run of this command on exactly this code, under the same pin and in the same environment, stands [TCE:REQ-080].
    let rerunReason = null;
    if (reuseUnchanged && policy.kind === 'test' && policy.argv && gateRun && !environmentGate.run) {
      const observed = {};
      await gateRun.attach(observed);
      const standing = await unchangedTestRun(root, workDirRelative(config, workflow.workItem.id), workflow, phase.id, value, {
        commit: sourceCommit, treeSha256: sourceTreeSha256, testInputSha256, environmentSha256: runEnvironmentSha256(observed.runEnvironment),
        ...(pinOf ? { pinSha256: pinOf(policy.id) } : {}) });
      if (standing.attempt) {
        // Nothing ran: the report staged for this run returns untouched.
        if (restoreTransientResult) await restoreTransientResult();
        activeTransientRestore = null;
        if (isolatedResultRestore) { await isolatedResultRestore(); isolatedResultRestore = null; }
        checks.push(reusedQualityCheck(policy, command, standing, { testInputSha256, testRuntime: testRuntimeIdentity(workflow?.resolution?.testRuntime, commandEnvironment) }));
        console.warn(`Not run again: ${policy.id} passed on this exact code (${standing.attempt.attemptId}, recorded by ${standing.attempt.phase}).`);
        continue;
      }
      rerunReason = standing.moved;
    }
    if (rerunReason) console.warn(`Running ${policy.id} again: ${rerunReason}.`);
    const result = policy.argv
      ? await runQualityCommand(policy.argv[0], policy.argv.slice(1), {
        cwd: executionRoot,
        env: commandEnvironment,
        timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
        killTree: true,
        reportCapture: trpNativeReportCapture(root, policy, riskDeclaration),
        stdoutFile: stdoutReportCaptured(policy) ? structuredResultTarget : null,
        redactor: materialized?.redactsAnything ? materialized.streamRedactor : null
      })
      : await runQualityCommand(policy.command, [], {
        cwd: executionRoot, env: commandEnvironment, shell: true,
        timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
        killTree: true
      });
    if (isolation && policy.kind === 'test') await importIsolatedReport(executionRoot, commandRoot, policy.result?.path, {
      isolatedRoot: isolation.root, repositoryRoot: root, adapter: policy.result?.adapter
    });
    if (isolatedResultRestore) {
      await isolatedResultRestore();
      isolatedResultRestore = null;
    }
    // Report files are rewritten with every bound secret redacted before anything reads them.
    if (materialized?.redactsAnything && policy.kind === 'test' && policy.result?.path) {
      await (await import('./code-delivery-tests.mjs')).redactTestReportFiles(root, policy, materialized.redact);
    }
    const completedTreeSha256 = await sourceTreeHash(isolation ? isolation.root : root, config, workflow);
    const completedTestInputSha256 = await testInputTreeHash(isolation ? isolation.root : root, config, workflow);
    const infrastructureError = result.error
      ? `Unable to run quality command: ${result.error.message}`
      : null;
    const check = {
      id: policy.id, command, kind: policy.kind, requirement: policy.requirement,
      workingDirectory: policy.workingDirectory,
      resultIsolated: Boolean(structuredResultTarget),
      ...(isolation ? { executionIsolation: 'candidate-worktree', excludedFromRun: [...(isolationNeed?.excluded ?? [])] } : {}),
      externalModelPolicy: policy.modelPolicy,
      timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
      sourceCommit, sourceTreeSha256, ...(testInputSha256 ? { testInputSha256 } : {}),
      ...(policy.kind === 'test' ? { testRuntime: testRuntimeIdentity(workflow?.resolution?.testRuntime, commandEnvironment) } : {}),
      startedAt, completedAt: nowIso(),
      status: result.timedOut || infrastructureError ? 'blocked' : result.status === 0 ? 'passed' : 'failed',
      ...(result.error?.code === 'ENOENT' ? { infrastructureUnavailable: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      exitCode: result.status, signal: result.signal ?? null, stdout: boundedQualityDiagnostic(result.stdout),
      stderr: boundedQualityDiagnostic(result.timedOut
        ? `Command exceeded its ${policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS}ms timeout.`
        : infrastructureError ?? requestedNode.explained(result)),
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated || String(result.stdout ?? '').length > 2000,
      stderrTruncated: result.stderrTruncated || String(result.stderr ?? '').length > 2000,
      // A run given an environment's values is local-integration evidence, labelled as such, with
      // the environment's public metadata and who ran it; never relabelled as governed [RUN M3].
      ...(environmentGate.run ? {
        evidenceClass: 'local-integration', environment: environmentGate.run.environment,
        ranBy: localIntegration?.ranBy ?? null, linkedEnvironment: environmentGate.run.linked,
        allowedEnvironments: environmentGate.run.listed.length ? environmentGate.run.listed : environmentGate.run.linked ? [environmentGate.run.linked] : [],
        countsForStep: environmentGate.run.countsForStep
      } : {})
    };
    if (completedTreeSha256 !== sourceTreeSha256 || completedTestInputSha256 !== testInputSha256) {
      const error = new SingularityFlowError(
        `Quality command '${policy.id}' changed application source or separately hashed test inputs. Validation commands must be observational; review the resulting files, publish a fresh generation, and run submission again.`,
        { code: 'QUALITY_COMMAND_SOURCE_MUTATION', details: {
          phase: phase.id, workId: workflow.workItem.id, commandId: policy.id,
          beforeSha256: sourceTreeSha256, afterSha256: completedTreeSha256,
          testInputBeforeSha256: testInputSha256, testInputAfterSha256: completedTestInputSha256
        } }
      );
      // It still ran, as did every suite before it: each is one attempt, recorded while its report is here [E2G-016].
      // Read as failed, so a run that changed the code can never stand as a pass on that code.
      if (onMutation) {
        await gateRun?.attach(check);
        await onMutation([...checks, { ...check, status: 'failed', sourceMutation: true }]).catch(() => null);
      }
      throw policy.kind === 'test'
        ? await attachRequiredTestExecution(error, root, {
          ...policy, provenance: commandProvenance.get(value) ?? 'configured'
        }, check) : error;
    }
    await gateRun?.attach(check);
    if (restoreTransientResult) transientQualityResultRestorers.set(check, restoreTransientResult);
    qualityCommandResults.set(check, result);
    checks.push(check);
    activeTransientRestore = null;
  }
  } catch (error) {
    if (activeTransientRestore) await activeTransientRestore();
    for (const check of checks) await restoreTransientQualityResult(check);
    throw error;
  } finally {
    try { if (isolatedResultRestore) await isolatedResultRestore(); }
    finally { await isolation?.dispose?.(); }
  }
  return checks;
}

/**
 * The check of a run that still stands: the run's own identity and times, and `reusedFrom` naming it,
 * so no surface can read it as a run of this step. The attempt behind it stays off the check's JSON.
 */
function reusedQualityCheck(policy, command, standing, { testInputSha256, testRuntime }) {
  const { attempt } = standing;
  const check = {
    id: policy.id, command, kind: policy.kind, requirement: policy.requirement, workingDirectory: policy.workingDirectory,
    resultIsolated: true, externalModelPolicy: policy.modelPolicy, timeoutMs: policy.timeoutMs ?? DEFAULT_QUALITY_COMMAND_TIMEOUT_MS,
    sourceCommit: attempt.candidate.commit, sourceTreeSha256: attempt.candidate.treeSha256, ...(testInputSha256 ? { testInputSha256 } : {}),
    testRuntime, startedAt: attempt.process.startedAt, completedAt: attempt.process.completedAt,
    status: 'passed', exitCode: 0, signal: null, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
    evidenceUse: 'reused', reusedFrom: { attemptId: attempt.attemptId, phase: attempt.phase, generation: attempt.generation, commit: attempt.candidate.commit,
      treeSha256: attempt.candidate.treeSha256, receiptPath: standing.path, receiptSha256: standing.sha256,
      ...(attempt.testScope?.files ? { files: attempt.testScope.files } : {}), counts: attempt.tests }
  };
  Object.defineProperty(check, 'unchangedRun', { value: standing, configurable: true });
  return check;
}

/** Whether a Story's gates may reuse an earlier passing run: never under the test-recovery pilot, which observes each run itself. */
function mayReuseUnchangedRuns(workflow) {
  return !workflow.testRecovery && workflow.resolution?.testRecovery?.enabled !== true;
}

/** The commands a gate runs under the Story's test scope; only a Story on its new and changed tests narrows any [TCE:REQ-093]. */
async function storyScopedTestCommands(root, workflow, phase, commands, deliveryEvidence) {
  if (storyTestScope(workflow) !== 'new-and-changed') return commands;
  return (await import('./verification/test-scope-selection.mjs')).newAndChangedTestCommands(root, commands, deliveryEvidence?.testPaths ?? []);
}

async function preflightCodeDeliveryTests(root, config, workflow, phase, deliveryEvidence) {
  if (phase.storyTestCommands || workflow.testCommandDecisions) (await import('./story-test-commands.mjs')).assertStoryTestCommands(workflow);
  let commands = (await resolveDeliveryQualityCommands(root, { ...phase, deliveryEvidence },
    { executionMode: storyTestScope(workflow) }))
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
  if (!commands.length) {
    throw structuredTestCommandRequiredError(phase, { workId: workflow.workItem.id, paths: deliveryEvidence?.sourcePaths });
  }
  let trpSelection = null;
  if (workflow.testRecovery || workflow.resolution?.testRecovery?.enabled === true) {
    trpSelection = await resolveTrpDeliverySelection(root, config, workflow, phase, deliveryEvidence, commands, { persist: true });
    commands = trpSelection.commands;
    if (trpSelection.reference) deliveryEvidence.trpSelection = trpSelection.reference;
  }
  const retainedRisk = await retainedStoryTestRisk(root, config, workflow, phase, {
    operation: 'publish', generation: trpSelection?.selection?.subject.generation ?? nextPhaseGeneration(phase),
    selection: trpSelection?.selection });
  if (retainedRisk) {
    if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
      const uncovered = uncoveredTestDeliveryPaths(deliveryEvidence, phase.sourceBoundary, commands);
      if (uncovered.length) throw uncoveredTestPathsError(`No approved test command covers affected paths: ${uncovered.join(', ')}`, uncovered);
    }
    deliveryEvidence.testRecovery = { observationSha256: retainedRisk.observation.recordSha256,
      observedOutcome: retainedRisk.observation.observedOutcome, disposition: 'accepted-risk',
      evidenceUse: retainedRisk.observation.observedOutcome === 'failed' ? 'reused' : 'retained-unavailable-attempt',
      evaluationSha256: retainedRisk.evaluation.recordSha256 };
    return { commands, checks: [], testRecovery: retainedRisk };
  }
  // A guessed command is pinned for the Story at first use; a changed one waits for a person [TCE:REQ-010].
  const pins = await (await import('./test-command-pins.mjs')).gateTestCommandPins(root, config, workflow, phase, commands, deliveryEvidence);
  const riskRun = await beginStoryTestRiskRun(root, config, workflow, phase, { commands, selection: trpSelection?.selection });
  commands = await storyScopedTestCommands(root, workflow, phase, commands, deliveryEvidence);
  const checks = await qualityChecks(root, phase, config, workflow, commands, {
    commandProvenance: new Map(commands.map((command) => [command, command.provenance])),
    reuseUnchanged: mayReuseUnchangedRuns(workflow), pinOf: (id) => pins.attempt(id).pin?.sha256 ?? null,
    onMutation: (ran) => recordRunsBeforeRefusal(root, workDirRelative(config, workflow.workItem.id), commands, ran, { pins,
      purpose: 'preflight', workId: workflow.workItem.id, phaseId: phase.id, generation: nextPhaseGeneration(phase), delivery: deliveryEvidence })
  });
  const passing = [];
  const attempts = [];
  const runRisks = [];
  deliveryEvidence.preflightAttempts = attempts;
  const recordedRuns = new Map();
  let refusal = null;
  const otherFailed = [];
  try {
    // Every run is one immutable attempt, recorded before any result is judged [E2G-016], so one
    // suite's failure never drops another's.
    for (const command of commands) {
      const check = checks.find((entry) => entry.id === command.id);
      const recorded = check ? await recordTestAttempt(root, workDirRelative(config, workflow.workItem.id), {
        command, check, purpose: 'preflight', workId: workflow.workItem.id, phaseId: phase.id,
        generation: nextPhaseGeneration(phase), delivery: deliveryEvidence, ...pins.attempt(command.id)
      }) : null;
      recordedRuns.set(command.id, recorded);
      if (recorded) {
        attempts.push({ commandId: command.id, attemptId: recorded.attempt.attemptId, receiptPath: recorded.path,
          receiptSha256: recorded.sha256, status: recorded.attempt.status, affectedRoots: command.affectedRoots });
      }
    }
    for (const command of commands) {
      const check = checks.find((entry) => entry.id === command.id);
      const recorded = recordedRuns.get(command.id);
      // Past the first refusal a suite is only read for the report: nothing can let the step through now.
      if (refusal) {
        otherFailed.push((await import('./test-run-risk.mjs')).otherFailedTest(workflow, phase, command, recorded?.attempt, { at: nowIso() }));
        continue;
      }
      try {
        if (!check || check.status === 'skipped-warning') {
          throw new SingularityFlowError(`Required test command '${command.id}' was skipped before publication.${skippedReason(check)}`, { code: 'CODE_TEST_SKIPPED' });
        }
        if (['blocked', 'failed'].includes(check.status)) {
          const observation = riskRun ? await captureStoryTestRiskObservation(root, config, workflow, phase,
            { run: riskRun, check, result: qualityCommandResults.get(check) }) : null;
          if (observation) {
            const accepted = await assertStoryTestRiskGate(root, config, workflow, { phaseId: phase.id,
              operation: 'publish', generation: observation.subject.generation, observationSha256: observation.recordSha256 });
            if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
              const uncovered = uncoveredTestDeliveryPaths(deliveryEvidence, phase.sourceBoundary, commands);
              if (uncovered.length) throw uncoveredTestPathsError(`No approved test command covers affected paths: ${uncovered.join(', ')}`, uncovered);
            }
            const { materializeStoryTestRiskEvidence } = await import('./test-recovery-runtime.mjs');
            await materializeStoryTestRiskEvidence(root, config, workflow, accepted);
            await appendTrpRecord(workDir(root, config, workflow.workItem.id), accepted.evaluation);
            deliveryEvidence.testRecovery = { observationSha256: observation.recordSha256,
              observedOutcome: observation.observedOutcome, disposition: 'accepted-risk', evidenceUse: 'executed',
              evaluationSha256: accepted.evaluation.recordSha256 };
            // An accepted risk publishes too, so its attempts are committed with it [E2G-016].
            await admitTestAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
            return { commands, checks: [], testRecovery: { observation, evaluation: accepted.evaluation } };
          }
          // A step approver may have accepted that this command cannot run here [test-run risk].
          const runRisk = await testRunRiskCover(workflow, phase, recorded?.attempt);
          if (runRisk) {
            runRisks.push({ commandId: command.id, attemptId: recorded.attempt.attemptId, testRunRisk: runRisk });
            passing.push(command);
            continue;
          }
          throw await testRunRiskRefusal(workflow, phase, recorded?.attempt,
            new SingularityFlowError(`Required test command '${command.id}' was blocked before publication.`, { code: 'CODE_TEST_FAILED' }));
        }
        if (check.status !== 'passed' || check.exitCode !== 0) {
          throw new SingularityFlowError(`Required test command '${command.id}' failed before publication.`, { code: 'CODE_TEST_FAILED' });
        }
        const parsed = recorded.parsed ?? await parseTestResult(root, command, { startedAt: check.startedAt });
        if (parsed.tests.skipped > 0 && riskRun && workflow.resolution.testRecovery.enabledRiskCategories.includes('reduced-coverage')) {
          const observation = await captureStoryTestRiskObservation(root, config, workflow, phase,
            { run: riskRun, check, result: qualityCommandResults.get(check) });
          if (observation) await assertStoryTestRiskGate(root, config, workflow, { phaseId: phase.id,
            operation: 'publish', generation: observation.subject.generation, observationSha256: observation.recordSha256 });
        }
        const receipt = recorded.attempt;
        if (receipt.tests.discovered < parsed.minimumDiscovered) {
          throw new SingularityFlowError(`Required test command '${command.id}' discovered zero or too few tests before publication.`, { code: 'CODE_TEST_ZERO_DISCOVERED' });
        }
        if (!testReceiptPassing(receipt, parsed.minimumDiscovered, command.result.minimumPassed)) {
          // Every discovered test skipped (a Docker daemon or database missing here): no test
          // executed, so the step approvers' test-run risk route applies; it is never a pass.
          const runRisk = await testRunRiskCover(workflow, phase, receipt);
          if (runRisk) {
            runRisks.push({ commandId: command.id, attemptId: receipt.attemptId, testRunRisk: runRisk });
            passing.push(command);
            continue;
          }
          throw await testRunRiskRefusal(workflow, phase, receipt,
            new SingularityFlowError(`Required test command '${command.id}' did not produce passing executable-test evidence before publication.`, { code: 'CODE_TEST_FAILED' }));
        }
        const narrowed = pins.narrowed(receipt, 'publish'); // refused unless a step approver accepted it [TCE:REQ-022]
        if (narrowed) attempts.find((entry) => entry.commandId === command.id).testNarrowing = narrowed;
        passing.push(command);
      } catch (error) {
        refusal = isolatedRunHint(await attachRequiredTestExecution(error, root, command, check, { workId: workflow.workItem.id }), check);
      }
    }
    if (refusal) throw (await import('./test-run-risk.mjs')).withOtherFailedTests(refusal, otherFailed);
  } finally {
    const acceptedIds = new Set(passing.map((command) => command.id));
    for (const check of checks) await restoreTransientQualityResult(check, {
      accepted: acceptedIds.has(check.id)
    });
  }
  if (workflow.resolution?.codeDelivery?.tests?.requireAffectedModuleCoverage !== false) {
    // Repository metadata and CI configuration are exempt, exactly as prepublish and replay judge it.
    const uncovered = uncoveredTestDeliveryPaths(deliveryEvidence, phase.sourceBoundary, passing);
    if (uncovered.length) {
      throw uncoveredTestPathsError(`No passing test command covers affected paths before publication: ${uncovered.join(', ')}`, uncovered);
    }
  }
  if (runRisks.length) deliveryEvidence.testRunRisks = runRisks;
  await pins.record(workflow, attempts.map((attempt) => attempt.commandId), { at: nowIso() });
  // The publication commits this preflight and every earlier kept attempt of the step [E2G-016].
  await admitTestAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phase.id);
  return { commands, checks };
}

/** Why a required test command was not run (its model-mode skip), for the refusal. */
function skippedReason(check) {
  return check?.status === 'skipped-warning' && check.stderr ? ` ${String(check.stderr).slice(0, 400)}` : '';
}

/** Affected paths no test command covers: name them and the test-setup route. */
function uncoveredTestPathsError(message, paths) {
  return new SingularityFlowError(`${message}. Configure an approved test command whose affected roots cover them.`, {
    code: 'TEST_MODULE_UNCOVERED', details: { paths, nextAction: { command: 'singularity-flow capability test-setup --json' },
      recoveryCommands: ['singularity-flow capability test-setup --json', 'singularity-flow story test-policy amend --reason <why>'] }
  });
}

/** The binding of the active test-run risk decision that lets this attempt through, or null. */
async function testRunRiskCover(workflow, phase, attempt) {
  if (!attempt) return null;
  const { coveringTestRunRisk, testRunRiskBinding } = await import('./test-run-risk.mjs');
  const decision = coveringTestRunRisk(workflow, { phaseId: phase.id, attempt, at: nowIso() });
  return decision ? testRunRiskBinding(decision) : null;
}

/** A refused run names what stopped it: an environment cause with the step approvers' route, or a code cause. */
async function testRunRiskRefusal(workflow, phase, attempt, error) {
  if (!attempt) return error;
  const { testRunRiskRefusalDetails } = await import('./test-run-risk.mjs');
  error.details = { ...(error.details ?? {}), ...testRunRiskRefusalDetails(workflow, { phaseId: phase.id, attempt, at: nowIso() }) };
  return error;
}

/** Whether a check or execution was let through by a test-run risk decision still active at `at`. */
async function testRunRiskCarries(workflow, entry, at = nowIso()) {
  if (!entry?.testRunRisk) return false;
  const { boundTestRunRiskActive } = await import('./test-run-risk.mjs');
  return boundTestRunRiskActive(workflow, entry.testRunRisk, { at });
}

/**
 * When runs a test-run risk decision let through are no longer carried (it expired or was
 * revoked), the renewal a person who approves that step runs: words and refusal details naming
 * `decision test-risk ... --expires`. Null when no carried run lapsed.
 */
async function lapsedTestRunRisk(workflow, entries, at = nowIso()) {
  const { lapsedTestRunRiskRenewals } = await import('./test-run-risk.mjs');
  const renewals = lapsedTestRunRiskRenewals(workflow, entries, { at });
  return renewals.length ? { words: renewals.map((entry) => entry.words).join(' '),
    details: { testRunRiskRenewals: renewals, nextAction: { command: renewals[0].command },
      recoveryCommands: renewals.map((entry) => entry.command) } } : null;
}

/** The entries an active test-run risk decision carries at `at`, so synchronous checks can ask. */
async function testRunRiskCarried(workflow, entries, at = nowIso()) {
  const carried = new Set();
  for (const entry of entries ?? []) if (await testRunRiskCarries(workflow, entry, at)) carried.add(entry);
  return carried;
}

/** A validation that did not pass only because of runs an active test-run risk decision carries. */
async function validationCarriedByTestRunRisk(workflow, validation, at = nowIso()) {
  const open = (validation?.checks ?? []).filter((check) => check.status !== 'passed');
  return open.length > 0 && (await testRunRiskCarried(workflow, open, at)).size === open.length;
}

async function submitPhaseTransition(root, config, workflow, {
  phaseId, runChecks = true, persist = true, submissionContext = null,
  actor = null, agent = undefined, decisionValues = null
} = {}) {
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  let session = actor ? { actor, agent: agent ?? null } : await loadSession(root, { required: false });
  assertPhaseAgentMayMutate(config, workflow, workflow.phases?.[phaseId ?? workflow.currentPhase], session, 'submit');
  assertPhaseGovernanceMayAdvance(workflow, workflow.phases?.[phaseId ?? workflow.currentPhase]);
  const verifiedAmendment = await verifyAcceptedSkillAmendmentRevalidation(root, config, workflow);
  await verifyAcceptedTestCommandAmendment(root, config, workflow, verifiedAmendment);
  if (workflow.resolution?.presence) await (await import('./story-test-command-amendment.mjs')).assertSignedTestCommandAmendments(workflow);
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
  const { assertPhaseRepairSettled } = await import('./phase-repair-journal.mjs');
  await assertPhaseRepairSettled(root, workflow, phase);
  const { assertPhaseAppealsResolved } = await import('./phase-appeals.mjs');
  await assertPhaseAppealsResolved(root, config, workflow, phase);
  await assertRequiredStepActionsRecorded(root, config, workflow, `${phase.id} cannot be submitted`);
  const { assertStoryDocumentRiskGates } = await import('./trp-document-runtime.mjs');
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
  if (phase.storyTestCommands || workflow.testCommandDecisions) (await import('./story-test-commands.mjs')).assertStoryTestCommands(workflow);
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
    ? await (await import('./verification/repository-tests.mjs')).verificationRepositoryTests(root, config, workflow, phase, deliveryCommands)
    : null;
  if (repositoryTests?.commands.length) deliveryCommands = [...deliveryCommands, ...repositoryTests.commands];
  const pins = codeDeliveryRequired && !retainedRisk && runChecks
    ? await (await import('./test-command-pins.mjs')).gateTestCommandPins(root, config, workflow, phase, requiredTestCommands, phase.deliveryEvidence) : null;
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
    ? (await import('./verification/repository-tests.mjs')).settleRepositoryTestChecks(phase.checks, repositoryTests) : [];
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
          otherFailed.push((await import('./test-run-risk.mjs')).otherFailedTest(workflow, phase, command, recorded?.attempt, { at: nowIso() }));
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
      if (refusal) throw (await import('./test-run-risk.mjs')).withOtherFailedTests(refusal, otherFailed);
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
    const { assertTerminalReadiness } = await import('./evidence/terminal.mjs');
    await assertTerminalReadiness(root, config, workflow);
  }
  phase.submissionArchitectureDecision = null;
  phase.submittedAt = nowIso();
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
  if (!reviewableFailure && !applicationReviewPending && (phase.approvalPolicy.mode === 'none' || waiver?.eligible)) {
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
    phase.status = 'awaiting_approval';
    // People review this generation; a waiver recorded for an earlier one does not authorize it.
    clearApprovalDisposition(phase);
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

/** Ordinary submission deliberately has no route through the convergence confirmation context. */
export async function submitPhase(root, config, workflow, options = {}) {
  return submitPhaseTransition(root, config, workflow, options);
}

/**
 * One combined, explicit confirmation-and-transition operation for convergence. It never returns
 * or exports the private authority used by the transition, so another command cannot mint or
 * retain it and then feed it into generic submission.
 */
export async function submitConfirmedConvergencePhase(root, config, workflow, {
  confirmation, phaseId = null, runChecks = true, persist = true,
  actor = identity(root), agent = null
} = {}) {
  assertStoryNotArchived(root, workflow);
  if (workflow.workflowSnapshot) config = (await resolveStoryExecutionCatalog(root, config, workflow)).effectiveDefinition;
  const phase = phaseId == null ? convergencePhaseOf(workflow) : workflow.phases?.[phaseId] ?? null;
  if (!isConvergencePhase(phase)) throw convergenceAdvanceRequired(workflow, { phase: phase?.id ?? null });
  await assertConvergenceConfirmation(root, config, workflow, phase, confirmation);
  return submitPhaseTransition(root, config, workflow, {
    phaseId: phase.id,
    runChecks,
    persist,
    actor,
    agent,
    submissionContext: CONFIRMED_CONVERGENCE_SUBMISSION
  });
}

function nextPhase(workflow, phase) { const id = workflow.phaseOrder[workflow.phaseOrder.indexOf(phase.id) + 1]; return id ? workflow.phases[id] : null; }

async function writeDecision(root, config, workflow, phase, decision) {
  const safe = decision.at.replace(/[:.]/g, '-');
  await writeJson(path.join(decisionDir(root, config, workflow.workItem.id, phase.id), `${safe}-${decision.decision}.json`), decision);
  await writeJson(approvalPath(root, config, workflow.workItem.id, phase.id), {
    schemaVersion: phaseApprovalSummaryVersion(phase.approvals), phase: phase.id, decisions: phase.approvals
  });
}

/**
 * A Story branch whose history was rewritten (rebased onto a moved main, then force-pushed) no
 * longer holds the commits SFlow recorded as evidence. Approval then listed every rewritten commit
 * as made after submission, and another clone said the test receipt was missing; nothing named the
 * cause, and no route led out (2026-10-28). This names it, and the way back: put the branch on the
 * recorded history again (this clone's reflog still has it), and bring main in with a merge, which
 * keeps every recorded commit. SFlow never rewrites history itself.
 */
const historyCommitExists = (root, commit) => refHead(root, `${commit}^{commit}`) === commit;
const historyQuoted = (value) => (/^[A-Za-z0-9._/@:-]+$/u.test(value) ? value : `"${String(value).replaceAll('"', '\\"')}"`);

/** The newest tip of `branch` in this clone's reflog that still holds `commit`, or null. */
function recordedHistoryTip(root, branch, commit) {
  for (const ref of [`refs/heads/${branch}`, 'HEAD']) {
    const listed = run('git', ['reflog', 'show', '--format=%H', ref], { cwd: root, allowFailure: true });
    if (listed.status !== 0) continue;
    const tip = listed.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      .find((candidate) => commitIsAncestor(root, commit, candidate));
    if (tip) return tip;
  }
  return null;
}

/** The commits a step's record names: its published generation and its submission. */
function recordedStepCommits(phase) {
  return [
    { commit: phase?.generationCommit, label: `${phase?.id}'s published generation` },
    { commit: phase?.submissionCommit, label: `${phase?.id}'s submission` },
    { commit: phase?.publicationCommit, label: `${phase?.id}'s publication` }
  ];
}

/**
 * Which missing recorded commits the rewritten history still carries as the same change (`git
 * patch-id --stable`, over HEAD's newest 400 commits), and whether the Story's records are the same
 * bytes there. A diagnosis only: SFlow's records name exact commit IDs in about a thousand places
 * (receipts, claim maps, approvals, attempts), so it never re-anchors them onto rebased commits; the
 * person restores the recorded history or keeps the rebase knowing exactly what it changed.
 */
function rewrittenHistoryMapping(root, commits, itemPath) {
  const patchIds = (args) => {
    const patches = run('git', ['log', '-p', '--no-merges', '--format=commit %H', ...args], { cwd: root, allowFailure: true });
    if (patches.status !== 0 || !patches.stdout.trim()) return [];
    const listed = run('git', ['patch-id', '--stable'], { cwd: root, allowFailure: true, input: patches.stdout });
    return listed.status !== 0 ? [] : listed.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)).filter((pair) => pair.length === 2);
  };
  const recorded = new Map(patchIds(['--no-walk', ...commits]).map(([id, commit]) => [commit, id]));
  const current = new Map();
  for (const [id, commit] of patchIds(['--max-count=400', 'HEAD'])) if (!current.has(id)) current.set(id, commit);
  const tree = (commit) => itemPath ? refHead(root, `${commit}:${itemPath}`) : null;
  return commits.map((commit) => {
    const rebased = recorded.has(commit) ? current.get(recorded.get(commit)) ?? null : null;
    return { recorded: commit, rebased, recordsSame: rebased && itemPath ? tree(commit) === tree(rebased) : null };
  });
}

function mappingSentence(branch, mapping) {
  const short = (commit) => commit.slice(0, 8);
  const same = mapping.filter((entry) => entry.rebased);
  const unmatched = mapping.filter((entry) => !entry.rebased);
  const differs = same.filter((entry) => entry.recordsSame === false);
  return `${branch} now carries the same change for ${same.length} of ${mapping.length} recorded commit(s)`
    + (same.length ? ` (${same.map((entry) => `${short(entry.recorded)} as ${short(entry.rebased)}`).join(', ')})` : '')
    + (unmatched.length ? `; ${unmatched.map((entry) => short(entry.recorded)).join(', ')} ${unmatched.length === 1 ? 'has' : 'have'} no matching change` : '')
    + (differs.length ? `; the Story's records differ at ${differs.map((entry) => short(entry.rebased)).join(', ')}` : '')
    + '. SFlow still reads only the recorded commit IDs, so restore that history either way. ';
}

/**
 * Refuse with STORY_HISTORY_REWRITTEN when a recorded commit is no longer an ancestor of HEAD.
 * `recorded` lists `{ commit, label }`; the first one missing is named, and every missing one is
 * matched against the rewritten history (rewrittenHistoryMapping).
 */
function assertRecordedHistory(root, workflow, recorded, { branch = workflow.workItem.branch ?? workflow.workItem.id,
  remote = 'origin', base = workflow.workItem.baseBranch ?? 'main', itemPath = null } = {}) {
  // One Git process per distinct commit: a step's generation, submission and publication are often one.
  const distinct = [...new Map(recorded.filter((entry) => /^[0-9a-f]{40,64}$/u.test(String(entry?.commit ?? '')))
    .map((entry) => [entry.commit, entry])).values()];
  const absent = distinct.filter((entry) => !commitIsAncestor(root, entry.commit, 'HEAD'));
  const missing = absent[0];
  if (!missing) return;
  const short = missing.commit.slice(0, 8);
  const here = historyCommitExists(root, missing.commit);
  const mapping = here ? rewrittenHistoryMapping(root, absent.map((entry) => entry.commit).filter((commit) => historyCommitExists(root, commit)), itemPath) : [];
  const tip = here ? recordedHistoryTip(root, branch, missing.commit) : null;
  const merge = `git merge ${historyQuoted(`${remote}/${base}`)}`;
  const commands = tip ? [
    `git reset --keep ${tip}`,
    `git push --force-with-lease ${historyQuoted(remote)} ${historyQuoted(branch)}`,
    merge
  ] : [];
  throw new SingularityFlowError(
    `The history of ${branch} was rewritten (a rebase or force-push): ${missing.label} commit ${short}, which SFlow recorded, is no longer on it, so every rewritten commit reads as new. Nothing was recorded. `
    + (mapping.length ? mappingSentence(branch, mapping) : '')
    + (tip
      ? `Put the branch back on the recorded history with git reset --keep ${tip.slice(0, 12)} (the last ${branch} tip in this clone that still has ${short}); if the rewritten history was pushed, put the remote back with git push --force-with-lease ${remote} ${branch}. Once no step is waiting for approval, bring ${base} in with ${merge}, which keeps every recorded commit, instead of a rebase.`
      : here
        ? `This clone still has commit ${short}, but no ${branch} tip in its reflog holds it: restore the branch from a clone or backup that has that history, then bring ${base} in with a merge instead of a rebase.`
        : `This clone does not have commit ${short}: restore ${branch} from a clone whose reflog still has it, then bring ${base} in with a merge instead of a rebase.`),
    {
      code: 'STORY_HISTORY_REWRITTEN',
      details: {
        branch, commit: missing.commit, label: missing.label, recordedTip: tip, availableHere: here, recoveryCommands: commands, mapping,
        // Plain Git is the person's to run, so each step is an instruction every surface shows.
        actions: tip ? [
          { label: `Put ${branch} back on the history SFlow recorded: git reset --keep ${tip}` },
          { label: `If the rewritten history was pushed, put the remote back: git push --force-with-lease ${remote} ${branch}` },
          { label: `Once no step is waiting for approval, bring ${base} in with ${merge}: a merge keeps every recorded commit; never rebase a Story branch.` }
        ] : [{ label: `Restore ${branch} from a clone or backup that still has commit ${missing.commit}, then bring ${base} in with a merge, never a rebase.` }]
      }
    }
  );
}

/**
 * The commits after a submitted phase's review evidence, and which of them may precede its approval.
 *
 * A receipt intentionally binds HEAD when review begins, so receipt freshness alone cannot tell
 * whether an unrelated commit was inserted *before* that point. Permit prior partial approvals,
 * verified test-risk reviews, recorded decisions (REVIEW_EFFECTS), the proposal and rejection of
 * a rejected intent amendment (`rejectedIntentAmendments` in approval-check.mjs; approval records
 * them), an undecided proposal (`pendingIntentAmendmentProposals`; approval waits for its
 * decision), an acknowledgement, and the exact Auto human-boundary checkpoint for this submitted
 * phase. Auto records that checkpoint immediately after submission so a human can resume the
 * flight after approval; it is observational evidence, not a new generation. Approval refuses on
 * every other commit (`blocking`); the approval packet and phase show name the same commits
 * beforehand, so all three read this one classification. `reviewedRisks` is read only when a
 * commit is not already a prior approval.
 */
export async function reviewHistoryCommits(root, config, workflow, phase, submittedReview, { reviewedRisks = async () => [] } = {}) {
  // Approval checked first that the step's recorded commits are still on the branch (a rebase or
  // force-push read here as every rewritten commit made after submission, 2026-10-28).
  const reviewRange = `${submittedReview.evidenceCommit}..${head(root)}`;
  const interveningCommits = storyHistoryCommits(root, [
    'rev-list', '--first-parent', reviewRange
  ], `Phase '${phase.id}' history since its review evidence`);
  const approvalSummary = posix(path.relative(
    root, approvalPath(root, config, workflow.workItem.id, phase.id)
  ));
  const priorApprovalCommits = storyHistoryCommits(root, [
    'log', '--first-parent', '--format=%H', reviewRange, '--', approvalSummary
  ], `Phase '${phase.id}' prior approvals`);
  const allowedReviewCommits = new Set(priorApprovalCommits);
  const unallowed = () => interveningCommits.filter((commit) => !allowedReviewCommits.has(commit));
  if (unallowed().length) {
    for (const reviewedRisk of (await reviewedRisks()).filter(Boolean)) {
      for (const commit of await verifiedStoryTestRiskReviewCommits(root, config, workflow, reviewedRisk, unallowed())) allowedReviewCommits.add(commit);
    }
  }
  if (workflow.auto && unallowed().length) {
    const { readGovernedAutoCheckpoint } = await import('./auto/auto-checkpoint.mjs');
    for (const projection of workflow.publicationProjections ?? []) {
      const event = projection.event;
      if (event?.type !== 'evidence-recorded'
          || event.payload?.kind !== 'auto-boundary-checkpoint'
          || event.payload?.checkpointClass !== 'human-boundary'
          || event.phaseId !== phase.id) continue;
      const checkpoint = await readGovernedAutoCheckpoint(root, workflow, projection);
      const commit = checkpoint.commit;
      if (!interveningCommits.includes(commit)
          || checkpoint.record.story.workId !== workflow.workItem.id
          || checkpoint.record.story.phase !== phase.id
          || checkpoint.record.story.generation !== phase.generation
          || checkpoint.record.position !== 'submitted') continue;
      const identity = governedCommitIdentity(root, commit);
      if (identity?.parents.length !== 1
          || identity.parents[0] !== submittedReview.evidenceCommit
          || identity.parents[0] !== checkpoint.record.story.sourceRevision
          || (event.sourceCommit && event.sourceCommit !== identity.parents[0])
          || identity.eventSha256 !== `sha256:${recordSha256(event)}`) continue;
      allowedReviewCommits.add(commit);
    }
  }
  if (unallowed().length) {
    const { workflowTaskDeltaSafe } = await import('./workflow-task.mjs');
    for (const commit of unallowed()) {
      if (applicabilityDecisionCommit(root, config, workflow, commit, workflowTaskDeltaSafe)) allowedReviewCommits.add(commit);
    }
  }
  if (workflow.applicationReviews?.length && unallowed().length) {
    const { applicationReviewCommit } = await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'application-review-history.mjs')).href);
    for (const commit of unallowed()) {
      if (applicationReviewCommit(root, governedStateChange(root, config, workflow, commit))) allowedReviewCommits.add(commit);
    }
  }
  // Intent-amendment records (approval-check.mjs): a rejected amendment's proposal and rejection as
  // one pair, an undecided proposal (approval waits for its decision) and an acknowledgement.
  const amendments = unallowed().length ? await import('./approval-check.mjs') : null;
  const rejectedAmendments = amendments ? await amendments.rejectedIntentAmendments(root, config, workflow, unallowed(), {
    evidenceCommit: submittedReview.evidenceCommit, interveningCommits }) : [];
  for (const { proposalCommit, rejectionCommit } of rejectedAmendments) {
    allowedReviewCommits.add(rejectionCommit);
    if (interveningCommits.includes(proposalCommit)) allowedReviewCommits.add(proposalCommit);
  }
  // A rejected skill-version proposal and its rejection, as one pair; an undecided or approved one still stales.
  const rejectedSkillVersions = amendments && unallowed().length ? await amendments.rejectedSkillVersionAmendments(root, config, workflow, unallowed(), {
    evidenceCommit: submittedReview.evidenceCommit, interveningCommits }) : [];
  for (const { proposalCommit, rejectionCommit } of rejectedSkillVersions) {
    allowedReviewCommits.add(rejectionCommit);
    if (interveningCommits.includes(proposalCommit)) allowedReviewCommits.add(proposalCommit);
  }
  // Documents offered only to other steps, and a child-branch link: each its exact record change.
  if (amendments && unallowed().length) {
    for (const commit of await amendments.reviewSafeDocumentAdditions(root, config, workflow, phase, unallowed())) allowedReviewCommits.add(commit);
  }
  if (amendments && unallowed().length) {
    for (const commit of await amendments.reviewSafeBranchLinks(root, config, workflow, unallowed())) allowedReviewCommits.add(commit);
  }
  // An approver refresh only adds members to the Story's groups: its exact record change.
  if (amendments && unallowed().length) {
    for (const commit of await amendments.reviewSafeApproverRefreshes(root, config, workflow, unallowed())) allowedReviewCommits.add(commit);
  }
  const pendingProposals = amendments && unallowed().length
    ? await amendments.pendingIntentAmendmentProposals(root, config, workflow, unallowed()) : [];
  for (const { proposalCommit } of pendingProposals) allowedReviewCommits.add(proposalCommit);
  const acknowledgements = amendments && unallowed().length
    ? await amendments.intentAmendmentAcknowledgements(root, config, workflow, unallowed()) : [];
  for (const { acknowledgementCommit } of acknowledgements) allowedReviewCommits.add(acknowledgementCommit);
  return {
    interveningCommits, priorApprovalCommits, allowedReviewCommits: [...allowedReviewCommits], blocking: unallowed(),
    rejectedIntentAmendments: rejectedAmendments, pendingIntentAmendmentProposals: pendingProposals
  };
}

/** Thrown inside evaluateApproval to end a preview whose foundation failed; it never escapes. */
const APPROVAL_PREVIEW_STOP = Symbol('approval-preview-stop');

/**
 * Every check approval makes, in the order it makes them, as stages over shared facts [SPEC-OAP M1].
 *
 * Recording (`preview: false`, what approvePhase does) throws the first refusal unchanged, so the
 * gate refuses exactly as it did. Previewing (the approval packet's readiness, phase show, and every
 * surface that offers Approve) runs every stage, keeps each refusal as a hold, and skips only a stage
 * whose inputs a failed stage did not establish; it never writes, publishes or prints. The gate and
 * the preview cannot disagree because they are the same code. Returns the holds (the refusals, in
 * gate order), the warnings, and the facts recording needs.
 */
export async function evaluateApproval(root, config, workflow, {
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
} = {}) {
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
      const { assertPhaseRepairSettled } = await import('./phase-repair-journal.mjs');
      await assertPhaseRepairSettled(root, workflow, phase);
    });
    await stage('appeals', async () => {
      const { assertPhaseAppealsResolved } = await import('./phase-appeals.mjs');
      await assertPhaseAppealsResolved(root, config, workflow, phase);
    });
    await stage('document-risks', async () => {
      const { assertStoryDocumentRiskGates } = await import('./trp-document-runtime.mjs');
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
      const { readStoryReviewPacket } = await import('./story-lineage.mjs');
      ({ reviewArtifactSetSha256 } = await import('./story-lineage.mjs'));
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
        throw (await import('./approval-check.mjs')).pendingAmendmentRefusal(workflow, phase, reviewHistory.pendingIntentAmendmentProposals);
      }
    }, { needs: ['history'] });
    await stage('history-commits', async () => {
      if (reviewHistory.blocking.length) {
        // Name each commit and route an undecided intent amendment among them to its decision first.
        const { interveningCommitRefusal } = await import('./approval-check.mjs');
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
            satisfied: verdictGaps.length ? await (await import('./evidence/clause-outlook.mjs')).clausesReadSatisfied(root, config, workflow) : [] });
        if (refusal) {
          // One plain sentence and the decision list first; each clause's own routes stay in details.
          const { decisionRefusalLead, phaseEndsStory } = await import('./decision-list-facts.mjs');
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
    const cardLines = submittedReview?.attribution ? (await import('./presence/attribution.mjs')).attributionCardLines(submittedReview.attribution) : [];
    await (await import('./presence/person-records.mjs')).attachPersonPresence(presence, decision, { cardLines });
  }
  return { holds, warnings, ready: !holds.length, config, phase, session, key, decision, reached, approvalOutcome,
    rejectedIntentAmendments: rejectedAmendments };
}

/** The approval-counting predicate SF Guard gives a Story, or null when it does not apply. */
async function presenceCountsFor(root, workflow) {
  return workflow.resolution?.presence ? (await import('./presence/person-records.mjs')).presenceCountsFor(root, workflow) : null;
}

/**
 * Record one approval decision: the checks of evaluateApproval (its first refusal is the refusal),
 * then the transition.
 */
export async function approvePhase(root, config, workflow, options = {}) {
  const { persist = true } = options;
  const checked = await evaluateApproval(root, config, workflow, { ...options, preview: false });
  const { phase, session, key, decision, reached, approvalOutcome } = checked;
  config = checked.config;
  phase.approvals.push(decision);
  // A person decides this phase now, so an automatic completion recorded before (by a build that
  // kept it across a reopen) no longer describes it.
  clearApprovalDisposition(phase);
  let approvalPending = null;
  let retention = null;
  if (reached) {
    phase.status = 'approved'; phase.approvedAt = decision.at; phase.approvedBy = key;
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

async function registerApprovedSnapshot(root, config, workflow, phase) {
  const required = requiredRepoPath(config, workflow, phase); const current = await repositoryArtifactSnapshot(root, required); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, status: phase.status === 'approved' ? 'approved' : 'pending', approvedAt: phase.approvedAt, approvedBy: phase.approvedBy });
}

async function refreshPhaseSpecificationIndex(root, config, workflow, phase) {
  const specPolicy = workflow.resolution?.spec ?? config.spec ?? { mode: 'off' };
  // Only definition-bearing artifacts may enlarge the Story's authoritative clause universe.
  // Conformance/release reports cite that universe; indexing their citations as new clauses made
  // a terminal report invent requirements that no planning phase could possibly have covered.
  if (specPolicy.mode === 'off' || !phaseDefinesSpecificationClaims(workflow, phase)) return null;
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const priorSpecRecords = await loadActiveSpecRecords(itemDirectory, workflow);
  const specIndexPath = posix(path.join(
    workDirRelative(config, workflow.workItem.id), 'context', 'spec-indexes',
    `${phase.id}-gen${phase.generation}.json`
  ));
  const specIndex = await buildSpecIndex(root, requiredRepoPath(config, workflow, phase), {
    workId: workflow.workItem.id,
    phase: phase.id,
    generation: phase.generation,
    outputPath: specIndexPath,
    policy: specPolicy,
    externalClauses: predecessorSpecClauses(priorSpecRecords, workflow, phase.id)
  });
  phase.specIndex = {
    generation: phase.generation,
    path: specIndexPath,
    clauses: specIndex.clauses.length,
    indexSha256: specIndex.indexSha256,
    sourceSha256: specIndex.source.sha256
  };
  if (plannedClaimsEnforced(workflow, normalizeSpecPolicy(specPolicy)) && !specIndex.clauses.length) {
    throw new SingularityFlowError(
      `Phase ${phase.id} requires stable clause anchors such as [${specPolicy.namespace ?? 'APP'}:REQ-001].`
    );
  }
  return specIndex;
}

async function refreshRequiredArtifact(root, config, workflow, phase, { registerIfMissing = true } = {}) {
  const required = requiredRepoPath(config, workflow, phase); const current = await repositoryArtifactSnapshot(root, required); const existing = artifactFor(phase, required);
  if (existing) Object.assign(existing, { ...current, updatedAt: nowIso() });
  else if (registerIfMissing) phase.artifacts.push({ path: required, kind: phase.requiredArtifact.kind ?? inferKind(required), status: 'pending', ...current, registeredAt: nowIso(), updatedAt: nowIso() });
}

function reworkCheckpointIntegrity(checkpoint) {
  const { integrity: _integrity, ...core } = checkpoint;
  return `sha256:${createHash('sha256').update(canonicalJson(core)).digest('hex')}`;
}

/**
 * Capture the lifecycle state that an authorized return invalidates.
 *
 * The checkpoint is embedded in the change request and therefore lands in the same governed
 * commit as the rejection/reopen. It deliberately records only the mutable forward cone rather
 * than nesting the whole workflow: repeated rework must grow linearly, not recursively.
 */
async function scopedWorktreeTree(root, config, workflow, baseCommit) {
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit,
    subject: { kind: 'story-rework-baseline', id: workflow.workItem.id }
  });
  const entries = (changeSet.entries ?? []).filter((entry) => {
    const endpoints = [entry.oldPath, entry.newPath].filter(Boolean);
    return endpoints.some((candidate) => reworkScopePath(config, workflow, candidate, {
      untracked: entry.untracked === true && candidate === entry.newPath
    }));
  });
  const paths = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))].sort();
  const baseTree = run('git', ['rev-parse', `${baseCommit}^{tree}`], { cwd: root }).stdout.trim();
  if (!paths.length) return { tree: baseTree, paths };

  const temporaryRoot = path.join(gitCommonDir(root), 'singularity-flow', 'temporary-indexes');
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, 'rework-snapshot-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    run('git', ['read-tree', baseCommit], { cwd: root, env });
    run('git', ['add', '-A', '--', ...paths], { cwd: root, env });
    return { tree: run('git', ['write-tree'], { cwd: root, env }).stdout.trim(), paths };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function currentReworkTreeChangeSet(root, config, workflow, baselineTree, currentHead) {
  const current = await buildRepositoryChangeSet(root, {
    baseCommit: currentHead,
    subject: { kind: 'story-rework-current', id: workflow.workItem.id }
  });
  const paths = [...new Set((current.entries ?? [])
    .filter((entry) => [entry.oldPath, entry.newPath].filter(Boolean).some((candidate) =>
      reworkScopePath(config, workflow, candidate, {
        untracked: entry.untracked === true && candidate === entry.newPath
      })))
    .flatMap((entry) => [entry.oldPath, entry.newPath])
    .filter(Boolean))].sort();

  if (!paths.length) {
    const currentTree = run('git', ['rev-parse', `${currentHead}^{tree}`], { cwd: root }).stdout.trim();
    return {
      currentTree,
      changeSet: buildRepositoryTreeChangeSet(root, {
        baseTree: baselineTree,
        targetTree: currentTree,
        subject: { kind: 'story-rework-roll-forward', id: workflow.workItem.id }
      })
    };
  }

  const temporaryRoot = path.join(gitCommonDir(root), 'singularity-flow', 'temporary-indexes');
  await mkdir(temporaryRoot, { recursive: true });
  const scratch = await mkdtemp(path.join(temporaryRoot, 'rework-preview-'));
  const objectDirectory = path.join(scratch, 'objects');
  await mkdir(objectDirectory, { recursive: true });
  const env = {
    ...process.env,
    GIT_INDEX_FILE: path.join(scratch, 'index'),
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [
      path.join(gitCommonDir(root), 'objects'),
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES
    ].filter(Boolean).join(path.delimiter)
  };
  try {
    run('git', ['read-tree', currentHead], { cwd: root, env });
    if (paths.length) run('git', ['add', '-A', '--', ...paths], { cwd: root, env });
    const currentTree = run('git', ['write-tree'], { cwd: root, env }).stdout.trim();
    return {
      currentTree,
      changeSet: buildRepositoryTreeChangeSet(root, {
        baseTree: baselineTree,
        targetTree: currentTree,
        subject: { kind: 'story-rework-roll-forward', id: workflow.workItem.id },
        env
      })
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function reworkBaselineRef(workflow, changeRequestId) {
  const key = createHash('sha256')
    .update(`${workflow.workItem.id}\0${changeRequestId}`)
    .digest('hex');
  return `${publicationReworkRefNamespace({ kind: 'story', id: workflow.workItem.id })}${key}`;
}

const REWORK_BASELINE_REF_PATTERN = /^refs\/singularity-flow\/rework-baselines\/[a-f0-9]{64}\/[a-f0-9]{64}$/u;

// A checkpoint ref is an owned, immutable direct ref. rev-parse dereferences symbolic aliases,
// which could make a foreign branch appear to retain the correct tree or receive an update.
function exactReworkBaselineRef(root, ref) {
  if (!REWORK_BASELINE_REF_PATTERN.test(ref)) {
    throw new SingularityFlowError('Rework checkpoint has an invalid local baseline ref.', {
      code: 'REWORK_FORWARD_BASELINE_REF_INVALID'
    });
  }
  const observed = run('git', [
    'for-each-ref', '--format=%(refname)%00%(symref)%00%(objectname)', ref
  ], { cwd: root, allowFailure: true });
  if (observed.status !== 0) {
    throw new SingularityFlowError('Rework checkpoint local baseline ref could not be inspected.', {
      code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE'
    });
  }
  const lines = String(observed.stdout ?? '').split('\n').filter(Boolean);
  if (lines.length === 0) return { kind: 'absent', object: null };
  if (lines.length !== 1) {
    throw new SingularityFlowError('Rework checkpoint local baseline ref observation is ambiguous.', {
      code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE'
    });
  }
  const match = lines[0].match(/^([^\0\r\n]+)\0([^\0\r\n]*)\0([a-f0-9]{40}|[a-f0-9]{64})$/u);
  if (!match || match[1] !== ref) {
    throw new SingularityFlowError('Rework checkpoint local baseline ref observation is invalid.', {
      code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE'
    });
  }
  return match[2] ? { kind: 'symbolic', object: null } : { kind: 'direct', object: match[3] };
}

function retainReworkBaselineRef(root, ref, tree) {
  const conflict = () => new SingularityFlowError(
    'Rework checkpoint baseline ref is symbolic or belongs to another object. No unrelated ref was changed.',
    { code: 'REWORK_FORWARD_BASELINE_REF_CONFLICT' }
  );
  const current = exactReworkBaselineRef(root, ref);
  if (current.kind === 'direct' && current.object === tree) return;
  if (current.kind !== 'absent') throw conflict();
  const write = run('git', ['update-ref', '--no-deref', ref, tree, '0'.repeat(tree.length)], {
    cwd: root, allowFailure: true
  });
  const retained = exactReworkBaselineRef(root, ref);
  // Reconcile a lost Git acknowledgement only against the same direct object; the zero-value
  // lease and --no-deref protect both concurrent creation and a symbolic-ref substitution.
  if (retained.kind === 'direct' && retained.object === tree) return;
  if (write.status !== 0 || retained.kind !== 'direct') throw conflict();
  throw conflict();
}

async function createReworkForwardCheckpoint(root, config, workflow, {
  changeRequestId,
  sourcePhase,
  targetPhase,
  targetIndex,
  createdAt
}) {
  const affectedPhaseIds = workflow.phaseOrder.slice(targetIndex);
  const sourceCommit = head(root);
  const baseline = await scopedWorktreeTree(root, config, workflow, sourceCommit);
  const baselineRef = baseline.paths.length ? reworkBaselineRef(workflow, changeRequestId) : null;
  if (baselineRef) retainReworkBaselineRef(root, baselineRef, baseline.tree);
  const checkpoint = {
    schemaVersion: currentSchemaVersion('rework-forward-checkpoint'),
    id: `RFW-${changeRequestId}`,
    changeRequestId,
    sourceCommit,
    sourcePhase,
    targetPhase,
    createdAt,
    worktreeBaseline: {
      kind: 'git-tree',
      tree: baseline.tree,
      ref: baselineRef,
      dirtyPaths: baseline.paths
    },
    state: {
      status: workflow.status,
      currentPhase: workflow.currentPhase,
      affectedPhaseIds,
      phases: Object.fromEntries(affectedPhaseIds.map((phaseId) => [phaseId, structuredClone(workflow.phases[phaseId])])),
      workIntervals: structuredClone(workflow.workIntervals ?? null),
      repairBudgets: structuredClone(workflow.repairBudgets ?? null),
      lineage: structuredClone(workflow.lineage ?? null),
      measurement: structuredClone(workflow.measurement ?? null),
      spec: structuredClone(workflow.spec ?? null),
      // A reopen clears the final evaluation; abandoning it restores the one the Story passed.
      completion: structuredClone(workflow.completion ?? null)
    }
  };
  return { ...checkpoint, integrity: { sha256: reworkCheckpointIntegrity(checkpoint) } };
}

/**
 * A Testing source/test edit is not a Testing publication. Preview the exact bytes that must be
 * returned to Code, without treating the old passing receipt as proof of the edited tree.
 */
export async function previewTestingRepair(root, config, workflow) {
  await assertNoPendingPublication(root, config, workflow, 'return Testing changes to Code');
  const review = workflow.phases?.[workflow.currentPhase];
  const code = reviewRepairTarget(workflow, review);
  if (!code) {
    throw new SingularityFlowError(
      'A pre-submission review repair requires an active non-code review with an allowed return to its earlier approved Code phase.',
      { code: 'TESTING_REPAIR_NOT_APPLICABLE' }
    );
  }
  const evidence = code?.deliveryEvidence;
  const approval = [...(code?.approvals ?? [])].reverse().find((decision) =>
    decision.decision === 'approved' && !decision.invalidatedAt
      && Number(decision.generation) === Number(code.generation));
  const submission = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === code.id && Number(entry.generation) === Number(code?.generation));
  const approvalNotRequired = code.approvalPolicy?.mode === 'none' && code.approvalDisposition === 'not_required';
  const approvalWaived = code.approvalPolicy?.mode === 'policy' && code.approvalDisposition === 'policy_waived'
    && (await (await import('./approval-waiver.mjs')).verifyPhaseApprovalWaiver(root, config, workflow, code)).valid;
  const riskReference = evidence?.testRecovery;
  const retainedRiskOutcome = riskReference && ['unavailable', 'failed'].includes(evidence.validation?.status)
    && evidence.validation.status === riskReference.observedOutcome;
  // A run a step approver accepted could not execute any test counts as it stood when it was validated.
  const runRiskAt = evidence?.validation?.validatedAt ?? nowIso();
  const runRiskOutcome = await validationCarriedByTestRunRisk(workflow, evidence?.validation, runRiskAt);
  if (code?.status !== 'approved' || (!approval && !approvalNotRequired && !approvalWaived) || !submission || !evidence
      || evidence.status !== 'ready' || (evidence.validation?.status !== 'passed' && !retainedRiskOutcome && !runRiskOutcome)
      || !code.generationCommit || !evidence.receiptPath || !evidence.receiptSha256) {
    throw new SingularityFlowError(
      'Review repair needs an approved Code generation with committed passing or historically authorized risk evidence.',
      { code: 'TESTING_REPAIR_CODE_EVIDENCE_REQUIRED' }
    );
  }
  const { readStoryReviewPacket } = await import('./story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, submission.packetSha256);
  const receiptBinding = packet.submissionEvidence?.codeDelivery;
  if ((!approvalNotRequired && !approvalWaived && (approval.reviewPacketSha256 !== packet.packetSha256
      || approval.evidenceCommit !== packet.evidenceCommit))
      || (approvalNotRequired && packet.status !== 'complete_no_review')
      || receiptBinding?.path !== evidence.receiptPath
      || String(receiptBinding?.sha256 ?? '').replace(/^sha256:/u, '')
        !== String(evidence.receiptSha256).replace(/^sha256:/u, '')) {
    throw new SingularityFlowError(
      'The approved Code packet does not bind its recorded test receipt.',
      { code: 'TESTING_REPAIR_CODE_EVIDENCE_REQUIRED' }
    );
  }
  const historical = run('git', ['show', `${packet.evidenceCommit}:${evidence.receiptPath}`], {
    cwd: root, allowFailure: true
  });
  let receipt;
  try {
    if (historical.status !== 0) throw new Error('receipt not committed');
    const stored = JSON.parse(historical.stdout);
    if (createHash('sha256').update(canonicalJson(stored)).digest('hex')
        !== String(evidence.receiptSha256).replace(/^sha256:/u, '')) {
      throw new Error('receipt digest differs');
    }
    receipt = readRecord('code-delivery', stored).record;
    const carriedRuns = await testRunRiskCarried(workflow, receipt.testExecutions, runRiskAt);
    if (receipt.status !== 'ready' || receipt.workId !== workflow.workItem.id
        || receipt.phase !== code.id
        || (riskReference && canonicalJson(receipt.testRecovery) !== canonicalJson(riskReference))
        || Number(receipt.generation) !== Number(code.generation)
        || receipt.tree?.generationCommit !== code.generationCommit
        || !Array.isArray(receipt.testExecutions) || !receipt.testExecutions.length
        || receipt.testExecutions.some((execution) => execution.status !== 'passed' && !carriedRuns.has(execution)
          && !(retainedRiskOutcome && execution.kind === 'phase-validation-observation'
            && execution.status === riskReference.observedOutcome))) {
      throw new Error('receipt does not describe the approved Code generation and passing or historically authorized risk evidence');
    }
  } catch (error) {
    throw new SingularityFlowError(
      `The approved Code test receipt cannot be verified: ${error.message}.`,
      { code: 'TESTING_REPAIR_CODE_EVIDENCE_REQUIRED' }
    );
  }
  if (riskReference) await assertStoryTestRiskGate(root, config, workflow, {
    phaseId: code.id, generation: code.generation, operation: 'submit', mode: 'historical',
    at: receipt.validatedAt, observationSha256: riskReference.observationSha256,
    evidenceCommit: packet.evidenceCommit
  });
  const changeSet = await buildRepositoryChangeSet(root, {
    baseCommit: code.generationCommit,
    subject: { kind: 'testing-repair', id: workflow.workItem.id,
      phase: review.id, testingGeneration: review.generation }
  });
  const protectedPaths = [...new Set([
    ...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ])];
  const protectedResult = evaluateProtectedPaths(changeSet, protectedPaths);
  if (!protectedResult.valid) {
    throw new SingularityFlowError(
      `Testing repair cannot carry protected process paths: ${[...new Set(protectedResult.violations.map((entry) => entry.path))].join(', ')}. Repair these through approved configuration authority.`,
      { code: 'TESTING_REPAIR_PROTECTED_PATH' }
    );
  }
  const application = applicationChangeSetProjection(changeSet, applicationPathContext(config, workflow));
  const changedPaths = [...new Set(application.entries.flatMap((entry) =>
    [entry.oldPath, entry.newPath].filter(Boolean)))].sort();
  if (!changedPaths.length) {
    throw new SingularityFlowError(
      'Testing has no application source or test changes to return to Code. Correct environment-only observations in a new Testing review generation.',
      { code: 'TESTING_REPAIR_NO_APPLICATION_CHANGES' }
    );
  }
  const plan = {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    workType: workflow.workItem.workType,
    branch: branch(root),
    head: head(root),
    phase: review.id,
    phaseStatus: review.status,
    testingGeneration: review.generation,
    targetPhase: code.id,
    codeGeneration: code.generation,
    codeGenerationCommit: code.generationCommit,
    codeEvidenceCommit: packet.evidenceCommit,
    codeReceiptSha256: evidence.receiptSha256,
    sourceTreeSha256: await sourceTreeHash(root, config, workflow),
    changeSetDigest: application.digest,
    changedPaths
  };
  return {
    ...plan,
    confirmation: `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`
  };
}

/**
 * The values a phase records for the decision after it, taken at submission so the reviewer
 * approves exactly the facts the decision will read. A submitted phase cannot change them; a
 * phase that is reopened records them again, because `resetPhaseForRework` clears them.
 */
function recordSubmittedDecisionInputs(workflow, phase, supplied, actor) {
  const decision = decisionFedBy(workflow, phase.id);
  const given = supplied && Object.keys(supplied).length ? supplied : null;
  if (!decision) {
    if (given) {
      throw new SingularityFlowError(`Phase '${phase.id}' feeds no decision that records values; submit it without --decision.`,
        { code: 'DECISION_INPUT_UNKNOWN' });
    }
    return null;
  }
  if (!given) {
    if (recordedDecisionValues(phase, decision)) return phase.decisionInputs;
    throw new SingularityFlowError(
      `Decision '${decision.label}' after '${phase.id}' reads values this submission must record. Submit with ${decisionInputsHint(decision)}.`,
      { code: 'DECISION_INPUTS_MISSING', details: { decision: decision.id, inputs: decision.inputs } }
    );
  }
  phase.decisionInputs = {
    schemaVersion: 1,
    decision: decision.id,
    values: normalizeDecisionInputValues(decision, given),
    recordedAt: nowIso(),
    recordedBy: actorKey(actor)
  };
  return phase.decisionInputs;
}

/** The phase a completion will start: the decision's target, or the linear successor. */
function upcomingAfterOutcome(workflow, phase, outcome) {
  if (!outcome || outcome.kind === 'next') return nextPhaseAfterSkillAmendment(workflow, phase);
  return outcome.kind === 'forward' ? workflow.phases[outcome.target] ?? null : null;
}

function resolvePhaseChangeRequests(workflow, phase, { at, actor, completionDisposition = null }) {
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

/** What rework retained after a completion, or which phase runs again and why [E2G-021]. */
function retentionDetail(retention) {
  const parts = [];
  if (retention?.retained?.length) parts.push(`; retained ${retention.retained.map((entry) => entry.phase).join(', ')} by rule E1`);
  if (retention?.stale) parts.push(`; ${retention.stale.phase} runs again because ${retention.stale.changed.join(', ')} changed`);
  return parts.join('');
}

/**
 * Render the approved state of the phases rework just retained, exactly as an approval does:
 * managed metadata, the approved artifact snapshot, and the specification index over those bytes.
 */
async function settleRetainedPhases(root, config, workflow, at) {
  const settled = [];
  for (const id of workflow.phaseOrder ?? []) {
    const retained = workflow.phases[id];
    if (retained?.status !== 'approved' || retained.retention?.at !== at) continue;
    await updateArtifactMetadata(root, config, workflow, retained);
    await registerApprovedSnapshot(root, config, workflow, retained);
    // Rule E9: the producers are approved and registered now, so bind the generations and exact
    // bytes this phase is carried to; its own input checks accept those and nothing else.
    if (retained.retention.rule === 'E9') {
      const { authoredRetentionBindings } = await import('./inputs.mjs');
      retained.retention.inputBindings = await authoredRetentionBindings(root, workflow, retained, retained.retention.authoredProducers ?? [], {
        itemDirectory: workDir(root, config, workflow.workItem.id), itemRelative: workDirRelative(config, workflow.workItem.id)
      });
    }
    await refreshPhaseSpecificationIndex(root, config, workflow, retained);
    settled.push(retained);
  }
  return settled;
}

function advanceDetail(workflow, pending) {
  if (pending) return `; waiting for a decision: ${pending.label}`;
  return workflow.currentPhase ? `; advanced to ${workflow.currentPhase}` : '; closed';
}

/** Append one routed, pending or chosen decision to the Story's log and history. */
function logDecision(workflow, { outcome, at, actor, agent, pending = null, comment = null, authority = null }) {
  workflow.decisionLog ??= [];
  workflow.decisionLog.push({
    decision: outcome.decision,
    after: outcome.after,
    kind: outcome.kind,
    reason: outcome.reason ?? null,
    route: outcome.route ?? null,
    target: outcome.target ?? null,
    skipped: [...(outcome.skipped ?? [])],
    round: outcome.round ?? null,
    values: outcome.values ?? null,
    by: outcome.by ?? 'rule',
    at,
    actor: actor ? actorKey(actor) : null,
    ...(authority ? { authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance } : {}),
    ...(comment ? { comment } : {}),
    ...(pending ? { pendingKey: pending.key } : {})
  });
  workflow.history.push({
    at,
    actor: actor ? actorKey(actor) : null,
    agent: agent ?? null,
    event: pending ? 'decision_pending' : outcome.by === 'person' ? 'decision_made' : 'decision_routed',
    phase: outcome.after,
    detail: `${describeOutcome(workflow, outcome)}${comment ? ` Reason: ${comment}` : ''}`
  });
}

/**
 * Apply a forward, finishing or pausing outcome after a phase completed. A loop never arrives
 * here: only a phase a person signs off may send work back, and that goes through rework.
 */
function applyCompletionOutcome(workflow, phase, outcome, { at, actor, agent }) {
  if (outcome?.kind === 'loop') {
    throw new SingularityFlowError(`Decision '${outcome.label}' can send work back only when a person approves '${phase.id}'.`,
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  const pending = outcome?.kind === 'pause' ? pendingDecisionRecord(workflow, phase, outcome, { at }) : null;
  const upcoming = advanceCompletedPhase(workflow, phase, at, pending ? { ...outcome, pending } : outcome);
  if (outcome) logDecision(workflow, { outcome, at, actor, agent, pending });
  return { upcoming, pending };
}

/** Skipped phases that already have an artifact from an earlier round say so in its metadata. */
async function updateSkippedArtifactMetadata(root, config, workflow, outcome) {
  for (const id of outcome?.skipped ?? []) {
    if (workflow.phases[id]?.status === 'skipped') await updateArtifactMetadata(root, config, workflow, workflow.phases[id]);
  }
}

/**
 * Go back because a decision chose to: reopen the range exactly as a rejection does, with a change
 * request that tells the reopened phase why. A rule's rounds are counted against its limit; a
 * person may choose another round past it, and that round is counted too.
 */
async function loopBackForDecision(root, config, workflow, phase, outcome, {
  at, actor, agent, channel = 'terminal', authorityGroup = null, identityAssurance = null, comment = null
}) {
  const targetId = outcome.target;
  if (!workflow.phaseOrder.includes(targetId) || workflow.phaseOrder.indexOf(targetId) > workflow.phaseOrder.indexOf(phase.id)) {
    throw new SingularityFlowError(`Decision '${outcome.label}' can only go back to '${phase.id}' or an earlier phase.`,
      { code: 'LIFECYCLE_TRANSITION_INVALID' });
  }
  workflow.decisionRounds ??= {};
  const rounds = workflow.decisionRounds[outcome.decision] ?? { count: 0 };
  rounds.count += 1;
  rounds.lastAt = at;
  workflow.decisionRounds[outcome.decision] = rounds;
  workflow.changeRequests ??= [];
  const packet = [...(workflow.lineage?.submissions ?? [])].reverse().find((entry) =>
    entry.phase === phase.id && entry.generation === phase.generation);
  const description = describeOutcome(workflow, { ...outcome, round: outcome.round ?? rounds.count });
  const changeRequest = {
    schemaVersion: 1,
    id: `CR-${String(workflow.changeRequests.length + 1).padStart(3, '0')}`,
    status: 'open',
    sourcePhase: phase.id,
    sourceGeneration: phase.generation,
    targetPhase: targetId,
    clauseIds: [],
    // No forward checkpoint: a decision's loop is undone by deciding differently, not by rolling
    // back to the moment before the rule applied.
    decision: {
      id: outcome.decision,
      route: outcome.route ?? null,
      round: outcome.round ?? rounds.count,
      maxRounds: outcome.maxRounds ?? null,
      values: outcome.values ?? null,
      by: outcome.by ?? 'rule'
    },
    comment: comment ? `${description} ${comment}` : description,
    requestedAt: at,
    requestedBy: actor,
    agent: agent ?? null,
    channel,
    authorityGroup,
    identityAssurance,
    sourceArtifactSha256: (phase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: packet?.packetSha256 ?? null,
    resolution: null
  };
  for (const id of reopenPhaseRange(workflow, {
    targetId, at, actor: actorKey(actor), reason: changeRequest.comment, loopDecision: outcome.decision
  })) await updateArtifactMetadata(root, config, workflow, workflow.phases[id]);
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: targetId,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  workflow.changeRequests.push(changeRequest);
  return { changeRequest };
}

/**
 * A person's choice at a decision that is waiting for one.
 *
 * Only members of the decision's groups may choose, with a reason, and only for the exact question
 * they were shown (`expectedKey`). Moving on skips or finishes exactly as a rule would; going back
 * is rework, recorded with a change request like any rejection.
 */
export async function decideStory(root, config, workflow, {
  option = null, to = null, reason = '', expectedKey = null, channel = 'terminal',
  actor = null, agent = undefined
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'decide');
  const pending = workflow.pendingDecision ?? null;
  if (!pending || workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${workflow.workItem.id} is not waiting for a decision.`, { code: 'DECISION_NOT_PENDING' });
  }
  if (expectedKey && expectedKey !== pending.key) {
    throw new SingularityFlowError(
      `The decision changed after it was shown (expected ${expectedKey}, now ${pending.key}). Review it again with singularity-flow decision show ${workflow.workItem.id}.`,
      { code: 'DECISION_STALE', details: { expected: expectedKey, current: pending.key } }
    );
  }
  const comment = String(reason ?? '').trim();
  if (!comment) throw new SingularityFlowError('Say why with --reason; the decision log keeps it.', { code: 'DECISION_REASON_REQUIRED' });
  const phase = workflow.phases[pending.after];
  if (!phase || phase.status !== 'approved' || workflow.currentPhase !== phase.id) {
    throw new SingularityFlowError(`Story ${workflow.workItem.id} records a decision after '${pending.after}', but that phase is not the approved current phase.`,
      { code: 'DECISION_STATE_INVALID' });
  }
  const session = actor ? { actor, agent: agent ?? null } : await loadSession(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: pending.by, requiredAuthorities: [], minimum: 1 },
    session.actor
  );
  const { route, reach } = resolveDecisionChoice(workflow, pending, { option, to });
  if (route.id === 'step') assertChoiceKeepsDependencies(workflow, pending, reach);
  const at = nowIso();
  const outcome = {
    decision: pending.decision,
    label: pending.label,
    after: pending.after,
    kind: reach.kind === 'backward' ? 'loop' : reach.kind,
    route: route.id,
    routeLabel: route.label,
    target: reach.target,
    skipped: reach.skipped,
    values: pending.values ?? null,
    maxRounds: pending.maxRounds ?? null,
    by: 'person'
  };
  let upcoming = null;
  if (outcome.kind === 'loop') {
    outcome.round = (workflow.decisionRounds?.[pending.decision]?.count ?? 0) + 1;
    delete workflow.pendingDecision;
    await loopBackForDecision(root, config, workflow, phase, outcome, {
      at, actor: session.actor, agent: session.agent, channel,
      authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance,
      comment: `Chosen by ${actorKey(session.actor)}: ${comment}`
    });
  } else {
    const target = outcome.kind === 'forward' || outcome.kind === 'next' ? workflow.phases[reach.target] : null;
    if (phaseRequiresCodeDelivery(target)) await assertPlannedSpecificationClaims(root, config, workflow, target);
    upcoming = advanceCompletedPhase(workflow, phase, at, outcome.kind === 'next' ? null : outcome);
    await updateSkippedArtifactMetadata(root, config, workflow, outcome);
    if (upcoming) {
      await ensureWorkIntervalBaseline(root, config, workflow, {
        phaseId: upcoming.id,
        itemDirectory: workDir(root, config, workflow.workItem.id),
        itemRelative: workDirRelative(config, workflow.workItem.id)
      });
    }
  }
  logDecision(workflow, { outcome, at, actor: session.actor, agent: session.agent, comment, authority });
  await saveWorkflow(root, config, workflow);
  return {
    outcome,
    pendingKey: pending.key,
    next: upcoming ?? (outcome.kind === 'loop' ? workflow.phases[outcome.target] : null),
    authority,
    contextBoundary: contextBoundaryHandoff(workflow.resolution.contextPolicy, phase.id, {
      event: outcome.kind === 'loop' ? 'rejection' : undefined,
      nextPhase: workflow.currentPhase ?? null,
      complete: workflow.status === 'closed'
    })
  };
}

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

export async function rejectPhase(root, config, workflow, {
  phaseId, target, reason, clauseIds = [], members = [], convergenceRework = null,
  testingRepairConfirm = null, testingRepairPlan = null, channel = 'terminal', actionContext = null,
  actor = null, agent = undefined, upstreamIssue = null, presence = null
} = {}) {
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
  if ((testingRepair || phase.approvalPolicy.changeRequests?.commentRequired !== false)
      && !reason?.trim()) {
    throw new SingularityFlowError('A change-request comment is required.');
  }
  const session = actor
    ? { actor, agent: agent ?? null }
    : await loadSession(root);
  assertPhaseAgentMayMutate(config, workflow, phase, session, 'reject');
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    (upstreamIssue ? workflow.phases[target]?.approvalPolicy : null) ?? phase.approvalPolicy,
    session.actor
  );
  if (upstreamIssue && workflow.phaseOrder.indexOf(target) >= workflow.phaseOrder.indexOf(phase.id)) {
    throw new SingularityFlowError(`${upstreamIssue.id} returns to an earlier step, not '${target}'.`, { code: 'UPSTREAM_ISSUE_NOT_EARLIER' });
  }
  const targetId = target ?? phase.id; if (!upstreamIssue && !phaseCorrectionTargets(phase).includes(targetId)) throw new SingularityFlowError(`Phase '${phase.id}' cannot be rejected to '${targetId}'. Allowed: ${phaseCorrectionTargets(phase).join(', ')}.`);
  const targetIndex = workflow.phaseOrder.indexOf(targetId); if (targetIndex < 0 || targetIndex > workflow.phaseOrder.indexOf(phase.id)) throw new SingularityFlowError(`Invalid rejection target '${targetId}'.`);
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
  if (presence) await (await import('./presence/person-records.mjs')).attachPersonPresence(presence, decision);
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

function intentAmendmentSummary(workflow, proposalId) {
  return (workflow.intentAmendments ?? []).find((entry) => entry.id === proposalId) ?? null;
}

async function intentAmendmentPath(root, config, workflow, relative, label, { mustExist = false, type = null } = {}) {
  const itemRoot = path.resolve(workDir(root, config, workflow.workItem.id));
  const target = path.resolve(root, relative ?? '');
  if (target === itemRoot || !target.startsWith(`${itemRoot}${path.sep}`)) {
    throw new SingularityFlowError(`${label} must remain inside Story '${workflow.workItem.id}'.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const secured = await secureRepositoryPath(root, posix(path.relative(root, target)), {
    label,
    mustExist,
    type
  });
  return secured.absolute;
}

/** An approved amendment that this checkout has not yet acknowledged. */
export { pendingIntentAmendmentAcknowledgement } from './source-review-policy.mjs';

async function persistIntentAmendmentRecord(root, config, workflow, summary, record) {
  const file = await intentAmendmentPath(root, config, workflow, summary.recordPath, 'Intent-amendment record');
  await writeJson(file, record);
}

/** Inspect exact candidate bytes before recording any approval, including a partial one. */
async function inspectedIntentAmendmentCandidate(root, config, workflow, specification, proposal, actor, staleProposalDetails) {
  const specificationPath = requiredRepoPath(config, workflow, specification);
  if (specificationPath !== proposal.specification?.artifact) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' targets a different specification artifact.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const specificationFile = (await secureRepositoryPath(root, specificationPath, {
    label: 'Specification artifact', mustExist: true, type: 'file'
  })).absolute;
  const current = await repositoryArtifactSnapshot(root, specificationPath);
  if (!current.exists || current.sha256 !== proposal.specification.beforeSha256) {
    throw new SingularityFlowError(
      `Specification changed after intent amendment '${proposal.id}' was proposed. Create a new proposal against the current generation.`,
      { code: 'INTENT_AMENDMENT_STALE', details: staleProposalDetails }
    );
  }
  const proposedFile = await intentAmendmentPath(root, config, workflow,
    proposal.specification.proposedPath, 'Proposed specification', { mustExist: true, type: 'file' });
  const proposedText = await readFile(proposedFile, 'utf8');
  // Bind validation and replacement to the very same bytes, not to a second file read.
  const proposedSnapshot = { sha256: createHash('sha256').update(proposedText).digest('hex') };
  if (proposedSnapshot.sha256 !== proposal.specification.proposedSha256) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' proposed bytes changed after review.`, {
      code: 'INTENT_AMENDMENT_STALE', details: staleProposalDetails
    });
  }
  try {
    await assertAmendedScopeContent(root, config, workflow, specification, proposedText,
      extractClauses(proposedText, { sourcePath: specificationPath }).map((clause) => clause.id));
  } catch (error) {
    if (!(error instanceof SingularityFlowError)) throw error;
    throw new SingularityFlowError(
      `Intent amendment '${proposal.id}' cannot be approved. ${error.message} `
      + 'An authorized scope reviewer can reject this proposal, then propose corrected bytes; do not edit the stored candidate or approved scope in place.',
      { code: error.code, details: { ...error.details, ...staleProposalDetails, proposalId: proposal.id } }
    );
  }
  // A reviewer approves intent, not a claim of authorship. Older proposals have unspecified
  // provenance; never turn the human decision into a fabricated human/no-AI attestation.
  const amendmentAuthorship = proposal.authorship ?? buildGenerationAuthorship({
    options: normalizeAuthorshipOptions(), actor: proposal.proposedBy ?? actor,
    governedAgentContext: null,
    source: { kind: 'intent-amendment', id: proposal.id, path: proposal.specification.proposedPath,
      sha256: proposedSnapshot.sha256 }
  });
  const declaredAuthorship = normalizeAuthorshipOptions({
    producer: amendmentAuthorship.producer, channel: amendmentAuthorship.channel,
    externalAiUse: amendmentAuthorship.externalAiUse?.status === 'self-reported'
      ? amendmentAuthorship.externalAiUse.value : null,
    changeOrigins: amendmentAuthorship.changeOrigins
  });
  assertProducerAllowed(specification, declaredAuthorship.producer);
  return { specificationPath, specificationFile, proposedText, proposedSnapshot, amendmentAuthorship };
}

/**
 * Record the authority decision and, once its threshold is reached, install the approved intent.
 *
 * This is deliberately not `rejectPhase`: code rework and corrected intent have different
 * authority, different evidence consequences, and different next actions. The specification gains
 * a new approved generation; downstream phases are replayed through the ordinary sequence while
 * their existing evidence is retained and labelled affected or preserved.
 */
export async function decideIntentAmendment(root, config, workflow, proposal, {
  decision,
  reason = null,
  channel = 'terminal',
  actionContext = null,
  actor = identity(root),
  agent = null
} = {}) {
  if (!['approve', 'reject'].includes(decision)) {
    throw new SingularityFlowError("Intent-amendment decision must be 'approve' or 'reject'.", {
      code: 'INTENT_AMENDMENT_DECISION_INVALID'
    });
  }
  const summary = intentAmendmentSummary(workflow, proposal?.id);
  if (!summary || summary.status !== 'proposed' || proposal?.status !== 'proposed') {
    throw new SingularityFlowError(`Intent amendment '${proposal?.id ?? 'unknown'}' is not awaiting a decision.`, {
      code: 'INTENT_AMENDMENT_NOT_PENDING'
    });
  }
  if (summary.proposalSha256 !== proposal.proposalSha256) {
    throw new SingularityFlowError(`Intent amendment '${proposal.id}' no longer matches its workflow binding.`, {
      code: 'INTENT_AMENDMENT_INVALID'
    });
  }
  const specification = scopeStepOf(workflow);
  if (!specification) {
    throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no step that defines the scope to amend.`, {
      code: 'INTENT_AMENDMENT_UNSUPPORTED'
    });
  }
  // Rejecting a stale proposal changes no approved intent or evidence. It must remain available
  // to the scope authority, otherwise a moved source leaves a pending proposal blocking forever.
  const staleProposalDetails = {
    workId: workflow.workItem.id, phase: workflow.currentPhase,
    recoveryCommand: `singularity-flow story intent-amendment decide ${proposal.id} --decision reject --confirm ${proposal.id} --work-id ${workflow.workItem.id}`
  };
  if (decision === 'approve' && proposal.source != null) {
    const source = proposal.source;
    const phase = workflow.phases[source.phaseId];
    if (!intentAmendmentSource(workflow, source.phaseId)
        || source.kind !== 'phase-feedback'
        || workflow.currentPhase !== source.phaseId
        || !phase
        || phase.generation !== source.generation
        || phase.status !== source.status
        || typeof source.artifactPresent !== 'boolean'
        || (source.artifactPresent && typeof source.artifactSha256 !== 'string')
        || (!source.artifactPresent && source.artifactSha256 !== null)
        || typeof source.sourceTreeSha256 !== 'string'
        || (phase.requiredArtifact?.path ? requiredRepoPath(config, workflow, phase) : null) !== source.artifactPath) {
      throw new SingularityFlowError(
        `Intent amendment '${proposal.id}' no longer matches its source phase '${source.phaseId}'.`,
        { code: 'INTENT_AMENDMENT_SOURCE_STALE', details: staleProposalDetails }
      );
    }
    const artifact = source.artifactPath ? await repositoryArtifactSnapshot(root, source.artifactPath)
      : { exists: false, symbolicLink: false, sha256: null };
    if (artifact.exists !== source.artifactPresent
        || artifact.symbolicLink
        || artifact.sha256 !== source.artifactSha256
        || await sourceTreeHash(root, config, workflow) !== source.sourceTreeSha256) {
      throw new SingularityFlowError(
        `Source-phase evidence changed after intent amendment '${proposal.id}' was proposed. Create a new proposal.`,
        { code: 'INTENT_AMENDMENT_SOURCE_STALE', details: staleProposalDetails }
      );
    }
  }
  if (decision === 'approve' && specification.generation !== proposal.specification?.generation) {
    throw new SingularityFlowError(
      `The approved scope generation changed after intent amendment '${proposal.id}' was proposed. Create a new proposal against the current generation.`,
      { code: 'INTENT_AMENDMENT_STALE', details: staleProposalDetails }
    );
  }
  const decisions = [...(proposal.decisions ?? [])];
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    specification.approvalPolicy,
    actor,
    { preferredAuthorities: decision === 'approve'
      ? remainingRequiredAuthorities(specification.approvalPolicy, decisions) : [] }
  );
  const key = actorKey(actor);
  if (decision === 'approve' && decisions.some((entry) => sameApprover(entry.actor, actor))) {
    throw new SingularityFlowError(`${key} already decided intent amendment ${proposal.id}; decisions require distinct identities.`);
  }
  const selfApproval = sameApprover(proposal.proposedBy ?? {}, actor);
  if (decision === 'approve' && selfApproval && specification.approvalPolicy.allowSelfApproval === false) {
    throw new SingularityFlowError(
      `Specification policy prohibits the proposer from approving intent amendment '${proposal.id}'. Ask another authorized Git identity.`
    );
  }
  const amendmentCandidate = decision === 'approve'
    ? await inspectedIntentAmendmentCandidate(root, config, workflow, specification, proposal, actor, staleProposalDetails)
    : null;
  const at = nowIso();
  const recorded = {
    decision: decision === 'approve' ? 'approved' : 'rejected',
    at,
    actor: structuredClone(actor),
    agent,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    channel,
    reason: reason?.trim() || null,
    selfApproval,
    ...(actionContext ? { actionContext } : {})
  };
  // SF Guard: on a Story it requires, this decision is the approver's signed step (SPEC-PSS-v1 §10.12).
  await (await import('./presence/person-steps.mjs')).signPersonRecords(root, workflow,
    [{ label: 'Intent amendment decision', action: 'decision.intent-amendment', record: recorded }]);
  const recordedDecisionSha256 = createHash('sha256').update(canonicalJson(recorded)).digest('hex');
  decisions.push(recorded);
  proposal.decisions = decisions;

  if (decision === 'reject') {
    proposal.status = 'rejected';
    proposal.decidedAt = at;
    proposal.decision = recorded;
    Object.assign(summary, { status: 'rejected', decidedAt: at, decision: recorded });
    workflow.history.push({
      at, actor: key, agent, event: 'intent_amendment_rejected',
      phase: scopeStepOf(workflow)?.id ?? null, detail: `${proposal.id}: ${recorded.reason ?? 'rejected by specification authority'}`
    });
    await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
    return {
      proposal,
      eventDecision: recorded,
      decisionSha256: recordedDecisionSha256,
      reached: true,
      applied: false,
      affectedPhases: [],
      preservedEvidence: []
    };
  }

  const approvals = decisions.filter((entry) => entry.decision === 'approved');
  const minimum = specification.approvalPolicy.minimum ?? 1;
  proposal.approvals = { reached: approvals.length, required: minimum,
    missingAuthorities: remainingRequiredAuthorities(specification.approvalPolicy, approvals) };
  Object.assign(summary, { approvals: proposal.approvals });
  if (!approvalRequirementsMet(specification.approvalPolicy, approvals)) {
    proposal.status = 'proposed';
    await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
    return {
      proposal,
      eventDecision: recorded,
      decisionSha256: recordedDecisionSha256,
      reached: false,
      applied: false,
      affectedPhases: [],
      preservedEvidence: []
    };
  }

  // Rule E8: the approved steps after the scope step whose approvals this amendment cannot touch,
  // checked against everything they decided over before anything below changes it.
  const retentionCandidates = await amendmentRetentionCandidates(root, config, workflow, specification,
    { addsClauses: (proposal.diff?.added ?? []).length > 0 });
  const { specificationPath, specificationFile, proposedText, proposedSnapshot, amendmentAuthorship } = amendmentCandidate;
  await writeBytes(specificationFile, Buffer.from(proposedText, 'utf8'));
  const priorGeneration = Number(specification.generation ?? 0);
  const amendmentGeneration = nextPhaseGeneration(specification);
  const amendmentArchitectureIntent = null;
  specification.approvals.forEach((approval) => {
    if (!approval.invalidatedAt) approval.invalidatedAt = at;
  });
  specification.generation = amendmentGeneration;
  specification.submissionArchitectureDecision = null;
  // The approved amendment is a person's decision on the new generation, not an automatic completion.
  clearApprovalDisposition(specification);
  specification.status = 'approved';
  specification.submittedAt = at;
  specification.approvedAt = at;
  specification.approvedBy = key;
  specification.generatedAt = at;
  specification.generatedBy = structuredClone(proposal.proposedBy ?? actor);
  specification.generatedAgent = amendmentAuthorship.governedAgentContext?.agentId ?? null;
  specification.authorship = [
    ...(specification.authorship ?? []).filter((entry) => Number(entry.generation) !== Number(specification.generation)),
    {
      ...structuredClone(amendmentAuthorship),
      source: { ...structuredClone(amendmentAuthorship.source), proposalSha256: proposal.proposalSha256 },
      generation: specification.generation,
      publishedAt: at
    }
  ];
  const amendmentApprovals = approvals.map((approval) => ({
    ...approval,
    decision: 'approved',
    phase: specification.id,
    generation: specification.generation,
    intentAmendmentId: proposal.id,
    changedClauses: [...(proposal.diff?.changed ?? [])],
    artifactSha256: [{ path: specificationPath, sha256: proposedSnapshot.sha256 }],
    architectureIntent: structuredClone(amendmentArchitectureIntent),
    architectureDecision: null
  }));
  const amendmentApproval = amendmentApprovals.at(-1);
  // The ordinary submit ceremony registers a model-safe expansion reference against the immutable
  // generation commit. An approved amendment deliberately has no synthetic submission packet, but
  // its proposed bytes already exist in the immutable proposal commit. Register that reviewed
  // source so downstream `fallback: block` briefs retain the same exact expansion guarantee.
  const amendmentReferenceRevision = referenceRevision(
    root, head(root), proposal.specification.proposedPath
  );
  const amendmentReference = await registerReference(root, {
    repository: {
      id: config.repository?.id ?? path.basename(root),
      origin: config.repository?.origin ?? null
    },
    subject: {
      kind: 'story', id: workflow.workItem.id, branch: workflow.workItem.branch,
      subjectRevision: specification.generation
    },
    artifact: {
      phaseId: specification.id,
      generation: specification.generation,
      outputId: specification.requiredArtifact?.id ?? specification.id,
      path: proposal.specification.proposedPath,
      mediaType: 'text/markdown'
    },
    revision: amendmentReferenceRevision,
    visibility: 'model'
  });
  specification.approvals.push(...amendmentApprovals);
  await updateArtifactMetadata(root, config, workflow, specification);
  await registerApprovedSnapshot(root, config, workflow, specification);
  await refreshPhaseSpecificationIndex(root, config, workflow, specification);
  // The new generation plans its clauses exactly as a published one does; without this the code step
  // found only the previous generation's planned claim map and refused to start.
  await refreshPlannedSpecificationClaims(root, config, workflow, specification);
  const scopeRevision = await recordApprovedScopeRevision(root, config, workflow, specification, at, { kind: 'intent-amendment', id: proposal.id });
  const amendmentTelemetry = await recordPhaseTelemetry(root, workflow, specification, [], {
    source: 'not-invoked', usage: [], spans: 0, rawBytes: 0, pending: false, warnings: [],
    startedAt: at, completedAt: at
  }, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  specification.telemetry = [
    ...(specification.telemetry ?? []).filter((entry) => Number(entry.generation) !== Number(specification.generation)),
    phaseTelemetrySummary(amendmentTelemetry)
  ];

  // An approved intent amendment creates a new specification generation without travelling
  // through the ordinary publish -> submit path. It must nevertheless mint the same downstream
  // projections as a normally published generation; otherwise the first replayed phase sees an
  // approved producer with no generation-bound brief and cannot prepare its inputs.
  //
  // Bind the deterministic records to the authority decision itself. The proposed artifact bytes
  // were what the authority reviewed, while `agentBriefSource` names the kernel-managed bytes after
  // their metadata block was refreshed. Keeping both bindings avoids inventing a synthetic submit
  // ceremony and lets downstream verification distinguish this exceptional, reviewed transition
  // from an unreviewed missing submission packet.
  const agentBriefs = await createAgentBriefs(root, workflow, specification, {
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  if (agentBriefs.length) {
    specification.agentBriefs = [
      ...(specification.agentBriefs ?? []).filter((entry) => entry.generation !== specification.generation),
      ...agentBriefs
    ].sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
    const approvedSource = artifactFor(specification, specificationPath);
    amendmentApproval.agentBriefSource = approvedSource ? {
      path: approvedSource.path,
      sha256: approvedSource.sha256,
      size: approvedSource.size,
      reference: {
        handle: amendmentReference.handle,
        recordHash: amendmentReference.recordHash,
        sourcePath: proposal.specification.proposedPath
      }
    } : null;
    amendmentApproval.agentBriefs = agentBriefs.map((brief) => ({
      consumerPhase: brief.consumerPhase,
      status: brief.status,
      path: brief.path,
      renderedPath: brief.renderedPath,
      sourceSha256: brief.sourceSha256,
      sourceBytes: brief.sourceBytes ?? null,
      renderedSha256: brief.renderedSha256,
      integritySha256: brief.integritySha256
    }));
  }
  specification.sourceCommit = head(root);
  const amendmentPublication = {
    generation: specification.generation,
    publishedAt: at,
    changeSetDigest: null,
    resultDigest: await generationResultDigest(root, config, workflow, specification, {
      architectureIntent: amendmentArchitectureIntent,
      architectureDecision: null,
      resultDigestVersion: 3
    }),
    resultDigestVersion: 3,
    architectureIntent: structuredClone(amendmentArchitectureIntent),
    architectureDecision: null,
    origin: {
      kind: 'intent-amendment',
      id: proposal.id,
      proposalSha256: proposal.proposalSha256,
      // Bind the exceptional generation to the exact authority decision that created it. The
      // ordinary publish path gets this identity from its review packet; an amendment has no such
      // packet, so inheriting the previous phase approval here would misattribute the generation.
      decisionSha256: createHash('sha256').update(canonicalJson(amendmentApproval)).digest('hex')
    },
    record: null
  };
  specification.generationPublications = [
    ...(specification.generationPublications ?? []).filter((entry) =>
      Number(entry.generation) !== Number(specification.generation)),
    amendmentPublication
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
  for (const approval of amendmentApprovals) await writeDecision(root, config, workflow, specification, approval);

  const specificationIndex = workflow.phaseOrder.indexOf(specification.id);
  const nextIndex = specificationIndex + 1;
  if (specificationIndex < 0 || nextIndex >= workflow.phaseOrder.length) {
    throw new SingularityFlowError('An intent amendment requires a downstream phase to revalidate.', {
      code: 'INTENT_AMENDMENT_UNSUPPORTED'
    });
  }
  const changedClauses = [...(proposal.diff?.changed ?? [])];
  // What the revision makes stale: the clauses it added or revised and every clause depending on
  // one. An artifact is affected when it cites one of those, or a removed clause, by exact ID.
  const currentClauses = (await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow)).indexes
    .flatMap((index) => index.clauses ?? []);
  const staleClauses = scopeRevision
    ? staleClausesOf(scopeRevision, currentClauses)
    : new Set([...(proposal.diff?.added ?? []), ...(proposal.diff?.revised ?? [])]);
  const cited = new Set([...staleClauses, ...(proposal.diff?.removed ?? [])]);
  const standingClauses = currentClauses.map((clause) => String(clause.id).toUpperCase()).filter((id) => !staleClauses.has(id)).sort();
  const evidencePaths = new Set([
    ...(proposal.radius?.artifacts ?? []),
    ...(proposal.radius?.tests ?? [])
  ].map(posix));
  const affectedPhases = [];
  const preservedEvidence = [];
  const retainedPhases = [];
  let retaining = true;
  let firstReset = null;
  for (let index = nextIndex; index < workflow.phaseOrder.length; index += 1) {
    const phase = workflow.phases[workflow.phaseOrder[index]];
    let directlyAffected = isConvergencePhase(phase)
      || (phaseRequiresCodeDelivery(phase) && Number(proposal.radius?.totals?.affected ?? 0) > 0);
    for (const artifact of phase.artifacts ?? []) {
      let affected = evidencePaths.has(posix(artifact.path));
      if (!affected) {
        const artifactFile = path.join(root, artifact.path);
        if (existsSync(artifactFile)) {
          const text = await readFile(artifactFile, 'utf8').catch(() => '');
          affected = clauseReferences(text).some((clauseId) => cited.has(clauseId));
        }
      }
      artifact.intentAmendment = {
        id: proposal.id,
        state: affected ? 'affected-revalidation-required' : 'preserved-unaffected',
        fromSpecificationGeneration: priorGeneration,
        toSpecificationGeneration: specification.generation
      };
      if (affected) directlyAffected = true;
      else preservedEvidence.push(artifact.path);
    }
    if (directlyAffected) affectedPhases.push(phase.id);
    // Rule E8: an approved step the amendment cites nothing of keeps its approval, as long as every
    // step before it did too; the first one that does not runs again, and so does all after it.
    if (retaining && !directlyAffected && retentionCandidates.has(phase.id)) {
      phase.retention = { rule: 'E8', at, generation: phase.generation, amendment: proposal.id,
        ...retainedByRule('E8', { amendment: proposal.id, approvalAt: phase.approvedAt }) };
      workflow.history.push({ at, actor: key, agent: agent ?? null, event: 'phase_retained', phase: phase.id,
        detail: `Retained by rule E8: approved intent amendment ${proposal.id} changed none of the clauses its artifacts cite, and nothing else it decided over had changed.` });
      retainedPhases.push(phase.id);
      continue;
    }
    retaining = false;
    firstReset ??= index;
    phase.approvals.forEach((approval) => {
      if (!approval.invalidatedAt) approval.invalidatedAt = at;
    });
    phase.status = index === firstReset ? 'in_progress' : 'not_started';
    phase.submittedAt = null;
    phase.submissionArchitectureDecision = null;
    phase.approvedAt = null;
    phase.approvedBy = null;
    clearApprovalDisposition(phase);
    // The complete reset every reopen applies: a decision value recorded before the amendment
    // (a pass, say) routed the new round on old evidence (2026-10-28).
    delete phase.retention;
    clearDecisionState(phase);
    resetDecisionRounds(workflow, [phase.id]);
    if (workflow.pendingDecision?.after === phase.id) delete workflow.pendingDecision;
    phase.rejectedAt = at;
    phase.rejectedBy = key;
    phase.rejectionReason = `Revalidate after approved intent amendment ${proposal.id}.`;
    phase.intentAmendmentRevalidation = {
      id: proposal.id,
      state: directlyAffected ? 'affected' : 'evidence-preserved',
      changedClauses,
      acknowledgedAt: null,
      revalidatedAt: null
    };
    await updateArtifactMetadata(root, config, workflow, phase);
  }
  workflow.currentPhase = workflow.phaseOrder[firstReset ?? nextIndex];
  workflow.status = 'in_progress';
  if (firstReset != null) delete workflow.completion;

  proposal.status = 'approved';
  proposal.decidedAt = at;
  proposal.decision = recorded;
  proposal.application = {
    fromSpecificationGeneration: priorGeneration,
    toSpecificationGeneration: specification.generation,
    scopeRevision: scopeRevision ? { revision: scopeRevision.revision, revisionSha256: scopeRevision.revisionSha256 } : null,
    staleClauses: [...staleClauses].sort(),
    standingClauses,
    affectedPhases,
    retainedPhases,
    preservedEvidence: [...new Set(preservedEvidence)].sort(),
    acknowledgementRequired: true
  };
  Object.assign(summary, {
    status: 'approved', decidedAt: at, decision: recorded,
    changedClauses, affectedPhases, retainedPhases,
    scopeRevision: proposal.application.scopeRevision,
    staleClauses: proposal.application.staleClauses,
    standingClauses,
    preservedEvidence: proposal.application.preservedEvidence,
    acknowledgementRequired: true,
    acknowledgedAt: null,
    revalidatedPhases: []
  });
  workflow.history.push({
    at, actor: key, agent, event: 'intent_amendment_approved', phase: specification.id,
    detail: `${proposal.id} created specification generation ${specification.generation}`
      + `${scopeRevision ? ` and scope revision ${scopeRevision.revision}` : ''}; `
      + `${staleClauses.size} clause(s) stale, ${standingClauses.length} standing; `
      + `${affectedPhases.length} phase(s) affected and ${proposal.application.preservedEvidence.length} evidence item(s) preserved`
  });
  await persistIntentAmendmentRecord(root, config, workflow, summary, proposal);
  return {
    proposal,
    approval: amendmentApproval,
    eventDecision: amendmentApproval,
    decisionSha256: amendmentPublication.origin.decisionSha256,
    reached: true,
    applied: true,
    affectedPhases,
    preservedEvidence: proposal.application.preservedEvidence
  };
}

// ---------------------------------------------------------------------------------------------
// Forward amendment [UIF-M3]

function forwardAmendmentRefusal(message, code = 'FORWARD_AMENDMENT_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function inputProducerId(input) {
  return typeof input === 'string' ? input : input?.phase ?? input?.from ?? null;
}

/**
 * The earlier step a forward amendment may change: an approved document step before the current
 * one, while the current step is still being authored. Clause-defining steps change by intent
 * amendment, plan owners by plan corrections, code steps by their own generations.
 */
function forwardAmendmentTarget(config, workflow, phaseId) {
  const order = workflow.phaseOrder ?? [];
  const current = workflow.phases?.[workflow.currentPhase];
  const phase = workflow.phases?.[phaseId];
  if (workflow.status !== 'in_progress' || !current) forwardAmendmentRefusal('A forward amendment needs a Story in progress.');
  if (!phase || order.indexOf(phaseId) < 0 || order.indexOf(phaseId) >= order.indexOf(current.id)) {
    forwardAmendmentRefusal(`A forward amendment changes an earlier step; ${phaseId ?? 'that step'} is not before ${current.id}.`, 'FORWARD_AMENDMENT_NOT_EARLIER');
  }
  if (phase.status !== 'approved' || !(Number(phase.generation) > 0)) forwardAmendmentRefusal(`${phaseId} is not approved, so there is nothing to amend.`);
  if (current.status !== 'in_progress') {
    forwardAmendmentRefusal(`${current.id} is ${current.status.replaceAll('_', ' ')}; approve or return it before amending ${phaseId}.`, 'FORWARD_AMENDMENT_CURRENT_IN_REVIEW');
  }
  if (phaseRequiresCodeDelivery(phase)) forwardAmendmentRefusal(`${phaseId} is a code step; it changes through its own generations.`, 'FORWARD_AMENDMENT_UNSUPPORTED');
  if (isSpecificationDefinitionPhase(phase)) {
    forwardAmendmentRefusal(`${phaseId} defines clauses; change it with story intent-amendment or an upstream-issue return.`, 'FORWARD_AMENDMENT_UNSUPPORTED');
  }
  if (phase.claimMaps?.planned) forwardAmendmentRefusal(`${phaseId} owns the plan; correct its rows with decision plan.`, 'FORWARD_AMENDMENT_UNSUPPORTED');
  if (isConvergencePhase(phase) || phase.kind === 'skill' || phase.artifactSet || !phase.requiredArtifact?.path) {
    forwardAmendmentRefusal(`${phaseId} is not a single-document step a forward amendment can change.`, 'FORWARD_AMENDMENT_UNSUPPORTED');
  }
  const relative = posix(path.join(workDirRelative(config, workflow.workItem.id), phase.requiredArtifact.path));
  const approved = (phase.artifacts ?? []).find((artifact) => artifact.path === relative)?.sha256 ?? null;
  if (!approved) forwardAmendmentRefusal(`${phaseId} has no approved snapshot of ${relative}.`);
  return { phase, current, relative, approved };
}

/** Approved steps between the amended one and the current one that read it directly. */
function forwardAmendmentReaders(workflow, phase, current) {
  const order = workflow.phaseOrder ?? [];
  return order.slice(order.indexOf(phase.id) + 1, order.indexOf(current.id))
    .filter((id) => workflow.phases[id]?.status === 'approved'
      && resolvedPhaseInputs(workflow, workflow.phases[id]).some((input) => inputProducerId(input) === phase.id));
}

/**
 * Save corrected bytes of an earlier step for its approvers. The source is that step's artifact in
 * the working tree, which is restored to its approved bytes once saved, or a draft copy (`file`)
 * anywhere in the repository, so the step that found the defect can draft the fix.
 */
export async function proposeForwardAmendment(root, config, workflow, {
  phaseId, reason, file = null, actor, agent = null, upstreamIssue = null, at = nowIso()
}) {
  const { phase, relative, approved } = forwardAmendmentTarget(config, workflow, phaseId);
  if (pendingForwardAmendments(workflow).some((entry) => entry.phase === phaseId)) {
    forwardAmendmentRefusal(`A proposed amendment of ${phaseId} is waiting for a decision.`, 'FORWARD_AMENDMENT_PENDING');
  }
  const owed = pendingAmendmentRevalidations(workflow).filter((entry) => entry.producer === phaseId);
  if (owed.length) forwardAmendmentRefusal(`${owed[0].amendment} still needs ${owed.map((entry) => entry.phase).join(', ')} revalidated.`, 'AMENDMENT_REVALIDATION_REQUIRED');
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) forwardAmendmentRefusal('Say why the step is amended in 20 to 1000 characters with --reason.');
  const sourceRelative = posix(file ?? relative);
  const source = await secureRepositoryPath(root, sourceRelative, { label: 'Amended artifact', mustExist: true, type: 'file' });
  const bytes = await readFile(source.absolute);
  const proposedSha256 = createHash('sha256').update(bytes).digest('hex');
  if (proposedSha256 === approved) forwardAmendmentRefusal(`The bytes are the approved ${relative}; edit them first.`, 'FORWARD_AMENDMENT_UNCHANGED');
  const committed = exactFileAtObject(root, head(root), relative);
  if (!committed || createHash('sha256').update(committed).digest('hex') !== approved) {
    forwardAmendmentRefusal(`${relative} at HEAD is not the approved bytes; publish or sync first.`, 'FORWARD_AMENDMENT_STALE');
  }
  // The managed input block belongs to the kernel; an amendment changes only authored text.
  if (extractInputsBlock(bytes.toString('utf8')) !== extractInputsBlock(committed.toString('utf8'))) {
    forwardAmendmentRefusal(`Keep ${phaseId}'s managed input block unchanged; amend only the authored text.`);
  }
  workflow.forwardAmendments ??= [];
  const { id, proposedPath } = nextForwardAmendmentProposal(workDirRelative(config, workflow.workItem.id), workflow, relative);
  const target = await secureRepositoryPath(root, proposedPath, { label: 'Forward amendment proposal' });
  if (target.exists) forwardAmendmentRefusal(`${proposedPath} already exists; never overwrite a proposal.`);
  await writeBytes(target.absolute, bytes);
  // The approved bytes stay in force until the approvers decide.
  if (sourceRelative === relative) await writeBytes(path.join(root, relative), committed);
  const proposal = {
    id, phase: phaseId, fromGeneration: Number(phase.generation), artifactPath: relative, fromSha256: approved,
    proposedPath, proposedSha256, reason: text, proposedBy: actorKey(actor), agent, upstreamIssue, at
  };
  workflow.forwardAmendments.push(proposal);
  workflow.history.push({ at, actor: proposal.proposedBy, agent, event: 'forward_amendment_proposed', phase: workflow.currentPhase ?? null,
    detail: `${id} proposes ${phaseId} generation ${proposal.fromGeneration + 1}: ${text}` });
  return proposal;
}

/**
 * The amended step's approvers decide. Approval installs the proposed bytes as the step's next
 * approved generation through the same projections a published generation has (snapshot, input
 * record, briefs, reference and generation publication), lists every approved later step that read
 * it for revalidation instead of resetting it, and refreshes the current step's draft inputs.
 */
export async function decideForwardAmendment(root, config, workflow, {
  amendmentId, decision, reason = null, channel = 'terminal', actor = identity(root), agent = null
}) {
  const proposal = (workflow.forwardAmendments ?? []).find((entry) => entry.id === amendmentId);
  if (!proposal) forwardAmendmentRefusal(`${amendmentId || 'That amendment'} is not a forward amendment of this Story.`, 'FORWARD_AMENDMENT_NOT_FOUND');
  if (forwardAmendmentDecision(workflow, amendmentId)) forwardAmendmentRefusal(`${amendmentId} is already decided.`, 'FORWARD_AMENDMENT_DECIDED');
  if (!['approve', 'reject'].includes(decision)) forwardAmendmentRefusal("--decision must be 'approve' or 'reject'.");
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) forwardAmendmentRefusal('Say why in 20 to 1000 characters with --reason.');
  const phase = workflow.phases?.[proposal.phase];
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const key = actorKey(actor);
  const at = nowIso();
  const recordDecision = (extra = {}) => {
    const entry = { amendment: amendmentId, phase: proposal.phase, decision: decision === 'approve' ? 'approved' : 'rejected', reason: text,
      actor: key, authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at, ...extra };
    workflow.forwardAmendmentDecisions ??= [];
    workflow.forwardAmendmentDecisions.push(entry);
    workflow.history.push({ at, actor: key, agent, event: `forward_amendment_${entry.decision}`, phase: proposal.phase,
      detail: `${amendmentId}: ${text}` });
    return entry;
  };
  if (decision === 'reject') return { proposal, decision: recordDecision(), applied: false };
  const { current, relative, approved } = forwardAmendmentTarget(config, workflow, proposal.phase);
  if (Number(phase.generation) !== Number(proposal.fromGeneration) || approved !== proposal.fromSha256 || relative !== proposal.artifactPath) {
    forwardAmendmentRefusal(`${proposal.phase} changed after ${amendmentId} was proposed; reject it and propose again.`, 'FORWARD_AMENDMENT_STALE');
  }
  const record = { decision: 'approved', actor: structuredClone(actor), authorityGroup: authority.authorityGroup };
  if (!approvalRequirementsMet(phase.approvalPolicy, [record])) {
    forwardAmendmentRefusal(`${proposal.phase} needs more than one approval; return the Story to it instead.`, 'FORWARD_AMENDMENT_AUTHORITY');
  }
  if (phase.approvalPolicy?.allowSelfApproval === false && sameApprover(proposal.proposedBy, actor)) {
    forwardAmendmentRefusal(`${proposal.phase} policy prohibits approving your own amendment; ask another approver.`, 'FORWARD_AMENDMENT_AUTHORITY');
  }
  const proposed = await secureRepositoryPath(root, proposal.proposedPath, { label: 'Forward amendment proposal', mustExist: true, type: 'file' });
  const bytes = await readFile(proposed.absolute);
  const committed = exactFileAtObject(root, head(root), proposal.proposedPath);
  if (!committed?.equals(bytes) || createHash('sha256').update(bytes).digest('hex') !== proposal.proposedSha256) {
    forwardAmendmentRefusal(`${amendmentId}'s proposed bytes are not the committed proposal.`, 'FORWARD_AMENDMENT_STALE');
  }
  const artifactFile = path.join(root, relative);
  if ((await snapshot(artifactFile)).sha256 !== approved) {
    forwardAmendmentRefusal(`${relative} has uncommitted edits; restore the approved bytes before deciding.`, 'FORWARD_AMENDMENT_STALE');
  }
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  const declared = workflowInputsMode(workflow) !== 'off' && resolvedPhaseInputs(workflow, phase).length > 0;
  const authorship = buildGenerationAuthorship({
    options: normalizeAuthorshipOptions(), actor: proposal.proposedBy, governedAgentContext: null,
    source: { kind: 'forward-amendment', id: amendmentId, path: proposal.proposedPath, sha256: proposal.proposedSha256 }
  });
  assertProducerAllowed(phase, authorship.producer);
  await writeBytes(artifactFile, bytes);
  phase.approvals.forEach((entry) => { if (!entry.invalidatedAt) entry.invalidatedAt = at; });
  phase.generation = nextPhaseGeneration(phase);
  phase.submissionArchitectureDecision = null;
  clearApprovalDisposition(phase);
  Object.assign(phase, { status: 'approved', submittedAt: at, approvedAt: at, approvedBy: key, generatedAt: at,
    generatedBy: proposal.proposedBy, generatedAgent: null });
  phase.authorship = [...(phase.authorship ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    { ...structuredClone(authorship), generation: phase.generation, publishedAt: at }];
  if (declared) {
    const inputs = await collectInputs(root, workflow, phase, { definition: config, itemDirectory, itemRelative, generation: phase.generation });
    if (inputs.errors.length) throw phaseInputsNotReadyError(workflow, phase, inputs);
    if (extractInputsBlock(bytes.toString('utf8')) !== renderInputsBlock(inputs).text) {
      forwardAmendmentRefusal(`${amendmentId} changes ${proposal.phase}'s managed input block; reject it and propose authored text only.`);
    }
    const recorded = await recordInputs(root, workflow, phase, inputs, { itemDirectory });
    phase.inputContext = { generation: inputs.generation, path: recorded.path, sha256: recorded.sha256,
      renderedSha256: recorded.record.renderedSha256, mode: inputs.mode };
  }
  const approval = {
    decision: 'approved', phase: phase.id, generation: phase.generation, forwardAmendmentId: amendmentId,
    at, actor: structuredClone(actor), agent, authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, channel, reason: text, selfApproval: sameApprover(proposal.proposedBy, actor),
    artifactSha256: [{ path: relative, sha256: proposal.proposedSha256 }], architectureIntent: null, architectureDecision: null
  };
  const reference = await registerReference(root, {
    repository: { id: config.repository?.id ?? path.basename(root), origin: config.repository?.origin ?? null },
    subject: { kind: 'story', id: workflow.workItem.id, branch: workflow.workItem.branch, subjectRevision: phase.generation },
    artifact: { phaseId: phase.id, generation: phase.generation, outputId: phase.requiredArtifact?.id ?? phase.id,
      path: proposal.proposedPath, mediaType: 'text/markdown' },
    revision: referenceRevision(root, head(root), proposal.proposedPath),
    visibility: 'model'
  });
  phase.approvals.push(approval);
  await updateArtifactMetadata(root, config, workflow, phase);
  await registerApprovedSnapshot(root, config, workflow, phase);
  const telemetry = await recordPhaseTelemetry(root, workflow, phase, [], {
    source: 'not-invoked', usage: [], spans: 0, rawBytes: 0, pending: false, warnings: [], startedAt: at, completedAt: at
  }, { itemDirectory, itemRelative });
  phase.telemetry = [...(phase.telemetry ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)), phaseTelemetrySummary(telemetry)];
  const briefs = await createAgentBriefs(root, workflow, phase, { itemDirectory, itemRelative });
  if (briefs.length) {
    phase.agentBriefs = [...(phase.agentBriefs ?? []).filter((entry) => entry.generation !== phase.generation), ...briefs]
      .sort((left, right) => left.generation - right.generation || left.consumerPhase.localeCompare(right.consumerPhase));
    const source = artifactFor(phase, relative);
    approval.agentBriefSource = source ? { path: source.path, sha256: source.sha256, size: source.size,
      reference: { handle: reference.handle, recordHash: reference.recordHash, sourcePath: proposal.proposedPath } } : null;
    approval.agentBriefs = briefs.map((brief) => ({ consumerPhase: brief.consumerPhase, status: brief.status, path: brief.path,
      renderedPath: brief.renderedPath, sourceSha256: brief.sourceSha256, sourceBytes: brief.sourceBytes ?? null,
      renderedSha256: brief.renderedSha256, integritySha256: brief.integritySha256 }));
  }
  phase.sourceCommit = head(root);
  const decisionSha256 = createHash('sha256').update(canonicalJson(approval)).digest('hex');
  phase.generationPublications = [
    ...(phase.generationPublications ?? []).filter((entry) => Number(entry.generation) !== Number(phase.generation)),
    {
      generation: phase.generation, publishedAt: at, changeSetDigest: null,
      resultDigest: await generationResultDigest(root, config, workflow, phase, { architectureIntent: null, architectureDecision: null, resultDigestVersion: 3 }),
      resultDigestVersion: 3, architectureIntent: null, architectureDecision: null,
      origin: { kind: 'forward-amendment', id: amendmentId, proposalSha256: proposal.proposedSha256, decisionSha256 },
      record: null
    }
  ].sort((left, right) => Number(left.generation) - Number(right.generation));
  await writeDecision(root, config, workflow, phase, approval);
  // The current step reads the amended bytes from its next composition on; its draft keeps its text.
  let refreshed = null;
  if (resolvedPhaseInputs(workflow, current).some((input) => inputProducerId(input) === phase.id) && current.inputContext) {
    const draft = path.join(itemDirectory, current.requiredArtifact.path);
    if (existsSync(draft)) {
      const inputs = await collectInputs(root, workflow, current, { definition: config, itemDirectory, itemRelative });
      if (!inputs.errors.length) {
        await writeText(draft, applyInputsBlock(await readFile(draft, 'utf8'), renderInputsBlock(inputs).text, inputs.mode));
        const recorded = await recordInputs(root, workflow, current, inputs, { itemDirectory });
        current.inputContext = { generation: inputs.generation, path: recorded.path, sha256: recorded.sha256,
          renderedSha256: recorded.record.renderedSha256, mode: inputs.mode };
        await updateArtifactMetadata(root, config, workflow, current);
        refreshed = current.id;
      }
    }
  }
  const revalidate = forwardAmendmentReaders(workflow, phase, current)
    .map((id) => ({ phase: id, generation: Number(workflow.phases[id].generation) }));
  const recorded = recordDecision({ toGeneration: phase.generation, revalidate, refreshed });
  return { proposal, decision: recorded, approval, eventDecision: approval, decisionSha256, applied: true, revalidate, refreshed };
}

/**
 * A later step's approvers record that it still holds under the amended input. The binding names
 * the amended producer generation and bytes and the step's own input record, so a later change of
 * either needs a new decision. The record is checked by the same integrity verification the gate
 * runs before it is kept.
 */
export async function revalidateAfterForwardAmendment(root, config, workflow, {
  amendmentId, phaseId, outcome, reason, actor, agent = null, link = null, at = nowIso()
}) {
  const owed = pendingAmendmentRevalidations(workflow).find((entry) => entry.amendment === amendmentId && entry.phase === phaseId);
  if (!owed) forwardAmendmentRefusal(`${phaseId} has no revalidation owed for ${amendmentId}.`, 'AMENDMENT_REVALIDATION_NOT_OWED');
  if (!['unchanged', 'return'].includes(outcome)) forwardAmendmentRefusal('--outcome must be unchanged or return.');
  const text = String(reason ?? '').trim();
  if (text.length < 20 || text.length > 1000) forwardAmendmentRefusal('Say why in 20 to 1000 characters with --reason.');
  const phase = workflow.phases[phaseId];
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities, phase.approvalPolicy, actor);
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = workDirRelative(config, workflow.workItem.id);
  let binding = null;
  if (outcome === 'unchanged') {
    const inputs = await collectInputs(root, workflow, phase, { definition: config, itemDirectory, itemRelative, generation: phase.generation });
    const amended = inputs.records.find((entry) => entry.phase === owed.producer);
    if (!amended || amended.status !== 'captured' || !phase.inputContext?.sha256) {
      forwardAmendmentRefusal(`${phaseId} cannot read the approved ${owed.producer}; return the Story to ${phaseId} instead.`);
    }
    binding = { producer: owed.producer, producerGeneration: Number(amended.producerGeneration), producerSha256: amended.sha256,
      inputRecordSha256: phase.inputContext.sha256 };
  }
  const entry = { amendment: amendmentId, phase: phaseId, generation: Number(phase.generation), outcome, reason: text, binding,
    link, actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at };
  workflow.amendmentRevalidations ??= [];
  workflow.amendmentRevalidations.push(entry);
  if (outcome === 'unchanged') {
    const integrity = await verifyInputsIntegrity(root, workflow, phase, { itemDirectory, itemRelative, definition: config });
    if (integrity.errors.length) {
      forwardAmendmentRefusal(`${phaseId} does not hold under ${amendmentId} alone: ${integrity.errors[0]}`, 'AMENDMENT_REVALIDATION_INVALID');
    }
  }
  workflow.history.push({ at, actor: entry.actor, agent, event: 'amendment_revalidated', phase: workflow.currentPhase ?? null,
    detail: `${phaseId} after ${amendmentId}: ${outcome}${link ? ` (${link})` : ''}. ${text}` });
  return entry;
}

/** Record the human beat required before an amended Story can be submitted again. */
export async function acknowledgeIntentAmendment(root, config, workflow, proposalId = null, {
  actor = identity(root),
  agent = null
} = {}) {
  const summary = proposalId
    ? intentAmendmentSummary(workflow, proposalId)
    : pendingIntentAmendmentAcknowledgement(workflow);
  if (!summary || summary.status !== 'approved') {
    throw new SingularityFlowError('There is no approved intent amendment awaiting acknowledgement.', {
      code: 'INTENT_AMENDMENT_ACKNOWLEDGEMENT_UNNEEDED'
    });
  }
  if (summary.acknowledgedAt) return { ...summary, acknowledged: false };
  const at = nowIso();
  summary.acknowledgedAt = at;
  summary.acknowledgedBy = structuredClone(actor);
  summary.acknowledgementRequired = false;
  for (const phase of Object.values(workflow.phases ?? {})) {
    if (phase.intentAmendmentRevalidation?.id === summary.id) {
      phase.intentAmendmentRevalidation.acknowledgedAt = at;
    }
  }
  const record = await readJson(await intentAmendmentPath(root, config, workflow, summary.recordPath,
    'Intent-amendment record', { mustExist: true, type: 'file' }));
  record.acknowledgedAt = at;
  record.acknowledgedBy = structuredClone(actor);
  await persistIntentAmendmentRecord(root, config, workflow, summary, record);
  workflow.history.push({
    at, actor: actorKey(actor), agent, event: 'intent_amendment_acknowledged',
    phase: workflow.currentPhase, detail: `${summary.id} acknowledged before downstream revalidation`
  });
  return { ...summary, acknowledged: true };
}

/**
 * Record a scope revision [E2G-008] when an approved step defines clauses and the Story's accepted
 * clause set changed. Returns the revision, or null when nothing changed.
 */
async function recordApprovedScopeRevision(root, config, workflow, phase, at, origin = { kind: 'approval' }) {
  if (!phase.specIndex || Number(phase.specIndex.generation) !== Number(phase.generation)) return null;
  const records = await loadActiveSpecRecords(workDir(root, config, workflow.workItem.id), workflow);
  return recordScopeRevision(workflow, {
    clauses: acceptedClauses(records.indexes), origin: { ...origin, phase: phase.id, generation: phase.generation }, at
  });
}

async function markIntentAmendmentRevalidated(root, config, workflow, phase, at, actor) {
  const id = phase.intentAmendmentRevalidation?.id;
  if (!id) return;
  const summary = intentAmendmentSummary(workflow, id);
  if (!summary) return;
  phase.intentAmendmentRevalidation.revalidatedAt = at;
  phase.intentAmendmentRevalidation.revalidatedBy = actor;
  summary.revalidatedPhases = [...new Set([...(summary.revalidatedPhases ?? []), phase.id])];
  const required = workflow.phaseOrder.slice(workflow.phaseOrder.indexOf(scopeStepOf(workflow)?.id) + 1)
    .filter((phaseId) => workflow.phases[phaseId]?.status !== 'skipped');
  if (required.every((phaseId) => summary.revalidatedPhases.includes(phaseId))) {
    summary.status = 'revalidated';
    summary.revalidatedAt = at;
  }
  const record = await readJson(await intentAmendmentPath(root, config, workflow, summary.recordPath,
    'Intent-amendment record', { mustExist: true, type: 'file' }));
  record.revalidatedPhases = summary.revalidatedPhases;
  if (summary.revalidatedAt) {
    record.status = 'revalidated';
    record.revalidatedAt = summary.revalidatedAt;
  }
  await persistIntentAmendmentRecord(root, config, workflow, summary, record);
}

export async function reopenWorkflow(root, config, workflow, {
  target, reason, channel = 'terminal', actionContext = null, gateRecovery = null,
  actor = null, agent = null
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'reopen completed work');
  if (workflow.status === 'cancelled') throw cancelledStoryRefusal(workflow);
  if (workflow.status !== 'closed' || workflow.currentPhase != null) {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is not closed; use reject while a phase is awaiting approval.`);
  }
  const completionPhase = completionPhaseOf(workflow);
  if (completionPhase.approvalPolicy.changeRequests?.reopenCompleted === false) {
    throw new SingularityFlowError(`Phase '${completionPhase.id}' policy does not allow completed work to be reopened.`);
  }
  const targetId = target ?? completionPhase.id;
  const allowed = completionPhase.approvalPolicy.rejectTo ?? [completionPhase.id];
  const gateRecoveryAuthorized = gateRecovery?.targetPhase === targetId
    && verifyGateRecoveryReopenPlan(root, workflow, gateRecovery);
  if (!allowed.includes(targetId) && !gateRecoveryAuthorized) {
    throw new SingularityFlowError(`Closed Story '${workflow.workItem.id}' cannot be reopened to '${targetId}'. Allowed: ${allowed.join(', ')}.`);
  }
  const targetIndex = workflow.phaseOrder.indexOf(targetId);
  if (targetIndex < 0) throw new SingularityFlowError(`Unknown reopen target '${targetId}'.`);
  if (completionPhase.approvalPolicy.changeRequests?.commentRequired !== false && !reason?.trim()) {
    throw new SingularityFlowError('A change-request comment is required to reopen completed work.');
  }
  const loadedSession = await loadSession(root, { required: false });
  const session = loadedSession?.workId === workflow.workItem.id ? loadedSession : null;
  const decisionActor = actor ?? identity(root);
  const decisionAgent = agent ?? session?.agent ?? completionPhase.defaultAgent ?? null;
  // A final step with no approvers is reopened by the nearest earlier step's (reopenAuthorityStep).
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    workflow.phases[reopenAuthorityStep(workflow, completionPhase.id)].approvalPolicy,
    decisionActor
  );
  const timestamp = nowIso();
  const key = actorKey(decisionActor);
  workflow.changeRequests ??= [];
  const changeRequest = {
    schemaVersion: 1,
    id: `CR-${String(workflow.changeRequests.length + 1).padStart(3, '0')}`,
    status: 'open',
    sourcePhase: completionPhase.id,
    sourceGeneration: completionPhase.generation,
    targetPhase: targetId,
    comment: reason?.trim() || 'Completed work reopened.',
    requestedAt: timestamp,
    requestedBy: decisionActor,
    agent: decisionAgent,
    channel,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance,
    sourceArtifactSha256: (completionPhase.artifacts ?? []).map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 ?? null })),
    reviewPacketSha256: null,
    resolution: null,
    ...(gateRecoveryAuthorized ? {
      gateRecovery: {
        planSha256: gateRecovery.confirmation,
        sourceHead: gateRecovery.head,
        findings: structuredClone(gateRecovery.findings)
      }
    } : {})
  };
  changeRequest.forwardCheckpoint = await createReworkForwardCheckpoint(root, config, workflow, {
    changeRequestId: changeRequest.id,
    sourcePhase: completionPhase.id,
    targetPhase: targetId,
    targetIndex,
    createdAt: timestamp
  });
  for (const id of reopenPhaseRange(workflow, {
    targetId, at: timestamp, actor: key, reason: changeRequest.comment, retain: true
  })) await updateArtifactMetadata(root, config, workflow, workflow.phases[id]);
  // Reopening changes execution state, never the pinned operational contract. Legacy phases with
  // no task declaration already fail closed through phaseRequiresCodeDelivery and are hydrated by
  // normalizeCurrentWorkflow; an explicit non-code task such as the chore profile's `analyze` is
  // an immutable compatibility opt-out and must not be rewritten merely because its artifact kind
  // is `implementation-summary`.
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: targetId,
    itemDirectory: workDir(root, config, workflow.workItem.id),
    itemRelative: workDirRelative(config, workflow.workItem.id)
  });
  await invalidateImpactReceipt(root, config, workflow, {
    reason: changeRequest.comment,
    cause: 'workflow-reopened',
    actor: decisionActor,
    agent: decisionAgent
  });
  workflow.changeRequests.push(changeRequest);
  const decision = {
    decision: 'reopened', phase: completionPhase.id, target: targetId,
    reason: changeRequest.comment, changeRequestId: changeRequest.id, at: timestamp,
    actor: decisionActor, agent: decisionAgent, authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance, channel,
    generation: completionPhase.generation,
    artifactSha256: changeRequest.sourceArtifactSha256,
    ...(gateRecoveryAuthorized ? { gateRecoveryPlanSha256: gateRecovery.confirmation } : {}),
    ...(actionContext ? { actionContext } : {})
  };
  // SF Guard: on a Story it requires, reopening completed work is the approver's signed step, as reject
  // is (SPEC-PSS-v1 §10.6): the card, then one touch, inside the transaction so a refusal writes nothing.
  if (workflow.resolution?.presence) {
    const { attachPersonPresence, preparePersonPresence } = await import('./presence/person-records.mjs');
    await attachPersonPresence(await preparePersonPresence(root, { workflow, phase: completionPhase, actor: decisionActor, action: 'phase.reopen',
      command: `singularity-flow reopen ${workflow.workItem.id} --to ${targetId} --reason "<why>"` }), decision);
  }
  completionPhase.approvals.push(decision);
  await writeDecision(root, config, workflow, completionPhase, decision);
  workflow.history.push({
    at: timestamp, actor: key, agent: decisionAgent, event: 'workflow_reopened', phase: completionPhase.id,
    detail: `${changeRequest.id} returned completed work to ${targetId}: ${changeRequest.comment}`
  });
  await saveWorkflow(root, config, workflow);
  return { phase: workflow.phases[targetId], changeRequest, decision };
}

function reworkScopePath(config, workflow, candidate, { untracked = false } = {}) {
  const relative = posix(String(candidate ?? ''));
  if (!relative) return false;
  if (isApplicationChangePath(relative, {
    ...applicationPathContext(config, workflow), untracked
  })) return true;
  const itemRoot = posix(workDirRelative(config, workflow.workItem.id));
  if (!(relative === itemRoot || relative.startsWith(`${itemRoot}/`))) return false;
  const child = relative.slice(itemRoot.length).replace(/^\//, '');
  return child !== 'workflow.json'
    && child !== 'STATUS.md'
    && !child.startsWith('approvals/');
}

function openReworkCheckpoint(workflow, changeRequestId = null) {
  const newestOpen = (workflow.changeRequests ?? []).filter((request) => request.status === 'open').at(-1) ?? null;
  if (newestOpen?.decision) {
    throw new SingularityFlowError(
      `The newest open rework, ${newestOpen.id}, was chosen by decision '${newestOpen.decision.id}'. It has no checkpoint to roll forward to; finish the round, or reject or reopen with a reason.`,
      { code: 'REWORK_ROLL_FORWARD_DECISION', details: { changeRequest: newestOpen.id, decision: newestOpen.decision.id } }
    );
  }
  const candidates = (workflow.changeRequests ?? []).filter((request) =>
    request.status === 'open' && request.forwardCheckpoint);
  const latest = candidates.at(-1) ?? null;
  if (changeRequestId && latest && latest.id !== changeRequestId) {
    throw new SingularityFlowError(
      `Change request '${changeRequestId}' is beneath newer open rework '${latest.id}'. `
      + `Roll forward ${latest.id} first; checkpoints unwind newest-first.`,
      { code: 'REWORK_ROLL_FORWARD_ORDER_INVALID', details: { requested: changeRequestId, latest: latest.id } }
    );
  }
  const request = changeRequestId
    ? candidates.find((candidate) => candidate.id === changeRequestId) ?? null
    : latest;
  if (!request) {
    const qualifier = changeRequestId ? ` '${changeRequestId}'` : '';
    throw new SingularityFlowError(
      `No open rework change request${qualifier} has a forward checkpoint. `
      + 'Only phase returns recorded by this or a newer Singularity Flow build can be rolled forward safely.',
      { code: 'REWORK_FORWARD_CHECKPOINT_UNAVAILABLE' }
    );
  }
  const checkpoint = request.forwardCheckpoint;
  const expected = reworkCheckpointIntegrity(checkpoint);
  if (checkpoint.integrity?.sha256 !== expected) {
    throw new SingularityFlowError(`Rework checkpoint '${checkpoint.id}' failed its integrity check.`, {
      code: 'REWORK_FORWARD_CHECKPOINT_INVALID'
    });
  }
  return { request, checkpoint };
}

function verifiedReworkBaselineTree(root, checkpoint) {
  const readable = readRecord('rework-forward-checkpoint', checkpoint).record;
  const baseline = readable.worktreeBaseline;
  if (baseline?.kind !== 'git-tree' || !baseline.tree) {
    throw new SingularityFlowError(
      `Rework checkpoint '${checkpoint.id}' predates exact worktree baselines. `
      + 'Its rollback boundary cannot distinguish pre-existing developer changes from rework, so automatic roll-forward is refused. '
      + 'Keep the current files and resolve this legacy change request manually.',
      { code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE' }
    );
  }
  const resolved = run('git', ['rev-parse', '--verify', `${baseline.tree}^{tree}`], {
    cwd: root,
    allowFailure: true
  });
  if (resolved.status !== 0 || resolved.stdout.trim() !== baseline.tree) {
    throw new SingularityFlowError(
      `The exact local worktree baseline for checkpoint '${checkpoint.id}' is unavailable. `
      + 'No files were changed. Run this recovery from the checkout that recorded the phase return, or restore the local baseline ref.',
      { code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE' }
    );
  }
  if (baseline.ref) {
    const retained = exactReworkBaselineRef(root, baseline.ref);
    if (retained.kind !== 'direct' || retained.object !== baseline.tree) {
      throw new SingularityFlowError(
        `The retained local baseline ref for checkpoint '${checkpoint.id}' is missing or changed. No files were changed.`,
        { code: 'REWORK_FORWARD_BASELINE_UNAVAILABLE' }
      );
    }
  } else {
    const sourceTree = run('git', ['rev-parse', '--verify', `${checkpoint.sourceCommit}^{tree}`], {
      cwd: root,
      allowFailure: true
    });
    if (sourceTree.status !== 0 || sourceTree.stdout.trim() !== baseline.tree) {
      throw new SingularityFlowError(
        `Clean baseline for checkpoint '${checkpoint.id}' no longer matches its source commit. No files were changed.`,
        { code: 'REWORK_FORWARD_BASELINE_INVALID' }
      );
    }
  }
  return baseline.tree;
}

/**
 * Decisions made after a rework's checkpoint that rolling it forward would undo: it restores the
 * work item's files and its range's step records as they were, so an amendment approved since was
 * reverted while the records kept it (2026-10-28). A later return opens its own newer rework, and a
 * dismissal or accepted risk is not undone by it.
 */
export function decisionsSinceRework(workflow, request, checkpoint) {
  const since = Date.parse(request?.requestedAt ?? '');
  if (!Number.isFinite(since)) return [];
  const after = (value) => Date.parse(value ?? '') > since;
  const range = new Set(checkpoint?.state?.affectedPhaseIds ?? []);
  return [
    ...(workflow.intentAmendments ?? []).filter((entry) => entry?.status === 'approved' && after(entry.decidedAt))
      .map((entry) => `intent amendment ${entry.id}`),
    ...(workflow.forwardAmendmentDecisions ?? []).filter((entry) => entry?.decision === 'approved' && after(entry.at))
      .map((entry) => `amendment ${entry.amendment}`),
    ...(workflow.upstreamIssueDecisions ?? []).filter((entry) => ['amend', 'plan-correction'].includes(entry?.outcome) && after(entry.at))
      .map((entry) => `upstream issue ${entry.issue} (${entry.outcome})`),
    ...Object.values(workflow.phases ?? {}).filter((phase) => !range.has(phase.id) && phase.status === 'approved' && after(phase.approvedAt))
      .map((phase) => `the approval of ${phase.id}`)
  ];
}

/** A read-only, content-bound plan for abandoning the latest rework cone. */
export async function previewReworkRollForward(root, config, workflow, { changeRequestId = null } = {}) {
  const { request, checkpoint } = openReworkCheckpoint(workflow, changeRequestId);
  const newer = decisionsSinceRework(workflow, request, checkpoint);
  if (newer.length) {
    throw new SingularityFlowError(
      `Rolling ${request.id} forward would put back the files and step records from before ${newer.join(', ')}, undoing ${newer.length === 1 ? 'it' : 'them'}. Nothing was changed. `
      + 'Finish the rework round instead, or send the Story back with a reason.',
      { code: 'REWORK_ROLL_FORWARD_SUPERSEDED', details: { changeRequest: request.id, decisions: newer } }
    );
  }
  const baselineTree = verifiedReworkBaselineTree(root, checkpoint);
  const currentHead = head(root);
  const snapshot = await currentReworkTreeChangeSet(root, config, workflow, baselineTree, currentHead);
  const changeSet = snapshot.changeSet;
  const entries = [];
  for (const entry of changeSet.entries ?? []) {
    const endpoints = [entry.oldPath, entry.newPath].filter(Boolean);
    const scoped = endpoints.map((candidate) => reworkScopePath(config, workflow, candidate, {
      untracked: entry.untracked === true && candidate === entry.newPath
    }));
    if (!scoped.some(Boolean)) continue;
    if (scoped.some((value) => !value)) {
      throw new SingularityFlowError(
        `Rework change '${entry.changeId}' crosses the safe rollback boundary (${endpoints.join(' -> ')}). `
        + 'Move or commit that cross-boundary rename separately before rolling forward.',
        { code: 'REWORK_ROLL_FORWARD_SCOPE_CROSSING' }
      );
    }
    entries.push(structuredClone(entry));
  }
  const paths = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))].sort();
  const staged = new Set(run('git', ['diff', '--cached', '--name-only', '-z', 'HEAD', '--'], { cwd: root })
    .stdout.split('\0').filter(Boolean).map(posix));
  const plan = {
    schemaVersion: currentSchemaVersion('rework-roll-forward-plan'),
    workId: workflow.workItem.id,
    changeRequestId: request.id,
    checkpointId: checkpoint.id,
    checkpointSha256: checkpoint.integrity.sha256,
    sourceCommit: checkpoint.sourceCommit,
    sourcePhase: checkpoint.sourcePhase,
    targetPhase: checkpoint.targetPhase,
    baselineTree,
    currentHead,
    currentTree: snapshot.currentTree,
    paths,
    stagedPaths: paths.filter((candidate) => staged.has(candidate)),
    entries
  };
  return {
    ...plan,
    confirmation: `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`
  };
}

async function backupReworkPaths(root, workflow, preview) {
  const stamp = nowIso().replace(/[:.]/g, '-');
  const directory = path.join(
    gitCommonDir(root), 'singularity-flow', 'rework-backups',
    workflow.workItem.id, `${preview.changeRequestId}-${stamp}`
  );
  const filesDirectory = path.join(directory, 'files');
  await mkdir(filesDirectory, { recursive: true });
  const files = [];
  for (const relative of preview.paths) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info) {
      files.push({ path: relative, status: 'missing' });
      continue;
    }
    const destination = path.join(filesDirectory, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(absolute, destination, { recursive: true, force: false, verbatimSymlinks: true });
    files.push({ path: relative, status: 'saved', kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file' });
  }
  const manifest = {
    schemaVersion: currentSchemaVersion('rework-local-backup'),
    workId: workflow.workItem.id,
    changeRequestId: preview.changeRequestId,
    confirmation: preview.confirmation,
    checkpointCommit: preview.sourceCommit,
    capturedAt: nowIso(),
    files
  };
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  return directory;
}

async function restoreReworkPaths(root, preview) {
  if (!preview.paths.length) return;
  const present = new Set(run('git', [
    'ls-tree', '-r', '--name-only', '-z', preview.baselineTree, '--', ...preview.paths
  ], { cwd: root }).stdout.split('\0').filter(Boolean).map(posix));
  const restored = preview.paths.filter((candidate) => present.has(candidate));
  if (restored.length) {
    run('git', [
      'restore', '--source', preview.baselineTree, '--worktree',
      '--pathspec-from-file=-', '--pathspec-file-nul'
    ], { cwd: root, input: Buffer.from(`${restored.join('\0')}\0`) });
  }
  for (const relative of preview.paths.filter((candidate) => !present.has(candidate))) {
    await rm(path.join(root, relative), { recursive: true, force: true });
  }
}

/**
 * Re-establish review only when restoring the original immutable submission's exact evidence.
 */
async function refreshRestoredReview(root, config, workflow, at) {
  const phase = workflow.phases[workflow.currentPhase];
  if (phase?.status !== 'awaiting_approval') return null;
  const entry = [...(workflow.lineage?.submissions ?? [])].reverse().find((candidate) =>
    candidate.phase === phase.id && Number(candidate.generation) === Number(phase.generation));
  if (!entry) return null;
  const { readStoryReviewPacket, createStoryReviewPacket, reviewArtifactSetSha256 } = await import('./story-lineage.mjs');
  const original = await readStoryReviewPacket(root, config, workflow, entry.packetSha256);
  // A rejection may capture already-dirty work. Restoring that checkpoint is allowed, but it
  // cannot turn bytes that were never submitted into reviewed evidence. Keep the original packet
  // (and its normal approval refusals) unless every reviewed identity is restored exactly.
  if (original.phase !== phase.id || Number(original.generation) !== Number(phase.generation)
      || original.sourceTreeSha256 !== await sourceTreeHash(root, config, workflow)
      || original.submissionEvidence.checksSha256 !== createHash('sha256').update(JSON.stringify(phase.checks ?? [])).digest('hex')
      || original.submissionEvidence.artifactSetSha256 !== reviewArtifactSetSha256(phase.artifacts)) return null;
  for (const artifact of original.artifacts ?? []) {
    const actual = await repositoryArtifactSnapshot(root, artifact.path);
    if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) return null;
  }
  // Roll-forward is a new review boundary, not a bypass of the intervening-commit guard. Retain
  // the original immutable packet and approvals, then bind a fresh packet into this governed
  // publication; abandoned generation commits can no longer strand this restored review.
  for (const approval of phase.approvals ?? []) {
    if (!approval.invalidatedAt) approval.invalidatedAt = at;
  }
  phase.submittedAt = at;
  await updateArtifactMetadata(root, config, workflow, phase);
  await refreshRequiredArtifact(root, config, workflow, phase);
  await refreshSkillLifecycleArtifactIdentities(root, config, workflow, phase, { stage: 'submitted' });
  return createStoryReviewPacket(root, config, workflow, phase);
}

/**
 * Abandon rework by publishing the captured forward state, never resetting Git history.
 * The rejection and every abandoned generation remain immutable ancestors.
 */
export async function rollForwardRework(root, config, workflow, {
  changeRequestId = null,
  confirmation,
  channel = 'terminal',
  actionContext = null
} = {}) {
  await assertNoPendingPublication(root, config, workflow, 'roll forward abandoned rework');
  const preview = await previewReworkRollForward(root, config, workflow, { changeRequestId });
  if (!confirmation || confirmation !== preview.confirmation) {
    throw new SingularityFlowError(
      `Rework roll-forward requires the current change-set confirmation: --confirm ${preview.confirmation}.`,
      { code: 'REWORK_ROLL_FORWARD_CONFIRMATION_REQUIRED', details: { preview } }
    );
  }
  if (preview.stagedPaths.length) {
    throw new SingularityFlowError(
      `Rework roll-forward will not alter the existing Git index. Unstage these rework path(s), then preview again:\n- ${preview.stagedPaths.join('\n- ')}`,
      { code: 'REWORK_ROLL_FORWARD_STAGED_PATHS', details: { stagedPaths: preview.stagedPaths } }
    );
  }
  const { request, checkpoint } = openReworkCheckpoint(workflow, preview.changeRequestId);
  const session = await loadSession(root, { required: false }) ?? { actor: identity(root), agent: null };
  const sourcePhase = checkpoint.state.phases?.[checkpoint.sourcePhase] ?? workflow.phases[checkpoint.sourcePhase];
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    sourcePhase.approvalPolicy,
    session.actor
  );
  const backupPath = await backupReworkPaths(root, workflow, preview);
  await restoreReworkPaths(root, preview);

  const currentHistory = structuredClone(workflow.history ?? []);
  const rejectionDecisions = (workflow.phases?.[checkpoint.sourcePhase]?.approvals ?? [])
    .filter((decision) => decision.changeRequestId === request.id)
    .map((decision) => structuredClone(decision));
  workflow.status = checkpoint.state.status;
  workflow.currentPhase = checkpoint.state.currentPhase;
  workflow.workIntervals = structuredClone(checkpoint.state.workIntervals);
  workflow.repairBudgets = structuredClone(checkpoint.state.repairBudgets ?? {});
  if (checkpoint.state.lineage == null) delete workflow.lineage;
  else workflow.lineage = structuredClone(checkpoint.state.lineage);
  if (checkpoint.state.measurement == null) delete workflow.measurement;
  else workflow.measurement = structuredClone(checkpoint.state.measurement);
  if (checkpoint.state.spec == null) delete workflow.spec;
  else workflow.spec = structuredClone(checkpoint.state.spec);
  // Abandoning a reopen restores the finished Story exactly, with the final evaluation it passed,
  // so restoring it does not judge the old closure again under whatever rules apply today. A
  // checkpoint taken before this field existed keeps the earlier behaviour: evaluate again.
  if (checkpoint.state.completion == null) delete workflow.completion;
  else workflow.completion = structuredClone(checkpoint.state.completion);
  const abandonedGenerations = [];
  for (const phaseId of checkpoint.state.affectedPhaseIds) {
    const restoredGeneration = Number(checkpoint.state.phases[phaseId]?.generation ?? 0);
    for (const generation of new Set([
      Number(workflow.phases[phaseId]?.generation ?? 0),
      ...(workflow.phases[phaseId]?.generationPublications ?? []).map((entry) => Number(entry.generation))
    ])) {
      if (generation > restoredGeneration) abandonedGenerations.push({ phase: phaseId, generation });
    }
    const highWatermark = Math.max(
      Number(workflow.phases[phaseId]?.generation ?? 0),
      Number(workflow.phases[phaseId]?.generationHighWatermark ?? 0)
    );
    workflow.phases[phaseId] = structuredClone(checkpoint.state.phases[phaseId]);
    if (highWatermark > Number(workflow.phases[phaseId].generation ?? 0)) {
      workflow.phases[phaseId].generationHighWatermark = highWatermark;
    }
  }
  rebuildUsageAggregates(workflow);
  const rolledAt = nowIso();
  for (const decision of rejectionDecisions) {
    decision.invalidatedAt = rolledAt;
    decision.supersededAt = rolledAt;
    decision.supersededBy = 'rework-roll-forward';
    const approvals = workflow.phases[checkpoint.sourcePhase].approvals ??= [];
    if (!approvals.some((entry) => entry.changeRequestId === decision.changeRequestId && entry.at === decision.at)) approvals.push(decision);
  }
  request.status = 'abandoned';
  request.resolution = {
    status: 'abandoned',
    rolledForwardAt: rolledAt,
    rolledForwardBy: structuredClone(session.actor),
    agent: session.agent,
    channel,
    confirmation: preview.confirmation,
    restoredCommit: checkpoint.sourceCommit,
    restoredPhase: checkpoint.sourcePhase,
    abandonedGenerations,
    backup: { local: true, id: path.basename(backupPath) },
    ...(actionContext ? { actionContext } : {})
  };
  workflow.history = currentHistory;
  workflow.history.push({
    at: rolledAt,
    actor: actorKey(session.actor),
    agent: session.agent,
    event: 'rework_rolled_forward',
    phase: checkpoint.sourcePhase,
    detail: `${request.id} abandoned; restored ${preview.paths.length} path(s) and returned to ${checkpoint.sourcePhase}`
  });
  const restoredReview = await refreshRestoredReview(root, config, workflow, rolledAt);
  if (restoredReview) request.resolution.reviewPacketSha256 = restoredReview.packet.packetSha256;
  for (const phaseId of checkpoint.state.affectedPhaseIds) {
    await writeJson(approvalPath(root, config, workflow.workItem.id, phaseId), {
      schemaVersion: phaseApprovalSummaryVersion(workflow.phases[phaseId].approvals),
      phase: phaseId,
      decisions: workflow.phases[phaseId].approvals ?? []
    });
  }
  await saveWorkflow(root, config, workflow);
  return {
    request,
    checkpoint,
    preview,
    backupPath,
    restoredReview,
    actor: session.actor,
    agent: session.agent,
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance
  };
}

/**
 * Select a recorded design candidate and reopen the capture phase without
 * silently changing the approved source set. The caller publishes this mutation
 * through commitAndPublish; the next capture generation consumes the selection
 * and must be approved before downstream phases can proceed again.
 */
export async function promoteDesignSource(root, config, workflow, {
  candidateRecordId, reason = null, actor = null, agent = null, channel = 'terminal'
} = {}) {
  const configured = workflow.resolution?.designSources;
  if (!configured) throw new SingularityFlowError('This Story has no design-source policy.', { code: 'DESIGN_SOURCE_NOT_CONFIGURED' });
  const binding = approvedDesignSourceBinding(workflow);
  if (!binding) throw new SingularityFlowError('No approved design-source set exists to replace.', { code: 'DESIGN_SOURCE_APPROVAL_MISSING' });
  const evidence = await verifyMcpEvidence(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  if (evidence.errors.length) throw new SingularityFlowError(`Design-source evidence is not valid:\n- ${evidence.errors.join('\n- ')}`, { code: 'DESIGN_SOURCE_EVIDENCE_INVALID' });
  const candidate = classifyDesignSourceCandidates(evidence.records, binding)
    .find((entry) => entry.candidateRecordId === candidateRecordId);
  if (!candidate) throw new SingularityFlowError(`Design-source candidate '${candidateRecordId}' is not available against the approved set.`, { code: 'DESIGN_SOURCE_CANDIDATE_UNKNOWN' });
  const targetIndex = workflow.phaseOrder.indexOf(configured.capturePhase);
  if (targetIndex < 0) throw new SingularityFlowError(`Pinned design-source capture phase '${configured.capturePhase}' is missing.`);
  const timestamp = nowIso();
  // A promotion is not a rejection: the capture phase reopens without recording one.
  for (const id of resetPhaseRangeForRework(workflow, { targetId: configured.capturePhase, at: timestamp })) {
    await updateArtifactMetadata(root, config, workflow, workflow.phases[id]);
  }
  const capture = workflow.phases[configured.capturePhase];
  capture.designSourceSelection = { ...(capture.designSourceSelection ?? {}), [candidate.fileKey]: candidate.candidateRecordId };
  const record = {
    schemaVersion: 1, candidateRecordId: candidate.candidateRecordId, fileKey: candidate.fileKey,
    approvedRecordId: candidate.approvedRecordId, approvedVersion: candidate.approvedVersion,
    candidateVersion: candidate.candidateVersion, classification: candidate.classification,
    reason: reason?.trim() || 'Promote recorded design-source candidate.', promotedAt: timestamp,
    promotedBy: actor, agent, channel
  };
  workflow.designSourcePromotions ??= [];
  workflow.designSourcePromotions.push(record);
  workflow.history.push({
    at: timestamp, actor: actor ? actorKey(actor) : 'unknown', agent,
    event: 'design_source_promoted', phase: configured.capturePhase,
    detail: `${candidate.fileKey}: ${candidate.approvedVersion} -> ${candidate.candidateVersion} (${candidate.candidateRecordId})`
  });
  return { candidate, capturePhase: configured.capturePhase, invalidatedPhases: workflow.phaseOrder.slice(targetIndex), record };
}

/**
 * End a Story without claiming it was successfully completed.
 *
 * Cancellation is a terminal, audited lifecycle decision. It deliberately keeps the
 * Story directory, artifacts, approvals, and branch intact so the archived record
 * remains reconstructable from Git.
 */
export async function cancelWorkflow(root, config, workflow, { reason, channel = 'terminal', actionContext = null, session: chosenSession = null } = {}) {
  await assertNoPendingPublication(root, config, workflow, 'cancel work');
  if (workflow.status === 'cancelled') {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is already cancelled and archived.`);
  }
  if (workflow.status === 'closed' || workflow.currentPhase == null) {
    throw new SingularityFlowError(`Story '${workflow.workItem.id}' is closed; use reopen when it needs changes after closing.`);
  }
  const comment = String(reason ?? '').trim();
  if (!comment) throw new SingularityFlowError('A cancellation reason is required.');
  const phase = currentPhase(workflow);
  if (!phase) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no active phase to cancel.`);
  // A step SFlow runs itself (a verification, a convergence) ends the agent session, and cancel then
  // refused with "No active agent session"; the person's Git identity cancels, as reject does.
  const session = chosenSession ?? await loadSession(root, { required: false }) ?? { actor: identity(root), agent: null };
  assertPhaseAgentMayMutate(config, workflow, phase, session, 'cancel');
  const timestamp = nowIso();
  const record = {
    schemaVersion: 1,
    status: 'cancelled',
    phase: phase.id,
    generation: phase.generation,
    reason: comment,
    cancelledAt: timestamp,
    cancelledBy: session.actor,
    agent: session.agent ?? null,
    channel,
    ...(actionContext ? { actionContext } : {}),
    // The decision that waited after an approved step: that step keeps its approval in the history.
    ...(workflow.pendingDecision?.decision && phase.status === 'approved' ? { pendingDecision: workflow.pendingDecision.decision } : {})
  };
  if (phase.status !== 'approved') phase.status = 'cancelled';
  phase.cancelledAt = timestamp;
  phase.cancelledBy = session.actor;
  phase.cancellationReason = comment;
  delete workflow.pendingDecision;
  workflow.status = 'cancelled';
  workflow.currentPhase = null;
  workflow.cancellation = record;
  workflow.history.push({
    at: timestamp,
    actor: actorKey(session.actor),
    agent: session.agent,
    event: 'work_cancelled',
    phase: phase.id,
    detail: comment
  });
  await updateArtifactMetadata(root, config, workflow, phase);
  await saveWorkflow(root, config, workflow);
  return { phase, cancellation: record };
}

const SKILL_AMENDMENT_SHA = /^sha256:[a-f0-9]{64}$/u;
const SKILL_AMENDMENT_ID = /^SAM-[0-9]{3,6}$/u;

function skillAmendmentDigest(value) { return `sha256:${recordSha256(value)}`; }

function skillAmendmentPath(config, workflow, id, suffix) {
  if (!SKILL_AMENDMENT_ID.test(id)) {
    throw new SingularityFlowError('Invalid skill-version amendment identity.', {
      code: 'SKP_AMENDMENT_INVALID'
    });
  }
  return `${workDirRelative(config, workflow.workItem.id)}/context/skill-amendments/${id}-${suffix}.json`;
}

function skillAmendmentFail(code, message) {
  throw new SingularityFlowError(message, { code });
}

function skillAmendmentActorSnapshot(root) {
  const actor = identity(root);
  // Exact consent binds the human identity, not whether the GitHub lookup cache was warm.
  // Always re-read identity: real name/email/login changes must still invalidate the plan.
  // Historical immutable actors remain byte-exact; this shapes only newly reviewed records.
  return { name: actor.name, email: actor.email, login: actor.login };
}

function skillAmendmentActorKeys(actor) {
  const email = String(actor?.email ?? '').trim().toLowerCase();
  const login = String(actor?.login ?? actor?.githubLogin ?? '').trim().toLowerCase();
  return [email && `email:${email}`, login && `github:${login}`].filter(Boolean);
}

function skillAmendmentSameHuman(left, right) {
  const keys = new Set(skillAmendmentActorKeys(left));
  return skillAmendmentActorKeys(right).some((key) => keys.has(key));
}

function assertSelectableSkillAmendmentReopen(workflow, impact) {
  for (const phaseId of impact.affectedPhaseIds ?? []) {
    const phase = workflow.phases?.[phaseId];
    if (!phase || phase.generationPolicy?.requirement === 'none') {
      skillAmendmentFail('SKP_AMENDMENT_DEPENDENCY_UNPROVEN',
        `Affected phase '${phaseId}' has no publishable generation for reviewed revalidation.`);
    }
  }
  const first = Math.min(...impact.affectedPhaseIds.map((phaseId) =>
    workflow.phaseOrder.indexOf(phaseId)));
  if (!Number.isInteger(first) || first < 0) {
    skillAmendmentFail('SKP_AMENDMENT_DEPENDENCY_UNPROVEN',
      'The affected phase cannot be located in the accepted Story order.');
  }
  const activeEarlier = workflow.phaseOrder.slice(0, first)
    .filter((phaseId) => ['in_progress', 'awaiting_approval'].includes(
      workflow.phases[phaseId]?.status));
  if (activeEarlier.length) {
    skillAmendmentFail('SKP_AMENDMENT_SEQUENCE_UNSAFE',
      `Finish active predecessor phase(s) before adopting a later skill: ${activeEarlier.join(', ')}.`);
  }
  const activePreserved = workflow.phaseOrder.slice(first)
    .filter((phaseId) => impact.preservedPhaseIds.includes(phaseId)
      && ['in_progress', 'awaiting_approval'].includes(workflow.phases[phaseId]?.status));
  if (activePreserved.length) {
    skillAmendmentFail('SKP_AMENDMENT_ACTIVE_PRESERVED_PHASE',
      `Cannot reopen an earlier skill while preserving active phase(s): ${activePreserved.join(', ')}. `
      + 'Finish or explicitly rework those phases before adopting the new version.');
  }
  return first;
}

function skillAmendmentBindings(resolution, skillId) {
  return resolution.phases.filter((phase) => phase.kind === 'skill'
    && phase.skillBinding?.bindingRefs?.skill?.id === skillId).map((phase) => {
    const refs = phase.skillBinding.bindingRefs;
    return {
      phaseId: phase.id, contractSha256: refs.contractSha256,
      compilationSha256: phase.skillBinding.compilationSha256,
      parserProfile: phase.skillBinding.parserProfile,
      bindingRefsSha256: `sha256:${createHash('sha256')
        .update('skp.binding-refs.v1\0').update(canonicalJson(refs)).digest('hex')}`
    };
  });
}

function skillAmendmentPolicy(workflow, skillId) {
  const selected = workflow.resolution?.phases?.filter((phase) => phase.kind === 'skill'
    && phase.skillBinding?.bindingRefs?.skill?.id === skillId) ?? [];
  if (!selected.length || selected.some((phase) =>
    canonicalJson(phase.approval) !== canonicalJson(selected[0].approval))
      || selected[0].approval?.mode !== 'required') {
    skillAmendmentFail('SKP_AMENDMENT_UNSUPPORTED',
      'Skill-version adoption requires selected phases with one pinned required human approval policy.');
  }
  return selected[0].approval;
}

/** Build only the skill binding delta; no live YAML or unrelated phase policy enters the Story. */
async function skillAmendmentCandidate(root, config, workflow, skillId, approvedConfigurationSnapshot) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(skillId ?? ''))
      || !approvedConfigurationSnapshot) {
    skillAmendmentFail('SKP_AMENDMENT_INVALID',
      'Select one skill and an exact verified approved configuration snapshot.');
  }
  const accepted = await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true, retainBytes: true
  });
  if (!accepted.enrolled || !accepted.policy
      || canonicalJson(accepted.policy) !== canonicalJson(workflow.resolution)) {
    skillAmendmentFail('SKP_AMENDMENT_STALE', 'The Story no longer matches its accepted skill snapshot.');
  }
  const selectedIds = new Set(workflow.resolution.phases.filter((phase) => phase.kind === 'skill')
    .map((phase) => phase.skillBinding?.bindingRefs?.skill?.id));
  if (!selectedIds.has(skillId)) {
    skillAmendmentFail('SKP_AMENDMENT_UNSUPPORTED',
      'The selected skill is not pinned by this Story.');
  }
  const prior = workflow.resolution.phases.find((phase) => phase.kind === 'skill'
    && phase.skillBinding?.bindingRefs?.skill?.id === skillId);
  const priorPackageSha256 = prior.skillBinding.bindingRefs.skill.packageSha256;
  const newPackage = await inspectApprovedSkillPackage(approvedConfigurationSnapshot, skillId);
  const packageSha256 = newPackage.manifest.packageSha256;
  const sourceCommit = approvedConfigurationSnapshot.sourceCommit;
  const sourceRemote = approvedConfigurationSnapshot.authority?.remote;
  const previousSource = workflow.resolution.configurationSource;
  if (packageSha256 === priorPackageSha256 || !/^[a-f0-9]{40,64}$/u.test(sourceCommit ?? '')
      || sourceCommit === previousSource?.commit || sourceRemote !== previousSource?.repository) {
    skillAmendmentFail('SKP_AMENDMENT_STALE',
      'The approved candidate must select a newer skill package from the same configuration authority.');
  }
  const configurationAncestry = await captureSkillConfigurationAncestry(
    approvedConfigurationSnapshot, previousSource);
  const resolved = resolveApprovedStoryWorkType(approvedConfigurationSnapshot,
    workflow.workItem.workType);
  if (canonicalJson(resolved.phases.map((phase) => phase.id))
      !== canonicalJson(workflow.phaseOrder)) {
    skillAmendmentFail('SKP_AMENDMENT_UNSUPPORTED',
      'The approved candidate changes the Story phase topology. Use a new Story.');
  }
  const proposedResolution = structuredClone(workflow.resolution);
  for (const [index, priorPhase] of proposedResolution.phases.entries()) {
    if (priorPhase.kind !== 'skill'
        || priorPhase.skillBinding?.bindingRefs?.skill?.id !== skillId) continue;
    const selected = resolved.phases[index];
    if (selected?.id !== priorPhase.id || selected.kind !== 'skill'
        || selected.skillBinding?.bindingRefs?.skill?.id !== skillId
        || selected.skillBinding.bindingRefs.skill.packageSha256 !== packageSha256) {
      skillAmendmentFail('SKP_AMENDMENT_UNSUPPORTED',
        `Approved configuration has no exact replacement binding for '${priorPhase.id}'.`);
    }
    priorPhase.skillBinding = structuredClone(selected.skillBinding);
  }
  proposedResolution.configurationSource = {
    ...structuredClone(previousSource), commit: sourceCommit,
    // A new approved source is not yet materialized in the Story checkout; its exact WFA
    // package closure, not the old materialization receipt, supplies the new authority.
    filesSha256: null
  };
  proposedResolution.policySha256 = resolutionPolicySha256(proposedResolution);
  const impact = planSkillAmendmentEvidence(workflow.resolution, {
    replacedSkillIds: [skillId]
  });
  if (impact.status !== 'ready') {
    skillAmendmentFail('SKP_AMENDMENT_DEPENDENCY_UNPROVEN',
      `Selective evidence impact is unproven: ${impact.unknown.map((entry) => `${entry.phaseId}: ${entry.reason}`).join('; ')}`);
  }
  assertSelectableSkillAmendmentReopen(workflow, impact);
  skillAmendmentPolicy(workflow, skillId);
  return { accepted, proposedResolution, impact, packageSha256, sourceCommit, configurationAncestry,
    priorPackageSha256 };
}

/** Read-only, exact plan. Mutations recompute this digest after the subject lock is held. */
export async function previewStorySkillVersionProposal(root, config, workflow, {
  skillId, approvedConfigurationSnapshot, reason
} = {}) {
  if (!String(reason ?? '').trim() || [...String(reason)].length > 4096) {
    skillAmendmentFail('SKP_AMENDMENT_REASON_REQUIRED',
      'A skill-version adoption proposal requires a human-readable reason of at most 4096 characters.');
  }
  if ((workflow.skillVersionAmendments ?? []).some((entry) => entry.status === 'proposed')) {
    skillAmendmentFail('SKP_AMENDMENT_PENDING',
      'Finish or reject the existing skill-version proposal before opening another.');
  }
  const candidate = await skillAmendmentCandidate(root, config, workflow, skillId,
    approvedConfigurationSnapshot);
  const actor = skillAmendmentActorSnapshot(root);
  if (!skillAmendmentActorKeys(actor).length) {
    skillAmendmentFail('SKP_AMENDMENT_IDENTITY_UNAVAILABLE', 'Configure a Git email or login first.');
  }
  const next = Math.max(0, ...(workflow.skillVersionAmendments ?? []).map((entry) =>
    Number(String(entry.id).slice(4)) || 0)) + 1;
  if (next > 999999) skillAmendmentFail('SKP_AMENDMENT_LIMIT', 'Too many Story skill amendments.');
  const proposalId = `SAM-${String(next).padStart(3, '0')}`;
  const impactRecord = {
    schemaVersion: currentSchemaVersion('skill-version-adoption-impact'),
    kind: 'skill-version-adoption-impact', proposalId,
    workId: workflow.workItem.id, ...candidate.impact
  };
  const impactSha256 = skillAmendmentDigest(impactRecord);
  const proposal = {
    schemaVersion: currentSchemaVersion('skill-version-adoption-proposal'),
    kind: 'skill-version-adoption-proposal', id: proposalId,
    workId: workflow.workItem.id, skillId, proposedBy: structuredClone(actor),
    reason: String(reason).trim(), impactSha256,
    from: {
      revision: workflow.workflowSnapshot.revision,
      snapshotHash: workflow.workflowSnapshot.snapshotHash,
      policySha256: workflow.resolution.policySha256
    },
    to: {
      configurationCommit: candidate.sourceCommit,
      packageSha256: candidate.packageSha256,
      policySha256: candidate.proposedResolution.policySha256,
      phaseBindings: skillAmendmentBindings(candidate.proposedResolution, skillId)
    }
  };
  const proposalSha256 = skillAmendmentDigest(proposal);
  if (Buffer.byteLength(canonicalJson(proposal)) > 256 * 1024
      || Buffer.byteLength(canonicalJson(impactRecord)) > 256 * 1024) {
    skillAmendmentFail('SKP_AMENDMENT_LIMIT',
      'The review proposal or dependency impact exceeds the supported 256 KiB record ceiling.');
  }
  const planSha256 = skillAmendmentDigest({
    operation: 'skill-version.propose', gitHead: head(root),
    configurationAncestrySha256: skillAmendmentDigest(candidate.configurationAncestry),
    proposalSha256, impactSha256, workflowSnapshot: workflow.workflowSnapshot
  });
  return {
    schemaVersion: 1, status: 'ready', proposalId, planSha256,
    proposalSha256, impactSha256, proposal, impact: impactRecord,
    affectedPhaseIds: candidate.impact.affectedPhaseIds,
    preservedPhaseIds: candidate.impact.preservedPhaseIds
  };
}

export async function proposeStorySkillVersion(root, config, workflow, options = {}) {
  const { confirmPreviewDigest, ...selection } = options;
  const preview = await previewStorySkillVersionProposal(root, config, workflow, selection);
  if (!SKILL_AMENDMENT_SHA.test(confirmPreviewDigest ?? '')
      || confirmPreviewDigest !== preview.planSha256) {
    skillAmendmentFail('SKP_AMENDMENT_PREVIEW_STALE',
      'Skill-version proposal confirmation differs from the current exact preview.');
  }
  const result = await commitAndPublish(root, config, workflow, {
    type: LIFECYCLE_EVENT.SKILL_AMENDMENT_PROPOSED,
    phaseId: workflow.currentPhase,
    payload: { proposalId: preview.proposalId, proposalSha256: preview.proposalSha256,
      impactSha256: preview.impactSha256 }
  }, `[${workflow.workItem.id}][skill-version:propose] ${preview.proposalId}`, [], {
    beforeStateWrite: async () => {
      const live = await previewStorySkillVersionProposal(root, config, workflow, selection);
      if (live.planSha256 !== confirmPreviewDigest) {
        skillAmendmentFail('SKP_AMENDMENT_PREVIEW_STALE',
          'Story, approved package, or Git parent changed since the reviewed preview.');
      }
      for (const [suffix, reviewPayload] of [['impact', live.impact], ['proposal', live.proposal]]) {
        const relative = skillAmendmentPath(config, workflow, live.proposalId, suffix);
        const safe = await secureRepositoryPath(root, relative, { label: 'Story skill-version review record' });
        if (safe.exists) skillAmendmentFail('SKP_AMENDMENT_CONFLICT',
          `Skill-version review record already exists: ${relative}.`);
        await mkdir(path.dirname(safe.absolute), { recursive: true });
        await writeText(safe.absolute, canonicalJson(reviewPayload));
      }
      const at = nowIso();
      workflow.schemaVersion = currentSchemaVersion('story-workflow');
      workflow.skillVersionAmendments ??= [];
      workflow.skillVersionAmendments.push({
        schemaVersion: currentSchemaVersion('skill-version-adoption-summary'),
        id: live.proposalId, status: 'proposed', skillId: selection.skillId,
        proposalPath: skillAmendmentPath(config, workflow, live.proposalId, 'proposal'),
        proposalSha256: live.proposalSha256,
        impactPath: skillAmendmentPath(config, workflow, live.proposalId, 'impact'),
        impactSha256: live.impactSha256,
        from: live.proposal.from,
        to: { configurationCommit: live.proposal.to.configurationCommit,
          packageSha256: live.proposal.to.packageSha256 },
        proposedBy: live.proposal.proposedBy, proposedAt: at, approvals: [],
        affectedPhaseIds: live.affectedPhaseIds,
        preservedPhaseIds: live.preservedPhaseIds
      });
      workflow.history.push({ at, actor: actorKey(live.proposal.proposedBy),
        event: 'skill_version_proposed', phase: workflow.currentPhase,
        detail: `${live.proposalId}: ${selection.skillId} ${live.proposal.to.packageSha256}` });
      return { proposalId: live.proposalId, proposalSha256: live.proposalSha256 };
    }
  });
  return { ...result, proposalId: preview.proposalId, proposalSha256: preview.proposalSha256 };
}

async function committedSkillAmendmentRecord(root, relative, claimedSha256, label, family) {
  if (!SKILL_AMENDMENT_SHA.test(claimedSha256 ?? '')) {
    skillAmendmentFail('SKP_AMENDMENT_INVALID', `${label} has no exact committed SHA-256.`);
  }
  const bytes = exactFileAtObject(root, head(root), relative, { maximumBytes: 512 * 1024 });
  if (!bytes || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== claimedSha256) {
    skillAmendmentFail('SKP_AMENDMENT_STALE',
      `${label} is absent or differs from its committed Story review record.`);
  }
  const local = await secureRepositoryPath(root, relative, {
    label, mustExist: true, type: 'file'
  });
  const localBytes = await readFile(local.absolute);
  if (!localBytes.equals(bytes)) {
    skillAmendmentFail('SKP_AMENDMENT_STALE',
      `${label} has uncommitted changes; only the accepted exact bytes may be reviewed.`);
  }
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { skillAmendmentFail('SKP_AMENDMENT_INVALID', `${label} is not valid UTF-8 JSON.`); }
  try { readRecord(family, parsed); }
  catch { skillAmendmentFail('SKP_AMENDMENT_INVALID', `${label} has no supported registered reader.`); }
  if (canonicalJson(parsed) !== bytes.toString('utf8')) {
    skillAmendmentFail('SKP_AMENDMENT_INVALID', `${label} is not the exact canonical review record.`);
  }
  return parsed;
}

/** A read-only decision preview binds the current Git actor, exact proposal and authority sets. */
export async function previewStorySkillVersionDecision(root, config, workflow, {
  proposalId, decision, approvedConfigurationSnapshot, reason = null
} = {}) {
  if (!SKILL_AMENDMENT_ID.test(String(proposalId ?? ''))
      || !['approve', 'reject'].includes(decision)
      || [...String(reason ?? '')].length > 4096) {
    skillAmendmentFail('SKP_AMENDMENT_DECISION_INVALID',
      'Select a pending SAM proposal and approve or reject it, with a reason of at most 4096 characters.');
  }
  const summary = (workflow.skillVersionAmendments ?? []).find((entry) => entry.id === proposalId);
  if (!summary || summary.status !== 'proposed') {
    skillAmendmentFail('SKP_AMENDMENT_NOT_PENDING',
      `Skill-version proposal '${proposalId}' is not awaiting a human decision.`);
  }
  if (summary.proposalPath !== skillAmendmentPath(config, workflow, proposalId, 'proposal')
      || summary.impactPath !== skillAmendmentPath(config, workflow, proposalId, 'impact')) {
    skillAmendmentFail('SKP_AMENDMENT_INVALID', 'Skill-version review paths differ from their Story slots.');
  }
  const proposal = await committedSkillAmendmentRecord(root, summary.proposalPath,
    summary.proposalSha256, 'Skill-version proposal', 'skill-version-adoption-proposal');
  const impact = await committedSkillAmendmentRecord(root, summary.impactPath,
    summary.impactSha256, 'Skill-version impact', 'skill-version-adoption-impact');
  if (proposal.id !== proposalId || proposal.workId !== workflow.workItem.id
      || proposal.skillId !== summary.skillId
      || proposal.impactSha256 !== summary.impactSha256
      || impact.proposalId !== proposalId || impact.workId !== workflow.workItem.id
      || impact.status !== 'ready'
      || canonicalJson(proposal.from) !== canonicalJson(summary.from)
      || proposal.to.configurationCommit !== summary.to.configurationCommit
      || proposal.to.packageSha256 !== summary.to.packageSha256
      || canonicalJson(impact.affectedPhaseIds) !== canonicalJson(summary.affectedPhaseIds)
      || canonicalJson(impact.preservedPhaseIds) !== canonicalJson(summary.preservedPhaseIds)
      || canonicalJson(proposal.proposedBy) !== canonicalJson(summary.proposedBy)
      || proposal.from.revision !== workflow.workflowSnapshot?.revision
      || proposal.from.snapshotHash !== workflow.workflowSnapshot?.snapshotHash
      || proposal.from.policySha256 !== workflow.resolution?.policySha256) {
    skillAmendmentFail('SKP_AMENDMENT_STALE',
      'The committed proposal, impact, and current Story pin no longer agree.');
  }
  if (approvedConfigurationSnapshot?.authority?.remote
      !== workflow.resolution?.configurationSource?.repository) {
    skillAmendmentFail('SKP_AMENDMENT_AUTHORITY_CHANGED',
      'The current approved reviewer authority is not the Story’s pinned configuration repository.');
  }
  // Rejection closes a pending review without adopting bytes. It must remain possible when the
  // proposed package has since moved or disappeared. Approval, by contrast, re-proves the exact
  // candidate and impact before any revision can be recorded.
  if (decision === 'approve') {
    const candidate = await skillAmendmentCandidate(root, config, workflow,
      summary.skillId, approvedConfigurationSnapshot);
    const { kind: _kind, proposalId: _id,
      workId: _work, ...persistedImpact } = impact;
    if (candidate.sourceCommit !== proposal.to.configurationCommit
        || candidate.packageSha256 !== proposal.to.packageSha256
        || candidate.proposedResolution.policySha256 !== proposal.to.policySha256
        || canonicalJson(skillAmendmentBindings(candidate.proposedResolution, summary.skillId))
          !== canonicalJson(proposal.to.phaseBindings)
        || canonicalJson(candidate.impact) !== canonicalJson(persistedImpact)) {
      skillAmendmentFail('SKP_AMENDMENT_STALE',
        'The exact approved package or dependency impact changed after proposal.');
    }
  } else {
    const accepted = await verifyWorkflowSnapshot(root, config, workflow, {
      requireAccepted: true, retainBytes: true
    });
    if (!accepted.enrolled || !accepted.policy
        || canonicalJson(accepted.policy) !== canonicalJson(workflow.resolution)) {
      skillAmendmentFail('SKP_AMENDMENT_STALE',
        'The Story no longer matches its accepted skill snapshot.');
    }
  }
  const currentAuthorities = approvedStoryApprovalAuthorities(approvedConfigurationSnapshot);
  const actor = skillAmendmentActorSnapshot(root);
  if (!skillAmendmentActorKeys(actor).length
      || (summary.approvals ?? []).some((entry) => skillAmendmentSameHuman(entry.actor, actor))) {
    skillAmendmentFail('SKP_AMENDMENT_REVIEWER_INELIGIBLE',
      'A distinct configured Git identity is required for each skill-version decision.');
  }
  const policy = skillAmendmentPolicy(workflow, summary.skillId);
  for (const [index, previous] of (summary.approvals ?? []).entries()) {
    const path = skillAmendmentPath(config, workflow, proposalId,
      `review-${String(index + 1).padStart(3, '0')}`);
    if (previous.reviewPath !== path) {
      skillAmendmentFail('SKP_AMENDMENT_INVALID',
        'A prior reviewer record is outside its immutable Story slot.');
    }
    const recorded = await committedSkillAmendmentRecord(root, path,
      previous.reviewSha256, 'Prior skill-version review', 'skill-version-adoption-review');
    if (recorded.decision !== 'approve'
        || recorded.proposalSha256 !== summary.proposalSha256
        || recorded.impactSha256 !== summary.impactSha256
        || canonicalJson(recorded.actor) !== canonicalJson(previous.actor)
        || recorded.authorityGroup !== previous.authorityGroup
        || recorded.identityAssurance !== previous.identityAssurance
        || recorded.at !== previous.at) {
      skillAmendmentFail('SKP_AMENDMENT_STALE',
        'A prior approval no longer matches its committed reviewer record.');
    }
    if (decision === 'approve') {
      const stillAuthorized = requireApprovalAuthority(
        currentAuthorities,
        policy, previous.actor, { preferredAuthorities: [previous.authorityGroup] });
      if (stillAuthorized.authorityGroup !== previous.authorityGroup) {
        skillAmendmentFail('SKP_AMENDMENT_AUTHORITY_CHANGED',
          'A prior reviewer no longer holds the approved configuration authority group.');
      }
    }
  }
  if (policy.allowSelfApproval === false && skillAmendmentSameHuman(summary.proposedBy, actor)) {
    skillAmendmentFail('SKP_AMENDMENT_REVIEWER_INELIGIBLE',
      'The pinned phase policy prohibits proposer self-approval.');
  }
  const pinned = requireApprovalAuthority(workflow.resolution.approvalAuthorities,
    policy, actor);
  const current = requireApprovalAuthority(currentAuthorities,
    policy, actor, { preferredAuthorities: [pinned.authorityGroup] });
  if (current.authorityGroup !== pinned.authorityGroup) {
    skillAmendmentFail('SKP_AMENDMENT_AUTHORITY_CHANGED',
      'The reviewer no longer holds the pinned authority group in approved configuration.');
  }
  const approvals = [...summary.approvals.map((entry) => ({ ...entry,
    decision: 'approved' })), {
    actor, authorityGroup: pinned.authorityGroup,
    identityAssurance: pinned.identityAssurance, at: nowIso(), decision: 'approved'
  }];
  const willApply = decision === 'approve' && approvalRequirementsMet(policy, approvals);
  const planSha256 = skillAmendmentDigest({
    operation: 'skill-version.decide', gitHead: head(root), proposalId, decision,
    reason: String(reason ?? '').trim() || null,
    proposalSha256: summary.proposalSha256,
    impactSha256: summary.impactSha256,
    approvedConfigurationCommit: approvedConfigurationSnapshot.sourceCommit,
    actor, authorityGroup: pinned.authorityGroup,
    priorApprovals: summary.approvals,
    willApply, workflowSnapshot: workflow.workflowSnapshot
  });
  return { schemaVersion: 1, status: 'ready', proposalId, decision, planSha256,
    actor, authorityGroup: pinned.authorityGroup,
    identityAssurance: pinned.identityAssurance, willApply,
    proposalSha256: summary.proposalSha256, impactSha256: summary.impactSha256,
    affectedPhaseIds: summary.affectedPhaseIds,
    preservedPhaseIds: summary.preservedPhaseIds };
}

export function storySkillVersionStatus(workflow) {
  return {
    schemaVersion: 1, resultType: 'skill-version-adoption-status',
    workId: workflow.workItem.id,
    snapshotRevision: workflow.workflowSnapshot?.revision ?? null,
    selectedPackages: [...new Map((workflow.resolution?.phases ?? [])
      .filter((phase) => phase.kind === 'skill')
      .map((phase) => [phase.skillBinding?.bindingRefs?.skill?.id,
        phase.skillBinding?.bindingRefs?.skill?.packageSha256]))]
      .map(([skillId, packageSha256]) => ({ skillId, packageSha256 })),
    proposals: structuredClone(workflow.skillVersionAmendments ?? [])
  };
}

/** Reopen only proven affected phases; retained independent decisions are never rewritten. */
export function applySkillAmendmentSelectiveReopen(workflow, amendment, at) {
  const first = assertSelectableSkillAmendmentReopen(workflow, amendment);
  const affectedSet = new Set(amendment.affectedPhaseIds);
  for (const phaseId of amendment.affectedPhaseIds) {
    const phase = workflow.phases[phaseId];
    const index = workflow.phaseOrder.indexOf(phaseId);
    for (const item of phase.approvals ?? []) {
      if (!item.invalidatedAt) item.invalidatedAt = at;
    }
    phase.status = index === first ? 'in_progress' : 'not_started';
    phase.submittedAt = null; phase.approvedAt = null; phase.approvedBy = null;
    phase.submissionArchitectureDecision = null;
    clearApprovalDisposition(phase);
    delete phase.retention;
    clearDecisionState(phase);
    resetDecisionRounds(workflow, [phaseId]);
    if (workflow.pendingDecision?.after === phaseId) delete workflow.pendingDecision;
    phase.skillAmendmentRevalidation = {
      id: amendment.id, state: 'affected', adoptedAt: at,
      generationAtAdoption: phase.generation
    };
  }
  // No loop over preservedPhaseIds here: receipts, approvals, and even phase status remain
  // byte-identical. The linear transition owner skips preserved approved phases later.
  if (!affectedSet.has(workflow.phaseOrder[first])) {
    skillAmendmentFail('SKP_AMENDMENT_DEPENDENCY_UNPROVEN',
      'The first reopened phase is not in the accepted impact set.');
  }
  workflow.currentPhase = workflow.phaseOrder[first];
  workflow.status = 'in_progress';
  // A closed Story adopting a skill version kept its old completion, so the next ending skipped its
  // final evaluation and printed the old "passed" (2026-10-28).
  delete workflow.completion;
  return workflow.currentPhase;
}

/**
 * The generation baseline is lifecycle authority, not an optional display field. A local edit
 * could otherwise remove it while leaving the accepted WFA reference and an old publication in
 * place. Anchor every affected phase's marker to the exact Story record in the verified revision
 * acceptance commit; later ordinary lifecycle commits may advance generation but cannot rewrite
 * or erase that baseline.
 */
export async function verifyAcceptedSkillAmendmentRevalidation(root, config, workflow,
  verifiedSnapshot = null) {
  if (Number(workflow.workflowSnapshot?.revision ?? 1) <= 1) return;
  const verified = verifiedSnapshot ?? await verifyWorkflowSnapshot(root, config, workflow, {
    requireAccepted: true
  });
  const commit = verified.acceptanceCommit;
  if (!/^[a-f0-9]{40,64}$/u.test(commit ?? '')) {
    skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
      'The accepted skill-version revision has no immutable Story acceptance commit.');
  }
  const relative = `${workDirRelative(config, workflow.workItem.id)}/workflow.json`;
  const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024 });
  let accepted;
  try {
    if (!bytes) throw new Error('missing accepted Story record');
    accepted = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
      'The accepted skill-version Story record cannot be read exactly.');
  }
  if (canonicalJson(accepted.workflowSnapshot) !== canonicalJson(workflow.workflowSnapshot)) {
    skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
      'The Story no longer selects its accepted skill-version revision.');
  }
  const approved = accepted.skillVersionAmendments?.filter((item) => item?.status === 'approved');
  if (!approved?.length) {
    if (accepted.testCommandAmendments?.length || accepted.approverRefreshes?.length) return verified;
    skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
      'The accepted skill-version revision has no reviewed affected-phase record.');
  }
  const mostRecentForPhase = new Map();
  for (const amendment of approved) {
    for (const phaseId of amendment.affectedPhaseIds ?? []) {
      mostRecentForPhase.set(phaseId, amendment);
    }
  }
  if (!mostRecentForPhase.size) {
    skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
      'The accepted skill-version revision has no affected phases to revalidate.');
  }
  const newestId = approved.at(-1).id;
  for (const [phaseId, amendment] of mostRecentForPhase) {
    const anchoredPhase = accepted.phases?.[phaseId];
    const marker = anchoredPhase?.skillAmendmentRevalidation;
    const expected = {
      id: amendment.id, state: 'affected', adoptedAt: amendment.decidedAt,
      generationAtAdoption: marker?.generationAtAdoption
    };
    if (!anchoredPhase || !Number.isSafeInteger(marker?.generationAtAdoption)
        || marker.generationAtAdoption < 0
        || !Number.isSafeInteger(anchoredPhase.generation)
        || marker.generationAtAdoption > anchoredPhase.generation
        || (amendment.id === newestId
          && marker.generationAtAdoption !== anchoredPhase.generation)
        || canonicalJson(marker) !== canonicalJson(expected)
        || canonicalJson(workflow.phases?.[phaseId]?.skillAmendmentRevalidation)
          !== canonicalJson(marker)) {
      skillAmendmentFail('SKP_AMENDMENT_REVALIDATION_INVALID',
        `Phase '${phaseId}' revalidation baseline differs from its accepted skill-version amendment.`);
    }
  }
  return verified;
}

export async function decideStorySkillVersion(root, config, workflow, options = {}) {
  if (Object.hasOwn(options, 'actor') || Object.hasOwn(options, 'approvals')) {
    skillAmendmentFail('SKP_AMENDMENT_REVIEWER_INELIGIBLE',
      'Reviewer identities and approvals are read from current Git authority, not caller input.');
  }
  const { confirmPreviewDigest, ...selection } = options;
  const preview = await previewStorySkillVersionDecision(root, config, workflow, selection);
  if (!SKILL_AMENDMENT_SHA.test(confirmPreviewDigest ?? '')
      || confirmPreviewDigest !== preview.planSha256) {
    skillAmendmentFail('SKP_AMENDMENT_PREVIEW_STALE',
      'Skill-version decision confirmation differs from the current exact preview.');
  }
  const eventType = selection.decision === 'reject'
    ? LIFECYCLE_EVENT.SKILL_AMENDMENT_REJECTED : LIFECYCLE_EVENT.SKILL_AMENDMENT_APPROVED;
  let applied = false;
  let newReference = null;
  try {
    const publication = await commitAndPublish(root, config, workflow, {
      type: eventType, phaseId: workflow.currentPhase,
      actor: preview.actor, authorityGroup: preview.authorityGroup,
      payload: { proposalId: preview.proposalId, decision: selection.decision,
        proposalSha256: preview.proposalSha256, impactSha256: preview.impactSha256,
        willApply: preview.willApply }
    }, `[${workflow.workItem.id}][skill-version:${selection.decision}] ${preview.proposalId}`, [], {
      beforeStateWrite: async () => {
        const live = await previewStorySkillVersionDecision(root, config, workflow, selection);
        if (live.planSha256 !== confirmPreviewDigest) {
          skillAmendmentFail('SKP_AMENDMENT_PREVIEW_STALE',
            'Story, reviewer authority, or approved package changed since the reviewed preview.');
        }
        const summary = workflow.skillVersionAmendments.find((entry) =>
          entry.id === live.proposalId);
        const priorWorkflow = structuredClone(workflow);
        const at = nowIso();
        workflow.schemaVersion = currentSchemaVersion('story-workflow');
        const review = {
          schemaVersion: currentSchemaVersion('skill-version-adoption-review'),
          kind: 'skill-version-adoption-review',
          id: live.proposalId, workId: workflow.workItem.id,
          decision: selection.decision, actor: structuredClone(live.actor),
          authorityGroup: live.authorityGroup,
          identityAssurance: live.identityAssurance, at,
          reason: String(selection.reason ?? '').trim() || null,
          proposalSha256: live.proposalSha256,
          impactSha256: live.impactSha256
        };
        const reviewPath = skillAmendmentPath(config, workflow, live.proposalId,
          `review-${String(summary.approvals.length + 1).padStart(3, '0')}`);
        const reviewSafe = await secureRepositoryPath(root, reviewPath, {
          label: 'Story skill-version human review'
        });
        if (reviewSafe.exists) skillAmendmentFail('SKP_AMENDMENT_CONFLICT',
          'The next immutable skill-version review slot already exists.');
        await mkdir(path.dirname(reviewSafe.absolute), { recursive: true });
        await writeText(reviewSafe.absolute, canonicalJson(review));
        const reviewSha256 = skillAmendmentDigest(review);
        const approval = {
          actor: structuredClone(live.actor), authorityGroup: live.authorityGroup,
          identityAssurance: live.identityAssurance, at, reviewPath, reviewSha256
        };
        // SF Guard: on a Story it requires, this decision is the approver's signed step (SPEC-PSS-v1 §10.12).
        await (await import('./presence/person-steps.mjs')).signPersonRecords(root, workflow,
          [{ label: 'Skill version decision', action: 'decision.skill-version', record: approval }]);
        if (selection.decision === 'reject') {
          summary.schemaVersion = currentSchemaVersion('skill-version-adoption-summary');
          summary.status = 'rejected';
          summary.decidedAt = at;
          summary.rejection = {
            schemaVersion: currentSchemaVersion('skill-version-rejection-binding'), ...approval
          };
        } else {
          summary.approvals.push(approval);
        }
        if (live.willApply) {
          const candidate = await skillAmendmentCandidate(root, config, workflow,
            summary.skillId, selection.approvedConfigurationSnapshot);
          const decisionPath = skillAmendmentPath(config, workflow,
            live.proposalId, 'decision');
          const finalDecision = {
            schemaVersion: currentSchemaVersion('skill-version-adoption-decision'),
            kind: 'skill-version-adoption-decision', id: live.proposalId,
            workId: workflow.workItem.id, status: 'approved',
            proposedBy: structuredClone(summary.proposedBy),
            proposalSha256: summary.proposalSha256,
            impactSha256: summary.impactSha256,
            configurationAncestry: candidate.configurationAncestry,
            approvedAt: at,
            approvals: summary.approvals.map((entry) => ({
              actor: entry.actor, authorityGroup: entry.authorityGroup,
              identityAssurance: entry.identityAssurance, at: entry.at
            })),
            from: structuredClone(summary.from),
            to: {
              revision: priorWorkflow.workflowSnapshot.revision + 1,
              policySha256: candidate.proposedResolution.policySha256,
              configurationCommit: candidate.sourceCommit,
              skillId: summary.skillId,
              packageSha256: candidate.packageSha256,
              phaseBindings: skillAmendmentBindings(candidate.proposedResolution,
                summary.skillId)
            }
          };
          const decisionSafe = await secureRepositoryPath(root, decisionPath, {
            label: 'Approved Story skill-version decision'
          });
          if (decisionSafe.exists) skillAmendmentFail('SKP_AMENDMENT_CONFLICT',
            'The immutable skill-version decision slot already exists.');
          await writeText(decisionSafe.absolute, canonicalJson(finalDecision));
          const decisionSha256 = skillAmendmentDigest(finalDecision);
          workflow.resolution = candidate.proposedResolution;
          for (const phaseId of summary.affectedPhaseIds) {
            const acceptedPhase = workflow.resolution.phases.find((entry) => entry.id === phaseId);
            if (acceptedPhase?.kind === 'skill'
                && acceptedPhase.skillBinding?.bindingRefs?.skill?.id === summary.skillId) {
              workflow.phases[phaseId].skillBinding = structuredClone(acceptedPhase.skillBinding);
            }
          }
          newReference = await captureWorkflowSnapshotAmendment(
            root, config, priorWorkflow, workflow, {
              approvedConfigurationSnapshot: selection.approvedConfigurationSnapshot,
              amendmentDecision: { path: decisionPath, sha256: decisionSha256 }
            }
          );
          workflow.workflowSnapshot = newReference;
          workflow.schemaVersion = currentSchemaVersion('story-workflow');
          summary.status = 'approved'; summary.decidedAt = at;
          summary.decisionPath = decisionPath;
          summary.decisionSha256 = decisionSha256;
          applySkillAmendmentSelectiveReopen(workflow, summary, at);
          PROSPECTIVE_SKILL_AMENDMENT.set(workflow, {
            reference: structuredClone(newReference),
            policySha256: resolutionPolicySha256(workflow.resolution)
          });
          applied = true;
        }
        workflow.history.push({
          at, actor: actorKey(live.actor),
          event: selection.decision === 'reject' ? 'skill_version_rejected'
            : live.willApply ? 'skill_version_adopted' : 'skill_version_approved',
          phase: workflow.currentPhase,
          detail: `${live.proposalId}: ${summary.skillId}${live.willApply
            ? ` snapshot revision ${newReference.revision}` : ''}`
        });
        return { proposalId: live.proposalId, reviewSha256,
          applied: live.willApply, reference: newReference };
      }
    });
    return { ...publication, proposalId: preview.proposalId, applied,
      workflowSnapshot: newReference };
  } finally {
    PROSPECTIVE_SKILL_AMENDMENT.delete(workflow);
  }
}

/**
 * What a Story list shows, carried on the Story's ledger entries.
 *
 * Session candidates and URL-only discovery list Stories from the state ledger. Without these
 * fields each Story's committed workflow.json had to be read, and a blobless clone that lacked it
 * fell back to fetching every Story's metadata from the remote, one round trip each. Readers that
 * do not know these fields ignore them; workId, phase, generation and branch are unchanged.
 */



export async function syncPublication(root, config, workflow, { fault = null, rebindRemote = null } = {}) {
  assertStoryNotArchived(root, workflow);
  const subject = { kind: 'story', id: workflow.workItem.id };
  const pendingOptions = {
    ...subject,
    legacyPath: legacyPendingPublicationPath(root, config, workflow.workItem.id)
  };
  const pending = await readPendingPublication(root, pendingOptions);
  // `sync` is a retry operation, not a generic `git push`. In particular, a manual commit made
  // after a successful publication must never become governed merely because the operator runs a
  // harmless retry command later.
  if (!pending) {
    return {
      pending: false,
      pushed: null,
      noOp: true,
      capabilityPublished: [],
      ledger: null
    };
  }
  if (pending?.record?.recoveryStage === 'interrupted-before-branch-ref-advanced') {
    const liveOwner = livePreparedPublicationOwner(pending, root);
    if (liveOwner) {
      throw await activePublicationRefusal(root, pending, liveOwner, {
        what: `Story '${workflow.workItem.id}'`, retry: `singularity-flow sync ${workflow.workItem.id}`,
        code: 'STORY_PUBLICATION_IN_PROGRESS'
      });
    }
    const recovery = await recoverPreparedPublication(root, pending);
    if (recovery) {
      return {
        pushed: head(root),
        remote: pending.record.remote,
        branch: pending.record.branch,
        recoveredPrepared: true,
        restoredPrepared: recovery.restored,
        rescuePath: recovery.rescuePath,
        capabilityPublished: [],
        ledger: await reconcileLedger(root, workflow.resolution?.ledger ?? config.ledger ?? {}, { workId: workflow.workItem.id })
      };
    }
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' was interrupted before its commit completed. `
      + 'Inspect the working tree, run singularity-flow doctor, and repair or discard the partial local state before retrying.'
    , { details: { nextAction: { executable: 'singularity-flow', argv: ['doctor', '--json'], label: 'Inspect or continue the retained operation; recheck before retrying.' } } });
  }
  return withSubjectLock(root, subject, async () => {
    // The marker may have been completed while this command waited for the subject lease. Re-read
    // it under the same lock used by lifecycle publication so verification, push, and clearing are
    // one recovery decision rather than three races.
    const current = await readPendingPublication(root, pendingOptions);
    if (!current) {
      return {
        pending: false,
        pushed: null,
        noOp: true,
        capabilityPublished: [],
        ledger: null
      };
    }
    let record = current.record;
    if (record.recoveryStage === 'publication-recovery-diverged') {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' recovery diverged and was stopped safely. ${record.error} `
        + 'Run singularity-flow doctor for the exact journal/branch diagnosis; no commit was pushed.',
        { code: 'PUBLICATION_RECOVERY_DIVERGED', details: { ...record, nextAction: { executable: 'singularity-flow', argv: ['doctor', '--json'], label: 'Inspect the exact recovery journal and retained failure before retrying.' } } }
      );
    }
    if (record.recoveryStage === 'interrupted-before-branch-ref-advanced') {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' recovery state changed while synchronization was acquiring its lock. `
        + 'Run singularity-flow sync again; no commit was pushed.',
        { details: { nextAction: { executable: 'singularity-flow', argv: ['sync'], label: 'Inspect or continue the retained operation; recheck before retrying.' } },  code: 'PUBLICATION_RECOVERY_CHANGED' }
      );
    }
    if (isPendingStoryBranchPromotion(record)) {
      return completePendingStoryBranchPromotion(root, current, {
        subject,
        targetBranch: workflow.lineage?.canonicalBranch ?? workflow.workItem.branch,
        remote: config.git?.remote ?? 'origin'
      });
    }
    const expectedBranch = workflowPublicationBranch(root, workflow);
    const localOnly = record.publicationMode === 'off' && record.localCommitted === true;
    const verification = verifyPendingPublicationCommit(root, record, {
      subject,
      branch: expectedBranch,
      remote: config.git?.remote ?? 'origin',
      allowPublicationOff: localOnly
    });
    if (!verification.valid) {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' pending publication marker does not prove one exact commit: `
        + `${verification.failures.join('; ')}. The marker was retained and no commit was pushed. `
        + 'Run singularity-flow doctor --json and repair or discard the invalid recovery receipt.',
        {
          code: 'PENDING_PUBLICATION_IDENTITY_INVALID',
          details: { nextAction: { executable: 'singularity-flow', argv: ['doctor', '--json'], label: 'Inspect or continue the retained operation; recheck before retrying.' },  subject, markerPath: current.path, failures: verification.failures }
        }
      );
    }
    // A person who undid the waiting commit (git reset) saw sync publish exactly what they undid, and
    // a branch reset to the remote left it retrying an orphan for ever: it must still be on its branch.
    if (!localOnly && !commitIsAncestor(root, record.commit, `refs/heads/${record.branch}`)) {
      const preview = `singularity-flow sync ${workflow.workItem.id} --set-aside`;
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' is waiting to publish commit ${record.commit.slice(0, 8)}, but it is no longer on ${record.branch}: it was reset or rebased away. Nothing was pushed. `
        + `If that undid it on purpose, preview setting it aside with ${preview}; to keep it, put it back with git reset --keep ${record.commit}.`,
        { code: 'PENDING_PUBLICATION_COMMIT_OFF_BRANCH', details: { subject, commit: record.commit, branch: record.branch, nextAction: preview } }
      );
    }
    // The index refresh after the branch advanced may be what failed (another program held
    // index.lock); until it is done, every published file looks changed.
    refreshStalePublishedIndex(root, record.commit);
    const candidateAuthority = await verifyPendingPublicationCandidateAuthority(root, record);
    if (!candidateAuthority.valid) {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' pending publication marker does not retain its exact verified Candidate: `
        + `${candidateAuthority.failures.join('; ')}. The marker was retained and no commit was pushed.`,
        {
          code: 'PENDING_PUBLICATION_CANDIDATE_INVALID',
          details: { subject, markerPath: current.path, failures: candidateAuthority.failures }
        }
      );
    }
    // A prepared REV receipt must be completed from this exact pending marker
    // before Story sync may push the commit or discard the only recovery proof.
    await ensurePendingRevisionAttestation(root, { subject, record, pending: current });
    if (localOnly) {
      if (current.integrityVerified !== true) {
        throw new SingularityFlowError(
          `Story '${workflow.workItem.id}' local REV recovery marker failed integrity verification.`,
          { code: 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID', details: { subject, markerPath: current.path } }
        );
      }
      const ledger = await reconcileLedger(root, workflow.resolution?.ledger ?? config.ledger ?? {}, {
        workId: workflow.workItem.id
      });
      await clearPendingPublication(root, pendingOptions);
      return {
        pending: false, pushed: null, remote: null, branch: record.branch,
        localOnly: true, capabilityPublished: [], ledger
      };
    }
    let rootRemoteAuthority = null;
    try { rootRemoteAuthority = configuredRemoteAuthority(root, record.remote); }
    catch { /* Unsafe credential-bearing replacement is authority drift. */ }
    if (!record.remoteFingerprint || !rootRemoteAuthority?.url
      || rootRemoteAuthority.fingerprint !== record.remoteFingerprint) {
      // A remote moved from HTTPS to SSH names the same repository under a new URL. The marker's
      // schema stays as it is: name the change, and move a sealed marker only on a confirmed rebind.
      const retry = await import('./publication-retry-refusals.mjs');
      const rebind = retry.acceptPublicationRemoteRebind(root, {
        subject, record, integrityVerified: current.integrityVerified, confirmation: rebindRemote
      });
      if (!rebind) {
        throw retry.publicationRemoteChangedRefusal(root, {
          label: `Story '${workflow.workItem.id}'`, subject, record, markerPath: current.path,
          integrityVerified: current.integrityVerified, confirmationGiven: rebindRemote,
          rebindCommand: `singularity-flow sync ${workflow.workItem.id}`
        });
      }
      record = { ...record, remoteFingerprint: rootRemoteAuthority.fingerprint };
      await writePendingPublication(root, { ...subject, record });
    }
    if (fault) await fault('after-root-authority-capture', {
      record, remoteFingerprint: rootRemoteAuthority.fingerprint
    });
    const markerCarriesCapabilityProgress = record.capabilityPublicationPlan !== undefined
      || record.capabilityPublications !== undefined;
    if (markerCarriesCapabilityProgress && current.integrityVerified !== true) {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' pending capability publication progress integrity is invalid. `
        + 'The marker was retained and no root or sibling ref was pushed.',
        {
          code: 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID',
          details: {
            subject, markerPath: current.path,
            failures: ['pending capability publication progress integrity is invalid']
          }
        }
      );
    }
    if (record.rootPublished === true && current.integrityVerified !== true) {
      throw new SingularityFlowError(
        `Story '${workflow.workItem.id}' pending root publication progress integrity is invalid. `
        + 'The marker was retained and no root or sibling ref was pushed.',
        {
          code: 'PENDING_PUBLICATION_PROGRESS_INTEGRITY_INVALID',
          details: {
            subject, markerPath: current.path,
            failures: ['pending root publication progress integrity is invalid']
          }
        }
      );
    }
    let rootPushed = record.rootPublished === true;
    // The remote tip when another clone has published on top of this commit (sweep B1).
    let remoteBuiltOn = null;
    if (rootPushed) {
      const observed = await lifecycleAuthority(root).observe({
        remote: rootRemoteAuthority.url, branch: record.branch
      });
      // Sealed progress (checked above) stays proven once another clone publishes on top of it.
      const holds = await remoteBranchHolds(root, { observed, commit: record.commit, remote: record.remote, branch: record.branch });
      if (holds === 'descendant') remoteBuiltOn = observed.sha;
      if (holds !== 'exact' && holds !== 'descendant') {
        throw new SingularityFlowError(
          `Story '${workflow.workItem.id}' pending marker says its root ref was published, but remote '${record.remote}' `
          + `does not advertise exact commit ${record.commit}. The marker was retained and no sibling ref was pushed.`,
          { code: 'PENDING_PUBLICATION_ROOT_UNPROVEN', details: { subject, markerPath: current.path } }
        );
      }
    }
    if (!rootPushed) {
      // Recovery is itself a transport attempt. Make its ambiguous crash boundary durable before
      // invoking Git, just as the original publication unit does. Without this write, a successful
      // create-only retry followed by process death left the older `rejected` receipt in place; the
      // next sync then refused exact equality forever even though this machine had performed the
      // successful update.
      // Only the machine-sealed receipt may authorize equality from an earlier attempt. Rewriting
      // the marker for this new attempt must not launder a hand-edited `transport-indeterminate`
      // value into trusted recovery state.
      const priorPushOutcome = current.integrityVerified === true
        ? record.pushOutcome ?? 'not-attempted'
        : 'not-attempted';
      let recoveryExpectedRemoteSha = record.expectedRemoteSha;
      const recordedParent = verification.identity?.parents?.length === 1
        ? verification.identity.parents[0]
        : null;
      // Only a lease this release sealed from what it observed (or fell back to) is re-derived here.
      const observableLease = current.integrityVerified === true
        && ['implicit-local-parent', 'observed-remote', 'observed-absent'].includes(record.expectedRemoteShaSource);
      const observation = observableLease
        ? await lifecycleAuthority(root).observe({ remote: rootRemoteAuthority.url, branch: record.branch })
        : null;
      const observed = observation?.reachable === true && !observation.malformed;
      // A remote that already has this commit (or builds on it) is never claimed as this
      // publication: another actor's identical push, a hook-skipping one say, is not SFlow's. sync
      // --set-aside lets the person stop waiting for it, in their own terminal (2026-10-28).
      if (observed && observation.sha === null) {
        // The Story branch is gone from the remote (a merged pull request deletes it). A lease on the
        // commit it last had always failed, so nothing could publish and cancel stayed blocked.
        // Create it again, create-only: that cannot replace anything another clone sent.
        recoveryExpectedRemoteSha = null;
      } else if (observed && observation.sha
        && record.expectedRemoteShaSource === 'implicit-local-parent'
        && recoveryExpectedRemoteSha !== null
        && recoveryExpectedRemoteSha === recordedParent
        // Only this release's sealed provenance proves that the lease was an unavailable-remote
        // fallback rather than caller policy. Legacy markers and explicit leases fail closed even
        // when their SHA happens to equal the governed commit's first parent.
        && commitIsAncestor(root, observation.sha, record.commit)) {
        recoveryExpectedRemoteSha = observation.sha;
      }
      // The indeterminate receipt must immediately precede the operation that may mutate the
      // remote. Resolve the safe lease first: a crash during read-only observation must not create
      // authority to claim that another actor's later byte-identical push was ours.
      record = { ...record, pushOutcome: 'transport-indeterminate' };
      await writePendingPublication(root, { ...subject, record });
      const result = await pushCommitToBranchAsync(root, record.remote, record.commit, record.branch, {
        // A marker saved before exact leases has none; its recovery keeps fast-forward protection.
        ...(recoveryExpectedRemoteSha === undefined
          ? { unleased: 'a pending publication saved before exact leases' }
          : { expectedRemoteSha: recoveryExpectedRemoteSha }),
        transportRemote: rootRemoteAuthority.url,
        upstreamRemote: rootRemoteAuthority.remote
      });
      if (result.status !== 0) {
        const pushOutcome = publicationPushOutcome(result);
        // A transport may have accepted the exact governed commit and then lost its response. A
        // create-only lease must fail on retry because the branch is no longer absent; the durable
        // pending receipt is the authority that makes this exact equality an idempotent success.
        // Check an older durable ambiguity before letting this retry's expected collision supersede
        // it. That is the only way a crash after a successful receive-pack can converge safely. A
        // remote another clone has built on since holds it too: a takeover publishing on top of a
        // lost approval is proof that approval landed (sweep B1).
        const settled = await retainedPublicationOutcome(root, {
          priorOutcome: priorPushOutcome, outcome: pushOutcome,
          commit: record.commit, remote: record.remote, branch: record.branch,
          observe: () => lifecycleAuthority(root).observe({ remote: rootRemoteAuthority.url, branch: record.branch })
        });
        if (settled.holds === 'descendant') remoteBuiltOn = settled.remoteTip;
        if (!settled.published) {
          // An earlier attempt whose answer was lost stays unknown while the remote cannot be read:
          // this attempt failing to reach it says nothing about that one. Recorded as rejected, the
          // remote's later answer (it took the commit) was refused as "sent outside SFlow" (SDA-AC-004).
          if (pushOutcome !== 'transport-indeterminate' && !settled.earlierUnknown) {
            // The retry's own words: recover reads them to tell a moved remote from a fixable refusal.
            const diagnostic = (await import('./publication-retry-refusals.mjs')).publicationPushDiagnostic(result);
            record = { ...record, pushOutcome: 'rejected', ...(diagnostic ? { error: diagnostic } : {}) };
            await writePendingPublication(root, { ...subject, record });
          }
          // A rule, hook or push-protection refusal repeats on every retry of this commit: name
          // the manual repair first and offer the retry only for after the provider accepts it.
          throw (await import('./publication-retry-refusals.mjs')).publicationPushRefusal({
            result, outcome: pushOutcome, subject, commit: record.commit, branch: record.branch,
            remote: record.remote, extraDetails: { workId: workflow.workItem.id, markerPath: current.path },
            retryCommand: `singularity-flow sync ${workflow.workItem.id}`,
            inspectCommand: `singularity-flow recover ${workflow.workItem.id}`
          });
        }
      }
      if (fault) await fault('after-root-push-before-receipt', { record, result });
      // Persist root completion before any sibling verification/publication or final marker clear.
      // A later sync still proves the live exact root tip before trusting this progress bit.
      record = { ...record, rootPublished: true };
      await writePendingPublication(root, { ...subject, record });
      rootPushed = true;
    }
    const capabilityEntries = record.capabilityPublications ?? [];
    const hasCapabilityPlan = record.capabilityPublicationPlan !== undefined
      || record.capabilityPublications !== undefined;
    if (hasCapabilityPlan) {
      const capabilityVerification = verifyCapabilityPublicationRecoveryPlan(record);
      const progressFailures = [...capabilityVerification.failures];
      if (current.integrityVerified !== true) {
        progressFailures.push('pending capability publication progress integrity is invalid');
      }
      const pendingIdentities = new Set(capabilityEntries.map(capabilityPublicationEntrySha256));
      for (const completed of record.capabilityPublicationPlan ?? []) {
        let completedAuthority = null;
        try { completedAuthority = configuredRemoteAuthority(completed.root, completed.remote); }
        catch { /* Unsafe credential-bearing replacement is authority drift. */ }
        if (!completedAuthority?.url || completedAuthority.fingerprint !== completed.remoteFingerprint) {
          progressFailures.push(`capability publication '${completed.repository}' remote changed`);
          continue;
        }
        if (pendingIdentities.has(capabilityPublicationEntrySha256(completed))) continue;
        if ((await lifecycleAuthority(completed.root).observe({
          remote: completedAuthority.url, branch: completed.branch
        })).sha !== completed.commit) {
          progressFailures.push(`completed capability publication '${completed.repository}' exact remote ref is not proven`);
        }
      }
      if (progressFailures.length) {
        throw new SingularityFlowError(
          `Story '${workflow.workItem.id}' pending capability publication marker is not bound to its root commit: `
          + `${progressFailures.join('; ')}. The marker was retained and no sibling ref was pushed.`,
          {
            code: 'PENDING_CAPABILITY_PUBLICATION_IDENTITY_INVALID',
            details: { subject, markerPath: current.path, failures: progressFailures }
          }
        );
      }
    }
    const capability = capabilityEntries.length
      ? await publishCapabilityRepositoriesDurably(root, workflow.workItem.id, {
          remote: record.remote,
          branch: record.branch,
          commit: record.commit,
          event: record.event
        }, capabilityEntries, { rootPublished: true })
      : { published: [], pending: [], error: null };
    if (capability.pending.length) {
      throw new SingularityFlowError(
        `Capability Story publication still fails for '${capability.pending[0].repository}': ${capability.error}`
      );
    }
    await clearPendingPublication(root, pendingOptions);
    const ledger = await reconcileLedger(root, workflow.resolution?.ledger ?? config.ledger ?? {}, { workId: workflow.workItem.id });
    // Deliveries that waited for this commit to reach the remote are due now.
    let stepActions = null;
    if (storyUsesStepActions(workflow)) try {
      await releaseWaitingStepActions(root, { workId: workflow.workItem.id });
      stepActions = await deliverStepActions(root, { logger: stepActionLogger(root, config, workflow) });
      const notice = stepActionWarning(stepActions);
      if (notice) console.warn(`Warning: ${notice}`);
    } catch (error) {
      stepActions = { error: { code: error?.code ?? 'STEP_ACTION_RUNTIME_FAILED' } };
    }
    return {
      pending: false,
      pushed: rootPushed ? record.commit : null,
      remote: record.remote,
      branch: record.branch,
      ...(remoteBuiltOn ? { remoteBuiltOn } : {}),
      capabilityPublished: capability.published,
      ledger,
      stepActions
    };
  });
}

/**
 * `offline` is a read-path concession, and it defaults to off so every existing caller is unchanged.
 *
 * Validation consults the capability ledger, and `ledgerStatus` fetches the state branch plus one
 * pin per recorded entry — each inside a temporary worktree. Measured on a real repository that was
 * 42 of 47 `git fetch` calls and 33 s of a 48 s `snapshot --json`, for a validation whose answer the
 * read model only renders. A publication transaction and the governance gate still validate against
 * the remote; only a surface that is merely *describing* state opts out, and it says so through the
 * same ledger fields every other offline reader uses.
 */
