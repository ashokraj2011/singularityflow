/**
 * The activity log, in the editor.
 *
 * Every command already writes a durable JSON-lines record — what ran, with what argv, how long it
 * took, and why it failed — and `singularity-flow logs` reads it. Nothing surfaced it. The Output
 * channel shows a command's stdout as it happens; it is not the log, it does not survive a reload,
 * and it cannot be filtered. So the one place that answers "what did this thing actually do" was a
 * terminal command nobody had a reason to discover.
 *
 * Read-only by construction: this runs `logs --json` and renders it. There is no control here that
 * changes anything, which is why the panel can be opened at any point in a lifecycle without
 * thinking about what it might disturb.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

interface LogEntry {
  ts: string | null;
  level: string;
  event: string;
  msg?: string;
  command?: string;
  branch?: string;
  durationMs?: number;
  exitCode?: number;
  argv?: string[];
  [key: string]: unknown;
}

const LEVELS = ['all', 'error', 'warn', 'info', 'debug'] as const;
type Level = typeof LEVELS[number];

/** Fields rendered as their own column; everything else becomes the detail line. */
const COLUMNS = new Set(['ts', 'level', 'event', 'msg', 'command', 'durationMs', 'pid', 'cwd']);

function when(value: string | null): string {
  if (!value) return '—';
  // The date is noise when every row is from today; the time is the part being compared.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(11, 19);
}

function detail(entry: LogEntry): string {
  const rest = Object.entries(entry)
    .filter(([key, value]) => !COLUMNS.has(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(' ') : String(value)}`);
  return rest.join('  ');
}

function rows(entries: LogEntry[]): string {
  return entries.map((entry) => `
    <tr class="log-${escape(entry.level)}">
      <td class="log-time">${escape(when(entry.ts))}</td>
      <td><span class="pill ${entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'wait' : 'idle'}">${escape(entry.level)}</span></td>
      <td><code>${escape(entry.event)}</code>${entry.command ? ` <span class="muted">${escape(entry.command)}</span>` : ''}</td>
      <td>${entry.msg ? escape(entry.msg) : ''}${
  detail(entry) ? `<div class="log-detail">${escape(detail(entry))}</div>` : ''}</td>
      <td class="log-duration">${entry.durationMs === undefined ? '' : `${entry.durationMs} ms`}</td>
    </tr>`).join('');
}

function bodyHtml(entries: LogEntry[] | null, level: Level, error: string | null): string {
  const filters = LEVELS.map((option) => `<button class="${option === level ? '' : 'secondary'}"
    data-level="${option}">${option === 'all' ? 'Everything' : escape(option)}</button>`).join('');

  const head = `<header>
    <p class="eyebrow">Local governance</p>
    <h1>${icon('search', { size: 24 })}Activity log</h1>
    <p class="meta">Every command this repository has run, from its durable record. Nothing here changes anything.</p>
  </header>
  <p class="card-foot">${filters}<span class="grow"></span><button class="secondary" data-action="refresh">Refresh</button></p>`;

  if (error) {
    return `${head}<div class="empty"><p>${escape(error)}</p>
      <p class="muted">The log lives in this repository's Git directory and is written as commands run.</p></div>`;
  }
  if (!entries) return `${head}<div class="empty"><p>Reading the log…</p></div>`;
  if (!entries.length) {
    return `${head}<div class="empty"><p>Nothing recorded at this level yet.</p>
      <p class="muted">Run a governed command and it will appear here.</p></div>`;
  }

  const failures = entries.filter((entry) => entry.level === 'error').length;
  return `${head}
  <div class="summary-grid">
    <div class="summary-card"><strong>${entries.length}</strong><span>Entries shown</span></div>
    <div class="summary-card${failures ? ' important' : ''}"><strong>${failures}</strong><span>Failures</span></div>
  </div>
  <div class="table-wrap"><table class="analytics-table">
    <thead><tr><th>Time</th><th>Level</th><th>Event</th><th>Detail</th><th>Took</th></tr></thead>
    <tbody>${rows(entries)}</tbody>
  </table></div>`;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const level = event.target.closest('[data-level]');
    if (level) return vscode.postMessage({ type: 'level', level: level.dataset.level });
    const action = event.target.closest('[data-action]');
    if (action) vscode.postMessage({ type: action.dataset.action });
  });
`;

export class ActivityLogPanel {
  private static current: ActivityLogPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly client: SingularityFlowClient;
  private readonly disposables: vscode.Disposable[] = [];
  private entries: LogEntry[] | null = null;
  private level: Level = 'all';
  private error: string | null = null;

  private constructor(panel: vscode.WebviewPanel, client: SingularityFlowClient) {
    this.panel = panel;
    this.client = client;
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      const message = raw as { type?: unknown; level?: unknown };
      if (message?.type === 'refresh') return void this.load();
      if (message?.type === 'level' && typeof message.level === 'string'
        && (LEVELS as readonly string[]).includes(message.level)) {
        this.level = message.level as Level;
        return void this.load();
      }
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
  }

  static show(context: vscode.ExtensionContext, client: SingularityFlowClient): ActivityLogPanel {
    if (ActivityLogPanel.current) {
      ActivityLogPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void ActivityLogPanel.current.load();
      return ActivityLogPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.activityLog', 'Activity log', vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    );
    ActivityLogPanel.current = new ActivityLogPanel(panel, client);
    return ActivityLogPanel.current;
  }

  private async load(): Promise<void> {
    try {
      const args = ['logs', '--tail', '400', '--json'];
      if (this.level !== 'all') args.push('--level', this.level);
      this.entries = await this.client.run<LogEntry[]>(args);
      this.error = null;
    } catch (error) {
      this.entries = null;
      this.error = (error as Error).message;
    }
    this.render();
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Activity log',
      bodyHtml(this.entries, this.level, this.error),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    ActivityLogPanel.current = null;
    for (const subscription of this.disposables.splice(0)) subscription.dispose();
    this.panel.dispose();
  }
}
