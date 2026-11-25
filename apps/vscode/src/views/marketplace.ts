/**
 * Marketplace [owner, 2026-11-25]: the panel that shows `marketplace catalog --json` (marketplace-page.ts). The engine
 * reads; this view shows its answer, and each button opens Workflow Studio's own route for that row (studioTargetFor):
 * the import preview, an agent's conversion review, Studio's Delete or Remove, or a workflow's Archive or Restore. The
 * change itself is published from Studio as a reviewed proposal; nothing here writes configuration. A page message names
 * a row by its key, found here in the engine's own answer. Coming back to the page after a button reads it again.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { MARKETPLACE_SCRIPT, MARKETPLACE_STYLE, marketplaceCatalogFrom, marketplacePageHtml, studioTargetFor, type MarketplaceAct, type MarketplaceCatalog } from './marketplace-page.ts';

const errorText = (error: unknown): string => (error as Error)?.message ?? String(error);

export class MarketplacePanel implements vscode.Disposable {
  private static current: MarketplacePanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private catalog: MarketplaceCatalog | null = null;
  private busy = false;
  private error: string | null = null;
  private notice: string | null = null;
  /** A button sent the person to Workflow Studio: the page is read again when they come back to it. */
  private stale = false;
  private disposed = false;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidChangeViewState(() => {
      if (this.panel.visible && this.stale) { this.stale = false; this.notice = null; void this.load(); }
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open (or reveal) the Marketplace and read it fresh. */
  static show(client: SingularityFlowClient): MarketplacePanel {
    const existing = MarketplacePanel.current;
    if (existing && existing.client === client) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.marketplace', 'Marketplace', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    MarketplacePanel.current = new MarketplacePanel(panel, client);
    void MarketplacePanel.current.load();
    return MarketplacePanel.current;
  }

  private router = registerMessageRouter('singularityFlow.marketplace', {
    'marketplace.refresh': () => this.load(),
    'marketplace.install': (message) => this.act('install', stringField(message, 'key')),
    'marketplace.update': (message) => this.act('update', stringField(message, 'key')),
    'marketplace.remove': (message) => this.act('remove', stringField(message, 'key')),
    'marketplace.open': (message) => this.act('open', stringField(message, 'key')),
    'marketplace.approve': (message) => this.act('approve', stringField(message, 'key')),
    'marketplace.allSkills': () => vscode.commands.executeCommand('singularityFlow.allSkills'),
    'marketplace.studio': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'library' })
  });

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const catalog = marketplaceCatalogFrom(await this.client.run(['marketplace', 'catalog', '--json']));
      if (!catalog) throw new Error("The marketplace items could not be read from the engine's answer.");
      this.catalog = catalog;
      this.error = null;
    } catch (error) {
      this.error = errorText(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** A row's button: Workflow Studio's own route for it, found from the engine's row, never from the page. */
  private async act(act: MarketplaceAct, key: string | null): Promise<void> {
    const item = key ? this.catalog?.items.find((entry) => entry.key === key) ?? null : null;
    const target = item ? studioTargetFor(act, item) : null;
    if (!target) return;
    if (act !== 'open') { this.stale = true; this.notice = target.notice || null; this.render(); }
    await vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', target.studio);
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    this.panel.webview.html = page('Marketplace', marketplacePageHtml({ catalog: this.catalog, busy: this.busy, error: this.error, notice: this.notice }),
      contentSecurityPolicy(this.panel.webview, token), token, MARKETPLACE_SCRIPT, { styles: MARKETPLACE_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    if (MarketplacePanel.current === this) MarketplacePanel.current = null;
    while (this.subscriptions.length) this.subscriptions.pop()?.dispose();
  }
}
