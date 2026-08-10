/**
 * The work-intake panel: the six ways work starts, behind one screen.
 *
 * Every value the page reports is treated as a claim. The shape, the tracker and the profile are
 * resolved against what the engine actually offers, so a page that posts a profile nobody configured
 * changes nothing.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, intakeProblems, INTAKE_SCRIPT, SHAPES,
  type InFlight, type IntakeForm, type ProfileChoice, type Shape, type Tracker
} from './intake-form.ts';
import { SingularityFlowClient } from '../cli/client.ts';

/** What was started, so the caller can take the reader straight to it. */
export interface Started {
  shape: Shape;
  id: string;
  currentPhase?: string;
}

export class IntakePanel {
  private static current: IntakePanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly output: vscode.OutputChannel;
  private readonly onStarted: (started: Started) => Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];
  private form: IntakeForm = { ...EMPTY_INTAKE_FORM };

  private constructor(
    panel: vscode.WebviewPanel,
    client: SingularityFlowClient,
    output: vscode.OutputChannel,
    onStarted: (started: Started) => Promise<void>
  ) {
    this.panel = panel;
    this.client = client;
    this.output = output;
    this.onStarted = onStarted;
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
  }

  static show(
    context: vscode.ExtensionContext,
    client: SingularityFlowClient,
    output: vscode.OutputChannel,
    onStarted: (started: Started) => Promise<void>
  ): IntakePanel {
    if (IntakePanel.current) {
      IntakePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return IntakePanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.intake', 'Start work', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    IntakePanel.current = new IntakePanel(panel, client, output, onStarted);
    return IntakePanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Start work', intakeHtml(this.form),
      contentSecurityPolicy(this.panel.webview, token), token, INTAKE_SCRIPT
    );
  }

  private update(changes: Partial<IntakeForm>): void {
    this.form = { ...this.form, ...changes };
    this.render();
  }

  /**
   * What the repository actually offers: its profiles, whether a tracker is
   * configured, and what is already under way.
   *
   * Each is separately best effort, so a temporarily unavailable tracker does not stop local work.
   */
  private async load(): Promise<void> {
    const [profiles, storyWorkflows, tracker, inFlight] = await Promise.all([
      this.profiles(), this.storyWorkflows(), this.tracker(), this.inFlight()
    ]);
    this.update({
      profiles,
      // Defaulted so the form is not blocked on a choice with one sensible answer, but still shown,
      // because it decides the phases for the life of the work.
      profile: profiles.find((entry) => entry.id === 'epic-planning')?.id ?? profiles[0]?.id ?? null,
      storyWorkflows: storyWorkflows.workflows,
      // `feature` is the familiar starter workflow. A repository with one workflow needs no extra
      // click; multiple custom workflows remain an explicit, visible choice in the form.
      workType: storyWorkflows.workflows.find((entry) => entry.id === 'feature')?.id
        ?? storyWorkflows.workflows[0]?.id ?? null,
      workflowReason: storyWorkflows.reason,
      jiraConfigured: tracker.configured,
      jiraReason: tracker.reason,
      // A tracker that is configured is almost always the one being used, so it leads — but "no
      // tracker" stays a real answer rather than a fallback.
      tracker: tracker.configured ? 'jira' : 'none',
      inFlight
    });
  }

  private async profiles(): Promise<ProfileChoice[]> {
    try {
      const listed = await this.client.run<{
        id?: string; label?: string; description?: string; phases?: string[];
      }[]>(['initiative', 'profiles', '--json']);
      return listed.filter((entry) => entry.id).map((entry) => ({
        id: entry.id!,
        label: entry.label ?? entry.id!,
        description: entry.description ?? '',
        phases: entry.phases ?? []
      }));
    } catch (error) {
      this.output.appendLine(`No delivery profiles could be read: ${(error as Error).message}`);
      return [];
    }
  }

  /** Story workflows come from workflow.yml through the engine's unified workflow catalog. */
  private async storyWorkflows(): Promise<{ workflows: ProfileChoice[]; reason: string | null }> {
    try {
      const listed = await this.client.run<{
        id?: string; label?: string; description?: string; phases?: string[]; governs?: string;
      }[]>(['workflow', 'list', '--json']);
      return {
        workflows: listed.filter((entry) => entry.id && entry.governs === 'story').map((entry) => ({
          id: entry.id!, label: entry.label ?? entry.id!, description: entry.description ?? '',
          phases: entry.phases ?? []
        })),
        reason: null
      };
    } catch (error) {
      const reason = `Could not load Story workflows: ${(error as Error).message}`;
      this.output.appendLine(reason);
      return { workflows: [], reason };
    }
  }

  /**
   * Whether a tracker is reachable, and — when it is not — why, in the engine's own words.
   *
   * `jira status` is the probe because it is the thing that fails: unconfigured, it refuses with a
   * message naming the exact environment variables to set. Reporting that verbatim is more use than
   * "not configured", which tells somebody they have a problem and not how to end it.
   */
  private async tracker(): Promise<{ configured: boolean; reason: string | null }> {
    try {
      await this.client.run<unknown>(['jira', 'status', '--json']);
      return { configured: true, reason: null };
    } catch (error) {
      return { configured: false, reason: (error as Error).message };
    }
  }

  /**
   * What is already started.
   *
   * Starting the same thing twice is the mistake this prevents, and it is only preventable if the
   * screen that starts things knows what has been started.
   */
  private async inFlight(): Promise<InFlight[]> {
    try {
      const snapshot = await this.client.run<{
        initiatives?: { id?: string; title?: string; status?: string; currentPhaseLabel?: string | null }[];
        workItems?: {
          id?: string; title?: string; status?: string; workType?: string; currentPhase?: string | null;
        }[];
      }>(['snapshot', '--json']);
      // The phase is the useful half of "in progress", so it is said when there is one.
      const where = (status?: string, phase?: string | null): string =>
        (phase ? `${status ?? 'in progress'} · ${phase}` : status ?? 'in progress');
      const completed = (status?: string): boolean => ['complete', 'completed'].includes(status?.toLowerCase() ?? '');
      const initiatives = (snapshot.initiatives ?? []).filter((entry) => entry.id).map((entry) => ({
        shape: 'initiative' as Shape,
        id: entry.id!,
        title: entry.title ?? entry.id!,
        status: where(entry.status, entry.currentPhaseLabel),
        completed: completed(entry.status)
      }));
      const items = (snapshot.workItems ?? []).filter((entry) => entry.id).map((entry) => ({
        shape: (entry.workType === 'epic' ? 'epic' : 'story') as Shape,
        id: entry.id!,
        title: entry.title ?? entry.id!,
        status: where(entry.status, entry.currentPhase),
        completed: completed(entry.status)
      }));
      return [...initiatives, ...items];
    } catch {
      return [];
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; field?: unknown; value?: unknown };
    if (typeof message?.type !== 'string') return;

    // Resolved against what exists rather than trusted: a page can post whatever it likes.
    if (message.type === 'shape') {
      const shape = SHAPES.find((entry) => entry.id === message.value);
      if (shape) this.update({ shape: shape.id, error: null });
      return;
    }
    if (message.type === 'tracker') {
      const tracker = message.value === 'jira' ? 'jira' : 'none';
      this.update({ tracker: tracker as Tracker, error: null });
      return;
    }
    if (message.type === 'profile') {
      const profile = this.form.profiles.find((entry) => entry.id === message.value);
      if (profile) this.update({ profile: profile.id, error: null });
      return;
    }
    if (message.type === 'workType') {
      const workflow = this.form.storyWorkflows.find((entry) => entry.id === message.value);
      if (workflow) this.update({ workType: workflow.id, error: null });
      return;
    }

    // A keystroke is recorded and nothing else: replacing the document under whoever is typing would
    // take the caret with it. The committed value arrives again as a field, and that one redraws.
    if ((message.type === 'draft' || message.type === 'field') && typeof message.value === 'string') {
      const field = String(message.field);
      const value = message.value;
      const writable = ['key', 'id', 'title', 'description', 'goal', 'acceptanceCriteria'];
      if (!writable.includes(field)) return;
      if (message.type === 'draft') {
        (this.form as unknown as Record<string, string>)[field] = value;
        return;
      }
      this.update({ [field]: value } as Partial<IntakeForm>);
      return;
    }

    if (message.type === 'start') await this.start();
  }

  private async start(): Promise<void> {
    // Re-checked here rather than trusted from the page: the disabled button is a courtesy.
    if (intakeProblems(this.form).length || this.form.busy) return;
    this.update({ busy: true, error: null });

    const args = intakeCommand(this.form);
    this.output.appendLine(`\n$ singularity-flow ${args.join(' ')}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Starting ${this.form.shape}…` },
        () => this.client.run<{
          id?: string;
          initiativeId?: string;
          workItem?: { id?: string };
          initiative?: { id?: string };
          reservation?: { id?: string };
          currentPhase?: string;
        }>(args));
      // The identifier a local Epic minted is only knowable from what came back — and `epic start
      // --local --json` reports it as `initiativeId`, which was not among the names read here, so
      // the fallback produced the empty string and the new Epic was never selected.
      const id = result.workItem?.id ?? result.initiative?.id ?? result.initiativeId
        ?? result.reservation?.id ?? result.id
        ?? (this.form.tracker === 'jira' ? this.form.key.trim() : this.form.id.trim());
      const shape = this.form.shape;
      this.dispose();
      await this.onStarted({ shape, id, currentPhase: result.currentPhase });
    } catch (error) {
      this.update({ busy: false, error: (error as Error).message });
    }
  }

  dispose(): void {
    IntakePanel.current = null;
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
