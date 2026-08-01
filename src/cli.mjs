import readline from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import YAML from 'yaml';
import {
  SingularityFlowError,
  optionBoolean,
  optionNumber,
  optionString,
  optionStrings,
  parseArgs,
  posix,
  readJson,
  requirePositional,
  run,
  snapshot,
  table,
  writeText
} from './util.mjs';
import { assertClean, branch, changes, checkout, fastForwardTo, fetchOrigin, fetchRemote, fileAtRef, gitDir, hasUpstream, head, identity, pullFastForward, refHead, remoteBranches, repoRoot } from './git.mjs';
import {
  approvePhase,
  assertNoPendingPublication,
  commitAndPublish,
  CONFIG_PATH,
  createWorkflow,
  currentPhase,
  loadConfig,
  loadWorkflow,
  pendingPublicationPath,
  preparePhase,
  preparePhaseInputs,
  publishGeneration,
  reconcilePhaseTelemetry,
  registerArtifact,
  rejectPhase,
  resolveWorkItem,
  saveWorkflow,
  scanArtifacts,
  submitPhase,
  syncPublication,
  validateId,
  validateWorkflow,
  workflowBranchAllowed,
  workflowPublicationBranch,
  workflowPath,
  workDir
} from './state.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';
import { assertPhaseSequence } from './sequence.mjs';
import {
  addComment, assignIssue, discoverJiraConnection, getIssue, getIssueHierarchy, getMyPermissions, issueToMarkdown,
  getIssueProperty, listBoards, listBoardStories, listEpicStories, listEpics, listFields, listIssueTransitions,
  listMyIssues, listProjects, moveIssueToSprint, setIssuePriority, transitionIssue
} from './jira.mjs';
import { jiraDoctor, jiraDoctorText } from './jira-doctor.mjs';
import { installPlugin, listPlugins, pluginPath, uninstallPlugin } from './plugin.mjs';
import { runGovernanceGate } from './governance.mjs';
import { worldModelCommand } from './worldmodel.mjs';
import { initializationStatus, initializeDefinition, migrateLegacyConfig, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { activateWorkItemSession, loadSession, personaSessionStatus, selectIntakeSource, selectPersona, selectWorkType, setAgentSession } from './session.mjs';
import { addDocuments, documentCatalog, fetchRemoteDocument, listRemoteDocuments, previewDocument, viewDocument } from './documents.mjs';
import { progressBar, progressFlow, progressSnapshot } from './progress.mjs';
import { deriveReport, renderHtml, renderMarkdown } from './report.mjs';
import { loadManualStory, promptManualStory } from './intake.mjs';
import { guideText, phaseNeedsGeneration, workflowGuide } from './guide.mjs';
import { nextStepsSnapshot, nextStepsText } from './nextsteps.mjs';
import { loadHelpDocument } from './help.mjs';
import { agentMappingStatus, agentStatus, discoverAgents, lockAgent, prepareRemoteOutputs, remoteOutputConflicts, syncAgent } from './agents.mjs';
import {
  bootstrapDesktopPortfolio,
  deleteDesktopFile,
  deleteDesktopTemplate,
  desktopExportBundle,
  desktopSnapshot,
  publishDesktopConfiguration,
  readDesktopFile,
  saveDesktopFile,
  selectDesktopPersona,
  validateDesktopConfiguration
} from './desktop.mjs';
import { verifyGroundingRecord, worldModelCommit, worldModelRebuildReason, worldModelSourceSnapshot } from './grounding.mjs';
import {
  filterLogEntries, LOG_LEVELS, logFilePath, normalizeLogLevel, parseLogLines, repositoryLogger, resolveLogging
} from './logging.mjs';
import { doctorSnapshot, doctorText } from './doctor.mjs';
import { createReviewBundle, reviewHtml, reviewMarkdown } from './review.mjs';
import { installWorkflow, simulateWorkflow, simulationText, workflowCatalog, workflowDiff } from './workflow-catalog.mjs';
import { applyRecovery, assignPhase, recoveryPlan, recoveryText, watchSnapshot, watchText } from './collaboration.mjs';
import { copilotAgentStartHook, personaGuardHook, sessionStartPersonaHook } from './persona-hooks.mjs';
import { approvalInbox, approvalInboxText } from './inbox.mjs';
import { requireApprovalAuthority } from './approval-authority.mjs';
import {
  answerSelectionReceipt, beginCustomSelectionReceipt, beginSelectionReceipt, consumeSelectionReceipt,
  resolveCustomSelectionReceipt, resolveSelectionReceipt, selectionReceiptStatus
} from './choices.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import {
  currentKnowledge, filterKnowledge, harvestInitiativeKnowledge, readKnowledge, recordKnowledge, resolveKnowledge
} from './knowledge.mjs';
import {
  commitInitiativeChange, createInitiative, initiativeProgress, initiativeStartPreflight, listInitiatives,
  availableInitiativeOutputs, loadInitiative, prepareInitiativePhase, restartInitiative, secureInitiativePath,
  selectInitiativePhaseOutputs, setInitiativeApplicability, initiativeApplicabilityState,
  syncInitiativePublication, validateInitiativeId
} from './initiative-state.mjs';
import {
  approveInitiative, evaluateInitiativePhase, initiativeBundle, publishInitiativePhase,
  readInitiativeRecords, registerInitiativeEvidence
} from './initiative-evidence.mjs';
import { rejectInitiative } from './initiative-graph.mjs';
import {
  initiativeBreakdownReview, initiativeMergeState, loadInitiativeBreakdown, materializeInitiative, sameRepositoryRemote,
  syncInitiativeRepositories
} from './initiative-repositories.mjs';
import {
  adoptJiraDrift, adoptJiraEpic, applyJiraWritePlan, createJiraWritePlan,
  observeJiraDrift, previewJiraAdoption
} from './jira-initiative.mjs';
import { interfaceContractStatus, registerInterfaceContract } from './initiative-contracts.mjs';
import {
  deriveInitiativeReport, initiativeNextActions, renderInitiativeReport
} from './initiative-report.mjs';
import { epicJourney } from './initiative-next.mjs';
import { initiativeOutputRequired } from './initiative-policy.mjs';
import { runInitiativeGate } from './initiative-governance.mjs';
import { composeInitiativeContext, verifyInitiativeContext } from './initiative-context.mjs';
import { createPlanningContext, promotePlanningArtifact, promotePlanningArtifacts } from './planning.mjs';
import { formatContextBoundaryHandoff } from './context-policy.mjs';
import {
  listEpicSources, registerEpicSource, registerEpicTextSource, verifyEpicSources
} from './epic-sources.mjs';
import {
  adoptEpicStory, completeEpicIntake, completeEpicPublication, EPIC_PHASES,
  splitEpicStory, updateEpicStory, verifyEpicPlanningPackage
} from './epic-lifecycle.mjs';
import {
  attachStoryBranch, createStoryBranch, createStoryReviewPacket, finalizeStoryDelivery,
  promoteStoryBranch, storyBranchStatus
} from './story-lineage.mjs';
import { runAndRecordStoryChecks } from './github-evidence.mjs';
import { createStoryPullRequest, storyPullRequestPlan } from './pull-request.mjs';
import { epicCheckStory, epicReviewDecision, epicReviewStory, listEpicReviewInbox } from './epic-review.mjs';
import { completeEpicDelivery, epicDeliveryReadiness } from './epic-completion.mjs';
import { verifyEpicTraceability } from './epic-traceability.mjs';
import { currentLocalEpicReservation, reserveLocalEpicBranch } from './local-identity.mjs';
import {
  archiveWorkspace, createWorkspace, createWorkspaceConfiguration, fetchWorkspace, forgetWorkspace,
  listWorkspaceDocuments, previewWorkspace, previewWorkspaceConfiguration, previewWorkspaceUpdate,
  readWorkspace, readWorkspaceRegistry, rememberWorkspace, repairWorkspace, restoreWorkspace,
  stageWorkspaceDocuments, updateWorkspaceConfiguration, workspaceStatus
} from './workspace.mjs';
import {
  activateWorkspaceContext, activeWorkspaceFile, readActiveWorkspaceContext, workspacePromptLabel,
  workspaceRegistryFile
} from './workspace-context.mjs';
import {
  appendLedgerIntent, archiveLedger, createLedgerIntent, initializeLedger, ledgerDoctor, ledgerLog, ledgerShow, ledgerStatus, reconcileLedger, verifyLedger
} from './ledger.mjs';
import { loadCapabilities, resolveCapabilityPolicy, resolveEffectiveCapabilityPolicy } from './capabilities.mjs';
import { canonicalCommand, validateCommandHandlers } from './command-registry.mjs';

const VERSION = '0.9.0';

const ABOUT = `Singularity Flow ${VERSION}

Singularity Flow is a Git-native, configurable SDLC orchestration system for
GitHub Copilot and engineering teams. It belongs to the Singularity product
brand and uses the short, collision-safe sflow- command namespace.

What it provides:
  - YAML-defined feature, bugfix, chore, Figma-mobile, and custom workflows
  - Session working lenses, phase-aware prompts, and repository world-model grounding
  - Configurable artifact templates, phase inputs, approvals, and quality gates
  - Jira or manual intake with supporting documents
  - Requirements-to-code traceability, verification, and conformance reporting
  - Atomic Git commit/push state transfer, including every approval decision
  - Remote Markdown prompt packs and an Electron configuration desktop
  - Per-phase token and model usage reporting when the provider exposes it
  - A redacted, machine-local activity log readable from the CLI and Copilot

Command namespace:
  Copilot: /sflow-<action>     Example: /sflow-start, /sflow-next, /sflow-about
  Terminal: sflow-<action>     Example: sflow-next, sflow-about
  Compatibility: singularity-flow <action>

Workflow state lives in committed work-item branches, so another person or
terminal can fetch the branch and continue without a separate workflow database.

Run /sflow-help in Copilot or singularity-flow help in a terminal for the full guide.`;

