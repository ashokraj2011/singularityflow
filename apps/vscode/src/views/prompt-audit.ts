/** Workspace-local governed-prompt audit viewer and controls. */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';

interface PromptRecord {
  id: string;
  recordedAt: string;
  agent: string;
  workId: string | null;
  phase: string;
  generation: number | null;
  promptSha256: string;
  bytes: number;
  handoffSha256?: string | null;
  handoffBytes?: number | null;
  redactions: number;
  prompt: string;
  source: string;
  task: string | null;
  workType: string | null;
  integrityVerification?: { status?: string };
  execution: {
    observation: string;
    reason: string | null;
    invocationId: string | null;
    operationId: string | null;
    provider: string | null;
    model: string | null;
    channel: string | null;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    tools: {
      policyStatus: string;
      mode: string | null;
      allowed: string[];
      observedCalls: null;
      observation: string;
    };
    tokens: {
      status: string;
      assurance: string;
      input: number | null;
      output: number | null;
      cachedInput: number | null;
      reasoning: number | null;
      total: number | null;
      providerCost: number | null;
      promptEstimate: { value: number | null; assurance: string; basis: string | null };
    };
    limits: { timeoutMs?: number; outputBytes?: number; promptBytes?: number } | null;
    prompt: { bytes: number | null; sha256: string | null; transport: string | null; encoding: string | null } | null;
    output: { bytes: number; sha256: string | null } | null;
    error: { code?: string } | null;
  };
}

interface PromptAuditSnapshot {
  enabled: boolean;
  count: number;
  retentionDays: number;
  maximumBytes: number;
  scope: string;
  logFile: string;
  workspaceName: string | null;
  integrity: { status: string; verified: number; legacy: number; failed: number; malformed: number };
  warnings: string[];
  records: PromptRecord[];
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    if (action) vscode.postMessage({ type: action.dataset.action });
    const record = event.target.closest('[data-record]');
    if (record) vscode.postMessage({ type: 'select', id: record.dataset.record });
  });
  document.addEventListener('change', (event) => {
    const retention = event.target.closest('[data-retention]');
    if (retention) vscode.postMessage({ type: 'retention', days: retention.value });
  });
