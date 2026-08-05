/**
 * Workspace advisory and governed planning impact.
 *
 * Impact is computed by the engine — `epic impact --json` derives it from the Story plan rather than
 * from what the impact map claims — so this renders that answer rather than forming its own. The one
 * thing it adds is emphasis: the reconciliation between what was written down and what the plan
 * actually touches is the part that changes decisions, so it comes first and the inventory follows.
 */
import * as vscode from 'vscode';
import { contentSecurityPolicy, escape, icon, nonce, page } from './webview.ts';
import type { SingularityFlowClient } from '../cli/client.ts';
import type { WorkspaceStore } from '../state.ts';

/** The shape `epic impact --json` returns. Mirrored, not redefined: the engine owns it. */
export interface ImpactReport {
  initiativeId?: string | null;
  storyCount?: number;
  repositories?: Array<{
    id: string;
    lead?: boolean;
    storyCount: number;
    blockingStoryCount: number;
    stories: string[];
    consumesContracts?: string[];
    worldModel?: { present: boolean; views: string[] };
    claimed?: boolean;
  }>;
  crossRepository?: Array<{ from: string; to: string; via: Array<{ story: string; dependsOn: string }> }>;
  reconciliation?: {
    compared?: boolean;
    agreed?: string[];
    unclaimed?: string[];
    unsupported?: string[];
    unknownViews?: Array<{ repository: string; views: string[] }>;
    missingWorldModel?: string[];
  };
  invalidates?: string[];
}

export interface WorkspaceImpactReport {
  id: string;
  title: string;
  description: string;
  status: 'prepared' | 'complete' | 'failed' | string;
  freshness: 'current' | 'stale' | string;
  createdAt: string;
  completedAt?: string | null;
  repositories: Array<{
    id: string; branch?: string | null; commit: string; dirty?: boolean;
    worldModel: { present: boolean; sha256: string | null };
  }>;
  warnings?: string[];
  changes?: Array<{ repository: string; reason: string }>;
  model?: { provider?: string; name?: string } | null;
  tokenUsage?: { status?: string; input?: number; output?: number; total?: number } | null;
  result?: { summaryMarkdown?: string; path?: string; sha256?: string } | null;
  failure?: string | null;
  promotedDocument?: { path: string } | null;
}

type WorkspaceImpactMessage =
  | { type: 'analyze'; title?: unknown; description?: unknown }
  | { type: 'select'; id?: unknown }
  | { type: 'promote'; id?: unknown }
  | { type: 'startWork'; id?: unknown };

const WORKSPACE_SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const analyze = event.target.closest('[data-impact-analyze]');
    if (analyze) {
      const title = document.querySelector('[name="impact-title"]')?.value || '';
      const description = document.querySelector('[name="impact-description"]')?.value || '';
      vscode.postMessage({ type: 'analyze', title, description });
      return;
    }
    const target = event.target.closest('[data-impact-id]');
    if (!target) return;
    const id = target.dataset.impactId;
    if (target.matches('[data-impact-promote]')) vscode.postMessage({ type: 'promote', id });
    else if (target.matches('[data-impact-start]')) vscode.postMessage({ type: 'startWork', id });
    else vscode.postMessage({ type: 'select', id });
  });
