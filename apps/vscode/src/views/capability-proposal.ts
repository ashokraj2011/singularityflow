/** Review and activate a capability proposal without leaving VS Code. */
import * as vscode from 'vscode';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { COMMAND_GUIDANCE_COPY_SCRIPT, commandGuidanceHtml } from './command-guidance.ts';
import { capabilityActivationSucceeded } from './capability-proposal-model.ts';

export interface CapabilityProposal {
  remote: string;
  branch: string;
  targetBranch: string;
  targetCommit: string;
  proposalCommit: string;
  proposalBase: string;
  merged: boolean;
  valid: boolean;
  configurationError?: string | null;
  configurationErrorCode?: string | null;
  repairable?: boolean;
  repairAction?: { command?: string; skill?: string; copilotCommand?: string } | null;
  invalidFiles: string[];
  changedFiles: Array<{ status: string; paths: string[] }>;
  diff: string;
}

interface ActivationResult {
  status?: 'activated' | 'activated-without-projection' | 'activation-complete-projection-pending'
    | 'review-required' | 'activation-pending';
  activated?: boolean;
  targetBranch: string;
  targetCommit: string;
  proposalCommit: string;
  alreadyMerged: boolean;
  projection?: { published?: boolean; pending?: boolean; branch?: string; commit?: string; reason?: string } | null;
  audit?: { recorded?: boolean; eventId?: string; sequence?: number; ledgerCommit?: string };
  failure?: { code?: string; classification?: string; retryable?: boolean; message?: string };
  externalAction?: { action: string; sourceBranch: string; targetBranch: string; proposalCommit: string } | null;
  nextAction?: { command?: string; skill?: string; copilotCommand?: string } | null;
  preserved?: string[];
}

interface ProposalRepairResult {
  repaired?: boolean;
  proposalCommit: string;
  changedFiles?: string[];
}

type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null }>;

function fileChangeLabel(status: string): string {
  if (status.startsWith('A')) return 'Added';
  if (status.startsWith('M')) return 'Updated';
  if (status.startsWith('D')) return 'Removed';
  if (status.startsWith('R')) return 'Renamed';
  if (status.startsWith('C')) return 'Copied';
  return status;
}

