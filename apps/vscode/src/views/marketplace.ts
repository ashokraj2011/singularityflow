/**
 * Marketplace [owner, 2026-11-25]: the panel that shows `marketplace catalog --json` (marketplace-page.ts). The engine
 * reads; this view shows its answer, and each button opens Workflow Studio's own route for that row (studioTargetFor):
 * the import preview, an agent's conversion review, Studio's Delete or Remove, or a workflow's Archive or Restore. The
 * change itself is published from Studio as a reviewed proposal; nothing here writes configuration. A page message names
 * a row by its key, found here in the engine's own answer. Coming back to the page after a button reads it again. Check
 * for newer versions reads the Git repository marketplaces' newest commits too (`--newest`); Get newer… opens Studio's
 * Read its newest commit for that marketplace, which queues trusting that commit. Open its lifecycle change opens the
 * reviewed change a row's lifecycle record names, in the browser (OMK §5.3).
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
  /**
   * The person asked to check for newer versions: this panel's reads also read each Git repository marketplace's newest
   * commit (`--newest`), a network read, until the page is opened again. Opening it never does.
   */
  private newest = false;
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
      existing.newest = false;
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
    'marketplace.newest': () => { this.newest = true; return this.load(); },
    'marketplace.trust': (message) => this.act('trust', stringField(message, 'key')),
    'marketplace.install': (message) => this.act('install', stringField(message, 'key')),
    'marketplace.update': (message) => this.act('update', stringField(message, 'key')),
    'marketplace.remove': (message) => this.act('remove', stringField(message, 'key')),
    'marketplace.open': (message) => this.act('open', stringField(message, 'key')),
    'marketplace.approve': (message) => this.act('approve', stringField(message, 'key')),
    'marketplace.openChange': (message) => this.openChange(stringField(message, 'key')),
    'marketplace.allSkills': () => vscode.commands.executeCommand('singularityFlow.allSkills'),
    'marketplace.studio': () => vscode.commands.executeCommand('singularityFlow.openWorkflowStudio', { view: 'library' })
  });

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.render();
    try {
      const catalog = marketplaceCatalogFrom(await this.client.run(['marketplace', 'catalog', ...(this.newest ? ['--newest'] : []), '--json']));
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

  /**
   * A row's lifecycle change, the reviewed pull request the marketplace recorded (OMK §4.2), opened in the person's
   * browser: found from the engine's row, and only an https address.
   */
  private async openChange(key: string | null): Promise<void> {
    const item = key ? this.catalog?.items.find((entry) => entry.key === key) ?? null : null;
    const change = item?.lifecycleRecord?.change ?? null;
    if (!change || !/^https:\/\/[^\s]+$/.test(change)) return;
    await vscode.env.openExternal(vscode.Uri.parse(change, true));
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
