/**
 * The status dashboard.
 *
 * Every number here was already available from `doctor`, `inbox`, `initiative status` and the
 * agent lock — four commands whose answers a person had to hold in their head at once. The value
 * this adds is the ordering: what is broken, then what is waiting on a person, then what is merely
 * true. A dashboard that opens with a row of counts teaches people to skim past the one line that
 * mattered.
 */
import * as vscode from 'vscode';
import { buildDashboard, dashboardHealth, type Check, type Dashboard, type Health } from './dashboard-model.ts';
import { contentSecurityPolicy, escape, icon, nonce, page } from './webview.ts';
import type { IconName } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';

const PILL: Record<string, string> = { fail: 'bad', warn: 'wait', pass: 'ok', skip: '' };
const GLYPH: Record<string, IconName> = { fail: 'bad', warn: 'wait', pass: 'ok', skip: 'wait' };

function checkHtml(check: Check): string {
  return `
  <tr>
    <td><span class="pill ${PILL[check.status] ?? ''}">${icon(GLYPH[check.status] ?? 'wait')}${escape(check.status)}</span></td>
    <td>${escape(check.id)}</td>
    <td>${escape(check.message)}</td>
    <td class="muted">${check.fix ? `<code>${escape(check.fix)}</code>` : ''}</td>
  </tr>`;
}

function bodyHtml(dashboard: Dashboard | null): string {
  if (!dashboard) {
    return `<header><h1>${icon('impact', { size: 20 })}Status</h1></header>
      <div class="empty"><p>Reading the repository…</p></div>`;
  }

  const health = dashboardHealth(dashboard);
  return `
  <header>
    <h1>${icon('impact', { size: 20 })}Status</h1>
    <p class="meta">${escape(dashboard.repository)}${dashboard.branch ? ` · ${escape(dashboard.branch)}` : ''}</p>
  </header>

  <section class="plain">
    ${dashboard.quiet && health === 'pass'
    ? `<p class="ok-text">${icon('ok')}Nothing is broken and nothing is waiting on you.</p>`
    : ''}
    ${dashboard.failing.length ? `
    <h2>${icon('bad')}Would stop governed work</h2>
    <table>
      <thead><tr><th>State</th><th>Check</th><th>What it found</th><th>Fix</th></tr></thead>
      <tbody>${dashboard.failing.map(checkHtml).join('')}</tbody>
    </table>
    <p class="muted">${dashboard.passing} other ${dashboard.passing === 1 ? 'check passes' : 'checks pass'}.</p>`
    : `<p class="muted">${icon('ok')}All ${dashboard.passing} diagnostics pass.</p>`}
  </section>

  ${dashboard.sections.map((section) => `
  <section>
    <h2>${icon(GLYPH[section.status] ?? 'wait')}${escape(section.label)}</h2>
    <p${section.status === 'warn' ? ' class="blockers"' : section.status === 'pass' ? ' class="ok-text"' : ' class="muted"'}>${escape(section.headline)}</p>
    ${section.detail.length
    ? `<ul class="sources">${section.detail.map((line) => `<li class="muted">${escape(line)}</li>`).join('')}</ul>`
    : ''}
  </section>`).join('')}

  <section class="plain">
    <p class="card-foot">
      <button data-open="approvals">Approvals</button>
      <button class="secondary" data-open="journey">Journey</button>
      <button class="secondary" data-open="reconciliation">Reconciliation</button>
      <button class="link" data-open="doctor">Full diagnostics</button>
    </p>
  </section>`;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-open]');
    if (target) vscode.postMessage({ type: 'open', what: target.dataset.open });
  });
`;

/** Where each button on the dashboard leads. The page names one; this decides what that means. */
const DESTINATIONS: Record<string, string> = {
  approvals: 'singularityFlow.openApprovals',
  journey: 'singularityFlow.openJourney',
  reconciliation: 'singularityFlow.openReconciliation',
  doctor: 'singularityFlow.doctor'
};

export class DashboardPanel {
  private static current: DashboardPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore) {
    this.panel = panel;
    this.store = store;
    this.subscription = store.onDidChange(() => this.render());
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const what = (raw as { what?: unknown })?.what;
      const command = typeof what === 'string' ? DESTINATIONS[what] : undefined;
      // Only a destination this file names; the page cannot ask for an arbitrary command.
      if (command) void vscode.commands.executeCommand(command);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore): DashboardPanel {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.dashboard', 'Status', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    DashboardPanel.current = new DashboardPanel(panel, store);
    return DashboardPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Status',
      bodyHtml(buildDashboard(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    DashboardPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