const HELP = `Singularity Flow ${VERSION}

Personal Copilot skills plus a deterministic Git-native SDLC utility.

Usage:
  singularity-flow about
  singularity-flow help [TOPIC] [--json]
  singularity-flow init [--repair] [--work-id WORK-ID] [--base BRANCH] [--fetch]
  singularity-flow init --check [--json]
  singularity-flow start <WORK-ID> [--jira | --story-file FILE] [--title TEXT] [--description TEXT]
    [--acceptance-criteria TEXT] [--document FILE]... [--document-url URL]... [--base BRANCH] [--fetch] [--allow-dirty]
    [--ref CANONICAL-BRANCH] [--selection-receipt TOKEN]
  singularity-flow choices begin start <WORK-ID> [--json]
  singularity-flow choices begin approve <WORK-ID> [--fetch] [--json]
  singularity-flow choices answer <TOKEN> <CHOICE> <ID> [--json]
  singularity-flow choices status <TOKEN> [--json]
  singularity-flow resume <WORK-ID|BRANCH> [--fetch] [--allow-dirty]
  singularity-flow lens [WORK-ID]
  singularity-flow session status|candidates [--json]
  singularity-flow session attach <WORK-ID> [--json]
  singularity-flow inbox [--offline] [--json]
  singularity-flow status [WORK-ID] [--json]
  singularity-flow progress [WORK-ID] [--json]
  singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE]
  singularity-flow telemetry status [--json]
  singularity-flow telemetry reconcile [PHASE] [--json]
  singularity-flow ledger init [--json]
  singularity-flow ledger doctor [--json]
  singularity-flow ledger status [--json]
  singularity-flow ledger log [--limit N] [--json]
  singularity-flow ledger show <HASH|EVENT-ID> [--json]
  singularity-flow ledger verify [--offline] [--json]
  singularity-flow ledger reconcile [WORK-ID] [--json]
  singularity-flow ledger archive [--out FILE] [--sign] [--json]
  singularity-flow capabilities list [--json]
  singularity-flow capabilities show <ID> [--json]
  singularity-flow capabilities lease grant <ID> --expires ISO --reason TEXT --policy FILE_OR_JSON --confirm <ID>
  singularity-flow capabilities lease revoke <ID> <LEASE-ID> --reason TEXT --confirm <ID>
  singularity-flow guide [WORK-ID] [--json]
  singularity-flow nextsteps [WORK-ID] [--json]
  singularity-flow next [--task TEXT] [--fetch] [--yes] [--skip-checks]
  singularity-flow run [--task TEXT] [--yes]
  singularity-flow doctor [WORK-ID] [--offline] [--json]
  singularity-flow review [PHASE] [--format md|html|json] [--out FILE]
  singularity-flow workflow list | simulate [TYPE] | diff <TYPE> | add <TYPE> [--dry-run] [--replace]
  singularity-flow assign <PHASE> <ASSIGNEE>
  singularity-flow watch [WORK-ID] [--once] [--fetch] [--interval SECONDS] [--json]
  singularity-flow recover [WORK-ID] [--fetch] [--apply] [--json]
  singularity-flow inputs [PHASE] [--dry-run]
  singularity-flow prompt-packs list
  singularity-flow prompt-packs mappings
  singularity-flow prompt-packs lock <PACK> [--update]
  singularity-flow prompt-packs sync <PACK>
  singularity-flow prompt-packs status [PACK]
  singularity-flow prompt-packs refresh-output <RESOURCE-ID> [--replace]
  singularity-flow documents list [WORK-ID] [--json]
  singularity-flow documents view <DOCUMENT-ID|PATH> [--work-id ID] [--json]
  singularity-flow documents preview <DOCUMENT-ID|PATH> [--work-id ID] [--json]
  singularity-flow documents upload <FILE-OR-DIRECTORY...> [--url URL] [--label TEXT] [--kind KIND]
  singularity-flow prepare [PHASE]
  singularity-flow phase show [PHASE] [--json]
  singularity-flow phase publish [PHASE] [--usage-json FILE]
  singularity-flow artifact add <PATH...> [--kind KIND] [--phase PHASE]
  singularity-flow artifact scan [--phase PHASE]
  singularity-flow submit [--phase PHASE] [--skip-checks]
  singularity-flow approve [WORK-ID] [--fetch] [--phase PHASE] [--yes]
  singularity-flow reject [WORK-ID] [--fetch] --reason TEXT [--to PHASE]
  singularity-flow sync
  singularity-flow migrate-config
  singularity-flow validate [--strict]
  singularity-flow gate [--terminal]
  singularity-flow wm init
  singularity-flow wm build [--branch BRANCH] [--remote REMOTE] [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth quick|standard|deep] [--parallel|--no-parallel] [--workers N]
  singularity-flow wm context <PHASE> [--branch BRANCH] [--remote REMOTE] [--task TEXT] [--concat] [--evidence] [--no-persona]
  singularity-flow wm compose [--persona ID] [--phase ID] [--work-id ID] [--task TEXT] [--evidence] [--dry-run|--render-only] [--out FILE]
  singularity-flow wm show-prompt [--phase ID] [--work-id ID] [--skill ID] [--task TEXT] [--evidence]
  singularity-flow wm inject [same options]              Compatibility alias for wm compose
  singularity-flow wm check [--branch BRANCH] [--remote REMOTE]
  singularity-flow jira status [--json]
  singularity-flow jira doctor [--json]
  singularity-flow jira assigned [--project KEY] [--type Story] [--limit 25] [--json]
  singularity-flow jira list [same options]             Compatibility alias for jira assigned
  singularity-flow jira projects [--query TEXT]
  singularity-flow jira epics --project KEY
  singularity-flow jira children EPIC-KEY
  singularity-flow jira permissions --project KEY
  singularity-flow jira boards [--project KEY] [--limit 100] [--json]
  singularity-flow jira board <BOARD-ID> [--state active,future] [--type Story] [--limit 500] [--json]
  singularity-flow jira pull <WORK-ID> [--json]
  singularity-flow jira show <WORK-ID> [--json]      Alias for jira pull
  singularity-flow jira fields [--query TEXT] [--json]
  singularity-flow jira transitions <WORK-ID> [--json]
  singularity-flow jira transition <WORK-ID> --to STATUS --confirm <WORK-ID> [--expected-updated-at ISO] [--json]
  singularity-flow jira assign <WORK-ID> --to me|unassigned|ACCOUNT-ID --confirm <WORK-ID> [--json]
  singularity-flow jira priority <WORK-ID> --to NAME|ID --confirm <WORK-ID> [--json]
  singularity-flow jira sprint <WORK-ID> --to SPRINT-ID --confirm <WORK-ID> [--json]
  singularity-flow jira comment <WORK-ID> --text TEXT --confirm <WORK-ID> [--json]
  singularity-flow plugin install                     Installs plugin plus direct /sf-* personal skills
  singularity-flow plugin uninstall | list | path
  singularity-flow desktop snapshot [WORK-ID] --json
  singularity-flow desktop validate --json
  singularity-flow desktop save <PATH>          Reads replacement content from stdin
  singularity-flow desktop read <PATH> --json
  singularity-flow desktop export-bundle --json
  singularity-flow desktop delete-file <PATH> --json
  singularity-flow desktop delete-template <PATH> --json
  singularity-flow desktop publish [--message TEXT] --json
  singularity-flow desktop session <PERSONA> [--work-id ID] --json
  singularity-flow initiative profiles [--json]
  singularity-flow initiative choices begin start|approve <INIT-ID> [SUBJECT] [--json]
  singularity-flow initiative start <INIT-ID> [--jira] [--title TEXT] [--description TEXT] [--selection-receipt TOKEN]
  singularity-flow initiative resume <INIT-ID> [--fetch]
  singularity-flow initiative restart <INIT-ID> [--reason TEXT] [--confirm INIT-ID]
  singularity-flow knowledge [list] [--type TYPE] [--status open|resolved] [--tag TAG] [--query TEXT] [--json]
  singularity-flow knowledge show <SHA256> [--json]
  singularity-flow knowledge record <decision|learning|uncertainty|result> --title TEXT [--detail TEXT] [--tags a,b]
  singularity-flow knowledge harvest [--initiative INIT-ID] [--phase PHASE] [--dry-run] [--json]
  singularity-flow knowledge resolve <SHA256> --resolution TEXT [--json]

  singularity-flow initiative status [INIT-ID] [--json]
  singularity-flow initiative next [INIT-ID] [--json]
  singularity-flow initiative outputs [PHASE] [--include a,b,c] [--reason TEXT]
  singularity-flow initiative applicability [--json]
  singularity-flow initiative applicability set <POLICY> <yes|no> [--reason TEXT] [--json]
  singularity-flow initiative phase [publish] [PHASE]
  singularity-flow initiative context [PHASE] [--persona ID] [--dry-run] [--json]
  singularity-flow initiative documents [PHASE] [--json]
  singularity-flow initiative checklist [PHASE] [--json]
  singularity-flow initiative evidence add <CHECK-ID> --assurance LEVEL [--path FILE | --url URL]
  singularity-flow initiative evidence list [CHECK-ID] [--json]
  singularity-flow initiative verify [PHASE] [--json]
  singularity-flow initiative approve <OUTPUT|CHECK|phase> [--selection-receipt TOKEN]
  singularity-flow initiative reject <OUTPUT|CHECK|phase> --reason TEXT
  singularity-flow initiative breakdown [--probe] [--json]
  singularity-flow initiative materialize [--dry-run] [--confirm INIT-ID]
  singularity-flow initiative jira-adopt EPIC-KEY [--repository JIRA-KEY=REPO] [--dry-run]
  singularity-flow initiative jira-plan
  singularity-flow initiative jira-apply --plan SHA256 [--confirm INIT-ID]
  singularity-flow initiative sync
  singularity-flow initiative contracts [add] [--id ID --version VERSION --format FORMAT --path FILE]
  singularity-flow initiative report [INIT-ID] [--format md|json] [--out FILE]
  singularity-flow initiative gate [INIT-ID] [--terminal] [--json]
  singularity-flow epic start <EPIC-KEY> [--selection-receipt TOKEN]
  singularity-flow epic start --local --title "Epic title" --description TEXT --goal TEXT [--persona ID]
  singularity-flow epic sources [list|add|note|answer|verify|materialize] [--epic EPIC-KEY]
    [--provider ID] [--file PATH | --url URL] [--label TEXT] [--mime TYPE]
    [--text TEXT | --text-file FILE]
  singularity-flow epic requirements prepare|status|publish|approve
  singularity-flow epic planning prepare|status|validate|publish|approve
    Approving the Story plan is an explicit business review: it needs the exact
    "<phase>:<subject>" confirmation, and --acknowledge-self-approval when you
    generated any of its outputs yourself.
  singularity-flow epic stories list|show|update|split|adopt|validate|metadata|tasks
    update <PLAN-ID> [--metadata KEY=VALUE]... [--tasks-file FILE]
    split <PLAN-ID> [--title TEXT] [--repository ID] [--metadata KEY=VALUE]...
    adopt <JIRA-KEY> --repository ID --requirements REQ-nnn --acceptance-criteria AC-nnn
    metadata <PLAN-ID> list|set|remove|clear [KEY] [VALUE]
    tasks <PLAN-ID> list|add|update|remove [TASK-ID] [--title TEXT] [--description TEXT]
  singularity-flow epic jira preview|apply [--epic EPIC-KEY] [--plan SHA256]
  singularity-flow epic create-stories [--epic EPIC-KEY] [--plan SHA256] [--confirm EPIC-KEY]  Deprecated mapping target
    [--artifact PHASE/OUTPUT]... [--artifact-to epic|stories|both]
  singularity-flow epic status|sync|next|report|resume|journey [EPIC-KEY]
  singularity-flow epic merge-plan [--epic EPIC-KEY]
  singularity-flow epic complete [EPIC-KEY] [--dry-run] [--json] [--confirm EPIC-KEY]
  singularity-flow epic review [STORY-KEY] [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic review-choice begin approve|reject <STORY-KEY> [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic review-choice answer <TOKEN> <CHOICE> <ID>
  singularity-flow epic review-choice status <TOKEN>
  singularity-flow epic review approve|reject <STORY-KEY> --packet SHA256
    [--selection-receipt TOKEN] [--to PHASE] [--reason TEXT]
  singularity-flow epic checks <STORY-KEY> [--epic EPIC-KEY] [--packet SHA256]
  singularity-flow epic drift observe|adopt|restore-plan [--epic EPIC-KEY]
  singularity-flow story branch create <BRANCH> --parent <STORY-KEY>
  singularity-flow story branch attach|status|promote --parent <STORY-KEY> [--mode pr|direct]
  singularity-flow story start <STORY-KEY> [--selection-receipt TOKEN] [--fetch]
  singularity-flow story inbox [--assigned-to-me] [--project KEY] [--json]
  singularity-flow story fetch <STORY-KEY> [--directory PATH] [--json]
  singularity-flow story submit
  singularity-flow story checks [--parent STORY-KEY] [--packet SHA256]
  singularity-flow story finalize [--json]
  singularity-flow finalize [--json]
  singularity-flow workspace create --jira KEY --base DIRECTORY --lead REPOSITORY
    --repository ID=URL [--repository ID=URL] [--confirm KEY] [--no-clone]
  singularity-flow workspace create --local --id ID [--name TEXT] --lead REPOSITORY
    --repository ID=URL [--base DIRECTORY] [--confirm ID] [--no-clone] [--dry-run]
  singularity-flow workspace update <DIRECTORY> [--name TEXT] [--lead ID]
    [--repository ID=URL] [--confirm KEY] [--dry-run] [--json]
  singularity-flow workspace archive <DIRECTORY> --confirm KEY [--json]
  singularity-flow workspace restore <DIRECTORY> [--json]
  singularity-flow workspace list [--json]
  singularity-flow workspace current [--json]
  singularity-flow workspace use [ID|NAME|JIRA|DIRECTORY] [--repository ID] [--story ID] [--json]
  singularity-flow workspace copilot [ID|NAME|JIRA|DIRECTORY]
    [--repository ID] [--story ID] [--mode interactive|plan] [--dry-run]
  singularity-flow workspace prompt [--json]
  singularity-flow workspace open <DIRECTORY> [--json]
  singularity-flow workspace status <DIRECTORY> [--json]
  singularity-flow workspace sync <DIRECTORY> [--json]
  singularity-flow workspace repair <DIRECTORY> [--json]
  singularity-flow workspace documents <DIRECTORY> [--json]
  singularity-flow workspace documents import <DIRECTORY> <FILE...> [--json]
  singularity-flow workspace forget <DIRECTORY> [--json]

Optional Jira environment:
  JIRA_BASE_URL=https://company.atlassian.net
  JIRA_EMAIL=user@company.com
  JIRA_API_TOKEN=...
  # Data Center alternative:
  JIRA_DEPLOYMENT=data-center
  JIRA_PAT=...
  SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD=customfield_12345
  SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD=customfield_10016
  SINGULARITY_FLOW_JIRA_SPRINT_FIELD=customfield_10020
  SINGULARITY_FLOW_JIRA_EXTRA_FIELDS=customfield_10001,customfield_10002

Typical flow:
  singularity-flow start ENG-142
  singularity-flow prepare intake
  singularity-flow phase publish intake
  singularity-flow submit
  singularity-flow approve --yes
`;

function summary(workflow) {
  const active = currentPhase(workflow);
  console.log(`\n${workflow.workItem.id} — ${workflow.workItem.title}`);
  console.log(`Branch: ${workflow.workItem.branch}`);
  console.log(`World-model grounding: ${workflow.resolution?.worldModelGrounding ?? 'off'}`);
  console.log(`Status: ${workflow.status}`);
  console.log(`Current phase: ${active ? `${active.id} (${active.status})` : 'complete'}`);
  if (active) {
    console.log(`Suggested working lens: ${active.owner ?? 'unassigned'}`);
    console.log(`Required artifact: ${active.requiredArtifact?.path ?? 'none'}`);
    console.log(`Registered artifacts: ${active.artifacts.length}`);
  }
  if (workflow.sequenceOverrides?.length) console.warn(`Warning: ${workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded for this work item.`);
}

function actionActor(root) {
  return process.env.SINGULARITY_FLOW_GITHUB_ACTOR
    ? { name: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, login: process.env.SINGULARITY_FLOW_GITHUB_ACTOR, email: null }
    : identity(root);
}

async function confirm(phase) {
  if (!input.isTTY || !output.isTTY) throw new SingularityFlowError('Approval needs an interactive terminal or the explicit --yes flag.');
  const io = readline.createInterface({ input, output });
  try {
    const answer = await io.question(`Type ${phase.id} to approve ${phase.label}: `);
    return answer.trim() === phase.id;
  } finally {
    io.close();
  }
}

async function confirmExact(prompt, expected) {
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_AGENT_CONFIRM === expected) return true;
    throw new SingularityFlowError(`Trusting prompt pack '${expected}' requires an interactive terminal and exact pack-name confirmation.`);
  }
  const io = readline.createInterface({ input, output });
  try { return (await io.question(`${prompt}\nType ${expected} to continue: `)).trim() === expected; }
  finally { io.close(); }
}

async function confirmYesNo(prompt) {
  if (!input.isTTY || !output.isTTY) return false;
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
      if (!status.complete) console.log('Fix: singularity-flow init --repair');
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
    : `Verified ${WORKFLOW_PATH}, templates, prompts, and working lenses; nothing needed repair.`);
  if (workId) {
    console.log(`Initialized Singularity Flow on Work-ID branch ${workId}; the base branch was not modified.`);
    console.log(`Next: review and commit singularity/, push ${workId}, then run singularity-flow start ${workId}.`);
  }
}

async function helpCommand(positionals, options) {
  const document = await loadHelpDocument(positionals[1]);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(document, null, 2));
  else process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
}

async function startCommand(positionals, options) {
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  const config = await loadConfig(root);
  validateId(config, id);
  const receiptToken = optionString(options, 'selection-receipt');
  const receipt = receiptToken ? await resolveSelectionReceipt(root, config, receiptToken, { action: 'start', workId: id }) : null;
  if (!optionBoolean(options, 'allow-dirty')) assertClean(root);
  const jira = optionBoolean(options, 'jira');
  const storyFile = optionString(options, 'story-file');
  if (jira && storyFile) throw new SingularityFlowError('Choose either --jira or --story-file, not both.');
  const title = optionString(options, 'title');
  const description = optionString(options, 'description');
  const acceptanceCriteria = optionString(options, 'acceptance-criteria');
  const explicitFiles = optionStrings(options, 'document');
  const explicitUrls = optionStrings(options, 'document-url');
  const hasManualInput = Boolean(storyFile || title || description || acceptanceCriteria || explicitFiles.length || explicitUrls.length);
  const declaredSource = jira ? 'jira' : hasManualInput ? 'manual' : null;
  const receiptSource = receipt?.answers['intake-source'] ?? null;
  if (declaredSource && receiptSource && declaredSource !== receiptSource) throw new SingularityFlowError(`Selection receipt chose ${receiptSource} intake, but the start command explicitly requests ${declaredSource} intake.`);
  const sourceMode = declaredSource ?? await selectIntakeSource({ selection: receiptSource });
  const manual = sourceMode === 'manual'
    ? (storyFile || title || description || acceptanceCriteria
        ? await loadManualStory(id, { storyFile, title, description, acceptanceCriteria })
        : await promptManualStory(id))
    : null;
  let source = sourceMode === 'jira' ? await getIssue(id) : manual.source;
  const supportingDocuments = [
    ...(manual?.documents ?? []),
    ...explicitFiles.map((candidate) => ({ type: 'file', path: candidate, label: null, kind: null })),
    ...explicitUrls.map((url) => ({ type: 'url', url, label: null, kind: null }))
  ];
  const workType = await selectWorkType(config, { selection: receipt?.answers['workflow-template'] ?? null });
  const selectedPersona = await selectPersona(root, config, actionActor(root), id, { selection: receipt?.answers.persona ?? null });
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);

  const explicitBase = optionString(options, 'base');
  const canonicalBranch = optionString(options, 'ref', id);
  let base = explicitBase ?? config.defaultBaseBranch;
  checkout(root, canonicalBranch, { base, fetch: optionBoolean(options, 'fetch') });
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
    canonicalBranch,
    workType,
    persona: selectedPersona.persona,
    resolved: resolveWorkType(config, workType)
  });
  await commitAndPublish(root, config, workflow, `[${id}][init] start ${workType} workflow`);
  for (const document of supportingDocuments) {
    const records = await addDocuments(root, config, workflow, {
      files: document.type === 'file' ? [document.path] : [],
      url: document.type === 'url' ? document.url : null,
      label: document.label,
      kind: document.kind
    });
    await commitAndPublish(root, config, workflow, `[${id}][documents][upload] ${records.map((item) => item.id).join(',')}`);
  }
  summary(workflow);
  if (supportingDocuments.length) console.log(`Supporting documents: ${supportingDocuments.length} uploaded and published.`);
  console.log('\nTemplate help: /sflow-help');
  console.log('\nNext in Copilot: /sflow-phase');
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
      if (workId !== branch(root) || optionBoolean(options, 'fetch')) checkout(root, workId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
      config = await loadConfig(root);
      workflow = await loadWorkflow(root, config, workId);
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
  const initialConfig = await loadConfig(root);
  const resolved = await resolveWorkItem(root, initialConfig, reference, { mutation: true });
  validateId(initialConfig, resolved.workId);
  if (branch(root) !== resolved.branch && !optionBoolean(options, 'allow-dirty')) assertClean(root);
  checkout(root, resolved.branch, { base: initialConfig.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, resolved.workId);
  const session = await selectPersona(root, config, actionActor(root), resolved.workId);
  summary(workflow);
  console.log(`Active working lens: ${session.persona}`);
  const active = currentPhase(workflow);
  if (active) {
    const command = active.id === 'implementation' ? 'implement' : active.id === 'verification' ? 'verify' : active.id;
    console.log(`\nResume in Copilot: /sflow-${command}`);
  }
}

async function personaCommand(positionals) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  if (!workflowBranchAllowed(workflow, branch(root))) {
    throw new SingularityFlowError(`Branch '${branch(root)}' is not registered for Story '${workflow.workItem.id}'. Run singularity-flow story branch attach --parent ${workflow.workItem.id}.`);
  }
  const session = await selectPersona(root, config, actionActor(root), workflow.workItem.id);
  console.log(`Active working lens: ${config.personas[session.persona].label} (${session.persona})`);
  console.log(`Session scope: ${workflow.workItem.id} on branch ${branch(root)} (canonical ${workflow.workItem.branch})`);
  console.log('The selection is local to this checkout and will be recorded with the next workflow action.');
}

