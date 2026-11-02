/**
 * SF Guard in VS Code: the Guard page, the sign card, and the Story standing the Story, approval and
 * review views show. [SPEC-PSS-v1 M5, AC-014] [SPEC-SFG-v1 G5, AC-012]
 *
 * Every read is the CLI's own `--json` answer (`guard status`, `guard report`, `approvals`). The sign
 * card never signs: a person step the CLI refused for want of a terminal (`PSS_CARD_NOT_SHOWN`, before
 * anything was written) is shown as a card, and only the person's click opens their own terminal with
 * the same command, where the CLI prints its card and Touch ID prompts. No model, tool or message from
 * Copilot reaches that click, so agents stay refused, as the CLI refuses them too.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { terminalCommand } from '../cli/runner.ts';
import { createTerminalIn } from '../terminal-start.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  guardRemoteCheckArgv, guardReportArgv, guardReportFrom, guardStatusArgv, guardStatusFrom, signRequestFrom, storyApprovalsArgv,
  storyPinsSfGuard, storyStandingFrom, storyStandingKey, SF_GUARD_FIRST_RUN_KEY, SF_GUARD_RECIPE_PATH,
  type GuardReport, type GuardStatus, type SignRequest, type StoryStanding
} from './sf-guard-model.ts';
import {
  guardPageHtml, GUARD_SCRIPT, SF_GUARD_STYLE, signCardHtml, SIGN_CARD_SCRIPT, type GuardPageView, type SignCardView, type StoryRead
} from './sf-guard-page.ts';

export interface SfGuardHooks {
  /** This machine's VS Code state, where the first-run card's dismissal is kept. */
  memento: Pick<vscode.Memento, 'get' | 'update'>;
  output?: { appendLine(line: string): void };
  /** Refresh every view after the person signed in their terminal. */
  refresh?: () => Promise<unknown>;
}

const errorText = (error: unknown): string => (error as Error)?.message ?? String(error);

/** A Story's standing, read once per change of its approvals or submissions, and shared by the views that show it. */
export class SfGuardStandings implements vscode.Disposable {
  private readonly cache = new Map<string, { key: string; value: StoryRead }>();
  private readonly changed = new vscode.EventEmitter<string>();
  readonly onDidChange = this.changed.event;
  private readonly client: () => SingularityFlowClient | null;

  constructor(client: () => SingularityFlowClient | null) {
    this.client = client;
  }

  /** The standing for `workflow`, or null when its Story did not pin SF Guard (nothing is read then). */
  standing(workflow: unknown): StoryRead | null {
    if (!storyPinsSfGuard(workflow)) return null;
    const key = storyStandingKey(workflow);
    const client = this.client();
    if (!key || !client) return null;
    const workId = (workflow as { workItem: { id: string } }).workItem.id;
    const cacheKey = `${client.repository}\0${workId}`;
    const cached = this.cache.get(cacheKey);
    if (cached?.key === key) return cached.value;
    this.cache.set(cacheKey, { key, value: 'loading' });
    void Promise.all([client.run(storyApprovalsArgv(workId)), client.run(guardReportArgv({ story: workId }))])
      .then(([approvals, report]) => storyStandingFrom(workId, approvals, report) as StoryRead, (error) => ({ error: errorText(error) }))
      .then((value) => {
        if (this.cache.get(cacheKey)?.key !== key) return;
        this.cache.set(cacheKey, { key, value });
        this.changed.fire(workId);
      });
    return 'loading';
  }

  /** The standing if already read, for a page that reads it alongside its own data. */
  async read(workflow: unknown): Promise<StoryStanding | null> {
    const first = this.standing(workflow);
    if (!first || (first !== 'loading' && 'error' in first)) return null;
    if (first !== 'loading') return first;
    return new Promise((resolve) => {
      const subscription = this.onDidChange(() => {
        const next = this.standing(workflow);
        if (next === 'loading') return;
        subscription.dispose();
        resolve(next && !('error' in next) ? next : null);
      });
    });
  }

