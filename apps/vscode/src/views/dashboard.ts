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
import {
  buildDashboard, dashboardHealth, humanizeDuration,
  type Check, type Dashboard, type LifecycleAnalytics, type LifecyclePhaseMetric
} from './dashboard-model.ts';
import { contentSecurityPolicy, escape, icon, nonce, page } from './webview.ts';
import type { IconName } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';

const PILL: Record<string, string> = { fail: 'bad', warn: 'wait', pass: 'ok', skip: '' };
const GLYPH: Record<string, IconName> = { fail: 'bad', warn: 'wait', pass: 'ok', skip: 'wait' };

const PHASE_GLYPH: Record<string, IconName> = {
  approved: 'ok', in_progress: 'phase', awaiting_approval: 'wait', rejected: 'blocked', stale: 'stale'
};

function label(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function number(value: number): string {
  return value.toLocaleString('en-US');
}

function money(value: number | null): string {
  return value == null ? 'Unavailable' : `$${value.toFixed(2)}`;
}

function phaseRailHtml(phase: LifecyclePhaseMetric, currentPhase: string | null): string {
  const state = phase.status === 'approved' ? 'done'
    : phase.id === currentPhase ? 'current'
      : ['rejected', 'stale'].includes(phase.status) ? 'attention' : 'future';
  return `<li class="phase-node ${state}">
    <span class="phase-marker">${icon(PHASE_GLYPH[phase.status] ?? 'phase', { size: 14 })}</span>
    <span class="phase-name">${escape(phase.label)}</span>
    <span class="phase-state">${escape(label(phase.status))}</span>
  </li>`;
}

function durationBarHtml(phase: LifecyclePhaseMetric): string {
  const activeWidth = Math.round(phase.activeShare * 2.4);
  const waitingWidth = Math.round(phase.waitingShare * 2.4);
  const accessible = `${phase.label}: ${humanizeDuration(phase.activeMs)} active, ${humanizeDuration(phase.waitingMs)} waiting`;
  return `<tr>
    <td><strong>${escape(phase.label)}</strong><small>${escape(label(phase.status))}</small></td>
    <td class="duration-cell">
      <svg class="duration-bar" viewBox="0 0 240 16" preserveAspectRatio="none" role="img" aria-label="${escape(accessible)}">
        <rect class="duration-track" width="240" height="16" rx="3"/>
        <rect class="duration-active" width="${activeWidth}" height="16" rx="3"/>
        <rect class="duration-waiting" x="${activeWidth}" width="${waitingWidth}" height="16" rx="3"/>
      </svg>
      <small>${humanizeDuration(phase.elapsedMs)} elapsed</small>
    </td>
    <td>${humanizeDuration(phase.activeMs)}</td>
    <td>${humanizeDuration(phase.waitingMs)}</td>
    <td>${phase.generations}</td>
    <td>${phase.approvals}${phase.selfApprovals ? ` <span class="warning-text">(${phase.selfApprovals} self)</span>` : ''}</td>
  </tr>`;
}

function phaseToken(phase: LifecyclePhaseMetric): string {
  if (phase.tokenStatus === 'none') return 'Not captured';
  if (phase.tokenStatus === 'unavailable') return 'Unavailable';
  return `${number(phase.tokens)}${phase.tokenStatus === 'partial' ? ' (partial)' : ''}`;
}

function analyticsHtml(analytics: LifecycleAnalytics | null): string {
  if (!analytics) return `<section class="analytics-empty">
    <h2>${icon('story')}Lifecycle analytics</h2>
    <p class="muted">Start or attach a Story to see phase progress, elapsed time, approvals, models, tokens, and cost.</p>
  </section>`;

  const usageValue = analytics.usageStatus === 'none' || analytics.usageStatus === 'unavailable'
    ? 'Unavailable' : number(analytics.totalTokens);
  const usageNote = analytics.usageStatus === 'exact' ? `${analytics.exactUsageRecords} exact records`
    : analytics.usageStatus === 'partial' ? `${analytics.exactUsageRecords} of ${analytics.usageRecords} records exact`
      : analytics.pendingTelemetry ? `${analytics.pendingTelemetry} telemetry records pending`
        : 'Copilot did not expose exact usage';
  const costNote = analytics.costStatus === 'exact' ? 'Exact captured or configured pricing'
    : analytics.costStatus === 'partial' ? 'Partial pricing coverage'
      : 'No provider cost or matching price';
  const modelRows = analytics.models.length ? analytics.models.map((model) => `<tr>
    <td>${escape(model.provider)}</td><td>${escape(model.model)}</td><td>${model.records}</td>
    <td>${model.exactRecords}</td><td>${number(model.totalTokens)}</td>
    <td>${money(model.cost)}${model.costStatus === 'partial' ? ' (partial)' : ''}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="muted">No model telemetry has been recorded.</td></tr>`;

  return `<section class="analytics-overview plain">
    <div class="section-heading">
      <div class="grow">
        <span class="eyebrow">Story lifecycle</span>
        <h2>${icon('story', { size: 20 })}${escape(analytics.id)}${analytics.title ? ` — ${escape(analytics.title)}` : ''}</h2>
      </div>
      <span class="pill ${analytics.status === 'complete' ? 'ok' : ''}">${escape(label(analytics.status))}</span>
    </div>
    <div class="summary-grid lifecycle-kpis">
      <div class="summary-card important"><strong>${analytics.completionPercent}%</strong><span>${analytics.completedPhases} of ${analytics.totalPhases} phases approved</span></div>
      <div class="summary-card"><strong>${humanizeDuration(analytics.elapsedMs)}</strong><span>Wall-clock elapsed</span></div>
      <div class="summary-card"><strong>${humanizeDuration(analytics.activeMs)}</strong><span>Active phase time</span></div>
      <div class="summary-card"><strong>${humanizeDuration(analytics.waitingMs)}</strong><span>Waiting for decisions</span></div>
      <div class="summary-card"><strong>${escape(usageValue)}</strong><span>Tokens · ${escape(usageNote)}</span></div>
      <div class="summary-card"><strong>${money(analytics.cost)}</strong><span>Cost · ${escape(costNote)}</span></div>
    </div>
    <ol class="phase-rail" aria-label="Story phase progress">${analytics.phases.map((phase) => phaseRailHtml(phase, analytics.currentPhase)).join('')}</ol>
  </section>

  <section>
    <h2>${icon('wait')}Time by phase</h2>
    <p class="muted">Wall-clock durations include nights and weekends. Green is active time; amber is approval waiting time.</p>
    ${analytics.bottleneck ? `<p class="warning-text"><strong>Approval bottleneck:</strong> ${escape(analytics.bottleneck.phase)} waited ${humanizeDuration(analytics.bottleneck.waitingMs)}${analytics.bottleneck.share == null ? '' : ` (${analytics.bottleneck.share}% of elapsed time)`}.</p>` : ''}
    <div class="table-wrap"><table class="analytics-table">
      <thead><tr><th>Phase</th><th>Elapsed composition</th><th>Active</th><th>Waiting</th><th>Gens</th><th>Approvals</th></tr></thead>
      <tbody>${analytics.phases.map(durationBarHtml).join('')}</tbody>
    </table></div>
  </section>

  <section>
    <h2>${icon('impact')}Models, tokens, and cost</h2>
    <p class="muted">Only exact provider records contribute to token totals. Cost uses provider values first, then configured per-model pricing.</p>
    <div class="analytics-columns">
      <div class="table-wrap"><table class="analytics-table">
        <thead><tr><th>Phase</th><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${analytics.phases.map((phase) => `<tr><td>${escape(phase.label)}</td><td>${phase.modelUsage.length ? phase.modelUsage.map((entry) => `${escape(entry.provider)}/${escape(entry.model)}`).join('<br>') : '<span class="muted">Unavailable</span>'}</td><td>${escape(phaseToken(phase))}</td><td>${money(phase.cost)}${phase.costStatus === 'partial' ? ' (partial)' : ''}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="table-wrap"><table class="analytics-table">
        <thead><tr><th>Provider</th><th>Model</th><th>Records</th><th>Exact</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table></div>
    </div>
  </section>

  <section>
    <h2>${icon('approval')}Governance and rework</h2>
    <div class="summary-grid governance-kpis">
      <div class="summary-card"><strong>${analytics.reworkCycles}</strong><span>Regeneration cycles</span></div>
      <div class="summary-card"><strong>${analytics.rejections}</strong><span>Rejections</span></div>
      <div class="summary-card${analytics.selfApprovals ? ' governance-warning' : ''}"><strong>${analytics.selfApprovals}</strong><span>Self-approvals · not independent review</span></div>
      <div class="summary-card"><strong>${analytics.sequenceOverrides}</strong><span>Confirmed sequence overrides</span></div>
    </div>
  </section>`;
}

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
    return `<header><h1>${icon('impact', { size: 20 })}Lifecycle analytics</h1></header>
      <div class="empty"><p>Reading the repository…</p></div>`;
  }

  const health = dashboardHealth(dashboard);
  return `
  <header>
    <h1>${icon('impact', { size: 20 })}Lifecycle analytics</h1>
    <p class="meta">${escape(dashboard.repository)}${dashboard.branch ? ` · ${escape(dashboard.branch)}` : ''}</p>
  </header>

  ${analyticsHtml(dashboard.analytics)}

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
      'singularityFlow.dashboard', 'Lifecycle analytics', vscode.ViewColumn.Active, {
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
      'Lifecycle analytics',
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