async function statusCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  if (optionBoolean(options, 'json')) {
    console.log(JSON.stringify(workflow, null, 2));
    return;
  }
  summary(workflow);
  console.log(`\n${table(workflow.phaseOrder.map((id, index) => {
    const phase = workflow.phases[id];
    return { index: index + 1, phase: id, owner: phase.owner ?? '', status: phase.status, artifacts: phase.artifacts.length };
  }), [
    { key: 'index', label: '#' },
    { key: 'phase', label: 'PHASE' },
    { key: 'owner', label: 'OWNER' },
    { key: 'status', label: 'STATUS' },
    { key: 'artifacts', label: 'ARTIFACTS' }
  ])}`);
  const selfApprovals = workflow.phaseOrder.flatMap((id) => workflow.phases[id].approvals.filter((item) => !item.invalidatedAt && item.selfApproval).map((item) => `${id}: ${item.actor?.name ?? 'unknown'}; lens ${item.workingLens ?? item.persona ?? 'unavailable'}`));
  if (selfApprovals.length) console.warn(`\nSelf-approval warnings (not independent review):\n- ${selfApprovals.join('\n- ')}`);
  const ledger = await ledgerStatus(root, workflow.resolution?.ledger ?? config.ledger ?? {});
  if (ledger.enabled) {
    console.log(`\nCapability ledger: ${ledger.initialized ? ledger.verification.valid ? 'verified' : 'invalid' : 'not initialized'} · pending ${ledger.pending?.length ?? 0} · local outbox ${ledger.outbox}`);
    if (ledger.pending?.length) console.warn(`Run singularity-flow ledger reconcile ${workflow.workItem.id}.`);
  }
}

async function progressCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config, positionals[1]); const progress = progressSnapshot(workflow);
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
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError(`Unknown report format: ${format}. Use md, html, or json.`);
  const report = deriveReport(workflow, { pricing: config.tokens?.pricing ?? null });
  const rendered = format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : format === 'html' ? renderHtml(report) : renderMarkdown(report);
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = path.resolve(root, outputFile);
    await writeText(absolute, rendered);
    console.log(`Report written to ${absolute}`);
    return;
  }
  process.stdout.write(rendered);
}

async function guideCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  const guide = workflowGuide(workflow);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(guide, null, 2));
  else process.stdout.write(guideText(guide));
}

async function nextStepsCommand(positionals, options) {
  const root = repoRoot();
  const initialized = existsSync(path.join(root, WORKFLOW_PATH)) || existsSync(path.join(root, 'singularity/config.json'));
  let snapshot;
  if (!initialized) snapshot = nextStepsSnapshot({ initialized: false, branch: branch(root) });
  else {
    const config = await loadConfig(root);
    const requestedWorkId = positionals[1] ?? null;
    const id = requestedWorkId ?? branch(root);
    if (existsSync(workflowPath(root, config, id))) {
      const workflow = await loadWorkflow(root, config, id);
      const prerequisites = [];
      const active = currentPhase(workflow); const session = await loadSession(root, { required: false });
      if (active && workflow.resolution?.collaboration?.assignmentMode === 'required' && !workflow.collaboration?.assignments?.[active.id]) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Phase '${active.id}' requires an explicit assignment before the team continues.` });
      else if (active && workflow.resolution?.collaboration?.assignmentMode === 'suggested' && !workflow.collaboration?.assignments?.[active.id]) prerequisites.push({ timing: 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who is coordinating '${active.id}' so another terminal can see ownership.` });
      if (active?.status === 'in_progress' && !session?.persona) prerequisites.push({
        timing: 'now', skill: '/sflow-resume', command: `singularity-flow resume ${workflow.workItem.id} --fetch`,
        reason: 'Select the working lens that will remain active for this terminal session before generation.'
      });
      if (active?.status === 'in_progress' && phaseNeedsGeneration(workflow, active) && (workflow.resolution?.worldModelGrounding ?? config.worldModel?.grounding ?? 'off') !== 'off') {
        const rebuildReason = await worldModelRebuildReason(root, config);
        const task = '<current objective>';
        if (rebuildReason) {
          prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow wm build --phase ${active.id} --task "${task}"`, reason: rebuildReason });
          prerequisites.push({ timing: 'then', skill: null, command: `singularity-flow wm compose --phase ${active.id} --task "${task}"`, reason: 'Compose and record the governed phase prompt using the exact same task text.' });
        } else {
          const grounding = await verifyGroundingRecord(root, config, workflow, active, { persona: session?.persona ?? null });
          if (grounding.errors.length || grounding.warnings.length) prerequisites.push({
            timing: 'now', skill: null, command: `singularity-flow wm compose --phase ${active.id} --task "${task}"`,
            reason: 'Create or refresh the required grounding record and exact prompt snapshot before publishing this generation.'
          });
        }
      }
      if (active?.status === 'in_progress' && session?.agent) {
        const status = (await agentStatus(root, session.agent))[0];
        if (!status) prerequisites.push({ timing: 'now', skill: null, command: 'singularity-flow prompt-packs list', reason: `Active prompt pack '${session.agent}' is no longer available; choose and sync an available pack.` });
        else if (status.status === 'unlocked') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow prompt-packs lock ${session.agent}`, reason: `Review and trust the active prompt pack's remote Markdown before generation.` });
        else if (status.status === 'stale') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow prompt-packs lock ${session.agent} --update`, reason: 'The active prompt-pack Markdown changed after it was locked; review the new dependency hashes.' });
        if (status && !['ready', 'local-only'].includes(status.status)) prerequisites.push({ timing: ['unlocked', 'stale'].includes(status.status) ? 'then' : 'now', skill: null, command: `singularity-flow prompt-packs sync ${session.agent}`, reason: 'Verify the pinned hashes and materialize the active prompt-pack cache.' });
        for (const conflict of await remoteOutputConflicts(active, { itemDirectory: workDir(root, config, workflow.workItem.id) })) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow prompt-packs refresh-output ${conflict.resource}`, reason: `Remote output ${conflict.target} has local changes; review them before deciding whether to add --replace.` });
      }
      snapshot = nextStepsSnapshot({
        branch: branch(root),
        workflow,
        publicationPending: existsSync(pendingPublicationPath(root, config, workflow.workItem.id)),
        prerequisites
      });
    } else snapshot = nextStepsSnapshot({ branch: branch(root), requestedWorkId });
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, 2));
  else process.stdout.write(nextStepsText(snapshot));
}

async function nextCommand(options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  if (existsSync(pendingPublicationPath(root, config, workflow.workItem.id))) {
    console.log('Next step: publish the retained local commit.');
    return syncCommand();
  }
  const phase = currentPhase(workflow);
  if (!phase) {
    console.log('Next step: run the terminal governance gate for the completed workflow.');
    return gateCommand({ ...options, terminal: true });
  }
  if (phase.status === 'awaiting_approval') {
    console.log(`Next step: review and decide submitted phase '${phase.id}'.`);
    return approveCommand(['approve', workflow.workItem.id], { ...options, fetch: optionBoolean(options, 'fetch', true) });
  }
  if (phase.status !== 'in_progress') throw new SingularityFlowError(`Cannot automatically continue phase '${phase.id}' while it is ${phase.status}. Run singularity-flow nextsteps ${workflow.workItem.id}.`);
  if (!phaseNeedsGeneration(workflow, phase)) {
    console.log(`Next step: submit published phase '${phase.id}' for approval.`);
    return submitCommand({ ...options, phase: phase.id });
  }

  const task = optionString(options, 'task', workflow.workItem.title);
  const grounding = workflow.resolution?.worldModelGrounding ?? 'off';
  if (grounding !== 'off') {
    const rebuildReason = await worldModelRebuildReason(root, config);
    if (rebuildReason) {
      console.log(`Next step prerequisite: ${rebuildReason}`);
      await worldModelCommand(root, ['wm', 'build'], { phase: phase.id, task });
    }
    await worldModelCommand(root, ['wm', 'compose'], { phase: phase.id, task, evidence: phase.worldModel?.evidence === true });
  }
  const artifact = await preparePhase(root, config, workflow, phase.id);
  await saveWorkflow(root, config, workflow);
  console.log(`Next step prepared: generate '${phase.id}' using ${artifact}.`);
  console.log(`After authoring and validation, publish it with: singularity-flow phase publish ${phase.id}`);
}

