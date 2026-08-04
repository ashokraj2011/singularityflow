/**
 * The planning and impact panel.
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

  private constructor(panel: vscode.WebviewPanel, store: WorkspaceStore, client: SingularityFlowClient) {
    this.panel = panel;
    this.store = store;
    this.client = client;
    // Recomputed whenever the snapshot changes, so the impact and the plan it derives from never
    // describe different moments.
    this.subscription = store.onDidChange(() => { void this.reload(); });
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
      'singularityFlow.impact', 'Planning and impact', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    ImpactPanel.current = new ImpactPanel(panel, store, client);
    return ImpactPanel.current;
  }

  private async reload(): Promise<void> {
    if (!this.store.current.snapshot?.initiative) {
      this.report = null;
      this.error = 'Nothing governed is checked out on this branch.';
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

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Planning and impact',
      bodyHtml(this.report, this.error),
      contentSecurityPolicy(this.panel.webview, token),
      token
    );
  }

  dispose(): void {
    ImpactPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
