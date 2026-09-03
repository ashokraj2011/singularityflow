/**
 * The work-intake panel: the six ways work starts, behind one screen.
 *
 * Every value the page reports is treated as a claim. The shape, the tracker and the profile are
 * resolved against what the engine actually offers, so a page that posts a profile nobody configured
 * changes nothing.
 */
import * as vscode from 'vscode';
import {
  contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import {
  EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, intakeIdentifier, intakeProblems, INTAKE_SCRIPT, SHAPES,
  type BaseBranchChoice, type InFlight, type IntakeForm, type ProfileChoice, type Shape, type Tracker
} from './intake-form.ts';
import { SingularityFlowClient } from '../cli/client.ts';
import { CliTimeoutError, redactCliArgsForDisplay, terminalCommand } from '../cli/runner.ts';
import type { StartWizardProgress } from './start-wizard.ts';

/** What was started, so the caller can take the reader straight to it. */
export interface Started {
  shape: Shape;
  id: string;
  currentPhase?: string;
  repositoryPath?: string;
}

export interface IntakeTarget {
  workspace: string | null;
  repository: string;
  branch: string | null;
  inFlight: InFlight[];
  defaults?: IntakeDefaults;
  journey?: StartWizardProgress | null;
}

export interface IntakeDefaults {
  shape?: Shape | null;
  source?: 'jira' | 'github-issue' | 'manual' | null;
  workType?: string | null;
  summary?: string | null;
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
  private readonly inFlight: InFlight[];
  private readonly disposables: vscode.Disposable[] = [];
  private form: IntakeForm;
  private preflightVersion = 0;
  private preflightController: AbortController | null = null;
  private trackerChosen = false;
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
    this.form = {
      ...EMPTY_INTAKE_FORM,
      targetWorkspace: target.workspace,
      targetRepository: target.repository,
      targetBranch: target.branch,
      ...(this.defaults.shape ? { shape: this.defaults.shape } : {}),
      ...(this.defaults.source ? {
        tracker: this.defaults.source === 'github-issue' ? 'github'
          : this.defaults.source === 'jira' ? 'jira' : 'none'
      } : {}),
      ...(this.defaults.summary ? { title: this.defaults.summary } : {}),
      ...(this.defaults.workType ? { workType: this.defaults.workType } : {})
    };
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
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

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      this.journey ? 'Guided start' : 'Start work', intakeHtml(this.form, this.journey),
      contentSecurityPolicy(this.panel.webview, token), token, INTAKE_SCRIPT
    );
  }

  private update(changes: Partial<IntakeForm>): void {
    if (this.disposed) return;
    this.form = {
      ...this.form,
      ...(Object.hasOwn(changes, 'error') && changes.error === null ? { recoveryCommand: null } : {}),
      ...changes
    };
    this.render();
  }

  private cancelBasePreflight(): void {
    this.preflightController?.abort();
    this.preflightController = null;
  }

  /**
   * What the repository actually offers, resolved by one governed engine command.
   *
   * The Store already owns the fresh lifecycle projection used for `inFlight`. Profiles, installed
   * Story workflows and remote base branches share this aggregate process; Jira is an optional
   * network integration and is probed only after the local form can render.
   */
  private async load(): Promise<void> {
    try {
      const listed = await this.client.run<{
        choices?: BaseBranchChoice[];
        remote?: string;
        unreachable?: { repository: string }[];
        intake?: {
          profiles?: { id?: string; label?: string; description?: string; phases?: string[] }[];
          profileReason?: string | null;
          storyWorkflows?: {
            id?: string; label?: string; description?: string; phases?: string[]; governs?: string;
            installed?: boolean;
          }[];
          workflowReason?: string | null;
        };
      }>(['workspace', 'branches', '--json', '--intake']);
      const profiles: ProfileChoice[] = (listed.intake?.profiles ?? []).filter((entry) => entry.id).map((entry) => ({
        id: entry.id!,
        label: entry.label ?? entry.id!,
        description: entry.description ?? '',
        phases: entry.phases ?? []
      }));
      const storyWorkflows: ProfileChoice[] = (listed.intake?.storyWorkflows ?? []).filter((entry) =>
        entry.id && entry.governs === 'story' && entry.installed !== false).map((entry) => ({
        id: entry.id!, label: entry.label ?? entry.id!, description: entry.description ?? '',
        phases: entry.phases ?? []
      }));
      const unreachable = listed.unreachable ?? [];
      if (listed.intake?.profileReason) {
        this.output.appendLine(`No delivery profiles could be read: ${listed.intake.profileReason}`);
      }
      this.update({
        profiles,
        // Defaulted so the form is not blocked on a choice with one sensible answer, but still
        // shown, because it decides the phases for the life of the work.
        profile: profiles.find((entry) => entry.id === 'epic-planning')?.id ?? profiles[0]?.id ?? null,
        storyWorkflows,
        // `feature` is the familiar starter workflow. A repository with one workflow needs no extra
        // click; multiple custom workflows remain an explicit, visible choice in the form.
        workType: storyWorkflows.find((entry) => entry.id === this.defaults.workType)?.id
          ?? storyWorkflows.find((entry) => entry.id === 'feature')?.id
          ?? storyWorkflows[0]?.id ?? null,
        workflowReason: listed.intake?.workflowReason
          ? `Could not load Story workflows: ${listed.intake.workflowReason}` : null,
        baseBranchChoices: (listed.choices ?? []).filter((choice) => choice.everywhere),
        // A Story base is an explicit, permanent choice. Even one available branch must be selected.
        baseBranch: null,
        baseRemote: listed.remote ?? null,
        // Named, because a branch missing from the list because a remote was unreachable looks
        // exactly like a branch that does not exist.
        baseBranchReason: unreachable.length
          ? `Could not read ${unreachable.map((entry) => entry.repository).join(', ')}. Remote access is required before starting a Story.`
          : null,
        basePreflightPassed: false,
        basePreflightChecking: false,
        basePreflightReason: null,
        githubConfigured: true,
        githubReason: null,
        inFlight: this.inFlight
      });
    } catch (error) {
      const reason = (error as Error).message;
      this.output.appendLine(`Intake catalog could not be read: ${reason}`);
      this.update({
        profiles: [], profile: null, storyWorkflows: [], workType: null,
        workflowReason: `Could not load Story workflows: ${reason}`,
        baseBranchChoices: [], baseBranch: null, baseRemote: null, baseBranchReason: reason,
        basePreflightPassed: false, basePreflightChecking: false, basePreflightReason: null,
        inFlight: this.inFlight
      });
    }
    // Jira is an optional external integration. Do not make its cold process or network probe part
    // of the form's critical path; its result updates only the tracker controls when it arrives.
    void this.loadTracker();
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
    if (!this.trackerChosen) {
      selection = this.defaults.source === 'github-issue' ? 'github'
        : this.defaults.source === 'manual' ? 'none'
          : tracker.configured ? 'jira' : 'none';
    }
    this.update({
      jiraConfigured: tracker.configured,
      jiraReason: tracker.reason,
      tracker: selection
    });
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
  private static readonly WRITABLE = Object.freeze(['key', 'id', 'title', 'description', 'goal', 'acceptanceCriteria', 'targetUrl']);

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
    shape: (message) => {
      const shape = SHAPES.find((entry) => entry.id === stringField(message, 'value'));
      if (shape) {
        this.cancelBasePreflight();
        this.preflightVersion += 1;
        this.update({
          shape: shape.id, error: null,
          basePreflightPassed: false, basePreflightChecking: false, basePreflightReason: null
        });
      }
    },
    tracker: (message) => {
      const value = stringField(message, 'value');
      const tracker = value === 'jira' ? 'jira' : value === 'github' ? 'github' : 'none';
      this.trackerChosen = true;
      this.preflightVersion += 1;
      this.update({
        tracker: tracker as Tracker, error: null,
        basePreflightPassed: false, basePreflightChecking: false, basePreflightReason: null
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
          basePreflightPassed: false, basePreflightChecking: false, basePreflightReason: null
        });
        return this.preflightBaseBranch();
      }
    },
    workType: (message) => {
      const workflow = this.form.storyWorkflows.find((entry) => entry.id === stringField(message, 'value'));
      if (workflow) this.update({ workType: workflow.id, error: null });
    },
    draft: (message) => {
      const field = this.writableField(message);
      const value = stringField(message, 'value');
      if (field && value !== null) (this.form as unknown as Record<string, string>)[field] = value;
    },
    field: (message) => {
      const field = this.writableField(message);
      const value = stringField(message, 'value');
      if (field && value !== null) {
        const invalidatesPreflight = field === 'id' || field === 'key';
        if (invalidatesPreflight) this.preflightVersion += 1;
        this.update({
          [field]: value,
          ...(invalidatesPreflight ? {
            basePreflightPassed: false, basePreflightChecking: false, basePreflightReason: null
          } : {})
        } as Partial<IntakeForm>);
        if (invalidatesPreflight) return this.preflightBaseBranch();
      }
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

  /**
   * Ask the engine to re-fetch every required base and dry-run the exact Story destination. The
   * version prevents a slow answer for an earlier branch or identifier from enabling Start.
   */
  private async preflightBaseBranch(): Promise<void> {
    this.cancelBasePreflight();
    const storyId = intakeIdentifier(this.form);
    const branch = this.form.baseBranch;
    if (this.form.shape !== 'story' || !storyId || !branch) return;
    const version = ++this.preflightVersion;
    const controller = new AbortController();
    this.preflightController = controller;
    this.update({ basePreflightPassed: false, basePreflightChecking: true, basePreflightReason: null });
    try {
      const result = await this.client.run<{ preflight?: { passed?: boolean } }>([
        'workspace', 'branches', '--json', '--preflight-story', storyId,
        '--from-branch', branch
      ], controller.signal);
      if (version !== this.preflightVersion) return;
      if (!result.preflight?.passed) {
        this.update({
          basePreflightPassed: false, basePreflightChecking: false,
          basePreflightReason: 'The remote publication preflight did not return a passing result.'
        });
        return;
      }
      this.update({
        basePreflightPassed: true, basePreflightChecking: false, basePreflightReason: null
      });
    } catch (error) {
      if (version !== this.preflightVersion) return;
      this.update({
        basePreflightPassed: false, basePreflightChecking: false,
        basePreflightReason: (error as Error).message
      });
    } finally {
      if (this.preflightController === controller) this.preflightController = null;
    }
  }

  private async start(): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy.
    if (intakeProblems(this.form).length || this.form.busy) return;
    if (this.client.repository !== this.form.targetRepository) {
      this.update({
        error: `The active repository changed to ${this.client.repository}. Close this form and start again so the target is explicit.`
      });
      return;
    }
    this.update({ busy: true, error: null, recoveryCommand: null });

    const args = intakeCommand(this.form);
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
      };
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${this.form.shape}…` },
        () => this.client.run<StartPayload & { data?: StartPayload }>(args));
      const payload = result.data ?? result;
      // The identifier a local Epic minted is only knowable from what came back — and `epic start
      // --local --json` reports it as `initiativeId`, which was not among the names read here, so
      // the fallback produced the empty string and the new Epic was never selected.
      const id = payload.workItem?.id ?? payload.initiative?.id ?? payload.initiativeId
        ?? payload.reservation?.id ?? payload.id
        ?? (this.form.tracker === 'jira' ? this.form.key.trim() : this.form.id.trim());
      const shape = this.form.shape;
      this.dispose();
      await this.onStarted({
        shape, id, currentPhase: payload.currentPhase, repositoryPath: payload.repositoryPath
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.update({
        busy: false,
        error: failure instanceof CliTimeoutError ? failure.summary : failure.message,
        recoveryCommand: failure instanceof CliTimeoutError ? failure.terminalCommand : null
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelBasePreflight();
    if (IntakePanel.current === this) IntakePanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