async function documentsCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'documents subcommand'); const root = repoRoot(); const config = await loadConfig(root);
  if (subcommand === 'list') {
    const workflow = await loadWorkflow(root, config, positionals[2]); const records = await documentCatalog(root, config, workflow);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(records, null, 2));
    if (!records.length) return console.log('No documents found.');
    return console.log(table(records.map((item) => ({ id: item.id, type: item.type, phase: item.phase ?? '', label: item.label, location: item.url ?? item.path ?? '' })), [
      { key: 'id', label: 'ID' }, { key: 'type', label: 'TYPE' }, { key: 'phase', label: 'PHASE' }, { key: 'label', label: 'LABEL' }, { key: 'location', label: 'LOCATION' }
    ]));
  }
  if (subcommand === 'view') {
    const reference = requirePositional(positionals, 2, 'document ID or path'); const workflow = await loadWorkflow(root, config, optionString(options, 'work-id')); const result = await viewDocument(root, config, workflow, reference);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.record.id} — ${result.record.label}`); console.log(`Type: ${result.record.type}${result.record.mimeType ? ` (${result.record.mimeType})` : ''}`);
    if (result.record.url) console.log(`URL: ${result.record.url}`);
    else console.log(`Path: ${result.absolutePath ?? pathForDisplay(root, result.record.path)}`);
    if (result.binary) console.log('Binary document: use the path above in an image, PDF, Figma, or desktop viewer.');
    else if (result.content != null) process.stdout.write(`\n${result.content}`);
    return;
  }
  if (subcommand === 'preview') {
    const reference = requirePositional(positionals, 2, 'document ID or path');
    const workflow = await loadWorkflow(root, config, optionString(options, 'work-id'));
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
    const workflow = await loadWorkflow(root, config); const records = await addDocuments(root, config, workflow, { files: positionals.slice(2), url: optionString(options, 'url'), label: optionString(options, 'label'), kind: optionString(options, 'kind') });
    const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][documents][upload] ${records.map((item) => item.id).join(',')}`);
    records.forEach((record) => console.log(`${record.id}\t${record.type}\t${record.url ?? record.path}`)); console.log(`Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`); return;
  }
  if (subcommand === 'browse') {
    const workflow = await loadWorkflow(root, config, optionString(options, 'work-id'));
    const result = await listRemoteDocuments(config, { providerId: optionString(options, 'provider'), path: optionString(options, 'path', '') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`${result.providerId} (${result.providerType})`);
    if (!result.entries.length) return console.log('No entries.');
    return console.log(table(result.entries.map((entry) => ({ name: entry.name, kind: entry.folder ? 'folder' : 'file', id: entry.id, size: entry.folder ? '' : entry.size ?? '' })), [
      { key: 'name', label: 'NAME' }, { key: 'kind', label: 'KIND' }, { key: 'size', label: 'BYTES' }, { key: 'id', label: 'ITEM ID' }
    ]));
  }
  if (subcommand === 'fetch') {
    const workflow = await loadWorkflow(root, config);
    const records = await fetchRemoteDocument(root, config, workflow, {
      providerId: optionString(options, 'provider'),
      remoteRef: optionString(options, 'ref') ?? positionals[2],
      name: optionString(options, 'name'),
      label: optionString(options, 'label'),
      kind: optionString(options, 'kind')
    });
    const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][documents][fetch] ${records.map((item) => item.id).join(',')}`);
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
  const workflow = await loadWorkflow(root, config);
  console.log(await preparePhase(root, config, workflow, positionals[1]));
  await saveWorkflow(root, config, workflow);
}

async function inputsCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const dryRun = optionBoolean(options, 'dry-run');
  const result = await preparePhaseInputs(root, config, workflow, positionals[1], { dryRun });
  if (!dryRun) await saveWorkflow(root, config, workflow);
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

async function promptPacksCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'prompt-packs subcommand');
  const root = repoRoot();
  if (subcommand === 'list') {
    const agents = await discoverAgents(root);
    if (!agents.length) return console.log('No repository or bundled prompt packs found.');
    return console.log(table(agents.map((agent) => ({ id: agent.id, scope: agent.scope, source: agent.source, dependencies: agent.dependencies.length })), [
      { key: 'id', label: 'PACK' }, { key: 'scope', label: 'SCOPE' }, { key: 'source', label: 'SOURCE' }, { key: 'dependencies', label: 'REMOTE' }
    ]));
  }
  if (subcommand === 'mappings') {
    const result = await agentMappingStatus(root);
    console.log(`Copilot agent mappings: ${result.path}${result.exists ? '' : ' (not created; same-name fallback only)'}`);
    if (!result.rows.length) return console.log('No Copilot agents or Singularity Flow prompt packs were discovered.');
    return console.log(table(result.rows, [
      { key: 'copilotAgent', label: 'COPILOT AGENT' },
      { key: 'promptPack', label: 'FLOW PROMPT PACK' },
      { key: 'source', label: 'RESOLUTION' }
    ]));
  }
  if (subcommand === 'lock') {
    const agentId = requirePositional(positionals, 2, 'prompt pack');
    const update = optionBoolean(options, 'update');
    const preview = await lockAgent(root, agentId, { update });
    console.log(`Prompt pack: ${agentId}\nSource: ${preview.agent.source}\nPack SHA-256: ${preview.agent.sha256}`);
    if (preview.resolution.dependencies.length) console.log(table(preview.resolution.dependencies.map((entry) => { const previous = preview.existing?.dependencies?.find((item) => item.id === entry.id && item.type === entry.type); return { id: entry.id, type: entry.type, previous: previous?.sha256?.slice(0, 12) ?? '', sha256: entry.sha256?.slice(0, 16) ?? entry.status ?? 'dynamic', bytes: entry.size ?? '', url: entry.url ?? entry.urlTemplate }; }), [
      { key: 'id', label: 'RESOURCE' }, { key: 'type', label: 'TYPE' }, { key: 'previous', label: 'PREVIOUS' }, { key: 'sha256', label: 'NEW SHA256' }, { key: 'bytes', label: 'BYTES' }, { key: 'url', label: 'URL' }
    ]));
    if (!(await confirmExact(update ? 'This will replace the trusted hashes shown above.' : 'This is the first trust decision for these public HTTPS Markdown dependencies.', agentId))) throw new SingularityFlowError('Prompt-pack lock cancelled.');
    await lockAgent(root, agentId, { update, accepted: true, resolution: preview.resolution });
    return console.log(`Locked '${agentId}' in singularity/agents.lock.yml.`);
  }
  if (subcommand === 'sync') {
    const agentId = requirePositional(positionals, 2, 'prompt pack');
    const result = await syncAgent(root, agentId);
    await setAgentSession(root, result.agent, actionActor(root));
    result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    console.log(`Active prompt pack: ${result.agent.id}. ${result.dependencies.filter((entry) => entry.status === 'ready').length} remote Markdown resource(s) verified and cached.`);
    return;
  }
  if (subcommand === 'status') {
    const requested = positionals[2] ?? null;
    const rows = await agentStatus(root, requested);
    if (requested && !rows.length) throw new SingularityFlowError(`Unknown prompt pack '${requested}'.`);
    if (!rows.length) return console.log('No repository or bundled prompt packs found.');
    console.log(table(rows.map((entry) => ({ id: entry.id, scope: entry.scope, status: entry.status, source: entry.source, resources: entry.dependencies.length })), [
      { key: 'id', label: 'PACK' }, { key: 'scope', label: 'SCOPE' }, { key: 'status', label: 'STATUS' }, { key: 'resources', label: 'REMOTE' }, { key: 'source', label: 'SOURCE' }
    ]));
    for (const entry of rows) for (const dependency of entry.dependencies) console.log(`  ${entry.id}/${dependency.id}\t${dependency.type}\t${dependency.status}\t${dependency.sha256?.slice(0, 12) ?? ''}`);
    return;
  }
  if (subcommand === 'refresh-output') {
    const resourceId = requirePositional(positionals, 2, 'resource ID');
    const config = await loadConfig(root); const workflow = await loadWorkflow(root, config); const phase = currentPhase(workflow);
    await assertNoPendingPublication(root, config, workflow, 'refresh remote generated output');
    await assertPhaseSequence(root, workflow, 'refresh remote generated output');
    const session = await loadSession(root);
    const itemDirectory = workDir(root, config, workflow.workItem.id);
    const refreshed = await prepareRemoteOutputs(root, workflow, phase, session, { itemDirectory, refresh: true, replace: optionBoolean(options, 'replace'), resourceId });
    phase.remoteOutputs = [...(phase.remoteOutputs ?? []).filter((entry) => !refreshed.outputs.some((output) => output.resource === entry.resource && output.generation === entry.generation)), ...refreshed.outputs];
    await preparePhaseInputs(root, config, workflow, phase.id);
    await saveWorkflow(root, config, workflow);
    refreshed.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    return console.log(`Refreshed remote generated artifact '${resourceId}'. It will be committed by the next phase publication.`);
  }
  throw new SingularityFlowError(`Unknown prompt-packs subcommand: ${subcommand}`);
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

function printPhaseReview(review) {
  console.log(`\nGenerated documents ready for review — ${review.workId} / ${review.phase} / generation ${review.generation}`);
  if (!review.documents.length) {
    console.log('No generated documents are registered for this phase.');
    return;
  }
  for (const [index, document] of review.documents.entries()) {
    console.log(`\n[${index + 1}] ${document.label} (${document.id})`);
    console.log(`Path: ${document.path}`);
    console.log(`Kind: ${document.kind ?? 'artifact'} | Type: ${document.mimeType ?? 'unknown'} | Bytes: ${document.size ?? 'unknown'} | SHA-256: ${document.sha256 ?? 'unavailable'}`);
    console.log(`View again: singularity-flow documents view ${document.id} --work-id ${review.workId}`);
    if (document.error) console.warn(`Warning: document preview unavailable: ${document.error}`);
    else if (document.binary) console.log(`Binary document: open ${document.absolutePath}`);
    else if (document.content != null) {
      console.log(`\n--- BEGIN ${document.path} ---`);
      process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
      console.log(`--- END ${document.path} ---`);
    }
  }
}

async function phaseCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'phase subcommand');
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  if (subcommand === 'show') {
    const phaseId = positionals[2] ?? workflow.currentPhase;
    const phase = workflow.phases[phaseId];
    if (!phase) throw new SingularityFlowError(`Unknown or unavailable phase '${phaseId ?? ''}'. Provide a phase ID.`);
    const review = await phaseReview(root, config, workflow, phase);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(review, null, 2));
    else printPhaseReview(review);
    return;
  }
  if (subcommand !== 'publish') throw new SingularityFlowError(`Unknown phase subcommand: ${subcommand}`);
  const usageFile = optionString(options, 'usage-json'); const usage = usageFile ? await readJson(usageFile) : null;
  const phase = await publishGeneration(root, config, workflow, { phaseId: positionals[2], usage });
  const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][generated:${phase.generation}] publish artifacts`, phase.artifacts.map((item) => item.path));
  console.log(`Published ${phase.id} generation ${phase.generation} at ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
  const telemetry = (phase.telemetry ?? []).find((item) => item.generation === phase.generation);
  const generationUsage = (phase.usage ?? []).filter((item) => item.generation === phase.generation);
  const tokens = generationUsage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0);
  const costs = generationUsage.map((item) => item.providerCost).filter(Number.isFinite);
  const providerCost = costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
  if (telemetry) {
    console.log(`Telemetry: ${telemetry.status} | Models: ${telemetry.models.join(', ') || 'unavailable'} | Tokens: ${tokens || 'unavailable'} | Provider cost: ${providerCost == null ? 'unavailable' : `$${providerCost.toFixed(6)}`}`);
    console.log(`Telemetry record: ${telemetry.path}`);
    if (telemetry.status === 'pending') console.log('Telemetry will be reconciled automatically on the next submit action, after Copilot exports this completed turn.');
  }
  printPhaseReview(await phaseReview(root, config, workflow, phase));
}

async function artifactCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'artifact subcommand');
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  await assertNoPendingPublication(root, config, workflow, 'change artifact registration');
  const phaseId = optionString(options, 'phase');
  if (subcommand === 'add') {
    const paths = positionals.slice(2);
    if (!paths.length) throw new SingularityFlowError('Provide at least one artifact path.');
    const records = [];
    for (const candidate of paths) records.push(await registerArtifact(root, workflow, candidate, { phaseId, kind: optionString(options, 'kind') }));
    await saveWorkflow(root, config, workflow);
    records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  if (subcommand === 'scan') {
    const records = await scanArtifacts(root, config, workflow, phaseId);
    await saveWorkflow(root, config, workflow);
    if (!records.length) console.log('No changed artifacts found.');
    else records.forEach((record) => console.log(`${record.kind}\t${record.path}`));
    return;
  }
  throw new SingularityFlowError(`Unknown artifact subcommand: ${subcommand}`);
}

async function pullRequestCommand(positionals, options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, positionals[1]);
  const plan = await storyPullRequestPlan(root, config, workflow);

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

async function submitCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  let workflow = await loadWorkflow(root, config);
  const reconciliation = await reconcilePhaseTelemetry(root, config, workflow, { phaseId: optionString(options, 'phase') });
  if (reconciliation.updated) {
    const telemetryPublication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${reconciliation.phase}][telemetry:${reconciliation.generation}] reconcile Copilot usage`);
    console.log(`Reconciled ${reconciliation.phase} generation ${reconciliation.generation} telemetry at ${telemetryPublication.sha.slice(0, 8)}${telemetryPublication.pushed ? ' and pushed' : ''}.`);
    console.log(`Models: ${reconciliation.models.join(', ') || 'unavailable'} | Tokens: ${reconciliation.usage.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0) || 'unavailable'} | Provider cost: ${reconciliation.providerCost == null ? 'unavailable' : `$${reconciliation.providerCost.toFixed(6)}`}`);
    workflow = await loadWorkflow(root, config);
  } else if (reconciliation.pending) console.warn(`Telemetry remains pending: ${reconciliation.reason}`);
  const phase = await submitPhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    runChecks: !optionBoolean(options, 'skip-checks')
  });
  const reviewPacket = await createStoryReviewPacket(root, config, workflow, phase);
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][submit] request approval`, [...phase.artifacts.map((item) => item.path), reviewPacket.path]);
  console.log(`\nSubmitted ${phase.id} phase for approval.`);
  console.log(`Commit: ${publication.sha.slice(0, 8)} — request approval (${workflow.workItem.id})`);
  console.log(`Push: ${publication.pushed ? `${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}` : 'disabled by git.publish: off'}`);
  console.log(`Review packet: ${reviewPacket.path} (${reviewPacket.packet.packetSha256.slice(0, 12)})`);
  printPhaseReview(await phaseReview(root, config, workflow, phase));
  console.log(`\nStatus: ${phase.id} is awaiting approval with ${phase.artifacts.length} generated document(s).`);
  console.log('Next in Copilot: /sflow-approve');
}

async function telemetryCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  const status = await copilotTelemetryStatus(root);
  if (subcommand === 'status') {
    let workflow = null;
    try { const config = await loadConfig(root); workflow = await loadWorkflow(root, config); } catch { /* Diagnostics remain useful without an active work item. */ }
    const pending = workflow
      ? workflow.phaseOrder.flatMap((phaseId) => (workflow.phases[phaseId].telemetry ?? []).filter((item) => item.status === 'pending').map((item) => ({ phase: phaseId, generation: item.generation, path: item.path })))
      : [];
    const result = { ...status, pending };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Copilot telemetry — ${status.ready ? 'ready' : status.enabled ? 'waiting for completed spans' : 'not active in this process'}`);
    console.log(`File: ${status.path}`);
    console.log(`Exists: ${status.exists ? 'yes' : 'no'} | Bytes: ${status.bytes} | Completed chat spans: ${status.completedChatSpans}`);
    console.log(`Pending generations: ${pending.length ? pending.map((item) => `${item.phase}@${item.generation}`).join(', ') : 'none'}`);
    status.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
    if (!status.fileConfigured && !status.ready) console.log('Fix: exit Copilot, open a new terminal in the repository, verify `type copilot`, then start a new Copilot session.');
    else if (!status.completedChatSpans) console.log('Next: finish the current Copilot response, then run this command from the next turn.');
    return;
  }
  if (subcommand !== 'reconcile') throw new SingularityFlowError(`Unknown telemetry subcommand: ${subcommand}`);
  const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const result = await reconcilePhaseTelemetry(root, config, workflow, { phaseId: positionals[2] });
  if (result.updated) {
    const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${result.phase}][telemetry:${result.generation}] reconcile Copilot usage`);
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
  const requestedId = positionals[1];
  const receiptToken = optionString(options, 'selection-receipt');
  if (receiptToken) assertClean(root);
  let config = await loadConfig(root);
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) checkout(root, requestedId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, requestedId);
  const workId = workflow.workItem.id;
  const overridesBefore = workflow.sequenceOverrides?.length ?? 0;
  await assertNoPendingPublication(root, config, workflow, action);
  const phase = await assertPhaseSequence(root, workflow, action, {
    requestedPhase: optionString(options, 'phase'),
    allowedStatuses: ['awaiting_approval']
  });
  const receipt = receiptToken
    ? await resolveSelectionReceipt(root, config, receiptToken, { action, workId: workflow.workItem.id, workflow })
    : null;
  const session = await selectPersona(root, config, actionActor(root), workflow.workItem.id, {
    selection: receipt?.answers.persona ?? null
  });
  for (const override of (workflow.sequenceOverrides ?? []).slice(overridesBefore)) {
    override.actor = session.actor;
    override.persona = session.persona;
    const history = workflow.history?.find((event) => event.event === 'sequence_gate_overridden' && event.at === override.at);
    if (history) {
      history.actor = session.actor.login ?? session.actor.email ?? session.actor.name ?? 'interactive-user';
      history.persona = session.persona;
    }
  }
  return { root, config, workflow, phase, session, receipt, receiptToken };
}

async function approveCommand(positionals, options) {
  if (optionString(options, 'selection-receipt') && optionBoolean(options, 'yes')) {
    throw new SingularityFlowError('Do not combine --selection-receipt with --yes; the receipt already carries the reviewer\'s exact phase confirmation.');
  }
  const { root, config, workflow, phase, session, receipt, receiptToken } = await decisionWorkflow(positionals, options, 'approve');
  const selfApproval = (phase.generatedBy?.login ?? phase.generatedBy?.email ?? phase.generatedBy?.name) === (session.actor.login ?? session.actor.email ?? session.actor.name);
  printPhaseReview(await phaseReview(root, config, workflow, phase));
  const approvalAuthority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    phase.approvalPolicy,
    session.actor
  );
  console.log(`\nReviewing ${workflow.workItem.id} / ${phase.id}`);
  console.log(`Reviewer: ${session.actor.name ?? session.actor.email ?? session.actor.login} · authority: ${approvalAuthority.authorityLabel} (${approvalAuthority.authorityGroup})`);
  console.log(`Working lens: ${session.persona} (prompt/audit context only)`);
  console.log(`Artifacts: ${phase.artifacts.map((item) => `${item.path} (${item.sha256?.slice(0, 18) ?? 'no hash'})`).join(', ')}`);
  console.log(`Checks: ${phase.checks.map((item) => `${item.command}=${item.status}`).join(', ') || 'none'}`);
  console.log(`Tokens: ${phase.usage.map((item) => item.totalTokens ?? item.status).join(', ') || 'unavailable'}`);
  console.log(`Prior approvals: ${phase.approvals.filter((item) => !item.invalidatedAt).map((item) => `${item.actor?.name ?? item.actor?.email ?? 'unknown'} via ${item.authorityGroup ?? 'unrecorded authority'}; lens ${item.workingLens ?? item.persona ?? 'unavailable'} (${item.decision})`).join(', ') || 'none'}`);
  if (selfApproval) console.warn('Warning: this identity generated the phase; approval will be recorded as self-approval.');
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
  if (!receipt && !optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const result = await approvePhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : receipt ? 'copilot-selection-receipt' : 'terminal'
  });
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][approve] ${result.approval.authorityGroup}`, phase.artifacts.map((item) => item.path));
  console.log(publication.pushed
    ? `Approval decision committed ${publication.sha.slice(0, 8)} and pushed to ${config.git?.remote ?? 'origin'}/${workflowPublicationBranch(root, workflow)}.`
    : `Approval decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy} through ${result.approval.authorityGroup}; working lens ${result.approval.workingLens}.`);
  if (result.approval.selfApproval) console.warn(`Warning: ${result.phase.id} was self-approved; this is not independent review.`);
  console.log(result.next ? `Current phase is now ${result.next.id}.` : 'Workflow is complete.');
  formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
}

