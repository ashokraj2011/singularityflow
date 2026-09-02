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
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, readFile, rm } from 'node:fs/promises';
import { gatewayDestinationRequest } from './gateway-destination.ts';
import { resolveCli, SingularityFlowClient, type CliLocation } from './cli/client.ts';
import {
  RepositoryAuthorityUnavailableError, validateRepositoryDirectory
} from './cli/runner.ts';
import { WorkspaceStore } from './state.ts';
import type { RepositorySnapshot } from './cli/snapshot.ts';
import { ConfigurationValidator } from './validation.ts';
import { approveWithReceipt, resolvePlaceholders, runGovernedAction, runPlannedAction } from './actions.ts';
import { commandArgv } from './commands.ts';
import { LifecycleTreeProvider } from './views/lifecycle.ts';
import type { JourneyMessage } from './views/journey.ts';
import { buildJourney } from './views/journey-model.ts';
import type { ApprovalsMessage } from './views/approvals.ts';
import type { InboxMessage } from './views/inbox.ts';
import { buildInboxTree } from './views/inbox-model.ts';
import type { StoriesMessage } from './views/stories.ts';
import type { CapabilitiesMessage } from './views/capabilities.ts';
import type { DesignerMessage } from './views/designer.ts';
import type { ConfigurationCenterMessage } from './views/configuration-center.ts';
import type { ConfigurationTab } from './views/configuration-center-model.ts';
import type { HelpDocument } from './views/help-page.ts';
import type { WorkspacesMessage } from './views/workspaces-panel.ts';
import type { Mapped } from './views/bootstrap-panel.ts';
import {
  archiveCommand, configurationRefreshCommand, restoreCommand, workspaceRows,
  type WorkspaceConfigurationRefreshResult, type WorkspaceEntry, type WorkspaceStatus
} from './views/workspaces-model.ts';
import { capabilityChoices, type RemoteCapability } from './views/workspace-form.ts';
import { capabilityProposalArgv } from './views/capability-model.ts';
import { buildConfigurationTree, unavailableTree, type TreeNode } from './views/tree-model.ts';
import { NodeTreeProvider } from './views/navigation.ts';
import { SidebarViewProvider } from './views/sidebar.ts';
import { PROFILE_PERSONAS, isProfilePersonaId, resolveProfilePersona } from './views/profile-personas.ts';
import {
  buildWorkspaceTree, capabilityIdOf, workspacePathOf, type CapabilityReadiness
} from './views/navigation-trees.ts';
import { SecureCredentials } from './credentials.ts';
import {
  evidenceCatalog, evidenceCommands, evidenceDetachCommand, evidenceTargets,
  expandEpicEvidenceDirectory, validateEvidenceUrl,
  type EvidenceCatalogItem, type EvidenceTarget
} from './evidence.ts';
import type { EvidenceSourceKind } from './views/evidence-manager.ts';
import { onFormSubmit, showForm, useDraftStore } from './views/form-panel.ts';
import {
  onAutoResultAction, onHomeRequest, onResultAction, resultPanelRepositoryChanged,
  showRefusal, showResultCard
} from './views/result-panel.ts';
import { buildResultCard, gateSummary } from './views/result-card-model.ts';
import {
  ACKNOWLEDGE_ACTION_ID, acknowledgementKey, homeAcknowledgementFor, type HomeAcknowledgement
} from './views/home-acknowledgement.ts';
import {
  activeRepositoryContext, gatewaySession, provideAcknowledgedAt, provideHomeLens,
  resetGatewaySession, setActiveRepositoryContext, type ActiveRepositoryContext, type GatewayRepositoryContext
} from './gateway-session.ts';
import { latestWorkspaceBootstrap } from '../../../src/workspace-bootstrap.mjs';
import { readRecord } from '../../../src/schema-migrations.mjs';
import { registerSflowChat } from './sflow-chat.ts';
import { recordHelpMetric } from '../../../src/help-metrics.mjs';
import { storyCheckoutIssue, unsavedRepositoryPaths } from './generation-guards.ts';
import { renderReworkRollForwardPreview } from './views/rework-roll-forward-preview.ts';
import { RepositoryEpochGuard, type RepositoryEpochToken } from './repository-epoch.ts';
import { RevisionSliceWatcherFence } from './watcher-refresh-fence.ts';

let extensionLifetime = new AbortController();

/** Injected by esbuild: the commit and time this bundle was built from. */
declare const __SFLOW_BUILD__: string;

