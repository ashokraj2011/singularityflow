import readline from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  table,
  writeText
} from './util.mjs';
import { assertClean, branch, changes, checkout, fastForwardTo, fetchOrigin, fetchRemote, fileAtRef, hasUpstream, head, identity, pullFastForward, refHead, remoteBranches, repoRoot } from './git.mjs';
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
  saveWorkflow,
  scanArtifacts,
  submitPhase,
  syncPublication,
  validateId,
  validateWorkflow,
  workflowPath,
  workDir
} from './state.mjs';
import { copilotTelemetryStatus } from './telemetry.mjs';
import { assertPhaseSequence } from './sequence.mjs';
import {
  discoverJiraConnection, getIssue, getIssueHierarchy, getMyPermissions, issueToMarkdown,
  listEpicStories, listEpics, listFields, listMyIssues, listProjects
} from './jira.mjs';
import { installPlugin, listPlugins, pluginPath, uninstallPlugin } from './plugin.mjs';
import { runGovernanceGate } from './governance.mjs';
import { worldModelCommand } from './worldmodel.mjs';
import { initializeDefinition, migrateLegacyConfig, resolveWorkType, validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { activateWorkItemSession, loadSession, personaSessionStatus, selectIntakeSource, selectPersona, selectWorkType, setAgentSession } from './session.mjs';
import { addDocuments, documentCatalog, previewDocument, viewDocument } from './documents.mjs';
import { progressBar, progressFlow, progressSnapshot } from './progress.mjs';
import { deriveReport, renderHtml, renderMarkdown } from './report.mjs';
import { loadManualStory, promptManualStory } from './intake.mjs';
import { guideText, phaseNeedsGeneration, workflowGuide } from './guide.mjs';
import { nextStepsSnapshot, nextStepsText } from './nextsteps.mjs';
import { loadHelpDocument } from './help.mjs';
import { agentStatus, discoverAgents, lockAgent, prepareRemoteOutputs, remoteOutputConflicts, syncAgent } from './agents.mjs';
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
import { verifyGroundingRecord, worldModelCommit, worldModelSourceSnapshot } from './grounding.mjs';
import { doctorSnapshot, doctorText } from './doctor.mjs';
import { createReviewBundle, reviewHtml, reviewMarkdown } from './review.mjs';
import { installWorkflow, simulateWorkflow, simulationText, workflowCatalog, workflowDiff } from './workflow-catalog.mjs';
import { applyRecovery, assignPhase, recoveryPlan, recoveryText, watchSnapshot, watchText } from './collaboration.mjs';
import { personaGuardHook, sessionStartPersonaHook } from './persona-hooks.mjs';
import { approvalInbox, approvalInboxText } from './inbox.mjs';
import {
  answerSelectionReceipt, beginCustomSelectionReceipt, beginSelectionReceipt, consumeSelectionReceipt,
  resolveCustomSelectionReceipt, resolveSelectionReceipt, selectionReceiptStatus
} from './choices.mjs';
import { loadPortfolio } from './initiative-config.mjs';
import {
  commitInitiativeChange, createInitiative, initiativeProgress, listInitiatives,
  loadInitiative, prepareInitiativePhase, secureInitiativePath, syncInitiativePublication, validateInitiativeId
} from './initiative-state.mjs';
import {
  approveInitiative, evaluateInitiativePhase, initiativeBundle, publishInitiativePhase,
  readInitiativeRecords, registerInitiativeEvidence
} from './initiative-evidence.mjs';
import { rejectInitiative } from './initiative-graph.mjs';
import {
  initiativeBreakdownReview, materializeInitiative, syncInitiativeRepositories
} from './initiative-repositories.mjs';
import {
  adoptJiraEpic, applyJiraWritePlan, createJiraWritePlan, previewJiraAdoption
} from './jira-initiative.mjs';
import { interfaceContractStatus, registerInterfaceContract } from './initiative-contracts.mjs';
import {
  deriveInitiativeReport, initiativeNextActions, renderInitiativeReport
} from './initiative-report.mjs';
import { runInitiativeGate } from './initiative-governance.mjs';
import { composeInitiativeContext, verifyInitiativeContext } from './initiative-context.mjs';
import { createPlanningContext, promotePlanningArtifact } from './planning.mjs';
import {
  createWorkspace, fetchWorkspace, forgetWorkspace, listWorkspaceDocuments, previewWorkspace,
  readWorkspace, readWorkspaceRegistry, rememberWorkspace, repairWorkspace, stageWorkspaceDocuments,
  workspaceStatus
} from './workspace.mjs';

const VERSION = '0.8.0';

const ABOUT = `Singularity Flow ${VERSION}

Singularity Flow is a Git-native, configurable SDLC orchestration system for
GitHub Copilot and engineering teams. It belongs to the Singularity product
brand and uses the short, collision-safe sflow- command namespace.

What it provides:
  - YAML-defined feature, bugfix, chore, Figma-mobile, and custom workflows
  - Session personas, phase-aware prompts, and repository world-model grounding
  - Configurable artifact templates, phase inputs, approvals, and quality gates
  - Jira or manual intake with supporting documents
  - Requirements-to-code traceability, verification, and conformance reporting
  - Atomic Git commit/push state transfer, including every approval decision
  - Remote agent Markdown dependencies and an Electron configuration desktop
  - Per-phase token and model usage reporting when the provider exposes it

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
  singularity-flow init
  singularity-flow start <WORK-ID> [--jira | --story-file FILE] [--title TEXT] [--description TEXT]
    [--acceptance-criteria TEXT] [--document FILE]... [--document-url URL]... [--base BRANCH] [--fetch] [--allow-dirty]
    [--selection-receipt TOKEN]
  singularity-flow choices begin start <WORK-ID> [--json]
  singularity-flow choices begin approve <WORK-ID> [--fetch] [--json]
  singularity-flow choices answer <TOKEN> <CHOICE> <ID> [--json]
  singularity-flow choices status <TOKEN> [--json]
  singularity-flow resume <WORK-ID> [--fetch] [--allow-dirty]
  singularity-flow persona [WORK-ID]
  singularity-flow session status|candidates [--json]
  singularity-flow session attach <WORK-ID> [--json]
  singularity-flow inbox [--offline] [--json]
  singularity-flow status [WORK-ID] [--json]
  singularity-flow progress [WORK-ID] [--json]
  singularity-flow report [WORK-ID] [--format md|html|json] [--out FILE]
  singularity-flow telemetry status [--json]
  singularity-flow telemetry reconcile [PHASE] [--json]
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
  singularity-flow agents list
  singularity-flow agents lock <AGENT> [--update]
  singularity-flow agents sync <AGENT>
  singularity-flow agents status [AGENT]
  singularity-flow agents refresh-output <RESOURCE-ID> [--replace]
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
  singularity-flow wm build [--phase PHASE] [--task TEXT] [--focus TEXT] [--depth quick|standard|deep]
  singularity-flow wm context <PHASE> [--task TEXT] [--concat] [--evidence] [--no-persona]
  singularity-flow wm compose [--persona ID] [--phase ID] [--task TEXT] [--evidence] [--dry-run] [--out FILE]
  singularity-flow wm inject [same options]              Compatibility alias for wm compose
  singularity-flow wm check
  singularity-flow jira list [--project KEY] [--type Story] [--limit 25] [--jql JQL] [--json]
  singularity-flow jira status
  singularity-flow jira projects [--query TEXT]
  singularity-flow jira epics --project KEY
  singularity-flow jira children EPIC-KEY
  singularity-flow jira permissions --project KEY
  singularity-flow jira pull <WORK-ID> [--json]
  singularity-flow jira show <WORK-ID> [--json]      Alias for jira pull
  singularity-flow jira fields [--query TEXT] [--json]
  singularity-flow plugin install
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
  singularity-flow initiative status [INIT-ID] [--json]
  singularity-flow initiative next [INIT-ID] [--json]
  singularity-flow initiative phase [publish] [PHASE]
  singularity-flow initiative context [PHASE] [--dry-run] [--json]
  singularity-flow initiative documents [PHASE] [--json]
  singularity-flow initiative checklist [PHASE] [--json]
  singularity-flow initiative evidence add <CHECK-ID> --assurance LEVEL [--path FILE | --url URL]
  singularity-flow initiative evidence list [CHECK-ID] [--json]
  singularity-flow initiative verify [PHASE] [--json]
  singularity-flow initiative approve <OUTPUT|CHECK|phase> [--selection-receipt TOKEN]
  singularity-flow initiative reject <OUTPUT|CHECK|phase> --reason TEXT
  singularity-flow initiative breakdown [--probe] [--json]
  singularity-flow initiative materialize [--dry-run]
  singularity-flow initiative jira-adopt EPIC-KEY [--repository JIRA-KEY=REPO] [--dry-run]
  singularity-flow initiative jira-plan
  singularity-flow initiative jira-apply --plan SHA256
  singularity-flow initiative sync
  singularity-flow initiative contracts [add] [--id ID --version VERSION --format FORMAT --path FILE]
  singularity-flow initiative report [INIT-ID] [--format md|json] [--out FILE]
  singularity-flow initiative gate [INIT-ID] [--terminal] [--json]
  singularity-flow workspace create --jira KEY --base DIRECTORY --lead REPOSITORY
    --repository ID=URL [--repository ID=URL] [--confirm KEY] [--no-clone]
  singularity-flow workspace list [--json]
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
    console.log(`Owner persona: ${active.owner ?? 'unassigned'}`);
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
    throw new SingularityFlowError(`Trusting remote agent '${expected}' requires an interactive terminal and exact agent-name confirmation.`);
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

async function initCommand() {
  const root = repoRoot();
  const wrote = await initializeDefinition(root);
  await worldModelCommand(root, ['wm', 'init'], {});
  console.log(wrote.length ? `Created ${wrote.join(', ')}` : `Verified ${WORKFLOW_PATH} and repository templates.`);
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
  const source = sourceMode === 'jira' ? await getIssue(id) : manual.source;
  const supportingDocuments = [
    ...(manual?.documents ?? []),
    ...explicitFiles.map((candidate) => ({ type: 'file', path: candidate, label: null, kind: null })),
    ...explicitUrls.map((url) => ({ type: 'url', url, label: null, kind: null }))
  ];
  const workType = await selectWorkType(config, { selection: receipt?.answers['workflow-template'] ?? null });
  const selectedPersona = await selectPersona(root, config, actionActor(root), id, { selection: receipt?.answers.persona ?? null });
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);

  const base = optionString(options, 'base', config.defaultBaseBranch);
  checkout(root, id, { base, fetch: optionBoolean(options, 'fetch') });
  const workflow = await createWorkflow(root, config, {
    id,
    title: optionString(options, 'title', source.title || id),
    source,
    baseBranch: base,
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
  const id = requirePositional(positionals, 1, 'work ID');
  const root = repoRoot();
  const initialConfig = await loadConfig(root);
  validateId(initialConfig, id);
  if (branch(root) !== id && !optionBoolean(options, 'allow-dirty')) assertClean(root);
  checkout(root, id, { base: initialConfig.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  const config = await loadConfig(root);
  const workflow = await loadWorkflow(root, config, id);
  const session = await selectPersona(root, config, actionActor(root), id);
  summary(workflow);
  console.log(`Active persona: ${session.persona}`);
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
  if (branch(root) !== workflow.workItem.branch) {
    throw new SingularityFlowError(`Work item '${workflow.workItem.id}' is not the current branch. Run singularity-flow resume ${workflow.workItem.id} --fetch first.`);
  }
  const session = await selectPersona(root, config, actionActor(root), workflow.workItem.id);
  console.log(`Active persona: ${config.personas[session.persona].label} (${session.persona})`);
  console.log(`Session scope: ${workflow.workItem.id} on branch ${workflow.workItem.branch}`);
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
  const selfApprovals = workflow.phaseOrder.flatMap((id) => workflow.phases[id].approvals.filter((item) => !item.invalidatedAt && item.selfApproval).map((item) => `${id}: ${item.actor?.name ?? 'unknown'} as ${item.persona}`));
  if (selfApprovals.length) console.warn(`\nSelf-approval warnings (not independent review):\n- ${selfApprovals.join('\n- ')}`);
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
        reason: 'Select the persona that will remain active for this terminal session before generation.'
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
        if (!status) prerequisites.push({ timing: 'now', skill: null, command: 'singularity-flow agents list', reason: `Active agent '${session.agent}' is no longer available; choose and sync an available agent.` });
        else if (status.status === 'unlocked') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent}`, reason: `Review and trust the active agent's remote Markdown before generation.` });
        else if (status.status === 'stale') prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents lock ${session.agent} --update`, reason: 'The active agent Markdown changed after it was locked; review the new dependency hashes.' });
        if (status && !['ready', 'local-only'].includes(status.status)) prerequisites.push({ timing: ['unlocked', 'stale'].includes(status.status) ? 'then' : 'now', skill: null, command: `singularity-flow agents sync ${session.agent}`, reason: 'Verify the pinned hashes and materialize the active agent cache.' });
        for (const conflict of await remoteOutputConflicts(active, { itemDirectory: workDir(root, config, workflow.workItem.id) })) prerequisites.push({ timing: 'now', skill: null, command: `singularity-flow agents refresh-output ${conflict.resource}`, reason: `Remote output ${conflict.target} has local changes; review them before deciding whether to add --replace.` });
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

async function worldModelRebuildReason(root, config) {
  const outputDir = config.worldModel?.outputDir ?? 'singularity/world-model';
  const manifestPath = path.join(root, outputDir, 'manifest.json');
  if (!existsSync(manifestPath)) return 'The governed repository world model has not been built.';
  try {
    const manifest = await readJson(manifestPath);
    const currentSource = await worldModelSourceSnapshot(root, config);
    if (!worldModelCommit(root, outputDir)) return 'The repository world model is not committed.';
    if (!manifest.source_tree_sha256 || manifest.source_tree_sha256 !== currentSource.sha256) return 'The repository world model is stale for the current source tree.';
    return null;
  } catch (error) {
    return `The repository world model is invalid: ${error.message}`;
  }
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
  if (subcommand === 'lock') {
    const agentId = requirePositional(positionals, 2, 'agent');
    const update = optionBoolean(options, 'update');
    const preview = await lockAgent(root, agentId, { update });
    console.log(`Agent: ${agentId}\nSource: ${preview.agent.source}\nAgent SHA-256: ${preview.agent.sha256}`);
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
    await setAgentSession(root, result.agent, actionActor(root));
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
  throw new SingularityFlowError(`Unknown agents subcommand: ${subcommand}`);
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
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][submit] request approval`, phase.artifacts.map((item) => item.path));
  console.log(`\nSubmitted ${phase.id} phase for approval.`);
  console.log(`Commit: ${publication.sha.slice(0, 8)} — request approval (${workflow.workItem.id})`);
  console.log(`Push: ${publication.pushed ? `${config.git?.remote ?? 'origin'}/${workflow.workItem.branch}` : 'disabled by git.publish: off'}`);
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
  const workId = requestedId ?? branch(root);
  if (workId !== branch(root) || optionBoolean(options, 'fetch')) checkout(root, workId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
  config = await loadConfig(root); const workflow = await loadWorkflow(root, config, workId);
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
    allowedPersonas: phase.approvalPolicy?.personas ?? [],
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
  console.log(`\nReviewing ${workflow.workItem.id} / ${phase.id} as ${session.persona}`);
  console.log(`Artifacts: ${phase.artifacts.map((item) => `${item.path} (${item.sha256?.slice(0, 18) ?? 'no hash'})`).join(', ')}`);
  console.log(`Checks: ${phase.checks.map((item) => `${item.command}=${item.status}`).join(', ') || 'none'}`);
  console.log(`Tokens: ${phase.usage.map((item) => item.totalTokens ?? item.status).join(', ') || 'unavailable'}`);
  console.log(`Prior approvals: ${phase.approvals.filter((item) => !item.invalidatedAt).map((item) => `${item.actor?.name ?? 'unknown'} as ${item.persona} (${item.decision})`).join(', ') || 'none'}`);
  if (selfApproval) console.warn('Warning: this identity generated the phase; approval will be recorded as self-approval.');
  if (receiptToken) await consumeSelectionReceipt(root, receiptToken);
  if (!receipt && !optionBoolean(options, 'yes') && !(await confirm(phase))) throw new SingularityFlowError('Approval cancelled.');
  const result = await approvePhase(root, config, workflow, {
    phaseId: optionString(options, 'phase'),
    channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : receipt ? 'copilot-selection-receipt' : 'terminal'
  });
  const publication = await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${phase.id}][approve] ${result.approval.persona}`, phase.artifacts.map((item) => item.path));
  console.log(publication.pushed
    ? `Approval decision committed ${publication.sha.slice(0, 8)} and pushed to ${config.git?.remote ?? 'origin'}/${workflow.workItem.branch}.`
    : `Approval decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  console.log(`Approved ${result.phase.id} by ${result.approval.approvedBy}.`);
  if (result.approval.selfApproval) console.warn(`Warning: ${result.phase.id} was self-approved; this is not independent review.`);
  console.log(result.next ? `Current phase is now ${result.next.id}.` : 'Workflow is complete.');
}

