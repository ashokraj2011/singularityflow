/** Pending capability proposals across every registered organisation lead repository. */
import * as vscode from 'vscode';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter } from './messages.ts';

interface LeadRepository { url: string }

interface CapabilityProposalSummary {
  branch: string;
  proposalCommit: string;
  changedFiles: Array<{ status: string; paths: string[] }>;
  valid: boolean;
  merged?: boolean;
  status?: string;
  discardable?: boolean;
  failure?: { code?: string; message?: string; nextAction?: { command?: string } };
}

interface ProposalEntry extends CapabilityProposalSummary { lead: string }
interface LeadFailure { lead: string; message: string }
interface CapabilityFsckCheck {
  id: string; status: 'pass' | 'info' | 'warn' | 'fail'; summary: string;
  branch?: string | null; commit?: string | null; remediation?: string | null;
}
interface CapabilityFsckResult {
  valid: boolean;
  summary: { passed: number; information: number; warnings: number; failures: number };
  checks: CapabilityFsckCheck[];
}
interface LeadIntegrity { lead: string; result?: CapabilityFsckResult; error?: string }
type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

function shortName(branch: string): string {
  return branch.replace(/^sflow\/config-change\/capability\/map-/, '');
}

function proposalsHtml(entries: ProposalEntry[], leads: number, failures: LeadFailure[],
  busy: boolean, includeMerged: boolean, integrity: LeadIntegrity[]): string {
  const ready = entries.filter((entry) => entry.valid && !entry.merged).length;
  const blocked = entries.filter((entry) => !entry.valid).length;
  const merged = entries.filter((entry) => entry.merged).length;
  const pending = entries.length - merged;
  const grouped = new Map<string, Array<{ entry: ProposalEntry; index: number }>>();
  entries.forEach((entry, index) => {
    const rows = grouped.get(entry.lead) ?? [];
    rows.push({ entry, index });
    grouped.set(entry.lead, rows);
  });
  const groups = [...grouped.entries()].map(([lead, rows]) => `<section class="plain">
    <div class="section-heading"><h2>${icon('repository')} ${escape(lead)}</h2>
      <span class="count-badge">${rows.length}</span></div>
    <div class="configuration-list">${rows.map(({ entry, index }) => `<div class="configuration-row-wrap"><button
        class="configuration-row secondary" data-review="${index}"
        aria-label="Review capability proposal ${escape(shortName(entry.branch))}">
        <span>${icon(entry.valid ? 'merge' : 'warning')}</span>
        <strong>${escape(shortName(entry.branch))}</strong>
        <small>${escape(entry.proposalCommit.slice(0, 12))} · ${entry.changedFiles.length} changed file${entry.changedFiles.length === 1 ? '' : 's'} · ${entry.merged ? 'merged history' : entry.valid ? 'ready for exact review' : escape(entry.status ?? 'blocked by validation')}</small>
        ${entry.failure?.message ? `<small class="error-text">${escape(entry.failure.message)}</small>` : ''}
        ${entry.failure?.nextAction?.command ? `<small>Recovery: <code>${escape(entry.failure.nextAction.command)}</code></small>` : ''}
      </button>${entry.discardable ? `<button class="secondary" data-discard="${index}" aria-label="Discard stale proposal ${escape(shortName(entry.branch))}">${icon('remove')} Discard stale proposal</button>` : ''}</div>`).join('')}</div>
  </section>`).join('');
  const integrityHtml = integrity.map((entry) => {
    if (entry.error) return `<div class="notice error"><p><strong>${escape(entry.lead)}</strong>: ${escape(entry.error)}</p></div>`;
    const issues = entry.result?.checks.filter((check) => check.status === 'fail' || check.status === 'warn') ?? [];
    return `<section class="plain"><div class="section-heading"><h2>${icon(entry.result?.valid ? 'ok' : 'warning')} Integrity · ${escape(entry.lead)}</h2>
      <span class="count-badge">${issues.length}</span></div>
      ${issues.length ? issues.map((check) => `<div class="notice ${check.status === 'fail' ? 'error' : 'governance-warning'}"><p><strong>${escape(check.id)}</strong>: ${escape(check.summary)}</p>
        ${check.branch ? `<p><code>${escape(check.branch)}${check.commit ? `@${escape(check.commit)}` : ''}</code></p>` : ''}
        ${check.remediation ? `<p>Remediation: <code>${escape(check.remediation)}</code></p>` : ''}</div>`).join('')
        : '<div class="notice ok"><p>No capability authority or proposal-integrity issues were detected.</p></div>'}</section>`;
  }).join('');
  return `${brandLockup()}
    <header class="inbox-header">
      <p class="eyebrow">Governed configuration review</p>
      <div class="section-heading"><h1>${icon('merge', { size: 24 })} Capability proposals</h1>
        <button class="secondary" data-action="toggle-history" ${busy ? 'disabled' : ''}>${icon('git')} ${includeMerged ? 'Hide merged history' : 'Show merged history'}</button>
        <button class="secondary" data-action="fsck" ${busy ? 'disabled' : ''}>${icon('policy')} Check integrity</button>
        <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} ${busy ? 'Refreshing…' : 'Refresh'}</button></div>
      <p class="meta">Review proposed capability-map changes across registered lead repositories, or inspect earlier merged revisions. Nothing is merged from this list.</p>
    </header>
    <div class="summary-grid">
      <div class="summary-card"><strong>${leads}</strong><span>Lead repositories</span></div>
      <div class="summary-card important"><strong>${pending}</strong><span>Pending proposals</span></div>
      <div class="summary-card"><strong>${ready}</strong><span>Ready for review</span></div>
      <div class="summary-card${blocked ? ' governance-warning' : ''}"><strong>${includeMerged ? merged : blocked}</strong><span>${includeMerged ? 'Merged history' : 'Blocked'}</span></div>
    </div>
    <div class="notice"><p>Opening a proposal shows its exact commit, changed files, and complete diff. Activation can attempt one exact leased update to <code>sflow/config</code>; server review controls and hooks remain authoritative, and the application default branch is never changed.</p></div>
    ${integrityHtml}
    ${failures.map((failure) => `<div class="notice error"><p><strong>${escape(failure.lead)}</strong>: ${escape(failure.message)}</p></div>`).join('')}
    ${busy && !entries.length ? `<div class="empty">${icon('wait')} Reading registered lead repositories and pending proposals…</div>`
      : groups || `<div class="empty"><h2>${icon('ok')} ${includeMerged ? 'No proposal history found' : 'No proposals waiting'}</h2><p>${includeMerged ? 'No retained capability proposal branches are available to inspect.' : 'No capability-map proposals require review. You can retry the capability change that brought you here.'}</p></div>`}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const discard = event.target.closest('[data-discard]');
    if (discard) return vscode.postMessage({ type: 'discard', index: Number(discard.dataset.discard) });
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
  private integrity: LeadIntegrity[] = [];
  private leadUrls: string[] = [];
  private busy = false;
  private includeMerged = false;

  private constructor(context: vscode.ExtensionContext, private readonly run: Run,
    private readonly onReview: (lead: string, branch: string) => void) {
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.capabilityProposals', 'Capability proposals', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    /**
     * The two messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * An index is looked up against the entries this panel loaded, never used to reach anything
     * else — `integerField` refuses a non-integer, and an out-of-range index simply finds nothing.
     */
    const router = registerMessageRouter('singularityFlow.capabilityProposals', {
      refresh: () => { void this.load(); },
      'toggle-history': () => {
        this.includeMerged = !this.includeMerged;
        void this.load();
      },
      fsck: () => { void this.fsck(); },
      discard: (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.entries[index];
        if (entry?.discardable) void this.discard(entry);
      },
      review: (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.entries[index];
        if (entry) this.onReview(entry.lead, entry.branch);
      }
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      router.route(raw);
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
      proposalsHtml(this.entries, this.leadCount, this.failures, this.busy, this.includeMerged, this.integrity),
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
    this.leadUrls = leads.map((lead) => lead.url);
    this.leadCount = leads.length;
    const results = await Promise.all(leads.map(async (lead) => {
      const response = await this.run([
        'capability', 'proposals', '--lead', lead.url,
        ...(this.includeMerged ? ['--all'] : []), '--json'
      ]);
      if (response.error) return { lead: lead.url, proposals: [], error: response.error };
      const payload = response.result as { proposals?: CapabilityProposalSummary[] } | null;
      return { lead: lead.url, proposals: Array.isArray(payload?.proposals) ? payload.proposals : [], error: null };
    }));
    this.entries = results.flatMap((result) => result.proposals
      .filter((proposal) => this.includeMerged || !proposal.merged)
      .map((proposal) => ({ ...proposal, lead: result.lead })));
    this.failures = results.filter((result) => result.error)
      .map((result) => ({ lead: result.lead, message: result.error as string }));
    this.busy = false; this.render();
  }

  private async fsck(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.integrity = []; this.render();
    const results = await Promise.all(this.leadUrls.map(async (lead) => {
      const response = await this.run(['capability', 'fsck', '--lead', lead, '--json']);
      return response.error
        ? { lead, error: response.error }
        : { lead, result: response.result as CapabilityFsckResult };
    }));
    this.integrity = results;
    this.busy = false; this.render();
  }

  private async discard(entry: ProposalEntry): Promise<void> {
    if (this.busy || !entry.discardable) return;
    const reason = await vscode.window.showInputBox({
      title: 'Discard stale capability proposal',
      prompt: 'Why is this unrelated-history proposal no longer needed?',
      placeHolder: 'The configuration authority was intentionally re-created',
      validateInput: (value) => value.trim() ? null : 'A reason is required.',
      ignoreFocusOut: true
    });
    if (!reason?.trim()) return;
    const confirmation = 'Discard exact stale proposal';
    const accepted = await vscode.window.showWarningMessage(
      `Discard ${entry.branch}@${entry.proposalCommit.slice(0, 12)}?`,
      {
        modal: true,
        detail: 'Only this exact unrelated-history capability proposal ref is removed. If the remote branch moved, the operation refuses. Approved configuration, state, application branches, and every other proposal are preserved.'
      },
      confirmation
    );
    if (accepted !== confirmation) return;
    this.busy = true; this.render();
    const response = await this.run([
      'capability', 'discard-proposal', entry.branch,
      '--lead', entry.lead, '--confirm', entry.proposalCommit,
      '--reason', reason.trim(), '--json'
    ]);
    this.busy = false;
    if (response.error) {
      this.failures = [{ lead: entry.lead, message: response.error }, ...this.failures];
      this.render();
      return;
    }
    void vscode.window.showInformationMessage(
      `Discarded stale capability proposal ${shortName(entry.branch)}; approved configuration was preserved.`);
    await this.load();
  }

  dispose(): void {
    CapabilityProposalsPanel.current = null;
    for (const disposable of this.disposables) disposable.dispose();
  }
}