`;

function workspaceImpactHtml(
  workspace: { path: string; name?: string | null } | null,
  reports: WorkspaceImpactReport[],
  selectedId: string | null,
  running: boolean,
  actionError: string | null
): string {
  if (!workspace) return `<section class="plain">
    <h2>${icon('workspace')}Explore workspace impact</h2>
    <p class="muted">Select a workspace to analyze proposed changes without creating a Work ID or branch.</p>
  </section>`;
  const selected = reports.find((report) => report.id === selectedId) ?? reports[0] ?? null;
  const rows = reports.map((report) => `<button class="artifact-card" data-impact-id="${escape(report.id)}">
    <span class="artifact-title">${escape(report.title)}</span>
    <span class="pill ${report.freshness === 'stale' ? 'wait' : report.status === 'complete' ? 'ok' : report.status === 'failed' ? 'bad' : ''}">${escape(report.status)} · ${escape(report.freshness)}</span>
    <span class="artifact-meta">${escape(report.id)} · ${escape(new Date(report.createdAt).toLocaleString())} · ${report.repositories.length} ${report.repositories.length === 1 ? 'repository' : 'repositories'}</span>
  </button>`).join('');
  const details = selected ? `<section>
    <div class="section-heading"><div class="grow"><span class="eyebrow">Advisory result</span><h2>${icon('impact')}${escape(selected.title)}</h2></div>
      <span class="pill ${selected.freshness === 'stale' ? 'wait' : 'ok'}">${escape(selected.freshness)}</span></div>
    ${(selected.warnings ?? []).length ? `<ul class="blockers">${selected.warnings?.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>` : ''}
    ${(selected.changes ?? []).length ? `<p class="warning-text">Captured evidence changed: ${selected.changes?.map((change) => `${escape(change.repository)} (${escape(change.reason)})`).join(', ')}</p>` : ''}
    <details><summary>Captured analysis context</summary>
      <table><thead><tr><th>Repository</th><th>Revision</th><th>World model</th></tr></thead><tbody>
      ${selected.repositories.map((repository) => `<tr><td><code>${escape(repository.id)}</code></td><td><code>${escape(repository.commit.slice(0, 12))}</code>${repository.branch ? ` · ${escape(repository.branch)}` : ''}</td><td>${repository.worldModel.present ? 'pinned' : '<span class="pill wait">missing</span>'}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted">Model: ${escape(selected.model?.name ?? 'provider default')} · Tokens: ${escape(selected.tokenUsage?.status ?? 'unavailable')}</p>
    </details>
    ${selected.result?.summaryMarkdown
    ? `<pre class="prompt-content"><code>${escape(selected.result.summaryMarkdown)}</code></pre>`
    : `<p class="muted">${escape(selected.failure ?? 'No summary is available yet.')}</p>`}
    ${selected.status === 'complete' ? `<p class="card-foot">
      <button data-impact-promote data-impact-id="${escape(selected.id)}" ${selected.freshness === 'stale' || selected.promotedDocument ? 'disabled' : ''}>${selected.promotedDocument ? 'Added to intake sources' : 'Use as intake source'}</button>
      <button class="secondary" data-impact-start data-impact-id="${escape(selected.id)}">Start governed work</button>
    </p>` : ''}
    <p class="muted">This report is advisory. It becomes lifecycle context only after it is staged and selected during governed intake.</p>
  </section>` : '';
  return `<section class="plain">
    <span class="eyebrow">No Work ID or branch required</span>
    <h2>${icon('impact', { size: 20 })}Explore workspace impact</h2>
    <p class="meta">${escape(workspace.name ?? 'Active workspace')} · Copilot analyzes detached copies of committed repository revisions. Your working trees are never modified.</p>
    ${actionError ? `<p class="blockers">${escape(actionError)}</p>` : ''}
    <div class="card">
      <label for="impact-title"><strong>Change title</strong></label>
      <input id="impact-title" name="impact-title" type="text" placeholder="For example: Add passkey authentication" ${running ? 'disabled' : ''}>
      <label for="impact-description"><strong>What are you considering?</strong></label>
      <textarea id="impact-description" name="impact-description" rows="7" placeholder="Describe the proposed change, constraints, expected outcome, and questions Copilot should assess." ${running ? 'disabled' : ''}></textarea>
      <p class="card-foot"><button data-impact-analyze ${running ? 'disabled' : ''}>${running ? 'Copilot is analyzing…' : 'Analyze impact with Copilot'}</button>
        <span class="muted">Uses all repositories, mapped capabilities, world models, and staged workspace documents.</span></p>
    </div>
  </section>
  <section><h2>${icon('artifact')}Previous analyses</h2>${rows ? `<div class="artifact-cards">${rows}</div>` : '<p class="muted">No workspace impact analyses yet.</p>'}</section>
  ${details}`;
}

function findingsHtml(report: ImpactReport): string {
  const reconciliation = report.reconciliation ?? {};
  if (!reconciliation.compared) {
    return `<p class="muted">No impact map has been published yet, so there is nothing to reconcile against.
      This is not the same as agreement.</p>`;
  }

  const findings: string[] = [
    ...(reconciliation.unclaimed ?? []).map((id) => {
      const repository = report.repositories?.find((entry) => entry.id === id);
      const count = repository?.storyCount ?? 0;
      return `The map omits <code>${escape(id)}</code>, which ${count} ${count === 1 ? 'Story lands' : 'Stories land'} in.`;
    }),
    ...(reconciliation.unsupported ?? []).map((id) =>
      `The map names <code>${escape(id)}</code>, which no Story touches.`),
    ...(reconciliation.unknownViews ?? []).map((entry) =>
      `<code>${escape(entry.repository)}</code> is claimed to use ${entry.views.map((view) => `<code>${escape(view)}</code>`).join(', ')}, which its world model does not declare.`)
  ];

  if (!findings.length) {
    return '<p class="ok-text">The published impact map agrees with the Story plan.</p>';
  }

  return `
    <ul class="blockers">${findings.map((finding) => `<li>${finding}</li>`).join('')}</ul>
    ${report.invalidates?.length
    ? `<p class="remedy">Correcting the map would invalidate ${report.invalidates.length}
         downstream ${report.invalidates.length === 1 ? 'node' : 'nodes'}:
         ${report.invalidates.map((node) => `<code>${escape(node)}</code>`).join(' ')}</p>`
    : ''}`;
}

function bodyHtml(report: ImpactReport | null, error: string | null): string {
  if (error) {
    return `<header><h1>${icon('impact', { size: 20 })}Planning and impact</h1></header>
      <div class="empty"><p>${escape(error)}</p></div>`;
  }
  if (!report) {
    return `<header><h1>${icon('impact', { size: 20 })}Planning and impact</h1></header>
      <div class="empty"><p>Computing impact…</p></div>`;
  }

  const repositories = report.repositories ?? [];
  const edges = report.crossRepository ?? [];

  return `
  <header>
    <h1>${icon('impact', { size: 20 })}Planning and impact</h1>
    <p class="meta">${escape(report.initiativeId ?? '')} ·
      ${report.storyCount ?? 0} ${report.storyCount === 1 ? 'Story' : 'Stories'} across
      ${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'} ·
      derived from the plan, not from the map</p>
  </header>

  <section class="plain">
    <h2>${icon('impact')}Reconciliation</h2>
    ${findingsHtml(report)}
  </section>

  <section>
    <h2>${icon('repository')}What this Epic touches</h2>
    ${repositories.length ? `
    <table>
      <thead><tr><th>Repository</th><th>Stories</th><th>Gates the Epic</th><th>Contracts</th><th>World model</th><th>In the map</th></tr></thead>
      <tbody>${repositories.map((repository) => `
        <tr>
          <td>${icon('repository')}<code>${escape(repository.id)}</code>${repository.lead ? ' <span class="muted">lead</span>' : ''}</td>
          <td>${repository.storyCount}</td>
          <td>${repository.blockingStoryCount}</td>
          <td>${repository.consumesContracts?.length ? repository.consumesContracts.map((id) => escape(id)).join(', ') : '<span class="muted">—</span>'}</td>
          <td>${repository.worldModel?.present
    ? escape(repository.worldModel.views.join(', ') || 'present')
    : '<span class="pill bad">none</span>'}</td>
          <td>${repository.claimed ? 'yes' : '<span class="pill wait">no</span>'}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="muted">No Story declares a repository.</p>'}
  </section>

  <section>
    <h2>${icon('branch')}Cross-repository order</h2>
    ${edges.length ? `
    <table>
      <thead><tr><th>Must land first</th><th>Then</th><th>Because</th></tr></thead>
      <tbody>${edges.map((edge) => `
        <tr>
          <td><code>${escape(edge.from)}</code></td>
          <td><code>${escape(edge.to)}</code></td>
          <td class="muted">${edge.via.map((via) => `${escape(via.story)} → ${escape(via.dependsOn)}`).join('; ')}</td>
        </tr>`).join('')}</tbody>
    </table>`
    : '<p class="muted">No Story depends on a Story in another repository, so the repositories may land in any order.</p>'}
  </section>

  ${report.reconciliation?.missingWorldModel?.length ? `
  <section>
    <h2>${icon('bad')}No committed world model</h2>
    <p class="muted">Grounding for these repositories has nothing to draw on:
      ${report.reconciliation.missingWorldModel.map((id) => `<code>${escape(id)}</code>`).join(' ')}</p>
  </section>` : ''}`;
}

export class ImpactPanel {
  private static current: ImpactPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly client: SingularityFlowClient;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private report: ImpactReport | null = null;
  private error: string | null = null;
  private workspace: { path: string; name?: string | null } | null = null;
  private workspaceReports: WorkspaceImpactReport[] = [];
  private selectedWorkspaceReport: string | null = null;
  private runningWorkspaceImpact = false;
  private workspaceActionError: string | null = null;

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    // Recomputed whenever the snapshot changes, so the impact and the plan it derives from never
    // describe different moments.
    this.subscription = store.onDidChange(() => { void this.reload(); });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      void this.receive(raw as WorkspaceImpactMessage);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.reload();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, client: SingularityFlowClient): ImpactPanel {
    if (ImpactPanel.current) {
      ImpactPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ImpactPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.impact', 'Impact analysis', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    ImpactPanel.current = new ImpactPanel(panel, store, client);
    return ImpactPanel.current;
  }

  private async reload(): Promise<void> {
    const current: {
      active?: boolean; workspacePath?: string; workspaceName?: string;
    } = await this.client.run<{
      active?: boolean; workspacePath?: string; workspaceName?: string;
    }>(['workspace', 'current', '--json']).catch(() => ({ active: false }));
    this.workspace = current.active && current.workspacePath
      ? { path: current.workspacePath, name: current.workspaceName ?? null } : null;
    const workspacePath = this.workspace?.path ?? null;
    this.workspaceReports = workspacePath
      ? await this.client.run<WorkspaceImpactReport[]>(['workspace', 'impact', 'list', workspacePath, '--json']).catch(() => [])
      : [];
    const firstReport = this.workspaceReports[0];
    if (!this.selectedWorkspaceReport && firstReport) this.selectedWorkspaceReport = firstReport.id;
    if (!this.store.current.snapshot?.initiative) {
      this.report = null;
      this.error = null;
      this.render();
      return;
    }
    try {
      this.report = await this.client.run<ImpactReport>(['epic', 'impact', '--json']);
      this.error = null;
    } catch (error) {
      // An Epic with no Story plan cannot be given an impact, which is a state rather than a fault.
      this.report = null;
      this.error = (error as Error).message;
    }
    this.render();
  }

  private async receive(message: WorkspaceImpactMessage): Promise<void> {
    if (!this.workspace) return;
    if (message.type === 'select' && typeof message.id === 'string') {
      this.selectedWorkspaceReport = message.id;
      this.render();
      return;
    }
    if (message.type === 'startWork') {
      await vscode.commands.executeCommand('singularityFlow.startWork');
      return;
    }
    if (message.type === 'promote' && typeof message.id === 'string') {
      try {
        await this.client.run(['workspace', 'impact', 'promote', this.workspace.path, message.id, '--json']);
        this.workspaceActionError = null;
        await this.reload();
        void vscode.window.showInformationMessage('Impact summary staged as an intake source. Start governed work when ready.');
      } catch (error) {
        this.workspaceActionError = (error as Error).message;
        this.render();
      }
      return;
    }
    if (message.type !== 'analyze') return;
    const description = typeof message.description === 'string' ? message.description.trim() : '';
    if (!description) {
      this.workspaceActionError = 'Describe the proposed change before running impact analysis.';
      this.render();
      return;
    }
    this.runningWorkspaceImpact = true;
    this.workspaceActionError = null;
    this.render();
    try {
      const title = typeof message.title === 'string' && message.title.trim()
        ? message.title.trim() : 'Workspace change impact';
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Copilot is analyzing ${this.workspace.name ?? 'the workspace'}…`,
        cancellable: false
      }, () => this.client.run<WorkspaceImpactReport>([
        'workspace', 'impact', 'analyze', this.workspace?.path ?? '',
        '--title', title, '--description', description, '--json'
      ]));
      this.selectedWorkspaceReport = result.id;
    } catch (error) {
      this.workspaceActionError = (error as Error).message;
    } finally {
      this.runningWorkspaceImpact = false;
      await this.reload();
    }
  }

  private render(): void {
    const token = nonce();
    const governed = this.store.current.snapshot?.initiative
      ? bodyHtml(this.report, this.error)
      : `<section><h2>${icon('initiative')}Governed Epic impact</h2><p class="muted">No governed Initiative is selected. Workspace analysis remains available without one.</p></section>`;
    this.panel.webview.html = page(
      'Impact analysis',
      `<header><h1>${icon('impact', { size: 20 })}Impact analysis</h1></header>
      ${workspaceImpactHtml(this.workspace, this.workspaceReports, this.selectedWorkspaceReport, this.runningWorkspaceImpact, this.workspaceActionError)}
      ${governed}`,
      contentSecurityPolicy(this.panel.webview, token),
      token,
      WORKSPACE_SCRIPT
    );
  }

  dispose(): void {
    ImpactPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