`;

function metric(value: number | null): string {
  return value == null ? 'Unavailable' : value.toLocaleString('en-US');
}

function duration(value: number | null): string {
  if (value == null) return 'Unavailable';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
}

function retentionOptions(selected: number): string {
  const values = [...new Set([7, 30, 90, 180, 365, selected])].sort((a, b) => a - b);
  return values.map((days) => `<option value="${days}"${days === selected ? ' selected' : ''}>${days} days</option>`).join('');
}

function body(snapshot: PromptAuditSnapshot | null, selected: string | null, error: string | null): string {
  if (!snapshot) return `<header><p class="eyebrow">Local governance</p><h1>${icon('prompt', { size: 24 })}Prompt audit</h1></header>
    <section><p>${error ? escape(error) : 'Reading workspace prompt records…'}</p><button class="secondary" data-action="refresh">Retry</button></section>`;
  const active = snapshot.records.find((record) => record.id === selected) ?? snapshot.records[0] ?? null;
  return `<header class="inbox-header">
    ${brandLockup()}
    <p class="eyebrow">Workspace-local governance</p>
    <h1>${icon('prompt', { size: 24 })}Prompt audit</h1>
    <p class="meta">Capture the governed prompt assembled for each Copilot agent handoff. Copilot system prompts and chat history are never captured.</p>
    <p class="card-foot"><button data-action="toggle">Turn capture ${snapshot.enabled ? 'off' : 'on'}</button><button class="secondary" data-action="refresh">Refresh</button><button class="secondary" data-action="repair">Repair</button><button class="secondary" data-action="clear">Clear history</button></p>
  </header>
  <section class="plain">
    <div class="summary-grid">
      <div class="summary-card important"><strong>${snapshot.enabled ? 'On' : 'Off'}</strong><span>Future handoffs</span></div>
      <div class="summary-card"><strong>${snapshot.count}</strong><span>Captured prompts</span></div>
      <div class="summary-card"><strong>${escape(snapshot.scope)}</strong><span>${escape(snapshot.workspaceName ?? 'Repository local')}</span></div>
      <div class="summary-card"><strong>${escape(snapshot.integrity.status)}</strong><span>Integrity</span></div>
    </div>
    <label>Retention <select data-retention>${retentionOptions(snapshot.retentionDays)}</select></label><p class="muted">Storage is also capped at ${escape(Math.round(snapshot.maximumBytes / (1024 * 1024)))} MiB.</p>
    <p class="warning-text">${icon('warning')}Prompts may contain proprietary requirements and source context. The file is machine-local and recognized token shapes are removed before writing.</p>
    ${snapshot.warnings.length ? `<p class="warning-text">${snapshot.warnings.map(escape).join('<br>')}</p>` : ''}
    <p class="muted"><code>${escape(snapshot.logFile)}</code></p>
  </section>
  <div class="split-layout">
    <section><h2>${icon('commit')}Agent handoffs</h2>${snapshot.records.length ? `<div class="audit-list">${snapshot.records.map((record) => `
      <button class="audit-record${active?.id === record.id ? ' selected' : ''}" data-record="${escape(record.id)}">
        <strong>${escape(record.agent)}</strong><span>${escape(record.workId ?? 'repository')} · ${escape(record.phase)} · generation ${escape(record.generation ?? '—')}</span>
        <small>${escape(record.recordedAt)} · ${escape(record.source)} · ${escape(record.execution.model ?? 'model unavailable')} · ${escape(record.execution.tokens.total == null ? `~${record.execution.tokens.promptEstimate.value ?? '—'} estimated prompt tokens` : `${record.execution.tokens.total} provider tokens`)}</small>
      </button>`).join('')}</div>` : '<div class="empty"><p>No prompts captured yet. Turn capture on, then run a governed phase handoff.</p></div>'}</section>
    <section><h2>${icon('document')}Structured prompt record</h2>${active ? `
      <div class="summary-grid"><div class="summary-card"><strong>${escape(active.execution.model ?? 'Unavailable')}</strong><span>Model</span></div><div class="summary-card"><strong>${escape(metric(active.execution.tokens.total))}</strong><span>Provider tokens</span></div><div class="summary-card"><strong>${escape(active.execution.tools.mode ?? 'Unavailable')}</strong><span>Tool policy</span></div><div class="summary-card"><strong>${escape(active.execution.status)}</strong><span>Execution</span></div></div>
      <h3>Context</h3><dl class="audit-meta"><div><dt>Agent</dt><dd>${escape(active.agent)}</dd></div><div><dt>Story</dt><dd>${escape(active.workId ?? '—')}</dd></div><div><dt>Phase</dt><dd>${escape(active.phase)}</dd></div><div><dt>Generation</dt><dd>${escape(active.generation ?? '—')}</dd></div><div><dt>Source</dt><dd>${escape(active.source)}</dd></div><div><dt>Task</dt><dd>${escape(active.task ?? 'Unavailable')}</dd></div><div><dt>Prompt bytes</dt><dd>${escape(active.bytes.toLocaleString('en-US'))}</dd></div><div><dt>Redactions</dt><dd>${active.redactions}</dd></div><div><dt>Integrity</dt><dd>${escape(active.integrityVerification?.status ?? 'Legacy')}</dd></div></dl>
      <h3>Model and execution</h3><dl class="audit-meta"><div><dt>Provider</dt><dd>${escape(active.execution.provider ?? 'Unavailable')}</dd></div><div><dt>Model</dt><dd>${escape(active.execution.model ?? 'Unavailable')}</dd></div><div><dt>Channel</dt><dd>${escape(active.execution.channel ?? 'Unavailable')}</dd></div><div><dt>Duration</dt><dd>${escape(duration(active.execution.durationMs))}</dd></div><div><dt>Operation</dt><dd>${escape(active.execution.operationId ?? 'Unavailable')}</dd></div><div><dt>Invocation</dt><dd>${escape(active.execution.invocationId ?? 'Unavailable')}</dd></div><div><dt>Started</dt><dd>${escape(active.execution.startedAt ?? 'Unavailable')}</dd></div><div><dt>Completed</dt><dd>${escape(active.execution.completedAt ?? 'Unavailable')}</dd></div><div><dt>Error code</dt><dd>${escape(active.execution.error?.code ?? 'Unavailable')}</dd></div></dl>${active.execution.reason ? `<p class="muted">${escape(active.execution.reason)}</p>` : ''}
      <h3>Tools</h3><dl class="audit-meta"><div><dt>Authorization</dt><dd>${escape(active.execution.tools.policyStatus)}</dd></div><div><dt>Policy</dt><dd>${escape(active.execution.tools.mode ?? 'Unavailable')}</dd></div><div><dt>Allowed</dt><dd>${escape(active.execution.tools.mode === 'none' ? 'None' : active.execution.tools.allowed.join(', ') || (active.execution.tools.mode === 'all' ? 'All provider tools' : 'Unavailable'))}</dd></div><div><dt>Observed calls</dt><dd>Unavailable</dd></div></dl><p class="muted">${escape(active.execution.tools.observation)}</p>
      <h3>Tokens and cost</h3><dl class="audit-meta"><div><dt>Usage status</dt><dd>${escape(`${active.execution.tokens.status} · ${active.execution.tokens.assurance}`)}</dd></div><div><dt>Input</dt><dd>${escape(metric(active.execution.tokens.input))}</dd></div><div><dt>Output</dt><dd>${escape(metric(active.execution.tokens.output))}</dd></div><div><dt>Cached input</dt><dd>${escape(metric(active.execution.tokens.cachedInput))}</dd></div><div><dt>Reasoning</dt><dd>${escape(metric(active.execution.tokens.reasoning))}</dd></div><div><dt>Total</dt><dd>${escape(metric(active.execution.tokens.total))}</dd></div><div><dt>Provider cost</dt><dd>${escape(active.execution.tokens.providerCost == null ? 'Unavailable' : `$${active.execution.tokens.providerCost.toFixed(6)}`)}</dd></div><div><dt>Prompt estimate</dt><dd>${escape(`${metric(active.execution.tokens.promptEstimate.value)} · ${active.execution.tokens.promptEstimate.assurance}`)}</dd></div></dl><p class="muted">Prompt estimates are based on UTF-8 size and are not provider billing usage.</p>
      <h3>Request and output</h3><dl class="audit-meta"><div><dt>Timeout</dt><dd>${escape(duration(active.execution.limits?.timeoutMs ?? null))}</dd></div><div><dt>Output limit</dt><dd>${escape(active.execution.limits?.outputBytes == null ? 'Unavailable' : `${active.execution.limits.outputBytes.toLocaleString('en-US')} bytes`)}</dd></div><div><dt>Output bytes</dt><dd>${escape(active.execution.output?.bytes == null ? 'Unavailable' : active.execution.output.bytes.toLocaleString('en-US'))}</dd></div><div><dt>Captured prompt hash</dt><dd><code>${escape(active.promptSha256.slice(0, 16))}</code></dd></div><div><dt>Exact handoff bytes</dt><dd>${escape(active.handoffBytes == null ? 'Unavailable' : active.handoffBytes.toLocaleString('en-US'))}</dd></div><div><dt>Exact handoff hash</dt><dd><code>${escape(active.handoffSha256?.slice(0, 16) ?? 'Unavailable')}</code></dd></div><div><dt>Sent prompt bytes</dt><dd>${escape(active.execution.prompt?.bytes == null ? 'Unavailable' : active.execution.prompt.bytes.toLocaleString('en-US'))}</dd></div><div><dt>Sent prompt hash</dt><dd><code>${escape(active.execution.prompt?.sha256?.slice(0, 16) ?? 'Unavailable')}</code></dd></div><div><dt>Transport</dt><dd>${escape(active.execution.prompt?.transport ?? 'Unavailable')}</dd></div><div><dt>Encoding</dt><dd>${escape(active.execution.prompt?.encoding ?? 'Unavailable')}</dd></div></dl>
      <h3>Prompt</h3><pre class="prompt-content"><code>${escape(active.prompt)}</code></pre>` : '<p class="muted">Select a captured handoff.</p>'}</section>
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
      if (navigation) return void navigateTo(navigation);
      this.router.route(raw);
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

  /**
   * The three messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
   *
   * `toggle` reads the *current* snapshot to decide which way to flip, so it stays a method rather
   * than a captured value: a router built once at construction would otherwise close over the
   * enabled flag as it was before the first refresh.
   */
  private router = registerMessageRouter('singularityFlow.promptAudit', {
    select: (message) => {
      const id = stringField(message, 'id');
      // Which record that is comes from the snapshot when it renders, never used as a path here.
      if (id) { this.selected = id; this.render(); }
    },
    toggle: () => { void this.toggle(); },
    retention: (message) => {
      const days = Number(stringField(message, 'days'));
      if (Number.isInteger(days)) void this.retention(days);
    },
    repair: () => { void this.repair(); },
    clear: () => { void this.clear(); },
    refresh: () => { void this.refresh(); }
  });

  private async toggle(): Promise<void> {
    await this.client.run(['prompt-log', this.snapshot?.enabled ? 'off' : 'on', '--json']);
    await this.refresh();
  }

  private async retention(days: number): Promise<void> {
    await this.client.run(['prompt-log', 'retention', '--retention-days', String(days), '--json']);
    await this.refresh();
  }

  private async repair(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Repair prompt history? The original bytes will be retained in a private recovery file and unsafe records will be excluded.',
      { modal: true }, 'Repair'
    );
    if (confirmed !== 'Repair') return;
    await this.client.run(['prompt-log', 'repair', '--confirm', 'REPAIR PROMPT AUDIT', '--json']);
    await this.refresh();
  }

  private async clear(): Promise<void> {
    const confirmed = await vscode.window.showWarningMessage(
      'Permanently clear all prompt history and recovery copies for this workspace?',
      { modal: true }, 'Clear history'
    );
    if (confirmed !== 'Clear history') return;
    await this.client.run(['prompt-log', 'clear', '--confirm', 'DELETE PROMPT AUDIT', '--json']);
    this.selected = null;
    await this.refresh();
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
