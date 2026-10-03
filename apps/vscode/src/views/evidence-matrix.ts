/**
 * The Evidence Matrix panel: every requirement and acceptance criterion of the active Story as one
 * row of obligations, with the completion label and lifecycle words exactly as the engine states
 * them [E2G-029]. It reads `singularity-flow evidence matrix --json` once per refresh and changes
 * nothing; selecting a row opens its obligations, what needs attention and how to act on it.
 */
import * as vscode from 'vscode';
import { evidenceView, type EvidenceView } from './evidence-matrix-model.ts';
import { EVIDENCE_MATRIX_SCRIPT, evidenceMatrixHtml } from './evidence-matrix-page.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { commandData } from './surface-adapters.ts';

export class EvidenceMatrixPanel {
  private static current: EvidenceMatrixPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private view: EvidenceView | null = null;
  private error: string | null = null;
  private selected: string | null = null;
  private reloadRevision = 0;
  private reloadPending = false;

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    // The matrix is re-read whenever the Story changes, so it never describes an older moment.
    this.subscription = store.onDidChange((_state, change) => {
      if (change.kind !== 'snapshot' || !change.revisionChanged) return;
      if (this.panel.visible === false) { this.reloadPending = true; return; }
      void this.reload();
    });
    const messages = registerMessageRouter('singularityFlow.evidenceMatrix', {
      navigate: (raw) => {
        const navigation = navigationTarget(raw);
        if (navigation) void navigateTo(navigation);
      },
      // The row is looked up in what this panel loaded, never taken from the page.
      select: (message) => {
        const id = stringField(message, 'id');
        if (!id || !this.view?.rows.some((row) => row.id === id)) return;
        this.selected = id;
        this.render();
      },
      refresh: () => void this.reload()
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => messages.route(raw), null, this.disposables);
    this.panel.onDidChangeViewState?.(({ webviewPanel }) => {
      if (webviewPanel.visible === false || !this.reloadPending) return;
      this.reloadPending = false;
      void this.reload();
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.reload();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient
  ): EvidenceMatrixPanel {
    if (EvidenceMatrixPanel.current) {
      EvidenceMatrixPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return EvidenceMatrixPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.evidenceMatrix', 'Evidence Matrix', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    EvidenceMatrixPanel.current = new EvidenceMatrixPanel(panel, store, client);
    return EvidenceMatrixPanel.current;
  }

  private async reload(): Promise<void> {
    const revision = ++this.reloadRevision;
    // Without an active Story there is nothing to evaluate; say so rather than call the CLI.
    if (!this.store.current.snapshot?.workflow) {
      this.view = null;
      this.error = 'Open a Story to see its evidence matrix.';
      this.render();
      return;
    }
    try {
      const result = await this.client.run<unknown>(['evidence', 'matrix', '--json', '--page-size', '500']);
      if (revision !== this.reloadRevision) return;
      const view = evidenceView({ data: commandData<unknown>(result) });
      this.view = view;
      this.error = view ? null : 'The evidence matrix returned a shape this panel does not read.';
      if (this.selected && !view?.rows.some((row) => row.id === this.selected)) this.selected = null;
    } catch (failure) {
      if (revision !== this.reloadRevision) return;
      this.view = null;
      this.error = `The evidence matrix could not be read: ${failure instanceof Error ? failure.message : String(failure)}`;
    }
    this.render();
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Evidence Matrix',
      evidenceMatrixHtml(this.view, this.selected, this.error, token),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      EVIDENCE_MATRIX_SCRIPT
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (EvidenceMatrixPanel.current === this) EvidenceMatrixPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
