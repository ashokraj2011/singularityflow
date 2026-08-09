/** Workspace-local governed-prompt audit viewer and controls. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';

interface PromptRecord {
  id: string;
  recordedAt: string;
  agent: string;
  workId: string | null;
  phase: string;
  generation: number | null;
  promptSha256: string;
  bytes: number;
  redactions: number;
  prompt: string;
}

interface PromptAuditSnapshot {
  enabled: boolean;
  count: number;
  scope: string;
  logFile: string;
  workspaceName: string | null;
  records: PromptRecord[];
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) vscode.postMessage({ type: action.dataset.action });
    const record = event.target.closest('[data-record]');
    if (record) vscode.postMessage({ type: 'select', id: record.dataset.record });
  });
`;

function body(snapshot: PromptAuditSnapshot | null, selected: string | null, error: string | null): string {
  if (!snapshot) return `<header><p class="eyebrow">Local governance</p><h1>${icon('prompt', { size: 24 })}Prompt audit</h1></header>
    <section><p>${error ? escape(error) : 'Reading workspace prompt records…'}</p><button class="secondary" data-action="refresh">Retry</button></section>`;
  const active = snapshot.records.find((record) => record.id === selected) ?? snapshot.records[0] ?? null;
  return `<header class="inbox-header">
    <div class="brand-lockup">SINGULARITY <span>FLOW</span></div>
    <p class="eyebrow">Workspace-local governance</p>
    <h1>${icon('prompt', { size: 24 })}Prompt audit</h1>
    <p class="meta">Capture the governed prompt assembled for each Copilot agent handoff. Copilot system prompts and chat history are never captured.</p>
    <p class="card-foot"><button data-action="toggle">Turn capture ${snapshot.enabled ? 'off' : 'on'}</button><button class="secondary" data-action="refresh">Refresh</button></p>
  </header>
  <section class="plain">
    <div class="summary-grid">
      <div class="summary-card important"><strong>${snapshot.enabled ? 'On' : 'Off'}</strong><span>Future handoffs</span></div>
      <div class="summary-card"><strong>${snapshot.count}</strong><span>Captured prompts</span></div>
      <div class="summary-card"><strong>${escape(snapshot.scope)}</strong><span>${escape(snapshot.workspaceName ?? 'Repository local')}</span></div>
    </div>
    <p class="warning-text">${icon('warning')}Prompts may contain proprietary requirements and source context. The file is machine-local and recognized token shapes are removed before writing.</p>
    <p class="muted"><code>${escape(snapshot.logFile)}</code></p>
  </section>
  <div class="split-layout">
    <section><h2>${icon('commit')}Agent handoffs</h2>${snapshot.records.length ? `<div class="audit-list">${snapshot.records.map((record) => `
      <button class="audit-record${active?.id === record.id ? ' selected' : ''}" data-record="${escape(record.id)}">
        <strong>${escape(record.agent)}</strong><span>${escape(record.workId ?? 'repository')} · ${escape(record.phase)} · generation ${escape(record.generation ?? '—')}</span>
        <small>${escape(record.recordedAt)} · ${escape(record.promptSha256.slice(0, 12))}</small>
      </button>`).join('')}</div>` : '<div class="empty"><p>No prompts captured yet. Turn capture on, then run a governed phase handoff.</p></div>'}</section>
    <section><h2>${icon('document')}Captured prompt</h2>${active ? `
      <dl class="audit-meta"><div><dt>Agent</dt><dd>${escape(active.agent)}</dd></div><div><dt>Story</dt><dd>${escape(active.workId ?? '—')}</dd></div><div><dt>Phase</dt><dd>${escape(active.phase)}</dd></div><div><dt>Redactions</dt><dd>${active.redactions}</dd></div></dl>
      <pre class="prompt-content"><code>${escape(active.prompt)}</code></pre>` : '<p class="muted">Select a captured handoff.</p>'}</section>
  </div>`;
}

export class PromptAuditPanel {
  private static current: PromptAuditPanel | null = null;
  private snapshot: PromptAuditSnapshot | null = null;
  private selected: string | null = null;
  private error: string | null = null;

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly client: SingularityFlowClient) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void vscode.commands.executeCommand(navigation);
      void this.receive(raw);
    });
    panel.onDidDispose(() => { PromptAuditPanel.current = null; });
    void this.refresh();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): PromptAuditPanel {
    if (PromptAuditPanel.current) {
      PromptAuditPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void PromptAuditPanel.current.refresh();
      return PromptAuditPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.promptAudit', 'Prompt audit', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    PromptAuditPanel.current = new PromptAuditPanel(panel, client);
    return PromptAuditPanel.current;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as { type?: unknown; id?: unknown };
    if (message.type === 'select' && typeof message.id === 'string') { this.selected = message.id; return this.render(); }
    if (message.type === 'toggle') {
      await this.client.run(['prompt-log', this.snapshot?.enabled ? 'off' : 'on', '--json']);
      return this.refresh();
    }
    if (message.type === 'refresh') return this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.snapshot = await this.client.run<PromptAuditSnapshot>(['prompt-log', 'list', '--include-prompt', '--limit', '250', '--json']);
      this.error = null;
      if (this.selected && !this.snapshot.records.some((record) => record.id === this.selected)) this.selected = null;
    } catch (error) { this.error = (error as Error).message; this.snapshot = null; }
    this.render();
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Prompt audit', body(this.snapshot, this.selected, this.error),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }
}
