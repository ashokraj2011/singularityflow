/** Exact repository-setup proposal review. The CLI remains the authority for validation and writes. */
import * as vscode from 'vscode';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page
} from './webview.ts';
import { navigateTo } from './navigate.ts';
import { sameGitRepository } from '../repository-refresh-model.ts';
import { gitRemoteProblem } from './map-capability-form.ts';

export interface SetupProposal {
  remote: string;
  branch: string;
  targetBranch: 'sflow/config';
  targetCommit: string | null;
  proposalCommit: string;
  merged: boolean;
  valid: boolean;
  status?: string;
  changedFiles: Array<{ status: string; paths: string[] }>;
  diff: string | null;
  failure?: { code?: string; message?: string } | null;
}

interface SetupActivation {
  status: 'activated' | 'review-required' | 'activation-pending';
  activated: boolean;
  targetBranch: 'sflow/config';
  targetCommit: string | null;
  proposalCommit: string;
  failure?: { code?: string; classification?: string; message?: string } | null;
  externalAction?: {
    action: string; sourceBranch: string; targetBranch: string; proposalCommit: string
  } | null;
}

type Run = (argv: string[]) => Promise<{ result: unknown; error: string | null; errorCode?: string | null }>;
const COMMIT = /^[0-9a-f]{40,64}$/i;
const BRANCH = /^sflow\/config-change\/onboarding\/(?:create|restore|migrate|recreate)-[0-9a-f]{12}$/;

function setupProposal(value: unknown, lead: string, branch: string): SetupProposal | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SetupProposal>;
  if (typeof candidate.remote !== 'string' || !sameGitRepository(candidate.remote, lead)
    || candidate.branch !== branch
    || candidate.targetBranch !== 'sflow/config'
    || typeof candidate.proposalCommit !== 'string' || !COMMIT.test(candidate.proposalCommit)
    || (candidate.targetCommit != null && !COMMIT.test(candidate.targetCommit))
    || typeof candidate.merged !== 'boolean' || typeof candidate.valid !== 'boolean'
    || !Array.isArray(candidate.changedFiles)
    || candidate.changedFiles.some((file) => typeof file?.status !== 'string'
      || !Array.isArray(file.paths) || file.paths.some((path) => typeof path !== 'string'))
    || (candidate.diff != null && typeof candidate.diff !== 'string')) return null;
  return candidate as SetupProposal;
}

function setupActivation(value: unknown, proposal: SetupProposal): SetupActivation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SetupActivation>;
  if (!['activated', 'review-required', 'activation-pending'].includes(candidate.status ?? '')
    || typeof candidate.activated !== 'boolean'
    || candidate.targetBranch !== 'sflow/config'
    || candidate.proposalCommit !== proposal.proposalCommit
    || (candidate.targetCommit != null && !COMMIT.test(candidate.targetCommit))) return null;
  return candidate as SetupActivation;
}

