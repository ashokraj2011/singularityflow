/**
 * The reconciliation panel: the four levels, and whether each one currently agrees.
 *
 * Reads the same shared snapshot as every other view, plus one extra call for the merge plan, which
 * `snapshot --json` does not carry. That call is made once per refresh rather than per
 * render, so opening the panel does not start a second conversation with the repository.
 */
import * as vscode from 'vscode';
import { buildReconciliation, type MergePlan, type Reconciliation, type ReconciliationLevel } from './reconciliation-model.ts';
import { contentSecurityPolicy, escape, nonce, page, icon } from './webview.ts';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';

const VERDICT_PILL: Record<string, { className: string; label: string }> = {
  aligned: { className: 'ok', label: 'aligned' },
  drifted: { className: 'bad', label: 'drifted' },
  'not-applicable': { className: '', label: 'nothing to compare' }
};

function levelHtml(level: ReconciliationLevel): string {
  const pill = VERDICT_PILL[level.verdict] ?? VERDICT_PILL['not-applicable'];
  const head = `
    <h2>${icon('merge')}${escape(level.label)}&nbsp;<span class="pill ${pill?.className ?? ''}">${icon(pill?.className || 'wait')}${escape(pill?.label ?? '')}</span></h2>
    <p class="question">${escape(level.question)}</p>`;

  if (level.verdict === 'not-applicable') {
    return `<section>${head}<p class="muted">${escape(level.reason)}</p>${remedyHtml(level)}</section>`;
  }

  const rows = level.rows.map((row) => `
    <tr class="${row.drifted ? 'drift' : ''}">
      ${row.cells.map((cell) => `<td>${escape(cell)}</td>`).join('')}
    </tr>${row.detail ? `<tr class="${row.drifted ? 'drift' : ''}"><td colspan="${level.columns.length}" class="muted">${escape(row.detail)}</td></tr>` : ''}`).join('');

  return `<section>${head}
    <table>
      <thead><tr>${level.columns.map((column) => `<th>${escape(column)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${remedyHtml(level)}
  </section>`;
}

function remedyHtml(level: ReconciliationLevel): string {
  if (!level.remedy) return '';
  const looksLikeCommand = level.remedy.startsWith('singularity-flow ');
  return `<p class="remedy">${looksLikeCommand
    ? `To resolve: <code>${escape(level.remedy)}</code>`
    : escape(level.remedy)}</p>`;
}

function bodyHtml(reconciliation: Reconciliation): string {
  if (reconciliation.empty) return `<div class="empty"><p>${escape(reconciliation.empty)}</p></div>`;
  const drifted = reconciliation.levels.filter((level) => level.verdict === 'drifted').length;
  const summary = drifted
    ? `${drifted} of ${reconciliation.levels.length} levels have drifted.`
    : 'Every level that can be compared currently agrees.';
  return `
    <header>
      <h1>${icon('impact', { size: 20 })}Reconciliation</h1>
      <p class="meta">${escape(reconciliation.initiativeId)} · ${escape(summary)}</p>
    </header>
    ${reconciliation.levels.map(levelHtml).join('')}`;
}

export class ReconciliationPanel {
  private static current: ReconciliationPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private mergePlan: MergePlan | null = null;

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    // The merge plan is re-read whenever the snapshot changes, so the two never describe different
    // moments of the same repository.
    this.subscription = store.onDidChange(() => { void this.reload(); });
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Render what the snapshot already knows before waiting on the merge plan. Three of the four
    // levels need no extra call, and a panel that is blank until a subprocess returns reads as a
    // panel that has nothing to say.
    this.render();
    void this.reload();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    client: SingularityFlowClient
  ): ReconciliationPanel {
    if (ReconciliationPanel.current) {
      ReconciliationPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ReconciliationPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.reconciliation', 'Reconciliation', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    ReconciliationPanel.current = new ReconciliationPanel(panel, store, client);
    return ReconciliationPanel.current;
  }

  private async reload(): Promise<void> {
    try {
      this.mergePlan = this.store.current.snapshot?.initiative
        ? await this.client.run<MergePlan>(['epic', 'merge-plan', '--json'])
        : null;
    } catch {
      // An Epic with no Story plan cannot produce a merge plan, and that is a normal state rather
      // than a failure. The level itself reports that there is nothing to sequence.
      this.mergePlan = null;
    }
    this.render();
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Reconciliation',
      bodyHtml(buildReconciliation(this.store.current.snapshot, this.mergePlan)),
      contentSecurityPolicy(this.panel.webview, token),
      token
    );
  }

  dispose(): void {
    ReconciliationPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