async function rejectCommand(positionals, options) {
  const { root, config, workflow, phase: current, session } = await decisionWorkflow(positionals, options, 'reject');
  const target = optionString(options, 'to') ?? current.id;
  console.log(`Rejecting ${current.id} to ${target} as ${session.actor.name ?? session.actor.email ?? session.actor.login}; working lens ${session.persona} is audit context only. Approvals from ${target} onward will be invalidated.`);
  const phase = await rejectPhase(root, config, workflow, { phaseId: optionString(options, 'phase'), target, reason: optionString(options, 'reason'), channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'terminal' });
  await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${current.id}][reject] return to ${phase.id}`);
  console.log(`Rejected ${current.id}; ${phase.id} is now in progress.`);
  formatContextBoundaryHandoff(phase.contextBoundary).forEach((line) => console.log(line));
}

async function syncCommand() {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
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
  else if (subcommand === 'reconcile') result = await reconcileLedger(root, ledger, { workId: positionals[2] ?? null });
  else if (subcommand === 'log') result = await ledgerLog(root, ledger, { limit: optionNumber(options, 'limit', 20) });
  else if (subcommand === 'show') result = await ledgerShow(root, ledger, requirePositional(positionals, 2, 'ledger hash or event ID'));
  else if (subcommand === 'archive') result = await archiveLedger(
    root,
    ledger,
    optionString(options, 'out', `singularity-ledger-${new Date().toISOString().slice(0, 10)}.bundle`),
    { sign: optionBoolean(options, 'sign') }
  );
  else throw new SingularityFlowError(`Unknown ledger subcommand '${subcommand}'. Use init, doctor, status, log, show, verify, reconcile, or archive.`);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  if (subcommand === 'init') {
    console.log(result.created
      ? `Created orphan ledger branch ${result.branch} at ${result.commit.slice(0, 8)}.`
      : `Ledger branch ${result.branch} already exists at ${result.ref}.`);
    return;
  }
  if (subcommand === 'doctor') {
    result.checks.forEach((check) => console.log(`  ${check.status === 'pass' ? '✓' : check.status === 'warn' ? '~' : '✗'} ${check.id}: ${check.detail}`));
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
  const definition = await loadCapabilities(root, { required: true });
  const workflowConfig = await loadConfig(root);
  const subcommand = positionals[1] ?? 'list';
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
  throw new SingularityFlowError(`Unknown capabilities subcommand '${subcommand}'. Use list, show, or lease.`);
}

// Read the machine-local activity log. The log lives under .git/ so it is never committed, which
// also means nobody finds it by browsing the repository — this is how it is meant to be read.
async function logsCommand(positionals, options) {
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
  const root = repoRoot();
  const report = await doctorSnapshot(root, { workId: positionals[1], offline: optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(report, null, 2));
  else process.stdout.write(doctorText(report));
  if (!report.healthy) process.exitCode = 2;
}

async function reviewCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const bundle = await createReviewBundle(root, config, workflow, positionals[1]);
  const format = optionString(options, 'format', 'md').toLowerCase();
  if (!['md', 'html', 'json'].includes(format)) throw new SingularityFlowError('Review format must be md, html, or json.');
  const rendered = format === 'json' ? `${JSON.stringify(bundle, null, 2)}\n` : format === 'html' ? reviewHtml(bundle) : reviewMarkdown(bundle);
  const outputFile = optionString(options, 'out');
  if (outputFile) {
    const absolute = path.resolve(root, outputFile); await writeText(absolute, rendered); console.log(`Review bundle written to ${absolute}`); return;
  }
  process.stdout.write(rendered);
}

async function workflowCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'workflow subcommand'); const root = repoRoot();
  if (subcommand === 'list') {
    const catalog = await workflowCatalog(root);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(catalog, null, 2));
    return console.log(table(catalog.map((item) => ({ id: item.id, label: item.label, phases: item.phases.length, status: item.status })), [
      { key: 'id', label: 'WORKFLOW' }, { key: 'label', label: 'LABEL' }, { key: 'phases', label: 'PHASES' }, { key: 'status', label: 'STATUS' }
    ]));
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
  if (['add', 'upgrade'].includes(subcommand)) {
    const id = requirePositional(positionals, 2, 'workflow type');
    const result = await installWorkflow(root, id, { replace: optionBoolean(options, 'replace'), dryRun: optionBoolean(options, 'dry-run') });
    console.log(`${result.dryRun ? 'Would update' : 'Updated'} workflow '${id}':`); result.files.forEach((file) => console.log(`  ${file}`));
    if (!result.dryRun) console.log('Changes are validated but uncommitted. Review them, then publish from the desktop or commit them through your normal configuration-review path.');
    return;
  }
  throw new SingularityFlowError(`Unknown workflow subcommand: ${subcommand}`);
}

async function assignCommand(positionals) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const phaseId = requirePositional(positionals, 1, 'phase'); const assignee = requirePositional(positionals, 2, 'assignee'); const session = await loadSession(root);
  const record = await assignPhase(root, config, workflow, phaseId, assignee, session);
  const result = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phaseId}][assign] ${record.assignee}`);
  console.log(`Assigned ${phaseId} to ${record.assignee}. Committed ${result.sha.slice(0, 8)}${result.pushed ? ' and pushed' : ''}.`);
}

async function watchCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config, positionals[1]);
  const once = optionBoolean(options, 'once') || !output.isTTY; const interval = Math.max(2, optionNumber(options, 'interval', 15));
  let previous = '';
  do {
    if (optionBoolean(options, 'fetch') && branch(root) === workflow.workItem.branch && hasUpstream(root) && !changes(root).trim()) { fetchOrigin(root); pullFastForward(root); }
    const fresh = await loadWorkflow(root, config, workflow.workItem.id); const snapshot = watchSnapshot(fresh); const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) {
      if (optionBoolean(options, 'json')) console.log(JSON.stringify(snapshot, null, 2)); else process.stdout.write(watchText(snapshot));
      previous = serialized;
    }
    if (once) break;
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  } while (true);
}

async function recoverCommand(positionals, options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config, positionals[1]);
  const plan = await recoveryPlan(root, config, workflow, { fetch: optionBoolean(options, 'fetch') });
  const result = optionBoolean(options, 'apply') ? await applyRecovery(root, config, workflow, plan) : plan;
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2)); else process.stdout.write(recoveryText(result));
}

async function runCommand(options) {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config); const phase = currentPhase(workflow);
  if (!phase) { console.log('Workflow is complete. Running the final governance gate.'); return gateCommand({ terminal: true }); }
  if (phase.status === 'awaiting_approval') {
    console.log(`Guided run stopped: '${phase.id}' is awaiting human review and approval.`);
    console.log(`Review: singularity-flow review ${phase.id}`);
    console.log(`Decide: singularity-flow approve ${workflow.workItem.id} --fetch`);
    return;
  }
  if (phaseNeedsGeneration(workflow, phase)) {
    await nextCommand(options);
    console.log(`Guided run stopped at the authoring boundary. Complete ${phase.requiredArtifact.path}, then publish it with singularity-flow phase publish ${phase.id}.`);
    return;
  }
  const submit = optionBoolean(options, 'yes') || await confirmYesNo(`Generation ${phase.generation} is published. Submit '${phase.id}' for approval?`);
  if (!submit) { console.log(`No state changed. Submit later with singularity-flow submit --phase ${phase.id}.`); return; }
  await submitCommand({ ...options, phase: phase.id });
  console.log(`Guided run stopped at the approval boundary. Review with singularity-flow review ${phase.id}.`);
}

async function cockpitCommand() {
  const root = repoRoot();
  if (!existsSync(path.join(root, WORKFLOW_PATH)) && !existsSync(path.join(root, 'singularity/config.json'))) {
    console.log('Singularity Flow is not initialized in this repository.\n\nRun: singularity-flow init'); return;
  }
  const config = await loadConfig(root); let workflow;
  try { workflow = await loadWorkflow(root, config); }
  catch {
    console.log(`Singularity Flow cockpit\nRepository: ${root}\nBranch: ${branch(root)}\n\nNo work item is active on this branch.`);
    console.log('Start: singularity-flow start <WORK-ID>\nResume: singularity-flow resume <WORK-ID> --fetch\nDiagnostics: singularity-flow doctor'); return;
  }
  const progress = progressSnapshot(workflow); const session = await loadSession(root, { required: false }); const active = currentPhase(workflow);
  console.log(`Singularity Flow cockpit — ${workflow.workItem.id}`);
  console.log(`${progressBar(progress.percentage)} ${progress.percentage}% · ${progress.approvedPhases}/${progress.totalPhases} phases`);
  console.log(`Working lens: ${session?.workId === workflow.workItem.id ? session.persona : 'not selected'} · Branch: ${workflow.workItem.branch}`);
  console.log(`Current: ${active ? `${active.label} (${active.status})` : 'workflow complete'}`);
  console.log(`Assignment: ${active ? workflow.collaboration?.assignments?.[active.id]?.assignee ?? 'unassigned' : 'none'}`);
  console.log('\nNext actions:');
  const prerequisites = active && workflow.resolution?.collaboration?.assignmentMode !== 'off' && !workflow.collaboration?.assignments?.[active.id]
    ? [{ timing: workflow.resolution.collaboration.assignmentMode === 'required' ? 'now' : 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who coordinates '${active.id}' for cross-terminal handoff.` }]
    : [];
  process.stdout.write(nextStepsText(nextStepsSnapshot({ branch: branch(root), workflow, publicationPending: existsSync(pendingPublicationPath(root, config, workflow.workItem.id)), prerequisites })));
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

async function hookCommand(positionals) {
  const event = requirePositional(positionals, 1, 'hook event');
  let payload = {};
  try { payload = JSON.parse(await stdinText() || '{}'); } catch { payload = {}; }
  try {
    const candidate = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : process.cwd();
    const root = repoRoot(candidate);
    if (isWorldModelBuildContext(root, payload)) return console.log('{}');
    if (!existsSync(path.join(root, WORKFLOW_PATH))) return console.log('{}');
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
    const config = await loadConfig(root); let workflow = null;
    try { workflow = await loadWorkflow(root, config); } catch { workflow = null; }
    if (event === 'session-start') return console.log(JSON.stringify(await sessionStartPersonaHook(root, config, workflow, payload)));
    if (event === 'persona-guard') return console.log(JSON.stringify(await personaGuardHook(root, config, workflow, payload)));
    throw new SingularityFlowError(`Unknown hook event: ${event}`);
  } catch { console.log('{}'); }
}

async function sessionCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  let root;
  try { root = repoRoot(); } catch {
    const empty = { initialized: false, workId: null, selectionRequired: false, bound: false, activePersona: null, choices: [] };
    return console.log(optionBoolean(options, 'json') ? JSON.stringify(empty, null, 2) : 'No Singularity Flow repository is active.');
  }
  if (!existsSync(path.join(root, WORKFLOW_PATH))) {
    const empty = { initialized: false, workId: null, selectionRequired: false, bound: false, activePersona: null, choices: [] };
    return console.log(optionBoolean(options, 'json') ? JSON.stringify(empty, null, 2) : 'No Singularity Flow repository is active.');
  }
  const config = await loadConfig(root);
  if (subcommand === 'candidates') {
    const remote = config.git?.remote ?? 'origin';
    fetchRemote(root, remote);
    const candidates = [];
    for (const id of remoteBranches(root, remote)) {
      try { validateId(config, id); } catch { continue; }
      const ref = `${remote}/${id}`;
      const content = fileAtRef(root, ref, `${String(config.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '')}/${id}/workflow.json`);
      if (!content) continue;
      try {
        const workflow = JSON.parse(content);
        if (workflow.workItem?.id !== id || workflow.workItem?.branch !== id) continue;
        validateDefinition(YAML.parse(fileAtRef(root, ref, WORKFLOW_PATH) ?? ''));
        candidates.push({ id, title: workflow.workItem.title, status: workflow.status, phase: workflow.currentPhase, commit: refHead(root, ref)?.slice(0, 8) ?? '' });
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
    const id = requirePositional(positionals, 2, 'work or Jira ID');
    validateId(config, id);
    const alreadyCurrent = branch(root) === id;
    // A new Copilot session may begin after the previous session prepared an unpublished
    // generation. Those governed edits must not make the exact, already-synchronized Story
    // branch impossible to select. We still require a clean tree before changing branches or
    // advancing HEAD; the sole exception below only binds local session metadata in place.
    if (!alreadyCurrent) assertClean(root);
    const remote = config.git?.remote ?? 'origin';
    fetchRemote(root, remote);
    const remoteRef = `refs/remotes/${remote}/${id}`;
    const remoteSha = refHead(root, remoteRef);
    if (!remoteSha) throw new SingularityFlowError(`No committed work-item branch '${id}' exists on ${remote}. Start it with /sflow-start or verify the work/Jira ID.`);
    const remoteName = `${remote}/${id}`;
    const itemPath = `${String(config.workItemRoot ?? 'singularity/work-items').replace(/\/$/, '')}/${id}/workflow.json`;
    const remoteWorkflow = fileAtRef(root, remoteName, itemPath);
    const remoteDefinition = fileAtRef(root, remoteName, WORKFLOW_PATH);
    try {
      const parsedWorkflow = JSON.parse(remoteWorkflow ?? 'null');
      if (parsedWorkflow?.workItem?.id !== id || parsedWorkflow?.workItem?.branch !== id) throw new Error('identity mismatch');
      validateDefinition(YAML.parse(remoteDefinition ?? ''));
    } catch { throw new SingularityFlowError(`Remote branch ${remote}/${id} is not a valid Singularity Flow work-item branch. Expected a matching ${itemPath} and valid ${WORKFLOW_PATH}.`); }
    const dirtyInPlace = alreadyCurrent && Boolean(changes(root).trim());
    let materialization;
    if (dirtyInPlace) {
      if (head(root) !== remoteSha) {
        throw new SingularityFlowError(
          `Local branch '${id}' has uncommitted changes and is not at the exact ${remote}/${id} head. `
          + 'Commit or preserve the changes before synchronizing; Singularity Flow will not merge, rebase, reset, stash, or discard them.'
        );
      }
      materialization = 'bound-current-with-local-changes';
    } else {
      materialization = checkout(root, id, { base: config.defaultBaseBranch, existingOnly: true, remote });
      try { fastForwardTo(root, remoteName); }
      catch { throw new SingularityFlowError(`Local branch '${id}' cannot fast-forward to ${remote}/${id}. Resolve or preserve the local commits in another clone; Singularity Flow will not merge, rebase, reset, or discard them.`); }
    }
    if (head(root) !== remoteSha) throw new SingularityFlowError(`Local branch '${id}' contains commits that are not on ${remote}/${id}. Push them or use a clean clone before attaching; Singularity Flow will not discard local history.`);
    const attachedConfig = await loadConfig(root);
    const workflow = await loadWorkflow(root, attachedConfig, id);
    const session = await activateWorkItemSession(root, attachedConfig, workflow);
    const result = { workId: id, branch: workflow.workItem.branch, remote, commit: remoteSha, phase: workflow.currentPhase, status: workflow.status, materialization, personaSelectionRequired: session.selectionRequired };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Attached to ${id} from ${remote}/${id} at ${remoteSha.slice(0, 8)}.`);
    console.log(`Current phase: ${workflow.currentPhase ?? 'complete'} · status: ${workflow.status}`);
    console.log(session.selectionRequired ? 'Next: choose a working lens with /sflow-lens.' : 'The existing valid working lens is bound to this Copilot session.');
    return;
  }
  if (subcommand !== 'status') throw new SingularityFlowError(`Unknown session subcommand: ${subcommand}`);
  let workflow;
  try { workflow = await loadWorkflow(root, config); } catch { workflow = null; }
  const status = await personaSessionStatus(root, config, workflow);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
  console.log(`Work item: ${status.workId ?? 'not selected'}${status.candidateWorkId && !status.workId ? ` · current candidate: ${status.candidateWorkId}` : ''}`);
  console.log(`Working lens: ${status.activePersona ?? 'not selected'}`);
  console.log(`Copilot session: ${status.copilotSessionId ?? 'not bound'}`);
  console.log(`Work-item selection: ${status.workItemSelectionRequired ? 'required' : 'complete'} · working lens: ${status.selectionRequired ? 'required' : status.bound ? 'bound' : 'not required'}`);
  console.log(`Policy: work item ${status.policy.workItemSelection ?? 'off'} · working lens ${status.policy.personaSelection} · before tools: ${status.policy.requireBeforeTools ? 'required' : 'not required'}`);
  if (status.workItemSelectionRequired) console.log('Run /sflow-session or singularity-flow session attach <WORK-ID>.');
  if (status.selectionRequired) console.log('Run /sflow-lens or singularity-flow lens to choose.');
}