  dispose(): void {
    this.changed.dispose();
    this.cache.clear();
  }
}

export class SfGuardPanel implements vscode.Disposable {
  private static current: SfGuardPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private status: GuardStatus | null = null;
  private report: GuardReport | null = null;
  private stories: Record<string, StoryRead> = {};
  private recipe: GuardPageView['recipe'] = null;
  private error: string | null = null;
  private notice: string | null = null;
  private busy = false;
  private showFirstRun: boolean;
  private disposed = false;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private hooks: SfGuardHooks;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient, hooks: SfGuardHooks) {
    this.panel = panel;
    this.client = client;
    this.hooks = hooks;
    this.showFirstRun = !hooks.memento.get<boolean>(SF_GUARD_FIRST_RUN_KEY, false);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or reveal) the Guard page and read it fresh. */
  static show(client: SingularityFlowClient, hooks: SfGuardHooks): SfGuardPanel {
    const existing = SfGuardPanel.current;
    if (existing && existing.client === client) {
      existing.hooks = hooks;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.sfGuard', 'SF Guard', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    SfGuardPanel.current = new SfGuardPanel(panel, client, hooks);
    void SfGuardPanel.current.load();
    return SfGuardPanel.current;
  }

  private router = registerMessageRouter('singularityFlow.sfGuard', {
    'guard.refresh': () => this.load(),
    'guard.story': (message) => this.story(stringField(message, 'workId')),
    'guard.recipe': () => this.readRecipe(),
    'guard.copy': (message) => this.copy(stringField(message, 'text')),
    'guard.firstRunSeen': async () => { this.showFirstRun = false; await this.hooks.memento.update(SF_GUARD_FIRST_RUN_KEY, true); this.render(); },
    'guard.firstRunShow': () => { this.showFirstRun = true; this.render(); }
  });

  /** `guard status` and `guard report`, read together; a failed read keeps the last answer on screen. */
  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const [status, report] = await Promise.all([this.client.run(guardStatusArgv()), this.client.run(guardReportArgv())]);
      this.status = guardStatusFrom(status);
      this.report = guardReportFrom(report);
      if (!this.status) throw new Error('SF Guard\'s status could not be read from the engine\'s answer.');
      this.stories = {};
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** One Story's labels step by step, and its decisions as SF Guard counts them. */
  private async story(workId: string | null): Promise<void> {
    if (!workId || !this.report?.subjects.some((subject) => subject.scope === workId)) return;
    this.stories = { ...this.stories, [workId]: 'loading' };
    this.render();
    try {
      const [approvals, report] = await Promise.all([
        this.client.run(storyApprovalsArgv(workId)).catch(() => null), this.client.run(guardReportArgv({ story: workId }))]);
      this.stories = { ...this.stories, [workId]: storyStandingFrom(workId, approvals, report) };
    } catch (error) {
      this.stories = { ...this.stories, [workId]: { error: errorText(error) } };
    }
    this.render();
  }

  /** The CI recipe `guard remote-check` prints: nothing is written. */
  private async readRecipe(): Promise<void> {
    try {
      const result = await this.client.run<{ recipe?: string; path?: string; incomplete?: boolean }>(guardRemoteCheckArgv());
      this.recipe = { path: result.path ?? SF_GUARD_RECIPE_PATH, text: result.recipe ?? '', incomplete: result.incomplete === true };
    } catch (error) {
      this.error = errorText(error);
    }
    this.render();
  }

  private async copy(value: string | null): Promise<void> {
    if (!value) return;
    await vscode.env.clipboard.writeText(value);
    void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const view: GuardPageView = { status: this.status, report: this.report, error: this.error, busy: this.busy, firstRun: this.showFirstRun,
      notice: this.notice, stories: this.stories, recipe: this.recipe };
    this.panel.webview.html = page('SF Guard', guardPageHtml(view), contentSecurityPolicy(this.panel.webview, token), token, GUARD_SCRIPT,
      { styles: SF_GUARD_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (SfGuardPanel.current === this) SfGuardPanel.current = null;
  }
}

export interface SignCardHooks extends SfGuardHooks {
  /** The client for the repository the step was refused in; the card refuses another repository's. */
  client: () => SingularityFlowClient | null;
}

/**
 * The sign card. Opened for a refusal the CLI gave a person step started without a terminal; its one
 * action opens the person's own terminal with that same command. Returns whether it took the refusal.
 */
export class SfGuardSignPanel implements vscode.Disposable {
  private static current: SfGuardSignPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private state: SignCardView['state'] = 'ready';
  private disposed = false;

  private readonly panel: vscode.WebviewPanel;
  private request: SignRequest;
  private hooks: SignCardHooks;

  private constructor(panel: vscode.WebviewPanel, request: SignRequest, hooks: SignCardHooks) {
    this.panel = panel;
    this.request = request;
    this.hooks = hooks;
    panel.webview.onDidReceiveMessage((raw: unknown) => void this.router.route(raw), null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  static fromRefusal(error: unknown, hooks: SignCardHooks): boolean {
    const request = signRequestFrom(error);
    if (!request) return false;
    SfGuardSignPanel.show(request, hooks);
    return true;
  }

  static show(request: SignRequest, hooks: SignCardHooks): SfGuardSignPanel {
    const existing = SfGuardSignPanel.current;
    if (existing) {
      existing.request = request; existing.hooks = hooks; existing.state = 'ready';
      existing.panel.reveal(vscode.ViewColumn.Active);
      existing.render();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.sfGuardSign', 'SF Guard · sign', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    SfGuardSignPanel.current = new SfGuardSignPanel(panel, request, hooks);
    SfGuardSignPanel.current.render();
    return SfGuardSignPanel.current;
  }

  private router = registerMessageRouter('singularityFlow.sfGuardSign', {
    'sign.terminal': () => this.openTerminal(),
    'sign.cancel': () => { this.hooks.output?.appendLine('SF Guard: not signed; nothing was written.'); this.panel.dispose(); },
    'sign.done': async () => { await this.hooks.refresh?.().catch(() => undefined); this.panel.dispose(); }
  });

  /** The person's own terminal, in the refused step's repository, with the same command. */
  private async openTerminal(): Promise<void> {
    const client = this.hooks.client();
    if (!client || client.repository !== this.request.repository) { this.state = 'stale'; return this.render(); }
    const terminal = createTerminalIn({
      name: `SF Guard · ${this.request.title}`,
      // The bundled engine runs as Node in the terminal, as every other terminal route here does.
      shellPath: process.platform === 'win32' ? 'powershell.exe' : undefined,
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }, this.request.repository);
    terminal.show(false);
    // Typed, not run: the person presses Enter themselves, so the command is one they started [PSS:REQ-012].
    terminal.sendText(terminalCommand(this.request.repository, this.request.args, process.platform, client.location), false);
    this.hooks.output?.appendLine(`SF Guard: ${this.request.title} typed into your terminal; press Enter there, read its card, then Touch ID asks.`);
    if (!this.hooks.memento.get<boolean>(SF_GUARD_FIRST_RUN_KEY, false)) await this.hooks.memento.update(SF_GUARD_FIRST_RUN_KEY, true);
    this.state = 'sent';
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const view: SignCardView = { request: this.request, firstRun: !this.hooks.memento.get<boolean>(SF_GUARD_FIRST_RUN_KEY, false), state: this.state };
    this.panel.webview.html = page('SF Guard · sign', signCardHtml(view), contentSecurityPolicy(this.panel.webview, token), token, SIGN_CARD_SCRIPT,
      { styles: SF_GUARD_STYLE, nav: false });
  }

  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (SfGuardSignPanel.current === this) SfGuardSignPanel.current = null;
  }
}
