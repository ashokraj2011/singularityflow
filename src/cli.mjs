import readline from 'node:readline/promises';

import { actionActor, activatePhaseAgent, activeActionContext, confirm, summary } from './commands/kernel.mjs';
import os from 'node:os';
import path from 'node:path';
import * as style from './style.mjs';
import { stdin as input, stdout as output } from 'node:process';
import { chmodSync, existsSync } from 'node:fs';
import { addPhase, defineWorkflow, editPhase, editWorkflow, listWorkflows, upsertPhaseOutput } from './workflow-authoring.mjs';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { SingularityFlowError, exists, nowIso, optionBoolean, optionNumber, optionString, optionStrings, parseArgs, posix, readJson, requirePositional, run, secureRepositoryPath, snapshot, table, writeJson, writeText } from './util.mjs';
import { add, assertClean, branch, changes, checkout, commit, fastForwardTo, fetchOrigin, fetchRemote, fileAtRef, gitDir, hasUpstream, head, identity, localBranches, preflightPushBranch, pullFastForward, refExists, refHead, remoteBranches, repoRoot } from './git.mjs';
import { buildRepositorySubjectIndex, buildRepositorySubjectIndexFromRefs, resolveContext } from './repository-subject-index.mjs';
import { approvePhase, assertNoPendingPublication, cancelWorkflow, commitAndPublish, CONFIG_PATH, createWorkflow, currentPhase, loadConfig, preparePhase, preparePhaseInputs, promoteDesignSource, publishGeneration, reconcilePhaseTelemetry, registerArtifact, rejectPhase, reopenWorkflow, resolveWorkItem, saveStoryDraft, transactStory, scanArtifacts, storyPublicationPending, submitPhase, syncPublication, validateId, validateWorkflow, workflowBranchAllowed, workflowPublicationBranch, workflowPath, workDir } from './state-stores.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';
import {
  explainTelemetryStatus,
  prepareTelemetryLaunch,
  probeTelemetry,
  setTelemetryCapture,
  TELEMETRY_DISCLOSURE,
  TELEMETRY_DISCLOSURE_CONFIRMATION
} from './telemetry-provision.mjs';
import { listPromptAudits, promptAuditStatus, readPromptAudit, setPromptAudit } from './prompt-audit.mjs';
import { assertPhaseSequence, withConfirmationPort } from './sequence.mjs';
import { addComment, assignIssue, discoverJiraConnection, getIssue, getIssueHierarchy, getMyPermissions, issueToMarkdown, listBoards, listBoardStories, listEpicStories, listEpics, listFields, listIssueTransitions, listMyIssues, listProjects, moveIssueToSprint, setIssuePriority, transitionIssue } from './jira.mjs';
import { jiraDoctor, jiraDoctorText } from './jira-doctor.mjs';
import { installPlugin, listPlugins, pluginPath, uninstallPlugin } from './plugin.mjs';
import { runGovernanceGate } from './governance.mjs';
import { inspectWorkflowGrounding, worldModelCommand } from './worldmodel.mjs';
import { effectiveMaterializationPolicy } from './world-model-materialization.mjs';
import { launchHostSession } from './host-session-launcher.mjs';
import { operationContext, runOperation } from './operation-context.mjs';
import { invokeModel, listModelInvocations, resolveModelProvider } from './model-runner.mjs';
import { assertProducerAllowed, buildGenerationAuthorship, importManualArtifact, inspectInPlaceArtifact, normalizeAuthorshipOptions } from './manual-authorship.mjs';
import { initializationStatus, initializeDefinition, loadDefinition, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { loadImpactDefinition } from './impact-config.mjs';
import { collectImpactEvidence, compareImpactReceipts, confirmImpactEnrollment, exportImpactReceipts, hydrateImpactPlan, impactDoctor, importImpactEvidence, listImpactReceipts, recordImpactExposure, verifyImpactReceipt } from './impact.mjs';
import {
  explainChangeFlightPlanFinding, previewChangeFlightPlan, readChangeFlightPlan,
  recordChangeFlightPlanDisposition, recordChangeFlightPlanExpansionDisposition,
  refreshChangeFlightPlan, startChangeFlightPlan
} from './change-flight-plan.mjs';
import { registerReference, resolveReference } from './harness-imports.mjs';
import { beginHarnessInvocation, completeHarnessInvocation, harnessReport } from './harness-events.mjs';
import { activateWorkItemSession, loadCopilotSession, loadSession, agentSessionStatus, requireCopilotWorkItemSelection, restoreAgentSession, restoreCopilotSession, selectIntakeSource, selectAgent, selectWorkType, setAgentSession } from './session.mjs';
import { addDocuments, detachDocuments, documentCatalog, fetchRemoteDocument, listRemoteDocuments, previewDocument, viewDocument } from './documents.mjs';
import { recordClarificationResponses, verifyClarificationRecord } from './clarifications.mjs';
import { progressBar, progressFlow, progressSnapshot } from './progress.mjs';
import { deriveReport, renderHtml, renderMarkdown } from './report.mjs';
import { loadManualStory, promptManualStory } from './intake.mjs';
import { guideText, phaseNeedsGeneration, workflowGuide } from './guide.mjs';
import { runFirstRunGuide } from './first-run-guide.mjs';
import { nextStepsSnapshot, nextStepsText } from './nextsteps.mjs';
import { loadHelpDocument } from './help.mjs';
import { agentMappingStatus, agentStatus, discoverAgents, lockAgent, prepareRemoteOutputs, remoteOutputConflicts, syncAgent } from './agents.mjs';
import { attestMcpHost, mcpDoctor, mcpStatus, recordMcpEvidence, scaffoldFigmaMcp, smokeMcpHost, warmMcpHost, scaffoldPlaywrightMcp } from './mcp.mjs';
import { message as gatewayMessage } from './gateway/messages.mjs';
import { normalizeMcpTargetOrigin } from './mcp-target.mjs';
import { approvedDesignSourceBinding, verifyDesignSourceLifecycle } from './design-sources.mjs';
import { generateDesignInventory } from './design-inventory.mjs';
import { evaluateVisualCoverage } from './visual-coverage.mjs';
import { compareVisualArtifacts, listVisualComparisons } from './visual-compare.mjs';
import { bootstrapWorkspacePortfolio, deleteConfigurationFile, deleteConfigurationTemplate, exportConfigurationBundle, repositorySnapshot, publishEditorConfiguration, readConfigurationFile, saveConfigurationFile, selectEditorAgent, validateEditorConfiguration } from './editor.mjs';
import { verifyGroundingRecord } from './grounding.mjs';
import { filterLogEntries, logFilePath, normalizeLogLevel, parseLogLines, repositoryLogger, resolveLogging } from './logging.mjs';
import { collectWorkspaceLogs } from './workspace-logs.mjs';
import { doctorSnapshot, doctorText } from './doctor.mjs';
import { createReviewBundle, reviewHtml, reviewMarkdown } from './review.mjs';

import { installWorkflow, simulateWorkflow, simulationText, workflowCatalog, workflowDiff } from './workflow-catalog.mjs';
import { applyRecovery, assignPhase, recoveryPlan, recoveryText, watchSnapshot, watchText } from './collaboration.mjs';
import { copilotAgentStartHook, agentGuardHook, sessionStartAgentHook } from './agent-hooks.mjs';
import { approvalInbox, approvalInboxText } from './inbox.mjs';
import { remainingRequiredAuthorities, requireApprovalAuthority } from './approval-authority.mjs';
import { answerSelectionReceipt, beginCustomSelectionReceipt, beginSelectionReceipt, consumeSelectionReceipt, resolveCustomSelectionReceipt, resolveSelectionReceipt, selectionReceiptStatus } from './choices.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import { KNOWLEDGE_ROOT, currentKnowledge, filterKnowledge, harvestInitiativeKnowledge, readKnowledge, recordKnowledge, resolveKnowledge } from './knowledge.mjs';
import { commitInitiativeChange, createInitiative, initiativeProgress, initiativeStartPreflight, listInitiatives, availableInitiativeOutputs, initiativeRelative, prepareInitiativePhase, restartInitiative, secureInitiativePath, saveInitiativeDraft, selectInitiativePhaseOutputs, setInitiativeApplicability, initiativeApplicabilityState, syncInitiativePublication, validateInitiativeId } from './state-stores.mjs';
import { approveInitiative, evaluateInitiativePhase, initiativeBundle, publishInitiativePhase, readInitiativeRecords, registerInitiativeEvidence } from './initiative-evidence.mjs';
import { rejectInitiative } from './initiative-graph.mjs';
import { impactDocument, impactFindings, initiativeImpact } from './initiative-impact.mjs';
import { initiativeBreakdownReview, initiativeMergeState, loadInitiativeBreakdown, materializeInitiative, syncInitiativeRepositories } from './initiative-repositories.mjs';
import { adoptJiraDrift, adoptJiraEpic, applyJiraWritePlan, createJiraWritePlan, observeJiraDrift, previewJiraAdoption } from './jira-initiative.mjs';
import { interfaceContractStatus, registerInterfaceContract } from './initiative-contracts.mjs';
import { deriveInitiativeReport, initiativeNextActions, renderInitiativeReport } from './initiative-report.mjs';
import { epicJourney } from './initiative-next.mjs';
import { initiativeOutputRequired } from './initiative-policy.mjs';
import { runInitiativeGate } from './initiative-governance.mjs';
import { composeInitiativeContext, verifyInitiativeContext } from './initiative-context.mjs';
import { createPlanningContext, promotePlanningArtifact, promotePlanningArtifacts } from './planning.mjs';
import { formatContextBoundaryHandoff } from './context-policy.mjs';
import { detachEpicSource, listEpicSources, registerEpicSource, registerEpicTextSource, verifyEpicSources } from './epic-sources.mjs';
import { adoptEpicStory, completeEpicIntake, completeEpicPublication, EPIC_PHASES, addEpicStory, splitEpicStory, updateEpicStory, verifyEpicPlanningPackage } from './epic-lifecycle.mjs';
import { createStoryReviewPacket, finalizeStoryDelivery, readStoryReviewPacket } from './story-lineage.mjs';
import {
  composeEvidenceReceipt, renderEvidenceReceipt, renderEvidenceReceiptMarkdown
} from './evidence-receipt.mjs';
import { readReturnLocatorAtRef, writeReturnLocator } from './return-locator.mjs';
import { getGitHubIssue, normalizeWorkSource, workflowSourceIdentity } from './work-source.mjs';
import { composeContextBrief } from './context-broker.mjs';
import { compileObservation } from './observation-compiler.mjs';
import {
  attemptRepair, authorizeRepair, cancelRepair, diagnoseFault, listFaults, listRepairs,
  governedFaultRepairPolicy, parseVerificationArgv, readFault, readRepair, repairNextActions, reportFault, requestRepair,
  wrapCommandWithFaultRepair
} from './fault-repair.mjs';

import { createPullRequest, createStoryPullRequest, epicPullRequestPlan, storyPullRequestPlan, updateStoryPullRequest } from './pull-request.mjs';
import { copyToClipboard } from './clipboard.mjs';
import { epicCheckStory, epicReviewDecision, epicReviewStory, listEpicReviewInbox } from './epic-review.mjs';
import { completeEpicDelivery, epicDeliveryReadiness } from './epic-completion.mjs';

import { currentLocalEpicReservation, reserveLocalEpicBranch } from './local-identity.mjs';
import { adoptWorkspaceConfiguration, archiveWorkspace, createWorkspace, createWorkspaceConfiguration, fetchWorkspace, forgetWorkspace, listWorkspaceDocuments, previewWorkspace, previewWorkspaceConfiguration, previewWorkspaceUpdate, readWorkspace, readWorkspaceRegistry, rememberWorkspace, repairWorkspace, restoreWorkspace, duplicateWorkspaceConfiguration, isCloneTarget, stageWorkspaceDocuments, updateWorkspaceConfiguration, workspaceRemoteCapabilities, workspaceRemoteDefaults, remoteDefaultBranch, workspaceRepositoryDefaults, workspaceArchiveReadiness, workspaceRepositoryPath, workspaceStatus } from './workspace.mjs';
import {
  captureConfigurationState, CONFIGURATION_BRANCH, materializeConfigurationSnapshot,
  resolveConfigurationRemote, restoreConfigurationState
} from './configuration-branch.mjs';
import { analyzeWorkspaceImpact, listWorkspaceImpacts, previewWorkspaceImpact, promoteWorkspaceImpact, workspaceImpactStatus } from './workspace-impact.mjs';
import { activateWorkspaceContext, activeWorkspaceFile, clearActiveWorkspaceContext, discardUnsupportedWorkflowWorkspaces, readActiveWorkspaceContext, workspacePromptLabel, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { appendLedgerIntent, archiveLedger, createLedgerIntent, initializeLedger, ledgerDoctor, ledgerLog, ledgerShow, ledgerStatus, reconcileLedger, repairLedgerPins, verifyLedger } from './ledger.mjs';
import { validateLedgerDeployment } from './ledger-deployment.mjs';
import { CAPABILITY_KINDS, CAPABILITY_TYPES, CAPABILITIES_PATH, capabilityDeliveries, capabilityForRepository, capabilityTree, editCapability, flattenCapabilityTree, loadCapabilities, resolveCapabilityPolicy, resolveEffectiveCapabilityPolicy, validateCapabilities } from './capabilities.mjs';
import { bootstrapRepository, repositoryIdFromUrl } from './bootstrap.mjs';
import { activateCapabilityProposal, capabilityReadiness, composeCapabilityWorldModel, editCapabilityInOrganisation, inspectCapabilityProposal, listCapabilityProposals, initializeWorkspaceState, listLeadRepositories, mapCapability, publishOrganisationCapabilityMap, readOrganisation, rememberLeadRepository, resolveWorkspacePlan } from './organisation.mjs';
import { canonicalCommand, commandDefinition, operationById, SECRETS_SUBCOMMANDS, validateCommandHandlers } from './command-registry.mjs';
// `action` is already a command name in this file, so the narration constructor is renamed rather
// than shadowing it.
import { action as narrationAction, commandResult, effects, noEffects, noop, succeeded } from './narration/command-result.mjs';
import { emitCommandResult } from './narration/emit.mjs';
import { factoryResetAll, factoryResetAllPlan, factoryResetPlan, factoryResetRepository } from './factory-reset.mjs';
import { localReset, localResetPlan } from './fresh-install-reset.mjs';
import { applyLocalReinstall, reinstallPlanText, resolveReinstallPlan } from './reinstall.mjs';
import { capabilityDoctor } from './capability-doctor.mjs';
import { inspectStatePlanes, reconcileStateProjections } from './state-planes.mjs';
import { clearPendingPublication, readPendingPublication, writePendingPublication } from './publication-pending.mjs';
import { InitiativeStateStore, StoryStateStore, loadInitiativeAggregate, loadStoryAggregate } from './state-stores.mjs';

import { SnapshotCoordinator } from './snapshot-coordinator.mjs';
import { TimingCollector, writeHumanTimings } from './dx-timings.mjs';
import { assertActionPlanFresh, createActionPlan, loadActionPlan, readActionResult, recordActionResult, selectPlannedAction } from './action-plans.mjs';
import { consumeActionAuthorization, issueActionAuthorization } from './action-authorization.mjs';
import { refreshBranch } from './branch-refresh.mjs';
import { buildStoryStack, publishedStackForStory, syncStoryStack } from './story-stack.mjs';
import { analyzeRegression, regressionReportMarkdown } from './regression-analysis.mjs';
import { buildSpecIndex, changedRepositoryPaths, configuredAcceptanceCommandSetSha256, evaluateSpecAcceptance, evaluateSpecCoverage, loadActiveSpecRecords, normalizeClaimMap, predecessorSpecClauses, readStructuredFile, runSpecAcceptance, specificationSourceTreeHash, traceClause, traceCsv } from './specifications.mjs';
import { evaluateSpecificationGate } from './specification-gate.mjs';
import { advisoryTaskPath, approvedSource, deriveAdvisoryTasks, renderAdvisoryTasks } from './advisory-tasks.mjs';
import { assistedPrompt, assistedRecordRelative, buildAssistedRecord, parseAssistedCandidates, serializeAssistedRecord, unknownCitations } from './assisted-quality.mjs';

import { buildConstitutionException, constitutionIndex, constitutionPolicy, generateConstitution, loadConstitution } from './constitution.mjs';

import { ABOUT } from './about.mjs';
import { VERSION } from './version.mjs';

import { HELP } from './help-text.mjs';

async function confirmExact(prompt, expected) {
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_AGENT_CONFIRM === expected) return true;
    throw new SingularityFlowError(`Confirming '${expected}' requires an interactive terminal; use the command's explicit non-interactive confirmation flag when available.`);
  }
  const io = readline.createInterface({ input, output });
  try { return (await io.question(`${prompt}\nType ${expected} to continue: `)).trim() === expected; }
  finally { io.close(); }
}

async function confirmYesNo(prompt) {
  if (!input.isTTY || !output.isTTY) {
    throw new SingularityFlowError('Confirmation needs an interactive terminal or the explicit --yes flag.');
  }
  const io = readline.createInterface({ input, output });
  try { return /^(y|yes)$/i.test((await io.question(`${prompt} [y/N] `)).trim()); }
  finally { io.close(); }
}

async function initCommand(options) {
  const root = repoRoot();
  const workId = optionString(options, 'work-id');
  const checkOnly = optionBoolean(options, 'check');
  const repair = optionBoolean(options, 'repair');
  if (checkOnly && repair) throw new SingularityFlowError('Choose either init --check or init --repair.');
  if (checkOnly && (workId || optionBoolean(options, 'fetch') || options.base != null)) {
    throw new SingularityFlowError('init --check inspects the current branch and cannot switch or fetch. Check out the target branch first.');
  }
  if (checkOnly) {
    const status = await initializationStatus(root);
    const report = {
      ...status,
      repository: root,
      branch: branch(root)
    };
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Singularity Flow initialization — ${status.complete ? 'complete' : 'repair needed'}`);
      console.log(`Repository: ${root}`);
      console.log(`Branch: ${report.branch}`);
      console.log(`Assets: ${status.presentFiles.length}/${status.expectedFiles.length} present`);
      if (status.missingFiles.length) {
        console.log('Missing:');
        for (const file of status.missingFiles) console.log(`- ${file}`);
      }
      if (status.configurationError) console.log(`Configuration: ${status.configurationError}`);
      if (!status.complete) {
        console.log(status.configurationError?.includes('workflow.yml version must be 2')
          ? 'Fix: singularity-flow factory-reset --dry-run'
          : 'Fix: singularity-flow init --repair');
      }
    }
    return report;
  }
  if (workId) {
    validateId({ idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }, workId);
    assertClean(root);
    checkout(root, workId, {
      base: optionString(options, 'base', 'main'),
      fetch: optionBoolean(options, 'fetch')
    });
  }
  const wrote = await initializeDefinition(root);
  const config = await loadConfig(root);
  if (workId) validateId(config, workId);
  await worldModelCommand(root, ['wm', 'init'], {});
  console.log(wrote.length
    ? `${repair ? 'Repaired' : 'Created'} ${wrote.join(', ')}`
    : `Verified ${WORKFLOW_PATH}, templates, prompts, and governed agents; nothing needed repair.`);
  if (workId) {
    console.log(`Initialized Singularity Flow on Work-ID branch ${workId}; the base branch was not modified.`);
    console.log(`After reviewing, committing and pushing singularity/, run: singularity-flow start ${workId}`);
    console.log(`In Copilot: /sf-start ${workId}`);
  }
}

function renderFactoryResetPlan(plan) {
  console.log(`Singularity Flow factory reset — ${plan.completed ? 'complete' : 'preview'}`);
  console.log(`Repository: ${plan.repository}`);
  console.log(`Branch: ${plan.branch ?? 'detached'} · HEAD ${String(plan.head ?? 'unborn').slice(0, 12)}`);
  console.log(`Npm package: ${plan.packageVersion ?? 'unknown'}`);
  console.log('\nRemove:');
  for (const item of plan.remove) console.log(`- ${item}`);
  console.log('\nReplace:');
  for (const item of plan.replace) console.log(`- ${item}`);
  console.log('\nPreserve:');
  for (const item of plan.preserve) console.log(`- ${item}`);
  if (plan.uncommittedResetPaths.length && !plan.completed) {
    console.log('\nThese uncommitted reset-scope changes would be discarded, so the reset will refuse');
    console.log('to run until they are committed, stashed, or --allow-dirty is passed:');
    for (const item of plan.uncommittedResetPaths) console.log(`- ${item}`);
  }
  if (!plan.completed) {
    console.log(`\nConfirmation required: ${plan.confirmation}`);
    console.log(plan.operation === 'factory-reset-all'
      ? 'Run: sflow reset-all --yes'
      : `Run: singularity-flow factory-reset --confirm ${JSON.stringify(plan.confirmation)}`);
  } else {
    console.log('\nThe replacement is intentionally uncommitted.');
    for (const item of plan.next) console.log(`Next CLI step: ${item}`);
    console.log('Copilot guide: /sf-nextsteps');
  }
}

async function factoryResetCommand(options) {
  const root = repoRoot();
  const dryRun = optionBoolean(options, 'dry-run');
  if (dryRun && options.confirm != null) throw new SingularityFlowError('factory-reset --dry-run does not accept --confirm. Review the preview first.');
  const result = dryRun
    ? await factoryResetPlan(root, { packageVersion: VERSION })
    : await factoryResetRepository(root, {
      confirmation: optionString(options, 'confirm'),
      packageVersion: VERSION,
      allowDirty: optionBoolean(options, 'allow-dirty')
    });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else renderFactoryResetPlan(result);
  return result;
}

async function resetAllCommand(options) {
  const root = repoRoot();
  const confirmed = optionBoolean(options, 'yes');
  const result = confirmed
    ? await factoryResetAll(root, { confirmation: 'RESET ALL', packageVersion: VERSION })
    : await factoryResetAllPlan(root, { packageVersion: VERSION });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    renderFactoryResetPlan(result);
  }
  return result;
}

function renderLocalResetPlan(plan) {
  const forgetOnly = plan.mode === 'forget-only';
  console.log(`Singularity Flow local reset — ${forgetOnly ? 'forget machine state' : 'delete workspaces'} — ${plan.completed ? 'complete' : 'preview'}`);
  if (!forgetOnly) {
    console.log('\nWARNING: this mode permanently deletes every validated registered workspace directory and its repository clones.');
  }
  console.log(`\nRegistered workspace directories (${forgetOnly ? 'preserved' : 'deleted'}): ${plan.workspaces.length}`);
  if (plan.workspaces.length) {
    for (const workspace of plan.workspaces) {
      console.log(`- [${workspace.disposition}] ${workspace.name} (${workspace.id}): ${workspace.path}`);
    }
  } else {
    console.log('- none');
  }
  if (plan.registryWarning) console.log(`Registry warning: ${plan.registryWarning}`);
  if (plan.missingRegistrations.length) {
    console.log(`Stale missing registrations: ${plan.missingRegistrations.length} (forgotten with local state)`);
    for (const target of plan.missingRegistrations) console.log(`- ${target}`);
  }
  console.log('\nRemove:');
  for (const item of plan.remove) console.log(`- ${item}`);
  console.log('\nPreserve:');
  for (const item of plan.preserve) console.log(`- ${item}`);
  if (!plan.completed) {
    console.log(`\nConfirmation required: ${plan.confirmation}`);
    const modeFlag = forgetOnly ? ' --forget-only' : '';
    console.log(`Run: singularity-flow local-reset${modeFlag} --confirm ${JSON.stringify(plan.confirmation)}`);
    console.log(`Short command: sf-local-reset${modeFlag} --confirm ${JSON.stringify(plan.confirmation)}`);
  } else {
    console.log(forgetOnly
      ? '\nLocal Singularity registrations and personalization are forgotten. Workspace and repository bytes were preserved.'
      : '\nLocal Singularity state is clean. The installed product remains ready to create a new workspace.');
    console.log('Next: open VS Code and choose or create a workspace.');
  }
}

async function localResetCommand(options) {
  const dryRun = optionBoolean(options, 'dry-run');
  const forgetOnly = optionBoolean(options, 'forget-only');
  const json = optionBoolean(options, 'json');
  if (dryRun && options.confirm != null) {
    throw new SingularityFlowError('local-reset --dry-run does not accept --confirm. Review the preview first.');
  }
  const resetOptions = {
    homeDirectory: os.homedir(),
    projectDirectory: process.cwd(),
    environment: process.env,
    forgetOnly
  };
  let result;
  if (dryRun) {
    result = await localResetPlan(resetOptions);
  } else if (options.confirm != null) {
    result = await localReset({ ...resetOptions, confirmation: optionString(options, 'confirm') });
  } else {
    const preview = await localResetPlan(resetOptions);
    if (json || !input.isTTY || !output.isTTY) {
      const modeFlag = forgetOnly ? ' --forget-only' : '';
      throw new SingularityFlowError(
        `Non-interactive local-reset requires an explicit preview and confirmation. Run 'singularity-flow local-reset${modeFlag} --dry-run', then rerun with --confirm ${JSON.stringify(preview.confirmation)}.`
      );
    }
    renderLocalResetPlan(preview);
    const terminal = readline.createInterface({ input, output });
    let answer = null;
    try {
      answer = await terminal.question(`\nType ${JSON.stringify(preview.confirmation)} to continue, or press Enter to cancel: `);
    } catch {
      answer = null;
    } finally {
      terminal.close();
    }
    if (answer !== preview.confirmation) {
      console.log('\nLocal reset cancelled. No changes were made.');
      result = { ...preview, cancelled: true, completed: false };
    } else {
      result = await localReset({ ...resetOptions, confirmation: answer });
    }
  }
  const narration = commandResult({
    operation: { id: 'local-reset', classification: 'mutation' },
    outcome: dryRun || result.cancelled
      ? noop(result.cancelled ? 'local-reset.cancelled' : 'local-reset.previewed', {
        workspaces: result.workspaces.length,
        mode: result.mode
      })
      : succeeded('local-reset.completed', { workspaces: result.workspaces.length }),
    effects: effects(dryRun || result.cancelled ? {} : { stateChanged: true, filesChanged: true }),
    restState: 'informational',
    data: result
  });
  if (!json && !result.cancelled) renderLocalResetPlan(result);
  emitCommandResult(narration, { json });
  return result;
}

async function freshInstallCommand(options) {
  if (optionBoolean(options, 'json')) {
    throw new SingularityFlowError('fresh-install streams the installer output and does not support --json. Run it without --json.');
  }
  const requestedCheckout = path.resolve(optionString(options, 'checkout', process.cwd()));
  const checkout = await realpath(requestedCheckout).catch(() => requestedCheckout);
  const resolved = run('git', ['rev-parse', '--show-toplevel'], { cwd: checkout, allowFailure: true });
  if (resolved.status !== 0 || path.resolve(resolved.stdout.trim()) !== checkout) {
    throw new SingularityFlowError(
      `Fresh install requires the root of a Singularity Flow source checkout. Use --checkout <directory>: ${checkout}`
    );
  }
  const packageFile = path.join(checkout, 'package.json');
  const installer = path.join(checkout, 'install.sh');
  const packageInfo = await lstat(packageFile).catch(() => null);
  const installerInfo = await lstat(installer).catch(() => null);
  if (!packageInfo?.isFile() || packageInfo.isSymbolicLink() || !installerInfo?.isFile() || installerInfo.isSymbolicLink()) {
    throw new SingularityFlowError(`The selected checkout does not contain regular package.json and install.sh files: ${checkout}`);
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(packageFile, 'utf8')); }
  catch (error) { throw new SingularityFlowError(`Unable to read ${packageFile}: ${error.message}`); }
  if (manifest.name !== 'singularity-flow') {
    throw new SingularityFlowError(`The selected checkout is not the Singularity Flow product repository: ${checkout}`);
  }
  const trackedInstaller = run('git', ['ls-files', '--error-unmatch', '--', 'install.sh'], {
    cwd: checkout,
    allowFailure: true
  });
  if (trackedInstaller.status !== 0) {
    throw new SingularityFlowError(`Refusing to run an untracked installer: ${installer}`);
  }
  const installerArgs = [installer, '--factory-reset'];
  if (optionBoolean(options, 'yes')) installerArgs.push('--yes');
  const registry = optionString(options, 'registry');
  if (registry) installerArgs.push('--registry', registry);
  if (optionBoolean(options, 'cli-only')) installerArgs.push('--cli-only');
  if (options['copilot-telemetry'] === false) installerArgs.push('--no-copilot-telemetry');
  const result = run('bash', installerArgs, { cwd: checkout, stdio: 'inherit', allowFailure: true });
  if (result.status !== 0) {
    throw new SingularityFlowError(`Fresh install failed with exit code ${result.status}. Review the installer output above.`);
  }
  return { checkout, applied: optionBoolean(options, 'yes') };
}

async function reinstallCommand(options) {
  const dryRun = optionBoolean(options, 'dry-run');
  const confirmation = optionString(options, 'confirm');
  if (dryRun && confirmation) {
    throw new SingularityFlowError('reinstall --dry-run does not accept --confirm. Review the preview first.');
  }
  const checkout = path.resolve(optionString(options, 'checkout', process.cwd()));
  const cliOnly = optionBoolean(options, 'cli-only');
  const telemetry = !cliOnly && options['copilot-telemetry'] !== false;
  const plan = await resolveReinstallPlan({
    checkout,
    confirmation,
    registry: optionString(options, 'registry'),
    cliOnly,
    telemetry
  });
  // No confirmation is a preview even when --dry-run was omitted. A local product uninstall must
  // never be the accidental result of forgetting a safety flag.
  const result = confirmation
    ? await applyLocalReinstall(plan, { confirmation })
    : plan;
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(reinstallPlanText(result));
  return result;
}

async function helpCommand(positionals, options) {
  // `help <command>` and `<command> --help` answer the same question, so they render the same page —
  // but only when the name is not already a manual topic. Topics win: several of them share a name
  // with a command, and an existing topic is the richer answer. Note `commandDefinition` throws on
  // an unknown name rather than returning nothing, so the lookup has to be guarded.
  const requested = positionals[1];
  const isCommand = (name) => { try { return Boolean(commandDefinition(name)); } catch { return false; } };
  if (requested && !optionBoolean(options, 'json') && isCommand(requested)) {
    const topic = await loadHelpDocument(requested).catch(() => null);
    if (!topic) {
      const { renderCommandHelp } = await import('./help-pages.mjs');
      return console.log(renderCommandHelp(requested));
    }
  }
  const document = await loadHelpDocument(requested);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(document, null, 2));
  else process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
}

/**
 * Refuse to cut a Story branch from an application branch that does not carry the governed
 * definition and has no approved configuration authority to materialize.
 *
 * Approved configuration belongs to `sflow/config`, not application main. When that authority is
 * available, start deliberately cuts the Story from the application base and materializes the exact
 * approved revision into it. This guard is therefore only for the older branch-local case where the
 * current checkout has governance but no approved configuration authority exists anywhere.
 */
function assertBaseCarriesGovernance(root, {
  config, branchName, base, remote, currentBranch, configurationRemote
}) {
  // Reached only when this repository carries its own governance in the working tree — the `init`
  // path. A bootstrapped repository has no local definition at all: it resolves configuration from
  // the `sflow/config` branch and materializes it into the Story branch at start, so `config` is
  // null here and the guard correctly does nothing.
  // Only meaningful when the definition is in this working tree. A repository governed from the
  // workspace lead's `sflow/config` branch legitimately has no definition on its own base branch.
  if (configurationRemote || !config || !base) return;
  if (refExists(root, `refs/heads/${branchName}`)) return;
  const baseRef = [`refs/heads/${base}`, `refs/remotes/${remote}/${base}`]
    .find((ref) => refExists(root, ref));
  if (!baseRef || fileAtRef(root, baseRef, WORKFLOW_PATH) !== null) return;
  throw new SingularityFlowError(
    `Base branch '${base}' does not carry ${WORKFLOW_PATH} yet, so a Story branch cut from it would `
    + `lose the governed definition currently on '${currentBranch}'.\n`
    + `Publish the reviewed governance to 'sflow/config' first, then run this again. `
    + `The application branch '${base}' does not need to change. Nothing was changed.`
  );
}

async function retainCapabilityPublicationRecovery(root, workId, publication, entries, error, {
  rootPublished = false
} = {}) {
  if (!entries?.length) return null;
  const existing = await readPendingPublication(root, { kind: 'story', id: workId });
  // A failure before the governed Story commit exists is fully rolled back by the publication unit;
  // there is no root branch to recover and sibling refs must remain absent too.
  if (!rootPublished && !existing) return null;
  const record = existing?.record ?? {
    schemaVersion: 2,
    subject: { kind: 'story', id: workId },
    branch: publication.branch,
    remote: publication.remote,
    commit: publication.commit,
    event: null,
    createdAt: nowIso()
  };
  const next = {
    ...record,
    recoveryStage: record.recoveryStage ?? 'capability-publication-pending',
    capabilityPublications: entries,
    error: error?.message ?? String(error ?? 'Capability Story publication is incomplete.')
  };
  await writePendingPublication(root, { kind: 'story', id: workId, record: next });
  return next;
}

export async function startCommand(positionals, options) {
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  let config = existsSync(path.join(root, WORKFLOW_PATH)) ? await loadConfig(root) : null;
  // At this point the command has not established whether this is new work or an existing Story
  // carrying an older pinned policy. Enforce the transport-safe shape now; the selected lifecycle
  // branch enforces its exact `idPattern` below, while genuinely new work uses current configuration.
  validateId({
    idPattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    defaultBaseBranch: config?.defaultBaseBranch
  }, id);
  const receiptToken = optionString(options, 'selection-receipt');
  let receipt = null;
  if (!optionBoolean(options, 'allow-dirty')) assertClean(root);
  if (receiptToken && config) {
    // A base-branch answer is needed before checkout, so the one-time receipt is resolved while it
    // is still bound to the HEAD on which the contributor reviewed it. Workflow and source answers
    // are validated again against the definition loaded from the selected base below.
    receipt = await resolveSelectionReceipt(root, config, receiptToken, { action: 'start', workId: id });
  }
  const jira = optionBoolean(options, 'jira');
  const githubReference = optionString(options, 'github');
  const storyFile = optionString(options, 'story-file');
  if ([jira, Boolean(githubReference), Boolean(storyFile)].filter(Boolean).length > 1) {
    throw new SingularityFlowError('Choose exactly one of --jira, --github, or --story-file.');
  }
  const title = optionString(options, 'title');
  const description = optionString(options, 'description');
  const acceptanceCriteria = optionString(options, 'acceptance-criteria');
  const explicitFiles = optionStrings(options, 'document');
  const explicitUrls = optionStrings(options, 'document-url');
  const hasManualInput = Boolean(storyFile || title || description || acceptanceCriteria || explicitFiles.length || explicitUrls.length);
  const declaredSource = githubReference ? 'github-issue' : jira ? 'jira' : hasManualInput ? 'manual' : null;
  let externalSourcePromise = null;
  const externalSource = () => {
    if (!externalSourcePromise) {
      externalSourcePromise = githubReference
        ? getGitHubIssue(githubReference)
        : jira ? getIssue(id).then((source) => normalizeWorkSource(source, { rawRef: id, fetchedAt: nowIso() }))
          : Promise.resolve(null);
    }
    return externalSourcePromise;
  };
  const explicitBase = optionString(options, 'base');
  const canonicalBranch = optionString(options, 'ref', id);
  const remote = config?.git?.remote ?? 'origin';
  const applicationRemote = run('git', ['remote', 'get-url', remote], {
    cwd: root, allowFailure: true
  }).stdout.trim();
  const applicationDefault = applicationRemote
    ? remoteDefaultBranch(applicationRemote,
      run('git', ['ls-remote', '--symref', applicationRemote, 'HEAD'], { allowFailure: true }).stdout)
    : 'main';
  const storySeedRelative = posix(path.join('singularity', 'seeds', `${id}.yml`));
  const localStoryRef = `refs/heads/${canonicalBranch}`;
  const durableStoryAtRef = async (ref, branchName) => {
    const index = await buildRepositorySubjectIndexFromRefs(root, {
      definition: config ?? {}, refs: [{ branch: branchName, ref }]
    });
    return resolveContext(index, { reference: id, kind: 'story', required: false });
  };

  // Starting is idempotent for durable Stories. A local workflow does not need a new base choice;
  // it is resumed from its own recorded branch and resolution. This check intentionally precedes
  // every remote/base prompt so an offline contributor can resume work already present locally.
  const localStory = refExists(root, localStoryRef)
    ? await durableStoryAtRef(localStoryRef, canonicalBranch)
    : null;
  if (localStory) {
    const requested = await externalSource();
    const existingIdentity = workflowSourceIdentity(localStory.state);
    if (requested?.stableId && existingIdentity && requested.stableId !== existingIdentity) {
      throw new SingularityFlowError(
        `Story '${id}' already belongs to source '${existingIdentity}', not '${requested.stableId}'. Nothing was changed.`,
        { code: 'STORY_SOURCE_CONFLICT' }
      );
    }
    return resumeCommand(['resume', id], { ...options, fetch: false });
  }

  // Probe the exact destination ref without substituting local branches. When it exists, fetch it
  // so we can distinguish a durable workflow (Resume) from an Epic-materialized seed whose parent
  // base is already pinned. A failed probe is left for storyBaseCatalog to report with the stable
  // STORY_REMOTE_UNREACHABLE refusal used by every surface.
  let remoteStoryRef = `refs/remotes/${remote}/${canonicalBranch}`;
  const remoteStoryProbe = applicationRemote
    ? run('git', ['ls-remote', '--heads', '--', applicationRemote, `refs/heads/${canonicalBranch}`], {
      cwd: root, allowFailure: true
    })
    : { status: 1, stdout: '' };
  if (remoteStoryProbe.status === 0 && remoteStoryProbe.stdout.trim()) {
    fetchRemote(root, remote);
    const remoteStory = await durableStoryAtRef(remoteStoryRef, canonicalBranch);
    if (remoteStory) {
      const requested = await externalSource();
      const existingIdentity = workflowSourceIdentity(remoteStory.state);
      if (requested?.stableId && existingIdentity && requested.stableId !== existingIdentity) {
        throw new SingularityFlowError(
          `Published Story '${id}' belongs to source '${existingIdentity}', not '${requested.stableId}'. Nothing was changed.`,
          { code: 'STORY_SOURCE_CONFLICT' }
        );
      }
      return resumeCommand(['resume', id], { ...options, fetch: true });
    }
  }

  // A stable external identity wins over a proposed new Work ID. Fetch and search the governed
  // refs before choosing a base or checking out a branch, then attach to the existing Story.
  const requestedExternalSource = await externalSource();
  if (requestedExternalSource?.stableId) {
    fetchRemote(root, remote);
    const refs = [
      ...localBranches(root).map((branchName) => ({ branch: branchName, ref: branchName })),
      ...remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` }))
    ];
    const sourceIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: config ?? {}, refs });
    const existing = resolveContext(sourceIndex, {
      reference: requestedExternalSource.stableId, kind: 'story', required: false
    });
    if (existing) {
      if (!optionBoolean(options, 'json')) {
        console.log(`Source ${requestedExternalSource.stableId} is already governed as ${existing.id}; attaching instead of creating ${id}.`);
      }
      return resumeCommand(['resume', existing.id], { ...options, fetch: true });
    }
  }

  const preselectedWorkType = receipt?.answers['workflow-template'] ?? optionString(options, 'work-type');
  if (preselectedWorkType === 'poc-workflow') {
    normalizeMcpTargetOrigin(optionString(options, 'target-url'), {
      required: true,
      label: 'POC target URL'
    });
  }

  const materializedSeedText = fileAtRef(root,
    refExists(root, remoteStoryRef) ? remoteStoryRef : localStoryRef,
    storySeedRelative);
  let materializedSeed = null;
  if (materializedSeedText !== null) {
    materializedSeed = YAML.parse(materializedSeedText)?.story ?? null;
    if ((materializedSeed?.workId ?? materializedSeed?.id) !== id) {
      throw new SingularityFlowError(
        `Published Story branch '${canonicalBranch}' carries a seed for a different Story. Nothing was changed.`,
        { code: 'STORY_BRANCH_EXISTS' }
      );
    }
    if (!materializedSeed.parentBranch || !materializedSeed.baseCommit) {
      throw new SingularityFlowError(
        `Materialized Story '${id}' does not record its pinned parent branch and base commit. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
  }
  if (config && !materializedSeed) validateId(config, id);
  /**
   * The base branch, chosen once for the whole capability.
   *
   * A Story is one unit of work but a capability is usually several repositories, and `--base` only
   * ever spoke for the one this command runs in. `--from-branch` speaks for all of them: it is
   * resolved against what each repository actually publishes, refuses before anything is touched if
   * any of them lack it, and is recorded per repository so the evidence says what the work was
   * really built on.
   *
   * Absent both flags, a terminal presents the remote-derived choices and requires an answer;
   * non-interactive callers receive STORY_BASE_REQUIRED before any checkout or session mutation.
   */
  const fromBranch = optionStrings(options, 'from-branch');
  if (explicitBase && fromBranch.length) {
    throw new SingularityFlowError('Choose either --from-branch or the compatibility --base option, not both.', {
      code: 'STORY_BASE_INVALID'
    });
  }
  const receiptBase = receipt?.answers?.['base-branch'] ?? null;
  const requestedBase = fromBranch.length
    ? fromBranch
    : receiptBase
      ? [receiptBase]
      : explicitBase
        ? [explicitBase]
        : [];
  const {
    storyBaseForRepository, preflightStoryRepositories,
    capabilityPublicationPlan, prepareCapabilityRepositories, printCapabilityBase,
    publishCapabilityRepositories, rollbackCapabilityRepositories
  } = await import('./capability-start.mjs');
  if (materializedSeed && requestedBase.length
    && requestedBase.some((value) => value !== materializedSeed.parentBranch)) {
    throw new SingularityFlowError(
      `Story '${id}' is already materialized from '${materializedSeed.parentBranch}'. Its pinned base is read-only.`,
      { code: 'STORY_BASE_INVALID' }
    );
  }
  const storyBase = materializedSeed
    ? {
        scope: 'materialized',
        capability: null,
        remote,
        localBase: materializedSeed.parentBranch,
        pinnedBaseCommit: materializedSeed.baseCommit
      }
    : await storyBaseForRepository(root, {
        values: requestedBase,
        interactive: !optionBoolean(options, 'json') && !optionBoolean(options, 'yes') && !receiptToken,
        remote,
        defaultBranch: config?.defaultBaseBranch ?? applicationDefault,
        capabilityId: optionString(options, 'capability')
      });
  if (explicitBase && storyBase.scope === 'capability') {
    throw new SingularityFlowError(
      '--base is a compatibility alias for a standalone repository. Use --from-branch for a capability.',
      { code: 'STORY_BASE_INVALID' }
    );
  }
  const baseAtStart = storyBase.localBase;
  const publishRequired = (config?.git?.publish ?? 'required') !== 'off';
  const capabilityPreflight = storyBase.scope === 'capability'
    ? await preflightStoryRepositories(storyBase.workspaceRoot, storyBase.plan, canonicalBranch, {
        remote, publishRequired, lifecycleRoot: root, capabilityId: storyBase.capability
      })
    : null;
  const capabilityPublications = capabilityPublicationPlan(capabilityPreflight, root);
  const configurationRemote = await resolveConfigurationRemote(root, remote);
  if (!config && !configurationRemote) {
    throw new SingularityFlowError(
      `Missing ${WORKFLOW_PATH}. This repository is not inside an active workspace whose lead `
      + `repository has the approved sflow/config branch. Map and approve the workspace capability first.`);
  }
  const originalBranch = branch(root);
  // Fetch and prove the exact source and destination before the first checkout or session change.
  // Listing branches establishes read access; this dry-run additionally establishes that the
  // configured publication remote will accept the new Story ref.
  fetchRemote(root, remote);
  const remoteBaseRef = `refs/remotes/${remote}/${baseAtStart}`;
  if (!materializedSeed && !refExists(root, remoteBaseRef)) {
    throw new SingularityFlowError(
      `Selected base branch '${baseAtStart}' is no longer published by remote '${remote}'. Nothing was changed.`,
      { code: 'STORY_BASE_INVALID' }
    );
  }
  if (!materializedSeed && refExists(root, remoteStoryRef)) {
    throw new SingularityFlowError(
      `Story branch '${canonicalBranch}' already exists on '${remote}'. Resume it instead of starting it again. Nothing was changed.`,
      { code: 'STORY_BRANCH_EXISTS' }
    );
  }
  const baseCommitAtStart = materializedSeed?.baseCommit ?? refHead(root, remoteBaseRef);
  if (publishRequired && !capabilityPreflight) {
    const dryRun = preflightPushBranch(
      root, remote, materializedSeed ? remoteStoryRef : remoteBaseRef, canonicalBranch
    );
    if (dryRun.status !== 0) {
      throw new SingularityFlowError(
        `Cannot publish the new Story branch '${canonicalBranch}' to '${remote}'. `
        + `Git reported: ${(dryRun.stderr || dryRun.stdout || 'remote rejected the dry-run push').trim()} Nothing was changed.`,
        { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' }
      );
    }
  }
  assertBaseCarriesGovernance(root, {
    config, branchName: canonicalBranch, base: baseAtStart, remote, currentBranch: originalBranch,
    configurationRemote
  });
  const originalSession = await loadSession(root, { required: false });
  const originalCopilotSession = await loadCopilotSession(root);
  let createdBranch = false;
  let capabilityRepositoriesPrepared = null;
  let configurationSnapshot = null;
  let configurationRestorePoint = null;
  let configurationMaterializationStarted = false;
  try {
  const checkoutResult = checkout(root, canonicalBranch, materializedSeed
    ? { base: baseAtStart, fetch: true, existingOnly: true, remote }
    : { base: baseAtStart, fetch: false, remote, preferRemoteBase: true });
  createdBranch = checkoutResult.startsWith('created-from-');

  /**
   * The siblings follow the same base.
   *
   * After this repository, not before: if the Story cannot start here there is no reason to have
   * moved four other repositories onto a branch for it. Each is refused if dirty, and a repository
   * the workspace has not cloned is named rather than silently left behind.
   */
  if (storyBase.scope === 'capability') {
    capabilityRepositoriesPrepared = prepareCapabilityRepositories(
      storyBase.workspaceRoot, storyBase.plan, canonicalBranch, { remote }
    );
    if (!optionBoolean(options, 'json')) printCapabilityBase(storyBase.plan, capabilityRepositoriesPrepared);
  }
  // Application branches do not own shared configuration. A new Story receives the exact approved
  // configuration revision here, before any selection or generation happens, and the initial Story
  // commit publishes the copied files together with their provenance record.
  if (createdBranch && configurationRemote) {
    configurationRestorePoint = await captureConfigurationState(root);
    configurationMaterializationStarted = true;
    configurationSnapshot = await materializeConfigurationSnapshot(root, {
      remote: configurationRemote,
      remoteName: remote
    });
  }
  // The selected lifecycle branch, not the checkout the user happened to start from, owns the
  // workflow definition. Reload after materialization so a newly fetched phase graph, agent,
  // template, or world-model policy is what gets pinned into the Story.
  config = await loadConfig(root);
  validateId(config, id);
  if (receiptToken && !receipt) {
    throw new SingularityFlowError('A start selection receipt requires an initialized governed definition before checkout.');
  }
  const receiptSource = receipt?.answers['intake-source'] ?? null;
  if (declaredSource && receiptSource && declaredSource !== receiptSource) {
    throw new SingularityFlowError(
      `Selection receipt chose ${receiptSource} intake, but the start command explicitly requests ${declaredSource} intake.`);
  }
  // A materialized Story arrives on a branch carrying its own governed seed — the requirements, the
  // specification and the traceability are already pinned there. Asking where the work came from is
  // asking a question the branch has already answered, and asking it interactively made starting a
  // materialized Story impossible without a terminal.
  const seeded = existsSync(path.join(root, 'singularity', 'seeds', `${id}.yml`));
  const sourceMode = declaredSource
    ?? receiptSource
    ?? (seeded ? 'manual' : null)
    ?? await selectIntakeSource({
      selection: null,
      nonInteractiveHint: 'Pass --jira, or --title with --description, to say where the work came from.'
    });
  // A governed seed already carries the title, the description and the acceptance criteria the
  // manual prompts ask for — they were written during planning and hash-pinned onto this branch.
  // Asking again invites a second, divergent answer to a question already settled.
  const seed = seeded && !storyFile && !title && !description && !acceptanceCriteria
    ? YAML.parse(await readFile(path.join(root, 'singularity', 'seeds', `${id}.yml`), 'utf8'))?.story ?? null
    : null;
  const manual = sourceMode === 'manual'
    ? (seed
        ? await loadManualStory(id, {
          title: seed.title ?? id,
          description: seed.description ?? '',
          acceptanceCriteria: (seed.acceptanceCriteria ?? []).join('\n')
        })
        : storyFile || title || description || acceptanceCriteria
          ? await loadManualStory(id, { storyFile, title, description, acceptanceCriteria })
          : await promptManualStory(id))
    : null;
  const normalizedManualSource = manual ? normalizeWorkSource(manual.source) : null;
  let source = requestedExternalSource
    ?? (sourceMode === 'jira'
      ? normalizeWorkSource(await getIssue(id), { rawRef: id, fetchedAt: nowIso() })
      : {
          ...normalizedManualSource,
          // Manual source.json predates WorkSourceV1 and stores criteria as Markdown. Preserve that
          // public artifact shape while the normalized hash and provider contract remain list-based.
          acceptanceCriteria: manual.source.acceptanceCriteria
        });
  const supportingDocuments = [
    ...(manual?.documents ?? []),
    ...explicitFiles.map((candidate) => ({ type: 'file', path: candidate, label: null, kind: null })),
    ...explicitUrls.map((url) => ({ type: 'url', url, label: null, kind: null }))
  ];
  // The seed's `suggestedWorkType` is the planning phase's answer to this question, so it is used
  // rather than asked again. `--work-type` covers the unseeded case without a terminal.
  const workType = await selectWorkType(config, {
    selection: receipt?.answers['workflow-template'] ?? optionString(options, 'work-type') ?? seed?.suggestedWorkType ?? null,
    nonInteractiveHint: 'Pass --work-type <id> to choose one without a terminal.'
  });
  const targetOrigin = normalizeMcpTargetOrigin(optionString(options, 'target-url'), {
    required: workType === 'poc-workflow',
    label: 'POC target URL'
  });
  if (targetOrigin) source = { ...source, targetOrigin };
  const resolvedWorkType = resolveWorkType(config, workType);
  const selectedAgent = await activatePhaseAgent(
    root, config, id, resolvedWorkType.phases[0], optionString(options, 'agent') ?? null
  );
  let base = baseAtStart;
  const seedFile = path.join(root, 'singularity', 'seeds', `${id}.yml`);
  if (existsSync(seedFile)) {
    const seed = YAML.parse(await readFile(seedFile, 'utf8'));
    if (seed?.story?.workId !== id && seed?.story?.id !== id) {
      throw new SingularityFlowError(`Story seed ${posix(path.relative(root, seedFile))} does not belong to Work ID '${id}'.`);
    }
    source = {
      ...source,
      type: source.type ?? 'jira',
      key: seed.story.jiraKey ?? source.key ?? id,
      id: seed.story.jiraIssueId ?? source.id ?? null,
      epicId: seed.initiative?.id ?? seed.story.epicId ?? null,
      planId: seed.story.planId ?? null,
      branchCompletionPolicy: seed.story.branchCompletionPolicy ?? 'pr',
      requiredChecks: seed.story.requiredChecks ?? [],
      parentBranch: seed.story.parentBranch ?? null,
      seed: posix(path.relative(root, seedFile))
    };
    // Materialization records the branch this story was actually cut from. Use it as the work
    // item's base so change detection (`<base>...HEAD`) sees only the story's own commits, not
    // the epic branch's governance artifacts.
    if (!explicitBase && seed.story.parentBranch) base = seed.story.parentBranch;
  }
  const workflow = await createWorkflow(root, config, {
    id,
    title: optionString(options, 'title', source.title || id),
    source,
    baseBranch: base,
    baseCommit: baseCommitAtStart,
    baseRemote: remote,
    canonicalBranch,
    workType,
    agent: selectedAgent.agent,
    resolved: resolvedWorkType,
    capabilityId: optionString(options, 'capability')
  });
  const returnLocator = await writeReturnLocator(root, config, workflow);
  let publication;
  try {
    publication = await commitAndPublish(
      root,
      config,
      workflow,
      { type: 'binding', payload: configurationSnapshot ? {
        configurationBranch: configurationSnapshot.branch,
        configurationCommit: configurationSnapshot.commit
      } : {} },
      `[${id}][init] start ${workType} workflow`,
      [...(configurationSnapshot?.paths ?? []), returnLocator.path]
    );
  } catch (error) {
    await retainCapabilityPublicationRecovery(root, id, {
      remote, branch: canonicalBranch, commit: head(root)
    }, capabilityPublications, error);
    throw error;
  }
  // Spent once the start has landed, not before it is attempted.
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
  try {
    for (const document of supportingDocuments) {
      const records = await addDocuments(root, config, workflow, {
        files: document.type === 'file' ? [document.path] : [],
        url: document.type === 'url' ? document.url : null,
        label: document.label,
        kind: document.kind
      });
      await commitAndPublish(root, config, workflow, { type: 'evidence-recorded', payload: { documents: records.map((item) => item.id) } }, `[${id}][documents][upload] ${records.map((item) => item.id).join(',')}`);
    }
  } catch (error) {
    await retainCapabilityPublicationRecovery(root, id, {
      remote, branch: canonicalBranch, commit: head(root)
    }, capabilityPublications, error);
    throw error;
  }
  let capabilityPublication = { published: [], pending: [], error: null };
  if (publication.pushed && capabilityPublications.length) {
    // Make the cross-repository tail crash-recoverable before the first sibling ref moves. The root
    // Story is already durable; `sync` can now finish the exact remaining refs after interruption.
    await retainCapabilityPublicationRecovery(root, id, {
      remote, branch: canonicalBranch, commit: head(root)
    }, capabilityPublications, new Error('Capability Story branch publication is in progress.'), {
      rootPublished: true
    });
    capabilityPublication = publishCapabilityRepositories(capabilityPublications);
    if (capabilityPublication.pending.length) {
      const failure = new SingularityFlowError(
        `Story '${id}' was published in its lifecycle repository, but capability branch publication `
        + `failed for '${capabilityPublication.pending[0].repository}': ${capabilityPublication.error}. `
        + 'The remaining exact branch publications were retained; run singularity-flow sync after fixing remote access.',
        { code: 'STORY_CAPABILITY_PUBLICATION_PENDING' }
      );
      await retainCapabilityPublicationRecovery(root, id, {
        remote, branch: canonicalBranch, commit: head(root)
      }, capabilityPublication.pending, failure, { rootPublished: true });
      throw failure;
    }
    await clearPendingPublication(root, { kind: 'story', id });
  } else if (!publication.pushed && capabilityPublications.length) {
    await retainCapabilityPublicationRecovery(root, id, {
      remote, branch: canonicalBranch, commit: head(root)
    }, capabilityPublications, new Error('The lifecycle Story branch is still pending publication.'));
  }
  const startResult = commandResult({
    operation: { id: 'start', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('start.succeeded', {
      workId: workflow.workItem.id,
      branch: workflow.workItem.branch,
      phase: workflow.currentPhase
    }),
    // Creates the branch, writes the pinned resolution, and publishes the opening commit.
    effects: effects({ filesChanged: true, stateChanged: true, publicationCreated: true }),
    data: {
      workItem: { id: workflow.workItem.id, branch: workflow.workItem.branch, title: workflow.workItem.title },
      id: workflow.workItem.id,
      workType,
      currentPhase: workflow.currentPhase,
      documents: supportingDocuments.length,
      // Present only when a capability base was chosen, so `--json` consumers can tell the
      // single-repository start from the capability-wide one instead of inferring it.
      base: {
        branch: base,
        commit: baseCommitAtStart,
        remote
      },
      publication: {
        remote,
        branch: workflow.workItem.branch,
        ref: `refs/heads/${workflow.workItem.branch}`,
        pushed: publication.pushed === true,
        commit: publication.sha
      },
      returnLocator: {
        path: returnLocator.path,
        integritySha256: returnLocator.locator.integritySha256,
        portability: returnLocator.locator.repositories.every((repository) => repository.portability === 'portable')
          ? 'portable'
          : 'partial'
      },
      measurement: workflow.measurement?.plan ? {
        status: workflow.measurement.status,
        studyId: workflow.measurement.plan.studyId,
        studyRunId: workflow.measurement.plan.studyRunId ?? null,
        cohort: workflow.measurement.plan.groupId,
        promptVariant: workflow.measurement.plan.variantId ?? null
      } : { status: workflow.measurement?.status ?? 'not-enrolled' },
      ...(storyBase.scope === 'capability' ? {
        capabilityBase: {
          ...storyBase.plan.record,
          prepared: capabilityRepositoriesPrepared ?? [],
          publications: capabilityPublication.published
        }
      } : {})
    },
    next: [
      narrationAction({
        id: 'start.prepare',
        label: `Materialise the ${workflow.currentPhase} artifact so it can be filled in`,
        command: `singularity-flow prepare ${workflow.currentPhase}`
      }),
      narrationAction({
        id: 'start.help',
        label: 'See what this phase expects',
        command: `singularity-flow phase show ${workflow.currentPhase}`,
        rank: 'LATER'
      })
    ]
  });
  if (!optionBoolean(options, 'json')) {
    summary(workflow);
    if (workflow.measurement?.plan?.variantId) {
      console.log(`Prompt study assignment: ${workflow.measurement.plan.variantId} · ${workflow.measurement.plan.studyRunId}.`);
    }
    if (supportingDocuments.length) console.log(`Supporting documents: ${supportingDocuments.length} uploaded and published.`);
  }
  emitCommandResult(startResult, { json: optionBoolean(options, 'json'), postState: workflow });
  } catch (error) {
    // Selection and validation happen against the lifecycle branch because that branch owns the
    // workflow definition and any governed Story seed. If those preflight steps fail before state
    // exists, restore the caller's branch and remove only the branch this invocation created.
    // Existing remote/local Story branches and partially-created workflow state are never deleted.
    const workflowCreated = config ? existsSync(workflowPath(root, config, id)) : false;
    if (!workflowCreated) {
      const rollbackFailures = rollbackCapabilityRepositories(
        capabilityRepositoriesPrepared, canonicalBranch
      );
      if (rollbackFailures.length) {
        console.warn(
          `Warning: start failed before creating workflow state, and capability rollback failed for `
          + `${rollbackFailures.join('; ')}. The original error follows.`
        );
      }
      await restoreAgentSession(root, originalSession);
      await restoreCopilotSession(root, originalCopilotSession);
      if (configurationMaterializationStarted && configurationRestorePoint) {
        try {
          await restoreConfigurationState(root, configurationRestorePoint);
        } catch (rollbackError) {
          console.warn(
            `Warning: start failed before creating workflow state, and configuration rollback failed: `
            + `${rollbackError.message}. The original error follows.`
          );
        }
      }
    }
    if (createdBranch && !workflowCreated) {
      const restored = run('git', ['switch', originalBranch], { cwd: root, stdio: 'inherit', allowFailure: true });
      if (restored.status === 0) {
        run('git', ['branch', '-D', canonicalBranch], { cwd: root, stdio: 'inherit', allowFailure: true });
      } else {
        console.warn(`Warning: start failed before creating workflow state, but Git could not restore branch '${originalBranch}'. The original error follows.`);
      }
    }
    throw error;
  }
}

function printSelectionReceipt(receipt) {
  console.log(`Selection receipt: ${receipt.token}`);
  console.log(`Action: ${receipt.action} ${receipt.workId} · expires: ${receipt.expiresAt}`);
  for (const choices of receipt.choiceSets) {
    const selected = receipt.answers?.[choices.id]?.id;
    console.log(`\n${choices.label}${selected ? ` — selected: ${selected}` : ''}`);
    for (const item of choices.options) console.log(`  ${item.id}\t${item.label}${item.description ? ` — ${item.description}` : ''}`);
  }
  console.log(`\nReady: ${receipt.ready ? 'yes' : 'no'}`);
}

async function choicesCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'choices subcommand');
  const root = repoRoot();
  let config = await loadConfig(root);
  let receipt;
  if (subcommand === 'begin') {
    const action = requirePositional(positionals, 2, 'selection action');
    const workId = requirePositional(positionals, 3, 'work ID');
    validateId(config, workId);
    let workflow = null;
    if (action === 'approve') {
      assertClean(root);
      if (workId !== branch(root) || optionBoolean(options, 'fetch')) checkout(root, workId, {
        base: config.defaultBaseBranch,
        fetch: optionBoolean(options, 'fetch'),
        existingOnly: true,
        remote: config.git?.remote ?? 'origin'
      });
      config = await loadConfig(root);
      workflow = await loadStoryAggregate(root, config, workId);
      await assertNoPendingPublication(root, config, workflow, 'prepare an approval selection');
    }
    receipt = await beginSelectionReceipt(root, config, { action, workId, workflow });
  } else if (subcommand === 'answer') {
    receipt = await answerSelectionReceipt(
      root,
      requirePositional(positionals, 2, 'selection receipt token'),
      requirePositional(positionals, 3, 'choice ID'),
      requirePositional(positionals, 4, 'selected option ID')
    );
  } else if (subcommand === 'status') receipt = await selectionReceiptStatus(root, requirePositional(positionals, 2, 'selection receipt token'));
  else throw new SingularityFlowError(`Unknown choices subcommand: ${subcommand}`);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2));
  else printSelectionReceipt(receipt);
}

async function resumeCommand(positionals, options) {
  const reference = requirePositional(positionals, 1, 'work ID or branch reference');
  const root = repoRoot();
  const discovery = await sessionDiscoveryConfiguration(root, sessionRepositoryAuthority(root));
  const initialConfig = discovery.definition;
  const fetch = optionBoolean(options, 'fetch');
  const remote = discovery.remote;
  if (fetch) fetchRemote(root, remote);
  const refs = [
    { branch: branch(root), ref: branch(root) },
    ...localBranches(root).map((branchName) => ({ branch: branchName, ref: branchName })),
    ...(fetch ? remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` })) : [])
  ];
  const refIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: initialConfig, refs });
  const refSubject = resolveContext(refIndex, { reference, kind: 'story', required: false });
  const resolved = refSubject
    ? { workId: refSubject.id, branch: refSubject.canonicalBranch, selectedBranch: refSubject.selectedBranch, workflow: refSubject.state, source: refSubject.source }
    : await resolveWorkItem(root, initialConfig, reference, { mutation: true });
  const targetBranch = resolved.selectedBranch ?? resolved.branch;
  if (branch(root) !== targetBranch && !optionBoolean(options, 'allow-dirty')) assertClean(root);
  checkout(root, targetBranch, { base: initialConfig.defaultBaseBranch, fetch, existingOnly: true, remote });
  const config = await loadConfig(root);
  validateId(config, resolved.workId);
  const workflow = await loadStoryAggregate(root, config, resolved.workId);
  const session = await activatePhaseAgent(
    root, config, resolved.workId, currentPhase(workflow), optionString(options, 'agent') ?? null
  );
  summary(workflow);
  console.log(`Active governed agent: ${session.agent}`);
  const active = currentPhase(workflow);
  if (active) {
    const command = active.id === 'implementation' ? 'implement' : active.id === 'verification' ? 'verify' : active.id;
    console.log(`\nRun: singularity-flow prepare ${active.id}`);
    console.log(`In Copilot: /sf-${command}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'resume', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('resume.succeeded', { workId: workflow.workItem.id, branch: branch(root) }),
    // Resume may check out a different branch and records the local governed-agent selection.
    effects: effects({ filesChanged: true })
  }), { postState: workflow });
}

async function returnCommand(positionals, options) {
  const reference = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  const discovery = await sessionDiscoveryConfiguration(root, sessionRepositoryAuthority(root));
  const initialConfig = discovery.definition;
  const remote = discovery.remote;
  const offline = optionBoolean(options, 'offline');
  if (!offline) fetchRemote(root, remote);
  const refs = remoteBranches(root, remote).map((branchName) => ({
    branch: branchName, ref: `${remote}/${branchName}`
  }));
  const index = await buildRepositorySubjectIndexFromRefs(root, { definition: initialConfig, refs });
  const subject = resolveContext(index, { reference, kind: 'story' });
  const targetBranch = subject.canonicalBranch;
  const remoteRef = `${remote}/${targetBranch}`;
  const sourceCommit = refHead(root, remoteRef);
  if (!sourceCommit) {
    throw new SingularityFlowError(`Published Story ref '${remoteRef}' is unavailable. Nothing was changed.`, {
      code: 'RETURN_REMOTE_REF_UNAVAILABLE'
    });
  }
  const located = readReturnLocatorAtRef(root, initialConfig, subject.id, remoteRef);
  if (located.locator.workBranchRef !== `refs/heads/${targetBranch}`
      && located.locator.lifecycleRef !== `refs/heads/${targetBranch}`) {
    throw new SingularityFlowError(
      `Return locator for '${subject.id}' does not bind published branch '${targetBranch}'. Nothing was changed.`,
      { code: 'RETURN_LOCATOR_BRANCH_MISMATCH' }
    );
  }
  const changed = changes(root).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const localRef = `refs/heads/${targetBranch}`;
  const localCommit = refHead(root, localRef);
  const localCanFastForward = Boolean(localCommit && localCommit !== sourceCommit)
    && run('git', ['merge-base', '--is-ancestor', localCommit, sourceCommit], {
      cwd: root, allowFailure: true
    }).status === 0;
  const localContainsRemote = Boolean(localCommit && localCommit !== sourceCommit)
    && run('git', ['merge-base', '--is-ancestor', sourceCommit, localCommit], {
      cwd: root, allowFailure: true
    }).status === 0;
  const localConflict = Boolean(localCommit && localCommit !== sourceCommit && !localCanFastForward);
  const repositories = located.locator.repositories.map((repository, index) => Object.freeze({
    id: repository.id,
    required: repository.required !== false,
    remote: repository.remote,
    remoteUrl: repository.url,
    portability: repository.portability,
    disposition: repository.id === (located.locator.originRepositoryId ?? located.locator.repositories[0]?.id)
      ? 'existing-clone' : 'clone-or-locate-required'
  }));
  const missingRequiredRepositories = repositories
    .filter((repository) => repository.required && repository.disposition !== 'existing-clone')
    .map((repository) => repository.id);
  const plan = Object.freeze({
    schemaVersion: 1,
    kind: 'story-return-plan',
    workId: subject.id,
    configuredRemote: remote,
    destinationBranch: targetBranch,
    sourceRef: remoteRef,
    sourceCommit,
    currentBranch: branch(root),
    currentCommit: head(root),
    worktree: { clean: changed.length === 0, changedPaths: changed.length },
    localBranch: {
      exists: Boolean(localCommit), commit: localCommit,
      disposition: !localCommit ? 'create-from-remote'
        : localCommit === sourceCommit ? 'already-current'
          : localCanFastForward ? 'fast-forward'
            : localContainsRemote ? 'local-ahead' : 'diverged',
      blocksApply: localConflict
    },
    repositories,
    missingRequiredRepositories,
    locator: { path: located.path, integritySha256: located.locator.integritySha256 },
    freshness: offline ? 'cached-remote-tracking-ref' : 'fetched',
    confirmation: subject.id
  });
  if (!optionBoolean(options, 'apply')) {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(plan, null, 2));
    console.log(`Return plan: ${subject.id}`);
    console.log(`Source: ${remoteRef} @ ${plan.sourceCommit?.slice(0, 12) ?? 'unavailable'}`);
    console.log(`Destination: local ${targetBranch}`);
    console.log(`Worktree: ${plan.worktree.clean ? 'clean' : `${plan.worktree.changedPaths} changed path(s) — must be committed or stashed by you`}`);
    console.log(`Local branch: ${plan.localBranch.disposition}${plan.localBranch.blocksApply ? ' — automatic attach is blocked; reconcile it yourself' : ''}`);
    for (const repository of repositories.filter((entry) => entry.disposition !== 'existing-clone')) {
      console.log(`Required repository: ${repository.id} — ${repository.disposition}`);
    }
    console.log(`Apply with: singularity-flow return ${subject.id} --apply --confirm ${subject.id}`);
    return;
  }
  if (optionString(options, 'confirm') !== subject.id) {
    throw new SingularityFlowError(
      `Returning to '${subject.id}' requires exact confirmation. Preview with singularity-flow return ${subject.id}, then pass --apply --confirm ${subject.id}. Nothing was changed.`,
      { code: 'RETURN_CONFIRMATION_REQUIRED' }
    );
  }
  if (plan.localBranch.blocksApply) {
    throw new SingularityFlowError(
      `Local Story branch '${targetBranch}' is ${plan.localBranch.disposition} from '${remoteRef}'. Automatic Return preserved both histories and changed nothing. Reconcile or rename the local branch, then preview Return again.`,
      { code: 'RETURN_LOCAL_BRANCH_CONFLICT' }
    );
  }
  if (plan.missingRequiredRepositories.length) {
    throw new SingularityFlowError(
      `Return requires additional repository clone(s): ${plan.missingRequiredRepositories.join(', ')}. Automatic attach changed nothing. Prepare or adopt those repositories in a workspace, then preview Return from its lead repository.`,
      { code: 'RETURN_REQUIRED_REPOSITORIES_MISSING' }
    );
  }
  assertClean(root);
  checkout(root, targetBranch, {
    base: initialConfig.defaultBaseBranch, existingOnly: true, remote, fetch: false
  });
  fastForwardTo(root, remoteRef);
  const config = await loadConfig(root);
  validateId(config, subject.id);
  const workflow = await loadStoryAggregate(root, config, subject.id);
  const session = await activatePhaseAgent(
    root, config, workflow.workItem.id, currentPhase(workflow), optionString(options, 'agent') ?? null
  );
  const json = optionBoolean(options, 'json');
  if (!json) {
    summary(workflow);
    console.log(`Returned from ${plan.freshness} evidence at ${plan.sourceCommit.slice(0, 12)}.`);
    console.log(`Active governed agent: ${session.agent}`);
  }
  const active = currentPhase(workflow);
  if (active && !json) {
    const command = active.id === 'implementation' ? 'implement' : active.id === 'verification' ? 'verify' : active.id;
    console.log(`Next: singularity-flow prepare ${active.id}`);
    console.log(`In Copilot: /sf-${command}`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'return', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('resume.succeeded', { workId: workflow.workItem.id, branch: branch(root) }),
    effects: effects({ filesChanged: true }),
    data: { returnPlan: plan }
  }), { json, postState: workflow });
}

async function agentCommand(positionals, options = {}) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, positionals[1]);
  if (!workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Branch '${branch(root)}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  const session = await selectAgent(root, config, actionActor(root), workflow.workItem.id, {
    phaseId: workflow.currentPhase,
    selection: optionString(options, 'agent') ?? null,
    nonInteractiveHint: 'Pass --agent <id> to choose one without a terminal.'
  });
  console.log(`Active governed agent: ${config.agents[session.agent].label} (${session.agent})`);
  console.log(`Session scope: ${workflow.workItem.id} on branch ${branch(root)} (canonical ${workflow.workItem.branch})`);
  console.log('The selection is local to this checkout and will be recorded with the next workflow action.');
  if (session.phaseCompatibilityOverride) console.warn(`Warning: ${session.agent} is not declared for phase '${session.phaseCompatibilityOverride.phase}'. This is an audited prompt override, not approval authority.`);
  emitCommandResult(commandResult({
    operation: { id: 'agent', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('agent.selected', { workId: workflow.workItem.id, agent: session.agent }),
    // Agent selection is local to this checkout. It changes the session record but not governed
    // lifecycle state and does not publish anything.
    effects: effects({ filesChanged: true })
  }), { postState: workflow });
}

export async function statusCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, positionals[1]);
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify(workflow, null, 2));
    return;
  }
  summary(workflow);
  console.log(`\n${table(workflow.phaseOrder.map((id, index) => {
    const phase = workflow.phases[id];
    return { index: index + 1, phase: id, agent: phase.defaultAgent ?? '', status: phase.status, artifacts: phase.artifacts.length };
  }), [
    { key: 'index', label: '#' },
    { key: 'phase', label: 'PHASE' },
    { key: 'agent', label: 'AGENT' },
    { key: 'status', label: 'STATUS' },
    { key: 'artifacts', label: 'ARTIFACTS' }
  ])}`);
  const selfApprovals = workflow.phaseOrder.flatMap((id) => workflow.phases[id].approvals.filter((item) => !item.invalidatedAt && item.selfApproval).map((item) => `${id}: ${item.actor?.name ?? 'unknown'}; agent ${item.agent ?? 'unavailable'}`));
  if (selfApprovals.length) console.warn(`\nSelf-approval warnings (not independent review):\n- ${selfApprovals.join('\n- ')}`);
  const ledger = await ledgerStatus(root, workflow.resolution?.ledger ?? config.ledger ?? {});
  if (ledger.enabled) {
    console.log(`\nCapability ledger: ${ledger.initialized ? ledger.verification.valid ? 'verified' : 'invalid' : 'not initialized'} · pending ${ledger.pending?.length ?? 0} · local outbox ${ledger.outbox}`);
    if (ledger.pending?.length) console.warn(`Run singularity-flow ledger reconcile ${workflow.workItem.id}.`);
  }
}

async function progressCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config, positionals[1]); const progress = progressSnapshot(workflow);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(progress, null, 2));
  console.log(`\n${progress.workId} — ${progress.workType}`);
  console.log(`${progressBar(progress.percentage)} ${progress.percentage}%`);
  console.log(`${progress.approvedPhases} of ${progress.totalPhases} phases approved; current: ${progress.currentPhase ?? 'complete'} (${progress.currentPosition}/${progress.totalPhases})`);
  console.log(`Documents: ${progress.documents}  Tokens: ${progress.tokens.totalTokens || 'unavailable'}`);
  console.log(`\nWorkflow flow:\n${progressFlow(progress)}`);
  console.log(`\n${table(progress.phases, [
    { key: 'index', label: '#' }, { key: 'id', label: 'PHASE' }, { key: 'status', label: 'STATUS' },
    { key: 'generation', label: 'GEN' }, { key: 'approvals', label: 'APPROVED' }, { key: 'approvalsRequired', label: 'NEEDED' }, { key: 'tokens', label: 'TOKENS' }
  ])}`);
}

async function reportCommand(positionals, options) {
  const timingsEnabled = optionBoolean(options, 'timings');
  const timer = new TimingCollector({ enabled: timingsEnabled });
  const root = repoRoot();
  const config = await timer.measure('configuration', () => loadConfig(root));
  const workflow = await timer.measure('workflow', () => loadStoryAggregate(root, config, positionals[1]));
  // `report --recap` is the same account the pull-request body carries, from the same beats. Kept on
  // `report` rather than given its own verb: it answers "what happened here", which is the question
  // report already exists to answer, and one surface is one thing to keep true.
  if (optionBoolean(options, 'recap')) {
    const { recap } = await import('./narration/recap.mjs');
    const length = optionString(options, 'length', 'standard');
    const account = recap(workflow, {
      length,
      locale: optionString(options, 'locale', 'en-GB'),
      timeZone: optionString(options, 'timezone', 'UTC')
    });
    return console.log(account || `No recorded beats for ${workflow.workItem.id} yet.`);
  }
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError(`Unknown report format: ${format}. Use md, html, or json.`);
  const report = await timer.measure('derive', async () => deriveReport(workflow, { pricing: config.tokens?.pricing ?? null }));
  let rendered = await timer.measure('render', async () => format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : format === 'html' ? renderHtml(report) : renderMarkdown(report));
  const timings = timer.finish();
  if (format === 'json' && timings) {
    report.timings = timings;
    rendered = `${JSON.stringify(report, null, 2)}\n`;
  }
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = path.resolve(root, outputFile);
    await writeText(absolute, rendered);
    console.log(`Report written to ${absolute}`);
    if (format !== 'json') writeHumanTimings(timings);
    return;
  }
  // stdout stays the default. The extension classifies `report` as a read precisely when `--out` is
  // absent and calls it that way, and `singularity-flow report > notes.md` is how everyone else uses
  // it — so `--brief` is opt-in rather than the other way round.
  if (optionBoolean(options, 'brief') && format !== 'json') {
    console.log(summariseRendered(rendered, `report for ${workflow.workItem.id}`));
    if (format !== 'json') writeHumanTimings(timings);
    return;
  }
  process.stdout.write(rendered);
  if (format !== 'json') writeHumanTimings(timings);
}

/**
 * Describe a rendered document instead of printing it.
 *
 * Enough to know it is the right one and what to do with it: how big it is, how it starts, and the
 * flag that prints the rest. Used by the two commands that otherwise put a whole document on screen.
 */
function summariseRendered(rendered, label) {
  const lines = String(rendered).split('\n');
  const heading = lines.find((line) => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
  return [
    `${style.heading(label)} ${style.detail(style.fields(
      `${lines.length} lines`,
      `${Buffer.byteLength(rendered)} bytes`,
      heading ? `starts: ${heading}` : null
    ))}`,
    style.detail('Printed in full without --brief; redirect to a file with --out <path>.')
  ].join('\n');
}

function impactFilters(values) {
  const result = {};
  for (const item of values) {
    const separator = item.indexOf('=');
    if (separator < 1 || separator === item.length - 1) throw new SingularityFlowError(`Impact filters must use DIMENSION=VALUE; got '${item}'.`);
    result[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return result;
}

function printImpactPlan(workflow) {
  const measurement = workflow.measurement ?? {};
  console.log(`Impact measurement: ${measurement.status ?? 'not-enrolled'}`);
  if (!measurement.plan) return;
  console.log(`Study: ${measurement.plan.studyRunId ?? measurement.plan.studyId} · ${measurement.plan.variantId ? `prompt variant ${measurement.plan.variantId}` : `cohort ${measurement.plan.groupId}`}`);
  const suggested = measurement.classification?.suggested;
  const confirmed = measurement.classification?.confirmed;
  if (suggested) console.log(`Suggested classification: ${suggested.complexity}/${suggested.risk}`);
  console.log(`Confirmed classification: ${confirmed ? `${confirmed.complexity}/${confirmed.risk}` : 'pending human confirmation'}`);
  if (measurement.receipt) console.log(`Receipt: ${measurement.receipt.status} · ${measurement.receipt.sha256.slice(0, 12)} · ${measurement.receipt.path}`);
  console.log(`Exposure records: ${(measurement.exposures ?? []).length} · Evidence records: ${(measurement.evidence ?? []).length}`);
}

function printChangeFlightPlan(plan) {
  const all = [...plan.findings, ...plan.unknowns];
  const counts = Object.fromEntries(['proven', 'inferred', 'unknown'].map((classification) => [
    classification, all.filter((finding) => finding.classification === classification).length
  ]));
  console.log(style.heading('CHANGE FLIGHT PLAN'));
  console.log(`\nIntent\n${plan.intent.text}`);
  console.log(`\nPlan: ${plan.planId} · ${plan.status} · baseline ${plan.baseline.revision.slice(0, 12)}`);
  console.log(`Evidence: ${counts.proven} proven · ${counts.inferred} need confirmation · ${counts.unknown} unresolved`);
  if (plan.findings.length) {
    console.log('\nAffected');
    for (const finding of plan.findings.slice(0, 20)) {
      const mark = finding.classification === 'proven' ? '✓' : finding.classification === 'inferred' ? '~' : '?';
      console.log(`${mark} ${finding.kind}: ${finding.subject} — ${finding.relationship} [${finding.findingId}]`);
    }
    if (plan.findings.length > 20) console.log(`… ${plan.findings.length - 20} more; use --json for the complete bounded result.`);
  }
  if (plan.unknowns.length) {
    console.log('\nCould not evaluate');
    for (const finding of plan.unknowns) console.log(`? ${finding.subject}: ${finding.explanation}`);
  }
  console.log(`\nRecommended starting point\n${plan.recommendedStart.subject}`);
  console.log(`\nReview a finding: sflow impact explain ${plan.planId} <finding-id>`);
  console.log(`Start safely: sflow impact start ${plan.planId} --work-id <ID> --work-type <TYPE> --confirm ${plan.planId}`);
}

async function impactCommand(positionals, options) {
  const root = repoRoot();
  const action = positionals[1] ?? 'status';
  if (action === 'preview') {
    const intent = positionals.slice(2).join(' ').trim();
    const budgets = {};
    for (const [optionName, field] of [['max-files', 'maxFiles'], ['max-findings', 'maxFindings'], ['max-output-bytes', 'maxOutputBytes']]) {
      const value = optionNumber(options, optionName);
      if (value != null) budgets[field] = value;
    }
    const plan = await previewChangeFlightPlan(root, {
      intent,
      file: optionString(options, 'file'),
      symbol: optionString(options, 'symbol'),
      issue: optionString(options, 'issue'),
      build: optionString(options, 'build'),
      source: optionString(options, 'source', 'cli'),
      workType: optionString(options, 'work-type'),
      ast: optionBoolean(options, 'ast', true),
      ...(Object.keys(budgets).length ? { budgets } : {})
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(plan, null, 2));
    printChangeFlightPlan(plan);
    return;
  }
  if (action === 'explain') {
    const planId = requirePositional(positionals, 2, 'Change Flight Plan ID');
    const result = await explainChangeFlightPlanFinding(root, planId, positionals[3] ?? null);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (result.finding) {
      console.log(`${result.finding.findingId} · ${result.finding.classification} · ${result.finding.kind}`);
      console.log(`${result.finding.subject} ${result.finding.relationship}`);
      console.log(result.finding.explanation);
      console.log(`Source: ${result.finding.source.type} ${result.finding.source.reference ?? ''} · baseline ${result.baseline.revision}`);
      console.log(`Reproducible: ${result.reproducible ? 'yes' : 'no'}`);
    } else {
      console.log(`Plan ${result.planId} · baseline ${result.baseline.revision}`);
      for (const finding of result.findings) console.log(`${finding.findingId}\t${finding.classification}\t${finding.subject}\t${finding.relationship}`);
    }
    return;
  }
  if (action === 'refresh') {
    const planId = requirePositional(positionals, 2, 'Change Flight Plan ID');
    const result = await refreshChangeFlightPlan(root, planId, { ast: optionBoolean(options, 'ast', true) });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(result.changed ? `Plan ${planId} refreshed as ${result.plan.planId}.` : `Plan ${planId} is unchanged at the current baseline.`);
    printChangeFlightPlan(result.plan);
    return;
  }
  if (action === 'start') {
    const planId = requirePositional(positionals, 2, 'Change Flight Plan ID');
    const result = await startChangeFlightPlan(root, planId, {
      confirm: optionString(options, 'confirm'),
      workId: optionString(options, 'work-id'),
      workType: optionString(options, 'work-type'),
      agent: optionString(options, 'agent'),
      baseBranch: optionString(options, 'base'),
      worktree: optionString(options, 'worktree'),
      acceptPartial: optionBoolean(options, 'accept-partial'),
      independent: optionBoolean(options, 'independent')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.idempotent ? 'Reused' : 'Started'} ${result.workId} from ${result.planId}.`);
    console.log(`Branch: ${result.branch}\nIsolated worktree: ${result.worktree}\nResume: cd ${JSON.stringify(result.worktree)} && sflow resume ${result.workId}`);
    return;
  }
  if (action === 'disposition') {
    const planId = requirePositional(positionals, 2, 'Change Flight Plan ID');
    const findingId = requirePositional(positionals, 3, 'finding ID');
    const result = await recordChangeFlightPlanDisposition(root, planId, findingId, {
      disposition: optionString(options, 'disposition'), reason: optionString(options, 'reason')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Recorded the disposition in new plan ${result.planId}; ${planId} remains unchanged for audit.`);
    printChangeFlightPlan(result);
    return;
  }
  if (action === 'expansion') {
    const workId = requirePositional(positionals, 2, 'Work ID');
    const relative = requirePositional(positionals, 3, 'expanded repository path');
    if (optionString(options, 'confirm') !== relative) {
      throw new SingularityFlowError(`Recording a scope expansion requires --confirm ${relative}.`);
    }
    const config = await loadConfig(root);
    const workflow = await loadStoryAggregate(root, config, workId);
    const { value, publication } = await transactStory(
      root, config, workflow,
      { type: 'binding', phaseId: workflow.currentPhase, payload: { kind: 'flight-plan-scope-disposition', path: relative } },
      `[${workId}][flight-plan:scope] ${relative}`,
      (aggregate) => recordChangeFlightPlanExpansionDisposition(root, aggregate, relative, {
        disposition: optionString(options, 'disposition'), reason: optionString(options, 'reason')
      })
    );
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ disposition: value, publication }, null, 2));
    console.log(`Recorded ${value.disposition} for ${value.path}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' retained locally'}.`);
    return;
  }
  if (action === 'status' && String(positionals[2] ?? '').startsWith('cfp-')) {
    const plan = await readChangeFlightPlan(root, positionals[2]);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(plan, null, 2));
    printChangeFlightPlan(plan);
    return;
  }
  if (action === 'study') {
    const impact = await loadImpactDefinition(root, { required: true });
    const operation = positionals[2] ?? 'list';
    if (operation === 'list') {
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(impact.studies, null, 2));
      if (!impact.studies.length) return console.log('No impact studies are configured.');
      for (const study of impact.studies) console.log(`${study.studyRunId ?? study.id}\t${study.status ?? (study.enabled ? 'enabled' : 'disabled')}\t${study.method}\t${study.label}`);
      return;
    }
    if (operation === 'show') {
      const id = requirePositional(positionals, 3, 'study ID');
      const study = impact.studies.find((item) => item.id === id);
      if (!study) throw new SingularityFlowError(`Unknown impact study '${id}'.`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(study, null, 2));
      return process.stdout.write(YAML.stringify(study));
    }
    if (operation === 'prompt-hash') {
      const requested = requirePositional(positionals, 3, 'prompt path');
      const promptPath = posix(requested);
      if (!promptPath.startsWith('singularity/prompts/') || !promptPath.endsWith('.md')) {
        throw new SingularityFlowError('Prompt study files must be Markdown under singularity/prompts/.');
      }
      const target = await secureRepositoryPath(root, promptPath, {
        label: 'Prompt study file', mustExist: true, type: 'file'
      });
      const info = await snapshot(target.absolute);
      const result = { path: promptPath, sha256: info.sha256, bytes: info.size };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`${result.path}\t${result.sha256}\t${result.bytes} bytes`);
      return;
    }
    throw new SingularityFlowError(`Unknown impact study action '${operation}'.`);
  }

  if (action === 'compare') {
    const studyId = requirePositional(positionals, 2, 'study ID');
    const impact = await loadImpactDefinition(root, { required: true });
    const study = impact.studies.find((item) => item.id === studyId);
    if (!study) throw new SingularityFlowError(`Unknown impact study '${studyId}'.`);
    const result = compareImpactReceipts(await listImpactReceipts(root, await loadConfig(root), { studyId }), study, {
      filters: impactFilters(optionStrings(options, 'filter'))
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.label}\nStudy: ${result.studyRunId ?? result.study}${result.studyDefinitionSha256 ? ` · definition ${result.studyDefinitionSha256.slice(0, 12)}` : ''} · method ${result.method} · evidence grade ${result.evidenceGrade}`);
    console.log(`Matched cohorts: baseline ${result.cohorts.matchedBaseline}, treatment ${result.cohorts.matchedTreatment}; privacy floor ${result.cohorts.privacyFloor}`);
    console.log(`Primary ${result.primaryMetric.id}: ${result.result.gainPercent.toFixed(2)}% · CI ${result.result.confidenceInterval.lower.toFixed(2)}%..${result.result.confidenceInterval.upper.toFixed(2)}%`);
    for (const guardrail of result.guardrails) console.log(`Guardrail ${guardrail.metric}: ${guardrail.passed ? 'pass' : 'fail'} (${guardrail.regressionPercent == null ? 'unavailable' : `${guardrail.regressionPercent.toFixed(2)}%`})`);
    if (result.promptAdherence) console.log(`Prompt adherence: exact ${result.promptAdherence.exact}, partial ${result.promptAdherence.partial}, unavailable ${result.promptAdherence.unavailable}.`);
    return;
  }

  if (action === 'export') {
    const outputFile = optionString(options, 'out');
    if (!outputFile) throw new SingularityFlowError('Impact export requires --out FILE.');
    const result = await exportImpactReceipts(root, await loadConfig(root), path.resolve(root, outputFile), { studyId: optionString(options, 'study') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`Exported ${result.receipts} normalized Impact Receipt(s) to ${result.output} · ${result.sha256.slice(0, 12)}.`);
  }

  const config = await loadConfig(root);
  const evidenceOperation = action === 'evidence' ? positionals[2] : null;
  const id = action === 'evidence'
    ? (evidenceOperation === 'collect' ? positionals[5] : positionals[4])
    : action === 'exposure' ? positionals[3] : positionals[2];
  const workflow = await loadStoryAggregate(root, config, id);
  await hydrateImpactPlan(root, workflow);

  if (action === 'status') {
    const result = { workId: workflow.workItem.id, measurement: workflow.measurement ?? { status: 'not-enrolled' } };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    printImpactPlan(workflow);
    return;
  }
  if (action === 'enroll') {
    if (!optionBoolean(options, 'confirm')) throw new SingularityFlowError(`Review the suggested classification, then re-run with --confirm for Story '${workflow.workItem.id}'.`);
    const optOut = optionBoolean(options, 'opt-out');
    const { value, publication } = await transactStory(
      root, config, workflow,
      { type: optOut ? 'impact-opted-out' : 'impact-classified', phaseId: workflow.currentPhase },
      `[${workflow.workItem.id}][impact:${optOut ? 'opt-out' : 'classify'}]`,
      (aggregate) => confirmImpactEnrollment(root, config, aggregate, {
        complexity: optionString(options, 'complexity'),
        risk: optionString(options, 'risk'),
        optOut,
        reason: optionString(options, 'reason')
      })
    );
    console.log(`${optOut ? 'Opted out of' : 'Confirmed enrollment in'} impact study '${value.study.id}'. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' retained locally'}.`);
    return;
  }
  if (action === 'exposure') {
    const operation = positionals[2] ?? 'status';
    if (operation === 'status') {
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(workflow.measurement?.exposures ?? [], null, 2));
      for (const item of workflow.measurement?.exposures ?? []) console.log(`${item.phaseId}\t${item.level}\t${item.assurance}\t${item.sha256.slice(0, 12)}`);
      return;
    }
    if (operation !== 'attest') throw new SingularityFlowError(`Unknown impact exposure action '${operation}'.`);
    const phaseId = optionString(options, 'phase');
    if (!phaseId) throw new SingularityFlowError('Impact exposure attestation requires --phase PHASE.');
    const level = optionString(options, 'level'); const assurance = optionString(options, 'assurance');
    const { value, publication } = await transactStory(
      root, config, workflow,
      { type: 'impact-exposure-recorded', phaseId, payload: { level, assurance } },
      `[${workflow.workItem.id}][impact:exposure] ${phaseId} ${level}`,
      (aggregate) => recordImpactExposure(root, config, aggregate, { phaseId, level, assurance, reason: optionString(options, 'reason') })
    );
    console.log(`Recorded ${value.record.level} exposure for ${phaseId} · ${value.record.integrity.sha256.slice(0, 12)} · commit ${publication.sha.slice(0, 8)}.`);
    return;
  }
  if (action === 'evidence') {
    const operation = positionals[2];
    if (!['import', 'collect'].includes(operation)) throw new SingularityFlowError(`Unknown impact evidence action '${operation ?? 'missing'}'.`);
    const providerId = operation === 'collect' ? requirePositional(positionals, 3, 'provider ID') : null;
    const sourceFile = path.resolve(root, requirePositional(positionals, operation === 'collect' ? 4 : 3, operation === 'collect' ? 'provider observation file' : 'evidence file'));
    const { value, publication } = await transactStory(
      root, config, workflow,
      { type: operation === 'collect' ? 'impact-evidence-collected' : 'impact-evidence-imported', phaseId: workflow.currentPhase, payload: providerId ? { providerId } : undefined },
      `[${workflow.workItem.id}][impact:evidence] ${operation}`,
      (aggregate) => operation === 'collect'
        ? collectImpactEvidence(root, config, aggregate, {
            providerId,
            providerVersion: optionString(options, 'provider-version') ?? '1',
            runId: optionString(options, 'run-id'),
            file: sourceFile,
            commitSha: optionString(options, 'commit'),
            phaseId: optionString(options, 'phase'),
            generation: optionString(options, 'generation'),
            kind: optionString(options, 'kind'),
            capturedAt: optionString(options, 'captured-at')
          })
        : importImpactEvidence(root, config, aggregate, sourceFile)
    );
    console.log(`${operation === 'collect' ? 'Collected' : 'Imported'} ${value.record.evidenceId} · ${value.record.observation.metric}=${value.record.observation.status} · commit ${publication.sha.slice(0, 8)}.`);
    return;
  }
  if (action === 'verify') {
    const result = await verifyImpactReceipt(root, workflow);
    // `--json` reports; it does not decide whether the command succeeded. Returning early from the
    // JSON branch skipped the exit code below, so the same failure exited 1 for a human and 0 for
    // the pipeline that asked for machine-readable output — which is where it matters most.
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.valid ? `Impact Receipt verified for ${workflow.workItem.id}.` : `Impact Receipt is invalid for ${workflow.workItem.id}.`);
      for (const error of result.errors) console.warn(`- ${error}`);
    }
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (action === 'doctor') {
    const result = await impactDoctor(root, config, workflow);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.findings.length) console.log(`Impact measurement is healthy for ${workflow.workItem.id}.`);
    else for (const item of result.findings) console.log(`${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (action === 'finalize') return finalizeCommand({ ...options, parent: workflow.workItem.id });
  throw new SingularityFlowError(`Unknown impact action '${action}'.`);
}

async function guideCommand(positionals, options) {
  if (optionBoolean(options, 'first-run')) {
    const json = optionBoolean(options, 'json');
    const result = await runFirstRunGuide({
      keep: optionBoolean(options, 'keep'),
      onBoundary: json ? undefined : (directory) => console.log(`Guide sandbox: ${directory}`)
    });
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(`\n${style.heading('Singularity Flow first run completed.')}`);
    for (const step of result.steps) console.log(`  ${style.pass()} ${step.command}`);
    console.log(`\n${style.detail(style.fields(
      `work item ${result.workId}`,
      `${result.modelInvocations} model invocation(s)`,
      `network access: ${result.networkAccess ? 'yes' : 'no'}`,
      `final state ${result.finalStateSha256.slice(0, 12)}`
    ))}`);
    console.log(style.detail(result.retained
      ? `Guide repository retained at ${result.repository}`
      : 'Guide sandbox removed after successful completion.'));
    emitCommandResult(commandResult({
      operation: { id: 'quickstart', classification: 'read' },
      subject: { kind: 'repository', id: result.workId },
      outcome: succeeded('quickstart.completed', { steps: result.steps.length }),
      // The walkthrough runs entirely inside a sandbox it creates and removes. Nothing in the
      // reader's own repository is touched, which is what makes this safe as a first command.
      effects: noEffects(),
      // The sandbox is finished; the reader is not. Reporting a rest state here would answer the
      // newcomer's very first command with "there is nothing further to do".
      next: [
        narrationAction({
          id: 'quickstart.init',
          label: 'Set up a repository you already have',
          command: 'singularity-flow init'
        }),
        narrationAction({
          id: 'quickstart.bootstrap',
          label: 'Set up a new capability, with its configuration branch and ledger',
          command: 'singularity-flow bootstrap <REPOSITORY-URL>'
        }),
        narrationAction({
          id: 'quickstart.help',
          label: 'See what the other commands do',
          command: 'singularity-flow --help',
          rank: 'LATER'
        })
      ]
    }));
    return;
  }
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, positionals[1]);
  const guide = workflowGuide(workflow);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(guide, null, 2));
  else process.stdout.write(guideText(guide));
}

async function resolveNextStepsSnapshot(positionals, options) {
  const root = repoRoot();
  const initialized = existsSync(path.join(root, WORKFLOW_PATH)) || existsSync(path.join(root, 'singularity/config.json'));
  let snapshot;
  if (!initialized) snapshot = nextStepsSnapshot({ initialized: false, branch: branch(root) });
  else {
    const config = await loadConfig(root);
    const portfolio = await loadPortfolio(root, { required: false });
    const requestedWorkId = positionals[1] ?? null;
    const id = requestedWorkId ?? branch(root);
    const index = await buildRepositorySubjectIndex(root, { definition: config, portfolio });
    const selected = resolveContext(index, { reference: id, required: false });
    if (selected?.kind === 'initiative') {
      const initiative = selected.state;
      snapshot = {
        schemaVersion: 1,
        state: initiative.status ?? 'active',
        subject: { kind: 'initiative', id: selected.id },
        initiativeId: selected.id,
        currentPhase: initiative.currentPhase ?? null,
        actions: (await initiativeNextActions(root, selected.id)).map((item) => ({
          timing: 'now',
          skill: null,
          command: item.command,
          reason: item.reason
        }))
      };
    } else if (selected?.kind === 'story') {
      const workflow = await loadStoryAggregate(root, config, selected.id);
      const prerequisites = [];
      const active = currentPhase(workflow); const session = await loadSession(root, { required: false });
      if (active && workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[active.id]) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Phase '${active.id}' requires an explicit assignment before the team continues.` });
      else if (active && workflow.resolution?.collaboration?.assignmentMode === 'suggested' && !workflow.collaboration?.assignments?.[active.id]) prerequisites.push({ timing: 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who is coordinating '${active.id}' so another terminal can see ownership.` });
      if (active?.status === 'in_progress' && !session?.agent) prerequisites.push({
        timing: 'now', skill: '/sf-resume', command: `singularity-flow resume ${workflow.workItem.id} --fetch`,
        reason: 'Select the governed agent that will remain active for this terminal session before generation.'
      });
      const groundingMode = workflow.resolution?.worldModelGrounding ?? config.worldModel?.grounding ?? 'off';
      if (active?.status === 'in_progress' && phaseNeedsGeneration(workflow, active) && groundingMode !== 'off') {
        const readiness = await inspectWorkflowGrounding(root, workflow, active.id, {
          agent: session?.agent ?? null
        });
        if (!readiness.availability.ready) {
          const blocks = groundingMode === 'enforce' || readiness.availability.staleness?.blocks;
          prerequisites.push({ timing: blocks ? 'now' : 'optional', skill: '/sf-worldmodel', command: readiness.command, reason: readiness.reason });
          prerequisites.push({ timing: groundingMode === 'enforce' ? 'then' : 'optional', skill: null, command: `singularity-flow wm compose --phase ${active.id}`, reason: 'Compose and record the governed phase prompt from the shared repository model.' });
        } else {
          if (readiness.availability.staleness?.warns) prerequisites.push({
            timing: 'optional', skill: '/sf-worldmodel', command: readiness.command,
            reason: readiness.availability.staleness.message
          });
          const grounding = await verifyGroundingRecord(root, config, workflow, active, { agent: session?.agent ?? null });
          if (grounding.errors.length || grounding.warnings.length) prerequisites.push({
            timing: groundingMode === 'enforce' ? 'now' : 'optional', skill: null, command: `singularity-flow wm compose --phase ${active.id}`,
            reason: 'Create or refresh the required grounding record and exact prompt snapshot before publishing this generation.'
          });
        }
      }
      if (active?.status === 'in_progress' && session?.agent) {
        const status = (await agentStatus(root, session.agent))[0];
        if (!status) prerequisites.push({ timing: 'now', skill: null, command: 'singularity-flow agents list', reason: `Active agent '${session.agent}' is no longer available; choose and sync an available pack.` });
        else if (status.status === 'unlocked') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent}`, reason: `Review and trust the active agent's remote Markdown before generation.` });
        else if (status.status === 'stale') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent} --update`, reason: 'The active agent Markdown changed after it was locked; review the new dependency hashes.' });
        if (status && !['ready', 'local-only'].includes(status.status)) prerequisites.push({ timing: ['unlocked', 'stale'].includes(status.status) ? 'then' : 'now', skill: null, command: `singularity-flow agents sync ${session.agent}`, reason: 'Verify the pinned hashes and materialize the active agent cache.' });
        for (const conflict of await remoteOutputConflicts(active, { itemDirectory: workDir(root, config, workflow.workItem.id) })) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents refresh-output ${conflict.resource}`, reason: `Remote output ${conflict.target} has local changes; review them before deciding whether to add --replace.` });
      }
      snapshot = nextStepsSnapshot({
        branch: branch(root),
        workflow,
        publicationPending: await storyPublicationPending(root, config, workflow.workItem.id),
        prerequisites
      });
    } else snapshot = nextStepsSnapshot({ branch: branch(root), requestedWorkId });
  }
  return snapshot;
}

async function nextStepsCommand(positionals, options) {
  const snapshot = await resolveNextStepsSnapshot(positionals, options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, 2));
  else process.stdout.write(nextStepsText(snapshot));
}

async function actionCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'plan';
  if (subcommand === 'plan') {
    const reference = positionals[2] ?? optionString(options, 'work-id');
    const snapshot = await resolveNextStepsSnapshot(['nextsteps', reference].filter(Boolean), {});
    const plan = await createActionPlan(root, snapshot, {
      ttlMs: optionNumber(options, 'ttl-ms', 15 * 60 * 1000),
      subject: snapshot.subject ?? null
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(plan, null, 2));
    console.log(`Governed action plan: ${plan.planId}`);
    console.log(`Bound to: ${plan.revision.branch}@${plan.revision.head.slice(0, 12)} · expires ${plan.expiresAt}`);
    console.log(table(plan.actions.map((action) => ({
      id: action.actionId.slice(0, 10), timing: action.timing, intent: action.intent,
      executable: action.executable ? 'yes' : 'no', reason: action.reason
    })), [
      { key: 'id', label: 'ACTION' }, { key: 'timing', label: 'WHEN' },
      { key: 'intent', label: 'INTENT' }, { key: 'executable', label: 'READY' },
      { key: 'reason', label: 'REASON' }
    ]));
    console.log(`Authorize after review: singularity-flow action authorize ${plan.planId} --action <id> --confirm <exact-action-id>`);
    console.log(`Then execute once: singularity-flow action execute ${plan.planId} --action <id> --authorization <token>`);
    return;
  }
  if (!['authorize', 'execute'].includes(subcommand)) {
    throw new SingularityFlowError(`Unknown action subcommand '${subcommand}'. Use action plan, action authorize, or action execute.`);
  }

  const planId = positionals[2] ?? optionString(options, 'plan');
  const plan = await loadActionPlan(root, planId);
  const action = selectPlannedAction(plan, optionString(options, 'action'));
  if (subcommand === 'execute') {
    const prior = await readActionResult(root, plan, action);
    if (prior) {
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ replayed: true, record: prior }, null, 2));
      console.log(`Action ${action.actionId.slice(0, 10)} already completed at ${prior.completedAt}; no command was repeated.`);
      return;
    }
  }
  const snapshot = await resolveNextStepsSnapshot(['nextsteps', plan.subject.id].filter(Boolean), {});
  assertActionPlanFresh(root, plan, snapshot);
  if (subcommand === 'authorize') {
    const authorization = await issueActionAuthorization(root, plan, action, {
      confirmation: optionString(options, 'confirm'),
      channel: optionString(options, 'channel', 'terminal')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(authorization, null, 2));
    console.log(`One-time authorization: ${authorization.token}`);
    console.log(`Execute: singularity-flow action execute ${plan.planId} --action ${action.actionId} --authorization ${authorization.token}`);
    return;
  }
  const authorization = action.confirmation?.required
    ? await consumeActionAuthorization(root, optionString(options, 'authorization'), plan, action)
    : null;

  const priorActionEnvironment = {
    planId: process.env.SINGULARITY_FLOW_ACTION_PLAN_ID,
    planHash: process.env.SINGULARITY_FLOW_ACTION_PLAN_HASH,
    actionId: process.env.SINGULARITY_FLOW_ACTION_ID
  };
  process.env.SINGULARITY_FLOW_ACTION_PLAN_ID = plan.planId;
  process.env.SINGULARITY_FLOW_ACTION_PLAN_HASH = plan.planHash;
  process.env.SINGULARITY_FLOW_ACTION_ID = action.actionId;
  try { await main(action.argv); }
  finally {
    for (const [key, value] of Object.entries({
      SINGULARITY_FLOW_ACTION_PLAN_ID: priorActionEnvironment.planId,
      SINGULARITY_FLOW_ACTION_PLAN_HASH: priorActionEnvironment.planHash,
      SINGULARITY_FLOW_ACTION_ID: priorActionEnvironment.actionId
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const result = await recordActionResult(root, plan, action, {
    status: 'completed',
    branch: branch(root),
    head: head(root)
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ replayed: false, record: result }, null, 2));
  else console.log(`Governed action ${action.actionId.slice(0, 10)} completed and was recorded locally.`);
  if (!action.effect?.mutatesState) return {};
  return {
    harnessEvidence: {
      questions: authorization ? [{
        questionId: authorization.questionId,
        answered: true,
        answerReceipt: authorization.answerReceipt,
        actionPlanId: plan.planId,
        actionId: action.actionId,
        expiresAt: authorization.expiresAt
      }] : [],
      actionsExecuted: [{
        questionId: authorization?.questionId ?? null,
        answerReceipt: authorization?.answerReceipt ?? null,
        authorizationId: authorization?.authorizationId ?? null,
        planId: plan.planId,
        actionId: action.actionId,
        result: 'succeeded'
      }]
    }
  };
}

async function materializeWorldModelForNext(root, config, workflow, phase, options) {
  const policy = effectiveMaterializationPolicy(config, workflow);
  if (policy.mode !== 'on-demand') return { materialized: false, policy, reason: `materialization mode is ${policy.mode}` };

  const deterministic = policy.depth === 'light' || operationContext()?.modelMode.enabled === false;
  const description = deterministic
    ? `the deterministic light world model for phase '${phase.id}' (zero model tokens${policy.depth === 'phase' ? '; --no-model fallback' : ''})`
    : `the configured phase-depth world model for phase '${phase.id}' (may invoke the configured model provider)`;
  const authorized = policy.confirmation === 'automatic'
    || optionBoolean(options, 'yes')
    || await confirmYesNo(`Repository grounding is missing or stale. Build ${description} now?`);
  if (!authorized) return { materialized: false, policy, declined: true, reason: 'the user declined materialization' };

  console.log(`${policy.confirmation === 'automatic' ? 'Automatically building' : 'Building'} ${description}...`);
  const ensureOperation = operationById('wm.ensure');
  if (!ensureOperation) throw new SingularityFlowError("Registered operation 'wm.ensure' is unavailable.");
  const ensurePhase = (phaseId) => runOperation(ensureOperation, () => worldModelCommand(root, ['wm', 'ensure'], {
    phase: phaseId
  }));
  await ensurePhase(phase.id);

  let lookahead = null;
  if (policy.lookahead === 'next-phase') {
    const index = (workflow.phaseOrder ?? []).indexOf(phase.id);
    const nextPhaseId = index >= 0 ? workflow.phaseOrder?.[index + 1] ?? null : null;
    if (nextPhaseId && workflow.phases?.[nextPhaseId]) {
      console.log(`Preparing configured next-phase grounding for '${nextPhaseId}'...`);
      await ensurePhase(nextPhaseId);
      lookahead = { phase: nextPhaseId, materialized: true };
    }
  }
  return { materialized: true, policy, lookahead };
}

async function nextCommand(options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  if (await storyPublicationPending(root, config, workflow.workItem.id)) {
    console.log('Run: singularity-flow sync');
    console.log('In Copilot: /sf-next');
    console.log('Publish the retained local commit.');
    return syncCommand();
  }
  const phase = currentPhase(workflow);
  if (!phase) {
    console.log('Run: singularity-flow gate --terminal');
    console.log('In Copilot: /sf-next');
    console.log('Run the governance gate for the completed workflow.');
    return gateCommand({ ...options, terminal: true });
  }
  if (phase.status === 'awaiting_approval') {
    console.log(`Run: singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id} --fetch`);
    console.log(`In Copilot: /sf-approve ${phase.id}`);
    console.log(`Review and decide submitted phase '${phase.id}'.`);
    return approveCommand(['approve', workflow.workItem.id], { ...options, fetch: optionBoolean(options, 'fetch', true) });
  }
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Cannot automatically continue phase '${phase.id}' while it is ${phase.status}.\nCopilot: /sf-nextsteps ${workflow.workItem.id}\nRun: singularity-flow nextsteps ${workflow.workItem.id}`);
  if (!phaseNeedsGeneration(workflow, phase)) {
    console.log(`Run: singularity-flow submit ${phase.id}`);
    console.log(`In Copilot: /sf-submit ${phase.id}`);
    console.log(`Submit published phase '${phase.id}' for approval.`);
    return submitCommand(['submit', phase.id], options);
  }

  // Lifecycle grounding consumes the repository model, whose durable identity is the scoped
  // source snapshot. Story context is already supplied by the governed workflow prompt. Adding a
  // Story title as a task-guide requirement would make every Story look like a missing model and
  // could launch another expensive build even though the shared repository model is unchanged.
  // Keep accepting --task for command-line compatibility; only direct `wm ensure/compose --task`
  // explicitly requests an ad-hoc task guide.
  const requestedTask = optionString(options, 'task');
  if (requestedTask) {
    console.warn('Ignoring --task for lifecycle grounding; the repository world model is shared across Stories and Story context comes from the governed phase. Use an explicit wm ensure/compose --task command only to request an ad-hoc task guide.');
  }
  const grounding = workflow.resolution?.worldModelGrounding ?? 'off';
  if (grounding !== 'off') {
    const readiness = await inspectWorkflowGrounding(root, workflow, phase.id, {
      agent: (await loadSession(root, { required: false }))?.agent ?? null
    });
    if (!readiness.availability.ready) {
      const materialization = await materializeWorldModelForNext(root, config, workflow, phase, options);
      if (materialization.materialized) {
        try {
          await worldModelCommand(root, ['wm', 'compose'], { phase: phase.id, evidence: phase.worldModel?.evidence === true });
        } catch (error) {
          if (materialization.policy.depth === 'light') {
            throw new SingularityFlowError(`The configured automatic light world model did not satisfy phase '${phase.id}': ${error.message}\nUse depth: phase with confirmation: prompt, or run singularity-flow wm ensure --phase ${phase.id}.`);
          }
          throw error;
        }
      } else if (grounding === 'enforce' || readiness.availability.staleness?.blocks) {
        console.log(`Next step prerequisite: ${readiness.reason}`);
        console.log('No model was started. Build explicitly, then continue:');
        console.log(`Copilot: /sf-worldmodel --phase ${phase.id}`);
        console.log(`Run: singularity-flow wm ensure --phase ${phase.id}`);
        if (materialization.reason) console.log(`Configured policy did not build it: ${materialization.reason}.`);
        console.log('Model-free alternative: author the prepared artifact manually and publish with --authored human.');
        return;
      } else {
        console.warn(`Grounding warning: ${readiness.reason}`);
        if (materialization.reason) console.warn(`Configured policy did not build it: ${materialization.reason}.`);
        console.warn('Continuing because world-model grounding is advisory. No model will be built or composed.');
      }
    } else {
      try {
        await worldModelCommand(root, ['wm', 'compose'], { phase: phase.id, evidence: phase.worldModel?.evidence === true });
      } catch (error) {
        if (grounding === 'enforce') throw error;
        console.warn(`Grounding warning: ${error.message}`);
        console.warn('Continuing because world-model grounding is advisory.');
      }
    }
  }
  const artifact = await preparePhase(root, config, workflow, phase.id);
  await saveStoryDraft(root, config, workflow);
  console.log(`Next step prepared: generate '${phase.id}' using ${artifact}.`);
  console.log('\nAfter authoring and validation, publish the generation:');
  console.log(`  Run (authored by you): singularity-flow phase publish ${phase.id} --authored human`);
  console.log(`  Run (authored by Copilot): singularity-flow phase publish ${phase.id} --authored governed-agent --channel copilot-host`);
  console.log(`  In Copilot: /sf-phase ${phase.id}`);
}

async function documentsCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'documents subcommand'); const root = repoRoot(); const config = await loadConfig(root);
  if (subcommand === 'list') {
    if (optionBoolean(options, 'active') && optionBoolean(options, 'all')) throw new SingularityFlowError('Choose either --active or --all, not both.');
    const workflow = await loadStoryAggregate(root, config, positionals[2]);
    const records = await documentCatalog(root, config, workflow, { includeDetached: optionBoolean(options, 'all') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(records, null, 2));
    if (!records.length) return console.log('No documents found.');
    return console.log(table(records.map((item) => ({ id: item.id, type: item.type, phase: item.phase ?? '', status: item.status ?? 'active', label: item.label, location: item.url ?? item.path ?? '', reason: item.detachReason ?? '' })), [
      { key: 'id', label: 'ID' }, { key: 'type', label: 'TYPE' }, { key: 'phase', label: 'PHASE' }, { key: 'status', label: 'STATUS' }, { key: 'label', label: 'LABEL' }, { key: 'location', label: 'LOCATION' }, { key: 'reason', label: 'DETACH REASON' }
    ]));
  }
  if (subcommand === 'view') {
    const reference = requirePositional(positionals, 2, 'document ID or path'); const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id')); const result = await viewDocument(root, config, workflow, reference, { includeDetached: optionBoolean(options, 'all') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.record.id} — ${result.record.label}`); console.log(`Type: ${result.record.type}${result.record.mimeType ? ` (${result.record.mimeType})` : ''}`);
    if (result.record.url) console.log(`URL: ${result.record.url}`);
    else console.log(`Path: ${result.absolutePath ?? pathForDisplay(root, result.record.path)}`);
    if (result.binary) console.log('Binary document: use the path above in an image, PDF, Figma, or local viewer.');
    else if (result.content != null) process.stdout.write(`\n${result.content}`);
    return;
  }
  if (subcommand === 'detach') {
    const documentId = requirePositional(positionals, 2, 'document ID');
    const reason = optionString(options, 'reason');
    if (!reason?.trim()) throw new SingularityFlowError('Document detachment requires --reason "<reason>".');
    const scope = optionString(options, 'scope', 'file');
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
    const records = await documentCatalog(root, config, workflow, { includeDetached: true });
    const selected = records.find((record) => record.id === documentId);
    if (!selected) throw new SingularityFlowError(`Supporting document '${documentId}' was not found.`);
    const targets = scope === 'package' && selected.packageId
      ? records.filter((record) => record.packageId === selected.packageId && (record.status == null || ['active', 'pinned'].includes(record.status)))
      : [selected];
    const json = optionBoolean(options, 'json');
    if (!json) {
      console.log(`Detach ${scope === 'package' ? `package ${selected.packageId} (${targets.length} files)` : `${selected.id} — ${selected.label}`}.`);
      console.log('Committed bytes and audit history will be preserved. Future governed prompts will omit the evidence; dependent generated work and approvals may be invalidated.');
    }
    if (!optionBoolean(options, 'yes') && !(await confirmExact('Confirm this governed evidence detachment.', documentId))) {
      console.log('No state changed.');
      return;
    }
    let detached;
    const publication = await commitAndPublish(
      root,
      config,
      workflow,
      { type: 'evidence-recorded', phaseId: workflow.currentPhase, payload: { action: 'detached', documentId, scope } },
      `[${workflow.workItem.id}][evidence:detach] ${documentId}`,
      [],
      { beforeStateWrite: async () => { detached = await detachDocuments(root, config, workflow, { documentId, scope, reason }); } }
    );
    const reloaded = await loadStoryAggregate(root, config, workflow.workItem.id);
    const next = nextStepsSnapshot({
      branch: branch(root),
      workflow: reloaded,
      publicationPending: await storyPublicationPending(root, config, reloaded.workItem.id)
    });
    const result = { ...detached, publication, next };
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(`Decision: ${detached.decision.sha256}`);
    console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' retained locally; run singularity-flow sync'}`);
    console.log(`Invalidated phases: ${detached.affectedPhases.length ? detached.affectedPhases.join(', ') : 'none'}`);
    if (detached.reopenedPhase) console.log(`Reopened phase: ${detached.reopenedPhase}`);
    console.log(`Run: singularity-flow nextsteps`);
    console.log(`In Copilot: /sf-nextsteps`);
    return;
  }
  if (subcommand === 'preview') {
    const reference = requirePositional(positionals, 2, 'document ID or path');
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
    const result = await previewDocument(root, config, workflow, reference);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.record.id} — ${result.record.label}`);
    if (result.record.url) console.log(`URL: ${result.record.url}`);
    else if (result.previewable) console.log(`Governed inline preview verified at ${result.sha256}.`);
    else if (result.binary) console.log('This binary type requires its native viewer.');
    else if (result.content != null) process.stdout.write(`\n${result.content}`);
    return;
  }
  if (['upload', 'add'].includes(subcommand)) {
    const workflow = await loadStoryAggregate(root, config); const records = await addDocuments(root, config, workflow, { files: positionals.slice(2), url: optionString(options, 'url'), label: optionString(options, 'label'), kind: optionString(options, 'kind') });
    const result = await commitAndPublish(root, config, workflow, { type: 'evidence-recorded', payload: { documents: records.map((item) => item.id) } }, `[${workflow.workItem.id}][documents][upload] ${records.map((item) => item.id).join(',')}`);
    records.forEach((record) => console.log(`${record.id}\t${record.type}\t${record.url ?? record.path}`)); console.log(`Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`); return;
  }
  if (subcommand === 'browse') {
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
    const result = await listRemoteDocuments(config, { providerId: optionString(options, 'provider'), path: optionString(options, 'path', ''), workflow });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.providerId} (${result.providerType})`);
    if (!result.entries.length) return console.log('No entries.');
    return console.log(table(result.entries.map((entry) => ({ name: entry.name, kind: entry.folder ? 'folder' : 'file', id: entry.id, size: entry.folder ? '' : entry.size ?? '' })), [
      { key: 'name', label: 'NAME' }, { key: 'kind', label: 'KIND' }, { key: 'size', label: 'BYTES' }, { key: 'id', label: 'ITEM ID' }
    ]));
  }
  if (subcommand === 'fetch') {
    const workflow = await loadStoryAggregate(root, config);
    const records = await fetchRemoteDocument(root, config, workflow, {
      providerId: optionString(options, 'provider'),
      remoteRef: optionString(options, 'ref') ?? positionals[2],
      name: optionString(options, 'name'),
      label: optionString(options, 'label'),
      kind: optionString(options, 'kind')
    });
    const result = await commitAndPublish(root, config, workflow, { type: 'external-synchronized', payload: { documents: records.map((item) => item.id) } }, `[${workflow.workItem.id}][documents][fetch] ${records.map((item) => item.id).join(',')}`);
    records.forEach((record) => console.log(`${record.id}\t${record.type}\t${record.remote?.providerId ?? ''}\t${record.path}`));
    console.log(`Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
    return;
  }
  throw new SingularityFlowError(`Unknown documents subcommand: ${subcommand}`);
}

function pathForDisplay(root, relative) { return path.join(root, relative); }

async function prepareCommand(positionals) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  const artifact = await preparePhase(root, config, workflow, positionals[1]);
  await saveStoryDraft(root, config, workflow);
  const phase = positionals[1] ?? workflow.currentPhase;
  emitCommandResult(commandResult({
    operation: { id: 'prepare', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('prepare.succeeded', { phase, path: artifact }),
    // Materialises the artifact from its template and captures the interval baseline. Nothing is
    // committed or pushed: preparing is not a governed transition.
    effects: effects({ filesChanged: true }),
    next: [
      narrationAction({
        id: 'prepare.author',
        label: 'Fill the artifact in, then publish this generation of it',
        command: `singularity-flow phase publish ${phase} --authored human`
      }),
      narrationAction({
        id: 'prepare.inputs',
        label: 'See the approved upstream decisions this phase was given',
        command: `singularity-flow inputs ${phase}`,
        rank: 'LATER'
      })
    ]
  }), { postState: workflow });
}

async function clarificationCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  const subcommand = positionals[1] ?? 'status';
  const phaseId = positionals[2] ?? workflow.currentPhase;
  const phase = workflow.phases[phaseId];
  if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  if (subcommand === 'status') {
    const result = await verifyClarificationRecord(root, config, workflow, phase);
    const json = optionBoolean(options, 'json');
    if (!json) {
      console.log(`Clarification checkpoint: ${phase.id} generation ${phase.generation + 1} (${result.mode})`);
      if (result.record) {
        console.log(`Status: ${result.errors.length ? 'not ready' : 'ready'} · Responses: ${result.record.responses.length} · Recorded by: ${result.record.recordedBy?.name ?? result.record.recordedBy?.email ?? 'unknown'}`);
        console.log(`Record: ${result.path} · Prompt: ${result.record.promptSha256.slice(0, 12)}`);
      } else console.log(result.mode === 'off' ? 'This phase has no clarification checkpoint.' : 'No response record exists for the prospective generation.');
      result.passes.forEach((message) => console.log(`PASS ${message}`));
      result.warnings.forEach((message) => console.warn(`Warning: ${message}`));
      result.errors.forEach((message) => console.error(`BLOCKED ${message}`));
    }
    emitCommandResult(commandResult({
      operation: { id: 'clarification.status', classification: 'read' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: noop('clarification.reported', { phase: phase.id, generation: phase.generation + 1 }),
      effects: noEffects(),
      restState: 'informational',
      data: result
    }), { json });
    return;
  }
  if (subcommand !== 'record') throw new SingularityFlowError(`Unknown clarification subcommand '${subcommand}'. Use record or status.`);
  const responseFile = optionString(options, 'response-file');
  let responses;
  if (responseFile) {
    const payload = await readJson(path.resolve(responseFile));
    responses = Array.isArray(payload) ? payload : payload.responses ?? payload.questions;
  } else {
    // `--marker` names an artifact marker this answer resolves `[SPK:REQ-066]`. It defaults the
    // question too, because the marker text *is* the question and making someone retype it exactly
    // is how the two drift apart and the answer stops binding.
    const marker = optionString(options, 'marker');
    const question = optionString(options, 'question') ?? marker;
    const answer = optionString(options, 'answer');
    if (!question || !answer) throw new SingularityFlowError('clarification record requires --question and --answer (or --marker and --answer), or --response-file JSON.');
    responses = [{
      question,
      ...(marker ? { marker } : {}),
      answer,
      why: optionString(options, 'why'),
      status: optionString(options, 'status', 'answered'),
      blocking: optionBoolean(options, 'blocking'),
      owner: optionString(options, 'owner'),
      impact: optionString(options, 'impact')
    }];
  }
  const session = await loadSession(root);
  const result = await recordClarificationResponses(root, config, workflow, phase, {
    responses,
    actor: session.actor,
    agent: session.agent,
    replace: optionBoolean(options, 'replace')
  });
  console.log(`Recorded ${result.record.responses.length} human clarification response${result.record.responses.length === 1 ? '' : 's'} for ${phase.id} generation ${result.record.generation}.`);
  console.log(`Record: ${result.path} · SHA-256: ${result.sha256}`);
  console.log(result.record.completed
    ? `Next: author the phase artifact, then run singularity-flow phase publish ${phase.id} --authored governed-agent --channel copilot-host`
    : 'Publication remains blocked because at least one material decision is unresolved.');
  emitCommandResult(commandResult({
    operation: { id: 'clarification.record', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('clarification.recorded', {
      phase: phase.id,
      generation: result.record.generation,
      responses: result.record.responses.length
    }),
    effects: effects({ filesChanged: true }),
    restState: 'informational',
    data: { path: result.path, sha256: result.sha256, completed: result.record.completed }
  }));
}

async function inputsCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  const dryRun = optionBoolean(options, 'dry-run');
  const result = await preparePhaseInputs(root, config, workflow, positionals[1], { dryRun });
  if (!dryRun) await saveStoryDraft(root, config, workflow);
  console.log(`Phase inputs: ${result.phase.id} (${result.mode})${dryRun ? ' [dry-run]' : ''}`);
  if (!result.records.length) console.log(result.mode === 'off' ? 'Input dataflow is disabled for this work item.' : 'This phase declares no phase inputs.');
  else console.log(table(result.records.map((entry) => ({
    phase: entry.phase,
    status: entry.status,
    optional: entry.optional ? 'yes' : 'no',
    sha256: entry.sha256?.slice(0, 12) ?? '',
    bytes: entry.status === 'captured' ? `${entry.injectedBytes}/${entry.bytes}${entry.truncated ? ' truncated' : ''}` : '',
    path: entry.path ?? ''
  })), [
    { key: 'phase', label: 'INPUT' },
    { key: 'status', label: 'STATUS' },
    { key: 'optional', label: 'OPTIONAL' },
    { key: 'sha256', label: 'SHA256' },
    { key: 'bytes', label: 'BYTES' },
    { key: 'path', label: 'PATH' }
  ]));
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  result.remoteWarnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (!dryRun && result.records.length) console.log(`Recorded generation ${result.generation} inputs and rendered the managed artifact block.`);
}

/**
 * One governed relay turn for semantic candidates. `[SPK:REQ-057]` `[SPK:REQ-058]`
 *
 * `tools: { mode: 'none' }` is the load-bearing argument. This pass reads one document and returns
 * an opinion about it; a model that can also run commands in the repository is doing something else,
 * and `[SPK:CON-029]` would have no way to hold. Everything the relay needs to be auditable —
 * provider, model, prompt hash, usage, invocation id — `invokeModel` already records, and the record
 * written here binds those to the deterministic report they accompany.
 */
async function runAssistedAnalysis(root, config, workflow, phase, { report, itemRelative, generation, namespace, model = null }) {
  const markdown = await readFile(path.join(root, report.binding.artifactPath), 'utf8');
  const prompt = assistedPrompt({ report, markdown, namespace });
  const provider = resolveModelProvider(config);
  const invocation = await invokeModel({
    provider: provider.provider,
    providerConfig: provider.providerConfig,
    model: model ?? provider.model,
    cwd: root,
    allowedRoots: [root],
    prompt: { text: prompt },
    channel: 'specification-quality-assisted',
    subject: { kind: 'specification-quality', id: workflow.workItem.id, phase: phase.id, generation },
    tools: { mode: 'none' },
    limits: { timeoutMs: 5 * 60 * 1000, outputBytes: 256 * 1024 }
  });
  const candidates = parseAssistedCandidates(invocation.output);
  const record = buildAssistedRecord({
    report,
    invocation,
    candidates,
    prompt,
    workId: workflow.workItem.id,
    unknownClauseIds: unknownCitations(candidates, report.clauseIds ?? []),
    generatedAt: invocation.completedAt ?? new Date().toISOString()
  });
  const relative = assistedRecordRelative(itemRelative, phase.id, generation);
  await writeText(path.join(root, relative), serializeAssistedRecord(record));
  return { record, path: relative };
}

async function specCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'trace';
  const supplied = subcommand === 'index' ? positionals[2] : null;

  // Indexing a repository file is useful before a Story exists (for example while evaluating a
  // candidate specification). Keep that local index outside governed state. A valid workflow
  // configuration is still honoured when present; malformed configuration is never masked.
  if (subcommand === 'index' && supplied && !optionString(options, 'work-id') && !optionString(options, 'phase')) {
    let standalone = !existsSync(path.join(root, CONFIG_PATH));
    let standaloneConfig = null;
    if (!standalone) {
      standaloneConfig = await loadConfig(root);
      try { await loadStoryAggregate(root, standaloneConfig); }
      catch (error) {
        if (/^No workflow found for /.test(error.message)) standalone = true;
        else throw error;
      }
    }
    if (standalone) {
      const artifact = posix(path.relative(root, path.resolve(root, supplied)));
      const name = path.basename(supplied).replace(/[^A-Za-z0-9._-]/g, '-');
      const outputPath = optionString(options, 'out')
        ?? posix(path.join('.git', 'singularity-flow', 'spec-indexes', `${name}.json`));
      const index = await buildSpecIndex(root, artifact, {
        workId: null,
        phase: null,
        generation: 0,
        outputPath,
        policy: standaloneConfig?.spec ?? {},
        write: !optionBoolean(options, 'dry-run')
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(index, null, 2));
      console.log(`${optionBoolean(options, 'dry-run') ? 'Validated' : 'Indexed'} ${index.clauses.length} standalone clause(s) from ${index.source.path}.`);
      if (!optionBoolean(options, 'dry-run')) console.log(`Local index: ${outputPath} (${index.indexSha256.slice(0, 12)})`);
      return;
    }
  }

  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
  const itemDirectory = workDir(root, config, workflow.workItem.id);
  const itemRelative = posix(path.relative(root, itemDirectory));
  const phaseId = optionString(options, 'phase') ?? workflow.currentPhase;
  const phase = workflow.phases[phaseId];
  if (!phase) throw new SingularityFlowError(`Unknown Story phase '${phaseId}'.`);
  const generation = Math.max(1, Number(phase.generation ?? 0));
  const policy = workflow.resolution?.spec ?? config.spec;

  if (subcommand === 'index') {
    const artifact = supplied
      ? posix(path.relative(root, path.resolve(root, supplied)))
      : posix(path.join(itemRelative, phase.requiredArtifact?.path ?? ''));
    if (!supplied && !phase.requiredArtifact?.path) throw new SingularityFlowError(`Phase ${phase.id} has no specification artifact; provide its repository-relative path.`);
    const outputPath = posix(path.join(itemRelative, 'context', 'spec-indexes', `${phase.id}-gen${generation}.json`));
    const activeRecords = await loadActiveSpecRecords(itemDirectory, workflow);
    const index = await buildSpecIndex(root, artifact, {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation,
      outputPath,
      policy,
      externalClauses: predecessorSpecClauses(activeRecords, workflow, phase.id),
      write: !optionBoolean(options, 'dry-run')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(index, null, 2));
    console.log(`${optionBoolean(options, 'dry-run') ? 'Validated' : 'Indexed'} ${index.clauses.length} clause(s) from ${index.source.path}.`);
    if (!optionBoolean(options, 'dry-run')) console.log(`Index: ${outputPath} (${index.indexSha256.slice(0, 12)})`);
    return;
  }

  if (subcommand === 'claims') {
    const kind = requirePositional(positionals, 2, 'claim map kind (planned or observed)');
    const inputFile = optionString(options, 'file');
    if (!inputFile) throw new SingularityFlowError('Provide --file with a JSON or YAML claim map.');
    const records = await loadActiveSpecRecords(itemDirectory, workflow);
    const clauseIds = records.indexes.flatMap((index) => (index.clauses ?? []).map((clause) => clause.id));
    if (!clauseIds.length) throw new SingularityFlowError('No specification index exists. Run singularity-flow spec index first.');
    const claims = normalizeClaimMap(await readStructuredFile(root, inputFile), { kind, clauseIds, policy });
    Object.assign(claims, { workId: workflow.workItem.id, phase: phase.id, generation });
    const relative = posix(path.join(itemRelative, 'context', 'claims', `${phase.id}-gen${generation}-${kind}.json`));
    await writeJson(path.join(root, relative), claims);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(claims, null, 2));
    console.log(`Recorded ${Object.keys(claims.claims).length} ${kind} clause claim(s): ${relative}`);
    return;
  }

  if (subcommand === 'coverage') {
    const records = await loadActiveSpecRecords(itemDirectory, workflow);
    const base = optionString(options, 'base') ?? workflow.phases[workflow.phaseOrder[0]]?.sourceCommit ?? null;
    const target = optionString(options, 'target', 'HEAD');
    const coverage = evaluateSpecCoverage(records, changedRepositoryPaths(root, { base, target }), policy, { root });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(coverage, null, 2));
    else {
      console.log(`Clause coverage: ${coverage.complete ? 'complete' : coverage.severity} · ${coverage.totals.observed}/${coverage.totals.clauses} observed · ${coverage.totals.changedPaths} changed path(s).`);
      coverage.unimplemented.forEach((id) => console.log(`  missing ${id}`));
      coverage.unclaimedChangedPaths.forEach((file) => console.log(`  unclaimed ${file}`));
      coverage.withdrawnButClaimed.forEach((id) => console.log(`  withdrawn-but-claimed ${id}`));
      coverage.invalidEvidence.forEach((message) => console.log(`  invalid-evidence ${message}`));
    }
    if (coverage.severity === 'error') throw new SingularityFlowError('Clause coverage is incomplete.', { exitCode: 2 });
    return;
  }

  if (subcommand === 'acceptance') {
    const relative = posix(path.join(itemRelative, 'context', 'acceptance', `${phase.id}-gen${generation}.json`));
    const commandIds = optionStrings(options, 'command');
    if (optionBoolean(options, 'dry-run')) {
      const selected = commandIds.length ? [...new Set(commandIds)] : Object.keys(policy.testCommands ?? {});
      for (const id of selected) if (!policy.testCommands?.[id]) throw new SingularityFlowError(`Unknown allowlisted specification test command '${id}'.`);
      if (!selected.length) throw new SingularityFlowError('No spec.testCommands are configured. Add an allowlisted argv command before running acceptance.');
      const preview = { status: 'planned', write: false, commands: selected.map((id) => ({ id, argv: policy.testCommands[id] })) };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(preview, null, 2));
      console.log(`Specification acceptance dry run: ${selected.length} allowlisted command(s); nothing executed or written.`);
      preview.commands.forEach((entry) => console.log(`  ${entry.id}: ${entry.argv.join(' ')}`));
      return;
    }
    const result = await runSpecAcceptance(root, policy, {
      commandIds,
      workId: workflow.workItem.id,
      phase: phase.id,
      generation,
      outputPath: relative,
      write: true
    });
    const records = await loadActiveSpecRecords(itemDirectory, workflow);
    const evaluation = evaluateSpecAcceptance({ ...records, acceptance: [...records.acceptance, result] }, policy, {
      workId: workflow.workItem.id,
      phase: phase.id,
      generation,
      sourceTreeSha256: await specificationSourceTreeHash(root),
      // A partial command run remains useful evidence, but it cannot satisfy a
      // policy that configures a larger command set.
      commandSetSha256: configuredAcceptanceCommandSetSha256(policy)
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ record: result, evaluation }, null, 2));
    else {
      console.log(`Specification acceptance: ${result.status} · ${result.commands.length} allowlisted command(s).`);
      result.commands.forEach((entry) => console.log(`  ${entry.status === 'passed' ? 'PASS' : 'FAIL'} ${entry.id} (exit ${entry.exitCode})`));
      if (!evaluation.complete) {
        evaluation.missingPlannedTests.forEach((id) => console.warn(`  missing planned test evidence: ${id}`));
        evaluation.missingObservedTests.forEach((id) => console.warn(`  missing observed test evidence: ${id}`));
        evaluation.staleRunReasons.forEach((reason) => console.warn(`  stale acceptance evidence: ${reason}`));
      }
    }
    if (result.status !== 'passed') throw new SingularityFlowError('One or more allowlisted specification acceptance commands failed.', { exitCode: 2 });
    return;
  }

  /**
   * `spec analyze` — the deterministic specification-quality report. `[SPK:REQ-054]`
   *
   * Runs without a model and shows exactly what the publication gate would say, using the same
   * evaluation rather than a second implementation of it. That equivalence is the point: an author
   * needs to be able to ask "would this publish?" and get the real answer, not an approximation
   * that disagrees at the moment it matters.
   */
  if (subcommand === 'analyze') {
    const gate = await evaluateSpecificationGate(root, config, workflow, phase, {
      generation,
      artifactRelativePath: posix(path.join(itemRelative, phase.requiredArtifact?.path ?? '')),
      namespace: policy?.namespace ?? null
    });
    if (!gate.applies) {
      const reason = gate.markerMode === 'off' && gate.qualityMode === 'off'
        ? `Phase ${phase.id} pins no marker or specification-quality policy, so there is nothing to analyze.`
        : `Phase ${phase.id} has no required artifact on disk yet.`;
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ applies: false, reason }, null, 2));
      return console.log(reason);
    }
    /**
     * `--assisted` — semantic candidates through the governed relay. `[SPK:REQ-057]`
     *
     * Runs *after* the deterministic report and never instead of it: the assisted pass is handed
     * the findings so it does not spend its one turn restating them, and its output lands in a
     * separate record that no gate reads `[SPK:CON-029]`.
     */
    const assisted = optionBoolean(options, 'assisted')
      ? await runAssistedAnalysis(root, config, workflow, phase, {
        report: gate.report, itemRelative, generation, namespace: policy?.namespace ?? null, model: optionString(options, 'model')
      })
      : null;

    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(assisted ? { ...gate.report, assisted: assisted.record } : gate.report, null, 2));
    console.log(`Specification quality — ${phase.label} generation ${generation}`);
    console.log(`  artifact:  ${gate.report.binding.artifactPath} (${gate.report.binding.artifactSha256.slice(0, 12)})`);
    console.log(`  policy:    quality ${gate.qualityMode}, markers ${gate.markerMode}, checklist ${gate.checklist}`);
    console.log(`  clauses:   ${gate.report.clauseCount}`);
    console.log(`  markers:   ${gate.report.markers.open.length} open, ${gate.report.markers.resolved.length} resolved since the last generation`);
    if (!gate.report.findings.length) console.log('\nNo checkable defects found.');
    else {
      console.log('');
      for (const finding of gate.report.findings) console.log(`  ${finding.kind}: ${finding.message}`);
    }
    if (assisted) {
      console.log(`\nAssisted candidates — ${assisted.record.model.provider}${assisted.record.model.model ? ` / ${assisted.record.model.model}` : ''}`);
      if (!assisted.record.candidates.length) console.log('  The model raised no semantic concerns.');
      for (const candidate of assisted.record.candidates) {
        console.log(`  ${candidate.concern}${candidate.clauseIds.length ? ` (${candidate.clauseIds.join(', ')})` : ''}: ${candidate.text}`);
      }
      if (assisted.record.unknownClauseIds.length) {
        console.warn(`Warning: the model cited clause(s) this specification does not contain: ${assisted.record.unknownClauseIds.join(', ')}`);
      }
      console.log(`  Recorded: ${assisted.path}`);
      console.log(`  ${assisted.record.disclaimer}`);
    }
    // Printed every time, and most importantly when the report is clean — that is the moment a
    // reader is most likely to hear "the specification is good" `[SPK:CON-027]`.
    console.log(`\n${gate.report.disclaimer}`);
    if (gate.errors.length) console.log(`\nThis phase will not publish or submit until ${gate.errors.length === 1 ? 'this is' : 'these are'} resolved.`);
    return;
  }

  /**
   * `spec tasks` — derive the advisory task map. `[SPK:REQ-112]` `[SPK:REQ-113]`
   *
   * Under `spec` rather than as its own command because the map is derived from the approved
   * specification; giving it a command of its own would suggest it is a thing you author.
   */
  if (subcommand === 'tasks') {
    const specificationPhase = Object.values(workflow.phases).find((entry) => entry.requiredArtifact?.kind === 'requirements');
    if (!specificationPhase) throw new SingularityFlowError(`Work type '${workflow.workItem.workType}' has no specification phase to derive tasks from.`);
    const planningPhase = workflow.phases.planning ?? null;
    const map = deriveAdvisoryTasks({
      workId: workflow.workItem.id,
      specification: await approvedSource(root, itemRelative, specificationPhase),
      // Optional on purpose: a task map that exists as soon as the specification is approved is
      // useful during planning, and the plan only adds expected paths to items that already exist.
      planning: planningPhase ? await approvedSource(root, itemRelative, planningPhase, { required: false }) : null,
      namespace: policy?.namespace ?? null
    });
    const rendered = renderAdvisoryTasks(map);
    const target = advisoryTaskPath(itemRelative, planningPhase ?? specificationPhase);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...map, path: target }, null, 2));
    if (optionBoolean(options, 'dry-run')) {
      console.log(rendered);
      return console.log(`Would write ${map.items.length} advisory task(s) to ${target}.`);
    }
    await writeText(path.join(root, target), rendered);
    console.log(`Derived ${map.items.length} advisory task(s) into ${target}.`);
    console.log(`Bound to specification generation ${map.derivedFrom.specification.generation} (${map.derivedFrom.specification.sha256.slice(0, 12)})`
      + `${map.derivedFrom.planning ? ` and plan generation ${map.derivedFrom.planning.generation} (${map.derivedFrom.planning.sha256.slice(0, 12)})` : '; no approved plan yet'}.`);
    console.log('Advisory only: ticking these boxes is not evidence that implementation or verification is complete.');
    return;
  }

  if (subcommand === 'trace') {
    const rows = traceClause(await loadActiveSpecRecords(itemDirectory, workflow), positionals[2] ?? null);
    const format = optionString(options, 'format', optionBoolean(options, 'json') ? 'json' : 'human');
    if (format === 'json') return console.log(JSON.stringify(rows, null, 2));
    if (format === 'csv') return console.log(traceCsv(rows));
    if (format !== 'human') throw new SingularityFlowError('--format must be human, json, or csv.');
    if (!rows.length) return console.log('No indexed specification clauses were found.');
    console.log(table(rows.map((row) => ({ clause: row.id, type: row.type, verdict: row.verdict, source: row.source })), [
      { key: 'clause', label: 'CLAUSE' }, { key: 'type', label: 'TYPE' },
      { key: 'verdict', label: 'VERDICT' }, { key: 'source', label: 'SOURCE' }
    ]));
    return;
  }
  throw new SingularityFlowError(`Unknown spec subcommand '${subcommand}'. Use index, analyze, tasks, claims, coverage, acceptance, or trace.`);
}

async function agentsCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'agents subcommand');
  const root = repoRoot();
  if (subcommand === 'list') {
    const agents = await discoverAgents(root);
    if (!agents.length) return console.log('No repository or bundled agents found.');
    return console.log(table(agents.map((agent) => ({ id: agent.id, scope: agent.scope, source: agent.source, dependencies: agent.dependencies.length })), [
      { key: 'id', label: 'AGENT' }, { key: 'scope', label: 'SCOPE' }, { key: 'source', label: 'SOURCE' }, { key: 'dependencies', label: 'REMOTE' }
    ]));
  }
  if (subcommand === 'mappings') {
    const result = await agentMappingStatus(root);
    console.log(`Copilot agent mappings: ${result.path}${result.exists ? '' : ' (not created; same-name fallback only)'}`);
    if (!result.rows.length) return console.log('No Copilot agents or Singularity Flow agents were discovered.');
    return console.log(table(result.rows, [
      { key: 'copilotAgent', label: 'COPILOT AGENT' },
      { key: 'agentId', label: 'FLOW AGENT' },
      { key: 'source', label: 'RESOLUTION' }
    ]));
  }
  if (subcommand === 'lock') {
    const agentId = requirePositional(positionals, 2, 'agent');
    const update = optionBoolean(options, 'update');
    const preview = await lockAgent(root, agentId, { update });
    console.log(`agent: ${agentId}\nSource: ${preview.agent.source}\nPack SHA-256: ${preview.agent.sha256}`);
    if (preview.resolution.dependencies.length) console.log(table(preview.resolution.dependencies.map((entry) => { const previous = preview.existing?.dependencies?.find((item) => item.id === entry.id && item.type === entry.type); return { id: entry.id, type: entry.type, previous: previous?.sha256?.slice(0, 12) ?? '', sha256: entry.sha256?.slice(0, 16) ?? entry.status ?? 'dynamic', bytes: entry.size ?? '', url: entry.url ?? entry.urlTemplate }; }), [
      { key: 'id', label: 'RESOURCE' }, { key: 'type', label: 'TYPE' }, { key: 'previous', label: 'PREVIOUS' }, { key: 'sha256', label: 'NEW SHA256' }, { key: 'bytes', label: 'BYTES' }, { key: 'url', label: 'URL' }
    ]));
    if (!(await confirmExact(update ? 'This will replace the trusted hashes shown above.' : 'This is the first trust decision for these public HTTPS Markdown dependencies.', agentId))) throw new SingularityFlowError('Agent lock cancelled.');
    await lockAgent(root, agentId, { update, accepted: true, resolution: preview.resolution });
    return console.log(`Locked '${agentId}' in singularity/agents.lock.yml.`);
  }
  if (subcommand === 'sync') {
    const agentId = requirePositional(positionals, 2, 'agent');
    const result = await syncAgent(root, agentId);
    const definition = await loadConfig(root);
    let workflow = null;
    try { workflow = await loadStoryAggregate(root, definition); } catch { /* Agent sync is also valid before a work item exists. */ }
    await setAgentSession(root, definition, actionActor(root), result.agent.id, workflow?.workItem?.id ?? null, {
      phaseId: workflow?.currentPhase ?? null,
      source: 'agents-sync'
    });
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    console.log(`Active agent: ${result.agent.id}. ${result.dependencies.filter((entry) => entry.status === 'ready').length} remote Markdown resource(s) verified and cached.`);
    return;
  }
  if (subcommand === 'status') {
    const requested = positionals[2] ?? null;
    const rows = await agentStatus(root, requested);
    if (requested && !rows.length) throw new SingularityFlowError(`Unknown agent '${requested}'.`);
    if (!rows.length) return console.log('No repository or bundled agents found.');
    console.log(table(rows.map((entry) => ({ id: entry.id, scope: entry.scope, status: entry.status, source: entry.source, resources: entry.dependencies.length })), [
      { key: 'id', label: 'AGENT' }, { key: 'scope', label: 'SCOPE' }, { key: 'status', label: 'STATUS' }, { key: 'resources', label: 'REMOTE' }, { key: 'source', label: 'SOURCE' }
    ]));
    for (const entry of rows) for (const dependency of entry.dependencies) console.log(`  ${entry.id}/${dependency.id}\t${dependency.type}\t${dependency.status}\t${dependency.sha256?.slice(0, 12) ?? ''}`);
    return;
  }
  if (subcommand === 'refresh-output') {
    const resourceId = requirePositional(positionals, 2, 'resource ID');
    const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config); const phase = currentPhase(workflow);
    await assertNoPendingPublication(root, config, workflow, 'refresh remote generated output');
    await assertPhaseSequence(root, workflow, 'refresh remote generated output');
    const session = await loadSession(root);
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const refreshed = await prepareRemoteOutputs(root, workflow, phase, session, { itemDirectory, refresh: true, replace: optionBoolean(options, 'replace'), resourceId });
    phase.remoteOutputs = [...(phase.remoteOutputs ?? []).filter((entry) => !refreshed.outputs.some((output) => output.resource === entry.resource && output.generation === entry.generation)), ...refreshed.outputs];
    await preparePhaseInputs(root, config, workflow, phase.id);
    await saveStoryDraft(root, config, workflow);
    refreshed.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    return console.log(`Refreshed remote generated artifact '${resourceId}'. It will be committed by the next phase publication.`);
  }
  throw new SingularityFlowError(`Unknown agents subcommand: ${subcommand}`);
}

async function mcpCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  if (subcommand === 'scaffold') {
    const server = requirePositional(positionals, 2, 'MCP server');
    if (!['playwright', 'figma'].includes(server)) throw new SingularityFlowError(`No MCP scaffold is bundled for '${server}'. Supported: playwright, figma.`);
    const scaffold = server === 'figma' ? scaffoldFigmaMcp : scaffoldPlaywrightMcp;
    const result = await scaffold(root, {
      local: optionBoolean(options, 'local'),
      replaceServer: optionBoolean(options, 'replace-server') || optionBoolean(options, 'replace')
    });
    console.log(`${result.changed ? 'Updated' : 'Verified'} ${result.path} (${result.sha256.slice(0, 12)}). Review and commit it, then trust/start the server from VS Code or Copilot CLI.`);
    return;
  }
  const config = await loadConfig(root);
  if (subcommand === 'attest') {
    const server = requirePositional(positionals, 2, 'MCP server');
    const receipt = await attestMcpHost(root, config, server, { confirmation: optionString(options, 'confirm') });
    console.log(`Attested MCP host readiness for ${server} at ${receipt.path}. This machine-local receipt is invalidated when host or policy configuration changes.`);
    return;
  }
  if (subcommand === 'doctor') {
    const result = await mcpDoctor(root, config, { network: optionBoolean(options, 'network') });
    const selected = optionString(options, 'server');
    if (selected && !result.servers.some((server) => server.id === selected)) {
      throw new SingularityFlowError(`Unknown governed MCP server '${selected}'.`, { code: 'MCP_SERVER_UNKNOWN' });
    }
    const servers = selected ? result.servers.filter((server) => server.id === selected) : result.servers;
    const payload = { ...result, servers };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(payload, null, 2));
    if (!servers.length) console.log('No governed MCP servers are declared in singularity/workflow.yml.');
    for (const server of servers) {
      server.reasons.forEach((reason) => console.log(`  ${server.id}: ${reason}`));
      console.log(`MCP ${server.id}: ${server.readiness}`);
    }
    if (servers.some((server) => server.readiness === 'misconfigured' || (server.policy.required && server.readiness !== 'ready'))) {
      throw new SingularityFlowError('MCP diagnostics found blocking readiness errors.', { code: 'MCP_HOST_CONFIG_INVALID' });
    }
    return;
  }
  if (subcommand === 'smoke') {
    const server = requirePositional(positionals, 2, 'MCP server');
    const session = await loadSession(root, { required: false });
    let evidence = null;
    if (session?.workId) {
      const workflow = await loadStoryAggregate(root, config, session.workId);
      const phaseId = optionString(options, 'phase') ?? workflow.currentPhase;
      const phase = workflow.phases?.[phaseId];
      const browserEvidenceRequired = phase?.mcp?.requiredServers?.includes(server)
        && phase.mcp.evidence?.some((requirement) =>
          requirement.server === server && requirement.tool.startsWith('browser_')
        );
      if (browserEvidenceRequired) {
        evidence = { workflow, phase: phaseId, agent: session.agent, actor: session.actor };
      }
    }
    const result = await smokeMcpHost(root, config, server, {
      targetUrl: optionString(options, 'url'), evidence
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`MCP ${server} live smoke passed for ${result.authorizedOrigin}. Receipt: ${result.path}`);
    if (result.evidence) {
      console.log(`Recorded host-observed navigation evidence at ${result.evidence.file}. It will be committed by the next normal lifecycle publication.`);
    }
    return;
  }
  if (subcommand === 'warm') {
    const server = requirePositional(positionals, 2, 'MCP server');
    const result = await warmMcpHost(root, config, server, { network: optionBoolean(options, 'network') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`MCP ${server} network warm-up: ${result.network.status}. Receipt: ${result.path}`);
    return;
  }
  if (['list', 'status'].includes(subcommand)) {
    const result = await mcpStatus(root, config);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (!result.servers.length) console.log('No governed MCP servers are declared in singularity/workflow.yml.');
    else console.log(table(result.servers.map((server) => ({
      id: server.id,
      host: server.hostReference,
      required: server.required ? 'yes' : 'no',
      configured: server.configured ? 'yes' : 'no',
      agents: server.agents.join(',') || '*',
      phases: server.phases.join(',') || '*',
      source: server.sources.join(',') || '-'
    })), [
      { key: 'id', label: 'SERVER' }, { key: 'host', label: 'HOST NAME' },
      { key: 'required', label: 'REQUIRED' }, { key: 'configured', label: 'CONFIGURED' },
      { key: 'agents', label: 'AGENTS' }, { key: 'phases', label: 'PHASES' }, { key: 'source', label: 'HOST SOURCE' }
    ]));
    result.errors.forEach((error) => console.error(`Error: ${error}`));
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    if (subcommand === 'doctor' && (result.errors.length || result.servers.some((server) => server.required && !server.configured))) {
      throw new SingularityFlowError('MCP diagnostics found blocking configuration errors.');
    }
    return;
  }
  if (subcommand === 'record') {
    const server = requirePositional(positionals, 2, 'MCP server');
    const workflow = await loadStoryAggregate(root, config);
    const session = await loadSession(root);
    if (!session || session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Resume ${workflow.workItem.id} before recording MCP evidence.`);
    const result = await recordMcpEvidence(root, workflow, {
      server,
      tool: optionString(options, 'tool'),
      phase: optionString(options, 'phase'),
      outputPath: optionString(options, 'output'),
      outputUrl: optionString(options, 'output-url'),
      note: optionString(options, 'note'),
      targetUrl: optionString(options, 'target-url'),
      kind: optionString(options, 'kind', 'tool-call'),
      fileKey: optionString(options, 'file-key'),
      fileVersion: optionString(options, 'file-version'),
      fileVersionCreatedAt: optionString(options, 'file-version-created-at'),
      nodes: optionStrings(options, 'node'),
      format: optionString(options, 'format'),
      profileId: optionString(options, 'profile-id'),
      screenId: optionString(options, 'screen-id'),
      stateId: optionString(options, 'state-id'),
      agent: session.agent,
      actor: session.actor
    });
    console.log(`Recorded MCP provenance at ${result.file}. It will be committed by the next normal lifecycle publication.`);
    if (result.noticeCode) {
      const notice = gatewayMessage(result.noticeCode);
      console.warn(`Warning: ${notice.label}${notice.detail ? ` — ${notice.detail}` : ''}`);
    }
    return;
  }
  if (subcommand === 'design-sources') {
    const action = positionals[2] ?? 'status';
    const workflow = await loadStoryAggregate(root, config);
    if (action === 'promote') {
      const candidateRecordId = requirePositional(positionals, 3, 'candidate record ID');
      if (optionString(options, 'confirm') !== candidateRecordId) {
        throw new SingularityFlowError(`Promotion reopens the design capture phase and invalidates its downstream approvals. Pass --confirm ${candidateRecordId} to continue.`, { code: 'DESIGN_SOURCE_CONFIRMATION_REQUIRED' });
      }
      const session = await loadSession(root);
      if (session.workId !== workflow.workItem.id) throw new SingularityFlowError(`Resume ${workflow.workItem.id} before promoting design evidence.`);
      const rollbackWorkflow = structuredClone(workflow);
      let promoted;
      const publication = await commitAndPublish(root, config, workflow, {
        type: 'design-source-promoted', phaseId: workflow.resolution?.designSources?.capturePhase,
        actor: session.actor, agent: session.agent, payload: { candidateRecordId }
      }, `[${workflow.workItem.id}][design-source:promote] ${candidateRecordId}`, [], {
        rollbackWorkflow,
        beforeStateWrite: async () => {
          promoted = await promoteDesignSource(root, config, workflow, {
            candidateRecordId, reason: optionString(options, 'reason'), actor: session.actor, agent: session.agent
          });
        }
      });
      const output = { ...promoted, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
      console.log(`Promoted ${candidateRecordId}; reopened ${promoted.capturePhase} and invalidated ${promoted.invalidatedPhases.join(', ')}.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}. Publish and approve a new capture generation before continuing.`);
      return;
    }
    if (action !== 'status') throw new SingularityFlowError(`Unknown mcp design-sources action: ${action}`);
    const result = await verifyDesignSourceLifecycle(root, workflow, {
      itemDirectory: workDir(root, config, workflow.workItem.id)
    });
    const payload = { approved: approvedDesignSourceBinding(workflow), ...result };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(payload, null, 2));
    console.log(payload.approved
      ? `Approved design-source set: ${payload.approved.setSha256} (${payload.approved.records?.length ?? 0} record(s))`
      : 'No approved design-source set.');
    payload.passes.forEach((entry) => console.log(`Pass: ${entry}`));
    payload.warnings.forEach((entry) => console.warn(`Warning: ${entry}`));
    if (payload.errors.length) throw new SingularityFlowError(`Design-source diagnostics failed:\n- ${payload.errors.join('\n- ')}`);
    return;
  }
  throw new SingularityFlowError(`Unknown mcp subcommand: ${subcommand}`);
}

async function visualCommand(positionals, options) {
  const root = repoRoot(), config = await loadConfig(root), workflow = await loadStoryAggregate(root, config);
  const action = positionals[1] ?? 'status';
  if (action === 'status') {
    const coverage = await evaluateVisualCoverage(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    const comparisons = await listVisualComparisons(root, workflow, { itemDirectory: workDir(root, config, workflow.workItem.id) });
    const result = { coverage, comparisons };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Visual coverage: ${coverage.status} (${coverage.covered.length}/${coverage.profiles.length} profiles)`);
    coverage.warnings.forEach((entry) => console.warn(`Warning: ${entry}`));
    coverage.errors.forEach((entry) => console.error(`Error: ${entry}`));
    for (const comparison of comparisons) console.log(`${comparison.id}\t${comparison.status}\t${comparison.differingPixels} differing pixels`);
    return;
  }
  if (action === 'compare') {
    const result = await compareVisualArtifacts(root, workflow, {
      expected: optionString(options, 'expected'), actual: optionString(options, 'actual'),
      profileId: optionString(options, 'profile'), itemDirectory: workDir(root, config, workflow.workItem.id)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Visual comparison ${result.id}: ${result.status}; ${result.differingPixels} pixels (${(result.differingPixelRatio * 100).toFixed(3)}%).`);
    console.log(`Summary: ${result.path}${result.diffImage ? `\nDiff: ${result.diffImage.path}` : ''}`);
    if (result.status === 'fail') throw new SingularityFlowError('Visual comparison exceeds enforced thresholds.', { code: 'VISUAL_COMPARISON_FAILED' });
    return;
  }
  throw new SingularityFlowError(`Unknown visual action '${action}'.`);
}

async function wmCommand(positionals, options) {
  if (positionals[1] !== 'design-inventory') return worldModelCommand(repoRoot(), positionals, options);
  if (!optionBoolean(options, 'from-records')) throw new SingularityFlowError('Design inventory generation is deterministic and requires --from-records.');
  const root = repoRoot(), config = await loadConfig(root), workflow = await loadStoryAggregate(root, config);
  const binding = approvedDesignSourceBinding(workflow);
  const result = await generateDesignInventory(root, workflow, binding, { itemDirectory: workDir(root, config, workflow.workItem.id) });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`Design inventory: ${result.digest.digestSha256}\nJSON: ${result.json.path}\nMarkdown: ${result.markdown.path}`);
}

async function phaseReview(root, config, workflow, phase) {
  const records = (await documentCatalog(root, config, workflow))
    .filter((record) => record.type === 'artifact' && record.phase === phase.id);
  const documents = [];
  for (const record of records) {
    try {
      const viewed = await viewDocument(root, config, workflow, record.id);
      documents.push({
        id: record.id,
        label: record.label,
        kind: record.kind,
        path: record.path,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        generation: record.generation ?? phase.generation,
        binary: viewed.binary,
        absolutePath: viewed.absolutePath ?? pathForDisplay(root, record.path),
        content: viewed.content
      });
    } catch (error) {
      documents.push({
        id: record.id,
        label: record.label,
        kind: record.kind,
        path: record.path,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        generation: record.generation ?? phase.generation,
        error: error?.message ?? String(error)
      });
    }
  }
  for (const brief of (phase.agentBriefs ?? []).filter((entry) => entry.generation === phase.generation && entry.renderedPath)) {
    const absolute = path.join(root, brief.renderedPath);
    const info = await snapshot(absolute);
    documents.push({
      id: `agent-brief-${phase.id}-${brief.consumerPhase}`,
      label: `Agent brief for ${brief.consumerPhase}`,
      kind: 'agent-brief',
      path: brief.renderedPath,
      mimeType: 'text/markdown',
      size: info.size,
      sha256: info.sha256,
      generation: phase.generation,
      binary: false,
      absolutePath: pathForDisplay(root, brief.renderedPath),
      content: await readFile(absolute, 'utf8')
    });
  }
  return {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phase: phase.id,
    phaseLabel: phase.label,
    status: phase.status,
    generation: phase.generation,
    documents
  };
}

/**
 * Report the artifacts a phase produced.
 *
 * The full body used to be printed unconditionally, and `viewDocument` allows a megabyte, so one
 * `submit` ran to several hundred lines of which about twenty-five were the result — the commit SHA
 * and the next step at opposite ends of the wall. The default is now the inventory: what was
 * produced, where it is, and how to read it. `--show-artifact` prints the bodies.
 *
 * Only the terminal is affected. `--json` never reached this function.
 */
function printPhaseReview(review, { showArtifact = false } = {}) {
  console.log(`\n${style.heading('Generated documents ready for review')} ${style.detail(style.fields(review.workId, review.phase, `generation ${review.generation}`))}`);
  if (!review.documents.length) {
    console.log('No generated documents are registered for this phase.');
    return;
  }
  for (const [index, document] of review.documents.entries()) {
    console.log(`\n${style.bold(`[${index + 1}] ${document.label}`)} ${style.detail(`(${document.id})`)}`);
    console.log(`  ${document.path}`);
    console.log(`  ${style.detail(style.fields(
      document.kind ?? 'artifact',
      document.mimeType ?? 'unknown',
      `${document.size ?? 'unknown'} bytes`,
      document.sha256 ? `sha256:${String(document.sha256).slice(0, 12)}` : 'sha256 unavailable'
    ))}`);
    if (document.error) console.warn(`  Warning: document preview unavailable: ${document.error}`);
    else if (document.binary) console.log(`  Binary document: open ${document.absolutePath}`);
    else if (document.content != null && showArtifact) {
      console.log(`\n--- BEGIN ${document.path} ---`);
      process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
      console.log(`--- END ${document.path} ---`);
    }
  }
  const readable = review.documents.filter((document) => !document.error && !document.binary && document.content != null);
  if (readable.length && !showArtifact) {
    console.log(`\n${style.action('Read them:')} singularity-flow documents view <id> --work-id ${review.workId}`);
    console.log(style.detail(`Add --show-artifact to print ${readable.length === 1 ? 'the document' : `all ${readable.length} documents`} here instead.`));
  }
}

async function phaseCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'phase subcommand');
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  if (subcommand === 'show') {
    const phaseId = positionals[2] ?? workflow.currentPhase;
    const phase = workflow.phases[phaseId];
    if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
    const review = await phaseReview(root, config, workflow, phase);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(review, null, 2));
    else printPhaseReview(review, { showArtifact: optionBoolean(options, 'show-artifact') });
    return;
  }
  if (subcommand !== 'publish') throw new SingularityFlowError(`Unknown phase subcommand: ${subcommand}`);
  const usageFile = optionString(options, 'usage-json'); const usage = usageFile ? await readJson(usageFile) : null;
  const phaseId = positionals[2] ?? workflow.currentPhase;
  const requestedPhase = workflow.phases[phaseId];
  if (!requestedPhase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  const sourcePath = optionString(options, 'from');
  const authored = optionString(options, 'authored');
  const authorshipOptions = normalizeAuthorshipOptions({
    producer: authored,
    channel: optionString(options, 'channel'),
    imported: Boolean(sourcePath),
    externalAiUse: optionString(options, 'external-ai')
  });
  if (!authored) console.warn('Deprecation warning: phase publish without --authored records legacy-unspecified. Pass --authored human or --authored governed-agent.');
  if (sourcePath && !['human', 'external-tool'].includes(authorshipOptions.producer)) {
    throw new SingularityFlowError('--from requires --authored human or --authored external-tool.', { code: 'MANUAL_AUTHORSHIP_REQUIRED' });
  }
  if (usageFile && authorshipOptions.producer !== 'governed-agent') {
    throw new SingularityFlowError('--usage-json is valid only with --authored governed-agent. Manual and deterministic publication record model usage as not-invoked.');
  }
  assertProducerAllowed(requestedPhase, authorshipOptions.producer);
  const session = await loadSession(root);
  const targetPath = path.join(workDir(root, config, workflow.workItem.id), requestedPhase.requiredArtifact.path);
  const targetRelative = path.relative(root, targetPath).replaceAll(path.sep, '/');
  // Discover the prospective generation's artifact set before opening the publication unit. This
  // changes only the in-memory aggregate; the unit below still owns every durable write. Without
  // this preflight, implementation source/tests first discovered inside `publishGeneration` were
  // absent from the transaction's immutable path allowlist and therefore absent from the exact
  // generation commit later used by governed references and review packets.
  await scanArtifacts(root, config, workflow, phaseId);
  // Attribute the kernel-model invocations this generation actually made. Reading the audit store is
  // what makes `kernelModel.invoked` a fact rather than the constant `false` it has always been.
  // Invocations already claimed by an earlier generation are excluded, so each is attributed once.
  const attributedInvocations = new Set(Object.values(workflow.phases ?? {})
    .flatMap((item) => item.authorship ?? [])
    .flatMap((record) => record.kernelModel?.invocationIds ?? []));
  const kernelInvocationIds = (await listModelInvocations(root, { subjectId: workflow.workItem.id }))
    .map((record) => record.id)
    .filter((invocationId) => !attributedInvocations.has(invocationId));
  const generation = requestedPhase.generation + 1;
  let phase = requestedPhase;
  const result = await commitAndPublish(
    root,
    config,
    workflow,
    { type: 'artifact-generated', phaseId, generation },
    `[${workflow.workItem.id}][phase:${phaseId}][generated:${generation}] publish artifacts`,
    [...new Set([...requestedPhase.artifacts.map((item) => item.path), targetRelative])],
    {
      beforeStateWrite: async () => {
        const source = sourcePath
          ? await importManualArtifact({ sourcePath: path.resolve(sourcePath), targetPath, contract: requestedPhase.requiredArtifact })
          : await inspectInPlaceArtifact(targetPath, requestedPhase.requiredArtifact);
        const authorship = buildGenerationAuthorship({
          options: authorshipOptions,
          actor: session.actor,
          governedAgentContext: session.agent,
          source,
          kernelInvocationIds
        });
        await scanArtifacts(root, config, workflow, phaseId);
        phase = await publishGeneration(root, config, workflow, { phaseId, usage, authorship, persist: false });
      }
    }
  );
  console.log(`Published ${phase.id} generation ${phase.generation} at ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
  const telemetry = (phase.telemetry ?? []).find((item) => item.generation === phase.generation);
  const generationUsage = (phase.usage ?? []).filter((item) => item.generation === phase.generation);
  const tokens = generationUsage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
  const costs = generationUsage.map((item) => item.providerCost).filter(Number.isFinite);
  const providerCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
  if (telemetry) {
    const unavailable = telemetry.status === 'not-invoked' ? 'not invoked' : 'unavailable';
    console.log(style.fields(
      `Telemetry: ${telemetry.status}`,
      `models: ${telemetry.models.join(', ') || unavailable}`,
      `tokens: ${tokens || unavailable}`,
      `provider cost: ${providerCost == null ? unavailable : `$${providerCost.toFixed(6)}`}`
    ));
    console.log(`Telemetry record: ${telemetry.path}`);
    if (telemetry.status === 'pending') console.log('Telemetry will be reconciled automatically on the next submit action, after Copilot exports this completed turn.');
  }
  printPhaseReview(await phaseReview(root, config, workflow, phase), { showArtifact: optionBoolean(options, 'show-artifact') });
}

async function artifactCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'artifact subcommand');
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  await assertNoPendingPublication(root, config, workflow, 'change artifact registration');
  const phaseId = optionString(options, 'phase');
  if (subcommand === 'add') {
    const paths = positionals.slice(2);
    if (!paths.length) throw new SingularityFlowError('Provide at least one artifact path.');
    const records = [];
    for (const candidate of paths) records.push(await registerArtifact(root, workflow, candidate, { phaseId, kind: optionString(options, 'kind') }));
    await saveStoryDraft(root, config, workflow);
    records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  if (subcommand === 'scan') {
    const records = await scanArtifacts(root, config, workflow, phaseId);
    await saveStoryDraft(root, config, workflow);
    if (!records.length) console.log('No changed artifacts found.');
    else records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  throw new SingularityFlowError(`Unknown artifact subcommand: ${subcommand}`);
}

async function pullRequestCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const describe = positionals[1] === 'describe';
  const workflow = await loadStoryAggregate(root, config, describe ? positionals[2] : positionals[1]);
  const mergeSequence = await publishedStackForStory(root, config, workflow);
  const plan = await storyPullRequestPlan(root, config, workflow, { mergeSequence });

  if (describe) {
    const format = optionString(options, 'format', 'markdown').toLowerCase();
    if (!['markdown', 'json'].includes(format)) throw new SingularityFlowError(`Unknown PR description format '${format}'. Use markdown or json.`);
    const context = operationContext();
    const polishRequested = optionBoolean(options, 'polish');
    let body = plan.body;
    let polishApplied = false;
    let modelInvocation = null;
    if (polishRequested && context?.fallbackFrom !== 'pr.describe.polish') {
      const provider = config.models?.defaultProvider ?? 'copilot-cli';
      const providerConfig = config.models?.providers?.[provider] ?? null;
      const response = await invokeModel({
        provider,
        providerConfig,
        model: providerConfig?.model ?? null,
        cwd: root,
        allowedRoots: [root],
        channel: 'pr-description-polish',
        subject: { kind: 'story', id: workflow.workItem.id },
        prompt: { text: [
          'Polish the following pull-request description for clarity and brevity.',
          'Preserve every factual claim, identifier, checkbox, code span, and Markdown link.',
          'Do not add evidence, claims, or implementation details. Return Markdown only.',
          '', plan.body
        ].join('\n') },
        tools: { mode: 'none', names: [] },
        limits: { timeoutMs: 60_000, outputBytes: 512 * 1024 }
      });
      body = response.output;
      polishApplied = true;
      modelInvocation = {
        id: response.invocationId,
        provider: response.provider,
        model: response.model,
        outputSha256: response.outputSha256
      };
    }
    const fallback = context?.fallbackFrom === 'pr.describe.polish'
      ? { requestedOperationId: context.fallbackFrom, operationId: context.operation.id, enhancementOmitted: true }
      : null;
    const result = {
      ...plan,
      body,
      deterministic: !polishApplied,
      polishApplied,
      fallback,
      modelInvocation,
      subjectRevision: workflow.revision?.subjectRevision ?? null
    };
    if (optionBoolean(options, 'clipboard')) result.clipboard = copyToClipboard(result.body);
    if (optionBoolean(options, 'write')) {
      if (!optionBoolean(options, 'yes') && !(await confirmExact(`Type ${plan.workId} to update the existing pull request description: `, plan.workId))) {
        throw new SingularityFlowError('Pull request update cancelled.');
      }
      result.write = updateStoryPullRequest(root, { ...plan, body: result.body });
    }
    if (format === 'json') console.log(JSON.stringify(result, null, 2));
    else {
      process.stdout.write(`${result.body}\n`);
      if (fallback) console.error('Model enhancement omitted; returned the deterministic pr.describe result.');
      if (result.clipboard?.status === 'unavailable') console.error(`Clipboard unavailable: ${result.clipboard.reason}`);
      else if (result.clipboard) console.error(`Copied with ${result.clipboard.provider}.`);
      if (result.write?.status === 'unavailable') console.error(`PR update unavailable: ${result.write.reason}`);
      else if (result.write) console.error(`Updated ${result.write.url}`);
    }
    return;
  }

  if (optionBoolean(options, 'json')) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`Pull request for ${plan.workId}\n`);
    console.log(`  ${plan.head} → ${plan.base}   (policy: ${plan.policy})`);
    if (plan.requiredChecks.length) console.log(`  Required checks: ${plan.requiredChecks.join(', ')}`);
    if (plan.blockedBy.length) console.log(`  Blocked by: ${plan.blockedBy.join(', ')}`);
    console.log(`\n--- title ---\n${plan.title}\n\n--- body ---\n${plan.body}\n`);
  }

  // Opening a pull request is an outward action, so preview is the default: it requires an
  // explicit --create plus a typed confirmation of the exact work ID.
  if (!optionBoolean(options, 'create')) {
    console.log('Preview only. Re-run with --create to open this pull request.');
    return;
  }
  if (!optionBoolean(options, 'yes') && !(await confirmExact(`Type ${plan.workId} to open the pull request into ${plan.base}: `, plan.workId))) {
    throw new SingularityFlowError('Pull request cancelled.');
  }
  const result = createStoryPullRequest(root, plan, { remote: config.git?.remote ?? 'origin' });
  console.log(result.status === 'existing'
    ? `A pull request already exists: ${result.url}`
    : `Opened ${result.url}`);
}

async function refreshBranchCommand(options) {
  const root = repoRoot();
  const result = refreshBranch(root, {
    remote: optionString(options, 'remote', 'origin'),
    branchName: optionString(options, 'branch')
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  if (result.status === 'fast-forwarded') {
    console.log(`Refreshed ${result.branch}: ${result.before.slice(0, 8)} → ${result.after.slice(0, 8)} (${result.behind} commit${result.behind === 1 ? '' : 's'}).`);
  } else if (result.status === 'ahead') {
    console.log(`${result.branch} is already current and ${result.ahead} commit${result.ahead === 1 ? '' : 's'} ahead of ${result.remote}/${result.branch}; nothing changed.`);
  } else {
    console.log(`${result.branch} is up to date with ${result.remote}/${result.branch}.`);
  }
}

function printStack(stack) {
  console.log(`Story merge stack for ${stack.initiativeId} → ${stack.epicBranch}\n`);
  console.log(table(stack.stories.map((story) => ({
    order: String(story.order), story: story.workId, repository: story.repository,
    status: story.status, blockers: (story.mergeBlockedBy ?? story.blockedBy ?? []).join(', ') || '—'
  })), [
    { key: 'order', label: '#' }, { key: 'story', label: 'STORY' }, { key: 'repository', label: 'REPOSITORY' },
    { key: 'status', label: 'STATUS' }, { key: 'blockers', label: 'MERGE BLOCKERS' }
  ]));
  console.log(`\nNext to merge: ${stack.nextToMerge ?? 'none'}`);
  console.log(stack.epicReady ? 'Epic branch is ready to land.' : `Outstanding blocking Stories: ${stack.outstanding.join(', ') || 'none'}`);
  if (stack.unreachable?.length) console.log(`Unreachable Story branches: ${stack.unreachable.join(', ')}`);
}

async function stackCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'stack subcommand');
  const root = repoRoot();
  if (subcommand === 'sync') {
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const result = await syncStoryStack(root, initiativeId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    printStack(result.stack);
    console.log('\nOrphan state-branch publications:');
    result.publications.forEach((item) => console.log(`  ${item.repository}: ${item.changed ? item.commit.slice(0, 8) : 'unchanged'} on ${item.branch}`));
    return;
  }
  if (subcommand === 'status') {
    const explicitEpic = optionString(options, 'epic');
    let stack;
    if (explicitEpic) {
      const mergeState = await initiativeMergeState(root, explicitEpic);
      const { portfolio } = await loadInitiativeAggregate(root, explicitEpic);
      const breakdown = await loadInitiativeBreakdown(root, portfolio, explicitEpic);
      stack = buildStoryStack(mergeState, breakdown);
    } else {
      const config = await loadConfig(root);
      const workflow = await loadStoryAggregate(root, config);
      stack = await publishedStackForStory(root, config, workflow);
      if (!stack) throw new SingularityFlowError(`${workflow.workItem.id} has no Epic merge stack.`);
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(stack, null, 2));
    printStack(stack);
    return;
  }
  throw new SingularityFlowError(`Unknown stack subcommand: ${subcommand}`);
}

async function regressionCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'analyze';
  if (subcommand !== 'analyze') throw new SingularityFlowError(`Unknown regression subcommand: ${subcommand}`);
  const root = repoRoot();
  if (optionBoolean(options, 'fetch')) fetchRemote(root, optionString(options, 'remote', 'origin'));
  const report = analyzeRegression(root, {
    base: optionString(options, 'base', 'main'),
    good: optionString(options, 'good'),
    bad: optionString(options, 'bad', 'HEAD'),
    paths: optionStrings(options, 'path'),
    maxCandidates: optionNumber(options, 'max', 20)
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(report, null, 2));
  console.log(regressionReportMarkdown(report));
}

function selectedPhaseArgument(positionals, options, command) {
  const positional = positionals[1];
  const flagged = optionString(options, 'phase');
  if (positional && flagged && positional !== flagged) {
    throw new SingularityFlowError(`${command} received two different phases: '${positional}' and '${flagged}'. Pass the phase once, either positionally or with --phase.`);
  }
  return flagged ?? positional;
}

function configuredStoryPhaseIds(config) {
  const phases = new Set(Object.keys(config.phases ?? {}));
  for (const workType of Object.values(config.workTypes ?? {})) {
    for (const phase of workType.phases ?? []) {
      const id = typeof phase === 'string' ? phase : phase?.id ?? phase?.phase;
      if (id) phases.add(id);
    }
  }
  return phases;
}

function decisionArguments(config, positionals, options, action) {
  const positional = positionals[1];
  const explicitWorkId = optionString(options, 'work-id');
  const flaggedPhase = optionString(options, 'phase');
  if (!positional) return { requestedId: explicitWorkId, requestedPhase: flaggedPhase, implicitLegacyWorkId: false };

  if (explicitWorkId) {
    return {
      requestedId: explicitWorkId,
      requestedPhase: selectedPhaseArgument(positionals, options, action),
      implicitLegacyWorkId: false
    };
  }

  const phaseIds = configuredStoryPhaseIds(config);
  if (phaseIds.has(positional)) {
    return {
      requestedId: undefined,
      requestedPhase: selectedPhaseArgument(positionals, options, action),
      implicitLegacyWorkId: false
    };
  }

  // Compatibility for the former `approve WORK-ID --phase PHASE` grammar. New calls should use
  // `approve PHASE --work-id WORK-ID`, which cannot confuse a phase with a branch name.
  return { requestedId: positional, requestedPhase: flaggedPhase, implicitLegacyWorkId: true };
}

export async function submitCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  let workflow = await loadStoryAggregate(root, config);
  const requestedPhase = selectedPhaseArgument(positionals, options, 'submit');
  const reconciliation = await reconcilePhaseTelemetry(root, config, workflow, { phaseId: requestedPhase });
  if (reconciliation.updated) {
    const telemetryPublication = await commitAndPublish(root, config, workflow, { type: 'telemetry-recorded', phaseId: reconciliation.phase, generation: reconciliation.generation }, `[${workflow.workItem.id}][phase:${reconciliation.phase}][telemetry:${reconciliation.generation}] reconcile Copilot usage`);
    console.log(`Reconciled ${reconciliation.phase} generation ${reconciliation.generation} telemetry at ${telemetryPublication.sha.slice(0, 8)}${telemetryPublication.pushed ? ' and pushed' : ''}.`);
    console.log(`Models: ${reconciliation.models.join(', ') || 'unavailable'} | Tokens: ${reconciliation.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) || 'unavailable'} | Provider cost: ${reconciliation.providerCost == null ? 'unavailable' : `$${reconciliation.providerCost.toFixed(6)}`}`);
    workflow = await loadStoryAggregate(root, config);
  } else if (reconciliation.pending) console.warn(`Telemetry remains pending: ${reconciliation.reason}`);
  const workflowBeforeSubmission = structuredClone(workflow);
  const phaseId = requestedPhase ?? workflow.currentPhase;
  const requested = workflow.phases[phaseId];
  if (!requested) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
  let phase = requested;
  let reviewPacket = null;
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    { type: 'approval-requested', phaseId: requested.id, generation: requested.generation },
    `[${workflow.workItem.id}][phase:${requested.id}][submit] request approval`,
    requested.artifacts.map((item) => item.path),
    {
      rollbackWorkflow: workflowBeforeSubmission,
      beforeStateWrite: async () => {
        phase = await submitPhase(root, config, workflow, {
          phaseId: requested.id,
          runChecks: !optionBoolean(options, 'skip-checks'),
          persist: false
        });
        reviewPacket = await createStoryReviewPacket(root, config, workflow, phase);
      }
    }
  );
  if (!reviewPacket) throw new SingularityFlowError('Submission review packet was not created.');
  const evidenceReceipt = await composeEvidenceReceipt(root, config, workflow, reviewPacket.packet);
  const approvalMode = phase.approvalPolicy?.mode ?? 'required';
  const completedWithoutReview = phase.status === 'approved' && approvalMode === 'none';
  const completedByPolicy = phase.status === 'approved' && approvalMode === 'policy';
  if (completedWithoutReview) console.log(`\nCompleted ${phase.id} phase (configured approval mode: none).`);
  else if (completedByPolicy) console.log(`\nCompleted ${phase.id} phase using its deterministic policy waiver.`);
  else console.log(`\nSubmitted ${phase.id} phase for approval.`);
  console.log(`Commit: ${publication.sha.slice(0, 8)} — ${phase.status === 'approved' ? 'complete phase' : 'request approval'} (${workflow.workItem.id})`);
  console.log(`Push: ${publication.pushed ? `${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}` : 'disabled by git.publish: off'}`);
  console.log(`Review packet: ${reviewPacket.path} (${reviewPacket.packet.packetSha256.slice(0, 12)})`);
  console.log(`\n${renderEvidenceReceipt(evidenceReceipt)}`);
  printPhaseReview(await phaseReview(root, config, workflow, phase), { showArtifact: optionBoolean(options, 'show-artifact') });
  // The trailer is narrated. It used to name a Copilot skill and a CLI equivalent chosen by hand
  // here; NEXT now comes from the deterministic planner against the state the submission left.
  const advanced = currentPhase(workflow);
  emitCommandResult(commandResult({
    operation: { id: 'submit', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded(phase.status === 'approved' ? 'submit.completed' : 'submit.succeeded', {
      phase: phase.id, documents: phase.artifacts.length
    }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: {
      commit: publication.sha,
      pushed: publication.pushed,
      reviewPacket: reviewPacket.packet.packetSha256,
      evidenceReceipt
    }
  }), { postState: workflow, restStateWhenIdle: advanced ? null : 'complete' });
}

async function telemetryCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  const status = await copilotTelemetryStatus(root);
  if (subcommand === 'status') {
    let workflow = null;
    try { const config = await loadConfig(root); workflow = await loadStoryAggregate(root, config); } catch { /* Diagnostics remain useful without an active work item. */ }
    const pending = workflow
      ? workflow.phaseOrder.flatMap((phaseId) => (workflow.phases[phaseId].telemetry ?? []).filter((item) => item.status === 'pending').map((item) => ({ phase: phaseId, generation: item.generation, path: item.path })))
      : [];
    const launches = await explainTelemetryStatus({
      root,
      story: optionString(options, 'story', workflow?.workItem?.id ?? null)
    });
    const result = {
      schemaVersion: 2,
      capture: launches,
      // Preserve the path-free v1 readiness fields for scripts while the qualified launch
      // partition becomes the authoritative v2 view.
      exists: status.exists,
      ready: status.ready,
      completedChatSpans: status.completedChatSpans,
      legacyExporter: {
        enabled: status.enabled,
        fileConfigured: status.fileConfigured,
        externalEndpoint: status.externalEndpoint,
        explicitlyEnabled: status.explicitlyEnabled,
        exists: status.exists,
        bytes: status.bytes,
        completedChatSpans: status.completedChatSpans,
        ready: status.ready,
        setup: { installed: status.setup.installed, current: status.setup.current },
        warnings: status.warnings
      },
      pending
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Copilot usage — ${launches.status}`);
    console.log(`SFlow-owned launches: ${launches.launches.length} | Captured: ${launches.counts.captured} | Partial: ${launches.counts.partial}`);
    console.log(`Local capture: ${launches.preference.enabled ? 'enabled' : 'disabled'} | Disclosure: ${launches.preference.disclosureAccepted ? 'accepted' : 'required'}`);
    console.log(`Pending generations: ${pending.length ? pending.map((item) => `${item.phase}@${item.generation}`).join(', ') : 'none'}`);
    if (!launches.launches.length && status.ready) console.log(`Legacy repository stream: ${status.completedChatSpans} completed chat span(s).`);
    if (launches.status === 'unavailable') console.log('Usage unavailable for this session. Your work can continue.');
    if (!launches.preference.enabled) console.log('Enable future SFlow-owned launches with: singularity-flow telemetry enable');
    else if (!launches.preference.disclosureAccepted) console.log('Review and accept the local collection disclosure with: singularity-flow telemetry enable');
    return;
  }
  if (subcommand === 'probe') {
    const probes = await Promise.all([
      ['copilot-cli', 'cli'], ['copilot-cli', 'vscode-terminal'], ['copilot-cli', 'intellij-terminal'],
      ['copilot-native', 'vscode-native'], ['copilot-native', 'intellij-native']
    ].map(([runtime, host]) => probeTelemetry({ root, provider: 'github-copilot', runtime, host })));
    const result = { schemaVersion: 1, probes };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    for (const probe of probes) console.log(`${probe.host}: ${probe.mode} · ${probe.available ? 'available' : 'usage unavailable'}`);
    return;
  }
  if (subcommand === 'disable') {
    const preference = await setTelemetryCapture(false);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ schemaVersion: 1, status: 'disabled', preference }, null, 2));
    console.log('Local usage capture is disabled for future SFlow-owned launches. Governed work is unchanged.');
    return;
  }
  if (subcommand === 'enable') {
    if (!optionBoolean(options, 'json')) console.log(TELEMETRY_DISCLOSURE);
    const explicit = optionString(options, 'confirm');
    const accepted = explicit != null
      ? explicit === TELEMETRY_DISCLOSURE_CONFIRMATION
      : await confirmExact('Enable metadata-only local usage capture?', TELEMETRY_DISCLOSURE_CONFIRMATION);
    if (!accepted) throw new SingularityFlowError(`Telemetry enable requires exact confirmation '${TELEMETRY_DISCLOSURE_CONFIRMATION}'.`, { code: 'TELEMETRY_DISCLOSURE_REQUIRED' });
    const preference = await setTelemetryCapture(true, { acceptDisclosure: true });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({
      schemaVersion: 1, status: 'enabled', disclosure: TELEMETRY_DISCLOSURE, preference
    }, null, 2));
    console.log('Local metadata-only usage capture is enabled for future SFlow-owned launches.');
    return;
  }
  if (subcommand !== 'reconcile') throw new SingularityFlowError(`Unknown telemetry subcommand: ${subcommand}`);
  const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  const result = await reconcilePhaseTelemetry(root, config, workflow, { phaseId: positionals[2] });
  if (result.updated) {
    const publication = await commitAndPublish(root, config, workflow, { type: 'telemetry-recorded', phaseId: result.phase, generation: result.generation }, `[${workflow.workItem.id}][phase:${result.phase}][telemetry:${result.generation}] reconcile Copilot usage`);
    Object.assign(result, { commit: publication.sha, pushed: publication.pushed });
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ exporter: status, reconciliation: result }, null, 2));
  if (!result.updated) {
    console.log(`Telemetry was not changed: ${result.reason}`);
    status.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    return;
  }
  console.log(`Reconciled ${result.phase} generation ${result.generation}: ${result.status}.`);
  console.log(`Models: ${result.models.join(', ') || 'unavailable'} | Tokens: ${result.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) || 'unavailable'} | Provider cost: ${result.providerCost == null ? 'unavailable' : `$${result.providerCost.toFixed(6)}`}`);
  console.log(`Commit: ${result.commit.slice(0, 8)}${result.pushed ? ' and pushed' : ''}`);
}

async function decisionWorkflow(positionals, options, action) {
  const root = repoRoot();
  const receiptToken = optionString(options, 'selection-receipt');
  if (receiptToken) assertClean(root);
  let config = await loadConfig(root);
  const { requestedId, requestedPhase, implicitLegacyWorkId } = decisionArguments(config, positionals, options, action);
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) {
    try {
      checkout(root, requestedId, {
        base: config.defaultBaseBranch,
        fetch: optionBoolean(options, 'fetch'),
        existingOnly: true,
        remote: config.git?.remote ?? 'origin'
      });
    } catch (error) {
      if (implicitLegacyWorkId && /Branch .* does not exist/.test(error?.message ?? '')) {
        throw new SingularityFlowError(`'${requestedId}' is not a configured phase or an available Work ID. Use '${action} <PHASE>' for the current Story, or '${action} <PHASE> --work-id <WORK-ID>' for another Story.`);
      }
      throw error;
    }
  }
  config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, requestedId);
  const workId = workflow.workItem.id;
  const overridesBefore = workflow.sequenceOverrides?.length ?? 0;
  await assertNoPendingPublication(root, config, workflow, action);
  const phase = await assertPhaseSequence(root, workflow, action, {
    requestedPhase,
    allowedStatuses: ['awaiting_approval']
  });
  const receipt = receiptToken
    ? await resolveSelectionReceipt(root, config, receiptToken, { action, workId: workflow.workItem.id, workflow })
    : null;
  const session = await activatePhaseAgent(
    root, config, workflow.workItem.id, phase, optionString(options, 'agent') ?? null
  );
  for (const override of (workflow.sequenceOverrides ?? []).slice(overridesBefore)) {
    override.actor = session.actor;
    override.agent = session.agent;
    const history = workflow.history?.find((event) => event.event === 'sequence_gate_overridden' && event.at === override.at);
    if (history) {
      history.actor = session.actor.login ?? session.actor.email ?? session.actor.name ?? 'interactive-user';
      history.agent = session.agent;
    }
  }
  return { root, config, workflow, phase, session, receipt, receiptToken };
}

/**
 * The reviewer's checklist decisions, from `--article` or `--checklist`. `[SPK:REQ-060]`
 *
 * `--article completeness=satisfied` reads well for the common case and `--checklist decisions.json`
 * carries reasons that do not fit on a command line. There is deliberately no flag that answers
 * every article at once: the checklist is the reviewer's instrument, and a one-word way to satisfy
 * all six would be the rubber stamp `[SPK:REQ-060]` exists to prevent.
 *
 * Reasons come from `--article-reason` and not `--reason`, which already means "why this Story is
 * being returned" on `reject` and on `epic review`. Two meanings on one flag would have made
 * `epic review --decision reject --reason "..."` start failing as a malformed checklist.
 * `--article-reason` values pair with the non-`satisfied` articles in the order both are given.
 */
async function checklistDecisions(options) {
  const file = optionString(options, 'checklist');
  if (file) {
    const payload = await readJson(path.resolve(file));
    const entries = Array.isArray(payload) ? payload : payload.checklist ?? payload.decisions;
    if (!Array.isArray(entries)) throw new SingularityFlowError('--checklist must contain an array of {article, decision, reason} entries.');
    return entries;
  }
  const articles = optionStrings(options, 'article');
  const reasons = optionStrings(options, 'article-reason');
  if (!articles.length) {
    if (reasons.length) throw new SingularityFlowError('--article-reason applies to a checklist article; pass --article <id>=exception alongside it.');
    return [];
  }
  let reasonIndex = 0;
  return articles.map((entry) => {
    const separator = String(entry).indexOf('=');
    const article = separator === -1 ? '' : String(entry).slice(0, separator).trim();
    const decision = separator === -1 ? '' : String(entry).slice(separator + 1).trim();
    if (!article || !decision) throw new SingularityFlowError(`--article must be <id>=satisfied|exception|not-applicable; got '${entry}'.`);
    return {
      article,
      decision,
      ...(decision === 'satisfied' ? {} : { reason: reasons[reasonIndex++] ?? null })
    };
  });
}

async function approveCommand(positionals, options) {
  if (optionString(options, 'selection-receipt') && optionBoolean(options, 'yes')) {
    throw new SingularityFlowError('Do not combine --selection-receipt with --yes; the receipt already carries the reviewer\'s exact phase confirmation.');
  }
  const { root, config, workflow, phase, session, receipt, receiptToken } = await decisionWorkflow(positionals, options, 'approve');
  const selfApproval = (phase.generatedBy?.login ?? phase.generatedBy?.email ?? phase.generatedBy?.name) === (session.actor.login ?? session.actor.email ?? session.actor.name);
  printPhaseReview(await phaseReview(root, config, workflow, phase), { showArtifact: optionBoolean(options, 'show-artifact') });
  const approvalAuthority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,
    session.actor,
    { preferredAuthorities: remainingRequiredAuthorities(phase.approvalPolicy, phase.approvals) }
  );
  console.log(`\nReviewing ${workflow.workItem.id} / ${phase.id}`);
  console.log(`Reviewer: ${session.actor.name ?? session.actor.email ?? session.actor.login} · authority: ${approvalAuthority.authorityLabel} (${approvalAuthority.authorityGroup})`);
  console.log(`governed agent: ${session.agent} (prompt/audit context only)`);
  console.log(`Artifacts: ${phase.artifacts.map((item) => `${item.path} (${item.sha256?.slice(0, 18) ?? 'no hash'})`).join(', ')}`);
  console.log(`Checks: ${phase.checks.map((item) => `${item.command}=${item.status}`).join(', ') || 'none'}`);
  console.log(`Tokens: ${phase.usage.map((item) => item.totalTokens ?? item.status).join(', ') || 'unavailable'}`);
  console.log(`Prior approvals: ${phase.approvals.filter((item) => !item.invalidatedAt).map((item) => `${item.actor?.name ?? item.actor?.email ?? 'unknown'} via ${item.authorityGroup ?? 'unrecorded authority'}; agent ${item.agent ?? 'unavailable'} (${item.decision})`).join(', ') || 'none'}`);
  if (selfApproval) console.warn('Warning: this identity generated the phase; approval will be recorded as self-approval.');
  if (!receipt && !optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const workflowBeforeApproval = structuredClone(workflow);
  const result = await approvePhase(root, config, workflow, {
    phaseId: phase.id,
    channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : receipt ? 'copilot-selection-receipt' : 'terminal',
    actionContext: activeActionContext() ?? receipt?.approvalContext ?? null,
    checklist: await checklistDecisions(options),
    persist: false
  });
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    { type: 'phase-approved', phaseId: phase.id, generation: phase.generation, actor: result.approval.actor, agent: result.approval.agent, authorityGroup: result.approval.authorityGroup },
    `[${workflow.workItem.id}][phase:${phase.id}][approve] ${result.approval.authorityGroup}`,
    phase.artifacts.map((item) => item.path),
    { rollbackWorkflow: workflowBeforeApproval }
  );
  // Spent once the approval has actually landed. Consuming it up front — before the confirmation
  // prompt, let alone the publication — meant declining at the prompt or hitting any refusal burned
  // the reviewer's one-shot receipt, and a new one had to be issued before they could try again.
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
  console.log(publication.pushed
    ? `Approval decision committed ${publication.sha.slice(0, 8)} and pushed to ${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}.`
    : `Approval decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy} through ${result.approval.authorityGroup}; governed agent ${result.approval.agent}.`);
  if (result.approval.selfApproval) console.warn(`Warning: ${result.phase.id} was self-approved; this is not independent review.`);
  formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
  emitCommandResult(commandResult({
    operation: { id: 'approve', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('approve.succeeded', { phase: result.phase.id, next: result.next?.id ?? null }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, authorityGroup: result.approval.authorityGroup }
  }), { postState: workflow, restStateWhenIdle: result.next ? null : 'complete' });
}

async function rejectCommand(positionals, options) {
  const { root, config, workflow, phase: current, session } = await decisionWorkflow(positionals, options, 'reject');
  const target = optionString(options, 'to') ?? current.id;
  console.log(`Requesting changes to ${current.id}, returning work to ${target} as ${session.actor.name ?? session.actor.email ?? session.actor.login}; governed agent ${session.agent} is audit context only. Approvals from ${target} onward will be invalidated.`);
  // Inside the transaction: rejecting used to write workflow.json and the change-request decision
  // first and publish afterwards, so a refusal in the publication preflight reported that nothing
  // had happened while leaving every downstream approval invalidated and the decision durable and
  // unattested. `target` is resolved before the mutation, so the event needs nothing the transition
  // produces.
  const { value: phase } = await transactStory(
    root,
    config,
    workflow,
    { type: 'phase-rejected', phaseId: current.id, generation: current.generation, actor: session.actor, agent: session.agent, payload: { targetPhaseId: target.id ?? target } },
    `[${workflow.workItem.id}][phase:${current.id}][reject] return to ${target.id ?? target}`,
    (aggregate) => rejectPhase(root, config, aggregate, {
      phaseId: current.id,
      target,
      reason: optionString(options, 'reason'),
      clauseIds: optionStrings(options, 'clause'),
      members: optionStrings(options, 'member'),
      channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'terminal',
      actionContext: activeActionContext()
    })
  );
  console.log(`Recorded ${phase.changeRequest.id}. Comment: ${phase.changeRequest.comment}`);
  if (phase.changeRequest.clauseIds?.length) console.log(`Clauses requiring revision: ${phase.changeRequest.clauseIds.join(', ')}`);
  if (phase.changeRequest.members?.length) {
    console.log(`Members to regenerate: ${phase.changeRequest.members.join(', ')}`);
    console.log('Every other member must come back byte-identical; anything else that changes is reported at publication.');
  }
  formatContextBoundaryHandoff(phase.contextBoundary).forEach((line) => console.log(line));
  emitCommandResult(commandResult({
    operation: { id: 'reject', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('reject.succeeded', { phase: current.id, target: phase.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { changeRequestId: phase.changeRequest.id }
  }), { postState: workflow });
}

async function reopenCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[1];
  let config = await loadConfig(root);
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) {
    checkout(root, requestedId, {
      base: config.defaultBaseBranch,
      fetch: optionBoolean(options, 'fetch'),
      existingOnly: true,
      remote: config.git?.remote ?? 'origin'
    });
  }
  config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, requestedId);
  // Inside the transaction, like reject and cancel. Reopening used to invalidate every downstream
  // approval, write a durable `reopened` decision, invalidate the impact receipt and save
  // workflow.json *before* publishing — so a refusal in the publication preflight (an unreconciled
  // ledger is enough) reported that nothing had happened while leaving all of it on disk with no
  // commit, no event and no ledger entry. The next successful publication then swept that wreckage
  // into a commit describing something else.
  //
  // The event was what blocked this: it read values the mutation mints. Each one is resolvable
  // beforehand — the completion phase is the last phase in order, and the authority is a pure
  // function of the resolved authorities, that phase's policy, and the session actor.
  const completionPhase = workflow.phases[workflow.phaseOrder.at(-1)];
  const session = await loadSession(root);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    completionPhase.approvalPolicy,
    session.actor
  );
  const { value: result, publication } = await transactStory(
    root,
    config,
    workflow,
    {
      type: 'workflow-reopened',
      phaseId: completionPhase.id,
      generation: completionPhase.generation,
      actor: session.actor,
      agent: session.agent,
      authorityGroup: authority.authorityGroup,
      payload: { targetPhaseId: optionString(options, 'to') ?? completionPhase.id }
    },
    `[${workflow.workItem.id}][reopen:${optionString(options, 'to') ?? completionPhase.id}] change request`,
    (aggregate) => reopenWorkflow(root, config, aggregate, {
      target: optionString(options, 'to'),
      reason: optionString(options, 'reason'),
      channel: 'terminal',
      actionContext: activeActionContext()
    })
  );
  console.log(`Reopened ${workflow.workItem.id} at ${result.phase.id} with ${result.changeRequest.id}.`);
  console.log(publication.pushed
    ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
    : `Decision committed ${publication.sha.slice(0, 8)} locally.`);
}

async function cancelCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[1];
  let config = await loadConfig(root);
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) {
    checkout(root, requestedId, {
      base: config.defaultBaseBranch,
      fetch: optionBoolean(options, 'fetch'),
      existingOnly: true,
      remote: config.git?.remote ?? 'origin'
    });
  }
  config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, requestedId);
  const confirmation = optionString(options, 'confirm');
  if (confirmation !== workflow.workItem.id) {
    throw new SingularityFlowError(
      `Cancelling archives Story '${workflow.workItem.id}' and stops its lifecycle. `
      + `Re-run with --confirm ${workflow.workItem.id} after reviewing the generated artifacts.`
    );
  }
  // Cancelling runs *inside* the transaction, like every other governed mutation.
  //
  // It used to write `workflow.json` first and publish afterwards, so the rollback snapshot was
  // taken after the mutation and restored the cancellation instead of undoing it. Any refusal in the
  // publication preflight — an unreconciled ledger outbox is enough — reported that the mutation had
  // been refused while leaving the Story cancelled on disk with no commit, no event and no ledger
  // entry. Nothing could then recover it: cancel refuses an already-cancelled Story, every phase
  // command fails on a null currentPhase, and reopen only accepts a complete one.
  //
  // Every value the event needs comes from the state before the mutation, so the envelope is built
  // here and the cancellation itself happens in the transition.
  const cancelPhase = workflow.currentPhase ? workflow.phases?.[workflow.currentPhase] : null;
  if (!cancelPhase) throw new SingularityFlowError(`Story '${workflow.workItem.id}' has no active phase to cancel.`);
  const cancelSession = await loadSession(root);
  const { value: result, publication } = await transactStory(
    root,
    config,
    workflow,
    {
      type: 'work-cancelled',
      phaseId: cancelPhase.id,
      generation: cancelPhase.generation,
      actor: cancelSession.actor,
      agent: cancelSession.agent ?? null,
      payload: { reason: String(optionString(options, 'reason') ?? '').trim() }
    },
    `[${workflow.workItem.id}][cancel] archive cancelled work`,
    (aggregate) => cancelWorkflow(root, config, aggregate, {
      reason: optionString(options, 'reason'),
      channel: 'terminal',
      actionContext: activeActionContext()
    })
  );
  console.log(`Cancelled ${workflow.workItem.id} during ${result.phase.id}: ${result.cancellation.reason}`);
  console.log(`All generated artifacts and approvals remain on ${workflowPublicationBranch(root, workflow)}.`);
  console.log(publication.pushed
    ? `Cancellation committed ${publication.sha.slice(0, 8)} and pushed; the Story is now archived.`
    : `Cancellation committed ${publication.sha.slice(0, 8)} locally; the Story is now archived.`);
}

async function syncCommand() {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  const result = await syncPublication(root, config, workflow); console.log(`Pushed ${result.pushed.slice(0, 8)} to ${result.remote}/${result.branch}.`);
}

async function ledgerCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const ledger = config.ledger ?? {};
  const subcommand = positionals[1] ?? 'status';
  let result;
  if (subcommand === 'init') result = await initializeLedger(root, ledger);
  else if (subcommand === 'doctor') result = await ledgerDoctor(root, ledger);
  else if (subcommand === 'status') result = await ledgerStatus(root, ledger);
  else if (subcommand === 'verify') result = await verifyLedger(root, ledger, { offline: optionBoolean(options, 'offline') });
  else if (subcommand === 'repair') result = await repairLedgerPins(root, ledger, {
    sourceRemote: optionString(options, 'source-remote'),
    dryRun: optionBoolean(options, 'dry-run'),
    restoreRemote: optionBoolean(options, 'restore-remote'),
    confirmation: optionString(options, 'confirm')
  });
  else if (subcommand === 'reconcile') result = await reconcileLedger(root, ledger, { workId: positionals[2] ?? null });
  else if (subcommand === 'log') result = await ledgerLog(root, ledger, { limit: optionNumber(options, 'limit', 20) });
  else if (subcommand === 'show') result = await ledgerShow(root, ledger, requirePositional(positionals, 2, 'ledger hash or event ID'));
  else if (subcommand === 'archive') result = await archiveLedger(
    root,
    ledger,
    optionString(options, 'out', `singularity-ledger-${new Date().toISOString().slice(0, 10)}.bundle`),
    { sign: optionBoolean(options, 'sign') }
  );
  else if (subcommand === 'deployment-check') {
    const confirmations = {
      protectedBranch: optionBoolean(options, 'confirm-protected'),
      pushPolicy: optionBoolean(options, 'confirm-push-policy'),
      pinRetention: optionBoolean(options, 'confirm-pin-retention')
    };
    const assertsHostPolicy = Object.values(confirmations).some(Boolean);
    let confirmationContext = null;
    if (assertsHostPolicy) {
      const authority = optionString(options, 'authority');
      if (!authority) {
        throw new SingularityFlowError('Host-policy confirmations require --authority <group> so the assertion is bound to an authorized Git identity.');
      }
      const actor = identity(root);
      const matched = requireApprovalAuthority(
        config.approvalAuthorities,
        { authorities: [authority] },
        actor
      );
      confirmationContext = {
        actor,
        authorityGroup: matched.authorityGroup,
        identityAssurance: matched.identityAssurance
      };
    }
    result = await validateLedgerDeployment(root, ledger, {
      offline: optionBoolean(options, 'offline'),
      record: optionBoolean(options, 'record'),
      confirmations,
      confirmationContext
    });
  }
  else throw new SingularityFlowError(`Unknown ledger subcommand '${subcommand}'. Use init, doctor, status, log, show, verify, repair, reconcile, archive, or deployment-check.`);
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify(result, null, 2));
    // The verdict is the same whichever way it is rendered. `doctor` and `verify` are gates, and
    // returning here used to hand a pipeline exit 0 for a ledger that had just failed verification.
    if (['doctor', 'verify'].includes(subcommand) && !result.valid) process.exitCode = 2;
    if (subcommand === 'repair' && !result.dryRun && !result.valid) process.exitCode = 2;
    return;
  }
  if (subcommand === 'init') {
    console.log(result.created
      ? `Created orphan ledger branch ${result.branch} at ${result.commit.slice(0, 8)}.`
      : `Ledger branch ${result.branch} already exists at ${result.ref}.`);
    return;
  }
  if (subcommand === 'doctor') {
    result.checks.forEach((check) => console.log(`  ${style.mark(check.status)} ${check.id}: ${check.detail}`));
    if (!result.valid) throw new SingularityFlowError('Capability ledger doctor found blocking problems.', { exitCode: 2 });
    return;
  }
  if (subcommand === 'verify') {
    result.errors.forEach((message) => console.error(`  ✗ ${message}`));
    result.warnings.forEach((message) => console.warn(`  ~ ${message}`));
    if (!result.valid) throw new SingularityFlowError('Capability ledger verification failed.', { exitCode: 2 });
    console.log(`Capability ledger verified: ${result.entries} entries, sequence ${result.sequence}, trust tier ${result.trustTier}.`);
    return;
  }
  if (subcommand === 'repair') {
    console.log(`Ledger pin repair (${result.mode}${result.dryRun ? ', preview' : ''}): ${result.pins.length} pin(s), ${result.unresolved.length} unresolved.`);
    if (result.refspec.installed) console.log(`  installed ${result.refspec.refspec}`);
    result.localActions.forEach((item) => console.log(`  ${item.status} ${item.pinRef}`));
    result.restored.forEach((item) => console.log(`  restored ${item.pinRef} at ${item.commit} to ${item.remote}`));
    result.unresolved.forEach((item) => console.warn(`  unresolved ${item.pinRef}: ${item.status}`));
    if (result.dryRun && result.pins.some((item) => item.restoreCandidate)) {
      const source = result.sourceRemote ? ` --source-remote ${result.sourceRemote}` : '';
      console.log('Remote restoration is never automatic. After reviewing the exact refs and commits:');
      console.log(`  singularity-flow ledger repair --restore-remote${source} --confirm ${JSON.stringify(result.confirmation)}`);
    }
    if (!result.dryRun && !result.valid) {
      throw new SingularityFlowError('Ledger pin repair remains incomplete. Review the unresolved classifications above.', { exitCode: 2 });
    }
    return;
  }
  if (subcommand === 'status') {
    if (!result.enabled) return console.log('Capability ledger is disabled for this repository.');
    if (!result.initialized) return console.log(`Capability ledger is enabled but ${result.config.branch} has not been initialized.`);
    console.log(`Capability ledger: ${result.verification.valid ? 'verified' : 'invalid'} · sequence ${result.verification.sequence} · ${result.pending.length} pending durable intent(s) · ${result.outbox} local replay record(s).`);
    result.pending.forEach((item) => console.log(`  pending ${item.eventId} · ${item.workId} · ${item.path}`));
    return;
  }
  if (subcommand === 'reconcile') {
    console.log(`Ledger reconciliation: ${result.appended.length} appended, ${result.existing.length} already recorded, ${result.failed.length} failed.`);
    result.failed.forEach((item) => console.warn(`  pending ${item.eventId}: ${item.error}`));
    if (result.failed.length && (config.ledger?.behind ?? 'warn') === 'block') throw new SingularityFlowError('Required ledger reconciliation remains incomplete.');
    return;
  }
  if (subcommand === 'archive') {
    console.log(`Ledger archive: ${result.path}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log(`SHA-256: ${result.sha256}`);
    if (result.signaturePath) console.log(`Detached signature: ${result.signaturePath}`);
    return;
  }
  if (subcommand === 'deployment-check') {
    result.checks.forEach((check) => console.log(`  ${check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'} ${check.id}: ${check.detail}`));
    if (result.recordedPath) console.log(`Recorded deployment validation: ${result.recordedPath}`);
    if (!result.valid) throw new SingularityFlowError(`Ledger deployment is not ready for trust tier ${result.trustTier}.`, { exitCode: 2 });
    return;
  }
  if (subcommand === 'log') {
    if (!result.length) return console.log('Capability ledger is empty.');
    console.log(table(result.map((entry) => ({
      sequence: entry.transport?.recordedAt ?? '',
      hash: entry.hash.slice(0, 12),
      event: entry.eventType,
      workId: entry.subject?.workId ?? '',
      phase: entry.subject?.phase ?? '',
      actor: entry.actor?.email ?? entry.actor?.githubLogin ?? entry.actor?.name ?? ''
    })), [
      { key: 'hash', label: 'HASH' },
      { key: 'event', label: 'EVENT' },
      { key: 'workId', label: 'WORK' },
      { key: 'phase', label: 'PHASE' },
      { key: 'actor', label: 'ACTOR' }
    ]));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function capabilitiesCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'list';
  if (subcommand === 'doctor') {
    const result = await capabilityDoctor(root, {
      capabilityId: positionals[2] ?? optionString(options, 'capability'),
      offline: optionBoolean(options, 'offline')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      for (const item of result.checks) {
        console.log(`${style.mark(item.status)} ${item.id}: ${item.summary}${item.detail ? `\n  ${style.detail(item.detail)}` : ''}`);
      }
      console.log(`\n${style.fields(
        `${result.summary.passed} passed`,
        `${result.summary.warnings} warnings`,
        `${result.summary.failures} failures`
      )}`);
    }
    if (!result.valid) process.exitCode = 1;
    return;
  }
  const definition = await loadCapabilities(root, { required: true });
  const workflowConfig = await loadConfig(root);
  if (subcommand === 'list') {
    const rows = Object.entries(definition.capabilities).map(([id, capability]) => ({
      id,
      kind: capability.kind,
      parent: capability.parent ?? '—',
      owns: (capability.owns ?? []).join(', ')
    }));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(rows, null, 2));
    return console.log(table(rows, [
      { key: 'id', label: 'CAPABILITY' },
      { key: 'kind', label: 'KIND' },
      { key: 'parent', label: 'PARENT' },
      { key: 'owns', label: 'OWNS' }
    ]));
  }
  if (subcommand === 'show' || subcommand === 'resolve') {
    const capabilityId = requirePositional(positionals, 2, 'capability ID');
    const ledgerConfig = workflowConfig.ledger ?? {};
    const entries = ledgerConfig.enabled ? await ledgerLog(root, ledgerConfig, { limit: 1000000 }) : [];
    const result = resolveEffectiveCapabilityPolicy(definition, capabilityId, entries);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Capability: ${result.capabilityId}`);
    console.log(`Path: ${result.path.join(' → ')}`);
    console.log(JSON.stringify(result.policy, null, 2));
    if (result.leases.length) {
      console.warn(`Active break-glass leases: ${result.leases.length}`);
      result.leases.forEach((lease) => console.warn(`  ${lease.leaseId} expires ${lease.expiresAt} · ${lease.reason}`));
    }
    return;
  }
  if (subcommand === 'lease') {
    const action = requirePositional(positionals, 2, 'lease action');
    const capabilityId = requirePositional(positionals, 3, 'capability ID');
    const resolved = resolveCapabilityPolicy(definition, capabilityId);
    if (optionString(options, 'confirm') !== capabilityId) {
      throw new SingularityFlowError(`Break-glass changes require exact confirmation. Re-run with --confirm ${capabilityId}.`);
    }
    const requiredGroups = resolved.policy.requiredAuthorityGroups ?? [];
    const authority = optionString(options, 'authority', requiredGroups[0] ?? Object.keys(workflowConfig.approvalAuthorities ?? {})[0]);
    const matched = requireApprovalAuthority(workflowConfig.approvalAuthorities, { authorities: [authority] }, identity(root));
    const ledgerConfig = workflowConfig.ledger ?? {};
    if (!ledgerConfig.enabled) throw new SingularityFlowError('Capability leases require the capability ledger to be enabled.');
    let intent;
    if (action === 'grant') {
      const expiresAt = optionString(options, 'expires');
      if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
        throw new SingularityFlowError('Lease grant requires --expires with a future ISO timestamp.');
      }
      const reason = optionString(options, 'reason');
      if (!reason) throw new SingularityFlowError('Lease grant requires --reason.');
      const policyInput = optionString(options, 'policy');
      if (!policyInput) throw new SingularityFlowError('Lease grant requires --policy with inline JSON/YAML or a file path.');
      let relaxation;
      if (policyInput.trim().startsWith('{')) relaxation = JSON.parse(policyInput);
      else {
        const candidate = path.resolve(root, policyInput);
        relaxation = YAML.parse(await readFile(candidate, 'utf8'));
      }
      // Validate keys and values without folding the relaxation into the monotone base.
      resolveEffectiveCapabilityPolicy({
        version: 1,
        capabilities: { temporary: { kind: 'lease', policy: relaxation } }
      }, 'temporary');
      intent = createLedgerIntent({
        eventType: 'capability-lease-granted',
        capabilityId,
        subject: { workId: `capability:${capabilityId}`, phase: null, generation: null, branch: branch(root) },
        actor: identity(root),
        authorityGroup: matched.authorityGroup,
        identityAssurance: matched.identityAssurance,
        payload: { expiresAt: new Date(expiresAt).toISOString(), reason, relaxation }
      });
      intent.payload.leaseId = intent.eventId;
      intent.subject.generation = intent.eventId;
    } else if (action === 'revoke') {
      const leaseId = requirePositional(positionals, 4, 'lease ID');
      const reason = optionString(options, 'reason');
      if (!reason) throw new SingularityFlowError('Lease revocation requires --reason.');
      intent = createLedgerIntent({
        eventType: 'capability-lease-revoked',
        capabilityId,
        subject: { workId: `capability:${capabilityId}`, phase: null, generation: null, branch: branch(root) },
        actor: identity(root),
        authorityGroup: matched.authorityGroup,
        identityAssurance: matched.identityAssurance,
        payload: { leaseId, reason }
      });
      intent.subject.generation = intent.eventId;
    } else throw new SingularityFlowError(`Unknown lease action '${action}'. Use grant or revoke.`);
    const result = await appendLedgerIntent(root, ledgerConfig, intent, head(root));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ intent, result }, null, 2));
    console.log(`${action === 'grant' ? 'Granted' : 'Revoked'} capability lease ${intent.payload.leaseId} at ledger sequence ${result.sequence}.`);
    return;
  }
  throw new SingularityFlowError(`Unknown capabilities subcommand '${subcommand}'. Use list, show, doctor, or lease.`);
}

// Read the machine-local activity log. The log lives under .git/ so it is never committed, which
// also means nobody finds it by browsing the repository — this is how it is meant to be read.
async function logsCommand(positionals, options) {
  if (positionals[1] === 'workspace') {
    const report = await collectWorkspaceLogs({
      source: optionString(options, 'source', 'all'),
      repository: optionString(options, 'repository'),
      workId: optionString(options, 'work-id'),
      phase: optionString(options, 'phase'),
      agent: optionString(options, 'agent'),
      level: optionString(options, 'level'),
      since: optionString(options, 'since'),
      text: optionString(options, 'text'),
      limit: optionNumber(options, 'limit', 500)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(report, null, 2));
    console.log(`Workspace logs — ${report.workspace.id}`);
    console.log(`${report.entries.length} of ${report.total} matching entries · newest first`);
    for (const item of report.entries) {
      console.log(`${item.timestamp ?? '(no timestamp)'}  ${item.severity.toUpperCase().padEnd(5)}  ${item.source.padEnd(9)}  ${item.repositoryId ?? 'workspace'}  ${item.summary}`);
    }
    for (const warning of report.warnings) console.error(`Warning: ${warning}`);
    return;
  }
  const root = repoRoot();
  const file = logFilePath(gitDir(root));
  if (positionals[1] === 'path') return console.log(file);

  if (positionals[1] === 'level') {
    const config = await loadConfig(root).catch(() => null);
    const resolved = resolveLogging(config);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...resolved, file }));
    console.log(`Log file : ${file}`);
    console.log(`File level    : ${resolved.level}`);
    console.log(`Console level : ${resolved.console}`);
    console.log('Raise either for one command with SINGULARITY_FLOW_LOG_LEVEL=all or SINGULARITY_FLOW_LOG_CONSOLE=debug.');
    return;
  }

  if (!existsSync(file)) {
    console.log(`No activity log yet at ${file}.`);
    console.log('It is written as commands run. Set SINGULARITY_FLOW_LOG_LEVEL=all to capture everything.');
    return;
  }

  const entries = filterLogEntries(parseLogLines(await readFile(file, 'utf8')), {
    level: normalizeLogLevel(optionString(options, 'level') ?? 'trace', 'trace'),
    event: optionString(options, 'event'),
    since: optionString(options, 'since')
  });
  const limit = Number.parseInt(optionString(options, 'tail') ?? '80', 10);
  const shown = Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries;

  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(shown, null, 2));
  if (!shown.length) {
    console.log('No matching log entries. Widen with --level all, drop --event, or extend --since.');
    return;
  }
  for (const entry of shown) {
    const context = { ...entry };
    for (const key of ['ts', 'level', 'event', 'msg']) delete context[key];
    const detail = Object.keys(context).length ? `  ${JSON.stringify(context)}` : '';
    console.log(`${entry.ts ?? '(no timestamp)'}  ${String(entry.level ?? '?').toUpperCase().padEnd(5)}  ${entry.event ?? ''}${entry.msg ? `  ${entry.msg}` : ''}${detail}`);
  }
  const counts = shown.reduce((totals, entry) => ({ ...totals, [entry.level]: (totals[entry.level] ?? 0) + 1 }), {});
  console.log(`\n${shown.length} of ${entries.length} matching entries · ${Object.entries(counts).map(([level, count]) => `${level} ${count}`).join(' · ')}`);
  console.log(`Log file: ${file}`);
}

async function doctorCommand(positionals, options) {
  if (optionString(options, 'fix') === 'telemetry') {
    return telemetryCommand(['telemetry', 'enable'], options);
  }
  const root = repoRoot();
  const report = await doctorSnapshot(root, {
    workId: positionals[1],
    offline: optionBoolean(options, 'offline'),
    performance: optionBoolean(options, 'performance')
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(doctorText(report));
  if (!report.healthy) process.exitCode = 2;
}

async function reviewCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  const bundle = await createReviewBundle(root, config, workflow, selectedPhaseArgument(positionals, options, 'review'));
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError('Review format must be md, html, or json.');
  const rendered = format === 'json' ? `${JSON.stringify(bundle, null, 2)}\n` : format === 'html' ? reviewHtml(bundle) : reviewMarkdown(bundle);
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = path.resolve(root, outputFile); await writeText(absolute, rendered); console.log(`Review bundle written to ${absolute}`); return;
  }
  // Same rule as `report`: stdout is the default because piping it is the common case and the
  // extension depends on it. `--brief` describes the bundle instead of printing it.
  if (optionBoolean(options, 'brief') && format !== 'json') {
    return console.log(summariseRendered(rendered, `review bundle for ${workflow.workItem.id}`));
  }
  process.stdout.write(rendered);
}

async function receiptCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'show';
  if (subcommand !== 'show') throw new SingularityFlowError("receipt supports only 'show'.");
  const root = repoRoot();
  const config = await loadConfig(root);
  const workId = positionals[2] ?? optionString(options, 'work-id');
  const workflow = await loadStoryAggregate(root, config, workId);
  const packet = await readStoryReviewPacket(root, config, workflow, optionString(options, 'packet'));
  const receipt = await composeEvidenceReceipt(root, config, workflow, packet);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(receipt, null, 2));
  if (optionBoolean(options, 'markdown')) return console.log(renderEvidenceReceiptMarkdown(receipt));
  console.log(renderEvidenceReceipt(receipt));
}

async function workflowCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'workflow subcommand'); const root = repoRoot();
  if (subcommand === 'list') {
    const catalog = (await workflowCatalog(root)).map((item) => ({ ...item, governs: 'story' }));
    // Initiative workflows are the same shape — a label and an ordered list of phases — and were
    // only ever listed separately because they are stored in a different file under a different
    // name. That is a fact about the storage, not about the thing.
    const initiatives = (await listWorkflows(root, 'initiative').catch(() => []))
      .map((workflow) => ({ ...workflow, status: 'current' }));
    const both = [...catalog, ...initiatives];
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(both, null, 2));
    return console.log(table(both.map((item) => ({
      id: item.id, label: item.label, governs: item.governs, phases: item.phases.length, status: item.status
    })), [
      { key: 'id', label: 'WORKFLOW' }, { key: 'label', label: 'LABEL' },
      { key: 'governs', label: 'GOVERNS' }, { key: 'phases', label: 'PHASES' },
      { key: 'status', label: 'STATUS' }
    ]));
  }

  // Authoring, folded in rather than given a noun of its own. `add` already means "install a
  // packaged workflow", so creating one from phases you choose is `create`.
  if (['create', 'edit'].includes(subcommand)) {
    const id = requirePositional(positionals, 2, 'workflow ID');
    const list = (option) => (optionString(options, option) ?? '')
      .split(',').map((entry) => entry.trim()).filter(Boolean);
    if (subcommand === 'create') {
      const created = await defineWorkflow(root, id, {
        label: optionString(options, 'label'),
        description: optionString(options, 'description', ''),
        phases: list('phases'),
        governs: optionString(options, 'governs')
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(created, null, 2));
      console.log(`Created ${created.governs} workflow ${created.workflowId}: ${created.phases.join(' \u2192 ')}`);
      return console.log(`  ${created.path} — commit it to put the workflow under governance.`);
    }
    const changes = {};
    for (const field of ['label', 'description']) {
      const value = optionString(options, field);
      if (value != null) changes[field] = value;
    }
    if (optionString(options, 'phases') != null) changes.phases = list('phases');
    const edited = await editWorkflow(root, id, changes);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(edited, null, 2));
    return console.log(`Updated ${edited.governs} workflow ${edited.workflowId} in ${edited.path}.`);
  }

  if (subcommand === 'phase') {
    const action = positionals[2];
    if (action === 'output') {
      const outputAction = positionals[3];
      if (!['add', 'edit'].includes(outputAction)) throw new SingularityFlowError('Use workflow phase output add|edit.');
      const phaseId = requirePositional(positionals, 4, 'phase ID');
      const outputId = requirePositional(positionals, 5, 'output ID');
      const list = (option) => (optionString(options, option) ?? '')
        .split(',').map((entry) => entry.trim()).filter(Boolean);
      const changes = {};
      for (const field of ['label', 'kind', 'path', 'template']) {
        if (optionString(options, field) != null) changes[field] = optionString(options, field);
      }
      if (optionString(options, 'consumes') != null) changes.consumes = list('consumes');
      if (options.optional !== undefined) changes.required = !optionBoolean(options, 'optional');
      const result = await upsertPhaseOutput(root, phaseId, outputId, changes, {
        action: outputAction,
        governs: optionString(options, 'governs', 'initiative')
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      return console.log(`${outputAction === 'add' ? 'Added' : 'Updated'} output ${result.phaseId}/${result.outputId} in ${result.path}.`);
    }
    const id = requirePositional(positionals, 3, 'phase ID');
    const list = (option) => (optionString(options, option) ?? '')
      .split(',').map((entry) => entry.trim()).filter(Boolean);
    if (action === 'add') {
      const created = await addPhase(root, id, {
        label: optionString(options, 'label'),
        worldModelViews: list('views'),
        lanes: list('lanes'),
        agents: list('agents'),
        approvalAuthorities: list('authorities'),
        approvalMinimum: optionNumber(options, 'minimum') ?? 1,
        governs: optionString(options, 'governs', 'initiative')
      });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(created, null, 2));
      console.log(`Created ${created.governs} phase ${created.phaseId} in ${created.path}.`);
      if (created.template) console.log(`  Starter template: ${created.template}`);
      return console.log('  It runs nowhere until a workflow lists it: singularity-flow workflow edit <ID> --phases a,b,c');
    }
    if (action === 'edit') {
      const changes = {};
      if (optionString(options, 'label') != null) changes.label = optionString(options, 'label');
      if (optionString(options, 'views') != null) changes.worldModelViews = list('views');
      if (optionString(options, 'lanes') != null) changes.lanes = list('lanes');
      if (optionString(options, 'agents') != null) changes.agents = list('agents');
      const edited = await editPhase(root, id, changes, { governs: optionString(options, 'governs') });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(edited, null, 2));
      console.log(`Updated phase ${edited.phaseId} in ${edited.path}.`);
      if (edited.usedBy.length) console.log(`  This changes ${edited.usedBy.join(', ')}, which run it.`);
      return;
    }
    throw new SingularityFlowError('Use workflow phase add|edit.');
  }
  if (subcommand === 'simulate') {
    const result = await simulateWorkflow(root, positionals[2]);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2)); else process.stdout.write(simulationText(result));
    return;
  }
  if (subcommand === 'diff') {
    const result = await workflowDiff(root, requirePositional(positionals, 2, 'workflow type'));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(result.equal ? `Workflow '${result.id}' matches the bundled profile.` : `Workflow '${result.id}' differs from the bundled profile.`);
    if (!result.equal) process.stdout.write(`\n--- INSTALLED ---\n${YAML.stringify(result.installed)}\n--- BUNDLED ---\n${YAML.stringify(result.bundled)}`);
    return;
  }
  // `install` is what this does — it copies a packaged workflow into the repository. `add` and
  // `upgrade` are what it was called, kept working because repositories and scripts use them.
  if (['install', 'add', 'upgrade'].includes(subcommand)) {
    const id = requirePositional(positionals, 2, 'workflow type');
    const result = await installWorkflow(root, id, { replace: optionBoolean(options, 'replace'), dryRun: optionBoolean(options, 'dry-run') });
    console.log(`${result.dryRun ? 'Would update' : 'Updated'} workflow '${id}':`); result.files.forEach((file) => console.log(`  ${file}`));
    if (!result.dryRun) console.log('Changes are validated but uncommitted. Review them, then publish through the VS Code extension or commit them through your normal configuration-review path.');
    return;
  }
  throw new SingularityFlowError(`Unknown workflow subcommand: ${subcommand}`);
}

async function assignCommand(positionals) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config);
  const phaseId = requirePositional(positionals, 1, 'phase'); const assignee = requirePositional(positionals, 2, 'assignee'); const session = await loadSession(root);
  const { value: record, publication: result } = await transactStory(
    root,
    config,
    workflow,
    { type: 'configuration-changed', phaseId, payload: { assignee } },
    `[${workflow.workItem.id}][phase:${phaseId}][assign] ${assignee}`,
    (aggregate) => assignPhase(aggregate, phaseId, assignee, session)
  );
  console.log(`Assigned ${phaseId} to ${record.assignee}. Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
}

async function watchCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config, positionals[1]);
  const once = optionBoolean(options, 'once') || !output.isTTY; const interval = Math.max(2, optionNumber(options, 'interval', 15));
  let previous = '';
  do {
    if (optionBoolean(options, 'fetch') && branch(root) === workflow.workItem.branch && hasUpstream(root) && !changes(root).trim()) { fetchOrigin(root); pullFastForward(root); }
    const fresh = await loadStoryAggregate(root, config, workflow.workItem.id); const snapshot = watchSnapshot(fresh); const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) {
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, 2)); else process.stdout.write(watchText(snapshot));
      previous = serialized;
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  } while (true);
}

async function recoverCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config, positionals[1]);
  const plan = await recoveryPlan(root, config, workflow, { fetch: optionBoolean(options, 'fetch') });
  const result = optionBoolean(options, 'apply') ? await applyRecovery(root, config, workflow, plan) : plan;
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2)); else process.stdout.write(recoveryText(result));
}

async function configuredFaultPolicy(root, { failClosed = false, story = null, faultId = null } = {}) {
  const fault = faultId ? await readFault(root, faultId) : null;
  return governedFaultRepairPolicy(root, { story: story ?? fault?.story ?? null, failClosed });
}

function emitFaultRepairResult({
  operationId, classification, messageId, slots, data, changed = false, filesChanged = false,
  commands = [], restState = null, json = false
}) {
  const next = commands.map((command, index) => narrationAction({
    id: `${operationId}.next.${index + 1}`,
    label: command.label,
    command: command.command,
    rank: index === 0 ? 'NOW' : 'SOON',
    kind: command.kind ?? 'remediation',
    modelPolicy: 'never'
  }));
  return emitCommandResult(commandResult({
    operation: { id: operationId, classification },
    subject: null,
    outcome: succeeded(messageId, slots),
    effects: changed ? effects({ stateChanged: true, filesChanged }) : noEffects(),
    next,
    restState: next.length ? null : restState ?? 'informational',
    data
  }), { json });
}

async function faultCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'list';
  if (subcommand === 'report') {
    let envelope;
    const sourceFile = optionString(options, 'from');
    if (sourceFile) envelope = JSON.parse(await readFile(path.resolve(sourceFile), 'utf8'));
    else {
      const exitCode = optionNumber(options, 'exit-code');
      const commandArgvOption = optionString(options, 'command-argv');
      const commandArgv = commandArgvOption == null
        ? null
        : parseVerificationArgv(commandArgvOption, '--command-argv');
      envelope = {
        source: optionString(options, 'source', 'manual'),
        correlationId: optionString(options, 'correlation-id'),
        occurredAt: optionString(options, 'occurred-at'),
        environment: optionString(options, 'environment', 'local'),
        severity: optionString(options, 'severity', 'medium'),
        story: optionString(options, 'story') ?? optionString(options, 'work-id'),
        capability: optionString(options, 'capability'),
        build: { id: optionString(options, 'build'), commit: optionString(options, 'commit') },
        failure: {
          type: optionString(options, 'type', 'unknown'), command: optionString(options, 'command'), commandArgv,
          exitCode, message: optionString(options, 'message')
        },
        evidence: optionStrings(options, 'log').map((localPath) => ({ type: 'log', localPath, mediaType: 'text/plain' })),
        requestedAction: optionString(options, 'requested-action', 'policy-decides'),
        idempotencyKey: optionString(options, 'idempotency-key')
      };
    }
    const result = await reportFault(root, envelope, {
      policy: await configuredFaultPolicy(root, { story: envelope.story ?? null })
    });
    return emitFaultRepairResult({
      operationId: 'fault.report', classification: 'mutation', messageId: 'fault.recorded',
      slots: { faultId: result.fault.faultId, type: result.fault.failure.type, severity: result.fault.severity },
      data: result, changed: result.created, json: optionBoolean(options, 'json'),
      commands: [{ label: 'Diagnose this fault', command: `singularity-flow fix ${result.fault.faultId} --diagnose-only` }]
    });
  }
  if (subcommand === 'list') {
    const faults = await listFaults(root, { status: optionString(options, 'status'), limit: optionNumber(options, 'limit') });
    return emitFaultRepairResult({
      operationId: 'fault.list', classification: 'read', messageId: 'fault.listed',
      slots: { count: faults.length }, data: { faults }, json: optionBoolean(options, 'json'),
      commands: faults.length ? [{ label: 'Inspect the newest fault', command: `singularity-flow fault show ${faults[0].faultId}` }] : []
    });
  }
  if (subcommand === 'show') {
    const fault = await readFault(root, requirePositional(positionals, 2, 'Fault ID', 'fault show'));
    return emitFaultRepairResult({
      operationId: 'fault.show', classification: 'read', messageId: 'fault.returned',
      slots: { faultId: fault.faultId, disposition: (await listFaults(root)).find((entry) => entry.faultId === fault.faultId)?.disposition ?? 'recorded' },
      data: { fault }, json: optionBoolean(options, 'json'),
      commands: [{ label: 'Diagnose this fault', command: `singularity-flow fix ${fault.faultId} --diagnose-only` }]
    });
  }
  throw new SingularityFlowError(`Unknown fault subcommand '${subcommand}'. Use report, list, or show.`);
}

function renderRepair(state) {
  console.log(`Repair ${state.repairId} · ${state.status}`);
  console.log(`Fault: ${state.faultId} · Baseline: ${state.baseline}`);
  console.log(`Policy: ${state.executionMode} · Attempts: ${state.attempts.length}/${state.plan.budgets.maxAttempts}`);
  console.log(`Scope: ${state.plan.allowedPaths.length ? state.plan.allowedPaths.join(', ') : 'not yet bounded'}`);
  console.log(`Verification: ${state.plan.verification.length ? state.plan.verification.map((entry) => entry.argv.join(' ')).join(' | ') : 'not yet pinned'}`);
  if (state.workspace) console.log(`Isolated branch: ${state.workspace.branch} · ${state.workspace.path}`);
  if (state.stopReason) console.log(`Reason: ${state.stopReason}`);
  for (const command of repairNextActions(state)) console.log(`Next CLI step: ${command}`);
  if (repairNextActions(state).length) console.log(`In Copilot: /sf-fix ${state.faultId}`);
}

async function fixCommand(positionals, options) {
  const root = repoRoot();
  const faultId = requirePositional(positionals, 1, 'Fault ID', 'fix');
  if (optionBoolean(options, 'diagnose-only') && optionBoolean(options, 'plan-only')) {
    throw new SingularityFlowError('Choose either --diagnose-only or --plan-only.');
  }
  if (optionBoolean(options, 'diagnose-only')) {
    const diagnosis = await diagnoseFault(root, faultId);
    return emitFaultRepairResult({
      operationId: 'fix.diagnose', classification: 'mutation', messageId: 'repair.diagnosed',
      slots: { faultId, disposition: diagnosis.disposition }, data: { diagnosis }, changed: true,
      json: optionBoolean(options, 'json'),
      commands: [{ label: 'Preview a bounded repair plan', command: `singularity-flow fix ${faultId} --plan-only --allow-path <PATH> --verify <COMMAND>` }]
    });
  }
  const verification = [
    ...optionStrings(options, 'verify'),
    ...optionStrings(options, 'verify-argv').map((value, index) =>
      parseVerificationArgv(value, `--verify-argv value ${index + 1}`))
  ];
  const result = await requestRepair(root, faultId, {
    mode: optionBoolean(options, 'auto') ? 'bounded-auto' : 'policy-decides',
    maxAttempts: optionNumber(options, 'max-attempts'),
    allowedPaths: optionStrings(options, 'allow-path'),
    verification,
    policy: await configuredFaultPolicy(root, { failClosed: true, faultId }),
    executionEnvironment: 'local',
    persist: !optionBoolean(options, 'plan-only')
  });
  const preview = optionBoolean(options, 'plan-only');
  return emitFaultRepairResult({
    operationId: preview ? 'fix.preview' : 'fix.request', classification: preview ? 'read' : 'mutation',
    messageId: 'repair.planned',
    slots: { repairId: result.repair.repairId, status: result.repair.status, preview },
    data: result, changed: !preview, json: optionBoolean(options, 'json'),
    commands: preview
      ? [{
          label: 'Create this governed repair',
          command: [
            'singularity-flow', 'fix', faultId,
            ...(result.plan.requestedMode === 'bounded-auto' ? ['--auto'] : []),
            '--max-attempts', String(result.plan.budgets.maxAttempts),
            ...result.plan.allowedPaths.flatMap((entry) => ['--allow-path', entry]),
            ...result.plan.verification.flatMap((entry) => ['--verify-argv', JSON.stringify(entry.argv)])
          ].map((entry) => JSON.stringify(entry)).join(' ')
        }]
      : repairNextActions(result.repair).map((command) => ({ label: 'Continue the governed repair', command }))
  });
}

async function repairCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'list';
  let result;
  if (subcommand === 'list') result = { schemaVersion: 1, repairs: await listRepairs(root, { status: optionString(options, 'status') }) };
  else {
    const repairId = requirePositional(positionals, 2, 'Repair ID', `repair ${subcommand}`);
    if (subcommand === 'status') result = await readRepair(root, repairId);
    else if (subcommand === 'authorize') result = await authorizeRepair(root, repairId, {
      confirmation: optionString(options, 'confirm'), open: optionBoolean(options, 'open')
    });
    else if (subcommand === 'attempt') result = await attemptRepair(root, repairId, { patchFile: optionString(options, 'patch') });
    else if (subcommand === 'cancel') result = await cancelRepair(root, repairId, { reason: optionString(options, 'reason') });
    else throw new SingularityFlowError(`Unknown repair subcommand '${subcommand}'. Use list, status, authorize, attempt, or cancel.`);
  }
  const state = subcommand === 'list' ? null : result.repair ?? result;
  const read = ['list', 'status'].includes(subcommand);
  const messageId = subcommand === 'list' ? 'repair.listed'
    : subcommand === 'status' ? 'repair.returned'
      : subcommand === 'authorize' ? 'repair.authorized'
        : subcommand === 'attempt' ? 'repair.attempted' : 'repair.cancelled';
  const commands = state ? repairNextActions(state).map((command) => ({ label: 'Continue the governed repair', command })) : [];
  return emitFaultRepairResult({
    operationId: `repair.${subcommand}`, classification: read ? 'read' : 'mutation', messageId,
    slots: subcommand === 'list' ? { count: result.repairs.length }
      : { repairId: state.repairId, status: state.status },
    data: result, changed: !read, filesChanged: ['authorize', 'attempt'].includes(subcommand),
    commands, restState: state?.status === 'cancelled' ? 'cancelled'
      : state?.status === 'resolved' ? 'complete' : 'informational',
    json: optionBoolean(options, 'json')
  });
}

async function runCommand(positionals, options) {
  const root = repoRoot();
  if (optionBoolean(options, 'repair-on-fault')) {
    const command = positionals.slice(1);
    const result = await wrapCommandWithFaultRepair(root, command, {
      source: optionString(options, 'source', 'cli-run'),
      environment: optionString(options, 'environment', 'local'),
      severity: optionString(options, 'severity', 'medium'),
      type: optionString(options, 'type'),
      maxAttempts: optionNumber(options, 'max-attempts'),
      allowedPaths: optionStrings(options, 'allow-path'),
      idempotencyKey: optionString(options, 'idempotency-key'),
      policy: await configuredFaultPolicy(root, { failClosed: true }),
      echo: !optionBoolean(options, 'json')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, ...result }, null, 2));
    else if (!result.fault) console.log('Command passed; no fault was recorded.');
    else {
      console.log(`\nRecorded ${result.fault.faultId}; command exited ${result.exitCode}.`);
      if (result.nested) console.log(`The fault was attached to repair ${process.env.SINGULARITY_FLOW_REPAIR_ID}; no recursive repair was created.`);
      else if (result.repair) renderRepair(result.repair);
    }
    process.exitCode = result.exitCode;
    return result;
  }
  const config = await loadConfig(root); const workflow = await loadStoryAggregate(root, config); const phase = currentPhase(workflow);
  if (!phase) { console.log('Workflow is complete. Running the final governance gate.'); return gateCommand({ terminal: true }); }
  if (phase.status === 'awaiting_approval') {
    console.log(`Guided run stopped: '${phase.id}' is awaiting human review and approval.`);
    console.log(`Run: singularity-flow review ${phase.id}`);
    console.log(`In Copilot: /sf-review ${phase.id}`);
    console.log(`Run: singularity-flow approve ${phase.id} --work-id ${workflow.workItem.id} --fetch`);
    console.log(`In Copilot: /sf-approve ${phase.id}`);
    return;
  }
  if (phaseNeedsGeneration(workflow, phase)) {
    await nextCommand(options);
    console.log(`Guided run stopped at the authoring boundary. Complete ${phase.requiredArtifact.path}.`);
    console.log(`Run: singularity-flow phase publish ${phase.id}`);
    console.log(`In Copilot: /sf-phase ${phase.id}`);
    return;
  }
  const submit = optionBoolean(options, 'yes') || await confirmYesNo(`Generation ${phase.generation} is published. Submit '${phase.id}' for approval?`);
  if (!submit) {
    console.log('No state changed.');
    console.log(`Run: singularity-flow submit ${phase.id}`);
    console.log(`In Copilot: /sf-submit ${phase.id}`);
    return;
  }
  await submitCommand(['submit', phase.id], options);
  console.log(`Run: singularity-flow review ${phase.id}`);
  console.log(`Guided run stopped at the approval boundary. In Copilot: /sf-review ${phase.id}`);
}

async function cockpitCommand() {
  const root = repoRoot();
  if (!existsSync(path.join(root, WORKFLOW_PATH)) && !existsSync(path.join(root, 'singularity/config.json'))) {
    // The bare command in an uninitialised repository is, for most people, their first contact with
    // the product. It said what was absent and gave one command, with no way to find out what any of
    // it means or to see it work before committing a real repository to it.
    console.log(style.heading('Singularity Flow is not set up in this repository.'));
    const entries = [
      ['singularity-flow quickstart', [
        'See one complete governed change in a throwaway repository.',
        'About 8 seconds, offline, and nothing here is touched.'
      ]],
      ['singularity-flow init', ['Set this repository up.']],
      ['singularity-flow --help', ['What the other commands do.']]
    ];
    const column = Math.max(...entries.map(([command]) => command.length));
    for (const [command, lines] of entries) {
      console.log(`\n  ${style.action(command.padEnd(column))}  ${lines[0]}`);
      for (const line of lines.slice(1)) console.log(`  ${' '.repeat(column)}  ${style.detail(line)}`);
    }
    return;
  }
  const config = await loadConfig(root); let workflow;
  try { workflow = await loadStoryAggregate(root, config); }
  catch {
    console.log(`Singularity Flow cockpit\nRepository: ${root}\nBranch: ${branch(root)}\n\nNo work item is active on this branch.`);
    console.log('Start: singularity-flow start <WORK-ID>\nResume: singularity-flow resume <WORK-ID> --fetch\nDiagnostics: singularity-flow doctor'); return;
  }
  const progress = progressSnapshot(workflow); const session = await loadSession(root, { required: false }); const active = currentPhase(workflow);
  console.log(`Singularity Flow cockpit — ${workflow.workItem.id}`);
  console.log(`${progressBar(progress.percentage)} ${progress.percentage}% · ${progress.approvedPhases}/${progress.totalPhases} phases`);
  console.log(`governed agent: ${session?.workId === workflow.workItem.id ? session.agent : 'not selected'} · Branch: ${workflow.workItem.branch}`);
  console.log(`Current: ${active ? `${active.label} (${active.status})` : 'workflow complete'}`);
  console.log(`Assignment: ${active ? workflow.collaboration?.assignments?.[active.id]?.assignee ?? 'unassigned' : 'none'}`);
  console.log('\nNext actions:');
  const prerequisites = active && workflow.resolution?.collaboration?.assignmentMode !== 'off' && !workflow.collaboration?.assignments?.[active.id]
    ? [{ timing: workflow.resolution.collaboration.assignmentMode === 'required' ? 'now' : 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who coordinates '${active.id}' for cross-terminal handoff.` }]
    : [];
  process.stdout.write(nextStepsText(nextStepsSnapshot({ branch: branch(root), workflow, publicationPending: await storyPublicationPending(root, config, workflow.workItem.id), prerequisites })));
  try {
    const ledger = await ledgerStatus(root, workflow.resolution?.ledger ?? config.ledger ?? {});
    if (ledger.enabled) {
      const health = !ledger.initialized
        ? 'not initialized'
        : ledger.verification?.valid
          ? 'verified'
          : 'invalid';
      console.log(`\nCapability ledger: ${health} · pending ${ledger.pending?.length ?? 0} · local outbox ${ledger.outbox ?? 0}`);
    }
  } catch (error) {
    console.warn(`\nCapability ledger: unavailable (${error?.message ?? String(error)})`);
  }
  console.log('\nUseful views: singularity-flow progress · review · documents list · report · doctor');
}

// The world-model builder runs Copilot inside an isolated, throwaway worktree (a temp directory
// named `singularity-flow-world-model-*`) so it can inspect the repository and write the grounding
// files. That session is a trusted system operation, not contributor Story work: it has no work/Jira
// ID and can never acquire one. A repository may opt into the retained custom session-gate hook;
// without this exemption that hook would deny every file write the builder's Copilot attempts.
// Detect the builder's own worktree (by path, which is deterministic, or by the env marker the
// builder sets) and let its tools through. The bundled plugin itself is advisory and registers no
// preToolUse guard.
export function isWorldModelBuildContext(root, payload) {
  if (process.env.SINGULARITY_FLOW_WORLD_MODEL_BUILD === '1') return true;
  // The builder's isolated worktree is always `<tmp>/singularity-flow-world-model-<id>/repository`
  // (or `…-branch-<id>/repository`). Require the `repository` segment to sit under a matching prefix
  // segment so an unrelated user file that merely starts with that name is never exempted.
  const isBuilderWorktree = (value) => {
    const segments = value.split(path.sep);
    return segments.some((segment, index) =>
      segment.startsWith('singularity-flow-world-model-') && segments[index + 1] === 'repository');
  };
  const paths = [root, typeof payload?.cwd === 'string' ? payload.cwd : null].filter(Boolean);
  return paths.some(isBuilderWorktree);
}

const HOOK_EVENTS = ['turn-intent', 'turn-end', 'agent-start', 'session-start', 'agent-guard'];

async function hookCommand(positionals) {
  const event = requirePositional(positionals, 1, 'hook event');
  // Checked before the catch-all below. Swallowing runtime failures is deliberate — a hook must
  // never break the host turn that invoked it — but it also swallowed `hook install`, a name the
  // documentation told people to type, answering `{}` with exit 0. An unrecognised event is a
  // caller mistake, not a runtime failure, and there is no host turn to protect yet.
  if (!HOOK_EVENTS.includes(event)) {
    throw new SingularityFlowError(`Unknown hook event '${event}'. Use ${HOOK_EVENTS.join(', ')}.`);
  }
  let payload = {};
  try { payload = JSON.parse(await stdinText() || '{}'); } catch { payload = {}; }
  try {
    const candidate = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : process.cwd();
    const root = repoRoot(candidate);
    if (isWorldModelBuildContext(root, payload)) return console.log('{}');
    const authority = sessionRepositoryAuthority(root);
    if (!authority) return console.log('{}');
    if (event === 'turn-intent') {
      const { recordCopilotTurnIntent } = await import('./session.mjs');
      return console.log(JSON.stringify(await recordCopilotTurnIntent(root, payload)));
    }
    if (event === 'turn-end') {
      const { clearCopilotTurnIntent } = await import('./session.mjs');
      await clearCopilotTurnIntent(root, payload.sessionId ?? payload.session_id ?? null);
      return console.log('{}');
    }
    if (event === 'agent-start') return console.log(JSON.stringify(await copilotAgentStartHook(root, payload)));
    const { definition: config } = await sessionDiscoveryConfiguration(root, authority); let workflow = null;
    if (existsSync(path.join(root, WORKFLOW_PATH))) {
      try { workflow = await loadStoryAggregate(root, config); } catch { workflow = null; }
    }
    if (event === 'session-start') return console.log(JSON.stringify(await sessionStartAgentHook(root, config, workflow, payload)));
    if (event === 'agent-guard') return console.log(JSON.stringify(await agentGuardHook(root, config, workflow, payload)));
  } catch { console.log('{}'); }
}

/**
 * Which repository a session command is about. `[session]`
 *
 * The working directory is asked first and always wins when it is a governed repository: a person
 * standing in one clone must never be answered about another, however recently they selected it.
 *
 * When the working directory is not a governed repository, the active workspace selection answers
 * instead. That selection is an explicit act — someone chose this workspace and this repository —
 * and it already records the absolute path. Copilot does not run with its working directory inside
 * the clone, so without this fallback `session status` reported `initialized: false` and the only
 * remedy on offer was to reopen the editor somewhere else. The repository was known the whole time.
 *
 * The caller is always told which of the two answered, because the same JSON otherwise describes
 * two materially different situations.
 */
function sessionRepositoryRemotes(root) {
  const names = run('git', ['remote'], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  return [...new Set(['origin', ...names].filter((name) => names.includes(name)))];
}

function definitionAtRef(root, ref) {
  const source = fileAtRef(root, ref, WORKFLOW_PATH);
  if (source == null) return null;
  const definition = YAML.parse(source);
  validateDefinition(definition);
  return definition;
}

/**
 * A production bootstrap keeps approved configuration on `sflow/config`, not application `main`.
 * Treat the remote authority (or an already-published lifecycle branch carrying its snapshot) as
 * proof that the checkout is governed; requiring a working-tree copy made every fresh clone look
 * uninitialised until somebody manually checked out the Story branch.
 */
function sessionRepositoryAuthority(root) {
  if (!root) return null;
  if (existsSync(path.join(root, WORKFLOW_PATH))) return { source: 'working-tree', remote: null };
  for (const remote of sessionRepositoryRemotes(root)) {
    const configurationRef = `refs/remotes/${remote}/${CONFIGURATION_BRANCH}`;
    if (refExists(root, configurationRef)) {
      return { source: 'configuration-branch', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
    const storyRef = remoteBranches(root, remote)
      .map((branchName) => `${remote}/${branchName}`)
      .find((ref) => fileAtRef(root, ref, WORKFLOW_PATH) !== null);
    if (storyRef) return { source: 'lifecycle-branch', remote, ref: storyRef };
  }
  // A --single-branch clone may not have fetched the configuration namespace yet. The session
  // operation is remote-backed anyway, so prove the authority without changing the checkout.
  for (const remote of sessionRepositoryRemotes(root)) {
    const available = run('git', ['ls-remote', '--heads', remote, `refs/heads/${CONFIGURATION_BRANCH}`], {
      cwd: root, allowFailure: true
    });
    if (available.status === 0 && available.stdout.trim()) {
      return { source: 'configuration-remote', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
  }
  return null;
}

async function sessionDiscoveryConfiguration(root, authority = sessionRepositoryAuthority(root)) {
  if (existsSync(path.join(root, WORKFLOW_PATH))) {
    const definition = await loadConfig(root);
    return { definition, remote: definition.git?.remote ?? 'origin', source: 'working-tree' };
  }
  if (!authority?.remote) {
    throw new SingularityFlowError(
      `Repository '${root}' has no working-tree definition and no published ${CONFIGURATION_BRANCH} authority.`,
      { code: 'SESSION_REPOSITORY_NOT_GOVERNED' }
    );
  }
  const localCandidates = [
    authority.ref,
    `${authority.remote}/${CONFIGURATION_BRANCH}`,
    ...localBranches(root),
    branch(root)
  ].filter(Boolean);
  for (const ref of [...new Set(localCandidates)]) {
    try {
      const definition = definitionAtRef(root, ref);
      if (definition) return { definition, remote: authority.remote, source: ref };
    } catch { /* Try another local authority before requiring the network. */ }
  }
  fetchRemote(root, authority.remote);
  const remoteCandidates = [
    `${authority.remote}/${CONFIGURATION_BRANCH}`,
    ...remoteBranches(root, authority.remote).map((branchName) => `${authority.remote}/${branchName}`)
  ];
  for (const ref of [...new Set(remoteCandidates)]) {
    try {
      const definition = definitionAtRef(root, ref);
      if (definition) return { definition, remote: authority.remote, source: ref };
    } catch { /* Try another published ref; attachment validates the selected Story strictly. */ }
  }
  throw new SingularityFlowError(
    `Remote '${authority.remote}' has no readable governed definition on ${CONFIGURATION_BRANCH} or a lifecycle branch.`,
    { code: 'SESSION_CONFIGURATION_UNAVAILABLE' }
  );
}

function validatedRemoteStoryDefinition(root, remoteRef, subject) {
  const definition = definitionAtRef(root, remoteRef);
  if (!definition) throw new Error(`missing ${WORKFLOW_PATH}`);
  validateId(definition, subject.id);
  const expectedPath = posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', subject.id, 'workflow.json'
  ));
  if (subject.location.path !== expectedPath) {
    throw new Error(`state path '${subject.location.path}' does not match pinned root '${expectedPath}'`);
  }
  const workflow = JSON.parse(fileAtRef(root, remoteRef, expectedPath) ?? 'null');
  if (workflow?.workItem?.id !== subject.id) throw new Error('identity mismatch');
  return { definition, workflow, itemPath: expectedPath };
}

async function resolveSessionRepository() {
  const governed = (candidate) => sessionRepositoryAuthority(candidate);

  let cwdRoot = null;
  try { cwdRoot = repoRoot(); } catch { /* Not inside a Git repository at all. */ }
  const cwdAuthority = governed(cwdRoot);
  if (cwdAuthority) {
    return { root: cwdRoot, resolvedFrom: 'working-directory', workspaceId: null, authority: cwdAuthority };
  }

  let context = null;
  try {
    context = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile());
  } catch { /* An unreadable or stale selection is a miss, not a failure of the command. */ }

  if (!context) {
    return {
      root: null,
      reason: 'no-workspace-selected',
      detail: 'Select a workspace with `singularity-flow session workspace <workspace>`.'
    };
  }
  if (context.repositoryState !== 'ready') {
    // Never present an unusable clone as an active repository; say what is wrong with it.
    return {
      root: null,
      reason: 'workspace-repository-not-ready',
      detail: `Workspace '${context.workspaceName}' repository '${context.repositoryId}' is ${context.repositoryState}. `
        + `Run \`singularity-flow workspace repair ${context.workspacePath}\`.`
    };
  }
  const workspaceAuthority = governed(context.repositoryPath);
  if (!workspaceAuthority) {
    return {
      root: null,
      reason: 'workspace-repository-not-initialized',
      detail: `Workspace '${context.workspaceName}' repository '${context.repositoryId}' has no ${WORKFLOW_PATH}.`
    };
  }
  return {
    root: path.resolve(context.repositoryPath),
    resolvedFrom: 'active-workspace',
    workspaceId: context.workspaceId,
    authority: workspaceAuthority
  };
}

async function sessionCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'workspace') {
    const registry = workspaceRegistryFile();
    const selectionFile = activeWorkspaceFile();
    const reference = requirePositional(positionals, 2, 'workspace ID, name, Jira anchor, or directory');
    const requestedStoryId = optionString(options, 'story');
    const context = await activateWorkspaceContext(registry, selectionFile, reference, {
      repositoryId: optionString(options, 'repository'),
      storyId: requestedStoryId,
      // Selecting a workspace is not selecting whatever Story its lead clone happens to have
      // checked out. Only an explicit --story may pin a Story in this operation.
      detectStory: requestedStoryId != null
    });
    if (context.repositoryState !== 'ready') {
      throw new SingularityFlowError(
        `Workspace '${context.workspaceName}' is selected, but repository '${context.repositoryId}' is ${context.repositoryState}. `
        + `Run 'singularity-flow workspace repair ${context.workspacePath}' before attaching a session.`
      );
    }
    const currentDirectory = path.resolve(process.cwd());
    const repositoryPath = path.resolve(context.repositoryPath);
    /**
     * Attaching no longer depends on where the host happens to be rooted.
     *
     * This reported `reopen-repository` whenever the caller's working directory was not the clone,
     * and Copilot — which is never rooted there — read that as "I cannot proceed", refusing to
     * attach a Story until someone opened the repository again. The selection already names an
     * absolute path, and `session status`, `candidates` and `attach` now resolve through it, so
     * the session is genuinely ready.
     *
     * The directory mismatch is still reported, because it does matter for editing files by hand —
     * it is simply no longer a precondition for governed work.
     */
    const hostAction = 'ready';
    const editorRooted = currentDirectory === repositoryPath;
    if (!requestedStoryId) {
      const authority = sessionRepositoryAuthority(repositoryPath);
      const { definition } = await sessionDiscoveryConfiguration(repositoryPath, authority);
      let candidate = null;
      if (existsSync(path.join(repositoryPath, WORKFLOW_PATH))) {
        try { candidate = await loadStoryAggregate(repositoryPath, definition); } catch { /* no Story on this branch */ }
      }
      await requireCopilotWorkItemSelection(repositoryPath, definition, candidate);
    }
    const result = {
      attached: true,
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      workspacePath: context.workspacePath,
      repositoryId: context.repositoryId,
      repositoryPath: context.repositoryPath,
      storyId: context.storyId,
      prompt: workspacePromptLabel(context),
      hostAction,
      editorRooted,
      commands: {
        openCopilot: `singularity-flow workspace copilot ${JSON.stringify(context.workspaceId)}`
          + ` --repository ${JSON.stringify(context.repositoryId)}`
          + (context.storyId ? ` --story ${JSON.stringify(context.storyId)}` : ''),
        attachStory: context.storyId
          ? `singularity-flow session attach ${JSON.stringify(context.storyId)}`
          : 'singularity-flow session candidates'
      }
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Attached workspace session: ${workspacePromptLabel(context)}`);
    console.log(`Repository: ${context.repositoryId} · ${context.repositoryPath}`);
    console.log(`Story: ${context.storyId ?? 'not selected'}`);
    if (!editorRooted) {
      // Information, not an instruction. Governed commands resolve the repository from this
      // selection; only hand-editing files in the editor needs the folder open.
      console.log(`Governed commands will use ${context.repositoryPath}; this shell is elsewhere.`);
      console.log(`To edit files in this repository directly: ${result.commands.openCopilot}`);
    }
    if (context.storyId) {
      console.log(`Synchronize the Story branch: ${result.commands.attachStory}`);
    } else {
      console.log('The workspace is active. Select a Story with /sf-session before lifecycle work.');
    }
    return;
  }
  const resolved = await resolveSessionRepository();
  const root = resolved.root;
  if (!root) {
    if (subcommand === 'attach') {
      throw new SingularityFlowError(
        `Cannot attach a Story because no governed repository is active. ${resolved.detail}`,
        { code: 'SESSION_REPOSITORY_REQUIRED' }
      );
    }
    const empty = {
      initialized: false, workId: null, selectionRequired: false, bound: false, activeAgent: null, choices: [],
      resolvedFrom: null, repositoryPath: null, workspaceId: null,
      // Why there is no repository, so the caller can act instead of guessing at a URL.
      reason: resolved.reason
    };
    return console.log(optionBoolean(options, 'json') ? JSON.stringify(empty, null, 2) : `No Singularity Flow repository is active. ${resolved.detail}`);
  }
  const discovery = await sessionDiscoveryConfiguration(root, resolved.authority);
  const config = discovery.definition;
  if (subcommand === 'context') {
    const expandHandle = optionString(options, 'expand-handle');
    const observationKind = optionString(options, 'observation-kind');
    const observationFile = optionString(options, 'observation-file');
    if (Boolean(observationKind) !== Boolean(observationFile)) {
      throw new SingularityFlowError('Observation context requires both --observation-kind and --observation-file.');
    }
    let observation = null;
    if (observationFile) {
      const resolvedObservation = await secureRepositoryPath(root, observationFile, {
        label: 'Observation input', mustExist: true, type: 'file'
      });
      observation = await compileObservation(root, {
        kind: observationKind,
        raw: await readFile(resolvedObservation.absolute),
        commandClass: optionString(options, 'observation-command-class', 'configured-operation'),
        exitCode: optionNumber(options, 'observation-exit-code'),
        binding: {
          workId: optionString(options, 'work-id'),
          flightPlanId: optionString(options, 'flight-plan'),
          sourceRevision: head(root),
          maximumOutputBytes: optionNumber(options, 'max-output-bytes')
        }
      });
    }
    const context = await composeContextBrief(root, {
      workId: optionString(options, 'work-id'),
      slice: optionString(options, 'slice', 'brief'),
      flightPlanId: optionString(options, 'flight-plan'),
      expandHandle,
      observation,
      maxOutputBytes: optionNumber(options, 'max-output-bytes')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(context, null, 2));
    if (context.kind === 'evidence-packet-expansion') {
      console.log(`${context.packetId} · ${context.representation}`);
      console.log(`Included: ${context.accounting.includedContentBytes}/${context.accounting.maximumOutputBytes} bytes · ~${context.accounting.estimatedInputTokens} tokens`);
      console.log(context.content);
      return;
    }
    if (context.kind === 'evidence-packet') {
      console.log(`${context.binding.workId ?? 'preview'} · ${context.binding.phase ?? 'unbound'} · ${context.requestedSlices.join(',')} evidence packet`);
      console.log(`Packet: ${context.packetId} · ${context.status} · revision ${context.binding.sourceRevision.slice(0, 12)}`);
      console.log(`Included: ${context.budget.includedContentBytes}/${context.budget.maximumOutputBytes} bytes · ~${context.budget.estimatedInputTokens} estimated tokens`);
      console.log(`Items: ${context.items.length} · omissions: ${context.omissions.reduce((total, entry) => total + (entry.count ?? 1), 0)} · unavailable: ${context.unavailable.length}`);
      console.log(JSON.stringify({ items: context.items, omissions: context.omissions, unavailable: context.unavailable }, null, 2));
      return;
    }
    console.log(`${context.work.id} · ${context.phase?.id ?? 'complete'} · ${context.slice} context`);
    console.log(`Revision: ${(context.sourceRevision.commit ?? 'unavailable').slice(0, 12)}`);
    console.log(`Included: ${context.accounting.includedContentBytes}/${context.accounting.maximumOutputBytes} bytes · ~${context.accounting.estimatedInputTokens} tokens`);
    if (context.omissions.length) console.log(`Omitted: ${context.omissions.join(', ')}`);
    console.log(JSON.stringify(context.payload, null, 2));
    return;
  }
  if (subcommand === 'candidates') {
    const remote = discovery.remote;
    fetchRemote(root, remote);
    const refs = remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` }));
    const subjectIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: config, refs });
    const candidates = [];
    for (const subject of subjectIndex.list('story')) {
      try {
        const workflow = subject.state;
        validatedRemoteStoryDefinition(root, subject.location.ref, subject);
        candidates.push({ id: subject.id, branch: subject.canonicalBranch, title: workflow.workItem.title, status: workflow.status, phase: workflow.currentPhase, commit: subject.location.commit?.slice(0, 8) ?? '' });
      } catch { /* A malformed remote workflow is not selectable. */ }
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(candidates, null, 2));
    if (!candidates.length) return console.log(`No remote Singularity Flow work-item branches were found on ${remote}.`);
    return console.log(table(candidates, [
      { key: 'id', label: 'WORK/JIRA ID' }, { key: 'title', label: 'TITLE' }, { key: 'phase', label: 'PHASE' }, { key: 'status', label: 'STATUS' },
      { key: 'commit', label: 'REMOTE COMMIT' }
    ]));
  }
  if (subcommand === 'attach') {
    const reference = requirePositional(positionals, 2, 'work, Jira, or branch reference');
    // A new Copilot session may begin after the previous session prepared an unpublished
    // generation. Those governed edits must not make the exact, already-synchronized Story
    // branch impossible to select. We still require a clean tree before changing branches or
    // advancing HEAD; the sole exception below only binds local session metadata in place.
    const remote = discovery.remote;
    fetchRemote(root, remote);
    const refs = remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` }));
    const subjectIndex = await buildRepositorySubjectIndexFromRefs(root, { definition: config, refs });
    const subject = resolveContext(subjectIndex, { reference, kind: 'story' });
    const id = subject.id;
    const targetBranch = subject.selectedBranch;
    const alreadyCurrent = branch(root) === targetBranch;
    if (!alreadyCurrent) assertClean(root);
    const remoteName = `${remote}/${targetBranch}`;
    const remoteRef = `refs/remotes/${remote}/${targetBranch}`;
    const remoteSha = refHead(root, remoteRef);
    if (!remoteSha) throw new SingularityFlowError(`No committed lifecycle branch '${targetBranch}' exists on ${remote}. Start it with /sf-start or verify the Story reference.`);
    let pinned;
    try {
      pinned = validatedRemoteStoryDefinition(root, remoteName, subject);
    } catch {
      throw new SingularityFlowError(
        `Remote branch ${remote}/${targetBranch} is not a valid Singularity Flow Story branch. `
        + `Expected matching state at ${subject.location.path} and a valid pinned ${WORKFLOW_PATH}.`
      );
    }
    const dirtyInPlace = alreadyCurrent && Boolean(changes(root).trim());
    let materialization;
    if (dirtyInPlace) {
      if (head(root) !== remoteSha) {
        throw new SingularityFlowError(
          `Local branch '${targetBranch}' has uncommitted changes and is not at the exact ${remote}/${targetBranch} head. `
          + 'Commit or preserve the changes before synchronizing; Singularity Flow will not merge, rebase, reset, stash, or discard them.'
        );
      }
      materialization = 'bound-current-with-local-changes';
    } else {
      materialization = checkout(root, targetBranch, { base: pinned.definition.defaultBaseBranch, existingOnly: true, remote });
      try { fastForwardTo(root, remoteName); }
      catch { throw new SingularityFlowError(`Local branch '${targetBranch}' cannot fast-forward to ${remote}/${targetBranch}. Resolve or preserve the local commits in another clone; Singularity Flow will not merge, rebase, reset, or discard them.`); }
    }
    if (head(root) !== remoteSha) throw new SingularityFlowError(`Local branch '${targetBranch}' contains commits that are not on ${remote}/${targetBranch}. Push them or use a clean clone before attaching; Singularity Flow will not discard local history.`);
    const attachedConfig = await loadConfig(root);
    const workflow = await loadStoryAggregate(root, attachedConfig, id);
    const session = await activateWorkItemSession(root, attachedConfig, workflow);
    const result = {
      workId: id, branch: workflow.workItem.branch, remote, commit: remoteSha,
      phase: workflow.currentPhase, status: workflow.status, materialization, agent: session.selectedAgent,
      context: {
        operation: 'context.brief',
        arguments: { workId: id, slice: 'brief', maxOutputBytes: 32768 },
        command: `singularity-flow session context --work-id ${id} --slice brief --max-output-bytes 32768 --json`
      }
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...result, repositoryPath: root, resolvedFrom: resolved.resolvedFrom }, null, 2));
    // This checked out a branch. When the repository came from the selection rather than from where
    // the caller is standing, saying which one is the difference between an attach and a surprise.
    if (resolved.resolvedFrom === 'active-workspace') console.log(`Repository: ${root} (from the active workspace)`);
    console.log(`Attached to ${id} from ${remote}/${targetBranch} at ${remoteSha.slice(0, 8)}.`);
    console.log(`Current phase: ${workflow.currentPhase ?? 'complete'} · status: ${workflow.status}`);
    if (session.selectedAgent) console.log(`Phase agent: ${session.selectedAgent} (activated automatically).`);
    else console.log(`The Story is ${workflow.status}; no phase agent is required for read-only inspection.`);
    console.log(`Bounded Copilot context: ${result.context.command}`);
    return;
  }
  if (subcommand !== 'status') throw new SingularityFlowError(`Unknown session subcommand: ${subcommand}`);
  let workflow;
  try { workflow = await loadStoryAggregate(root, config); } catch { workflow = null; }
  /**
   * The repository this answer is about, and how it was chosen.
   *
   * Without it the caller cannot tell an answer about the directory it is standing in from an answer
   * about a workspace selected an hour ago in a different window — and those warrant different
   * confidence before anything is written.
   */
  const status = {
    ...await agentSessionStatus(root, config, workflow),
    repositoryPath: root,
    resolvedFrom: resolved.resolvedFrom,
    workspaceId: resolved.workspaceId
  };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
  if (resolved.resolvedFrom === 'active-workspace') console.log(`Repository: ${root} (from the active workspace, not the working directory)`);
  console.log(`Work item: ${status.workId ?? 'not selected'}${status.candidateWorkId && !status.workId ? ` · current candidate: ${status.candidateWorkId}` : ''}`);
  console.log(`governed agent: ${status.activeAgent ?? 'not selected'}`);
  console.log(`Copilot session: ${status.copilotSessionId ?? 'not bound'}`);
  console.log(`Work-item selection: ${status.workItemSelectionRequired ? 'required' : 'complete'} · governed agent: ${status.activeAgent ?? 'phase default pending'}`);
  console.log(`Policy: work item ${status.policy.workItemSelection ?? 'off'} · phase agent automatic · before tools: ${status.policy.requireBeforeTools ? 'required' : 'not required'}`);
  if (status.workItemSelectionRequired) console.log('Copilot: /sf-session\nRun: singularity-flow session attach <WORK-ID>');
}

async function inboxCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const snapshot = await approvalInbox(root, config, { fetch: !optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
  process.stdout.write(approvalInboxText(snapshot));
}

async function validateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  const result = await validateWorkflow(root, config, workflow, { strict: optionBoolean(options, 'strict') });
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (!result.valid) throw new SingularityFlowError(`Validation failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2 });
  console.log('Singularity Flow workflow is valid.');
}

async function gateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config);
  const result = await runGovernanceGate(root, config, workflow, {
    terminal: optionBoolean(options, 'terminal') || process.env.SINGULARITY_FLOW_ENFORCE_TERMINAL === '1'
  });
  result.passes.forEach((message) => console.log(`  ${style.mark('pass')} ${message}`));
  result.warnings.forEach((message) => console.warn(`  ${style.mark('warn')} ${message}`));
  if (result.errors.length) throw new SingularityFlowError(`Governance gate failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2 });
  console.log('Singularity Flow governance gate passed.');
}

function confirmedJiraIssue(positionals, options) {
  const key = requirePositional(positionals, 2, 'Jira work ID').trim().toUpperCase();
  const confirmation = optionString(options, 'confirm');
  if (!confirmation || confirmation.trim().toUpperCase() !== key) {
    throw new SingularityFlowError(`This Jira update requires exact confirmation. Re-run with --confirm ${key}.`);
  }
  return key;
}

function jiraSprintLabel(issue) {
  const sprint = issue.sprints?.find((item) => item.state === 'active') ?? issue.sprints?.[0];
  return sprint ? `${sprint.name ?? sprint.id}${sprint.state ? ` (${sprint.state})` : ''}` : '—';
}

async function jiraCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'Jira subcommand');
  if (subcommand === 'doctor') {
    const result = await jiraDoctor(repoRoot());
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(jiraDoctorText(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (subcommand === 'status') {
    const result = await discoverJiraConnection();
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Connected to ${result.server.serverTitle ?? result.baseUrl} (${result.deployment}).`);
      console.log(`URL: ${result.baseUrl}`);
      console.log(`Authentication: ${result.authenticationMode}`);
      console.log(`Account: ${result.account.displayName ?? result.account.accountId}${result.account.email ? ` <${result.account.email}>` : ''}`);
      console.log(`Visible projects: ${result.projects.length}`);
    }
    return;
  }
  if (subcommand === 'projects') {
    const projects = await listProjects({ query: optionString(options, 'query'), limit: optionNumber(options, 'limit', 50) });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(projects, null, 2));
    else console.log(table(projects, [
      { key: 'key', label: 'KEY' }, { key: 'name', label: 'PROJECT' }, { key: 'projectType', label: 'TYPE' }
    ]));
    return;
  }
  if (subcommand === 'epics') {
    const project = optionString(options, 'project');
    if (!project) throw new SingularityFlowError('jira epics requires --project KEY.');
    const issues = await listEpics(project, { issueType: optionString(options, 'type', 'Epic'), limit: optionNumber(options, 'limit', 100) });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issues, null, 2));
    else console.log(table(issues, [
      { key: 'key', label: 'EPIC' }, { key: 'status', label: 'STATUS' }, { key: 'title', label: 'SUMMARY' }, { key: 'updatedAt', label: 'UPDATED' }
    ]));
    return;
  }
  if (subcommand === 'children') {
    const issues = await listEpicStories(requirePositional(positionals, 2, 'Jira Epic key'), { limit: optionNumber(options, 'limit', 100) });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issues, null, 2));
    else console.log(table(issues, [
      { key: 'key', label: 'STORY' }, { key: 'status', label: 'STATUS' }, { key: 'issueType', label: 'TYPE' }, { key: 'title', label: 'SUMMARY' }
    ]));
    return;
  }
  if (subcommand === 'permissions') {
    const project = optionString(options, 'project');
    if (!project) throw new SingularityFlowError('jira permissions requires --project KEY.');
    const permissions = await getMyPermissions(project);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(permissions, null, 2));
    else console.log(table(Object.entries(permissions).map(([key, value]) => ({ key, allowed: value.havePermission, name: value.name })), [
      { key: 'key', label: 'PERMISSION' }, { key: 'allowed', label: 'ALLOWED' }, { key: 'name', label: 'NAME' }
    ]));
    return;
  }
  if (subcommand === 'boards') {
    const boards = await listBoards({
      project: optionString(options, 'project'),
      limit: optionNumber(options, 'limit', 100)
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(boards, null, 2));
    else if (!boards.length) console.log('No visible Jira Software boards found.');
    else console.log(table(boards.map((board) => ({
      id: board.id,
      type: board.type ?? '',
      project: board.location?.projectKey ?? '',
      name: board.name ?? ''
    })), [
      { key: 'id', label: 'BOARD' },
      { key: 'type', label: 'TYPE' },
      { key: 'project', label: 'PROJECT' },
      { key: 'name', label: 'NAME' }
    ]));
    return;
  }
  if (subcommand === 'board') {
    const boardId = requirePositional(positionals, 2, 'Jira board ID');
    const result = await listBoardStories(boardId, {
      states: optionString(options, 'state', 'active,future'),
      issueType: optionString(options, 'type', 'Story'),
      limit: optionNumber(options, 'limit', 500)
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.totalIssues) {
      console.log(`No Jira ${result.issueType} items found in ${result.sprintStates.join('/')} sprints. The backlog was not queried.`);
    } else {
      const rows = result.sprints.flatMap((sprint) => sprint.issues.map((issue) => ({
        sprint: sprint.name ?? sprint.id,
        state: sprint.state ?? '',
        key: issue.key,
        status: issue.status ?? '',
        assignee: issue.assignee?.displayName ?? 'Unassigned',
        title: issue.title
      })));
      console.log(table(rows, [
        { key: 'sprint', label: 'SPRINT' },
        { key: 'state', label: 'SPRINT STATE' },
        { key: 'key', label: 'STORY' },
        { key: 'status', label: 'STATUS' },
        { key: 'assignee', label: 'ASSIGNEE' },
        { key: 'title', label: 'SUMMARY' }
      ]));
      console.log(`Backlog excluded · ${result.totalIssues} ${result.issueType} item(s) across ${result.sprints.length} sprint(s).`);
    }
    return;
  }
  if (['list', 'assigned'].includes(subcommand)) {
    const result = await listMyIssues({
      project: optionString(options, 'project'),
      issueType: optionString(options, 'type', 'Story'),
      limit: optionNumber(options, 'limit', 25),
      jql: optionString(options, 'jql')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.issues.length) console.log('No matching Jira work items assigned to the connected user.');
    else console.log(table(result.issues.map((issue) => ({
      key: issue.key,
      status: issue.status ?? '',
      sprint: jiraSprintLabel(issue),
      priority: issue.priority ?? '',
      title: issue.title
    })), [
      { key: 'key', label: 'KEY' },
      { key: 'status', label: 'STATUS' },
      { key: 'sprint', label: 'SPRINT' },
      { key: 'priority', label: 'PRIORITY' },
      { key: 'title', label: 'SUMMARY' }
    ]));
    return;
  }
  if (['pull', 'show', 'get'].includes(subcommand)) {
    const key = requirePositional(positionals, 2, 'Jira work ID');
    const issue = await getIssue(key);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issue, null, 2));
    else console.log(issueToMarkdown(issue));
    return;
  }
  if (subcommand === 'fields') {
    const fields = await listFields({ query: optionString(options, 'query') });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(fields, null, 2));
    else if (!fields.length) console.log('No matching Jira fields found.');
    else console.log(table(fields, [
      { key: 'id', label: 'FIELD ID' },
      { key: 'name', label: 'NAME' },
      { key: 'custom', label: 'CUSTOM' },
      { key: 'type', label: 'TYPE' }
    ]));
    return;
  }
  if (subcommand === 'transitions') {
    const key = requirePositional(positionals, 2, 'Jira work ID');
    const transitions = await listIssueTransitions(key);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(transitions, null, 2));
    else if (!transitions.length) console.log(`No Jira transitions are currently available for ${key.toUpperCase()}.`);
    else console.log(table(transitions, [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'TRANSITION' },
      { key: 'to', label: 'TO STATUS' },
      { key: 'statusCategory', label: 'CATEGORY' }
    ]));
    return;
  }
  if (subcommand === 'transition') {
    const key = confirmedJiraIssue(positionals, options);
    const target = optionString(options, 'to');
    if (!target) throw new SingularityFlowError('jira transition requires --to STATUS or --to TRANSITION-ID.');
    const result = await transitionIssue(key, target, { expectedUpdatedAt: optionString(options, 'expected-updated-at') });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else console.log(`Jira ${key} transitioned using '${result.transition.name}' → ${result.issue.status}.`);
    return;
  }
  if (subcommand === 'assign') {
    const key = confirmedJiraIssue(positionals, options);
    const target = optionString(options, 'to');
    if (!target) throw new SingularityFlowError('jira assign requires --to me, --to unassigned, or --to ACCOUNT-ID.');
    const issue = await assignIssue(key, target);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issue, null, 2));
    else console.log(`Jira ${key} assignee is now ${issue.assignee?.displayName ?? 'Unassigned'}.`);
    return;
  }
  if (subcommand === 'priority') {
    const key = confirmedJiraIssue(positionals, options);
    const target = optionString(options, 'to');
    if (!target) throw new SingularityFlowError('jira priority requires --to NAME or --to PRIORITY-ID.');
    const issue = await setIssuePriority(key, target);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issue, null, 2));
    else console.log(`Jira ${key} priority is now ${issue.priority ?? target}.`);
    return;
  }
  if (subcommand === 'sprint') {
    const key = confirmedJiraIssue(positionals, options);
    const target = optionString(options, 'to');
    if (!target) throw new SingularityFlowError('jira sprint requires --to SPRINT-ID.');
    const issue = await moveIssueToSprint(key, target);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(issue, null, 2));
    else console.log(`Jira ${key} moved to sprint ${target}${issue.sprints?.length ? ` (${jiraSprintLabel(issue)})` : ''}.`);
    return;
  }
  if (subcommand === 'comment') {
    const key = confirmedJiraIssue(positionals, options);
    const text = optionString(options, 'text');
    if (!text?.trim()) throw new SingularityFlowError('jira comment requires non-empty --text TEXT.');
    const result = await addComment(key, text);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ key, ...result }, null, 2));
    else console.log(`Comment ${result.id ?? '(ID unavailable)'} added to Jira ${key}.`);
    return;
  }
  throw new SingularityFlowError(`Unknown Jira subcommand: ${subcommand}`);
}

async function pluginCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'plugin subcommand');
  if (subcommand === 'install') return installPlugin();
  if (subcommand === 'uninstall') return uninstallPlugin();
  if (subcommand === 'list') return listPlugins();
  if (subcommand === 'path') return console.log(pluginPath());
  throw new SingularityFlowError(`Unknown plugin subcommand: ${subcommand}`);
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function initiativeProfileChoices(portfolio) {
  return Object.entries(portfolio.initiativeProfiles).map(([id, profile]) => ({
    id,
    label: profile.label ?? id,
    description: `${profile.phases.length} governed phases`,
    // The phases themselves, not only how many. Which phases a profile runs is the entire
    // difference between two profiles, and a count cannot be compared against anything.
    phases: [...profile.phases]
  }));
}

function initiativeStartChoiceSets(portfolio) {
  return [{ id: 'initiative-profile', label: 'Initiative profile', options: initiativeProfileChoices(portfolio) }];
}

async function activateInitiativeAgent(root, definition, initiativeId, phase, requestedAgent = null) {
  const declared = phase?.agents ?? [];
  const fallback = declared[0] ?? (definition.agents?.['product-owner'] ? 'product-owner' : Object.keys(definition.agents ?? {})[0]);
  const agent = requestedAgent ?? fallback;
  if (!agent || !definition.agents?.[agent]) throw new SingularityFlowError(`Initiative phase '${phase?.id ?? 'unknown'}' has no valid governed agent.`);
  if (requestedAgent && declared.length && !declared.includes(requestedAgent)) {
    console.warn(`Warning: agent '${requestedAgent}' is not declared for initiative phase '${phase.id}'. Continuing with an audited override; human approval authority is unchanged.`);
  }
  return setAgentSession(root, definition, actionActor(root), agent, initiativeId, {
    phaseId: phase?.id ?? null,
    source: requestedAgent ? 'explicit-override' : 'phase-default'
  });
}

async function chooseInitiativeProfile(portfolio, selection = null) {
  const choices = initiativeProfileChoices(portfolio);
  if (selection) {
    if (!choices.some((choice) => choice.id === selection)) throw new SingularityFlowError(`Unknown initiative profile '${selection}'.`);
    return selection;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION) {
      const selected = JSON.parse(process.env.SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION).profile;
      if (choices.some((choice) => choice.id === selected)) return selected;
    }
    throw new SingularityFlowError('Selecting an initiative profile requires an interactive terminal or a Copilot selection receipt.');
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log('\nChoose initiative profile:');
    choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label} (${choice.id}) — ${choice.description}`));
    const selected = Number((await io.question(`Enter 1-${choices.length}: `)).trim()) - 1;
    if (!Number.isInteger(selected) || !choices[selected]) throw new SingularityFlowError('Invalid initiative profile selection.');
    return choices[selected].id;
  } finally { io.close(); }
}

// Exact confirmation exists so a destructive initiative action is never taken by accident, not so it
// can only be taken from a terminal. A visual client cannot type into stdin, so `--confirm` is the
// same contract for every surface — and matches how `workspace create|archive|update` already take
// it. The value must still
// be exact; supplying the wrong one fails loudly rather than falling back to a prompt.
async function confirmInitiativeExact(prompt, expected, options = null) {
  const supplied = options ? optionString(options, 'confirm') : undefined;
  if (supplied !== undefined) {
    if (supplied !== expected) {
      throw new SingularityFlowError(`This action requires exact confirmation '${expected}'; --confirm received '${supplied}'.`);
    }
    return true;
  }
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM === expected) return true;
    throw new SingularityFlowError(`This initiative action requires exact confirmation '${expected}'. Run it in a terminal, or pass --confirm ${expected}.`);
  }
  const io = readline.createInterface({ input, output });
  try { return (await io.question(`${prompt}\nType ${expected} to continue: `)).trim() === expected; }
  finally { io.close(); }
}

function initiativeFlowText(progress) {
  // A skipped phase is not an unknown one. It reads as a dash rather than a tick precisely because
  // it was never approved — an Initiative that entered the lifecycle late must not look like one
  // that went through the stages before it.
  const symbols = {
    approved: '✓', in_progress: '●', awaiting_approval: '◆', stale: '!', not_started: '○',
    skipped: '–'
  };
  return progress.phases.map((phase) => `[${symbols[phase.status] ?? '?'} ${phase.label}]`).join(' → ');
}

function repositoryMappings(options) {
  return Object.fromEntries(optionStrings(options, 'repository').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1 || separator === entry.length - 1) throw new SingularityFlowError(`Invalid repository mapping '${entry}'. Use JIRA-KEY=REPOSITORY.`);
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

async function initiativeChoicesCommand(root, config, portfolio, positionals, options) {
  const action = requirePositional(positionals, 3, 'initiative choice action');
  if (positionals[2] === 'answer') {
    const receipt = await answerSelectionReceipt(root, requirePositional(positionals, 3, 'receipt token'), requirePositional(positionals, 4, 'choice ID'), requirePositional(positionals, 5, 'selected ID'));
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2)); else printSelectionReceipt(receipt);
    return;
  }
  if (positionals[2] === 'status') {
    const receipt = await selectionReceiptStatus(root, requirePositional(positionals, 3, 'receipt token'));
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2)); else printSelectionReceipt(receipt);
    return;
  }
  if (positionals[2] !== 'begin') throw new SingularityFlowError('Initiative choices supports begin, answer, or status.');
  const initiativeId = requirePositional(positionals, 4, 'initiative ID');
  validateInitiativeId(initiativeId);
  let choiceSets;
  let context = null;
  let receiptAction;
  if (action === 'start') {
    choiceSets = initiativeStartChoiceSets(portfolio);
    receiptAction = 'initiative-start';
  } else if (action === 'approve') {
    const { initiative } = await loadInitiativeAggregate(root, initiativeId, portfolio);
    const phaseId = initiative.currentPhase;
    const subject = positionals[5] ?? 'phase';
    const bundle = await initiativeBundle(root, portfolio, initiative, phaseId);
    const expected = `${phaseId}:${subject}`;
    choiceSets = [{ id: 'decision-confirmation', label: 'Exact approval confirmation', options: [{ id: expected, label: `Approve ${expected}`, description: `Approves the exact current hash for ${subject}.` }] }];
    context = { phase: phaseId, subject, bundleSha256: bundle.sha256 };
    receiptAction = 'initiative-approve';
  } else throw new SingularityFlowError('Initiative choice action must be start or approve.');
  const receipt = await beginCustomSelectionReceipt(root, { action: receiptAction, workId: initiativeId, choiceSets, context });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2)); else printSelectionReceipt(receipt);
}

/**
 * Commit whatever the knowledge store just gained.
 *
 * Knowledge records were written and never committed by any path, so "Git is the database" did not
 * hold for them: the entries survived only as untracked files, and every governed command that
 * follows refuses to run against a dirty checkout. Kept separate from commitInitiativeChange because
 * a recorded decision need not belong to an initiative at all.
 */
function commitKnowledge(root, message) {
  add(root, [KNOWLEDGE_ROOT]);
  if (!changes(root).length) return null;
  return commit(root, message, [KNOWLEDGE_ROOT]);
}

/**
 * Structure a capability edit from options, leaving unnamed fields alone.
 *
 * `--repository ''` is not the same as omitting `--repository`: the first clears the repository,
 * while the second says nothing about it. A valid edit that changes a delivery into a collection
 * therefore sends both `--kind collection` and `--repository ''`.
 */
function capabilityChanges(options) {
  // Insertion order is the order new keys land in the file, so this is the order a person reads a
  // capability in: what it is, where it sits, what it ships, then who tracks and runs it.
  const changes = {};
  const put = (option, field, transform = (value) => value) => {
    const value = optionString(options, option);
    if (value != null) changes[field] = transform(value);
  };
  const list = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
  put('name', 'name');
  const kind = optionString(options, 'kind');
  if (kind != null) {
    if (!CAPABILITY_KINDS.includes(kind)) {
      throw new SingularityFlowError(`--kind must be one of: ${CAPABILITY_KINDS.join(', ')}.`);
    }
    changes.kind = kind;
  }
  put('type', 'type');
  put('parent', 'parent', (value) => value || null);
  put('repository', 'repository');
  // The list form, for a capability shipping from more than one. Empty clears it back to none.
  put('repositories', 'repositories', list);
  put('lead-repository', 'leadRepository', (value) => value || null);
  put('source-roots', 'sourceRoots', list);
  put('shared-roots', 'sharedRoots', list);
  // Merged rather than replaced: `--doc runbook=...` adds or changes that one key and leaves the
  // rest, which is what editing a set of links means. Clearing one is `--doc runbook=`.
  for (const [option, field] of [
    ['metadata', 'metadata'], ['doc', 'documentation'], ['resource', 'resources']
  ]) {
    const pairs = optionStrings(options, option);
    if (pairs.length) changes[field] = optionMap(pairs, `Capability ${field}`, { allowEmpty: true });
  }
  put('jira-project', 'jira.projectKey');
  put('jira-board', 'jira.board');
  put('jira-component', 'jira.component');
  put('teams', 'teams', list);
  put('owns', 'owns', list);
  put('description', 'description');
  put('owner', 'owner');
  return changes;
}

/**
 * The optional destination for direct children when their parent is removed.
 *
 * Omitted preserves the protective refusal. An explicitly empty value means top level, matching
 * the existing `--parent ''` convention used when moving one capability.
 */
function capabilityRemovalDestination(options) {
  const value = optionString(options, 'reparent-children-to');
  return value === undefined ? undefined : (value.trim() || null);
}

/**
 * The capability map: read, and edited one node at a time.
 *
 * Reading gives the derived answers a reader cannot get by looking at one place in the file — what a
 * capability ships, and who owns a repository. Writing exists because a screen needs a write path
 * that validates before it saves; it edits the YAML document rather than re-emitting it, so a map
 * that people also hand-edit stays readable afterwards.
 *
 * Policy is not editable here. It folds from the root down, so the value that applies is often not
 * the value written, and an option per field would make that easier to get wrong rather than easier
 * to see. `capability show --json` reports both.
 */
async function capabilityCommand(positionals, options) {
  const subcommandForWrite = positionals[1];

  // Mapping and reading happen against a lead repository rather than a checkout, so they run from
  // anywhere — including a window with nothing open, which is where somebody describing what their
  // organisation builds actually is.
  if (subcommandForWrite === 'map') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) {
      throw new SingularityFlowError(
        'No lead repository is known. Pass --lead <URL> for the repository that will own the '
        + 'first capability map; no workspace or prior bootstrap is required.');
    }
    const type = optionString(options, 'type');
    if (type && !CAPABILITY_TYPES.includes(type)) {
      throw new SingularityFlowError(`--type must be one of: ${CAPABILITY_TYPES.join(', ')}.`);
    }
    const kind = optionString(options, 'kind');
    if (kind && !CAPABILITY_KINDS.includes(kind)) {
      throw new SingularityFlowError(`--kind must be one of: ${CAPABILITY_KINDS.join(', ')}.`);
    }
    const mapped = await mapCapability(leadUrl, {
      capabilityId: requirePositional(positionals, 2, 'capability ID'),
      name: optionString(options, 'name'),
      kind,
      type,
      parent: optionString(options, 'parent'),
      // Repeatable: a capability may ship from several repositories, and --lead-repository says
      // which of them holds its governed state.
      repositoryUrls: optionStrings(options, 'repository'),
      leadRepositoryUrl: optionString(options, 'lead-repository'),
      metadata: optionMap(optionStrings(options, 'metadata'), 'Capability metadata'),
      // Free-form key/value, because every organisation names its documentation and its
      // infrastructure differently. `--doc confluence=<url>`, `--resource aws=<arn>`.
      documentation: optionMap(optionStrings(options, 'doc'), 'Capability documentation'),
      resources: optionMap(optionStrings(options, 'resource'), 'Capability resources'),
      sourceRoots: (optionString(options, 'source-roots') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      sharedRoots: (optionString(options, 'shared-roots') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
      clone: {
        mode: optionString(options, 'clone-mode', 'full'),
        sparseCone: (optionString(options, 'sparse-cone') ?? '').split(',').map((item) => item.trim()).filter(Boolean),
        fallback: optionString(options, 'clone-fallback', 'refuse')
      },
      jiraProject: optionString(options, 'jira-project'),
      teams: (optionString(options, 'teams') ?? '').split(',').map((team) => team.trim()).filter(Boolean)
    });
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ lead: leadUrl, ...mapped }, null, 2));
    const ships = mapped.repositoryIds?.length
      ? ` to ${mapped.repositoryIds.join(', ')}${mapped.leadRepositoryId && mapped.repositoryIds.length > 1 ? ` (lead ${mapped.leadRepositoryId})` : ''}`
      : '';
    console.log(`Proposed capability ${mapped.capabilityId}${ships} in ${leadUrl}.`);
    if (mapped.commit) {
      console.log(`  review branch: ${mapped.branch}`);
      console.log(`  base: ${mapped.baseBranch}@${mapped.baseCommit.slice(0, 8)}`);
      console.log(`  commit: ${mapped.commit.slice(0, 8)}`);
      console.log(`  approved ${mapped.baseBranch} was not changed.`);
      console.log('  the application default branch is not part of this configuration change.');
      console.log(`  review: singularity-flow capability proposal ${mapped.branch} --lead ${leadUrl}`);
      console.log(`  activate: singularity-flow capability activate ${mapped.branch} --lead ${leadUrl} --confirm ${mapped.commit}`);
      console.log('  if branch protection requires external review, merge there first and run the same activate command to publish the projection.');
    }
    return;
  }

  if (subcommandForWrite === 'edit') {
    // Editing reaches the map the same way mapping does: through the lead repository, with nothing
    // checked out. Requiring a clone to change a capability's Confluence link is the reason the
    // map went stale in the first place.
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) {
      throw new SingularityFlowError(
        'No lead repository is known. Pass --lead <URL>, or map a capability first.');
    }
    const id = requirePositional(positionals, 2, 'capability ID');
    const mode = optionString(options, 'mode') ?? 'set';
    if (!['add', 'set', 'remove'].includes(mode)) {
      throw new SingularityFlowError("--mode must be one of: add, set, remove.");
    }
    const type = optionString(options, 'type');
    if (type && !CAPABILITY_TYPES.includes(type)) {
      throw new SingularityFlowError(`--type must be one of: ${CAPABILITY_TYPES.join(', ')}.`);
    }
    const edited = await editCapabilityInOrganisation(
      leadUrl,
      id,
      mode === 'remove' ? {} : capabilityChanges(options),
      { mode, reparentChildrenTo: mode === 'remove' ? capabilityRemovalDestination(options) : undefined }
    );
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ lead: leadUrl, ...edited }, null, 2));
    const action = mode === 'add' ? 'addition of' : mode === 'remove' ? 'removal of' : 'update to';
    console.log(`Proposed the ${action} ${id} in ${leadUrl}.`);
    if (edited.commit) {
      console.log(`  review branch: ${edited.branch}`);
      console.log(`  base: ${edited.baseBranch}@${edited.baseCommit.slice(0, 8)}`);
      console.log(`  commit: ${edited.commit.slice(0, 8)}`);
      console.log(`  approved ${edited.baseBranch} was not changed.`);
      console.log('  the application default branch is not part of this configuration change.');
      console.log(`  review: singularity-flow capability proposal ${edited.branch} --lead ${leadUrl}`);
      console.log(`  activate: singularity-flow capability activate ${edited.branch} --lead ${leadUrl} --confirm ${edited.commit}`);
      console.log('  if branch protection requires external review, merge there first and run the same activate command to publish the projection.');
    }
    return;
  }

  if (subcommandForWrite === 'publish') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass --lead <URL>.');
    const state = await publishOrganisationCapabilityMap(leadUrl);
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ lead: leadUrl, ...state }, null, 2));
    if (state.published) {
      return console.log(`Published the reviewed ${state.baseBranch} capability map to ${state.branch} at ${state.commit.slice(0, 8)}.`);
    }
    return console.log(state.branch
      ? `The ${state.branch} capability projection is already current.`
      : `Capability projection not published: ${state.reason}.`);
  }

  if (subcommandForWrite === 'proposals') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass --lead <URL>.');
    const proposals = await listCapabilityProposals(leadUrl, {
      includeMerged: optionBoolean(options, 'all')
    });
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) {
      return console.log(JSON.stringify({ lead: leadUrl, proposals }, null, 2));
    }
    if (!proposals.length) return console.log('No pending capability proposals.');
    for (const proposal of proposals) {
      console.log(`${proposal.branch}  ${proposal.proposalCommit.slice(0, 12)}  `
        + `${proposal.merged ? 'merged' : proposal.valid ? 'ready for review' : 'invalid'}`);
    }
    return;
  }

  if (subcommandForWrite === 'proposal') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass --lead <URL>.');
    const branch = requirePositional(positionals, 2, 'capability proposal branch');
    const proposal = await inspectCapabilityProposal(leadUrl, branch);
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(proposal, null, 2));
    console.log(`${proposal.branch} (${proposal.proposalCommit})`);
    console.log(`  target: ${proposal.targetBranch}@${proposal.targetCommit}`);
    console.log(`  status: ${proposal.merged ? 'already merged' : proposal.valid ? 'ready for review' : 'invalid'}`);
    for (const file of proposal.changedFiles) console.log(`  ${file.status.padEnd(4)} ${file.paths.join(' -> ')}`);
    if (proposal.invalidFiles.length) console.log(`  refused files: ${proposal.invalidFiles.join(', ')}`);
    return;
  }

  if (subcommandForWrite === 'activate') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass --lead <URL>.');
    const branch = requirePositional(positionals, 2, 'capability proposal branch');
    const result = await activateCapabilityProposal(leadUrl, branch, {
      confirm: optionString(options, 'confirm'),
      acknowledgeUnprotected: optionBoolean(options, 'acknowledge-unprotected')
    });
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(result.alreadyMerged
      ? `${branch} was already merged into ${result.targetBranch}.`
      : `Merged ${branch}@${result.proposalCommit.slice(0, 12)} into ${result.targetBranch} at ${result.targetCommit.slice(0, 12)}.`);
    if (result.projection?.published) {
      console.log(`Published the capability projection to ${result.projection.branch} at ${result.projection.commit.slice(0, 12)}.`);
    } else {
      console.log(result.projection?.branch
        ? `The ${result.projection.branch} capability projection is already current.`
        : `Capability projection not published: ${result.projection?.reason}.`);
    }
    console.log(`Recorded activation audit ${result.audit.eventId} at ledger sequence ${result.audit.sequence}.`);
    return;
  }

  if (subcommandForWrite === 'world-model') {
    const leadUrl = optionString(options, 'lead') ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass --lead <URL>.');
    const id = requirePositional(positionals, 2, 'capability ID');
    const organisation = await readOrganisation(leadUrl, {
      refresh: optionBoolean(options, 'refresh')
    });
    const model = composeCapabilityWorldModel(organisation, id, await capabilityReadiness(leadUrl));
    await rememberLeadRepository(leadUrl);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(model, null, 2));

    console.log(`${model.name} — ${model.composed
      ? `composed from ${model.sources.length} capabilit${model.sources.length === 1 ? 'y' : 'ies'} beneath it`
      : 'its own world model'}`);
    if (!model.sources.length) {
      console.log('  Nothing beneath it ships, so there is nothing to compose from yet.');
      return;
    }
    for (const source of model.sources) {
      console.log(`  ${source.name} (${source.repository}): `
        + `${source.present ? `world model on ${source.branch}` : 'no world model built'}`);
    }
    if (model.alsoShipsFrom.length) {
      console.log(`  also ships from ${model.alsoShipsFrom.join(', ')}, whose code is governed by the lead's model`);
    }
    const missing = model.sources.filter((source) => !source.present);
    if (missing.length) {
      console.log(`  ${missing.length} of ${model.sources.length} have no world model, so this view is partial.`);
    }
    return;
  }

  if (subcommandForWrite === 'organisation') {
    const withReadiness = optionBoolean(options, 'readiness');

    const leadUrl = optionString(options, 'lead')
      ?? positionals[2] ?? (await listLeadRepositories())[0]?.url;
    if (!leadUrl) throw new SingularityFlowError('No lead repository is known. Pass one, or govern one first.');
    const organisation = await readOrganisation(leadUrl, {
      refresh: optionBoolean(options, 'refresh')
    });
    await rememberLeadRepository(leadUrl);
    // Asked of the remotes, so it costs an ls-remote per repository — worth it on request, not on
    // every read of the map.
    const readiness = withReadiness ? await capabilityReadiness(leadUrl) : null;
    if (optionBoolean(options, 'json')) {
      return console.log(JSON.stringify(readiness ? { ...organisation, readiness } : organisation, null, 2));
    }
    if (!organisation.governed) return console.log(`${leadUrl} holds no capability map.`);
    if (organisation.stale) {
      const minutes = organisation.cacheAgeMs == null ? 'an unknown time'
        : `${Math.max(0, Math.floor(organisation.cacheAgeMs / 60_000))} minute(s)`;
      console.warn(`Warning: showing the cached capability map from ${minutes} ago because the remote is unreachable: ${organisation.remoteError}`);
    }
    for (const row of flattenCapabilityTree(organisation.capabilities)) {
      const ships = row.repositories?.length ? `  \u2192 ${row.repositories.join(', ')}` : '';
      const lead = row.repositories?.length > 1 && row.leadRepository ? ` (lead ${row.leadRepository})` : '';
      const type = row.type ? ` [${row.type}]` : '';
      console.log(`${'  '.repeat(row.depth)}${row.name}${type}${ships}${lead}`);
      // Under each repository, the two things that decide whether it can be worked in.
      for (const id of readiness ? row.repositories ?? [] : []) {
        const state = readiness[id];
        if (!state) continue;
        console.log(`${'  '.repeat(row.depth + 1)}${id}: `
          + `${state.hasStateBranch ? `${state.stateBranch} branch` : 'no state branch'}`
          + ` \u00b7 ${state.worldModel ? `world model on ${state.worldModel}` : 'no world model'}`);
      }
    }
    return;
  }

  if (subcommandForWrite === 'leads') {
    const leads = await listLeadRepositories();
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(leads, null, 2));
    if (!leads.length) return console.log('No lead repository is known yet.');
    for (const lead of leads) console.log(`  ${lead.url}`);
    return;
  }

  // Everything below edits the map in the repository you are standing in, so it needs one.
  const root = repoRoot();
  const portfolio = await loadPortfolio(root, { required: false });

  if (subcommandForWrite === 'add' || subcommandForWrite === 'set' || subcommandForWrite === 'remove') {
    const id = requirePositional(positionals, 2, 'capability ID');
    const result = await editCapability(root, id, capabilityChanges(options), {
      mode: subcommandForWrite,
      portfolio,
      reparentChildrenTo: subcommandForWrite === 'remove'
        ? capabilityRemovalDestination(options)
        : undefined
    });
    const state = {
      published: false,
      reason: 'local authoring never publishes governed capability state; use capability edit --lead <URL> to propose an organisation change'
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...result, state }, null, 2));
    console.log(result.removed
      ? `Removed capability ${id} from ${result.path}.`
      : `Saved capability ${id} to ${result.path}.`);
    console.log('  This is a local authoring change; no governed state branch was created or moved.');
    return console.log('  Governed route: singularity-flow capability edit <ID> --lead <URL> --mode set …');
  }

  const definition = await loadCapabilities(root);
  if (!definition) {
    throw new SingularityFlowError(`No capability map exists. Describe what this organisation builds in ${CAPABILITIES_PATH}.`);
  }
  validateCapabilities(definition, portfolio);
  const tree = capabilityTree(definition);
  const subcommand = positionals[1] ?? 'tree';

  if (subcommand === 'show') {
    const id = requirePositional(positionals, 2, 'capability ID');
    const deliveries = capabilityDeliveries(definition, id);
    // Both policies, because they differ silently: a capability declaring one approval beneath a
    // parent demanding two is held to two, and only the effective form says so.
    const node = flattenCapabilityTree(tree).find((row) => row.id === id);
    if (optionBoolean(options, 'json')) {
      return console.log(JSON.stringify({
        id, deliveries, policy: node?.policy ?? {}, effectivePolicy: node?.effectivePolicy ?? {}
      }, null, 2));
    }
    // Counted by repository rather than by capability: "ships from 1 repository" above a row naming
    // two is the count contradicting the list beneath it.
    const shipsFrom = new Set(deliveries.flatMap((delivery) =>
      (delivery.repositories?.length ? delivery.repositories : (delivery.repository ? [delivery.repository] : []))));
    console.log(`${id} ships from ${shipsFrom.size} ${shipsFrom.size === 1 ? 'repository' : 'repositories'}`);
    for (const delivery of deliveries) {
      const ships = delivery.repositories?.length ? delivery.repositories
        : (delivery.repository ? [delivery.repository] : []);
      console.log(`  ${delivery.id.padEnd(28)} ${ships.join(', ')}`);
    }
    for (const [key, value] of Object.entries(node?.effectivePolicy ?? {})) {
      const declared = node?.policy?.[key];
      const overridden = declared !== undefined && JSON.stringify(declared) !== JSON.stringify(value);
      console.log(`  ${key.padEnd(28)} ${Array.isArray(value) ? value.join(', ') : value}${overridden ? `  (declared ${JSON.stringify(declared)}, overridden by an ancestor)` : ''}`);
    }
    return;
  }

  if (subcommand === 'of') {
    const repository = requirePositional(positionals, 2, 'repository ID');
    const owner = capabilityForRepository(definition, repository);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(owner, null, 2));
    if (!owner) return console.log(`No capability claims repository '${repository}'.`);
    console.log(`${repository} delivers ${owner.id}`);
    if (owner.ancestors.length) console.log(`  within ${owner.ancestors.join(' / ')}`);
    return;
  }

  const rows = flattenCapabilityTree(tree);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ capabilities: tree }, null, 2));
  for (const row of rows) {
    const indent = '  '.repeat(row.depth);
    // Every repository, not the first one. A capability may ship from several — a product with a web
    // app and a service is the ordinary case — and naming one of them is how a map that describes
    // two repositories reads as describing one.
    const ships = row.repositories?.length ? row.repositories : (row.repository ? [row.repository] : []);
    const lead = ships.length > 1 && row.leadRepository ? ` (lead ${row.leadRepository})` : '';
    console.log(`${indent}${row.name}${ships.length ? `  → ${ships.join(', ')}${lead}` : ''}`);
  }
  const deliveries = rows.filter((row) => row.delivery);
  const repositories = new Set(deliveries.flatMap((row) =>
    (row.repositories?.length ? row.repositories : (row.repository ? [row.repository] : []))));
  console.log(`\n${rows.length} capabilities, ${deliveries.length} delivering from ${repositories.size} ${repositories.size === 1 ? 'repository' : 'repositories'}.`);
}

/**
 * Govern a repository that has never heard of Singularity Flow.
 *
 * The one operation that cannot assume a governed repository, because it is the one that makes one.
 * Everything else in this CLI runs inside a repository; this runs from anywhere and produces one.
 */
// Rejected here rather than at first use: an unknown mode written into the configuration authority
// would only surface later, as a confusing failure in a Story that did nothing wrong.
function groundingOption(options) {
  const requested = optionString(options, 'grounding');
  if (requested == null) return null;
  if (!['off', 'warn', 'enforce'].includes(requested)) {
    throw new SingularityFlowError(`--grounding must be off, warn, or enforce; got '${requested}'.`);
  }
  return requested;
}

async function bootstrapCommand(positionals, options) {
  const url = requirePositional(positionals, 1, 'repository URL');
  const capabilityId = optionString(options, 'capability');
  if (!capabilityId) {
    throw new SingularityFlowError(
      'bootstrap requires --capability ID: the top-level thing this organisation builds, which the '
      + 'lead repository holds the map of.');
  }
  // Read raw, because this flag is both a switch and a value: `--no-state-branch` turns it off,
  // `--state-branch governance` renames it, and neither optionBoolean nor optionString alone can
  // see both — optionBoolean refuses a string, which is what a named branch is.
  const rawStateBranch = options['state-branch'];
  const stateBranch = rawStateBranch === false
    ? null
    : (typeof rawStateBranch === 'string' && rawStateBranch.trim() ? rawStateBranch.trim() : 'state');

  const result = await bootstrapRepository(url, {
    capabilityId,
    capabilityName: optionString(options, 'name'),
    kind: optionString(options, 'kind', 'collection'),
    jiraProject: optionString(options, 'jira-project'),
    teams: (optionString(options, 'teams') ?? '').split(',').map((team) => team.trim()).filter(Boolean),
    into: optionString(options, 'into'),
    base: optionString(options, 'base'),
    stateBranch,
    grounding: groundingOption(options),
    push: optionBoolean(options, 'push', true)
  });

  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  console.log(`${result.cloned ? 'Cloned' : 'Adopted'} ${result.url} at ${result.root}.`);
  console.log(`  repository   ${result.repositoryId} on ${result.branch}`);
  console.log(`  capability   ${result.capability}`);
  if (result.configurationBranch) {
    console.log(`  configuration ${result.configurationBranch} ${result.configurationCreated ? 'created' : 'already existed'}`);
  }
  if (result.stateBranch) {
    console.log(`  state branch ${result.stateBranch} ${result.ledgerCreated ? 'created' : 'already existed'}`);
  }
  // No pull request, and nothing to merge. The definition lives on the configuration branch, and
  // `start` materializes it into each Story branch, so the application branch is never touched.
  console.log(result.published.configuration
    ? '\nGoverned. Nothing was written to the application branch; start work with singularity-flow start <WORK-ID>.'
    : '\nNot published. Re-run without --no-push to establish the configuration and state branches.');
}

async function knowledgeCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'list';

  if (subcommand === 'record') {
    const result = await recordKnowledge(root, {
      type: requirePositional(positionals, 2, 'knowledge type'),
      // `--detail` is documented and `recordKnowledge` has always accepted it; the CLI simply never
      // passed it, so the text it was meant to contribute was silently dropped. Passing title and
      // detail separately lets `recordKnowledge` compose them as it was written to.
      text: optionString(options, 'text') ?? (positionals.slice(3).join(' ') || null),
      title: optionString(options, 'title'),
      detail: optionString(options, 'detail'),
      provenance: [{
        workId: optionString(options, 'work-id'), artifact: optionString(options, 'artifact'),
        sha256: optionString(options, 'sha256'), approvedRevision: optionNumber(options, 'approved-revision')
      }],
      scope: {
        capabilities: optionStrings(options, 'capability'), repositories: optionStrings(options, 'repository'),
        paths: optionStrings(options, 'path'), environments: optionStrings(options, 'environment')
      }
    });
    if (result.created) commitKnowledge(root, `[knowledge][${result.record.type}] ${result.record.id}`);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`${result.created ? 'Recorded' : 'Already recorded'} ${result.record.type} ${result.record.id}: ${result.record.text}`);
  }

  if (subcommand === 'resolve') {
    const result = await resolveKnowledge(root, requirePositional(positionals, 2, 'knowledge entry hash'), {
      resolution: optionString(options, 'resolution') ?? positionals.slice(3).join(' ')
    });
    commitKnowledge(root, `[knowledge][resolve] ${result.record.supersedes.slice(0, 12)}`);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`Resolved ${result.record.supersedes.slice(0, 12)} as ${result.record.id}: ${result.record.text}`);
  }

  if (subcommand === 'harvest') {
    const initiativeId = optionString(options, 'initiative') ?? branch(root);
    const { portfolio, initiative } = await loadInitiativeAggregate(root, initiativeId);
    const dryRun = optionBoolean(options, 'dry-run');
    const result = await harvestInitiativeKnowledge(root, portfolio, initiative, {
      phaseId: optionString(options, 'phase') ?? null,
      dryRun
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (dryRun) {
      for (const candidate of result.candidates) console.log(`${candidate.type.padEnd(12)} ${candidate.provenance[0].artifact}  ${candidate.text}`);
      return console.log(`\n${result.candidates.length} entr${result.candidates.length === 1 ? 'y' : 'ies'} would be harvested. Re-run without --dry-run to record them.`);
    }
    if (result.harvested.length) commitKnowledge(root, `[${initiativeId}][knowledge][harvest] ${result.harvested.length} entries`);
    for (const entry of result.harvested) console.log(`${entry.record.type.padEnd(12)} ${entry.record.id}  ${entry.record.text}`);
    return console.log(`\nHarvested ${result.harvested.length}; ${result.skipped} already recorded.`);
  }

  if (subcommand === 'show') {
    const wanted = requirePositional(positionals, 2, 'knowledge entry hash');
    const entries = await readKnowledge(root);
    const found = entries.find((entry) => entry.sha256 === wanted || entry.sha256.startsWith(wanted));
    if (!found) throw new SingularityFlowError(`No knowledge entry matches '${wanted}'.`);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(found, null, 2));
    console.log(`${found.record.type} ${found.sha256}`);
    console.log(`\n${found.record.text}`);
    for (const source of found.record.provenance) console.log(`\nFrom ${source.workId}:${source.artifact}@${source.sha256.slice(0, 12)} revision ${source.approvedRevision}`);
    return console.log(`Recorded ${found.record.createdAt} by ${found.record.createdBy ?? 'unknown'}`);
  }

  const entries = filterKnowledge(currentKnowledge(await readKnowledge(root)), {
    type: optionString(options, 'type') ?? null,
    status: optionString(options, 'status') ?? null,
    tag: optionString(options, 'tag') ?? null,
    query: optionString(options, 'query') ?? null
  });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(entries, null, 2));
  if (!entries.length) return console.log('No knowledge entries yet. Harvest an approved initiative with: singularity-flow knowledge harvest');
  for (const { sha256, record } of entries) {
    const scope = Object.entries(record.scope).flatMap(([key, values]) => values.map((value) => `${key}:${value}`)).join(',');
    console.log(`${record.id}  ${record.type.padEnd(12)} ${record.status.padEnd(10)} ${scope.padEnd(28)} ${record.text}`);
  }
  console.log(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`);
}

async function initiativeCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  let portfolio = await loadPortfolio(root);
  let config = await loadConfig(root);
  if (subcommand === 'profiles') {
    const profiles = initiativeProfileChoices(portfolio);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(profiles, null, 2));
    else console.log(table(profiles.map((profile) => ({ id: profile.id, label: profile.label, description: profile.description })), [
      { key: 'id', label: 'PROFILE' }, { key: 'label', label: 'LABEL' }, { key: 'description', label: 'PHASES' }
    ]));
    return;
  }
  if (subcommand === 'choices') return initiativeChoicesCommand(root, config, portfolio, positionals, options);
  if (subcommand === 'start') {
    const initiativeId = requirePositional(positionals, 2, 'initiative ID');
    validateInitiativeId(initiativeId);
    if (!optionBoolean(options, 'allow-dirty')) assertClean(root);
    const receiptToken = optionString(options, 'selection-receipt');
    checkout(root, initiativeId, {
      base: optionString(options, 'base', config.defaultBaseBranch),
      fetch: optionBoolean(options, 'fetch'),
      remote: config.git?.remote ?? 'origin'
    });
    // The materialized Initiative branch owns its lifecycle contract. Resolve the selection receipt,
    // profile, starting phase and agent only after switching, so a profile newly published to the
    // configured remote is selectable and stale local main cannot pin an older contract.
    portfolio = await loadPortfolio(root);
    config = await loadConfig(root);
    const choiceSets = initiativeStartChoiceSets(portfolio);
    const receipt = receiptToken ? await resolveCustomSelectionReceipt(root, receiptToken, {
      action: 'initiative-start',
      workId: initiativeId,
      choiceSets
    }) : null;
    const profile = await chooseInitiativeProfile(portfolio, receipt?.answers['initiative-profile'] ?? optionString(options, 'profile'));
    const requestedStartPhase = optionString(options, 'start-phase');
    const startPhaseId = requestedStartPhase ?? portfolio.initiativeProfiles[profile].phases[0];
    const selectedAgent = await activateInitiativeAgent(
      root, config, initiativeId, portfolio.initiativePhases[startPhaseId], optionString(options, 'agent') ?? null
    );
    const source = optionBoolean(options, 'jira')
      ? await getIssue(initiativeId)
      : { type: 'manual', id: initiativeId, title: optionString(options, 'title', initiativeId), description: optionString(options, 'description', '') };
    const created = await createInitiative(root, {
      // Enter the lifecycle where the work actually is. The phases before it are recorded as
      // skipped rather than approved — an approval that never happened must never look like one.
      startPhase: startPhaseId,
      id: initiativeId,
      title: optionString(options, 'title', source.title ?? initiativeId),
      profile,
      source,
      agent: selectedAgent.agent,
      capabilityId: optionString(options, 'capability')
    });
    if (profile === 'epic-planning' && source.type === 'jira') {
      await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId: 'epic-intake',
        checkId: 'epic-identity-verified',
        assurance: 'system-verified',
        verificationMethod: 'jira-issue-read',
        source: {
          externalId: source.id ?? source.key ?? initiativeId,
          version: source.updatedAt ?? null,
          observedState: `${source.key ?? initiativeId}: ${source.title ?? initiativeId}`
        },
        agent: selectedAgent.agent
      });
    }
    const started = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, started.portfolio, started.initiative, { type: 'binding' }, `[${initiativeId}][initiative:init] start ${profile}`);
    // Spent once the start has landed. Consumed before the Jira read and the creation, a network
    // failure or any refusal burned the one-shot receipt and a new one was needed to retry.
    if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
    let current = started;
    if (profile === 'epic-planning') {
      const completed = await completeEpicIntake(root, initiativeId, { agent: selectedAgent.agent });
      if (completed.advanced) {
        await commitInitiativeChange(root, completed.portfolio, completed.initiative, { type: 'phase-approved', phaseId: 'epic-intake' }, `[${initiativeId}][epic:intake] sources accepted`);
        current = await loadInitiativeAggregate(root, initiativeId);
      }
    }
    const progress = initiativeProgress(current.initiative);
    // The VS Code intake form runs this with `--json` and parses stdout. Without a JSON branch the
    // parse failed *after* the Initiative had been created, committed and pushed, so the person who
    // clicked Start saw an error for work that had actually succeeded.
    if (optionBoolean(options, 'json')) {
      return console.log(JSON.stringify({
        initiativeId, id: initiativeId, profile, progress, publication
      }, null, 2));
    }
    console.log(`Initiative ${initiativeId} started as ${profile}.`);
    console.log(initiativeFlowText(progress));
    console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
    console.log('Run: singularity-flow epic requirements prepare');
    console.log('In Copilot: /sf-epic-requirements');
    if (profile === 'epic-planning') console.log('Repository world-model generation is deferred until each Jira Story has its canonical branch.');
    return;
  }
  if (subcommand === 'resume') {
    const reference = requirePositional(positionals, 2, 'initiative ID or branch alias');
    const fetch = optionBoolean(options, 'fetch');
    const remote = config.git?.remote ?? 'origin';
    if (fetch) fetchRemote(root, remote);
    const refs = [
      { branch: branch(root), ref: branch(root) },
      ...localBranches(root).map((branchName) => ({ branch: branchName, ref: branchName })),
      ...remoteBranches(root, remote).map((branchName) => ({ branch: branchName, ref: `${remote}/${branchName}` }))
    ];
    const index = await buildRepositorySubjectIndexFromRefs(root, { definition: config, portfolio, refs });
    // A remote ref is the materialization source: resume checks out that exact lifecycle branch.
    // It is not ledger-only evidence and must remain eligible for checkout.
    const resolved = resolveContext(index, { reference, kind: 'initiative' });
    const initiativeId = resolved.id;
    const targetBranch = resolved.selectedBranch;
    if (branch(root) !== targetBranch) assertClean(root);
    checkout(root, targetBranch, { base: config.defaultBaseBranch, fetch, existingOnly: true, remote });
    const loaded = await loadInitiativeAggregate(root, initiativeId);
    const session = await activateInitiativeAgent(
      root, config, initiativeId, loaded.initiative.resolution.phases[loaded.initiative.currentPhase], optionString(options, 'agent') ?? null
    );
    console.log(`Resumed ${initiativeId} at ${loaded.initiative.currentPhase ?? 'complete'} with governed agent ${session.agent}.`);
    console.log(initiativeFlowText(initiativeProgress(loaded.initiative)));
    return;
  }
  if (subcommand === 'list') {
    const initiatives = await listInitiatives(root, portfolio);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(initiatives, null, 2));
    else console.log(table(initiatives, [{ key: 'id', label: 'INITIATIVE' }, { key: 'profile', label: 'PROFILE' }, { key: 'status', label: 'STATUS' }, { key: 'currentPhase', label: 'CURRENT' }]));
    return;
  }
  const acceptsExplicitId = new Set(['status', 'next', 'journey', 'report', 'gate']);
  const initiativeId = optionString(options, 'initiative') ?? (acceptsExplicitId.has(subcommand) && positionals[2] ? positionals[2] : branch(root));
  const loaded = await loadInitiativeAggregate(root, initiativeId, portfolio);
  const initiative = loaded.initiative;
  if (subcommand === 'status') {
    const progress = initiativeProgress(initiative);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ initiative, progress }, null, 2));
    else {
      console.log(`\n${initiative.initiative.id} — ${initiative.initiative.title}`);
      console.log(`Profile: ${initiative.initiative.profileLabel} · Status: ${initiative.status} · Current: ${initiative.currentPhase ?? 'complete'}`);
      console.log(`${initiativeFlowText(progress)}\n${progress.percentage}% complete`);
    }
    return;
  }
  if (subcommand === 'restart') {
    const confirmed = await confirmInitiativeExact(
      `Restarting ${initiativeId} returns it to its first phase and discards this attempt's artifacts. The branch, Epic identity, and pinned sources are kept; Story-branch world models are not changed.`,
      initiativeId,
      options
    );
    if (!confirmed) throw new SingularityFlowError('Restart was not confirmed.');
    const session = await loadSession(root, { required: false });
    const result = await restartInitiative(root, initiativeId, {
      reason: optionString(options, 'reason') ?? null,
      agent: session?.agent ?? null
    });
    const state = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, state.portfolio, state.initiative, { type: 'configuration-changed', phaseId: state.initiative.currentPhase }, `[${initiativeId}][initiative:restart] back to ${state.initiative.currentPhase}`);
    console.log(`${initiativeId} restarted at ${state.initiative.currentPhase}. ${result.removed.length} artifact${result.removed.length === 1 ? '' : 's'} discarded; Epic branch and sources kept, Story-branch world models unchanged. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'applicability') {
    const state = initiativeApplicabilityState(portfolio, initiative);
    if (positionals[2] !== 'set') {
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(state, null, 2));
      for (const policy of state) {
        const answer = policy.answered ? (policy.applicable ? 'applicable' : 'not applicable') : 'unanswered';
        console.log(`${policy.answered ? (policy.applicable ? '[x]' : '[-]') : '[ ]'} ${policy.id.padEnd(28)} ${answer}`);
        console.log(`    ${policy.question}${policy.reason ? `\n    reason: ${policy.reason}` : ''}`);
      }
      const pending = state.filter((policy) => !policy.answered);
      if (pending.length) console.log(`\nsingularity-flow initiative applicability set ${pending[0].id} yes|no --reason "..."`);
      return;
    }
    const policyId = requirePositional(positionals, 3, 'applicability policy');
    const answer = String(requirePositional(positionals, 4, 'yes or no')).toLowerCase();
    if (!['yes', 'no', 'true', 'false'].includes(answer)) throw new SingularityFlowError(`Answer '${answer}' must be yes or no.`);
    const session = await loadSession(root, { required: false });
    const result = await setInitiativeApplicability(root, initiativeId, policyId, ['yes', 'true'].includes(answer), {
      reason: optionString(options, 'reason') ?? null,
      agent: session?.agent ?? null
    });
    const saved = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, saved.portfolio, saved.initiative, { type: 'configuration-changed', phaseId: saved.initiative.currentPhase, payload: { policyId } }, `[${initiativeId}][initiative:applicability] ${policyId}`);
    if (optionBoolean(options, 'json')) {
      return console.log(JSON.stringify({ policyId, applicable: result.applicable, publication }, null, 2));
    }
    console.log(`${result.policy.label} is ${result.applicable ? 'applicable' : 'not applicable'} to ${initiativeId}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'outputs') {
    const phaseId = positionals[2] ?? initiative.currentPhase;
    const available = availableInitiativeOutputs(portfolio, initiative, phaseId);
    const include = optionString(options, 'include');
    if (include === undefined) {
      // Listing is the default: choosing outputs blind is how an Epic loses one it needed.
      for (const output of available) {
        const included = initiativeOutputRequired(initiative, phaseId, output);
        console.log(`${included ? '[x]' : '[ ]'} ${output.id.padEnd(28)} ${output.required === false ? 'optional' : 'required'}  ${output.label}`);
      }
      console.log(`\nsingularity-flow initiative outputs ${phaseId} --include ${available.filter((output) => initiativeOutputRequired(initiative, phaseId, output)).map((output) => output.id).join(',')} --reason "..."`);
      return;
    }
    const session = await loadSession(root, { required: false });
    const result = await selectInitiativePhaseOutputs(root, initiativeId, phaseId, include.split(',').map((value) => value.trim()).filter(Boolean), {
      reason: optionString(options, 'reason') ?? null,
      agent: session?.agent ?? null
    });
    const state = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, state.portfolio, state.initiative, { type: 'configuration-changed', phaseId, payload: { selection: 'outputs' } }, `[${initiativeId}][initiative:${phaseId}][outputs] select`);
    console.log(`${phaseId} will produce ${result.included.join(', ') || 'nothing'}${result.adopted.length ? ` (adopted ${result.adopted.join(', ')})` : ''}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'phase') {
    const publish = positionals[2] === 'publish';
    const phaseId = publish ? positionals[3] ?? initiative.currentPhase : positionals[2] ?? initiative.currentPhase;
    const session = await loadSession(root, { required: false });
    if (publish) {
      const context = await verifyInitiativeContext(root, portfolio, initiative, phaseId);
      context.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
      if (!context.valid) throw new SingularityFlowError(`Cannot publish ${phaseId}:\n- ${context.errors.join('\n- ')}`);
      // Traceability verification and its evidence now live in publishInitiativePhase, so the CLI
      // and the VS Code extension record the same thing. They used to live here, which is why publishing
      // from the editor left blocking gates unsatisfied and the phase impossible to approve.
      const result = await publishInitiativePhase(root, initiativeId, phaseId, { agent: session?.agent ?? null });
      const generationPublication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'artifact-generated', phaseId, generation: result.phase.generation }, `[${initiativeId}][initiative:${phaseId}][generated:${result.phase.generation}] publish`);
      // A governed handle must name bytes which already exist in an immutable Git revision. Publish
      // the generation first, then register its handles in a small atomic follow-up publication.
      // This avoids prospective or synthetic commit identifiers and keeps every handle reproducible.
      const referenceState = await loadInitiativeAggregate(root, initiativeId);
      const referencePhase = referenceState.initiative.phases[phaseId];
      const references = await registerInitiativePhaseReferences(root, config, referenceState.initiative, referencePhase, generationPublication.sha);
      let referencePublication = null;
      if (references.length) {
        await saveInitiativeDraft(root, referenceState.portfolio, referenceState.initiative);
        referencePublication = await commitInitiativeChange(
          root,
          referenceState.portfolio,
          referenceState.initiative,
          { type: 'configuration-changed', phaseId, generation: referencePhase.generation, payload: { references: references.map((entry) => entry.handle) } },
          `[${initiativeId}][initiative:${phaseId}][references:${referencePhase.generation}] register governed handles`
        );
      }
      console.log(`Published ${phaseId} generation ${result.phase.generation}. Commit ${generationPublication.sha.slice(0, 8)}${generationPublication.pushed ? ' pushed' : ''}.`);
      if (referencePublication) console.log(`Registered ${references.length} governed reference(s). Commit ${referencePublication.sha.slice(0, 8)}${referencePublication.pushed ? ' pushed' : ''}.`);
    } else {
      const context = await composeInitiativeContext(root, initiativeId, phaseId, { agent: session?.agent ?? null });
      const result = await prepareInitiativePhase(root, initiativeId, phaseId, { agent: session?.agent ?? null });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'artifact-generated', phaseId, generation: result.initiative.phases[phaseId].generation }, `[${initiativeId}][initiative:${phaseId}][prepare] outputs`);
      console.log(`Prepared ${result.outputs.length} ${phaseId} documents. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
      console.log(`Governed Copilot prompt: ${context.record.promptPath} (${context.record.renderedSha256.slice(0, 12)})`);
      context.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
      result.outputs.forEach((document) => {
        const detail = document.awaitingUpload
          ? 'awaiting upload'
          : `${document.sha256.slice(0, 12)}, ${document.bytes} bytes`;
        console.log(`- ${document.id}: ${document.path} (${detail})`);
      });
    }
    return;
  }
  if (subcommand === 'context') {
    const phaseId = positionals[2] ?? initiative.currentPhase;
    const session = await loadSession(root, { required: false });
    const result = await composeInitiativeContext(root, initiativeId, phaseId, {
      agent: optionString(options, 'agent') ?? session?.agent ?? null,
      dryRun: optionBoolean(options, 'dry-run')
    });
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result.record, null, 2));
    else process.stdout.write(result.rendered);
    return;
  }
  if (subcommand === 'documents') {
    const phaseId = positionals[2] ?? initiative.currentPhase ?? initiative.phaseOrder.at(-1);
    const records = Object.values(initiative.phases[phaseId]?.outputs ?? {});
    const documents = await Promise.all(records.map(async (record) => {
      const target = await secureInitiativePath(root, portfolio, initiativeId, record.path, {
        label: `Initiative document '${phaseId}/${record.id}'`,
        type: 'file'
      });
      const renderable = ['markdown', 'yaml', 'interface-contract'].includes(record.kind);
      return {
        ...record,
        repositoryPath: target.relative,
        content: renderable && target.exists ? await readFile(target.absolute, 'utf8') : null,
        exists: target.exists
      };
    }));
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(documents, null, 2));
    else for (const document of documents) {
      console.log(`\n--- BEGIN ${document.repositoryPath} ---`);
      console.log(document.content
        ?? (document.exists
          ? `[binary bundle: ${document.bytes} bytes, sha256 ${document.sha256 ?? 'not recorded'}]`
          : document.status === 'awaiting_upload' ? '[awaiting upload]' : '[not generated]'));
      console.log(`--- END ${document.repositoryPath} ---`);
    }
    return;
  }
  if (subcommand === 'checklist' || subcommand === 'verify') {
    const phaseId = positionals[2] ?? initiative.currentPhase ?? initiative.phaseOrder.at(-1);
    const gate = await evaluateInitiativePhase(root, portfolio, initiative, phaseId);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(gate, null, 2));
    else {
      console.log(table(gate.checklist, [{ key: 'id', label: 'CHECK' }, { key: 'requirement', label: 'REQUIREMENT' }, { key: 'status', label: 'STATUS' }, { key: 'gate', label: 'GATE' }]));
      gate.errors.forEach((error) => console.log(`BLOCK: ${error}`));
      gate.warnings.forEach((warning) => console.log(`WARN: ${warning}`));
    }
    if (subcommand === 'verify' && !gate.ready) process.exitCode = 2;
    return;
  }
  if (subcommand === 'evidence') {
    const action = positionals[2] ?? 'list';
    if (action === 'add') {
      const checkId = requirePositional(positionals, 3, 'checklist ID');
      const phaseId = optionString(options, 'phase', initiative.currentPhase);
      const session = await loadSession(root, { required: false });
      const appended = await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId,
        checkId,
        assurance: optionString(options, 'assurance'),
        verificationMethod: optionString(options, 'verification'),
        source: {
          path: optionString(options, 'path'),
          url: optionString(options, 'url'),
          externalId: optionString(options, 'external-id'),
          observedState: optionString(options, 'observed-state'),
          version: optionString(options, 'source-version')
        },
        agent: session?.agent ?? null,
        decision: optionString(options, 'decision'),
        reason: optionString(options, 'reason'),
        supersedes: optionStrings(options, 'supersedes')
      });
      const fresh = await loadInitiativeAggregate(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'evidence-recorded', phaseId, payload: { checkId } }, `[${initiativeId}][initiative:${phaseId}][evidence] ${checkId}`, { appendOnly: true });
      console.log(`Evidence ${appended.sha256.slice(0, 12)} committed ${publication.sha.slice(0, 8)}${publication.pushed ? ' and pushed' : ''}.`);
      return;
    }
    if (action === 'list') {
      const records = await readInitiativeRecords(root, portfolio, initiativeId, 'evidence');
      const checkId = positionals[3];
      const selected = checkId ? records.filter((entry) => entry.record.check === checkId) : records;
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(selected, null, 2));
      else console.log(table(selected.map((entry) => ({ hash: entry.sha256.slice(0, 12), phase: entry.record.phase, check: entry.record.check, assurance: entry.record.assurance, observed: entry.record.observedAt })), [
        { key: 'hash', label: 'HASH' }, { key: 'phase', label: 'PHASE' }, { key: 'check', label: 'CHECK' }, { key: 'assurance', label: 'ASSURANCE' }, { key: 'observed', label: 'OBSERVED' }
      ]));
      return;
    }
    throw new SingularityFlowError(`Unknown initiative evidence action '${action}'.`);
  }
  if (subcommand === 'approve') {
    const subject = positionals[2] ?? 'phase';
    const phaseId = initiative.currentPhase;
    // Planning approval is a first-class CLI operation. It retains the explicit acknowledgement
    // that approving your own work is not independent review, so the governance property is
    // identical wherever the approval happens. Exact confirmation is enforced below; the phase
    // agent is activated automatically.
    const approvalActor = String(identity(root).email ?? '').toLowerCase();
    const selfApproval = Boolean(approvalActor) && Object.values(initiative.phases[phaseId]?.outputs ?? {})
      .some((output) => String(output.generatedBy?.email ?? '').toLowerCase() === approvalActor);
    if (selfApproval && !optionBoolean(options, 'acknowledge-self-approval')) {
      throw new SingularityFlowError(
        `${approvalActor} generated an output in '${phaseId}', so approving it is self-approval and is not independent review. `
        + 'Re-run with --acknowledge-self-approval to record it as such.'
      );
    }
    const receiptToken = optionString(options, 'selection-receipt');
    const bundle = await initiativeBundle(root, portfolio, initiative, phaseId);
    const expected = `${phaseId}:${subject}`;
    const choiceSets = [{ id: 'decision-confirmation', label: 'Exact approval confirmation', options: [{ id: expected, label: `Approve ${expected}`, description: `Approves the exact current hash for ${subject}.` }] }];
    const receipt = receiptToken ? await resolveCustomSelectionReceipt(root, receiptToken, {
      action: 'initiative-approve',
      workId: initiativeId,
      choiceSets,
      context: { phase: phaseId, subject, bundleSha256: bundle.sha256 }
    }) : null;
    const session = await activateInitiativeAgent(
      root, config, initiativeId, initiative.resolution.phases[phaseId], optionString(options, 'agent') ?? null
    );
    if (!receipt && !(await confirmInitiativeExact(`Approve exact initiative subject ${expected}?`, expected, options))) throw new SingularityFlowError('Initiative approval cancelled.');
    const result = await approveInitiative(root, { initiativeId, phaseId, subject, agent: session.agent, channel: receipt ? 'copilot-selection-receipt' : 'terminal' });
    // Knowledge harvested by this approval is committed with it. Two commits would let one land
    // without the other, and leaving it unstaged left the working tree dirty — which the next
    // governed command refuses outright, since every one of them starts from a clean checkout.
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'phase-approved', phaseId, agent: session?.agent ?? null, payload: { approvalSubject: subject } }, `[${initiativeId}][initiative:${phaseId}][approve] ${subject}`, {
      extraPaths: result.knowledge?.harvested?.length ? [KNOWLEDGE_ROOT] : []
    });
    // Spent once the approval has landed, not before it is attempted.
    if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
    console.log(`Approved ${phaseId}:${subject}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    if (result.knowledge?.harvested?.length) {
      console.log(`Recorded ${result.knowledge.harvested.length} knowledge ${result.knowledge.harvested.length === 1 ? 'entry' : 'entries'} from the editorroved artifacts.`);
    }
    if (result.knowledge?.error) console.warn(`Warning: knowledge harvest failed and was skipped: ${result.knowledge.error}`);
    if (result.selfApproval) console.warn('Warning: this is a self-approval and is not independent review.');
    if (result.next) console.log(`Current phase: ${result.next}`);
    else if (result.initiative.status === 'complete') console.log('Initiative complete.');
    formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
    return;
  }
  if (subcommand === 'reject') {
    const subject = positionals[2] ?? 'phase';
    const session = await loadSession(root, { required: false });
    const result = await rejectInitiative(root, { initiativeId, subject, reason: optionString(options, 'reason'), agent: session?.agent ?? null });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'phase-rejected', phaseId: result.target.phaseId ?? result.initiative.currentPhase, payload: { targetType: result.target.type, targetId: result.target.id } }, `[${initiativeId}][initiative:${result.target.type}][reject] ${result.target.id}`);
    console.log(`Rejected ${result.target.type}/${result.target.id}; invalidated ${result.invalidation.affected.length} dependent nodes. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'breakdown') {
    const review = await initiativeBreakdownReview(root, initiativeId, { probe: optionBoolean(options, 'probe') });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(review, null, 2));
    else {
      console.log(`${review.initiativeId}: ${review.epics} epics, ${review.stories.length} repository stories`);
      console.log(table(review.stories, [{ key: 'id', label: 'STORY' }, { key: 'epicId', label: 'EPIC' }, { key: 'repository', label: 'REPOSITORY' }, { key: 'blocking', label: 'BLOCKING' }]));
    }
    return;
  }
  if (subcommand === 'jira-adopt') {
    const epicKey = requirePositional(positionals, 2, 'Jira Epic key');
    const repositoryMap = repositoryMappings(options);
    if (optionBoolean(options, 'dry-run')) {
      const preview = await previewJiraAdoption(root, initiativeId, epicKey, { repositoryMap });
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(preview, null, 2));
      else {
        console.log(`Jira Epic ${epicKey}: ${preview.draft.epics[0].stories.length} child stories.`);
        console.log(table(preview.draft.epics[0].stories, [
          { key: 'id', label: 'WORK ID' }, { key: 'jiraKey', label: 'JIRA ID' },
          { key: 'repository', label: 'REPOSITORY' }, { key: 'title', label: 'SUMMARY' }
        ]));
        if (preview.unresolved.length) console.warn(`Repository mapping required: ${preview.unresolved.map((story) => story.jiraKey).join(', ')}`);
      }
      return;
    }
    const result = await adoptJiraEpic(root, initiativeId, epicKey, {
      repositoryMap,
      replace: optionBoolean(options, 'replace'),
      actor: identity(root).email?.toLowerCase() ?? identity(root).name
    });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'adopt', epicKey } }, `[${initiativeId}][initiative:jira-adopt] ${epicKey}`);
    console.log(`Adopted ${epicKey} as ${result.breakdown.epics.length} Epic and ${result.breakdown.stories.length} stories.`);
    console.log(`Source snapshot: ${result.sourceSha256.slice(0, 12)} · Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'jira-plan') {
    const result = await createJiraWritePlan(root, initiativeId);
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'plan', planSha256: result.plan.sha256 } }, `[${initiativeId}][initiative:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify({ plan: result.plan, publication }, null, 2));
    else {
      console.log(`Jira write plan ${result.plan.sha256} contains ${result.plan.operations.length} operations.`);
      console.log(table(result.plan.operations.map((operation) => ({
        id: operation.id,
        action: operation.action,
        target: operation.subject.jiraKey ?? operation.subject.id,
        fields: Object.keys(operation.fields ?? operation.issue ?? {}).join(', ')
      })), [
        { key: 'id', label: 'OPERATION' }, { key: 'action', label: 'ACTION' },
        { key: 'target', label: 'TARGET' }, { key: 'fields', label: 'FIELDS' }
      ]));
      console.log(`Committed ${publication.sha.slice(0, 8)}${publication.pushed ? ' and pushed' : ''}. Review the plan before applying it.`);
    }
    return;
  }
  if (subcommand === 'jira-apply') {
    const planSha256 = optionString(options, 'plan');
    if (!planSha256) throw new SingularityFlowError('jira-apply requires --plan with the exact reviewed write-plan SHA-256.');
    if (!(await confirmInitiativeExact(`Apply reviewed Jira plan ${planSha256} for ${initiativeId}?`, initiativeId, options))) throw new SingularityFlowError('Jira apply cancelled.');
    const result = await applyJiraWritePlan(root, initiativeId, {
      planSha256,
      confirmation: initiativeId,
      actor: identity(root).email?.toLowerCase() ?? identity(root).name
    });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'apply', planSha256 } }, `[${initiativeId}][initiative:jira-apply] ${planSha256.slice(0, 12)}`);
    console.log(`Applied ${result.results.length} Jira operations. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    result.results.forEach((receipt) => console.log(`- ${receipt.operationId}: ${receipt.jiraKey}`));
    return;
  }
  if (subcommand === 'materialize') {
    if (optionBoolean(options, 'dry-run')) {
      const preview = await materializeInitiative(root, initiativeId, { dryRun: true });
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(preview, null, 2));
      else console.log(`Would materialize ${preview.review.stories.length} stories across ${Object.keys(preview.review.repositories).length} repositories.`);
      return;
    }
    if (!(await confirmInitiativeExact(`Materialize every reviewed repository story for ${initiativeId}?`, initiativeId, options))) throw new SingularityFlowError('Initiative materialization cancelled.');
    const result = await materializeInitiative(root, initiativeId, { confirmation: initiativeId });
    const fresh = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'external-synchronized', payload: { operation: 'materialize', status: result.attempt.status } }, `[${initiativeId}][initiative:materialize] ${result.attempt.status}`);
    console.log(`Materialization ${result.attempt.status}: ${result.attempt.stories.length - result.failures.length}/${result.attempt.stories.length} ready. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    result.failures.forEach((failure) => console.warn(`- ${failure.storyId}: ${failure.error}`));
    return;
  }
  if (subcommand === 'sync') {
    const pending = await syncInitiativePublication(root, portfolio, initiative);
    const result = await syncInitiativeRepositories(root, initiativeId);
    const fresh = await loadInitiativeAggregate(root, initiativeId);
    const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'external-synchronized', payload: { operation: 'repository-sync' } }, `[${initiativeId}][initiative:sync] repository evidence`);
    console.log(`Synchronized ${result.results.filter((item) => item.status === 'synchronized').length}/${result.results.length} stories. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.${pending.pushed ? ` Retried ${pending.pushed.slice(0, 8)} first.` : ''}`);
    return;
  }
  if (subcommand === 'contracts') {
    if (positionals[2] === 'add') {
      const session = await loadSession(root, { required: false });
      const result = await registerInterfaceContract(root, {
        initiativeId,
        contractId: optionString(options, 'id'),
        version: optionString(options, 'version'),
        format: optionString(options, 'format'),
        sourcePath: optionString(options, 'path'),
        producers: optionStrings(options, 'producer'),
        consumers: optionStrings(options, 'consumer'),
        compatibilityPolicy: optionString(options, 'compatibility', 'explicit-review'),
        agent: session?.agent ?? null
      });
      const fresh = await loadInitiativeAggregate(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'artifact-generated', payload: { contractId: result.contract.id, contractVersion: result.contract.version } }, `[${initiativeId}][initiative:contract] ${result.contract.id}@${result.contract.version}`);
      console.log(`Registered ${result.contract.id}@${result.contract.version} (${result.contract.sha256.slice(0, 12)}). Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
      return;
    }
    const contracts = await interfaceContractStatus(root, initiativeId);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(contracts, null, 2));
    else console.log(table(contracts, [{ key: 'key', label: 'CONTRACT' }, { key: 'format', label: 'FORMAT' }, { key: 'integrity', label: 'INTEGRITY' }, { key: 'status', label: 'STATUS' }]));
    return;
  }
  if (subcommand === 'report') {
    const reportId = positionals[2] ?? initiativeId;
    const report = await deriveInitiativeReport(root, reportId);
    const format = optionString(options, 'format', 'md');
    const rendered = format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderInitiativeReport(report);
    const target = optionString(options, 'out');
    if (target) {
      await writeText(path.resolve(root, target), rendered);
      console.log(`Initiative report written to ${path.resolve(root, target)}`);
    } else process.stdout.write(rendered);
    return;
  }
  if (subcommand === 'next') {
    const actions = await initiativeNextActions(root, initiativeId);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(actions, null, 2));
    else actions.forEach((action, index) => console.log(`${index + 1}. ${action.action}\n   Copilot: ${action.skill}\n   Run: ${action.command}\n   ${action.reason}`));
    return;
  }
  if (subcommand === 'journey') {
    const actions = await initiativeNextActions(root, initiativeId);
    const journey = epicJourney(initiative, actions);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(journey, null, 2));
    else {
      console.log(`${journey.stageLabel} · ${journey.completionPercent}% complete`);
      console.log(`Next: ${journey.nextAction.label}`);
      if (journey.nextAction.command) console.log(`Command: ${journey.nextAction.command}`);
      if (journey.nextAction.reason) console.log(journey.nextAction.reason);
    }
    return;
  }
  if (subcommand === 'gate') {
    const result = await runInitiativeGate(root, positionals[2] ?? initiativeId, { terminal: optionBoolean(options, 'terminal') });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      result.passes.forEach((message) => console.log(`PASS: ${message}`));
      result.warnings.forEach((message) => console.warn(`WARN: ${message}`));
      result.errors.forEach((message) => console.error(`ERROR: ${message}`));
    }
    if (!result.valid) process.exitCode = 2;
    return;
  }
  throw new SingularityFlowError(`Unknown initiative subcommand '${subcommand}'.`);
}

async function editorCommand(positionals, options, namespace = 'configuration') {
  const subcommand = requirePositional(positionals, 1, `${namespace} subcommand`);
  const root = repoRoot();
  let result;
  if (subcommand === 'snapshot') result = await repositorySnapshot(root, positionals[2], optionString(options, 'initiative'));
  else if (subcommand === 'validate') result = await validateEditorConfiguration(root);
  else if (subcommand === 'save') result = await saveConfigurationFile(
    root,
    requirePositional(positionals, 2, 'configuration path'),
    await stdinText(),
    { expectedSha256: optionString(options, 'expected-sha256') }
  );
  else if (subcommand === 'read') result = await readConfigurationFile(root, requirePositional(positionals, 2, 'configuration path'));
  else if (subcommand === 'export-bundle') result = await exportConfigurationBundle(root);
  else if (subcommand === 'delete-file') result = await deleteConfigurationFile(root, requirePositional(positionals, 2, 'configuration path'));
  else if (subcommand === 'delete-template') result = await deleteConfigurationTemplate(root, requirePositional(positionals, 2, 'template path'));
  else if (subcommand === 'publish') result = await publishEditorConfiguration(root, optionString(options, 'message'));
  else if (subcommand === 'portfolio-bootstrap') {
    let input = {};
    const text = await stdinText();
    if (text.trim()) {
      try { input = JSON.parse(text); } catch (error) { throw new SingularityFlowError(`Portfolio bootstrap input must be JSON: ${error.message}`); }
    }
    result = await bootstrapWorkspacePortfolio(root, input);
  }
  else if (subcommand === 'session') result = await selectEditorAgent(root, optionString(options, 'work-id'), requirePositional(positionals, 2, 'agent'));
  else if (subcommand === 'planning-context') result = await createPlanningContext(root, {
    scope: optionString(options, 'scope'),
    id: optionString(options, 'id'),
    phase: optionString(options, 'phase'),
    agent: optionString(options, 'agent'),
    target: optionString(options, 'target'),
    objective: optionString(options, 'objective', '')
  });
  else if (subcommand === 'planning-promote') {
    // stdin carries either the single reviewed artifact, or a JSON set from a phase-scoped
    // session: [{ outputId, content }]. The set form is how one conversation promotes every
    // artifact of a phase in a single governed commit.
    const input = await stdinText();
    let artifacts = null;
    if (optionBoolean(options, 'set')) {
      try { artifacts = JSON.parse(input); }
      catch (error) { throw new SingularityFlowError(`Artifact set is not valid JSON: ${error.message}`); }
      if (!Array.isArray(artifacts)) throw new SingularityFlowError('Artifact set must be a JSON array of { outputId, content }.');
    }
    result = artifacts
      ? await promotePlanningArtifacts(root, { sessionId: optionString(options, 'session'), agent: optionString(options, 'agent'), artifacts })
      : await promotePlanningArtifact(root, { sessionId: optionString(options, 'session'), agent: optionString(options, 'agent'), content: input });
  }
  else if (subcommand === 'initiative-materialize-preview') {
    const initiativeId = optionString(options, 'initiative');
    result = await materializeInitiative(root, initiativeId, { dryRun: true });
  }
  else if (subcommand === 'initiative-materialize') {
    const initiativeId = optionString(options, 'initiative');
    const confirmation = optionString(options, 'confirm');
    const before = await loadInitiativeAggregate(root, initiativeId);
    if (before.initiative.lineage?.idAuthority === 'local') {
      await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId: 'epic-publish',
        checkId: 'jira-permission-verified',
        assurance: 'machine-verified',
        verificationMethod: 'local-identity-authority',
        source: {
          externalId: initiativeId,
          version: before.initiative.resolution.resolutionSha256,
          observedState: 'Pinned local identity authority requires no Jira credentials'
        }
      });
    }
    result = await materializeInitiative(root, initiativeId, { confirmation });
    if (!result.failures.length) {
      await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId: 'epic-publish',
        checkId: 'stories-materialized',
        assurance: 'machine-verified',
        verificationMethod: before.initiative.lineage?.idAuthority === 'jira'
          ? 'jira-and-git-receipt-integrity'
          : 'git-receipt-integrity',
        source: {
          externalId: initiativeId,
          version: result.attempt.completedAt,
          observedState: `${result.attempt.stories.length} canonical Story branches and governed seeds published`
        }
      });
      if (before.initiative.resolution.profile === 'epic-planning') {
        result.completion = await completeEpicPublication(root, initiativeId);
      }
    }
    const fresh = await loadInitiativeAggregate(root, initiativeId);
    result.publication = await commitInitiativeChange(
      root,
      fresh.portfolio,
      fresh.initiative,
      { type: 'external-synchronized', payload: { operation: 'materialize', status: result.attempt.status } },
      `[${initiativeId}][initiative:materialize] ${result.attempt.status}`
    );
  }
  else if (subcommand === 'initiative-sync') {
    const initiativeId = optionString(options, 'initiative');
    const freshBefore = await loadInitiativeAggregate(root, initiativeId);
    const pendingPublication = await syncInitiativePublication(root, freshBefore.portfolio, freshBefore.initiative);
    result = await syncInitiativeRepositories(root, initiativeId);
    const fresh = await loadInitiativeAggregate(root, initiativeId);
    result.publication = await commitInitiativeChange(
      root,
      fresh.portfolio,
      fresh.initiative,
      { type: 'external-synchronized', payload: { operation: 'repository-sync' } },
      `[${initiativeId}][initiative:sync] repository evidence`
    );
    result.pendingPublication = pendingPublication;
  }
  else throw new SingularityFlowError(`Unknown ${namespace} subcommand: ${subcommand}`);
  console.log(JSON.stringify(result, null, 2));
}

async function promptLogCommand(positionals, options) {
  const root = repoRoot();
  const action = positionals[1] ?? 'status';
  let result;
  if (action === 'on' || action === 'off') {
    result = await setPromptAudit(root, action === 'on');
  } else if (action === 'status') {
    result = await promptAuditStatus(root);
  } else if (action === 'list') {
    result = await listPromptAudits(root, {
      agent: optionString(options, 'agent'),
      phase: optionString(options, 'phase'),
      workId: optionString(options, 'work-id'),
      limit: optionNumber(options, 'limit', 100),
      includePrompt: optionBoolean(options, 'include-prompt')
    });
  } else if (action === 'view') {
    result = await readPromptAudit(root, positionals[2] ?? 'latest');
  } else {
    throw new SingularityFlowError(`Unknown prompt-log action '${action}'. Use on, off, status, list, or view.`);
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  if (action === 'view') return process.stdout.write(`${result.record.prompt}${result.record.prompt.endsWith('\n') ? '' : '\n'}`);
  if (action === 'list') {
    if (!result.records.length) return console.log(`Prompt audit is ${result.enabled ? 'on' : 'off'}; no governed prompts have been captured.`);
    return console.log(table(result.records.map((record) => ({
      time: record.recordedAt, agent: record.agent, story: record.workId ?? '—', phase: record.phase,
      generation: record.generation ?? '—', id: record.id
    })), [
      { key: 'time', label: 'TIME' }, { key: 'agent', label: 'AGENT' },
      { key: 'story', label: 'STORY' }, { key: 'phase', label: 'PHASE' },
      { key: 'generation', label: 'GEN' }, { key: 'id', label: 'RECORD' }
    ]));
  }
  console.log(`Prompt audit: ${result.enabled ? 'on' : 'off'} · ${result.count} record(s) · ${result.scope} scope`);
  console.log(`File: ${result.logFile}`);
  if (action === 'on') console.log('Future governed prompts composed for Copilot will be captured. Existing prompts are not backfilled.');
}

async function snapshotCommand(positionals, options) {
  const root = repoRoot();
  const included = optionStrings(options, 'include');
  const timings = optionBoolean(options, 'timings');
  const result = await new SnapshotCoordinator(root).capture(
    ({ included: requested }) => repositorySnapshot(
      root,
      positionals[1],
      optionString(options, 'initiative'),
      { included: requested }
    ),
    {
      included: included.length ? included : undefined,
      ifRevision: optionString(options, 'if-revision'),
      timings,
      // See `src/commands/snapshot.mjs`: this is the read model every view in the extension shares,
      // and a background write must not empty all of them at once.
      consistency: 'best-effort'
    }
  );
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(JSON.stringify(result, null, 2));
    writeHumanTimings(result.timings);
  }
}

async function stateCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'planes';
  const reference = positionals[2] ?? optionString(options, 'subject') ?? branch(root);
  const definition = await loadConfig(root);
  const portfolio = await loadPortfolio(root).catch(() => null);
  const common = {
    definition,
    portfolio,
    reference,
    kind: optionString(options, 'kind'),
    offline: optionBoolean(options, 'offline', true)
  };
  if (subcommand === 'planes') {
    console.log(JSON.stringify(await inspectStatePlanes(root, common), null, 2));
    return;
  }
  if (subcommand !== 'reconcile') {
    throw new SingularityFlowError(`Unknown state subcommand '${subcommand}'. Use state planes or state reconcile.`);
  }
  const repair = optionBoolean(options, 'repair-projections');
  const result = await reconcileStateProjections(root, { ...common, repair });
  if (repair && result.repaired) {
    const subject = result.planes.subject;
    const repairedPaths = result.repairedPaths ?? [result.repairedPath].filter(Boolean);
    const event = {
      type: 'projection-reconciled',
      phaseId: null,
      generation: null,
      payload: { projections: repairedPaths }
    };
    if (subject.kind === 'story') {
      const store = new StoryStateStore(root, definition);
      const workflow = await store.loadAggregate(subject.id);
      result.publication = await store.publish(
        workflow,
        event,
        `[${subject.id}][state:reconcile] Repair derived projections`,
        repairedPaths
      );
    } else {
      const store = new InitiativeStateStore(root, portfolio);
      const initiative = await store.loadAggregate(subject.id);
      result.publication = await store.publish(
        initiative,
        event,
        `[${subject.id}][state:reconcile] Repair derived projections`,
        { extraPaths: repairedPaths }
      );
    }
    result.planes = await inspectStatePlanes(root, common);
  }
  console.log(JSON.stringify(result, null, 2));
}

function optionMap(values, label, { allowEmpty = false } = {}) {
  const result = {};
  for (const value of values) {
    const split = String(value).indexOf('=');
    if (split <= 0 || (!allowEmpty && split === String(value).length - 1)) {
      throw new SingularityFlowError(`${label} must use ID=VALUE.`);
    }
    const key = String(value).slice(0, split).trim();
    const entry = String(value).slice(split + 1).trim();
    if (!key || (!allowEmpty && !entry)) throw new SingularityFlowError(`${label} must use ID=VALUE.`);
    result[key] = entry;
  }
  return result;
}

async function storyMutationOptions(options) {
  const changes = {};
  for (const key of ['title', 'description', 'repository', 'specification']) {
    const value = optionString(options, key);
    if (value != null) changes[key] = value;
  }
  const workflow = optionString(options, 'workflow');
  if (workflow != null) changes.suggestedWorkType = workflow;
  if (options.blocking != null) changes.blocking = optionBoolean(options, 'blocking');
  for (const [option, key] of [['requirements', 'requirements'], ['acceptance-criteria', 'acceptanceCriteria'], ['depends-on', 'dependsOn']]) {
    const value = optionString(options, option);
    if (value != null) changes[key] = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  const metadata = optionStrings(options, 'metadata');
  if (metadata.length) changes.metadata = optionMap(metadata, 'Story metadata');
  const tasksFile = optionString(options, 'tasks-file');
  if (tasksFile) {
    const absolute = path.resolve(tasksFile);
    const contents = await readFile(absolute, 'utf8');
    const parsed = YAML.parse(contents);
    if (!Array.isArray(parsed)) throw new SingularityFlowError('--tasks-file must contain a YAML or JSON array of Story tasks.');
    changes.tasks = parsed;
  }
  return changes;
}

function storyByPlanId(breakdown, initiativeId, planId) {
  const story = breakdown.stories.find((entry) => entry.planId === planId);
  if (!story) throw new SingularityFlowError(`Epic '${initiativeId}' has no Story '${planId}'.`);
  return story;
}

function nextTaskId(tasks = []) {
  const highest = tasks.reduce((maximum, task) => {
    const match = String(task.id ?? '').match(/^TASK-(\d+)$/);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return `TASK-${String(highest + 1).padStart(3, '0')}`;
}

function taskMutationOptions(options, current = {}) {
  const result = structuredClone(current);
  for (const key of ['title', 'description']) {
    const value = optionString(options, key);
    if (value != null) result[key] = value;
  }
  const acceptance = optionString(options, 'acceptance-criteria');
  if (acceptance != null) {
    result.acceptanceCriteria = acceptance.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  const metadata = optionStrings(options, 'metadata');
  if (metadata.length) result.metadata = { ...(result.metadata ?? {}), ...optionMap(metadata, 'Task metadata') };
  result.description ??= '';
  result.acceptanceCriteria ??= [];
  result.metadata ??= {};
  return result;
}

async function publishEpicStoryUpdate(root, initiativeId, planId, changes, detail) {
  const updated = await updateEpicStory(root, initiativeId, planId, changes);
  const publication = await commitInitiativeChange(
    root,
    updated.portfolio,
    updated.initiative,
    { type: 'artifact-generated', phaseId: updated.initiative.currentPhase, payload: { planId, operation: detail } },
    `[${initiativeId}][epic:story] ${detail}`
  );
  return { updated, publication };
}

function epicReviewChoiceDefinition(review, decision) {
  const storyId = review.story.workId ?? review.story.jiraKey ?? review.story.planId ?? review.story.id;
  const packetSha256 = review.packet.packetSha256;
  const confirmation = `${decision}:${storyId}:${packetSha256}`;
  if (!review.approval.availableAgents.length || !review.approval.defaultAgent) {
    throw new SingularityFlowError(`No governed agent is configured for phase '${review.approval.phase}'.`);
  }
  const choiceSets = [];
  if (decision === 'reject') {
    choiceSets.push({
      id: 'reject-target',
      label: 'Return to phase',
      options: review.approval.rejectTo.map((phase) => ({
        id: phase,
        label: phase,
        description: `Invalidate this packet and return the Story to ${phase}.`
      }))
    });
  }
  choiceSets.push({
    id: 'decision-confirmation',
    label: 'Exact packet confirmation',
    options: [{
      id: confirmation,
      label: `${decision === 'approve' ? 'Approve' : 'Reject'} ${storyId}`,
      description: `Bind the decision to review packet ${packetSha256}.`
    }]
  });
  return {
    action: `epic-review-${decision}`,
    workId: storyId,
    choiceSets,
    context: {
      initiativeId: review.initiativeId,
      storyId,
      phase: review.approval.phase,
      sourceCommit: review.packet.sourceCommit,
      packetSha256,
      decision
    },
    confirmation
  };
}

async function chooseFromOptions(label, entries) {
  if (!entries.length) throw new SingularityFlowError(`${label} has no configured options.`);
  if (!input.isTTY || !output.isTTY) {
    throw new SingularityFlowError(`${label} requires an interactive terminal or a Copilot selection receipt.`);
  }
  const io = readline.createInterface({ input, output });
  try {
    console.log(`\n${label}`);
    entries.forEach((entry, index) => console.log(`  ${index + 1}. ${entry.label} (${entry.id})`));
    const selected = Number((await io.question(`Enter 1-${entries.length}: `)).trim()) - 1;
    if (!Number.isInteger(selected) || !entries[selected]) throw new SingularityFlowError(`Invalid ${label.toLowerCase()} selection.`);
    return entries[selected].id;
  } finally {
    io.close();
  }
}

function renderWorkspaceStatus(status) {
  console.log(`\n${status.workspace.anchor.key} — ${status.workspace.anchor.title}`);
  console.log(`Workspace: ${status.workspace.path}`);
  console.log(`Jira: ${status.workspace.anchor.issueTypeName} · level ${status.workspace.anchor.hierarchyLevel} · ${status.workspace.anchor.siteId}`);
  console.log(`Lead repository: ${status.leadRepositoryPath}`);
  console.log(table(status.repositories.map((repository) => ({
    id: repository.id,
    role: repository.role,
    state: repository.state,
    branch: repository.branch ?? '—',
    dirty: repository.dirty == null ? '—' : repository.dirty ? 'yes' : 'no'
  })), [
    { key: 'id', label: 'REPOSITORY' },
    { key: 'role', label: 'ROLE' },
    { key: 'state', label: 'STATE' },
    { key: 'branch', label: 'BRANCH' },
    { key: 'dirty', label: 'DIRTY' }
  ]));
  console.log(`Staged documents: ${status.counts.stagedDocuments} (not governed)`);
}

function renderWorkspaceMaterialization(result) {
  for (const repository of result.materialization ?? result.repair ?? []) {
    if (!repository.fallbackUsed) continue;
    console.log(`  ${repository.repository}: the remote did not establish the requested partial clone; used the explicitly configured full-clone fallback.`);
  }
}

/**
 * `sflow secrets scan` / `sflow secrets protect`.
 *
 * The commit gate refuses without being asked, which is what makes it a control rather than advice.
 * These are the two things a person still needs: to look before they commit, and to extend the same
 * refusal to plain `git commit`, which never enters this CLI at all.
 */
async function secretsCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'scan';
  if (!SECRETS_SUBCOMMANDS.includes(subcommand)) {
    throw new SingularityFlowError(`Unknown secrets subcommand '${subcommand}'. Use ${SECRETS_SUBCOMMANDS.join(' or ')}.`);
  }
  const root = repoRoot();
  const { scanEntries, secretRefusal } = await import('./secrets.mjs');

  if (subcommand === 'protect') {
    const hookPath = path.join(gitDir(root), 'hooks', 'pre-commit');
    /**
     * A hook, not a wrapper. It runs for `git commit` however it is invoked — terminal, editor,
     * another tool — which is the whole reason it exists; a check that only fires when someone
     * remembers to type a command is documentation.
     *
     * `--staged` matters: the hook must judge what is staged, not what is on disk. A file cleaned in
     * the editor after staging would otherwise pass with the credential still in the index.
     */
    /**
     * Resolve the CLI, do not assume it is on PATH.
     *
     * The first version of this hook was `exec sflow secrets scan --staged`, which failed closed for
     * the wrong reason on any machine where `sflow` was not installed globally: every commit broke
     * with `sflow: not found`, and the developer's only clue pointed at a tool they never installed.
     * Failing closed is right; failing closed illegibly teaches people to pass --no-verify.
     *
     * The CLI that installed the hook wins, and PATH is the fallback. The other order looks more
     * accommodating and is wrong: a stale global `sflow` shadows the one the person actually chose,
     * and if it predates this command every commit is refused with `Unknown command 'secrets'` —
     * observed, not hypothesised. A governance control should run the exact thing it was installed
     * from; picking up upgrades is not worth being at the mercy of whatever is first on PATH.
     */
    const installedFrom = path.resolve(fileURLToPath(import.meta.url), '..', '..', 'bin', 'singularity-flow.mjs');
    const script = [
      '#!/bin/sh',
      '# Installed by `sflow secrets protect`. Refuses a commit containing a credential.',
      '# Bypass in a genuine emergency with `git commit --no-verify`; the governed commit path',
      '# checks again and cannot be bypassed that way.',
      `if [ -f ${JSON.stringify(installedFrom)} ]; then`,
      `  exec node ${JSON.stringify(installedFrom)} secrets scan --staged`,
      'elif command -v sflow >/dev/null 2>&1; then',
      '  exec sflow secrets scan --staged',
      'else',
      '  echo "singularity-flow: the secret check cannot run — sflow is not on PATH and" >&2',
      `  echo "${installedFrom} is missing. Reinstall, or re-run \\\`sflow secrets protect\\\`." >&2`,
      '  exit 1',
      'fi',
      ''
    ].join('\n');
    const existing = existsSync(hookPath) ? await readFile(hookPath, 'utf8') : null;
    if (existing && !existing.includes('sflow secrets scan') && !optionBoolean(options, 'force')) {
      throw new SingularityFlowError(
        `${hookPath} already exists and was not written by Singularity Flow. `
        + 'Add `sflow secrets scan --staged` to it, or re-run with --force to replace it.',
        { code: 'SECRET_HOOK_EXISTS' }
      );
    }
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeText(hookPath, script);
    chmodSync(hookPath, 0o755);
    const result = { resultType: 'secret-protection', schemaVersion: 1, hook: hookPath, installed: true, replaced: Boolean(existing) };
    const narration = commandResult({
      operation: { id: 'secrets.protect', classification: 'mutation' },
      outcome: succeeded('secrets.protected', { hook: hookPath }),
      effects: effects({ filesChanged: true }),
      restState: 'informational',
      data: result
    });
    if (!optionBoolean(options, 'json')) {
      console.log(`\`git commit\` now refuses a commit containing a credential.`);
    }
    emitCommandResult(narration, { json: optionBoolean(options, 'json') });
    return result;
  }

  // `--staged` judges the index, which is what a commit will use. Without it, the working tree.
  const staged = optionBoolean(options, 'staged');
  const listed = staged
    ? run('git', ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'], { cwd: root }).stdout.split('\0').filter(Boolean)
    : run('git', ['ls-files', '-z'], { cwd: root }).stdout.split('\0').filter(Boolean);

  const entries = [];
  for (const item of listed) {
    if (staged) {
      const show = run('git', ['show', `:${item}`], { cwd: root, allowFailure: true });
      if (show.status === 0) entries.push({ path: item, content: show.stdout });
      continue;
    }
    try { entries.push({ path: item, content: await readFile(path.resolve(root, item), 'utf8') }); }
    catch (error) { if (error?.code !== 'ENOENT') entries.push({ path: item }); }
  }

  const scan = scanEntries(entries);
  const scope = staged ? 'staged' : 'tracked';
  const slots = { scanned: scan.scanned, scope, blocking: scan.blocking.length };
  const narration = commandResult({
    operation: { id: 'secrets.scan', classification: 'read' },
    // A scan that finds something has not failed — it did its job. `noop` with the detected message
    // keeps "the command worked" and "the commit must not proceed" as separate facts; the exit code
    // below is what stops the commit.
    outcome: scan.blocking.length ? noop('secrets.detected', slots) : succeeded('secrets.clean', slots),
    effects: noEffects(),
    restState: 'informational',
    data: { ...scan, scope }
  });
  if (!optionBoolean(options, 'json')) {
    // The detail goes to stderr, where the pre-commit hook shows it, and where it cannot be piped
    // into something that records it by accident.
    const refusal = secretRefusal(scan);
    if (refusal) console.error(refusal);
    else if (scan.waived.length) console.log(`${scan.waived.length} waived finding(s) were allowed.`);
  }
  emitCommandResult(narration, { json: optionBoolean(options, 'json') });
  // Non-zero so the pre-commit hook refuses, and so CI does.
  if (scan.blocking.length) process.exitCode = 1;
  return scan;
}

function renderWorkspaceBootstrap(session) {
  console.log(`\nWorkspace bootstrap ${session.bootstrapId} · ${session.status}`);
  console.log(`Workspace: ${session.plan?.workspace?.name ?? session.request?.workspaceName ?? 'unresolved'} (${session.plan?.workspace?.id ?? 'unresolved'})`);
  if (session.plan?.workspace?.targetPath) console.log(`Target: ${session.plan.workspace.targetPath}`);
  if (session.preflight) {
    console.log(`Preflight: ${session.preflight.ready ? 'ready' : 'blocked'} · ${session.preflight.checkedAt}`);
    for (const finding of session.preflight.findings ?? []) {
      console.log(`  ${finding.severity === 'blocker' ? 'blocked' : 'warning'}: ${finding.message}`);
      if (finding.action) console.log(`    ${finding.action}`);
    }
  }
  if (session.fault) console.log(`Recovery: ${session.fault.message}`);
  if (session.workspaceJournal?.path) console.log(`Journal: ${session.workspaceJournal.path}`);
  if (session.nextAction?.command) console.log(`Next CLI step: ${session.nextAction.command}`);
  if (session.nextAction?.skill) console.log(`Copilot: ${session.nextAction.skill}`);
}

async function workspaceBootstrapInput(source, options) {
  const baseDirectory = optionString(
    options, 'base', process.env.SINGULARITY_FLOW_WORKSPACE_ROOT || path.join(os.homedir(), 'Singularity Workspaces')
  );
  const resolvedSource = path.resolve(source);
  const sourceInfo = await lstat(resolvedSource).catch(() => null);
  if (sourceInfo?.isFile()) {
    const parsed = YAML.parse(await readFile(resolvedSource, 'utf8')) ?? {};
    const manifest = parsed.workspace ?? parsed;
    if (manifest.version === 1 && manifest.anchor && manifest.repositories) {
      const id = optionString(options, 'id') ?? manifest.id ?? manifest.anchor?.key;
      if (!id) throw new SingularityFlowError('The workspace manifest does not identify a workspace.');
      return {
        source: { kind: 'manifest', reference: resolvedSource },
        createInput: {
          baseDirectory: optionString(options, 'base')
            ?? (manifest.path ? path.dirname(path.resolve(manifest.path)) : baseDirectory),
          id,
          name: optionString(options, 'name') ?? manifest.name ?? id,
          leadRepository: manifest.leadRepository,
          capabilities: manifest.capabilities ?? [],
          repositories: manifest.repositories
        },
        inferDefaultRepositories: []
      };
    }
    if (manifest.id && manifest.repositories && manifest.leadRepository) {
      return {
        source: { kind: 'manifest', reference: resolvedSource },
        createInput: {
          ...manifest,
          baseDirectory: optionString(options, 'base') ?? manifest.baseDirectory ?? baseDirectory,
          name: optionString(options, 'name') ?? manifest.name ?? manifest.id
        },
        inferDefaultRepositories: []
      };
    }
    throw new SingularityFlowError(
      'A workspace bootstrap manifest must be a workspace.json document or contain id, leadRepository, and repositories.'
    );
  }

  const chosen = optionStrings(options, 'capability');
  if (chosen.length) {
    const organisation = await readOrganisation(source);
    const derived = resolveWorkspacePlan(organisation, {
      capabilities: chosen,
      leadCapability: optionString(options, 'lead-capability')
    });
    await rememberLeadRepository(source);
    const id = optionString(options, 'id');
    if (!id) throw new SingularityFlowError('workspace prepare for capabilities requires --id.');
    return {
      source: { kind: 'organisation', reference: source },
      createInput: {
        baseDirectory,
        id,
        name: optionString(options, 'name') ?? id,
        leadRepository: derived.leadRepository,
        capabilities: derived.capabilities,
        repositories: derived.repositories
      },
      inferDefaultRepositories: []
    };
  }

  const id = optionString(options, 'id');
  if (!id) throw new SingularityFlowError('workspace prepare requires --id for a repository URL.');
  const repositoryId = optionString(options, 'repository-id') ?? repositoryIdFromUrl(source);
  const explicitBranch = optionString(options, 'branch');
  const sparseCone = optionStrings(options, 'sparse-cone');
  const cloneMode = optionString(options, 'clone-mode', sparseCone.length ? 'blobless-sparse' : 'full');
  const cloneFallback = optionString(options, 'clone-fallback', 'refuse');
  return {
    source: { kind: 'remote', reference: source },
    createInput: {
      baseDirectory,
      id,
      name: optionString(options, 'name') ?? id,
      leadRepository: repositoryId,
      capabilities: [],
      repositories: {
        [repositoryId]: {
          url: source,
          defaultBranch: explicitBranch ?? 'main',
          required: true,
          path: `repos/${repositoryId}`,
          clone: { mode: cloneMode, sparseCone, fallback: cloneFallback }
        }
      }
    },
    inferDefaultRepositories: explicitBranch ? [] : [repositoryId]
  };
}

async function workspaceCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'list';
  const registry = workspaceRegistryFile();
  const selectionFile = activeWorkspaceFile();
  const compatibility = await discardUnsupportedWorkflowWorkspaces(registry, selectionFile);
  if (subcommand === 'prepare') {
    const source = requirePositional(positionals, 2, 'repository URL or workspace manifest');
    const input = await workspaceBootstrapInput(source, options);
    const { prepareWorkspaceBootstrap } = await import('./workspace-bootstrap.mjs');
    const session = await prepareWorkspaceBootstrap({
      ...input,
      initialize: optionBoolean(options, 'initialize'),
      stateBranch: optionString(options, 'state-branch', 'state')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(session, null, 2));
    renderWorkspaceBootstrap(session);
    return session;
  }
  if (subcommand === 'bootstrap') {
    const action = positionals[2] ?? 'status';
    const {
      abandonWorkspaceBootstrap, listWorkspaceBootstraps, readWorkspaceBootstrap,
      resumeWorkspaceBootstrap
    } = await import('./workspace-bootstrap.mjs');
    if (action === 'status') {
      const id = positionals[3] ?? null;
      const result = id ? await readWorkspaceBootstrap(id) : await listWorkspaceBootstraps();
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      if (Array.isArray(result)) {
        if (!result.length) return console.log('No workspace bootstrap sessions have been recorded.');
        result.forEach(renderWorkspaceBootstrap);
      } else renderWorkspaceBootstrap(result);
      return result;
    }
    if (action === 'resume') {
      const id = requirePositional(positionals, 3, 'bootstrap ID');
      const result = await resumeWorkspaceBootstrap(id, { confirmation: optionString(options, 'confirm') });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      renderWorkspaceBootstrap(result);
      return result;
    }
    if (action === 'abandon') {
      const id = requirePositional(positionals, 3, 'bootstrap ID');
      const result = await abandonWorkspaceBootstrap(id, { reason: optionString(options, 'reason') });
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      renderWorkspaceBootstrap(result);
      return result;
    }
    throw new SingularityFlowError("workspace bootstrap supports 'status', 'resume', and 'abandon'.");
  }
  if (subcommand === 'doctor') {
    const { workspaceBootstrapDoctor } = await import('./workspace-bootstrap.mjs');
    const result = await workspaceBootstrapDoctor({ network: optionBoolean(options, 'network') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Workspace reliability: ${result.healthy ? 'healthy' : 'needs attention'}`);
    for (const item of result.machine.findings) console.log(`  ${item.severity}: ${item.message}`);
    for (const item of result.remotes) {
      console.log(`  ${item.repository}: ${item.ok ? 'reachable' : item.classification}`);
      if (item.advice) console.log(`    ${item.advice}`);
    }
    if (!result.networkChecked) console.log('Network remotes were not contacted. Add --network to test pending bootstrap remotes.');
    for (const session of result.sessions) console.log(`  ${session.bootstrapId}: ${session.status} · ${session.workspaceName ?? session.workspaceId}`);
    return result;
  }
  /**
   * The base branches on offer for a capability, and which repositories publish each.
   *
   * Read-only and separate from `start` because the editor cannot answer an interactive prompt: it
   * has to render the choice itself, which means asking what the choices are before committing to
   * one. Not folded into the repository snapshot — it is several `ls-remote` calls over the network,
   * and the snapshot is read on every refresh.
   */
  if (subcommand === 'branches') {
    const root = repoRoot();
    const definition = await loadConfig(root);
    const {
      storyBaseCatalog, storyBaseForRepository, preflightStoryRepositories
    } = await import('./capability-start.mjs');
    const catalog = await storyBaseCatalog(root, {
      remote: definition.git?.remote ?? 'origin',
      defaultBranch: definition.defaultBaseBranch,
      capabilityId: optionString(options, 'capability')
    });
    const storyId = optionString(options, 'preflight-story');
    let preflight = null;
    if (storyId) {
      validateId(definition, storyId);
      const selected = await storyBaseForRepository(root, {
        values: optionStrings(options, 'from-branch'),
        interactive: false,
        remote: definition.git?.remote ?? 'origin',
        defaultBranch: definition.defaultBaseBranch,
        capabilityId: optionString(options, 'capability')
      });
      const repositories = await preflightStoryRepositories(
        selected.workspaceRoot, selected.plan, storyId,
        {
          remote: selected.remote,
          publishRequired: (definition.git?.publish ?? 'required') !== 'off',
          lifecycleRoot: root,
          capabilityId: selected.capability
        }
      );
      preflight = {
        passed: true,
        storyBranch: storyId,
        remote: selected.remote,
        destinationRef: `refs/heads/${storyId}`,
        repositories: repositories.map((entry) => ({
          repository: entry.repository,
          remote: entry.remote,
          baseBranch: entry.baseBranch,
          baseCommit: entry.baseCommit,
          destinationRef: entry.destinationRef,
          publishRequired: entry.publishRequired
        }))
      };
    }
    const result = {
      resultType: 'capability-branches',
      schemaVersion: 2,
      scope: catalog.scope,
      selectionRequired: true,
      remote: catalog.remote,
      capability: catalog.capability,
      repositories: catalog.repositories.map((repository) => ({
        id: repository.id, defaultBranch: repository.defaultBranch
      })),
      // Reported rather than thrown: the editor should render the branches it does know about and
      // say which repositories it could not reach, not show an empty list or an error dialog.
      unreachable: catalog.unreachable,
      choices: catalog.choices,
      preflight
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(catalog.scope === 'capability'
      ? `Base branches for capability '${catalog.capability}' (${catalog.repositories.length} repositories):`
      : `Base branches for repository '${catalog.repositoryId}' on '${catalog.remote}':`);
    for (const choice of result.choices) {
      console.log(`  ${choice.branch.padEnd(28)} ${choice.everywhere ? `all ${choice.total}` : `${choice.present} of ${choice.total}`}`
        + (choice.missingFrom.length ? ` — missing from ${choice.missingFrom.join(', ')}` : ''));
    }
    for (const entry of catalog.unreachable) console.warn(`Warning: could not read ${entry.repository} (${entry.url || catalog.remote}).`);
    return result;
  }
  if (subcommand === 'prune') {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(compatibility, null, 2));
    if (!compatibility.removed.length) return console.log('All saved workspaces use workflow version 2 or are not initialized yet.');
    for (const workspace of compatibility.removed) {
      console.log(`Forgot ${workspace.name} (${workspace.path}): ${workspace.reason}. Files were not deleted.`);
    }
    return;
  }
  if (subcommand === 'list') {
    const workspaces = await readWorkspaceRegistry(registry);
    const active = await readActiveWorkspaceContext(selectionFile, registry, { refresh: false }).catch(() => null);
    const result = workspaces.map((workspace) => {
      // Matched on both, because the registry de-duplicates by path and two workspaces created with
      // the same --id in different directories therefore both keep that id. Matching on the id
      // alone marked every one of them as the one being worked in, which is the one question this
      // column exists to answer.
      const selected = workspace.id === active?.workspaceId
        && (!active?.workspacePath || path.resolve(workspace.path) === path.resolve(active.workspacePath));
      return {
        ...workspace,
        active: selected ? 'yes' : '',
        // Selection and readiness are different facts. Surfaces need both or a missing clone gets a
        // green "working here" badge while every repository-backed view is necessarily empty.
        repositoryState: selected ? active?.repositoryState ?? null : null
      };
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(table(result, [
      { key: 'active', label: 'ACTIVE' },
      { key: 'anchorKey', label: 'JIRA' },
      { key: 'anchorType', label: 'TYPE' },
      { key: 'name', label: 'WORKSPACE' },
      { key: 'path', label: 'PATH' }
    ]));
  }
  if (subcommand === 'current' || subcommand === 'prompt') {
    const current = await readActiveWorkspaceContext(selectionFile, registry);
    if (!current) {
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ active: false }, null, 2));
      if (subcommand === 'prompt') return console.log('');
      return console.log('No active workspace. Run singularity-flow workspace use <WORKSPACE>.');
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ active: true, ...current }, null, 2));
    if (subcommand === 'prompt') return console.log(workspacePromptLabel(current));
    console.log(`\n${workspacePromptLabel(current)}`);
    console.log(`Workspace: ${current.workspacePath}`);
    console.log(`Repository: ${current.repositoryId} · ${current.repositoryPath}`);
    console.log(`Branch: ${current.branch ?? '—'}`);
    console.log(`Story: ${current.storyId ?? '—'}`);
    return;
  }
  if (['use', 'switch'].includes(subcommand)) {
    const context = await activateWorkspaceContext(registry, selectionFile, positionals[2], {
      repositoryId: optionString(options, 'repository'),
      storyId: optionString(options, 'story')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(context, null, 2));
    console.log(`\nActive context: ${workspacePromptLabel(context)}`);
    console.log(`Repository: ${context.repositoryPath}`);
    if (context.repositoryState !== 'ready') {
      console.log(`Repository state: ${context.repositoryState}. Run workspace repair before starting Copilot.`);
    }
    console.log(`Start Copilot here: singularity-flow workspace copilot`);
    console.log(`Shell directory: cd ${JSON.stringify(context.repositoryPath)}`);
    return;
  }
  if (subcommand === 'copilot') {
    const reference = positionals[2];
    const repositoryId = optionString(options, 'repository');
    const storyId = optionString(options, 'story');
    let context;
    if (reference || repositoryId || storyId) {
      const active = reference ? null : await readActiveWorkspaceContext(selectionFile, registry, { refresh: false });
      context = await activateWorkspaceContext(registry, selectionFile, reference ?? active?.workspaceId, {
        repositoryId: repositoryId ?? active?.repositoryId,
        storyId: storyId ?? active?.storyId
      });
    } else {
      context = await readActiveWorkspaceContext(selectionFile, registry);
      if (!context) context = await activateWorkspaceContext(registry, selectionFile, null);
    }
    if (context.repositoryState !== 'ready') {
      throw new SingularityFlowError(`Repository '${context.repositoryId}' is ${context.repositoryState}; repair or clone it before starting Copilot.`);
    }
    const mode = optionString(options, 'mode', 'interactive');
    if (!['interactive', 'plan'].includes(mode)) throw new SingularityFlowError('--mode must be interactive or plan.');
    const sessionName = `${context.workspaceName}${context.storyId ? ` · ${context.storyId}` : ''}`.slice(0, 120);
    const args = ['-C', context.repositoryPath, '--name', sessionName];
    if (mode === 'plan') args.push('--mode', 'plan');
    const launch = {
      command: 'copilot',
      args,
      cwd: context.repositoryPath,
      prompt: workspacePromptLabel(context),
      workspace: context.workspaceName,
      repository: context.repositoryId,
      story: context.storyId
    };
    let preparedTelemetry = await prepareTelemetryLaunch({
      root: context.repositoryPath,
      story: context.storyId,
      provider: 'github-copilot',
      runtime: 'copilot-cli',
      host: optionString(options, 'host', 'cli'),
      surface: optionString(options, 'surface', 'cli.workspace-copilot'),
      baseEnv: process.env
    });
    if (optionBoolean(options, 'dry-run')) {
      const prepared = await launchHostSession({
        cwd: context.repositoryPath, args, story: context.storyId,
        host: optionString(options, 'host', 'cli'),
        surface: optionString(options, 'surface', 'cli.workspace-copilot'),
        preparedTelemetry, dryRun: true
      });
      return console.log(JSON.stringify({ ...launch, telemetry: prepared.telemetry }, null, 2));
    }
    if (preparedTelemetry.captureStatus === 'disclosure-required') {
      console.log(`\n${TELEMETRY_DISCLOSURE}`);
      let accepted = false;
      if (input.isTTY && output.isTTY) {
        accepted = await confirmExact('Enable metadata-only local usage capture for SFlow-owned sessions?', TELEMETRY_DISCLOSURE_CONFIRMATION);
      }
      if (accepted) {
        await setTelemetryCapture(true, { acceptDisclosure: true });
        preparedTelemetry = await prepareTelemetryLaunch({
          root: context.repositoryPath,
          story: context.storyId,
          provider: 'github-copilot',
          runtime: 'copilot-cli',
          host: optionString(options, 'host', 'cli'),
          surface: optionString(options, 'surface', 'cli.workspace-copilot'),
          baseEnv: process.env
        });
      } else console.log('Usage unavailable for this session. Your work can continue.');
    }
    for (const notice of preparedTelemetry.notices) {
      if (notice !== TELEMETRY_DISCLOSURE) console.log(`Telemetry: ${notice}`);
    }
    console.log(`\n${launch.prompt}`);
    console.log(`Starting GitHub Copilot in ${context.repositoryPath}`);
    await launchHostSession({
      cwd: context.repositoryPath, args, story: context.storyId,
      host: optionString(options, 'host', 'cli'),
      surface: optionString(options, 'surface', 'cli.workspace-copilot'),
      preparedTelemetry
    });
    return;
  }
  if (subcommand === 'create') {
    // A workspace does not need a tracker to exist. The local anchor was already implemented but
    // exposed through the same public CLI so Jira-less teams can create one from any client.
    if (optionBoolean(options, 'local')) {
      const workspaceId = optionString(options, 'id');
      if (!workspaceId) throw new SingularityFlowError('workspace create --local requires --id.');
      const localUrls = optionMap(optionStrings(options, 'repository'), '--repository');
      const localBranches = optionMap(optionStrings(options, 'default-branch'), '--default-branch');
      // A workspace is capabilities and a working directory. When an organisation is named, the
      // repositories are what those capabilities deliver from — derived rather than listed, because
      // listing them again is a second place for the same fact to be wrong. Naming repositories
      // directly stays supported for a repository that has no capability map yet.
      const organisationUrl = optionString(options, 'organisation');
      const chosen = optionStrings(options, 'capability');
      let derived = null;
      if (organisationUrl) {
        derived = resolveWorkspacePlan(await readOrganisation(organisationUrl), {
          capabilities: chosen,
          leadCapability: optionString(options, 'lead-capability')
        });
        await rememberLeadRepository(organisationUrl);
      }

      const localInput = {
        baseDirectory: optionString(options, 'base', process.env.SINGULARITY_FLOW_WORKSPACE_ROOT || path.join(os.homedir(), 'Singularity Workspaces')),
        id: workspaceId,
        name: optionString(options, 'name') ?? workspaceId,
        leadRepository: derived?.leadRepository ?? optionString(options, 'lead'),
        capabilities: derived?.capabilities ?? chosen,
        repositories: derived?.repositories
          ?? Object.fromEntries(Object.entries(localUrls).map(([id, url]) => [id, {
            url,
            defaultBranch: localBranches[id] ?? 'main',
            required: true,
            path: `repos/${id}`
          }]))
      };
      if (optionBoolean(options, 'dry-run')) return console.log(JSON.stringify(previewWorkspaceConfiguration(localInput), null, 2));
      const localResult = await createWorkspaceConfiguration(localInput, {
        confirmation: optionString(options, 'confirm'),
        clone: optionBoolean(options, 'clone', true)
      });
      await rememberWorkspace(registry, localResult.workspace, localResult.status);

      // Initialising the workspace is what creates the governed state branch, in the repository the
      // lead capability ships from. Done here rather than by whoever called this, so the CLI and the
      // editor cannot drift into creating it in different places — or, as the editor did, quietly
      // skipping it for a repository that was not governed yet.
      let state = null;
      if (optionBoolean(options, 'clone', true) && localResult.workspace.leadRepository) {
        const lead = localResult.workspace.repositories?.[localResult.workspace.leadRepository];
        try {
          state = await initializeWorkspaceState(lead
            ? workspaceRepositoryPath(localResult.workspace, lead)
            : path.join(localResult.workspace.path, `repos/${localResult.workspace.leadRepository}`), {
            branch: optionString(options, 'state-branch', 'state')
          });
        } catch (error) {
          // A workspace that exists with no state branch is recoverable; refusing to report the
          // workspace that was just cloned is not.
          state = { error: error.message };
        }
      }

      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ ...localResult, state }, null, 2));
      console.log(`Workspace ${localResult.created ? 'created' : 'resumed'} at ${localResult.workspace.path}.`);
      if (state?.error) console.log(`  the ${optionString(options, 'state-branch', 'state')} branch was not created: ${state.error}`);
      else if (state?.created) console.log(`  created the ${state.branch} branch in ${localResult.workspace.leadRepository}`);
      else if (state) console.log(`  the ${state.branch} branch is already in ${localResult.workspace.leadRepository}`);
      if (state?.pinRepair && !state.pinRepair.valid) {
        console.warn('  source-pin recovery remains incomplete; run singularity-flow ledger repair --dry-run in the lead repository.');
      }
      renderWorkspaceMaterialization(localResult);
      return renderWorkspaceStatus(localResult.status);
    }
    const jiraKey = optionString(options, 'jira');
    if (!jiraKey) throw new SingularityFlowError('workspace create requires --jira KEY, or --local --id ID for a workspace with no tracker.');
    let hierarchy;
    try { hierarchy = await getIssueHierarchy(jiraKey); }
    catch (error) {
      const hierarchyLevel = optionNumber(options, 'hierarchy-level');
      if (!hierarchyLevel) throw new SingularityFlowError(`${error.message} To create offline, also supply --hierarchy-level, --issue-type, --title, and --site.`);
      hierarchy = {
        anchor: {
          key: jiraKey,
          title: optionString(options, 'title', jiraKey),
          issueType: optionString(options, 'issue-type', hierarchyLevel === 1 ? 'Epic' : 'Jira parent'),
          hierarchyLevel,
          issueTypeId: optionString(options, 'issue-type-id'),
          url: optionString(options, 'jira-url'),
          fetchedAt: new Date().toISOString()
        }
      };
    }
    const repositoryUrls = optionMap(optionStrings(options, 'repository'), '--repository');
    const branches = optionMap(optionStrings(options, 'default-branch'), '--default-branch');
    const repositories = Object.fromEntries(Object.entries(repositoryUrls).map(([id, url]) => [id, {
      url,
      defaultBranch: branches[id] ?? 'main',
      required: true,
      path: `repos/${id}`
    }]));
    const leadRepository = optionString(options, 'lead');
    const input = {
      baseDirectory: optionString(options, 'base', process.env.SINGULARITY_FLOW_WORKSPACE_ROOT || path.join(os.homedir(), 'Singularity Workspaces')),
      anchor: {
        provider: 'jira',
        siteId: optionString(options, 'site'),
        baseUrl: optionString(options, 'jira-url') || process.env.JIRA_BASE_URL,
        key: hierarchy.anchor.key,
        issueId: hierarchy.anchor.id,
        issueTypeId: hierarchy.anchor.issueTypeId,
        issueTypeName: hierarchy.anchor.issueType,
        hierarchyLevel: hierarchy.anchor.hierarchyLevel,
        title: hierarchy.anchor.title,
        url: hierarchy.anchor.url,
        fetchedAt: hierarchy.fetchedAt ?? hierarchy.anchor.fetchedAt
      },
      name: optionString(options, 'name'),
      repositories,
      leadRepository,
      hierarchySnapshot: hierarchy
    };
    const preview = previewWorkspace(input);
    if (optionBoolean(options, 'dry-run')) return console.log(JSON.stringify(preview, null, 2));
    const confirmation = optionString(options, 'confirm');
    const result = await createWorkspace(input, { confirmation, clone: optionBoolean(options, 'clone', true) });
    await rememberWorkspace(registry, result.workspace, result.status);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Workspace ${result.created ? 'created' : 'resumed'} at ${result.workspace.path}.`);
    renderWorkspaceMaterialization(result);
    return renderWorkspaceStatus(result.status);
  }
  if (subcommand === 'impact') {
    const action = positionals[2] ?? 'list';
    const workspacePath = requirePositional(positionals, 3, 'workspace directory');
    if (action === 'analyze') {
      const descriptionFile = optionString(options, 'description-file');
      const description = descriptionFile
        ? await readFile(path.resolve(descriptionFile), 'utf8')
        : optionString(options, 'description');
      // Resolved from the governed definition the same way every other model call site does, so a
      // repository configured with its own provider executable is honoured here too. Workspace
      // commands can legitimately run outside a governed checkout; the shared default covers that.
      let models = { provider: 'copilot-cli', providerConfig: null, model: null };
      try { models = resolveModelProvider(await loadConfig(repoRoot())); } catch { /* not in a governed repository */ }
      const request = {
        id: optionString(options, 'id'),
        title: optionString(options, 'title'),
        description,
        repositories: optionStrings(options, 'repository'),
        capabilities: optionStrings(options, 'capability'),
        documents: optionStrings(options, 'document'),
        provider: models.provider,
        providerConfig: models.providerConfig,
        model: optionString(options, 'model') ?? models.model
      };
      const result = optionBoolean(options, 'dry-run')
        ? await previewWorkspaceImpact(workspacePath, request)
        : await analyzeWorkspaceImpact(workspacePath, request);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      if (optionBoolean(options, 'dry-run')) {
        console.log(`\nPrepared advisory impact analysis ${result.id}; nothing was written and Copilot was not called.`);
        console.log(`Repositories: ${result.repositories.map((repository) => `${repository.id}@${repository.commit.slice(0, 12)}`).join(', ')}`);
        return;
      }
      console.log(`\nWorkspace impact analysis ${result.id}: ${result.status} · ${result.freshness}`);
      console.log(result.result?.summaryMarkdown ?? 'No summary was produced.');
      return;
    }
    if (action === 'list') {
      const reports = await listWorkspaceImpacts(workspacePath);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(reports, null, 2));
      return console.log(table(reports.map((report) => ({
        id: report.id, title: report.title, status: report.status, freshness: report.freshness,
        createdAt: report.createdAt
      })), [
        { key: 'id', label: 'ANALYSIS' }, { key: 'title', label: 'TITLE' },
        { key: 'status', label: 'STATUS' }, { key: 'freshness', label: 'FRESHNESS' },
        { key: 'createdAt', label: 'CREATED' }
      ]));
    }
    if (action === 'show') {
      const id = requirePositional(positionals, 4, 'impact analysis ID');
      const result = await workspaceImpactStatus(workspacePath, id);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`\n${result.title} · ${result.id} · ${result.freshness}`);
      console.log(result.result?.summaryMarkdown ?? result.failure ?? 'No summary is available.');
      return;
    }
    if (action === 'promote') {
      const id = requirePositional(positionals, 4, 'impact analysis ID');
      const result = await promoteWorkspaceImpact(workspacePath, id);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Staged ${result.document.path} as advisory intake context.`);
      console.log(result.next);
      return;
    }
    throw new SingularityFlowError(`Unknown workspace impact action '${action}'.`);
  }
  const workspacePath = positionals[subcommand === 'documents' && positionals[2] === 'import' ? 3 : 2];
  if (!workspacePath) throw new SingularityFlowError(`workspace ${subcommand} requires a workspace directory.`);
  if (subcommand === 'open') {
    const workspace = await readWorkspace(workspacePath);
    const status = await workspaceStatus(workspace.path);
    await rememberWorkspace(registry, workspace, status);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    return renderWorkspaceStatus(status);
  }
  if (subcommand === 'archive-status') {
    const readiness = await workspaceArchiveReadiness(workspacePath, {
      fetch: optionBoolean(options, 'fetch', true)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(readiness, null, 2));
    console.log(`${readiness.workspace.name}: ${readiness.eligible ? 'ready to archive' : 'cannot be archived'}`);
    if (readiness.activeStories.length) {
      console.log('\nActive Stories:');
      for (const story of readiness.activeStories) {
        console.log(`  ${story.id} · ${story.repository} · ${story.status}${story.phase ? ` · ${story.phase}` : ''}`);
      }
    }
    for (const blocker of readiness.blockers) console.log(`  blocked: ${blocker}`);
    return;
  }
  if (subcommand === 'rename') {
    const name = optionString(options, 'name');
    if (!name?.trim()) throw new SingularityFlowError('workspace rename requires --name TEXT.');
    const renamed = await updateWorkspaceConfiguration(workspacePath, { name: name.trim() }, {
      confirmation: optionString(options, 'confirm')
    });
    await rememberWorkspace(registry, renamed.workspace, renamed.status, { preserveArchived: true });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(renamed, null, 2));
    return console.log(`Renamed workspace to ${renamed.workspace.name}. Governed repository state was not changed.`);
  }
  if (subcommand === 'archive') {
    const archived = await archiveWorkspace(registry, workspacePath, {
      confirmation: optionString(options, 'confirm'),
      fetch: optionBoolean(options, 'fetch', true)
    });
    const clearedSelection = await clearActiveWorkspaceContext(activeWorkspaceFile(), archived.workspace.path);
    const result = { ...archived, clearedSelection };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Archived ${archived.workspace.name}. No active Stories were found; its checkout and artifacts are untouched.`);
    if (clearedSelection) console.log('The active workspace selection was cleared.');
    return console.log('Restore it with singularity-flow workspace restore.');
  }
  if (subcommand === 'restore') {
    const restored = await restoreWorkspace(registry, workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(restored, null, 2));
    return console.log(`Restored ${restored.workspace?.name ?? workspacePath}.`);
  }
  if (subcommand === 'inspect') {
    // What a workspace would record for this checkout, read from the checkout. Lets any surface
    // offer "add the repository I already have" without reimplementing how those values are found.
    // A URL is inspected over the network; a directory is read from the checkout. Both answer the
    // same question — what a workspace would record for this repository.
    const target = requirePositional(positionals, 2, 'repository URL or directory');
    const remote = isCloneTarget(target);
    const defaults = remote
      ? await workspaceRemoteDefaults(target, { stateBranch: optionString(options, 'state-branch', 'state') })
      : await workspaceRepositoryDefaults(target);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(defaults, null, 2));
    console.log(`${defaults.id}`);
    if (defaults.localPath) console.log(`  path:   ${defaults.localPath}`);
    console.log(`  origin: ${defaults.url}\n  branch: ${defaults.defaultBranch}`);
    if (remote) console.log(`  ${defaults.stateBranch}: ${defaults.hasStateBranch ? 'present' : 'not created yet'}`);
    return;
  }
  if (subcommand === 'adopt') {
    const cloneDirectory = requirePositional(positionals, 2, 'existing clone directory');
    const defaults = await workspaceRepositoryDefaults(cloneDirectory);
    const ownership = [];
    for (const entry of await readWorkspaceRegistry(registry)) {
      const workspace = await readWorkspace(entry.path).catch(() => null);
      if (!workspace) continue;
      for (const repository of Object.values(workspace.repositories)) {
        const ownedPath = await realpath(workspaceRepositoryPath(workspace, repository))
          .catch(() => path.resolve(workspaceRepositoryPath(workspace, repository)));
        if (ownedPath === defaults.localPath) {
          ownership.push({ workspaceId: workspace.id, workspacePath: workspace.path, repositoryId: repository.id });
        }
      }
    }
    if (ownership.length) {
      throw new SingularityFlowError(
        `Existing clone '${defaults.localPath}' is already owned by workspace '${ownership[0].workspaceId}'.`,
        { code: 'WORKSPACE_ADOPTION_ALREADY_OWNED', details: { ownership } }
      );
    }
    const id = optionString(options, 'id');
    if (!id) throw new SingularityFlowError('workspace adopt requires --id for the new workspace.');
    const result = await adoptWorkspaceConfiguration({
      cloneDirectory: defaults.localPath,
      id,
      name: optionString(options, 'name'),
      baseDirectory: optionString(options, 'base', process.env.SINGULARITY_FLOW_WORKSPACE_ROOT
        || path.join(os.homedir(), 'Singularity Workspaces')),
      dirtyConfirmation: optionString(options, 'confirm-dirty')
    }, {
      confirmation: optionString(options, 'confirm'),
      dryRun: optionBoolean(options, 'dry-run')
    });
    if (!optionBoolean(options, 'dry-run')) {
      await rememberWorkspace(registry, result.workspace, result.status);
    }
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (optionBoolean(options, 'dry-run')) {
      console.log(`Use existing clone: ${result.plan.repository.localPath}`);
      console.log(`Workspace shell: ${result.plan.workspace.path}`);
      console.log(`Preserved: ${result.plan.preserved.join(', ')}`);
      if (result.plan.dirtyConfirmationRequired) {
        console.log(`Dirty-tree confirmation: --confirm-dirty ${result.plan.dirtyConfirmationRequired}`);
      }
      return console.log(`Create with --confirm ${result.plan.confirmation}`);
    }
    console.log(`Adopted ${defaults.localPath} into workspace ${result.workspace.name}.`);
    console.log('The clone was not fetched, switched, stashed, committed, reset, or cleaned.');
    return;
  }
  if (subcommand === 'duplicate') {
    // A workspace is local and disposable, so copying one is an ordinary thing to want: the same
    // capabilities and repositories, somewhere else to work on them.
    const sourcePath = requirePositional(positionals, 2, 'workspace directory');
    const newId = optionString(options, 'id');
    if (!newId) throw new SingularityFlowError('workspace duplicate requires --id for the copy.');
    const copied = await duplicateWorkspaceConfiguration(sourcePath, {
      id: newId,
      name: optionString(options, 'name'),
      baseDirectory: optionString(options, 'base')
    }, { clone: optionBoolean(options, 'clone', true) });
    await rememberWorkspace(registry, copied.workspace, copied.status);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(copied, null, 2));
    console.log(`Workspace ${newId} copied from ${sourcePath} to ${copied.workspace.path}.`);
    return renderWorkspaceStatus(copied.status);
  }

  if (subcommand === 'capabilities') {
    // What the lead repository says this organisation builds, read before anything is cloned. A
    // workspace is chosen in these terms — the repositories follow from which ones you pick.
    const lead = requirePositional(positionals, 2, 'lead repository URL');
    const map = await workspaceRemoteCapabilities(lead);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(map, null, 2));
    if (!map.capabilities) return console.log(map.reason);
    for (const row of flattenCapabilityTree(map.capabilities)) {
      const ships = row.repositories?.length ? row.repositories : (row.repository ? [row.repository] : []);
      const lead = ships.length > 1 && row.leadRepository ? ` (lead ${row.leadRepository})` : '';
      console.log(`${'  '.repeat(row.depth)}${row.name}${ships.length ? `  \u2192 ${ships.join(', ')}${lead}` : ''}`);
    }
    const shipping = new Set(map.deliveries.map((entry) => entry.id));
    const cloned = new Set(map.deliveries.map((entry) => entry.repository));
    console.log(`\n${shipping.size} delivering from ${cloned.size} ${cloned.size === 1 ? 'repository' : 'repositories'}.`);
    return;
  }

  if (subcommand === 'update') {
    const updateUrls = optionMap(optionStrings(options, 'repository'), '--repository');
    const updateBranches = optionMap(optionStrings(options, 'default-branch'), '--default-branch');
    const updateCapabilities = optionStrings(options, 'capability');
    const updateInput = {
      name: optionString(options, 'name'),
      leadRepository: optionString(options, 'lead'),
      capabilities: updateCapabilities.length ? updateCapabilities : undefined,
      repositories: Object.keys(updateUrls).length
        ? Object.fromEntries(Object.entries(updateUrls).map(([id, url]) => [id, {
            url,
            defaultBranch: updateBranches[id] ?? 'main',
            required: true,
            path: `repos/${id}`
          }]))
        : undefined
    };
    if (optionBoolean(options, 'dry-run')) {
      return console.log(JSON.stringify(await previewWorkspaceUpdate(workspacePath, updateInput), null, 2));
    }
    const updated = await updateWorkspaceConfiguration(workspacePath, updateInput, {
      confirmation: optionString(options, 'confirm')
    });
    await rememberWorkspace(registry, updated.workspace, updated.status, { preserveArchived: true });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(updated, null, 2));
    console.log(`Updated ${updated.workspace.name}.`);
    return renderWorkspaceStatus(updated.status);
  }
  if (subcommand === 'status') {
    const status = await workspaceStatus(workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    return renderWorkspaceStatus(status);
  }
  if (subcommand === 'sync') {
    const result = await fetchWorkspace(workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    result.results.forEach((item) => console.log(`${item.repository}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`));
    return;
  }
  if (subcommand === 'repair') {
    const result = await repairWorkspace(workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    result.repaired.forEach((item) => console.log(`${item.repository}: ${item.status}`));
    return renderWorkspaceStatus(result.status);
  }
  if (subcommand === 'documents') {
    if (positionals[2] === 'import') {
      const files = positionals.slice(4);
      if (!files.length) throw new SingularityFlowError('workspace documents import requires at least one file.');
      const result = await stageWorkspaceDocuments(workspacePath, files);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      result.added.forEach((item) => console.log(`${item.name} · ${item.bytes} bytes · ${item.sha256.slice(0, 12)} · staged, not governed`));
      return;
    }
    const documents = await listWorkspaceDocuments(workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(documents, null, 2));
    return console.log(table(documents, [
      { key: 'name', label: 'DOCUMENT' },
      { key: 'bytes', label: 'BYTES' },
      { key: 'status', label: 'STATUS' }
    ]));
  }
  if (subcommand === 'forget') {
    const workspaces = await forgetWorkspace(registry, workspacePath);
    const clearedSelection = await clearActiveWorkspaceContext(selectionFile, workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(workspaces, null, 2));
    return console.log(`Workspace forgotten${clearedSelection ? ' and active selection cleared' : ''}. No repository or document files were deleted.`);
  }
  throw new SingularityFlowError(`Unknown workspace subcommand '${subcommand}'.`);
}

function epicPhaseName(value) {
  const aliases = {
    intake: 'epic-intake',
    requirements: 'epic-requirements',
    plan: 'epic-planning',
    planning: 'epic-planning',
    publish: 'epic-publish',
    stories: 'epic-publish'
  };
  return value ? (aliases[value] ?? value) : null;
}

function selectedJiraArtifacts(options) {
  const targets = optionString(options, 'artifact-to', 'epic');
  if (!['epic', 'stories', 'both'].includes(targets)) {
    throw new SingularityFlowError('--artifact-to must be epic, stories, or both.');
  }
  return optionStrings(options, 'artifact').map((reference) => {
    const [phase, id, ...rest] = reference.split('/');
    if (!phase || !id || rest.length) throw new SingularityFlowError(`Invalid Jira artifact '${reference}'. Use PHASE/OUTPUT.`);
    return {
      phase,
      id,
      targets: targets === 'both' ? ['epic', 'stories'] : [targets]
    };
  });
}

async function epicCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'start') {
    if (optionBoolean(options, 'local')) {
      const root = repoRoot();
      const [portfolio, config] = await Promise.all([loadPortfolio(root), loadConfig(root)]);
      assertClean(root);
      const title = optionString(options, 'title');
      const description = optionString(options, 'description');
      const goal = optionString(options, 'goal');
      if (!title || !description || !goal) {
        throw new SingularityFlowError('Local Epic start requires --title, --description, and --goal.');
      }
      const profile = optionString(options, 'profile', 'epic-planning');
      if (!portfolio.initiativeProfiles?.[profile]) throw new SingularityFlowError(`Unknown initiative profile '${profile}'.`);
      await initiativeStartPreflight(root, { profile, idAuthority: 'local' });
      const actor = identity(root);
      const existingReservation = await currentLocalEpicReservation(root, portfolio, { fetch: true });
      const reservation = existingReservation ?? await reserveLocalEpicBranch(root, portfolio, {
          base: optionString(options, 'base', config.defaultBaseBranch),
          actor
        });
      const firstPhase = portfolio.initiativeProfiles[profile].phases[0];
      const selectedAgent = await activateInitiativeAgent(
        root, config, reservation.id, portfolio.initiativePhases[firstPhase], optionString(options, 'agent') ?? null
      );
      const source = {
        type: 'manual',
        id: reservation.id,
        title,
        description,
        goal
      };
      const created = await createInitiative(root, {
        id: reservation.id,
        title: source.title,
        profile,
        source,
        agent: selectedAgent.agent,
        idAuthority: 'local',
        capabilityId: optionString(options, 'capability')
      });
      await registerInitiativeEvidence(root, {
        initiativeId: reservation.id,
        phaseId: 'epic-intake',
        checkId: 'epic-identity-verified',
        assurance: 'machine-verified',
        verificationMethod: 'git-atomic-branch-reservation',
        source: {
          externalId: reservation.id,
          version: reservation.reservationCommit,
          observedState: `Local Epic ID ${reservation.id} reserved on its canonical Git branch`
        },
        agent: selectedAgent.agent
      });
      const started = await loadInitiativeAggregate(root, reservation.id, created.portfolio);
      const publication = await commitInitiativeChange(
        root,
        started.portfolio,
        started.initiative,
        { type: 'binding' },
        `[${reservation.id}][epic:init] start ${profile}`
      );
      const result = { initiativeId: reservation.id, source, reservation, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Local Epic ${reservation.id} reserved, created, committed, and ${publication.pushed ? 'pushed' : 'recorded locally'}.`);
      console.log(`Run: singularity-flow epic sources --epic ${reservation.id}`);
      console.log(`In Copilot: /sf-epic-sources ${reservation.id}`);
      return;
    }
    return initiativeCommand(['initiative', 'start', requirePositional(positionals, 2, 'Jira Epic key')], {
      ...options,
      profile: optionString(options, 'profile', 'epic-planning'),
      jira: options.jira ?? true
    });
  }
  if (subcommand === 'pr') {
    const root = repoRoot();
    const config = await loadConfig(root);
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const [{ initiative }, mergeSequence] = await Promise.all([
      loadInitiativeAggregate(root, initiativeId),
      initiativeMergeState(root, initiativeId)
    ]);
    const plan = epicPullRequestPlan(root, config, initiative, mergeSequence);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(`Epic pull request for ${plan.subjectId}\n`);
      console.log(`  ${plan.head} → ${plan.base}`);
      if (plan.blockedBy.length) console.log(`  Blocked by: ${plan.blockedBy.join(', ')}`);
      console.log(`\n--- title ---\n${plan.title}\n\n--- body ---\n${plan.body}\n`);
    }
    if (!optionBoolean(options, 'create')) {
      if (!optionBoolean(options, 'json')) console.log('Preview only. Re-run with --create to open this pull request.');
      return;
    }
    if (!optionBoolean(options, 'yes')
      && !(await confirmExact(`Type ${plan.subjectId} to open the Epic pull request into ${plan.base}: `, plan.subjectId))) {
      throw new SingularityFlowError('Epic pull request cancelled.');
    }
    const result = createPullRequest(root, plan, { remote: config.git?.remote ?? 'origin' });
    console.log(result.status === 'existing'
      ? `A pull request already exists: ${result.url}`
      : `Opened ${result.url}`);
    return;
  }
  if (subcommand === 'sources') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const action = positionals[2] ?? 'list';
    if (action === 'detach') {
      const sourceId = requirePositional(positionals, 3, 'Epic source ID');
      const reason = optionString(options, 'reason');
      if (!reason?.trim()) throw new SingularityFlowError('Epic source detachment requires --reason "<reason>".');
      const loaded = await loadInitiativeAggregate(root, initiativeId);
      const catalog = await listEpicSources(root, initiativeId, { includeDetached: true });
      const selected = catalog.manifest.sources.find((source) => source.sourceId === sourceId);
      if (!selected) throw new SingularityFlowError(`Epic source '${sourceId}' was not found.`);
      const json = optionBoolean(options, 'json');
      if (!json) {
        console.log(`Detach ${sourceId} — ${selected.name}.`);
        console.log('Committed bytes and audit history will be preserved. Future governed prompts will omit this source; dependent generated work and approvals may be invalidated.');
      }
      if (!optionBoolean(options, 'yes') && !(await confirmExact('Confirm this governed Epic source detachment.', sourceId))) {
        console.log('No state changed.');
        return;
      }
      const session = await loadSession(root).catch(() => ({}));
      let detached;
      const publication = await commitInitiativeChange(
        root,
        loaded.portfolio,
        loaded.initiative,
        { type: 'evidence-recorded', phaseId: loaded.initiative.currentPhase, payload: { action: 'detached', sourceId } },
        `[${initiativeId}][epic:evidence:detach] ${sourceId}`,
        { beforeStateWrite: async () => { detached = await detachEpicSource(root, loaded.portfolio, loaded.initiative, { sourceId, reason, agent: session.agent ?? null }); } }
      );
      const result = { ...detached, publication };
      if (json) return console.log(JSON.stringify(result, null, 2));
      console.log(`Decision: ${detached.decision.sha256}`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' retained locally; run singularity-flow initiative sync'}`);
      console.log(`Invalidated phases: ${detached.affectedPhases.length ? detached.affectedPhases.join(', ') : 'none'}`);
      if (detached.reopenedPhase) console.log(`Reopened phase: ${detached.reopenedPhase}`);
      console.log(`Run: singularity-flow initiative next ${initiativeId}`);
      console.log(`In Copilot: /sf-initiative-next`);
      return;
    }
    if (action === 'note' || action === 'answer') {
      const textFile = optionString(options, 'text-file');
      const text = textFile ? await readFile(path.resolve(textFile), 'utf8') : optionString(options, 'text');
      const result = await registerEpicTextSource(root, {
        initiativeId,
        text,
        label: optionString(options, 'label', action === 'answer' ? 'Copilot question answer' : 'Epic notes'),
        kind: action === 'answer' ? 'question-answer' : 'note'
      });
      const publication = await commitInitiativeChange(
        root,
        result.portfolio,
        result.initiative,
        { type: 'evidence-recorded', phaseId: result.initiative.currentPhase, payload: { sourceId: result.record.sourceId } },
        `[${initiativeId}][epic:source] ${result.record.sourceId}`,
        { appendOnly: true }
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ record: result.record, publication }, null, 2));
      console.log(`Registered governed text ${result.record.sourceId}: ${result.record.name}`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'add') {
      const result = await registerEpicSource(root, {
        initiativeId,
        providerId: optionString(options, 'provider'),
        filePath: optionString(options, 'file'),
        url: optionString(options, 'url'),
        label: optionString(options, 'label'),
        mimeType: optionString(options, 'mime', 'application/octet-stream')
      });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'evidence-recorded', phaseId: result.initiative.currentPhase, payload: { sourceId: result.record.sourceId } }, `[${initiativeId}][epic:source] ${result.record.sourceId}`, { appendOnly: true });
      const output = { record: result.record, recordSha256: result.recordSha256, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
      console.log(`Registered ${result.record.sourceId}: ${result.record.name}`);
      console.log(`Provider: ${result.record.provider} · ${result.record.bytes} bytes · ${result.record.sha256}`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'verify' || action === 'materialize') {
      const result = await verifyEpicSources(root, initiativeId, { materialize: action === 'materialize' });
      let publication = null;
      if (action === 'materialize' && result.valid) {
        await registerInitiativeEvidence(root, {
          initiativeId,
          phaseId: 'epic-intake',
          checkId: 'sources-pinned',
          assurance: 'machine-verified',
          verificationMethod: 'provider-download-sha256',
          source: {
            externalId: result.results.map((entry) => `${entry.sourceId}@${entry.expectedSha256}`).join(','),
            version: result.results.map((entry) => entry.version ?? 'unavailable').join(','),
            observedState: `${result.results.length} source version(s) downloaded and hash-verified`
          }
        });
        const verifiedState = await loadInitiativeAggregate(root, initiativeId);
        publication = await commitInitiativeChange(root, verifiedState.portfolio, verifiedState.initiative, { type: 'evidence-recorded', phaseId: verifiedState.initiative.currentPhase, payload: { verifiedSources: result.results.length } }, `[${initiativeId}][epic:sources] verify ${result.results.length}`, { appendOnly: true });
      }
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(table(result.results, [
          { key: 'sourceId', label: 'SOURCE' },
          { key: 'status', label: 'STATUS' },
          { key: 'version', label: 'VERSION' },
          { key: 'cachePath', label: 'LOCAL CACHE' }
        ]));
        if (publication) console.log(`Verification evidence committed ${publication.sha.slice(0, 8)}${publication.pushed ? ' and pushed' : ''}.`);
      }
      if (!result.valid) process.exitCode = 2;
      return;
    }
    if (action !== 'list') throw new SingularityFlowError(`Unknown Epic sources action '${action}'.`);
    if (optionBoolean(options, 'active') && optionBoolean(options, 'all')) throw new SingularityFlowError('Choose either --active or --all, not both.');
    const result = await listEpicSources(root, initiativeId, { includeDetached: optionBoolean(options, 'all') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result.manifest, null, 2));
    return console.log(table(result.manifest.sources, [
      { key: 'sourceId', label: 'SOURCE' },
      { key: 'name', label: 'NAME' },
      { key: 'provider', label: 'PROVIDER' },
      { key: 'bytes', label: 'BYTES' },
      { key: 'status', label: 'STATUS' },
      { key: 'detachReason', label: 'DETACH REASON' }
    ]));
  }
  if (['requirements', 'planning'].includes(subcommand)) {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const phaseId = EPIC_PHASES[subcommand];
    const action = positionals[2] ?? 'status';
    let loaded = await loadInitiativeAggregate(root, initiativeId);
    if (subcommand === 'requirements' && loaded.initiative.currentPhase === EPIC_PHASES.intake) {
      const completed = await completeEpicIntake(root, initiativeId);
      if (completed.advanced) {
        await commitInitiativeChange(
          root,
          completed.portfolio,
          completed.initiative,
          { type: 'phase-approved', phaseId: EPIC_PHASES.intake },
          `[${initiativeId}][epic:intake] sources accepted`
        );
        loaded = await loadInitiativeAggregate(root, initiativeId);
      }
    }
    if (action === 'status') {
      const phase = loaded.initiative.phases[phaseId];
      if (!phase) throw new SingularityFlowError(`Epic does not contain ${phaseId}.`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(phase, null, 2));
      console.log(`${loaded.initiative.initiative.id} · ${phase.label} · ${phase.status} · generation ${phase.generation}`);
      Object.values(phase.outputs).forEach((output) => console.log(`- ${output.label}: ${output.status}${output.sha256 ? ` @${output.sha256.slice(0, 12)}` : ''}`));
      return;
    }
    if (loaded.initiative.currentPhase !== phaseId) {
      throw new SingularityFlowError(`Cannot ${action} ${phaseId}: current Epic stage is '${loaded.initiative.currentPhase ?? 'complete'}'.`);
    }
    if (action === 'prepare') return initiativeCommand(['initiative', 'phase', phaseId], options);
    if (action === 'validate' && subcommand === 'planning') {
      const verification = await verifyEpicPlanningPackage(root, loaded.portfolio, loaded.initiative);
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(verification, null, 2));
      else {
        verification.passes.forEach((line) => console.log(`PASS: ${line}`));
        verification.errors.forEach((line) => console.error(`BLOCK: ${line}`));
      }
      if (!verification.valid) process.exitCode = 2;
      return;
    }
    if (action === 'publish') return initiativeCommand(['initiative', 'phase', 'publish', phaseId], options);
    if (action === 'approve') return initiativeCommand(['initiative', 'approve', 'phase'], options);
    const allowed = subcommand === 'planning' ? 'prepare, status, validate, publish, or approve' : 'prepare, status, publish, or approve';
    throw new SingularityFlowError(`Unknown Epic ${subcommand} action '${action}'. Use ${allowed}.`);
  }
  if (subcommand === 'stories') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const action = positionals[2] ?? 'list';
    const { portfolio, initiative } = await loadInitiativeAggregate(root, initiativeId);
    const breakdown = await loadInitiativeBreakdown(root, portfolio, initiativeId);
    if (action === 'list' || action === 'show') {
      const selected = action === 'show'
        ? breakdown.stories.filter((story) => story.planId === requirePositional(positionals, 3, 'Story plan ID'))
        : breakdown.stories;
      if (action === 'show' && !selected.length) throw new SingularityFlowError(`Epic '${initiativeId}' has no Story '${positionals[3]}'.`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(selected, null, 2));
      return console.log(table(selected.map((story) => ({
        planId: story.planId,
        title: story.title,
        repository: story.repository,
        workflow: story.suggestedWorkType,
        requirements: story.requirements.join(','),
        acceptance: story.acceptanceCriteria.join(','),
        dependsOn: story.dependsOn.map((entry) => entry.story ?? entry).join(',')
      })), [
        { key: 'planId', label: 'PLAN ID' },
        { key: 'title', label: 'TITLE' },
        { key: 'repository', label: 'REPOSITORY' },
        { key: 'workflow', label: 'WORKFLOW' },
        { key: 'requirements', label: 'REQ' },
        { key: 'acceptance', label: 'AC' },
        { key: 'dependsOn', label: 'DEPENDS ON' }
      ]));
    }
    if (action === 'validate') {
      const verification = await verifyEpicPlanningPackage(root, portfolio, initiative);
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(verification, null, 2));
      else {
        verification.passes.forEach((line) => console.log(`PASS: ${line}`));
        verification.errors.forEach((line) => console.error(`BLOCK: ${line}`));
      }
      if (!verification.valid) process.exitCode = 2;
      return;
    }
    if (action === 'update') {
      const planId = requirePositional(positionals, 3, 'Story plan ID');
      const changes = await storyMutationOptions(options);
      if (!Object.keys(changes).length) throw new SingularityFlowError('Story update requires at least one changed field.');
      const { updated, publication } = await publishEpicStoryUpdate(root, initiativeId, planId, changes, `update ${planId}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: updated.story, publication }, null, 2));
      console.log(`Updated ${planId}; Planning approval was invalidated and Story specifications were refreshed.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'metadata') {
      const planId = requirePositional(positionals, 3, 'Story plan ID');
      const operation = positionals[4] ?? 'list';
      const story = storyByPlanId(breakdown, initiativeId, planId);
      if (operation === 'list') {
        if (optionBoolean(options, 'json')) return console.log(JSON.stringify(story.metadata ?? {}, null, 2));
        const rows = Object.entries(story.metadata ?? {}).map(([key, value]) => ({ key, value }));
        return console.log(rows.length ? table(rows, [
          { key: 'key', label: 'KEY' },
          { key: 'value', label: 'VALUE' }
        ]) : `${planId} has no metadata.`);
      }
      const metadata = structuredClone(story.metadata ?? {});
      if (operation === 'set') {
        const key = requirePositional(positionals, 5, 'metadata key');
        const value = requirePositional(positionals, 6, 'metadata value');
        metadata[key] = value;
      } else if (operation === 'remove') {
        const key = requirePositional(positionals, 5, 'metadata key');
        if (!(key in metadata)) throw new SingularityFlowError(`${planId} has no metadata key '${key}'.`);
        delete metadata[key];
      } else if (operation === 'clear') {
        for (const key of Object.keys(metadata)) delete metadata[key];
      } else {
        throw new SingularityFlowError(`Unknown Story metadata action '${operation}'. Use list, set, remove, or clear.`);
      }
      const { updated, publication } = await publishEpicStoryUpdate(
        root,
        initiativeId,
        planId,
        { metadata },
        `metadata ${operation} ${planId}`
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: updated.story, publication }, null, 2));
      console.log(`Updated ${planId} metadata; Planning approval was invalidated for renewed UI review.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'tasks') {
      const planId = requirePositional(positionals, 3, 'Story plan ID');
      const operation = positionals[4] ?? 'list';
      const story = storyByPlanId(breakdown, initiativeId, planId);
      const tasks = structuredClone(story.tasks ?? []);
      if (operation === 'list') {
        if (optionBoolean(options, 'json')) return console.log(JSON.stringify(tasks, null, 2));
        return console.log(tasks.length ? table(tasks.map((task) => ({
          id: task.id,
          title: task.title,
          acceptance: task.acceptanceCriteria?.join(',') ?? '',
          jira: task.jiraKey ?? '—'
        })), [
          { key: 'id', label: 'TASK' },
          { key: 'title', label: 'TITLE' },
          { key: 'acceptance', label: 'ACCEPTANCE' },
          { key: 'jira', label: 'JIRA' }
        ]) : `${planId} has no tasks.`);
      }
      let taskId;
      if (operation === 'add') {
        taskId = optionString(options, 'id', nextTaskId(tasks));
        if (tasks.some((task) => task.id === taskId)) throw new SingularityFlowError(`${planId} already has task '${taskId}'.`);
        const task = taskMutationOptions(options, { id: taskId });
        if (!task.title?.trim()) throw new SingularityFlowError('Adding a task requires --title.');
        tasks.push(task);
      } else if (operation === 'update') {
        taskId = requirePositional(positionals, 5, 'task ID');
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index < 0) throw new SingularityFlowError(`${planId} has no task '${taskId}'.`);
        tasks[index] = taskMutationOptions(options, tasks[index]);
      } else if (operation === 'remove') {
        taskId = requirePositional(positionals, 5, 'task ID');
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index < 0) throw new SingularityFlowError(`${planId} has no task '${taskId}'.`);
        tasks.splice(index, 1);
      } else {
        throw new SingularityFlowError(`Unknown Story task action '${operation}'. Use list, add, update, or remove.`);
      }
      const { updated, publication } = await publishEpicStoryUpdate(
        root,
        initiativeId,
        planId,
        { tasks },
        `tasks ${operation} ${planId}${taskId ? ` ${taskId}` : ''}`
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: updated.story, publication }, null, 2));
      console.log(`${operation === 'remove' ? 'Removed' : operation === 'add' ? 'Added' : 'Updated'} task ${taskId} on ${planId}; Planning approval was invalidated.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'add') {
      const changes = await storyMutationOptions(options);
      const added = await addEpicStory(root, initiativeId, {
        ...changes,
        epicPlanId: optionString(options, 'epic-plan-id')
      });
      const publication = await commitInitiativeChange(
        root,
        added.portfolio,
        added.initiative,
        { type: 'artifact-generated', phaseId: added.initiative.currentPhase, payload: { planId: added.story.planId, operation: 'add-story' } },
        `[${initiativeId}][epic:story] add ${added.story.planId}`
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: added.story, publication }, null, 2));
      console.log(`Added ${added.story.planId}: ${added.story.title} (${added.story.repository}).`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'split') {
      const planId = requirePositional(positionals, 3, 'source Story plan ID');
      const changes = await storyMutationOptions(options);
      const split = await splitEpicStory(root, initiativeId, planId, changes);
      const publication = await commitInitiativeChange(
        root,
        split.portfolio,
        split.initiative,
        { type: 'artifact-generated', phaseId: split.initiative.currentPhase, payload: { planId: split.story.planId, sourcePlanId: planId, operation: 'split-story' } },
        `[${initiativeId}][epic:story] split ${planId} as ${split.story.planId}`
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: split.story, publication }, null, 2));
      console.log(`Split ${planId} into ${split.story.planId}. Planning approval was invalidated for renewed UI review.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    if (action === 'adopt') {
      const jiraKey = requirePositional(positionals, 3, 'Jira Story key');
      const changes = await storyMutationOptions(options);
      if (!changes.repository) throw new SingularityFlowError('Story adoption requires --repository with a configured repository ID.');
      const issue = await getIssue(jiraKey);
      if (String(issue.issueType ?? '').toLowerCase() === 'epic') {
        throw new SingularityFlowError(`Jira ${issue.key} is an Epic. Choose a Story, task, or other delivery issue.`);
      }
      const adopted = await adoptEpicStory(root, initiativeId, issue, changes);
      const publication = await commitInitiativeChange(
        root,
        adopted.portfolio,
        adopted.initiative,
        { type: 'external-synchronized', phaseId: adopted.initiative.currentPhase, payload: { system: 'jira', operation: 'adopt-story', jiraKey: issue.key, planId: adopted.story.planId } },
        `[${initiativeId}][epic:story] adopt ${issue.key} as ${adopted.story.planId}`
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ story: adopted.story, publication }, null, 2));
      console.log(`Adopted Jira ${issue.key} as ${adopted.story.planId}; its existing Jira parent remains unchanged.`);
      console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
      return;
    }
    throw new SingularityFlowError(`Unknown Epic stories action '${action}'. Use list, show, update, metadata, tasks, split, adopt, or validate.`);
  }
  if (subcommand === 'jira') {
    const action = positionals[2] ?? 'preview';
    // These two branches used to be byte-identical, so typing the word "preview" committed and
    // pushed governed state. Preview delegates with the dry run the same handler already honours.
    if (action === 'preview') return epicCommand(['epic', 'create-stories'], { ...options, 'dry-run': true });
    if (action === 'apply') return epicCommand(['epic', 'create-stories'], options);
    throw new SingularityFlowError(`Unknown Epic Jira action '${action}'. Use preview or apply.`);
  }
  if (subcommand === 'generate') {
    throw new SingularityFlowError("epic generate was replaced by 'epic requirements prepare' or 'epic planning prepare'.");
  }
  if (subcommand === 'submit') {
    throw new SingularityFlowError("epic submit was replaced by 'epic requirements publish' or 'epic planning publish'.");
  }
  if (subcommand === 'create-stories') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const loaded = await loadInitiativeAggregate(root, initiativeId);
    if (loaded.initiative.lineage?.idAuthority === 'local') {
      const preview = await initiativeBreakdownReview(root, initiativeId, { probe: true });
      if (optionBoolean(options, 'dry-run')) {
        if (optionBoolean(options, 'json')) return console.log(JSON.stringify(preview, null, 2));
        console.log(`${preview.stories.length} local Story branches are ready to materialize across ${Object.keys(preview.repositories).length} repositories.`);
        return;
      }
      if (!(await confirmInitiativeExact(`Start ${preview.stories.length} local Stories and canonical Git branches for ${initiativeId}?`, initiativeId, options))) {
        throw new SingularityFlowError('Local Story creation cancelled.');
      }
      await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId: 'epic-publish',
        checkId: 'jira-permission-verified',
        assurance: 'machine-verified',
        verificationMethod: 'local-identity-authority',
        source: {
          externalId: initiativeId,
          version: loaded.initiative.resolution.resolutionSha256,
          observedState: 'Pinned local identity authority requires no Jira credentials'
        }
      });
      const materialized = await materializeInitiative(root, initiativeId, { confirmation: initiativeId });
      if (!materialized.failures.length) {
        await registerInitiativeEvidence(root, {
          initiativeId,
          phaseId: 'epic-publish',
          checkId: 'stories-materialized',
          assurance: 'machine-verified',
          verificationMethod: 'git-receipt-integrity',
          source: {
            externalId: initiativeId,
            version: materialized.attempt.completedAt,
            observedState: `${materialized.attempt.stories.length} local Story branches and governed seeds published`
          }
        });
        await completeEpicPublication(root, initiativeId);
      }
      const fresh = await loadInitiativeAggregate(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'external-synchronized', payload: { operation: 'materialize-branches', status: materialized.attempt.status } }, `[${initiativeId}][epic:branches] ${materialized.attempt.status}`);
      const result = { authority: 'local', materialization: materialized.attempt, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Local Story branches ready: ${materialized.attempt.stories.filter((entry) => entry.status !== 'failed').length}/${materialized.attempt.stories.length}.`);
      materialized.failures.forEach((failure) => console.warn(`- ${failure.storyId}: ${failure.error}`));
      return;
    }
    const planSha256 = optionString(options, 'plan');
    if (!planSha256) {
      const result = await createJiraWritePlan(root, initiativeId, {
        artifactSelections: selectedJiraArtifacts(options)
      });
      // `createJiraWritePlan` builds the plan in memory; the commit below is what persists it. So a
      // dry run can return the real plan and leave the repository untouched.
      if (optionBoolean(options, 'dry-run')) {
        if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ plan: result.plan, publication: null }, null, 2));
        console.log(`Jira write plan ${result.plan.sha256} previewed. Nothing was committed or pushed.`);
        console.log(`Publish it with singularity-flow epic jira apply.`);
        return;
      }
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'plan', planSha256: result.plan.sha256 } }, `[${initiativeId}][epic:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ plan: result.plan, publication }, null, 2));
      console.log(`Created and published Jira write plan ${result.plan.sha256}.`);
      console.log(`Review it, then run singularity-flow epic create-stories --plan ${result.plan.sha256}.`);
      return;
    }
    if (optionBoolean(options, 'dry-run')) {
      throw new SingularityFlowError(
        `Applying reviewed plan ${planSha256} writes to Jira and cannot be previewed. `
        + 'Run singularity-flow epic jira apply --plan <sha256> when you are ready.');
    }
    if (!(await confirmInitiativeExact(`Create the reviewed Jira Stories and canonical Git branches for ${initiativeId}?`, initiativeId, options))) throw new SingularityFlowError('Epic Story creation cancelled.');
    const applied = await applyJiraWritePlan(root, initiativeId, {
      planSha256,
      confirmation: initiativeId,
      actor: identity(root).email?.toLowerCase() ?? identity(root).name
    });
    await registerInitiativeEvidence(root, {
      initiativeId,
      phaseId: 'epic-publish',
      checkId: 'jira-permission-verified',
      assurance: 'system-verified',
      verificationMethod: 'jira-permission-preflight-and-apply',
      source: {
        externalId: planSha256,
        version: applied.application.appliedAt,
        observedState: `${applied.results.length} reviewed Jira operations applied by an account with required permissions`
      }
    });
    const appliedState = await loadInitiativeAggregate(root, initiativeId);
    const applicationPublication = await commitInitiativeChange(root, appliedState.portfolio, appliedState.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'apply', planSha256 } }, `[${initiativeId}][epic:jira-apply] ${planSha256.slice(0, 12)}`);
    const materialized = await materializeInitiative(root, initiativeId, { confirmation: initiativeId });
    if (!materialized.failures.length) {
      await registerInitiativeEvidence(root, {
        initiativeId,
        phaseId: 'epic-publish',
        checkId: 'stories-materialized',
        assurance: 'machine-verified',
        verificationMethod: 'jira-and-git-receipt-integrity',
        source: {
          externalId: planSha256,
          version: materialized.attempt.completedAt,
          observedState: `${materialized.attempt.stories.length} canonical Story branches and governed seeds published`
        }
      });
      await completeEpicPublication(root, initiativeId);
    }
    const fresh = await loadInitiativeAggregate(root, initiativeId);
    const branchPublication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, { type: 'external-synchronized', payload: { operation: 'materialize-branches', status: materialized.attempt.status } }, `[${initiativeId}][epic:branches] ${materialized.attempt.status}`);
    const result = { plan: planSha256, applied: applied.results, materialization: materialized.attempt, publications: { application: applicationPublication, branches: branchPublication } };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Created or attached ${applied.results.filter((entry) => entry.subject.type === 'story').length} Jira Stories.`);
    console.log(`Canonical branches ready: ${materialized.attempt.stories.filter((entry) => entry.status !== 'failed').length}/${materialized.attempt.stories.length}.`);
    materialized.failures.forEach((failure) => console.warn(`- ${failure.storyId}: ${failure.error}`));
    return;
  }
  if (subcommand === 'complete') {
    const root = repoRoot();
    const initiativeId = positionals[2] ?? branch(root);
    if (optionBoolean(options, 'dry-run')) {
      const readiness = await epicDeliveryReadiness(root, initiativeId);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(readiness, null, 2));
      console.log(`Epic ${initiativeId}: ${readiness.readyStories}/${readiness.requiredStories} blocking Stories ready.`);
      readiness.stories.forEach((story) => console.log(`${story.ready ? '✓' : story.blocking ? '!' : '○'} ${story.workId} · ${story.status}${story.problems.length ? ` · ${story.problems.join('; ')}` : ''}`));
      return;
    }
    if (!(await confirmInitiativeExact(`Mark Epic ${initiativeId} complete against the exact Story review and conformance hashes?`, initiativeId, options))) {
      throw new SingularityFlowError('Epic completion cancelled.');
    }
    const synchronized = await syncInitiativeRepositories(root, initiativeId);
    const synced = await loadInitiativeAggregate(root, initiativeId);
    const syncPublication = await commitInitiativeChange(root, synced.portfolio, synced.initiative, { type: 'external-synchronized', payload: { operation: 'completion-preflight' } }, `[${initiativeId}][epic:sync] completion preflight`);
    const result = await completeEpicDelivery(root, initiativeId, {
      confirmation: initiativeId,
      actor: identity(root)
    });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'work-completed', payload: { completionSha256: result.record.sha256 } }, `[${initiativeId}][epic:complete] ${result.record.sha256.slice(0, 12)}`);
    const output = { record: result.record, reportPath: result.reportPath, synchronized, publications: { sync: syncPublication, completion: publication } };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
    console.log(`Epic ${initiativeId} marked complete.`);
    console.log(`Spec-to-code report: ${result.reportPath}`);
    console.log(`Decision: ${result.record.sha256}`);
    console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
    return;
  }
  if (subcommand === 'review-choice') {
    const root = repoRoot();
    const action = requirePositional(positionals, 2, 'review-choice action');
    if (action === 'answer') {
      const receipt = await answerSelectionReceipt(
        root,
        requirePositional(positionals, 3, 'selection receipt token'),
        requirePositional(positionals, 4, 'choice ID'),
        requirePositional(positionals, 5, 'selected option ID')
      );
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(receipt, null, 2));
      return printSelectionReceipt(receipt);
    }
    if (action === 'status') {
      const receipt = await selectionReceiptStatus(root, requirePositional(positionals, 3, 'selection receipt token'));
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(receipt, null, 2));
      return printSelectionReceipt(receipt);
    }
    if (action !== 'begin') {
      throw new SingularityFlowError("Epic review-choice supports 'begin', 'answer', or 'status'.");
    }
    const decision = requirePositional(positionals, 3, 'review decision');
    if (!['approve', 'reject'].includes(decision)) {
      throw new SingularityFlowError("Epic review decision must be 'approve' or 'reject'.");
    }
    const story = requirePositional(positionals, 4, 'Story key');
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const review = await epicReviewStory(root, initiativeId, story, {
      packetSha256: optionString(options, 'packet')
    });
    const definition = epicReviewChoiceDefinition(review, decision);
    const receipt = await beginCustomSelectionReceipt(root, definition);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(receipt, null, 2));
    return printSelectionReceipt(receipt);
  }
  if (subcommand === 'review') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const requested = positionals[2];
    if (['approve', 'reject'].includes(requested)) {
      const decision = requested;
      const story = requirePositional(positionals, 3, 'Story key');
      const packetSha256 = optionString(options, 'packet');
      if (!packetSha256) throw new SingularityFlowError(`Epic Story ${decision} requires --packet with the exact full review-packet SHA-256.`);
      if (decision === 'reject' && !optionString(options, 'reason')) {
        throw new SingularityFlowError('Rejecting an Epic Story requires --reason.');
      }
      const review = await epicReviewStory(root, initiativeId, story, { packetSha256 });
      const definition = epicReviewChoiceDefinition(review, decision);
      const receiptToken = optionString(options, 'selection-receipt');
      const receipt = receiptToken
        ? await resolveCustomSelectionReceipt(root, receiptToken, definition)
        : null;
      const agent = optionString(options, 'agent') ?? review.approval.defaultAgent;
      const targetChoices = definition.choiceSets.find((entry) => entry.id === 'reject-target')?.options ?? [];
      const target = decision === 'reject'
        ? (receipt?.answers['reject-target']
          ?? optionString(options, 'to')
          ?? await chooseFromOptions('Return to phase', targetChoices))
        : null;
      if (!receipt && !(await confirmInitiativeExact(
        `${decision === 'approve' ? 'Approve' : 'Reject'} exact Story packet ${packetSha256}?`,
        definition.confirmation,
        options
      ))) {
        throw new SingularityFlowError(`Epic Story ${decision} cancelled.`);
      }
      const result = await epicReviewDecision(root, initiativeId, story, {
        packetSha256,
        decision,
        agent,
        target,
        reason: optionString(options, 'reason'),
        checklist: await checklistDecisions(options),
        channel: receipt ? 'copilot-selection-receipt' : 'terminal'
      });
      if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`${decision === 'approve' ? 'Approved' : 'Rejected'} ${story} packet ${packetSha256}.`);
      console.log(`Story commit: ${result.publication.sha.slice(0, 8)}${result.publication.pushed ? ' pushed' : ' local'}`);
      console.log(`Epic commit: ${result.initiativePublication.sha.slice(0, 8)}${result.initiativePublication.pushed ? ' pushed' : ' local'}`);
      if (result.selfApproval) console.warn('Warning: this is a self-approval and is not independent review.');
      return;
    }
    const story = requested;
    if (!story) {
      const inbox = await listEpicReviewInbox(root, initiativeId);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(inbox, null, 2));
      if (!inbox.length) return console.log(`Epic ${initiativeId} has no submitted Story review packets.`);
      return console.log(table(inbox, [
        { key: 'workId', label: 'STORY' },
        { key: 'repository', label: 'REPOSITORY' },
        { key: 'branch', label: 'SUBMITTED BRANCH' },
        { key: 'phase', label: 'PHASE' },
        { key: 'submittedAt', label: 'SUBMITTED' }
      ]));
    }
    const result = await epicReviewStory(root, initiativeId, story, {
      packetSha256: optionString(options, 'packet')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.story.workId ?? result.story.id} review packet ${result.packet.packetSha256}`);
    console.log(`Lineage: ${initiativeId} → ${result.story.planId ?? result.story.id} → ${result.story.jiraKey ?? 'not created'} → ${result.submittedBranch}`);
    console.log(`Exact source commit: ${result.packet.sourceCommit}`);
    process.stdout.write(`\n${result.review.markdown}`);
    return;
  }
  if (subcommand === 'impact') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const impact = await initiativeImpact(root, initiativeId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(impact, null, 2));
    if (optionBoolean(options, 'markdown')) return console.log(impactDocument(impact));

    console.log(`Computed impact for ${impact.initiativeId} — ${impact.storyCount} ${impact.storyCount === 1 ? 'Story' : 'Stories'} across ${impact.repositories.length} ${impact.repositories.length === 1 ? 'repository' : 'repositories'}\n`);
    console.log(table(impact.repositories.map((repository) => ({
      repository: `${repository.id}${repository.lead ? ' (lead)' : ''}`,
      stories: String(repository.storyCount),
      blocking: String(repository.blockingStoryCount),
      model: repository.worldModel.present ? (repository.worldModel.views.join(', ') || 'present') : 'none',
      claimed: repository.claimed ? 'yes' : 'no'
    })), [
      { key: 'repository', label: 'REPOSITORY' }, { key: 'stories', label: 'STORIES' },
      { key: 'blocking', label: 'BLOCKING' }, { key: 'model', label: 'WORLD MODEL' },
      { key: 'claimed', label: 'IN MAP' }
    ]));

    if (impact.crossRepository.length) {
      console.log('\nCross-repository dependencies:');
      for (const edge of impact.crossRepository) {
        console.log(`  ${edge.from} must land before ${edge.to} (${edge.via.map((via) => `${via.story} → ${via.dependsOn}`).join(', ')})`);
      }
    } else {
      console.log('\nNo Story depends on a Story in another repository.');
    }

    const findings = impactFindings(impact);
    if (!impact.reconciliation.compared) {
      console.log('\nNo impact map has been published yet, so there is nothing to reconcile against.');
    } else if (!findings.length) {
      console.log('\nThe published impact map agrees with the Story plan.');
    } else {
      console.log('\nThe published impact map disagrees with the Story plan:');
      for (const finding of findings) console.log(`  - ${finding}`);
      if (impact.invalidates?.length) {
        console.log(`\nCorrecting it would invalidate ${impact.invalidates.length} downstream ${impact.invalidates.length === 1 ? 'node' : 'nodes'}: ${impact.invalidates.join(', ')}`);
      }
    }
    if (impact.reconciliation.missingWorldModel.length) {
      console.log(`\nNo committed world model: ${impact.reconciliation.missingWorldModel.join(', ')}`);
    }
    return;
  }
  if (subcommand === 'merge-plan') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const plan = await initiativeMergeState(root, initiativeId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(plan, null, 2));
    console.log(`Merge sequence for ${plan.initiativeId} into ${plan.epicBranch}\n`);
    console.log(table(plan.stories.map((story) => ({
      order: String(story.order),
      story: story.workId,
      repository: story.repository,
      blocking: story.blocking ? 'yes' : 'no',
      status: story.status === 'blocked' ? `blocked by ${story.blockedBy.join(', ')}` : story.status
    })), [
      { key: 'order', label: '#' }, { key: 'story', label: 'STORY' }, { key: 'repository', label: 'REPOSITORY' },
      { key: 'blocking', label: 'BLOCKING' }, { key: 'status', label: 'STATUS' }
    ]));
    if (plan.unreachable.length) console.log(`\nUnreachable: ${plan.unreachable.join(', ')}`);
    console.log(plan.nextToMerge
      ? `\nNext to merge: ${plan.nextToMerge.workId} → ${plan.epicBranch}`
      : '\nNext to merge: nothing is ready.');
    console.log(plan.epicReady
      ? `Every blocking story has merged. ${plan.epicBranch} is ready to land.`
      : `${plan.epicBranch} is not ready: ${plan.outstanding.join(', ') || 'no stories'} still outstanding.`);
    console.log('After each merge, sync the remaining story branches from the epic branch before continuing.');
    return;
  }
  if (subcommand === 'checks') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const story = requirePositional(positionals, 2, 'Story key');
    const result = await epicCheckStory(root, initiativeId, story, {
      packetSha256: optionString(options, 'packet')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Recorded checks for ${story} packet ${result.packet.packetSha256.slice(0, 12)}.`);
      console.log(`Ready: ${result.checks.evidence.ready ? 'yes' : 'no'} · evidence ${result.checks.evidence.evidenceSha256.slice(0, 12)}`);
      console.log(`Story commit ${result.checks.publication.sha.slice(0, 8)}; Epic commit ${result.publication.sha.slice(0, 8)}.`);
    }
    if (!result.checks.evidence.ready) process.exitCode = 2;
    return;
  }
  if (subcommand === 'drift') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const action = positionals[2] ?? 'observe';
    if (action === 'observe') {
      const result = await observeJiraDrift(root, initiativeId);
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'observe-drift', observationSha256: result.record.observationSha256 } }, `[${initiativeId}][epic:jira-drift] observe`);
      const output = { record: result.record, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
      console.log(`Jira drift: ${result.record.observations.filter((entry) => entry.drifted).length}/${result.record.observations.length} issue(s).`);
      console.log(`Observation ${result.record.observationSha256}; commit ${publication.sha.slice(0, 8)}.`);
      return;
    }
    if (action === 'adopt') {
      const result = await adoptJiraDrift(root, initiativeId, {
        observationSha256: optionString(options, 'observation'),
        actor: identity(root).email?.toLowerCase() ?? identity(root).name
      });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'adopt-drift', observationSha256: result.observation.observationSha256 } }, `[${initiativeId}][epic:jira-drift] adopt ${result.observation.observationSha256.slice(0, 12)}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ observation: result.observation, publication }, null, 2));
      console.log(`Adopted Jira observations into a new governed Git generation. Commit ${publication.sha.slice(0, 8)}.`);
      return;
    }
    if (action === 'restore-plan') {
      const result = await createJiraWritePlan(root, initiativeId);
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, { type: 'external-synchronized', payload: { system: 'jira', operation: 'restore-plan', planSha256: result.plan.sha256 } }, `[${initiativeId}][epic:jira-restore] ${result.plan.sha256.slice(0, 12)}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ plan: result.plan, publication }, null, 2));
      console.log(`Created reviewed Jira restore plan ${result.plan.sha256}. No Jira fields were changed.`);
      return;
    }
    throw new SingularityFlowError(`Unknown Epic drift action '${action}'.`);
  }
  const mappings = {
    status: 'status',
    sync: 'sync',
    report: 'report',
    resume: 'resume',
    next: 'next',
    journey: 'journey'
  };
  const mapped = mappings[subcommand];
  if (!mapped) throw new SingularityFlowError(`Unknown Epic subcommand '${subcommand}'.`);
  return initiativeCommand(['initiative', mapped, ...positionals.slice(2)], options);
}

/**
 * `constitution generate|check|show`. `[SPK:REQ-097]` `[SPK:REQ-184]`
 *
 * `generate` rewrites only the enforced articles and leaves everything else byte-for-byte, `check`
 * reports the integrity findings without touching the file, and `show` prints what a Story is
 * actually held to. All three read the work type's pinned policy rather than guessing a path.
 */
async function constitutionCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const subcommand = positionals[1] ?? 'check';
  const workTypeId = optionString(options, 'work-type') ?? 'spec-driven-standard';
  const resolved = config.workTypes?.[workTypeId] ? resolveWorkType(config, workTypeId) : null;
  const policy = resolved?.constitution ?? constitutionPolicy(config.workTypes?.[workTypeId]?.constitution);
  const relative = optionString(options, 'path') ?? policy.path;

  if (subcommand === 'generate') {
    const absolute = path.join(root, relative);
    if (!(await exists(absolute))) {
      throw new SingularityFlowError(
        `No constitution at ${relative}. Copy examples/constitution/constitution.md there, replace the sample articles, and remove its 'example: true' marker.`
      );
    }
    const before = await readFile(absolute, 'utf8');
    const generated = generateConstitution(before, resolved ?? config);
    if (optionBoolean(options, 'dry-run')) {
      console.log(generated.markdown);
      return console.log(`\nWould regenerate ${generated.regenerated.length} enforced article(s): ${generated.regenerated.join(', ') || 'none'}`);
    }
    await writeText(absolute, generated.markdown);
    // `[SPK:CON-043]`: the constitution belongs to the configuration branch, not application main.
    return emitCommandResult(commandResult({
      operation: { id: 'constitution.generate', classification: 'mutation' },
      subject: { kind: 'configuration', id: relative },
      outcome: succeeded('constitution.generated', { regenerated: generated.regenerated.length }),
      effects: { files: [relative] },
      next: [{
        kind: 'review', rank: 'NOW',
        summary: 'Propose the regenerated constitution through the configuration-authority workflow; it must not be committed to application main.',
        command: 'singularity-flow configuration'
      }],
      data: { path: relative, regenerated: generated.regenerated, articles: generated.articles.map((article) => article.id) }
    }), { json: optionBoolean(options, 'json') });
  }

  const constitution = await loadConstitution(root, relative, { resolution: resolved ?? config, allowExample: subcommand === 'show' });
  if (!constitution) {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ present: false, path: relative }, null, 2));
    return console.log(`No constitution at ${relative}. Work type '${workTypeId}' has constitution mode '${policy.mode}'.`);
  }
  const index = constitutionIndex({
    articles: constitution.articles, path: constitution.path, fileSha256: constitution.fileSha256, resolution: resolved ?? config
  });

  if (subcommand === 'show') {
    if (optionBoolean(options, 'json')) {
      return emitCommandResult(commandResult({
        operation: { id: 'constitution.show', classification: 'read' },
        subject: { kind: 'configuration', id: constitution.path },
        outcome: noop('constitution.shown', { articles: index.articles.length, path: constitution.path }),
        effects: noEffects(), restState: 'informational', data: index
      }), { json: true });
    }
    console.log(`Constitution — ${constitution.path} (${constitution.fileSha256.slice(0, 12)}), index ${index.indexSha256.slice(0, 12)}`);
    for (const article of index.articles) {
      console.log(`  ${article.id} [${article.type}${article.type === 'judged' ? `/${article.level}${article.evidenceRequired ? ', evidence required' : ''}` : ''}]${article.status === 'withdrawn' ? ' (withdrawn)' : ''} ${article.title ?? ''}`);
      if (article.policy) console.log(`      policy: ${article.policy}`);
    }
    return;
  }
  /**
   * `constitution except` — a rule deliberately not followed. `[SPK:REQ-103]` `[SPK:REQ-104]`
   *
   * Every field is required, and the command exists so that the alternative — following the rule or
   * quietly not following it — is not the only choice available. An exception with a reason, a
   * scope, an authority and an expiry is a decision; the same thing undocumented is a defect
   * somebody will find later and be unable to explain.
   */
  if (subcommand === 'except') {
    const workflow = await loadStoryAggregate(root, config, optionString(options, 'work-id'));
    const pin = workflow.resolution?.constitutionPin ?? null;
    if (!pin) throw new SingularityFlowError('This Story pinned no constitution, so there is no article to take an exception to.');
    const articleId = requirePositional(positionals, 2, 'constitution article ID').toUpperCase();
    const article = pin.articles.find((entry) => entry.id.toUpperCase() === articleId);
    if (!article) throw new SingularityFlowError(`The pinned constitution has no article ${articleId}. It contains ${pin.articles.map((entry) => entry.id).join(', ')}.`);
    const session = await loadSession(root);
    const authority = requireApprovalAuthority(
      workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
      workflow.phases[workflow.currentPhase]?.approvalPolicy ?? { authorities: [] },
      session.actor
    );
    const exception = buildConstitutionException({
      articleId,
      reason: optionString(options, 'reason'),
      scope: optionString(options, 'scope') ?? workflow.workItem.id,
      actor: session.actor,
      authority: authority.authorityGroup,
      at: nowIso(),
      expiresAt: optionString(options, 'expires') ?? null,
      workId: workflow.workItem.id,
      sourceCommit: head(root)
    });
    const workflowBefore = structuredClone(workflow);
    const published = await commitAndPublish(
      root, config, workflow,
      // `evidence-recorded`, from the closed lifecycle-event vocabulary, rather than a new type: an
      // exception is a governed record attached to the Story, and inventing an event kind for it
      // would put a second vocabulary beside the one the ledger already validates against.
      { type: 'evidence-recorded', kind: 'constitution-exception', articleId, phaseId: workflow.currentPhase ?? null },
      `[${workflow.workItem.id}][constitution:except] ${articleId}`,
      [],
      {
        rollbackWorkflow: workflowBefore,
        beforeStateWrite: async () => {
          workflow.constitutionExceptions ??= [];
          workflow.constitutionExceptions.push({ ...exception, phase: workflow.currentPhase ?? null });
        }
      }
    );
    return emitCommandResult(commandResult({
      operation: { id: 'constitution.except', classification: 'mutation' },
      subject: { kind: 'story', id: workflow.workItem.id },
      outcome: succeeded('constitution.excepted', { article: articleId, scope: exception.scope }),
      effects: { commits: [published.sha] },
      next: [{
        kind: 'review', rank: 'SOON',
        summary: 'The exception appears in the review packet, Story evidence and final conformance.',
        command: `singularity-flow review --work-id ${workflow.workItem.id}`
      }],
      data: exception
    }), { json: optionBoolean(options, 'json') });
  }

  if (subcommand !== 'check') throw new SingularityFlowError(`Unknown constitution subcommand '${subcommand}'. Use generate, check, show, or except.`);

  if (optionBoolean(options, 'json')) {
    return emitCommandResult(commandResult({
      operation: { id: 'constitution.check', classification: 'read' },
      subject: { kind: 'configuration', id: constitution.path },
      outcome: noop('constitution.reported', {
        path: constitution.path, articles: index.articles.length, findings: constitution.findings.length
      }),
      effects: noEffects(), restState: 'informational',
      data: { present: true, index, findings: constitution.findings }
    }), { json: true });
  }
  console.log(`Constitution — ${constitution.path} (${constitution.fileSha256.slice(0, 12)})`);
  console.log(`  mode: ${policy.mode} · articles: ${index.articles.length} · index ${index.indexSha256.slice(0, 12)}`);
  if (!constitution.findings.length) return console.log('\nNo integrity problems found.');
  console.log('');
  for (const finding of constitution.findings) console.log(`  ${finding.kind}: ${finding.message}`);
  // A hand-edited enforced article is not a style problem: the document now says something the
  // kernel does not do, and this is the exit code a pipeline should stop on.
  if (constitution.findings.some((finding) => ['hand-edited', 'stale-policy', 'judged-prose-changed'].includes(finding.kind))) process.exitCode = 2;
}

export async function finalizeCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadStoryAggregate(root, config, optionString(options, 'parent'));
  const store = new StoryStateStore(root, config);
  const impactFinalization = Boolean(workflow.measurement?.plan && workflow.measurement?.status !== 'opted-out');
  const transaction = await store.transact(
    workflow,
    {
      type: impactFinalization ? 'impact-finalized' : 'work-completed',
      phaseId: workflow.currentPhase,
      payload: { workCompleted: true }
    },
    `[${workflow.workItem.id}][finalize] ready for Product Owner review`,
    async () => finalizeStoryDelivery(root, config, workflow, { persist: false })
  );
  const result = transaction.value;
  const publication = transaction.publication;
  const output = { ...result, publication };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
  console.log(`Story ${workflow.workItem.id} finalized for Product Owner review.`);
  console.log(`Packet: ${result.path}`);
  console.log(`Packet hash: ${result.packet.packetSha256}`);
  if (result.impact) console.log(`Impact receipt: ${result.impact.path} · ${result.impact.receipt.integrity.sha256.slice(0, 12)}`);
  console.log(`Source: ${result.packet.sourceCommit.slice(0, 12)} · tree ${result.packet.sourceTreeSha256.slice(0, 12)}`);
  console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
}

/**
 * Expand a `sfdoc:` handle, or return null when the handle belongs to the evidence plane.
 *
 * The hash in the handle is checked rather than decorative: a handle minted against one version of
 * a topic must not silently resolve to another. That is the same promise `sfref:` makes about
 * artifact bytes, and it is the reason a citation is worth anything.
 */
async function expandDocsHandle(handle, options) {
  const { parseDocsHandle, docsHandle, servedBody, citationLine } = await import('./commands/explain.mjs');
  const parsed = parseDocsHandle(handle);
  if (!parsed) return null;
  const { loadTopics } = await import('./docs-topics.mjs');
  const { docsManifest } = await import('./docs-manifest.mjs');
  const topics = await loadTopics();
  const topic = topics.find((entry) => entry.id === parsed.topicId);
  if (!topic) {
    throw new SingularityFlowError(`No documentation topic '${parsed.topicId}' is installed.`, { exitCode: 2, code: 'handle.not_found' });
  }
  if (docsHandle(topic) !== handle) {
    throw new SingularityFlowError(
      `Handle names ${parsed.shaPrefix} but topic '${topic.id}' is now ${topic.sha256.slice(0, 12)}. Re-read it with: sflow explain ${topic.id}.`,
      { exitCode: 4, code: 'handle.hash_mismatch' }
    );
  }
  const served = servedBody(topic, {
    maxBytes: optionNumber(options, 'max-bytes'),
    section: optionString(options, 'section')
  });
  const manifest = docsManifest();
  const provenance = {
    topic: topic.id, topicVersion: topic.version, topicSha256: topic.sha256,
    docsSourceCommit: manifest?.sourceCommit ?? null
  };
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify({
      schemaVersion: 1, resultType: 'docs-topic', handle, provenance, served
    }, null, 2));
  } else {
    console.log(served.text);
    console.log(citationLine(provenance));
  }
  return { harnessOutput: { handle, previewSha256: served.sha256, previewBytes: served.bytes } };
}

async function showCommand(positionals, options) {
  const handle = requirePositional(positionals, 1, 'governed reference handle');
  const selectors = [optionString(options, 'section'), optionString(options, 'json-pointer'), optionString(options, 'range')]
    .filter((value) => value != null);
  if (selectors.length > 1) throw new SingularityFlowError('Choose only one of --section, --json-pointer, or --range.', { exitCode: 5, code: 'handle.expansion_invalid' });
  // A documentation handle is answered from the package, before `repoRoot()` is consulted — the
  // whole point of the documentation plane is that it resolves with no clone at all. Dispatching on
  // the namespace also keeps the two planes visibly separate: `sfdoc:` is documentation, `sfref:` is
  // registered governed evidence, and neither can be mistaken for the other.
  const docs = await expandDocsHandle(handle, options);
  if (docs) return docs;
  const result = await resolveReference(repoRoot(), handle, {
    section: optionString(options, 'section'),
    jsonPointer: optionString(options, 'json-pointer'),
    range: optionString(options, 'range'),
    maxBytes: optionNumber(options, 'max-bytes'),
    totalEnvelopeBytes: optionNumber(options, 'max-envelope-bytes')
  });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.preview.text);
  return {
    harnessOutput: {
      rawSha256: result.source.rawSha256,
      rawBytes: result.source.rawBytes,
      previewSha256: result.preview.sha256,
      previewBytes: result.preview.bytes,
      handle: result.handle
    }
  };
}

function harnessMediaType(file) {
  return ({
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json',
    '.yml': 'application/yaml', '.yaml': 'application/yaml', '.csv': 'text/csv',
    '.txt': 'text/plain', '.log': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf'
  })[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function registerInitiativePhaseReferences(root, config, initiative, phase, commitSha = head(root)) {
  const policy = initiative.resolution?.harnessImports ?? config.harnessImports ?? { mode: 'off' };
  if (policy.mode === 'off') return [];
  const originResult = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true });
  const references = [];
  const subjectRoot = initiativeRelative(config, initiative.initiative.id);
  for (const output of Object.values(phase.outputs ?? {})) {
    if (!output.sha256 || !Number.isInteger(output.bytes)) continue;
    const artifactPath = path.posix.join(subjectRoot, output.path);
    const registered = await registerReference(root, {
      repository: { id: path.basename(root), origin: originResult.status === 0 ? originResult.stdout.trim() || null : null },
      subject: {
        kind: 'initiative', id: initiative.initiative.id,
        branch: initiative.initiative.branch, subjectRevision: phase.generation
      },
      artifact: {
        phaseId: phase.id, generation: phase.generation, outputId: output.id,
        path: artifactPath, mediaType: harnessMediaType(output.path)
      },
      revision: { commitSha, sha256: output.sha256, bytes: output.bytes },
      visibility: 'model'
    });
    references.push({ outputId: output.id, handle: registered.handle, recordHash: registered.recordHash });
  }
  phase.references = references;
  return references;
}

async function harnessCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'report';
  if (subcommand !== 'report') throw new SingularityFlowError(`Unknown harness subcommand '${subcommand}'.`);
  const report = await harnessReport(repoRoot());
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(report, null, 2));
  console.log(`Harness invocations: ${report.invocations}`);
  console.log(`Reference bytes: ${report.output.rawBytes} raw → ${report.output.previewBytes} preview (${report.output.savedBytes} omitted)`);
  console.log(`Checker coverage: ${(report.checkers.coverage * 100).toFixed(1)}% · pass ${report.checkers.verdicts.pass} · fail ${report.checkers.verdicts.fail} · not observed ${report.checkers.verdicts['not-observed']}`);
  console.log(`Host observations: ${report.hostObservations.status} — ${report.hostObservations.reason}`);
}

async function harnessInvocation(command, argv) {
  try {
    const root = repoRoot();
    const definition = await loadDefinition(root);
    if (definition.harnessImports?.mode === 'off') return null;
    const session = await loadSession(root).catch(() => null);
    return {
      root,
      started: beginHarnessInvocation({
        subject: session?.workId ? { kind: 'story', id: session.workId } : null,
        skill: command === 'show' ? 'sflow-show' : null,
        contractClass: command === 'show' ? 'echo' : null,
        command: ['singularity-flow', ...argv]
      })
    };
  } catch {
    return null;
  }
}

// Log every command's outcome. This is the spine of the activity log: without it a failure leaves
// only the message printed to the terminal, and the sequence that produced it is gone. Building the
// logger must never break a command, so a repository that cannot be resolved simply gets no file.
async function commandLogger(command, argv, { json = false, verbose = false } = {}) {
  // Machine-readable commands still keep their durable activity log, but their stderr transport
  // must contain only the JSON result. Suppress only the console sink for those invocations.
  // `--verbose` is the opposite request: put the diagnostics that are always written to the log file
  // on screen as well. It cannot override `--json`, because that would corrupt the transport.
  const env = json ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'off' }
    : verbose ? { ...process.env, SINGULARITY_FLOW_LOG_CONSOLE: 'debug' }
      : process.env;
  try {
    const root = repoRoot();
    const config = await loadConfig(root).catch(() => null);
    return repositoryLogger(root, config, {
      context: { command, pid: process.pid, cwd: root, branch: branch(root) ?? null }, env
    });
  } catch {
    return repositoryLogger(null, null, { context: { command, pid: process.pid }, env });
  }
}

export async function main(argv) {
  // Bare semver, deliberately: `reinstall.mjs` compares this output to the planned version with
  // `!==`, so anything appended here fails every `--clean-reinstall`. Build provenance is `--build`.
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return console.log(VERSION);
  // Bare `--help` answers the question a newcomer has in about a screen; `--help --all` is the
  // complete 365-line synopsis, which is a reference and not an introduction.
  if (argv.every((token) => ['--help', '-h', '--all'].includes(token)) && argv.some((token) => ['--help', '-h'].includes(token))) {
    const { renderOverview } = await import('./help-pages.mjs');
    return console.log(argv.includes('--all') ? HELP : renderOverview(VERSION));
  }
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command) return cockpitCommand();
  if (command === 'version') return console.log(VERSION);
  // `logs` reads the file; logging its own invocation would append noise to what it is showing.
  if (!['logs', 'factory-reset', 'reset-all', 'local-reset', 'fresh-install', 'reinstall'].includes(command)) {
    const log = await commandLogger(command, argv, { json: options.json, verbose: options.verbose });
    const harness = await harnessInvocation(command, argv);
    const started = Date.now();
    log.info('command.start', null, { argv: argv.slice(0, 24) });
    try {
      const result = await dispatch(command, positionals, options);
      log.info('command.ok', null, { durationMs: Date.now() - started });
      if (harness) await completeHarnessInvocation(harness.root, harness.started, {
        exitCode: 0,
        output: result?.harnessOutput ?? null,
        actionsExecuted: result?.harnessEvidence?.actionsExecuted ?? [],
        questions: result?.harnessEvidence?.questions ?? []
      }).catch(() => {});
      return result;
    } catch (error) {
      log.error('command.failed', error?.message, { durationMs: Date.now() - started, exitCode: error?.exitCode ?? 1, error });
      if (harness) await completeHarnessInvocation(harness.root, harness.started, { exitCode: error?.exitCode ?? 1 }).catch(() => {});
      throw error;
    }
  }
  return dispatch(command, positionals, options);
}

async function dispatch(command, positionals, options) {
  const handlers = validateCommandHandlers({
    about: () => console.log(ABOUT),
    help: () => helpCommand(positionals, options),
    show: () => showCommand(positionals, options),
    harness: () => harnessCommand(positionals, options),
    init: () => initCommand(options),
    'factory-reset': () => factoryResetCommand(options),
    'reset-all': () => resetAllCommand(options),
    'local-reset': () => localResetCommand(options),
    'fresh-install': () => freshInstallCommand(options),
    reinstall: () => reinstallCommand(options),
    choices: () => choicesCommand(positionals, options),
    start: () => startCommand(positionals, options),
    resume: () => resumeCommand(positionals, options),
    return: () => returnCommand(positionals, options),
    agent: () => agentCommand(positionals, options),
    session: () => sessionCommand(positionals, options),
    inbox: () => inboxCommand(options),
    finalize: () => finalizeCommand(options),
    status: () => statusCommand(positionals, options),
    approvals: async () => (await import('./commands/approvals.mjs')).run(argv, { positionals, options }),
    progress: () => progressCommand(positionals, options),
    report: () => reportCommand(positionals, options),
    impact: () => impactCommand(positionals, options),
    telemetry: () => telemetryCommand(positionals, options),
    'prompt-log': () => promptLogCommand(positionals, options),
    guide: () => guideCommand(positionals, options),
    // The front door to the first-run walkthrough. `guide --first-run` still works and does the same
    // thing; this is the name someone can guess.
    quickstart: () => guideCommand(['guide'], { ...options, 'first-run': true }),
    'refresh-branch': () => refreshBranchCommand(options),
    next: () => nextCommand(options),
    run: () => runCommand(positionals, options),
    fault: () => faultCommand(positionals, options),
    fix: () => fixCommand(positionals, options),
    repair: () => repairCommand(positionals, options),
    goal: async () => (await import('./commands/goal.mjs')).run([], { positionals, options }),
    journal: async () => (await import('./commands/journal.mjs')).run([], { positionals, options }),
    push: async () => (await import('./commands/push.mjs')).run([], { positionals, options }),
    home: async () => (await import('./commands/home.mjs')).run(argv, { positionals, options }),
    recommend: async () => (await import('./commands/recommend.mjs')).run(positionals, { positionals, options }),
    logs: () => logsCommand(positionals, options),
    doctor: () => doctorCommand(positionals, options),
    review: () => reviewCommand(positionals, options),
    receipt: () => receiptCommand(positionals, options),
    workflow: () => workflowCommand(positionals, options),
    assign: () => assignCommand(positionals),
    watch: () => watchCommand(positionals, options),
    recover: () => recoverCommand(positionals, options),
    explain: async () => (await import('./commands/explain.mjs')).run(argv, { positionals, options }),
    // The five verbs. Each dispatches into the same router; the registry keeps them distinct
    // commands so tripwires, help and the operation catalog treat them individually.
    ...Object.fromEntries(['specify', 'plan', 'implement', 'verify', 'converge'].map((verb) => [
      verb,
      async () => (await import('./commands/fast-path.mjs')).runVerb(verb, argv, { positionals, options })
    ])),
    nextsteps: () => nextStepsCommand(positionals, options),
    action: () => actionCommand(positionals, options),
    inputs: () => inputsCommand(positionals, options),
    spec: () => specCommand(positionals, options),
    'agents': () => agentsCommand(positionals, options),
    mcp: () => mcpCommand(positionals, options),
    visual: () => visualCommand(positionals, options),
    documents: () => documentsCommand(positionals, options),
    prepare: () => prepareCommand(positionals, options),
    clarification: () => clarificationCommand(positionals, options),
    phase: () => phaseCommand(positionals, options),
    artifact: () => artifactCommand(positionals, options),
    pr: () => pullRequestCommand(positionals, options),
    stack: () => stackCommand(positionals, options),
    regression: () => regressionCommand(positionals, options),
    submit: () => submitCommand(positionals, options),
    approve: () => approveCommand(positionals, options),
    reject: () => rejectCommand(positionals, options),
    reopen: () => reopenCommand(positionals, options),
    cancel: () => cancelCommand(positionals, options),
    sync: () => syncCommand(),
    ledger: () => ledgerCommand(positionals, options),
    capabilities: () => capabilitiesCommand(positionals, options),
    state: () => stateCommand(positionals, options),
    validate: () => validateCommand(options),
    gate: () => gateCommand(options),
    wm: () => wmCommand(positionals, options),
    jira: () => jiraCommand(positionals, options),
    plugin: () => pluginCommand(positionals, options),
    snapshot: () => snapshotCommand(positionals, options),
    configuration: () => editorCommand(positionals, options, 'configuration'),
    constitution: () => constitutionCommand(positionals, options),
    initiative: () => initiativeCommand(positionals, options),
    knowledge: () => knowledgeCommand(positionals, options),
    capability: () => capabilityCommand(positionals, options),
    epic: () => epicCommand(positionals, options),
    story: async () => (await import('./commands/story.mjs')).storyCommand(positionals, options),
    secrets: () => secretsCommand(positionals, options),
    workspace: () => workspaceCommand(positionals, options),
    copilot: () => workspaceCommand(['workspace', 'copilot', ...positionals.slice(1)], options),
    hook: () => hookCommand(positionals),
    bootstrap: () => bootstrapCommand(positionals, options)
  });
  const invoke = () => handlers[canonicalCommand(command)]();
  const override = optionString(options, 'confirm-override');
  try {
    if (override) {
      return withConfirmationPort(
        (_message, gate) => override === `continue:${gate}`,
        invoke
      );
    }
    return invoke();
  } catch (error) {
    // An unknown command is rejected by the registry with a correction and two entry points, before
    // dispatch is ever reached. This used to catch that message and append all 2,450 lines of HELP
    // to it, which was both unreachable — the registry throws first — and the wrong answer to a typo.
    throw error;
  }
}