async function inboxCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const snapshot = await approvalInbox(root, config, { fetch: !optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
  process.stdout.write(approvalInboxText(snapshot));
}

async function migrateConfigCommand() {
  const root = repoRoot();
  const result = await migrateLegacyConfig(root);
  if (!result.migrated) return console.log(result.reason);
  const moved = result.movedStateRoot ? `; moved ${result.movedFrom}/ to singularity/` : '';
  const initiatives = result.migratedInitiatives ? ` and refreshed ${result.migratedInitiatives} initiative snapshot(s)` : '';
  console.log(`Migrated configuration to ${result.path}; upgraded/refreshed ${result.migratedWorkItems} work item(s)${initiatives}${moved}.`);
}

async function validateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const result = await validateWorkflow(root, config, workflow, { strict: optionBoolean(options, 'strict') });
  result.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
  if (!result.valid) throw new SingularityFlowError(`Validation failed:\n- ${result.errors.join('\n- ')}`, { exitCode: 2 });
  console.log('Singularity Flow workflow is valid.');
}

async function gateCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config);
  const result = await runGovernanceGate(root, config, workflow, {
    terminal: optionBoolean(options, 'terminal') || process.env.SINGULARITY_FLOW_ENFORCE_TERMINAL === '1'
  });
  result.passes.forEach((message) => console.log(`  ✓ ${message}`));
  result.warnings.forEach((message) => console.warn(`  ~ ${message}`));
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
    description: `${profile.phases.length} governed phases`
  }));
}

function initiativePersonaChoices(definition) {
  return Object.entries(definition.personas).map(([id, persona]) => ({
    id,
    label: persona.label ?? id,
    description: persona.description ?? ''
  }));
}

function initiativeStartChoiceSets(portfolio, definition) {
  return [
    { id: 'initiative-profile', label: 'Initiative profile', options: initiativeProfileChoices(portfolio) },
    { id: 'persona', label: 'Working lens', options: initiativePersonaChoices(definition) }
  ];
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
// can only be taken from a terminal. A GUI cannot type into stdin, and the desktop app already passes
// the confirmation as a parameter over IPC, so `--confirm` is the same contract for every other
// surface — and matches how `workspace create|archive|update` already take it. The value must still
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
  const symbols = { approved: '✓', in_progress: '●', awaiting_approval: '◆', stale: '!', not_started: '○' };
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
    choiceSets = initiativeStartChoiceSets(portfolio, config);
    receiptAction = 'initiative-start';
  } else if (action === 'approve') {
    const { initiative } = await loadInitiative(root, initiativeId, portfolio);
    const phaseId = initiative.currentPhase;
    const subject = positionals[5] ?? 'phase';
    const bundle = await initiativeBundle(root, portfolio, initiative, phaseId);
    const expected = `${phaseId}:${subject}`;
    choiceSets = [
      { id: 'persona', label: 'Working lens', options: initiativePersonaChoices(config) },
      { id: 'decision-confirmation', label: 'Exact approval confirmation', options: [{ id: expected, label: `Approve ${expected}`, description: `Approves the exact current hash for ${subject}.` }] }
    ];
    context = { phase: phaseId, subject, bundleSha256: bundle.sha256 };
    receiptAction = 'initiative-approve';
  } else throw new SingularityFlowError('Initiative choice action must be start or approve.');
  const receipt = await beginCustomSelectionReceipt(root, { action: receiptAction, workId: initiativeId, choiceSets, context });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2)); else printSelectionReceipt(receipt);
}

async function knowledgeCommand(positionals, options) {
  const root = repoRoot();
  const subcommand = positionals[1] ?? 'list';

  if (subcommand === 'record') {
    const result = await recordKnowledge(root, {
      type: requirePositional(positionals, 2, 'knowledge type'),
      title: optionString(options, 'title') ?? positionals.slice(3).join(' '),
      detail: optionString(options, 'detail') ?? null,
      tags: (optionString(options, 'tags') ?? '').split(',').map((tag) => tag.trim()).filter(Boolean)
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`${result.created ? 'Recorded' : 'Already recorded'} ${result.record.type} ${result.sha256.slice(0, 12)}: ${result.record.title}`);
  }

  if (subcommand === 'resolve') {
    const result = await resolveKnowledge(root, requirePositional(positionals, 2, 'knowledge entry hash'), {
      resolution: optionString(options, 'resolution') ?? positionals.slice(3).join(' ')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(`Resolved ${result.record.supersedes.slice(0, 12)} as ${result.sha256.slice(0, 12)}: ${result.record.detail}`);
  }

  if (subcommand === 'harvest') {
    const initiativeId = optionString(options, 'initiative') ?? branch(root);
    const { portfolio, initiative } = await loadInitiative(root, initiativeId);
    const dryRun = optionBoolean(options, 'dry-run');
    const result = await harvestInitiativeKnowledge(root, portfolio, initiative, {
      phaseId: optionString(options, 'phase') ?? null,
      dryRun
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    if (dryRun) {
      for (const candidate of result.candidates) console.log(`${candidate.type.padEnd(12)} ${candidate.provenance.phase}/${candidate.provenance.output}  ${candidate.title}`);
      return console.log(`\n${result.candidates.length} entr${result.candidates.length === 1 ? 'y' : 'ies'} would be harvested. Re-run without --dry-run to record them.`);
    }
    for (const entry of result.harvested) console.log(`${entry.record.type.padEnd(12)} ${entry.sha256.slice(0, 12)}  ${entry.record.title}`);
    return console.log(`\nHarvested ${result.harvested.length}; ${result.skipped} already recorded.`);
  }

  if (subcommand === 'show') {
    const wanted = requirePositional(positionals, 2, 'knowledge entry hash');
    const entries = await readKnowledge(root);
    const found = entries.find((entry) => entry.sha256 === wanted || entry.sha256.startsWith(wanted));
    if (!found) throw new SingularityFlowError(`No knowledge entry matches '${wanted}'.`);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(found, null, 2));
    console.log(`${found.record.type} ${found.sha256}`);
    console.log(`\n${found.record.title}`);
    if (found.record.detail) console.log(`\n${found.record.detail}`);
    if (found.record.provenance) {
      const source = found.record.provenance;
      console.log(`\nFrom ${source.initiativeId} ${source.phase}/${source.output} (${source.section}) @ ${String(source.sha256).slice(0, 12)}`);
    }
    return console.log(`Recorded ${found.record.recordedAt} by ${found.record.actor ?? 'unknown'}`);
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
    const scope = record.provenance ? `${record.provenance.initiativeId}/${record.provenance.phase}` : 'manual';
    console.log(`${sha256.slice(0, 12)}  ${record.type.padEnd(12)} ${(record.status ?? '').padEnd(9)} ${scope.padEnd(28)} ${record.title}`);
  }
  console.log(`\n${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`);
}

async function initiativeCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  const portfolio = await loadPortfolio(root);
  const config = await loadConfig(root);
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
    const choiceSets = initiativeStartChoiceSets(portfolio, config);
    const receiptToken = optionString(options, 'selection-receipt');
    const receipt = receiptToken ? await resolveCustomSelectionReceipt(root, receiptToken, {
      action: 'initiative-start',
      workId: initiativeId,
      choiceSets
    }) : null;
    const profile = await chooseInitiativeProfile(portfolio, receipt?.answers['initiative-profile'] ?? optionString(options, 'profile'));
    const selectedPersona = await selectPersona(root, config, actionActor(root), initiativeId, { selection: receipt?.answers.persona ?? null });
    if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
    const source = optionBoolean(options, 'jira')
      ? await getIssue(initiativeId)
      : { type: 'manual', id: initiativeId, title: optionString(options, 'title', initiativeId), description: optionString(options, 'description', '') };
    checkout(root, initiativeId, { base: optionString(options, 'base', config.defaultBaseBranch), fetch: optionBoolean(options, 'fetch') });
    const created = await createInitiative(root, {
      id: initiativeId,
      title: optionString(options, 'title', source.title ?? initiativeId),
      profile,
      source,
      persona: selectedPersona.persona
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
        persona: selectedPersona.persona
      });
    }
    const started = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, started.portfolio, started.initiative, `[${initiativeId}][initiative:init] start ${profile}`);
    let current = started;
    if (profile === 'epic-planning') {
      const completed = await completeEpicIntake(root, initiativeId, { persona: selectedPersona.persona });
      if (completed.advanced) {
        await commitInitiativeChange(root, completed.portfolio, completed.initiative, `[${initiativeId}][epic:intake] sources accepted`);
        current = await loadInitiative(root, initiativeId);
      }
    }
    const progress = initiativeProgress(current.initiative);
    console.log(`Initiative ${initiativeId} started as ${profile}.`);
    console.log(initiativeFlowText(progress));
    console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
    console.log('Next: singularity-flow epic requirements prepare');
    if (profile === 'epic-planning') console.log('Repository world-model generation is deferred until each Jira Story has its canonical branch.');
    return;
  }
  if (subcommand === 'resume') {
    const initiativeId = requirePositional(positionals, 2, 'initiative ID');
    if (branch(root) !== initiativeId) assertClean(root);
    checkout(root, initiativeId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
    const loaded = await loadInitiative(root, initiativeId);
    const session = await selectPersona(root, config, actionActor(root), initiativeId);
    console.log(`Resumed ${initiativeId} at ${loaded.initiative.currentPhase ?? 'complete'} with working lens ${session.persona}.`);
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
  const loaded = await loadInitiative(root, initiativeId, portfolio);
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
      persona: session?.persona ?? null
    });
    const state = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, state.portfolio, state.initiative, `[${initiativeId}][initiative:restart] back to ${state.initiative.currentPhase}`);
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
      persona: session?.persona ?? null
    });
    const saved = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, saved.portfolio, saved.initiative, `[${initiativeId}][initiative:applicability] ${policyId}`);
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
      persona: session?.persona ?? null
    });
    const state = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, state.portfolio, state.initiative, `[${initiativeId}][initiative:${phaseId}][outputs] select`);
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
      // and the desktop record the same thing. They used to live here, which is why publishing
      // from the app left blocking gates unsatisfied and the phase impossible to approve.
      const result = await publishInitiativePhase(root, initiativeId, phaseId, { persona: session?.persona ?? null });
      const publishState = await loadInitiative(root, initiativeId);
      const publication = await commitInitiativeChange(root, publishState.portfolio, publishState.initiative, `[${initiativeId}][initiative:${phaseId}][generated:${result.phase.generation}] publish`);
      console.log(`Published ${phaseId} generation ${result.phase.generation}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    } else {
      const context = await composeInitiativeContext(root, initiativeId, phaseId, { persona: session?.persona ?? null });
      const result = await prepareInitiativePhase(root, initiativeId, phaseId, { persona: session?.persona ?? null });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:${phaseId}][prepare] outputs`);
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
      persona: optionString(options, 'persona') ?? session?.persona ?? null,
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
        persona: session?.persona ?? null,
        decision: optionString(options, 'decision'),
        reason: optionString(options, 'reason'),
        supersedes: optionStrings(options, 'supersedes')
      });
      const fresh = await loadInitiative(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][initiative:${phaseId}][evidence] ${checkId}`, { appendOnly: true });
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
    // Planning approval was refused here and implemented only in the desktop app's IPC, so the Story
    // plan could not be approved without Electron at all. The guard the desktop applied — an explicit
    // acknowledgement that approving your own work is not independent review — is applied here
    // instead, so the governance property is identical wherever the approval happens. Exact-hash
    // confirmation and working-lens selection are already enforced by the flow below.
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
    const choiceSets = [
      { id: 'persona', label: 'Working lens', options: initiativePersonaChoices(config) },
      { id: 'decision-confirmation', label: 'Exact approval confirmation', options: [{ id: expected, label: `Approve ${expected}`, description: `Approves the exact current hash for ${subject}.` }] }
    ];
    const receipt = receiptToken ? await resolveCustomSelectionReceipt(root, receiptToken, {
      action: 'initiative-approve',
      workId: initiativeId,
      choiceSets,
      context: { phase: phaseId, subject, bundleSha256: bundle.sha256 }
    }) : null;
    const session = await selectPersona(root, config, actionActor(root), initiativeId, { selection: receipt?.answers.persona ?? null });
    if (!receipt && !(await confirmInitiativeExact(`Approve exact initiative subject ${expected}?`, expected))) throw new SingularityFlowError('Initiative approval cancelled.');
    if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
    const result = await approveInitiative(root, { initiativeId, phaseId, subject, persona: session.persona, channel: receipt ? 'copilot-selection-receipt' : 'terminal' });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:${phaseId}][approve] ${subject}`);
    console.log(`Approved ${phaseId}:${subject}. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    if (result.selfApproval) console.warn('Warning: this is a self-approval and is not independent review.');
    if (result.next) console.log(`Current phase: ${result.next}`);
    else if (result.initiative.status === 'complete') console.log('Initiative complete.');
    formatContextBoundaryHandoff(result.contextBoundary).forEach((line) => console.log(line));
    return;
  }
  if (subcommand === 'reject') {
    const subject = positionals[2] ?? 'phase';
    const session = await loadSession(root, { required: false });
    const result = await rejectInitiative(root, { initiativeId, subject, reason: optionString(options, 'reason'), persona: session?.persona ?? null });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:${result.target.type}][reject] ${result.target.id}`);
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
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-adopt] ${epicKey}`);
    console.log(`Adopted ${epicKey} as ${result.breakdown.epics.length} Epic and ${result.breakdown.stories.length} stories.`);
    console.log(`Source snapshot: ${result.sourceSha256.slice(0, 12)} · Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    return;
  }
  if (subcommand === 'jira-plan') {
    const result = await createJiraWritePlan(root, initiativeId);
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
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
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:jira-apply] ${planSha256.slice(0, 12)}`);
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
    const fresh = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][initiative:materialize] ${result.attempt.status}`);
    console.log(`Materialization ${result.attempt.status}: ${result.attempt.stories.length - result.failures.length}/${result.attempt.stories.length} ready. Commit ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ''}.`);
    result.failures.forEach((failure) => console.warn(`- ${failure.storyId}: ${failure.error}`));
    return;
  }
  if (subcommand === 'sync') {
    const pending = await syncInitiativePublication(root, portfolio, initiative);
    const result = await syncInitiativeRepositories(root, initiativeId);
    const fresh = await loadInitiative(root, initiativeId);
    const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][initiative:sync] repository evidence`);
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
        persona: session?.persona ?? null
      });
      const fresh = await loadInitiative(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][initiative:contract] ${result.contract.id}@${result.contract.version}`);
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
    else actions.forEach((action, index) => console.log(`${index + 1}. ${action.action}: ${action.command}\n   ${action.reason}`));
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