function reviewHtml(proposal: CapabilityProposal | null, busy: boolean, error: string | null,
  activated: ActivationResult | null): string {
  if (!proposal) return `${brandLockup({ compact: true })}
    <header><h1>${icon('merge', { size: 24 })} Review capability proposal</h1>
    <p class="meta">Loading the exact configuration change from Git…</p></header>
    ${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}`;
  const files = proposal.changedFiles.map((file) => `<tr>
      <td>${escape(fileChangeLabel(file.status))}</td><td><code>${escape(file.paths.join(' → '))}</code></td></tr>`).join('');
  const changeSummary = proposal.merged
    ? `This proposal has already been merged into ${proposal.targetBranch}. Check the changed files, then record its activation.`
    : `This proposal changes ${proposal.changedFiles.length} ${proposal.changedFiles.length === 1 ? 'file' : 'files'} on ${proposal.targetBranch}. Check the changed files before merging this exact commit.`;
  const projection = activated?.projection;
  const activationComplete = capabilityActivationSucceeded(activated);
  // The engine proves repairability against the exact mismatching Agent Markdown bytes at the
  // reviewed Git ref. Never infer that safety boundary from human-readable error text.
  const packagedRepairAvailable = !proposal.merged && proposal.repairable === true;
  const activationNotice = !activated ? '' : activationComplete
    ? `<div class="notice ok"><p><strong>Capability activated.</strong> ${escape(
      activated.alreadyMerged ? 'The externally merged proposal is now audited.' : `Approved ${activated.targetBranch} now points to ${activated.targetCommit.slice(0, 12)}.`
    )}</p><p>${escape(projection?.published
      ? `Projection published to ${projection.branch}@${projection.commit?.slice(0, 12)}.`
      : projection?.branch ? `${projection.branch} was already current.`
        : `Projection: ${projection?.reason ?? 'not available'}.`)}</p>${activated.audit?.eventId
          ? `<p>Activation audit: <code>${escape(activated.audit.eventId)}</code>${activated.audit.sequence == null ? '' : ` at ledger sequence ${activated.audit.sequence}`}.</p>`
          : ''}${activated.nextAction?.command
            ? commandGuidanceHtml(activated.nextAction, { shellLabel: 'Recovery — Shell', copilotLabel: 'Recovery — Copilot' }) : ''}</div>`
    : `<div class="notice governance-warning"><p><strong>Activation is waiting.</strong> ${escape(
      activated.failure?.message ?? `Status: ${activated.status ?? 'review-required'}.`
    )}</p>${activated.externalAction
      ? `<p>Merge <code>${escape(activated.externalAction.sourceBranch)}</code> into <code>${escape(activated.externalAction.targetBranch)}</code> through the repository review controls.</p>`
      : ''}${activated.nextAction?.command
      ? `<p>After correcting the blocker, retry the same exact activation:</p>${commandGuidanceHtml(activated.nextAction)}`
      : ''}<p>Preserved: ${escape((activated.preserved ?? ['proposal branch', 'approved configuration', 'application branches']).join(', '))}.</p></div>`;
  return `${brandLockup({ compact: true })}
    <header class="inbox-header">
      <p class="eyebrow">Governed configuration review</p>
      <h1>${icon('merge', { size: 24 })} Review capability proposal</h1>
      <p class="meta">${escape(changeSummary)}</p>
    </header>
    ${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}
    ${activationNotice}
    <div class="summary-grid">
      <div class="summary-card"><span>Proposal</span><strong>${escape(proposal.proposalCommit.slice(0, 12))}</strong></div>
      <div class="summary-card"><span>Approved target</span><strong>${escape(proposal.targetCommit.slice(0, 12))}</strong></div>
      <div class="summary-card"><span>Files</span><strong>${proposal.changedFiles.length}</strong></div>
      <div class="summary-card ${proposal.valid ? '' : 'governance-warning'}"><span>Validation</span><strong>${proposal.valid ? 'Ready' : 'Blocked'}</strong></div>
    </div>
    <section>
      <h2>${icon('configuration')} Changed files</h2>
      ${proposal.changedFiles.length
        ? `<div class="table-wrap"><table><thead><tr><th>Change</th><th>Path</th></tr></thead><tbody>${files}</tbody></table></div>`
        : '<p class="muted">No changed files were reported.</p>'}
      ${proposal.invalidFiles.length ? `<div class="notice error"><p>Non-configuration files are refused: ${escape(proposal.invalidFiles.join(', '))}</p></div>` : ''}
      ${proposal.configurationError ? `<div class="notice governance-warning"><p><strong>Configuration compatibility needs attention.</strong> ${escape(proposal.configurationError)}</p>${proposal.repairable
        ? '<p>The recognized historical packaged files can be repaired on this proposal branch without changing approved configuration or application code. The new commit must be reviewed again.</p>'
        : proposal.repairAction?.command
          ? commandGuidanceHtml(proposal.repairAction, { shellLabel: 'Next — Shell', copilotLabel: 'Next — Copilot' })
          : ''}</div>` : ''}
    </section>
    <section class="plain">
      <h2>${icon('branch')} Source and target</h2>
      <div class="review-binding">
        <span>Review branch</span><code>${escape(proposal.branch)}</code>
        <span>Exact commit</span><code>${escape(proposal.proposalCommit)}</code>
        <span>Target branch</span><code>${escape(proposal.targetBranch)}</code>
        <span>Lead repository</span><code>${escape(proposal.remote)}</code>
      </div>
      <div class="notice"><p>The application default branch is not part of this operation. Activation uses a normal, non-force push to <code>${escape(proposal.targetBranch)}</code>; repository branch protection still applies.</p></div>
      <details class="configuration-advanced-tools"><summary>${icon('compare')} View Git diff</summary>
        <div class="help-code"><pre><code>${escape(proposal.diff || 'No textual diff.')}</code></pre></div>
      </details>
    </section>
    <section class="next">
      ${proposal.merged
        ? '<p class="muted">Record the activation audit and publish the capability projection for this already merged commit.</p>'
        : `<p class="muted">Merge and acknowledge authorizes one exact leased update of <code>${escape(proposal.proposalCommit)}</code> to <code>${escape(proposal.targetBranch)}</code> if the repository permits direct pushes. Branch protection and server hooks still apply.</p>`}
      <div class="actions">
        <button class="primary" data-action="activate" ${busy || !proposal.valid || activationComplete && Boolean(activated) ? 'disabled' : ''}>${icon('merge')} ${busy ? 'Activating…' : proposal.merged ? 'Record merged activation' : activated && !activationComplete ? `Retry merge and acknowledge ${escape(proposal.proposalCommit.slice(0, 12))}` : `Merge and acknowledge ${escape(proposal.proposalCommit.slice(0, 12))}`}</button>
        ${packagedRepairAvailable
          ? `<button class="secondary" data-action="repair" ${busy ? 'disabled' : ''}>${icon('refresh')} Prepare compatibility repair</button>` : ''}
        <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} Refresh</button>
        <button class="secondary" data-action="copy">${icon('branch')} Copy branch</button>
      </div>
    </section>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    ${COMMAND_GUIDANCE_COPY_SCRIPT}
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
  private readonly activationCallbacks = new Set<(result: ActivationResult) => Promise<void>>();

  private constructor(
    context: vscode.ExtensionContext,
    private readonly lead: string,
    private readonly branch: string,
    private readonly run: Run,
    onActivated?: (result: ActivationResult) => Promise<void>
  ) {
    if (onActivated) this.activationCallbacks.add(onActivated);
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
      if (onActivated) existing.activationCallbacks.add(onActivated);
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
    if (message.type === 'repair' && this.proposal?.repairable === true && !this.busy) {
      const proposal = this.proposal;
      const label = 'Prepare repair for review';
      const accepted = await vscode.window.showWarningMessage(
        `Prepare a compatibility repair on ${proposal.branch}@${proposal.proposalCommit.slice(0, 12)}?`,
        { modal: true, detail: 'Only missing packaged files and byte-exact historical SFlow package files can change. Repository-customized files, the approved configuration, state, and application branches remain untouched. The resulting commit must be reviewed again before activation.' },
        label);
      if (accepted !== label) return;
      this.busy = true; this.error = null; this.render();
      const repaired = await this.run([
        'capability', 'repair-proposal', proposal.branch, '--lead', this.lead,
        '--confirm', proposal.proposalCommit, '--json'
      ]);
      this.busy = false;
      if (repaired.error) {
        this.error = repaired.error;
        if (/No recognized historical packaged files remain|repository-customized and requires a normal reviewed configuration change/i.test(repaired.error)) {
          this.proposal = { ...proposal, repairable: false };
        }
        this.render();
        return;
      }
      const result = repaired.result as ProposalRepairResult;
      this.activated = null;
      this.error = null;
      void vscode.window.showInformationMessage(result.repaired
        ? `Compatibility repair prepared at ${result.proposalCommit.slice(0, 12)}. Review the updated diff before merging.`
        : 'This capability proposal is already compatible.');
      await this.load();
      return;
    }
    if (message.type !== 'activate' || !this.proposal || !this.proposal.valid || this.busy) return;
    const proposal = this.proposal;
    const externallyMerged = proposal.merged;
    this.busy = true; this.error = null; this.render();
    const baseArguments = [
      'capability', 'activate', proposal.branch, '--lead', this.lead,
      '--confirm', proposal.proposalCommit,
      ...(externallyMerged ? [] : ['--acknowledge-unprotected']), '--json'
    ];
    const { result, error } = await this.run(baseArguments);
    this.busy = false;
    if (error) this.error = error;
    else {
      this.activated = result as ActivationResult;
      if (capabilityActivationSucceeded(this.activated)) {
        const followUps = await Promise.allSettled(
          [...this.activationCallbacks].map((callback) => callback(this.activated as ActivationResult))
        );
        const failedFollowUps = followUps.filter((followUp) => followUp.status === 'rejected');
        if (failedFollowUps.length) {
          this.error = `Capability activation succeeded, but ${failedFollowUps.length} UI follow-up action(s) failed. Refresh the affected page; do not repeat the activation.`;
        }
        void vscode.window.showInformationMessage(
          `Capability configuration activated on ${this.activated.targetBranch}.`);
      } else {
        void vscode.window.showWarningMessage(
          this.activated.failure?.message ?? 'Capability activation is waiting for repository review.');
      }
    }
    this.render();
  }

  dispose(): void {
    CapabilityProposalPanel.current.delete(`${this.lead}\n${this.branch}`);
    this.activationCallbacks.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
