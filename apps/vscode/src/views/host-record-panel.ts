/**
 * The panels behind `vscode.openInvestigation`, `vscode.openContextReceipt`, `vscode.openHandoff`
 * and `vscode.openProgress` (lazy panels runtime). `[INT:IFC-060]` `[INT:IFC-061]` `[INT:CON-130]`
 *
 * One panel per view, retargeted when opened again. Each read is a read: the CLI's `progress` and
 * `tokens report`, the kernel's `work.handoff`, or the investigation report this window's kernel
 * returned. No message from the page names a command or an argument: a button names one of the
 * routes the view model offered, and the panel runs that route's own command with its own
 * arguments. Every message carries the render it came from, and one from an older render is
 * ignored, so a click on a page that has since been replaced cannot act on the newer record.
 */
import * as vscode from 'vscode';
import type { GatewaySession } from '../gateway-session.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import {
  contextLedgerOf, contextReceiptView, failedView, handoffView, HOST_RECORD_ACTIONS, HOST_RECORD_SCRIPT, HOST_RECORD_STYLE,
  hostRecordHtml, hostRecordRequest, investigationView, loadingView, progressView, receiptGuidance,
  type HostRecordAction, type HostRecordRequest, type HostRecordView
} from './host-record-page.ts';

/** What only the extension knows: its CLI client, the attached Story and the gateway session. */
export interface HostRecordSources {
  /** A read through this window's CLI client; never a mutation. */
  readonly read: (argv: string[]) => Promise<unknown>;
  readonly currentWorkId: () => string | null;
  /** The session links and cards are received in: its kernel, and the investigations it kept. */
  readonly gateway: () => GatewaySession | null;
}

/**
 * The registered phrase that names `work.handoff` and nothing else, resolved with the work's ID.
 * The kernel then reads it like any other request: policy, binding and a signed read handle.
 */
const HANDOFF_PHRASE = 'handoff packet';
/** Likewise the phrase that names `problem.investigate`, with the symptom the person typed. */
const INVESTIGATE_PHRASE = 'investigate this bug';

export class HostRecordPanel implements vscode.Disposable {
  private static readonly panels = new Map<HostRecordAction, HostRecordPanel>();
  private readonly subscriptions: vscode.Disposable[] = [];
  // Plain fields, not parameter properties, so the module also loads where types are only stripped.
  private readonly action: HostRecordAction;
  private readonly panel: vscode.WebviewPanel;
  private request: HostRecordRequest;
  private sources: HostRecordSources;
  private model: HostRecordView;
  private renderId = '';
  private generation = 0;
  private disposed = false;
  /** Ask for a symptom on the next read: when nothing is kept (`empty`), or because the person asked. */
  private ask: 'empty' | 'always' | null = null;

