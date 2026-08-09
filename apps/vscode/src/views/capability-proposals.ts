/** Pending capability proposals across every registered organisation lead repository. */
import * as vscode from 'vscode';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';

interface LeadRepository { url: string }

interface CapabilityProposalSummary {
  branch: string;
  proposalCommit: string;
  changedFiles: Array<{ status: string; paths: string[] }>;
  valid: boolean;
  merged?: boolean;
}

interface ProposalEntry extends CapabilityProposalSummary { lead: string }
interface LeadFailure { lead: string; message: string }
type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

function shortName(branch: string): string {
  return branch.replace(/^sflow\/config-change\/capability\/map-/, '');
}

function proposalsHtml(entries: ProposalEntry[], leads: number, failures: LeadFailure[],
  busy: boolean): string {
  const ready = entries.filter((entry) => entry.valid && !entry.merged).length;
  const blocked = entries.filter((entry) => !entry.valid).length;
  const grouped = new Map<string, Array<{ entry: ProposalEntry; index: number }>>();
  entries.forEach((entry, index) => {
    const rows = grouped.get(entry.lead) ?? [];
    rows.push({ entry, index });
    grouped.set(entry.lead, rows);
  });
  const groups = [...grouped.entries()].map(([lead, rows]) => `<section class="plain">
    <div class="section-heading"><h2>${icon('repository')} ${escape(lead)}</h2>
      <span class="count-badge">${rows.length}</span></div>
    <div class="configuration-list">${rows.map(({ entry, index }) => `<button
      class="configuration-row secondary" data-review="${index}"
      aria-label="Review capability proposal ${escape(shortName(entry.branch))}">
      <span>${icon(entry.valid ? 'merge' : 'warning')}</span>
      <strong>${escape(shortName(entry.branch))}</strong>
      <small>${escape(entry.proposalCommit.slice(0, 12))} · ${entry.changedFiles.length} changed file${entry.changedFiles.length === 1 ? '' : 's'} · ${entry.valid ? 'ready for exact review' : 'blocked by validation'}</small>
    </button>`).join('')}</div>
  </section>`).join('');
  return `<div class="brand-lockup">SINGULARITY <span>FLOW</span></div>
    <header class="inbox-header">
      <p class="eyebrow">Governed configuration review</p>
      <div class="section-heading"><h1>${icon('merge', { size: 24 })} Capability proposals</h1>
        <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} ${busy ? 'Refreshing…' : 'Refresh'}</button></div>
      <p class="meta">Review proposed capability-map changes across registered lead repositories. Nothing is merged from this list.</p>
    </header>
    <div class="summary-grid">
      <div class="summary-card"><strong>${leads}</strong><span>Lead repositories</span></div>
      <div class="summary-card important"><strong>${entries.length}</strong><span>Pending proposals</span></div>
      <div class="summary-card"><strong>${ready}</strong><span>Ready for review</span></div>
      <div class="summary-card${blocked ? ' governance-warning' : ''}"><strong>${blocked}</strong><span>Blocked</span></div>
    </div>
    <div class="notice"><p>Opening a proposal shows its exact commit, changed files, and complete diff. Activation uses a normal non-force push to <code>sflow/config</code>; the application default branch is never changed.</p></div>
    ${failures.map((failure) => `<div class="notice error"><p><strong>${escape(failure.lead)}</strong>: ${escape(failure.message)}</p></div>`).join('')}
    ${busy && !entries.length ? `<div class="empty">${icon('wait')} Reading registered lead repositories and pending proposals…</div>`
      : groups || `<div class="empty"><h2>${icon('ok')} No proposals waiting</h2><p>No capability-map proposals require review. You can retry the capability change that brought you here.</p></div>`}`;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const review = event.target.closest('[data-review]');
    if (review) return vscode.postMessage({ type: 'review', index: Number(review.dataset.review) });
    const action = event.target.closest('[data-action]');
    if (action && !action.disabled) vscode.postMessage({ type: action.dataset.action });
  });
`;

export class CapabilityProposalsPanel {
  private static current: CapabilityProposalsPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private entries: ProposalEntry[] = [];
  private leadCount = 0;
  private failures: LeadFailure[] = [];
  private busy = false;

  private constructor(context: vscode.ExtensionContext, private readonly run: Run,
    private readonly onReview: (lead: string, branch: string) => void) {
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.capabilityProposals', 'Capability proposals', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void vscode.commands.executeCommand(navigation);
      const message = raw as { type?: string; index?: number };
      if (message.type === 'refresh') void this.load();
      if (message.type === 'review' && Number.isInteger(message.index)) {
        const entry = this.entries[message.index as number];
        if (entry) this.onReview(entry.lead, entry.branch);
      }
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
  }

  static show(context: vscode.ExtensionContext, run: Run,
    onReview: (lead: string, branch: string) => void): CapabilityProposalsPanel {
    if (this.current) {
      this.current.panel.reveal(vscode.ViewColumn.Active);
      void this.current.load();
      return this.current;
    }
    this.current = new CapabilityProposalsPanel(context, run, onReview);
    return this.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Capability proposals',
      proposalsHtml(this.entries, this.leadCount, this.failures, this.busy),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.failures = []; this.render();
    const leadsResponse = await this.run(['capability', 'leads', '--json']);
    if (leadsResponse.error) {
      this.entries = []; this.leadCount = 0;
      this.failures = [{ lead: 'Capability lead registry', message: leadsResponse.error }];
      this.busy = false; this.render(); return;
    }
    const leads = Array.isArray(leadsResponse.result)
      ? (leadsResponse.result as LeadRepository[]).filter((lead) => typeof lead?.url === 'string') : [];
    this.leadCount = leads.length;
    const results = await Promise.all(leads.map(async (lead) => {
      const response = await this.run(['capability', 'proposals', '--lead', lead.url, '--json']);
      if (response.error) return { lead: lead.url, proposals: [], error: response.error };
      const payload = response.result as { proposals?: CapabilityProposalSummary[] } | null;
      return { lead: lead.url, proposals: Array.isArray(payload?.proposals) ? payload.proposals : [], error: null };
    }));
    this.entries = results.flatMap((result) => result.proposals
      .filter((proposal) => !proposal.merged)
      .map((proposal) => ({ ...proposal, lead: result.lead })));
    this.failures = results.filter((result) => result.error)
      .map((result) => ({ lead: result.lead, message: result.error as string }));
    this.busy = false; this.render();
  }

  dispose(): void {
    CapabilityProposalsPanel.current = null;
    for (const disposable of this.disposables) disposable.dispose();
  }
}