export function setupProposalHtml(
  proposal: SetupProposal | null, lead: string, branch: string, expectedCommit: string | null,
  busy: boolean, error: string | null, activation: SetupActivation | null
): string {
  const header = `${brandLockup({ compact: true })}<header class="inbox-header">
    <p class="eyebrow">Repository setup</p>
    <h1>${icon('merge', { size: 24 })} Review setup proposal</h1>
    <p class="meta">Review the exact commit and configuration changes before approval.</p>
  </header>`;
  if (!proposal) return `${header}${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}
    <section class="plain"><p>Repository: <code>${escape(lead)}</code></p>
    <p>Review branch: <code>${escape(branch)}</code></p>
    ${expectedCommit ? `<p>Expected commit: <code>${escape(expectedCommit)}</code></p>` : ''}
    <p>${busy ? 'Loading the setup proposal from Git…' : 'The exact setup proposal is unavailable. Refresh to retry.'}</p>
    <button class="secondary" data-action="refresh">Refresh</button></section>`;
  const moved = expectedCommit != null && proposal.proposalCommit !== expectedCommit;
  const completed = activation?.activated === true && activation.status === 'activated';
  const files = proposal.changedFiles.map((file) => `<tr><td><code>${escape(file.status)}</code></td>
    <td>${escape(file.paths.join(' to '))}</td></tr>`).join('');
  const activationNotice = !activation ? '' : completed
    ? `<div class="notice ok"><p><strong>Setup approved.</strong> <code>sflow/config</code> now points to <code>${escape(activation.targetCommit ?? '')}</code>. Recheck repository setup to continue mapping.</p></div>`
    : `<div class="notice warning"><p><strong>Approval is waiting.</strong> ${escape(activation.failure?.message
      ?? 'The repository requires its review process before this proposal can become approved configuration.')}</p>
      ${activation.externalAction ? `<p>Review and merge <code>${escape(activation.externalAction.sourceBranch)}</code> into <code>${escape(activation.externalAction.targetBranch)}</code> through the repository controls.</p>` : ''}</div>`;
  return `${header}${error ? `<div class="notice error"><p>${escape(error)}</p></div>` : ''}
    ${activationNotice}
    ${moved ? `<div class="notice warning"><p>The proposal moved since repository setup returned. This screen loaded its current exact commit; review the diff below before approval.</p></div>` : ''}
    <section class="plain"><h2>${icon('branch')} Source and target</h2>
      <div class="review-binding">
        <span>Repository</span><code>${escape(proposal.remote)}</code>
        <span>Review branch</span><code>${escape(proposal.branch)}</code>
        <span>Exact commit</span><code>${escape(proposal.proposalCommit)}</code>
        <span>Approved target</span><code>${escape(proposal.targetBranch)}</code>
        <span>Target commit</span><code>${escape(proposal.targetCommit ?? 'Not created yet')}</code>
      </div>
      <div class="notice"><p>${proposal.targetCommit
        ? 'Approval updates sflow/config to the reviewed setup commit.'
        : 'sflow/config has not been created. Approval creates it from this reviewed setup commit if the repository permits the exact update.'}</p></div>
    </section>
    <section><h2>${icon('configuration')} Configuration changes</h2>
      <div class="table-wrap"><table><thead><tr><th>Status</th><th>Path</th></tr></thead>
        <tbody>${files}</tbody></table></div>
      ${!proposal.valid ? `<div class="notice warning"><p>${escape(proposal.failure?.message
        ?? proposal.status ?? 'This setup proposal is blocked by validation.')}</p></div>` : ''}
      ${proposal.diff == null ? '<div class="notice warning"><p>The full diff could not be loaded. Refresh before approving this exact commit.</p></div>' : ''}
    </section>
    <section><h2>${icon('compare')} Proposed diff</h2>
      <div class="help-code"><pre><code>${escape(proposal.diff || 'No textual diff.')}</code></pre></div>
    </section>
    <section class="next"><div class="actions">
      <button class="primary" data-action="activate" ${busy || !proposal.valid || proposal.diff == null || completed ? 'disabled' : ''}>${icon('merge')} ${busy ? 'Checking approval…' : proposal.merged ? 'Record reviewed setup' : 'Approve setup proposal'}</button>
      <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} Refresh</button>
      <button class="secondary" data-action="copy">${icon('branch')} Copy branch</button>
    </div></section>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button && !button.disabled) vscode.postMessage({ type: button.dataset.action });
  });
`;

export class SetupProposalPanel {
  private static current = new Map<string, SetupProposalPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private proposal: SetupProposal | null = null;
  private activation: SetupActivation | null = null;
  private busy = false;
  private error: string | null = null;
  private readonly callbacks = new Set<() => Promise<void>>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly lead: string,
    private readonly branch: string,
    private readonly expectedCommit: string | null,
    private readonly run: Run,
    onActivated?: () => Promise<void>
  ) {
    if (onActivated) this.callbacks.add(onActivated);
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.setupProposal', 'Setup proposal review', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
    );
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      const message = raw as { type?: string };
      void this.receive(message);
    }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
    void this.load();
  }

  static show(context: vscode.ExtensionContext, lead: string, branch: string,
    expectedCommit: string | null, run: Run,
    onActivated?: () => Promise<void>): SetupProposalPanel | null {
    if (gitRemoteProblem(lead, 'Repository') || !BRANCH.test(branch)
      || (expectedCommit != null && !COMMIT.test(expectedCommit))) return null;
    const key = `${lead}\n${branch}`;
    const existing = this.current.get(key);
    if (existing) {
      if (onActivated) existing.callbacks.add(onActivated);
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.load();
      return existing;
    }
    const created = new SetupProposalPanel(context, lead, branch, expectedCommit, run, onActivated);
    this.current.set(key, created);
    return created;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Setup proposal review',
      setupProposalHtml(this.proposal, this.lead, this.branch, this.expectedCommit,
        this.busy, this.error, this.activation),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.error = null; this.proposal = null; this.render();
    const response = await this.run([
      'capability', 'setup-proposal', this.branch, '--lead', this.lead, '--json'
    ]);
    this.busy = false;
    if (response.error) this.error = response.error;
    else {
      this.proposal = setupProposal(response.result, this.lead, this.branch);
      if (!this.proposal) this.error = 'The CLI returned an incompatible setup proposal. Refresh after updating SFlow.';
    }
    this.render();
  }

  private async receive(message: { type?: string }): Promise<void> {
    if (message.type === 'refresh') return this.load();
    if (message.type === 'copy') {
      await vscode.env.clipboard.writeText(this.branch);
      return;
    }
    if (message.type !== 'activate' || !this.proposal || !this.proposal.valid
      || this.proposal.diff == null || this.busy) return;
    const proposal = this.proposal;
    const label = proposal.merged ? 'Record reviewed setup' : 'Approve exact setup';
    const accepted = await vscode.window.showWarningMessage(
      `${label}: ${proposal.branch}@${proposal.proposalCommit.slice(0, 12)}?`,
      { modal: true, detail: `The exact reviewed configuration change targets ${proposal.targetBranch}. The repository may require its own review controls before the update is accepted.` },
      label
    );
    if (accepted !== label) return;
    this.busy = true; this.error = null; this.render();
    const argv = ['capability', 'setup-activate', proposal.branch, '--lead', this.lead,
      '--confirm', proposal.proposalCommit, '--json'];
    let attempted = await this.run(argv);
    if (attempted.error && /REPOSITORY_ONBOARDING_CONFIGURATION_UNPROTECTED|CAPABILITY_CONFIGURATION_UNPROTECTED|cannot prove whether|branch protection is not enforced/i.test(
      attempted.errorCode ?? attempted.error
    )) {
      this.busy = false; this.error = attempted.error; this.render();
      const acknowledgement = 'Acknowledge unprotected branch';
      const acknowledged = await vscode.window.showWarningMessage(
        `Git cannot verify whether ${proposal.targetBranch} requires repository review. Authorize one exact update for ${proposal.branch}@${proposal.proposalCommit.slice(0, 12)}?`,
        { modal: true, detail: 'This authorizes only the reviewed commit. Server hooks and review controls can still refuse the update.' },
        acknowledgement
      );
      if (acknowledged !== acknowledgement) return;
      this.busy = true; this.error = null; this.render();
      attempted = await this.run([...argv.slice(0, -1), '--acknowledge-unprotected', '--json']);
    }
    this.busy = false;
    if (attempted.error) this.error = attempted.error;
    else {
      this.activation = setupActivation(attempted.result, proposal);
      if (!this.activation) this.error = 'The CLI returned an incompatible setup approval result. Recheck the repository before retrying.';
      else if (this.activation.activated && this.activation.status === 'activated') {
        await Promise.allSettled([...this.callbacks].map((callback) => callback()));
      }
    }
    this.render();
  }

  dispose(): void {
    SetupProposalPanel.current.delete(`${this.lead}\n${this.branch}`);
    this.callbacks.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
