/**
 * The work-intake panel: the six ways work starts, behind one screen.
 *
 * Every value the page reports is treated as a claim. The shape, the tracker and the profile are
 * resolved against what the engine actually offers, so a page that posts a profile nobody configured
 * changes nothing.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import {
  contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import {
  EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, intakeIdentifier, intakePlanInputKey, intakeProblems, INTAKE_SCRIPT,
  MAX_STORY_ATTACHMENT_SLOTS, mergeStoryAttachments, referenceRepositoryEntries, SHAPES,
  storyPreflightCommand, storyWorkflowSelection, suggestedStoryDocumentName,
  storyWorkflowSelectionForReload,
  type BaseBranchChoice, type InFlight, type IntakeForm, type ProfileChoice,
  type PreflightTestReadiness, type ReferenceRepositoryDraft, type Shape, type StoryAttachmentDraft, type Tracker
} from './intake-form.ts';
import { SingularityFlowClient } from '../cli/client.ts';
import { CliTimeoutError, redactCliArgsForDisplay, terminalCommand } from '../cli/runner.ts';
import { startProgressLabel } from '../cli/progress.ts';
import { canonicalFilesystemPath } from '../repository-refresh-model.ts';
import type { StartWizardProgress } from './start-wizard.ts';
import type { IntakeCatalogCacheBinding } from '../intake-catalog-cache.ts';
import type { BackgroundHold } from '../background-governor.ts';
import {
  testRecoveryCanConfirm, testRecoveryChoiceSupported, testRecoveryConfirmation, testRecoveryEnabled,
  type PreflightTestRecovery
} from './test-recovery-intake.ts';

/** A background result waits this long after the last keystroke before it redraws the page. */
const INTAKE_TYPING_QUIET_MS = 300;
/** Readiness is checked once somebody pauses typing the identifier this long, not only on blur. */
const INTAKE_ID_PREFLIGHT_DEBOUNCE_MS = 400;
const PORTABLE_WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A completed reference row is checked, and its commit fetched ahead of Start, after this pause. */
const INTAKE_REFERENCE_PREFETCH_DEBOUNCE_MS = 600;
/** Start passes an intake receipt only while this much of its life remains. */
const INTAKE_RECEIPT_MINIMUM_REMAINING_MS = 60_000;

/** What was started, so the caller can take the reader straight to it. */
export interface Started {
  shape: Shape;
  id: string;
  currentPhase?: string;
  repositoryPath?: string;
  publication?: { pushed?: boolean; branch?: string; commit?: string };
  configuration?: { commit?: string } | null;
}

export interface IntakeTarget {
  workspace: string | null;
  repository: string;
  branch: string | null;
  /** From the Store's last snapshot, possibly cached; `lifecycleChanged` keeps it current. */
  inFlight: InFlight[];
  approvalAuthorityMissing?: boolean;
  defaults?: IntakeDefaults;
  journey?: StartWizardProgress | null;
  /** The last complete catalog for this repository, painted while the fresh one is read. */
  catalogCache?: IntakeCatalogCacheBinding | null;
  /** Held while the form is on screen, so optional background work does not compete with it. */
  holdBackgroundWork?: ((reason: string) => BackgroundHold) | null;
  /** Held while a Story starts, so the window does not follow its selection write before it opens it. */
  holdNavigation?: (() => { release(): void }) | null;
}

export interface IntakeDefaults {
  shape?: Shape | null;
  source?: 'jira' | 'github-issue' | 'manual' | null;
  workType?: string | null;
  summary?: string | null;
}

interface StoryStartReadinessCheck {
  id?: string;
  status?: 'pass' | 'warning' | 'block';
  code?: string;
  message?: string;
}

interface StoryStartReadinessResult {
  ready?: boolean;
  checks?: StoryStartReadinessCheck[];
  blockers?: StoryStartReadinessCheck[];
  warnings?: StoryStartReadinessCheck[];
}

interface EngineStoryWorkflow {
  id?: string;
  label?: string;
  description?: string;
  phases?: string[];
  governs?: string;
  installed?: boolean;
  references?: 'off' | 'optional' | 'required';
  generatesCode?: boolean;
  codePhases?: string[];
  documentStorage?: { allowed: Array<'git' | 'local'>; default: 'git' | 'local' };
}

interface EngineStoryWorkflowCatalog {
  storyWorkflows?: EngineStoryWorkflow[];
  availableStoryWorkflows?: EngineStoryWorkflow[];
  workflowCatalogReason?: string | null;
  workflowReason?: string | null;
}

/** `workspace branches --json --intake`: everything the form offers, in one engine process. */
interface CatalogListing {
  choices?: BaseBranchChoice[];
  remote?: string;
  unreachable?: { repository: string }[];
  intake?: EngineStoryWorkflowCatalog & {
    profiles?: { id?: string; label?: string; description?: string; phases?: string[] }[];
    profileReason?: string | null;
    approvalAuthorityMissing?: boolean;
  };
}

/** The first listing, the fresh one replacing a cached paint, or a reload after a configuration change. */
type CatalogMode = 'initial' | 'revalidate' | 'reload';

/** Keep the launch catalog and exact-base preflight catalog on one validation path. */
function storyWorkflowChoices(entries: EngineStoryWorkflow[] = []): ProfileChoice[] {
  return entries.filter((entry) => entry.id && entry.governs === 'story'
    && entry.installed !== false).map((entry) => ({
    id: entry.id!, label: entry.label ?? entry.id!, description: entry.description ?? '',
    phases: entry.phases ?? [], referenceMode: entry.references ?? 'optional',
    generatesCode: entry.generatesCode, codePhases: entry.codePhases, documentStorage: entry.documentStorage
  }));
}

/** Installed and packaged-available rows are one catalog with two different authorities. */
function storyWorkflowCatalog(catalog: EngineStoryWorkflowCatalog | undefined): {
  installed: ProfileChoice[];
  available: ProfileChoice[];
} {
  return {
    installed: storyWorkflowChoices(catalog?.storyWorkflows),
    available: (catalog?.availableStoryWorkflows ?? []).filter((entry) =>
      entry.id && entry.governs === 'story' && entry.installed === false).map((entry) => ({
      id: entry.id!, label: entry.label ?? entry.id!, description: entry.description ?? '',
      phases: entry.phases ?? [], referenceMode: entry.references ?? 'optional',
      generatesCode: entry.generatesCode, codePhases: entry.codePhases, documentStorage: entry.documentStorage
    }))
  };
}

function emptyStoryPreflight(): Pick<IntakeForm,
  'basePreflightPassed' | 'basePreflightChecking' | 'basePreflightReason'
  | 'basePreflightWarnings' | 'baseTestReadiness' | 'basePreflightRefreshRecommended'
  | 'testRecovery' | 'testRecoveryConfirmedDigest'> {
  return {
    basePreflightPassed: false,
    basePreflightChecking: false,
    basePreflightReason: null,
    basePreflightWarnings: [],
    baseTestReadiness: null,
    basePreflightRefreshRecommended: false,
    testRecovery: null,
    testRecoveryConfirmedDigest: null
  };
}