  private constructor(action: HostRecordAction, panel: vscode.WebviewPanel, request: HostRecordRequest, sources: HostRecordSources) {
    this.action = action;
    this.panel = panel;
    this.request = request;
    this.sources = sources;
    this.model = loadingView(action, request);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      return this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or retarget) the one panel for this view and read its record fresh. */
  static show(action: HostRecordAction, request: unknown, sources: HostRecordSources): HostRecordPanel {
    const accepted = hostRecordRequest(action, request);
    // From the palette with nothing kept, the Investigation view asks what is failing.
    const ask = action === 'vscode.openInvestigation' && !accepted.investigationId ? 'empty' : null;
    const existing = HostRecordPanel.panels.get(action);
    if (existing && !existing.disposed) {
      existing.request = accepted;
      existing.sources = sources;
      existing.ask = ask;
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    const { viewType, title } = HOST_RECORD_ACTIONS[action];
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] });
    const created = new HostRecordPanel(action, panel, accepted, sources);
    created.ask = ask;
    HostRecordPanel.panels.set(action, created);
    void created.load();
    return created;
  }

  private readonly router = registerMessageRouter('singularityFlow.hostRecord', {
    'record.route': (message) => {
      if (stringField(message, 'renderId') !== this.renderId) return;
      const route = this.model.routes.find((entry) => entry.id === stringField(message, 'id'));
      if (!route) return;
      if (route.id === 'investigate') this.ask = 'always';
      if (!route.command) return this.load();
      return navigateTo(route.command, ...route.args);
    },
    'record.choose': (message) => {
      if (stringField(message, 'renderId') !== this.renderId) return;
      const choice = this.model.choice;
      const value = stringField(message, 'value');
      if (!choice || stringField(message, 'field') !== choice.field || !choice.options.some((option) => option.value === value)) return;
      this.request = hostRecordRequest(this.action, { ...this.request, [choice.field]: value });
      return this.load();
    }
  });

  /** Read the record now; only the latest of overlapping reads is shown. */
  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.model = loadingView(this.action, this.request);
    this.render();
    let model: HostRecordView;
    try {
      model = await this.read();
    } catch (error) {
      model = failedView(this.action, this.request, error, this.guidanceForFailure());
    }
    if (generation !== this.generation || this.disposed) return;
    this.model = model;
    this.render();
  }

  private workId(): string | null {
    return this.request.workId ?? this.sources.currentWorkId();
  }

  private guidanceForFailure(): string | null {
    const workId = this.workId();
    if (this.action === 'vscode.openInvestigation') return 'singularity-flow explain investigation';
    if (!workId) return null;
    if (this.action === 'vscode.openProgress') return `singularity-flow progress ${workId}`;
    if (this.action === 'vscode.openContextReceipt') return receiptGuidance(workId, null);
    return `singularity-flow status --work-id ${workId}`;
  }

  private async read(): Promise<HostRecordView> {
    const request = this.request;
    if (this.action === 'vscode.openInvestigation') {
      const session = this.sources.gateway();
      const kept = session?.investigations ?? null;
      const ask = this.ask;
      this.ask = null;
      if (session?.root && (ask === 'always' || (ask === 'empty' && !kept?.list().length))) {
        // A report it ran becomes this page's request; a cancelled question leaves the page as it was.
        const failed = await this.investigate(session);
        if (failed) return failed;
      }
      const all = kept?.list() ?? [];
      const id = this.request.investigationId ?? (all.length === 1 ? all[0]?.investigationId ?? null : null);
      return investigationView({ request: this.request, record: id ? kept?.get(id) ?? null : null, kept: all });
    }
    const workId = this.workId();
    if (this.action === 'vscode.openContextReceipt') {
      if (!workId) return contextReceiptView({ request, workId: null });
      const ledger = contextLedgerOf(await this.sources.read(['tokens', 'report', '--work-id', workId, '--json']));
      return contextReceiptView({ request, workId, ledger });
    }
    if (this.action === 'vscode.openProgress') {
      if (!workId) return progressView({ request, workId: null });
      return progressView({ request, workId, progress: await this.sources.read(['progress', workId, '--json']) });
    }
    if (!workId) return handoffView({ request, workId: null });
    const session = this.sources.gateway();
    if (!session?.root) {
      return failedView(this.action, request, new Error('No repository is selected, so the Story\'s records cannot be read.'),
        `singularity-flow status --work-id ${workId}`);
    }
    const { kernel } = session;
    const resolution = await kernel.resolve({
      utterance: HANDOFF_PHRASE, arguments: { workId, ...(request.workKind ? { workKind: request.workKind } : {}) }
    });
    const result = resolution?.kind === 'read' && resolution.next?.length === 1
      ? await kernel.read({ resolutionId: resolution.next[0].handle })
      : resolution;
    return handoffView({ request, workId, result });
  }

  /**
   * Ask what is failing, and run the same read `@sflow` or a result card would: `problem.investigate`
   * through this session's kernel, which keeps the report. Read-only and model-free; the words go to
   * the kernel as the symptom and nowhere else. Returns a view only when there is nothing to show.
   */
  private async investigate(session: GatewaySession): Promise<HostRecordView | null> {
    const symptom = (await vscode.window.showInputBox({
      title: 'Investigate a failure',
      prompt: 'What is failing? The investigation only reads this repository: nothing is changed, and no test or model runs.',
      ignoreFocusOut: true,
      validateInput: (value) => (!value.trim() ? 'Describe what is failing.' : value.length > 2000 ? 'Keep it under 2,000 characters.' : undefined)
    }))?.trim();
    if (!symptom) return null;
    const { kernel } = session;
    const resolution = await kernel.resolve({ utterance: INVESTIGATE_PHRASE, arguments: { symptom } });
    const result = resolution?.kind === 'read' && resolution.next?.length === 1
      ? await kernel.read({ resolutionId: resolution.next[0].handle })
      : resolution;
    const id = result?.data?.investigationId;
    if (typeof id === 'string' && session.investigations.get(id)) {
      this.request = hostRecordRequest(this.action, { ...this.request, investigationId: id });
      return null;
    }
    return failedView(this.action, {}, new Error(`The investigation did not return a report (${String(result?.why?.[0]?.code ?? result?.kind ?? 'no answer')}).`),
      'singularity-flow explain investigation');
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.renderId = nonce();
    this.panel.title = this.model.subtitle && this.model.state !== 'loading'
      ? `${this.model.title} · ${this.model.subtitle.split(' · ')[0]}` : this.model.title;
    this.panel.webview.html = page(this.model.title, hostRecordHtml(this.model, this.renderId),
      contentSecurityPolicy(this.panel.webview, token), token, HOST_RECORD_SCRIPT, { styles: HOST_RECORD_STYLE });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (HostRecordPanel.panels.get(this.action) === this) HostRecordPanel.panels.delete(this.action);
  }
}