async function rejectCommand(positionals, options) {
  const { root, config, workflow, phase: current, session } = await decisionWorkflow(positionals, options, 'reject');
  const target = optionString(options, 'to') ?? current.id;
  console.log(`Rejecting ${current.id} to ${target} as ${session.persona}; approvals from ${target} onward will be invalidated.`);
  const phase = await rejectPhase(root, config, workflow, { phaseId: optionString(options, 'phase'), target, reason: optionString(options, 'reason'), channel: process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? 'github-pr-comment' : 'terminal' });
  await commitAndPublish(root, config, workflow, `[${workflow.workItem.id}][phase:${current.id}][reject] return to ${phase.id}`);
  console.log(`Rejected ${current.id}; ${phase.id} is now in progress.`);
}

async function syncCommand() {
  const root = repoRoot(); const config = await loadConfig(root); const workflow = await loadWorkflow(root, config);
  const result = await syncPublication(root, config, workflow); console.log(`Pushed ${result.pushed.slice(0, 8)} to ${result.remote}/${result.branch}.`);
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
  console.log(`Persona: ${session?.workId === workflow.workItem.id ? session.persona : 'not selected'} · Branch: ${workflow.workItem.branch}`);
  console.log(`Current: ${active ? `${active.label} (${active.status})` : 'workflow complete'}`);
  console.log(`Assignment: ${active ? workflow.collaboration?.assignments?.[active.id]?.assignee ?? 'unassigned' : 'none'}`);
  console.log('\nNext actions:');
  const prerequisites = active && workflow.resolution?.collaboration?.assignmentMode !== 'off' && !workflow.collaboration?.assignments?.[active.id]
    ? [{ timing: workflow.resolution.collaboration.assignmentMode === 'required' ? 'now' : 'optional', skill: null, command: `singularity-flow assign ${active.id} <assignee>`, reason: `Record who coordinates '${active.id}' for cross-terminal handoff.` }]
    : [];
  process.stdout.write(nextStepsText(nextStepsSnapshot({ branch: branch(root), workflow, publicationPending: existsSync(pendingPublicationPath(root, config, workflow.workItem.id)), prerequisites })));
  console.log('\nUseful views: singularity-flow progress · review · documents list · report · doctor');
}

