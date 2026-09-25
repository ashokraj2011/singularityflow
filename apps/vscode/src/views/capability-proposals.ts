/** Pending capability and repository-setup proposals across known repositories. */
import * as vscode from 'vscode';
import {
  brandLockup, contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { integerField, registerMessageRouter } from './messages.ts';
import { gitRemoteProblem, screenGitRemotes } from './map-capability-form.ts';
import { commandGuidance } from '../copilot-command.ts';
import { SetupProposalPanel } from './setup-proposal.ts';
import {
  forgetSetupReviewRepository, rememberSetupReviewRepository, setupReviewRepositories
} from './setup-review-repositories.ts';

interface LeadRepository { url: string }

interface CapabilityProposalSummary {
  branch: string;
  proposalCommit: string;
  changedFiles: Array<{ status: string; paths: string[] }>;
  valid: boolean;
  merged?: boolean;
  status?: string;
  discardable?: boolean;
  cancelable?: boolean;
  configurationError?: string | null;
  configurationErrorCode?: string | null;
  repairable?: boolean;
  repairAction?: { command?: string; skill?: string; copilotCommand?: string } | null;
  failure?: {
    code?: string; message?: string;
    diagnosticAction?: { command?: string; skill?: string; copilotCommand?: string } | null;
    nextAction?: { command?: string; skill?: string; copilotCommand?: string };
  };
}

interface ProposalEntry extends CapabilityProposalSummary { lead: string }
interface SetupProposalSummary {
  branch: string;
  proposalCommit: string;
  changedFiles: Array<{ status: string; paths: string[] }>;
  valid: boolean | null;
  merged: boolean | null;
  status?: string;
}
interface SetupProposalEntry extends SetupProposalSummary { lead: string }
const MAX_MANUALLY_CHECKED_SETUP_REPOSITORIES = 100;

function validSetupSummary(value: unknown): value is SetupProposalSummary {
  if (!value || typeof value !== 'object') return false;
  const proposal = value as Partial<SetupProposalSummary>;
  return typeof proposal.branch === 'string'
    && /^sflow\/config-change\/onboarding\/(?:create|restore|migrate|recreate)-[0-9a-f]{12}$/.test(proposal.branch)
    && typeof proposal.proposalCommit === 'string'
    && /^[0-9a-f]{40,64}$/i.test(proposal.proposalCommit)
    && (proposal.valid === null || typeof proposal.valid === 'boolean')
    && (proposal.merged === null || typeof proposal.merged === 'boolean')
    && Array.isArray(proposal.changedFiles);
}
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

function commandPair(label: string, value: unknown): string {
  const guidance = commandGuidance(value);
  if (!guidance) return '';
  return `<small><strong>${escape(label)}</strong></small>
    <small>Shell: <code>${escape(guidance.command)}</code></small>
    <small>Copilot: <code>${escape(guidance.copilotCommand)}</code></small>`;
}

function remediation(value: unknown): string {
  const paired = commandPair('Remediation', value);
  if (paired) return paired;
  const text = typeof value === 'string' ? value.trim() : '';
  // A command-shaped value that failed the shared safety check is omitted, not downgraded to prose.
  if (!text || /^(?:singularity-flow|sflow)(?:\s|$)/u.test(text)) return '';
  return `<p>Remediation: ${escape(text)}</p>`;
}

function proposalsHtml(entries: ProposalEntry[], setupEntries: SetupProposalEntry[],
  leads: number, failures: LeadFailure[],
  busy: boolean, includeMerged: boolean, integrity: LeadIntegrity[],
  staleSetupRepositories: string[], emptyCheckedSetupRepositories: string[]): string {
  const allEntries = [...entries, ...setupEntries];
  const ready = allEntries.filter((entry) => entry.valid === true && !entry.merged).length;
  const needsInspection = allEntries.filter((entry) => entry.valid === null && !entry.merged).length;
  const blocked = allEntries.filter((entry) => entry.valid === false).length;
  const merged = allEntries.filter((entry) => entry.merged).length;
  const pending = allEntries.length - merged;
  const grouped = new Map<string, Array<{ entry: ProposalEntry; index: number }>>();
  entries.forEach((entry, index) => {
    const rows = grouped.get(entry.lead) ?? [];
    rows.push({ entry, index });
    grouped.set(entry.lead, rows);
  });
  const groups = [...grouped.entries()].map(([lead, rows]) => `<section class="plain">
    <div class="section-heading"><h2>${icon('repository')} Capability proposals · ${escape(lead)}</h2>
      <span class="count-badge">${rows.length}</span></div>
    <div class="configuration-list">${rows.map(({ entry, index }) => `<div class="configuration-row-wrap"><button
        class="configuration-row secondary" data-review="${index}"
        aria-label="Review capability proposal ${escape(shortName(entry.branch))}">
        <span>${icon(entry.valid ? 'merge' : 'warning')}</span>
        <strong>${escape(shortName(entry.branch))}</strong>
        <small>${escape(entry.proposalCommit.slice(0, 12))} · ${entry.changedFiles.length} changed file${entry.changedFiles.length === 1 ? '' : 's'} · ${entry.merged ? 'merged history' : entry.valid ? 'ready for exact review' : escape(entry.status ?? 'blocked by validation')}</small>
        ${entry.configurationError ? `<small class="error-text">${escape(entry.configurationError)}</small>` : ''}
        ${entry.repairable ? '<small>Open this review to prepare the exact packaged compatibility repair.</small>' : ''}
        ${commandPair('Recovery', entry.repairAction)}
        ${entry.failure?.message ? `<small class="error-text">${escape(entry.failure.message)}</small>` : ''}
        ${commandPair('Diagnostic', entry.failure?.diagnosticAction)}
        ${commandPair('Recovery', entry.failure?.nextAction)}
      </button>${entry.cancelable && !entry.merged
        ? `<button class="secondary" data-cancel="${index}" aria-label="Cancel pending mapping ${escape(shortName(entry.branch))}">${icon('remove')} Cancel pending mapping</button>`
        : entry.discardable ? `<button class="secondary" data-discard="${index}" aria-label="Discard stale proposal ${escape(shortName(entry.branch))}">${icon('remove')} Discard stale proposal</button>` : ''}</div>`).join('')}</div>
  </section>`).join('');
  const setupGroups = new Map<string, Array<{ entry: SetupProposalEntry; index: number }>>();
  setupEntries.forEach((entry, index) => {
    const rows = setupGroups.get(entry.lead) ?? [];
    rows.push({ entry, index });
    setupGroups.set(entry.lead, rows);
  });
  const setupHtml = [...setupGroups.entries()].map(([lead, rows]) => `<section class="plain">
    <div class="section-heading"><h2>${icon('configuration')} Repository setup proposals · ${escape(lead)}</h2>
      <span class="count-badge">${rows.length}</span></div>
    <div class="configuration-list">${rows.map(({ entry, index }) => `<button
      class="configuration-row secondary" data-review-setup="${index}"
      aria-label="Review repository setup proposal ${escape(entry.branch)}">
      <span>${icon(entry.valid === false ? 'warning' : 'merge')}</span>
      <strong>${escape(entry.branch)}</strong>
      <small>${escape(entry.proposalCommit)} · ${entry.merged ? 'merged history' : entry.valid === null
        ? 'open to inspect changed files and validation'
        : entry.valid ? 'ready for exact review' : escape(entry.status ?? 'blocked by validation')}</small>
    </button>`).join('')}</div>
  </section>`).join('');
  const integrityHtml = integrity.map((entry) => {
    if (entry.error) return `<div class="notice error"><p><strong>${escape(entry.lead)}</strong>: ${escape(entry.error)}</p></div>`;
    const issues = entry.result?.checks.filter((check) => check.status === 'fail' || check.status === 'warn') ?? [];
    return `<section class="plain"><div class="section-heading"><h2>${icon(entry.result?.valid ? 'ok' : 'warning')} Integrity · ${escape(entry.lead)}</h2>
      <span class="count-badge">${issues.length}</span></div>
      ${issues.length ? issues.map((check) => `<div class="notice ${check.status === 'fail' ? 'error' : 'governance-warning'}"><p><strong>${escape(check.id)}</strong>: ${escape(check.summary)}</p>
        ${check.branch ? `<p><code>${escape(check.branch)}${check.commit ? `@${escape(check.commit)}` : ''}</code></p>` : ''}
        ${remediation(check.remediation)}</div>`).join('')
        : '<div class="notice ok"><p>No capability authority or proposal-integrity issues were detected.</p></div>'}</section>`;
  }).join('');
  return `${brandLockup()}
    <header class="inbox-header">
      <p class="eyebrow">Governed configuration review</p>
      <div class="section-heading"><h1>${icon('merge', { size: 24 })} Review proposals</h1>
        <button class="secondary" data-action="add-setup-repository" ${busy ? 'disabled' : ''}>${icon('repository')} Find setup proposal…</button>
        <button class="secondary" data-action="toggle-history" ${busy ? 'disabled' : ''}>${icon('git')} ${includeMerged ? 'Hide merged history' : 'Show merged history'}</button>
        <button class="secondary" data-action="fsck" ${busy ? 'disabled' : ''}>${icon('policy')} Check integrity</button>
        <button class="secondary" data-action="refresh" ${busy ? 'disabled' : ''}>${icon('refresh')} ${busy ? 'Refreshing…' : 'Refresh'}</button></div>
      <p class="meta">Review capability-map and repository-setup changes across known repositories. If setup began on another laptop or before this extension was installed, check its Git clone URL here. Nothing is merged from this list.</p>
    </header>
    <div class="summary-grid">
      <div class="summary-card"><strong>${leads}</strong><span>Known repositories</span></div>
      <div class="summary-card important"><strong>${pending}</strong><span>Pending proposals</span></div>
      <div class="summary-card"><strong>${ready}</strong><span>Ready for review</span></div>
      <div class="summary-card"><strong>${needsInspection}</strong><span>Needs inspection</span></div>
      <div class="summary-card${blocked ? ' governance-warning' : ''}"><strong>${includeMerged ? merged : blocked}</strong><span>${includeMerged ? 'Merged history' : 'Blocked'}</span></div>
    </div>
    <div class="notice"><p>Opening a proposal shows its exact commit, changed files, and complete diff. Approval attempts an exact update to <code>sflow/config</code>; repository review controls and hooks remain authoritative. Setup rows are brief ref summaries, so open one to verify validation and external merges. Setup proposals from another laptop appear here after its repository URL is used or registered on this laptop.</p></div>
    ${integrityHtml}
    ${failures.map((failure) => `<div class="notice error"><p><strong>${escape(failure.lead)}</strong>: ${escape(failure.message)}</p></div>`).join('')}
    ${staleSetupRepositories.map((lead) => `<div class="notice"><p>No pending setup proposal remains in <code>${escape(lead)}</code>. Its local review shortcut was cleared after a fresh remote check.</p></div>`).join('')}
    ${emptyCheckedSetupRepositories.map((lead) => `<div class="notice"><p>No setup proposal was found in <code>${escape(lead)}</code> during this check.</p></div>`).join('')}
    ${busy && !allEntries.length ? `<div class="empty">${icon('wait')} Reading known repositories and pending proposals…</div>`
      : setupHtml || groups ? `${setupHtml}${groups}`
        : `<div class="empty"><h2>${icon('ok')} ${includeMerged ? 'No proposal history found' : 'No proposals waiting'}</h2><p>${includeMerged ? 'No retained proposal branches are available to inspect.' : 'No known repository has a proposal waiting for review.'}</p></div>`}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const cancel = event.target.closest('[data-cancel]');
    if (cancel) return vscode.postMessage({ type: 'cancel', index: Number(cancel.dataset.cancel) });
    const discard = event.target.closest('[data-discard]');
    if (discard) return vscode.postMessage({ type: 'discard', index: Number(discard.dataset.discard) });
    const review = event.target.closest('[data-review]');
    if (review) return vscode.postMessage({ type: 'review', index: Number(review.dataset.review) });
    const setup = event.target.closest('[data-review-setup]');
    if (setup) return vscode.postMessage({ type: 'review-setup', index: Number(setup.dataset.reviewSetup) });
    const action = event.target.closest('[data-action]');
    if (action && !action.disabled) vscode.postMessage({ type: action.dataset.action });
  });
`;

export class CapabilityProposalsPanel {
  private static current: CapabilityProposalsPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private entries: ProposalEntry[] = [];
  private setupEntries: SetupProposalEntry[] = [];
  private staleSetupRepositories: string[] = [];
  private emptyCheckedSetupRepositories: string[] = [];
  private readonly manuallyCheckedSetupRepositories = new Set<string>();
  private leadCount = 0;
  private failures: LeadFailure[] = [];
  private integrity: LeadIntegrity[] = [];
  private leadUrls: string[] = [];
  private busy = false;
  private includeMerged = false;

  private constructor(private readonly context: vscode.ExtensionContext, private readonly run: Run,
    private readonly onReview: (lead: string, branch: string) => void) {
    this.panel = vscode.window.createWebviewPanel(
      'singularityFlow.capabilityProposals', 'Review proposals', vscode.ViewColumn.Active,
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
      'add-setup-repository': () => { void this.addSetupRepository(); },
      'toggle-history': () => {
        this.includeMerged = !this.includeMerged;
        void this.load();
      },
      fsck: () => { void this.fsck(); },
      cancel: (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.entries[index];
        if (entry?.cancelable && !entry.merged) void this.cancel(entry);
      },
      discard: (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.entries[index];
        if (entry?.discardable) void this.discard(entry);
      },
      review: (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.entries[index];
        if (entry) this.onReview(entry.lead, entry.branch);
      },
      'review-setup': (message) => {
        const index = integerField(message, 'index');
        const entry = index === null ? null : this.setupEntries[index];
        if (entry) SetupProposalPanel.show(this.context, entry.lead, entry.branch,
          entry.proposalCommit, this.run, async () => { await this.load(); });
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
    this.panel.webview.html = page('Review proposals',
      proposalsHtml(this.entries, this.setupEntries, this.leadCount,
        this.failures, this.busy, this.includeMerged, this.integrity,
        this.staleSetupRepositories, this.emptyCheckedSetupRepositories),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  private async load(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.failures = []; this.staleSetupRepositories = [];
    this.emptyCheckedSetupRepositories = []; this.render();
    const leadsResponse = await this.run(['capability', 'leads', '--json']);
    const rawLeads = Array.isArray(leadsResponse.result)
      ? (leadsResponse.result as LeadRepository[]).map((lead) => lead?.url) : [];
    const screened = screenGitRemotes(rawLeads, 'Registered capability-map repository');
    const cachedSetupUrls = setupReviewRepositories(this.context.globalState);
    const leads = screened.accepted.map((url) => ({ url }));
    const setupLeads = [...new Set([
      ...screened.accepted, ...cachedSetupUrls, ...this.manuallyCheckedSetupRepositories
    ])];
    const registryFailures: LeadFailure[] = screened.rejected.map((entry) => ({
      lead: `Rejected registry entry · sha256:${entry.fingerprint.slice(0, 12)}`,
      message: entry.message
    }));
    if (leadsResponse.error) registryFailures.unshift({
      lead: 'Capability lead registry', message: leadsResponse.error
    });
    this.leadUrls = screened.accepted;
    this.leadCount = setupLeads.length;
    const [results, setupResults] = await Promise.all([
      Promise.all(leads.map(async (lead) => {
        const response = await this.run([
          'capability', 'proposals', '--lead', lead.url,
          ...(this.includeMerged ? ['--all'] : []), '--json'
        ]);
        if (response.error) return { lead: lead.url, proposals: [], error: response.error };
        const payload = response.result as { proposals?: CapabilityProposalSummary[] } | null;
        return { lead: lead.url, proposals: Array.isArray(payload?.proposals) ? payload.proposals : [], error: null };
      })),
      Promise.all(setupLeads.map(async (lead) => {
        const response = await this.run([
          'capability', 'setup-proposals', '--lead', lead,
          ...(this.includeMerged ? ['--all'] : []), '--json'
        ]);
        if (response.error) return { lead, proposals: [], error: response.error, complete: false };
        const payload = response.result as { proposals?: SetupProposalSummary[] } | null;
        if (!Array.isArray(payload?.proposals)) return {
          lead, proposals: [], error: 'The CLI returned an incompatible setup proposal list.', complete: false
        };
        if (payload.proposals.some((proposal) => !validSetupSummary(proposal))) return {
          lead, proposals: [], error: 'The CLI returned an unsupported setup proposal summary.', complete: false
        };
        return { lead, proposals: payload.proposals, error: null, complete: true };
      }))
    ]);
    this.entries = results.flatMap((result) => result.proposals
      .filter((proposal) => this.includeMerged || !proposal.merged)
      .map((proposal) => ({ ...proposal, lead: result.lead })));
    this.setupEntries = setupResults.flatMap((result) => result.proposals
      .filter((proposal) => this.includeMerged || !proposal.merged)
      .map((proposal) => ({ ...proposal, lead: result.lead })));
    this.failures = [...registryFailures, ...results.filter((result) => result.error)
      .map((result) => ({ lead: result.lead, message: result.error as string })),
    ...setupResults.filter((result) => result.error)
      .map((result) => ({ lead: result.lead, message: `Setup proposals: ${result.error}` }))];
    this.staleSetupRepositories = setupResults.filter((result) => result.complete
      && cachedSetupUrls.includes(result.lead)
      && !result.proposals.some((proposal) => !proposal.merged))
      .map((result) => result.lead);
    this.emptyCheckedSetupRepositories = setupResults.filter((result) => result.complete
      && this.manuallyCheckedSetupRepositories.has(result.lead)
      && result.proposals.length === 0)
      .map((result) => result.lead);
    const discovered = setupResults.filter((result) => result.complete
      && this.manuallyCheckedSetupRepositories.has(result.lead)
      && result.proposals.some((proposal) => !proposal.merged))
      .map((result) => result.lead);
    const remembered = await Promise.allSettled(discovered
      .map((lead) => rememberSetupReviewRepository(this.context.globalState, lead)));
    remembered.forEach((result, index) => {
      if (result.status === 'fulfilled') this.manuallyCheckedSetupRepositories.delete(discovered[index]!);
    });
    for (const lead of this.emptyCheckedSetupRepositories) {
      this.manuallyCheckedSetupRepositories.delete(lead);
    }
    await Promise.allSettled(this.staleSetupRepositories
      .map((lead) => forgetSetupReviewRepository(this.context.globalState, lead)));
    this.busy = false; this.render();
  }

  private async addSetupRepository(): Promise<void> {
    if (this.busy) return;
    const entered = await vscode.window.showInputBox({
      title: 'Check repository setup proposals',
      prompt: 'Paste the credential-free Git clone URL for the repository whose setup is pending review.',
      placeHolder: 'https://git.example/team/service.git',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim()
        ? gitRemoteProblem(value.trim(), 'Repository')
        : 'Enter a Git clone URL.'
    });
    if (entered == null) return;
    const repository = entered.trim();
    if (!repository || gitRemoteProblem(repository, 'Repository')) return;
    if (!this.manuallyCheckedSetupRepositories.has(repository)
      && this.manuallyCheckedSetupRepositories.size >= MAX_MANUALLY_CHECKED_SETUP_REPOSITORIES) {
      void vscode.window.showWarningMessage(
        'This review session has reached its 100-repository check limit. Reopen Review Proposals to start a fresh session.'
      );
      return;
    }
    this.manuallyCheckedSetupRepositories.add(repository);
    await this.load();
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

  private async cancel(entry: ProposalEntry): Promise<void> {
    if (this.busy || !entry.cancelable || entry.merged) return;
    const reason = await vscode.window.showInputBox({
      title: 'Cancel pending capability mapping',
      prompt: 'Why should this unmerged mapping proposal be cancelled?',
      placeHolder: 'Replaced by a corrected capability mapping',
      validateInput: (value) => value.trim() && value.trim().length <= 500
        ? null : 'Enter a reason of 500 characters or fewer.',
      ignoreFocusOut: true
    });
    if (!reason?.trim() || reason.trim().length > 500) return;
    const confirmation = 'Cancel exact pending mapping';
    const accepted = await vscode.window.showWarningMessage(
      `Cancel ${entry.branch}@${entry.proposalCommit.slice(0, 12)}?`,
      { modal: true, detail: 'Only this exact unmerged Git review branch is deleted. If the branch moved or was merged, cancellation refuses. Approved configuration, state, application branches, and other proposals are preserved.' },
      confirmation
    );
    if (accepted !== confirmation) return;
    this.busy = true; this.render();
    const response = await this.run([
      'capability', 'cancel-proposal', entry.branch,
      '--lead', entry.lead, '--confirm', entry.proposalCommit,
      '--reason', reason.trim(), '--json'
    ]);
    this.busy = false;
    if (response.error || (response.result as { status?: string } | null)?.status !== 'cancelled') {
      this.failures = [{ lead: entry.lead,
        message: response.error ?? 'The engine did not confirm cancellation; the proposal remains pending until rechecked.' },
      ...this.failures];
      this.render();
      return;
    }
    void vscode.window.showInformationMessage(
      `Cancelled pending mapping ${shortName(entry.branch)}; approved configuration was preserved.`);
    await this.load();
  }

  dispose(): void {
    CapabilityProposalsPanel.current = null;
    for (const disposable of this.disposables) disposable.dispose();
  }
}
