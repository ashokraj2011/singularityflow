/** Consolidated, read-only diagnostics for every repository declared by the active workspace. */
import * as vscode from 'vscode';
import { watchFile, unwatchFile, type Stats } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

type LogSource = 'all' | 'activity' | 'prompt' | 'telemetry' | 'workspace';

interface WorkspaceLogEntry {
  id: string;
  timestamp: string | null;
  source: Exclude<LogSource, 'all'>;
  severity: 'error' | 'warn' | 'info' | 'debug';
  repositoryId: string | null;
  workId: string | null;
  phase: string | null;
  agent: string | null;
  event: string | null;
  summary: string;
  durationMs: number | null;
  details: Record<string, unknown>;
  sourcePath: string;
}

interface WorkspaceLogsEnvelope {
  schemaVersion: 1;
  workspace: { id: string; path: string };
  generatedAt: string;
  entries: WorkspaceLogEntry[];
  total: number;
  limit: number;
  sources: Array<{ source: string; repositoryId: string | null; path: string }>;
  warnings: string[];
}

function age(value: string | null): string {
  if (!value) return 'unknown time';
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return 'invalid time';
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function absoluteTime(value: string | null): string {
  if (!value) return 'No valid timestamp';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Invalid timestamp' : parsed.toLocaleString();
}

function sourceLabel(source: WorkspaceLogEntry['source']): string {
  return ({ activity: 'Activity', prompt: 'Prompts', telemetry: 'Copilot', workspace: 'Workspace' })[source];
}

function severityClass(level: WorkspaceLogEntry['severity']): string {
  return level === 'error' ? 'bad' : level === 'warn' ? 'wait' : 'idle';
}

function rows(entries: WorkspaceLogEntry[], selected: string | null): string {
  return entries.map((item) => `<tr class="entry${item.id === selected ? ' selected' : ''}"
    tabindex="0" data-entry="${escape(item.id)}" data-source="${escape(item.source)}"
    data-repository="${escape(item.repositoryId ?? '')}" data-severity="${escape(item.severity)}"
    data-work="${escape(item.workId ?? '')}" data-phase="${escape(item.phase ?? '')}"
    data-agent="${escape(item.agent ?? '')}" data-timestamp="${escape(item.timestamp ?? '')}"
    data-search="${escape(`${item.summary} ${item.event ?? ''} ${JSON.stringify(item.details)}`.toLocaleLowerCase())}">
      <td><strong>${escape(absoluteTime(item.timestamp))}</strong><small>${escape(age(item.timestamp))}</small></td>
      <td><span class="pill idle">${escape(sourceLabel(item.source))}</span></td>
      <td><span class="pill ${severityClass(item.severity)}">${escape(item.severity)}</span></td>
      <td><strong>${escape(item.summary)}</strong><small>${escape([item.repositoryId, item.workId, item.phase, item.agent].filter(Boolean).join(' · ') || 'workspace')}</small></td>
      <td>${item.durationMs == null ? '—' : `${escape(item.durationMs.toLocaleString())} ms`}</td>
    </tr>`).join('');
}

function options(values: Array<string | null>, placeholder: string): string {
  return `<option value="">${escape(placeholder)}</option>${[...new Set(values.filter((value): value is string => Boolean(value)))]
    .sort().map((value) => `<option value="${escape(value)}">${escape(value)}</option>`).join('')}`;
}

function detail(item: WorkspaceLogEntry | null, fullPrompt: string | null): string {
  if (!item) return `<aside class="details empty"><p>Select an entry to inspect its structured metadata.</p></aside>`;
  const prompt = item.source === 'prompt'
    ? `<section><h3>Captured prompt</h3>${fullPrompt == null
      ? '<p class="muted">Select the entry to load its redacted governed prompt from the audit record.</p>'
      : `<pre>${escape(fullPrompt)}</pre>`}</section>` : '';
  return `<aside class="details">
    <div class="section-heading"><h2>${icon('document', { size: 20 })}Entry details</h2>
      <button class="secondary" data-action="copy-json">Copy entry JSON</button>
      <button class="secondary" data-action="open-source">Open source file</button></div>
    <dl><dt>ID</dt><dd><code>${escape(item.id)}</code></dd>
      <dt>Time</dt><dd>${escape(absoluteTime(item.timestamp))}</dd>
      <dt>Source</dt><dd>${escape(sourceLabel(item.source))}</dd>
      <dt>Event</dt><dd>${escape(item.event ?? '—')}</dd>
      <dt>Repository</dt><dd>${escape(item.repositoryId ?? 'workspace')}</dd>
      <dt>Work / phase / agent</dt><dd>${escape([item.workId, item.phase, item.agent].filter(Boolean).join(' · ') || '—')}</dd>
      <dt>Local source</dt><dd><code>${escape(item.sourcePath)}</code></dd></dl>
    <pre>${escape(JSON.stringify(item.details, null, 2))}</pre>${prompt}
  </aside>`;
}

/**
 * `token` threads through only so the stylesheet below can carry the nonce.
 *
 * The policy is `style-src 'nonce-…'`, so an inline `<style>` without it is dropped by the webview
 * with no error — the page renders, the markup is right, and every rule silently does not exist.
 * This panel had been shipping that way; it was found by a sweep after the same bug was caught by
 * eye in the result card.
 */
function body(report: WorkspaceLogsEnvelope | null, selectedId: string | null, fullPrompt: string | null,
  error: string | null, defaultTab: LogSource, tabRevision: number, token: string): string {
  const entries = report?.entries ?? [];
  const selected = entries.find((item) => item.id === selectedId) ?? null;
  const errors = entries.filter((item) => item.severity === 'error').length;
  const warnings = entries.filter((item) => item.severity === 'warn').length;
  const tabs: Array<[LogSource, string]> = [['all', 'Timeline'], ['activity', 'Activity'], ['prompt', 'Prompts'], ['telemetry', 'Copilot'], ['workspace', 'Workspace']];
  const warningBlock = report?.warnings.length
    ? `<details class="notice warning"><summary>${report.warnings.length} source warning${report.warnings.length === 1 ? '' : 's'}</summary><ul>${report.warnings.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></details>` : '';
  return `<div id="workspace-log-options" data-default-tab="${escape(defaultTab)}" data-tab-revision="${tabRevision}"></div>
    <header class="inbox-header"><p class="eyebrow">Machine-local diagnostics</p>
    <h1>${icon('commit', { size: 24 })}Workspace logs</h1>
    <p class="meta">${report ? `${escape(report.workspace.id)} · ${escape(report.workspace.path)}` : 'Active workspace'} · read-only · newest first</p></header>
    <div class="toolbar"><nav class="tabs" aria-label="Log sources">${tabs.map(([id, label]) =>
      `<button class="tab${id === defaultTab ? ' active' : ''}" data-tab="${id}">${escape(label)}</button>`).join('')}</nav>
      <span class="grow"></span><button class="secondary" data-action="refresh">Refresh</button></div>
    ${error ? `<div class="notice bad"><strong>Logs could not be loaded.</strong><p>${escape(error)}</p></div>` : ''}
    ${warningBlock}
    <div class="summary-grid"><div class="summary-card"><strong>${entries.length}</strong><span>Loaded</span></div>
      <div class="summary-card${errors ? ' important' : ''}"><strong>${errors}</strong><span>Errors</span></div>
      <div class="summary-card"><strong>${warnings}</strong><span>Warnings</span></div>
      <div class="summary-card"><strong>${report ? escape(absoluteTime(report.generatedAt)) : '—'}</strong><span>Refreshed</span></div></div>
    <section class="filters"><label>Repository<select data-filter="repository">${options(entries.map((item) => item.repositoryId), 'All repositories')}</select></label>
      <label>Severity<select data-filter="severity"><option value="">All severities</option><option>error</option><option>warn</option><option>info</option><option>debug</option></select></label>
      <label>Work ID<select data-filter="work">${options(entries.map((item) => item.workId), 'All work')}</select></label>
      <label>Phase<select data-filter="phase">${options(entries.map((item) => item.phase), 'All phases')}</select></label>
      <label>Agent<select data-filter="agent">${options(entries.map((item) => item.agent), 'All agents')}</select></label>
      <label>Time range<select data-filter="range"><option value="">Any time</option><option value="1">Last hour</option><option value="24">Last 24 hours</option><option value="168">Last 7 days</option></select></label>
      <label class="search-filter">Text<input type="search" data-filter="text" placeholder="Search summary and metadata"></label></section>
    <p class="muted"><span data-visible-count>${entries.length}</span> matching entries. Prompt bodies stay hidden from the combined timeline.</p>
    <div class="source-empty" data-source-empty hidden>
      <p>No entries match this source and filter combination. Missing or unreadable sources are listed in the source warnings above.</p>
    </div>
    ${entries.length ? `<div class="table-wrap"><table class="analytics-table logs-table"><thead><tr><th>When</th><th>Source</th><th>Level</th><th>Summary</th><th>Took</th></tr></thead><tbody>${rows(entries, selectedId)}</tbody></table></div>`
      : `<div class="empty"><p>${report ? 'No log entries have been recorded for this workspace yet.' : 'Reading workspace logs…'}</p></div>`}
    ${report && report.total > report.entries.length ? `<p><button class="secondary" data-action="load-older">Load older entries (${report.entries.length} of ${report.total})</button></p>` : ''}
    ${detail(selected, fullPrompt)}
    <style nonce="${token}">
      .toolbar,.tabs { display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; margin:1rem 0; }
      .tab { color:var(--vscode-foreground); background:transparent; border:0; border-bottom:2px solid transparent; border-radius:0; }
      .tab.active { color:var(--sf-accent); border-bottom-color:var(--sf-accent); }
      .filters { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.7rem; margin:1rem 0; }
      .filters label { display:grid; gap:.25rem; color:var(--sf-dim); font-size:.75rem; }
      .search-filter { grid-column:span 2; }
      .logs-table tr.entry { cursor:pointer; }
      .logs-table tr.entry:hover,.logs-table tr.entry.selected { background:var(--sf-accent-quiet); }
      .logs-table td strong,.logs-table td small { display:block; }
      .logs-table td small { color:var(--sf-dim); }
      .details { margin-top:1.2rem; padding:1rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
      .details dl { display:grid; grid-template-columns:max-content 1fr; gap:.35rem .8rem; }
      .details dt { color:var(--sf-dim); }.details dd { margin:0; min-width:0; overflow-wrap:anywhere; }
      pre { max-height:30rem; overflow:auto; white-space:pre-wrap; border:var(--sf-border); padding:.75rem; }
      .notice { margin:1rem 0; padding:.7rem 1rem; border-left:3px solid var(--sf-wait); background:var(--sf-surface); }
      .notice.bad { border-left-color:var(--sf-bad); }
    </style>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  const saved = vscode.getState() || {};
  const options = document.querySelector('#workspace-log-options');
  const requestedTab = options?.dataset.defaultTab || 'all';
  const tabRevision = Number(options?.dataset.tabRevision || 0);
  let activeTab = saved.tabRevision === tabRevision ? (saved.tab || requestedTab) : requestedTab;
  const filters = saved.filters || {};
  function apply() {
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === activeTab));
    let visible = 0;
    const cutoffHours = Number(filters.range || 0);
    const cutoff = cutoffHours ? Date.now() - cutoffHours * 3600000 : 0;
    document.querySelectorAll('tr.entry').forEach((row) => {
      const text = (filters.text || '').toLowerCase();
      const time = row.dataset.timestamp ? Date.parse(row.dataset.timestamp) : 0;
      const shown = (activeTab === 'all' || row.dataset.source === activeTab)
        && (!filters.repository || row.dataset.repository === filters.repository)
        && (!filters.severity || row.dataset.severity === filters.severity)
        && (!filters.work || row.dataset.work === filters.work)
        && (!filters.phase || row.dataset.phase === filters.phase)
        && (!filters.agent || row.dataset.agent === filters.agent)
        && (!cutoff || time >= cutoff)
        && (!text || row.dataset.search.includes(text));
      row.hidden = !shown; if (shown) visible += 1;
    });
    const count = document.querySelector('[data-visible-count]'); if (count) count.textContent = String(visible);
    const empty = document.querySelector('[data-source-empty]'); if (empty) empty.hidden = visible !== 0;
    vscode.setState({ tab: activeTab, tabRevision, filters });
  }
  document.querySelectorAll('[data-filter]').forEach((input) => {
    const key = input.dataset.filter; if (filters[key] != null) input.value = filters[key];
    input.addEventListener('input', () => { filters[key] = input.value; apply(); });
  });
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-tab]');
    if (tab) { activeTab = tab.dataset.tab; apply(); return; }
    const entry = event.target.closest('[data-entry]');
    if (entry) { vscode.postMessage({ type: 'select', id: entry.dataset.entry }); return; }
    const action = event.target.closest('[data-action]');
    if (action) vscode.postMessage({ type: action.dataset.action });
  });
  document.addEventListener('keydown', (event) => {
    const entry = event.target.closest?.('[data-entry]');
    if (entry && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); vscode.postMessage({ type:'select', id:entry.dataset.entry }); }
  });
  apply();
`;

export class WorkspaceLogsPanel {
  private static current: WorkspaceLogsPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watched = new Map<string, (current: Stats, previous: Stats) => void>();
  private report: WorkspaceLogsEnvelope | null = null;
  private error: string | null = null;
  private selectedId: string | null = null;
  private fullPrompt: string | null = null;
  private limit = 500;
  private tabRevision = 1;
  private refreshTimer: NodeJS.Timeout | null = null;

  private constructor(private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient, private defaultTab: LogSource) {
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer provides the standard way out of every full-page view.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.receive(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render(); void this.load();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient,
    tab: LogSource = 'all'): WorkspaceLogsPanel {
    if (WorkspaceLogsPanel.current) {
      WorkspaceLogsPanel.current.defaultTab = tab;
      WorkspaceLogsPanel.current.tabRevision += 1;
      WorkspaceLogsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      WorkspaceLogsPanel.current.render(); void WorkspaceLogsPanel.current.load();
      return WorkspaceLogsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.workspaceLogs', 'Workspace logs',
      vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
    WorkspaceLogsPanel.current = new WorkspaceLogsPanel(panel, client, tab);
    return WorkspaceLogsPanel.current;
  }

  static refreshCurrent(): void { void WorkspaceLogsPanel.current?.load(); }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as { type?: unknown; id?: unknown };
    if (message.type === 'refresh') return this.load();
    if (message.type === 'load-older') { this.limit = Math.min(5000, this.limit + 500); return this.load(); }
    const selected = this.report?.entries.find((item) => item.id === (message.id ?? this.selectedId));
    if (message.type === 'select' && typeof message.id === 'string') {
      this.selectedId = message.id; this.fullPrompt = null;
      if (selected?.source === 'prompt' && typeof selected.details.promptAuditId === 'string') {
        try {
          const records = (await readFile(selected.sourcePath, 'utf8')).split(/\r?\n/)
            .filter(Boolean).flatMap((line) => {
              try { return [JSON.parse(line) as { id?: string; prompt?: string }]; }
              catch { return []; }
            });
          this.fullPrompt = records.find((item) => item.id === selected.details.promptAuditId)?.prompt ?? null;
        } catch { this.fullPrompt = null; }
      }
      return this.render();
    }
    if (message.type === 'open-source' && selected?.sourcePath) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.sourcePath));
      await vscode.window.showTextDocument(document, { preview: true }); return;
    }
    if (message.type === 'copy-json' && selected) {
      await vscode.env.clipboard.writeText(JSON.stringify(selected, null, 2));
      void vscode.window.showInformationMessage('Workspace log entry copied.');
    }
  }

  private async load(): Promise<void> {
    try {
      this.report = await this.client.run<WorkspaceLogsEnvelope>(['logs', 'workspace', '--limit', String(this.limit), '--json']);
      this.error = null;
      if (this.selectedId && !this.report.entries.some((item) => item.id === this.selectedId)) this.selectedId = null;
      this.resetWatchers();
    } catch (error) { this.report = null; this.error = (error as Error).message; }
    this.render();
  }

  private resetWatchers(): void {
    for (const [file, listener] of this.watched) unwatchFile(file, listener);
    this.watched.clear();
    for (const source of this.report?.sources ?? []) {
      if (this.watched.has(source.path)) continue;
      const listener = (current: Stats, previous: Stats): void => {
        if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => void this.load(), 300);
      };
      this.watched.set(source.path, listener);
      watchFile(source.path, { interval: 1000, persistent: false }, listener);
    }
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Workspace logs', body(this.report, this.selectedId, this.fullPrompt,
      this.error, this.defaultTab, this.tabRevision, token), contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  dispose(): void {
    WorkspaceLogsPanel.current = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const [file, listener] of this.watched) unwatchFile(file, listener);
    this.watched.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}