async function desktopCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'desktop subcommand');
  const root = repoRoot();
  let result;
  if (subcommand === 'snapshot') result = await desktopSnapshot(root, positionals[2], optionString(options, 'initiative'));
  else if (subcommand === 'validate') result = await validateDesktopConfiguration(root);
  else if (subcommand === 'save') result = await saveDesktopFile(root, requirePositional(positionals, 2, 'configuration path'), await stdinText());
  else if (subcommand === 'read') result = await readDesktopFile(root, requirePositional(positionals, 2, 'configuration path'));
  else if (subcommand === 'export-bundle') result = await desktopExportBundle(root);
  else if (subcommand === 'delete-file') result = await deleteDesktopFile(root, requirePositional(positionals, 2, 'configuration path'));
  else if (subcommand === 'delete-template') result = await deleteDesktopTemplate(root, requirePositional(positionals, 2, 'template path'));
  else if (subcommand === 'publish') result = await publishDesktopConfiguration(root, optionString(options, 'message'));
  else if (subcommand === 'portfolio-bootstrap') {
    let input = {};
    const text = await stdinText();
    if (text.trim()) {
      try { input = JSON.parse(text); } catch (error) { throw new SingularityFlowError(`Portfolio bootstrap input must be JSON: ${error.message}`); }
    }
    result = await bootstrapDesktopPortfolio(root, input);
  }
  else if (subcommand === 'session') result = await selectDesktopPersona(root, optionString(options, 'work-id'), requirePositional(positionals, 2, 'persona'));
  else if (subcommand === 'planning-context') result = await createPlanningContext(root, {
    scope: optionString(options, 'scope'),
    id: optionString(options, 'id'),
    phase: optionString(options, 'phase'),
    persona: optionString(options, 'persona'),
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
      ? await promotePlanningArtifacts(root, { sessionId: optionString(options, 'session'), persona: optionString(options, 'persona'), artifacts })
      : await promotePlanningArtifact(root, { sessionId: optionString(options, 'session'), persona: optionString(options, 'persona'), content: input });
  }
  else if (subcommand === 'initiative-materialize-preview') {
    const initiativeId = optionString(options, 'initiative');
    result = await materializeInitiative(root, initiativeId, { dryRun: true });
  }
  else if (subcommand === 'initiative-materialize') {
    const initiativeId = optionString(options, 'initiative');
    const confirmation = optionString(options, 'confirm');
    const before = await loadInitiative(root, initiativeId);
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
    const fresh = await loadInitiative(root, initiativeId);
    result.publication = await commitInitiativeChange(
      root,
      fresh.portfolio,
      fresh.initiative,
      `[${initiativeId}][initiative:materialize] ${result.attempt.status}`
    );
  }
  else if (subcommand === 'initiative-sync') {
    const initiativeId = optionString(options, 'initiative');
    const freshBefore = await loadInitiative(root, initiativeId);
    const pendingPublication = await syncInitiativePublication(root, freshBefore.portfolio, freshBefore.initiative);
    result = await syncInitiativeRepositories(root, initiativeId);
    const fresh = await loadInitiative(root, initiativeId);
    result.publication = await commitInitiativeChange(
      root,
      fresh.portfolio,
      fresh.initiative,
      `[${initiativeId}][initiative:sync] repository evidence`
    );
    result.pendingPublication = pendingPublication;
  }
  else throw new SingularityFlowError(`Unknown desktop subcommand: ${subcommand}`);
  console.log(JSON.stringify(result, null, 2));
}

function optionMap(values, label) {
  const result = {};
  for (const value of values) {
    const split = String(value).indexOf('=');
    if (split <= 0 || split === String(value).length - 1) throw new SingularityFlowError(`${label} must use ID=VALUE.`);
    result[String(value).slice(0, split).trim()] = String(value).slice(split + 1).trim();
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
    `[${initiativeId}][epic:story] ${detail}`
  );
  return { updated, publication };
}

function epicReviewChoiceDefinition(review, decision) {
  const storyId = review.story.workId ?? review.story.jiraKey ?? review.story.planId ?? review.story.id;
  const packetSha256 = review.packet.packetSha256;
  const confirmation = `${decision}:${storyId}:${packetSha256}`;
  if (!review.approval.workingLenses.length) {
    throw new SingularityFlowError(`No working lens is configured for phase '${review.approval.phase}'.`);
  }
  const choiceSets = [
    {
      id: 'persona',
      label: 'Working lens (audit only)',
      options: review.approval.workingLenses.map((persona) => ({
        id: persona.id,
        label: persona.label,
        description: `Use the ${persona.label} prompt perspective. Authority comes from the reviewer identity shown separately.`
      }))
    }
  ];
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

async function workspaceCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'list';
  const registry = workspaceRegistryFile();
  const selectionFile = activeWorkspaceFile();
  if (subcommand === 'list') {
    const workspaces = await readWorkspaceRegistry(registry);
    const active = await readActiveWorkspaceContext(selectionFile, registry, { refresh: false }).catch(() => null);
    const result = workspaces.map((workspace) => ({
      ...workspace,
      active: workspace.id === active?.workspaceId ? 'yes' : ''
    }));
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
    if (optionBoolean(options, 'dry-run')) return console.log(JSON.stringify(launch, null, 2));
    console.log(`\n${launch.prompt}`);
    console.log(`Starting GitHub Copilot in ${context.repositoryPath}`);
    const result = run(process.platform === 'win32' ? 'copilot.cmd' : 'copilot', args, {
      cwd: context.repositoryPath,
      stdio: 'inherit',
      allowFailure: true
    });
    if (result.error) throw new SingularityFlowError(`Unable to start GitHub Copilot: ${result.error.message}`);
    if (result.status !== 0) throw new SingularityFlowError(`GitHub Copilot exited with status ${result.status}.`);
    return;
  }
  if (subcommand === 'create') {
    // A workspace does not need a tracker to exist. The local anchor was already implemented but
    // reachable only from the desktop app, so a Jira-less team could not create one at all once the
    // desktop is out of the picture.
    if (optionBoolean(options, 'local')) {
      const workspaceId = optionString(options, 'id');
      if (!workspaceId) throw new SingularityFlowError('workspace create --local requires --id.');
      const localUrls = optionMap(optionStrings(options, 'repository'), '--repository');
      const localBranches = optionMap(optionStrings(options, 'default-branch'), '--default-branch');
      const localInput = {
        baseDirectory: optionString(options, 'base', process.env.SINGULARITY_FLOW_WORKSPACE_ROOT || path.join(os.homedir(), 'Singularity Workspaces')),
        id: workspaceId,
        name: optionString(options, 'name') ?? workspaceId,
        leadRepository: optionString(options, 'lead'),
        repositories: Object.fromEntries(Object.entries(localUrls).map(([id, url]) => [id, {
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
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(localResult, null, 2));
      console.log(`Workspace ${localResult.created ? 'created' : 'resumed'} at ${localResult.workspace.path}.`);
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
    return renderWorkspaceStatus(result.status);
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
  if (subcommand === 'archive') {
    const archived = await archiveWorkspace(registry, workspacePath, { confirmation: optionString(options, 'confirm') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(archived, null, 2));
    return console.log(`Archived ${archived.workspace?.name ?? workspacePath}. Its files are untouched; restore it with singularity-flow workspace restore.`);
  }
  if (subcommand === 'restore') {
    const restored = await restoreWorkspace(registry, workspacePath);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(restored, null, 2));
    return console.log(`Restored ${restored.workspace?.name ?? workspacePath}.`);
  }
  if (subcommand === 'update') {
    const updateUrls = optionMap(optionStrings(options, 'repository'), '--repository');
    const updateBranches = optionMap(optionStrings(options, 'default-branch'), '--default-branch');
    const updateInput = {
      name: optionString(options, 'name'),
      leadRepository: optionString(options, 'lead'),
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
    await rememberWorkspace(registry, updated.workspace, updated.status);
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
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(workspaces, null, 2));
    return console.log('Workspace forgotten. No repository or document files were deleted.');
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
      // The Jira route answers this prompt from a selection receipt, but a receipt is bound to an
      // identifier that already exists and a local Epic's identifier is minted by the reservation
      // above — so there is nothing to bind to until the command is already running. `--persona`
      // carries the human's choice instead, exactly as `--profile` already does on this same route.
      // A lens is prompt context, not identity or approval authority, so nothing is weakened.
      const selectedPersona = await selectPersona(root, config, actor, reservation.id, {
        selection: optionString(options, 'persona') ?? null,
        nonInteractiveHint: 'Pass --persona <id> to choose one without a terminal.'
      });
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
        persona: selectedPersona.persona,
        idAuthority: 'local'
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
        persona: selectedPersona.persona
      });
      const started = await loadInitiative(root, reservation.id, created.portfolio);
      const publication = await commitInitiativeChange(
        root,
        started.portfolio,
        started.initiative,
        `[${reservation.id}][epic:init] start ${profile}`
      );
      const result = { initiativeId: reservation.id, source, reservation, publication };
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(`Local Epic ${reservation.id} reserved, created, committed, and ${publication.pushed ? 'pushed' : 'recorded locally'}.`);
      console.log(`Next: singularity-flow epic sources --epic ${reservation.id}`);
      return;
    }
    return initiativeCommand(['initiative', 'start', requirePositional(positionals, 2, 'Jira Epic key')], {
      ...options,
      profile: optionString(options, 'profile', 'epic-planning'),
      jira: options.jira ?? true
    });
  }
  if (subcommand === 'sources') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const action = positionals[2] ?? 'list';
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
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:source] ${result.record.sourceId}`, { appendOnly: true });
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
        const verifiedState = await loadInitiative(root, initiativeId);
        publication = await commitInitiativeChange(root, verifiedState.portfolio, verifiedState.initiative, `[${initiativeId}][epic:sources] verify ${result.results.length}`, { appendOnly: true });
      }
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
      console.log(table(result.results, [
        { key: 'sourceId', label: 'SOURCE' },
        { key: 'status', label: 'STATUS' },
        { key: 'version', label: 'VERSION' },
        { key: 'cachePath', label: 'LOCAL CACHE' }
      ]));
      if (publication) console.log(`Verification evidence committed ${publication.sha.slice(0, 8)}${publication.pushed ? ' and pushed' : ''}.`);
      if (!result.valid) process.exitCode = 2;
      return;
    }
    if (action !== 'list') throw new SingularityFlowError(`Unknown Epic sources action '${action}'.`);
    const result = await listEpicSources(root, initiativeId);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result.manifest, null, 2));
    return console.log(table(result.manifest.sources, [
      { key: 'sourceId', label: 'SOURCE' },
      { key: 'name', label: 'NAME' },
      { key: 'provider', label: 'PROVIDER' },
      { key: 'bytes', label: 'BYTES' },
      { key: 'status', label: 'STATUS' }
    ]));
  }
  if (['requirements', 'planning'].includes(subcommand)) {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const phaseId = EPIC_PHASES[subcommand];
    const action = positionals[2] ?? 'status';
    let loaded = await loadInitiative(root, initiativeId);
    if (subcommand === 'requirements' && loaded.initiative.currentPhase === EPIC_PHASES.intake) {
      const completed = await completeEpicIntake(root, initiativeId);
      if (completed.advanced) {
        await commitInitiativeChange(
          root,
          completed.portfolio,
          completed.initiative,
          `[${initiativeId}][epic:intake] sources accepted`
        );
        loaded = await loadInitiative(root, initiativeId);
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
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(verification, null, 2));
      verification.passes.forEach((line) => console.log(`PASS: ${line}`));
      verification.errors.forEach((line) => console.error(`BLOCK: ${line}`));
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
    const { portfolio, initiative } = await loadInitiative(root, initiativeId);
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
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify(verification, null, 2));
      verification.passes.forEach((line) => console.log(`PASS: ${line}`));
      verification.errors.forEach((line) => console.error(`BLOCK: ${line}`));
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
    if (action === 'split') {
      const planId = requirePositional(positionals, 3, 'source Story plan ID');
      const changes = await storyMutationOptions(options);
      const split = await splitEpicStory(root, initiativeId, planId, changes);
      const publication = await commitInitiativeChange(
        root,
        split.portfolio,
        split.initiative,
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
    if (action === 'preview') return epicCommand(['epic', 'create-stories'], options);
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
    const loaded = await loadInitiative(root, initiativeId);
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
      const fresh = await loadInitiative(root, initiativeId);
      const publication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][epic:branches] ${materialized.attempt.status}`);
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
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:jira-plan] ${result.plan.sha256.slice(0, 12)}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ plan: result.plan, publication }, null, 2));
      console.log(`Created and published Jira write plan ${result.plan.sha256}.`);
      console.log(`Review it, then run singularity-flow epic create-stories --plan ${result.plan.sha256}.`);
      return;
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
    const appliedState = await loadInitiative(root, initiativeId);
    const applicationPublication = await commitInitiativeChange(root, appliedState.portfolio, appliedState.initiative, `[${initiativeId}][epic:jira-apply] ${planSha256.slice(0, 12)}`);
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
    const fresh = await loadInitiative(root, initiativeId);
    const branchPublication = await commitInitiativeChange(root, fresh.portfolio, fresh.initiative, `[${initiativeId}][epic:branches] ${materialized.attempt.status}`);
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
    const synced = await loadInitiative(root, initiativeId);
    const syncPublication = await commitInitiativeChange(root, synced.portfolio, synced.initiative, `[${initiativeId}][epic:sync] completion preflight`);
    const result = await completeEpicDelivery(root, initiativeId, {
      confirmation: initiativeId,
      actor: identity(root)
    });
    const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:complete] ${result.record.sha256.slice(0, 12)}`);
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
      const persona = receipt?.answers.persona
        ?? await chooseFromOptions('Working lens', definition.choiceSets.find((entry) => entry.id === 'persona').options);
      const targetChoices = definition.choiceSets.find((entry) => entry.id === 'reject-target')?.options ?? [];
      const target = decision === 'reject'
        ? (receipt?.answers['reject-target']
          ?? optionString(options, 'to')
          ?? await chooseFromOptions('Return to phase', targetChoices))
        : null;
      if (!receipt && !(await confirmInitiativeExact(
        `${decision === 'approve' ? 'Approve' : 'Reject'} exact Story packet ${packetSha256}?`,
        definition.confirmation
      ))) {
        throw new SingularityFlowError(`Epic Story ${decision} cancelled.`);
      }
      const result = await epicReviewDecision(root, initiativeId, story, {
        packetSha256,
        decision,
        persona,
        target,
        reason: optionString(options, 'reason'),
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
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Recorded checks for ${story} packet ${result.packet.packetSha256.slice(0, 12)}.`);
    console.log(`Ready: ${result.checks.evidence.ready ? 'yes' : 'no'} · evidence ${result.checks.evidence.evidenceSha256.slice(0, 12)}`);
    console.log(`Story commit ${result.checks.publication.sha.slice(0, 8)}; Epic commit ${result.publication.sha.slice(0, 8)}.`);
    return;
  }
  if (subcommand === 'drift') {
    const root = repoRoot();
    const initiativeId = optionString(options, 'epic') ?? branch(root);
    const action = positionals[2] ?? 'observe';
    if (action === 'observe') {
      const result = await observeJiraDrift(root, initiativeId);
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:jira-drift] observe`);
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
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:jira-drift] adopt ${result.observation.observationSha256.slice(0, 12)}`);
      if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ observation: result.observation, publication }, null, 2));
      console.log(`Adopted Jira observations into a new governed Git generation. Commit ${publication.sha.slice(0, 8)}.`);
      return;
    }
    if (action === 'restore-plan') {
      const result = await createJiraWritePlan(root, initiativeId);
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][epic:jira-restore] ${result.plan.sha256.slice(0, 12)}`);
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

const STORY_LINEAGE_PROPERTY = 'com.singularity.flow.lineage';

async function storyInboxCommand(options) {
  const root = repoRoot();
  const portfolio = await loadPortfolio(root);
  if (!portfolio.jira?.enabled) {
    throw new SingularityFlowError('Story inbox requires the workspace Jira connection configured in singularity/portfolio.yml.');
  }
  const project = optionString(options, 'project', portfolio.jira.projectKey);
  if (!project) throw new SingularityFlowError('Story inbox requires a configured Jira project key or --project.');
  const assigned = optionBoolean(options, 'assigned-to-me');
  const result = await listMyIssues({
    project,
    issueType: portfolio.jira.storyIssueType ?? 'Story',
    limit: optionNumber(options, 'limit', 50),
    ...(assigned ? {} : {
      jql: `project = "${project}" AND issuetype = "${portfolio.jira.storyIssueType ?? 'Story'}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`
    })
  });
  const stories = (await Promise.all(result.issues.map(async (issue) => {
    try {
      const lineage = await getIssueProperty(issue.key, STORY_LINEAGE_PROPERTY);
      return lineage?.schemaVersion === 1 ? {
        key: issue.key,
        title: issue.title,
        status: issue.status,
        assignee: issue.assignee ?? null,
        planId: lineage.story?.planId ?? null,
        repository: lineage.deliveryRepository?.id ?? lineage.story?.repository ?? null,
        branch: lineage.deliveryRepository?.branch ?? lineage.story?.canonicalBranch ?? issue.key,
        epic: lineage.epic?.jiraKey ?? lineage.epic?.id ?? null
      } : null;
    } catch {
      // Jira returns 404 when an ordinary Story has no Singularity issue property.
      return null;
    }
  }))).filter(Boolean);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ stories, jql: result.jql }, null, 2));
  if (!stories.length) return console.log(`No active Singularity Stories found in Jira project ${project}.`);
  console.log(table(stories, [
    { key: 'key', label: 'STORY' },
    { key: 'planId', label: 'PLAN ID' },
    { key: 'title', label: 'TITLE' },
    { key: 'repository', label: 'REPOSITORY' },
    { key: 'branch', label: 'BRANCH' },
    { key: 'status', label: 'JIRA STATUS' }
  ]));
}

