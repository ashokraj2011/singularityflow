/**
 * The capability screen: what this organisation builds, and the policy each part is held to.
 *
 * Jira and teams live here rather than on a workspace because they are properties of the thing being
 * built, not of who has cloned what. A workspace is a local grouping; a capability outlives it.
 *
 * Editing goes through a reviewed proposal against the lead repository's `sflow/config` branch.
 * The engine validates the whole map before proposing it, so the screen cannot save a tree the
 * engine would reject and cannot bypass the organisation's configuration authority.
 */
import * as vscode from 'vscode';
import { bodyHtml, readEdits, SCRIPT } from './capability-page.ts';
import { buildCapabilityDashboard } from './capability-dashboard-model.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';

export type CapabilitiesMessage =
  | { type: 'create'; id: string; edits: Record<string, string> }
  | { type: 'save'; id: string; edits: Record<string, string> }
  | { type: 'remove'; id: string };

export class CapabilitiesPanel {
  private static current: CapabilitiesPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private selected: string | null = null;
  private adding: { parent: string | null } | null = null;
  private error: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: CapabilitiesMessage) => void
  ) {
    this.panel = panel;
    this.store = store;
    this.subscription = store.onDidChange(() => this.render());

    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void vscode.commands.executeCommand(navigation);

      const message = raw as { type?: unknown; id?: unknown; parent?: unknown; edits?: unknown };
      // Selecting and cancelling are the panel's own state; only the three that touch the map leave.
      if (message?.type === 'select' && typeof message.id === 'string') {
        this.selected = message.id;
        this.adding = null;
        this.error = null;
        return this.render();
      }
      if (message?.type === 'add') {
        this.adding = { parent: typeof message.parent === 'string' && message.parent ? message.parent : null };
        this.error = null;
        return this.render();
      }
      if (message?.type === 'cancel') {
        this.adding = null;
        return this.render();
      }
      if (message?.type === 'create') {
        const edits = readEdits(message.edits);
        const id = String((message.edits as Record<string, unknown> | undefined)?.id ?? '').trim();
        if (!id) return this.report('An identifier is required.');
        const hasCapabilities = Boolean(this.store.current.snapshot?.capabilityMap?.capabilities?.length);
        if (hasCapabilities && !edits.parent?.trim()) {
          return this.report('Choose the capability this belongs under. The map has one root and every new capability links beneath it.');
        }
        return onMessage({ type: 'create', id, edits });
      }
      if (message?.type === 'remove' && typeof message.id === 'string') {
        return onMessage({ type: 'remove', id: message.id });
      }
      if (message?.type === 'save' && typeof message.id === 'string') {
        return onMessage({ type: 'save', id: message.id, edits: readEdits(message.edits) });
      }
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: CapabilitiesMessage) => void
  ): CapabilitiesPanel {
    if (CapabilitiesPanel.current) {
      CapabilitiesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return CapabilitiesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.capabilities', 'Capabilities', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    CapabilitiesPanel.current = new CapabilitiesPanel(panel, store, onMessage);
    return CapabilitiesPanel.current;
  }

  /** Open on a capability, for a caller that already knows which one — the tree, clicking one. */
  focus(capabilityId: string): void {
    this.selected = capabilityId;
    this.adding = null;
    this.error = null;
    this.render();
  }

  /** Open on the form for a new capability under `parent`, or at the top when there is none. */
  beginAdd(parent: string | null): void {
    this.adding = { parent };
    this.selected = parent;
    this.error = null;
    this.render();
  }

  /** A refused edit reports the engine's own sentence on the screen that caused it. */
  report(error: string | null): void {
    this.error = error;
    this.render();
  }

  /** Called after an accepted edit, so the form closes and the new node is the one on screen. */
  settled(capabilityId: string): void {
    this.selected = capabilityId;
    this.adding = null;
    this.error = null;
    this.render();
  }

  private render(): void {
    const map = this.store.current.snapshot?.capabilityMap;
    const dashboard = buildCapabilityDashboard(this.store.current.snapshot);
    const token = nonce();
    this.panel.webview.html = page(
      'Capabilities',
      bodyHtml(
        map?.capabilities ?? [], this.selected, this.adding,
        this.error ?? map?.error ?? null, dashboard
      ),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    CapabilitiesPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
