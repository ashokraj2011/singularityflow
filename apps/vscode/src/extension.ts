import { showCompactWarningMessage, showCompactInformationMessage } from "./compact-message.ts";
/**
 * Activation, commands, and the wiring between them.
 *
 * The extension refuses to half-work: if the workspace is not a Singularity Flow repository, or no
 * CLI can be found, it says so once and stops rather than presenting an empty tree that looks like a
 * repository with nothing in it.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, readFile, readdir, realpath as fsRealpath, rm } from 'node:fs/promises';
import { gatewayDestinationRequest } from './gateway-destination.ts';
import { resolveCli, SingularityFlowClient, isCliReadSuperseded, type CliLocation } from './cli/client.ts';
import {
  CliError, formatCliArgsForDisplay, RepositoryAuthorityUnavailableError,
  terminalCommand, recentCliCommandTimings,
  validateFactoryResetRepositoryDirectory, validateRepositoryDirectory,
  validatedRepositoryGitCommonDirectory
} from './cli/runner.ts';
import { WorkspaceStore } from './state.ts';
import { synchronizeChatProfile } from './personalization.ts';
import { StepActionDeliveryMonitor } from './step-action-deliveries.ts';
import { RepositorySnapshotFileCache } from './snapshot-file-cache.ts';
import { IntakeCatalogCache } from './intake-catalog-cache.ts';
import { BackgroundWorkGovernor } from './background-governor.ts';
import type { CapabilityNode, DecisionInputSpec, RepositorySnapshot, StoryDecisionView } from './cli/snapshot.ts';
import {
  decisionChoiceItems, decisionChooseArgv, decisionInputPrompt, pendingDecisionSummary, submitArgvWithDecisionValues
} from './decisions.ts';
import { ConfigurationValidator } from './validation.ts';
import { approveWithReceipt, resolvePlaceholders, runGovernedAction, runPlannedAction } from './actions.ts';
import { LifecycleTreeProvider } from './views/lifecycle.ts';
import type { JourneyMessage } from './views/journey.ts';
import { buildJourney } from './views/journey-model.ts';
import {
  phaseGenerationChatPrefill, submissionCommandArgv
} from './views/submission-presentation.ts';
import { phasePrepublishDecision } from './views/phase-prepublish.ts';
import { testRecoveryPreviewArgs, testRecoveryReviewActions, type TestRecoveryAction } from './views/story-test-recovery.ts';
import { storyRiskPreviewArgs, storyRiskChoices, storyRiskObligationChoices, storyRiskApplyArgs, type StoryRiskTerms } from './views/story-test-risk.ts';
import type { ApprovalsMessage } from './views/approvals.ts';
import type { InboxMessage } from './views/inbox.ts';
import { buildInbox, buildInboxTree, type InboxRepositoryBinding, type WorkspaceStoryCatalogRow } from './views/inbox-model.ts';
import { discoverWorkspaceStoryRows, StoryRefreshGate, type StoryRepository } from './story-discovery.ts';
import { sameStoryAttachPath, selectedCatalogStory, verifiedInboxRepositoryBinding, verifiedWorkspaceStoryRepository } from './story-attach.ts';
import {
  storyCheckoutNeedsWindowSwitch, storyStartHandoffFromResult, storyStartHandoffMatches,
  STORY_START_HANDOFF_KEY, STORY_START_DISCOVERY_IDLE_MS
} from './story-start-handoff.ts';
import type { StoriesMessage } from './views/stories.ts';
import type { CapabilitiesMessage } from './views/capabilities.ts';
import {
  workflowImportResolveArgs, type WorkflowImportChoice, type WorkflowMutationPreview
} from './views/workflow-transfer-presentation.ts';
import type { ConfigurationCenterMessage, ConfigurationCenterReply } from './views/configuration-center.ts';
import { configurationPathTarget, type ConfigurationTab } from './views/configuration-center-model.ts';
import { configurationSaveDisposition, configurationSavePlanCliArgs } from './views/configuration-save.ts';
import type { HelpDocument } from './views/help-page.ts';
import type { WorkspacesMessage } from './views/workspaces-panel.ts';
import type { Mapped } from './views/bootstrap-panel.ts';
import {
  archiveCommand, capabilityChangeCommand, restoreCommand, workspaceReinitializeCommand, workspaceRows,
  verifyCapabilityAuthorityLease, WORKSPACE_ACTION_CANCELLED,
  type WorkspaceCapabilityChangePreview, type WorkspaceCapabilityChangeResult,
  type WorkspaceCapabilityAttachScope,
  type ObservedCapabilityAuthority,
  type WorkspaceConfigurationRefreshResult,
  type WorkspaceEntry, type WorkspaceStatus, type WorkspaceFosAction, type WorkspaceFosOutcome
} from './views/workspaces-model.ts';
import { unavailableCapabilityAuthorityMessage } from './views/capability-authority-diagnostics.ts';
import { workspaceAuthorityChoices } from './views/workspace-authority-matching.ts';
import { capabilityChoices, type RemoteCapability } from './views/workspace-form.ts';
import { deferredWorkspaceRepositories } from './views/workspace-start.ts';
import { gitRemoteProblem } from './views/map-capability-form.ts';
import {
  parseRepositoryOnboardingPlan, parseRepositoryOnboardingResult,
  repositoryOnboardingFailureCode
} from './views/repository-onboarding-model.ts';
import {
  repositoryRefreshCommand, repositoryRefreshTargetForPath, repositoryRefreshTargets,
  sameGitRepository,
  type RepositoryRefreshTarget, type WorkspaceRefreshObservation
} from './repository-refresh-model.ts';
import { capabilityProposalArgv } from './views/capability-model.ts';
import { buildConfigurationTree, unavailableTree, type TreeNode } from './views/tree-model.ts';
import { NodeTreeProvider } from './views/navigation.ts';
import { SidebarViewProvider } from './views/sidebar.ts';
import { deriveSidebarNavigation } from './views/sidebar-navigation-model.ts';
import { sidebarDestination } from './views/sidebar-destination.ts';
import { buildApprovals } from './views/approvals-model.ts';
import { PROFILE_PERSONAS, isProfilePersonaId, resolveProfilePersona } from './views/profile-personas.ts';
import {
  buildWorkspaceTree, capabilityIdOf, workspacePathOf, type CapabilityReadiness
} from './views/navigation-trees.ts';
import { SecureCredentials } from './credentials.ts';
import {
  defaultEvidencePhases, evidenceCatalog, evidenceCommands, evidenceDetachCommand, evidenceDetachPreviewCommand,
  evidenceScopeCommand, evidenceStorageChoices, evidenceTargets, evidenceUsesLabel,
  suggestedEvidenceName, validateEvidenceName,
  expandEpicEvidenceDirectory, validateEvidenceUrl,
  type EpicSourceBrowse, type EvidenceCatalogItem, type EvidenceTarget
} from './evidence.ts';
import type { EvidenceSourceKind } from './views/evidence-manager.ts';
import { onFormSubmit, showForm, useDraftStore } from './views/form-panel.ts';
import {
  onAutoResultAction, onHomeRequest, onResultAction, resultPanelRepositoryChanged,
  resultPanelIsHome, onResultPanelChanged, showRefusal, showResultCard
} from './views/result-panel.ts';
import { buildResultCard } from './views/result-card-model.ts';
import {
  ACKNOWLEDGE_ACTION_ID, acknowledgementKey, homeAcknowledgementFor, type HomeAcknowledgement
} from './views/home-acknowledgement.ts';
import {
  activeRepositoryContext, gatewaySession, provideAcknowledgedAt, provideHomeLens, provideChatProfileName,
  latestWorkspaceBootstrap, resetGatewaySession, setActiveRepositoryContext as setGatewayRepositoryContext,
  type ActiveRepositoryContext, type GatewayRepositoryContext
} from './gateway-runtime-client.ts';
import { menuResource, repositoryRelativePath } from './explain-target.ts';
import type { ExplorerFocusRequest } from './views/change-explorer.ts';
import { registerSflowChat } from './sflow-chat.ts';
import { helpRuntime } from './help-runtime-client.ts';
import { readRecord, recordHelpMetric } from './support-runtime-client.ts';
import { storyCheckoutIssue, unsavedRepositoryPaths } from './generation-guards.ts';
import { renderReworkRollForwardPreview } from './views/rework-roll-forward-preview.ts';
import { RepositoryEpochGuard, type RepositoryEpochToken } from './repository-epoch.ts';
import { RevisionSliceWatcherFence } from './watcher-refresh-fence.ts';
import { machineSelectionRevision } from './machine-selection-revision.ts';
import {
  beginHostPerformanceActivation, hostPerformanceSnapshot, markHostPerformance,
  recordHostRuntimeLoad, recordHostSidebarRender, recordHostStoreEvent, resetHostPerformanceInterval,
  trackHostBackgroundTask
} from './host-performance.ts';
import { GatewayStatusWorker } from './gateway-status-worker-client.ts';
import { commandGuidanceText, safeCommandPair } from './views/command-guidance.ts';
import { configuredGitRemoteUrls, configuredGitRemotes, gitVersion } from './cli/git-observations.ts';
import {
  alignProductSurfaces, codeLauncher, LoadedBundle, openConfigurationReviews, type ProductAlignmentHost
} from './product-alignment.ts';

let extensionLifetime = new AbortController();

/** Injected by esbuild: the commit and time this bundle was built from. */
declare const __SFLOW_BUILD__: string;

const COPILOT_HANDOFF_KEY = 'singularityFlow.pendingCopilotHandoff';
const START_WIZARD_KEY = 'singularityFlow.pendingStartWizard.v1';
const REPOSITORY_SETUP_CHANGED_MESSAGE =
  'Repository setup changed; review the refreshed result.';

type LazyPanelsRuntime = typeof import('./lazy-panels-runtime.ts');
let lazyPanelsRuntime: LazyPanelsRuntime | null = null;
function lazyPanels(): LazyPanelsRuntime {
  if (lazyPanelsRuntime) return lazyPanelsRuntime;
  const started = performance.now();
  lazyPanelsRuntime = require(path.join(__dirname, 'lazy-panels-runtime.cjs')) as LazyPanelsRuntime;
  recordHostRuntimeLoad('panels', performance.now() - started);
  return lazyPanelsRuntime;
}

interface PendingCopilotHandoff {
  /** Workspace handoffs must never infer a Story from the repository's checked-out branch. */
  kind: 'workspace' | 'story';
  repository: string;
  workId: string | null;
  workspaceName?: string | null;
  requestedAt: string;
}

interface PendingStartWizard {
  schemaVersion: 1;
  step: 'capability' | 'workspace' | 'work';
  capabilityId?: string | null;
  organisation?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  workspacePath?: string | null;
  resumeOnActivation?: boolean;
  startedAt: string;
}

interface GovernedReferencePreview {
  handle: string;
  mediaType: string;
  renderer: { id: string; version: number };
  source: { rawSha256: string; rawBytes: number };
  preview: { text: string; sha256: string; bytes: number };
  truncated: boolean;
  reference: { artifact: { path: string }; revision: { commitSha: string } };
}

interface HarnessReport {
  invocations: number;
  output: { rawBytes: number; previewBytes: number; savedBytes: number };
  checkers: { total: number; coverage: number; verdicts: Record<string, number> };
  hostObservations: { status: string; coverage: number; reason: string };
  events: Array<{
    invocationId: string;
    command?: string[];
    startedAt?: string;
    exitCode?: number;
    checkers?: Array<{ checkerId: string; verdict: string }>;
  }>;
}

interface FactoryResetPlan {
  repository: string;
  branch: string | null;
  head: string | null;
  confirmation: string;
  remove: string[];
  replace: string[];
  preserve: string[];
  localRuntimeRoots?: string[];
  resetScopeSha256?: string;
  uncommittedResetPaths: string[];
  uncommittedDiscardPaths?: string[];
  customAgentRecoveries?: Array<{
    sourcePath: string;
    recoveryPath: string;
    sourceDisplay: string;
    recoveryDisplay: string;
    sha256: string;
    bytes: number;
    reason: string;
  }>;
  cleanupPendingPath?: string;
  barrierPendingPath?: string;
  warnings?: string[];
}

interface StoryReturnPlan {
  schemaVersion: number;
  kind: 'story-return-plan';
  workId: string;
  configuredRemote: string;
  destinationBranch: string;
  sourceRef: string;
  sourceCommit: string;
  currentBranch: string;
  worktree: { clean: boolean; changedPaths: number };
  localBranch: { disposition: string; blocksApply: boolean };
  repositories: Array<{
    id: string; required: boolean; remote: string; portability: string; disposition: string;
  }>;
  missingRequiredRepositories: string[];
  freshness: string;
  confirmation: string;
}

type FirstRunCheck = { id: string; status: 'healthy' | 'blocked'; detail: string };

async function firstRunChecks(extensionPath: string, location: { executable: string; cli: string },
  repository: string | null): Promise<FirstRunCheck[]> {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  /**
   * Two probes, neither of which may stop the extension host.
   *
   * These were `spawnSync` with 5- and 10-second timeouts, inside a function that is already `async`
   * and already awaits four filesystem checks. Nothing needed the synchrony, and the cost of it is
   * paid at the worst possible moment: `activate` runs these on a first run, so a slow or missing
   * Git and a bundled CLI that will not start could freeze the whole window for fifteen seconds
   * before anything had been drawn.
   *
   * Run together rather than in sequence for the same reason — they do not depend on each other, so
   * the worst case is the slower of the two rather than the sum.
   */
  const probe = async (command: string, args: string[], options: { cwd?: string; timeout: number }) => {
    try {
      const { stdout } = await promisify(execFile)(command, args, {
        ...options, encoding: 'utf8', windowsHide: true
      });
      return { ok: true, stdout: String(stdout) };
    } catch {
      // A non-zero exit, a timeout and a missing executable are the same answer here: not healthy.
      return { ok: false, stdout: '' };
    }
  };
  const [git, cli] = await Promise.all([
    gitVersion(repository ?? os.tmpdir()).catch(() => null),
    probe(location.executable, [location.cli, 'about'], { cwd: repository ?? os.tmpdir(), timeout: 10_000 })
  ]);
  const bundle = await lstat(path.join(extensionPath, 'dist', 'extension.cjs')).catch(() => null);
  const machineDirectory = path.resolve(process.env.SINGULARITY_FLOW_HOME
    || path.join(os.homedir(), '.singularity-flow'));
  const writableTarget = await lstat(machineDirectory).then(() => machineDirectory)
    .catch(() => path.dirname(machineDirectory));
  const writable = await access(writableTarget, fsConstants.W_OK).then(() => true).catch(() => false);
  const repositoryKind = repository
    ? await lstat(path.join(repository, 'singularity', 'workflow.yml')).then((entry) => entry.isFile()
      ? 'governed repository' : 'ordinary Git repository').catch(() => 'ordinary Git repository')
    : 'no repository open';
  return [
    { id: 'extension', status: bundle?.isFile() ? 'healthy' : 'blocked', detail: 'packaged extension bundle' },
    { id: 'runtime', status: nodeMajor >= 20 ? 'healthy' : 'blocked', detail: `Node ${process.versions.node} (minimum 20)` },
    { id: 'git', status: git ? 'healthy' : 'blocked', detail: git ?? 'Git is unavailable' },
    { id: 'cli', status: cli.ok ? 'healthy' : 'blocked', detail: cli.ok ? 'bundled CLI executes' : 'bundled CLI did not execute' },
    { id: 'machine-state', status: writable ? 'healthy' : 'blocked', detail: 'machine-local SFlow state location is writable' },
    { id: 'repository', status: 'healthy', detail: repositoryKind }
  ];
}

/**
 * The context key the repository menus are gated on: the editor and Explorer "Singularity Flow"
 * submenus, the editor title, Source Control and the Navigator title show their explain actions
 * only while a governed repository is selected. Every change of repository goes through the
 * function below, so the key cannot disagree with the routing it describes.
 */
export const REPOSITORY_ACTIVE_CONTEXT = 'singularityFlow.repositoryActive';

function setActiveRepositoryContext(next: ActiveRepositoryContext | null): void {
  setGatewayRepositoryContext(next);
  Promise.resolve(vscode.commands.executeCommand('setContext', REPOSITORY_ACTIVE_CONTEXT, next !== null))
    .catch(() => undefined);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const hostBenchmarkEnabled = beginHostPerformanceActivation();
  let persistHostBenchmarkCache: () => Promise<boolean> = async () => false;
  extensionLifetime.abort();
  extensionLifetime = new AbortController();
  const activationSignal = extensionLifetime.signal;
  // Capture before activation yields: post-install maintenance must not mix the loaded old
  // extension with a replacement bundle already on disk, even without a governed repo open.
  const loadedBundle = new LoadedBundle(path.join(context.extensionPath, 'dist', 'extension.cjs'));
  // Optional work (Story discovery, product checks) waits while the intake form is on screen.
  const backgroundWork = new BackgroundWorkGovernor();
  // Module state can survive a deactivate/reactivate cycle in the same extension host. Until this
  // activation validates a workspace or folder, no command may inherit the previous routing choice.
  setActiveRepositoryContext(null);
  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);
  if (hostBenchmarkEnabled) {
    context.subscriptions.push(vscode.commands.registerCommand(
      'singularityFlow.__hostPerformance',
      async (action: 'snapshot' | 'reset-interval' | 'persist-cache' = 'snapshot') => {
        if (action === 'persist-cache') return persistHostBenchmarkCache();
        return action === 'reset-interval' ? resetHostPerformanceInterval() : hostPerformanceSnapshot();
      }
    ));
  }
  // First line in the channel, so "which build is actually loaded" is one look rather than a guess.
  // The version does not change between development reinstalls, so it cannot answer this.
  output.appendLine(`Singularity Flow — build ${typeof __SFLOW_BUILD__ === 'string' ? __SFLOW_BUILD__ : 'unstamped'}`);
  /**
   * What a button on a result card does. `[UXH:REQ-031]` `[DHR:REQ-086]`
   *
   * One handler for every card, dispatching by the action's stable id — the card never puts a handle
   * or an operation name in the DOM, so a click cannot name something that was not offered.
   *
   * Two paths, and which one applies is a property of where the card came from rather than a
   * setting. A card built from a gateway result carries live handles, so it goes through the
   * executor, which re-resolves against the world as it is now and refuses if anything moved. A card
   * built from a CLI refusal carries no handle — the process that signed one has exited — so its
   * only mechanism is the terminal equivalent the producer supplied.
   *
   * The fallback is not a quiet downgrade: `showCardResult` is what re-renders after a dispatch, so
   * a stale handle produces a visible recovery card rather than a command that silently ran against
   * a world the reader was not looking at.
   */
  /**
   * The home the reader is currently looking at, kept so it can be acknowledged.
   *
   * The envelope rather than the card: an acknowledgement records the *world* the reader read, and
   * the card is a rendering of it that has already dropped everything the next delta compares. Held
   * for the same reason the card's actions are looked up in the result that produced them — what is
   * acknowledged must be what was on screen, not whatever a second read would return now.
   */
  let lastHome: {
    readonly envelope: any;
    readonly key: string;
    readonly route: GatewayRepositoryContext;
  } | null = null;
  // Home and its conversational answer share one generation. A slower read from a previous
  // workspace/request must never replace a newer projection in the full-width panel.
  let homeRequestGeneration = 0;
  // Workspaces is a retained singleton, but its machine-wide reads are asynchronous. Bind every
  // open request to one generation so an older authority handoff can never finish last and replace
  // the scope selected by a newer click.
  let openWorkspacesRequestGeneration = 0;
  let openWorkspacesReadController: AbortController | null = null;
  context.subscriptions.push({ dispose: () => openWorkspacesReadController?.abort() });
  let currentHelpWork: () => { id: string; kind?: string | null } | null = () => null;

  /**
   * Hand the gateway the one fact only this host has. `[DHR:REQ-024]`
   *
   * `work.return` decides between "since you were here" and "current state" on whether it was given
   * a *when*, and nothing had ever given it one — the field was declared, defaulted and threaded
   * the whole way through `plannerContext` with no supplier at either end. The acknowledgement that
   * answers it is in `globalState`, which is host memory by nature: it is about a person and a
   * machine, not about the repository, which is exactly why the gateway cannot derive it.
   *
   * Keyed off the home the reader is currently looking at, so the briefing and the card agree about
   * when "last time" was rather than each consulting the store with a key of their own.
   */
  provideAcknowledgedAt(() => {
    if (!lastHome) return null;
    return context.globalState.get<HomeAcknowledgement>(lastHome.key)?.at ?? null;
  });
  const currentHomeLens = (): string => {
    const role = vscode.workspace.getConfiguration('singularityFlow').get<string>('role', 'developer');
    return ['developer', 'qa', 'architect', 'product-owner', 'admin'].includes(role) ? role : 'developer';
  };
  provideHomeLens(currentHomeLens);
  provideChatProfileName(() => vscode.workspace.getConfiguration('singularityFlow').get<string>('userName', ''));

  onHomeRequest(async ({ request }) => {
    if (!lastHome) return;
    const generation = ++homeRequestGeneration;
    const requestedHome = lastHome;
    try {
      const { kernel } = gatewaySession(requestedHome.route);
      const { planDeveloperConversation } = await import('../../../src/gateway/conversation.mjs');
      const conversation = planDeveloperConversation(request);
      const currentWork = requestedHome.envelope.data?.currentWork ?? requestedHome.envelope.data?.activeWork ?? null;
      const workOperations = new Set(['work.continue', 'work.return', 'work.readiness', 'review.packet']);
      const argumentsForRequest = conversation.route?.operationId === 'impact.what-if'
        ? { proposal: request }
        : conversation.route && currentWork && workOperations.has(conversation.route.operationId)
          ? { workId: currentWork.id, ...(currentWork.kind ? { workKind: currentWork.kind } : {}) }
          : {};
      const resolution = await kernel.resolve({
        utterance: request,
        ...(conversation.route ? { goalHint: conversation.route.operationId } : {}),
        arguments: argumentsForRequest
      });
      const envelope = resolution.kind === 'read' && resolution.next.length === 1
        ? await kernel.read({ resolutionId: resolution.next[0].handle })
        : resolution;
      if (generation !== homeRequestGeneration || lastHome !== requestedHome) return;
      const destination = gatewayDestinationRequest(envelope);
      if (destination) {
        await vscode.commands.executeCommand(destination.command, ...destination.args);
        return;
      }
      showResultCard(buildResultCard(envelope), { origin: 'gateway', historyMode: 'push' });
    } catch (error) {
      if (generation !== homeRequestGeneration || lastHome !== requestedHome) return;
      showRefusal(error, { headline: 'Could not answer from My Work' });
    }
  });

  onResultAction(async ({ actionId, view, origin }) => {
    /**
     * "I have read this", stored before anything else is considered. `[DHR:REQ-024]`
     *
     * Handled ahead of the executor because it is not a gateway action and has no handle to
     * re-resolve — dispatching it there would look up an id the kernel never issued and fall
     * through to the terminal path, which would open a terminal and type nothing.
     */
    if (actionId === ACKNOWLEDGE_ACTION_ID) {
      if (!lastHome) return;
      const acknowledgement = homeAcknowledgementFor(lastHome.envelope);
      /**
       * A snapshot with nothing in it is not stored.
       *
       * The model already declines to offer the button in that case, so reaching here means the
       * world changed between render and press. Writing the empty snapshot anyway would replace
       * *not checked* with *could not compare* — strictly worse, and caused by the press.
       */
      if (!acknowledgement) return;
      await context.globalState.update(lastHome.key, acknowledgement);
      showResultCard(buildResultCard(lastHome.envelope, { acknowledgement }), {
        origin: 'gateway', historyMode: 'replace'
      });
      return;
    }

    const action = view.actions.find((entry) => entry.id === actionId)
      ?? view.checklist.map((row) => row.action).find((entry) => entry?.id === actionId);
    if (!action) return;

    const active = activeRepositoryContext();
    const route = lastHome?.route ?? active;
    if (route && origin === 'gateway') {
      try {
        // A rootless Home is stale the moment a governed repository becomes active. Its handle
        // cannot infer that machine-wide selection change from Git bytes, so the host closes that
        // observation gap before dispatch.
        if (route.root === null && active) {
          await vscode.commands.executeCommand('singularityFlow.myWork');
          return;
        }
        const { executor } = gatewaySession(route);
        /**
         * The action as the envelope described it, not as this host assumed.
         *
         * It used to force `executable: false`, which made every press a *selection* — right for a
         * disambiguation choice, wrong for a read handle, and the wrongness surfaced as "that
         * choice is no longer current", blaming drift for a guess. The executor already knows what
         * to do with each; it only needed to be told which one this is.
         */
        const outcome = await executor.execute(action);
        const destination = gatewayDestinationRequest(outcome.result);
        if (destination) {
          await vscode.commands.executeCommand(destination.command, ...destination.args);
          return;
        }
        if (outcome.result) showResultCard(buildResultCard(outcome.result), {
          origin: 'gateway', historyMode: 'push'
        });
        /**
         * A ceremony is a destination, not a gateway mutation. The executor deliberately hands it
         * back to the host, so returning here without opening that destination made approval and
         * review buttons appear to work while doing nothing. Until a dedicated review webview is
         * supplied, the authored terminal equivalent is the governed ceremony surface.
         */
        if (outcome.outcome === 'ceremony') {
          if (!action.command) {
            output.appendLine(`[result] '${actionId}' has no ceremony surface in this build.`);
            return;
          }
          const terminal = vscode.window.createTerminal({ name: 'Singularity Flow review' });
          terminal.show(true);
          terminal.sendText(action.command, false);
        }
        return;
      } catch (error) {
        output.appendLine(`[result] ${actionId} could not be dispatched in-process: ${(error as Error).message}`);
      }
    }

    if (!action.command) {
      output.appendLine(`[result] '${actionId}' has no terminal equivalent to run in this build.`);
      return;
    }
    const terminal = vscode.window.createTerminal({ name: 'Singularity Flow' });
    terminal.show(true);
    terminal.sendText(action.command, false);
  });

  onAutoResultAction(async ({ command, repositoryRoot }) => {
    const activeRoot = activeRepositoryContext()?.root;
    if (!activeRoot || path.resolve(activeRoot) !== path.resolve(repositoryRoot)) return;
    // A card click prepares the exact current CAS/hash-bound command but never presses Enter.
    // The developer can review, add a typed answer where required, or discard it safely.
    const terminal = vscode.window.createTerminal({
      name: 'Singularity Flow Auto review', cwd: repositoryRoot
    });
    terminal.show(true);
    terminal.sendText(command, false);
  });

  /**
   * `My Work` — the home, resolved in this process. `[UXH:REQ-020]` `[UXH:D1]`
   *
   * The whole path in one command: words in, an opaque handle back, the handle revalidated against
   * the current world, and a v2 envelope rendered by the same card every other result uses. Nothing
   * here knows what a home is, which is the point — the shell renders results, and `home.overview`
   * is one.
   *
   * The one thing the kernel cannot supply is what the reader saw last time `[DHR:REQ-024]`. That is
   * host memory by nature — it is about a person and a machine, not about the repository — so it is
   * read here, handed to the card, and never pushed into the envelope where it would masquerade as
   * something the gateway established.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.myWork', async (
    options: { reveal?: boolean } = {}
  ) => {
    const generation = ++homeRequestGeneration;
    const active = activeRepositoryContext();
    try {
      const bootstrap = active ? null : await latestWorkspaceBootstrap().catch(() => null);
      const route: GatewayRepositoryContext = active ?? {
        root: null,
        workspaceId: null,
        workspaceName: null,
        repositoryId: null,
        origin: 'machine-local',
        bootstrap
      };
      const { kernel, binding } = gatewaySession(route);
      const resolution = await kernel.resolve({ utterance: 'what should I do next' });
      const envelope = resolution.kind === 'read' && resolution.next.length === 1
        ? await kernel.read({ resolutionId: resolution.next[0].handle })
        : resolution;
      if (generation !== homeRequestGeneration || activeRepositoryContext() !== active) return;
      /**
       * Keyed on what this home is about, not on the folder that is open.
       *
       * `data.workspace.id` is the workspace the planner resolved; falling back to the binding's
       * covers the no-workspace-selected home, which has no workspace to name and still deserves a
       * stable key rather than sharing `unknown` with every other unresolved repository.
       */
      const key = acknowledgementKey(
        envelope.data?.workspace?.id ?? binding().workspaceId
          ?? bootstrap?.bootstrapId ?? 'rootless-home',
        binding().actorId
      );
      const acknowledgement = context.globalState.get<HomeAcknowledgement>(key) ?? null;
      lastHome = { envelope, key, route };
      showResultCard(buildResultCard(envelope, { acknowledgement }), {
        origin: 'gateway', reveal: options.reveal !== false, preserveFocus: options.reveal === false
      });
    } catch (error) {
      if (generation !== homeRequestGeneration || activeRepositoryContext() !== active) return;
      showRefusal(error, { headline: 'Could not read your work',
        reveal: options.reveal !== false, preserveFocus: options.reveal === false });
    }
  }));

  /**
   * `Impact of a change…` — the first form the shell renders from a schema. `[UXH:REQ-070]`
   *
   * `impact-what-if-v1` rather than one of the 25 bespoke panels, deliberately. `[UXH:REQ-075]` lets
   * a specialised form remain "when they provide richer domain validation", and the large ones do —
   * `intake-form.ts` populates repository pickers from the snapshot, which no schema declares.
   * Replacing those first would trade a better form for a more general one. This is a surface that
   * did not exist: three optional arguments on an implemented planner, reachable today.
   *
   * It is also the whole P5 path in one command — schema to form, form to registered operation,
   * operation to the same result card every other answer uses. Nothing between the button and the
   * kernel knows what an impact is.
   */
  useDraftStore(context.workspaceState);
  onFormSubmit(async ({ schemaId, goal, values }) => {
    const active = activeRepositoryContext();
    if (!active) {
      // Not a silent return: the form has just closed, and a reader who filled one in and pressed
      // the button is owed a reason rather than an empty editor. `[UXH:CON-007]`
      showRefusal('The repository is no longer resolved, so nothing was submitted.',
        { headline: 'No workspace selected' });
      return;
    }
    try {
      const { kernel } = gatewaySession(active);
      const resolution = await kernel.resolve({ goalHint: goal, arguments: values });
      const envelope = resolution.kind === 'read' && resolution.next.length === 1
        ? await kernel.read({ resolutionId: resolution.next[0].handle })
        : resolution;
      showResultCard(buildResultCard(envelope), { origin: 'gateway' });
    } catch (error) {
      // The refusal is the answer, and it renders as a card like any other `[UXH:CON-007]`.
      showRefusal(error, { headline: `Could not run ${schemaId.replace(/-v\d+$/, '')}` });
    }
  });
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.impactForm', () => {
    if (!activeRepositoryContext()) {
      showRefusal('No governed workspace or repository is selected. Choose a workspace or open a governed repository.',
        { headline: 'No workspace selected' });
      return;
    }
    if (!showForm({
      schemaId: 'impact-what-if-v1', goal: 'impact.what-if',
      title: 'Change Flight Plan', command: 'sflow impact preview'
    })) {
      showRefusal('This build has no argument schema for that operation.',
        { headline: 'Nothing to ask for' });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.previewSelectedImpact', async (argument?: unknown) => {
    const active = activeRepositoryContext();
    const selected = menuResource(argument) ?? vscode.window.activeTextEditor?.document.uri;
    if (!active || !selected || selected.scheme !== 'file') {
      showRefusal('Open a file inside the active governed repository, then try again.', { headline: 'No code selected' });
      return;
    }
    // The same containment the explain menus use, so a file opened through a symbolic link (on
    // macOS, /tmp is /private/tmp) is not refused as outside the repository.
    const relative = await repositoryRelativePath(active.root, selected.fsPath);
    if (!relative) {
      showRefusal('The selected file is outside the active governed repository.', { headline: 'Selection is out of scope' });
      return;
    }
    try {
      const { kernel } = gatewaySession(active);
      const resolution = await kernel.resolve({
        goalHint: 'impact.what-if',
        arguments: { proposal: `Change selected file ${relative}`, scope: relative }
      });
      const envelope = resolution.kind === 'read' && resolution.next.length === 1
        ? await kernel.read({ resolutionId: resolution.next[0].handle })
        : resolution;
      showResultCard(buildResultCard(envelope), { origin: 'gateway' });
    } catch (error) {
      showRefusal(error, { headline: 'Could not preview selected code' });
    }
  }));

  const secureCredentials = new SecureCredentials(context.secrets);
  const resolvedCliEnvironment = async (): Promise<NodeJS.ProcessEnv> => {
    const environment = await secureCredentials.environment();
    const name = vscode.workspace.getConfiguration('singularityFlow').get<string>('userName', '');
    const mirrored = await synchronizeChatProfile(name, environment);
    if (!mirrored) output.appendLine('Chat profile could not be shared with shell skills; this window still uses its configured name.');
    const mode = vscode.workspace.getConfiguration('singularityFlow').get<'auto' | 'disabled'>('modelMode', 'auto');
    if (mode === 'disabled') environment.SINGULARITY_FLOW_NO_MODEL = '1';
    else delete environment.SINGULARITY_FLOW_NO_MODEL;
    return environment;
  };
  const resetMarker = path.resolve(process.env.SINGULARITY_FLOW_VSCODE_RESET_MARKER
    || path.join(os.homedir(), '.singularity-flow', 'vscode-fresh-reset-pending.json'));
  const pendingFreshReset = await readFile(resetMarker).then((bytes) => {
    readRecord('vscode-reset-marker', bytes);
    return true;
  }).catch((error: NodeJS.ErrnoException & { code?: string }) => {
    if (error.code === 'ENOENT') return false;
    output.appendLine(`Could not inspect fresh-reset marker: ${error.message}`);
    return false;
  });
  if (pendingFreshReset) {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    const globalSettingKeys = ['cliPath', 'nodePath', 'modelMode', 'userName', 'role'];
    const globalKeys = typeof context.globalState.keys === 'function'
      ? context.globalState.keys()
      : ['onboardingComplete', START_WIZARD_KEY];
    await Promise.all([
      secureCredentials.resetAll(),
      ...globalKeys.map((key) => context.globalState.update(key, undefined)),
      ...globalSettingKeys.map((key) => settings.update(key, undefined, vscode.ConfigurationTarget.Global))
    ]);
    await rm(resetMarker, { force: true });
    output.appendLine('Local reset: cleared Singularity Flow credentials, personalization, global settings, and extension global state.');
  }
  let cliEnvironment = await resolvedCliEnvironment();

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.configureModelMode', async () => {
    const setting = await vscode.window.showQuickPick([
      { label: 'Auto', description: 'Allow operations whose policy permits or requires a model', value: 'auto' as const },
      { label: 'Disabled', description: 'No kernel-owned model invocation; required operations fail before loading', value: 'disabled' as const }
    ], { title: 'Singularity Flow model mode' });
    if (!setting) return;
    await vscode.workspace.getConfiguration('singularityFlow').update('modelMode', setting.value, vscode.ConfigurationTarget.Workspace);
    cliEnvironment = await resolvedCliEnvironment();
    await vscode.commands.executeCommand('singularityFlow.refresh');
  }));

  let refreshPersonaMenus = (): void => {};
  const configurationListener = vscode.workspace.onDidChangeConfiguration?.(async (event) => {
    if (event.affectsConfiguration('singularityFlow.modelMode')
      || event.affectsConfiguration('singularityFlow.userName')) cliEnvironment = await resolvedCliEnvironment();
    if (event.affectsConfiguration('singularityFlow.role')
      || event.affectsConfiguration('singularityFlow.userName')) refreshPersonaMenus();
  });
  if (configurationListener) context.subscriptions.push(configurationListener);

  const pickMenuPersona = () => vscode.window.showQuickPick(PROFILE_PERSONAS.map((persona) => ({
    label: persona.label, description: persona.description, value: persona.id
  })), {
    title: 'Choose your menu persona',
    placeHolder: 'Persona changes navigation only; governed agents and approval authority do not change.'
  });

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.choosePersona', async () => {
    const role = await pickMenuPersona();
    if (!role) return;
    await Promise.all([
      vscode.workspace.getConfiguration('singularityFlow')
        .update('role', role.value, vscode.ConfigurationTarget.Global),
      context.globalState.update('onboardingComplete', true)
    ]);
    refreshPersonaMenus();
    void showCompactInformationMessage(`${role.label} menu is ready. All commands remain available.`);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.configureProfile', async () => {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    const name = await vscode.window.showInputBox({
      title: 'Your Singularity Flow profile', prompt: 'Display name',
      value: settings.get<string>('userName') ?? '', ignoreFocusOut: true
    });
    if (name == null) return;
    const role = await pickMenuPersona();
    if (!role) return;
    await Promise.all([
      settings.update('userName', name.trim(), vscode.ConfigurationTarget.Global),
      settings.update('role', role.value, vscode.ConfigurationTarget.Global),
      context.globalState.update('onboardingComplete', true)
    ]);
    refreshPersonaMenus();
    void showCompactInformationMessage(
      `Singularity Flow profile saved for ${name.trim() || role.label}. ${role.label} menus are ready.`
    );
  }));

  /**
   * Open the getting-started walkthrough.
   *
   * The walkthrough was written, shipped in the manifest, and opened by nothing — there was no
   * command for it and no code path that called `openWalkthrough`. `onboardingComplete` was written
   * by the profile command above and never read by anything, so the extension recorded that
   * onboarding had happened without ever offering it.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWalkthrough', async () => {
    await vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#singularityFlow.gettingStarted`,
      false
    );
  }));

  // Offer it once, on the first activation that has never seen it. Offer, not force: an unprompted
  // full-screen takeover is its own kind of rude, and a notification can be dismissed for good.
  if (!context.globalState.get<boolean>('onboardingComplete') && !context.globalState.get<boolean>('walkthroughOffered')) {
    void context.globalState.update('walkthroughOffered', true);
    void showCompactInformationMessage(
      'New to Singularity Flow? The walkthrough sets up your profile and first governed workspace.',
      'Show me', 'Not now'
    ).then((choice) => {
      if (choice === 'Show me') void vscode.commands.executeCommand('singularityFlow.openWalkthrough');
    });
  }

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.connectJira', async () => {
    const deployment = await vscode.window.showQuickPick([
      { label: 'Jira Cloud', value: 'cloud' as const },
      { label: 'Jira Data Center', value: 'data-center' as const }
    ], { title: 'Jira deployment' });
    if (!deployment) return;
    const baseUrl = await vscode.window.showInputBox({
      title: 'Jira URL', prompt: 'https://company.atlassian.net', ignoreFocusOut: true,
      validateInput: (value) => { try { return new URL(value).protocol === 'https:' ? null : 'Use HTTPS.'; } catch { return 'Enter a valid HTTPS URL.'; } }
    });
    if (!baseUrl) return;
    const username = await vscode.window.showInputBox({
      title: deployment.value === 'cloud' ? 'Jira email or username' : 'Jira username (optional for PAT)',
      ignoreFocusOut: true
    });
    if (username == null) return;
    const token = await vscode.window.showInputBox({
      title: deployment.value === 'cloud' ? 'Jira API token / PAT' : 'Jira personal access token',
      password: true, ignoreFocusOut: true, validateInput: (value) => value.trim() ? null : 'A token is required.'
    });
    if (!token) return;
    const candidate = {
      ...process.env, JIRA_BASE_URL: baseUrl, JIRA_DEPLOYMENT: deployment.value,
      JIRA_USERNAME: username, JIRA_PAT: token, JIRA_CONNECTION_NAME: 'vscode'
    };
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const repository = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      await new SingularityFlowClient({ location, repository, environment: candidate }).run(['jira', 'status', '--json']);
      await secureCredentials.saveJira({ deployment: deployment.value, baseUrl, username, connectionName: 'vscode' }, token);
      cliEnvironment = await resolvedCliEnvironment();
      void showCompactInformationMessage('Jira connected securely. Reload this window to apply it to every view.', 'Reload')
        .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
    } catch (error) {
      showRefusal(error, { headline: 'Jira was not saved' });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetJira', async () => {
    const choice = await showCompactWarningMessage(
      'Remove the saved Jira connection from the operating-system keychain?', { modal: true }, 'Reset Jira');
    if (choice !== 'Reset Jira') return;
    await secureCredentials.resetJira();
    cliEnvironment = await resolvedCliEnvironment();
    void showCompactInformationMessage('Saved Jira credentials removed.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.configureTeams', async () => {
    const webhook = await vscode.window.showInputBox({
      title: 'Microsoft Teams incoming webhook',
      prompt: 'Stored in the operating-system keychain; never written to Git.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password ? null : 'Use an HTTPS webhook URL without embedded credentials.';
        } catch { return 'Enter a valid HTTPS URL.'; }
      }
    });
    if (!webhook) return;
    await secureCredentials.saveTeamsWebhook(webhook);
    cliEnvironment = await resolvedCliEnvironment();
    void showCompactInformationMessage('Teams notifications configured. Reload this window to apply the secret to every command.', 'Reload')
      .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetTeams', async () => {
    const choice = await showCompactWarningMessage(
      'Remove the saved Teams webhook from the operating-system keychain?', { modal: true }, 'Reset Teams');
    if (choice !== 'Reset Teams') return;
    await secureCredentials.resetTeamsWebhook();
    cliEnvironment = await resolvedCliEnvironment();
    void showCompactInformationMessage('Saved Teams webhook removed.');
  }));

  /**
   * Register the view with a fixed explanation and stop.
   *
   * Every path out of activation goes through here rather than returning bare. A contributed view
   * with no provider makes VS Code report that no data provider is registered, which describes the
   * extension's internals and nothing about the repository the reader has open.
   */
  /**
   * The commands that need a repository behind them.
   *
   * Every one of these is contributed in package.json, so the command palette offers all of them
   * whatever state the window is in. They used to be registered after activation had decided it
   * had a repository — which meant that in a window without one, the palette advertised eleven
   * commands that did not exist, and running one reported "command not found". That describes the
   * extension's internals and nothing about the folder the reader has open.
   *
   * So they are registered here, unconditionally, and dispatch through `handlers`. Until a
   * repository is available the handler is missing and the command says why, in the same words the
   * view is showing.
   */
  const REPOSITORY_COMMANDS = [
    'singularityFlow.openCapabilities', 'singularityFlow.openImpact', 'singularityFlow.openFlowImpact', 'singularityFlow.openStories',
    'singularityFlow.openApprovals', 'singularityFlow.openInbox', 'singularityFlow.openWorkspaceStories', 'singularityFlow.openReviews', 'singularityFlow.startWork',
    'singularityFlow.openConfigurationApprovals',
    'singularityFlow.openAdhocWork',
    'singularityFlow.openDeveloperHome',
    'singularityFlow.openGoals', 'singularityFlow.openFaultRepairs', 'singularityFlow.openJournal',
    'singularityFlow.attachEvidence', 'singularityFlow.manageEvidence',
    'singularityFlow.detachEvidence', 'singularityFlow.addSource',
    'singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.openPhaseArtifacts', 'singularityFlow.openStoryIntake', 'singularityFlow.runAction',
    'singularityFlow.continueSafely',
    'singularityFlow.prepareStoryPhase', 'singularityFlow.publishStoryPhase',
    'singularityFlow.submitStoryPhase', 'singularityFlow.prefillStoryPhaseGeneration',
    'singularityFlow.reviewStoryTestRecovery', 'singularityFlow.resolvePhaseIssues',
    'singularityFlow.approve', 'singularityFlow.openJourney', 'singularityFlow.openCommandCenter',
    'singularityFlow.openComprehensionCenter', 'singularityFlow.openChangeExplorer',
    'singularityFlow.openCodeExplanation', 'singularityFlow.explainFileChanges', 'singularityFlow.explainChangeAtCursor',
    'singularityFlow.openCodeExplainer', 'singularityFlow.explainCodeAtCursor', 'singularityFlow.openRepositoryKnowledge',
    'singularityFlow.reviewRepositoryKnowledge',
    'singularityFlow.createSgosWorkflow', 'singularityFlow.reviewSgosMetaTool',
    'singularityFlow.reviewLocalRunner',
    'singularityFlow.openReconciliation',
    'singularityFlow.openEvidenceMatrix',
    'singularityFlow.showImpact', 'singularityFlow.addCapability', 'singularityFlow.editCapability',
    'singularityFlow.openDashboard', 'singularityFlow.openDesigner', 'singularityFlow.openWorkflowStudio', 'singularityFlow.decideStory',
    'singularityFlow.publishConfiguration',
    'singularityFlow.openInstructionDesigner', 'singularityFlow.openPromptAudit', 'singularityFlow.openActivityLog',
    'singularityFlow.openWorkspaceLogs', 'singularityFlow.refreshWorkspaceLogs', 'singularityFlow.openSpecificationTrace',
    'singularityFlow.inspectCompositionCache', 'singularityFlow.checkLedgerDeployment',
    'singularityFlow.openCopilot', 'singularityFlow.openMeteredCopilot',
    'singularityFlow.openVisualAssurance',
    'singularityFlow.openConfigurationCenter', 'singularityFlow.configureTests', 'singularityFlow.configureAuto', 'singularityFlow.configureWorldModel',
    'singularityFlow.buildWorldModel', 'singularityFlow.rebuildWorldModel', 'singularityFlow.configureAstIntelligence',
    'singularityFlow.configurePeople', 'singularityFlow.configureMcp',
    'singularityFlow.configureTemplates', 'singularityFlow.openSkills', 'singularityFlow.configureModels',
    'singularityFlow.reopenCompleted', 'singularityFlow.rollForwardRework', 'singularityFlow.cancelWork',
    'singularityFlow.expandReference', 'singularityFlow.openHarnessReport'
  ];
  /** Workspaces are machine-wide and remain available whatever folder is open. */
  const workspaceTree = new NodeTreeProvider();
  let workspaceEntries: WorkspaceEntry[] = [];
  const drawWorkspaces = (): void => workspaceTree.replace(buildWorkspaceTree(workspaceEntries));
  context.subscriptions.push(workspaceTree);
  /**
   * The five tree views these providers used to feed are gone. `[UXH:REQ-141]`
   *
   * They were contributed with `"when": "singularityFlow.legacyNavigation"`, a context key set
   * nowhere in the extension — so they had never rendered for anyone, while `createTreeView` still
   * built and retained one per provider on every activation. Three of them were registered twice,
   * from the main path and the repository-unavailable path, which is two live views for one id.
   *
   * The providers stay exactly as they are: `sidebar.bind()` is what feeds the Navigator webview,
   * which is the surface that actually renders. Only the dead half is removed.
   */

  /**
   * Product help is available before a repository or workspace is selected.
   *
   * The CLI packages the canonical manual, so the editor asks the selected/bundled CLI for it
   * instead of carrying a second documentation copy that can drift. The small tree is navigation;
   * the panel is the complete, searchable manual and command reference.
   */
  /**
   * The documentation topics, read from the CLI package's stamped manifest `[DOC:REQ-040]`.
   *
   * Synchronous and best-effort: this runs during activation, and an older CLI without a manifest
   * must produce a Help view with one fewer group rather than a failed activation. The topics are
   * only ever *named* here — the bytes come from `explain` when one is clicked, so the extension
   * can never show a different answer than the terminal does.
   */
  function documentationTopicsGroup(packageRoot: string): TreeNode[] {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const manifest = require(path.join(packageRoot, 'src', 'docs-manifest.json')) as {
        topics?: { id: string; title: string; version: number }[];
      };
      const topics = manifest.topics ?? [];
      if (!topics.length) return [];
      return [{
        kind: 'group', id: 'help:topics', label: 'Topics', icon: 'book',
        description: `${topics.length} served offline`,
        children: topics.map((topic) => ({
          kind: 'action',
          id: `help:topic:${topic.id}`,
          label: topic.title,
          description: `${topic.id} v${topic.version}`,
          icon: 'book',
          runCommand: 'singularityFlow.explainTopic'
        }))
      }];
    } catch {
      return [];
    }
  }

  const helpNodes = (topicGroup: TreeNode[]): TreeNode[] => [
    {
      kind: 'group', id: 'help:start', label: 'Learn Singularity Flow', icon: 'book', children: [
        { kind: 'action', id: 'help:quick-start', label: 'Quick start', description: 'first governed work', icon: 'rocket', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:workspaces-and-capabilities', label: 'Workspaces & capabilities', description: 'scope and ownership', icon: 'type-hierarchy', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:story-intake', label: 'Story intake', description: 'Jira or manual', icon: 'book', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:how-the-workflow-works', label: 'Lifecycle & approvals', description: 'state and phases', icon: 'git-branch', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:governed-agents-and-approval-authority', label: 'Agents, prompts & world model', description: 'prompt composition', icon: 'hubot', runCommand: 'singularityFlow.openHelp' }
      ]
    },
    {
      kind: 'group', id: 'help:reference', label: 'Reference', icon: 'references', children: [
        { kind: 'action', id: 'help:copilot-commands', label: 'Copilot /sf-* commands', description: 'skills', icon: 'sparkle', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:cli-to-copilot-skill-mapping', label: 'CLI ↔ Copilot mapping', description: 'every command and skill', icon: 'arrow-swap', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:cli-command-reference', label: 'CLI command reference', description: 'all commands', icon: 'terminal', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:configuring-workflows', label: 'Configuration reference', description: 'workflow and artifacts', icon: 'settings-gear', runCommand: 'singularityFlow.openHelp' },
        { kind: 'action', id: 'help:troubleshooting', label: 'Troubleshooting', description: 'doctor and recovery', icon: 'tools', runCommand: 'singularityFlow.openHelp' }
      ]
    },
    ...topicGroup,
    { kind: 'action', id: 'help:all', label: 'Open searchable Help Center', description: 'complete offline manual', icon: 'search', runCommand: 'singularityFlow.openHelp' }
  ];
  // Topics come from the CLI's own stamped manifest, and clicking one renders the CLI's own bytes
  // `[DOC:REQ-040]`. They are filled in once the CLI is resolved, below: the tree is built during
  // activation and the CLI location is not known yet. The alternative — restating 29 topics in the
  // extension — is the second documentation copy this whole layer exists to avoid.
  const helpTree = new NodeTreeProvider(helpNodes([]));
  context.subscriptions.push(helpTree);
  const logsTree = new NodeTreeProvider([{
    kind: 'action', id: 'logs:open', label: 'Open workspace logs',
    description: 'activity · prompts · Copilot · workspace', icon: 'commit',
    runCommand: 'singularityFlow.openWorkspaceLogs'
  }]);
  context.subscriptions.push(logsTree);
  // One continuous navigation surface replaces five independently-sized native panes. The hidden
  // native TreeViews remain compatibility adapters for their mature, tested read models and context
  // commands; the webview binds to the exact same providers so it cannot tell a different story.
  let hostSidebarProjection: 'initial' | 'loading' | 'cache' | 'confirmed' = 'initial';
  const sidebar = new SidebarViewProvider(context.globalState, () => {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    return { name: settings.get<string>('userName') ?? '', role: settings.get<string>('role') ?? '' };
  }, () => recordHostSidebarRender(hostSidebarProjection));
  refreshPersonaMenus = () => sidebar.profileChanged();
  const syncSidebarDestination = () => {
    const input = vscode.window.tabGroups?.activeTabGroup?.activeTab?.input;
    const type = input && typeof input === 'object' && 'viewType' in input && typeof input.viewType === 'string'
      ? input.viewType : null;
    sidebar.setActiveDestination(sidebarDestination(type, resultPanelIsHome()));
  };
  if (vscode.window.tabGroups) context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(syncSidebarDestination),
    vscode.window.tabGroups.onDidChangeTabGroups(syncSidebarDestination)
  );
  context.subscriptions.push(onResultPanelChanged(syncSidebarDestination));
  syncSidebarDestination();
  sidebar.bind('workspaces', workspaceTree);
  sidebar.bind('logs', logsTree);
  sidebar.bind('help', helpTree);
  context.subscriptions.push(sidebar, vscode.window.registerWebviewViewProvider(
    'singularityFlow.navigation', sidebar, { webviewOptions: { retainContextWhenHidden: true } }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.manageFavorites', () => sidebar.manageFavorites()
  ));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openHelp', async (node?: TreeNode) => {
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const manual = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      }).run<HelpDocument>(['help', '--json']);
      const topic = node?.id.startsWith('help:') && !['help:start', 'help:reference', 'help:all'].includes(node.id)
        ? node.id.slice('help:'.length) : null;
      const { HelpPanel } = helpRuntime();
      HelpPanel.show(context, manual, topic, path.resolve(path.dirname(location.cli), '..'));
    } catch (error) {
      showRefusal(error, { headline: 'Could not open Singularity Flow Help' });
    }
  }));
  /**
   * Render one documentation topic using the selected engine's own served bytes `[DOC:REQ-040]`.
   *
   * This command is registered with the other repository-independent Help commands. Keeping it in
   * the late repository handler table made every topic look actionable while leaving VS Code with
   * no command to execute. The engine-served bytes are inserted into the existing Help Center so a
   * topic keeps readable Markdown rendering, search, navigation, and copy controls instead of
   * opening as a raw untitled Markdown editor.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.explainTopic', async (node?: TreeNode) => {
    const id = String(node?.id ?? '').replace(/^help:topic:/, '');
    if (!id) return;
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const served = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      }).run<{
        data?: { served?: { text?: string }; citation?: string; topic?: { id?: string; title?: string } };
      }>(['explain', id, '--json']);
      const body = served.data?.served?.text ?? '';
      if (!body) throw new Error(`The engine returned no documentation body for '${id}'.`);
      const manual = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      }).run<HelpDocument>(['help', '--json']);
      const topic = {
        id: served.data?.topic?.id ?? id,
        title: served.data?.topic?.title ?? id,
        content: `${body}\n\n${served.data?.citation ?? ''}`.trim()
      };
      const document: HelpDocument = {
        ...manual,
        topics: [topic, ...manual.topics.filter((entry) => entry.id !== topic.id)],
        selectedTopic: topic.id
      };
      const { HelpPanel } = helpRuntime();
      HelpPanel.show(context, document, topic.id, path.resolve(path.dirname(location.cli), '..'));
    } catch (error) {
      showRefusal(error, { headline: `Could not read topic ${id}` });
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.explainError', async (topicId: string) => {
    const id = String(topicId ?? '').trim();
    // Error cards only carry a reviewed topic identifier. They never carry a path, transcript, or
    // terminal command across this boundary.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return;
    await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: `help:topic:${id}` });
    const root = activeRepositoryContext()?.root;
    if (root) {
      await recordHelpMetric(root, {
        surface: 'error-link', intent: 'diagnose', outcome: 'resolved', topicId: id,
        matchedBy: 'stable-error-code', latencyMs: 0, answerBytes: 0, actionCategory: 'error-explained'
      }).catch(() => {});
    }
  }));
  registerSflowChat(context, { getCurrentWork: () => currentHelpWork() });

  const handlers = new Map<string, (...args: never[]) => unknown>();
  let unavailableReason = 'Open the repository that contains singularity/workflow.yml.';
  const reloadAfterBlockedPreparation = async (): Promise<void> => {
    // The reload binds Lifecycle to the newly selected workspace, but must not silently retry the
    // failed clone during activation. Keep the checkpoint visible for a person to repair explicitly.
    const pending = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
    if (pending?.step === 'work') {
      await context.globalState.update(START_WIZARD_KEY, { ...pending, resumeOnActivation: false });
    }
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  /**
   * Align this window's native root with an explicit workspace choice. Rebinding the SFlow
   * client alone leaves terminals and native Copilot in the previous repository. Deferred
   * workspaces open their existing shell, never a nonexistent checkout or an implicit clone.
   * Background machine-selection updates deliberately do not use this window-navigation helper.
   */
  const workspaceSelectionFile = path.resolve(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(os.homedir(), '.singularity-flow', 'active-workspace.json'));
  let workspaceNavigationGeneration = 0;
  let workspaceSelectionQueue: Promise<unknown> = Promise.resolve();
  const openSelectedWorkspaceFolder = async (selected: {
    workspaceName: string; workspacePath: string; repositoryPath?: string; repositoryState?: string;
  }, reloadIfOpen = false, isCurrent = async (): Promise<boolean> => true): Promise<boolean> => {
    const ready = selected.repositoryState === 'ready';
    if (ready && !selected.repositoryPath) throw new Error('The selected workspace returned no repository path.');
    const target = ready
      // Navigation needs a proven Git root, not another configuration/remote authority fetch.
      // The workspace command already proved membership; lifecycle activation retains its gates.
      ? await validateFactoryResetRepositoryDirectory(selected.repositoryPath!, { signal: extensionLifetime.signal })
      : await fsRealpath(selected.workspacePath);
    if (!ready && !(await lstat(target)).isDirectory()) {
      throw new Error('The selected workspace folder is unavailable. Open Workspace details to repair it.');
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const opened = folders.length === 1
      ? await fsRealpath(folders[0]!.uri.fsPath).catch(() => folders[0]!.uri.fsPath) : null;
    if (!await isCurrent()) return true; // a newer selection owns window navigation now
    if (opened && sameStoryAttachPath(opened, target)) {
      if (!reloadIfOpen) return false;
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return true;
    }
    // A previous Story handoff is not consent to resume that Story in a newly chosen workspace.
    // Selecting a workspace also does not select a Story or automatically open a Copilot chat.
    await context.globalState.update(COPILOT_HANDOFF_KEY, undefined);
    if (!await isCurrent()) return true;
    void showCompactInformationMessage(ready
      ? `${selected.workspaceName} selected. Opening its repository in this window. Start a fresh Copilot chat or terminal for this workspace.`
      : ['missing', 'empty'].includes(selected.repositoryState ?? '')
        ? `${selected.workspaceName} selected. Opening its workspace folder; Start Work will prepare the repository when needed.`
        : `${selected.workspaceName} selected. Opening its workspace folder; inspect Workspace details to repair its repository before starting work.`);
    // VS Code owns unsaved-file handling and preserves the old checkout, branches, and chat history.
    // The documented boolean signature replaces this window rather than creating another one.
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), false);
    return true;
  };
  const prepareDeferredWorkspaceForWork = async (reloadWhenBlocked = false): Promise<boolean> => {
    let location;
    try { location = resolveCli({ extensionPath: context.extensionPath }); }
    catch (error) { showRefusal(error, { headline: 'Could not start work' }); return true; }
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (value) => output.append(value)
    });
    const navigationGeneration = workspaceNavigationGeneration;
    const selectionRevision = await machineSelectionRevision(workspaceSelectionFile);
    const selectionIsCurrent = async (): Promise<boolean> => navigationGeneration === workspaceNavigationGeneration
      && selectionRevision !== undefined
      && await machineSelectionRevision(workspaceSelectionFile) === selectionRevision;
    try {
      const current = await registry.run<{
        active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
        repositoryId?: string; repositoryState?: string; repositoryCapabilities?: string[];
      }>(['workspace', 'current', '--json']);
      if (!current.active || !current.workspacePath) return false;
      if (!await selectionIsCurrent()) return true;
      const status = await registry.run<{
        repositories: Array<{ id: string; required?: boolean; state: string; capabilities?: string[] }>;
      }>(['workspace', 'status', current.workspacePath, '--level', 'readiness', '--json']);
      const previous = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
      const selectedCapability = previous?.workspaceId === current.workspaceId
        ? previous?.capabilityId : null;
      const pending = deferredWorkspaceRepositories(status.repositories, current, selectedCapability);
      if (!await selectionIsCurrent()) return true;
      if (!pending.length) return false;
      if (pending.some((entry) => !['missing', 'empty'].includes(entry.state))) {
        void showCompactWarningMessage(
          'The selected workspace has a repository that needs review before work can start. Open Workspace details to inspect it.');
        if (reloadWhenBlocked) await reloadAfterBlockedPreparation();
        return true;
      }
      const args = [
        'workspace', 'repair', current.workspacePath,
        ...pending.flatMap((entry) => ['--repository', entry.id]),
        '--level', 'readiness', '--json'
      ];
      const materialized = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Preparing ${pending.length} ${pending.length === 1 ? 'repository' : 'repositories'} for work…`
      }, () => registry.run<{ status: { repositories: Array<{ id: string; state: string }> } }>(args));
      if (pending.some((entry) => materialized.status.repositories
        .find((observed) => observed.id === entry.id)?.state !== 'ready')) {
        throw new Error('A required workspace repository is still unavailable. Open Workspace details for its repair status.');
      }
      if (!await selectionIsCurrent()) {
        void showCompactInformationMessage('Workspace selection changed while its repository was being prepared. The prepared checkout was kept; start work again in your selected workspace.');
        return true;
      }
      const selected = await registry.run<{
        workspaceName: string; workspacePath: string; repositoryPath: string; repositoryState: string;
      }>(['workspace', 'current', '--json']);
      if (!await selectionIsCurrent()) return true;
      await context.globalState.update(START_WIZARD_KEY, startWizardState('work', {
        capabilityId: previous?.capabilityId ?? null,
        organisation: previous?.organisation ?? null,
        workspaceId: current.workspaceId ?? null,
        workspaceName: current.workspaceName ?? null,
        workspacePath: current.workspacePath,
        resumeOnActivation: true
      }));
      await openSelectedWorkspaceFolder(selected, true, selectionIsCurrent);
      return true;
    } catch (error) {
      if (!await selectionIsCurrent()) return true;
      showRefusal(error, { headline: 'Could not prepare the workspace for work' });
      if (reloadWhenBlocked) await reloadAfterBlockedPreparation();
      return true;
    }
  };
  for (const id of REPOSITORY_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
      if (id === 'singularityFlow.startWork' && await prepareDeferredWorkspaceForWork()) return;
      const handler = handlers.get(id);
      if (handler) return handler(...args);
      // Capability/setup reviews are machine-wide and must remain reachable before a workspace
      // exists. Phase decisions still require the repository-bound Reviews screen above.
      if (id === 'singularityFlow.openReviews') {
        return vscode.commands.executeCommand('singularityFlow.reviewCapabilityProposals');
      }
      void showCompactWarningMessage(
        `Singularity Flow: ${unavailableReason}`,
        'Map a capability', 'Find a workspace'
      ).then((chosen) => {
        if (chosen === 'Map a capability') return vscode.commands.executeCommand('singularityFlow.mapCapability');
        if (chosen === 'Find a workspace') return vscode.commands.executeCommand('singularityFlow.openWorkspaces');
        return undefined;
      });
      return undefined;
    }));
  }

  const unavailable = (
    label: string, detail: string, contextValue?: string, leadRepository?: string | null
  ): void => {
    output.appendLine(`${label} — ${detail}`);
    // The same sentence the view is showing, so a command and the tree never disagree about why
    // there is nothing to act on.
    unavailableReason = detail;
    drawWorkspaces();
    const repositoryUnavailable = contextValue === 'sflow.workspace.repositoryUnavailable';
    const recoveryCommand = repositoryUnavailable
      ? 'singularityFlow.repairWorkspace' : 'singularityFlow.openWorkspaces';
    const recoveryDescription = repositoryUnavailable
      ? 'repair selected workspace' : 'select a saved workspace';
    const provider = new LifecycleTreeProvider(null,
      unavailableTree(label, detail, contextValue, leadRepository));
    const inbox = new LifecycleTreeProvider(null, [{
      kind: 'action', id: 'inbox:unavailable',
      label: repositoryUnavailable ? label : 'Select a workspace',
      description: repositoryUnavailable ? recoveryDescription : 'reviews and generated artifacts',
      tooltip: detail,
      icon: repositoryUnavailable ? 'statusWarning' : 'approval', runCommand: recoveryCommand
    }]);
    const configuration = new LifecycleTreeProvider(null, repositoryUnavailable ? [{
      kind: 'action', id: 'configuration:unavailable', label,
      description: recoveryDescription, tooltip: detail,
      icon: 'warning', runCommand: recoveryCommand
    }] : [{
      kind: 'action', id: 'configuration:create-capability',
      label: 'Create first capability', description: 'start organisation setup',
      tooltip: 'Describe what the organisation builds and which repository ships it. No workspace is required.',
      icon: 'capability', runCommand: 'singularityFlow.mapCapability'
    }, {
      kind: 'action', id: 'configuration:choose-workspace',
      label: 'Choose a workspace', description: 'load its configuration',
      tooltip: detail, icon: 'workspace', runCommand: recoveryCommand
    }, {
      kind: 'action', id: 'configuration:review-proposals',
      label: 'Review proposals', description: 'inspect pending setup and capability changes',
      tooltip: 'List pending setup and capability proposals across registered and locally reviewed repositories.',
      icon: 'merge', runCommand: 'singularityFlow.reviewCapabilityProposals'
    }, {
      kind: 'action', id: 'configuration:onboard-team',
      label: 'Onboard a team', description: 'select repositories and propose them together',
      tooltip: 'Discover repositories, inspect only explicit selections, and create one reviewed team proposal.',
      icon: 'team', runCommand: 'singularityFlow.onboardTeam'
    }]);
    logsTree.replace([{
      kind: 'action', id: 'logs:unavailable', label: 'Choose a workspace',
      description: 'load its machine-local logs', tooltip: detail,
      icon: repositoryUnavailable ? 'statusWarning' : 'workspace', runCommand: recoveryCommand
    }]);
    context.subscriptions.push(provider, inbox, configuration);
    sidebar.bind('lifecycle', provider);
    sidebar.bind('inbox', inbox);
    sidebar.bind('configuration', configuration);
  };

  const startWizardState = (
    step: PendingStartWizard['step'],
    details: Partial<Omit<PendingStartWizard, 'schemaVersion' | 'step' | 'startedAt'>> = {}
  ): PendingStartWizard => ({
    schemaVersion: 1,
    step,
    startedAt: new Date().toISOString(),
    ...details
  });

  /**
   * One front door for a first governed work item.
   *
   * Existing organisations and active workspaces are respected rather than duplicated: a person
   * who already completed a step advances to the next one. The only persisted value is an ephemeral
   * continuation marker for the window reload required after the first workspace selection; all
   * capability, workspace, repository and lifecycle authority remains in the CLI's durable records.
   */
  /**
   * Back and Exit in the guided start's progress rail. Back goes one step and keeps what the step
   * already made (a mapped capability, a created workspace); Exit forgets the journey. Either closes
   * the screen the person was on.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.guidedStartBack', async () => {
    const prior = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
    if (!prior || prior.step === 'capability') return;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    if (prior.step === 'work') {
      const back = startWizardState('workspace', { capabilityId: prior.capabilityId ?? null, organisation: prior.organisation ?? null });
      await context.globalState.update(START_WIZARD_KEY, back);
      await vscode.commands.executeCommand('singularityFlow.createWorkspace', {
        guidedStart: true, capabilityId: back.capabilityId, organisation: back.organisation
      });
      return;
    }
    // From the workspace step: the guided start opens Map capability when the journey says so.
    await context.globalState.update(START_WIZARD_KEY, startWizardState('capability'));
    await vscode.commands.executeCommand('singularityFlow.startWizard');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.guidedStartExit', async () => {
    await context.globalState.update(START_WIZARD_KEY, undefined);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    void showCompactInformationMessage('Guided start closed. Nothing it had not finished was created; start it again from the Navigator.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.startWizard', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error, { headline: 'Guided start is unavailable' });
    }
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), environment: cliEnvironment,
      onOutput: (text) => output.append(text)
    });
    const prior = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
    type CurrentWorkspace = {
      active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string; repositoryPath?: string;
      repositoryState?: string;
    };
    let current: CurrentWorkspace;
    try {
      current = await registry.run<CurrentWorkspace>(['workspace', 'current', '--json']);
    } catch (error) {
      return showRefusal(error, { headline: 'Could not read the active workspace' });
    }
    if (current.active && current.workspacePath && current.repositoryPath
        && (!current.repositoryState || current.repositoryState === 'ready')) {
      const pending = startWizardState('work', {
        capabilityId: prior?.capabilityId ?? null,
        organisation: prior?.organisation ?? null,
        workspaceId: current.workspaceId ?? null,
        workspaceName: current.workspaceName ?? null,
        workspacePath: current.workspacePath,
        resumeOnActivation: false
      });
      await context.globalState.update(START_WIZARD_KEY, pending);
      return vscode.commands.executeCommand('singularityFlow.startWork', {
        guidedStart: true,
        workspaceName: pending.workspaceName
      });
    }
    if (current.active) {
      return showRefusal(
        'The active workspace does not resolve to a ready repository. Repair or reselect it before starting governed work.',
        { headline: 'Active workspace needs attention' }
      );
    }

    let leads: Array<{ url?: string }>;
    try {
      leads = await registry.run<Array<{ url?: string }>>(['capability', 'leads', '--json']);
    } catch (error) {
      return showRefusal(error, { headline: 'Could not read mapped capabilities' });
    }
    if (leads.some((lead) => lead.url) && prior?.step !== 'capability') {
      const pending = startWizardState('workspace', {
        capabilityId: prior?.step === 'workspace' ? prior.capabilityId ?? null : null,
        organisation: prior?.step === 'workspace' ? prior.organisation ?? null : null
      });
      await context.globalState.update(START_WIZARD_KEY, pending);
      return vscode.commands.executeCommand('singularityFlow.createWorkspace', {
        guidedStart: true,
        capabilityId: pending.capabilityId,
        organisation: pending.organisation
      });
    }

    const pending = startWizardState('capability');
    await context.globalState.update(START_WIZARD_KEY, pending);
    return vscode.commands.executeCommand(
      'singularityFlow.mapCapability',
      { journey: { step: 'capability' } },
      async (mapped: Mapped) => {
        const next = startWizardState('workspace', {
          capabilityId: mapped.capabilityId,
          organisation: mapped.lead
        });
        await context.globalState.update(START_WIZARD_KEY, next);
        await vscode.commands.executeCommand('singularityFlow.createWorkspace', {
          guidedStart: true,
          capabilityId: mapped.capabilityId,
          organisation: mapped.lead
        });
      }
    );
  }));

  /**
   * Register a workspace without downloading application source. Guided Start Work later
   * materializes the selected repositories and initializes their governed state as needed.
   *
   * Registered before any early return: this is the command for when there is no repository to
   * serve yet, which is precisely when activation stops early.
   */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.createWorkspace', async (request?: {
    guidedStart?: boolean;
    capabilityId?: string | null;
    organisation?: string | null;
  }) => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error);
    }

    const { WorkspacePanel } = lazyPanels();
    const guidedStart = request?.guidedStart === true;
    const journey = guidedStart ? {
      step: 'workspace' as const,
      capabilityId: request?.capabilityId ?? null
    } : null;
    const workspacePanel = WorkspacePanel.show(context, location, output, async (created) => {
      // Registration is intentionally checkout-free. Start Work performs the explicit repair before
      // any intake reads source or workflow configuration from the selected repositories.
      void showCompactInformationMessage(`Workspace registered. Now working in ${created.name}.`);
      // Guided Start can prepare the selected checkout with the early-registered command before
      // reloading. Otherwise selection would reload once for the planned path and again after
      // repair, even though the intermediate activation has no useful work to show.
      if (guidedStart) {
        await context.globalState.update(START_WIZARD_KEY, startWizardState('work', {
          capabilityId: request?.capabilityId ?? null,
          organisation: request?.organisation ?? null,
          workspaceId: created.id,
          workspaceName: created.name,
          workspacePath: created.directory,
          resumeOnActivation: true
        }));
      }
      const selected = await selectWorkspace(
        created.directory, created.leadDirectory, created.name, undefined, true, guidedStart
      );
      if (!selected && guidedStart) {
        await context.globalState.update(START_WIZARD_KEY, startWizardState('workspace', {
          capabilityId: request?.capabilityId ?? null,
          organisation: request?.organisation ?? null
        }));
      } else if (selected && guidedStart) {
        const handled = await prepareDeferredWorkspaceForWork(true);
        if (!handled) await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }, async (options?: { chooseRepository?: boolean }) => {
      // Keep the workspace draft open. Capability setup creates a review proposal; the proposal
      // review panel activates it on the protected configuration branch and then reloads this draft.
      await vscode.commands.executeCommand(
        'singularityFlow.mapCapability',
        { journey: guidedStart ? {
          step: 'capability' as const,
          capabilityId: request?.capabilityId ?? null
        } : null, chooseRepository: options?.chooseRepository === true },
        async (mapped: Mapped) => {
          if (guidedStart) {
            await context.globalState.update(START_WIZARD_KEY, startWizardState('workspace', {
              capabilityId: mapped.capabilityId,
              organisation: mapped.lead
            }));
          }
          await workspacePanel.refreshCapabilityMap({
            capabilityId: guidedStart ? mapped.capabilityId : null,
            organisation: mapped.lead
          }, { reveal: guidedStart });
        }
      );
    }, {
      journey,
      capabilityId: request?.capabilityId ?? null,
      organisation: request?.organisation ?? null
    });
  }));

  /** Wrap an existing clone in a workspace shell without mutating any Git or working-tree state. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.adoptWorkspace', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error);
    }
    const cloneChoice = await vscode.window.showOpenDialog({
      title: 'Choose an existing Git clone', canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, openLabel: 'Inspect clone'
    });
    if (!cloneChoice?.[0]) return;
    const cloneDirectory = cloneChoice[0].fsPath;
    const suggestedId = path.basename(cloneDirectory).normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
    const id = await vscode.window.showInputBox({
      title: 'Workspace identity', prompt: 'Choose a machine-local workspace ID.',
      value: suggestedId, ignoreFocusOut: true,
      validateInput: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.trim())
        ? null : 'Use a portable identifier containing letters, numbers, dots, underscores, or hyphens.'
    });
    if (!id) return;
    const name = await vscode.window.showInputBox({
      title: 'Workspace name', prompt: 'Name this workspace.', value: id, ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'A workspace name is required.'
    });
    if (!name) return;
    const baseChoice = await vscode.window.showOpenDialog({
      title: 'Choose where the workspace shell will live', canSelectFiles: false, canSelectFolders: true,
      canSelectMany: false, openLabel: 'Use this parent folder', defaultUri: vscode.Uri.file(os.homedir())
    });
    if (!baseChoice?.[0]) return;
    const client = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    try {
      const baseArgs = ['workspace', 'adopt', cloneDirectory, '--id', id.trim(), '--name', name.trim(),
        '--base', baseChoice[0].fsPath];
      const preview = await client.run<any>([...baseArgs, '--dry-run', '--json']);
      const repository = preview.plan?.repository;
      const dirtyHash = preview.plan?.dirtyConfirmationRequired as string | null;
      const changed = (repository?.adoption?.changedPaths ?? []) as string[];
      const preservation = `Existing clone: ${cloneDirectory}\nWorkspace shell: ${preview.plan?.workspace?.path}\n\n`
        + 'Singularity Flow will not fetch, checkout, stash, commit, reset, clean, or edit remotes.';
      if (dirtyHash) {
        const accepted = await showCompactWarningMessage(
          'This clone has local changes. Keep and adopt them?',
          { modal: true, detail: `${preservation}\n\nChanged paths:\n${changed.slice(0, 20).join('\n') || '(Git reports local changes)'}` },
          'Keep local changes'
        );
        if (accepted !== 'Keep local changes') return;
      }
      const confirmation = await vscode.window.showInputBox({
        title: `Use ${path.basename(cloneDirectory)} as workspace ${id.trim()}`,
        prompt: `${preservation}\nType ${id.trim()} to create only the workspace shell.`,
        placeHolder: id.trim(), ignoreFocusOut: true,
        validateInput: (value) => value === id.trim() ? null : `Type exactly ${id.trim()}.`
      });
      if (confirmation !== id.trim()) return;
      const result = await client.run<any>([
        ...baseArgs, ...(dirtyHash ? ['--confirm-dirty', dirtyHash] : []),
        '--confirm', confirmation, '--json'
      ]);
      const lead = result.status?.leadRepositoryPath ?? cloneDirectory;
      void showCompactInformationMessage(`${name.trim()} now uses the existing clone. No Git state was changed.`);
      await selectWorkspace(result.workspace.path, lead, name.trim());
    } catch (error) {
      showRefusal(error, { headline: 'Could not use the existing clone' });
    }
  }));

  /**
   * FOS commands are registered before repository activation succeeds because their purpose is to
   * attach an ordinary existing checkout. The CLI owns every mutation, validation, receipt and
   * recovery boundary; this host only gathers an explicit repository/route and renders the result.
   */
  const fosClient = (repository: string): SingularityFlowClient => {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    return new SingularityFlowClient({
      location: resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      }),
      repository,
      environment: cliEnvironment,
      onOutput: (text) => output.append(text)
    });
  };
  const chooseFosRepository = async (title: string): Promise<string | null> => {
    const selected = await vscode.window.showOpenDialog({
      title,
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this Git checkout',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    return selected?.[0]?.fsPath ?? null;
  };
  const resolveFosRepository = async (requested: unknown, title: string): Promise<string | null> => {
    if (typeof requested === 'string' && requested.trim()) return path.resolve(requested.trim());
    return chooseFosRepository(title);
  };
  const fosPayload = <T,>(value: any): T => (value?.data?.result ?? value) as T;
  const fosOutcome = (
    action: WorkspaceFosAction,
    status: WorkspaceFosOutcome['status'],
    headline: string,
    summary: string,
    repositoryPath: string | null,
    details: Array<string | null | undefined> = []
  ): WorkspaceFosOutcome => ({
    action, status, headline, summary, repositoryPath, recordedAt: new Date().toISOString(),
    details: details.filter((detail): detail is string => Boolean(detail))
  });
  const fosFailure = (
    action: WorkspaceFosAction,
    headline: string,
    error: unknown,
    repositoryPath: string | null
  ): WorkspaceFosOutcome => fosOutcome(
    action, 'attention', headline,
    String((error as { message?: string })?.message ?? error), repositoryPath
  );

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.fastOnboardRepository', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the existing repository to attach');
      if (!repository) return;
      try {
        const remotes = await configuredGitRemotes(repository);
        let routeArgs: string[] = [];
        let routeLabel = 'the repository’s only configured remote';
        if (remotes.length > 1) {
          const remote = await vscode.window.showQuickPick(remotes.map((name) => ({
            label: name, description: 'Read the reviewed configuration authority from this remote'
          })), {
            title: 'Choose the configuration authority remote',
            placeHolder: 'No remote is assumed to be authoritative',
            ignoreFocusOut: true
          });
          if (!remote) return;
          routeArgs = ['--remote', remote.label];
          routeLabel = `remote ${remote.label}`;
        } else if (remotes.length === 1) {
          routeArgs = ['--remote', remotes[0]!];
          routeLabel = `remote ${remotes[0]}`;
        } else {
          const local = await showCompactWarningMessage(
            'This checkout has no Git remote. Use an already reviewed local configuration authority?',
            {
              modal: true,
              detail: 'Singularity Flow will validate a local sflow/config or state authority. It will not create or weaken policy.'
            },
            'Use reviewed local authority'
          );
          if (local !== 'Use reviewed local authority') return;
          routeArgs = ['--authority-local'];
          routeLabel = 'the reviewed local authority';
        }
        const confirmed = await showCompactInformationMessage(
          'Attach this repository to Singularity Flow?',
          {
            modal: true,
            detail: `Repository: ${repository}\nAuthority: ${routeLabel}\n\nNo clone, source scan, AST build, world-model build, model request, checkout, or application-branch commit will run.`
          },
          'Attach repository'
        );
        if (confirmed !== 'Attach repository') return;
        const envelope = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Verifying and attaching repository', cancellable: false },
          () => fosClient(repository).run<any>(['onboard', repository, ...routeArgs, '--json'])
        );
        const result = fosPayload<{ status: string; operationId: string; descriptor?: {
          authority?: { branch?: string; commit?: string }; descriptorSha256?: string;
        } }>(envelope);
        output.appendLine(`FOS attachment: ${result.status} · ${result.operationId}`);
        output.appendLine(`Authority: ${result.descriptor?.authority?.branch ?? 'unknown'}@${result.descriptor?.authority?.commit ?? 'unknown'}`);
        output.appendLine(`Pin: ${result.descriptor?.descriptorSha256 ?? 'unavailable'}`);
        output.show(true);
        void showCompactInformationMessage(
          result.status === 'already-attached'
            ? 'Repository is already attached to this exact reviewed authority.'
            : 'Repository attached. Story start can now reuse the verified authority pin.'
        );
        return fosOutcome(
          'attach', 'completed',
          result.status === 'already-attached' ? 'Repository already attached' : 'Repository attached',
          result.status === 'already-attached'
            ? 'The checkout already uses this exact reviewed configuration authority.'
            : 'The reviewed authority pin is ready for Story start reuse.',
          repository,
          [
            `Operation: ${result.operationId}`,
            result.descriptor?.authority?.branch && result.descriptor?.authority?.commit
              ? `Authority: ${result.descriptor.authority.branch}@${result.descriptor.authority.commit}` : null,
            result.descriptor?.descriptorSha256 ? `Pin: ${result.descriptor.descriptorSha256}` : null
          ]
        );
      } catch (error) {
        showRefusal(error, { headline: 'Fast repository onboarding did not complete' });
        return fosFailure('attach', 'Repository attachment needs attention', error, repository);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.refreshAuthorityPin', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the attached repository to refresh');
      if (!repository) return;
      const confirmed = await showCompactInformationMessage(
        'Refresh this repository’s reviewed authority pin?',
        {
          modal: true,
          detail: `Repository: ${repository}\n\nOnly the previously selected authority route is observed. Source, AST, world model, and application branches are not changed.`
        },
        'Refresh authority pin'
      );
      if (confirmed !== 'Refresh authority pin') return;
      try {
        const envelope = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Refreshing reviewed authority pin', cancellable: false },
          () => fosClient(repository).run<any>(['authority', 'refresh', repository, '--json'])
        );
        const result = fosPayload<{ status: string; operationId: string }>(envelope);
        output.appendLine(`FOS authority refresh: ${result.status} · ${result.operationId}`);
        output.show(true);
        void showCompactInformationMessage(`Authority pin ${result.status}.`);
        return fosOutcome(
          'refresh-authority', 'completed', 'Authority pin refreshed',
          `The previously selected authority route reported ${result.status}.`, repository,
          [`Operation: ${result.operationId}`]
        );
      } catch (error) {
        showRefusal(error, { headline: 'Authority refresh did not complete' });
        return fosFailure('refresh-authority', 'Authority refresh needs attention', error, repository);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.bootstrapLocalAuthority', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the unmanaged repository to initialize locally');
      if (!repository) return;
      const confirmed = await showCompactWarningMessage(
        'Create a local-only Singularity Flow authority?',
        {
          modal: true,
          detail: `Repository: ${repository}\nPolicy: unmanaged-local-v1\n\nThis creates sflow/config without changing the application branch. It does not claim organization membership, corporate approval, or authority over another repository.`
        },
        'Create local-only authority'
      );
      if (confirmed !== 'Create local-only authority') return;
      try {
        const envelope = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Creating local-only configuration authority', cancellable: false },
          () => fosClient(repository).run<any>([
            'onboard', repository, '--bootstrap', '--policy', 'unmanaged-local-v1',
            '--authority-local', '--json'
          ])
        );
        const result = fosPayload<{ status: string; bootstrap?: {
          operationId?: string; scope?: string; authorityCommit?: string;
        } }>(envelope);
        output.appendLine(`FOS local bootstrap: ${result.status} · ${result.bootstrap?.operationId ?? 'unknown operation'}`);
        output.appendLine(`Scope: ${result.bootstrap?.scope ?? 'local-only'} · authority ${result.bootstrap?.authorityCommit ?? 'unknown'}`);
        output.show(true);
        void showCompactInformationMessage('Local-only authority created and attached.');
        return fosOutcome(
          'local-authority', 'completed', 'Local-only authority created',
          'The unmanaged checkout now has a local authority; this does not claim organization approval.',
          repository,
          [
            result.bootstrap?.operationId ? `Operation: ${result.bootstrap.operationId}` : null,
            `Scope: ${result.bootstrap?.scope ?? 'local-only'}`,
            result.bootstrap?.authorityCommit ? `Authority commit: ${result.bootstrap.authorityCommit}` : null
          ]
        );
      } catch (error) {
        showRefusal(error, { headline: 'Local-only authority creation did not complete' });
        return fosFailure('local-authority', 'Local authority creation needs attention', error, repository);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.useOfflineAuthorityPin', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the attached repository to use offline');
      if (!repository) return;
      const confirmed = await showCompactInformationMessage(
        'Use this repository’s approved offline authority pin?',
        {
          modal: true,
          detail: `Repository: ${repository}\n\nNo remote will be contacted. Complete retained bytes and the pinned authority policy must permit this operation and remain unexpired.`
        },
        'Use approved offline pin'
      );
      if (confirmed !== 'Use approved offline pin') return;
      try {
        const envelope = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Validating retained offline authority', cancellable: false },
          () => fosClient(repository).run<any>(['onboard', repository, '--offline', '--json'])
        );
        const result = fosPayload<{ status: string; freshness?: {
          mode?: string; ageMilliseconds?: number; expiresAt?: string; policyId?: string;
        } }>(envelope);
        output.appendLine(`FOS offline authority: ${result.status} · ${result.freshness?.mode ?? 'unknown'}`);
        output.appendLine(`Policy: ${result.freshness?.policyId ?? 'unknown'} · age ${result.freshness?.ageMilliseconds ?? 'unknown'} ms · expires ${result.freshness?.expiresAt ?? 'unknown'}`);
        output.show(true);
        void showCompactInformationMessage('Approved pinned authority is available offline. It is not reported as current or latest.');
        return fosOutcome(
          'offline-authority', 'completed', 'Offline authority pin validated',
          'The retained authority is usable under its pinned policy without contacting the remote.',
          repository,
          [
            `Status: ${result.status}`,
            result.freshness?.policyId ? `Policy: ${result.freshness.policyId}` : null,
            result.freshness?.expiresAt ? `Expires: ${result.freshness.expiresAt}` : null
          ]
        );
      } catch (error) {
        showRefusal(error, { headline: 'Offline authority reuse was refused' });
        return fosFailure('offline-authority', 'Offline authority needs attention', error, repository);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.configureGitAcceleration', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the repository to inspect');
      if (!repository) return;
      try {
        const report = await fosClient(repository).run<any>(['doctor', '--git-speed', '--json']);
        const settings = report.settings ?? report.report?.settings ?? {};
        const choices = Object.entries(settings).map(([id, raw]) => {
          const value = raw as { key?: string; value?: string | null; compatible?: boolean };
          return {
            label: id,
            description: value.value == null ? 'unset' : `currently ${value.value}`,
            detail: value.compatible ? `${value.key} · repository-local` : `${value.key} · unsupported by this Git version`,
            picked: value.value?.toLowerCase() === 'true',
            compatible: value.compatible !== false
          };
        });
        const selected = await vscode.window.showQuickPick(choices.filter((item) => item.compatible), {
          title: `Safe Git acceleration · Git ${report.gitVersion ?? 'unknown'}`,
          placeHolder: 'Select repository-local accelerators to enable; existing custom values are preserved',
          canPickMany: true,
          ignoreFocusOut: true
        });
        if (selected === undefined || selected.length === 0) {
          output.appendLine(`Git speed inspection: ${repository}`);
          for (const item of choices) output.appendLine(`  ${item.label}: ${item.description} · ${item.detail}`);
          output.show(true);
          return fosOutcome(
            'git-acceleration', 'completed', 'Git acceleration inspected',
            'No repository-local setting was changed. The complete inspection is in the output channel.',
            repository, [`Git: ${report.gitVersion ?? 'unknown'}`]
          );
        }
        const enable = selected.filter((item) => !item.picked).map((item) => item.label);
        if (!enable.length) {
          void showCompactInformationMessage('The selected Git accelerators are already enabled.');
          return fosOutcome(
            'git-acceleration', 'completed', 'Git accelerators already enabled',
            'Every selected repository-local accelerator was already active.', repository,
            selected.map((item) => item.label)
          );
        }
        const confirmed = await showCompactInformationMessage(
          'Enable the selected repository-local Git accelerators?',
          {
            modal: true,
            detail: `${enable.join(', ')}\n\nSFlow verifies each write, records a receipt, preserves custom values, and rolls back its own changes if verification fails.`
          },
          'Enable selected'
        );
        if (confirmed !== 'Enable selected') return;
        const applied = await fosClient(repository).run<any>([
          'doctor', '--git-speed', '--apply', ...enable.flatMap((id) => ['--enable', id]), '--json'
        ]);
        output.appendLine(`Git acceleration receipt: ${applied.receipt?.receiptId ?? 'unavailable'}`);
        output.show(true);
        void showCompactInformationMessage('Selected Git accelerators were verified and enabled for this repository.');
        return fosOutcome(
          'git-acceleration', 'completed', 'Git acceleration updated',
          'The selected repository-local settings were written and verified.', repository,
          [
            `Enabled: ${enable.join(', ')}`,
            applied.receipt?.receiptId ? `Receipt: ${applied.receipt.receiptId}` : null
          ]
        );
      } catch (error) {
        showRefusal(error, { headline: 'Git acceleration could not be inspected or changed' });
        return fosFailure('git-acceleration', 'Git acceleration needs attention', error, repository);
      }
    }
  ));

  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.clearDerivedCache', async (requestedRepository?: string) => {
      const repository = await resolveFosRepository(requestedRepository, 'Choose the repository whose disposable cache should be cleared');
      if (!repository) return;
      const confirmed = await showCompactWarningMessage(
        'Clear only the disposable FOS derived cache?',
        {
          modal: true,
          detail: `Repository: ${repository}\n\nAuthority pins, receipts, journals, evidence, Story state, and recovery checkpoints are outside this cache and will be preserved.`
        },
        'Clear derived cache'
      );
      if (confirmed !== 'Clear derived cache') return;
      try {
        const envelope = await fosClient(repository).run<any>([
          'cache', 'clear', '--derived', '--repo', repository, '--json'
        ]);
        const result = fosPayload<{ removedEntries: number }>(envelope);
        void showCompactInformationMessage(`Cleared ${result.removedEntries} disposable cache entr${result.removedEntries === 1 ? 'y' : 'ies'}.`);
        return fosOutcome(
          'clear-cache', 'completed', 'Derived cache cleared',
          `Removed ${result.removedEntries} disposable cache ${result.removedEntries === 1 ? 'entry' : 'entries'}.`,
          repository, ['Authority pins, receipts, Story state, and recovery checkpoints were preserved.']
        );
      } catch (error) {
        showRefusal(error, { headline: 'Derived cache was not cleared' });
        return fosFailure('clear-cache', 'Cache cleanup needs attention', error, repository);
      }
    }
  ));

  /** Read-only machine and bootstrap diagnostics, available even in an empty VS Code window. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.workspaceDoctor', async () => {
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const client = new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      });
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Diagnosing workspace setup' },
        () => client.run<any>(['workspace', 'doctor', '--json'])
      );
      output.appendLine(`\nWorkspace reliability: ${result.healthy ? 'healthy' : 'needs attention'}`);
      for (const finding of result.machine?.findings ?? []) {
        output.appendLine(`  ${finding.severity}: ${finding.message}`);
      }
      for (const session of result.sessions ?? []) {
        output.appendLine(`  ${session.bootstrapId}: ${session.status} · ${session.workspaceName ?? session.workspaceId ?? ''}`);
        const recovery = commandGuidanceText(session.nextAction);
        if (recovery) output.appendLine(`    Recover:\n${recovery}`);
      }
      output.show(true);
      void showCompactInformationMessage(result.healthy
        ? 'Workspace setup checks passed. Details are in Singularity Flow output.'
        : 'Workspace setup needs attention. Review the Singularity Flow output.');
      const findings = (result.machine?.findings ?? []).slice(0, 8).map((finding: any) =>
        `${finding.severity}: ${finding.message}`);
      const sessions = (result.sessions ?? []).slice(0, 8).map((session: any) =>
        `${session.bootstrapId}: ${session.status}${commandGuidanceText(session.nextAction)
          ? ` · Recover:\n${commandGuidanceText(session.nextAction)}` : ''}`);
      return fosOutcome(
        'doctor', result.healthy ? 'completed' : 'attention',
        result.healthy ? 'Workspace checks passed' : 'Workspace setup needs attention',
        result.healthy
          ? 'No workspace setup blocker was reported.'
          : 'Review the findings and exact recovery commands below.',
        null, [...findings, ...sessions]
      );
    } catch (error) {
      showRefusal(error, { headline: 'Workspace diagnostics could not run' });
      return fosFailure('doctor', 'Workspace diagnosis needs attention', error, null);
    }
  }));

  /** Resume the latest preserved bootstrap through the same exact-confirm CLI boundary. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resumeWorkspaceBootstrap', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      showRefusal(error);
      return fosFailure('resume-bootstrap', 'Workspace setup recovery is unavailable', error, null);
    }
    const client = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    try {
      const sessions = await client.run<any[]>(['workspace', 'bootstrap', 'status', '--json']);
      if (!sessions.length) {
        showRefusal('No resumable workspace setup was found. Start a new workspace setup instead.', {
          headline: 'No setup to continue'
        });
        return fosOutcome(
          'resume-bootstrap', 'attention', 'No setup to continue',
          'No preserved workspace setup checkpoint was found. Start a new workspace setup instead.',
          null
        );
      }
      const choices = sessions.map((entry) => ({
        label: entry.plan?.workspace?.name ?? entry.request?.workspaceName ?? entry.bootstrapId,
        description: entry.status,
        detail: entry.plan?.workspace?.targetPath ?? commandGuidanceText(entry.nextAction) ?? '',
        entry
      }));
      const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
        title: 'Continue workspace setup',
        placeHolder: 'Choose the preserved setup to recheck and resume',
        ignoreFocusOut: true
      });
      if (!selected) return;
      const expected = selected.entry.plan?.workspace?.confirmation;
      if (!expected) {
        showRefusal('The preserved setup has no valid confirmation identity. Run workspace doctor before retrying.', {
          headline: 'Setup record needs repair'
        });
        return fosOutcome(
          'resume-bootstrap', 'attention', 'Setup record needs repair',
          'The preserved setup has no valid confirmation identity. Run workspace doctor before retrying.',
          null
        );
      }
      const confirmation = await vscode.window.showInputBox({
        title: `Resume ${selected.label}`,
        prompt: `Type ${expected} to recheck remote access and materialize only the reviewed workspace plan.`,
        placeHolder: expected,
        ignoreFocusOut: true,
        validateInput: (value) => value === expected ? null : `Type exactly ${expected}.`
      });
      if (confirmation !== expected) return;
      const result = await client.run<any>([
        'workspace', 'bootstrap', 'resume', selected.entry.bootstrapId,
        '--confirm', confirmation, '--json'
      ]);
      if (result.status === 'ready') {
        void showCompactInformationMessage(`${selected.label} is ready.`);
        await vscode.commands.executeCommand('singularityFlow.openWorkspaces');
        return fosOutcome(
          'resume-bootstrap', 'completed', 'Workspace setup completed',
          `${selected.label} is ready.`, null,
          [selected.entry.bootstrapId ? `Bootstrap: ${selected.entry.bootstrapId}` : null]
        );
      } else {
        const blockers = (result.preflight?.findings ?? [])
          .filter((finding: any) => finding.severity === 'blocker')
          .map((finding: any) => `${finding.message}${finding.action && commandGuidanceText(finding.action)
            ? `\nRecovery:\n${commandGuidanceText(finding.action)}` : ''}`);
        const actions = (result.recoveryActions ?? [])
          .map((action: any) => ({ action, guidance: commandGuidanceText(action) }))
          .filter((entry: any) => entry.guidance)
          .map((entry: any) => `${entry.action.label ?? entry.action.id}:\n${entry.guidance}`);
        const detail = [
          result.fault?.message,
          ...blockers,
          actions.length ? `Available recovery paths:\n${actions.join('\n')}` : null,
          'The bootstrap ID, reviewed plan, and any owned partial workspace were preserved.'
        ].filter(Boolean).join('\n\n');
        showRefusal(detail || 'Workspace setup still needs attention. No reviewed plan was widened.', {
          headline: `Setup is ${result.status}`
        });
        return fosOutcome(
          'resume-bootstrap', 'attention', `Setup is ${result.status}`,
          result.fault?.message ?? 'Workspace setup still needs attention. No reviewed plan was widened.',
          null, [...blockers, ...actions]
        );
      }
    } catch (error) {
      showRefusal(error, { headline: 'Could not resume workspace setup' });
      return fosFailure('resume-bootstrap', 'Workspace setup recovery needs attention', error, null);
    }
  }));

  /**
   * Onboard one team and its explicitly selected repositories as one reviewed capability change.
   *
   * Registered before repository activation can stop: repository discovery and organisation
   * authority are machine/global concerns, so this journey must also work from an empty window.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.onboardTeam',
    async () => {
      let location;
      try {
        location = resolveCli({ extensionPath: context.extensionPath });
      } catch (error) {
        return showRefusal(error, { headline: 'Team onboarding is unavailable' });
      }
      const initiatingRepository = await capabilityActionInitiatingRoot();
      const client = new SingularityFlowClient({
        location,
        repository: initiatingRepository,
        environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const run = async (
        argv: string[], signal?: AbortSignal
      ): Promise<{ result: unknown; error: string | null }> => {
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(argv)}`);
        try {
          return { result: await client.run<unknown>(argv, signal), error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`  failed: ${message}`);
          return { result: null, error: message };
        }
      };
      const { TeamOnboardingPanel } = lazyPanels();
      TeamOnboardingPanel.show(
        context,
        run,
        (lead, branch, onActivated) => {
          const { CapabilityProposalPanel } = lazyPanels();
          CapabilityProposalPanel.show(context, lead, branch, run, async () => onActivated());
        },
        async (teamId, lead) => {
          await vscode.commands.executeCommand('singularityFlow.createWorkspace', {
            capabilityId: teamId,
            organisation: lead
          });
        }
      );
    }
  ));

  /**
   * Govern a repository that has never heard of Singularity Flow.
   *
   * Registered before any early return, and it has to be: this is the command that produces the
   * thing every other command needs, so requiring one would be the whole chicken-and-egg problem
   * written into the extension.
   */
  let refreshStoriesAfterMapping: (() => Promise<void>) | null = null;
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.mapCapability',
    async (
      requestOrReturn?: {
        parent?: string;
        chooseRepository?: boolean;
        repositoryUrl?: string;
        maintenance?: boolean;
        journey?: { step: 'capability' | 'workspace' | 'work'; capabilityId?: string | null; workspaceName?: string | null } | null;
      } | ((mapped: Mapped) => Promise<void>),
      returnAfterMapping?: (mapped: Mapped) => Promise<void>
    ) => {
    const initial = typeof requestOrReturn === 'object' && requestOrReturn
      ? {
          parent: requestOrReturn.parent,
          journey: requestOrReturn.journey,
          chooseRepository: requestOrReturn.chooseRepository === true,
          repositoryUrl: requestOrReturn.repositoryUrl,
          maintenance: requestOrReturn.maintenance === true
        }
      : {};
    const returnToWorkspace = typeof requestOrReturn === 'function'
      ? requestOrReturn
      : returnAfterMapping;
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error);
    }
    // Capability authority is global, but commit presentation belongs to the person initiating the
    // action. Use the repository this window is actually acting on (including a workspace shell's
    // selected repository), rather than the extension host's unrelated process cwd. Repository-free
    // first-time setup still has the process cwd as its compatibility fallback.
    const initiatingRepository = await capabilityActionInitiatingRoot();
    const registry = new SingularityFlowClient({
      location, repository: initiatingRepository, onOutput: (text) => output.append(text)
    });
    const run = async (argv: string[], signal?: AbortSignal): Promise<{
      result: unknown; error: string | null; errorCode?: string | null;
    }> => {
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(argv)}`);
      try {
        return { result: await registry.run<unknown>(argv, signal), error: null };
      } catch (error) {
        output.appendLine(`  failed: ${(error as Error).message}`);
        return {
          result: null,
          error: (error as Error).message,
          errorCode: repositoryOnboardingFailureCode(error)
        };
      }
    };

    // Repository maintenance is intentionally registry-free: the URL/path is sufficient for the
    // onboarding preview, including on a clean laptop with no registered workspaces or leads.
    const leads = initial.maintenance ? [] : await registry
      .run<Array<{ url: string }>>(['capability', 'leads', '--json'])
      .catch(() => []);

    const { BootstrapPanel } = lazyPanels();
    BootstrapPanel.show(context, leads.map((lead) => lead.url), run, async (mapped: Mapped) => {
      if (!mapped.reviewRequired || !mapped.branch) {
        void showCompactInformationMessage(`${mapped.capabilityId} is already active on ${mapped.baseBranch}.`);
        if (typeof returnToWorkspace === 'function') await returnToWorkspace(mapped);
        else {
          const { WorkspacePanel } = lazyPanels();
          await WorkspacePanel.refreshOpenCapabilityMap({
            organisation: mapped.lead
          });
        }
        if (refreshStoriesAfterMapping) void refreshStoriesAfterMapping().catch((error) => {
          if (isCliReadSuperseded(error)) return;
          output.appendLine(`Story discovery after capability mapping needs attention: ${(error as Error).message}`);
        });
        return;
      }
      const { CapabilityProposalPanel } = lazyPanels();
      CapabilityProposalPanel.show(context, mapped.lead, mapped.branch, run, async () => {
        // A retained workspace form contains the user's unsaved directory and identity choices.
        // Refresh that form only after activation, when the capability is genuinely selectable.
        if (typeof returnToWorkspace === 'function') await returnToWorkspace(mapped);
        else {
          const { WorkspacePanel } = lazyPanels();
          await WorkspacePanel.refreshOpenCapabilityMap({
            organisation: mapped.lead
          });
        }
        if (refreshStoriesAfterMapping) void refreshStoriesAfterMapping().catch((error) => {
          if (isCliReadSuperseded(error)) return;
          output.appendLine(`Story discovery after capability activation needs attention: ${(error as Error).message}`);
        });
      }, mapped.capabilityId);
    }, initial);
  }));

  /** Reopen pending setup and capability proposals without finding their branches in a terminal. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.reviewCapabilityProposals',
    async () => {
      let location;
      try {
        location = resolveCli({ extensionPath: context.extensionPath });
      } catch (error) {
        return showRefusal(error);
      }
      const initiatingRepository = await capabilityActionInitiatingRoot();
      const registry = new SingularityFlowClient({
        location, repository: initiatingRepository, onOutput: (text) => output.append(text)
      });
      const run = async (argv: string[]): Promise<{ result: unknown; error: string | null }> => {
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(argv)}`);
        try { return { result: await registry.run<unknown>(argv), error: null }; }
        catch (error) { return { result: null, error: (error as Error).message }; }
      };
      const { CapabilityProposalsPanel } = lazyPanels();
      CapabilityProposalsPanel.show(context, run, (lead, branch) => {
        void Promise.resolve(lazyPanels()).then(({ CapabilityProposalPanel }) => {
          CapabilityProposalPanel.show(context, lead, branch, run, async () => {
            const { WorkspacePanel } = lazyPanels();
            await WorkspacePanel.refreshOpenCapabilityMap({ organisation: lead });
            if (refreshStoriesAfterMapping) void refreshStoriesAfterMapping().catch((error) => {
              if (isCliReadSuperseded(error)) return;
              output.appendLine(`Story discovery after capability activation needs attention: ${(error as Error).message}`);
            });
          });
        });
      });
    }
  ));

  /**
   * The workspaces on this machine, and the three things you can do to one.
   *
   * Registered before any early return, like creating one: a person with no repository open is
   * exactly the person who needs to find the workspace they already have.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.openWorkspaces', async (
      request?: TreeNode | {
        upgrade?: boolean;
        upgradeScope?: 'selected' | 'all';
        /** Exact registered workspace selected by the Git-URL maintenance menu. */
        workspacePath?: string;
        /** Exact repository selected by that menu; narrows preview and apply together. */
        repositoryId?: string;
        capabilityIds?: readonly string[];
        authority?: {
          leadUrl?: string;
          configurationBranch?: string;
          configurationCommit?: string;
          /** Compatibility with handoffs emitted before authority/projection identities split. */
          sourceBranch?: string;
          sourceCommit?: string;
        };
        /**
         * Fresh repository-setup evidence produced by the Map journey. It may suppress only the
         * redundant, read-only organisation refresh below. The workspace capability preview still
         * performs the mutation-bound authority/ref check before anything is attached.
         */
        repositorySetup?: { plan?: unknown; result?: unknown };
      }
    ) => {
    const requestGeneration = ++openWorkspacesRequestGeneration;
    openWorkspacesReadController?.abort();
    const readController = new AbortController();
    openWorkspacesReadController = readController;
    const readWithProgress = async <T>(title: string, read: () => Promise<T>): Promise<T> =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          const cancelled = token.onCancellationRequested(() => readController.abort());
          if (token.isCancellationRequested) readController.abort();
          try { return await read(); } finally { cancelled.dispose(); }
        });
    const requestIsCurrent = (): boolean =>
      requestGeneration === openWorkspacesRequestGeneration && !readController.signal.aborted;
    const upgradeScope = request && typeof request === 'object'
      && 'upgradeScope' in request
      && (request.upgradeScope === 'selected' || request.upgradeScope === 'all')
      ? request.upgradeScope
      : request && typeof request === 'object' && 'upgrade' in request && request.upgrade
        ? 'all' : null;
    const upgrade = Boolean(upgradeScope);
    const requestedWorkspacePath = request && typeof request === 'object'
      && 'workspacePath' in request && typeof request.workspacePath === 'string'
      ? request.workspacePath.trim() : '';
    const repositoryIdSupplied = Boolean(request && typeof request === 'object'
      && 'repositoryId' in request);
    const requestedRepositoryId = request && typeof request === 'object'
      && 'repositoryId' in request && typeof request.repositoryId === 'string'
      && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.repositoryId.trim())
      ? request.repositoryId.trim() : null;
    if (repositoryIdSupplied && !requestedRepositoryId) {
      void showCompactWarningMessage(
        'The repository refresh request did not identify one valid registered repository. Nothing was changed.'
      );
      return;
    }
    if (requestedRepositoryId && !requestedWorkspacePath) {
      void showCompactWarningMessage(
        'A repository-scoped refresh must identify its exact registered workspace. Nothing was changed.'
      );
      return;
    }
    const requestedCapabilityIds = request && typeof request === 'object'
      && 'capabilityIds' in request && Array.isArray(request.capabilityIds)
      ? request.capabilityIds.filter((id): id is string =>
        typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
      : [];
    const authoritySupplied = Boolean(request && typeof request === 'object' && 'authority' in request);
    const rawAuthority = authoritySupplied
      ? (request as { authority?: {
          leadUrl?: string; configurationBranch?: string; configurationCommit?: string;
          sourceBranch?: string; sourceCommit?: string;
        } }).authority
      : null;
    const validAuthorityPair = (branch: unknown, commit: unknown): branch is string =>
      typeof branch === 'string' && Boolean(branch.trim())
      && !/[\u0000-\u001f\u007f\s]/u.test(branch.trim())
      && typeof commit === 'string' && /^[0-9a-f]{40,64}$/i.test(commit.trim());
    const configurationPairPresent = Boolean(rawAuthority
      && (rawAuthority.configurationBranch !== undefined
        || rawAuthority.configurationCommit !== undefined));
    const sourcePairPresent = Boolean(rawAuthority
      && (rawAuthority.sourceBranch !== undefined || rawAuthority.sourceCommit !== undefined));
    const configurationPairValid = validAuthorityPair(
      rawAuthority?.configurationBranch, rawAuthority?.configurationCommit
    );
    const sourcePairValid = validAuthorityPair(
      rawAuthority?.sourceBranch, rawAuthority?.sourceCommit
    );
    const rawAuthorityBranch = configurationPairValid
      ? rawAuthority!.configurationBranch! : sourcePairValid ? rawAuthority!.sourceBranch! : null;
    const rawAuthorityCommit = configurationPairValid
      ? rawAuthority!.configurationCommit! : sourcePairValid ? rawAuthority!.sourceCommit! : null;
    const requestedAuthority = rawAuthority
      && typeof rawAuthority.leadUrl === 'string'
      && !gitRemoteProblem(rawAuthority.leadUrl, 'Capability authority')
      && (!configurationPairPresent || configurationPairValid)
      && (!sourcePairPresent || sourcePairValid)
      && rawAuthorityBranch && rawAuthorityCommit
      ? {
          leadUrl: rawAuthority.leadUrl.trim(),
          configurationBranch: rawAuthorityBranch.trim(),
          configurationCommit: rawAuthorityCommit.trim().toLowerCase(),
          identityKind: configurationPairValid
            ? 'configuration' as const : 'legacy-projection' as const
        }
      : null;
    if (authoritySupplied && !requestedAuthority) {
      void showCompactWarningMessage(REPOSITORY_SETUP_CHANGED_MESSAGE);
      return;
    }
    if (requestedCapabilityIds.length && !requestedAuthority) {
      void showCompactWarningMessage(REPOSITORY_SETUP_CHANGED_MESSAGE);
      return;
    }
    const rawRepositorySetup = request && typeof request === 'object'
      && 'repositorySetup' in request
      && request.repositorySetup && typeof request.repositorySetup === 'object'
      ? request.repositorySetup : null;
    const repositorySetupPlan = parseRepositoryOnboardingPlan(rawRepositorySetup?.plan);
    const repositorySetupResult = repositorySetupPlan && rawRepositorySetup?.result != null
      ? parseRepositoryOnboardingResult(rawRepositorySetup.result, repositorySetupPlan.planId)
      : null;
    const setupLead = repositorySetupPlan?.routing?.leadUrl
      ?? repositorySetupPlan?.repository.url ?? null;
    const setupConfigurationCommit = repositorySetupResult?.configuration?.commit
      ?? repositorySetupPlan?.observedRefs['refs/heads/sflow/config'] ?? null;
    const repositorySetupReceiptCurrent = Boolean(requestedAuthority && repositorySetupPlan
      && repositorySetupPlan.canApply
      && (repositorySetupResult
        ? ['ready', 'ready-state-refresh-pending', 'linked-to-team-configuration']
          .includes(repositorySetupResult.status)
        : ['ready', 'linked-to-team-configuration'].includes(repositorySetupPlan.status))
      && setupLead && sameGitRepository(setupLead, requestedAuthority.leadUrl)
      // A direct configuration receipt must name the exact revision handed to Workspaces. A
      // delivery-locator receipt intentionally contains no lead configuration ref; its routing is
      // sufficient for this read-only handoff because attach preview rechecks the lead before write.
      && (repositorySetupPlan.state.kind === 'delivery-locator'
        || (setupConfigurationCommit != null
          && setupConfigurationCommit.toLowerCase()
            === requestedAuthority.configurationCommit.toLowerCase()))
      // A result is optional (Ready performs no mutation). When supplied, it must be the exact
      // confirmed result for this preview; a stale or forged pair never suppresses the live read.
      && (rawRepositorySetup?.result == null || repositorySetupResult));
    const node = upgrade ? undefined : request as TreeNode | undefined;
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error);
    }
    // The registry is machine-wide, so this runs from wherever the CLI happens to be rooted rather
    // than from a repository the person may not have open.
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    const readEntries = (signal?: AbortSignal): Promise<WorkspaceEntry[]> =>
      registry.run<WorkspaceEntry[]>(['workspace', 'list', '--json'], signal);
    const list = (): Promise<WorkspaceEntry[]> => readEntries().catch(() => []);
    const readWorkspaceStatus = (workspacePath: string): Promise<WorkspaceStatus> =>
      registry.run<WorkspaceStatus>([
        'workspace', 'status', workspacePath,
        ...(requestedAuthority ? ['--level', 'readiness'] : ['--archive-readiness', '--no-fetch']),
        '--json'
      ]);
    let inspectedAuthorityOrganisation: (ObservedCapabilityAuthority & {
      capabilities?: RemoteCapability[] | null;
      repositories?: Record<string, { url?: string; defaultBranch?: string }>;
    }) | null = null;
    const details = async (workspacePath: string): Promise<WorkspaceStatus> => {
      // Only the selected row receives a repository read. Never retain a manifest as mutation
      // authority: attachment preview/apply and archival still perform their own fresh checks.
      const status = await readWorkspaceStatus(workspacePath);
      const lead = status.repositories.find((repository) =>
        repository.id === status.workspace.leadRepository || repository.role === 'lead');
      const capabilityAuthorityUrl = status.workspace.capabilityAuthority?.url?.trim()
        || lead?.url?.trim();
      if (!capabilityAuthorityUrl) return status;
      try {
        // Consume a verified invocation-local catalog at most once for advisory choices. Retained
        // panels must not continue presenting this snapshot after later registry/authority changes.
        // Attachment preview/apply never uses this catalog as mutation authority.
        const initialCatalogue = inspectedAuthorityOrganisation && requestedAuthority
          && sameGitRepository(capabilityAuthorityUrl, requestedAuthority.leadUrl)
          ? inspectedAuthorityOrganisation : null;
        if (initialCatalogue) inspectedAuthorityOrganisation = null;
        const organisation = initialCatalogue ?? await registry.run<{
          governed?: boolean; stale?: boolean; sourceBranch?: string; sourceCommit?: string;
          configurationBranch?: string; configurationCommit?: string;
          capabilities?: RemoteCapability[] | null;
          repositories?: Record<string, { url?: string; defaultBranch?: string }>;
        }>(['capability', 'organisation', capabilityAuthorityUrl, '--json']);
        return {
          ...status,
          availableCapabilities: capabilityChoices(
            organisation.capabilities ?? [], organisation.repositories ?? {}
          ).map(({ id, name, depth, ancestors, repository }) => ({
            id, name, depth, ancestors, repository
          }))
        };
      } catch (error) {
        // Workspace health is still useful when the remote map is temporarily unreachable. The
        // edit screen names the limitation without hiding everything else it already read.
        return {
          ...status,
          warnings: [
            ...(status.warnings ?? []),
            { code: 'capability-map-unavailable', message: `Capabilities could not be refreshed: ${(error as Error).message}` }
          ]
        };
      }
    };

    let entries: WorkspaceEntry[];
    try {
      entries = await readWithProgress('Loading local workspace choices',
        () => readEntries(readController.signal));
    } catch (error) {
      if (requestIsCurrent()) showRefusal(error);
      return;
    }
    if (!requestIsCurrent()) return;
    let attachScope: WorkspaceCapabilityAttachScope | null = null;
    if (requestedAuthority) {
      let issue: string | null = null;
      let verifiedAuthority: WorkspaceCapabilityAttachScope['authority'] = {
        leadUrl: requestedAuthority.leadUrl,
        configurationBranch: requestedAuthority.configurationBranch,
        configurationCommit: requestedAuthority.configurationCommit
      };
      try {
        if (repositorySetupReceiptCurrent) {
          // The Map panel has already made the bounded repository observation and handed us the
          // exact approved configuration identity. Do not clone/read the same organisation again
          // merely to render workspace choices. This never authorizes a write: attach-capability
          // dry-run verifies the current authority and its returned CAS-bound plan is compared
          // with `verifiedAuthority` immediately before user confirmation and apply.
          verifiedAuthority = {
            leadUrl: requestedAuthority.leadUrl,
            configurationBranch: requestedAuthority.configurationBranch,
            configurationCommit: requestedAuthority.configurationCommit
          };
        } else {
          const readAuthority = (refresh: boolean) => readWithProgress('Checking the selected capability authority',
            () => registry.run<ObservedCapabilityAuthority & {
            capabilities?: RemoteCapability[] | null;
            repositories?: Record<string, { url?: string; defaultBranch?: string }>;
          }>([
            'capability', 'organisation', requestedAuthority.leadUrl,
            ...(refresh ? ['--refresh'] : []), '--json'
          ], readController.signal));
        // Prefer the commit-validated cache. Retry once from the remote only when an old cache
        // schema cannot express the split identity or its last observation was explicitly stale.
        // This avoids an unconditional clone while preventing either condition from masquerading
        // as a real sflow/config revision change.
        inspectedAuthorityOrganisation = await readAuthority(false);
        let verification = verifyCapabilityAuthorityLease(
          requestedAuthority, inspectedAuthorityOrganisation
        );
        if (verification.status === 'unavailable' || verification.status === 'invalid') {
          inspectedAuthorityOrganisation = await readAuthority(true);
          verification = verifyCapabilityAuthorityLease(
            requestedAuthority, inspectedAuthorityOrganisation
          );
        }
        if (verification.status === 'verified') {
          // Older/retained Map panels handed Workspaces the state-projection identity. Accept that
          // lease only when it still exactly matches the freshly observed projection, then upgrade
          // it to the canonical sflow/config identity used by preview and apply. This keeps old
          // panels recoverable without weakening the exact-CAS mutation boundary.
          verifiedAuthority = verification.authority;
        } else if (verification.status === 'ungoverned') {
          issue = REPOSITORY_SETUP_CHANGED_MESSAGE;
        } else if (verification.status === 'unavailable') {
          issue = unavailableCapabilityAuthorityMessage(inspectedAuthorityOrganisation);
        } else if (verification.status === 'invalid') {
          issue = REPOSITORY_SETUP_CHANGED_MESSAGE;
        } else if (verification.status === 'changed') {
          issue = REPOSITORY_SETUP_CHANGED_MESSAGE;
        }
        }
      } catch (error) {
        issue = `The verified capability authority could not be re-read: ${(error as Error).message}`;
      }
      if (!requestIsCurrent()) return;
      if (issue) {
        output.appendLine(`\nCapability attachment refused:\n${issue}`);
        void showCompactWarningMessage(issue);
        return;
      }
      const { matchingPaths, unreadable } = workspaceAuthorityChoices(entries, requestedAuthority.leadUrl);
      if (!requestIsCurrent()) return;
      if (unreadable.length) {
        void showCompactWarningMessage(
          `Capability attachment could not read every local workspace manifest. Reload with the current CLI, or repair ${unreadable.map((entry) => entry.name).join(', ')}, then retry. No workspace was selected.`
        );
        return;
      }
      if (!matchingPaths.length) {
        issue = 'No local workspace is bound to the verified capability authority. Create a workspace for this authority, or use an existing clone, before attaching the capability.';
      }
      attachScope = {
        capabilityIds: requestedCapabilityIds,
        authority: verifiedAuthority,
        matchingPaths,
        issue
      };
    }

    const onMessage = async (message: WorkspacesMessage): Promise<string | null> => {
      if (message.type === 'create') {
        await vscode.commands.executeCommand('singularityFlow.createWorkspace', {
          organisation: message.organisation,
          capabilityId: message.capabilityId
        });
        return null;
      }
      if (message.type === 'adopt') {
        await vscode.commands.executeCommand('singularityFlow.adoptWorkspace');
        return null;
      }
      if (message.type === 'switch') {
        await selectWorkspace(
          message.row.directory,
          message.row.leadRepositoryPath || message.row.directory,
          message.row.name
        );
        return null;
      }
      if (message.type === 'forget') {
        const confirmed = await showCompactWarningMessage(
          `Forget ${message.row.name}?`,
          { modal: true, detail: `Removes it from the workspace list. ${message.row.directory} is left exactly as it is.` },
          'Forget');
        if (confirmed !== 'Forget') return WORKSPACE_ACTION_CANCELLED;
        message = { type: 'run', command: ['workspace', 'forget', message.row.directory, '--json'], title: 'Forgetting workspace' };
      }
      if (message.type === 'archive') {
        const confirmed = await showCompactWarningMessage(
          `Archive ${message.row.name}?`,
          {
            modal: true,
            detail: 'Singularity Flow will refresh every repository and refuse if any Story is still active. The checkout, branches and generated artifacts are preserved.'
          },
          'Archive workspace'
        );
        if (confirmed !== 'Archive workspace') return WORKSPACE_ACTION_CANCELLED;
        message = {
          type: 'run', command: archiveCommand(message.row), title: `Archiving ${message.row.name}`
        };
      }
      if (message.type === 'restore') {
        message = {
          type: 'run', command: restoreCommand(message.row), title: `Restoring ${message.row.name}`
        };
      }
      if (message.type === 'repair') {
        message = {
          type: 'run', command: ['workspace', 'repair', message.row.directory, '--json'],
          title: `Repairing ${message.row.name}`
        };
      }
      if (message.type === 'attach-capability' || message.type === 'detach-capability') {
        if (!message.isCurrent()) return WORKSPACE_ACTION_CANCELLED;
        const action = message.type === 'attach-capability' ? 'attach' : 'detach';
        const dropLocal = message.type === 'detach-capability' && message.dropLocal;
        const previewCommand = capabilityChangeCommand(
          message.row, message.capabilityId, action, { dropLocal }
        );
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(previewCommand)}`);
        let preview: WorkspaceCapabilityChangePreview;
        try {
          preview = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${action === 'attach' ? 'Checking attachment' : 'Checking detach safety'} for ${message.capabilityId}`
            },
            () => registry.run<WorkspaceCapabilityChangePreview>(previewCommand)
          );
        } catch (error) {
          output.appendLine(`  failed: ${(error as Error).message}`);
          return (error as Error).message;
        }
        const previewValid = /^wscp-[0-9a-f]{24}$/.test(preview?.planId ?? '')
          && preview.action === action
          && preview.capabilityId === message.capabilityId
          && preview.dropLocal === dropLocal
          && preview.workspace?.path === message.row.directory
          && preview.authority && typeof preview.authority.url === 'string'
          && typeof preview.authority.configurationBranch === 'string'
          && typeof preview.authority.configurationCommit === 'string'
          && typeof preview.authority.sourceBranch === 'string'
          && typeof preview.authority.sourceCommit === 'string'
          && Array.isArray(preview.materializeRepositories)
          && Array.isArray(preview.addedRepositories)
          && Array.isArray(preview.dropRepositories)
          && preview.dropRepositories.every((repository) => repository
            && typeof repository.id === 'string' && typeof repository.path === 'string');
        if (!previewValid) {
          const error = 'The installed SFlow engine returned an incompatible capability-change preview. Reinstall the matching extension and engine before retrying.';
          output.appendLine(`  failed: ${error}`);
          return error;
        }
        const expectedAuthority = message.type === 'attach-capability'
          ? message.expectedAuthority : null;
        if (expectedAuthority && (!sameGitRepository(
          preview.authority.url, expectedAuthority.leadUrl
        )
          || preview.authority.configurationBranch !== expectedAuthority.configurationBranch
          || preview.authority.configurationCommit.toLowerCase()
              !== expectedAuthority.configurationCommit.toLowerCase())) {
          const error = REPOSITORY_SETUP_CHANGED_MESSAGE;
          output.appendLine(`  failed: ${error}`);
          return error;
        }
        if (!message.isCurrent()) return WORKSPACE_ACTION_CANCELLED;
        const effects = [
          `Workspace: ${message.row.name}`,
          `Capability: ${message.capabilityId}`,
          action === 'attach'
            ? preview.materializeRepositories.length
              ? `Repositories to materialize: ${preview.materializeRepositories.join(', ')}`
              : 'Existing repository checkouts will be reused.'
            : dropLocal
              ? preview.dropRepositories.length
                ? `Local checkouts to remove: ${preview.dropRepositories.map((repository) => repository.path).join(', ')}`
                : 'No checkout can or needs to be removed; shared and lead repositories stay in place.'
              : 'Repository checkouts will be retained.',
          preview.preservedLeadRepository
            ? `Lead repository '${preview.preservedLeadRepository}' will remain in the workspace.`
            : null,
          'The approved capability map is not changed.'
        ].filter((line): line is string => Boolean(line));
        const label = action === 'attach'
          ? 'Attach capability'
          : dropLocal ? 'Detach and drop local' : 'Detach capability';
        const confirmed = await showCompactWarningMessage(
          `${label}: ${message.capabilityId}?`,
          { modal: true, detail: effects.join('\n') },
          label
        );
        if (confirmed !== label) return WORKSPACE_ACTION_CANCELLED;
        // A modal can remain open while the user switches rows or closes Manage. Never apply a
        // plan that no longer belongs to the visible, authoritative editor snapshot.
        if (!message.isCurrent()) return WORKSPACE_ACTION_CANCELLED;
        const applyCommand = capabilityChangeCommand(message.row, message.capabilityId, action, {
          dropLocal, planId: preview.planId
        });
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(applyCommand)}`);
        try {
          const applied = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${action === 'attach' ? 'Attaching' : 'Detaching'} ${message.capabilityId}`
            },
            () => registry.run<WorkspaceCapabilityChangeResult>(applyCommand)
          );
          if (applied.activeSelectionCleared) {
            // The dropped participant was the repository every other extension surface still used.
            // Re-select the preserved lead through the normal host-wide handoff so the CLI,
            // repository clients, gateway handles, status bar, and retained panels move together.
            const rebound = await selectWorkspace(
              applied.workspace.path,
              applied.status.leadRepositoryPath,
              applied.workspace.name,
              applied.workspace.leadRepository
            );
            if (!rebound) {
              // `selectWorkspace` already surfaced the exact refusal. Retire gateway handles now,
              // then reload so no repository-bound closure can keep using the removed directory.
              setActiveRepositoryContext(null);
              await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
          }
          if (applied.materializationError) {
            const recovery = commandGuidanceText(applied.repairCommand);
            const failure = `${applied.materializationError}${recovery
              ? ` Recover with:\n${recovery}` : ''}`;
            output.appendLine(`  attachment recorded; materialization pending: ${failure}`);
            void showCompactWarningMessage(
              'Capability attached, but a repository still needs repair. Open the workspace and choose Repair workspace.'
            );
            return null;
          }
          if (action === 'attach' && refreshStoriesAfterMapping) {
            void refreshStoriesAfterMapping().catch((error) => {
              if (isCliReadSuperseded(error)) return;
              output.appendLine(`Story discovery after capability attachment needs attention: ${(error as Error).message}`);
            });
          }
          if (applied.retained?.length) {
            const recovery = commandGuidanceText(applied.repairCommand);
            const failure = `Capability detached, but ${applied.retained.length} checkout cleanup ${applied.retained.length === 1 ? 'item was' : 'items were'} retained for safe recovery.${recovery
              ? ` Recover with:\n${recovery}` : ''}`;
            output.appendLine(`  ${failure}`);
            void showCompactWarningMessage(failure);
            // This is a durable partial success, not a clean completion. Keeping a visible failure
            // preserves Manage and its Repair workspace action instead of closing the only recovery
            // surface after the manifest has already changed.
            return failure;
          }
          return null;
        } catch (error) {
          output.appendLine(`  failed: ${(error as Error).message}`);
          return (error as Error).message;
        }
      }
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(message.command)}`);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: message.title },
          () => registry.runText(message.command));
        return null;
      } catch (error) {
        output.appendLine(`  failed: ${(error as Error).message}`);
        return (error as Error).message;
      }
    };

    const { WorkspacesPanel, IntakePanel } = lazyPanels();
    if (!requestIsCurrent()) return;
    const refreshConfiguration = async (
      workspacePath: string | null,
      request: Parameters<typeof workspaceReinitializeCommand>[1]
    ): Promise<WorkspaceConfigurationRefreshResult> => {
      // The engine revalidates registry membership and the exact plan before mutation. Avoid a
      // second machine-wide `workspace list` process merely to recover the already-selected path.
      const command = workspaceReinitializeCommand(
        workspacePath ? { directory: workspacePath } : null,
        request
      );
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: request.dryRun
              ? 'Checking workspace reinitialization'
              : 'Applying reviewed workspace reinitialization',
            cancellable: true
          },
          async (_progress, token) => {
            const cancellation = new AbortController();
            const subscription = token.onCancellationRequested?.(() => cancellation.abort());
            try {
              return await registry.run<WorkspaceConfigurationRefreshResult>(
                command, cancellation.signal
              );
            } finally {
              subscription?.dispose();
            }
          }
        );
        if (!request.dryRun && (result.status === 'complete' || result.updated > 0)) {
          await IntakePanel.configurationChanged();
        }
        return result;
      } catch (error) {
        // This command deliberately exits non-zero for a blocked or partial multi-repository result.
        // Keep that structured result so the page can name the failed repository, review branch,
        // and recovery state instead of displaying a serialized JSON object as an exception.
        const result = (error as { result?: unknown }).result;
        if (result && typeof result === 'object' && Array.isArray((result as { results?: unknown }).results)) {
          const structured = result as WorkspaceConfigurationRefreshResult;
          if (!request.dryRun && structured.updated > 0) {
            await IntakePanel.configurationChanged();
          }
          return structured;
        }
        throw error;
      }
    };
    const runFosAction = async (
      action: WorkspaceFosAction,
      repositoryPath: string | null
    ): Promise<WorkspaceFosOutcome | null> => {
      const commands: Record<WorkspaceFosAction, string> = {
        attach: 'singularityFlow.fastOnboardRepository',
        'refresh-authority': 'singularityFlow.refreshAuthorityPin',
        'offline-authority': 'singularityFlow.useOfflineAuthorityPin',
        'git-acceleration': 'singularityFlow.configureGitAcceleration',
        'clear-cache': 'singularityFlow.clearDerivedCache',
        'local-authority': 'singularityFlow.bootstrapLocalAuthority',
        doctor: 'singularityFlow.workspaceDoctor',
        'resume-bootstrap': 'singularityFlow.resumeWorkspaceBootstrap',
        'factory-reset': 'singularityFlow.factoryReset'
      };
      return await vscode.commands.executeCommand<WorkspaceFosOutcome | null>(
        commands[action], repositoryPath ?? undefined
      ) ?? null;
    };
    WorkspacesPanel.show(context, entries, list, async (message) => {
      const failure = await onMessage(message);
      // Anything that changes the registry changes the tree beside it.
      if (message.type !== 'switch') {
        void refreshWorkspaceTree();
      }
      return failure;
    }, details, refreshConfiguration, runFosAction,
    requestedWorkspacePath || workspacePathOf(node) || node?.path || null,
    upgradeScope, attachScope, requestedRepositoryId);
  }));

  /** One post-install entry point: review the build and upgrade an explicitly selected workspace. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.afterInstall', async () => {
      try {
        const location = resolveCli({ extensionPath: context.extensionPath });
        const launcher = codeLauncher(vscode.env?.appRoot);
        const registry = new SingularityFlowClient({
          location, repository: os.tmpdir(),
          environment: { ...cliEnvironment, ...(launcher ? { SINGULARITY_FLOW_CODE_CLI: launcher } : {}) },
          onOutput: text => output.append(text)
        });
        const { AfterInstallPanel, collectReviewConfirmation, IntakePanel } = lazyPanels();
        AfterInstallPanel.show(context, {
          extensionPath: context.extensionPath,
          confirm: collectReviewConfirmation,
          run: async <T>(argv: string[]): Promise<T> => {
            if (loadedBundle.reloadPending()) throw new Error(
              'SFlow was updated while this window was open. Reload VS Code, then reopen After install before upgrading.'
            );
            try { return await registry.run<T>(argv); }
            catch (error) {
              // A partial/blocked upgrade exits nonzero but still has repository-specific results.
              // Preserve them rather than losing protected-branch and schema recovery guidance.
              const result = (error as { result?: unknown }).result;
              if (argv[0] === 'workspace' && argv[1] === 'reinitialize'
                && result && typeof result === 'object'
                && Array.isArray((result as { results?: unknown }).results)) return result as T;
              throw error;
            }
          },
          configurationChanged: async () => {
            await IntakePanel.configurationChanged();
            await refreshWorkspaceTree();
          }
        });
      } catch (error) { showRefusal(error, { headline: 'After-install upgrade is unavailable' }); }
    }
  ));

  /** Compatibility commands continue to open the existing reviewed workspace upgrade UI. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.upgradeWorkspaces',
    () => vscode.commands.executeCommand('singularityFlow.openWorkspaces', { upgrade: true })
  ));

  /** Discoverable name for the same safe, plan-first workflow; kept separate from factory reset. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.reinitializeWorkspaces',
    () => vscode.commands.executeCommand('singularityFlow.openWorkspaces', { upgrade: true })
  ));

  /**
   * Compatibility route for clients which used the old ambiguous command ID.
   *
   * Reinitialize now always means the seeded-only, plan-first workspace refresh. The destructive
   * repository operation has its own explicit `singularityFlow.factoryReset` command below and is
   * never selected merely because an older button or tree node asked to reinitialize.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.reinitialize',
    (requestedRepository?: string) => requestedRepository?.trim()
      ? vscode.commands.executeCommand('singularityFlow.refreshRepositorySetup', {
        repositoryPath: requestedRepository.trim(), action: 'reinitialize'
      })
      : vscode.commands.executeCommand('singularityFlow.reinitializeWorkspaces')
  ));

  /**
   * Refresh the capability this window works on to the installed SFlow version, from a menu and
   * without asking for its Git URL: the workspace a page selected, else the repository open here,
   * else a registered workspace someone picks. Everything after that is the existing plan-first
   * reinitialize preview and apply; a repository no workspace registers gets the repair and
   * upgrade preview for its own setup instead.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.refreshCapability',
    async (request?: { workspacePath?: string; repositoryPath?: string }) => {
      const workspacePath = typeof request?.workspacePath === 'string' ? request.workspacePath.trim() : '';
      if (workspacePath) {
        return vscode.commands.executeCommand('singularityFlow.openWorkspaces', { upgradeScope: 'selected', workspacePath });
      }
      const repositoryPath = (typeof request?.repositoryPath === 'string' ? request.repositoryPath.trim() : '')
        || activeRepositoryContext()?.root || '';
      if (repositoryPath) {
        return vscode.commands.executeCommand('singularityFlow.refreshRepositorySetup', {
          repositoryPath, action: 'reinitialize', whenUnregistered: 'repair'
        });
      }
      let entries: WorkspaceEntry[];
      try {
        const location = resolveCli({ extensionPath: context.extensionPath });
        entries = (await new SingularityFlowClient({
          location, repository: process.cwd(), environment: cliEnvironment, onOutput: (text) => output.append(text)
        }).run<WorkspaceEntry[]>(['workspace', 'list', '--json'])).filter((entry) => !entry.archivedAt);
      } catch (error) {
        return showRefusal(error, { headline: 'Registered workspaces could not be read' });
      }
      if (!entries.length) {
        const next = await showCompactInformationMessage(
          'No workspace is registered on this machine yet, so there is no capability to refresh. Map a capability first.',
          'Map a capability'
        );
        if (next === 'Map a capability') return vscode.commands.executeCommand('singularityFlow.mapCapability');
        return;
      }
      const chosen = entries.length === 1 ? entries[0] : (await vscode.window.showQuickPick(
        entries.map((entry) => ({ label: entry.name || entry.id, description: entry.id, detail: entry.path, entry })),
        {
          title: 'Refresh which capability to the new version?',
          placeHolder: 'Choose a registered workspace; nothing changes until you confirm the reviewed preview.',
          ignoreFocusOut: true
        }
      ))?.entry;
      if (!chosen) return;
      return vscode.commands.executeCommand('singularityFlow.openWorkspaces', { upgradeScope: 'selected', workspacePath: chosen.path });
    }
  ));

  /**
   * Repository-centric maintenance that works on a new laptop before any workspace is registered.
   * The Map panel owns the shared setup card and the CLI owns every observation and mutation plan.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.repairRepositorySetup',
    async (request?: { repositoryUrl?: string; repositoryPath?: string } | string) => {
      const supplied = typeof request === 'string'
        ? request.trim()
        : request?.repositoryUrl?.trim() || request?.repositoryPath?.trim() || '';
      let repositoryUrl = supplied;
      const openRepository = activeRepositoryContext()?.root ?? '';
      if (!repositoryUrl && openRepository) {
        // The repository open in this window is almost always the one meant; another one stays one
        // choice away instead of a URL being the first thing asked for.
        const choice = await vscode.window.showQuickPick([
          { label: '$(repo) This repository', detail: openRepository, value: openRepository },
          { label: '$(link) Another repository…', detail: 'Enter its Git URL or the path to a local clone.', value: '' }
        ], { title: 'Repair or upgrade repository setup', ignoreFocusOut: true });
        if (!choice) return;
        repositoryUrl = choice.value;
      }
      if (!repositoryUrl) {
        repositoryUrl = (await vscode.window.showInputBox({
          title: 'Repair or upgrade repository setup',
          prompt: 'Enter a credential-free Git URL or the path to an existing local clone.',
          placeHolder: 'https://git.example.com/team/repository.git',
          ignoreFocusOut: true,
          validateInput: (value) => value.trim()
            ? gitRemoteProblem(value, 'Repository')
            : 'Enter a Git URL or local clone path.'
        }))?.trim() ?? '';
      }
      if (!repositoryUrl) return;
      const problem = gitRemoteProblem(repositoryUrl, 'Repository');
      if (problem) return showRefusal(problem, { headline: 'The repository cannot be used safely' });
      return vscode.commands.executeCommand('singularityFlow.mapCapability', {
        repositoryUrl,
        maintenance: true
      });
    }
  ));

  /**
   * Recover an old or incomplete setup from the one identity a person normally knows: its Git URL.
   *
   * This is deliberately an orchestrator over existing guarded CLI contracts. It performs no
   * configuration mutation itself: safe reinitialize opens the exact-plan preview already used by
   * Workspaces, authority refresh reuses the pinned-route command, and factory reset remains one
   * separately named choice with its own repository-bound confirmation.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.refreshRepositorySetup', async (request?: {
      repositoryUrl?: string;
      repositoryPath?: string;
      workspacePath?: string;
      /** Internal compatibility route: resolve the exact target, then open only safe reinitialize. */
      action?: 'reinitialize';
      /** With repositoryPath: a repository no workspace registers opens its repair and upgrade preview. */
      whenUnregistered?: 'repair';
    }) => {
      let location: CliLocation;
      try {
        location = resolveCli({ extensionPath: context.extensionPath });
      } catch (error) {
        return showRefusal(error, { headline: 'Repository maintenance is unavailable' });
      }
      const suppliedRepositoryPath = request?.repositoryPath?.trim() ?? '';
      const suppliedWorkspacePath = request?.workspacePath?.trim() ?? '';
      let requestedUrl = request?.repositoryUrl?.trim() ?? '';
      if (!requestedUrl && !suppliedRepositoryPath) {
        requestedUrl = (await vscode.window.showInputBox({
          title: 'Refresh or reinitialize from a Git URL',
          prompt: 'Enter the credential-free clone URL. SFlow searches only registered workspaces and repositories already open in this window.',
          placeHolder: 'https://git.example.com/team/repository.git',
          ignoreFocusOut: true,
          validateInput: (value) => {
            if (!value.trim()) return 'Enter the repository Git URL.';
            return gitRemoteProblem(value, 'Repository');
          }
        }))?.trim() ?? '';
        if (!requestedUrl) return;
      }
      if (requestedUrl) {
        const problem = gitRemoteProblem(requestedUrl, 'Repository');
        if (problem) return showRefusal(problem, { headline: 'The Git URL cannot be used safely' });
      }

      const registry = new SingularityFlowClient({
        location, repository: process.cwd(), environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      let observations: WorkspaceRefreshObservation[] = [];
      let lookupCancelled = false;
      try {
        observations = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Finding this repository in registered workspaces',
            cancellable: true
          },
          async (_progress, token) => {
            const cancellation = new AbortController();
            const subscription = token.onCancellationRequested?.(() => {
              lookupCancelled = true;
              cancellation.abort();
            });
            try {
              if (token.isCancellationRequested) {
                lookupCancelled = true;
                cancellation.abort();
              }
              if (cancellation.signal.aborted) return [];
              const workspaces = await registry.run<WorkspaceEntry[]>(
                ['workspace', 'list', '--json'], cancellation.signal
              );
              const directLeadMatches = suppliedRepositoryPath
                ? workspaces.filter((workspace) => workspace.leadRepositoryPath
                    && path.resolve(workspace.leadRepositoryPath) === path.resolve(suppliedRepositoryPath))
                : [];
              const scoped = suppliedWorkspacePath
                ? workspaces.filter((workspace) =>
                    path.resolve(workspace.path) === path.resolve(suppliedWorkspacePath))
                : directLeadMatches.length
                  ? directLeadMatches
                  : workspaces.filter((workspace) => !workspace.archivedAt);
              const results = new Array<WorkspaceRefreshObservation | null>(scoped.length).fill(null);
              let cursor = 0;
              const worker = async (): Promise<void> => {
                while (!cancellation.signal.aborted) {
                  const index = cursor++;
                  if (index >= scoped.length) return;
                  const workspace = scoped[index]!;
                  try {
                    const status = await registry.run<WorkspaceStatus>([
                      'workspace', 'status', workspace.path, '--no-fetch', '--json'
                    ], cancellation.signal);
                    results[index] = { workspace, status, error: null };
                  } catch (error) {
                    if (cancellation.signal.aborted) return;
                    results[index] = { workspace, status: null, error: (error as Error).message };
                  }
                }
              };
              await Promise.all(Array.from(
                { length: Math.min(4, scoped.length) }, () => worker()
              ));
              if (cancellation.signal.aborted) {
                lookupCancelled = true;
                return [];
              }
              return results.filter(
                (entry): entry is WorkspaceRefreshObservation => Boolean(entry)
              );
            } finally {
              subscription?.dispose();
            }
          }
        );
      } catch (error) {
        if (lookupCancelled) return;
        return showRefusal(error, { headline: 'Registered workspaces could not be read' });
      }
      if (lookupCancelled) return;

      const unreadable = observations.filter((observation) => observation.error);
      for (const observation of unreadable) {
        output.appendLine(`Workspace ${observation.workspace.name} could not be inspected: ${observation.error}`);
      }
      let targets: RepositoryRefreshTarget[];
      if (suppliedRepositoryPath) {
        const target = await repositoryRefreshTargetForPath(
          suppliedRepositoryPath, suppliedWorkspacePath || null, observations
        );
        targets = target ? [target] : [];
      } else {
        targets = repositoryRefreshTargets(requestedUrl, observations);
      }

      // An old-format workspace can fail before `workspace status` has enough structure to expose
      // repository URLs. Recovery must not depend on the damaged record it exists to replace.
      // The ordinary path above is metadata-only. Probe local Git only when that path found nothing,
      // and only for exact registered paths or a folder explicitly open in this window. This avoids
      // turning a maintenance menu into N×remote Git subprocesses on healthy workspaces.
      let fallbackCancelled = false;
      if (!targets.length) {
        let fallbackTargets: RepositoryRefreshTarget[] = [];
        try {
          fallbackTargets = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Checking local Git repositories for this URL',
              cancellable: true
            },
            async (_progress, token) => {
              const cancellation = new AbortController();
              const subscription = token.onCancellationRequested?.(() => {
                fallbackCancelled = true;
                cancellation.abort();
              });
              try {
                if (token.isCancellationRequested) {
                  fallbackCancelled = true;
                  cancellation.abort();
                }
                if (cancellation.signal.aborted) return [];
                const candidateOwners = new Map<string, WorkspaceRefreshObservation | null>();
                // A partially readable legacy status can expose the checkout path but omit or
                // stale its remote URL. Include those exact registered paths in the bounded local
                // fallback as well; otherwise the healthier half of a damaged record would
                // paradoxically make it unrecoverable by URL.
                for (const observation of observations) {
                  for (const repository of observation.status?.repositories ?? []) {
                    const repositoryPath = repository.absolutePath ?? repository.path;
                    if (repositoryPath) candidateOwners.set(path.resolve(repositoryPath), observation);
                  }
                }
                for (const observation of unreadable) {
                  if (observation.workspace.leadRepositoryPath) {
                    candidateOwners.set(path.resolve(observation.workspace.leadRepositoryPath), observation);
                  }
                }
                // Very old registry entries did not persist `leadRepositoryPath`, and a moved
                // workspace can retain an obsolete one. Inspect only direct `repos/<id>` children
                // of the registered workspace. Symlinks/junctions must resolve inside it; there is
                // no recursive or parent scan.
                for (const observation of unreadable.slice(0, 24)) {
                  if (cancellation.signal.aborted) return [];
                  try {
                    const workspaceBoundary = await fsRealpath(observation.workspace.path);
                    const repositoryDirectory = await fsRealpath(
                      path.join(observation.workspace.path, 'repos')
                    );
                    const directoryRelative = path.relative(workspaceBoundary, repositoryDirectory);
                    if (!directoryRelative || directoryRelative === '..'
                      || directoryRelative.startsWith(`..${path.sep}`)
                      || path.isAbsolute(directoryRelative)) continue;
                    const children = (await readdir(repositoryDirectory, { withFileTypes: true }))
                      .filter((entry) => entry.isDirectory()).slice(0, 24);
                    for (const child of children) {
                      if (cancellation.signal.aborted) return [];
                      const candidate = await fsRealpath(path.join(repositoryDirectory, child.name));
                      const relative = path.relative(workspaceBoundary, candidate);
                      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
                        || path.isAbsolute(relative)) continue;
                      candidateOwners.set(candidate, observation);
                    }
                  } catch {
                    // A missing or unreadable conventional directory is just another disclosed damaged
                    // workspace. The no-match path below retains the exact doctor command.
                  }
                }
                for (const folder of vscode.workspace.workspaceFolders ?? []) {
                  if (cancellation.signal.aborted) return [];
                  if (folder.uri?.scheme !== 'file' && folder.uri?.scheme != null) continue;
                  const folderPath = path.resolve(folder.uri.fsPath);
                  if (!candidateOwners.has(folderPath)) {
                    candidateOwners.set(folderPath, null);
                  }
                }
                const requestedPath = suppliedRepositoryPath ? path.resolve(suppliedRepositoryPath) : null;
                if (requestedPath) {
                  const registeredOwner = observations.find((observation) =>
                    (observation.workspace.leadRepositoryPath
                      && path.resolve(observation.workspace.leadRepositoryPath) === requestedPath)
                    || (observation.status?.repositories ?? []).some((repository) => {
                      const repositoryPath = repository.absolutePath ?? repository.path;
                      return repositoryPath && path.resolve(repositoryPath) === requestedPath;
                    })) ?? null;
                  const explicitlyOpen = (vscode.workspace.workspaceFolders ?? []).some((folder) =>
                    (folder.uri?.scheme === 'file' || folder.uri?.scheme == null)
                    && path.resolve(folder.uri.fsPath) === requestedPath);
                  if (registeredOwner || explicitlyOpen) candidateOwners.set(requestedPath, registeredOwner);
                }

                // One local `git config` invocation yields every remote URL; it never contacts the
                // network or opens a credential prompt. Four probes at a time and 24 paths are
                // deliberate safety ceilings for a damaged machine registry.
                const candidates = [...candidateOwners.entries()].slice(0, 24);
                const discovered: RepositoryRefreshTarget[] = [];
                const inspect = async (
                  candidate: string, owner: WorkspaceRefreshObservation | null
                ): Promise<RepositoryRefreshTarget | null> => {
                  if (cancellation.signal.aborted
                    || (requestedPath && path.resolve(candidate) !== requestedPath)) return null;
                  let canonical: string;
                  try {
                    canonical = await validateFactoryResetRepositoryDirectory(candidate, {
                      signal: cancellation.signal
                    });
                  } catch {
                    return null;
                  }
                  if (cancellation.signal.aborted) return null;
                  let urls: string[] = [];
                  try {
                    const configured = await configuredGitRemoteUrls(canonical, { signal: cancellation.signal });
                    urls = [...new Set(configured.filter((url) =>
                      url && !gitRemoteProblem(url, 'Configured repository')))].slice(0, 16);
                  } catch {
                    // A local repository with damaged remote configuration remains eligible when an
                    // internal caller supplied its exact registered path. Reinitialization repairs SFlow
                    // without rewriting Git remotes; URL discovery still requires an identity match.
                  }
                  if (cancellation.signal.aborted) return null;
                  const matchingUrl = requestedUrl
                    ? urls.find((url) => sameGitRepository(requestedUrl, url)) ?? null
                    : urls[0] ?? null;
                  if (requestedUrl && !matchingUrl) return null;
                  const repository = owner?.status?.repositories.find((entry) => {
                    const repositoryPath = entry.absolutePath ?? entry.path;
                    return repositoryPath && path.resolve(repositoryPath) === path.resolve(candidate);
                  });
                  return {
                    workspaceId: owner?.workspace.id ?? null,
                    workspaceName: owner?.workspace.name ?? 'Open repository',
                    workspacePath: owner?.workspace.path ?? null,
                    repositoryId: repository?.id ?? path.basename(canonical),
                    repositoryPath: canonical,
                    repositoryUrl: matchingUrl ?? requestedUrl,
                    repositoryState: repository?.state ?? (owner ? 'workspace details unreadable' : 'open in VS Code')
                  };
                };
                for (let index = 0; index < candidates.length; index += 4) {
                  if (cancellation.signal.aborted) return [];
                  const batch = candidates.slice(index, index + 4);
                  const inspected = await Promise.all(batch.map(([candidate, owner]) => inspect(candidate, owner)));
                  if (cancellation.signal.aborted) return [];
                  discovered.push(...inspected.filter(
                    (target): target is RepositoryRefreshTarget => Boolean(target)
                  ));
                }
                return discovered;
              } finally {
                subscription?.dispose();
              }
            }
          );
        } catch (error) {
          if (fallbackCancelled) return;
          return showRefusal(error, { headline: 'Local Git repositories could not be checked' });
        }
        targets.push(...fallbackTargets);
      }
      if (fallbackCancelled) return;
      if (!targets.length && suppliedRepositoryPath && request?.whenUnregistered === 'repair') {
        output.appendLine(`${suppliedRepositoryPath} belongs to no registered workspace; opening the repair and upgrade preview for its own setup.`);
        return vscode.commands.executeCommand('singularityFlow.repairRepositorySetup', { repositoryPath: suppliedRepositoryPath });
      }
      if (!targets.length) {
        const doctorArgs = requestedUrl
          ? ['workspace', 'doctor', '--network', '--repository', requestedUrl, '--json']
          : ['workspace', 'doctor', '--json'];
        const recovery = terminalCommand(
          os.tmpdir(), doctorArgs, process.platform, location
        );
        const recoveryRoute = safeCommandPair(
          `singularity-flow ${formatCliArgsForDisplay(doctorArgs)}`
        ) ?? (requestedUrl ? safeCommandPair(
          'singularity-flow workspace doctor --network --repository <REPOSITORY-URL> --json'
        ) : null);
        const recoveryText = recoveryRoute
          ? `Shell: ${recovery}\nCopilot: ${recoveryRoute.copilotCommand}`
          : null;
        output.appendLine(`No registered workspace matched the requested repository.${recoveryText
          ? ` Recover with:\n${recoveryText}` : ''}`);
        const next = await showCompactWarningMessage(
          'No registered workspace or open folder contains that repository.',
          {
            modal: true,
            detail: `${unreadable.length
              ? `${unreadable.length} registered workspace${unreadable.length === 1 ? '' : 's'} could not be read. Repair those registrations and retry.\n\n`
              : ''}Nothing was changed. SFlow did not scan the home directory or clone a repository.${recoveryText
              ? `\n\nRecovery:\n${recoveryText}` : ''}`
          },
          'Open Workspaces', 'Map a capability'
        );
        if (next === 'Open Workspaces') return vscode.commands.executeCommand('singularityFlow.openWorkspaces');
        if (next === 'Map a capability') return vscode.commands.executeCommand('singularityFlow.mapCapability');
        return;
      }

      const chosen = targets.length === 1 ? targets[0] : (await vscode.window.showQuickPick(
        targets.map((target) => ({
          label: `${target.workspaceName} · ${target.repositoryId}`,
          description: target.repositoryState,
          detail: `${target.repositoryPath}\n${target.repositoryUrl}`,
          target
        })),
        {
          title: 'Choose the exact registered repository',
          placeHolder: 'The Git URL belongs to more than one local workspace; no workspace is inferred.',
          ignoreFocusOut: true
        }
      ))?.target;
      if (!chosen) return;

      // The retired `singularityFlow.reinitialize` command ID must stay safe for old buttons and
      // extensions which supplied a repository path. Resolve that path against the registry as
      // above, then go directly to seeded-only review; never expose factory reset as an accidental
      // interpretation of the old command.
      if (request?.action === 'reinitialize') {
        const route = repositoryRefreshCommand('reinitialize', chosen);
        if (!route) return showRefusal(
          'Safe reinitialize requires this repository to belong to one registered workspace.',
          { headline: 'Could not open safe reinitialize' }
        );
        return vscode.commands.executeCommand(route.command, ...route.args);
      }

      const actions = [
        ...(repositoryRefreshCommand('reinitialize', chosen) ? [{
          label: '$(sync) Reinitialize framework-seeded SFlow assets',
          description: 'Recommended',
          detail: 'Preview only missing or exact registered framework workflow, phase, artifact-set, template, prompt, and agent updates. User-created and user-modified content is preserved.',
          action: 'reinitialize' as const
        }] : []),
        {
          label: '$(refresh) Refresh authority pin',
          description: 'Repair checkout/worktree routing',
          detail: 'Re-read the previously selected authority route without changing source or application branches.',
          action: 'authority' as const
        },
        {
          label: '$(warning) Factory reset all local SFlow data',
          description: 'Destructive recovery only',
          detail: 'Discard local SFlow configuration and runtime after an exact preview. This is not reinitialize and does not preserve user-created SFlow files.',
          action: 'factory-reset' as const
        }
      ];
      const selectedAction = await vscode.window.showQuickPick(actions, {
        title: `${chosen.workspaceName} · ${chosen.repositoryId}`,
        placeHolder: 'Choose a reviewed recovery path; no action is run automatically.',
        ignoreFocusOut: true
      });
      if (!selectedAction) return;
      output.appendLine(`Repository setup maintenance: ${selectedAction.action} · ${chosen.repositoryPath}`);
      const route = repositoryRefreshCommand(selectedAction.action, chosen);
      if (!route) return;
      return vscode.commands.executeCommand(route.command, ...route.args);
    }
  ));

  /**
   * The workspace tree, and the two things it offers.
   *
   * Machine-wide: the registry does not depend on which folder happens to be open, which is exactly
   * why this is useful in a window that has no repository in it yet.
   */
  const refreshWorkspaceTree = async (): Promise<void> => {
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      const entries = await new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: () => {}
      }).run<WorkspaceEntry[]>(['workspace', 'list', '--json']);
      workspaceEntries = entries;
      drawWorkspaces();
      sidebar.setNavigation(deriveSidebarNavigation(workspaceEntries, null));
    } catch (error) {
      output.appendLine(`Could not read the workspace registry: ${(error as Error).message}`);
      drawWorkspaces();
      sidebar.setNavigation(deriveSidebarNavigation(workspaceEntries, null, { loading: true }));
    }
  };
  /**
   * Make one workspace current, for this window and for the machine.
   *
   * An explicit choice also opens its native folder in this same window, so SFlow, newly created
   * terminals, and native Copilot share the same repository. Workspace details remain available
   * without selecting it. Selecting an already-open canonical root only refreshes SFlow views.
   */
  type SelectedWorkspace = {
    workspaceId: string;
    workspaceName: string;
    repositoryId: string | null;
    repositoryPath: string;
    workspacePath: string;
    navigationIsCurrent?: () => Promise<boolean>;
  };
  const workspaceSelected: Array<(selected: SelectedWorkspace) => void | Promise<void>> = [];

  async function selectWorkspace(
    target: string, leadPath: string, name: string, repositoryId?: string,
    forceReload = false, deferReload = false
  ): Promise<boolean> {
    const navigationGeneration = ++workspaceNavigationGeneration;
    try {
      const chooser = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: process.cwd(),
        onOutput: (text) => output.append(text)
      });
      const selected = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Working in ${name}${repositoryId ? ` · ${repositoryId}` : ''}` },
        // The CLI records the selection; the native folder handoff below aligns this window too.
        () => {
          // Keep machine-selector writes ordered by explicit requests. An older slow CLI must
          // not overwrite the newer choice, even when its window handoff is later fenced out.
          const action = workspaceSelectionQueue.catch(() => {}).then(() => {
            if (navigationGeneration !== workspaceNavigationGeneration) return null;
            return chooser.run<{
              workspaceId?: string; workspaceName?: string; repositoryId?: string;
              repositoryPath?: string; repositoryState?: string; workspacePath?: string;
            }>(['workspace', 'use', target, ...(repositoryId ? ['--repository', repositoryId] : []), '--json']);
          });
          workspaceSelectionQueue = action;
          return action;
        }
      );
      if (!selected || navigationGeneration !== workspaceNavigationGeneration) return false;
      // `workspace use --json` relays the exact record written atomically by the CLI. This cheap
      // byte fence also catches a newer selection from another window without another Git read.
      const selectedRevision = createHash('sha256').update(`${JSON.stringify(selected, null, 2)}\n`).digest('hex');
      const selectionIsCurrent = async (): Promise<boolean> => navigationGeneration === workspaceNavigationGeneration
        && await machineSelectionRevision(workspaceSelectionFile) === selectedRevision;
      if (!await selectionIsCurrent()) return false;
      const selection: SelectedWorkspace = {
        workspaceId: selected.workspaceId ?? target,
        workspaceName: selected.workspaceName ?? name,
        repositoryId: selected.repositoryId ?? null,
        repositoryPath: selected.repositoryPath ?? leadPath,
        workspacePath: selected.workspacePath ?? target,
        navigationIsCurrent: selectionIsCurrent
      };
      await refreshWorkspaceTree();
      // The Workspaces page is retained when hidden and owns its own row snapshot. Refresh it from
      // the same machine-wide registry before any other screen follows the new repository, so the
      // old workspace cannot remain labelled active beside a Navigator that already moved on.
      const { WorkspacesPanel } = lazyPanels();
      await WorkspacesPanel.activeWorkspaceChanged(target);
      if (!await selectionIsCurrent()) return false;
      await context.globalState.update(COPILOT_HANDOFF_KEY, undefined);
      if (!await selectionIsCurrent()) return false;
      if (deferReload) return true;
      if (await openSelectedWorkspaceFolder({ ...selection, repositoryState: selected.repositoryState },
        forceReload || !workspaceSelected.length || selected.repositoryState !== 'ready', selectionIsCurrent)) return true;
      for (const follow of workspaceSelected) await follow(selection);
      return true;
    } catch (error) {
      if (navigationGeneration === workspaceNavigationGeneration) showRefusal(error, { headline: 'Could not switch workspace' });
      return false;
    }
  }

  const nodeWorkspace = (node?: TreeNode): { path: string; lead: string; name: string } | null => {
    const workspacePath = workspacePathOf(node) ?? node?.path;
    if (typeof workspacePath !== 'string' || !workspacePath) return null;
    return {
      path: workspacePath,
      lead: node?.openPath ?? workspacePath,
      name: node?.label ?? workspacePath
    };
  };

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.switchWorkspace',
    async (node?: TreeNode) => {
      let chosen = nodeWorkspace(node);
      if (!chosen) {
        // Commands invoked from the palette do not receive a tree node. Previously that made
        // "Work in This Workspace" silently return without doing anything, even though the same
        // command worked when invoked from a workspace row.
        await refreshWorkspaceTree();
        const candidates = workspaceEntries.filter((entry) => !entry.archivedAt);
        if (!candidates.length) {
          return void showCompactWarningMessage(
            'No active Singularity Flow workspaces are available. Create or restore one first.');
        }
        const picked = await vscode.window.showQuickPick(candidates.map((entry) => ({
          label: entry.name,
          description: entry.active ? 'working here' : (entry.anchorKey || entry.id),
          detail: entry.path,
          entry
        })), {
          title: 'Work in a Singularity Flow workspace',
          placeHolder: 'Choose the workspace Lifecycle, Inbox, and Configuration should use'
        });
        if (!picked) return;
        chosen = {
          path: picked.entry.path,
          lead: picked.entry.leadRepositoryPath || picked.entry.path,
          name: picked.entry.name
        };
      }
      await selectWorkspace(chosen.path, chosen.lead, chosen.name);
    }));

  /**
   * Choose one repository inside the active workspace and publish that choice to every surface.
   *
   * The CLI already persists this dimension in the active-workspace record. Exposing it here avoids
   * a panel-local override that would make AST settings act on one checkout while My Work, Copilot,
   * and the terminal continued to act on another.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.switchWorkspaceRepository', async (requested?: string): Promise<boolean> => {
      try {
        const chooser = new SingularityFlowClient({
          location: resolveCli({ extensionPath: context.extensionPath }),
          repository: process.cwd(), onOutput: (text) => output.append(text)
        });
        const current = await chooser.run<{
          active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
          repositoryId?: string; repositoryPath?: string;
        }>(['workspace', 'current', '--json']);
        if (current.active !== true || !current.workspaceId || !current.workspacePath) {
          void showCompactWarningMessage('Choose a workspace before selecting one of its repositories.');
          return false;
        }
        const status = await chooser.run<WorkspaceStatus>(
          ['workspace', 'status', current.workspacePath, '--json']);
        const ready = status.repositories.filter((repository) =>
          Boolean(repository.id) && (!repository.state || repository.state === 'ready'));
        if (!ready.length) {
          void showCompactWarningMessage(
            `${current.workspaceName ?? current.workspaceId} has no ready repositories. Repair the workspace first.`);
          return false;
        }
        let repositoryId = typeof requested === 'string' ? requested.trim() : '';
        if (!repositoryId) {
          const picked = await vscode.window.showQuickPick(ready.map((repository) => ({
            label: repository.id,
            description: repository.id === current.repositoryId ? 'active repository' : (repository.role ?? ''),
            detail: repository.absolutePath ?? repository.path,
            repository
          })), {
            title: `Repository in ${current.workspaceName ?? current.workspaceId}`,
            placeHolder: 'Choose the repository every Singularity Flow surface should use'
          });
          if (!picked) return false;
          repositoryId = picked.repository.id;
        }
        const repository = ready.find((entry) => entry.id === repositoryId);
        if (!repository) {
          void showCompactWarningMessage(
            `Repository '${repositoryId}' is not a ready member of ${current.workspaceName ?? current.workspaceId}.`);
          return false;
        }
        return selectWorkspace(
          current.workspacePath,
          repository.absolutePath ?? repository.path ?? current.repositoryPath ?? current.workspacePath,
          current.workspaceName ?? current.workspaceId,
          repositoryId
        );
      } catch (error) {
        showRefusal(error, { headline: 'Could not switch workspace repository' });
        return false;
      }
    }
  ));

  /**
   * Open a workspace's lead repository as this window's folder.
   *
   * Use the same selection and native-root handoff as the workspace row so opening one cannot
   * leave the registry or governed screens pointing at another workspace.
   */
  /**
   * Resolve a workspace from a clicked node, or ask.
   *
   * Node-only commands were reachable exactly once — from a context menu on a view that is never
   * rendered. Falling back to the picker is what `attachSessionToWorkspace` already did; this is the
   * same behaviour, shared, so a command works whether it arrives from a click or the palette.
   */
  const chooseWorkspace = async (
    node: TreeNode | undefined, title: string, placeHolder: string
  ): Promise<{ path: string; lead: string; name: string } | null> => {
    const fromNode = nodeWorkspace(node);
    if (fromNode) return fromNode;
    await refreshWorkspaceTree();
    const picked = await vscode.window.showQuickPick(workspaceEntries.map((entry) => ({
      label: entry.name,
      description: entry.anchorKey || entry.id,
      detail: entry.path,
      entry
    })), { title, placeHolder });
    if (!picked) return null;
    return {
      path: picked.entry.path,
      lead: picked.entry.leadRepositoryPath || picked.entry.path,
      name: picked.entry.name
    };
  };

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openWorkspace',
    async (node?: TreeNode) => {
      const chosen = await chooseWorkspace(
        node,
        'Open a Singularity Flow workspace',
        'Choose the workspace whose repository should open in this window'
      );
      if (!chosen) return;
      await selectWorkspace(chosen.path, chosen.lead, chosen.name);
    }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.attachSessionToWorkspace',
    async (node?: TreeNode) => {
      const chosen = await chooseWorkspace(
        node,
        'Attach Copilot to a Singularity Flow workspace',
        'Choose the workspace whose governed repository Copilot should use'
      );
      if (!chosen) return;
      try {
        const chooser = new SingularityFlowClient({
          location: resolveCli({ extensionPath: context.extensionPath }),
          repository: process.cwd(),
          onOutput: (text) => output.append(text)
        });
        const attached = await chooser.run<{
          repositoryPath: string; workspaceName?: string;
        }>(['session', 'workspace', chosen.path, '--json']);
        const target = path.resolve(attached.repositoryPath || chosen.lead);
        const pending: PendingCopilotHandoff = {
          kind: 'workspace',
          repository: target,
          // Choosing a workspace is not choosing a Story. The repository may currently have a
          // Story branch checked out, but that is only a candidate until the contributor selects
          // it explicitly in /sf-session.
          workId: null,
          workspaceName: attached.workspaceName ?? chosen.name,
          requestedAt: new Date().toISOString()
        };
        await context.globalState.update(COPILOT_HANDOFF_KEY, pending);
        const targetIsOpen = vscode.workspace.workspaceFolders?.some(
          (folder) => path.resolve(folder.uri.fsPath) === target
        ) === true;
        if (targetIsOpen) {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        }
        void showCompactInformationMessage(
          `${pending.workspaceName} attached. Switching this window to ${target}; Copilot will open after reload.`
        );
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), false);
      } catch (error) {
        showRefusal(error, { headline: 'Could not attach the Copilot session to a workspace' });
      }
    }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.repairWorkspace', async () => {
    try {
      const client = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: process.cwd(), onOutput: (text) => output.append(text)
      });
      const current = await client.run<{
        active?: boolean; workspacePath?: string; workspaceName?: string;
      }>(['workspace', 'current', '--json']);
      if (!current.active || !current.workspacePath) {
        return void showCompactWarningMessage('Select a workspace before repairing it.');
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Repairing ${current.workspaceName ?? 'workspace'}` },
        () => client.run(['workspace', 'repair', current.workspacePath as string, '--json'])
      );
      // Refresh the persisted context so the next activation sees the repaired repository as ready.
      await client.run(['workspace', 'use', current.workspacePath, '--json']);
      void showCompactInformationMessage(
        `${current.workspaceName ?? 'Workspace'} repaired. Reloading Lifecycle, Inbox, and Configuration.`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error, { headline: 'Could not repair workspace' });
    }
  }));

  // A real editor can paint retained workspace rows and confirm its selected repository without
  // waiting for a second, machine-wide inventory. `workspace current` below still binds every
  // repository-scoped action. Stub-host tests await the list so their assertions stay deterministic;
  // production publishes it as soon as its independent read completes.
  const initialWorkspaceRefresh = refreshWorkspaceTree();

  // A new VSIX can carry a newer workflow/agent contract while every saved workspace still points
  // at its older approved configuration. Offer one visible route per installed build; do not start
  // remote Git reads until the contributor chooses it. The build stamp is used because development
  // reinstalls intentionally keep the same extension version.
  const loadedBuild = typeof __SFLOW_BUILD__ === 'string' ? __SFLOW_BUILD__ : 'unstamped';
  const upgradeOfferKey = 'singularityFlow.workspaceUpgradeOfferedBuild';
  const offerWorkspaceUpgrade = async (): Promise<void> => {
    if (loadedBuild === 'unstamped' || !workspaceEntries.some((entry) => !entry.archivedAt)
      || context.globalState.get<string>(upgradeOfferKey) === loadedBuild) return;
    await context.globalState.update(upgradeOfferKey, loadedBuild);
    void showCompactInformationMessage(
      'A new Singularity Flow build is installed. Review capability, workspace, and governed-agent updates?',
      'Review upgrades'
    ).then((choice) => choice === 'Review upgrades'
      ? vscode.commands.executeCommand('singularityFlow.upgradeWorkspaces') : undefined);
  };
  if (vscode.env?.appHost) {
    void initialWorkspaceRefresh.then(offerWorkspaceUpgrade).catch((error) => {
      output.appendLine(`Workspace upgrade offer could not be prepared: ${(error as Error).message}`);
    });
  } else {
    await initialWorkspaceRefresh;
    await offerWorkspaceUpgrade();
  }

  /**
   * Repository-independent panel clients. Their working directory is updated from the shared
   * active-workspace resolver at invocation time; local-reset deliberately stays outside every
   * managed workspace so destructive mode cannot accidentally run from inside a target.
   */
  const surfaceSettings = vscode.workspace.getConfiguration('singularityFlow');
  let surfaceLocation: CliLocation;
  try {
    surfaceLocation = resolveCli({
      configuredCli: surfaceSettings.get<string>('cliPath'),
      configuredNode: surfaceSettings.get<string>('nodePath'),
      extensionPath: context.extensionPath
    });
  } catch (error) {
    showRefusal(
      `${(error as Error).message} Open Singularity Flow: Diagnostics after correcting the CLI path.`,
      { headline: 'First-run health check could not find the CLI' }
    );
    return unavailable('Singularity Flow CLI unavailable', (error as Error).message);
  }

  // This is intentionally bounded and local: six probes, no repository scan and no network. It is
  // run once per health-contract version in a real extension host, then retained only as a small
  // machine-local status record. Governed Git data and credentials are never copied into it. The
  // function is invoked after the first confirmed paint: a healthy one-time diagnostic must not
  // make every fresh profile wait before commands, providers, or cached content can render.
  const firstRunHealthKey = 'singularityFlow.firstRunHealth.v1';
  const existingFirstRunHealth = context.globalState.get<{ status?: string } | null>(firstRunHealthKey, null);
  let firstRunBlocked = existingFirstRunHealth?.status === 'blocked';
  let firstRunHealthStarted = false;
  const runFirstRunHealth = async (): Promise<void> => {
    if (firstRunHealthStarted || !vscode.env?.appHost || (existingFirstRunHealth && !firstRunBlocked)) return;
    firstRunHealthStarted = true;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
    const checks = await firstRunChecks(context.extensionPath, surfaceLocation, folder);
    const blocked = checks.filter((entry) => entry.status === 'blocked');
    firstRunBlocked = blocked.length > 0;
    await context.globalState.update(firstRunHealthKey, {
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      status: blocked.length ? 'blocked' : 'healthy',
      checks
    });
    for (const check of checks) output.appendLine(`First-run check ${check.id}: ${check.status} — ${check.detail}`);
    if (blocked.length) {
      showRefusal(
        `${blocked.map((entry) => entry.detail).join('; ')}. Run Singularity Flow: Diagnostics for the single repair path.`,
        { headline: 'First-run health check needs attention' }
      );
    }
  };
  const diagnosticClient = new SingularityFlowClient({
    location: surfaceLocation, repository: os.tmpdir(), environment: cliEnvironment,
    onOutput: (text) => output.append(text)
  });
  let diagnosticHasRepository = false;
  const openDiagnostics = async (): Promise<void> => {
    try {
      const target = await resolveGovernedRepository(context, output);
      diagnosticHasRepository = !('reason' in target);
      if (diagnosticHasRepository && 'repository' in target) diagnosticClient.useRepository(target.repository);
      else diagnosticClient.useRepository(os.tmpdir());
      const { DiagnosticsPanel } = lazyPanels();
      output.appendLine(`\nRecent CLI timings (local, sanitized):\n${JSON.stringify(recentCliCommandTimings(), null, 2)}`);
      DiagnosticsPanel.show(context, diagnosticClient, () => diagnosticHasRepository);
    } catch (error) {
      showRefusal(error, { headline: 'Could not open Diagnostics' });
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openDiagnostics', openDiagnostics));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.doctor', openDiagnostics));

  // One build on every product surface. Checked after the first paint, repaired from the build this
  // machine retains, and a reload offered once this window's own files have been replaced.
  const launcher = codeLauncher(vscode.env?.appRoot);
  const productClient = new SingularityFlowClient({
    location: surfaceLocation, repository: os.tmpdir(),
    environment: { ...cliEnvironment, ...(launcher ? { SINGULARITY_FLOW_CODE_CLI: launcher } : {}) },
    onOutput: (text) => output.append(text)
  });
  const productHost: ProductAlignmentHost = {
    run: (args) => productClient.run(args),
    extensionPath: context.extensionPath,
    log: (line) => output.appendLine(line),
    progress: (title, task) => vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title
    }, task),
    inform: (message, ...actions) => showCompactInformationMessage(message, ...actions),
    warn: (message, ...actions) => showCompactWarningMessage(message, ...actions),
    reload: () => vscode.commands.executeCommand('workbench.action.reloadWindow'),
    remembered: (key) => context.globalState.get(key),
    remember: (key, value) => context.globalState.update(key, value)
  };
  const onExtensionsChanged = vscode.extensions?.onDidChange;
  if (onExtensionsChanged) {
    context.subscriptions.push(onExtensionsChanged(() => { void loadedBundle.offerReload(productHost); }));
  }
  if (vscode.env?.appHost) {
    // Both checks are optional, so neither competes with somebody filling in the intake form, nor
    // with the first reads of a window just opened for a new Story: that window waits until idle.
    const openedForNewStory = Boolean(context.globalState.get<unknown>(STORY_START_HANDOFF_KEY));
    const newStoryIdle = (): Promise<void> => new Promise((resolve) => {
      if (!openedForNewStory || activationSignal.aborted) return resolve();
      const timer = setTimeout(resolve, STORY_START_DISCOVERY_IDLE_MS);
      timer.unref?.();
      activationSignal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    void initialWorkspaceRefresh
      .then(newStoryIdle)
      .then(() => backgroundWork.waitUntilIdle({ signal: activationSignal }))
      .then(() => alignProductSurfaces(productHost, { loadedBuild, bundle: loadedBundle }))
      .then((outcome) => output.appendLine(`Product surface check: ${outcome}`))
      .then(() => backgroundWork.waitUntilIdle({ signal: activationSignal }))
      .then(() => openConfigurationReviews(productHost, { loadedBuild, bundle: loadedBundle }))
      .then((outcome) => output.appendLine(`Configuration review check: ${outcome}`))
      .catch((error) => output.appendLine(`Product surface check could not run: ${(error as Error).message}`));
  }

  // Shared drafts are bound to a verified repository, never just the machine's last open folder.
  // Configuration Center passes its exact bound repository. A command-palette invocation uses
  // the active workspace, then this editor's repository. Ask only when none is known.
  // Register before lifecycle activation so an incomplete Story cannot hide authoring.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openSharedWorkflowDrafts', async (configuration?: { repositoryPath: string }) => {
    try {
      const selectedWorkspace = configuration ? null : await activeWorkspaceRepository(context, output);
      if (selectedWorkspace && !('repository' in selectedWorkspace)) {
        throw new Error(selectedWorkspace.reason);
      }
      const selectedEditorRepository = activeRepositoryContext();
      let selectedRoot: string;
      if (configuration) {
        if (!selectedEditorRepository || selectedEditorRepository.root !== configuration.repositoryPath) {
          throw new Error('The Configuration Center repository changed. Reopen it before opening shared workflow drafts.');
        }
        selectedRoot = await validateRepositoryDirectory(configuration.repositoryPath);
      } else if (selectedWorkspace) selectedRoot = selectedWorkspace.repository;
      else if (selectedEditorRepository) selectedRoot = await validateRepositoryDirectory(selectedEditorRepository.root);
      else {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const folder = folders.length === 1 ? folders[0]
          : folders.length > 1 ? await vscode.window.showWorkspaceFolderPick({
            placeHolder: 'Choose the opened repository whose configuration authority owns these drafts'
          }) : null;
        const picked = folder ? folder.uri : (await vscode.window.showOpenDialog({
          title: 'Choose the exact Git repository root for shared workflow drafts',
          canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
          openLabel: 'Use this repository'
        }))?.[0];
        if (!picked) return;
        selectedRoot = await validateRepositoryDirectory(picked.fsPath);
      }
      const draftsClient = new SingularityFlowClient({
        location: surfaceLocation, repository: selectedRoot, environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const { showSharedWorkflowDrafts } = lazyPanels();
      await showSharedWorkflowDrafts(context, async (argv, requestedRoot) => {
        try {
          if (path.resolve(requestedRoot) !== path.resolve(selectedRoot)) {
            return { result: null, error: 'The shared-draft repository changed. Reopen the draft panel.' };
          }
          if (selectedWorkspace) {
            const current = await activeWorkspaceRepository(context, output);
            if (!current || !('repository' in current)
                || current.workspaceId !== selectedWorkspace.workspaceId
                || current.repositoryId !== selectedWorkspace.repositoryId
                || current.repository !== selectedRoot) {
              return { result: null, error: 'The selected workspace repository changed. Reopen Shared workflow drafts for the current repository; the previous draft was not moved.' };
            }
          } else {
            const currentEditorRepository = activeRepositoryContext();
            if (selectedEditorRepository && (!currentEditorRepository
                || currentEditorRepository.root !== selectedEditorRepository.root
                || currentEditorRepository.workspaceId !== selectedEditorRepository.workspaceId
                || currentEditorRepository.repositoryId !== selectedEditorRepository.repositoryId)) {
              return { result: null, error: 'The editor repository changed. Reopen Shared workflow drafts for the current repository; the previous draft was not moved.' };
            }
            if (await validateRepositoryDirectory(selectedRoot) !== selectedRoot) {
              return { result: null, error: 'The shared-draft repository changed. Reopen the draft panel.' };
            }
          }
          return { result: await draftsClient.run(argv), error: null };
        } catch (error) {
          return { result: null, error: error instanceof Error ? error.message : String(error) };
        }
      }, selectedRoot);
    } catch (error) { showRefusal(error, { headline: 'Could not open shared workflow drafts' }); }
  }));

  const resetClient = new SingularityFlowClient({
    location: surfaceLocation, repository: os.tmpdir(), environment: cliEnvironment,
    onOutput: (text) => output.append(text)
  });
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openLocalReset', async () => {
    try {
      const { LocalResetPanel } = lazyPanels();
      LocalResetPanel.show(context, resetClient);
    } catch (error) { showRefusal(error, { headline: 'Could not open Local Data & Reset' }); }
  }));

  // Return is registered before repository-dependent activation can stop. A fresh machine may have
  // only an ordinary clone open; the command must be able to inspect the published locator, show a
  // complete no-mutation plan, and then attach after an exact confirmation.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.returnToWork', async () => {
    try {
      const target = await resolveGovernedRepository(context, output);
      if ('reason' in target) {
        return showRefusal(
          'Open the repository clone that contains the published Story, or choose its governed workspace, then try Return again.',
          { headline: 'No repository available for Return' }
        );
      }
      const workId = (await vscode.window.showInputBox({
        title: 'Return to governed work',
        prompt: 'Enter the published Work ID. This preview does not change your branch.',
        placeHolder: 'WRK-123',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'Enter a Work ID.'
      }))?.trim();
      if (!workId) return;
      const returnClient = new SingularityFlowClient({
        location: surfaceLocation,
        repository: target.repository,
        environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const plan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Inspecting published work ${workId}…` },
        () => returnClient.run<StoryReturnPlan>(['return', workId, '--json'])
      );
      const additionalRepositories = plan.repositories
        .filter((entry) => entry.disposition !== 'existing-clone')
        .map((entry) => `${entry.id}: ${entry.disposition}${entry.required ? ' (required)' : ''}`);
      const blockers = [
        ...(!plan.worktree.clean ? [`${plan.worktree.changedPaths} uncommitted path(s)`] : []),
        ...(plan.localBranch.blocksApply ? [`local Story branch is ${plan.localBranch.disposition}`] : []),
        ...(plan.missingRequiredRepositories.length
          ? [`required repositories must be prepared first: ${plan.missingRequiredRepositories.join(', ')}`] : [])
      ];
      const detail = [
        `Source: ${plan.sourceRef} @ ${plan.sourceCommit.slice(0, 12)}`,
        `New/current local branch: ${plan.destinationBranch}`,
        `Configured remote: ${plan.configuredRemote}`,
        `Freshness: ${plan.freshness}`,
        `Local branch: ${plan.localBranch.disposition}`,
        ...(additionalRepositories.length ? ['', 'Other repositories:', ...additionalRepositories] : []),
        ...(blockers.length ? ['', 'Automatic attach is blocked:', ...blockers] : []),
        '',
        'Return never resets, stashes, cleans, or force-checks out local work.'
      ].join('\n');
      if (blockers.length) {
        await showCompactWarningMessage(
          `Return to ${plan.workId} cannot be applied safely.`, { modal: true, detail }, 'Open Source Control'
        ).then(async (choice) => {
          if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
        });
        return;
      }
      const approved = await showCompactInformationMessage(
        `Return to ${plan.workId}?`, { modal: true, detail }, 'Continue to confirmation'
      );
      if (approved !== 'Continue to confirmation') return;
      const confirmation = await vscode.window.showInputBox({
        title: `Confirm Return to ${plan.workId}`,
        prompt: `Type exactly: ${plan.confirmation}`,
        placeHolder: plan.confirmation,
        ignoreFocusOut: true,
        validateInput: (value) => value === plan.confirmation ? null : 'The confirmation must match the Work ID exactly.'
      });
      if (confirmation !== plan.confirmation) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Returning to ${plan.workId}…` },
        () => returnClient.run(['return', plan.workId, '--apply', '--confirm', confirmation, '--json'])
      );
      resetGatewaySession();
      const next = await showCompactInformationMessage(
        `${plan.workId} is attached on ${plan.destinationBranch}. Reload to show its durable next action.`,
        'Reload and open My Work'
      );
      if (next === 'Reload and open My Work') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    } catch (error) {
      showRefusal(error, { headline: 'Could not return to governed work' });
    }
  }));

  // Offered from the uninitialized state, so a folder that is not yet a Flow repository can become
  // one without leaving the editor. Registered before any early return, since that is exactly when
  // it is the only useful thing to do.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.init', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let target = folders[0];
    if (folders.length > 1) {
      const selected = await vscode.window.showQuickPick(
        folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
        {
          title: 'Repository to smart initialize',
          placeHolder: 'Choose the exact repository; multi-root workspaces are never inferred',
          ignoreFocusOut: true
        }
      );
      target = selected?.folder;
    }
    if (!target) return;
    const confirmed = await showCompactWarningMessage(
      'Initialize Singularity Flow in this repository?',
      { modal: true, detail: `This writes singularity/ into ${target.uri.fsPath} and commits it.` },
      'Initialize');
    if (confirmed !== 'Initialize') return;
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      await new SingularityFlowClient({ location, repository: target.uri.fsPath, onOutput: (text) => output.append(text) })
        .runText(['init']);
      // The extension host has to reload: activation already decided this was not a Flow repository.
      const reload = await showCompactInformationMessage(
        'Singularity Flow initialized. Reload the window to open it?', 'Reload');
      if (reload === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error);
    }
  }));

  // The smart path is deliberately a separate command. Legacy Initialize keeps its compatible
  // behavior, while this command renders the engine's deterministic proposal and sends back only
  // choices the person actually made. VS Code never invents a command or supplies confirmation
  // merely because it already knows the digest.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.smartInit', async () => {
    type SmartProposal = {
      proposalSha256: string;
      detectedStacks: string[];
      commands: Record<'verification' | 'quality' | 'build', Array<{
        id: string; launcher: string; args: string[]; workingDirectory: string; confidence: string;
      }>>;
      proof: { profile: string; readiness: string; gaps: Array<{ statement: string; blockingAt: string }> };
      ambiguities: Array<{ id: string; reason: string; candidates?: string[] }>;
      suggestions: Array<{ id: string; pattern: string; reason: string; selected: boolean }>;
      writeSet: Array<{ path: string; bytes: number; sha256: string }>;
    };
    const target = vscode.workspace.workspaceFolders?.[0];
    if (!target) return;
    try {
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      const location = resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      });
      const client = new SingularityFlowClient({
        location, repository: target.uri.fsPath, environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const preview = (protect: string[] = []) => client.run<SmartProposal>([
        'init', '--smart-detect', '--dry-run', '--json',
        ...protect.flatMap((id) => ['--protect', id])
      ]);
      let proposal = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Inspecting repository manifests (no scripts or model)' },
        () => preview()
      );
      if (proposal.ambiguities.length) {
        const detail = proposal.ambiguities.map((item) =>
          `${item.id}: ${item.reason}${item.candidates?.length ? `\n  ${item.candidates.join(', ')}` : ''}`).join('\n');
        await showCompactWarningMessage(
          'Smart initialization found choices it cannot make safely.',
          { modal: true, detail: `${detail}\n\nResolve the manifest ambiguity and preview again. Nothing was changed.` }
        );
        return;
      }
      const applicable = proposal.suggestions.filter((item) => !item.selected);
      if (applicable.length) {
        const selected = await vscode.window.showQuickPick(
          applicable.map((item) => ({ label: item.pattern, description: item.id, detail: item.reason, id: item.id })),
          {
            title: 'Optional repository protections',
            placeHolder: 'Select only protections you want to become repository law; leave empty to decline all',
            canPickMany: true,
            ignoreFocusOut: true
          }
        );
        if (selected === undefined) return;
        if (selected.length) proposal = await preview(selected.map((item) => item.id));
      }
      const commandLines = (['verification', 'quality', 'build'] as const).flatMap((purpose) =>
        proposal.commands[purpose].map((item) =>
          `${purpose}: ${item.launcher} ${item.args.join(' ')} (${item.workingDirectory}; ${item.confidence})`));
      const detail = [
        `Repository: ${target.uri.fsPath}`,
        `Detected: ${proposal.detectedStacks.join(', ') || 'unknown'}`,
        ...commandLines,
        `Proof: ${proposal.proof.profile} · ${proposal.proof.readiness}`,
        ...proposal.proof.gaps.map((gap) => `Gap: ${gap.statement} (blocks at ${gap.blockingAt})`),
        `Will create ${proposal.writeSet.length} declared SFlow file(s).`,
        'Will not run project commands, call a model, install dependencies, access the network, or stage unrelated work.',
        `Proposal: ${proposal.proposalSha256}`
      ].join('\n');
      const reviewed = await showCompactInformationMessage(
        'Review the exact smart-initialization proposal.', { modal: true, detail }, 'Continue to exact confirmation'
      );
      if (reviewed !== 'Continue to exact confirmation') return;
      let acceptsUnavailableVerification = false;
      if (proposal.proof.readiness === 'unavailable') {
        const acceptedGap = await showCompactWarningMessage(
          'No structured verifier is available. This remains a visible proof gap and will block candidate admission.',
          { modal: true, detail: proposal.proof.gaps.map((gap) => gap.statement).join('\n') },
          'Accept disclosed gap'
        );
        if (acceptedGap !== 'Accept disclosed gap') return;
        acceptsUnavailableVerification = true;
      }
      const confirmation = await vscode.window.showInputBox({
        title: 'Confirm smart initialization',
        prompt: `Paste the exact proposal digest: ${proposal.proposalSha256}`,
        placeHolder: proposal.proposalSha256,
        ignoreFocusOut: true,
        validateInput: (value) => value === proposal.proposalSha256 ? null : 'The digest must match the reviewed proposal exactly.'
      });
      if (confirmation !== proposal.proposalSha256) return;
      const activationArgs = ['init', '--smart-detect', '--confirm', confirmation, '--json'];
      const selectedProtections = proposal.suggestions.filter((item) => item.selected).map((item) => item.id);
      for (const id of selectedProtections) activationArgs.push('--protect', id);
      if (acceptsUnavailableVerification) activationArgs.push('--allow-unavailable-verification');
      const activated = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Activating exact repository law' },
        () => client.run<{ activationCommit: string; nextCommand: string }>(activationArgs)
      );
      const precheck = await client.run<{ data?: { precheck?: { status?: string } } }>(['precheck', '--quick', '--json']);
      const reload = await showCompactInformationMessage(
        `Smart initialization committed at ${activated.activationCommit.slice(0, 12)}. Quick precheck: ${precheck.data?.precheck?.status ?? 'unavailable'}.`,
        'Reload'
      );
      if (reload === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error, { headline: 'Smart initialization did not complete' });
    }
  }));

  // Version 1 is deliberately not migrated. This is the editor equivalent of /sf-factory-reset:
  // the engine creates the preview and owns the mutation, while VS Code only presents the exact
  // confirmation to the person. Registered before repository activation succeeds so the action is
  // still available in the incompatible-workflow state it exists to repair.
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.factoryReset', async (requestedRepository?: string) => {
    try {
      // Recovery cannot start by loading governed configuration: an old, incomplete, or damaged
      // configuration is the thing this command exists to remove. Require an explicit repository
      // selection instead, and prove only that it is the canonical root of a Git working tree.
      // A Workspaces repository action supplies its exact path; Command Palette use opens a picker.
      let selectedRepository = typeof requestedRepository === 'string'
        ? requestedRepository.trim() : '';
      if (!selectedRepository) {
        const choice = await vscode.window.showOpenDialog({
          title: 'Choose the Git repository to factory reset',
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Inspect repository',
          ...(vscode.workspace.workspaceFolders?.[0]?.uri
            ? { defaultUri: vscode.workspace.workspaceFolders[0].uri } : {})
        });
        if (!choice?.[0]) return;
        selectedRepository = choice[0].fsPath;
      }
      const repository = await validateFactoryResetRepositoryDirectory(selectedRepository, {
        signal: extensionLifetime.signal
      });
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      const location = resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      });
      const client = new SingularityFlowClient({
        location, repository, environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const plan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Preparing the destructive factory-reset preview' },
        () => client.run<FactoryResetPlan>(['factory-reset', '--dry-run', '--json'])
      );
      if (!plan.resetScopeSha256) {
        throw new Error('The selected Singularity Flow CLI is too old for guarded VS Code factory reset. Install the current build and try again.');
      }
      const reviewedScopeSha256 = plan.resetScopeSha256;
      const discarded = plan.uncommittedDiscardPaths ?? plan.uncommittedResetPaths.filter((entry) =>
        /^.. (?:singularity|\.singularity|\.sdlc)(?:\/|$)/.test(entry));
      const preservedDirty = plan.uncommittedResetPaths.filter((entry) => !discarded.includes(entry));
      const action = discarded.length
        ? 'Discard all local SFlow data'
        : 'Factory reset local SFlow data';
      const review = await showCompactWarningMessage(
        'Factory reset all local Singularity Flow data in this repository?',
        {
          modal: true,
          detail: `Repository: ${plan.repository}\nBranch: ${plan.branch ?? 'detached'}\n\n`
            + `Remove: ${plan.remove.join('; ')}\n\nReplace: ${plan.replace.join('; ')}\n\n`
            + `Preserve: ${plan.preserve.join('; ')}\n\n`
            + ((plan.customAgentRecoveries ?? []).length
              ? 'Invalid custom agents will be removed from active discovery and preserved byte-for-byte:\n'
                + `${plan.customAgentRecoveries!.map((entry) => `${entry.sourceDisplay} → ${entry.recoveryDisplay} `
                  + `(${entry.sha256}, ${entry.bytes} bytes)\nReason: ${entry.reason}`).join('\n')}\n\n`
              : '')
            + (discarded.length
              ? `Will be permanently discarded:\n${discarded.join('\n')}\n\n`
              : '')
            + (preservedDirty.length
              ? `Uncommitted custom-agent bytes that will be preserved:\n${preservedDirty.join('\n')}\n\n`
              : '')
            + 'Application source and Git history are preserved. Remote sflow/config and state branches are not changed. '
            + 'The replacement remains uncommitted for review.'
        },
        action
      );
      if (review !== action) return;
      const confirmation = await vscode.window.showInputBox({
        title: 'Confirm destructive factory reset',
        prompt: `Type exactly: ${plan.confirmation}`,
        placeHolder: plan.confirmation,
        ignoreFocusOut: true,
        validateInput: (value) => value === plan.confirmation ? null : 'The confirmation does not match the reset preview.'
      });
      if (confirmation !== plan.confirmation) return;

      // Re-read the preview after the person confirms. A branch switch or newly changed SFlow path
      // invalidates the reviewed operation; the command stops and makes the person inspect again.
      const currentPlan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Rechecking the factory-reset boundary' },
        () => client.run<FactoryResetPlan>(['factory-reset', '--dry-run', '--json'])
      );
      const reviewedIdentity = (candidate: FactoryResetPlan) => JSON.stringify({
        repository: candidate.repository,
        branch: candidate.branch,
        head: candidate.head,
        confirmation: candidate.confirmation,
        remove: candidate.remove,
        replace: candidate.replace,
        preserve: candidate.preserve,
        localRuntimeRoots: candidate.localRuntimeRoots ?? [],
        resetScopeSha256: candidate.resetScopeSha256 ?? null,
        uncommittedResetPaths: candidate.uncommittedResetPaths,
        uncommittedDiscardPaths: candidate.uncommittedDiscardPaths ?? [],
        customAgentRecoveries: candidate.customAgentRecoveries ?? []
      });
      if (reviewedIdentity(currentPlan) !== reviewedIdentity(plan)) {
        return void showCompactWarningMessage(
          'The repository changed after the reset preview. Nothing was removed. Run Factory Reset again to review the current boundary.'
        );
      }

      const resetResult = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Factory resetting local Singularity Flow data' },
        () => client.run<FactoryResetPlan>([
          'factory-reset', '--confirm', confirmation,
          '--expect-scope-sha256', reviewedScopeSha256,
          ...(discarded.length ? ['--allow-dirty'] : []), '--json'
        ])
      );
      // The reset engine has already validated the exact replacement bytes. This broader check can
      // also inspect a preserved remote authority, so report its failure as follow-up diagnostics —
      // never pretend the successfully completed destructive reset rolled back when it did not.
      let verificationWarning: string | null = resetResult.warnings?.join(' ') ?? null;
      for (const warning of resetResult.warnings ?? []) output.appendLine(`Post-reset warning: ${warning}`);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Checking the new local configuration' },
          () => client.run(['init', '--check', '--json'])
        );
      } catch (error) {
        const checkWarning = (error as Error).message;
        verificationWarning = [verificationWarning, checkWarning].filter(Boolean).join(' ');
        output.appendLine(`Post-reset configuration check needs attention: ${checkWarning}`);
      }
      // A retained Story Intake panel owns no configuration authority of its own. Its draft stays
      // intact, but installed and available workflows must now come from the replacement bytes.
      await lazyPanels().IntakePanel.configurationChanged(repository);
      const completedMessage = 'The current Singularity Flow format is installed locally. Application source and Git history were preserved; remote sflow/config and state branches were not changed. Review all generated SFlow changes in Source Control—including singularity/, packaged .github/agents files, and any recovered custom-agent files—then commit and publish through your normal review path.';
      const next = verificationWarning
        ? await showCompactWarningMessage(
          'The repository was factory reset, but cleanup or the post-reset check needs attention.',
          { modal: true, detail: `${completedMessage}\n\n${verificationWarning}` },
          'Open Output', 'Open Source Control', 'Reload Window'
        )
        : await showCompactInformationMessage(
          completedMessage, 'Open Source Control', 'Reload Window'
        );
      if (next === 'Open Output') output.show(true);
      else if (next === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      else if (next === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return {
        action: 'factory-reset' as const,
        status: verificationWarning ? 'attention' as const : 'completed' as const,
        headline: verificationWarning
          ? 'Repository factory reset; configuration check needs attention'
          : 'Repository factory reset',
        summary: verificationWarning
          ? 'The reset completed and application source was preserved. Review the post-reset check before publishing configuration.'
          : 'The current SFlow format is installed locally. Review and commit the generated configuration when it is correct.',
        repositoryPath: repository,
        details: [
          'Application source and Git history were preserved.',
          'Remote sflow/config and state branches were not changed.',
          ...(verificationWarning ? [`Post-reset check: ${verificationWarning}`] : [])
        ],
        recordedAt: new Date().toISOString()
      } satisfies WorkspaceFosOutcome;
    } catch (error) {
      showRefusal(error, { headline: 'Could not factory reset the repository' });
    }
  }));

  // Resolving the repository spawns the CLI, which on a cold start can take a noticeable while.
  // Without this the sidebar sat empty and silent for the whole of it, which reads as broken rather
  // than as busy. ProgressLocation.Window is the status-bar spinner: present, not in the way.
  const resolved = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Singularity Flow: finding the governed repository…' },
    () => resolveGovernedRepository(context, output)
  );
  if ('reason' in resolved) {
    const result = unavailable(resolved.label, resolved.reason, resolved.contextValue, resolved.lead);
    const pendingStart = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
    if (pendingStart?.step === 'work' && pendingStart.resumeOnActivation
        && resolved.contextValue === 'sflow.workspace.repositoryUnavailable') {
      void vscode.commands.executeCommand('singularityFlow.startWork');
    }
    return result;
  }
  markHostPerformance('repositoryResolved');
  // `repository` is rebound when a different workspace is chosen. Every closure below captures the
  // binding rather than the value, so they all follow — which is the point: choosing a workspace
  // used to require a window reload precisely because this was a constant.
  let { repository } = resolved;
  const repositoryEpoch = new RepositoryEpochGuard(repository);
  const { origin } = resolved;
  setActiveRepositoryContext({
    root: repository,
    workspaceId: resolved.workspaceId,
    workspaceName: resolved.workspaceName,
    repositoryId: resolved.repositoryId,
    leadRepositoryPath: resolved.leadRepositoryPath ?? repository,
    origin
  });
  resultPanelRepositoryChanged(repository);
  // Which repository this window is acting on, and why that one. Every screen below operates on it,
  // and when it was not the open folder that has to be visible rather than inferred.
  output.appendLine(`Governed repository: ${repository} (${origin})`);
  // Named in the status bar too: which workspace you are in is the one piece of context every
  // screen shares, and inferring it from a folder path in a title bar is not the same as being told.
  // Not a constant: choosing a different workspace changes it, and the status bar is where a person
  // checks which one they are in.
  let workspaceLabel = resolved.workspaceName;

  const settings = vscode.workspace.getConfiguration('singularityFlow');
  let client: SingularityFlowClient;
  try {
    client = new SingularityFlowClient({
      location: resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      }),
      repository,
      environment: () => cliEnvironment,
      onOutput: (text) => output.append(text)
    });
  } catch (error) {
    showRefusal(error);
    return unavailable('No Singularity Flow CLI was found', (error as Error).message);
  }
  // Workspace/session selection is machine-wide. Keep its reads independent of the currently
  // selected checkout so a removed or otherwise stale Story worktree cannot prevent the extension
  // from discovering the checkout that replaced it.
  const activeSelectionClient = new SingularityFlowClient({
    location: client.location,
    repository: process.cwd(),
    environment: () => cliEnvironment,
    onOutput: (text) => output.append(text)
  });
  output.appendLine(`Using CLI (${client.location.source}): ${client.location.cli}`);

  const expandReference = async (seed?: string): Promise<void> => {
    const handle = seed?.startsWith('sfref:') ? seed : await vscode.window.showInputBox({
      title: 'Expand governed reference',
      prompt: 'Paste the opaque sfref:v1 handle. The CLI verifies its exact Git revision and hash.',
      value: seed ?? '', ignoreFocusOut: true,
      validateInput: (value) => /^sfref:v1:(story|initiative):[^:]+:[a-f0-9]{12,64}$/.test(value.trim())
        ? null : 'Enter a registered sfref:v1 Story or Initiative handle.'
    });
    if (!handle) return;
    const selector = await vscode.window.showQuickPick([
      { label: 'Bounded preview', value: null },
      { label: 'Markdown section', value: 'section' },
      { label: 'JSON Pointer', value: 'json-pointer' },
      { label: 'Line or byte range', value: 'range' }
    ], { title: 'Choose the exact expansion', placeHolder: 'Expansion is explicit and recorded by the engine.' });
    if (!selector) return;
    const args = ['show', handle.trim(), '--json'];
    if (selector.value) {
      const selection = await vscode.window.showInputBox({
        title: selector.label,
        prompt: selector.value === 'range' ? 'lines:1..40 or bytes:0..4095' : undefined,
        ignoreFocusOut: true
      });
      if (!selection) return;
      args.push(`--${selector.value}`, selection.trim());
    }
    try {
      const result = await client.run<GovernedReferencePreview>(args);
      const content = [
        '# Governed reference preview', '',
        `- Handle: \`${result.handle}\``,
        `- Artifact: \`${result.reference.artifact.path}\``,
        `- Revision: \`${result.reference.revision.commitSha}\``,
        `- MIME: \`${result.mediaType}\``,
        `- Source: \`${result.source.rawSha256}\` (${result.source.rawBytes} bytes)`,
        `- Preview: \`${result.preview.sha256}\` (${result.preview.bytes} bytes; ${result.renderer.id}@${result.renderer.version})`,
        `- Truncated: ${result.truncated ? 'yes' : 'no'}`, '',
        '---', '', result.preview.text, ''
      ].join('\n');
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      showRefusal(error, { headline: 'Could not expand governed reference' });
    }
  };
  const openHarnessReport = async (): Promise<void> => {
    try {
      const report = await client.run<HarnessReport>(['harness', 'report', '--json']);
      const percent = (report.checkers.coverage * 100).toFixed(1);
      const rows = report.events.map((event) => {
        const verdict = event.checkers?.some((checker) => checker.verdict === 'fail') ? 'fail'
          : event.checkers?.some((checker) => checker.verdict === 'pass') ? 'pass' : 'not observed';
        return `| \`${event.invocationId}\` | ${event.command?.join(' ') || 'unknown'} | ${event.exitCode ?? '—'} | ${verdict} |`;
      });
      const content = [
        '# Harness imports report', '',
        `- Engine invocations: **${report.invocations}**`,
        `- Reference bytes: **${report.output.rawBytes}** raw → **${report.output.previewBytes}** rendered (**${report.output.savedBytes}** omitted)`,
        `- Deterministic checker coverage: **${percent}%**`,
        `- Host observation: **${report.hostObservations.status}**`,
        `- Host note: ${report.hostObservations.reason}`, '',
        '| Invocation | Command | Exit | Verdict |',
        '|---|---|---:|---|',
        ...(rows.length ? rows : ['| — | No harness invocations recorded in this checkout | — | not observed |']), ''
      ].join('\n');
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      showRefusal(error, { headline: 'Could not open the harness report' });
    }
  };
  // Packaged agents and skills belong to the exact engine this window is driving. Resolve them
  // beside that CLI, not beside the repository and not beside some other globally installed copy.
  const cliPackageRoot = path.resolve(path.dirname(client.location.cli), '..');
  // Now that the engine is resolved, the Help view can list the topics that engine actually ships.
  helpTree.replace(helpNodes(documentationTopicsGroup(cliPackageRoot)));

  /**
   * The last confirmed snapshot, kept per repository so the sidebar can open with content.
   *
   * Keyed by repository root: one window may be pointed at several governed repositories over its
   * life, and opening repository B on repository A's lifecycle would be worse than a blank panel.
   * The primary copy is a bounded atomic file beneath VS Code's machine-local `globalStorageUri`;
   * an older Memento copy is only a one-time compatibility fallback. Neither is synced. A repository hash prevents
   * path disclosure in storage names and makes A -> B -> A cache identity exact. Older workspace-
   * state entries are read once and migrated so an upgrade does not throw away a useful first paint.
   *
   * A read that throws — a payload written by an older build, a shape that no longer parses — is
   * treated as no cache at all. A stale-cache bug must degrade to today's behaviour, never to a
   * broken sidebar.
   */
  // `repository` is deliberately rebound by workspace selection. Resolve the key at each access so
  // a window that moves A -> B -> A never reads or overwrites another repository's last snapshot.
  const legacySnapshotCacheKey = (): string => `snapshot:${repository}`;
  const snapshotCacheKey = (): string => `singularityFlow.snapshotCache.v2.${createHash('sha256')
    .update(repository).digest('hex')}`;
  const snapshotFileCache = context.globalStorageUri?.fsPath
    ? new RepositorySnapshotFileCache<RepositorySnapshot>(context.globalStorageUri.fsPath) : null;
  const snapshotCache = {
    read: (): RepositorySnapshot | null => {
      try {
        const stored = snapshotFileCache?.read(repository);
        if (stored) return stored;
        const current = context.globalState.get<RepositorySnapshot>(snapshotCacheKey());
        if (current) {
          snapshotFileCache?.write(repository, current);
          if (snapshotFileCache) void context.globalState.update(snapshotCacheKey(), undefined);
          return current;
        }
        const legacy = context.workspaceState?.get<RepositorySnapshot>(legacySnapshotCacheKey()) ?? null;
        if (legacy) {
          if (snapshotFileCache) snapshotFileCache.write(repository, legacy);
          else void context.globalState.update(snapshotCacheKey(), legacy);
          void context.workspaceState?.update(legacySnapshotCacheKey(), undefined);
        }
        return legacy;
      }
      catch { return null; }
    },
    write: (snapshot: RepositorySnapshot): void => {
      if (snapshotFileCache) snapshotFileCache.write(repository, snapshot);
      else void context.globalState.update(snapshotCacheKey(), snapshot);
      void context.workspaceState?.update(legacySnapshotCacheKey(), undefined);
    }
  };

  // Start Work paints the last complete intake catalog at once and revalidates it. `[perf]`
  const intakeCatalogCache = context.globalStorageUri?.fsPath
    ? new IntakeCatalogCache(context.globalStorageUri.fsPath, client.location.cli) : null;
  // The watched repository's verified Git common directory, which its Story worktrees share. Only
  // used while it still describes the current repository.
  let intakeCatalogScope: { repository: string; commonDirectory: string } | null = null;
  const intakeCatalogKey = (): string => intakeCatalogScope?.repository === repository
    ? intakeCatalogScope.commonDirectory : repository;

  const store = new WorkspaceStore(client, snapshotCache);
  if (hostBenchmarkEnabled) {
    persistHostBenchmarkCache = async () => {
      if (!store.current.snapshot || store.current.stale || store.current.error) return false;
      if (snapshotFileCache) return snapshotFileCache.persist(repository, store.current.snapshot);
      await context.globalState.update(snapshotCacheKey(), store.current.snapshot);
      return true;
    };
  }
  currentHelpWork = () => {
    const item = store.current.snapshot?.workflow?.workItem;
    return item?.id ? { id: item.id, kind: item.workType ?? null } : null;
  };
  context.subscriptions.push(store);
  // An open intake form started on the Store's last snapshot; keep its in-flight list current. The
  // panels bundle is never loaded just to listen: no bundle means no open form.
  context.subscriptions.push(store.onDidChange((state) => {
    const panels = lazyPanelsRuntime;
    if (panels && state.snapshot) panels.IntakePanel.lifecycleChanged(panels.intakeInFlight(state.snapshot));
  }));
  // Registered before the tree-model listeners, so the benchmark labels the render they queue
  // with the exact projection that caused it. This is inert outside the explicit host benchmark.
  context.subscriptions.push(store.onDidChange((state, change) => {
    hostSidebarProjection = change.kind === 'cache' ? 'cache'
      : state.snapshot && !state.stale && !state.loading ? 'confirmed'
        // Starting validation does not remove the cached projection already on screen. Preserve
        // that attribution until a confirmed snapshot replaces it; only a true empty first read
        // is a loading projection.
        : change.kind === 'loading' && !state.snapshot ? 'loading' : hostSidebarProjection;
  }));
  // Only two states are worth a line of UI. `stale` is the one that matters — content restored from
  // the last session and not yet confirmed. A plain refresh over content already known to be current
  // says nothing: the tree is right, it is simply being re-checked.
  context.subscriptions.push(store.onDidChange((state) => {
    sidebar.setFreshness(state.error ? 'Workspace state could not be confirmed. Open Help & diagnostics.'
      : state.stale ? 'Showing the last known state — checking the repository…' : null);
    sidebar.setNavigation(deriveSidebarNavigation(workspaceEntries, state.stale || state.error ? null : state.snapshot,
      { loading: state.loading, verifiedContext: activeRepositoryContext() }));
    sidebar.setPendingApprovals(state.stale || state.error || !state.snapshot || state.snapshot.included && !state.snapshot.included.includes('lifecycle') ? null
      : buildApprovals(state.snapshot).pending.filter((approval) => approval.standing === 'yours').length);
    /**
     * The first read specifically, which is the one with nothing behind it.
     *
     * `primeFromCache` covers every open after the first, but the first open of a repository — and
     * every open after the cache is dropped — still has an empty store while the CLI is spawning,
     * and the sections were filling that gap with their "nothing to do" sentences.
     */
    sidebar.setAwaitingFirstRead(state.loading && !state.snapshot);
  }));
  context.subscriptions.push(store.onDidChange((_state, change) => {
    recordHostStoreEvent(change.kind);
  }));
  // After-step deliveries are read only for a Story that pinned actions, after one of its steps
  // moved. One that did not go out is said once, with a way to see why and to retry it.
  const stepActionDeliveries = new StepActionDeliveryMonitor(client, (notice, workId) => {
    void showCompactWarningMessage(notice.message, 'Show deliveries', 'Retry now').then(async (choice) => {
      if (choice === 'Show deliveries') await vscode.commands.executeCommand('singularityFlow.openJourney');
      else if (choice === 'Retry now') {
        try { void showCompactInformationMessage(await stepActionDeliveries.retry(workId, notice.keys)); }
        catch (error) { showRefusal(error, { headline: 'The deliveries were not retried' }); }
      }
    });
  });
  context.subscriptions.push(store.onDidChange((state) => {
    if (state.snapshot && !state.stale) stepActionDeliveries.observe(state.snapshot.workflow ?? null, state.snapshot.submissionReadiness?.reasonCode ?? '');
  }));
  interface WorkspaceLogsSummary {
    entries: Array<{ timestamp: string | null; severity: string }>;
    total: number;
    warnings: string[];
  }
  const refreshWorkspaceLogsTree = async (): Promise<void> => {
    if (!activeRepositoryContext()?.workspaceId) {
      logsTree.replace([{
        kind: 'action', id: 'logs:workspace-required', label: 'Workspace logs',
        description: 'select a workspace to enable', icon: 'info',
        runCommand: 'singularityFlow.openWorkspaces'
      }]);
      return;
    }
    const scope = repositoryEpoch.capture();
    try {
      const report = await client.run<WorkspaceLogsSummary>(['logs', 'workspace', '--limit', '500', '--json']);
      if (!repositoryEpoch.isCurrent(scope)) return;
      const errors = report.entries.filter((entry) => entry.severity === 'error').length;
      const warnings = report.entries.filter((entry) => entry.severity === 'warn').length;
      const latest = report.entries[0]?.timestamp;
      const latestLabel = latest && Number.isFinite(Date.parse(latest))
        ? new Date(latest).toLocaleString() : 'no timestamped events';
      logsTree.replace([{
        kind: 'action', id: 'logs:open', label: 'Open workspace logs',
        description: `${report.total} events · ${errors} errors · ${warnings} warnings`,
        tooltip: `Latest event: ${latestLabel}${report.warnings.length ? `\n${report.warnings.length} source warning(s)` : ''}`,
        icon: errors ? 'blocked' : warnings ? 'warning' : 'commit',
        runCommand: 'singularityFlow.openWorkspaceLogs'
      }, {
        kind: 'action', id: 'logs:latest', label: 'Latest event', description: latestLabel,
        icon: 'waiting', runCommand: 'singularityFlow.openWorkspaceLogs'
      }]);
    } catch (error) {
      if (!repositoryEpoch.isCurrent(scope)) return;
      logsTree.replace([{
        kind: 'action', id: 'logs:error', label: 'Workspace logs unavailable',
        description: 'open for details', tooltip: (error as Error).message,
        icon: 'warning', runCommand: 'singularityFlow.openWorkspaceLogs'
      }]);
    }
  };
  // Lifecycle commits are routinely created by Copilot CLI or a terminal while
  // the editor is open. Watch the governed tree and debounce one coherent
  // snapshot refresh so every view follows those external mutations together.
  //
  // The debounce also has to outlast the writer. A running phase writes its artifacts in a burst,
  // and a snapshot taken in the middle of one used to be refused outright — so a short window meant
  // firing repeatedly into a condition that could not yet succeed. Waiting for the burst to go quiet
  // costs a fraction of a second and collapses the whole burst into one refresh.
  const REPOSITORY_REFRESH_DEBOUNCE_MS = 750;
  let repositoryWatcher: vscode.FileSystemWatcher | null = null;
  let autoPrivateWatcher: vscode.FileSystemWatcher | null = null;
  let repositoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const repositoryWatcherFence = new RevisionSliceWatcherFence(() => repository);
  const armRepositoryRefresh = (): void => {
    if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    repositoryRefreshTimer = setTimeout(() => {
      repositoryRefreshTimer = null;
      const batch = repositoryWatcherFence.capture();
      const scope = repositoryEpoch.capture();
      void (async () => {
        if (!repositoryEpoch.isCurrent(scope)) return;
        if (await repositoryWatcherFence.matchesDelayedEcho(batch, () => client.revisionProbe())) return;
        if (!repositoryEpoch.isCurrent(scope)) return;
        repositoryWatcherFence.clearDelayedEcho();
        const autoPrivateChanged = batch.events.some((event) => event.origin === 'auto-private');
        const refreshCurrentHome = autoPrivateChanged && resultPanelIsHome({ visibleOnly: false });
        if (refreshCurrentHome) {
          // Snapshot revisions intentionally describe Git-tracked state and therefore cannot make
          // private Auto bytes part of an if-revision receipt. Invalidate the in-process gateway so
          // the current My Work document reopens the Git-common records instead of retaining its
          // prior handles. A different result stays live and is never navigated away from.
          homeRequestGeneration += 1;
          resetGatewaySession();
          lastHome = null;
        }
        await store.refresh();
        if (refreshCurrentHome && repositoryEpoch.isCurrent(scope)) {
          await vscode.commands.executeCommand('singularityFlow.myWork', { reveal: false });
        }
      })();
    }, REPOSITORY_REFRESH_DEBOUNCE_MS);
  };
  const scheduleRepositoryRefresh = (uri?: vscode.Uri): void => {
    repositoryWatcherFence.observe(uri?.fsPath);
    armRepositoryRefresh();
  };
  const scheduleAutoPrivateRefresh = (uri?: vscode.Uri): void => {
    repositoryWatcherFence.observe(uri?.fsPath, 'auto-private');
    armRepositoryRefresh();
  };

  /** One explicit mutation refresh, with an exact fence around already-observed watcher echoes. */
  const refreshAfterKnownMutation = async (): Promise<void> => {
    if (repositoryRefreshTimer) {
      clearTimeout(repositoryRefreshTimer);
      repositoryRefreshTimer = null;
    }
    await repositoryWatcherFence.reconcileExplicitRefresh(
      () => store.current.snapshot,
      () => store.refresh()
    );
    // A mismatched captured event, or any event delivered during the refresh, is still owed its own
    // read. Never let the fence for one mutation consume somebody else's later repository change.
    if (repositoryWatcherFence.hasPending) armRepositoryRefresh();
  };
  // Keep both watches narrow. Tracked lifecycle/configuration changes live under `singularity/**`;
  // Auto's private plans, authorizations, and flight records live under the repository's verified
  // Git common directory so a linked Story worktree and its main checkout see the same flight. The
  // Auto worktrees themselves are deliberately excluded: watching source/build output there would
  // recreate the whole-repository watcher storm this boundary is intended to avoid.
  let watchedGitCommonDirectory: string | null = null;
  const watchGovernedRepository = (target: string, gitCommonDirectory: string | null): void => {
    watchedGitCommonDirectory = gitCommonDirectory;
    intakeCatalogScope = gitCommonDirectory ? { repository: target, commonDirectory: gitCommonDirectory } : null;
    repositoryWatcher?.dispose();
    autoPrivateWatcher?.dispose();
    if (repositoryRefreshTimer) {
      clearTimeout(repositoryRefreshTimer);
      repositoryRefreshTimer = null;
    }
    repositoryWatcherFence.reset();
    const watcherScope = repositoryEpoch.capture();
    const scheduleGovernedForCurrentRepository = (uri?: vscode.Uri): void => {
      if (repositoryEpoch.isCurrent(watcherScope)) scheduleRepositoryRefresh(uri);
    };
    const scheduleAutoForCurrentRepository = (uri?: vscode.Uri): void => {
      if (repositoryEpoch.isCurrent(watcherScope)) scheduleAutoPrivateRefresh(uri);
    };
    repositoryWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target), 'singularity/**/*')
    );
    context.subscriptions.push(
      repositoryWatcher.onDidCreate(scheduleGovernedForCurrentRepository),
      repositoryWatcher.onDidChange(scheduleGovernedForCurrentRepository),
      repositoryWatcher.onDidDelete(scheduleGovernedForCurrentRepository)
    );
    autoPrivateWatcher = gitCommonDirectory
      ? vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
          vscode.Uri.file(gitCommonDirectory),
          'singularity-flow/{auto-plans/*.json,auto-authorizations/*.json,auto-flights/**/*.json}'
        ))
      : null;
    if (autoPrivateWatcher) {
      context.subscriptions.push(
        autoPrivateWatcher.onDidCreate(scheduleAutoForCurrentRepository),
        autoPrivateWatcher.onDidChange(scheduleAutoForCurrentRepository),
        autoPrivateWatcher.onDidDelete(scheduleAutoForCurrentRepository)
      );
    }
  };
  const initialGitCommonDirectory = await validatedRepositoryGitCommonDirectory(repository, {
    signal: extensionLifetime.signal
  }).catch((error) => {
    output.appendLine(`Auto private-state watcher unavailable: ${(error as Error).message}`);
    return null;
  });
  watchGovernedRepository(repository, initialGitCommonDirectory);
  context.subscriptions.push({
    dispose: () => {
      repositoryWatcher?.dispose();
      autoPrivateWatcher?.dispose();
      if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    }
  });
  // Capability readiness is remote-derived status (state branch and world-model availability), not
  // configuration. Read it on demand so unopened views cannot delay activation on an office VPN.
  let readiness: CapabilityReadiness = {};
  let workspaceStoryCatalog: WorkspaceStoryCatalogRow[] = [];
  let workspaceStoryCatalogIssue: string | null = null;
  let workspaceStoryCatalogWorkspacePath: string | null = null;
  let inboxRepositoryBinding: InboxRepositoryBinding | null = null;
  let configurationTree: LifecycleTreeProvider | null = null;
  const refreshReadiness = async (force = false): Promise<void> => {
    // Readiness is a remote projection of an approved capability map. A plain governed repository
    // with no map has no lead to inspect, so launching `capability leads` can only return the same
    // empty answer and delays every explicit Refresh. The confirmed snapshot is the exact local
    // authority for whether this slice exists; map creation changes its slice revision and the next
    // refresh naturally enables the remote read.
    const current = store.current;
    const capabilityMap = current.snapshot?.capabilityMap;
    if (!capabilityMap) {
      readiness = {};
      return;
    }
    const scope = repositoryEpoch.capture();
    try {
      // The confirmed snapshot already identifies the exact approved map authority. Avoid a
      // second CLI process to rediscover it; older snapshots retain the leads fallback.
      let url = !current.stale && !current.error && !capabilityMap.error
        ? capabilityMap.authorityRepository?.trim() : undefined;
      if (!url) {
        const leads = await client.run<{ url?: string }[]>(['capability', 'leads', '--json']);
        if (!repositoryEpoch.isCurrent(scope)) return;
        url = leads.find((lead) => lead.url)?.url;
      }
      if (!url) return;
      const organisation = await client.run<{ readiness?: CapabilityReadiness }>(
        ['capability', 'organisation', url, '--readiness', ...(force ? ['--refresh'] : []), '--json']);
      if (!repositoryEpoch.isCurrent(scope)) return;
      if (!organisation.readiness) return;
      readiness = organisation.readiness;
      configurationTree?.refresh();
    } catch (error) {
      if (!repositoryEpoch.isCurrent(scope)) return;
      output.appendLine(`Capability readiness could not be read: ${(error as Error).message}`);
    }
  };
  // Governed configuration is edited in ordinary tabs; saving one asks the engine whether the result
  // is still valid, so a broken workflow.yml is reported where it was typed rather than by a command
  // failing later for a reason that looks unrelated.
  context.subscriptions.push(new ConfigurationValidator(client));

  const tree = new LifecycleTreeProvider(store);
  const inboxTree = new LifecycleTreeProvider(store, [], (snapshot, error) =>
    buildInboxTree(snapshot, error, workspaceStoryCatalog, repository, workspaceStoryCatalogIssue, inboxRepositoryBinding));
  configurationTree = new LifecycleTreeProvider(
    store, [], (snapshot, error) => buildConfigurationTree(snapshot, error, readiness));
  context.subscriptions.push(tree, inboxTree, configurationTree);
  sidebar.bind('lifecycle', tree);
  sidebar.bind('inbox', inboxTree);
  sidebar.bind('configuration', configurationTree);
  const storyRefreshGate = new StoryRefreshGate();
  let postStartDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelPostStartDiscoveryTimer = (): void => {
    if (postStartDiscoveryTimer) clearTimeout(postStartDiscoveryTimer);
    postStartDiscoveryTimer = null;
  };
  context.subscriptions.push({ dispose: cancelPostStartDiscoveryTimer });
  let deferredDiscovery: AbortController | null = null;
  const cancelDeferredDiscovery = (): void => {
    deferredDiscovery?.abort();
    deferredDiscovery = null;
  };
  context.subscriptions.push({ dispose: cancelDeferredDiscovery });
  const refreshRemoteStories = ({ afterCurrent = false, refreshSnapshot = true }: {
    afterCurrent?: boolean; refreshSnapshot?: boolean;
  } = {}): Promise<void> => {
    // Explicit Refresh/attachment/map actions never wait for the advisory post-start idle hint.
    cancelPostStartDiscoveryTimer();
    cancelDeferredDiscovery();
    const scope = repositoryEpoch.capture();
    return storyRefreshGate.run(scope.epoch, async (): Promise<void> => {
      let issue: string | null = null;
      let repositoryBinding: InboxRepositoryBinding | null = null;
      try {
        const current = await activeSelectionClient.run<{
          active?: boolean; workspaceId?: string; workspacePath?: string; repositoryId?: string; repositoryPath?: string;
          canonicalRepositoryPath?: string; selectionStatus?: string;
        }>(['workspace', 'current', '--json']);
        const selectedHere = current.active && current.repositoryPath
          && path.resolve(current.repositoryPath) === path.resolve(scope.repository);
        // The active workspace file is machine-wide. Another window may have selected B while
        // this window still renders A; never join B's inventory to A's repository path.
        if (current.active && !selectedHere) {
          throw new Error('Workspace selection changed in another window. Refresh after this window follows the new selection.');
        }
        let repositories: StoryRepository[];
        let workspaceStatus: WorkspaceStatus | null = null;
        if (current.active && current.workspacePath) {
          const status = await activeSelectionClient.run<WorkspaceStatus>([
            'workspace', 'status', current.workspacePath, '--level', 'readiness', '--json'
          ]);
          workspaceStatus = status;
          repositories = status.repositories.map((entry) => ({
            id: entry.id,
            // Catalog identity is the mapped clone, not the open Story worktree.
            absolutePath: entry.absolutePath ?? '',
            state: entry.state ?? 'unknown',
            url: entry.url ?? null,
            configurationUrl: status.workspace.capabilityAuthority?.url
              ?? status.repositories.find((candidate) => candidate.id === status.workspace.leadRepository)?.url
              ?? null
          }));
        } else {
          repositories = [{
            id: activeRepositoryContext()?.repositoryId ?? path.basename(scope.repository),
            absolutePath: scope.repository,
            state: 'ready'
          }];
        }
        const catalog = await discoverWorkspaceStoryRows(repositories, async (entry) => {
          if (entry.state !== 'ready' && entry.url) {
            return activeSelectionClient.run<{
              items: Array<{ id: string; title: string; status: string; phase: string | null; branch: string | null }>;
              unavailableCount: number;
              unavailable: Array<{ code?: string; branch?: string | null; ref?: string | null; reason?: string }>;
            }>(['session', 'candidates', '--repository-url', entry.url,
              ...(entry.configurationUrl && entry.configurationUrl !== entry.url
                ? ['--configuration-url', entry.configurationUrl] : []),
              '--json', '--diagnostics']);
          }
          const verifiedRoot = await validateRepositoryDirectory(entry.absolutePath, {
            signal: extensionLifetime.signal
          });
          if (workspaceStatus && entry.id === current.repositoryId) {
            let commonDirectories: { checkout: string; mapped: string } | undefined;
            if (!sameStoryAttachPath(scope.repository, verifiedRoot)) {
              // Reuse this epoch's already-validated watcher identity. Only the canonical
              // member needs another local metadata read; no remote or per-Story probe is added.
              const checkoutCommon = watchedGitCommonDirectory
                ?? await validatedRepositoryGitCommonDirectory(scope.repository, { signal: extensionLifetime.signal });
              commonDirectories = {
                checkout: checkoutCommon,
                mapped: await validatedRepositoryGitCommonDirectory(verifiedRoot, { signal: extensionLifetime.signal })
              };
            }
            repositoryBinding = verifiedInboxRepositoryBinding(current, workspaceStatus, scope.repository, commonDirectories);
          }
          const reader = new SingularityFlowClient({
            location: client.location,
            repository: verifiedRoot,
            environment: cliEnvironment,
            onOutput: (value) => output.append(value)
          });
          return reader.run<{
            items: Array<{ id: string; title: string; status: string; phase: string | null; branch: string | null }>;
            unavailableCount: number;
            unavailable: Array<{ code?: string; branch?: string | null; ref?: string | null; reason?: string }>;
          }>(['session', 'candidates', '--json', '--diagnostics']);
        });
        if (!repositoryEpoch.isCurrent(scope)) return;
        workspaceStoryCatalog = catalog.stories;
        workspaceStoryCatalogWorkspacePath = current.active ? current.workspacePath ?? null : null;
        if (catalog.issues.length) issue = `Story discovery is incomplete: ${catalog.issues.map((entry) =>
          `${entry.repositoryId}: ${entry.message}`).join(' | ')}`;
      } catch (error) {
        if (isCliReadSuperseded(error)) return;
        issue = `Story discovery is incomplete: ${(error as Error).message}`;
      }
      if (!repositoryEpoch.isCurrent(scope)) return;
      inboxRepositoryBinding = repositoryBinding;
      workspaceStoryCatalogIssue = issue;
      // Explicit Refresh must re-read the local lifecycle even when remote discovery is offline.
      // Initial discovery follows a just-confirmed snapshot, so reading that same snapshot again
      // only adds a CLI process. The remote Story catalog is a separate Inbox projection.
      if (refreshSnapshot) await store.refresh();
      if (!repositoryEpoch.isCurrent(scope)) return;
      if (!refreshSnapshot) {
        inboxTree.refresh();
        // A closed Inbox must not load the multi-panel runtime just to refresh an absent view.
        lazyPanelsRuntime?.InboxPanel.refreshCurrent();
      }
      if (issue) throw new Error(issue);
    }, afterCurrent);
  };
  refreshStoriesAfterMapping = () => refreshRemoteStories({ afterCurrent: true });
  // Only Story discovery follows a confirmed initial snapshot. Readiness and logs stay on demand.
  // A failed initial read leaves these deferred; the first later confirmed snapshot starts them.
  let initialRefreshCompleted = false;
  let auxiliaryEpoch = -1;
  const startAuxiliaryReadsAfterConfirmedSnapshot = (forceReadiness = false): void => {
    const state = store.current;
    if (!initialRefreshCompleted || state.stale || state.error || !state.snapshot) return;
    const scope = repositoryEpoch.capture();
    if (!forceReadiness && auxiliaryEpoch === scope.epoch) return;
    auxiliaryEpoch = scope.epoch;
    // Capability readiness is demand-loaded by the capability surface or an explicit Refresh.
    // Activation/switching must not fan out remote configuration reads for unopened views.
    // The Logs section is collapsed by default and already has an Open action. Reading up to 500
    // events here delays a new window for a summary nobody has requested yet; opening that section
    // or an explicit Refresh loads it instead. A repository switch still clears the old summary.
    if (scope.epoch > 0) {
      logsTree.replace([{
        kind: 'action', id: 'logs:open', label: 'Open workspace logs',
        description: 'activity · prompts · Copilot · workspace', icon: 'commit',
        runCommand: 'singularityFlow.openWorkspaceLogs'
      }]);
    }
    const discover = (): void => { void refreshRemoteStories({ refreshSnapshot: false }).catch((error) => {
      if (isCliReadSuperseded(error)) return;
      if (repositoryEpoch.isCurrent(scope)) {
        output.appendLine(`Story discovery needs attention: ${(error as Error).message}`);
      }
    }); };
    // Discovery is optional: while the intake form is on screen it waits, for at most two minutes.
    // A forced read never waits, and an explicit refresh cancels the wait.
    const discoverWhenIdle = (): void => {
      if (forceReadiness || !backgroundWork.held) return discover();
      cancelDeferredDiscovery();
      const controller = new AbortController();
      deferredDiscovery = controller;
      output.appendLine('Story discovery waits until Start Work is closed.');
      void backgroundWork.waitUntilIdle({ signal: controller.signal }).then(() => {
        if (controller.signal.aborted || deferredDiscovery !== controller) return;
        deferredDiscovery = null;
        if (activationSignal.aborted || !repositoryEpoch.isCurrent(scope)) return;
        discover();
      });
    };
    const handoff = context.globalState.get<unknown>(STORY_START_HANDOFF_KEY);
    if (!forceReadiness && storyStartHandoffMatches(handoff, scope.repository, state.snapshot)) {
      // Confirmed core/lifecycle bytes remain the only source for actions. This one-use hint just
      // avoids a workspace-wide remote scan competing with the new Story's first paint; no ready,
      // approval, pin freshness, session, or snapshot receipt is manufactured from start output.
      void context.globalState.update(STORY_START_HANDOFF_KEY, undefined).then(() => {}, () => {});
      workspaceStoryCatalogIssue = 'Remote Story inventory has not been refreshed in this new Story window. It will refresh when idle; use Refresh Stories to check now.';
      inboxTree.refresh();
      output.appendLine('Post-start Story inventory deferred until idle; the local lifecycle has been confirmed.');
      cancelPostStartDiscoveryTimer();
      const timer = setTimeout(() => {
        if (postStartDiscoveryTimer !== timer) return;
        postStartDiscoveryTimer = null;
        if (activationSignal.aborted || !repositoryEpoch.isCurrent(scope)) return;
        discoverWhenIdle();
      }, STORY_START_DISCOVERY_IDLE_MS);
      postStartDiscoveryTimer = timer;
      postStartDiscoveryTimer.unref?.();
      return;
    }
    discoverWhenIdle();
  };
  context.subscriptions.push(store.onDidChange((state, change) => {
    if (change.kind !== 'snapshot' || state.stale || state.error || !state.snapshot) return;
    startAuxiliaryReadsAfterConfirmedSnapshot();
  }));

  /**
   * What the home says, for the chrome that is always on screen. `[UXH:AC-002]` `[DHR:REQ-070]`
   *
   * The gate count already comes from the card's own derivation, which is half of AC-002. The other
   * half is the two facts the home computes and the status bar never showed:
   *
   *   - **Recovery required.** `[DHR:REQ-070]` rule 1, the highest-priority state in the whole
   *     ordering — a half-finished publication, and the one situation where doing something else
   *     first can lose work. The home promotes it above everything; the status bar rendered the
   *     ordinary "Story · phase" beside it.
   *   - **Decisions waiting on you.** Somebody is blocked on this reader's approval. The home counts
   *     it and names it separately from their own work, because "you have work in progress" and
   *     "you are the blocker" are different obligations.
   *
   * Reading the same envelope rather than recomputing from `store.snapshot` is the point. Two
   * surfaces that each decide what is most important will eventually disagree about it, and the one
   * that is always visible is the one a reader trusts.
   */
  const statusChromeWorker = new GatewayStatusWorker(context.extensionPath);
  context.subscriptions.push(statusChromeWorker);
  const statusChromeFor = async (workId: string | null, scope: RepositoryEpochToken) => {
    if (!repositoryEpoch.isCurrent(scope)) return null;
    const active = activeRepositoryContext();
    if (!active || path.resolve(active.root) !== scope.repository) return null;
    const chrome = await statusChromeWorker.read(active, workId, currentHomeLens());
    return repositoryEpoch.isCurrent(scope) ? chrome : null;
  };

  /** Which Story the status bar is currently about, so a late gate count can be discarded. */
  let statusWorkId: string | null = null;
  let statusChromeCache: {
    repository: string;
    workId: string | null;
    value: NonNullable<Awaited<ReturnType<typeof statusChromeFor>>>;
  } | null = null;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  /**
   * The status bar returns you to your work; it does not refresh it. `[UXH:REQ-040]`
   *
   * It was wired to `singularityFlow.refresh`, so the one always-visible piece of SFlow chrome
   * answered a click by re-reading the repository and leaving the reader exactly where they were.
   * Refresh is a thing you ask for when you believe the screen is stale; it is not what "take me
   * back" means, and it is not what a persistent indicator is for.
   */
  status.command = 'singularityFlow.myWork';
  context.subscriptions.push(status);
  context.subscriptions.push(store.onDidChange((state, change) => {
    if (state.loading) { status.text = '$(loading~spin) Singularity Flow'; status.show(); return; }
    if (state.error) { status.text = '$(error) Singularity Flow'; status.tooltip = state.error.message; status.show(); return; }
    const initiative = state.snapshot?.initiative;
    const workflow = state.snapshot?.workflow;
    const where = workspaceLabel ? `${workspaceLabel} · ` : '';
    if (workflow) {
      // A Story with no current phase has decided every step or was cancelled; neither is evidence
      // that it is complete, which only the final governance check can say.
      const phase = workflow.currentPhase
        ?? ((workflow as { status?: string }).status === 'cancelled' ? 'cancelled' : 'every step decided');
      status.text = `$(git-pull-request) ${workflow.workItem.id} · ${phase}`;
      status.tooltip = `${where}${workflow.workItem.title ?? 'Governed Story workflow'}`;
      status.show();
      // Cached content is useful first paint, but it is not authority for new repository reads.
      // Invalidate late work from the previous Story immediately and wait for the confirmed
      // snapshot before launching the two kernel derivations below.
      statusWorkId = workflow.workItem.id;
      if (state.stale) return;
      /**
       * The gate count, from the same derivation the card uses. `[UXH:AC-002]`
       *
       * Screen B has the status bar reading `gates 3/5` beside a card reading "2 of 5 gates unmet".
       * Those are one fact shown twice, and two surfaces that each count for themselves will
       * eventually disagree — usually the day the meaning of "unknown" changes for one of them. So
       * this asks the kernel for the readiness envelope and runs `gateSummary` over it, which is
       * the function the card calls.
       *
       * Fire-and-forget, and it only ever *adds* to a status bar that already rendered. A gate
       * count that arrives late is worth having; a status bar that waits for it is not.
       */
      const renderedFor = workflow.workItem.id;
      const renderedScope = repositoryEpoch.capture();
      statusWorkId = renderedFor;
      const renderStatusChrome = (home: NonNullable<Awaited<ReturnType<typeof statusChromeFor>>>) => {
        const gates = home.gates;
        if (gates) {
          status.text = `$(git-pull-request) ${workflow.workItem.id} · ${phase} · gates ${gates.met}/${gates.total}`;
          status.tooltip = `${where}${workflow.workItem.title ?? 'Governed Story workflow'}`
            + `\n${gates.unmet} unmet, ${gates.outstanding - gates.unmet} not evaluated`;
        }
        if (home.recoveryWorkId) {
          status.text = `$(warning) ${home.recoveryWorkId} · finish publishing`;
          status.tooltip = `${where}A publication was interrupted and is not finished.`
            + '\nDoing anything else first can lose work.'
            + (home.leads ? `\nNext: ${home.leads}` : '');
          return;
        }
        if (home.decisions) {
          // Appended, not substituted: their own work is still what they came here for.
          status.text = `${status.text} · $(person) ${home.decisions}`;
          status.tooltip = `${status.tooltip}`
            + `\n${home.decisions} decision(s) are waiting on you.`;
        }
      };
      const cached = statusChromeCache?.repository === renderedScope.repository
        && statusChromeCache.workId === renderedFor ? statusChromeCache.value : null;
      if (change.kind === 'snapshot' && !change.revisionChanged && cached) {
        renderStatusChrome(cached);
        return;
      }
      void trackHostBackgroundTask(statusChromeFor(renderedFor, renderedScope)).then((home) => {
        // Discard a count that arrived after the reader moved on: a gate total from the previous
        // Story rendered beside the current one is worse than no count at all.
        if (!home || !repositoryEpoch.isCurrent(renderedScope) || statusWorkId !== renderedFor) return;
        statusChromeCache = { repository: renderedScope.repository, workId: renderedFor, value: home };
        renderStatusChrome(home);
      });
      return;
    }
    if (!initiative) {
      status.text = `$(rocket) ${where}No work`;
      status.tooltip = workspaceLabel
        ? `Working in ${workspaceLabel}. Nothing governed is checked out on this branch.`
        : 'Nothing governed is checked out on this branch.';
      status.show();
      /**
       * Having nothing checked out does not mean nothing is waiting on you. `[DHR:REQ-062]`
       *
       * This branch read as "No work" while approvals sat in the reader's queue — the state a
       * person is most likely to be in when they have just finished something, and exactly when
       * being told they are the blocker is most useful.
       */
      statusWorkId = null;
      if (state.stale) return;
      const renderedScope = repositoryEpoch.capture();
      const cached = statusChromeCache?.repository === renderedScope.repository
        && statusChromeCache.workId === null ? statusChromeCache.value : null;
      if (change.kind === 'snapshot' && !change.revisionChanged && cached) {
        if (cached.decisions) {
          status.text = `$(person) ${where}${cached.decisions} waiting on you`;
          status.tooltip = `${cached.decisions} decision(s) are waiting on you.`
            + '\nNothing governed is checked out on this branch.';
        }
        return;
      }
      void trackHostBackgroundTask(statusChromeFor(null, renderedScope)).then((home) => {
        if (!home || !repositoryEpoch.isCurrent(renderedScope) || statusWorkId !== null) return;
        statusChromeCache = { repository: renderedScope.repository, workId: null, value: home };
        if (!home.decisions) return;
        status.text = `$(person) ${where}${home.decisions} waiting on you`;
        status.tooltip = `${home.decisions} decision(s) are waiting on you.`
          + '\nNothing governed is checked out on this branch.';
      });
      return;
    }
    statusWorkId = null;
    const phase = initiative.state.currentPhase ?? 'complete';
    status.text = `$(rocket) ${initiative.state.initiative.id} · ${phase}`;
    status.tooltip = initiative.nextActions?.[0]?.reason ?? 'Singularity Flow';
    status.show();
  }));

  /**
   * Follow the chosen workspace, in place.
   *
   * Everything that knows which repository this window acts on is re-pointed here, in one list, so
   * that adding a screen which reads the repository means adding it to this list and not
   * discovering months later that it kept answering about the previous workspace.
   *
   * A workspace whose lead has never been cloned is a real state — the registry is machine-wide and
   * a colleague's workspace can name a directory this machine does not have — so it is reported
   * rather than switched to, and the previous workspace stays selected in the editor.
   */
  workspaceSelected.push(async (selected) => {
    const target = path.resolve(selected.repositoryPath);
    let canonicalTarget: string;
    let targetGitCommonDirectory: string | null;
    try {
      canonicalTarget = await validateRepositoryDirectory(target, { signal: extensionLifetime.signal });
      targetGitCommonDirectory = await validatedRepositoryGitCommonDirectory(canonicalTarget, {
        signal: extensionLifetime.signal
      });
    } catch (error) {
      if (selected.navigationIsCurrent && !await selected.navigationIsCurrent()) return;
      void showCompactWarningMessage(
        `${selected.workspaceName} is recorded as your workspace, but this window is still acting on ${path.basename(repository)}: ${(error as Error).message}`);
      return;
    }
    const leadRepositoryPath = await workspaceLeadDirectory(selected.workspacePath) ?? canonicalTarget;
    if (selected.navigationIsCurrent && !await selected.navigationIsCurrent()) return;
    repositoryEpoch.moved(canonicalTarget);
    const selectionEpoch = repositoryEpoch.capture();
    repository = canonicalTarget;
    workspaceStoryCatalog = [];
    workspaceStoryCatalogIssue = null;
    workspaceStoryCatalogWorkspacePath = null;
    inboxRepositoryBinding = null;
    resultPanelRepositoryChanged(canonicalTarget);
    client.useRepository(canonicalTarget);
    watchGovernedRepository(canonicalTarget, targetGitCommonDirectory);
    workspaceLabel = selected.workspaceName;
    lastHome = null;
    setActiveRepositoryContext({
      root: canonicalTarget,
      workspaceId: selected.workspaceId,
      workspaceName: selected.workspaceName,
      repositoryId: selected.repositoryId,
      leadRepositoryPath,
      origin: `the selected repository of your active workspace, ${selected.workspaceName}`
    });
    readiness = {};
    statusWorkId = null;
    // Publish B's cache only after every repository-aware closure points at B. Store listeners may
    // render synchronously; none of them may observe B data through A's gateway/session context.
    store.repositoryChanged();
    inboxTree.refresh();
    lazyPanels().InboxPanel.refreshCurrent();
    await store.refresh();
    if (!repositoryEpoch.isCurrent(selectionEpoch)
      || (selected.navigationIsCurrent && !await selected.navigationIsCurrent())) return;
    diagnosticHasRepository = true;
    diagnosticClient.useRepository(canonicalTarget);
    const {
      GoalsPanel, FaultRepairsPanel, JournalPanel, DiagnosticsPanel, AstIntelligencePanel
    } = lazyPanels();
    GoalsPanel.repositoryChanged(); FaultRepairsPanel.repositoryChanged(); JournalPanel.repositoryChanged(); DiagnosticsPanel.refreshCurrent(); AstIntelligencePanel.repositoryChanged();
    startAuxiliaryReadsAfterConfirmedSnapshot();
    output.appendLine(`Governed repository: ${repository} (the selected repository of your active workspace, ${selected.workspaceName})`);
  });

  /**
   * Follow Story or workspace selections made outside this extension host.
   *
   * Copilot skills and terminal commands update the same machine-wide active-workspace record as
   * the Workspaces screen. Previously only the screen called `workspaceSelected`, so `/sf-session`
   * could attach a Story successfully while Lifecycle, Inbox, and Work Journey kept reading the
   * previous checkout until VS Code was reloaded. Read the authoritative CLI projection again and
   * reuse the one rebind path above; no surface gets to maintain its own idea of the active Story.
   */
  const ACTIVE_SELECTION_REFRESH_DEBOUNCE_MS = 250;
  const activeSelectionFile = workspaceSelectionFile;
  // Repository resolution has already consumed this exact selector. Keep its content revision so
  // steady-state Refresh can go directly to the repository snapshot. If the file cannot be read,
  // `undefined` deliberately preserves the existing CLI check on every request.
  let activeSelectionRevision = await machineSelectionRevision(activeSelectionFile);
  let selectionReconciliation: Promise<boolean> | null = null;
  // A Story start moves the machine-wide selection to its new checkout before it returns. Following
  // that here would rebind this window before the start decides to open the checkout, so a change
  // seen while a start is in flight waits, and is reconciled once the start has finished.
  let navigationHolds = 0;
  let navigationDeferred = false;
  const holdNavigation = (): { release(): void } => {
    navigationHolds += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        navigationHolds -= 1;
        if (navigationHolds || !navigationDeferred) return;
        navigationDeferred = false;
        void reconcileActiveWorkspaceSelection();
      }
    };
  };
  const reconcileActiveWorkspaceSelection = async (): Promise<boolean> => {
    if (navigationHolds) {
      if (!navigationDeferred) {
        output.appendLine('The active selection changed during a Story start; it is followed once the start finishes.');
      }
      navigationDeferred = true;
      return false;
    }
    if (selectionReconciliation) return selectionReconciliation;
    const reconciliation = (async (): Promise<boolean> => {
      const observedSelectionRevision = await machineSelectionRevision(activeSelectionFile);
      if (observedSelectionRevision !== undefined
        && observedSelectionRevision === activeSelectionRevision) return false;
      try {
        const current = await activeSelectionClient.run<{
          active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
          repositoryId?: string; repositoryPath?: string; repositoryState?: string;
          selectionStatus?: string; storyId?: string | null;
        }>(['workspace', 'current', '--json']);
        // The CLI completed an authoritative read, so this exact file revision is now reconciled
        // even when it describes no active workspace or retains the current repository.
        if (observedSelectionRevision !== undefined) activeSelectionRevision = observedSelectionRevision;
        if (current.active === false || current.repositoryState && current.repositoryState !== 'ready'
          || current.selectionStatus && current.selectionStatus !== 'ready') return false;
        if (!current.repositoryPath || !current.workspacePath) return false;
        const target = path.resolve(current.repositoryPath);
        if (target === path.resolve(repository)) return false;
        const selected: SelectedWorkspace = {
          workspaceId: current.workspaceId ?? current.workspacePath,
          workspaceName: current.workspaceName ?? current.workspaceId ?? path.basename(current.workspacePath),
          repositoryId: current.repositoryId ?? null,
          repositoryPath: target,
          workspacePath: current.workspacePath
        };
        output.appendLine(`Active selection changed outside VS Code${current.storyId ? ` to Story ${current.storyId}` : ''}; following ${target}.`);
        await refreshWorkspaceTree();
        const { WorkspacesPanel } = lazyPanels();
        await WorkspacesPanel.activeWorkspaceChanged(current.workspacePath);
        for (const follow of workspaceSelected) await follow(selected);
        return path.resolve(repository) === target;
      } catch (error) {
        // A background synchronization failure must not interrupt editing. The explicit Refresh
        // action remains available, and the output channel keeps the exact diagnostic.
        output.appendLine(`Could not synchronize the active Story selection: ${(error as Error).message}`);
        return false;
      }
    })();
    selectionReconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (selectionReconciliation === reconciliation) selectionReconciliation = null;
    }
  };

  const activeSelectionWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(activeSelectionFile)), path.basename(activeSelectionFile))
  );
  let activeSelectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleActiveSelectionRefresh = (): void => {
    if (activeSelectionRefreshTimer) clearTimeout(activeSelectionRefreshTimer);
    activeSelectionRefreshTimer = setTimeout(() => {
      activeSelectionRefreshTimer = null;
      void reconcileActiveWorkspaceSelection();
    }, ACTIVE_SELECTION_REFRESH_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    activeSelectionWatcher.onDidCreate(scheduleActiveSelectionRefresh),
    activeSelectionWatcher.onDidChange(scheduleActiveSelectionRefresh),
    activeSelectionWatcher.onDidDelete(scheduleActiveSelectionRefresh),
    {
      dispose: () => {
        activeSelectionWatcher.dispose();
        if (activeSelectionRefreshTimer) clearTimeout(activeSelectionRefreshTimer);
      }
    }
  );

  /**
   * Run whatever a node offers, then refresh so every view reflects what just happened.
   *
   * Approvals take the receipt path; everything else is a plain command. They are different enough
   * to be worth distinguishing here rather than papering over with one code path.
   */
  const runNode = async (node?: TreeNode): Promise<void> => {
    if (node?.approve) {
      if (await approveWithReceipt(client, node.approve, output)) await refreshAfterKnownMutation();
      return;
    }
    if (!node?.command) return;
    // A suggested command may carry `<PATH>`-style placeholders meant for a person to fill in.
    // Running them literally passes the placeholder to the CLI, which then fails on a file of that
    // name — a failure that says nothing about what was actually wanted.
    const publishScope = repositoryEpoch.capture();
    const argv = await resolvePlaceholders(node.command, repository);
    if (!argv) return;
    if (argv[0] === 'phase' && argv[1] === 'publish') {
      const workflow = store.current.snapshot?.workflow;
      const checkoutIssue = storyCheckoutIssue(repository, store.current.snapshot, workflow);
      if (checkoutIssue) {
        const choice = await showCompactWarningMessage(
          `Cannot publish ${checkoutIssue.workId} from this checkout.`,
          {
            modal: true,
            detail: `${checkoutIssue.message}\n\nRegistered branch(es): ${checkoutIssue.allowedBranches.join(', ') || 'none'}.`
          },
          'Open Story checkout'
        );
        if (choice === 'Open Story checkout') {
          await runNode({
            kind: 'action', id: `story:${checkoutIssue.workId}:attach`,
            label: `Open ${checkoutIssue.workId}`,
            command: ['session', 'attach', checkoutIssue.workId]
          });
        }
        return;
      }
      const unsaved = unsavedRepositoryPaths(vscode.workspace.textDocuments ?? [], repository);
      if (unsaved.length) {
        const choice = await showCompactWarningMessage(
          `Save ${unsaved.length} edited file${unsaved.length === 1 ? '' : 's'} before publishing this generation.`,
          {
            modal: true,
            detail: `${unsaved.slice(0, 20).join('\n')}${unsaved.length > 20 ? `\n… and ${unsaved.length - 20} more` : ''}\n\nGit and Singularity Flow can bind only saved bytes.`
          },
          'Save all and continue'
        );
        if (choice !== 'Save all and continue') return;
        await vscode.commands.executeCommand('workbench.action.files.saveAll');
        const remaining = unsavedRepositoryPaths(vscode.workspace.textDocuments ?? [], repository);
        if (remaining.length) {
          void showCompactWarningMessage(
            `Publication stopped because ${remaining.length} repository file${remaining.length === 1 ? ' is' : 's are'} still unsaved.`
          );
          return;
        }
      }
      const phaseId = argv[2];
      if (!phaseId || !workflow?.workItem?.id || workflow.currentPhase !== phaseId) {
        void showCompactWarningMessage(
          'Publication stopped because the selected Story phase is no longer current. Refresh Lifecycle and choose the phase again.'
        );
        return;
      }
      try {
        const checkedRepository = repository;
        if (!repositoryEpoch.isCurrent(publishScope)) {
          void showCompactWarningMessage(
            'Publication stopped because the selected repository changed. Refresh Lifecycle and try again.'
          );
          return;
        }
        const result = await client.run<unknown>(['phase', 'prepublish', phaseId, '--json']);
        const currentWorkflow = store.current.snapshot?.workflow;
        if (!repositoryEpoch.isCurrent(publishScope) || repository !== checkedRepository
            || currentWorkflow?.workItem?.id !== workflow.workItem.id
            || currentWorkflow.currentPhase !== phaseId) {
          void showCompactWarningMessage(
            'Publication stopped because the selected repository or Story changed during the phase check. Refresh Lifecycle and try again.'
          );
          return;
        }
        const gate = phasePrepublishDecision(result, {
          workId: workflow.workItem.id, phaseId
        });
        if (!gate.ready) {
          output.appendLine(`\n$ singularity-flow phase prepublish ${phaseId} --json`);
          output.appendLine(gate.headline);
          for (const detail of gate.details) output.appendLine(`- ${detail}`);
          const correctionPrefill = phaseGenerationChatPrefill(gate.skill);
          const choice = await showCompactWarningMessage(
            `${gate.headline}${gate.details[0] ? ` ${gate.details[0]}` : ''}`,
            ...(correctionPrefill ? ['Fix in Copilot'] : []),
            'Show correction steps'
          );
          if (choice === 'Show correction steps') output.show(true);
          if (choice === 'Fix in Copilot' && correctionPrefill
              && repositoryEpoch.isCurrent(publishScope)
              && repository === checkedRepository
              && store.current.snapshot?.workflow?.workItem?.id === workflow.workItem.id
              && store.current.snapshot?.workflow?.currentPhase === phaseId) {
            // A partial prefill offers the engine-selected phase owner; the click executes nothing.
            await vscode.commands.executeCommand('workbench.action.chat.open', correctionPrefill);
          }
          return;
        }
        // Advisories never block: publish, and say what the documentation check found.
        if (gate.advisories.length) {
          output.appendLine(`\nDocumentation advisories for ${phaseId} (never block publication):`);
          for (const advisory of gate.advisories) output.appendLine(`- ${advisory}`);
          void showCompactInformationMessage(
            `Publishing ${phaseId}. Documentation: ${gate.advisories[0]}${gate.advisories.length > 1 ? ` (+${gate.advisories.length - 1} more)` : ''}`,
            'Show advisories'
          ).then((choice) => { if (choice === 'Show advisories') output.show(true); });
        }
      } catch (error) {
        showRefusal(error, { headline: `Could not check ${phaseId} before publication` });
        return;
      }
    }
    // A registered local Story checkout may contain unpublished work ahead of its remote. Opening
    // that checkout must not be misrepresented as a remote attachment (which correctly refuses
    // ahead history). First ask the engine to prove an existing managed checkout without Git
    // synchronization; only a genuine local miss may fall through to the strict remote attach.
    // Both routes return the verified repositoryPath that this window must open.
    if (argv[0] === 'session' && argv[1] === 'attach') {
      try {
        let args = argv.includes('--json') ? argv : [...argv, '--json'];
        // A Story card carries only its repository ID. Resolve it against the extension's trusted
        // catalog, then the current workspace manifest. Never accept a webview path as a clone or
        // checkout target, and never fall back to the current tab for a deferred repository.
        const catalogStory = node.storyRepositoryId
          ? selectedCatalogStory(workspaceStoryCatalog, {
            workId: argv[2] ?? '', repositoryId: node.storyRepositoryId
          }) : null;
        let attachmentRoot: string;
        if (catalogStory) {
          const current = await activeSelectionClient.run<{
            active?: boolean; workspaceId?: string; workspacePath?: string;
          }>(['workspace', 'current', '--json']);
          if (current.active && current.workspacePath) {
            if (!workspaceStoryCatalogWorkspacePath
              || !sameStoryAttachPath(workspaceStoryCatalogWorkspacePath, current.workspacePath)) {
              throw new Error('Workspace selection changed after Story discovery. Refresh Stories and select it again.');
            }
            const status = await activeSelectionClient.run<WorkspaceStatus>([
              'workspace', 'status', current.workspacePath, '--level', 'readiness', '--json'
            ]);
            verifiedWorkspaceStoryRepository(catalogStory, current, status);
            // The CLI preflights the exact remote Story before materializing this one mapped
            // repository. Explicit selectors avoid changing machine-wide workspace selection or
            // accidentally resolving the same Story ID in a different open checkout.
            args = [...args, '--workspace', status.workspace.path,
              '--repository', catalogStory.repositoryId];
            attachmentRoot = status.workspace.path;
          } else {
            if (!catalogStory.repositoryPath) {
              throw new Error('Select the workspace that owns this remote-only Story, then refresh Stories. No repository was cloned.');
            }
            attachmentRoot = await validateRepositoryDirectory(catalogStory.repositoryPath, {
              signal: extensionLifetime.signal
            });
          }
        } else {
          attachmentRoot = node.openPath
            ? await validateRepositoryDirectory(node.openPath, { signal: extensionLifetime.signal })
            : repository;
        }
        const attachmentClient = attachmentRoot === repository ? client : new SingularityFlowClient({
          location: client.location, repository: attachmentRoot, environment: cliEnvironment,
          onOutput: (value) => output.append(value)
        });
        const attached = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Opening ${argv[2] ?? 'Story'}…` },
          async () => {
            type StorySelection = {
              workId?: string; repositoryPath?: string; branch?: string; phase?: string; status?: string;
              localOnly?: boolean;
            };
            try {
              return await attachmentClient.run<StorySelection>([
                'session', 'open-local', ...args.slice(2)
              ]);
            } catch (error) {
              const refusal = error instanceof CliError && error.result
                && typeof error.result === 'object'
                ? (error.result as { error?: { code?: unknown } }).error?.code : null;
              if (!['SESSION_LOCAL_STORY_UNAVAILABLE', 'SESSION_LOCAL_REPOSITORY_UNAVAILABLE'].includes(
                String(refusal ?? '')
              )) throw error;
              return attachmentClient.run<StorySelection>(args);
            }
          }
        );
        const checkout = attached.repositoryPath ? path.resolve(attached.repositoryPath) : null;
        if (!checkout) {
          showRefusal('Story attachment completed without a repositoryPath.', {
            headline: 'Could not open the selected Story checkout'
          });
          return;
        }
        if (checkout !== path.resolve(repository)) {
          if (node.openCopilotAfterAttach && attached.workId) {
            const pending: PendingCopilotHandoff = {
              kind: 'story', repository: checkout, workId: attached.workId,
              requestedAt: new Date().toISOString()
            };
            await context.globalState.update(COPILOT_HANDOFF_KEY, pending);
          }
          void showCompactInformationMessage(
            `Story ${attached.workId ?? argv[2]} is ready in its isolated checkout${attached.localOnly ? ' (local work preserved; remote not synchronized)' : ''}. Opening it now.`
          );
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(checkout), false);
          return;
        }
        await refreshAfterKnownMutation();
        if (node.openCopilotAfterAttach && attached.workId) await openGovernedCopilot(attached.workId);
      } catch (error) {
        output.appendLine(`Story attachment failed: ${(error as Error).message}`);
        showRefusal(error, { headline: `Could not attach Story ${argv[2] ?? ''}`.trim() });
      }
      return;
    }
    const ran = await runGovernedAction(client, {
      command: argv,
      title: node.confirmation?.summary ?? `singularity-flow ${formatCliArgsForDisplay(argv)}`,
      ...(node.confirmation ? { confirmation: node.confirmation } : {})
    }, output);
    if (ran) await refreshAfterKnownMutation();
  };

  /** Named Story commands work both from a phase row and directly from the command palette. */
  const runStoryPhase = async (
    action: 'prepare' | 'publish' | 'submit', node?: TreeNode
  ): Promise<void> => {
    const workflow = store.current.snapshot?.workflow;
    const phaseId = workflow?.currentPhase;
    if (!workflow || !phaseId) {
      void showCompactWarningMessage('No governed Story phase is active in this workspace.');
      return;
    }
    if (action === 'submit') {
      const readiness = store.current.snapshot?.submissionReadiness;
      const command = readiness?.lifecycleReady === true
        ? submissionCommandArgv(readiness, phaseId)
        : null;
      if (!command) {
        void showCompactWarningMessage(
          'Submit is unavailable until the current phase has an exact recorded publication. Refresh Lifecycle for the legal next action.'
        );
        return;
      }
      // The decision after this phase reads values recorded with the submission; ask for them first.
      const decisionValues = await askDecisionValues(readiness?.decisionInputs ?? []);
      if (!decisionValues) return;
      return runNode({
        kind: 'action', id: `story:${phaseId}:submit`, label: `submit ${phaseId}`,
        command: submitArgvWithDecisionValues(command, decisionValues)
      });
    }
    if (node?.command) return runNode(node);
    const command = action === 'prepare'
      ? ['prepare', phaseId]
      : ['phase', 'publish', phaseId];
    await runNode({
      kind: 'action', id: `story:${phaseId}:${action}`,
      label: `${action} ${phaseId}`, command
    });
  };

  /** Resolve a webview's artifact id against the snapshot; ids from a page are never paths. */
  const nodeForOutput = (artifactId: string): TreeNode | null => {
    const snapshot = store.current.snapshot;
    const journey = buildJourney(snapshot);
    const stage = journey.stages.find((candidate) =>
      candidate.artifacts.some((artifact) => artifact.id === artifactId));
    const artifact = stage?.artifacts.find((candidate) => candidate.id === artifactId);
    if (!stage || !artifact) return null;
    const initiative = snapshot?.initiative;
    const output = artifact.subjectId
      ? initiative?.state.phases[artifact.phaseId]?.outputs?.[artifact.subjectId]
      : null;
    return {
      kind: 'artifact',
      id: artifact.id,
      label: artifact.label,
      path: artifact.path,
      readOnly: stage.approved || artifact.status === 'approved',
      ...(output?.sha256 && output.status !== 'approved' ? {
        approve: {
          kind: 'initiative',
          initiativeId: initiative?.state.initiative.id ?? '',
          subject: output.id,
          expected: `${artifact.phaseId}:${output.id}`,
          summary: `Approve ${output.label ?? output.id}`
        }
      } : {})
    };
  };

  /**
   * The values a phase records for the decision after it, asked with that decision's own choices.
   * Returns an empty object when there is nothing to ask, and null when the person cancels.
   */
  const askDecisionValues = async (inputs: DecisionInputSpec[]): Promise<Record<string, string> | null> => {
    const values: Record<string, string> = {};
    for (const input of inputs) {
      const prompt = decisionInputPrompt(input);
      const answer = prompt.choices
        ? await vscode.window.showQuickPick(prompt.choices, {
          title: prompt.title, placeHolder: 'The decision after this step reads this value', ignoreFocusOut: true
        })
        : await vscode.window.showInputBox({
          title: prompt.title, prompt: 'The decision after this step reads this number', ignoreFocusOut: true,
          validateInput: prompt.validate
        });
      if (answer === undefined || !answer.trim()) return null;
      values[input.name] = answer.trim();
    }
    return values;
  };

  /**
   * A person's choice at a waiting workflow decision.
   *
   * The question is read fresh from the engine, so the choice is bound (`--expected`) to exactly what
   * the person saw; they pick an option, or any step when the decision allows it, and say why. The
   * engine checks their group and applies the route; nothing here decides anything itself.
   */
  const chooseStoryDecision = async (requestedWorkId?: string | null, optionId?: string | null): Promise<void> => {
    const workId = requestedWorkId || store.current.snapshot?.workflow?.workItem.id || null;
    if (!workId) {
      showRefusal('Select the Story whose decision you want to answer.', { headline: 'No Story selected' });
      return;
    }
    let view: StoryDecisionView;
    try { view = await client.run<StoryDecisionView>(['decision', 'show', workId, '--json']); }
    catch (error) {
      showRefusal((error as Error).message, { headline: 'Could not read the decision' });
      return;
    }
    const pending = view.pending;
    if (!pending) {
      void showCompactInformationMessage(`${workId} is not waiting for a decision.`);
      return;
    }
    let choice: { option?: string; to?: string; label: string } | null = null;
    const named = optionId && optionId !== '__step__' ? pending.options.find((option) => option.id === optionId) : null;
    if (named) choice = { option: named.id, label: named.label };
    else {
      const items = decisionChoiceItems(pending);
      const picked = optionId === '__step__'
        ? items.find((item) => item.anyStep)
        : await vscode.window.showQuickPick(items, { title: pending.label, placeHolder: pendingDecisionSummary(pending), ignoreFocusOut: true });
      if (!picked) return;
      if (picked.anyStep) {
        const workflow = store.current.snapshot?.workflow;
        const steps = (workflow?.phaseOrder ?? []).map((id) => ({ label: workflow?.phases[id]?.label ?? id, description: id, to: id }))
          .concat([{ label: 'Finish the Story', description: 'end', to: 'end' }]);
        const step = await vscode.window.showQuickPick(steps, { title: `${pending.label}: choose a step`, ignoreFocusOut: true });
        if (!step) return;
        choice = { to: step.to, label: step.label };
      } else if (picked.option) choice = { option: picked.option, label: picked.label };
    }
    if (!choice) return;
    const reason = await vscode.window.showInputBox({
      title: `${pending.label}: ${choice.label}`,
      prompt: 'Why this choice? It is recorded in the Story with your name.',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'A reason is required.')
    });
    if (!reason?.trim()) return;
    await runNode({
      kind: 'action', id: `story:decision:${pending.decision}`, label: `Choose '${choice.label}'`,
      command: decisionChooseArgv(workId, pending, choice, reason)
    });
  };

  const onJourneyMessage = async (message: JourneyMessage): Promise<void> => {
    if (message.type === 'pin') return addSource();
    if (message.type === 'decide') return chooseStoryDecision(null, message.option);
    if (message.type === 'run') {
      const journey = buildJourney(store.current.snapshot);
      if (journey.nextAction?.execution === 'decide') return chooseStoryDecision(journey.id, null);
      if (journey.nextAction?.execution === 'prefill') {
        return vscode.commands.executeCommand('singularityFlow.prefillStoryPhaseGeneration', {
          kind: 'action', id: 'story:journey:generate', label: journey.nextAction.label ?? 'Generate phase',
          prefill: journey.nextAction.skill
        });
      }
      if (journey.nextAction?.execution === 'run') {
        // A phase that feeds a decision records its values when it is submitted: ask with the
        // decision's own choices, then run exactly the validated command with them filled in.
        const decisionValues = await askDecisionValues(journey.nextAction.decisionInputs ?? []);
        if (!decisionValues) return;
        return runNode({
          kind: 'action', id: `${journey.kind}:journey:next`,
          label: journey.nextAction.label ?? journey.nextAction.reason,
          command: submitArgvWithDecisionValues(journey.nextAction.argv, decisionValues)
        });
      }
      return;
    }
    const node = nodeForOutput(message.outputId);
    if (!node) return;
    if (message.type === 'open') return openArtifact(repository, node);
    await runNode(node);
  };

  /**
   * Start work: an Initiative, an Epic or a Story, with or without a tracker.
   *
   * Every answer is asked for; none is guessed. The profile and the governed agent come from the
   * repository's own configuration rather than a list this file keeps, so a portfolio that adds a
   * profile offers it here without the extension being changed.
   */
  const startWork = async (defaults: {
    shape?: 'initiative' | 'epic' | 'story' | null;
    source?: 'jira' | 'github-issue' | 'manual' | null;
    workType?: string | null;
    summary?: string | null;
    guidedStart?: boolean;
    workspaceName?: string | null;
  } = {}): Promise<void> => {
    // An Initiative or an Epic starts in this checkout, so asked for directly it refreshes before
    // asking anything: `start` refuses a dirty tree, and discovering that only after somebody
    // completes the form wastes their answers. A Story runs in its own worktree and its form reads
    // its own catalog and readiness, so the form opens at once on the Store's last snapshot; the
    // refresh runs behind it and updates the in-flight list when it lands. Waiting here used to cost
    // one or two full snapshots, including a network clone of approved configuration, before any
    // form appeared.
    const checkoutShape = Boolean(defaults.shape && defaults.shape !== 'story');
    if (checkoutShape) {
      // Loading a new slice already performs a fresh snapshot; only an already loaded
      // configuration needs the explicit freshness read.
      const refreshedForConfiguration = await store.ensureSlices(['configuration']);
      if (!refreshedForConfiguration) await store.refresh();
    } else if (!store.current.snapshot || store.current.stale) {
      void store.refresh().catch(() => undefined);
    }
    const repositoryState = store.current.snapshot?.repository;
    const changedPaths = repositoryState?.changes ?? [];
    // Stories run in dedicated worktrees, so a dirty checkout from another Story is not a blocker.
    // Initiative and Epic starts still use the selected checkout and retain the existing guard when
    // that shape was requested directly. With the generic Start Work entry, the form decides the
    // shape first and the engine applies the appropriate boundary.
    if (changedPaths.length && defaults.shape && defaults.shape !== 'story') {
      const branchName = repositoryState?.branch ?? 'detached HEAD';
      const repositoryName = path.basename(repositoryState?.root ?? repository);
      const target = workspaceLabel ? `${workspaceLabel} → ${repositoryName}` : repositoryName;
      const sample = changedPaths.slice(0, 3).join(', ');
      const remaining = changedPaths.length - Math.min(changedPaths.length, 3);
      const cancelled = store.current.snapshot?.workflow?.status === 'cancelled'
        ? store.current.snapshot.workflow : null;
      let release: {
        workId: string; branch: string; baseBranch: string; changedPathCount: number;
        changedPaths: string[]; ready: boolean;
      } | null = null;
      if (cancelled?.workItem.id && cancelled.workItem.branch === branchName) {
        try {
          release = await client.run<{
            workId: string; branch: string; baseBranch: string; changedPathCount: number;
            changedPaths: string[]; ready: boolean;
          }>([
            'cancel', cancelled.workItem.id, '--release', '--json'
          ]);
        } catch (error) {
          output.appendLine(`Cancelled checkout release is unavailable: ${(error as Error).message}`);
        }
      }
      const releaseAction = release?.ready ? 'Preserve changes & return to base' : null;
      const open = await showCompactWarningMessage(
        `Cannot start work in ${target} on ${branchName}: ${changedPaths.length} uncommitted path(s) (${sample}${remaining ? `, +${remaining} more` : ''}).`,
        {
          modal: true,
          detail: `Repository: ${repositoryState?.root ?? repository}\nBranch: ${branchName}\n\n`
            + `${changedPaths.join('\n')}\n\n`
            + (release
              ? `This Story is cancelled. Singularity Flow can preserve these edits in a named Git stash and return to ${release.baseBranch}; the archived branch and history remain intact.`
              : 'Commit or stash these changes before starting governed work.')
        },
        ...(releaseAction ? [releaseAction] : []),
        'Open Source Control'
      );
      if (releaseAction && open === releaseAction && cancelled) {
        try {
          const result = await client.run<{
            baseBranch: string; stashSha: string | null; recoveryCommand: string | null;
            sessionWarning: string | null;
          }>([
            'cancel', cancelled.workItem.id, '--release', '--apply',
            '--confirm', cancelled.workItem.id, '--json'
          ]);
          await refreshAfterKnownMutation();
          const preserved = result.stashSha
            ? ` Changes were preserved at stash commit ${result.stashSha.slice(0, 12)}.` : '';
          void showCompactInformationMessage(
            `Cancelled Story ${cancelled.workItem.id} remains archived. Returned to ${result.baseBranch}.${preserved}`
            + (result.sessionWarning ? ` ${result.sessionWarning}` : '')
          );
          return startWork(defaults);
        } catch (error) {
          showRefusal(error, { headline: `Could not release cancelled Story ${cancelled.workItem.id}` });
          return;
        }
      }
      if (open === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }

    // Checked before anything is asked. The engine refuses to start an Epic or an Initiative when no
    // approval authority has a member, and discovering that after a filled-in form — with a message
    // naming a YAML key — is a poor greeting for someone who has just initialized a repository. From
    // the generic entry the form shows the same thing as a problem once one of those shapes is chosen.
    const authorities = store.current.snapshot?.portfolio?.approvalAuthorities ?? {};
    const named = Object.entries(authorities).filter(([, authority]) => (authority?.members ?? []).length);
    const approvalAuthorityMissing = Object.keys(authorities).length > 0 && !named.length;
    if (checkoutShape && approvalAuthorityMissing) {
      const open = await showCompactWarningMessage(
        'No approval authority has a member yet, so governed work cannot be started.',
        { modal: true, detail: 'Add at least one person in People & approvals. Every governed approval is checked against the configured Git or GitHub identity.' },
        'Open People & approvals');
      if (open === 'Open People & approvals') await vscode.commands.executeCommand('singularityFlow.configurePeople');
      return;
    }

    // One screen for six paths. An Initiative, an Epic or a Story, each with or without a tracker,
    // used to be six commands you had to already know the names of — which meant the product's front
    // door was documentation rather than a screen.
    const { IntakePanel, intakeInFlight } = lazyPanels();
    IntakePanel.show(context, client, output, async (started) => {
      if (defaults.guidedStart) await context.globalState.update(START_WIZARD_KEY, undefined);
      if (started.shape === 'story' && started.repositoryPath
          && await storyCheckoutNeedsWindowSwitch(started.repositoryPath,
            (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath))) {
        const handoff = storyStartHandoffFromResult(started);
        if (handoff) {
          try { await context.globalState.update(STORY_START_HANDOFF_KEY, handoff); }
          catch { /* An advisory scheduling cache must not turn a published Story into a refusal. */ }
        }
        void showCompactInformationMessage(
          `Story ${started.id} started in its isolated checkout. Opening it now.`
        );
        await vscode.commands.executeCommand(
          'vscode.openFolder', vscode.Uri.file(started.repositoryPath), false
        );
        return;
      }
      await refreshAfterKnownMutation();
      const subject = started.shape === 'story' ? 'Story'
        : started.shape === 'epic' ? 'Epic' : 'Initiative';
      const next = started.currentPhase
        ? ` Next: prepare ${started.currentPhase.replaceAll('-', ' ')}.` : '';
      const open = await showCompactInformationMessage(
        `${subject} ${started.id} started.${next}`, 'Continue safely', 'Open the journey', 'Show status');
      if (open === 'Continue safely') await vscode.commands.executeCommand('singularityFlow.continueSafely');
      else if (open === 'Open the journey') await vscode.commands.executeCommand('singularityFlow.openJourney');
      else if (open === 'Show status') await vscode.commands.executeCommand('singularityFlow.openDashboard');
    }, {
      workspace: workspaceLabel,
      repository: repositoryState?.root ?? repository,
      branch: repositoryState?.branch ?? null,
      // Re-project the Store's lifecycle slice rather than spawning a second full `snapshot --json`
      // inside the panel. For a Story it may be the last snapshot; `lifecycleChanged` follows it.
      inFlight: intakeInFlight(store.current.snapshot),
      approvalAuthorityMissing,
      defaults,
      catalogCache: intakeCatalogCache?.bind(intakeCatalogKey()) ?? null,
      holdBackgroundWork: (reason) => backgroundWork.hold(reason),
      holdNavigation,
      journey: defaults.guidedStart ? {
        step: 'work',
        capabilityId: context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null)?.capabilityId ?? null,
        workspaceName: defaults.workspaceName ?? workspaceLabel
      } : null
    });
  };

  /**
   * Pin a source.
   *
   * A file picker is the one thing an editor does better than a terminal here, and pinning is the
   * step that decides what every later requirement is allowed to cite.
   */
  const addSource = async (): Promise<void> => {
    const picked = await vscode.window.showOpenDialog({
      title: 'Pin a source for this Epic',
      openLabel: 'Pin this source',
      canSelectMany: false
    });
    if (!picked?.length || !picked[0]) return;
    const ran = await runGovernedAction(client, {
      command: ['epic', 'sources', 'add', '--provider', 'local', '--file', picked[0].fsPath],
      title: 'Pinning source'
    }, output);
    if (ran) await refreshAfterKnownMutation();
  };

  /**
   * Attach governed evidence without making people translate a design asset into CLI syntax.
   *
   * The selected Story or Epic is resolved from the same coherent snapshot used by Lifecycle. The
   * CLI performs every mutation, so files, folders and links receive the same hashes, receipts,
   * commits, pushes and sequence checks as `/sf-upload` in Copilot.
   */
  const collectEvidence = async (
    requestedTarget?: EvidenceTarget,
    requestedSource?: EvidenceSourceKind
  ): Promise<void> => {
    const available = evidenceTargets(store.current.snapshot);
    if (!available.length) {
      void showCompactWarningMessage(
        'Start or resume an Epic or Story before attaching evidence. The evidence must have a governed owner.');
      return;
    }
    let target: EvidenceTarget | undefined = requestedTarget ?? available[0];
    if (!requestedTarget && available.length > 1) {
      const picked = await vscode.window.showQuickPick(
        available.map((candidate) => ({
          label: candidate.label,
          description: candidate.kind === 'story'
            ? 'available to this Story workflow'
            : 'available to Epic requirements and planning',
          target: candidate
        })),
        { title: 'Attach evidence & designs', placeHolder: 'Choose the governed owner' }
      );
      target = picked?.target;
    }
    if (!target) return;

    // A Story released from an Epic can import the Epic's own sources, so it is offered them.
    const releasedFrom = target.kind === 'story'
      ? (store.current.snapshot?.workflow as { lineage?: { epicId?: string | null } } | undefined)?.lineage?.epicId ?? null
      : null;
    const source = requestedSource ? { value: requestedSource } : await vscode.window.showQuickPick([{
      label: 'Files, images or PDFs', value: 'files' as const,
      description: 'Select one or more local files'
    }, {
      label: 'Figma export folder', value: 'figma-export' as const,
      description: target.kind === 'story'
        ? 'Preserve the export as one governed Story package'
        : 'Pin every exported file to the Epic in deterministic order'
    }, {
      label: 'Figma design link', value: 'figma-link' as const,
      description: 'Pin the HTTPS reference; no Figma credentials are stored'
    }, {
      label: 'Other HTTPS reference', value: 'url' as const,
      description: 'Pin a document or design-system link'
    }, ...(releasedFrom ? [{
      label: 'Source from the Epic', value: 'epic-source' as const,
      description: `Import a verified copy of one of Epic ${releasedFrom}'s sources`
    }] : [])], { title: `Attach evidence to ${target.label}`, placeHolder: 'Choose the source type' });
    if (!source) return;

    // A Story document needs its own name. Ask once per file or folder, suggesting the file name
    // and refusing a name the Story already uses, detached documents included.
    const storyNames = target.kind === 'story'
      ? evidenceCatalog(store.current.snapshot).filter((item) => item.target.kind === 'story').map((item) => item.label)
      : [];
    const askNames = async (paths: string[]): Promise<string[] | null> => {
      if (target?.kind !== 'story') return [];
      const chosen: string[] = [];
      for (const [index, file] of paths.entries()) {
        const name = await vscode.window.showInputBox({
          title: paths.length > 1 ? `Name document ${index + 1} of ${paths.length}` : 'Name this document',
          prompt: `How reviewers and prompts will refer to ${path.basename(file)} in ${target.label}.`,
          value: suggestedEvidenceName(file),
          ignoreFocusOut: true,
          validateInput: (value) => validateEvidenceName(value, [...storyNames, ...chosen])
        });
        if (!name?.trim()) return null;
        chosen.push(name.replace(/\s+/gu, ' ').trim());
      }
      return chosen;
    };
    // Which phases use the new documents: the current phase onward unless the person narrows it.
    // Returns undefined on cancel, and null when the default was kept, so no flag is passed.
    const askPhases = async (): Promise<string[] | null | undefined> => {
      if (target?.kind !== 'story') return null;
      const workflow = store.current.snapshot?.workflow;
      const phaseOrder = workflow?.phaseOrder ?? [];
      if (!phaseOrder.length) return null;
      const defaults = defaultEvidencePhases(phaseOrder, workflow?.currentPhase);
      const picked = await vscode.window.showQuickPick(
        phaseOrder.map((phase) => ({ label: phase, picked: defaults.includes(phase) })),
        { canPickMany: true, title: 'Which phases use it?', placeHolder: 'Only these phases\' prompts and source reviews include it', ignoreFocusOut: true }
      );
      if (!picked) return undefined;
      if (!picked.length) {
        void showCompactWarningMessage('Choose at least one phase. Nothing was attached.');
        return undefined;
      }
      const chosen = phaseOrder.filter((phase) => picked.some((entry) => entry.label === phase));
      return chosen.length === defaults.length && chosen.every((phase) => defaults.includes(phase)) ? null : chosen;
    };
    // Where a Story file is kept: only what its document policy allows, its default first; one
    // choice is no choice. Undefined on cancel.
    const askStorage = async (plural: boolean): Promise<'git' | 'local' | undefined> => {
      const policy = evidenceStorageChoices(
        (store.current.snapshot?.workflow?.resolution as { documents?: { storage?: { allowed?: unknown; default?: unknown } } } | undefined)?.documents);
      if (policy.allowed.length <= 1) return policy.default;
      const options = [{
        label: 'Commit to Git', description: 'Everyone working on this Story gets the file', value: 'git' as const
      }, {
        label: 'Keep on this machine only',
        description: 'Git records its name, size and SHA-256; other machines cannot open it', value: 'local' as const
      }].sort((left, right) => Number(right.value === policy.default) - Number(left.value === policy.default));
      const choice = await vscode.window.showQuickPick(options,
        { title: plural ? 'Where should these files be kept?' : 'Where should this file be kept?', ignoreFocusOut: true });
      return choice?.value;
    };
    let input: Parameters<typeof evidenceCommands>[1] | null = null;
    if (source.value === 'files') {
      const picked = await vscode.window.showOpenDialog({
        title: `Attach files to ${target.label}`,
        openLabel: 'Attach selected files',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: {
          'Evidence and designs': ['md', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'json', 'yaml', 'yml', 'csv', 'xlsx', 'docx', 'pptx'],
          'All files': ['*']
        }
      });
      if (!picked?.length) return;
      const paths = picked.map((entry) => entry.fsPath);
      const names = await askNames(paths);
      if (!names) return;
      let storage: 'git' | 'local' = 'git';
      if (target.kind === 'story') {
        const chosen = await askStorage(paths.length > 1);
        if (!chosen) return;
        storage = chosen;
      }
      const phases = await askPhases();
      if (phases === undefined) return;
      input = { kind: 'files', paths, names, store: storage, phases };
    } else if (source.value === 'figma-export') {
      const picked = await vscode.window.showOpenDialog({
        title: `Attach a Figma export folder to ${target.label}`,
        openLabel: 'Attach Figma export',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false
      });
      if (!picked?.[0]) return;
      const paths = target.kind === 'epic'
        ? await expandEpicEvidenceDirectory(picked[0].fsPath)
        : [picked[0].fsPath];
      if (!paths.length) {
        void showCompactWarningMessage('The selected Figma export folder contains no files. Nothing was attached.');
        return;
      }
      if (target.kind === 'story') {
        const policy = evidenceStorageChoices(
          (store.current.snapshot?.workflow?.resolution as { documents?: { storage?: { allowed?: unknown; default?: unknown } } } | undefined)?.documents);
        if (!policy.allowed.some((kind) => kind === 'git')) {
          void showCompactWarningMessage('A Figma export folder is committed to Git, and this Story keeps documents on this machine only. Attach its files one by one instead. Nothing was attached.');
          return;
        }
      }
      const names = await askNames(target.kind === 'story' ? paths : []);
      if (!names) return;
      const phases = await askPhases();
      if (phases === undefined) return;
      input = { kind: 'figma-export', paths, names, store: 'git', phases };
    } else if (source.value === 'epic-source') {
      if (target.kind !== 'story') {
        void showCompactInformationMessage('An Epic\'s sources are imported into a Story released from it. Choose that Story as the owner.');
        return;
      }
      let browsed: EpicSourceBrowse;
      try {
        browsed = await client.run<EpicSourceBrowse>(['documents', 'browse', '--provider', 'epic', '--json']);
      } catch (error) {
        showRefusal(error, { headline: 'Could not read the Epic\'s sources' });
        return;
      }
      const waiting = browsed.entries.filter((entry) => !entry.imported);
      // A source that failed verification is never offered; say how many, so none goes missing silently.
      const failed = browsed.rejected.length
        ? `${browsed.rejected.length} failed verification and cannot be imported (${browsed.rejected.map((entry) => entry.sourceId ?? entry.name).join(', ')})`
        : '';
      if (!waiting.length) {
        void showCompactInformationMessage(`Every verified source of Epic ${browsed.epicId} is already in ${target.label}.${failed ? ` ${failed}.` : ''}`);
        return;
      }
      const picked = await vscode.window.showQuickPick(waiting.map((entry) => ({
        label: entry.name, description: [entry.id, entry.mimeType].filter(Boolean).join(' · '), entry
      })), {
        title: `Import a source from Epic ${browsed.epicId}${failed ? ` · ${failed}` : ''}`, ignoreFocusOut: true,
        placeHolder: 'Its copy is checked against the Epic\'s SHA-256'
      });
      if (!picked) return;
      const name = await vscode.window.showInputBox({
        title: 'Name this document',
        prompt: `How reviewers and prompts will refer to ${picked.entry.id} in ${target.label}.`,
        value: picked.entry.name.replace(/\s+/gu, ' ').trim().slice(0, 120),
        ignoreFocusOut: true,
        validateInput: (value) => validateEvidenceName(value, storyNames)
      });
      if (!name?.trim()) return;
      const storage = await askStorage(false);
      if (!storage) return;
      const phases = await askPhases();
      if (phases === undefined) return;
      input = { kind: 'epic-source', sourceId: picked.entry.id, name: name.replace(/\s+/gu, ' ').trim(), store: storage, phases };
    } else {
      const figmaOnly = source.value === 'figma-link';
      const url = await vscode.window.showInputBox({
        title: figmaOnly ? 'Figma design link' : 'Evidence link',
        prompt: `Pin an HTTPS reference to ${target.label}. The link is recorded; it is not opened or followed.`,
        placeHolder: figmaOnly ? 'https://www.figma.com/design/…' : 'https://…',
        ignoreFocusOut: true,
        validateInput: (value) => validateEvidenceUrl(value, figmaOnly)
      });
      if (!url) return;
      const label = await vscode.window.showInputBox({
        title: target.kind === 'story' ? 'Name this document' : 'Evidence label',
        value: figmaOnly ? 'Figma design' : '',
        prompt: 'Use a name reviewers will recognize.',
        ignoreFocusOut: true,
        validateInput: (value) => target?.kind === 'story'
          ? validateEvidenceName(value, storyNames)
          : value.trim() ? null : 'A label is required.'
      });
      if (!label?.trim()) return;
      const phases = await askPhases();
      if (phases === undefined) return;
      input = { kind: 'url', url: url.trim(), label: label.trim(), phases };
    }

    const commands = evidenceCommands(target, input);
    // Story documents are named by now, and the name is what the person will look for afterwards.
    const summary = input.kind === 'url'
      ? input.label
      : input.kind === 'epic-source' ? `'${input.name}'`
      : input.names?.length
        ? input.names.map((name) => `'${name}'`).join(', ')
        : `${input.paths.length} ${input.paths.length === 1 ? 'path' : 'paths'}`;
    const confirmation = await showCompactInformationMessage(
      (input.kind === 'files' || input.kind === 'epic-source') && input.store === 'local'
        ? `Attach ${summary} to ${target.label}? The file stays on this machine; only its name, size and SHA-256 are committed and pushed.`
        : `Attach ${summary} to ${target.label}? The governed record will be committed and pushed.`,
      { modal: true }, 'Attach evidence');
    if (confirmation !== 'Attach evidence') return;
    for (const [index, command] of commands.entries()) {
      const ran = await runGovernedAction(client, {
        command,
        title: commands.length > 1
          ? `Attaching evidence ${index + 1} of ${commands.length}`
          : `Attaching evidence to ${target.label}`
      }, output);
      if (!ran) return;
    }
    await refreshAfterKnownMutation();
    void showCompactInformationMessage(
      `Attached ${summary} to ${target.label}. Open Lifecycle to review the governed IDs and artifacts.`);
  };

  // Verified document text, shown read-only and memory-backed: never the stored file, never a temporary file.
  const evidencePreviews = new Map<string, string>();
  let evidencePreviewProvider: vscode.Disposable | null = null;
  const showEvidencePreview = async (item: EvidenceCatalogItem, content: string): Promise<void> => {
    if (!evidencePreviewProvider) {
      evidencePreviewProvider = vscode.workspace.registerTextDocumentContentProvider('sflow-evidence', {
        provideTextDocumentContent: (uri) => evidencePreviews.get(uri.toString())
          ?? 'This preview is no longer retained. Open the document again from Evidence & designs.'
      });
      context.subscriptions.push(evidencePreviewProvider, vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === 'sflow-evidence') evidencePreviews.delete(document.uri.toString());
      }));
    }
    const uri = vscode.Uri.from({
      scheme: 'sflow-evidence', path: `/${item.target.id}/${item.id} ${item.label.replace(/[\\/]/gu, '-')}.md`
    });
    evidencePreviews.set(uri.toString(), content);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  };

  /**
   * Open a document through `documents view`, which verifies its SHA-256: the rendered text in a
   * read-only preview (the stored file is never opened for editing), or the verified file itself
   * when it is an image or PDF.
   */
  const openVerifiedEvidence = async (item: EvidenceCatalogItem): Promise<void> => {
    try {
      const viewed = await client.run<{
        content?: string | null; binary?: boolean; absolutePath?: string; rendition?: { status: string; text?: string }
      }>(['documents', 'view', item.id, '--work-id', item.target.id, '--json']);
      const text = viewed.rendition?.status === 'extracted' ? viewed.rendition.text : viewed.binary ? null : viewed.content;
      if (text != null) {
        await showEvidencePreview(item, text);
      } else if (viewed.absolutePath && (item.mimeType?.startsWith('image/') || item.mimeType === 'application/pdf')) {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(viewed.absolutePath));
      } else {
        void showCompactInformationMessage(`${item.id} (${item.label}) is a binary document with no text preview.`);
      }
    } catch (error) {
      showRefusal(error, { headline: `Could not open ${item.id}` });
    }
  };

  const openEvidence = async (item: EvidenceCatalogItem): Promise<void> => {
    if (item.url) {
      await vscode.env.openExternal(vscode.Uri.parse(item.url));
      return;
    }
    if (item.storage === 'local') {
      if (item.availability !== 'available') {
        void showCompactWarningMessage(item.availability === 'changed'
          ? `${item.id} (${item.label}) is kept on this machine, but the copy here no longer matches its committed SHA-256.`
          : `${item.id} (${item.label}) is kept on another machine; this checkout does not have its bytes.`);
        return;
      }
      return openVerifiedEvidence(item);
    }
    // A DOCX or XLSX is shown as its extracted text rather than as ZIP bytes.
    if (item.target.kind === 'story' && /officedocument\.(?:wordprocessingml|spreadsheetml)/u.test(item.mimeType ?? '')) {
      return openVerifiedEvidence(item);
    }
    if (!item.path) {
      void showCompactInformationMessage(
        `${item.id} has no locally committed preview. Its verified metadata remains available in Lifecycle.`);
      return;
    }
    if (item.mimeType?.startsWith('image/') || item.mimeType === 'application/pdf') {
      const absolute = path.resolve(client.repository, item.path);
      const relative = path.relative(client.repository, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        showRefusal(`This evidence path resolves outside the repository, so it was not opened: ${item.path}`,
          { headline: 'Refused: that path leaves the repository' });
        return;
      }
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolute));
      return;
    }
    // A supporting document is pinned by SHA-256: saving an edit would break that, so it opens
    // locked for this session rather than as an ordinary file.
    await openArtifact(client.repository, {
      kind: 'source', id: `evidence:${item.target.kind}:${item.id}`,
      label: item.label, path: item.path
    });
    await vscode.commands.executeCommand('workbench.action.files.setActiveEditorReadonlyInSession').then(undefined, () => undefined);
    void vscode.window.setStatusBarMessage(`$(lock-small) ${item.id} is a supporting document pinned by SHA-256; it opens read-only.`, 6_000);
  };

  const detachEvidenceItem = async (item: EvidenceCatalogItem): Promise<void> => {
    if (item.status === 'detached') {
      void showCompactInformationMessage(`${item.id} is already detached. Its committed evidence remains read-only.`);
      return;
    }
    let scope: 'file' | 'package' = 'file';
    if (item.target.kind === 'story' && item.packageId) {
      const selected = await vscode.window.showQuickPick([{
        label: 'Detach this file', description: item.id, scope: 'file' as const
      }, {
        label: 'Detach complete package', description: item.packageId, scope: 'package' as const
      }], {
        title: `Detach ${item.label}`,
        placeHolder: 'Choose how much of this governed Figma/design package to detach'
      });
      if (!selected) return;
      scope = selected.scope;
    }
    const reason = await vscode.window.showInputBox({
      title: scope === 'package' ? `Why is package ${item.packageId} being detached?` : `Why is ${item.id} being detached?`,
      prompt: 'This reason is committed in the append-only evidence decision record.',
      placeHolder: 'Superseded, incorrect, out of scope…',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'A detachment reason is required.'
    });
    if (!reason?.trim()) return;
    const target = scope === 'package' ? `package ${item.packageId}` : `${item.id} — ${item.label}`;
    // A Story detach is previewed by the CLI first, so the dialog names what it actually reopens.
    let impact = 'Any phase and approval that depended on it will be invalidated and the earliest dependent phase reopened.';
    const previewCommand = evidenceDetachPreviewCommand(item, scope);
    if (previewCommand) {
      try {
        const preview = await client.run<{ usedBy?: Array<{ phase: string; generation: number }>; reopenedPhase?: string | null; pendingPrompt?: string | null }>(previewCommand);
        const used = evidenceUsesLabel(preview.usedBy);
        impact = [
          used ? `Published work that used it: ${used}.` : 'No published work has used it.',
          preview.reopenedPhase ? `Reopens ${preview.reopenedPhase}: its approvals and every later phase are invalidated.` : 'No phase reopens.',
          preview.pendingPrompt ? 'The prompt already composed for the current phase is recomposed without it the next time.' : null
        ].filter(Boolean).join('\n');
      } catch (error) {
        showRefusal(error, { headline: `Could not preview detaching ${target}` });
        return;
      }
    }
    const confirmed = await showCompactWarningMessage(
      `Detach ${target}?`,
      {
        modal: true,
        detail: `Committed bytes and audit history will be preserved. The evidence will be omitted from future Copilot prompts.\n${impact}`
      },
      'Detach evidence'
    );
    if (confirmed !== 'Detach evidence') return;

    const command = evidenceDetachCommand(item, scope, reason.trim());
    output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Detaching ${target}`, cancellable: false },
        () => client.runText(command)
      );
      output.appendLine(result.trim());
      await refreshAfterKnownMutation();
      const meaningful = result.split(/\r?\n/).filter((line) =>
        /^(Commit|Invalidated phases|Reopened phase|Next in Copilot|Run|In Copilot):/.test(line));
      const action = await showCompactInformationMessage(
        `Detached ${target}. ${meaningful.slice(0, 2).join(' · ') || 'The decision was committed through the governed publication transaction.'}`,
        'Show complete result'
      );
      if (action === 'Show complete result') output.show(true);
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      showRefusal(error, { headline: `Could not detach ${target}` });
    }
  };

  /** Change which phases use a Story document: choose, give a reason, review the dry run, confirm. */
  const scopeEvidenceItem = async (item: EvidenceCatalogItem): Promise<void> => {
    const phaseOrder = store.current.snapshot?.workflow?.phaseOrder ?? [];
    if (item.target.kind !== 'story' || !phaseOrder.length) return;
    const current = item.phases?.length ? item.phases : phaseOrder;
    const picked = await vscode.window.showQuickPick(
      phaseOrder.map((phase) => ({ label: phase, picked: current.includes(phase) })),
      { canPickMany: true, title: `Which phases use ${item.label}?`, placeHolder: 'Only these phases\' prompts and source reviews include it', ignoreFocusOut: true }
    );
    if (!picked) return;
    if (!picked.length) {
      void showCompactWarningMessage('Choose at least one phase. To stop using a document everywhere, detach it.');
      return;
    }
    const phases = phaseOrder.filter((phase) => picked.some((entry) => entry.label === phase));
    if (phases.length === current.length && phases.every((phase) => current.includes(phase))) {
      void showCompactInformationMessage(`${item.label} is already used in exactly those phases.`);
      return;
    }
    const reason = await vscode.window.showInputBox({
      title: `Why change which phases use ${item.label}?`,
      prompt: 'This reason is committed in the document scope decision record.',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim() ? null : 'A reason is required.'
    });
    if (!reason?.trim()) return;
    let preview: { removedPhases?: string[]; addedPhases?: string[]; usedBy?: Array<{ phase: string; generation: number }>; pendingPrompt?: string | null };
    try {
      preview = await client.run(evidenceScopeCommand(item, phases, reason.trim(), { dryRun: true }));
    } catch (error) {
      showRefusal(error, { headline: `Could not preview the change for ${item.id}` });
      return;
    }
    const detail = [
      preview.removedPhases?.length ? `No longer used in: ${preview.removedPhases.join(', ')}.` : null,
      preview.addedPhases?.length ? `Used from now on in: ${preview.addedPhases.join(', ')}.` : null,
      evidenceUsesLabel(preview.usedBy)
        ? `Already used by ${evidenceUsesLabel(preview.usedBy)}; that work keeps it. Only later prompts change; detach it to withdraw it from that work.`
        : 'Only later prompts change; nothing is reopened.',
      preview.pendingPrompt ? 'The prompt already composed for the current phase is recomposed with this change the next time.' : null
    ].filter(Boolean).join('\n');
    const confirmed = await showCompactWarningMessage(
      `Change which phases use ${item.id} — ${item.label}?`, { modal: true, detail }, 'Change phases');
    if (confirmed !== 'Change phases') return;
    const ran = await runGovernedAction(client, {
      command: evidenceScopeCommand(item, phases, reason.trim()),
      title: `Changing which phases use ${item.label}`
    }, output);
    if (!ran) return;
    await refreshAfterKnownMutation();
    void showCompactInformationMessage(`${item.label} is now used in: ${phases.join(', ')}.`);
  };

  const resolveEvidenceNode = (node?: TreeNode): EvidenceCatalogItem | undefined => {
    if (!node?.evidence) return undefined;
    return evidenceCatalog(store.current.snapshot).find((item) =>
      item.target.kind === node.evidence?.ownerKind
      && item.target.id === node.evidence.ownerId
      && item.id === node.evidence.evidenceId);
  };

  const manageEvidence = async (): Promise<void> => {
    const { EvidenceManagerPanel } = lazyPanels();
    EvidenceManagerPanel.show(store, {
      attach: collectEvidence,
      open: openEvidence,
      detach: detachEvidenceItem,
      scope: scopeEvidenceItem
    });
  };

  const detachEvidence = async (node?: TreeNode): Promise<void> => {
    const direct = resolveEvidenceNode(node);
    if (direct) return detachEvidenceItem(direct);
    const active = evidenceCatalog(store.current.snapshot).filter((item) => item.status === 'active');
    if (!active.length) {
      void showCompactInformationMessage('No active governed evidence is available to detach.');
      return;
    }
    const picked = await vscode.window.showQuickPick(active.map((item) => ({
      label: item.label, description: `${item.target.label} · ${item.id}`, item
    })), { title: 'Detach evidence', placeHolder: 'Choose the exact governed evidence' });
    if (picked) await detachEvidenceItem(picked.item);
  };

  /**
   * Acting on an approval card.
   *
   * The page names a card; which approval that is was resolved from the snapshot before this runs,
   * so the subject and the confirmation string come from governed state rather than the page.
   */
  const onApprovalsMessage = async (message: ApprovalsMessage): Promise<void> => {
    const { approval } = message;
    const initiative = store.current.snapshot?.initiative;
    if (message.type === 'open') {
      const output = approval.source === 'initiative'
        ? initiative?.state.phases[approval.phase]?.outputs?.[approval.subject]
        : null;
      const artifactPath = output?.path ?? approval.artifactPath;
      if (artifactPath) {
        await openArtifact(repository, {
          kind: 'artifact', id: approval.id, label: approval.label, path: artifactPath
        });
      }
      return;
    }
    if (message.type === 'approve') {
      return runNode({
        kind: 'action', id: approval.id, label: approval.label,
        approve: approval.source === 'story'
          ? {
            kind: 'story', workId: approval.workId ?? '', phaseId: approval.phase,
            expected: approval.expected, summary: `Approve ${approval.label}`,
            selfApproval: approval.selfApproval
          }
          : {
            kind: 'initiative', initiativeId: initiative?.state.initiative.id ?? '',
            subject: approval.subject, expected: approval.expected,
            summary: `Approve ${approval.label}`
          }
      });
    }
    let target = approval.phase;
    if (approval.source === 'story') {
      const workflow = store.current.snapshot?.workflow;
      const choices = approval.rejectTo.map((phaseId) => ({
        label: workflow?.phases?.[phaseId]?.label ?? phaseId,
        description: phaseId,
        phaseId
      }));
      const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
        title: `Send ${approval.label} back to an earlier phase`,
        placeHolder: 'Choose the phase that must be revised',
        ignoreFocusOut: true
      });
      if (!selected) return;
      target = selected.phaseId;
    }
    // Change requests need a reason: an invalidation nobody can explain is worse than none at all.
    const reason = await vscode.window.showInputBox({
      title: `Request changes to ${approval.label}`,
      prompt: `What must change in ${target}? This comment is recorded and injected into the next generation.`,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'A reason is required.')
    });
    if (!reason?.trim()) return;
    await runNode({
      kind: 'action', id: approval.id, label: approval.label,
      command: approval.source === 'story'
        ? ['reject', approval.workId ?? '', '--fetch', '--phase', approval.phase, '--to', target, '--reason', reason.trim()]
        : ['initiative', 'reject', approval.subject, '--reason', reason.trim()]
    });
  };

  /** The inbox reuses the exact approval transaction and adds all-phase document navigation. */
  const onInboxMessage = async (message: InboxMessage): Promise<void> => {
    if (message.type === 'refresh-stories') {
      await reconcileActiveWorkspaceSelection();
      return refreshRemoteStories();
    }
    if (message.type === 'attach-story') {
      const story = buildInbox(store.current.snapshot, workspaceStoryCatalog, repository, inboxRepositoryBinding).stories
        .find((item) => item.workId === message.workId && item.repositoryId === message.repositoryId);
      if (!story || !story.attachable) {
        showRefusal('This Story is no longer in the workspace Inbox. Refresh Stories and select it again.', {
          headline: 'Could not attach the selected Story'
        });
        return;
      }
      return runNode({
        kind: 'story', id: `inbox:active-story:${message.workId}`, label: message.workId,
        command: ['session', 'attach', message.workId],
        openCopilotAfterAttach: true,
        ...(workspaceStoryCatalog.some((row) => row.id === story.workId
          && row.repositoryId === story.repositoryId)
          ? { storyRepositoryId: story.repositoryId }
          : story.repositoryPath && story.repositoryPath !== repository
            ? { openPath: story.repositoryPath } : {})
      });
    }
    if (message.type === 'decide') return chooseStoryDecision(message.workId, null);
    if (message.type === 'open-artifact') {
      return openArtifact(repository, {
        kind: 'artifact', id: message.artifact.id, label: message.artifact.label,
        path: message.artifact.path, readOnly: message.artifact.readOnly
      });
    }
    const mapped: ApprovalsMessage = message.type === 'open-approval'
      ? { type: 'open', approval: message.approval }
      : { type: message.type, approval: message.approval };
    return onApprovalsMessage(mapped);
  };

  const onStoriesMessage = async (message: StoriesMessage): Promise<void> => {
    const initiativeId = store.current.snapshot?.initiative?.state.initiative.id ?? '';
    if (message.type === 'materialize') {
      // The confirmation is the Epic's own identifier, exactly as the terminal demands it.
      return runNode({
        kind: 'action', id: 'materialize', label: 'Push Stories to their repositories',
        command: ['initiative', 'materialize'],
        confirmation: { expected: initiativeId, summary: `Push ${initiativeId} Stories to their repositories` }
      });
    }
    if (message.type === 'spec') {
      // The specification lives beside the Story plan, under the planning phase.
      const initiativeRoot = String(
        store.current.snapshot?.initiative?.state.resolution.initiativeRoot ?? 'singularity/initiatives'
      ).replace(/\/+$/, '');
      return openArtifact(repository, {
        kind: 'artifact', id: `spec:${message.story.planId}`, label: message.story.workId,
        path: `${initiativeRoot}/${initiativeId}/artifacts/epic-planning/stories/${message.story.planId}/story-spec.md`
      });
    }
    const title = await vscode.window.showInputBox({
      title: `Split ${message.story.workId}`,
      prompt: 'Title of the new Story carved out of this one',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? null : 'A title is required.')
    });
    if (!title?.trim()) return;
    await runNode({
      kind: 'action', id: `split:${message.story.planId}`, label: 'Split Story',
      command: ['epic', 'stories', 'split', message.story.planId, '--title', title.trim()]
    });
  };

  /**
   * Editing the capability map.
   *
   * The engine validates the whole tree before it writes, so a refusal is the answer rather than a
   * failure: it goes back onto the panel that caused it, in the engine's own words, instead of into a
   * notification the reader has to hold in their head while fixing the form.
   */
  const onCapabilitiesMessage = async (message: CapabilitiesMessage): Promise<void> => {
    const { CapabilitiesPanel } = lazyPanels();
    const panel = await CapabilitiesPanel.show(context, store, (next) => { void onCapabilitiesMessage(next); });
    if (message.type === 'open-auto-settings') {
      await vscode.commands.executeCommand('singularityFlow.configureAuto');
      return;
    }
    if (message.type === 'test-setup') {
      const active = activeRepositoryContext();
      const find = (nodes: CapabilityNode[]): CapabilityNode | undefined => {
        for (const node of nodes) { if (node.id === message.id) return node; const child = find(node.children ?? []); if (child) return child; }
        return undefined;
      };
      const capability = message.id ? find(store.current.snapshot?.capabilityMap?.capabilities ?? []) : null;
      if (message.id && !capability) { panel.report('The capability changed. Refresh Capabilities and select it again.'); return; }
      const repositories = capability?.repositories?.length ? capability.repositories : capability?.repository ? [capability.repository] : [];
      if (repositories.length && (!active?.repositoryId || !repositories.includes(active.repositoryId))) {
        panel.report('Select this capability’s repository in Workspaces before opening Test setup. No other repository configuration was opened or changed.');
        return;
      }
      await vscode.commands.executeCommand('singularityFlow.configureTests');
      return;
    }
    if (message.type === 'progressive-start') {
      await vscode.commands.executeCommand('singularityFlow.startWork');
      return;
    }
    if (message.type === 'progressive-why') {
      try {
        const explanation = await client.run<{
          capability?: { label?: string }; approvalProfile?: string;
          selfApprovalAllowed?: boolean; explanationSha256?: string
        }>(['capability', 'show', '--json', '--verbose']);
        await showCompactInformationMessage(
          `${explanation.capability?.label ?? 'This repository'} owns the current path. `
          + `Approval uses the ${explanation.approvalProfile ?? 'team'} profile`
          + `${explanation.selfApprovalAllowed ? ' and self-approval is allowed.' : '.'}`,
          { modal: true, detail: `Deterministic explanation: ${explanation.explanationSha256 ?? 'unavailable'}` }
        );
      } catch (error) {
        panel.report((error as Error).message);
      }
      return;
    }
    if (message.type === 'progressive-add' || message.type === 'progressive-protect'
        || message.type === 'managed-auto') {
      try {
        let argv: string[];
        if (message.type === 'progressive-add') {
          const id = await vscode.window.showInputBox({
            title: 'Add a narrower capability',
            prompt: 'Permanent lower-case kebab-case identifier',
            placeHolder: 'payments',
            ignoreFocusOut: true,
            validateInput: (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.trim())
              ? null : 'Use lower-case kebab-case.'
          });
          if (!id) return;
          const owns = await vscode.window.showInputBox({
            title: `What does ${id} own?`,
            prompt: 'One repository-relative directory. A trailing /** is optional.',
            placeHolder: 'services/payments/**',
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() && !value.includes('..') && !/[*?]/.test(value.replace(/\/\*\*$/, ''))
              ? null : 'Enter one safe repository-relative directory; only a trailing /** is allowed.'
          });
          if (!owns) return;
          const name = await vscode.window.showInputBox({
            title: 'Display name', placeHolder: id, value: id,
            prompt: 'Optional human-readable label', ignoreFocusOut: true
          });
          if (name === undefined) return;
          argv = ['capability', 'add', id, '--owns', owns, '--name', name.trim() || id, '--json'];
        } else if (message.type === 'managed-auto') {
          const eligibility = message.edits.autoEligibility ?? 'inherit';
          argv = ['capability', 'auto', message.id, '--eligibility', eligibility];
          if (eligibility !== 'inherit') {
            argv.push('--protected-scope', message.edits.autoProtectedScope ?? 'block');
            if (message.edits.autoMaximumTouchedPaths) {
              argv.push('--maximum-touched-paths', message.edits.autoMaximumTouchedPaths);
            }
            if (message.edits.autoMaximumConcurrentFlights) {
              argv.push('--maximum-concurrent-flights', message.edits.autoMaximumConcurrentFlights);
            }
          }
          argv.push('--json');
        } else {
          const protectedPath = await vscode.window.showInputBox({
            title: 'Protect a path',
            prompt: 'Changes under this repository-relative directory will require approval.',
            placeHolder: 'ledger/**',
            ignoreFocusOut: true,
            validateInput: (value) => value.trim() && !value.includes('..') && !/[*?]/.test(value.replace(/\/\*\*$/, ''))
              ? null : 'Enter one safe repository-relative directory; only a trailing /** is allowed.'
          });
          if (!protectedPath) return;
          const authorities = Object.entries(store.current.snapshot?.definition?.approvalAuthorities ?? {})
            .map(([id, authority]) => ({ label: authority.label ?? id, description: id, id }));
          const authority = authorities.length === 1 ? authorities[0] : await vscode.window.showQuickPick(authorities, {
            title: 'Who must approve changes?',
            placeHolder: 'Choose one approved authority group',
            ignoreFocusOut: true
          });
          if (!authority) return;
          const reason = await vscode.window.showInputBox({
            title: 'Reason for protection',
            prompt: 'Optional explanation recorded in the change receipt',
            ignoreFocusOut: true
          });
          if (reason === undefined) return;
          argv = ['capability', 'protect', protectedPath, '--approver', authority.id,
            ...(reason.trim() ? ['--reason', reason.trim()] : []), '--json'];
        }
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(argv)}`);
        const proposed = await client.run<{
          lead?: string; branch?: string | null; reviewRequired?: boolean;
          capabilityId?: string; receipt?: { changeId?: string }
        }>(argv);
        if (!proposed.reviewRequired || !proposed.branch || !proposed.lead) {
          await refreshAfterKnownMutation();
          return;
        }
        const run = async (command: string[]): Promise<{ result: unknown; error: string | null }> => {
          output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
          try { return { result: await client.run<unknown>(command), error: null }; }
          catch (error) { return { result: null, error: (error as Error).message }; }
        };
        const { CapabilityProposalPanel } = lazyPanels();
        CapabilityProposalPanel.show(context, proposed.lead, proposed.branch, run, async () => {
          await refreshAfterKnownMutation();
          panel.settled(proposed.capabilityId ?? 'repository-root');
        });
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        panel.report((error as Error).message);
      }
      return;
    }
    if (message.type === 'review-proposals') {
      await vscode.commands.executeCommand('singularityFlow.reviewCapabilityProposals');
      return;
    }
    if (message.type === 'remove') {
      const destination = message.reparentChildrenTo == null
        ? 'the top level'
        : message.reparentChildrenTo;
      const confirmed = await showCompactWarningMessage(
        `Remove ${message.id} from the capability map?`,
        {
          modal: true,
          detail: message.childCount
            ? `${message.childCount} direct ${message.childCount === 1 ? 'child' : 'children'} will move to ${destination} in the same reviewed proposal. Previous approved versions remain in Git history.`
            : 'The current map will no longer contain this capability. Previous approved versions remain in Git history.'
        },
        'Remove'
      );
      if (confirmed !== 'Remove') return;
    }
    try {
      const authorityRepository = store.current.snapshot?.capabilityMap?.authorityRepository?.trim();
      let selected: { url: string } | undefined = authorityRepository
        ? { url: authorityRepository }
        : undefined;
      if (!selected) {
        const leads = await client.run<Array<{ url?: string }>>(['capability', 'leads', '--json']);
        const available = leads.filter((entry): entry is { url: string } =>
          typeof entry.url === 'string' && entry.url.length > 0);
        if (!available.length) {
          throw new Error('No organisation lead repository is registered. Map the first capability before editing the organisation map.');
        }
        selected = available.length === 1 ? available[0] : await vscode.window.showQuickPick(
          available.map((entry) => ({ label: entry.url, entry })), {
            title: 'Choose capability-map authority',
            placeHolder: 'The approved map has no verified source; choose the repository that owns it'
          }).then((choice) => choice?.entry);
      }
      if (!selected) return;
      const mode = message.type === 'remove' ? 'remove' : 'set';
      const argv = capabilityProposalArgv(mode, message.id, selected.url,
        message.type === 'remove' ? {} : message.edits,
        message.type === 'remove'
          ? { reparentChildrenTo: message.reparentChildrenTo }
          : {});
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(argv)}`);
      const proposed = await client.run<{
        branch?: string | null; reviewRequired?: boolean; capabilityId?: string
      }>(argv);
      if (!proposed.reviewRequired || !proposed.branch) {
        await refreshAfterKnownMutation();
        panel.settled(message.type === 'remove' ? '' : message.id);
        return;
      }
      const run = async (command: string[]): Promise<{ result: unknown; error: string | null }> => {
        output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
        try { return { result: await client.run<unknown>(command), error: null }; }
        catch (error) {
          output.appendLine(`  failed: ${(error as Error).message}`);
          return { result: null, error: (error as Error).message };
        }
      };
      const { CapabilityProposalPanel } = lazyPanels();
      CapabilityProposalPanel.show(context, selected.url, proposed.branch, run, async () => {
        await refreshAfterKnownMutation();
        panel.settled(message.type === 'remove' ? '' : message.id);
      });
      return;
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      return panel.report((error as Error).message);
    }
  };

  /**
   * Open a fresh native Copilot chat for the governed Story in the repository that owns it.
   *
   * A Flow workspace may contain several repositories, while native Copilot inherits only the
   * folders open in this VS Code window. The selected Flow workspace already tells the engine which
   * repository owns the active Story; the handoff names that directory explicitly and starts a new
   * chat so a previous world-model-builder or unrelated repository conversation cannot leak into
   * the Story session.
  */
  const openGovernedCopilot = async (requestedWorkId?: string | null): Promise<void> => {
    const resolvedWorkId = store.current.snapshot?.workflow?.workItem.id ?? null;
    const activeWorkId = requestedWorkId ?? resolvedWorkId;
    // The repository snapshot is authoritative when it already resolves the requested Story. Only
    // attach when a handoff survived a branch change; re-attaching the Story already checked out
    // needlessly fetches and can reject a perfectly valid dirty development worktree.
    if (activeWorkId && resolvedWorkId !== activeWorkId) {
      const session = await client.run<{ ready?: boolean; workId?: string | null }>(['session', 'status', '--json']);
      if (session.ready !== true || session.workId !== activeWorkId) {
        await client.run(['session', 'attach', activeWorkId, '--json']);
        await refreshAfterKnownMutation();
      }
    }
    const prompt = await client.runText(['wm', 'show-prompt', '--record-audit']);
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      // `wm show-prompt --record-audit` returns and records this complete host handoff. Do not add
      // bytes here: the audit SHA must describe the exact query passed to native Copilot.
      query: prompt,
      isPartialQuery: false
    });
  };

  const openWorkspaceCopilot = async (workspaceName?: string | null): Promise<void> => {
    const handoff = [
      '# Singularity Flow workspace session',
      '',
      ...(workspaceName ? [`Workspace: ${workspaceName}`] : []),
      `Working directory: ${client.repository}`,
      '',
      'Use this repository as the working directory for every file and shell operation.',
      'This workspace is attached, but no governed Story is selected yet.',
      'Ask the contributor to run /sf-session and choose the exact Story before lifecycle work.',
      'Do not treat the checked-out Story or the only available Story as an implicit selection.',
      'Do not inspect or modify another repository merely because it was open in the previous chat.'
    ].join('\n');
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: handoff,
      isPartialQuery: false
    });
  };

  const configurationMessage = async (message: ConfigurationCenterMessage): Promise<ConfigurationCenterReply> => {
    if (message.type === 'inspect-test-setup') {
      const root = client.repository;
      try {
        const inspection = await client.run<import('./views/test-setup-model.ts').TestSetupInspection>([
          'capability', 'test-setup', ...message.sourceRoots.flatMap(directory => ['--source-root', directory]), '--json'
        ]);
        if (client.repository !== root || !sameStoryAttachPath(inspection.repositoryPath, root)) return 'The repository changed during inspection. Reopen Test setup.';
        return { error: null, inspection };
      } catch (error) { return (error as Error).message; }
    }
    if (message.type === 'save') {
      if (!message.writable) return message.blockedReason ?? 'The approved configuration authority is read-only.';
      const args = [
        'configuration', 'save', message.path, ...configurationSavePlanCliArgs(message)
      ];
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
      try {
        const text = await client.runText(args, { input: message.content });
        const disposition = configurationSaveDisposition(text, message.proposal);
        await refreshAfterKnownMutation();
        if (store.current.error) {
          output.appendLine(`  configuration refresh warning: ${store.current.error.message}`);
          void showCompactWarningMessage(
            `The configuration change completed, but the approved snapshot could not be refreshed: ${store.current.error.message}`
          );
        }
        if (disposition.kind === 'proposal') {
            const review = 'Review proposals';
            const selected = await showCompactInformationMessage(
              `Configuration proposal ${disposition.branch} was created from the approved authority. `
              + `Merge it into ${disposition.baseBranch}, then refresh workspace configuration. `
              + 'The application checkout was not changed.',
              review, 'Later'
            );
            if (selected === review) {
              await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'changes' });
            }
        } else if (disposition.kind === 'unchanged') {
            void showCompactInformationMessage(
              'The approved configuration already contains this change; no proposal was required.'
            );
        }
        return { error: null, disposition };
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }
    if (message.type === 'action' && message.action === 'refresh') {
      try {
        await store.refresh();
        if (store.current.error) {
          output.appendLine(`  configuration refresh refused: ${store.current.error.message}`);
          return store.current.error.message;
        }
        await lazyPanels().IntakePanel.configurationChanged(repository);
        return null;
      } catch (error) {
        output.appendLine(`  configuration refresh refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }
    if (message.type === 'action' && message.action === 'pending-proposals') {
      try {
        const proposals = await client.run<Array<{
          branch: string; proposalCommit: string; targetBranch?: string; merged: boolean;
        }>>(['workflow', 'proposals', '--all', '--json']);
        return { error: null, proposals };
      } catch (error) {
        output.appendLine(`  configuration proposal refresh refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }
    if (message.type === 'proposal-status') {
      try {
        const proposalStatus = await client.run<{
          branch: string; proposalCommit: string; targetBranch: string;
          merged: boolean; branchStatus: string;
        }>([
          'workflow', 'proposal-status', message.branch,
          '--commit', message.proposalCommit, '--json'
        ]);
        return { error: null, proposalStatus };
      } catch (error) {
        output.appendLine(`  configuration proposal status refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }
    if (message.type === 'profile') {
      try {
        if (!isProfilePersonaId(message.role)) return 'Choose a supported menu persona.';
        const settings = vscode.workspace.getConfiguration('singularityFlow');
        await Promise.all([
          settings.update('userName', message.name.trim(), vscode.ConfigurationTarget.Global),
          settings.update('role', message.role, vscode.ConfigurationTarget.Global),
          context.globalState.update('onboardingComplete', true)
        ]);
        refreshPersonaMenus();
        return null;
      } catch (error) { return (error as Error).message; }
    }
    if (message.type === 'add-current-identity') {
      const args = [
        'configuration', 'add-current-identity', '--target', message.target,
        '--self-approval', message.allowSelfApproval ? 'on' : 'off',
        '--auto-enroll', message.autoEnrollNewIdentities ? 'on' : 'off'
      ];
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
      try {
        const result = await client.run<{
          changed: boolean; pushed: boolean; commit: string;
          groups: Array<{ id: string; scope: string }>;
          transportIntent?: string; transportStatus?: string;
          nextAction?: { command?: string; skill?: string; copilotCommand?: string } | null;
        }>(args);
        if (result.changed && !result.pushed) {
          const next = commandGuidanceText(result.nextAction);
          return `Configuration commit ${result.commit.slice(0, 8)} is retained, but publication is ${result.transportStatus ?? 'pending'}. ${next ? `Continue with:\n${next}` : 'Open Push recovery to continue.'}`;
        }
        await refreshAfterKnownMutation();
        if (!result.changed) {
          void showCompactInformationMessage('Your current Git identity already belongs to the selected approval groups.');
        } else {
          void showCompactInformationMessage(
            `People & approvals updated on sflow/config (${result.commit.slice(0, 8)}). Future Stories will use it.`
          );
        }
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }

    /**
     * A template row was clicked. Path-carrying rather than a named action, and validated against
     * the snapshot's own template list rather than trusted: a webview message is untrusted input,
     * and `openArtifact` would otherwise open any path the message named.
     */
    if (message.type === 'open-path') {
      const active = activeRepositoryContext();
      if (!active || active.root !== client.repository) {
        return 'The selected repository changed. Refresh the Explorer before opening repository content.';
      }
      const target = configurationPathTarget(store.current.snapshot, message.path);
      if (target.kind === 'unavailable') return target.message;
      if (target.kind === 'captured') {
        // A governed model normally lives only on the state branch. Open the exact content already
        // captured by the read-only snapshot instead of pretending the file exists in the
        // application checkout or projecting state bytes into it.
        const extension = message.path.split('.').pop()?.toLowerCase();
        const language = extension === 'json' || extension === 'jsonl'
          ? 'json'
          : extension === 'yml' || extension === 'yaml'
            ? 'yaml'
            : 'markdown';
        const document = await vscode.workspace.openTextDocument({
          content: target.content,
          language
        });
        await vscode.window.showTextDocument(document, { preview: true });
        return null;
      }
      const label = message.path.split('/').pop() ?? message.path;
      await openArtifact(client.repository, { kind: 'artifact', id: `file:${message.path}`, label, path: message.path });
      return null;
    }

    if (message.type === 'open-world-model-ref') {
      const snapshot = store.current.snapshot;
      const references = [
        ...(snapshot?.worldModel?.expansion ?? []),
        ...(snapshot?.worldModel?.views ?? []).flatMap((view) => view.expansion ?? [])
      ];
      const selected = references.find((entry) => entry.ref === message.ref);
      if (!selected) return 'This world-model reference is no longer current. Refresh the Explorer and try again.';
      const active = activeRepositoryContext();
      if (!active || active.root !== client.repository) {
        return 'The selected repository changed. Refresh the Explorer before opening state-backed world-model content.';
      }
      try {
        const { kernel } = gatewaySession(active);
        const resolution = await kernel.resolve({
          utterance: 'show registered world model',
          arguments: { entity: 'expansion', id: selected.ref, maximumBytes: 65_536 }
        });
        const envelope = resolution.kind === 'read' && resolution.next?.length === 1
          ? await kernel.read({ resolutionId: resolution.next[0].handle })
          : resolution;
        const page = envelope?.data?.worldModel?.value;
        if (page?.kind !== 'world-model-exact-expansion' || page.encoding !== 'base64') {
          const reason = envelope?.why?.[0]?.code ?? 'world-model.entity-unavailable';
          return `The exact state-backed record could not be opened (${reason}).`;
        }
        const exact = Buffer.from(page.content, 'base64').toString('utf8');
        const complete = page.complete === true;
        const content = complete
          ? exact
          : `${exact}\n\n[Bounded at ${page.bytes} of ${page.totalBytes} bytes. Use the CLI or gateway cursor to read the remaining exact record.]\n`;
        const language = complete && page.contentType === 'application/json'
          ? 'json'
          : complete && page.contentType === 'text/markdown'
            ? 'markdown'
            : 'plaintext';
        const document = await vscode.workspace.openTextDocument({ content, language });
        await vscode.window.showTextDocument(document, { preview: true });
        if (!complete) {
          void showCompactInformationMessage(
            `Opened a bounded ${page.bytes}-byte preview of ${selected.kind}:${selected.id}.`
          );
        }
        return null;
      } catch (error) {
        output.appendLine(`  world-model expansion refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }

    if (message.action === 'after-install') await vscode.commands.executeCommand('singularityFlow.afterInstall');
    else if (message.action === 'repository-setup') await vscode.commands.executeCommand(
      'singularityFlow.repairRepositorySetup', { repositoryPath: client.repository }
    );
    else if (message.action === 'capability-refresh') await vscode.commands.executeCommand(
      'singularityFlow.refreshCapability', { repositoryPath: client.repository }
    );
    else if (message.action === 'capabilities') await vscode.commands.executeCommand('singularityFlow.openCapabilities');
    else if (message.action === 'add-capability') await vscode.commands.executeCommand('singularityFlow.addCapability');
    else if (message.action === 'proposals') await vscode.commands.executeCommand('singularityFlow.reviewCapabilityProposals');
    // A configuration proposal the Center created waits in Workflow Studio's Changes, with its diff and activation.
    else if (message.action === 'workflow-proposals') await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'changes' });
    else if (message.action === 'workflow') await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio');
    else if (message.action === 'workflow-studio') await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio');
    else if (message.action === 'shared-workflow-drafts') await vscode.commands.executeCommand(
      'singularityFlow.openSharedWorkflowDrafts', { repositoryPath: client.repository }
    );
    else if (message.action === 'instructions') await vscode.commands.executeCommand('singularityFlow.openInstructionDesigner');
    else if (message.action === 'world-model') { await openConfigurationCenter('world-model'); return null; }
    else if (message.action === 'ast-intelligence') await vscode.commands.executeCommand('singularityFlow.configureAstIntelligence');
    else if (message.action === 'people') { await openConfigurationCenter('people'); return null; }
    else if (message.action === 'mcp') { await openConfigurationCenter('mcp'); return null; }
    else if (message.action === 'models') { await openConfigurationCenter('models'); return null; }
    else if (message.action === 'templates') { await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'artifacts' }); return null; }
    else if (message.action === 'skills') { await vscode.commands.executeCommand('singularityFlow.openSkills'); return null; }
    // Absorbed from the Configuration sidebar section, which now only leads here.
    else if (message.action === 'publish-configuration') await vscode.commands.executeCommand('singularityFlow.publishConfiguration');
    else if (message.action === 'reset-jira') await vscode.commands.executeCommand('singularityFlow.resetJira');
    else if (message.action === 'open-designer') await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio');
    else if (message.action === 'open-instruction-designer') await vscode.commands.executeCommand('singularityFlow.openInstructionDesigner');
    else if (message.action === 'open-specification-trace') await vscode.commands.executeCommand('singularityFlow.openSpecificationTrace');
    else if (message.action === 'open-flow-impact') await vscode.commands.executeCommand('singularityFlow.openFlowImpact');
    else if (message.action === 'open-copilot') await vscode.commands.executeCommand('singularityFlow.openCopilot');
    else if (message.action === 'test-setup-copilot') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/sf-test-setup Inspect the selected repository and suggest its test commands and reporters. Ask before changing configuration or running tests.',
        isPartialQuery: true
      });
      return null;
    }
    else if (message.action === 'open-prompt-audit') await vscode.commands.executeCommand('singularityFlow.openPromptAudit');
    else if (message.action === 'inspect-composition-cache') await vscode.commands.executeCommand('singularityFlow.inspectCompositionCache');
    else if (message.action === 'check-ledger-deployment') await vscode.commands.executeCommand('singularityFlow.checkLedgerDeployment');
    else if (message.action === 'open-impact-file') await openArtifact(client.repository, { kind: 'artifact', id: 'config:impact', label: 'impact.yml', path: 'singularity/impact.yml' });
    else if (message.action === 'build-world-model') {
      await vscode.commands.executeCommand('singularityFlow.buildWorldModel');
      return null;
    }
    else if (message.action === 'rebuild-world-model') {
      await vscode.commands.executeCommand('singularityFlow.rebuildWorldModel');
      return null;
    }
    else if (message.action === 'architecture-export') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/sf-architecture export the current CALM projection to ', isPartialQuery: true
      });
      return null;
    }
    else if (message.action === 'architecture-planned') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/sf-architecture show the approved planned architecture for the active Story',
        isPartialQuery: true
      });
      return null;
    }
    else if (message.action === 'architecture-compare') {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '/sf-architecture compare these two CALM projection files: ', isPartialQuery: true
      });
      return null;
    }
    else if (message.action === 'diagnose-monorepo') {
      output.appendLine('\n$ singularity-flow doctor --performance --offline');
      output.show(true);
      try {
        await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Benchmarking repository and world-model scope…',
          cancellable: false
        }, () => client.runText(['doctor', '--performance', '--offline']));
        void showCompactInformationMessage(
          'Repository performance benchmark completed. Review measured timings and recommendations in the Singularity Flow output.');
      } catch (error) {
        return `${(error as Error).message}\nThe complete diagnostic output is available in the Singularity Flow output channel.`;
      }
      return null;
    }
    else if (message.action === 'prompt-audit') await vscode.commands.executeCommand('singularityFlow.openPromptAudit');
    else if (message.action === 'visual-assurance') await vscode.commands.executeCommand('singularityFlow.openVisualAssurance');
    else if (message.action === 'jira') await vscode.commands.executeCommand('singularityFlow.connectJira');
    else if (message.action === 'teams') await vscode.commands.executeCommand('singularityFlow.configureTeams');
    else if (message.action === 'open-workflow') await openArtifact(client.repository, { kind: 'artifact', id: 'config:workflow', label: 'workflow.yml', path: store.current.snapshot?.definitionPath ?? 'singularity/workflow.yml' });
    // The routing panel is read-only, so this is the only way out of it — editing the mapping means
    // editing the governed file, which is the point.
    else if (message.action === 'open-model-tiers') await openArtifact(client.repository, { kind: 'artifact', id: 'config:model-tiers', label: 'modelTiers.yml', path: store.current.snapshot?.modelRouting?.path ?? 'singularity/modelTiers.yml' });
    else if (message.action === 'open-portfolio') await openArtifact(client.repository, { kind: 'artifact', id: 'config:portfolio', label: 'portfolio.yml', path: store.current.snapshot?.portfolioPath ?? 'singularity/portfolio.yml' });
    else if (message.action === 'playwright') {
      try {
        await client.runText(['mcp', 'scaffold', 'playwright']);
        await refreshAfterKnownMutation();
        void showCompactInformationMessage('Playwright MCP host configuration created. Review it, then trust and start it through VS Code MCP: List Servers. The managed host requires the global Singularity Flow CLI; VSIX-only installation does not provide that launcher.');
      } catch (error) {
        const detail = (error as Error).message;
        // A differing entry is not a terminal-only recovery exercise. Keep unrelated MCP servers,
        // show exactly what replacement means, and let the contributor make the same explicit
        // decision the CLI's --replace-server flag represents without leaving Configuration Center.
        if (!detail.includes('--replace-server')) return detail;
        const confirmed = await showCompactWarningMessage(
          'Replace the existing Playwright MCP host entry?',
          {
            modal: true,
            detail: 'Only the Playwright server entry in .vscode/mcp.json will be replaced with the release-pinned starter. Other MCP servers and inputs are preserved.'
          },
          'Replace Playwright entry'
        );
        if (confirmed !== 'Replace Playwright entry') return 'The existing Playwright MCP host entry was left unchanged.';
        try {
          await client.runText(['mcp', 'scaffold', 'playwright', '--replace-server']);
          await refreshAfterKnownMutation();
          void showCompactInformationMessage('Playwright MCP host entry replaced. Review it, then trust and start it through VS Code MCP: List Servers. The managed host requires the global Singularity Flow CLI; VSIX-only installation does not provide that launcher.');
        } catch (replacementError) { return (replacementError as Error).message; }
      }
    } else if (message.action === 'open-mcp-host') {
      const hostFile = vscode.Uri.file(path.join(client.repository, '.vscode', 'mcp.json'));
      try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(hostFile), { preview: false }); }
      catch { return 'No .vscode/mcp.json exists yet. Add a Playwright starter or create a host configuration first.'; }
    }
    return null;
  };

  const openConfigurationCenter = async (tab: ConfigurationTab = 'overview'): Promise<void> => {
    const { ConfigurationCenterPanel } = lazyPanels();
    await ConfigurationCenterPanel.show(context, store, () => {
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      return {
        name: settings.get<string>('userName') ?? '',
        role: resolveProfilePersona(settings.get<string>('role')).id
      };
    }, configurationMessage, tab);
  };

  // The commands themselves were registered at activation; this is what they do once there is a
  // repository to do it against.
  const refreshAfterSurfaceMutation = async (): Promise<void> => {
    const refreshHome = lastHome !== null;
    resetGatewaySession(); lastHome = null;
    await refreshAfterKnownMutation();
    if (refreshHome) await vscode.commands.executeCommand('singularityFlow.myWork');
  };

  /**
   * The file an explain menu was opened on (and, from the editor, the cursor line) as a Change
   * Explorer focus request, or a refusal in the same words "What If I Change This?" uses.
   */
  const explainFocusRequest = async (argument: unknown, atCursor: boolean): Promise<ExplorerFocusRequest | null> => {
    const active = activeRepositoryContext();
    const editor = vscode.window.activeTextEditor;
    const selected = atCursor ? editor?.document.uri ?? null : menuResource(argument) ?? editor?.document.uri ?? null;
    if (!active || !selected || selected.scheme !== 'file') {
      showRefusal('Open a file inside the active governed repository, then try again.', { headline: 'No code selected' });
      return null;
    }
    const relative = await repositoryRelativePath(active.root, selected.fsPath);
    if (!relative) {
      showRefusal('The selected file is outside the active governed repository.', { headline: 'Selection is out of scope' });
      return null;
    }
    // Singularity Flow's own records and agent files are not application code (code-explainer-model).
    if (['singularity', '.github/agents', '.singularity-flow'].some((root) => relative === root || relative.startsWith(`${root}/`))) {
      showRefusal('This is one of Singularity Flow\'s own files, not application code, so it is not explained. Open an application file instead.', { headline: 'Not application code' });
      return null;
    }
    const document = vscode.workspace.textDocuments?.find((entry) => entry.uri.fsPath === selected.fsPath);
    return {
      path: relative,
      line: atCursor && editor ? editor.selection.active.line + 1 : null,
      unsaved: Boolean(document?.isDirty ?? (atCursor && editor?.document.isDirty))
    };
  };
  const showChangeExplorerFocused = async (argument: unknown, atCursor: boolean): Promise<unknown> => {
    await reconcileActiveWorkspaceSelection();
    const focus = await explainFocusRequest(argument, atCursor);
    if (!focus) return undefined;
    const { ComprehensionCenterPanel } = lazyPanels();
    return ComprehensionCenterPanel.show(context, store, client, { tab: 'explorer', focus });
  };
  // The Code Explainer at the cursor: the function there, its callers and callees, and how the
  // change touches them. A file outside the governed repository is refused in the same words.
  const showCodeExplainer = async (atCursor: boolean): Promise<unknown> => {
    await reconcileActiveWorkspaceSelection();
    const { CodeExplainerPanel } = lazyPanels();
    // The gate count is the status bar's, from the same derivation, for the same repository and Story.
    const services = {
      gates: () => {
        const active = activeRepositoryContext();
        const workId = store.current.snapshot?.workflow?.workItem.id ?? null;
        return active && statusChromeCache && statusChromeCache.repository === path.resolve(active.root)
          && statusChromeCache.workId === workId ? statusChromeCache.value.gates ?? null : null;
      }
    };
    if (!atCursor) return CodeExplainerPanel.show(context, store, client, { services });
    const focus = await explainFocusRequest(undefined, true);
    if (!focus) return undefined;
    return CodeExplainerPanel.show(context, store, client, { focus: { path: focus.path, line: focus.line }, services });
  };

  // What a person reviews before a configuration change (a proposal's diff, an import plan) opens
  // read-only and memory-backed, so reviewing leaves nothing to save. The name's extension picks the
  // language: .diff or .md.
  const reviewDocuments = new Map<string, string>();
  let storyIntakePanel: vscode.WebviewPanel | null = null;
  let storyIntakeRequest = 0;
  let phaseArtifactsPanel: vscode.WebviewPanel | null = null;
  let phaseArtifactsRequest = 0;
  let reviewDocumentProvider: vscode.Disposable | null = null;
  const showReviewDocument = async (name: string, content: string): Promise<void> => {
    if (!reviewDocumentProvider) {
      reviewDocumentProvider = vscode.workspace.registerTextDocumentContentProvider('sflow-review', {
        provideTextDocumentContent: (uri) => reviewDocuments.get(uri.toString()) ?? 'This preview is no longer open. Reopen it from its original view.'
      });
      context.subscriptions.push(reviewDocumentProvider, vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === 'sflow-review') reviewDocuments.delete(document.uri.toString());
      }));
    }
    const uri = vscode.Uri.from({ scheme: 'sflow-review', path: `/${name.replace(/[^A-Za-z0-9._/ -]/g, '-')}`, query: String(Date.now()) });
    reviewDocuments.set(uri.toString(), content);
    if (/\.md$/iu.test(name)) await vscode.commands.executeCommand('markdown.showPreview', uri);
    else await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
  };
  // Governed workflow configuration routines: review and activate a configuration proposal, propose
  // a change after previewing it, and export, import or copy workflows. Workflow Studio calls them;
  // every mutation goes through the engine's validation and the repository's review proposal.
  const reviewAndActivateWorkflowProposal = async (branch: string): Promise<string | null> => {
    try {
      const inspected = await client.run<{
        branch: string; proposalCommit: string; targetBranch: string; diff: string;
        valid: boolean; workflows?: Array<{ id: string; change: string }>;
      }>(['workflow', 'proposal', branch, '--json']);
      await showReviewDocument(`${inspected.branch}.diff`, inspected.diff || 'No textual diff.');
      if (!inspected.valid) {
        const message = 'The workflow proposal contains invalid or out-of-scope configuration changes.';
        showRefusal(message, { headline: 'Workflow proposal cannot be activated' });
        return message;
      }
      const merge = 'Merge exact proposal';
      const confirmed = await showCompactWarningMessage(
        `Merge ${inspected.branch}@${inspected.proposalCommit.slice(0, 12)} into ${inspected.targetBranch}?`,
        {
          modal: true,
          detail: 'The complete diff is open for review. Git dry-runs cannot prove server review enforcement, so the command stops before the exact leased update and asks for a separate acknowledgement. The application branch is never changed.'
        },
        merge
      );
      if (confirmed !== merge) return null;
      const baseArguments = [
        'workflow', 'activate', inspected.branch,
        '--confirm', inspected.proposalCommit, '--json'
      ];
      let activation: {
        activated?: boolean; status?: string; targetBranch?: string; targetCommit?: string;
        failure?: { message?: string }; nextAction?: string;
      };
      try {
        activation = await client.run(baseArguments);
      } catch (error) {
        if (!/WORKFLOW_CONFIGURATION_UNPROTECTED|cannot prove whether|branch protection is not enforced|accepted the exact dry-run update/i
          .test((error as Error).message)) throw error;
        const acknowledge = 'Acknowledge and merge';
        const accepted = await showCompactWarningMessage(
          `Git cannot determine whether ${inspected.targetBranch} permits this direct update without attempting it. Authorize one exact leased update for the reviewed workflow proposal?`,
          { modal: true, detail: 'The acknowledgement applies only to this exact proposal commit. Server review controls and hooks may still refuse it. The application branch remains unchanged.' },
          acknowledge
        );
        if (accepted !== acknowledge) return null;
        activation = await client.run([
          ...baseArguments.slice(0, -1), '--acknowledge-unprotected', '--json'
        ]);
      }
      if (activation.activated === false) {
        const message = activation.failure?.message
          ?? `Workflow activation is ${activation.status ?? 'waiting for repository review'}.`;
        void showCompactWarningMessage(message);
        return message;
      }
      await refreshAfterKnownMutation();
      void showCompactInformationMessage(
        `Workflow configuration activated on ${activation.targetBranch ?? 'sflow/config'} at `
        + `${activation.targetCommit?.slice(0, 12) ?? 'the reviewed commit'}. `
        + 'It is now available to new Stories; refresh workspace configuration to project it to other repositories.'
      );
      return null;
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      showRefusal(error, { headline: 'Could not activate workflow configuration proposal' });
      return (error as Error).message;
    }
  };
  /**
   * One proposal boundary for workflow configuration changes made outside Workflow Studio's change
   * set (an imported bundle).
   *
   * Keeping these routes here means the extension never writes workflow configuration directly:
   * every mutation receives the same validation, lead-authority proposal, exact-diff review, and
   * local-authority draft treatment as the existing authoring controls.
  */
  const proposeWorkflowChange = async (baseCommand: string[], title: string): Promise<WorkflowChangeOutcome> => {
    const command = [...baseCommand];
    if (!command.includes('--propose')) command.push('--propose');
    if (!command.includes('--json')) command.push('--json');
    output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
    try {
      const proposal = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false
      }, () => client.run<{
        branch?: string; commit?: string; files?: string[]; reviewRequired?: boolean;
        baseBranch?: string; nextAction?: string; authorityMode?: string;
      }>(command));
      await refreshAfterKnownMutation();
      if (proposal.reviewRequired && proposal.branch) {
        const files = proposal.files?.length ?? 0;
        const review = 'Review and activate';
        const selected = await showCompactInformationMessage(
          `Workflow proposal ${proposal.branch} was pushed with ${files} configuration file${files === 1 ? '' : 's'}. `
          + `It remains visible as Pending review until it is merged into ${proposal.baseBranch ?? 'sflow/config'}. `
          + 'The active Story was not changed.',
          review, 'Later'
        );
        if (selected === review) {
          const stopped = await reviewAndActivateWorkflowProposal(proposal.branch);
          return { outcome: 'proposed', branch: proposal.branch, error: stopped };
        }
        return { outcome: 'proposed', branch: proposal.branch, error: null };
      } else if (proposal.authorityMode === 'local') {
        const openSourceControl = 'Open Source Control';
        const selected = await showCompactInformationMessage(
          'Workflow configuration was saved as an uncommitted local draft. Review and commit '
          + 'it through the local configuration authority; no proposal was pushed and it is '
          + 'not yet available to new Stories.',
          openSourceControl, 'Later'
        );
        if (selected === openSourceControl) {
          await vscode.commands.executeCommand('workbench.view.scm');
        }
        return { outcome: 'written', error: null };
      }
      void showCompactInformationMessage('The approved configuration already contains this workflow change.');
      return { outcome: 'unchanged', error: null };
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      showRefusal(error, { headline: 'Could not create workflow configuration proposal' });
      return { outcome: 'failed', error: (error as Error).message };
    }
  };
  const exportWorkflowBundle = async (workflowIds: readonly string[]): Promise<string | null> => {
    const target = await vscode.window.showSaveDialog({
      title: 'Export portable workflow bundle',
      saveLabel: 'Export bundle',
      defaultUri: vscode.Uri.file(path.join(repository, 'singularity-flow-workflows.json')),
      filters: { 'Workflow bundle': ['json'] }
    });
    if (!target) return null;
    const command = ['workflow', 'export'];
    for (const workflowId of workflowIds) command.push('--workflow', workflowId);
    command.push('--out', target.fsPath, '--json');
    output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Exporting ${workflowIds.length} workflow${workflowIds.length === 1 ? '' : 's'}`,
        cancellable: false
      }, () => client.run<{ notes?: unknown }>(command));
      // Skills attached in the attachments file stay behind; the export says which.
      const notes = Array.isArray(result?.notes) ? result.notes.filter((note): note is string => typeof note === 'string') : [];
      void showCompactInformationMessage(
        `Exported ${workflowIds.length} workflow${workflowIds.length === 1 ? '' : 's'} and their dependencies to ${target.fsPath}.${notes.length ? ` ${notes.join(' ')}` : ''}`
      );
      return null;
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      showRefusal(error, { headline: 'Could not export workflows' });
      return (error as Error).message;
    }
  };
  const importWorkflowBundle = async (): Promise<WorkflowChangeOutcome> => {
    const selected = await vscode.window.showOpenDialog({
      title: 'Import portable workflow bundle',
      openLabel: 'Import bundle',
      defaultUri: vscode.Uri.file(repository),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Workflow bundle': ['json'] }
    });
    const source = selected?.[0];
    if (!source) return { outcome: 'cancelled', error: null };
    const { WorkflowTransferPanel } = await import('./views/workflow-transfer-panel.ts');
    return WorkflowTransferPanel.show(`Import ${path.basename(source.fsPath)}`,
      (choices) => client.run<WorkflowMutationPreview>(['workflow', 'import', source.fsPath,
        ...workflowImportResolveArgs(choices), '--resolve-all', 'suggested', '--dry-run', '--json']),
      (plan, choices) => proposeWorkflowChange(['workflow', 'import', source.fsPath,
        ...workflowImportResolveArgs({ ...choices, ...plan.resolutions }), '--confirm', plan.planSha256!], 'Importing workflows'));
  };
  const duplicateWorkflow = async (selector: string): Promise<WorkflowChangeOutcome> => {
    const catalog = await client.run<{ workflows: { id: string; label: string }[]; epics?: { workflows: { id: string; label: string }[] } }>(['workflow', 'studio', '--json']);
    const sourceId = selector.slice(selector.indexOf(':') + 1);
    const epic = selector.startsWith('initiative:');
    const all = [...catalog.workflows, ...(catalog.epics?.workflows ?? [])];
    const source = (epic ? catalog.epics?.workflows : catalog.workflows)?.find((entry) => entry.id === sourceId);
    if (!source) return { outcome: 'failed', error: 'Refresh Workflow Studio: this workflow is no longer available.' };
    let target = `${sourceId}-copy`, index = 2;
    while (all.some((entry) => entry.id === target)) target = `${sourceId}-copy-${index++}`;
    const subject = `${epic ? 'initiative-workflow' : 'workflow'}:${sourceId}`;
    const command = (choices: Record<string, WorkflowImportChoice>) => ['workflow', 'duplicate', selector,
      choices[subject]?.to ?? target, '--label', `${source.label} copy`, ...workflowImportResolveArgs(choices)];
    const { WorkflowTransferPanel } = await import('./views/workflow-transfer-panel.ts');
    return WorkflowTransferPanel.show(`Duplicate ${source.label}`,
      (choices) => client.run<WorkflowMutationPreview>([...command(choices), '--dry-run', '--json']),
      (plan, choices) => proposeWorkflowChange([...command({ ...choices, ...plan.resolutions }), '--confirm', plan.planSha256!], `Duplicating ${source.label}`));
  };

  const registered: Record<string, (...args: never[]) => unknown> = {
    'singularityFlow.openCapabilities':
      async () => {
        const { CapabilitiesPanel } = lazyPanels();
        void refreshReadiness();
        return CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); });
      },
    'singularityFlow.openImpact': async () => {
      const { ImpactPanel } = lazyPanels();
      return ImpactPanel.show(context, store, client);
    },
    'singularityFlow.openFlowImpact': async () => {
      const { FlowImpactPanel } = lazyPanels();
      return FlowImpactPanel.show(context, store, client);
    },
    'singularityFlow.openStories':
      async () => {
        const { StoriesPanel } = lazyPanels();
        return StoriesPanel.show(context, store, (message) => { void onStoriesMessage(message); });
      },
    'singularityFlow.openApprovals':
      async () => {
        const { ApprovalsPanel } = lazyPanels();
        return ApprovalsPanel.show(context, store, (message) => { void onApprovalsMessage(message); });
      },
    'singularityFlow.openInbox':
      async () => {
        const { InboxPanel } = lazyPanels();
        return InboxPanel.show(context, store, onInboxMessage,
          () => workspaceStoryCatalog, () => repository, () => workspaceStoryCatalogIssue, () => inboxRepositoryBinding);
      },
    'singularityFlow.openWorkspaceStories': async () => {
      const { InboxPanel } = lazyPanels();
      return InboxPanel.show(context, store, onInboxMessage,
        () => workspaceStoryCatalog, () => repository, () => workspaceStoryCatalogIssue, () => inboxRepositoryBinding, 'stories');
    },
    'singularityFlow.openReviews': async () => {
      const { InboxPanel } = lazyPanels();
      return InboxPanel.show(context, store, onInboxMessage,
        () => workspaceStoryCatalog, () => repository, () => workspaceStoryCatalogIssue, () => inboxRepositoryBinding, 'reviews');
    },
    'singularityFlow.openConfigurationApprovals': async () =>
      vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'changes' }),
    // Backward-compatible command ID for old keybindings and links; it never opens a second home.
    'singularityFlow.openDeveloperHome': async () =>
      vscode.commands.executeCommand('singularityFlow.myWork'),
    'singularityFlow.expandReference': expandReference as never,
    'singularityFlow.openHarnessReport': openHarnessReport,
    'singularityFlow.continueSafely': async () => {
      if (await runPlannedAction(client, output)) await refreshAfterKnownMutation();
    },
    'singularityFlow.startWork': startWork,
    'singularityFlow.openAdhocWork': async () => {
      const choice = await vscode.window.showQuickPick([
        {
          label: '$(diff) Observe existing work',
          description: 'Create a local landing preview; no commit or push',
          action: 'land'
        },
        {
          label: '$(record) Start before editing',
          description: 'Record an exact clean baseline for an in-place session',
          action: 'start'
        },
        {
          label: '$(list-tree) View current session',
          description: 'Show baseline, effects, intent, packet, and publication status',
          action: 'status'
        },
        {
          label: '$(book) Open ad hoc guide',
          description: 'Read the reviewed offline procedure and recovery guidance',
          action: 'guide'
        }
      ], { title: 'Ad Hoc Work & Governed Landing', placeHolder: 'Choose a safe next step' });
      if (!choice) return;
      if (choice.action === 'guide') {
        await vscode.commands.executeCommand('singularityFlow.explainTopic', { id: 'help:topic:ad-hoc-work' });
        return;
      }
      try {
        let result: unknown;
        if (choice.action === 'start') {
          const note = await vscode.window.showInputBox({
            title: 'Start ad hoc work',
            prompt: 'Optional note; it is not treated as an approved specification',
            placeHolder: 'Investigate checkout latency'
          });
          if (note === undefined) return;
          result = await client.run(['adhoc', 'start', ...(note.trim() ? [note.trim()] : []), '--json']);
        } else if (choice.action === 'land') {
          const selected = await showCompactWarningMessage(
            'Observe all current tracked and untracked changes as one ad hoc landing candidate?',
            {
              modal: true,
              detail: 'This writes only a machine-local session and preview. It does not commit, push, approve, or fabricate pre-work intent.'
            },
            'Observe current work'
          );
          if (selected !== 'Observe current work') return;
          result = await client.run(['land', '--json']);
        } else {
          result = await client.run(['adhoc', 'status', '--json']);
        }
        const document = await vscode.workspace.openTextDocument({
          language: 'json', content: `${JSON.stringify(result, null, 2)}\n`
        });
        await vscode.window.showTextDocument(document, { preview: true });
        const next = await showCompactInformationMessage(
          'Ad hoc record opened. Continue the reviewed intent, disposition, verification, and exact-packet steps in Copilot or the terminal.',
          'Open Copilot', 'Open terminal command'
        );
        if (next === 'Open Copilot') {
          await vscode.commands.executeCommand('workbench.action.chat.open', { query: '/sf-adhoc ' });
        } else if (next === 'Open terminal command') {
          const terminal = vscode.window.createTerminal({
            name: 'Singularity Flow · Ad Hoc', cwd: client.repository
          });
          terminal.show(true);
          // Prefill only. The contributor reviews and submits the command.
          terminal.sendText('singularity-flow adhoc status', false);
        }
      } catch (error) {
        showRefusal(error, { headline: 'Ad hoc work could not continue' });
      }
    },
    'singularityFlow.attachEvidence': manageEvidence,
    'singularityFlow.manageEvidence': manageEvidence,
    'singularityFlow.detachEvidence': detachEvidence as never,
    'singularityFlow.addSource': addSource,
    'singularityFlow.refresh': async () => {
      await reconcileActiveWorkspaceSelection();
      try {
        await refreshRemoteStories();
      } catch (error) {
        output.appendLine(`Story refresh failed: ${(error as Error).message}`);
        showRefusal(error, { headline: 'Could not refresh every workspace Story' });
      }
      void refreshReadiness(true);
      void refreshWorkspaceLogsTree();
    },
    // A supporting document in a tree opens the way the evidence manager opens it: an image or PDF in
    // its viewer, an Office file as its extracted text, a text file read-only. Only artifacts go
    // through the plain text editor, which has no way to show a binary file.
    'singularityFlow.openArtifact':
      ((node?: TreeNode) => {
        const evidence = resolveEvidenceNode(node);
        return evidence ? openEvidence(evidence) : openArtifact(repository, node, cliPackageRoot);
      }) as never,
    'singularityFlow.openPhaseArtifacts': async () => {
      await reconcileActiveWorkspaceSelection();
      const workId = store.current.snapshot?.workflow?.workItem.id;
      if (!repository || !workId) { void showCompactWarningMessage('Select and attach a Story from Stories to browse its phase artifacts.'); return; }
      const checkedRepository = repository;
      const scope = repositoryEpoch.capture();
      const request = ++phaseArtifactsRequest;
      let alive = true;
      const stillCurrent = (): boolean => alive && request === phaseArtifactsRequest
        && repositoryEpoch.isCurrent(scope) && repository === checkedRepository
        && store.current.snapshot?.workflow?.workItem.id === workId;
      try {
        const catalog = await client.run<import('./views/phase-artifacts-page.ts').PhaseArtifactCatalog>(
          ['documents', 'artifacts', '--work-id', workId, '--json'], undefined, { priority: 'interactive' });
        if (!stillCurrent() || catalog.workId !== workId) return;
        const { showPhaseArtifacts, artifactPreviewMarkdown } = await lazyPanels();
        if (!stillCurrent()) return;
        phaseArtifactsPanel?.dispose();
        const panel = showPhaseArtifacts(catalog, async (id, version) => {
          if (!stillCurrent()) return;
          const phase = catalog.phases.find(item => item.artifacts.some(artifact => artifact.id === id));
          if (!phase) return;
          try {
            const preview = await client.run<import('./views/phase-artifacts-page.ts').PhaseArtifactPreview>(
              ['documents', 'artifacts', id, '--version', version, '--work-id', workId, '--json'], undefined, { priority: 'interactive' });
            if (!stillCurrent()) return;
            if (preview.workId !== workId || preview.record?.id !== id || preview.phase !== phase.id
                || preview.version !== version || preview.generation !== phase.generation) {
              void showCompactWarningMessage('Artifact generation changed. Refresh Artifacts before opening this version.'); return;
            }
            await showReviewDocument(`${workId}/${phase.id}/${version}/${id}.md`, artifactPreviewMarkdown(preview));
          } catch (error) { if (stillCurrent()) showRefusal(error, { headline: 'Artifact preview unavailable' }); }
        }, () => { if (stillCurrent()) void vscode.commands.executeCommand('singularityFlow.openPhaseArtifacts'); });
        phaseArtifactsPanel = panel;
        const selection = store.onDidChange(() => { if (!stillCurrent()) panel.dispose(); });
        panel.onDidDispose(() => { alive = false; selection.dispose(); if (phaseArtifactsPanel === panel) phaseArtifactsPanel = null; });
        context.subscriptions.push(panel);
      } catch (error) { if (stillCurrent()) showRefusal(error, { headline: 'Could not read phase artifacts' }); }
    },
    'singularityFlow.openStoryIntake': async () => {
      const snapshot = store.current.snapshot;
      const workflow = snapshot?.workflow;
      if (!repository || !workflow?.workItem.id) {
        void showCompactWarningMessage('Attach a Story to view its saved intake details.'); return;
      }
      const checkedRepository = repository;
      const scope = repositoryEpoch.capture();
      const workId = workflow.workItem.id;
      const request = ++storyIntakeRequest;
      const stillCurrent = (): boolean => request === storyIntakeRequest
        && repositoryEpoch.isCurrent(scope) && repository === checkedRepository
        && store.current.snapshot?.workflow?.workItem.id === workId;
      try {
        const preview = await client.run<import('./views/story-intake-page.ts').IntakeDocumentPreview>(
          ['documents', 'view', 'SYS-SOURCE', '--work-id', workId, '--json'], undefined, { priority: 'interactive' });
        if (!stillCurrent()) return;
        const { showStoryIntakeDetails } = await import('./views/story-intake-details.ts');
        if (!stillCurrent()) return;
        storyIntakePanel?.dispose();
        const panel = showStoryIntakeDetails(workflow, preview, snapshot?.documents ?? [], action => {
          if (!stillCurrent()) return;
          const commands = { refresh: 'singularityFlow.openStoryIntake',
            evidence: 'singularityFlow.manageEvidence', tests: 'singularityFlow.reviewStoryTestRecovery' };
          void vscode.commands.executeCommand(commands[action]);
        });
        storyIntakePanel = panel;
        const selection = store.onDidChange(() => { if (!stillCurrent()) panel.dispose(); });
        panel.onDidDispose(() => {
          selection.dispose();
          if (storyIntakePanel === panel) storyIntakePanel = null;
        });
        context.subscriptions.push(panel);
      } catch (error) {
        if (stillCurrent()) showRefusal(error, { headline: 'Could not view Story intake details' });
      }
    },
    'singularityFlow.runAction': runNode as never,
    'singularityFlow.prepareStoryPhase': ((node?: TreeNode) => runStoryPhase('prepare', node)) as never,
    'singularityFlow.publishStoryPhase': ((node?: TreeNode) => runStoryPhase('publish', node)) as never,
    'singularityFlow.submitStoryPhase': ((node?: TreeNode) => runStoryPhase('submit', node)) as never,
    'singularityFlow.resolvePhaseIssues': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!repository || !workflow?.workItem.id || !workflow.currentPhase) {
        void showCompactWarningMessage('Attach a Story before resolving phase issues.'); return;
      }
      const checkedRepository = repository;
      const scope = repositoryEpoch.capture();
      const workId = workflow.workItem.id;
      const phaseId = workflow.currentPhase;
      const stillCurrent = (): boolean => repositoryEpoch.isCurrent(scope) && repository === checkedRepository
        && store.current.snapshot?.workflow?.workItem.id === workId
        && store.current.snapshot?.workflow?.currentPhase === phaseId;
      try {
        const result = await client.run<unknown>(['appeal', 'preflight', '--work-id', workId, '--phase', phaseId, '--json']);
        if (!stillCurrent()) return;
        const { showPhaseIssues } = await import('./views/phase-issues.ts');
        showPhaseIssues(result, action => { void (async () => {
          if (!stillCurrent()) { void showCompactWarningMessage('Story context changed. Reopen phase issues in the selected Story.'); return; }
          if (action === 'refresh') return vscode.commands.executeCommand('singularityFlow.resolvePhaseIssues');
          if (action === 'continue') {
            const preview = await client.run<{ data?: { confirmation?: string; continuationAllowed?: boolean; status?: string;
              binding?: { workId?: string; phaseId?: string }; journey?: { state?: string } } }>(
              ['appeal', 'resolve', '--work-id', workId, '--phase', phaseId, '--json']);
            const plan = preview.data;
            if (!stillCurrent() || plan?.binding?.workId !== workId || plan.binding.phaseId !== phaseId) return;
            if (plan.status === 'resume-required') {
              await client.run(['appeal', 'resolve-resume', '--work-id', workId, '--phase', phaseId, '--json']);
              if (stillCurrent()) return vscode.commands.executeCommand('singularityFlow.resolvePhaseIssues');
              return;
            }
            if (!plan.continuationAllowed || !/^sha256:[a-f0-9]{64}$/u.test(plan.confirmation ?? '')) {
              void showCompactInformationMessage(`Continuation needs ${plan.journey?.state ?? 'its named owner'}. Preserve the draft and use the displayed review/repair route.`); return;
            }
            const choice = await showCompactWarningMessage('Run guarded publish/submission checks for this exact phase? Tests may run; publication may commit and push. Human reviews and approval are never automatic.', 'Run guarded checks');
            if (choice !== 'Run guarded checks' || !stillCurrent()) return;
            await client.run(['appeal', 'resolve-run', '--work-id', workId, '--phase', phaseId, '--confirm', plan.confirmation!, '--json']);
            if (stillCurrent()) return vscode.commands.executeCommand('singularityFlow.resolvePhaseIssues');
            return;
          }
          if (action === 'witness') {
            const fresh = await client.run<{ data?: { journey?: { state?: string; witnesses?: { clauseId: string; slot: string; files: string[]; status: string }[] } } }>(
              ['appeal', 'preflight', '--work-id', workId, '--phase', phaseId, '--json']);
            if (!stillCurrent()) return;
            if (fresh.data?.journey?.state !== 'witness-review') {
              void showCompactInformationMessage('Witness review follows submission, which pins fresh candidate/test evidence. Follow the displayed continuation or owning repair route first.'); return;
            }
            const witnesses = (fresh.data?.journey?.witnesses ?? []).filter(w => w.status !== 'met'
              && /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u.test(w.clauseId) && /^[A-Za-z0-9._-]+$/u.test(w.slot)
              && Array.isArray(w.files) && w.files.length === 1 && typeof w.files[0] === 'string' && w.files[0].length > 0
              && !/^[\\/]|[:\\\x00-\x1f]/u.test(w.files[0]) && !w.files[0].split('/').some(part => part === '..' || part === '.'));
            const selected = await vscode.window.showQuickPick(witnesses.map(w => ({ label: `${w.clauseId} · ${w.slot}`, description: w.files[0], witness: w })),
              { title: 'Human witness — inspect published evidence, not its classification', ignoreFocusOut: true });
            if (!selected || !stillCurrent()) return;
            const terminal = vscode.window.createTerminal({ name: 'Singularity Flow · Human Witness Review', cwd: checkedRepository });
            terminal.show(true);
            // No checklist answers are preselected. The real command enforces authority/binding.
            terminal.sendText(terminalCommand(checkedRepository, ['decision', 'witness', '--work-id', workId,
              '--criterion', selected.witness.clauseId, '--slot', selected.witness.slot, '--file', selected.witness.files[0]!,
              '--reason', '<what-you-inspected>', '--json'], process.platform, client.location), false);
            void showCompactInformationMessage('Inspect the published file, replace the reason, and answer each item with --confirm or --deny: states-the-outcome, matches-the-criterion, current-for-this-change. No witness is recorded yet.');
            return;
          }
          if (action === 'appeal') return vscode.commands.executeCommand('workbench.action.chat.open', { query: `/sf-appeal --phase ${phaseId}` });
          if (action === 'tests') return vscode.commands.executeCommand('singularityFlow.reviewStoryTestRecovery');
          if (action === 'evidence') {
            const { reviewEvidenceContract } = await import('./views/evidence-contract-review.ts');
            return reviewEvidenceContract(client, workId, phaseId, stillCurrent, result);
          }
          if (action === 'checkpoint') {
            const saved = await client.run<unknown>(['appeal', 'checkpoint', '--work-id', workId, '--phase', phaseId, '--json']);
            if (!stillCurrent()) return;
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(saved, null, 2) });
            await vscode.window.showTextDocument(document, { preview: true });
            return;
          }
          if (action === 'risk') {
            const current = await client.run<{ data?: { artifactQuality?: { eligible?: boolean; remaining?: { code: string }[] };
              quality?: { risks?: { eligible?: boolean; excepted?: boolean } } } }>(['appeal', 'preflight', '--work-id', workId, '--phase', phaseId, '--json']);
            if (!stillCurrent()) return;
            const coverage = current.data?.quality?.risks;
            const findingCodes = coverage?.eligible === true && coverage.excepted !== true ? []
              : [...new Set((current.data?.artifactQuality?.remaining ?? []).map(finding => finding.code))];
            if (!findingCodes.length && !(coverage?.eligible === true && coverage.excepted !== true)) {
              void showCompactInformationMessage('No eligible quality risk is currently open. Use the exact repair/owner route.'); return;
            }
            const reason = await vscode.window.showInputBox({ title: 'Why may this pilot proceed with the listed quality shortfall?', ignoreFocusOut: true,
              validateInput: value => value.trim().length >= 20 && value.trim().length <= 1000 && !/[\x00-\x1f\x7f]/u.test(value) ? null : 'Give a reason of 20–1000 ordinary characters.' });
            if (reason === undefined || !stillCurrent()) return;
            const expires = await vscode.window.showInputBox({ title: 'Risk expiry (YYYY-MM-DD, within 90 days)', ignoreFocusOut: true,
              value: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
              validateInput: value => /^\d{4}-\d{2}-\d{2}$/u.test(value) ? null : 'Use YYYY-MM-DD.' });
            if (!expires || !stillCurrent()) return;
            const selectors = ['--work-id', workId, '--phase', phaseId, '--gate-mode', 'soft', '--expires', expires, '--reason', reason,
              ...findingCodes.flatMap(code => ['--finding', code])];
            const preview = await client.run<{ data?: { packet?: { packetSha256?: string; binding?: { workId?: string; phaseId?: string } } } }>(
              ['appeal', 'risk-prepare', ...selectors, '--json']);
            const packet = preview.data?.packet;
            if (!stillCurrent() || packet?.binding?.workId !== workId || packet.binding.phaseId !== phaseId
                || !/^sha256:[a-f0-9]{64}$/u.test(packet.packetSha256 ?? '')) return;
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(preview, null, 2) });
            await vscode.window.showTextDocument(document, { preview: true });
            if (!stillCurrent()) return;
            const terminal = vscode.window.createTerminal({ name: 'Singularity Flow · Human Pilot Risk Review', cwd: checkedRepository });
            terminal.show(true);
            terminal.sendText(terminalCommand(checkedRepository, ['appeal', 'risk-accept', ...selectors, '--confirm', packet.packetSha256!],
              process.platform, client.location), false);
            return;
          }
          if (action === 'repair' || action === 'resume') {
            const planned = await client.run<{ data?: { status?: string; confirmation?: string;
              binding?: { workId?: string; phaseId?: string }; admission?: { allowed?: boolean } } }>(
              ['appeal', 'repair-plan', '--work-id', workId, '--phase', phaseId, '--json']);
            if (!stillCurrent() || planned.data?.binding?.workId !== workId || planned.data?.binding?.phaseId !== phaseId) return;
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(planned, null, 2) });
            await vscode.window.showTextDocument(document, { preview: true });
            if (!stillCurrent()) return;
            const resume = planned.data.status === 'resume-required';
            if (action === 'resume' && !resume) { void showCompactInformationMessage('No active attempt needs resumption. The recorded budget remains unchanged.'); return; }
            if (!resume && (planned.data.admission?.allowed !== true || !/^sha256:[a-f0-9]{64}$/u.test(planned.data.confirmation ?? ''))) {
              void showCompactWarningMessage('This repair needs its named human/owner route. No new attempt was started.'); return;
            }
            const terminal = vscode.window.createTerminal({ name: 'Singularity Flow · Recorded Phase Repair', cwd: checkedRepository });
            terminal.show(true);
            terminal.sendText(terminalCommand(checkedRepository, ['appeal', resume ? 'repair-resume' : 'repair-run',
              '--work-id', workId, '--phase', phaseId, ...(!resume ? ['--confirm', planned.data.confirmation!] : []), '--json'],
              process.platform, client.location), false);
            return;
          }
          const listed = await client.run<{ data?: { items?: { id: string; packetSha256: string; decisionSha256?: string; status: string }[] } }>(['appeal', 'list', '--work-id', workId, '--phase', phaseId, '--json']);
          if (!stillCurrent()) return;
          const items = (listed.data?.items ?? []).filter(item => /^APL-[a-f0-9]{24}$/u.test(item.id) && /^sha256:[a-f0-9]{64}$/u.test(item.packetSha256));
          const selected = await vscode.window.showQuickPick(items.map(item => ({ label: item.id, description: item.status, item })), { title: 'Review the exact retained appeal', ignoreFocusOut: true });
          if (!selected || !stillCurrent()) return;
          const packet = await client.run<unknown>(['appeal', 'show', selected.item.id, '--work-id', workId, '--json']);
          if (!stillCurrent()) return;
          const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(packet, null, 2) });
          await vscode.window.showTextDocument(document, { preview: true });
          if (stillCurrent() && selected.item.status === 'needs-reattestation' && /^sha256:[a-f0-9]{64}$/u.test(selected.item.decisionSha256 ?? '')) {
            const terminal = vscode.window.createTerminal({ name: 'Singularity Flow · Appeal Re-review', cwd: checkedRepository });
            terminal.show(true);
            terminal.sendText(terminalCommand(checkedRepository, ['appeal', 'attest', selected.item.id, '--work-id', workId,
              '--confirm', selected.item.decisionSha256!], process.platform, client.location), false);
            return;
          }
          if (!stillCurrent() || selected.item.status !== 'needs-human') return;
          const choice = await vscode.window.showQuickPick([
            { label: 'Account for these extra paths', decision: 'account-scope' },
            { label: 'Request changes; preserve the diff', decision: 'request-changes' }
          ], { title: 'Prepare human terminal review — does not approve the phase or waive tests', ignoreFocusOut: true });
          if (!choice || !stillCurrent()) return;
          const reason = await vscode.window.showInputBox({ title: 'Reason for this exact appeal decision', ignoreFocusOut: true,
            validateInput: value => value.trim().length >= 20 && value.trim().length <= 2000 && !/[\x00-\x1f\x7f]/u.test(value) ? null : 'Give a reason of 20–2000 ordinary characters.' });
          if (reason === undefined || !stillCurrent()) return;
          const terminal = vscode.window.createTerminal({ name: 'Singularity Flow · Appeal Review', cwd: checkedRepository });
          terminal.show(true);
          terminal.sendText(terminalCommand(checkedRepository, ['appeal', 'decide', selected.item.id, '--work-id', workId,
            '--decision', choice.decision, '--reason', reason, '--confirm', selected.item.packetSha256], process.platform, client.location), false);
        })().catch(error => showRefusal(error, { headline: 'Phase issue review could not continue' })); });
      } catch (error) { showRefusal(error, { headline: 'Phase issues could not be inspected' }); }
    },
    'singularityFlow.reviewStoryTestRecovery': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!repository || !workflow?.workItem?.id || !workflow.currentPhase) {
        void showCompactWarningMessage('Attach a Story before reviewing its test policy.');
        return;
      }
      const checkedRepository = repository;
      const scope = repositoryEpoch.capture();
      const attachedPhaseId = workflow.currentPhase;
      let subject = { workId: workflow.workItem.id, phaseId: attachedPhaseId };
      const stillCurrent = (): boolean => repositoryEpoch.isCurrent(scope) && repository === checkedRepository
        && store.current.snapshot?.workflow?.workItem?.id === subject.workId
        && store.current.snapshot?.workflow?.currentPhase === attachedPhaseId;
      const choice = await vscode.window.showQuickPick([
        { label: 'Review and commit current code-phase edits', action: 'worktree' as TestRecoveryAction,
          description: 'Exact file list and confirmation; preserve reports, revalidate changed code, never auto-approve' },
        { label: 'Inspect test policy and readiness', action: 'show' as TestRecoveryAction,
          description: 'Read only; no tests, changes or risk acceptance' },
        { label: 'Preview approved test-runner repair', action: 'amend' as TestRecoveryAction,
          description: 'Preserve code; review a newer command from the original configuration authority' },
        { label: 'Restore review after clone or host change', action: 'attest' as TestRecoveryAction,
          description: 'Inspect missing local review evidence; original reviewer required' },
        { label: 'Inspect phase risks and reviewed exceptions', action: 'risks' as TestRecoveryAction,
          description: 'Inspect blockers, authorize eligible risk, or revoke a decision; no automatic bypass' }
      ], { title: `${subject.workId} — Test and recovery`, ignoreFocusOut: true });
      if (!choice || !stillCurrent()) return;
      const reason = choice.action === 'amend' ? await vscode.window.showInputBox({
        title: 'Why is the approved runner being repaired?', ignoreFocusOut: true,
        prompt: 'The preview adopts only the newer approved test command, not unrelated configuration changes.',
        validateInput: value => {
          try { testRecoveryPreviewArgs('amend', subject, value); return null; }
          catch (error) { return (error as Error).message; }
        }
      }) : undefined;
      if (!stillCurrent() || choice.action === 'amend' && reason === undefined) return;
      try {
        const riskTransition = choice.action === 'risks' ? await vscode.window.showQuickPick([
          { label: 'Publication', operation: 'publish' as const }, { label: 'Submission', operation: 'submit' as const },
          { label: 'Approval', operation: 'approve' as const }, { label: 'Downstream evidence use', operation: 'downstream' as const },
          { label: 'Replay', operation: 'replay' as const }
        ], { title: 'Inspect the exact transition; a decision for one does not authorize another', ignoreFocusOut: true }) : null;
        if (!stillCurrent() || choice.action === 'risks' && !riskTransition) return;
        if (riskTransition && ['downstream', 'replay'].includes(riskTransition.operation)) {
          const sourcePhases = Object.entries(workflow.phases ?? {}).filter(([, phase]) => Number(phase.generation) > 0)
            .map(([phaseId]) => ({ label: phaseId, description: 'Published source phase; active phase will not change', phaseId }));
          if (!sourcePhases.length) {
            void showCompactInformationMessage('This Story has no published phase to review for downstream evidence use.');
            return;
          }
          const sourcePhase = await vscode.window.showQuickPick(sourcePhases, {
            title: 'Which published source phase needs the exception?', ignoreFocusOut: true
          });
          if (!sourcePhase || !stillCurrent()) return;
          subject = { ...subject, phaseId: sourcePhase.phaseId };
        }
        const args = riskTransition ? storyRiskPreviewArgs('risks', subject, riskTransition)
          : testRecoveryPreviewArgs(choice.action, subject, reason);
        let result = await client.run<unknown>(args);
        if (!stillCurrent()) return;
        if (choice.action === 'risks' && riskTransition) {
          const obligations = storyRiskObligationChoices(result, subject);
          if (obligations.length) {
            const selected = await vscode.window.showQuickPick(obligations, {
              title: 'Inspect test validation or an exact document obligation', ignoreFocusOut: true
            });
            if (!selected || !stillCurrent()) return;
            if (selected.obligationId) result = await client.run<unknown>(storyRiskPreviewArgs('risks', subject,
              { ...riskTransition, obligationId: selected.obligationId }));
            if (!stillCurrent()) return;
          }
        }
        // JSON language mode prevents repository-derived strings from becoming links or commands.
        const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(result, null, 2) });
        await vscode.window.showTextDocument(document, { preview: true });
        if (!stillCurrent()) return;
        let actions = testRecoveryReviewActions(result, choice.action, subject, reason);
        if (choice.action === 'risks') {
          const riskChoices = storyRiskChoices(result, subject);
          if (!riskChoices.length) return;
          const selectedRisk = await vscode.window.showQuickPick(riskChoices, {
            title: 'Choose an exact risk review; integrity failures cannot be waived', ignoreFocusOut: true
          });
          if (!selectedRisk || !stillCurrent()) return;
          const terms: StoryRiskTerms = { ...selectedRisk.terms };
          if (selectedRisk.action === 'accept-risk' || selectedRisk.action === 'revoke-risk') {
            terms.reason = await vscode.window.showInputBox({ title: 'Reason for this exact risk decision', ignoreFocusOut: true,
              validateInput: value => value.trim().length >= 15 && value.trim().length <= 2000 && !/[\x00-\x1f\x7f]/u.test(value)
                ? null : 'Give a reason of 15–2000 ordinary characters.' });
            if (terms.reason === undefined || !stillCurrent()) return;
          }
          if (selectedRisk.action === 'accept-risk') {
            terms.followUpOwner = await vscode.window.showInputBox({ title: 'Who owns the follow-up?', ignoreFocusOut: true,
              validateInput: value => value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value)
                ? null : 'Name a follow-up owner (1–256 ordinary characters).' });
            if (terms.followUpOwner === undefined || !stillCurrent()) return;
            terms.remediationRef = await vscode.window.showInputBox({ title: 'Remediation reference or action', ignoreFocusOut: true,
              prompt: 'The observed failure, gap or unavailable result stays unchanged. Record its remediation.',
              validateInput: value => value.trim().length > 0 && value.length <= 1000 && !/[\x00-\x1f\x7f]/u.test(value)
                ? null : 'Give a remediation reference or action (1–1000 ordinary characters).' });
            if (terms.remediationRef === undefined || !stillCurrent()) return;
          }
          const riskPreview = await client.run<unknown>(storyRiskPreviewArgs(selectedRisk.action, subject, terms));
          if (!stillCurrent()) return;
          const riskDocument = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(riskPreview, null, 2) });
          await vscode.window.showTextDocument(riskDocument, { preview: true });
          if (!stillCurrent()) return;
          const applyArgs = storyRiskApplyArgs(riskPreview, selectedRisk.action, subject, terms);
          actions = applyArgs ? [{ label: 'Prepare exact risk review in terminal — live authorization still required', args: applyArgs }] : [];
        }
        if (!actions.length) return;
        const selected = await vscode.window.showQuickPick(actions, {
          title: 'Review the preview; prepare a terminal command only', ignoreFocusOut: true,
          placeHolder: 'No risk is accepted and no Story is changed by opening this terminal.'
        });
        if (!selected || !stillCurrent()) return;
        const terminal = vscode.window.createTerminal({
          name: `Singularity Flow · Test recovery · ${subject.workId}`, cwd: checkedRepository,
          // Quote for a known shell, not a user-selected Git Bash/cmd profile on Windows.
          shellPath: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
          env: { ELECTRON_RUN_AS_NODE: '1' }
        });
        terminal.show(true);
        terminal.sendText(terminalCommand(checkedRepository, selected.args, process.platform, client.location), false);
      } catch (error) {
        if (stillCurrent()) showRefusal(error, { headline: 'Could not review Story test recovery' });
      }
    },
    'singularityFlow.prefillStoryPhaseGeneration': async (node?: TreeNode) => {
      const phaseId = store.current.snapshot?.workflow?.currentPhase;
      if (!phaseId) {
        void showCompactWarningMessage('No governed Story phase is active in this workspace.');
        return;
      }
      const prefill = phaseGenerationChatPrefill(node?.prefill);
      if (!prefill) {
        void showCompactWarningMessage(
          'The lifecycle snapshot did not provide a supported phase action skill. Refresh and try again.'
        );
        return;
      }
      // This is deliberately a partial query. Clicking the lifecycle action cannot prepare,
      // review, author, publish, or submit anything; the contributor reviews the engine-selected skill.
      await vscode.commands.executeCommand('workbench.action.chat.open', prefill);
    },
    'singularityFlow.approve': runNode as never,
    'singularityFlow.openJourney': async () => {
      await reconcileActiveWorkspaceSelection();
      const { JourneyPanel } = lazyPanels();
      return JourneyPanel.show(context, store, onJourneyMessage, stepActionDeliveries);
    },
    'singularityFlow.openCommandCenter': async () => {
      await reconcileActiveWorkspaceSelection();
      const { SgosCommandCenterPanel } = lazyPanels();
      return SgosCommandCenterPanel.show(context, store, client);
    },
    'singularityFlow.openComprehensionCenter': async () => {
      await reconcileActiveWorkspaceSelection();
      const { ComprehensionCenterPanel } = lazyPanels();
      return ComprehensionCenterPanel.show(context, store, client);
    },
    // The Change Explorer is a mode of the Comprehension Center: same lease, same snapshot.
    'singularityFlow.openChangeExplorer': async () => {
      await reconcileActiveWorkspaceSelection();
      const { ComprehensionCenterPanel } = lazyPanels();
      return ComprehensionCenterPanel.show(context, store, client, { tab: 'explorer' });
    },
    'singularityFlow.openCodeExplanation': async () => {
      await reconcileActiveWorkspaceSelection();
      const { ComprehensionCenterPanel } = lazyPanels();
      return ComprehensionCenterPanel.show(context, store, client, { tab: 'explanation' });
    },
    // The explain menus: the editor, Explorer and Source Control pass the file; the editor's
    // "Explain This Change" also passes the cursor line.
    'singularityFlow.explainFileChanges': ((argument?: unknown) => showChangeExplorerFocused(argument, false)) as never,
    'singularityFlow.explainChangeAtCursor': () => showChangeExplorerFocused(undefined, true),
    'singularityFlow.openCodeExplainer': () => showCodeExplainer(false),
    // A person's review of what was read: confirm it, correct it with a note, or reject it.
    'singularityFlow.reviewRepositoryKnowledge': async () => {
      type Item = { id: string; kind: string; subject?: { symbol?: string; path?: string }; statement?: Record<string, unknown>;
        citations: Array<{ path: string; lines: number[] }>; review?: { status: string; current: boolean } };
      try {
        const listed = await client.run<{ items: Item[] }>(['wm', 'knowledge', 'items', '--json']);
        const reviewable = listed.items.filter((item) => ['rule', 'drift', 'untested-rule', 'limit', 'journey', 'error-path'].includes(item.kind));
        const describe = (item: Item): string => {
          const statement = item.statement ?? {};
          if (item.kind === 'rule') return `when ${(statement.when as string[] | undefined)?.join(' and ') ?? ''} → ${(statement.then as { text?: string } | null)?.text ?? ''}`;
          if (item.kind === 'drift') return String(statement.detail ?? 'test and code disagree');
          if (item.kind === 'limit') return `${String(statement.name)} = ${String(statement.value)}`;
          if (item.kind === 'journey') return String(statement.trigger ?? 'journey');
          if (item.kind === 'error-path') return `${String(statement.exception ?? 'error')} ${statement.message ? `"${String(statement.message)}"` : ''}`;
          return 'no test exercises it';
        };
        const picked = await vscode.window.showQuickPick(reviewable.map((item) => ({
          label: `${item.subject?.symbol ?? item.subject?.path ?? item.kind}: ${describe(item)}`.slice(0, 160),
          description: `${item.kind}${item.review?.current ? ` · ${item.review.status}` : ''}`,
          detail: item.citations[0] ? `${item.citations[0].path}:${item.citations[0].lines[0]}` : undefined,
          item
        })), { title: 'Review repository knowledge', placeHolder: 'Choose what to confirm, correct or reject', matchOnDescription: true, matchOnDetail: true });
        if (!picked) return;
        const action = await vscode.window.showQuickPick([
          { label: 'Confirm', description: 'it is right', value: 'confirm' },
          { label: 'Correct', description: 'it is wrong in a way you will describe', value: 'correct' },
          { label: 'Reject', description: 'it is wrong; leave it out of prompts', value: 'reject' }
        ], { title: picked.label });
        if (!action) return;
        const note = await vscode.window.showInputBox({
          title: `${action.label}: ${picked.label}`,
          prompt: action.value === 'confirm' ? 'Optional note' : 'What is wrong?',
          validateInput: (value) => (action.value !== 'confirm' && !value.trim() ? 'Say what is wrong.' : undefined)
        });
        if (note === undefined) return;
        await client.run(['wm', 'knowledge', action.value, picked.item.id, ...(note.trim() ? ['--note', note.trim()] : []), '--json']);
        void vscode.window.showInformationMessage(`Recorded in docs/knowledge/confirmations.yml. Commit it with your change.`);
      } catch (error) {
        showRefusal(error, { headline: 'Could not record the review' });
      }
    },
    // What the code does (rules, journeys, tests and their gaps), read from the committed source by the CLI.
    'singularityFlow.openRepositoryKnowledge': async () => {
      try {
        const view = await vscode.window.showQuickPick([
          { label: 'How the code works', description: 'rules, journeys, tests and their gaps', value: 'overview' },
          { label: 'For product owners', description: 'approved requirements, journeys, rules, messages and vocabulary', value: 'business' },
          { label: 'What a change touches', description: 'hotspots, impact and pitfalls', value: 'change' }
        ], { title: 'Repository Knowledge' });
        if (!view) return;
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Reading repository knowledge', cancellable: false },
          () => client.run<{ markdown: string }>(['wm', 'knowledge', 'show', view.value, '--json'])
        );
        // A file in the extension's own storage, rewritten each time: the preview opens without leaving an unsaved document behind.
        const file = vscode.Uri.joinPath(context.globalStorageUri, 'repository-knowledge.md');
        await vscode.workspace.fs.createDirectory(context.globalStorageUri);
        await vscode.workspace.fs.writeFile(file, Buffer.from(result.markdown, 'utf8'));
        await vscode.commands.executeCommand('markdown.showPreview', file);
      } catch (error) {
        showRefusal(error, { headline: 'Could not read repository knowledge' });
      }
    },
    'singularityFlow.explainCodeAtCursor': () => showCodeExplainer(true),
    'singularityFlow.createSgosWorkflow': async () => {
      await reconcileActiveWorkspaceSelection();
      const { showSgosWorkflowCreator } = lazyPanels();
      return showSgosWorkflowCreator(client);
    },
    'singularityFlow.reviewSgosMetaTool': async () => {
      await reconcileActiveWorkspaceSelection();
      const { showSgosMetaToolReview } = lazyPanels();
      return showSgosMetaToolReview(client);
    },
    'singularityFlow.reviewLocalRunner': async () => {
      await reconcileActiveWorkspaceSelection();
      const { showGdpLocalRunnerReview } = lazyPanels();
      return showGdpLocalRunnerReview(client);
    },
    'singularityFlow.openEvidenceMatrix': async () => {
      const { EvidenceMatrixPanel } = lazyPanels();
      return EvidenceMatrixPanel.show(context, store, client);
    },
    'singularityFlow.openReconciliation': async () => {
      const { ReconciliationPanel } = lazyPanels();
      return ReconciliationPanel.show(context, store, client);
    },
    'singularityFlow.showImpact': () => showImpact(client, output),
    'singularityFlow.openDashboard': async () => {
      const { DashboardPanel } = lazyPanels();
      return DashboardPanel.show(context, store);
    },
    'singularityFlow.cancelWork': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow || workflow.status !== 'in_progress') {
        void showCompactWarningMessage('Only active Story work can be cancelled.');
        return;
      }
      const reason = await vscode.window.showInputBox({
        title: `Cancel and archive ${workflow.workItem.id}`,
        prompt: 'Explain why this work is being stopped. The reason, actor, artifacts, and approvals remain in Git.',
        placeHolder: 'Reason for cancellation',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'A cancellation reason is required.'
      });
      if (!reason?.trim()) return;
      const decision = await showCompactWarningMessage(
        `Cancel ${workflow.workItem.id}? Its lifecycle will stop and it will move to Archived. Generated artifacts are preserved.`,
        { modal: true, detail: `Current phase: ${workflow.currentPhase ?? 'unknown'}\nReason: ${reason.trim()}` },
        'Cancel and archive'
      );
      if (decision !== 'Cancel and archive') return;
      try {
        await client.runText(['cancel', workflow.workItem.id, '--reason', reason.trim(), '--confirm', workflow.workItem.id]);
        await refreshAfterKnownMutation();
        void showCompactInformationMessage(`${workflow.workItem.id} was cancelled and moved to Archived.`);
      } catch (error) {
        showRefusal(error, { headline: 'Could not cancel ${workflow.workItem.id}' });
      }
    },
    'singularityFlow.reopenCompleted': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow || workflow.status !== 'closed') {
        void showCompactWarningMessage('Only a closed Story can be reopened.');
        return;
      }
      const completion = workflow.phases[workflow.phaseOrder.at(-1) ?? ''];
      if (!completion) {
        showRefusal('The closed Story has no final phase policy, so there is nothing to reopen against.',
          { headline: 'No final phase policy' });
        return;
      }
      const choices = (completion.approvalPolicy?.rejectTo ?? [completion.id]).map((phaseId) => ({
        label: workflow.phases[phaseId]?.label ?? phaseId,
        description: phaseId,
        phaseId
      }));
      const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, {
        title: `Reopen ${workflow.workItem.id}`,
        placeHolder: 'Choose the phase that must be revised',
        ignoreFocusOut: true
      });
      if (!selected) return;
      const reason = await vscode.window.showInputBox({
        title: `Why is ${workflow.workItem.id} being reopened?`,
        prompt: 'The comment is recorded as a governed change request and injected into the target phase.',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'A comment is required.'
      });
      if (!reason?.trim()) return;
      try {
        await client.runText(['reopen', workflow.workItem.id, '--fetch', '--to', selected.phaseId, '--reason', reason.trim()]);
        await refreshAfterKnownMutation();
        void showCompactInformationMessage(`${workflow.workItem.id} reopened at ${selected.phaseId}.`);
      } catch (error) {
        showRefusal(error, { headline: 'Could not reopen ${workflow.workItem.id}' });
      }
    },
    'singularityFlow.rollForwardRework': async (node?: TreeNode) => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow) {
        void showCompactWarningMessage('No active Story has a rework checkpoint to restore.');
        return;
      }
      const requestId = node?.id.match(/^story:change-request:([^:]+):roll-forward$/)?.[1]
        ?? workflow.changeRequests?.filter((request) => request.status === 'open' && request.forwardCheckpoint).at(-1)?.id;
      if (!requestId) {
        void showCompactWarningMessage('No open change request has a safe forward checkpoint.');
        return;
      }
      type ReworkPlan = {
        status: 'preview'; workId: string; changeRequestId: string; sourcePhase: string; targetPhase: string;
        checkpointId: string; sourceCommit: string; confirmation: string; paths: string[]; stagedPaths: string[];
      };
      try {
        const plan = await client.run<ReworkPlan>([
          'story', 'rework', 'roll-forward', '--work-id', workflow.workItem.id,
          '--change-request', requestId, '--json'
        ]);
        if (plan.stagedPaths.length) {
          showRefusal(
            `Unstage these rework paths first; Singularity Flow will not alter your Git index:\n- ${plan.stagedPaths.join('\n- ')}`,
            { headline: 'Staged rework is preserved' }
          );
          return;
        }
        const previewContent = renderReworkRollForwardPreview(plan);
        const previewDocument = await vscode.workspace.openTextDocument({ language: 'markdown', content: previewContent });
        await vscode.window.showTextDocument(previewDocument, { preview: true });
        const reviewed = await showCompactInformationMessage(
          `Review the complete ${plan.paths.length}-path roll-forward preview before continuing.`,
          'Continue to confirmation'
        );
        if (reviewed !== 'Continue to confirmation') return;
        const choice = await showCompactWarningMessage(
          `Discard ${requestId} rework and safely return ${workflow.workItem.id} to ${plan.sourcePhase}?`,
          {
            modal: true,
            detail: [
              `Checkpoint: ${plan.checkpointId} at ${plan.sourceCommit}`,
              `The current Git history is preserved. A local backup is created before ${plan.paths.length} path(s) are restored.`,
              'You confirmed that you reviewed the complete preview document.'
            ].join('\n')
          },
          'Back up, discard, and return forward'
        );
        if (choice !== 'Back up, discard, and return forward') return;
        const result = await client.run<{
          status: 'rolled-forward'; phase: string | null; restoredPaths: string[]; backupPath: string;
          commit: string; pushed: boolean;
        }>([
          'story', 'rework', 'roll-forward', '--work-id', plan.workId,
          '--change-request', plan.changeRequestId, '--confirm', plan.confirmation, '--json'
        ]);
        await refreshAfterKnownMutation();
        void showCompactInformationMessage(
          `${plan.workId} returned to ${result.phase ?? 'its closed state'} in ${result.commit.slice(0, 8)}. `
          + `${result.restoredPaths.length} path(s) were backed up locally and restored.`
        );
      } catch (error) {
        showRefusal(error, { headline: `Could not return ${workflow.workItem.id} forward` });
      }
    },
    // Workflow Studio is the visual way in: Story and Epic workflows, steps, agents, approvals and
    // artifacts edited together and published as one change, with its proposals reviewed there.
    'singularityFlow.decideStory': async (target?: unknown) => {
      const workId = typeof target === 'string' ? target
        : (target as { workId?: unknown } | undefined)?.workId;
      return chooseStoryDecision(typeof workId === 'string' ? workId : null, null);
    },
    // Workflow Studio, optionally at one section: `{ view: 'changes' }` opens the proposals waiting
    // for review, `{ view: 'artifacts' }` the templates.
    'singularityFlow.openWorkflowStudio': async (target?: unknown) => {
      const { WorkflowStudioPanel, STUDIO_FOCUS_VIEWS } = lazyPanels();
      const requested = typeof target === 'string' ? target : (target as { view?: unknown } | undefined)?.view;
      const workflowId = (target as { workflowId?: unknown } | undefined)?.workflowId;
      const focus = (STUDIO_FOCUS_VIEWS as readonly unknown[]).includes(requested) ? requested as typeof STUDIO_FOCUS_VIEWS[number] : null;
      WorkflowStudioPanel.show(client, output, {
        refresh: refreshAfterKnownMutation,
        reviewProposal: (branch) => reviewAndActivateWorkflowProposal(branch),
        exportWorkflows: (selectors) => exportWorkflowBundle(selectors),
        importWorkflows: () => importWorkflowBundle(),
        duplicateWorkflow: (selector) => duplicateWorkflow(selector),
        openFile: async (relative) => {
          await openArtifact(repository, { kind: 'artifact', id: relative, label: relative, path: relative });
        },
        // Unpublished changes survive closing the panel, in this workspace's storage.
        draftStore: {
          get: () => context.workspaceState.get('singularityFlow.workflowStudioDraft'),
          set: (value) => context.workspaceState.update('singularityFlow.workflowStudioDraft', value)
        },
        // Integration secrets go to the keychain; the next command (a delivery, a test) reads them.
        integrationSecrets: {
          status: (names) => secureCredentials.integrationSecretStatus(names),
          store: async (name, value) => { await secureCredentials.saveIntegrationSecret(name, value); cliEnvironment = await resolvedCliEnvironment(); },
          clear: async (name) => { await secureCredentials.resetIntegrationSecret(name); cliEnvironment = await resolvedCliEnvironment(); },
          jiraStatus: async () => ((await secureCredentials.jiraStatus()).connected ? 'stored'
            : String(process.env.JIRA_BASE_URL ?? '').trim() && String(process.env.JIRA_PAT ?? process.env.JIRA_API_TOKEN ?? '').trim() ? 'environment' : 'missing')
        }
      }, focus, typeof workflowId === 'string' ? workflowId : null);
    },
    // The Workflow Designer is gone: Workflow Studio does what it did. The command stays for one
    // release, so links and habits land in Studio.
    'singularityFlow.openDesigner': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio'),
    'singularityFlow.openInstructionDesigner': async () => {
      const { InstructionDesignerPanel } = lazyPanels();
      return InstructionDesignerPanel.show(context, store, async (message) => {
      if (message.type === 'agent-action') {
        if (message.action === 'refresh') {
          await store.refresh();
          return store.current.error
            ? `Approved instruction reload failed: ${store.current.error.message}`
            : null;
        }
        if (message.action === 'sync') {
          output.appendLine(`\n$ singularity-flow agents sync ${message.agentId}`);
          try {
            await client.runText(['agents', 'sync', message.agentId]);
            await refreshAfterKnownMutation();
            return null;
          } catch (error) {
            output.appendLine(`  refused: ${(error as Error).message}`);
            return (error as Error).message;
          }
        }

        // First trust and lock updates deliberately require exact interactive confirmation. Open
        // the bundled engine in an integrated terminal instead of weakening that TOFU boundary in
        // the webview. The terminal uses the active repository and therefore records the same agent
        // and lock hashes that a direct CLI user would review.
        const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
        const args = [quote(client.location.executable), quote(client.location.cli), 'agents', 'lock', quote(message.agentId)];
        if (message.action === 'update') args.push('--update');
        const terminal = vscode.window.createTerminal({
          name: `Singularity Flow · ${message.action === 'update' ? 'Update' : 'Trust'} ${message.agentId}`,
          cwd: client.repository,
          // VS Code's extension host is Electron. The normal CLI runner sets this flag when it
          // invokes the bundled entrypoint; the interactive terminal must do the same or macOS
          // launches another Code process instead of Node executing the CLI.
          env: { ELECTRON_RUN_AS_NODE: '1' }
        });
        terminal.show(true);
        terminal.sendText(args.join(' '), true);
        return null;
      }
      if (!message.writable) return message.blockedReason ?? 'The approved configuration authority is read-only.';
      const command = [
        'configuration', 'save', message.path, ...configurationSavePlanCliArgs(message)
      ];
      output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
      try {
        const text = await client.runText(command, { input: message.content });
        await refreshAfterKnownMutation();
        const disposition = configurationSaveDisposition(text, message.proposal);
        if (disposition.kind === 'proposal') {
          void showCompactInformationMessage(
            `Instruction proposal ${disposition.branch} is ready for review. Merge it into `
            + `${disposition.baseBranch}, then refresh workspace configuration. `
            + 'The application checkout was not changed.'
          );
        } else if (disposition.kind === 'local') {
          void showCompactInformationMessage(
            'Instruction changes were saved as a local configuration draft. Review and commit them through the local authority.'
          );
        } else {
          void showCompactInformationMessage(
            'The approved instructions already contain this change; no proposal was required.'
          );
        }
        return { error: null, disposition };
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
      });
    },
    'singularityFlow.openConfigurationCenter': () => openConfigurationCenter('overview'),
    'singularityFlow.configureTests': () => openConfigurationCenter('tests'),
    'singularityFlow.configureAuto': () => openConfigurationCenter('auto'),
    'singularityFlow.configureWorldModel': () => openConfigurationCenter('world-model'),
    'singularityFlow.rebuildWorldModel': (request?: { capabilityId?: string }) => vscode.commands.executeCommand(
      'singularityFlow.buildWorldModel', { ...request, rebuild: true }
    ),
    'singularityFlow.buildWorldModel': async (request?: { capabilityId?: string; rebuild?: boolean }) => {
      const active = activeRepositoryContext();
      if (!active) {
        void showCompactWarningMessage(
          'Choose a governed workspace repository before building its World Model.'
        );
        return;
      }
      try {
        // The model builder brings the full writable gateway and World Model graph. Keep that
        // separate from activation and load it only after the person selects this command.
        const {
          showGovernedWorldModelBuild, worldModelAuthorityRefreshArguments,
          worldModelBuildCompletionMessage
        } = require(path.join(__dirname, 'world-model-build.cjs')) as typeof import('./world-model-build.ts');
        const modelMode = vscode.workspace.getConfiguration('singularityFlow')
          .get<string>('modelMode', 'auto');
        const outcome = await showGovernedWorldModelBuild(active, {
          modelRouting: modelMode === 'disabled' ? 'disabled' : 'enabled',
          capabilityId: request?.capabilityId ?? null,
          rebuild: request?.rebuild === true
        });
        if (outcome.status === 'cancelled') return;
        if (outcome.status === 'refused') {
          const reason = outcome.result?.why?.[0];
          const code = reason?.code ?? 'world-model build refused';
          const engineCode = reason?.slots?.code;
          const refreshRequired = engineCode === 'WMB_GATEWAY_STATE_AUTHORITY_REFRESH_REQUIRED';
          const refreshAction = 'Refresh state & retry';
          const choice = await showCompactWarningMessage(
            `World Model build was not run: ${code}${engineCode ? ` (${String(engineCode)})` : ''}. ${refreshRequired
              ? 'The remote state authority must be materialized before an exact preserving Plan can be reviewed.'
              : 'Review the current repository state and try again.'}`,
            ...(refreshRequired ? [refreshAction] : [])
          );
          if (refreshRequired && choice === refreshAction) {
            const refreshArgs = worldModelAuthorityRefreshArguments(outcome.capabilityId ?? null);
            output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(refreshArgs)}`);
            await client.runText([...refreshArgs]);
            await refreshAfterSurfaceMutation();
            await vscode.commands.executeCommand(
              'singularityFlow.buildWorldModel',
              { ...(outcome.capabilityId ? { capabilityId: outcome.capabilityId } : {}),
                ...(request?.rebuild === true ? { rebuild: true } : {}) }
            );
          }
          return;
        }
        await refreshAfterSurfaceMutation();
        void showCompactInformationMessage(worldModelBuildCompletionMessage(outcome));
      } catch (error) {
        output.appendLine(`  exact world-model build refused: ${(error as Error).message}`);
        // Keep recovery bound to the repository that produced the failure even if the user changes
        // the active workspace while an authority probe or reviewed build is still in flight.
        showRefusal(error, {
          headline: 'Could not build the World Model', repositoryRoot: active.root
        });
      }
    },
    'singularityFlow.configureAstIntelligence': async () => {
      const { AstIntelligencePanel } = lazyPanels();
      return AstIntelligencePanel.show(context, client, store);
    },
    'singularityFlow.publishConfiguration': async () => {
      const repository = store.current.snapshot?.repository;
      const files = repository?.configurationChanges ?? [];
      if (!files.length) {
        void showCompactInformationMessage('No validated configuration changes are ready to publish.');
        return;
      }
      const unrelated = repository?.unrelatedChanges ?? [];
      if (unrelated.length) {
        void showCompactWarningMessage(
          `Configuration publication is blocked by unrelated changes: ${unrelated.join(', ')}. Commit or set them aside, then refresh.`
        );
        return;
      }
      const branchName = repository?.branch ?? 'current branch';
      const choice = await showCompactWarningMessage(
        `Publish ${files.length} configuration file${files.length === 1 ? '' : 's'} from ${branchName}?`,
        {
          modal: true,
          detail: `${files.join('\n')}\n\nFlow will validate the complete configuration, create one scoped commit, and push only this branch. The engine refuses publication from the protected application branch.`
        },
        'Commit & push configuration'
      );
      if (choice !== 'Commit & push configuration') return;
      output.appendLine('\n$ singularity-flow configuration publish --json');
      try {
        const published = await client.run<{ sha?: string; pushed?: boolean; remote?: string; files?: string[] }>([
          'configuration', 'publish', '--message', 'Configure Singularity Flow', '--json'
        ]);
        await refreshAfterKnownMutation();
        const destination = published.pushed ? `${published.remote ?? 'remote'}/${branchName}` : 'the local repository';
        void showCompactInformationMessage(
          `Configuration published to ${destination}${published.sha ? ` at ${published.sha.slice(0, 8)}` : ''}.`
        );
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        showRefusal(error, { headline: 'Could not publish configuration' });
      }
    },
    'singularityFlow.configurePeople': () => openConfigurationCenter('people'),
    'singularityFlow.configureMcp': () => openConfigurationCenter('mcp'),
    // Every tab has a palette command: with the Configuration section collapsed to one entry, the
    // palette is the only route into a tab that does not start at the Center's overview.
    // Templates are designed in Workflow Studio's Artifacts; instructions in the Agent Designer.
    'singularityFlow.configureTemplates': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'artifacts' }),
    // The skill master: write skills and attach them to any agent, for the steps they are for.
    'singularityFlow.openSkills': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'skills' }),
    'singularityFlow.configureModels': () => openConfigurationCenter('models'),
    'singularityFlow.openWorkspaceLogs': async () => {
      const { WorkspaceLogsPanel } = lazyPanels();
      return WorkspaceLogsPanel.show(context, client, 'all');
    },
    'singularityFlow.refreshWorkspaceLogs': async () => {
      await refreshWorkspaceLogsTree();
      // Expanding the sidebar Logs section needs its summary, not the whole panels bundle.
      lazyPanelsRuntime?.WorkspaceLogsPanel.refreshCurrent();
    },
    'singularityFlow.openPromptAudit': async () => {
      const { WorkspaceLogsPanel } = lazyPanels();
      return WorkspaceLogsPanel.show(context, client, 'prompt');
    },
    'singularityFlow.openActivityLog': async () => {
      const { WorkspaceLogsPanel } = lazyPanels();
      return WorkspaceLogsPanel.show(context, client, 'activity');
    },
    'singularityFlow.openGoals': async () => {
      const { GoalsPanel } = lazyPanels();
      return GoalsPanel.show(context, client, () => [
        ...(store.current.snapshot?.workItems ?? []).map((item) => ({ ...item, kind: 'story' as const })),
        ...(store.current.snapshot?.initiatives ?? []).map((item) => ({ ...item, kind: 'initiative' as const }))
      ], refreshAfterSurfaceMutation);
    },
    'singularityFlow.openFaultRepairs': async () => {
      const { FaultRepairsPanel } = lazyPanels();
      return FaultRepairsPanel.show(context, client, async () => {
        await refreshAfterSurfaceMutation(); void refreshWorkspaceLogsTree();
      });
    },
    'singularityFlow.openJournal': async () => {
      const { JournalPanel } = lazyPanels();
      return JournalPanel.show(context, client, refreshAfterSurfaceMutation);
    },
    'singularityFlow.openSpecificationTrace': async () => {
      const { SpecificationTracePanel } = lazyPanels();
      return SpecificationTracePanel.show(context, client);
    },
    'singularityFlow.inspectCompositionCache': async () => {
      const status = await client.run<{ entries: number; bytes: number }>(['wm', 'cache', 'status', '--json']);
      void showCompactInformationMessage(`Composition cache: ${status.entries} exact prompt(s), ${status.bytes.toLocaleString()} bytes.`);
    },
    'singularityFlow.checkLedgerDeployment': async () => {
      const result = await client.run<{ valid: boolean; checks: Array<{ status: string }> }>(['ledger', 'deployment-check', '--offline', '--json']);
      const failed = result.checks.filter((check) => check.status === 'fail').length;
      void showCompactInformationMessage(result.valid ? 'Ledger deployment checks passed.' : `Ledger deployment needs attention: ${failed} failed check(s).`);
    },
    'singularityFlow.openVisualAssurance': async () => {
      const { VisualAssurancePanel } = lazyPanels();
      return VisualAssurancePanel.show(context, store, client);
    },
    'singularityFlow.openCopilot': async () => {
      try {
        const nativeUsageNotice = 'singularityFlow.nativeCopilotUsageUnavailableNotice';
        if (!context.globalState.get<boolean>(nativeUsageNotice, false)) {
          void showCompactInformationMessage(
            'Usage unavailable for native Copilot Chat in this build. Your work can continue. Use “Continue with Copilot CLI” for consented local usage capture.'
          );
          await context.globalState.update(nativeUsageNotice, true);
        }
        const target = path.resolve(client.repository);
        const workId = store.current.snapshot?.workflow?.workItem.id ?? null;
        const targetIsOpen = vscode.workspace.workspaceFolders?.some(
          (folder) => path.resolve(folder.uri.fsPath) === target
        ) === true;
        if (!targetIsOpen) {
          const pending: PendingCopilotHandoff = {
            kind: workId ? 'story' : 'workspace',
            repository: target,
            workId,
            requestedAt: new Date().toISOString()
          };
          await context.globalState.update(COPILOT_HANDOFF_KEY, pending);
          void showCompactInformationMessage(
            `${workId ?? 'Governed work'} belongs to ${target}. Switching this window to that repository; Copilot will open after reload.`
          );
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), false);
          return;
        }
        await openGovernedCopilot(workId);
      } catch (error) {
        showRefusal(error, { headline: 'Could not prepare governed Copilot context' });
      }
    },
    'singularityFlow.openMeteredCopilot': async () => {
      const terminal = vscode.window.createTerminal({
        name: 'Singularity Flow · Copilot CLI',
        cwd: client.repository
      });
      terminal.show(true);
      terminal.sendText('singularity-flow copilot --host vscode-terminal --surface vscode.continue-with-copilot', true);
    },
    // Creating and editing deliberately use different screens. Creation may introduce a new Git
    // repository, so it always uses the mapping form that accepts a clone URL and registers the
    // repository. The capability editor only changes nodes whose repository IDs already exist.
    'singularityFlow.addCapability': (async (node?: TreeNode) => {
      void node;
      return vscode.commands.executeCommand('singularityFlow.mapCapability');
    }) as never,
    'singularityFlow.editCapability': (async (node?: TreeNode) => {
      const { CapabilitiesPanel } = lazyPanels();
      const panel = await CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); });
      const capability = capabilityIdOf(node);
      if (capability) panel.focus(capability);
    }) as never
  };
  for (const [id, handler] of Object.entries(registered)) handlers.set(id, handler);
  // A contributed command with no handler here would be one the palette offers and nothing answers.
  const orphaned = REPOSITORY_COMMANDS.filter((id) => !handlers.has(id));
  if (orphaned.length) output.appendLine(`Commands with no handler: ${orphaned.join(', ')}`);

  // Content first, confirmation second. Every view is subscribed by now, so the previous session's
  // snapshot paints immediately; the refresh below replaces it a second later. Without this the
  // sidebar is empty for the whole of that second, on every single open.
  const completeInitialRepositoryRead = async (): Promise<void> => {
    // Somebody is waiting on this read, in a new window above all: ahead of discovery and checks.
    await store.refresh({ priority: 'interactive' });
    if (activationSignal.aborted) return;
    if (store.current.snapshot && !store.current.error && !store.current.stale) {
      markHostPerformance('confirmedSnapshotPublished');
    }
    // Auxiliary reads are read-only and scoped to this confirmed snapshot. Do not hold them behind
    // a first-run health probe whose CLI timeout can be much longer than the repository read.
    initialRefreshCompleted = true;
    startAuxiliaryReadsAfterConfirmedSnapshot();
    await runFirstRunHealth().catch((error) => {
      firstRunBlocked = true;
      output.appendLine(`First-run health check failed: ${(error as Error).message}`);
    });
    const pendingStartWizard = context.globalState.get<PendingStartWizard | null>(START_WIZARD_KEY, null);
    if (pendingStartWizard?.step === 'work' && pendingStartWizard.resumeOnActivation) {
      // Clear only the auto-resume bit before opening the form. A second reload must not repeatedly
      // take over the editor, while the remaining marker lets the explicit Guided start command
      // resume this final step if the person closes the form.
      await context.globalState.update(START_WIZARD_KEY, {
        ...pendingStartWizard,
        resumeOnActivation: false
      });
      if (pendingStartWizard.workspaceId && pendingStartWizard.workspaceId !== resolved.workspaceId) {
        void showCompactWarningMessage(
          `Guided Start paused because the active workspace changed from ${pendingStartWizard.workspaceName ?? pendingStartWizard.workspaceId}. Run Guided Start again to continue in the current workspace.`
        );
      } else {
        await vscode.commands.executeCommand('singularityFlow.startWork', {
          guidedStart: true,
          workspaceName: pendingStartWizard.workspaceName ?? workspaceLabel
        });
      }
    }
    const pendingHandoff = context.globalState.get<PendingCopilotHandoff | null>(COPILOT_HANDOFF_KEY, null);
    const openFolders = vscode.workspace.workspaceFolders ?? [];
    if (pendingHandoff && openFolders.some(
      (folder) => path.resolve(folder.uri.fsPath) === path.resolve(pendingHandoff.repository)
    )) {
      // Clear before opening chat. If prompt composition fails, reloading the window must not create
      // an endless retry loop; the visible error leaves the person in the correct repository.
      await context.globalState.update(COPILOT_HANDOFF_KEY, undefined);
      try {
        // The discriminator is intentional: legacy handoffs without it fail closed to workspace
        // selection instead of inferring a Story from mutable repository state after the reload.
        if (pendingHandoff.kind === 'story' && pendingHandoff.workId) {
          await openGovernedCopilot(pendingHandoff.workId);
        } else {
          await openWorkspaceCopilot(pendingHandoff.workspaceName);
        }
      } catch (error) {
        showRefusal(error, { headline: 'Could not resume governed Copilot handoff' });
      }
    }
    // The Navigator is already the successful first screen. My Work remains its primary action,
    // but opening it without a click loads the full interactive gateway after first paint and
    // creates a visible event-loop pause in a window whose reader asked only for the sidebar.
  };

  if (store.primeFromCache()) markHostPerformance('cachePublished');
  if (vscode.env?.appHost) {
    // VS Code resolves a contributed view only after activate() returns. Awaiting the fresh CLI
    // snapshot here made the cache-first path impossible: the bytes existed, but the host could not
    // paint them. Return after registering every command/provider, then confirm in the next turn.
    markHostPerformance('activationComplete');
    setTimeout(() => {
      if (activationSignal.aborted) return;
      void completeInitialRepositoryRead().catch((error) => {
        output.appendLine(`Initial repository refresh failed: ${(error as Error).message}`);
      });
    }, 0);
  } else {
    await completeInitialRepositoryRead();
    markHostPerformance('activationComplete');
  }
}

/**
 * Open Markdown artifacts rendered by default; other formats use their normal editor.
 *
 * The path comes from the snapshot rather than from anything a view constructed, and it is resolved
 * and then checked to be inside the repository — a `..` that escaped the workspace would be a
 * genuine path-traversal, and the check costs nothing.
 */
/** What a governed workflow configuration change came to, for screens that report it. */
export interface WorkflowChangeOutcome {
  outcome: 'cancelled' | 'proposed' | 'written' | 'unchanged' | 'failed';
  branch?: string;
  error: string | null;
}

async function openArtifact(
  repository: string,
  node?: TreeNode,
  cliPackageRoot?: string
): Promise<void> {
  if (!node?.path) return;
  const base = node.packagePath ? cliPackageRoot : repository;
  if (!base) {
    showRefusal(`This build does not contain ${node.path}.`, { headline: 'Packaged resource not found' });
    return;
  }
  const requested = node.packagePath ?? node.path;
  const absolute = path.resolve(base, requested);
  const relative = path.relative(base, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const boundary = node.packagePath ? 'installed Singularity Flow engine' : 'repository';
    showRefusal(`${requested} resolves outside the ${boundary}, so it was not opened.`,
      { headline: `Refused: that path leaves the ${boundary}` });
    return;
  }

  const uri = vscode.Uri.file(absolute);
  try {
    const [info, realBase, realFile] = await Promise.all([lstat(absolute), fsRealpath(base), fsRealpath(absolute)]);
    const realRelative = path.relative(realBase, realFile);
    if (!info.isFile() || info.isSymbolicLink() || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('Artifact path is not a regular file inside its repository.');
    }
    if (/\.(md|markdown)$/iu.test(absolute)) await vscode.commands.executeCommand('markdown.showPreview', uri);
    else await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    if (node.readOnly) {
      const message = node.packagePath
        ? '$(lock-small) This resource ships with Singularity Flow and is read-only. Copy it into the repository to customize it.'
        // An approved artifact is pinned by hash into approvals that already happened, so editing it
        // in place silently invalidates them. Said once, rather than enforced by fighting the editor.
        : '$(lock-small) This artifact is approved and hash-pinned. Editing it invalidates its approval.';
      void vscode.window.setStatusBarMessage(
        message, 6_000);
    }
  } catch {
    void showCompactWarningMessage(`This artifact has not been generated yet: ${node.path}`);
  }
}

async function showImpact(client: SingularityFlowClient, output: vscode.OutputChannel): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Computing impact…' },
    async () => {
      try {
        const impact = await client.runText(['epic', 'impact', '--markdown']);
        const document = await vscode.workspace.openTextDocument({ content: impact, language: 'markdown' });
        await vscode.window.showTextDocument(document, { preview: true });
      } catch (error) {
        output.appendLine(`epic impact failed: ${(error as Error).message}`);
        showRefusal(error);
      }
    }
  );
}

/**
 * The lead repository of a workspace directory, or null when this is not one.
 *
 * Read through the editor's own file system rather than the CLI: this runs on a path the CLI has
 * already refused to treat as a repository, so there is nothing to run a command in.
 */
/** Where the governed repository came from, said in the words a reader would use. */
type Resolved =
  | ActiveRepositoryContext & { repository: string }
  | { label: string; reason: string; contextValue?: string; lead?: string | null };

/**
 * Which repository this window governs.
 *
 * The map and the governed state live in a repository, but nobody works by opening that repository
 * as their editor folder — they work in a workspace, and the workspace already knows where its lead
 * is. Requiring the folder to be the repository made every screen in the product unreachable from
 * the place people actually start, and answered with "open the repository that contains
 * singularity/workflow.yml", which is a demand rather than an explanation.
 *
 * So three sources, in authority order: the explicitly selected active workspace repository;
 * otherwise
 * the open folder when it is governed; otherwise the lead named by an opened workspace directory.
 * The first is what makes the product usable from a window with something else entirely open.
 */
async function resolveGovernedRepository(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<Resolved> {
  // The active workspace leads. Choosing one is an explicit act — it says which capabilities are
  // being worked on and where — and everything else in the product is scoped by it, so it cannot be
  // a fallback for whatever folder happens to be open. The open folder answers only when no
  // workspace has been chosen.
  const active = await activeWorkspaceRepository(context, output);
  if (active) return active;

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    try {
      const repository = await validateRepositoryDirectory(folder.uri.fsPath, { signal: extensionLifetime.signal });
      return {
        repository, root: repository, origin: 'the open folder', workspaceId: null,
        workspaceName: null, repositoryId: null
      };
    } catch (error) {
      let repositoryError = error as Error;
      // A workspace directory holds repos/, documents/ and workspace.json — it is not itself a
      // repository, but opening it is the obvious thing to do from a file manager, and it knows
      // exactly where the repository someone wanted is. Now it is used rather than described.
      const lead = await workspaceLeadDirectory(folder.uri.fsPath);
      if (lead) {
        try {
          const repository = await validateRepositoryDirectory(lead, { signal: extensionLifetime.signal });
          return {
            repository, root: repository,
            origin: 'the lead repository of the workspace directory you have open',
            workspaceId: null, workspaceName: null, repositoryId: null
          };
        } catch (leadError) {
          if (leadError instanceof RepositoryAuthorityUnavailableError) repositoryError = leadError;
        }
      }
      return {
        label: repositoryError instanceof RepositoryAuthorityUnavailableError
          ? 'Singularity Flow authority is unavailable'
          : 'Not a Singularity Flow repository',
        reason: repositoryError.message,
        contextValue: repositoryError instanceof RepositoryAuthorityUnavailableError
          ? 'sflow.authorityUnavailable'
          : 'sflow.uninitialized'
      };
    }
  }

  return {
    label: 'No workspace is active',
    reason: 'Choose a workspace to work in, or create one. Everything else is scoped to it.'
  };
}

/**
 * The selected repository of the active workspace, when there is one.
 *
 * No selection returns null so an open folder can be considered. A selected workspace that cannot
 * be read returns its own repair state instead: silently falling back to an unrelated editor folder
 * would make different surfaces act on different repositories again.
 */
async function activeWorkspaceRepository(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<Resolved | null> {
  let current: {
    active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
    repositoryId?: string; repositoryPath?: string; repositoryState?: string;
    canonicalRepositoryPath?: string; checkoutPath?: string | null; storyId?: string | null;
    selectionStatus?: string; selectionError?: string | null;
  };
  try {
    const client = new SingularityFlowClient({
      location: resolveCli({ extensionPath: context.extensionPath }),
      repository: process.cwd(),
      onOutput: () => {}
    });
    // The shape `workspace current --json` actually emits: flat, and it already names the lead
    // repository. This read `current.workspace.path` — a nested field the CLI has never produced —
    // so it resolved to undefined every time and the active workspace was silently never consulted.
    // Whichever folder happened to be open won, always, including when somebody had just chosen a
    // workspace. The test that covered this asserted the order of two lines in this file rather
    // than what the function returns, so it passed throughout.
    current = await client.run(['workspace', 'current', '--json']);
  } catch (error) {
    output.appendLine(`Could not read the active workspace: ${(error as Error).message}`);
    return {
      label: 'Active workspace selection could not be read',
      reason: `Select the workspace again or repair its machine-local record: ${(error as Error).message}`,
      contextValue: 'sflow.workspace.repositoryUnavailable'
    };
  }
  if (current.active === false) return null;
  if (current.selectionStatus === 'stale' && current.storyId) {
    return {
      label: `Selected Story ${current.storyId} needs reattachment`,
      reason: `Its previous checkout is unavailable${current.selectionError ? `: ${current.selectionError}` : '.'} Run “Select Story” or singularity-flow session attach ${current.storyId} --json.`,
      contextValue: 'sflow.workspace.repositoryUnavailable',
      lead: current.canonicalRepositoryPath ?? current.repositoryPath ?? null
    };
  }
  const directory = current.workspacePath;
  if (!directory) {
    return {
      label: 'Active workspace selection is incomplete',
      reason: 'Select the workspace again so its working directory and lead repository can be resolved.'
    };
  }
  // Story surfaces act on the selected member repository. Governed Goals remain owned by the
  // workspace lead, so retain both paths instead of overloading "lead" with the selection.
  const workspaceLead = await workspaceLeadDirectory(directory);
  const selectedRepository = current.repositoryPath ?? workspaceLead;
  if (!selectedRepository) {
    return {
      label: 'Workspace lead repository is not configured',
      reason: `${current.workspaceName ?? directory} is selected, but it has no resolvable lead repository. Edit the workspace details.`,
      contextValue: 'sflow.workspace.repositoryUnavailable'
    };
  }
  if (current.repositoryState && current.repositoryState !== 'ready') {
    return {
      label: `Workspace repository is ${current.repositoryState}`,
      reason: `${current.workspaceName ?? directory} is selected, but its repository at ${selectedRepository} is ${current.repositoryState}. Repair the selected workspace to materialize it from workspace.json.`,
      contextValue: 'sflow.workspace.repositoryUnavailable',
      lead: selectedRepository
    };
  }
  try {
    const repository = await validateRepositoryDirectory(selectedRepository, { signal: extensionLifetime.signal });
    return {
      repository,
      root: repository,
      workspaceId: current.workspaceId ?? null,
      workspaceName: current.workspaceName ?? current.workspaceId ?? directory,
      repositoryId: current.repositoryId ?? null,
      leadRepositoryPath: workspaceLead ?? repository,
      origin: `the selected repository of your active workspace, ${current.workspaceName ?? directory}`
    };
  } catch (error) {
    output.appendLine(`Active workspace lead is unavailable: ${(error as Error).message}`);
    return {
      label: 'Workspace lead repository is not ready',
      reason: `${current.workspaceName ?? directory} is selected, but ${selectedRepository} cannot load Singularity Flow: ${(error as Error).message}`,
      contextValue: 'sflow.workspace.repositoryUnavailable',
      lead: selectedRepository
    };
  }
}

async function workspaceLeadDirectory(folder: string): Promise<string | null> {
  try {
    const manifest = vscode.Uri.file(path.join(folder, 'workspace.json'));
    const text = Buffer.from(await vscode.workspace.fs.readFile(manifest)).toString('utf8');
    const workspace = JSON.parse(text) as {
      leadRepository?: string;
      repositories?: Record<string, { path?: string }>;
    };
    const lead = workspace.leadRepository;
    if (!lead) return null;
    const relative = workspace.repositories?.[lead]?.path ?? `repos/${lead}`;
    return path.join(folder, relative);
  } catch {
    return null;
  }
}

/**
 * The Git context whose presentation identity/signing applies to a capability action.
 *
 * Capability configuration lives in a remote lead checkout, but the author starts the action from
 * this editor window. The active repository context has already resolved Story worktrees and
 * workspace-shell selection, so it is authoritative when present. Before a governed repository can
 * be selected (the first-capability case), an opened workspace shell can still name its lead; an
 * ordinary opened checkout is itself the initiating root. `process.cwd()` is deliberately last: an
 * extension host is commonly launched from the user's home and must not override repository-local
 * Git configuration merely because the capability operation itself uses a remote URL.
 */
async function capabilityActionInitiatingRoot(): Promise<string> {
  const active = activeRepositoryContext()?.root;
  if (active) return active;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) return process.cwd();
  return await workspaceLeadDirectory(folder) ?? folder;
}

export function deactivate(): void {
  extensionLifetime.abort();
}