async function hookCommand(positionals) {
  const event = requirePositional(positionals, 1, 'hook event');
  let payload = {};
  try { payload = JSON.parse(await stdinText() || '{}'); } catch { payload = {}; }
  try {
    const candidate = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : process.cwd();
    const root = repoRoot(candidate);
    if (!existsSync(path.join(root, WORKFLOW_PATH))) return console.log('{}');
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
    assertClean(root);
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
    const materialization = checkout(root, id, { base: config.defaultBaseBranch, existingOnly: true, remote });
    try { fastForwardTo(root, remoteName); }
    catch { throw new SingularityFlowError(`Local branch '${id}' cannot fast-forward to ${remote}/${id}. Resolve or preserve the local commits in another clone; Singularity Flow will not merge, rebase, reset, or discard them.`); }
    if (head(root) !== remoteSha) throw new SingularityFlowError(`Local branch '${id}' contains commits that are not on ${remote}/${id}. Push them or use a clean clone before attaching; Singularity Flow will not discard local history.`);
    const attachedConfig = await loadConfig(root);
    const workflow = await loadWorkflow(root, attachedConfig, id);
    const session = await activateWorkItemSession(root, attachedConfig, workflow);
    const result = { workId: id, branch: workflow.workItem.branch, remote, commit: remoteSha, phase: workflow.currentPhase, status: workflow.status, materialization, personaSelectionRequired: session.selectionRequired };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Attached to ${id} from ${remote}/${id} at ${remoteSha.slice(0, 8)}.`);
    console.log(`Current phase: ${workflow.currentPhase ?? 'complete'} · status: ${workflow.status}`);
    console.log(session.selectionRequired ? 'Next: choose a persona with /sflow-persona.' : 'The existing valid persona is bound to this Copilot session.');
    return;
  }
  if (subcommand !== 'status') throw new SingularityFlowError(`Unknown session subcommand: ${subcommand}`);
  let workflow;
  try { workflow = await loadWorkflow(root, config); } catch { workflow = null; }
  const status = await personaSessionStatus(root, config, workflow);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
  console.log(`Work item: ${status.workId ?? 'not selected'}${status.candidateWorkId && !status.workId ? ` · current candidate: ${status.candidateWorkId}` : ''}`);
  console.log(`Persona: ${status.activePersona ?? 'not selected'}`);
  console.log(`Copilot session: ${status.copilotSessionId ?? 'not bound'}`);
  console.log(`Work-item selection: ${status.workItemSelectionRequired ? 'required' : 'complete'} · persona: ${status.selectionRequired ? 'required' : status.bound ? 'bound' : 'not required'}`);
  console.log(`Policy: work item ${status.policy.workItemSelection ?? 'off'} · persona ${status.policy.personaSelection} · before tools: ${status.policy.requireBeforeTools ? 'required' : 'not required'}`);
  if (status.workItemSelectionRequired) console.log('Run /sflow-session or singularity-flow session attach <WORK-ID>.');
  if (status.selectionRequired) console.log('Run /sflow-persona or singularity-flow persona to choose.');
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

async function jiraCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'Jira subcommand');
  if (subcommand === 'status') {
    const result = await discoverJiraConnection();
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Connected to ${result.server.serverTitle ?? result.baseUrl} (${result.deployment}).`);
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
  if (subcommand === 'list') {
    const result = await listMyIssues({
      project: optionString(options, 'project'),
      issueType: optionString(options, 'type', 'Story'),
      limit: optionNumber(options, 'limit', 25),
      jql: optionString(options, 'jql')
    });
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
    else if (!result.issues.length) console.log('No matching Jira work items found.');
    else console.log(table(result.issues.map((issue) => ({ key: issue.key, status: issue.status ?? '', priority: issue.priority ?? '', title: issue.title })), [
      { key: 'key', label: 'KEY' },
      { key: 'status', label: 'STATUS' },
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
    { id: 'persona', label: 'Persona', options: initiativePersonaChoices(definition) }
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

async function confirmInitiativeExact(prompt, expected) {
  if (!input.isTTY || !output.isTTY) {
    if (process.env.NODE_ENV === 'test' && process.env.SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM === expected) return true;
    throw new SingularityFlowError(`This initiative action requires interactive exact confirmation '${expected}' or a Copilot selection receipt.`);
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
      { id: 'persona', label: 'Persona', options: initiativePersonaChoices(config) },
      { id: 'decision-confirmation', label: 'Exact approval confirmation', options: [{ id: expected, label: `Approve ${expected}`, description: `Approves the exact current hash for ${subject}.` }] }
    ];
    context = { phase: phaseId, subject, bundleSha256: bundle.sha256 };
    receiptAction = 'initiative-approve';
  } else throw new SingularityFlowError('Initiative choice action must be start or approve.');
  const receipt = await beginCustomSelectionReceipt(root, { action: receiptAction, workId: initiativeId, choiceSets, context });
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2)); else printSelectionReceipt(receipt);
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
    const profile = await chooseInitiativeProfile(portfolio, receipt?.answers['initiative-profile']);
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
    const publication = await commitInitiativeChange(root, created.portfolio, created.initiative, `[${initiativeId}][initiative:init] start ${profile}`);
    const progress = initiativeProgress(created.initiative);
    console.log(`Initiative ${initiativeId} started as ${profile}.`);
    console.log(initiativeFlowText(progress));
    console.log(`Commit: ${publication.sha.slice(0, 8)}${publication.pushed ? ' pushed' : ' local'}`);
    console.log(`Next: singularity-flow initiative phase ${created.initiative.currentPhase}`);
    return;
  }
  if (subcommand === 'resume') {
    const initiativeId = requirePositional(positionals, 2, 'initiative ID');
    if (branch(root) !== initiativeId) assertClean(root);
    checkout(root, initiativeId, { base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true });
    const loaded = await loadInitiative(root, initiativeId);
    const session = await selectPersona(root, config, actionActor(root), initiativeId);
    console.log(`Resumed ${initiativeId} at ${loaded.initiative.currentPhase ?? 'complete'} as ${session.persona}.`);
    console.log(initiativeFlowText(initiativeProgress(loaded.initiative)));
    return;
  }
  if (subcommand === 'list') {
    const initiatives = await listInitiatives(root, portfolio);
    if (optionBoolean(options, 'json')) console.log(JSON.stringify(initiatives, null, 2));
    else console.log(table(initiatives, [{ key: 'id', label: 'INITIATIVE' }, { key: 'profile', label: 'PROFILE' }, { key: 'status', label: 'STATUS' }, { key: 'currentPhase', label: 'CURRENT' }]));
    return;
  }
  const acceptsExplicitId = new Set(['status', 'next', 'report', 'gate']);
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
  if (subcommand === 'phase') {
    const publish = positionals[2] === 'publish';
    const phaseId = publish ? positionals[3] ?? initiative.currentPhase : positionals[2] ?? initiative.currentPhase;
    const session = await loadSession(root, { required: false });
    if (publish) {
      const context = await verifyInitiativeContext(root, portfolio, initiative, phaseId);
      context.warnings.forEach((warning) => console.warn(`Warning: ${warning}`));
      if (!context.valid) throw new SingularityFlowError(`Cannot publish ${phaseId}:\n- ${context.errors.join('\n- ')}`);
      const result = await publishInitiativePhase(root, initiativeId, phaseId, { persona: session?.persona ?? null });
      const publication = await commitInitiativeChange(root, result.portfolio, result.initiative, `[${initiativeId}][initiative:${phaseId}][generated:${result.phase.generation}] publish`);
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
      persona: session?.persona ?? null,
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
    const receiptToken = optionString(options, 'selection-receipt');
    const bundle = await initiativeBundle(root, portfolio, initiative, phaseId);
    const expected = `${phaseId}:${subject}`;
    const choiceSets = [
      { id: 'persona', label: 'Persona', options: initiativePersonaChoices(config) },
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
    if (!(await confirmInitiativeExact(`Apply reviewed Jira plan ${planSha256} for ${initiativeId}?`, initiativeId))) throw new SingularityFlowError('Jira apply cancelled.');
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
    if (!(await confirmInitiativeExact(`Materialize every reviewed repository story for ${initiativeId}?`, initiativeId))) throw new SingularityFlowError('Initiative materialization cancelled.');
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
  else if (subcommand === 'planning-promote') result = await promotePlanningArtifact(root, {
    sessionId: optionString(options, 'session'),
    persona: optionString(options, 'persona'),
    content: await stdinText()
  });
  else if (subcommand === 'initiative-materialize-preview') {
    const initiativeId = optionString(options, 'initiative');
    result = await materializeInitiative(root, initiativeId, { dryRun: true });
  }
  else if (subcommand === 'initiative-materialize') {
    const initiativeId = optionString(options, 'initiative');
    const confirmation = optionString(options, 'confirm');
    result = await materializeInitiative(root, initiativeId, { confirmation });
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

function workspaceRegistryPath() {
  return path.resolve(process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    || path.join(os.homedir(), '.singularity-flow', 'workspaces.json'));
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
  const registry = workspaceRegistryPath();
  if (subcommand === 'list') {
    const workspaces = await readWorkspaceRegistry(registry);
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(workspaces, null, 2));
    return console.log(table(workspaces, [
      { key: 'anchorKey', label: 'JIRA' },
      { key: 'anchorType', label: 'TYPE' },
      { key: 'name', label: 'WORKSPACE' },
      { key: 'path', label: 'PATH' }
    ]));
  }
  if (subcommand === 'create') {
    const jiraKey = optionString(options, 'jira');
    if (!jiraKey) throw new SingularityFlowError('workspace create requires --jira KEY.');
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

export async function main(argv) {
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return console.log(VERSION);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return console.log(HELP);
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command) return cockpitCommand();
  if (command === 'version') return console.log(VERSION);
  switch (command) {
    case 'about': return console.log(ABOUT);
    case 'help': return helpCommand(positionals, options);
    case 'init': return initCommand();
    case 'choices': return choicesCommand(positionals, options);
    case 'start': return startCommand(positionals, options);
    case 'resume': return resumeCommand(positionals, options);
    case 'persona': return personaCommand(positionals);
    case 'session': return sessionCommand(positionals, options);
    case 'inbox': return inboxCommand(options);
    case 'status': return statusCommand(positionals, options);
    case 'progress': return progressCommand(positionals, options);
    case 'report': return reportCommand(positionals, options);
    case 'telemetry': return telemetryCommand(positionals, options);
    case 'guide': return guideCommand(positionals, options);
    case 'next': return nextCommand(options);
    case 'run': return runCommand(options);
    case 'cockpit':
    case 'home': return cockpitCommand();
    case 'doctor': return doctorCommand(positionals, options);
    case 'review': return reviewCommand(positionals, options);
    case 'workflow': return workflowCommand(positionals, options);
    case 'assign': return assignCommand(positionals);
    case 'watch': return watchCommand(positionals, options);
    case 'recover': return recoverCommand(positionals, options);
    case 'nextsteps':
    case 'next-steps': return nextStepsCommand(positionals, options);
    case 'inputs': return inputsCommand(positionals, options);
    case 'agents': return agentsCommand(positionals, options);
    case 'documents': return documentsCommand(positionals, options);
    case 'prepare': return prepareCommand(positionals, options);
    case 'phase': return phaseCommand(positionals, options);
    case 'artifact': return artifactCommand(positionals, options);
    case 'submit': return submitCommand(options);
    case 'approve': return approveCommand(positionals, options);
    case 'reject': return rejectCommand(positionals, options);
    case 'sync': return syncCommand();
    case 'migrate-config': return migrateConfigCommand();
    case 'validate': return validateCommand(options);
    case 'gate': return gateCommand(options);
    case 'wm': return worldModelCommand(repoRoot(), positionals, options);
    case 'jira': return jiraCommand(positionals, options);
    case 'plugin': return pluginCommand(positionals, options);
    case 'desktop': return desktopCommand(positionals, options);
    case 'initiative': return initiativeCommand(positionals, options);
    case 'workspace': return workspaceCommand(positionals, options);
    case 'hook': return hookCommand(positionals);
    default: throw new SingularityFlowError(`Unknown command: ${command}\n\n${HELP}`);
  }
}