/** Configuration repair is offered only for findings the refresh/reinitialize journey can address. */
function configurationRefreshRelevant(readiness: StoryStartReadinessResult | undefined): boolean {
  return (readiness?.checks ?? []).some((entry) =>
    (entry.id === 'configuration-authority' && entry.status !== 'pass')
    || (entry.id === 'workflow' && entry.status === 'block'
      && entry.code !== 'STORY_WORKFLOW_SELECTION_PENDING')
    || (entry.id === 'governed-agents' && entry.status === 'block'));
}

/** Project the store's already-fresh lifecycle slice into the compact rows Intake renders. */
export function intakeInFlight(snapshot: {
  initiatives?: { id?: string; title?: string; status?: string; currentPhaseLabel?: string | null }[];
  workItems?: {
    id?: string; title?: string; status?: string; workType?: string; currentPhase?: string | null;
  }[];
} | null | undefined): InFlight[] {
  const where = (status?: string, phase?: string | null): string =>
    (phase ? `${status ?? 'in progress'} · ${phase}` : status ?? 'in progress');
  const completed = (status?: string): boolean =>
    ['complete', 'completed'].includes(status?.toLowerCase() ?? '');
  const initiatives = (snapshot?.initiatives ?? []).filter((entry) => entry.id).map((entry) => ({
    shape: 'initiative' as Shape,
    id: entry.id!,
    title: entry.title ?? entry.id!,
    status: where(entry.status, entry.currentPhaseLabel),
    completed: completed(entry.status)
  }));
  const items = (snapshot?.workItems ?? []).filter((entry) => entry.id).map((entry) => ({
    shape: (entry.workType === 'epic' ? 'epic' : 'story') as Shape,
    id: entry.id!,
    title: entry.title ?? entry.id!,
    status: where(entry.status, entry.currentPhase),
    completed: completed(entry.status)
  }));
  return [...initiatives, ...items];
}