async function verifyFetchedStoryContext(target, storyKey, property) {
  const seedFile = path.join(target, 'singularity', 'seeds', `${storyKey}.yml`);
  if (!existsSync(seedFile)) {
    throw new SingularityFlowError(`Fetched branch '${storyKey}' has no governed seed at singularity/seeds/${storyKey}.yml.`);
  }
  const seed = YAML.parse(await readFile(seedFile, 'utf8'));
  if (seed?.story?.workId !== storyKey || seed?.story?.jiraKey !== storyKey) {
    throw new SingularityFlowError(`Fetched seed does not belong to Jira Story '${storyKey}'.`);
  }
  const expectedPlan = property.story?.planId ?? null;
  if (expectedPlan && seed.story.planId !== expectedPlan) {
    throw new SingularityFlowError(`Jira lineage says plan '${expectedPlan}', but the governed seed says '${seed.story.planId}'.`);
  }
  for (const record of seed.governedContext ?? []) {
    const current = await snapshot(path.join(target, record.path));
    if (!current.exists || current.sha256 !== record.sha256) {
      throw new SingularityFlowError(
        `Governed Story input '${record.id}' failed verification. Expected ${record.sha256}; `
        + `found ${current.exists ? current.sha256 : 'missing'}.`
      );
    }
  }
  const expectedStoryHash = property.specification?.storySha256 ?? null;
  const actualStory = (seed.governedContext ?? []).find((record) => record.id === 'story-specification');
  if (expectedStoryHash && actualStory?.sha256 !== expectedStoryHash) {
    throw new SingularityFlowError(
      `Jira lineage Story specification hash ${expectedStoryHash} does not match the governed seed hash ${actualStory?.sha256 ?? 'missing'}.`
    );
  }
  return seed;
}

async function storyFetchCommand(positionals, options) {
  const leadRoot = repoRoot();
  const storyKey = requirePositional(positionals, 2, 'Jira Story key').toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*-\d+$/.test(storyKey)) throw new SingularityFlowError('story fetch requires a Jira Story key such as MOB-123.');
  const portfolio = await loadPortfolio(leadRoot);
  const issue = await getIssue(storyKey);
  const property = await getIssueProperty(storyKey, STORY_LINEAGE_PROPERTY);
  if (property?.schemaVersion !== 1) {
    throw new SingularityFlowError(`Jira Story ${storyKey} has no Singularity Flow lineage property. Publish it from an approved Epic plan first.`);
  }
  const repositoryId = property.deliveryRepository?.id ?? property.story?.repository;
  const repository = portfolio.repositories?.[repositoryId];
  if (!repository) {
    throw new SingularityFlowError(
      `Story ${storyKey}'s lineage names repository '${repositoryId ?? 'unknown'}', which is not configured in this workspace. `
      + `Configured: ${Object.keys(portfolio.repositories ?? {}).join(', ') || 'none'}.`
    );
  }
  const propertyUrl = property.deliveryRepository?.url;
  if (propertyUrl && !sameRepositoryRemote(propertyUrl, repository.url)) {
    throw new SingularityFlowError(
      `Story ${storyKey}'s lineage names repository ${propertyUrl}, which does not match configured repository ${repository.url}. `
      + 'Correct the workspace deliberately; an unlisted Jira URL is never fetched.'
    );
  }

  const currentRemote = run('git', ['remote', 'get-url', 'origin'], { cwd: leadRoot, allowFailure: true });
  const currentIsDelivery = currentRemote.status === 0 && sameRepositoryRemote(currentRemote.stdout, repository.url);
  const explicitDirectory = optionString(options, 'directory');
  if (!currentIsDelivery && !explicitDirectory) {
    throw new SingularityFlowError(
      `Story ${storyKey} belongs to repository '${repositoryId}'. Re-run with --directory <local-path>; `
      + `Singularity will clone only the configured URL ${repository.url}.`
    );
  }
  const target = path.resolve(explicitDirectory ?? leadRoot);
  if (!existsSync(target)) {
    await mkdir(path.dirname(target), { recursive: true });
    const cloned = run('git', ['clone', '--', repository.url, target], { cwd: path.dirname(target), allowFailure: true });
    if (cloned.status !== 0) throw new SingularityFlowError(`Unable to clone configured repository '${repositoryId}': ${(cloned.stderr || cloned.stdout).trim()}`);
  }
  const targetRoot = repoRoot(target);
  if (targetRoot !== target) throw new SingularityFlowError(`Story target must be the repository root: ${targetRoot}.`);
  const targetRemote = run('git', ['remote', 'get-url', 'origin'], { cwd: target, allowFailure: true });
  if (targetRemote.status !== 0 || !sameRepositoryRemote(targetRemote.stdout, repository.url)) {
    throw new SingularityFlowError(`Target repository origin does not match configured URL ${repository.url}.`);
  }
  assertClean(target);
  checkout(target, storyKey, {
    base: repository.defaultBranch,
    fetch: true,
    existingOnly: true
  });
  const seed = await verifyFetchedStoryContext(target, storyKey, property);

  const config = await loadConfig(target);
  let workflow;
  try {
    workflow = await loadWorkflow(target, config, storyKey);
  } catch {
    const workType = seed.story.suggestedWorkType;
    if (!config.workTypes?.[workType]) {
      throw new SingularityFlowError(`Approved Story plan pins workflow '${workType}', but repository '${repositoryId}' does not configure it.`);
    }
    const actor = identity(target);
    const persona = await selectPersona(target, config, actor, storyKey);
    workflow = await createWorkflow(target, config, {
      id: storyKey,
      title: issue.title || seed.story.title || storyKey,
      source: {
        ...issue,
        type: 'jira',
        key: storyKey,
        id: issue.id ?? seed.story.jiraIssueId ?? null,
        epicId: property.epic?.jiraKey ?? property.epic?.id ?? seed.initiative?.id ?? null,
        planId: seed.story.planId,
        parentBranch: seed.story.parentBranch,
        branchCompletionPolicy: seed.story.branchCompletionPolicy,
        requiredChecks: seed.story.requiredChecks
      },
      baseBranch: seed.story.parentBranch ?? repository.defaultBranch,
      workType,
      persona: persona.persona,
      resolved: resolveWorkType(config, workType)
    });
    await commitAndPublish(target, config, workflow, `[${storyKey}][init] start governed Story workflow`);
  }
  if (optionBoolean(options, 'json')) {
    return console.log(JSON.stringify({ storyKey, repository: repositoryId, directory: target, workflow: workflow.workItem, property }, null, 2));
  }
  console.log(`Story ${storyKey} is ready in ${target}.`);
  console.log(`Lineage: ${property.epic?.jiraKey ?? property.epic?.id} → ${seed.story.planId} → ${storyKey}`);
  console.log(`Workflow: ${workflow.workItem.workType} · current phase ${workflow.currentPhase ?? 'complete'}`);
  console.log('Next: singularity-flow next');
}

async function storyCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'status';
  const root = repoRoot();
  if (subcommand === 'start') {
    const storyKey = requirePositional(positionals, 2, 'Jira Story key');
    return startCommand(['start', storyKey], { ...options, jira: true });
  }
  if (subcommand === 'inbox') return storyInboxCommand(options);
  if (subcommand === 'fetch') return storyFetchCommand(positionals, options);
  const config = await loadConfig(root);
  if (subcommand === 'branch') {
    const action = positionals[2] ?? 'status';
    if (action === 'create') {
      const result = await createStoryBranch(root, config, {
        parentStoryId: optionString(options, 'parent'),
        branchName: requirePositional(positionals, 3, 'child branch name')
      });
      console.log(`Created and registered child branch ${result.branch} for Story ${result.workflow.workItem.id}.`);
      return;
    }
    if (action === 'attach') {
      const result = await attachStoryBranch(root, config, { parentStoryId: optionString(options, 'parent') });
      console.log(`${result.created ? 'Registered' : 'Using'} ${result.canonical ? 'canonical' : 'child'} branch ${result.branch} for Story ${result.workflow.workItem.id}.`);
      return;
    }
    if (action === 'promote') {
      const workflow = await loadWorkflow(root, config, optionString(options, 'parent'));
      const result = await promoteStoryBranch(root, config, workflow, { mode: optionString(options, 'mode') });
      if (result.requiresPullRequest) console.log(`Open a pull request from ${result.branch} to ${result.canonicalBranch}. Epic progress advances only after merge.`);
      else console.log(`Promoted ${result.branch} to ${result.canonicalBranch} at ${result.commit.slice(0, 8)}.`);
      return;
    }
    if (action !== 'status') throw new SingularityFlowError(`Unknown Story branch action '${action}'.`);
    const status = await storyBranchStatus(root, config, optionString(options, 'parent'));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
    console.log(`Story: ${status.workId} · Epic: ${status.epicId ?? 'unlinked'}`);
    console.log(`Current: ${status.currentBranch} (${status.kind}) · Canonical: ${status.canonicalBranch}`);
    return;
  }
  if (subcommand === 'submit') return submitCommand(options);
  if (subcommand === 'finalize') return finalizeCommand(options);
  if (subcommand === 'checks') {
    const workflow = await loadWorkflow(root, config, optionString(options, 'parent'));
    const result = await runAndRecordStoryChecks(root, config, workflow, {
      packetSha256: optionString(options, 'packet'),
      requiredChecks: optionStrings(options, 'required-check')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Story checks ${result.evidence.ready ? 'passed' : 'need attention'} for ${result.evidence.packetSha256.slice(0, 12)}.`);
    console.log(`GitHub Actions: ${result.evidence.github.required.map((entry) => `${entry.name}=${entry.status}`).join(', ') || 'no required checks configured'}`);
    result.evidence.governance.errors.forEach((error) => console.warn(`BLOCK: ${error}`));
    console.log(`Evidence committed ${result.publication.sha.slice(0, 8)}${result.publication.pushed ? ' and pushed' : ''}.`);
    return;
  }
  if (subcommand === 'status') return statusCommand([positionals[0], positionals[2]], options);
  throw new SingularityFlowError(`Unknown Story subcommand '${subcommand}'.`);
}

async function finalizeCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, optionString(options, 'parent'));
  const result = await finalizeStoryDelivery(root, config, workflow);
  const publication = await commitAndPublish(
    root,
    config,
    workflow,
    `[${workflow.workItem.id}][finalize] ready for Product Owner review`,
    [result.path]
  );
  const output = { ...result, publication };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(output, null, 2));
  console.log(`Story ${workflow.workItem.id} finalized for Product Owner review.`);
  console.log(`Packet: ${result.path}`);
  console.log(`Packet hash: ${result.packet.packetSha256}`);
  console.log(`Source: ${result.packet.sourceCommit.slice(0, 12)} · tree ${result.packet.sourceTreeSha256.slice(0, 12)}`);
  console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
}

// Log every command's outcome. This is the spine of the activity log: without it a failure leaves
// only the message printed to the terminal, and the sequence that produced it is gone. Building the
// logger must never break a command, so a repository that cannot be resolved simply gets no file.
async function commandLogger(command, argv) {
  try {
    const root = repoRoot();
    const config = await loadConfig(root).catch(() => null);
    return repositoryLogger(root, config, {
      context: { command, pid: process.pid, cwd: root, branch: branch(root) ?? null }
    });
  } catch {
    return repositoryLogger(null, null, { context: { command, pid: process.pid } });
  }
}

export async function main(argv) {
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return console.log(VERSION);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return console.log(HELP);
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command) return cockpitCommand();
  if (command === 'version') return console.log(VERSION);
  // `logs` reads the file; logging its own invocation would append noise to what it is showing.
  if (command !== 'logs') {
    const log = await commandLogger(command, argv);
    const started = Date.now();
    log.info('command.start', null, { argv: argv.slice(0, 24) });
    try {
      const result = await dispatch(command, positionals, options);
      log.info('command.ok', null, { durationMs: Date.now() - started });
      return result;
    } catch (error) {
      log.error('command.failed', error?.message, { durationMs: Date.now() - started, exitCode: error?.exitCode ?? 1, error });
      throw error;
    }
  }
  return dispatch(command, positionals, options);
}

async function dispatch(command, positionals, options) {
  const handlers = validateCommandHandlers({
    about: () => console.log(ABOUT),
    help: () => helpCommand(positionals, options),
    init: () => initCommand(options),
    choices: () => choicesCommand(positionals, options),
    start: () => startCommand(positionals, options),
    resume: () => resumeCommand(positionals, options),
    lens: () => personaCommand(positionals),
    session: () => sessionCommand(positionals, options),
    inbox: () => inboxCommand(options),
    finalize: () => finalizeCommand(options),
    status: () => statusCommand(positionals, options),
    progress: () => progressCommand(positionals, options),
    report: () => reportCommand(positionals, options),
    telemetry: () => telemetryCommand(positionals, options),
    guide: () => guideCommand(positionals, options),
    next: () => nextCommand(options),
    run: () => runCommand(options),
    cockpit: () => cockpitCommand(),
    logs: () => logsCommand(positionals, options),
    doctor: () => doctorCommand(positionals, options),
    review: () => reviewCommand(positionals, options),
    workflow: () => workflowCommand(positionals, options),
    assign: () => assignCommand(positionals),
    watch: () => watchCommand(positionals, options),
    recover: () => recoverCommand(positionals, options),
    nextsteps: () => nextStepsCommand(positionals, options),
    inputs: () => inputsCommand(positionals, options),
    'prompt-packs': () => promptPacksCommand(positionals, options),
    documents: () => documentsCommand(positionals, options),
    prepare: () => prepareCommand(positionals, options),
    phase: () => phaseCommand(positionals, options),
    artifact: () => artifactCommand(positionals, options),
    pr: () => pullRequestCommand(positionals, options),
    submit: () => submitCommand(options),
    approve: () => approveCommand(positionals, options),
    reject: () => rejectCommand(positionals, options),
    sync: () => syncCommand(),
    ledger: () => ledgerCommand(positionals, options),
    capabilities: () => capabilitiesCommand(positionals, options),
    'migrate-config': () => migrateConfigCommand(),
    validate: () => validateCommand(options),
    gate: () => gateCommand(options),
    wm: () => worldModelCommand(repoRoot(), positionals, options),
    jira: () => jiraCommand(positionals, options),
    plugin: () => pluginCommand(positionals, options),
    desktop: () => desktopCommand(positionals, options),
    initiative: () => initiativeCommand(positionals, options),
    knowledge: () => knowledgeCommand(positionals, options),
    epic: () => epicCommand(positionals, options),
    story: () => storyCommand(positionals, options),
    workspace: () => workspaceCommand(positionals, options),
    hook: () => hookCommand(positionals)
  });
  try {
    return handlers[canonicalCommand(command)]();
  } catch (error) {
    if (error instanceof SingularityFlowError && error.message === `Unknown command: ${command}`) {
      throw new SingularityFlowError(`${error.message}\n\n${HELP}`);
    }
    throw error;
  }
}
