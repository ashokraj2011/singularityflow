/** Review and activate a capability proposal without leaving VS Code. */
import * as vscode from 'vscode';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';

export interface CapabilityProposal {
  remote: string;
  branch: string;
  targetBranch: string;
  targetCommit: string;
  proposalCommit: string;
  proposalBase: string;
  merged: boolean;
  valid: boolean;
  invalidFiles: string[];
  changedFiles: Array<{ status: string; paths: string[] }>;
  diff: string;
}

interface ActivationResult {
  targetBranch: string;
  targetCommit: string;
  proposalCommit: string;
  alreadyMerged: boolean;
  projection?: { published?: boolean; branch?: string; commit?: string; reason?: string };
}

type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

function reviewHtml(proposal: CapabilityProposal | null, busy: boolean, error: string | null,
  activated: ActivationResult | null): string {
  if (!proposal) return `${brandLockup({ compact: true })}
    <header><h1>${icon('merge', { size: 24 })} Review capability proposal</h1>
    <p class="meta">Loading the exact configuration change from Git…</p></header>
    ${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}`;
  const files = proposal.changedFiles.map((file) => `<tr>
      <td><code>${escape(file.status)}</code></td><td>${escape(file.paths.join(' to '))}</td></tr>`).join('');
  const projection = activated?.projection;
  return `${brandLockup({ compact: true })}
    <header class="inbox-header">
      <p class="eyebrow">Governed configuration review</p>
      <h1>${icon('merge', { size: 24 })} Review capability proposal</h1>
      <p class="meta">Review one exact commit before it becomes approved organisation configuration.</p>
    </header>
    ${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}
    ${activated ? `<div class="notice ok"><p><strong>Capability activated.</strong> ${escape(
      activated.alreadyMerged ? 'The proposal was already merged.' : `Approved ${activated.targetBranch} now points to ${activated.targetCommit.slice(0, 12)}.`
    )}</p><p>${escape(projection?.published
      ? `Projection published to ${projection.branch}@${projection.commit?.slice(0, 12)}.`
      : projection?.branch ? `${projection.branch} was already current.`
        : `Projection: ${projection?.reason ?? 'not available'}.`)}</p></div>` : ''}
    <div class="summary-grid">
      <div class="summary-card"><span>Proposal</span><strong>${escape(proposal.proposalCommit.slice(0, 12))}</strong></div>
      <div class="summary-card"><span>Approved target</span><strong>${escape(proposal.targetCommit.slice(0, 12))}</strong></div>
      <div class="summary-card"><span>Files</span><strong>${proposal.changedFiles.length}</strong></div>
      <div class="summary-card ${proposal.valid ? '' : 'governance-warning'}"><span>Validation</span><strong>${proposal.valid ? 'Ready' : 'Blocked'}</strong></div>
    </div>
    <section class="plain">
      <h2>${icon('branch')} Source and target</h2>
      <div class="review-binding">
        <span>Review branch</span><code>${escape(proposal.branch)}</code>
        <span>Exact commit</span><code>${escape(proposal.proposalCommit)}</code>
        <span>Target branch</span><code>${escape(proposal.targetBranch)}</code>
        <span>Lead repository</span><code>${escape(proposal.remote)}</code>
      </div>
      <div class="notice"><p>The application default branch is not part of this operation. Activation uses a normal, non-force push to <code>${escape(proposal.targetBranch)}</code>; repository branch protection still applies.</p></div>
    </section>
    <section>
      <h2>${icon('configuration')} Changed configuration files</h2>
      <div class="table-wrap"><table><thead><tr><th>Status</th><th>Path</th></tr></thead><tbody>${files}</tbody></table></div>
      ${proposal.invalidFiles.length ? `<div class="notice error"><p>Non-configuration files are refused: ${escape(proposal.invalidFiles.join(', '))}</p></div>` : ''}
    </section>
    <section>
      <h2>${icon('compare')} Proposed diff</h2>
      <div class="help-code"><pre><code>${escape(proposal.diff || 'No textual diff.')}</code></pre></div>
    </section>
    <section class="next">
      <div class="actions">
        <button class="primary" data-action="activate" ${busy || !proposal.valid || activated ? 'disabled' : ''}>${icon('merge')} ${busy ? 'Activating…' : 'Merge and activate'}</button>
        <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} Refresh</button>
        <button class="secondary" data-action="copy">${icon('branch')} Copy branch</button>
      </div>
    </section>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button && !button.disabled) vscode.postMessage({ type: button.dataset.action });
  });
`;

export class CapabilityProposalPanel {
  private static current = new Map<string, CapabilityProposalPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private proposal: CapabilityProposal | null = null;
  private busy = false;
  private error: string | null = null;
  private activated: ActivationResult | null = null;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly lead: string,
    private readonly branch: string,
    private readonly run: Run,
    private readonly onActivated?: (result: ActivationResult) => Promise<void>
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.capabilityProposal', 'Capability proposal review', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      const message = raw as { type?: string };
      void this.receive(message);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
  }

  static show(context: vscode.ExtensionContext, lead: string, branch: string, run: Run,
    onActivated?: (result: ActivationResult) => Promise<void>): CapabilityProposalPanel {
    const key = `${lead}\n${branch}`;
    const existing = this.current.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return existing;
    }
    const created = new CapabilityProposalPanel(context, lead, branch, run, onActivated);
    this.current.set(key, created);
    return created;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Capability proposal review',
      reviewHtml(this.proposal, this.busy, this.error, this.activated),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  private async load(): Promise<void> {
    this.busy = true; this.error = null; this.render();
    const { result, error } = await this.run([
      'capability', 'proposal', this.branch, '--lead', this.lead, '--json'
    ]);
    this.busy = false;
    if (error) this.error = error;
    else this.proposal = result as CapabilityProposal;
    this.render();
  }

  private async receive(message: { type?: string }): Promise<void> {
    if (message.type === 'refresh') return this.load();
    if (message.type === 'copy') {
      await vscode.env.clipboard.writeText(this.branch);
      void vscode.window.showInformationMessage('Capability proposal branch copied.');
      return;
    }
    if (message.type !== 'activate' || !this.proposal || this.busy) return;
    const proposal = this.proposal;
    const confirmed = await vscode.window.showWarningMessage(
      `Merge ${proposal.branch}@${proposal.proposalCommit.slice(0, 12)} into ${proposal.targetBranch}, then publish the capability projection?`,
      { modal: true, detail: 'This uses a normal non-force Git push. The application default branch is not changed.' },
      'Merge and activate');
    if (confirmed !== 'Merge and activate') return;
    this.busy = true; this.error = null; this.render();
    const { result, error } = await this.run([
      'capability', 'activate', proposal.branch, '--lead', this.lead,
      '--confirm', proposal.proposalCommit, '--json'
    ]);
    this.busy = false;
    if (error) this.error = error;
    else {
      this.activated = result as ActivationResult;
      await this.onActivated?.(this.activated);
      void vscode.window.showInformationMessage(
        `Capability configuration activated on ${this.activated.targetBranch}.`);
    }
    this.render();
  }

  dispose(): void {
    CapabilityProposalPanel.current.delete(`${this.lead}\n${this.branch}`);
    for (const disposable of this.disposables) disposable.dispose();
  }
}