const COPILOT_HANDOFF_KEY = 'singularityFlow.pendingCopilotHandoff';
const START_WIZARD_KEY = 'singularityFlow.pendingStartWizard.v1';

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
  uncommittedResetPaths: string[];
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
    probe('git', ['--version'], { timeout: 5_000 }),
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
    { id: 'git', status: git.ok ? 'healthy' : 'blocked', detail: git.ok ? git.stdout.trim() : 'Git is unavailable' },
    { id: 'cli', status: cli.ok ? 'healthy' : 'blocked', detail: cli.ok ? 'bundled CLI executes' : 'bundled CLI did not execute' },
    { id: 'machine-state', status: writable ? 'healthy' : 'blocked', detail: 'machine-local SFlow state location is writable' },
    { id: 'repository', status: 'healthy', detail: repositoryKind }
  ];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionLifetime.abort();
  extensionLifetime = new AbortController();
  // Module state can survive a deactivate/reactivate cycle in the same extension host. Until this
  // activation validates a workspace or folder, no command may inherit the previous routing choice.
  setActiveRepositoryContext(null);
  const output = vscode.window.createOutputChannel('Singularity Flow');
  context.subscriptions.push(output);
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
  provideHomeLens(() => {
    const role = vscode.workspace.getConfiguration('singularityFlow').get<string>('role', 'developer');
    return ['developer', 'qa', 'architect', 'product-owner', 'admin'].includes(role) ? role : 'developer';
  });

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
      const resolution = kernel.resolve({
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
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.myWork', async () => {
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
      showResultCard(buildResultCard(envelope, { acknowledgement }), { origin: 'gateway' });
    } catch (error) {
      if (generation !== homeRequestGeneration || activeRepositoryContext() !== active) return;
      showRefusal(error, { headline: 'Could not read your work' });
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
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.previewSelectedImpact', async (uri?: vscode.Uri) => {
    const active = activeRepositoryContext();
    const selected = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!active || !selected || selected.scheme !== 'file') {
      showRefusal('Open a file inside the active governed repository, then try again.', { headline: 'No code selected' });
      return;
    }
    const relative = path.relative(active.root, selected.fsPath).split(path.sep).join('/');
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      showRefusal('The selected file is outside the active governed repository.', { headline: 'Selection is out of scope' });
      return;
    }
    try {
      const { kernel } = gatewaySession(active);
      const resolution = kernel.resolve({
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
    if (event.affectsConfiguration('singularityFlow.modelMode')) cliEnvironment = await resolvedCliEnvironment();
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
    void vscode.window.showInformationMessage(`${role.label} menu is ready. All commands remain available.`);
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
    void vscode.window.showInformationMessage(
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
    void vscode.window.showInformationMessage(
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
      void vscode.window.showInformationMessage('Jira connected securely. Reload this window to apply it to every view.', 'Reload')
        .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
    } catch (error) {
      showRefusal(error, { headline: 'Jira was not saved' });
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetJira', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Remove the saved Jira connection from the operating-system keychain?', { modal: true }, 'Reset Jira');
    if (choice !== 'Reset Jira') return;
    await secureCredentials.resetJira();
    cliEnvironment = await resolvedCliEnvironment();
    void vscode.window.showInformationMessage('Saved Jira credentials removed.');
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
    void vscode.window.showInformationMessage('Teams notifications configured. Reload this window to apply the secret to every command.', 'Reload')
      .then((choice) => choice === 'Reload' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : undefined);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resetTeams', async () => {
    const choice = await vscode.window.showWarningMessage(
      'Remove the saved Teams webhook from the operating-system keychain?', { modal: true }, 'Reset Teams');
    if (choice !== 'Reset Teams') return;
    await secureCredentials.resetTeamsWebhook();
    cliEnvironment = await resolvedCliEnvironment();
    void vscode.window.showInformationMessage('Saved Teams webhook removed.');
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
    'singularityFlow.openApprovals', 'singularityFlow.openInbox', 'singularityFlow.startWork',
    'singularityFlow.openAdhocWork',
    'singularityFlow.openDeveloperHome',
    'singularityFlow.openGoals', 'singularityFlow.openFaultRepairs', 'singularityFlow.openJournal',
    'singularityFlow.attachEvidence', 'singularityFlow.manageEvidence',
    'singularityFlow.detachEvidence', 'singularityFlow.addSource',
    'singularityFlow.refresh', 'singularityFlow.openArtifact', 'singularityFlow.runAction',
    'singularityFlow.continueSafely',
    'singularityFlow.prepareStoryPhase', 'singularityFlow.publishStoryPhase',
    'singularityFlow.submitStoryPhase',
    'singularityFlow.approve', 'singularityFlow.openJourney', 'singularityFlow.openCommandCenter', 'singularityFlow.openReconciliation',
    'singularityFlow.showImpact', 'singularityFlow.addCapability', 'singularityFlow.editCapability',
    'singularityFlow.openDashboard', 'singularityFlow.openDesigner',
    'singularityFlow.publishConfiguration',
    'singularityFlow.openInstructionDesigner', 'singularityFlow.openPromptAudit', 'singularityFlow.openActivityLog',
    'singularityFlow.openWorkspaceLogs', 'singularityFlow.refreshWorkspaceLogs', 'singularityFlow.openSpecificationTrace',
    'singularityFlow.inspectCompositionCache', 'singularityFlow.checkLedgerDeployment',
    'singularityFlow.openCopilot', 'singularityFlow.openMeteredCopilot',
    'singularityFlow.openVisualAssurance',
    'singularityFlow.openConfigurationCenter', 'singularityFlow.configureWorldModel',
    'singularityFlow.buildWorldModel', 'singularityFlow.configureAstIntelligence',
    'singularityFlow.configurePeople', 'singularityFlow.configureMcp',
    'singularityFlow.configureTemplates', 'singularityFlow.configureModels',
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
  const sidebar = new SidebarViewProvider(context.globalState, () => {
    const settings = vscode.workspace.getConfiguration('singularityFlow');
    return { name: settings.get<string>('userName') ?? '', role: settings.get<string>('role') ?? '' };
  });
  refreshPersonaMenus = () => sidebar.profileChanged();
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
      const { HelpPanel } = await import('./views/help.ts');
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
      const { HelpPanel } = await import('./views/help.ts');
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
  for (const id of REPOSITORY_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: never[]) => {
      const handler = handlers.get(id);
      if (handler) return handler(...args);
      void vscode.window.showWarningMessage(
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
      label: 'Review capability proposals', description: 'inspect pending organisation changes',
      tooltip: 'List pending capability-map proposals across every registered lead repository.',
      icon: 'merge', runCommand: 'singularityFlow.reviewCapabilityProposals'
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
   * Create a workspace, then offer its append-only state branch and open the lead repository.
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

    const { WorkspacePanel } = await import('./views/workspace-panel.ts');
    const guidedStart = request?.guidedStart === true;
    const journey = guidedStart ? {
      step: 'workspace' as const,
      capabilityId: request?.capabilityId ?? null
    } : null;
    const workspacePanel = WorkspacePanel.show(context, location, output, async (created) => {
      // The state branch is not created here. `workspace create` does it, in the repository the lead
      // capability ships from — one owner, so the editor and the CLI cannot disagree about where the
      // branch goes, and the editor's copy cannot silently skip a repository the CLI would govern.
      void vscode.window.showInformationMessage(`Workspace created. Now working in ${created.name}.`);
      const requiresReload = workspaceSelected.length === 0;
      if (guidedStart) {
        await context.globalState.update(START_WIZARD_KEY, startWizardState('work', {
          capabilityId: request?.capabilityId ?? null,
          organisation: request?.organisation ?? null,
          workspaceId: created.id,
          workspaceName: created.name,
          workspacePath: created.directory,
          resumeOnActivation: requiresReload
        }));
      }
      const selected = await selectWorkspace(created.directory, created.leadDirectory, created.name);
      if (!selected && guidedStart) {
        await context.globalState.update(START_WIZARD_KEY, startWizardState('workspace', {
          capabilityId: request?.capabilityId ?? null,
          organisation: request?.organisation ?? null
        }));
      } else if (selected && guidedStart && !requiresReload) {
        await vscode.commands.executeCommand('singularityFlow.startWork', {
          guidedStart: true,
          workspaceName: created.name
        });
      }
    }, async () => {
      // Keep the workspace draft open. Capability setup creates a review proposal; the proposal
      // review panel activates it on the protected configuration branch and then reloads this draft.
      await vscode.commands.executeCommand(
        'singularityFlow.mapCapability',
        { journey: guidedStart ? {
          step: 'capability' as const,
          capabilityId: request?.capabilityId ?? null
        } : null },
        async (mapped: Mapped) => {
          if (guidedStart) {
            await context.globalState.update(START_WIZARD_KEY, startWizardState('workspace', {
              capabilityId: mapped.capabilityId,
              organisation: mapped.lead
            }));
          }
          await workspacePanel.refreshCapabilityMap({
            capabilityId: mapped.capabilityId,
            organisation: mapped.lead
          });
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
        const accepted = await vscode.window.showWarningMessage(
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
      void vscode.window.showInformationMessage(`${name.trim()} now uses the existing clone. No Git state was changed.`);
      await selectWorkspace(result.workspace.path, lead, name.trim());
    } catch (error) {
      showRefusal(error, { headline: 'Could not use the existing clone' });
    }
  }));

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
        if (session.nextAction?.command) output.appendLine(`    Recover: ${session.nextAction.command}`);
      }
      output.show(true);
      void vscode.window.showInformationMessage(result.healthy
        ? 'Workspace setup checks passed. Details are in Singularity Flow output.'
        : 'Workspace setup needs attention. Review the Singularity Flow output.');
    } catch (error) {
      showRefusal(error, { headline: 'Workspace diagnostics could not run' });
    }
  }));

  /** Resume the latest preserved bootstrap through the same exact-confirm CLI boundary. */
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.resumeWorkspaceBootstrap', async () => {
    let location;
    try {
      location = resolveCli({ extensionPath: context.extensionPath });
    } catch (error) {
      return showRefusal(error);
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
        return;
      }
      const choices = sessions.map((entry) => ({
        label: entry.plan?.workspace?.name ?? entry.request?.workspaceName ?? entry.bootstrapId,
        description: entry.status,
        detail: entry.plan?.workspace?.targetPath ?? entry.nextAction?.command ?? '',
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
        return;
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
        void vscode.window.showInformationMessage(`${selected.label} is ready.`);
        await vscode.commands.executeCommand('singularityFlow.openWorkspaces');
      } else {
        const blockers = (result.preflight?.findings ?? [])
          .filter((finding: any) => finding.severity === 'blocker')
          .map((finding: any) => `${finding.message}${finding.action ? `\nRecovery: ${finding.action}` : ''}`);
        const actions = (result.recoveryActions ?? [])
          .filter((action: any) => action.command)
          .map((action: any) => `${action.label ?? action.id}: ${action.command}`);
        const detail = [
          result.fault?.message,
          ...blockers,
          actions.length ? `Available recovery paths:\n${actions.join('\n')}` : null,
          'The bootstrap ID, reviewed plan, and any owned partial workspace were preserved.'
        ].filter(Boolean).join('\n\n');
        showRefusal(detail || 'Workspace setup still needs attention. No reviewed plan was widened.', {
          headline: `Setup is ${result.status}`
        });
      }
    } catch (error) {
      showRefusal(error, { headline: 'Could not resume workspace setup' });
    }
  }));

  /**
   * Govern a repository that has never heard of Singularity Flow.
   *
   * Registered before any early return, and it has to be: this is the command that produces the
   * thing every other command needs, so requiring one would be the whole chicken-and-egg problem
   * written into the extension.
   */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.mapCapability',
    async (
      requestOrReturn?: {
        parent?: string;
        journey?: { step: 'capability' | 'workspace' | 'work'; capabilityId?: string | null; workspaceName?: string | null } | null;
      } | ((mapped: Mapped) => Promise<void>),
      returnAfterMapping?: (mapped: Mapped) => Promise<void>
    ) => {
    const initial = typeof requestOrReturn === 'object' && requestOrReturn
      ? { parent: requestOrReturn.parent, journey: requestOrReturn.journey }
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
    // Run from wherever the CLI is rooted: describing what an organisation builds is not work done
    // inside a checkout, and requiring one was the circular dependency this breaks.
    const registry = new SingularityFlowClient({
      location, repository: process.cwd(), onOutput: (text) => output.append(text)
    });
    const run = async (argv: string[]): Promise<{ result: unknown; error: string | null }> => {
      output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
      try {
        return { result: await registry.run<unknown>(argv), error: null };
      } catch (error) {
        output.appendLine(`  failed: ${(error as Error).message}`);
        return { result: null, error: (error as Error).message };
      }
    };

    const leads = await registry
      .run<Array<{ url: string }>>(['capability', 'leads', '--json'])
      .catch(() => []);

    const { BootstrapPanel } = await import('./views/bootstrap-panel.ts');
    BootstrapPanel.show(context, leads.map((lead) => lead.url), run, async (mapped: Mapped) => {
      if (!mapped.reviewRequired || !mapped.branch) {
        void vscode.window.showInformationMessage(`${mapped.capabilityId} is already active on ${mapped.baseBranch}.`);
        if (typeof returnToWorkspace === 'function') await returnToWorkspace(mapped);
        return;
      }
      const { CapabilityProposalPanel } = await import('./views/capability-proposal.ts');
      CapabilityProposalPanel.show(context, mapped.lead, mapped.branch, run, async () => {
        // A retained workspace form contains the user's unsaved directory and identity choices.
        // Refresh that form only after activation, when the capability is genuinely selectable.
        if (typeof returnToWorkspace === 'function') await returnToWorkspace(mapped);
      });
    }, initial);
  }));

  /** Reopen any pending capability proposal without finding its branch in a terminal. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.reviewCapabilityProposals',
    async () => {
      let location;
      try {
        location = resolveCli({ extensionPath: context.extensionPath });
      } catch (error) {
        return showRefusal(error);
      }
      const registry = new SingularityFlowClient({
        location, repository: process.cwd(), onOutput: (text) => output.append(text)
      });
      const run = async (argv: string[]): Promise<{ result: unknown; error: string | null }> => {
        output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
        try { return { result: await registry.run<unknown>(argv), error: null }; }
        catch (error) { return { result: null, error: (error as Error).message }; }
      };
      const { CapabilityProposalsPanel } = await import('./views/capability-proposals.ts');
      CapabilityProposalsPanel.show(context, run, (lead, branch) => {
        void import('./views/capability-proposal.ts').then(({ CapabilityProposalPanel }) => {
          CapabilityProposalPanel.show(context, lead, branch, run);
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
    'singularityFlow.openWorkspaces', async (request?: TreeNode | { upgrade?: boolean }) => {
    const upgrade = Boolean(request && typeof request === 'object' && 'upgrade' in request && request.upgrade);
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
    const list = (): Promise<WorkspaceEntry[]> =>
      registry.run<WorkspaceEntry[]>(['workspace', 'list', '--json']).catch(() => []);
    const details = async (workspacePath: string): Promise<WorkspaceStatus> => {
      // Inspecting an archived workspace must not restore it as a side effect. `status` reads the
      // checkout and computes the immediate local archive proof from that same snapshot. The
      // mutating archive command refreshes remotes and verifies again before changing the registry.
      const status = await registry.run<WorkspaceStatus>([
        'workspace', 'status', workspacePath, '--archive-readiness', '--no-fetch', '--json'
      ]);
      const lead = status.repositories.find((repository) =>
        repository.id === status.workspace.leadRepository || repository.role === 'lead');
      if (!lead?.url) return status;
      try {
        const organisation = await registry.run<{
          capabilities?: RemoteCapability[] | null;
          repositories?: Record<string, { url?: string; defaultBranch?: string }>;
        }>(['capability', 'organisation', lead.url, '--json']);
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

    const onMessage = async (message: WorkspacesMessage): Promise<string | null> => {
      if (message.type === 'create') {
        await vscode.commands.executeCommand('singularityFlow.createWorkspace');
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
        const confirmed = await vscode.window.showWarningMessage(
          `Forget ${message.row.name}?`,
          { modal: true, detail: `Removes it from the workspace list. ${message.row.directory} is left exactly as it is.` },
          'Forget');
        if (confirmed !== 'Forget') return null;
        message = { type: 'run', command: ['workspace', 'forget', message.row.directory, '--json'], title: 'Forgetting workspace' };
      }
      if (message.type === 'archive') {
        const confirmed = await vscode.window.showWarningMessage(
          `Archive ${message.row.name}?`,
          {
            modal: true,
            detail: 'Singularity Flow will refresh every repository and refuse if any Story is still active. The checkout, branches and generated artifacts are preserved.'
          },
          'Archive workspace'
        );
        if (confirmed !== 'Archive workspace') return null;
        message = {
          type: 'run', command: archiveCommand(message.row), title: `Archiving ${message.row.name}`
        };
      }
      if (message.type === 'restore') {
        message = {
          type: 'run', command: restoreCommand(message.row), title: `Restoring ${message.row.name}`
        };
      }
      output.appendLine(`\n$ singularity-flow ${message.command.join(' ')}`);
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

    const { WorkspacesPanel } = await import('./views/workspaces-panel.ts');
    const refreshConfiguration = async (
      workspacePath: string | null,
      request: Parameters<typeof configurationRefreshCommand>[1]
    ): Promise<WorkspaceConfigurationRefreshResult> => {
      // The engine revalidates registry membership and the exact plan before mutation. Avoid a
      // second machine-wide `workspace list` process merely to recover the already-selected path.
      const command = configurationRefreshCommand(
        workspacePath ? { directory: workspacePath } : null,
        request
      );
      output.appendLine(`\n$ singularity-flow ${command.join(' ')}`);
      try {
        return await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: request.dryRun ? 'Checking SFlow configuration' : 'Refreshing SFlow configuration'
          },
          () => registry.run<WorkspaceConfigurationRefreshResult>(command)
        );
      } catch (error) {
        // This command deliberately exits non-zero for a blocked or partial multi-repository result.
        // Keep that structured result so the page can name the failed repository, review branch,
        // and recovery state instead of displaying a serialized JSON object as an exception.
        const result = (error as { result?: unknown }).result;
        if (result && typeof result === 'object' && Array.isArray((result as { results?: unknown }).results)) {
          return result as WorkspaceConfigurationRefreshResult;
        }
        throw error;
      }
    };
    WorkspacesPanel.show(context, await list(), list, async (message) => {
      const failure = await onMessage(message);
      // Anything that changes the registry changes the tree beside it.
      if (message.type !== 'switch') void refreshWorkspaceTree();
      return failure;
    }, details, refreshConfiguration, workspacePathOf(node) ?? node?.path ?? null, upgrade ? 'all' : null);
  }));

  /** One discoverable post-install entry point: open the reviewed UI and check every workspace. */
  context.subscriptions.push(vscode.commands.registerCommand(
    'singularityFlow.upgradeWorkspaces',
    () => vscode.commands.executeCommand('singularityFlow.openWorkspaces', { upgrade: true })
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
    } catch (error) {
      output.appendLine(`Could not read the workspace registry: ${(error as Error).message}`);
      workspaceEntries = [];
      drawWorkspaces();
    }
  };
  /**
   * Make one workspace current, for this window and for the machine.
   *
   * Selecting a workspace does not open anything. It used to reload the window, or open the lead
   * repository as a folder — which threw away every open editor and every scroll position to change
   * which repository some commands run in, and made "have a look at that other workspace" an act
   * with a cost. Choosing is now cheap and reversible: pick another one whenever you like.
   *
   * What actually changes is the repository the client spawns commands in, and everything read from
   * it. Opening the lead repository as a folder is still available, as its own action, because
   * editing the code in it is a different intention from working in it.
   */
  type SelectedWorkspace = {
    workspaceId: string;
    workspaceName: string;
    repositoryId: string | null;
    repositoryPath: string;
    workspacePath: string;
  };
  const workspaceSelected: Array<(selected: SelectedWorkspace) => void | Promise<void>> = [];

  async function selectWorkspace(
    target: string, leadPath: string, name: string, repositoryId?: string
  ): Promise<boolean> {
    try {
      const chooser = new SingularityFlowClient({
        location: resolveCli({ extensionPath: context.extensionPath }),
        repository: process.cwd(),
        onOutput: (text) => output.append(text)
      });
      const selected = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Working in ${name}${repositoryId ? ` · ${repositoryId}` : ''}` },
        // Recorded machine-wide by the CLI, so the terminal and the editor agree about where you are.
        () => chooser.run<{
          workspaceId?: string; workspaceName?: string; repositoryId?: string;
          repositoryPath?: string; repositoryState?: string; workspacePath?: string;
        }>(['workspace', 'use', target, ...(repositoryId ? ['--repository', repositoryId] : []), '--json'])
      );
      const selection: SelectedWorkspace = {
        workspaceId: selected.workspaceId ?? target,
        workspaceName: selected.workspaceName ?? name,
        repositoryId: selected.repositoryId ?? null,
        repositoryPath: selected.repositoryPath ?? leadPath,
        workspacePath: selected.workspacePath ?? target
      };
      await refreshWorkspaceTree();
      // The Workspaces page is retained when hidden and owns its own row snapshot. Refresh it from
      // the same machine-wide registry before any other screen follows the new repository, so the
      // old workspace cannot remain labelled active beside a Navigator that already moved on.
      const { WorkspacesPanel } = await import('./views/workspaces-panel.ts');
      await WorkspacesPanel.activeWorkspaceChanged(target);
      // When activation began without a selected workspace, Lifecycle and Configuration were
      // registered with their honest empty-state providers and the repository services below were
      // never created. Reload this same window once so extension activation can bind those views to
      // the newly selected lead repository. This is not "Open workspace" and never creates another
      // VS Code window.
      if (!workspaceSelected.length) {
        void vscode.window.showInformationMessage(
          `${name} selected. Loading its Lifecycle and Configuration in this window.`);
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
        return true;
      }
      for (const follow of workspaceSelected) await follow(selection);
      return true;
    } catch (error) {
      showRefusal(error, { headline: 'Could not switch workspace' });
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
          return void vscode.window.showWarningMessage(
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
          void vscode.window.showWarningMessage('Choose a workspace before selecting one of its repositories.');
          return false;
        }
        const status = await chooser.run<WorkspaceStatus>(
          ['workspace', 'status', current.workspacePath, '--json']);
        const ready = status.repositories.filter((repository) =>
          Boolean(repository.id) && (!repository.state || repository.state === 'ready'));
        if (!ready.length) {
          void vscode.window.showWarningMessage(
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
          void vscode.window.showWarningMessage(
            `Repository '${repositoryId}' is not a ready member of ${current.workspaceName ?? current.workspaceId}.`);
          return false;
        }
        if (repositoryId === current.repositoryId) return true;
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
   * Separate from selecting it, and deliberately so: this one costs you the window. It is for going
   * to edit the code, not for choosing what the governed screens act on.
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
      const open = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (open && path.resolve(open) === path.resolve(chosen.lead)) {
        return void vscode.window.showInformationMessage(`${chosen.name} is already open in this window.`);
      }
      // The built-in command takes a boolean as its second argument. Passing an object made that
      // object truthy on versions implementing the documented signature, which opened an unwanted
      // second window. `false` means replace this window everywhere.
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(chosen.lead), false);
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
        void vscode.window.showInformationMessage(
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
        return void vscode.window.showWarningMessage('Select a workspace before repairing it.');
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Repairing ${current.workspaceName ?? 'workspace'}` },
        () => client.run(['workspace', 'repair', current.workspacePath as string, '--json'])
      );
      // Refresh the persisted context so the next activation sees the repaired repository as ready.
      await client.run(['workspace', 'use', current.workspacePath, '--json']);
      void vscode.window.showInformationMessage(
        `${current.workspaceName ?? 'Workspace'} repaired. Reloading Lifecycle, Inbox, and Configuration.`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error, { headline: 'Could not repair workspace' });
    }
  }));

  // The workspace list is part of the activation read model, not a background decoration. Await it
  // so a selected-but-unmaterialized workspace cannot briefly render as "No workspaces yet" (and
  // so commands/context menus are derived from the same registry revision as Lifecycle).
  await refreshWorkspaceTree();

  // A new VSIX can carry a newer workflow/agent contract while every saved workspace still points
  // at its older approved configuration. Offer one visible route per installed build; do not start
  // remote Git reads until the contributor chooses it. The build stamp is used because development
  // reinstalls intentionally keep the same extension version.
  const loadedBuild = typeof __SFLOW_BUILD__ === 'string' ? __SFLOW_BUILD__ : 'unstamped';
  const upgradeOfferKey = 'singularityFlow.workspaceUpgradeOfferedBuild';
  if (loadedBuild !== 'unstamped' && workspaceEntries.some((entry) => !entry.archivedAt)
    && context.globalState.get<string>(upgradeOfferKey) !== loadedBuild) {
    await context.globalState.update(upgradeOfferKey, loadedBuild);
    void vscode.window.showInformationMessage(
      'A new Singularity Flow build is installed. Review capability, workspace, and governed-agent updates?',
      'Review upgrades'
    ).then((choice) => choice === 'Review upgrades'
      ? vscode.commands.executeCommand('singularityFlow.upgradeWorkspaces') : undefined);
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
  // machine-local status record. Governed Git data and credentials are never copied into it.
  const firstRunHealthKey = 'singularityFlow.firstRunHealth.v1';
  const existingFirstRunHealth = context.globalState.get<{ status?: string } | null>(firstRunHealthKey, null);
  let firstRunBlocked = existingFirstRunHealth?.status === 'blocked';
  if (vscode.env?.appHost && (!existingFirstRunHealth || firstRunBlocked)) {
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
  }
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
      const { DiagnosticsPanel } = await import('./views/diagnostics.ts');
      DiagnosticsPanel.show(context, diagnosticClient, () => diagnosticHasRepository);
    } catch (error) {
      showRefusal(error, { headline: 'Could not open Diagnostics' });
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openDiagnostics', openDiagnostics));
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.doctor', openDiagnostics));

  const resetClient = new SingularityFlowClient({
    location: surfaceLocation, repository: os.tmpdir(), environment: cliEnvironment,
    onOutput: (text) => output.append(text)
  });
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.openLocalReset', async () => {
    try {
      const { LocalResetPanel } = await import('./views/local-reset.ts');
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
        await vscode.window.showWarningMessage(
          `Return to ${plan.workId} cannot be applied safely.`, { modal: true, detail }, 'Open Source Control'
        ).then(async (choice) => {
          if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
        });
        return;
      }
      const approved = await vscode.window.showInformationMessage(
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
      const next = await vscode.window.showInformationMessage(
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
    const target = vscode.workspace.workspaceFolders?.[0];
    if (!target) return;
    const confirmed = await vscode.window.showWarningMessage(
      'Initialize Singularity Flow in this repository?',
      { modal: true, detail: `This writes singularity/ into ${target.uri.fsPath} and commits it.` },
      'Initialize');
    if (confirmed !== 'Initialize') return;
    try {
      const location = resolveCli({ extensionPath: context.extensionPath });
      await new SingularityFlowClient({ location, repository: target.uri.fsPath, onOutput: (text) => output.append(text) })
        .runText(['init']);
      // The extension host has to reload: activation already decided this was not a Flow repository.
      const reload = await vscode.window.showInformationMessage(
        'Singularity Flow initialized. Reload the window to open it?', 'Reload');
      if (reload === 'Reload') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error);
    }
  }));

  // Version 1 is deliberately not migrated. This is the editor equivalent of /sf-factory-reset:
  // the engine creates the preview and owns the mutation, while VS Code only presents the exact
  // confirmation to the person. Registered before repository activation succeeds so the action is
  // still available in the incompatible-workflow state it exists to repair.
  context.subscriptions.push(vscode.commands.registerCommand('singularityFlow.reinitialize', async () => {
    try {
      const target = await resolveGovernedRepository(context, output);
      if ('reason' in target) {
        return void vscode.window.showWarningMessage(`Singularity Flow: ${target.reason}`);
      }
      const settings = vscode.workspace.getConfiguration('singularityFlow');
      const location = resolveCli({
        configuredCli: settings.get<string>('cliPath'),
        configuredNode: settings.get<string>('nodePath'),
        extensionPath: context.extensionPath
      });
      const client = new SingularityFlowClient({
        location, repository: target.repository, environment: cliEnvironment,
        onOutput: (text) => output.append(text)
      });
      const plan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Preparing the workflow v2 reset preview' },
        () => client.run<FactoryResetPlan>(['factory-reset', '--dry-run', '--json'])
      );
      if (plan.uncommittedResetPaths.length) {
        return void vscode.window.showWarningMessage(
          'Reset cannot continue because governed files have uncommitted changes. Commit or stash them first. '
          + 'Use the CLI with --allow-dirty only when you deliberately want to discard them.'
        );
      }
      const review = await vscode.window.showWarningMessage(
        'Reset and reinitialize this repository with workflow v2?',
        {
          modal: true,
          detail: `Repository: ${plan.repository}\nBranch: ${plan.branch ?? 'detached'}\n\n`
            + `Remove: ${plan.remove.join('; ')}\n\nReplace: ${plan.replace.join('; ')}\n\n`
            + 'Application source and Git history are preserved. The replacement remains uncommitted for review.'
        },
        'Reset and reinitialize'
      );
      if (review !== 'Reset and reinitialize') return;
      const confirmation = await vscode.window.showInputBox({
        title: 'Confirm repository reset',
        prompt: `Type exactly: ${plan.confirmation}`,
        placeHolder: plan.confirmation,
        ignoreFocusOut: true,
        validateInput: (value) => value === plan.confirmation ? null : 'The confirmation does not match the reset preview.'
      });
      if (confirmation !== plan.confirmation) return;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Installing Singularity Flow workflow v2' },
        async () => {
          await client.run(['factory-reset', '--confirm', confirmation, '--json']);
          await client.run(['init', '--check', '--json']);
        }
      );
      const next = await vscode.window.showInformationMessage(
        'Workflow v2 is installed locally. Review and commit the generated singularity/ files, then publish the configuration through your normal review path.',
        'Open Source Control', 'Reload Window'
      );
      if (next === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      else if (next === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      showRefusal(error, { headline: 'Could not reset and reinitialize the repository' });
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
    return unavailable(resolved.label, resolved.reason, resolved.contextValue, resolved.lead);
  }
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
      environment: cliEnvironment,
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
    environment: cliEnvironment,
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
   * `workspaceState` rather than `globalState` for the same reason.
   *
   * A read that throws — a payload written by an older build, a shape that no longer parses — is
   * treated as no cache at all. A stale-cache bug must degrade to today's behaviour, never to a
   * broken sidebar.
   */
  // `repository` is deliberately rebound by workspace selection. Resolve the key at each access so
  // a window that moves A -> B -> A never reads or overwrites another repository's last snapshot.
  const snapshotCacheKey = (): string => `snapshot:${repository}`;
  const snapshotCache = {
    read: (): RepositorySnapshot | null => {
      try { return context.workspaceState.get<RepositorySnapshot>(snapshotCacheKey()) ?? null; }
      catch { return null; }
    },
    write: (snapshot: RepositorySnapshot): void => {
      void context.workspaceState.update(snapshotCacheKey(), snapshot);
    }
  };

  const store = new WorkspaceStore(client, snapshotCache);
  currentHelpWork = () => {
    const item = store.current.snapshot?.workflow?.workItem;
    return item?.id ? { id: item.id, kind: item.workType ?? null } : null;
  };
  context.subscriptions.push(store);
  // Only two states are worth a line of UI. `stale` is the one that matters — content restored from
  // the last session and not yet confirmed. A plain refresh over content already known to be current
  // says nothing: the tree is right, it is simply being re-checked.
  context.subscriptions.push(store.onDidChange((state) => {
    sidebar.setFreshness(state.stale ? 'Showing the last known state — checking the repository…' : null);
    /**
     * The first read specifically, which is the one with nothing behind it.
     *
     * `primeFromCache` covers every open after the first, but the first open of a repository — and
     * every open after the cache is dropped — still has an empty store while the CLI is spawning,
     * and the sections were filling that gap with their "nothing to do" sentences.
     */
    sidebar.setAwaitingFirstRead(state.loading && !state.snapshot);
  }));
  interface WorkspaceLogsSummary {
    entries: Array<{ timestamp: string | null; severity: string }>;
    total: number;
    warnings: string[];
  }
  const refreshWorkspaceLogsTree = async (): Promise<void> => {
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
  let repositoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const repositoryWatcherFence = new RevisionSliceWatcherFence(() => repository);
  const armRepositoryRefresh = (): void => {
    if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    repositoryRefreshTimer = setTimeout(() => {
      repositoryRefreshTimer = null;
      const batch = repositoryWatcherFence.capture();
      void (async () => {
        if (await repositoryWatcherFence.matchesDelayedEcho(batch, () => client.revisionProbe())) return;
        repositoryWatcherFence.clearDelayedEcho();
        await store.refresh();
      })();
    }, REPOSITORY_REFRESH_DEBOUNCE_MS);
  };
  const scheduleRepositoryRefresh = (uri?: vscode.Uri): void => {
    repositoryWatcherFence.observe(uri?.fsPath);
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
  // Deliberately still only `singularity/**`. A disturbance from outside it — an autosave, a build —
  // is handled where it belongs, by the store retrying a transient failure, and not by watching the
  // whole tree: a recursive watcher would traverse `node_modules`, and refreshing the entire read
  // model on every keystroke-adjacent save would spawn a CLI process each time.
  const watchGovernedRepository = (target: string): void => {
    repositoryWatcher?.dispose();
    if (repositoryRefreshTimer) {
      clearTimeout(repositoryRefreshTimer);
      repositoryRefreshTimer = null;
    }
    repositoryWatcherFence.reset();
    repositoryWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(target), 'singularity/**/*')
    );
    context.subscriptions.push(
      repositoryWatcher.onDidCreate(scheduleRepositoryRefresh),
      repositoryWatcher.onDidChange(scheduleRepositoryRefresh),
      repositoryWatcher.onDidDelete(scheduleRepositoryRefresh)
    );
  };
  watchGovernedRepository(repository);
  context.subscriptions.push({
    dispose: () => {
      repositoryWatcher?.dispose();
      if (repositoryRefreshTimer) clearTimeout(repositoryRefreshTimer);
    }
  });
  // Capability readiness is remote-derived status (state branch and world-model availability), not
  // configuration. Read it after the local snapshot so Configuration renders immediately and then
  // gains the remote status without delaying activation when VPN access is unavailable.
  let readiness: CapabilityReadiness = {};
  let configurationTree: LifecycleTreeProvider | null = null;
  const refreshReadiness = async (force = false): Promise<void> => {
    const scope = repositoryEpoch.capture();
    try {
      const leads = await client.run<{ url?: string }[]>(['capability', 'leads', '--json']);
      if (!repositoryEpoch.isCurrent(scope)) return;
      const url = leads.find((lead) => lead.url)?.url;
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
  const inboxTree = new LifecycleTreeProvider(store, [], buildInboxTree);
  configurationTree = new LifecycleTreeProvider(
    store, [], (snapshot, error) => buildConfigurationTree(snapshot, error, readiness));
  context.subscriptions.push(tree, inboxTree, configurationTree);
  sidebar.bind('lifecycle', tree);
  sidebar.bind('inbox', inboxTree);
  sidebar.bind('configuration', configurationTree);
  // Readiness may touch a remote and logs load a second legacy CLI process. Neither may compete
  // with the initial snapshot that establishes which repository and Story this window represents.
  // A failed initial read leaves these deferred; the first later confirmed snapshot starts them.
  let initialRefreshCompleted = false;
  let auxiliaryEpoch = -1;
  const startAuxiliaryReadsAfterConfirmedSnapshot = (forceReadiness = false): void => {
    const state = store.current;
    if (!initialRefreshCompleted || state.stale || state.error || !state.snapshot) return;
    const scope = repositoryEpoch.capture();
    if (!forceReadiness && auxiliaryEpoch === scope.epoch) return;
    auxiliaryEpoch = scope.epoch;
    void refreshReadiness(forceReadiness);
    void refreshWorkspaceLogsTree();
  };
  context.subscriptions.push(store.onDidChange((state, change) => {
    if (change.kind !== 'snapshot' || state.stale || state.error || !state.snapshot) return;
    startAuxiliaryReadsAfterConfirmedSnapshot();
  }));

  /**
   * The readiness gates for one work item, or null when they cannot be read.
   *
   * Null rather than zeros: "no gates" and "we could not ask" are different facts, and a status bar
   * that renders `gates 0/0` on a failed read is asserting the first while meaning the second.
   */
  const gateCountFor = async (workId: string, scope: RepositoryEpochToken) => {
    if (!repositoryEpoch.isCurrent(scope)) return null;
    const active = activeRepositoryContext();
    if (!active || path.resolve(active.root) !== scope.repository) return null;
    try {
      const { kernel } = gatewaySession(active);
      // The registered phrase, not a word that looks like the operation's name.
      const resolution = await kernel.resolve({ utterance: 'am I ready', arguments: { workId } });
      if (!repositoryEpoch.isCurrent(scope)) return null;
      if (resolution.kind !== 'read' || resolution.next.length !== 1) return null;
      const gates = gateSummary(await kernel.read({ resolutionId: resolution.next[0].handle }));
      if (!repositoryEpoch.isCurrent(scope)) return null;
      return gates;
    } catch {
      return null;
    }
  };

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
  const homeChromeFor = async (scope: RepositoryEpochToken) => {
    if (!repositoryEpoch.isCurrent(scope)) return null;
    const active = activeRepositoryContext();
    if (!active || path.resolve(active.root) !== scope.repository) return null;
    try {
      const { kernel } = gatewaySession(active);
      const resolution = await kernel.resolve({ utterance: 'home' });
      if (!repositoryEpoch.isCurrent(scope)) return null;
      if (resolution.kind !== 'read' || resolution.next.length !== 1) return null;
      const envelope = await kernel.read({ resolutionId: resolution.next[0].handle });
      if (!repositoryEpoch.isCurrent(scope)) return null;
      const recovery = (envelope.why ?? []).find((entry: { code: string }) => entry.code === 'home.recovery-required');
      const { primaryAction } = await import('../../../src/gateway/result.mjs');
      if (!repositoryEpoch.isCurrent(scope)) return null;
      return {
        recoveryWorkId: recovery?.slots?.work ?? null,
        decisions: Number(envelope.data?.needsYourDecision ?? 0),
        /** The one filled button on the card, so the chrome names the same next step. */
        leads: primaryAction(envelope)?.label ?? null
      };
    } catch {
      return null;
    }
  };

  /** Which Story the status bar is currently about, so a late gate count can be discarded. */
  let statusWorkId: string | null = null;

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
  context.subscriptions.push(store.onDidChange((state) => {
    if (state.loading) { status.text = '$(loading~spin) Singularity Flow'; status.show(); return; }
    if (state.error) { status.text = '$(error) Singularity Flow'; status.tooltip = state.error.message; status.show(); return; }
    const initiative = state.snapshot?.initiative;
    const workflow = state.snapshot?.workflow;
    const where = workspaceLabel ? `${workspaceLabel} · ` : '';
    if (workflow) {
      const phase = workflow.currentPhase ?? 'complete';
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
      void gateCountFor(renderedFor, renderedScope).then((gates) => {
        // Discard a count that arrived after the reader moved on: a gate total from the previous
        // Story rendered beside the current one is worse than no count at all.
        if (!gates || statusWorkId !== renderedFor || !repositoryEpoch.isCurrent(renderedScope)) return;
        status.text = `$(git-pull-request) ${workflow.workItem.id} · ${phase} · gates ${gates.met}/${gates.total}`;
        status.tooltip = `${where}${workflow.workItem.title ?? 'Governed Story workflow'}`
          + `\n${gates.unmet} unmet, ${gates.outstanding - gates.unmet} not evaluated`;
      });
      /**
       * The home's two obligations, layered over the Story line. `[UXH:AC-002]` `[DHR:REQ-070]`
       *
       * Same fire-and-forget discipline as the gate count, and the same staleness guard: a fact
       * about the previous Story rendered beside the current one is worse than none.
       *
       * Recovery replaces the text rather than appending to it. Rule 1 exists because a
       * half-finished publication is the state where doing anything else first can lose work, and
       * appending it to "WRK-1978 · implement" would put it at the same weight as the phase name.
       */
      void homeChromeFor(renderedScope).then((home) => {
        if (!home || !repositoryEpoch.isCurrent(renderedScope) || statusWorkId !== renderedFor) return;
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
      void homeChromeFor(renderedScope).then((home) => {
        if (!home?.decisions || !repositoryEpoch.isCurrent(renderedScope) || statusWorkId !== null) return;
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
    try {
      canonicalTarget = await validateRepositoryDirectory(target, { signal: extensionLifetime.signal });
    } catch (error) {
      void vscode.window.showWarningMessage(
        `${selected.workspaceName} is recorded as your workspace, but this window is still acting on ${path.basename(repository)}: ${(error as Error).message}`);
      return;
    }
    repositoryEpoch.moved(canonicalTarget);
    repository = canonicalTarget;
    resultPanelRepositoryChanged(canonicalTarget);
    client.useRepository(canonicalTarget);
    watchGovernedRepository(canonicalTarget);
    workspaceLabel = selected.workspaceName;
    lastHome = null;
    setActiveRepositoryContext({
      root: canonicalTarget,
      workspaceId: selected.workspaceId,
      workspaceName: selected.workspaceName,
      repositoryId: selected.repositoryId,
      leadRepositoryPath: await workspaceLeadDirectory(selected.workspacePath) ?? canonicalTarget,
      origin: `the selected repository of your active workspace, ${selected.workspaceName}`
    });
    readiness = {};
    statusWorkId = null;
    // Publish B's cache only after every repository-aware closure points at B. Store listeners may
    // render synchronously; none of them may observe B data through A's gateway/session context.
    store.repositoryChanged();
    await store.refresh();
    diagnosticHasRepository = true;
    diagnosticClient.useRepository(canonicalTarget);
    const [{ GoalsPanel }, { FaultRepairsPanel }, { JournalPanel }, { DiagnosticsPanel }, { AstIntelligencePanel }] = await Promise.all([
      import('./views/goals.ts'), import('./views/fault-repairs.ts'), import('./views/journal.ts'), import('./views/diagnostics.ts'), import('./views/ast-intelligence.ts')
    ]);
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
  let selectionReconciliation: Promise<boolean> | null = null;
  const reconcileActiveWorkspaceSelection = async (): Promise<boolean> => {
    if (selectionReconciliation) return selectionReconciliation;
    const reconciliation = (async (): Promise<boolean> => {
      try {
        const current = await activeSelectionClient.run<{
          active?: boolean; workspaceId?: string; workspaceName?: string; workspacePath?: string;
          repositoryId?: string; repositoryPath?: string; repositoryState?: string;
          selectionStatus?: string; storyId?: string | null;
        }>(['workspace', 'current', '--json']);
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
        const { WorkspacesPanel } = await import('./views/workspaces-panel.ts');
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

  const ACTIVE_SELECTION_REFRESH_DEBOUNCE_MS = 250;
  const activeSelectionFile = path.resolve(process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(os.homedir(), '.singularity-flow', 'active-workspace.json'));
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
    const argv = await resolvePlaceholders(node.command, repository);
    if (!argv) return;
    if (argv[0] === 'phase' && argv[1] === 'publish') {
      const workflow = store.current.snapshot?.workflow;
      const checkoutIssue = storyCheckoutIssue(repository, store.current.snapshot, workflow);
      if (checkoutIssue) {
        const choice = await vscode.window.showWarningMessage(
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
        const choice = await vscode.window.showWarningMessage(
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
          void vscode.window.showWarningMessage(
            `Publication stopped because ${remaining.length} repository file${remaining.length === 1 ? ' is' : 's are'} still unsaved.`
          );
          return;
        }
      }
    }
    // Session attachment can resolve to a managed Story worktree. Refreshing the launch clone after
    // that succeeds leaves every view on the previous Story and discards the most important field
    // in the command result: `repositoryPath`. Run this one selection operation as JSON, then move
    // the window to the checkout the engine proved. The CLI still owns fetching and validation.
    if (argv[0] === 'session' && argv[1] === 'attach') {
      try {
        const args = argv.includes('--json') ? argv : [...argv, '--json'];
        const attached = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Attaching ${argv[2] ?? 'Story'}…` },
          () => client.run<{
            workId?: string; repositoryPath?: string; branch?: string; phase?: string; status?: string;
          }>(args)
        );
        const checkout = attached.repositoryPath ? path.resolve(attached.repositoryPath) : null;
        if (!checkout) {
          showRefusal('Story attachment completed without a repositoryPath.', {
            headline: 'Could not open the selected Story checkout'
          });
          return;
        }
        if (checkout !== path.resolve(repository)) {
          void vscode.window.showInformationMessage(
            `Story ${attached.workId ?? argv[2]} is ready in its isolated checkout. Opening it now.`
          );
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(checkout), false);
          return;
        }
        await refreshAfterKnownMutation();
      } catch (error) {
        output.appendLine(`Story attachment failed: ${(error as Error).message}`);
        showRefusal(error, { headline: `Could not attach Story ${argv[2] ?? ''}`.trim() });
      }
      return;
    }
    const ran = await runGovernedAction(client, {
      command: argv,
      title: node.confirmation?.summary ?? `singularity-flow ${argv.join(' ')}`,
      ...(node.confirmation ? { confirmation: node.confirmation } : {})
    }, output);
    if (ran) await refreshAfterKnownMutation();
  };

  /** Named Story commands work both from a phase row and directly from the command palette. */
  const runStoryPhase = async (
    action: 'prepare' | 'publish' | 'submit', node?: TreeNode
  ): Promise<void> => {
    if (node?.command) return runNode(node);
    const workflow = store.current.snapshot?.workflow;
    const phaseId = workflow?.currentPhase;
    if (!workflow || !phaseId) {
      void vscode.window.showWarningMessage('No governed Story phase is active in this workspace.');
      return;
    }
    const command = action === 'prepare'
      ? ['prepare', phaseId]
      : action === 'publish'
        ? ['phase', 'publish', phaseId]
        : ['submit', '--phase', phaseId];
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

  const onJourneyMessage = async (message: JourneyMessage): Promise<void> => {
    if (message.type === 'pin') return addSource();
    if (message.type === 'run') {
      const next = store.current.snapshot?.initiative?.nextActions?.[0];
      if (!next) return;
      return runNode({
        kind: 'action', id: 'next', label: next.reason,
        command: commandArgv(next.command)
      });
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
    // Refresh before asking anything. `start` refuses a dirty tree, and discovering that only after
    // somebody completes the intake form wastes their answers and makes a correct guard look like a
    // dead button. The target is stated here because a selected workspace may point this window at
    // a lead repository other than the folder visible in the title bar.
    // Loading a new slice already performs a fresh snapshot. Calling refresh unconditionally after
    // it made the first Start Work click pay for the same repository scan twice; only an already
    // loaded configuration needs the explicit freshness read below.
    const refreshedForConfiguration = await store.ensureSlices(['configuration']);
    if (!refreshedForConfiguration) await store.refresh();
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
      const open = await vscode.window.showWarningMessage(
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
          void vscode.window.showInformationMessage(
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

    // Checked before anything is asked. The engine refuses to start governed work when no approval
    // authority has a member, and discovering that after a filled-in form — with a message naming a
    // YAML key — is a poor greeting for someone who has just initialized a repository.
    const authorities = store.current.snapshot?.portfolio?.approvalAuthorities ?? {};
    const named = Object.entries(authorities).filter(([, authority]) => (authority?.members ?? []).length);
    if (Object.keys(authorities).length && !named.length) {
      const open = await vscode.window.showWarningMessage(
        'No approval authority has a member yet, so governed work cannot be started.',
        { modal: true, detail: 'Add at least one person in People & approvals. Every governed approval is checked against the configured Git or GitHub identity.' },
        'Open People & approvals');
      if (open === 'Open People & approvals') await vscode.commands.executeCommand('singularityFlow.configurePeople');
      return;
    }

    // One screen for six paths. An Initiative, an Epic or a Story, each with or without a tracker,
    // used to be six commands you had to already know the names of — which meant the product's front
    // door was documentation rather than a screen.
    const { IntakePanel, intakeInFlight } = await import('./views/intake-panel.ts');
    IntakePanel.show(context, client, output, async (started) => {
      if (defaults.guidedStart) await context.globalState.update(START_WIZARD_KEY, undefined);
      if (started.shape === 'story' && started.repositoryPath
          && path.resolve(started.repositoryPath) !== path.resolve(repository)) {
        void vscode.window.showInformationMessage(
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
      const open = await vscode.window.showInformationMessage(
        `${subject} ${started.id} started.${next}`, 'Continue safely', 'Open the journey', 'Show status');
      if (open === 'Continue safely') await vscode.commands.executeCommand('singularityFlow.continueSafely');
      else if (open === 'Open the journey') await vscode.commands.executeCommand('singularityFlow.openJourney');
      else if (open === 'Show status') await vscode.commands.executeCommand('singularityFlow.openDashboard');
    }, {
      workspace: workspaceLabel,
      repository: repositoryState?.root ?? repository,
      branch: repositoryState?.branch ?? null,
      // Start Work already refreshed the Store's core lifecycle slice. Re-project those exact bytes
      // instead of spawning a second full `snapshot --json` process inside the panel.
      inFlight: intakeInFlight(store.current.snapshot),
      defaults,
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
      void vscode.window.showWarningMessage(
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
    }], { title: `Attach evidence to ${target.label}`, placeHolder: 'Choose the source type' });
    if (!source) return;

    let input: Parameters<typeof evidenceCommands>[1] | null = null;
    if (source.value === 'files') {
      const picked = await vscode.window.showOpenDialog({
        title: `Attach files to ${target.label}`,
        openLabel: 'Attach selected files',
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: {
          'Evidence and designs': ['md', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'json', 'yaml', 'yml', 'csv', 'xlsx', 'docx', 'pptx'],
          'All files': ['*']
        }
      });
      if (!picked?.length) return;
      input = { kind: 'files', paths: picked.map((entry) => entry.fsPath) };
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
        void vscode.window.showWarningMessage('The selected Figma export folder contains no files. Nothing was attached.');
        return;
      }
      input = { kind: 'figma-export', paths };
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
        title: 'Evidence label',
        value: figmaOnly ? 'Figma design' : '',
        prompt: 'Use a name reviewers will recognize.',
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? null : 'A label is required.'
      });
      if (!label?.trim()) return;
      input = { kind: 'url', url: url.trim(), label: label.trim() };
    }

    const commands = evidenceCommands(target, input);
    const summary = input.kind === 'url'
      ? input.label
      : `${input.paths.length} ${input.paths.length === 1 ? 'path' : 'paths'}`;
    const confirmation = await vscode.window.showInformationMessage(
      `Attach ${summary} to ${target.label}? The governed record will be committed and pushed.`,
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
    void vscode.window.showInformationMessage(
      `Attached ${summary} to ${target.label}. Open Lifecycle to review the governed IDs and artifacts.`);
  };

  const openEvidence = async (item: EvidenceCatalogItem): Promise<void> => {
    if (item.url) {
      await vscode.env.openExternal(vscode.Uri.parse(item.url));
      return;
    }
    if (!item.path) {
      void vscode.window.showInformationMessage(
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
    await openArtifact(client.repository, {
      kind: 'source', id: `evidence:${item.target.kind}:${item.id}`,
      label: item.label, path: item.path, readOnly: item.status === 'detached'
    });
  };

  const detachEvidenceItem = async (item: EvidenceCatalogItem): Promise<void> => {
    if (item.status === 'detached') {
      void vscode.window.showInformationMessage(`${item.id} is already detached. Its committed evidence remains read-only.`);
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
    const confirmed = await vscode.window.showWarningMessage(
      `Detach ${target}?`,
      {
        modal: true,
        detail: 'Committed bytes and audit history will be preserved. The evidence will be omitted from future Copilot prompts. Any phase and approval that depended on it will be invalidated and the earliest dependent phase reopened.'
      },
      'Detach evidence'
    );
    if (confirmed !== 'Detach evidence') return;

    const command = evidenceDetachCommand(item, scope, reason.trim());
    output.appendLine(`\n$ singularity-flow ${command.join(' ')}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Detaching ${target}`, cancellable: false },
        () => client.runText(command)
      );
      output.appendLine(result.trim());
      await refreshAfterKnownMutation();
      const meaningful = result.split(/\r?\n/).filter((line) =>
        /^(Commit|Invalidated phases|Reopened phase|Next in Copilot|Run|In Copilot):/.test(line));
      const action = await vscode.window.showInformationMessage(
        `Detached ${target}. ${meaningful.slice(0, 2).join(' · ') || 'The decision was committed through the governed publication transaction.'}`,
        'Show complete result'
      );
      if (action === 'Show complete result') output.show(true);
    } catch (error) {
      output.appendLine(`  refused: ${(error as Error).message}`);
      showRefusal(error, { headline: 'Could not detach ${target}' });
    }
  };

  const resolveEvidenceNode = (node?: TreeNode): EvidenceCatalogItem | undefined => {
    if (!node?.evidence) return undefined;
    return evidenceCatalog(store.current.snapshot).find((item) =>
      item.target.kind === node.evidence?.ownerKind
      && item.target.id === node.evidence.ownerId
      && item.id === node.evidence.evidenceId);
  };

  const manageEvidence = async (): Promise<void> => {
    const { EvidenceManagerPanel } = await import('./views/evidence-manager.ts');
    EvidenceManagerPanel.show(store, {
      attach: collectEvidence,
      open: openEvidence,
      detach: detachEvidenceItem
    });
  };

  const detachEvidence = async (node?: TreeNode): Promise<void> => {
    const direct = resolveEvidenceNode(node);
    if (direct) return detachEvidenceItem(direct);
    const active = evidenceCatalog(store.current.snapshot).filter((item) => item.status === 'active');
    if (!active.length) {
      void vscode.window.showInformationMessage('No active governed evidence is available to detach.');
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
    if (message.type === 'attach-story') {
      return runNode({
        kind: 'story', id: `inbox:active-story:${message.workId}`, label: message.workId,
        command: ['session', 'attach', message.workId]
      });
    }
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
    const { CapabilitiesPanel } = await import('./views/capabilities.ts');
    const panel = await CapabilitiesPanel.show(context, store, (next) => { void onCapabilitiesMessage(next); });
    if (message.type === 'review-proposals') {
      await vscode.commands.executeCommand('singularityFlow.reviewCapabilityProposals');
      return;
    }
    if (message.type === 'remove') {
      const destination = message.reparentChildrenTo == null
        ? 'the top level'
        : message.reparentChildrenTo;
      const confirmed = await vscode.window.showWarningMessage(
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
      const leads = await client.run<Array<{ url?: string }>>(['capability', 'leads', '--json']);
      const available = leads.filter((entry): entry is { url: string } =>
        typeof entry.url === 'string' && entry.url.length > 0);
      if (!available.length) {
        throw new Error('No organisation lead repository is registered. Map the first capability before editing the organisation map.');
      }
      const selected = available.length === 1 ? available[0] : await vscode.window.showQuickPick(
        available.map((entry) => ({ label: entry.url, entry })), {
          title: 'Edit the governed capability map',
          placeHolder: 'Choose the lead repository whose sflow/config branch owns this map'
        }).then((choice) => choice?.entry);
      if (!selected) return;
      const mode = message.type === 'remove' ? 'remove' : 'set';
      const argv = capabilityProposalArgv(mode, message.id, selected.url,
        message.type === 'remove' ? {} : message.edits,
        message.type === 'remove'
          ? { reparentChildrenTo: message.reparentChildrenTo }
          : {});
      output.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
      const proposed = await client.run<{
        branch?: string | null; reviewRequired?: boolean; capabilityId?: string
      }>(argv);
      if (!proposed.reviewRequired || !proposed.branch) {
        await refreshAfterKnownMutation();
        panel.settled(message.type === 'remove' ? '' : message.id);
        return;
      }
      const run = async (command: string[]): Promise<{ result: unknown; error: string | null }> => {
        output.appendLine(`\n$ singularity-flow ${command.join(' ')}`);
        try { return { result: await client.run<unknown>(command), error: null }; }
        catch (error) {
          output.appendLine(`  failed: ${(error as Error).message}`);
          return { result: null, error: (error as Error).message };
        }
      };
      const { CapabilityProposalPanel } = await import('./views/capability-proposal.ts');
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

  const configurationMessage = async (message: ConfigurationCenterMessage): Promise<string | null> => {
    if (message.type === 'save') {
      output.appendLine(`\n$ singularity-flow configuration save ${message.path} --expected-sha256 ${message.expectedSha256}`);
      try {
        await client.runText(['configuration', 'save', message.path, '--expected-sha256', message.expectedSha256], { input: message.content });
        await refreshAfterKnownMutation();
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
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
      output.appendLine(`\n$ singularity-flow ${args.join(' ')}`);
      try {
        const result = await client.run<{
          changed: boolean; pushed: boolean; commit: string;
          groups: Array<{ id: string; scope: string }>;
          transportIntent?: string; transportStatus?: string;
          nextAction?: { command?: string } | null;
        }>(args);
        if (result.changed && !result.pushed) {
          return `Configuration commit ${result.commit.slice(0, 8)} is retained, but publication is ${result.transportStatus ?? 'pending'}. ${result.nextAction?.command ? `Run: ${result.nextAction.command}` : 'Open Push recovery to continue.'}`;
        }
        await refreshAfterKnownMutation();
        if (!result.changed) {
          void vscode.window.showInformationMessage('Your current Git identity already belongs to the selected approval groups.');
        } else {
          void vscode.window.showInformationMessage(
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
      const snapshot = store.current.snapshot;
      const listed = new Set<string>([
        ...(snapshot?.templates ?? []).map((entry) => entry.path),
        ...(snapshot?.prompts ?? snapshot?.agentPrompts ?? snapshot?.personaPrompts ?? []).map((entry) => entry.path),
        ...(snapshot?.repositorySkills ?? []).map((entry) => entry.path),
        ...(snapshot?.flowSkills ?? []).map((entry) => entry.packagePath ?? entry.path),
        ...(snapshot?.worldModel?.views ?? []).map((view) => `${snapshot?.worldModel?.root ?? 'singularity/world-model'}/views/${view.id}.md`)
      ]);
      if (!listed.has(message.path)) return `This repository no longer lists ${message.path}. Refresh and try again.`;
      const capturedWorldModelFile = snapshot?.worldModel?.files?.find((entry) => entry.path === message.path);
      if (typeof capturedWorldModelFile?.content === 'string') {
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
          content: capturedWorldModelFile.content,
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
          void vscode.window.showInformationMessage(
            `Opened a bounded ${page.bytes}-byte preview of ${selected.kind}:${selected.id}.`
          );
        }
        return null;
      } catch (error) {
        output.appendLine(`  world-model expansion refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
    }

    if (message.action === 'capabilities') await vscode.commands.executeCommand('singularityFlow.openCapabilities');
    else if (message.action === 'add-capability') await vscode.commands.executeCommand('singularityFlow.addCapability');
    else if (message.action === 'proposals') await vscode.commands.executeCommand('singularityFlow.reviewCapabilityProposals');
    else if (message.action === 'workflow') await vscode.commands.executeCommand('singularityFlow.openDesigner');
    else if (message.action === 'instructions') await vscode.commands.executeCommand('singularityFlow.openInstructionDesigner');
    else if (message.action === 'world-model') { await openConfigurationCenter('world-model'); return null; }
    else if (message.action === 'ast-intelligence') await vscode.commands.executeCommand('singularityFlow.configureAstIntelligence');
    else if (message.action === 'people') { await openConfigurationCenter('people'); return null; }
    else if (message.action === 'mcp') { await openConfigurationCenter('mcp'); return null; }
    else if (message.action === 'models') { await openConfigurationCenter('models'); return null; }
    else if (message.action === 'templates') { await openConfigurationCenter('templates'); return null; }
    // Absorbed from the Configuration sidebar section, which now only leads here.
    else if (message.action === 'publish-configuration') await vscode.commands.executeCommand('singularityFlow.publishConfiguration');
    else if (message.action === 'reset-jira') await vscode.commands.executeCommand('singularityFlow.resetJira');
    else if (message.action === 'open-designer') await vscode.commands.executeCommand('singularityFlow.openDesigner');
    else if (message.action === 'open-instruction-designer') await vscode.commands.executeCommand('singularityFlow.openInstructionDesigner');
    else if (message.action === 'open-specification-trace') await vscode.commands.executeCommand('singularityFlow.openSpecificationTrace');
    else if (message.action === 'open-flow-impact') await vscode.commands.executeCommand('singularityFlow.openFlowImpact');
    else if (message.action === 'open-copilot') await vscode.commands.executeCommand('singularityFlow.openCopilot');
    else if (message.action === 'open-prompt-audit') await vscode.commands.executeCommand('singularityFlow.openPromptAudit');
    else if (message.action === 'inspect-composition-cache') await vscode.commands.executeCommand('singularityFlow.inspectCompositionCache');
    else if (message.action === 'check-ledger-deployment') await vscode.commands.executeCommand('singularityFlow.checkLedgerDeployment');
    else if (message.action === 'open-impact-file') await openArtifact(client.repository, { kind: 'artifact', id: 'config:impact', label: 'impact.yml', path: 'singularity/impact.yml' });
    else if (message.action === 'build-world-model') {
      await vscode.commands.executeCommand('singularityFlow.buildWorldModel');
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
        void vscode.window.showInformationMessage(
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
        void vscode.window.showInformationMessage('Playwright MCP host configuration created. Review it, then trust and start it through VS Code MCP: List Servers.');
      } catch (error) {
        const detail = (error as Error).message;
        // A differing entry is not a terminal-only recovery exercise. Keep unrelated MCP servers,
        // show exactly what replacement means, and let the contributor make the same explicit
        // decision the CLI's --replace-server flag represents without leaving Configuration Center.
        if (!detail.includes('--replace-server')) return detail;
        const confirmed = await vscode.window.showWarningMessage(
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
          void vscode.window.showInformationMessage('Playwright MCP host entry replaced. Review it, then trust and start it through VS Code MCP: List Servers.');
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
    const { ConfigurationCenterPanel } = await import('./views/configuration-center.ts');
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

  const registered: Record<string, (...args: never[]) => unknown> = {
    'singularityFlow.openCapabilities':
      async () => {
        const { CapabilitiesPanel } = await import('./views/capabilities.ts');
        return CapabilitiesPanel.show(context, store, (message) => { void onCapabilitiesMessage(message); });
      },
    'singularityFlow.openImpact': async () => {
      const { ImpactPanel } = await import('./views/impact.ts');
      return ImpactPanel.show(context, store, client);
    },
    'singularityFlow.openFlowImpact': async () => {
      const { FlowImpactPanel } = await import('./views/flow-impact.ts');
      return FlowImpactPanel.show(context, store, client);
    },
    'singularityFlow.openStories':
      async () => {
        const { StoriesPanel } = await import('./views/stories.ts');
        return StoriesPanel.show(context, store, (message) => { void onStoriesMessage(message); });
      },
    'singularityFlow.openApprovals':
      async () => {
        const { ApprovalsPanel } = await import('./views/approvals.ts');
        return ApprovalsPanel.show(context, store, (message) => { void onApprovalsMessage(message); });
      },
    'singularityFlow.openInbox':
      async () => {
        const { InboxPanel } = await import('./views/inbox.ts');
        return InboxPanel.show(context, store, (message) => { void onInboxMessage(message); });
      },
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
          const selected = await vscode.window.showWarningMessage(
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
        const next = await vscode.window.showInformationMessage(
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
      const repositoryChanged = await reconcileActiveWorkspaceSelection();
      if (!repositoryChanged) await store.refresh();
      void refreshReadiness(true);
      void refreshWorkspaceLogsTree();
    },
    'singularityFlow.openArtifact':
      ((node?: TreeNode) => openArtifact(repository, node, cliPackageRoot)) as never,
    'singularityFlow.runAction': runNode as never,
    'singularityFlow.prepareStoryPhase': ((node?: TreeNode) => runStoryPhase('prepare', node)) as never,
    'singularityFlow.publishStoryPhase': ((node?: TreeNode) => runStoryPhase('publish', node)) as never,
    'singularityFlow.submitStoryPhase': ((node?: TreeNode) => runStoryPhase('submit', node)) as never,
    'singularityFlow.approve': runNode as never,
    'singularityFlow.openJourney': async () => {
      await reconcileActiveWorkspaceSelection();
      const { JourneyPanel } = await import('./views/journey.ts');
      return JourneyPanel.show(context, store, onJourneyMessage);
    },
    'singularityFlow.openCommandCenter': async () => {
      await reconcileActiveWorkspaceSelection();
      const { SgosCommandCenterPanel } = await import('./views/sgos-command-center.ts');
      return SgosCommandCenterPanel.show(context, store, client);
    },
    'singularityFlow.openReconciliation': async () => {
      const { ReconciliationPanel } = await import('./views/reconciliation.ts');
      return ReconciliationPanel.show(context, store, client);
    },
    'singularityFlow.showImpact': () => showImpact(client, output),
    'singularityFlow.openDashboard': async () => {
      const { DashboardPanel } = await import('./views/dashboard.ts');
      return DashboardPanel.show(context, store);
    },
    'singularityFlow.cancelWork': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow || workflow.status !== 'in_progress') {
        void vscode.window.showWarningMessage('Only active Story work can be cancelled.');
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
      const decision = await vscode.window.showWarningMessage(
        `Cancel ${workflow.workItem.id}? Its lifecycle will stop and it will move to Archived. Generated artifacts are preserved.`,
        { modal: true, detail: `Current phase: ${workflow.currentPhase ?? 'unknown'}\nReason: ${reason.trim()}` },
        'Cancel and archive'
      );
      if (decision !== 'Cancel and archive') return;
      try {
        await client.runText(['cancel', workflow.workItem.id, '--reason', reason.trim(), '--confirm', workflow.workItem.id]);
        await refreshAfterKnownMutation();
        void vscode.window.showInformationMessage(`${workflow.workItem.id} was cancelled and moved to Archived.`);
      } catch (error) {
        showRefusal(error, { headline: 'Could not cancel ${workflow.workItem.id}' });
      }
    },
    'singularityFlow.reopenCompleted': async () => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow || workflow.status !== 'complete') {
        void vscode.window.showWarningMessage('Only a completed Story can be reopened.');
        return;
      }
      const completion = workflow.phases[workflow.phaseOrder.at(-1) ?? ''];
      if (!completion) {
        showRefusal('The completed Story has no final phase policy, so there is nothing to reopen against.',
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
        void vscode.window.showInformationMessage(`${workflow.workItem.id} reopened at ${selected.phaseId}.`);
      } catch (error) {
        showRefusal(error, { headline: 'Could not reopen ${workflow.workItem.id}' });
      }
    },
    'singularityFlow.rollForwardRework': async (node?: TreeNode) => {
      const workflow = store.current.snapshot?.workflow;
      if (!workflow) {
        void vscode.window.showWarningMessage('No active Story has a rework checkpoint to restore.');
        return;
      }
      const requestId = node?.id.match(/^story:change-request:([^:]+):roll-forward$/)?.[1]
        ?? workflow.changeRequests?.filter((request) => request.status === 'open' && request.forwardCheckpoint).at(-1)?.id;
      if (!requestId) {
        void vscode.window.showWarningMessage('No open change request has a safe forward checkpoint.');
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
        const reviewed = await vscode.window.showInformationMessage(
          `Review the complete ${plan.paths.length}-path roll-forward preview before continuing.`,
          'Continue to confirmation'
        );
        if (reviewed !== 'Continue to confirmation') return;
        const choice = await vscode.window.showWarningMessage(
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
        void vscode.window.showInformationMessage(
          `${plan.workId} returned to ${result.phase ?? 'complete'} in ${result.commit.slice(0, 8)}. `
          + `${result.restoredPaths.length} path(s) were backed up locally and restored.`
        );
      } catch (error) {
        showRefusal(error, { headline: `Could not return ${workflow.workItem.id} forward` });
      }
    },
    'singularityFlow.openDesigner': async () => {
      const { DesignerPanel } = await import('./views/designer.ts');
      const reviewAndActivateWorkflowProposal = async (branch: string): Promise<string | null> => {
        try {
          const inspected = await client.run<{
            branch: string; proposalCommit: string; targetBranch: string; diff: string;
            valid: boolean; workflows?: Array<{ id: string; change: string }>;
          }>(['workflow', 'proposal', branch, '--json']);
          const document = await vscode.workspace.openTextDocument({
            language: 'diff', content: inspected.diff || 'No textual diff.'
          });
          await vscode.window.showTextDocument(document, { preview: true });
          if (!inspected.valid) {
            const message = 'The workflow proposal contains invalid or out-of-scope configuration changes.';
            showRefusal(message, { headline: 'Workflow proposal cannot be activated' });
            return message;
          }
          const merge = 'Merge exact proposal';
          const confirmed = await vscode.window.showWarningMessage(
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
            const accepted = await vscode.window.showWarningMessage(
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
            void vscode.window.showWarningMessage(message);
            return message;
          }
          await refreshAfterKnownMutation();
          void vscode.window.showInformationMessage(
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
      return DesignerPanel.show(context, store, async (message) => {
      if (message.type === 'open') {
        await openArtifact(repository, { kind: 'artifact', id: message.path, label: message.path, path: message.path });
        return null;
      }
      if (message.type === 'review-proposal') {
        return reviewAndActivateWorkflowProposal(message.branch);
      }
      // Authoring a lifecycle runs the same command the CLI runs, so the validation that refuses an
      // incoherent profile is one implementation rather than two that drift.
      if (message.type === 'run') {
        const command = [...message.command, '--propose', '--json'];
        output.appendLine(`\n$ singularity-flow ${command.join(' ')}`);
        try {
          const proposal = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: message.title,
            cancellable: false
          }, () => client.run<{
            branch?: string; commit?: string; files?: string[]; reviewRequired?: boolean;
            baseBranch?: string; nextAction?: string;
          }>(command));
          await refreshAfterKnownMutation();
          if (proposal.reviewRequired && proposal.branch) {
            const files = proposal.files?.length ?? 0;
            const review = 'Review and activate';
            const selected = await vscode.window.showInformationMessage(
              `Workflow proposal ${proposal.branch} was pushed with ${files} configuration file${files === 1 ? '' : 's'}. `
              + `It remains visible as Pending review until it is merged into ${proposal.baseBranch ?? 'sflow/config'}. `
              + 'The active Story was not changed.',
              review, 'Later'
            );
            if (selected === review) {
              return reviewAndActivateWorkflowProposal(proposal.branch);
            }
          } else {
            void vscode.window.showInformationMessage('The approved configuration already contains this workflow change.');
          }
          return null;
        } catch (error) {
          output.appendLine(`  refused: ${(error as Error).message}`);
          showRefusal(error, { headline: 'Could not create workflow configuration proposal' });
          return (error as Error).message;
        }
      }
      // Written through the engine, which validates before it writes — a template is governed
      // configuration like any other, and the editor does not get its own way past that.
      output.appendLine(`\n$ singularity-flow configuration save ${message.path} --propose --json`);
      try {
        const text = await client.runText(
          ['configuration', 'save', message.path, '--propose', '--json'],
          { input: message.content }
        );
        const proposal = JSON.parse(text) as {
          branch?: string; files?: string[]; reviewRequired?: boolean; baseBranch?: string;
        };
        await refreshAfterKnownMutation();
        if (proposal.reviewRequired && proposal.branch) {
          void vscode.window.showInformationMessage(
            `Artifact-template proposal ${proposal.branch} was pushed. Merge it into `
            + `${proposal.baseBranch ?? 'sflow/config'}, then refresh workspace configuration. `
            + 'The active Story was not changed.'
          );
        }
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
      }, () => client.run<{
        branch: string; proposalCommit: string; valid: boolean;
        workflows: Array<{ id: string; label?: string; governs?: string; change: string; phases?: string[] }>;
        failure?: { message?: string };
      }[]>(['workflow', 'proposals', '--json']));
    },
    'singularityFlow.openInstructionDesigner': async () => {
      const { InstructionDesignerPanel } = await import('./views/instruction-designer.ts');
      return InstructionDesignerPanel.show(context, store, async (message) => {
      if (message.type === 'agent-action') {
        if (message.action === 'refresh') {
          await store.refresh();
          return null;
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
      output.appendLine(`\n$ singularity-flow configuration save ${message.path}`);
      try {
        await client.runText(['configuration', 'save', message.path], { input: message.content });
        await refreshAfterKnownMutation();
        return null;
      } catch (error) {
        output.appendLine(`  refused: ${(error as Error).message}`);
        return (error as Error).message;
      }
      });
    },
    'singularityFlow.openConfigurationCenter': () => openConfigurationCenter('overview'),
    'singularityFlow.configureWorldModel': () => openConfigurationCenter('world-model'),
    'singularityFlow.buildWorldModel': async (request?: { capabilityId?: string }) => {
      const active = activeRepositoryContext();
      if (!active) {
        void vscode.window.showWarningMessage(
          'Choose a governed workspace repository before building its World Model.'
        );
        return;
      }
      try {
        const {
          showGovernedWorldModelBuild, worldModelAuthorityRefreshArguments
        } = await import('./world-model-build.ts');
        const modelMode = vscode.workspace.getConfiguration('singularityFlow')
          .get<string>('modelMode', 'auto');
        const outcome = await showGovernedWorldModelBuild(active, {
          modelRouting: modelMode === 'disabled' ? 'disabled' : 'enabled',
          capabilityId: request?.capabilityId ?? null
        });
        if (outcome.status === 'cancelled') return;
        if (outcome.status === 'refused') {
          const reason = outcome.result?.why?.[0];
          const code = reason?.code ?? 'world-model build refused';
          const engineCode = reason?.slots?.code;
          const refreshRequired = engineCode === 'WMB_GATEWAY_STATE_AUTHORITY_REFRESH_REQUIRED';
          const refreshAction = 'Refresh state & retry';
          const choice = await vscode.window.showWarningMessage(
            `World Model build was not run: ${code}${engineCode ? ` (${String(engineCode)})` : ''}. ${refreshRequired
              ? 'The remote state authority must be materialized before an exact preserving Plan can be reviewed.'
              : 'Review the current repository state and try again.'}`,
            ...(refreshRequired ? [refreshAction] : [])
          );
          if (refreshRequired && choice === refreshAction) {
            const refreshArgs = worldModelAuthorityRefreshArguments(outcome.capabilityId ?? null);
            output.appendLine(`\n$ singularity-flow ${refreshArgs.join(' ')}`);
            await client.runText([...refreshArgs]);
            await refreshAfterSurfaceMutation();
            await vscode.commands.executeCommand(
              'singularityFlow.buildWorldModel',
              outcome.capabilityId ? { capabilityId: outcome.capabilityId } : undefined
            );
          }
          return;
        }
        const manifest = outcome.result?.data?.manifestSha256;
        const views = Array.isArray(outcome.result?.data?.views)
          ? outcome.result.data.views.length : 0;
        await refreshAfterSurfaceMutation();
        void vscode.window.showInformationMessage(
          `World Model published${manifest ? ` as ${String(manifest).slice(0, 19)}` : ''} with ${views} view${views === 1 ? '' : 's'}.`
        );
      } catch (error) {
        output.appendLine(`  exact world-model build refused: ${(error as Error).message}`);
        showRefusal(error, { headline: 'Could not build the World Model' });
      }
    },
    'singularityFlow.configureAstIntelligence': async () => {
      const { AstIntelligencePanel } = await import('./views/ast-intelligence.ts');
      return AstIntelligencePanel.show(context, client, store);
    },
    'singularityFlow.publishConfiguration': async () => {
      const repository = store.current.snapshot?.repository;
      const files = repository?.configurationChanges ?? [];
      if (!files.length) {
        void vscode.window.showInformationMessage('No validated configuration changes are ready to publish.');
        return;
      }
      const unrelated = repository?.unrelatedChanges ?? [];
      if (unrelated.length) {
        void vscode.window.showWarningMessage(
          `Configuration publication is blocked by unrelated changes: ${unrelated.join(', ')}. Commit or set them aside, then refresh.`
        );
        return;
      }
      const branchName = repository?.branch ?? 'current branch';
      const choice = await vscode.window.showWarningMessage(
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
        void vscode.window.showInformationMessage(
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
    'singularityFlow.configureTemplates': () => openConfigurationCenter('templates'),
    'singularityFlow.configureModels': () => openConfigurationCenter('models'),
    'singularityFlow.openWorkspaceLogs': async () => {
      const { WorkspaceLogsPanel } = await import('./views/workspace-logs.ts');
      return WorkspaceLogsPanel.show(context, client, 'all');
    },
    'singularityFlow.refreshWorkspaceLogs': async () => {
      await refreshWorkspaceLogsTree();
      const { WorkspaceLogsPanel } = await import('./views/workspace-logs.ts');
      WorkspaceLogsPanel.refreshCurrent();
    },
    'singularityFlow.openPromptAudit': async () => {
      const { WorkspaceLogsPanel } = await import('./views/workspace-logs.ts');
      return WorkspaceLogsPanel.show(context, client, 'prompt');
    },
    'singularityFlow.openActivityLog': async () => {
      const { WorkspaceLogsPanel } = await import('./views/workspace-logs.ts');
      return WorkspaceLogsPanel.show(context, client, 'activity');
    },
    'singularityFlow.openGoals': async () => {
      const { GoalsPanel } = await import('./views/goals.ts');
      return GoalsPanel.show(context, client, () => [
        ...(store.current.snapshot?.workItems ?? []).map((item) => ({ ...item, kind: 'story' as const })),
        ...(store.current.snapshot?.initiatives ?? []).map((item) => ({ ...item, kind: 'initiative' as const }))
      ], refreshAfterSurfaceMutation);
    },
    'singularityFlow.openFaultRepairs': async () => {
      const { FaultRepairsPanel } = await import('./views/fault-repairs.ts');
      return FaultRepairsPanel.show(context, client, async () => {
        await refreshAfterSurfaceMutation(); void refreshWorkspaceLogsTree();
      });
    },
    'singularityFlow.openJournal': async () => {
      const { JournalPanel } = await import('./views/journal.ts');
      return JournalPanel.show(context, client, refreshAfterSurfaceMutation);
    },
    'singularityFlow.openSpecificationTrace': async () => {
      const { SpecificationTracePanel } = await import('./views/specification-trace.ts');
      return SpecificationTracePanel.show(context, client);
    },
    'singularityFlow.inspectCompositionCache': async () => {
      const status = await client.run<{ entries: number; bytes: number }>(['wm', 'cache', 'status', '--json']);
      void vscode.window.showInformationMessage(`Composition cache: ${status.entries} exact prompt(s), ${status.bytes.toLocaleString()} bytes.`);
    },
    'singularityFlow.checkLedgerDeployment': async () => {
      const result = await client.run<{ valid: boolean; checks: Array<{ status: string }> }>(['ledger', 'deployment-check', '--offline', '--json']);
      const failed = result.checks.filter((check) => check.status === 'fail').length;
      void vscode.window.showInformationMessage(result.valid ? 'Ledger deployment checks passed.' : `Ledger deployment needs attention: ${failed} failed check(s).`);
    },
    'singularityFlow.openVisualAssurance': async () => {
      const { VisualAssurancePanel } = await import('./views/visual-assurance.ts');
      return VisualAssurancePanel.show(context, store, client);
    },
    'singularityFlow.openCopilot': async () => {
      try {
        const nativeUsageNotice = 'singularityFlow.nativeCopilotUsageUnavailableNotice';
        if (!context.globalState.get<boolean>(nativeUsageNotice, false)) {
          void vscode.window.showInformationMessage(
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
          void vscode.window.showInformationMessage(
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
      const { CapabilitiesPanel } = await import('./views/capabilities.ts');
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
  store.primeFromCache();
  await store.refresh();
  initialRefreshCompleted = true;
  startAuxiliaryReadsAfterConfirmedSnapshot();
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
      void vscode.window.showWarningMessage(
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
  const firstHomeKey = 'singularityFlow.firstHealthyHome.v1';
  if (vscode.env?.appHost && !firstRunBlocked && !pendingStartWizard && !pendingHandoff
      && !context.globalState.get(firstHomeKey)) {
    // Home, not the walkthrough or a configuration form, is the successful first screen. The
    // walkthrough remains available from its one-time offer and the Help section.
    await context.globalState.update(firstHomeKey, true);
    await vscode.commands.executeCommand('singularityFlow.myWork');
  }
}

/**
 * Open an artifact as a normal editor tab.
 *
 * The path comes from the snapshot rather than from anything a view constructed, and it is resolved
 * and then checked to be inside the repository — a `..` that escaped the workspace would be a
 * genuine path-traversal, and the check costs nothing.
 */
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
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
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
    void vscode.window.showWarningMessage(`This artifact has not been generated yet: ${node.path}`);
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

export function deactivate(): void {
  extensionLifetime.abort();
}