export class IntakePanel {
  private static current: IntakePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly output: vscode.OutputChannel;
  private readonly onStarted: (started: Started) => Promise<void>;
  private readonly defaults: IntakeDefaults;
  private readonly journey: StartWizardProgress | null;
  private inFlight: InFlight[];
  private readonly disposables: vscode.Disposable[] = [];
  private form: IntakeForm;
  private preflightVersion = 0;
  private preflightController: AbortController | null = null;
  private enhancementRevision = 0;
  private catalogRevision = 0;
  private enhancementController: AbortController | null = null;
  private trackerChosen = false;
  /** Any input at all. A background result never switches the tracker under somebody's typing. */
  private formTouched = false;
  private lastDraftAt = 0;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private idPreflightTimer: ReturnType<typeof setTimeout> | null = null;
  /** The exact readiness command in flight or last completed, so blur does not repeat it. */
  private preflightKey: string | null = null;
  /**
   * The intake receipt from the last passing readiness check, for exactly that request. Private to
   * this panel: never rendered, logged unredacted, or put in a recovery command.
   */
  private intakeReceipt: { id: string; expiresAt: number; key: string } | null = null;
  private readonly referencePrefetchTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly catalogCache: IntakeCatalogCacheBinding | null;
  private readonly holdBackgroundWork: ((reason: string) => BackgroundHold) | null;
  private readonly holdNavigation: (() => { release(): void }) | null;
  private backgroundHold: BackgroundHold | null = null;
  /** The base whose readiness answer replaced the workflow choices with that base's own. */
  private exactCatalogBase: string | null = null;
  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    client: SingularityFlowClient,
    output: vscode.OutputChannel,
    onStarted: (started: Started) => Promise<void>,
    target: IntakeTarget
  ) {
    this.panel = panel;
    this.client = client;
    this.output = output;
    this.onStarted = onStarted;
    this.defaults = target.defaults ?? {};
    this.journey = target.journey ?? null;
    this.inFlight = target.inFlight;
    this.catalogCache = target.catalogCache ?? null;
    this.holdBackgroundWork = target.holdBackgroundWork ?? null;
    this.holdNavigation = target.holdNavigation ?? null;
    this.form = {
      ...EMPTY_INTAKE_FORM,
      targetWorkspace: target.workspace,
      targetRepository: target.repository,
      targetBranch: target.branch,
      // Starting a Story is the common case, so the form opens on it unless the caller asked for
      // another shape.
      shape: this.defaults.shape ?? 'story',
      approvalAuthorityMissing: target.approvalAuthorityMissing === true,
      inFlight: target.inFlight,
      ...(this.defaults.source ? {
        tracker: this.defaults.source === 'github-issue' ? 'github'
          : this.defaults.source === 'jira' ? 'jira' : 'none'
      } : {}),
      ...(this.defaults.summary ? { title: this.defaults.summary } : {}),
      ...(this.defaults.workType ? { workType: this.defaults.workType } : {})
    };
    // Paint the last known choices now; `load` revalidates them against the remote.
    this.form = { ...this.form, ...(this.cachedCatalogChanges() ?? { catalogStatus: 'loading' }) };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((event) => this.holdWhileVisible(event.webviewPanel.visible),
      null, this.disposables);
    this.holdWhileVisible(this.panel.visible);
    this.render();
    void this.load();
  }

  /** Optional background work waits while this form is on screen, and resumes once it is not. */
  private holdWhileVisible(visible: boolean): void {
    if (visible && !this.disposed) {
      this.backgroundHold ??= this.holdBackgroundWork?.('intake') ?? null;
      return;
    }
    this.backgroundHold?.release();
    this.backgroundHold = null;
  }

  static show(
    context: vscode.ExtensionContext,
    client: SingularityFlowClient,
    output: vscode.OutputChannel,
    onStarted: (started: Started) => Promise<void>,
    target: IntakeTarget
  ): IntakePanel {
    if (IntakePanel.current) {
      if (IntakePanel.current.form.targetRepository === target.repository
          && IntakePanel.current.form.targetBranch === target.branch
          && Boolean(IntakePanel.current.journey) === Boolean(target.journey)) {
        IntakePanel.current.panel.reveal(vscode.ViewColumn.Active);
        // A retained Intake panel may have outlived a terminal or Configuration Center refresh.
        // Reopening Start Work is an explicit request for the current authority, not for its cached
        // launch catalog. Preserve the person's draft while refreshing only governed choices.
        void IntakePanel.current.reloadCatalog();
        return IntakePanel.current;
      }
      // A workspace or branch switch changes the mutation target. Never reveal a form that names
      // the former target while its shared client now points somewhere else.
      IntakePanel.current.dispose();
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.intake', target.journey ? 'Guided start' : 'Start work', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    IntakePanel.current = new IntakePanel(panel, client, output, onStarted, target);
    return IntakePanel.current;
  }

  /**
   * The Store refreshed its lifecycle slice. The form opens on the last known in-flight work instead
   * of waiting for a fresh snapshot, so this is how it learns about work started since.
   */
  static lifecycleChanged(inFlight: InFlight[]): void {
    const current = IntakePanel.current;
    if (!current || current.disposed) return;
    if (JSON.stringify(current.inFlight) === JSON.stringify(inFlight)) return;
    current.inFlight = inFlight;
    current.update({ inFlight }, { background: true });
  }

  /** Refresh an already-open Intake form after approved configuration changes elsewhere. */
  static async configurationChanged(repository: string | null = null): Promise<boolean> {
    const current = IntakePanel.current;
    if (!current || current.disposed) return false;
    if (repository && current.form.targetRepository
        && await canonicalFilesystemPath(repository)
          !== await canonicalFilesystemPath(current.form.targetRepository)) return false;
    await current.reloadCatalog();
    return true;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      this.journey ? 'Guided start' : 'Start work', intakeHtml(this.form, this.journey),
      contentSecurityPolicy(this.panel.webview, token), token, INTAKE_SCRIPT
    );
  }

  /**
   * Merge and redraw. A change the person just made redraws at once; a background result waits until
   * typing pauses, so a redraw never lands in the middle of a word.
   */
  private update(changes: Partial<IntakeForm>, { background = false }: { background?: boolean } = {}): void {
    if (this.disposed) return;
    const previousPlan = intakePlanInputKey(this.form);
    this.form = {
      ...this.form,
      ...(Object.hasOwn(changes, 'error') && changes.error === null
        ? { recoveryCommand: null, recoveryRouteCommand: null } : {}),
      ...changes
    };
    if (previousPlan !== intakePlanInputKey(this.form)) this.form.testRecoveryConfirmedDigest = null;
    if (background) this.scheduleRender();
    else this.renderNow();
  }

  private renderNow(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.render();
  }

  private scheduleRender(): void {
    const quiet = Date.now() - this.lastDraftAt;
    if (quiet >= INTAKE_TYPING_QUIET_MS) return this.renderNow();
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (!this.disposed) this.scheduleRender();
    }, INTAKE_TYPING_QUIET_MS - quiet);
  }

  private cancelBasePreflight(): void {
    this.preflightController?.abort();
    this.preflightController = null;
    this.preflightKey = null;
    this.intakeReceipt = null;
    if (this.idPreflightTimer) clearTimeout(this.idPreflightTimer);
    this.idPreflightTimer = null;
  }

  /** Check readiness once the request has stopped changing, instead of waiting for blur. */
  private scheduleIdentifierPreflight(): void {
    if (this.idPreflightTimer) clearTimeout(this.idPreflightTimer);
    this.idPreflightTimer = setTimeout(() => {
      this.idPreflightTimer = null;
      if (this.disposed || this.form.shape !== 'story') return;
      const command = storyPreflightCommand(this.form);
      if (!command || !PORTABLE_WORK_ID.test(intakeIdentifier(this.form))) return;
      if (JSON.stringify(command) === this.preflightKey) return;
      this.preflightVersion += 1;
      void this.preflightBaseBranch();
    }, INTAKE_ID_PREFLIGHT_DEBOUNCE_MS);
  }

  /** Cancel an advisory rewrite whenever any input it was based on changes. */
  private invalidateEnhancement(): void {
    this.enhancementRevision += 1;
    this.form.enhanceError = null;
    this.form.enhanceProposal = null;
    const active = this.enhancementController;
    if (active && !active.signal.aborted) active.abort();
  }

  private enhancementIsCurrent(controller: AbortController, revision: number): boolean {
    return !this.disposed
      && this.enhancementController === controller
      && !controller.signal.aborted
      && revision === this.enhancementRevision
      && this.form.shape === 'story'
      && this.form.tracker === 'none';
  }

  /**
   * What the repository actually offers, resolved by one governed engine command.
   *
   * The Store already owns the fresh lifecycle projection used for `inFlight`. Profiles, installed
   * Story workflows and remote base branches share this aggregate process; Jira is an optional
   * network integration and is probed only after the local form can render.
   *
   * A form painted from the cached catalog revalidates here, keeping what the person chose since
   * wherever it is still offered.
   */
  private async load({ preserveSelections = false }: { preserveSelections?: boolean } = {}): Promise<void> {
    const revision = ++this.catalogRevision;
    const mode: CatalogMode = preserveSelections ? 'reload'
      : this.form.catalogStatus === 'cached' ? 'revalidate' : 'initial';
    try {
      const listed = await this.client.run<CatalogListing>(['workspace', 'branches', '--json', '--intake']);
      if (revision !== this.catalogRevision || this.disposed) return;
      if (listed.intake?.profileReason) {
        this.output.appendLine(`No delivery profiles could be read: ${listed.intake.profileReason}`);
      }
      const { changes, readinessReset, workflowsReplaced } = this.catalogChanges(listed, mode);
      if (readinessReset && mode === 'revalidate') {
        this.cancelBasePreflight();
        this.preflightVersion += 1;
      }
      if (workflowsReplaced) this.exactCatalogBase = null;
      this.update(changes, { background: true });
      // Only a complete listing is worth painting next time; a degraded one keeps the last good entry.
      if (!(listed.unreachable ?? []).length && !listed.intake?.workflowReason) {
        try { this.catalogCache?.write(listed); } catch { /* an acceleration only */ }
      }
      if (mode !== 'initial' && readinessReset && this.form.baseBranch) await this.preflightBaseBranch();
    } catch (error) {
      if (revision !== this.catalogRevision || this.disposed) return;
      const reason = (error as Error).message;
      this.output.appendLine(`Intake catalog could not be read: ${reason}`);
      if (mode === 'revalidate') {
        this.cancelBasePreflight();
        this.preflightVersion += 1;
      }
      this.update(mode !== 'initial' ? {
        // A failed refresh must not erase a valid draft or its last known choices. Mark the
        // authority stale and require another successful preflight before Start can be enabled.
        workflowReason: `Could not refresh Story workflows: ${reason}`,
        baseBranchReason: reason,
        ...emptyStoryPreflight()
      } : {
        profiles: [], profile: null, storyWorkflows: [], availableStoryWorkflows: [], workType: null,
        workflowCatalogReason: null,
        workflowReason: `Could not load Story workflows: ${reason}`,
        baseBranchChoices: [], baseBranch: null, baseRemote: null, baseBranchReason: reason,
        catalogStatus: 'fresh',
        ...emptyStoryPreflight(),
        inFlight: this.inFlight
      });
    }
    // Jira is an optional external integration. Do not make its cold process or network probe part
    // of the form's critical path; its result updates only the tracker controls when it arrives.
    if (!preserveSelections) void this.loadTracker();
  }

  /**
   * How one catalog listing changes the form.
   *
   * `cached` and `initial` start from the defaults. `reload` keeps the person's choices while they
   * are still offered and always re-checks readiness, because it follows a configuration change.
   * `revalidate` replaces a cached paint: it keeps the person's choices the same way, and leaves a
   * readiness check alone while its base and workflow are still offered, since that check read the
   * exact base and is at least as fresh as this listing. The exact-base workflows it returned stay
   * too. No mode ever selects a base the person did not choose.
   */
  private catalogChanges(listed: CatalogListing, mode: CatalogMode | 'cached'): {
    changes: Partial<IntakeForm>; readinessReset: boolean; workflowsReplaced: boolean;
  } {
    const keepChoices = mode === 'reload' || mode === 'revalidate';
    const profiles: ProfileChoice[] = (listed.intake?.profiles ?? []).filter((entry) => entry.id).map((entry) => ({
      id: entry.id!,
      label: entry.label ?? entry.id!,
      description: entry.description ?? '',
      phases: entry.phases ?? []
    }));
    const workflows = storyWorkflowCatalog(listed.intake);
    const priorProfile = keepChoices ? this.form.profile : null;
    const priorWorkType = (keepChoices ? this.form.workType : this.defaults.workType) ?? null;
    const priorBaseBranch = keepChoices ? this.form.baseBranch : null;
    const baseBranchChoices = (listed.choices ?? []).filter((choice) => choice.everywhere);
    const baseBranch = baseBranchChoices.some((choice) => choice.branch === priorBaseBranch)
      ? priorBaseBranch : null;
    const keepExactWorkflows = mode === 'revalidate' && baseBranch !== null
      && this.exactCatalogBase === baseBranch;
    const retainedWorkType = mode === 'revalidate'
      ? storyWorkflowSelection(priorWorkType, workflows.installed)
      : storyWorkflowSelectionForReload(
        priorWorkType, workflows.installed, mode === 'reload' && Boolean(baseBranch)
      );
    const workType = keepExactWorkflows ? this.form.workType
      : retainedWorkType
        // `feature` is the familiar starter workflow. A repository with one workflow needs no extra
        // click; multiple custom workflows remain an explicit, visible choice in the form.
        ?? workflows.installed.find((entry) => entry.id === 'feature')?.id
        ?? workflows.installed[0]?.id ?? null;
    const readinessReset = !(mode === 'revalidate' && baseBranch !== null && workType === this.form.workType);
    const unreachable = listed.unreachable ?? [];
    return {
      readinessReset,
      workflowsReplaced: !keepExactWorkflows,
      changes: {
        profiles,
        // Defaulted so the form is not blocked on a choice with one sensible answer, but still
        // shown, because it decides the phases for the life of the work.
        profile: profiles.find((entry) => entry.id === priorProfile)?.id
          ?? profiles.find((entry) => entry.id === 'epic-planning')?.id ?? profiles[0]?.id ?? null,
        ...(keepExactWorkflows ? {} : {
          storyWorkflows: workflows.installed,
          availableStoryWorkflows: workflows.available,
          workflowCatalogReason: listed.intake?.workflowCatalogReason ?? null,
          workType,
          workflowReason: listed.intake?.workflowReason
            ? `Could not load Story workflows: ${listed.intake.workflowReason}` : null
        }),
        baseBranchChoices,
        // A Story base is an explicit, permanent choice. Even one available branch must be selected.
        baseBranch,
        baseRemote: listed.remote ?? null,
        // Named, because a branch missing from the list because a remote was unreachable looks
        // exactly like a branch that does not exist.
        baseBranchReason: unreachable.length
          ? `Could not read ${unreachable.map((entry) => entry.repository).join(', ')}. Remote access is required before starting a Story.`
          : null,
        ...(readinessReset ? emptyStoryPreflight() : {}),
        githubConfigured: true,
        githubReason: null,
        inFlight: this.inFlight,
        approvalAuthorityMissing: typeof listed.intake?.approvalAuthorityMissing === 'boolean'
          ? listed.intake.approvalAuthorityMissing : this.form.approvalAuthorityMissing,
        catalogStatus: mode === 'cached' ? 'cached' : 'fresh'
      }
    };
  }

  /** The last complete listing for this repository and CLI build, if it still parses. */
  private cachedCatalogChanges(): Partial<IntakeForm> | null {
    try {
      const cached = this.catalogCache?.read();
      if (!cached) return null;
      const listed = cached.listed as CatalogListing;
      if ((listed.choices !== undefined && !Array.isArray(listed.choices))
          || (listed.intake !== undefined && (typeof listed.intake !== 'object' || listed.intake === null))) {
        return null;
      }
      return this.catalogChanges(listed, 'cached').changes;
    } catch {
      return null;
    }
  }

  private async reloadCatalog(): Promise<void> {
    this.cancelBasePreflight();
    this.preflightVersion += 1;
    // The last successful preflight is bound to the catalog revision being replaced. Invalidate it
    // before the asynchronous authority read starts so a retained webview cannot start work from
    // stale workflow/configuration bytes while the refresh is in flight.
    this.update({
      ...emptyStoryPreflight(),
      basePreflightChecking: true
    });
    await this.load({ preserveSelections: true });
  }

  /**
   * Whether a tracker is reachable, and — when it is not — why, in the engine's own words.
   *
   * `jira status` is the probe because it is the thing that fails: unconfigured, it refuses with a
   * message naming the exact environment variables to set. Reporting that verbatim is more use than
   * "not configured", which tells somebody they have a problem and not how to end it.
   */
  private async loadTracker(): Promise<void> {
    const tracker = await this.tracker();
    let selection = this.form.tracker;
    if (!this.trackerChosen && !this.formTouched) {
      selection = this.defaults.source === 'github-issue' ? 'github'
        : this.defaults.source === 'manual' ? 'none'
          : tracker.configured ? 'jira' : 'none';
    }
    if (selection !== this.form.tracker) this.invalidateEnhancement();
    this.update({
      jiraConfigured: tracker.configured,
      jiraReason: tracker.reason,
      tracker: selection
    }, { background: true });
  }

  private async tracker(): Promise<{ configured: boolean; reason: string | null }> {
    try {
      await this.client.run<unknown>(['jira', 'status', '--json']);
      return { configured: true, reason: null };
    } catch (error) {
      return { configured: false, reason: (error as Error).message };
    }
  }

  /** The fields this form will write. Anything else named by the page is refused. */
  private static readonly WRITABLE = Object.freeze([
    'key', 'id', 'title', 'description', 'goal', 'acceptanceCriteria', 'targetUrl'
  ]);

  /**
   * The eight messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * Five of them resolve a value against what exists — a shape, a profile, a base branch, a work
   * type — rather than trusting the page, and that is unchanged. `draft` and `field` share a
   * writable-field allowlist, which matters more than it looks: `field` writes through a computed
   * key, so without the allowlist a page could name any property of the form object.
   *
   * `draft` records a keystroke and nothing else. Replacing the document under whoever is typing
   * takes the caret with it; the committed value arrives again as `field`, and that one redraws.
   */
  private router = registerMessageRouter('singularityFlow.intake', {
    testRecoveryChoice: (message) => {
      if (this.form.busy) return;
      const field = stringField(message, 'field');
      const value = stringField(message, 'value');
      if (!field || !value || !testRecoveryChoiceSupported(this.form, field, value)) return;
      this.cancelBasePreflight();
      this.preflightVersion += 1;
      this.update({ [field]: value, testRecoveryConfirmedDigest: null, error: null } as Partial<IntakeForm>);
      return this.preflightBaseBranch();
    },
    testRecoveryConfirm: (message) => {
      if (this.form.busy || this.form.basePreflightChecking || !testRecoveryCanConfirm(this.form)) return;
      // The page echoes the displayed digest to reject a delayed event from an older preview.
      // The mutation's digest still comes only from this host's current engine response.
      if (stringField(message, 'planDigest') !== this.form.testRecovery!.planDigest) return;
      if (this.preflightKey !== JSON.stringify(storyPreflightCommand(this.form))) return;
      this.update({ testRecoveryConfirmedDigest: testRecoveryConfirmation(
        this.form, stringField(message, 'planDigest'), message.confirmed
      ) });
    },
    testRecoveryRefresh: () => {
      if (this.form.busy || !testRecoveryEnabled(this.form)) return;
      return this.preflightBaseBranch();
    },
    shape: (message) => {
      const shape = SHAPES.find((entry) => entry.id === stringField(message, 'value'));
      if (shape) {
        this.invalidateEnhancement();
        this.cancelBasePreflight();
        this.preflightVersion += 1;
        this.update({
          shape: shape.id, error: null,
          ...emptyStoryPreflight()
        });
      }
    },
    tracker: (message) => {
      const value = stringField(message, 'value');
      const tracker = value === 'jira' ? 'jira' : value === 'github' ? 'github' : 'none';
      this.trackerChosen = true;
      this.formTouched = true;
      this.invalidateEnhancement();
      this.preflightVersion += 1;
      this.update({
        tracker: tracker as Tracker, error: null,
        ...emptyStoryPreflight()
      });
      return this.preflightBaseBranch();
    },
    profile: (message) => {
      const profile = this.form.profiles.find((entry) => entry.id === stringField(message, 'value'));
      if (profile) this.update({ profile: profile.id, error: null });
    },
    baseBranch: (message) => {
      const choice = this.form.baseBranchChoices.find((entry) => entry.branch === stringField(message, 'value'));
      if (choice) {
        this.preflightVersion += 1;
        this.update({
          baseBranch: choice.branch, error: null,
          ...emptyStoryPreflight()
        });
        return this.preflightBaseBranch();
      }
    },
    workType: (message) => {
      const workflow = this.form.storyWorkflows.find((entry) => entry.id === stringField(message, 'value'));
      if (workflow) {
        this.cancelBasePreflight();
        this.preflightVersion += 1;
        // Another workflow has other phases, so a narrowed phase set does not carry over.
        this.update({
          workType: workflow.id, error: null, ...emptyStoryPreflight(),
          storyAttachments: this.form.storyAttachments.map((entry) => entry ? { ...entry, phases: null } : entry)
        });
        return this.preflightBaseBranch();
      }
    },
    workflowRefresh: () => vscode.commands.executeCommand(
      'singularityFlow.refreshRepositorySetup', {
        repositoryPath: this.form.targetRepository ?? undefined,
        workspacePath: this.form.targetWorkspace ?? undefined
      }
    ),
    referenceAdd: () => {
      if (this.form.referenceRepositories.length >= 16) return;
      this.update({
        referenceRepositories: [...this.form.referenceRepositories, {
          id: '', repository: '', branch: '', status: 'idle'
        }],
        error: null
      });
    },
    referenceRemove: (message) => {
      const index = this.referenceIndex(message);
      if (index === null) return;
      this.update({
        referenceRepositories: this.form.referenceRepositories.filter((_, row) => row !== index),
        error: null
      });
      this.scheduleIdentifierPreflight();
    },
    referenceDraft: (message) => this.updateReferenceDraft(message, false),
    referenceField: (message) => this.updateReferenceDraft(message, true),
    referenceCheck: (message) => this.checkReference(message),
    attachmentPick: (message) => {
      const index = this.attachmentIndex(message);
      if (index !== null) return this.pickStoryAttachments(index);
    },
    attachmentsPick: () => this.pickStoryAttachments(null),
    // Typing keeps the caret: record the name without redrawing. A committed change redraws so
    // the Start button reflects whether every document now has its own name.
    attachmentNameDraft: (message) => this.renameStoryAttachment(message, false),
    attachmentName: (message) => this.renameStoryAttachment(message, true),
    attachmentStore: (message) => {
      const index = this.attachmentIndex(message);
      const value = stringField(message, 'value');
      if (index === null || !this.form.storyAttachments[index] || (value !== 'git' && value !== 'local')) return;
      this.update({
        storyAttachments: this.form.storyAttachments.map((entry, slot) => slot === index && entry ? { ...entry, store: value } : entry),
        error: null
      });
    },
    attachmentPhases: (message) => {
      const index = this.attachmentIndex(message);
      const phases = this.form.storyWorkflows.find((workflow) => workflow.id === this.form.workType)?.phases ?? [];
      const raw = Array.isArray(message.value) ? message.value : null;
      if (index === null || !this.form.storyAttachments[index] || !raw
        || raw.some((entry) => typeof entry !== 'string' || !phases.includes(entry))) return;
      // Every phase is the default, so it passes no flag; anything narrower is kept in workflow order.
      const chosen = phases.filter((phase) => raw.includes(phase));
      this.update({
        storyAttachments: this.form.storyAttachments.map((entry, slot) => slot === index && entry
          ? { ...entry, phases: chosen.length === phases.length ? null : chosen } : entry),
        error: null
      });
    },
    attachmentClear: (message) => {
      const index = this.attachmentIndex(message);
      if (index === null) return;
      this.invalidateEnhancement();
      this.update({
        storyAttachments: this.form.storyAttachments.map((entry, slot) => slot === index ? null : entry),
        enhanceError: null, error: null
      });
    },
    draft: (message) => {
      const field = this.writableField(message);
      const value = typeof message.value === 'string' ? message.value : null;
      if (field && value !== null) {
        this.formTouched = true;
        this.lastDraftAt = Date.now();
        if (['title', 'description', 'acceptanceCriteria'].includes(field)) {
          this.invalidateEnhancement();
        }
        if ((this.form as unknown as Record<string, string>)[field] !== value) {
          this.form.testRecoveryConfirmedDigest = null;
        }
        (this.form as unknown as Record<string, string>)[field] = value;
        if (field === 'id' || field === 'key') {
          // The identifier moved on, so an answer for the old one must never enable Start.
          if (this.preflightKey !== null
              && this.preflightKey !== JSON.stringify(storyPreflightCommand(this.form))) {
            this.cancelBasePreflight();
            this.preflightVersion += 1;
            this.update(emptyStoryPreflight(), { background: true });
          }
          this.scheduleIdentifierPreflight();
        }
      }
    },
    field: (message) => {
      const field = this.writableField(message);
      const value = typeof message.value === 'string' ? message.value : null;
      if (field && value !== null) {
        const invalidatesEnhancement = ['title', 'description', 'acceptanceCriteria'].includes(field);
        if (invalidatesEnhancement) this.invalidateEnhancement();
        this.formTouched = true;
        // Blur after a pause re-reports the value readiness is already checking or has checked.
        const alreadyChecked = (field === 'id' || field === 'key') && this.preflightKey !== null
          && this.preflightKey === JSON.stringify(storyPreflightCommand({ ...this.form, [field]: value }));
        const invalidatesPreflight = (field === 'id' || field === 'key') && !alreadyChecked;
        if (invalidatesPreflight) this.preflightVersion += 1;
        this.update({
          [field]: value,
          ...(invalidatesEnhancement ? { enhanceError: null } : {}),
          ...(invalidatesPreflight ? {
            ...emptyStoryPreflight()
          } : {})
        } as Partial<IntakeForm>);
        if (invalidatesPreflight) return this.preflightBaseBranch();
      }
    },
    enhanceDescription: () => this.enhanceStoryDescription(),
    enhanceApply: () => {
      const proposal = this.form.enhanceProposal;
      if (!proposal || this.form.enhancing || this.form.busy) return;
      this.enhancementRevision += 1;
      this.update({ description: proposal, enhanceProposal: null, enhanceError: null });
    },
    enhanceDiscard: () => {
      if (!this.form.enhanceProposal || this.form.enhancing || this.form.busy) return;
      this.enhancementRevision += 1;
      this.update({ enhanceProposal: null, enhanceError: null });
    },
    start: () => this.start(),
    'recover-start': () => this.recoverStartedStory()
  });

  /** Adopt a Story whose terminal retry completed after the extension request timed out. */
  private async recoverStartedStory(): Promise<void> {
    if (this.form.shape !== 'story' || this.form.busy) return;
    const workId = intakeIdentifier(this.form);
    if (!workId) return;
    this.update({ busy: true, error: null });
    try {
      // `attach` performs the same fresh fetch, exact remote subject-index resolution and pinned
      // workflow validation as `candidates`, then binds that exact Story. Listing candidates first
      // repeated the whole remote/index path and provided no additional authority.
      const attached = await this.client.run<{
        workId?: string; repositoryPath?: string; phase?: string; status?: string;
      }>(['session', 'attach', workId, '--json']);
      this.dispose();
      await this.onStarted({
        shape: 'story', id: attached.workId ?? workId,
        currentPhase: attached.phase, repositoryPath: attached.repositoryPath
      });
    } catch (error) {
      const message = (error as Error).message;
      this.update({
        busy: false,
        error: /No governed story matches/i.test(message)
          ? `Story ${workId} is not published yet. Let the terminal command finish, then check again.`
          : message
      });
    }
  }

  private writableField(message: InboundMessage): string | null {
    const field = stringField(message, 'field');
    return field && IntakePanel.WRITABLE.includes(field) ? field : null;
  }

  private referenceIndex(message: InboundMessage): number | null {
    const index = integerField(message, 'index');
    return index !== null && index < this.form.referenceRepositories.length ? index : null;
  }

  private attachmentIndex(message: InboundMessage): number | null {
    const index = integerField(message, 'index');
    return index !== null && index < MAX_STORY_ATTACHMENT_SLOTS
      && index < this.form.storyAttachments.length ? index : null;
  }

  /** Ask for a proposal without putting Story content or local paths on the process command line. */
  private async enhanceStoryDescription(): Promise<void> {
    if (this.form.shape !== 'story' || this.form.tracker !== 'none' || this.form.busy
        || this.form.enhancing || !this.form.description.trim()) return;
    const controller = new AbortController();
    const revision = this.enhancementRevision;
    this.enhancementController = controller;
    this.update({ enhancing: true, enhanceProposal: null, enhanceError: null });
    try {
      const result = await this.client.runWithInput<{
        status?: string;
        proposal?: { description?: string };
      }>(['story', 'enhance-description', '--draft-stdin', '--json'], JSON.stringify({
        schemaVersion: 1,
        title: this.form.title,
        description: this.form.description,
        acceptanceCriteria: this.form.acceptanceCriteria,
        attachments: this.form.storyAttachments.flatMap((entry) => entry ? [entry.sourcePath] : [])
      }), controller.signal);
      if (!this.enhancementIsCurrent(controller, revision)) return;
      const proposed = result.status === 'proposed' && typeof result.proposal?.description === 'string'
        ? result.proposal.description.trim() : '';
      if (!proposed) throw new Error('Copilot did not return a proposed Story description.');
      this.enhancementRevision += 1;
      this.update({ enhanceProposal: proposed, enhancing: false, enhanceError: null });
    } catch (error) {
      if (!this.enhancementIsCurrent(controller, revision)) return;
      this.update({
        enhancing: false,
        enhanceError: `Copilot could not enhance this description: ${(error as Error).message}`
      });
    } finally {
      if (this.enhancementController === controller) {
        this.enhancementController = null;
        if (!this.disposed && this.form.enhancing) {
          this.update({ enhancing: false, enhanceError: null });
        }
      }
    }
  }

  /**
   * Resolve attachment paths through VS Code's native picker rather than accepting paths posted by
   * the webview. A numbered slot replaces one item; the collection action fills empty slots first
   * and then grows the bounded list.
   */
  private async pickStoryAttachments(replaceIndex: number | null): Promise<void> {
    if (this.form.shape !== 'story' || this.form.busy) return;
    this.invalidateEnhancement();
    const selected = await vscode.window.showOpenDialog({
      title: replaceIndex === null ? 'Choose supporting Story documents' : `Choose document ${replaceIndex + 1}`,
      openLabel: replaceIndex === null ? 'Attach documents' : 'Attach document',
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: replaceIndex === null,
      ...(this.form.targetRepository ? { defaultUri: vscode.Uri.file(this.form.targetRepository) } : {}),
      // One combined filter: a second one would leave images greyed out until the dialog's format
      // menu is changed, because the first filter is the one it selects.
      filters: {
        'Documents and images': ['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'xlsx', 'pptx', 'csv', 'json', 'yaml', 'yml',
          'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
        'All files': ['*']
      }
    });
    if (!selected?.length || this.disposed) return;
    const previous = replaceIndex === null ? null : this.form.storyAttachments[replaceIndex];
    const drafts: StoryAttachmentDraft[] = selected.map((uri) => ({
      sourcePath: uri.fsPath,
      displayName: path.basename(uri.fsPath),
      name: suggestedStoryDocumentName(uri.fsPath),
      // A replaced file keeps the storage and phases chosen for its slot.
      ...(previous ? { store: previous.store, phases: previous.phases } : {})
    })).filter((entry) => Boolean(entry.sourcePath && entry.displayName));
    if (!drafts.length) return;

    const merged = mergeStoryAttachments(this.form.storyAttachments, drafts, replaceIndex);
    if (merged.duplicates || merged.overflow) {
      const messages = [
        ...(merged.duplicates ? [`${merged.duplicates} duplicate document selection${merged.duplicates === 1 ? ' was' : 's were'} ignored.`] : []),
        ...(merged.overflow ? [`Only four Story documents can be attached; ${merged.overflow} selection${merged.overflow === 1 ? ' was' : 's were'} not added.`] : [])
      ];
      void vscode.window.showWarningMessage(messages.join(' '));
    }
    this.update({ storyAttachments: merged.attachments, enhanceError: null, error: null });
  }

  private renameStoryAttachment(message: InboundMessage, render: boolean): void {
    const index = this.attachmentIndex(message);
    const value = typeof message.value === 'string' ? message.value.slice(0, 512) : null;
    const current = index === null ? null : this.form.storyAttachments[index];
    if (index === null || value === null || !current) return;
    const storyAttachments = this.form.storyAttachments.map((entry, slot) => slot === index && entry ? { ...entry, name: value } : entry);
    if (render) this.update({ storyAttachments, error: null });
    else this.form.storyAttachments = storyAttachments;
  }

  private replaceReference(index: number, entry: ReferenceRepositoryDraft, render = true, background = false): void {
    const references = this.form.referenceRepositories.map((current, row) => row === index ? entry : current);
    if (render) this.update({ referenceRepositories: references, error: null }, { background });
    else this.form.referenceRepositories = references;
  }

  /**
   * Check a completed reference row once typing pauses, which also fetches its pinned commit into
   * the machine-local reference store so Start can copy it instead of transferring it. `[perf]`
   */
  private scheduleReferencePrefetch(index: number): void {
    const pending = this.referencePrefetchTimers.get(index);
    if (pending) clearTimeout(pending);
    this.referencePrefetchTimers.set(index, setTimeout(() => {
      this.referencePrefetchTimers.delete(index);
      const draft = this.form.referenceRepositories[index];
      if (this.disposed || !draft || draft.status === 'checking' || draft.status === 'ready') return;
      try {
        if (!referenceRepositoryEntries([draft]).length) return;
      } catch { return; }
      void this.checkReference({ type: 'referenceCheck', index } as InboundMessage, { background: true });
    }, INTAKE_REFERENCE_PREFETCH_DEBOUNCE_MS));
  }

  /** Keep typing local to one row; the engine remains the authority for URL/ref validation. */
  private updateReferenceDraft(message: InboundMessage, render: boolean): void {
    const index = this.referenceIndex(message);
    const field = stringField(message, 'field');
    const value = typeof message.value === 'string' ? message.value : null;
    const referenceField = field === 'id' || field === 'repository' || field === 'branch' ? field : null;
    if (index === null || value === null || !referenceField) return;
    const current = this.form.referenceRepositories[index];
    if (!current) return;
    this.replaceReference(index, {
      ...current,
      [referenceField]: value,
      status: 'idle', commit: null, message: null
    }, render);
    // A completed row changes the request an intake receipt must bind.
    this.scheduleIdentifierPreflight();
    this.scheduleReferencePrefetch(index);
  }

  /** Read-only provisional check. Story start resolves the branch again before creating state. */
  private async checkReference(message: InboundMessage, { background = false }: { background?: boolean } = {}): Promise<void> {
    const index = this.referenceIndex(message);
    if (index === null) return;
    const draft = this.form.referenceRepositories[index];
    if (!draft) return;
    let reference: { id: string; repository: string; branch: string };
    try {
      const parsed = referenceRepositoryEntries([draft]);
      const resolved = parsed[0];
      if (!resolved) throw new Error('Enter a reference ID, Git clone URL, and branch.');
      reference = resolved;
    } catch (error) {
      this.replaceReference(index, {
        ...draft, status: 'error', commit: null, message: (error as Error).message
      });
      return;
    }
    // A result belongs to the row only while that row still names the same reference. A global
    // revision used to drop it whenever any other row was edited, leaving this one checking forever.
    const unchanged = (current: ReferenceRepositoryDraft | undefined): current is ReferenceRepositoryDraft =>
      Boolean(current) && current!.id === reference.id && current!.repository === reference.repository
        && current!.branch === reference.branch;
    this.replaceReference(index, { ...draft, status: 'checking', commit: null, message: null }, true, background);
    try {
      const result = await this.client.run<{
        repositories?: Array<{ id?: string; commit?: string }>;
      }>([
        'story', 'references', 'inspect',
        '--reference-repository', `${reference.id}=${reference.repository}`,
        '--reference-branch', `${reference.id}=${reference.branch}`,
        '--prefetch', '--json'
      ]);
      const current = this.form.referenceRepositories[index];
      if (!unchanged(current)) return;
      const resolved = result.repositories?.find((entry) => entry.id === reference.id);
      if (!resolved?.commit) throw new Error('The read-only check returned no pinned commit.');
      this.replaceReference(index, {
        ...current, status: 'ready', commit: resolved.commit, message: null
      }, true, background);
    } catch (error) {
      const current = this.form.referenceRepositories[index];
      if (!unchanged(current)) return;
      this.replaceReference(index, {
        ...current, status: 'error', commit: null, message: (error as Error).message
      }, true, background);
    }
  }

  /**
   * Ask the engine to re-fetch every required base and dry-run the exact Story destination. The
   * version prevents a slow answer for an earlier branch or identifier from enabling Start.
   */
  private async preflightBaseBranch(): Promise<void> {
    this.cancelBasePreflight();
    const command = storyPreflightCommand(this.form);
    if (!command) return;
    const base = this.form.baseBranch;
    const version = ++this.preflightVersion;
    const controller = new AbortController();
    this.preflightController = controller;
    this.preflightKey = JSON.stringify(command);
    this.update({ ...emptyStoryPreflight(), basePreflightChecking: true }, { background: true });
    try {
      const result = await this.client.run<{
        preflight?: {
          passed?: boolean; readiness?: StoryStartReadinessResult;
          testReadiness?: PreflightTestReadiness;
          testRecovery?: PreflightTestRecovery;
          intakeReceipt?: { issued?: boolean; id?: string; expiresAt?: string; reason?: string };
        };
        intake?: EngineStoryWorkflowCatalog;
      }>(command, controller.signal);
      if (version !== this.preflightVersion) return;
      const testRecovery = result.preflight?.testRecovery?.schemaVersion === 1
        ? result.preflight.testRecovery : null;
      // Capability discovery is read-only. Once advertised, request the explicit choice tuple
      // before a confirmable plan can be shown. No tests are executed by this preview request.
      if (testRecovery?.enabled === true && !command.includes('--test-baseline-disposition')) {
        this.update({ testRecovery, testRecoveryConfirmedDigest: null }, { background: true });
        return this.preflightBaseBranch();
      }
      const readiness = result.preflight?.readiness;
      if (Array.isArray(result.intake?.storyWorkflows)) this.exactCatalogBase = base;
      // The selected remote base, not the launch checkout, owns a legacy workflow catalog. Replace
      // the choices with the exact-base response before interpreting readiness. If the previous
      // choice does not exist there, clear it and require a visible user selection.
      const exactCatalog = storyWorkflowCatalog(result.intake);
      const exactBaseWorkflows = exactCatalog.installed;
      const catalogReturned = Array.isArray(result.intake?.storyWorkflows);
      const exactWorkType = catalogReturned
        ? storyWorkflowSelection(this.form.workType, exactBaseWorkflows)
        : this.form.workType;
      const warnings = (readiness?.warnings ?? [])
        .map((entry) => entry.message?.trim())
        .filter((message): message is string => Boolean(message));
      const refreshRecommended = configurationRefreshRelevant(readiness);
      if (!result.preflight?.passed || !readiness || readiness.ready === false
          || exactWorkType === null) {
        this.update({
          ...(catalogReturned ? {
            storyWorkflows: exactBaseWorkflows,
            availableStoryWorkflows: exactCatalog.available,
            workflowCatalogReason: result.intake?.workflowCatalogReason ?? null,
            workType: exactWorkType,
            workflowReason: exactWorkType === null
              ? 'Choose a Story workflow available on the selected base branch.' : null
          } : {}),
          basePreflightPassed: false, basePreflightChecking: false,
          basePreflightReason: exactWorkType === null
            ? 'Choose a Story workflow available on the selected base branch.'
            : readiness?.blockers?.find((entry) => entry.message)?.message
            ?? (readiness
              ? 'Story-start readiness did not return a passing result.'
              : 'The engine did not return Story-start readiness. Reload or update Singularity Flow before retrying.'),
          basePreflightWarnings: warnings,
          baseTestReadiness: result.preflight?.testReadiness ?? null,
          testRecovery,
          basePreflightRefreshRecommended: refreshRecommended
        }, { background: true });
        return;
      }
      this.update({
        ...(catalogReturned ? {
          storyWorkflows: exactBaseWorkflows,
          availableStoryWorkflows: exactCatalog.available,
          workflowCatalogReason: result.intake?.workflowCatalogReason ?? null,
          workType: exactWorkType, workflowReason: null
        } : {}),
        basePreflightPassed: true, basePreflightChecking: false, basePreflightReason: null,
        basePreflightWarnings: warnings,
        baseTestReadiness: result.preflight?.testReadiness ?? null,
        testRecovery,
        basePreflightRefreshRecommended: refreshRecommended
      }, { background: true });
      const receipt = result.preflight?.intakeReceipt;
      const expiresAt = receipt?.issued ? Date.parse(receipt.expiresAt ?? '') : Number.NaN;
      this.intakeReceipt = receipt?.issued && typeof receipt.id === 'string' && Number.isFinite(expiresAt)
        ? { id: receipt.id, expiresAt, key: JSON.stringify(command) } : null;
    } catch (error) {
      if (version !== this.preflightVersion) return;
      this.preflightKey = null;
      this.update({
        basePreflightPassed: false, basePreflightChecking: false,
        basePreflightReason: (error as Error).message,
        basePreflightWarnings: [], baseTestReadiness: null, basePreflightRefreshRecommended: false
      }, { background: true });
    } finally {
      if (this.preflightController === controller) this.preflightController = null;
    }
  }

  private async start(): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy.
    if (intakeProblems(this.form).length || this.form.busy || this.form.enhancing) return;
    if (this.client.repository !== this.form.targetRepository) {
      this.update({
        error: `The active repository changed to ${this.client.repository}. Close this form and start again so the target is explicit.`
      });
      return;
    }
    this.update({ busy: true, startStep: null, error: null, recoveryCommand: null, recoveryRouteCommand: null });

    // A receipt for exactly this request, with time left, lets Start verify instead of rediscover.
    // It is single-use either way, so the panel forgets it now.
    const receipt = this.intakeReceipt;
    this.intakeReceipt = null;
    const currentPreflight = storyPreflightCommand(this.form);
    const args = [
      ...intakeCommand(this.form),
      ...(receipt && currentPreflight && JSON.stringify(currentPreflight) === receipt.key
        && receipt.expiresAt - Date.now() >= INTAKE_RECEIPT_MINIMUM_REMAINING_MS
        ? ['--intake-receipt', receipt.id] : [])
    ];
    const navigation = this.form.shape === 'story' ? this.holdNavigation?.() ?? null : null;
    this.output.appendLine(`\n$ ${terminalCommand(
      this.client.repository,
      redactCliArgsForDisplay(args),
      process.platform,
      this.client.location
    )}`);
    try {
      type StartPayload = {
        id?: string;
        initiativeId?: string;
        workItem?: { id?: string };
        initiative?: { id?: string };
        reservation?: { id?: string };
        currentPhase?: string;
        repositoryPath?: string;
        publication?: Started['publication'];
        configuration?: Started['configuration'];
        intakeReceipt?: { status?: string; reason?: string | null; reused?: string[] };
      };
      // The engine reports each stage it enters; show it where the person is looking.
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${this.form.shape}…` },
        (progress) => this.client.run<StartPayload & { data?: StartPayload }>(args, undefined, {
          onProgress: (step) => {
            const label = startProgressLabel(step);
            if (!label || label === this.form.startStep) return;
            progress.report({ message: label });
            this.update({ startStep: label }, { background: true });
          }
        }));
      const payload = result.data ?? result;
      const verified = payload.intakeReceipt;
      if (verified?.status) {
        this.output.appendLine(verified.status === 'verified'
          ? `Story start confirmed the readiness check in one pass (reused: ${(verified.reused ?? []).join(', ') || 'nothing'}).`
          : `Story start ran its full checks: the intake receipt was ${verified.status}${verified.reason ? ` (${verified.reason})` : ''}.`);
      }
      // The identifier a local Epic minted is only knowable from what came back — and `epic start
      // --local --json` reports it as `initiativeId`, which was not among the names read here, so
      // the fallback produced the empty string and the new Epic was never selected.
      const id = payload.workItem?.id ?? payload.initiative?.id ?? payload.initiativeId
        ?? payload.reservation?.id ?? payload.id
        ?? (this.form.tracker === 'jira' ? this.form.key.trim() : this.form.id.trim());
      const shape = this.form.shape;
      this.dispose();
      await this.onStarted({
        shape, id, currentPhase: payload.currentPhase, repositoryPath: payload.repositoryPath,
        publication: payload.publication, configuration: payload.configuration
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.update({
        busy: false,
        error: failure instanceof CliTimeoutError ? failure.summary : failure.message,
        recoveryCommand: failure instanceof CliTimeoutError ? failure.terminalCommand : null,
        recoveryRouteCommand: failure instanceof CliTimeoutError
          ? `singularity-flow ${args.slice(0, 2).join(' ')}` : null
      });
    } finally {
      navigation?.release();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.holdWhileVisible(false);
    for (const timer of this.referencePrefetchTimers.values()) clearTimeout(timer);
    this.referencePrefetchTimers.clear();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.invalidateEnhancement();
    this.cancelBasePreflight();
    if (IntakePanel.current === this) IntakePanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
