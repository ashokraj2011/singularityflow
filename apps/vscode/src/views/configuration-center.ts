/** First-class VS Code configuration for humans, approvals, MCP, and the other designers. */
import * as vscode from 'vscode';
import { DEFAULT_WORLD_MODEL_SLICE_LEASE_MS, type SliceLease, type WorkspaceStore } from '../state.ts';
import type { RepositorySnapshot } from '../cli/snapshot.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  configurationCenterView, configurationPendingProposalStatus, configurationRefreshDecision,
  pendingConfigurationProposal,
  prepareWorldModelDraftForSave,
  updateAuthorityYaml, updateAutoYaml, updateMcpYaml, updateWorldModelYaml,
  validateAuthorityDraft, validateAutoDraft, validateMcpDraft, validateWorldModelDraft,
  CONFIGURATION_TABS,
  type AutoDraft, type AuthorityDraft, type AuthorityView, type ConfigurationTab, type McpDraft, type McpServerView,
  type ConfigurationProposalObservation, type PendingConfigurationProposal,
  type WorldModelDraft
} from './configuration-center-model.ts';
import {
  configurationSavePlan, type ConfigurationSaveDisposition, type ConfigurationSavePlan
} from './configuration-save.ts';
import { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } from './configuration-center-page.ts';
import { RetainedPanelRenderGate } from '../single-flight.ts';

export type ConfigurationCenterMessage =
  | ({ type: 'save'; path: string; content: string } & ConfigurationSavePlan)
  | { type: 'profile'; name: string; role: string }
  | {
      type: 'add-current-identity'; target: string;
      allowSelfApproval: boolean; autoEnrollNewIdentities: boolean;
    }
  | { type: 'action'; action: string }
  | { type: 'proposal-status'; branch: string; proposalCommit: string }
  /**
   * Open a repository file the Center listed. Carries the path rather than an action name because
   * the set is data — every template in the catalog — not a fixed vocabulary of commands.
   */
  | { type: 'open-path'; path: string }
  | { type: 'open-world-model-ref'; ref: string };

/** Saves return their actual CLI disposition; all other messages retain the simple error contract. */
export type ConfigurationCenterReply = string | null | {
  error: string | null;
  disposition: ConfigurationSaveDisposition;
} | {
  error: string | null;
  proposals: ConfigurationProposalObservation[];
} | {
  error: string | null;
  proposalStatus: ConfigurationProposalObservation & { branchStatus: string };
};

type ConfigurationSaveOutcome = {
  error: string | null;
  disposition: ConfigurationSaveDisposition | null;
};

const emptyAuthority = (): AuthorityView => ({ id: '', label: '', scope: 'story', allowAnyGitIdentity: false, members: [] });
const emptyMcp = (): McpServerView => ({ id: '', label: '', hostReference: '', agents: [], phases: [], tools: [], required: false, approval: 'confirm', configured: false, sources: [], captureToolCalls: true, captureResults: false });

export class ConfigurationCenterPanel {
  private static current: ConfigurationCenterPanel | null = null;
  private tab: ConfigurationTab = 'overview';
  private authorityKey: string | null = null;
  private mcpId: string | null = null;
  private newAuthority = false;
  private newMcp = false;
  private notice: string | null = null;
  private errors: string[] = [];
  private dirty = false;
  private saving = false;
  private reloadInFlight = false;
  private refreshPending = false;
  private pendingProposal: PendingConfigurationProposal | null = null;
  private disposed = false;
  private renderedTexts = { definitionText: '', portfolioText: '' };
  private renderedConfigurationSource: RepositorySnapshot['configurationSource'] = undefined;
  private readonly subscription: { dispose(): void };
  private readonly snapshotRenders: RetainedPanelRenderGate;
  private readonly disposables: vscode.Disposable[] = [];
  private worldModelLease: SliceLease | null;
  private worldModelLeaseAcquisition: Promise<void> | null = null;
  private worldModelRenewal: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly profile: () => { name: string; role: string },
    private readonly onMessage: (message: ConfigurationCenterMessage) => Promise<ConfigurationCenterReply>,
    private readonly lease: SliceLease,
    initialTab: ConfigurationTab,
    worldModelLease: SliceLease | null
  ) {
    this.tab = initialTab;
    this.worldModelLease = worldModelLease;
    this.armWorldModelRenewal();
    this.snapshotRenders = new RetainedPanelRenderGate(
      () => this.panel.visible !== false,
      () => this.storeChanged(),
      ['repository', 'configuration', 'integrations', 'worldModel']
    );
    this.subscription = store.onDidChange((_state, change) =>
      this.snapshotRenders.changed(change.kind, change.changedSlices));
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.receive(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState?.(({ webviewPanel }) => {
      const visible = webviewPanel.visible !== false;
      this.snapshotRenders.visibilityChanged(visible);
      if (visible && this.tab === 'world-model') {
        void this.ensureWorldModelLease().then(() => this.render());
      }
    }, null, this.disposables);
    this.render();
  }

  static async show(context: vscode.ExtensionContext, store: WorkspaceStore, profile: () => { name: string; role: string }, onMessage: (message: ConfigurationCenterMessage) => Promise<ConfigurationCenterReply>, tab: ConfigurationTab = 'overview'): Promise<ConfigurationCenterPanel> {
    if (ConfigurationCenterPanel.current) {
      await ConfigurationCenterPanel.current.restorePendingProposal();
      await ConfigurationCenterPanel.current.selectTab(tab);
      ConfigurationCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ConfigurationCenterPanel.current;
    }
    const lease = await store.acquireSlices(['configuration', 'integrations']);
    let worldModelLease: SliceLease | null = null;
    if (tab === 'world-model') {
      try {
        worldModelLease = await store.acquireSlices(
          'world-model-explorer', ['worldModel'], { ttlMs: DEFAULT_WORLD_MODEL_SLICE_LEASE_MS }
        );
      } catch (error) {
        lease.dispose();
        throw error;
      }
    }
    const raced = ConfigurationCenterPanel.current as ConfigurationCenterPanel | null;
    if (raced) {
      lease.dispose();
      worldModelLease?.dispose();
      await raced.restorePendingProposal();
      await raced.selectTab(tab);
      raced.panel.reveal(vscode.ViewColumn.Active);
      return raced;
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel('singularityFlow.configurationCenter', 'Configuration Center', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
      ConfigurationCenterPanel.current = new ConfigurationCenterPanel(
        panel, store, profile, onMessage, lease, tab, worldModelLease
      );
      await ConfigurationCenterPanel.current.restorePendingProposal();
      ConfigurationCenterPanel.current.render();
    } catch (error) {
      lease.dispose();
      worldModelLease?.dispose();
      throw error;
    }
    return ConfigurationCenterPanel.current;
  }

  private armWorldModelRenewal(): void {
    if (this.worldModelRenewal) clearInterval(this.worldModelRenewal);
    this.worldModelRenewal = null;
    if (!this.worldModelLease) return;
    this.worldModelRenewal = setInterval(() => {
      if (this.disposed || this.tab !== 'world-model' || this.panel.visible === false) return;
      try { this.worldModelLease?.renew(); }
      catch {
        this.worldModelLease = null;
        if (this.worldModelRenewal) clearInterval(this.worldModelRenewal);
        this.worldModelRenewal = null;
        void this.ensureWorldModelLease().then(() => this.render());
      }
    }, Math.max(1_000, Math.floor(DEFAULT_WORLD_MODEL_SLICE_LEASE_MS / 2)));
    this.worldModelRenewal.unref?.();
  }

  /** Acquire or revive the heavy slice only while the World-Model Explorer is selected. */
  private async ensureWorldModelLease(): Promise<void> {
    if (this.disposed || this.tab !== 'world-model') return;
    if (this.worldModelLease) {
      try {
        this.worldModelLease.renew();
        this.armWorldModelRenewal();
        return;
      } catch {
        this.worldModelLease = null;
      }
    }
    if (!this.worldModelLeaseAcquisition) {
      this.worldModelLeaseAcquisition = this.store.acquireSlices(
        'world-model-explorer', ['worldModel'], { ttlMs: DEFAULT_WORLD_MODEL_SLICE_LEASE_MS }
      ).then((lease) => {
        if (this.disposed || this.tab !== 'world-model') lease.dispose();
        else this.worldModelLease = lease;
      }).finally(() => { this.worldModelLeaseAcquisition = null; });
    }
    await this.worldModelLeaseAcquisition;
    this.armWorldModelRenewal();
  }

  private releaseWorldModelLease(): void {
    if (this.worldModelRenewal) clearInterval(this.worldModelRenewal);
    this.worldModelRenewal = null;
    this.worldModelLease?.dispose();
    this.worldModelLease = null;
  }

  /** World-model bytes exist only while the Explorer tab itself owns this bounded lease. */
  private async selectTab(tab: ConfigurationTab): Promise<void> {
    if (tab === 'world-model') {
      this.tab = tab;
      await this.ensureWorldModelLease();
    } else {
      // Update the visible tab before release publishes its reduced snapshot; the synchronous store
      // notification must never re-render an empty World-Model Explorer during the transition.
      this.tab = tab;
      this.releaseWorldModelLease();
    }
    this.render();
  }

  private view() {
    const snapshot = this.store.current.snapshot;
    return snapshot ? configurationCenterView(snapshot, this.profile()) : null;
  }

  private texts() {
    const snapshot = this.store.current.snapshot;
    return {
      definitionText: String(snapshot?.definitionText ?? ''),
      portfolioText: String(snapshot?.portfolioText ?? '')
    };
  }

  private static replyError(reply: ConfigurationCenterReply): string | null {
    return typeof reply === 'string' || reply === null ? reply : reply.error;
  }

  private async restorePendingProposal(): Promise<void> {
    if (this.store.current.snapshot?.configurationSource?.effective?.kind
        !== 'approved-configuration-ref') return;
    const reply = await this.onMessage({ type: 'action', action: 'pending-proposals' });
    if (typeof reply === 'string' || reply === null) {
      if (reply) this.showErrors([reply]);
      return;
    }
    if (!('proposals' in reply)) return;
    if (reply.error) return this.showErrors([reply.error]);
    const restored = pendingConfigurationProposal(reply.proposals);
    if (!this.pendingProposal) this.pendingProposal = restored;
    else if (configurationPendingProposalStatus(this.pendingProposal, reply.proposals) === 'merged') {
      this.pendingProposal = restored;
      this.notice = 'The exact configuration proposal was merged. The Configuration Center now shows the refreshed approved revision.';
    } else if (!reply.proposals.some((entry) => entry.branch === this.pendingProposal?.branch
        && entry.proposalCommit === this.pendingProposal?.proposalCommit)) {
      // Review platforms commonly delete a branch immediately after merging it. A missing branch
      // is ambiguous (merge or discard), so query the exact saved commit against current authority
      // ancestry before releasing the guard.
      const statusReply = await this.onMessage({
        type: 'proposal-status',
        branch: this.pendingProposal.branch,
        proposalCommit: this.pendingProposal.proposalCommit
      });
      if (typeof statusReply === 'object' && statusReply !== null
          && 'proposalStatus' in statusReply && statusReply.proposalStatus.merged) {
        this.pendingProposal = restored;
        this.notice = 'The exact configuration proposal was merged and its review branch was removed. The Configuration Center now shows the refreshed approved revision.';
      }
    }
  }

  private storeChanged(): void {
    if (this.reloadInFlight) return;
    // Keep the exact submitted form in place while its proposal is awaiting review. Repainting from
    // the approved snapshot here would make a successful V4 proposal appear to have reverted to V3.
    if (this.pendingProposal) return;
    const decision = configurationRefreshDecision(this.dirty, this.renderedTexts, this.texts());
    if (decision === 'render') return this.render();
    if (decision !== 'conflict') return;
    if (this.saving) {
      // A successful proposal refresh can arrive while the retained panel's mutation mutex is
      // held. Replaying after the write finishes prevents that update from disappearing forever.
      this.refreshPending = true;
      return;
    }
    void this.panel.webview.postMessage({ type: 'configuration-repository-changed' });
  }

  private async save(path: string, content: string, sourceText: string): Promise<ConfigurationSaveOutcome> {
    const plan = configurationSavePlan(this.renderedConfigurationSource, path, sourceText);
    if (!plan.writable) {
      return {
        error: plan.blockedReason ?? 'The approved configuration authority is read-only.',
        disposition: null
      };
    }
    const reply = await this.onMessage({ type: 'save', path, content, ...plan });
    if (typeof reply === 'string' || reply === null) {
      return { error: reply, disposition: plan.proposal ? null : { kind: 'local' } };
    }
    if (!('disposition' in reply)) {
      return { error: 'Configuration save returned an unexpected proposal-status response.', disposition: null };
    }
    if (!reply.error && reply.disposition.kind === 'proposal') {
      this.pendingProposal = {
        branch: reply.disposition.branch,
        baseBranch: reply.disposition.baseBranch,
        proposalCommit: reply.disposition.proposalCommit
      };
      // Keep the submitted form in the webview rather than immediately repainting approved V3.
      // The browser freezes it and labels it review-required; every host-side mutation is guarded too.
      void this.panel.webview.postMessage({
        type: 'configuration-proposal-pending',
        branch: reply.disposition.branch,
        baseBranch: reply.disposition.baseBranch
      });
    }
    return { error: reply.error, disposition: reply.disposition };
  }

  private savedNotice(localNotice: string, disposition: ConfigurationSaveDisposition | null): string {
    if (disposition?.kind === 'proposal') {
      return `Configuration proposal ${disposition.branch} is pending review. Merge it into ${disposition.baseBranch}, then recheck the approved authority. The application checkout was not changed.`;
    }
    if (disposition?.kind === 'unchanged') {
      return 'The approved configuration already contains this change; no proposal was required.';
    }
    return localNotice;
  }

  private showErrors(errors: string[]): void {
    this.errors = errors;
    const conflict = errors.some((entry) => /configuration changed (?:since|while)/iu.test(entry));
    void this.panel.webview.postMessage({ type: 'configuration-save-error', errors, conflict });
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (message.type === 'open-help-topic' && message.topic === 'configuration') {
      await vscode.commands.executeCommand('singularityFlow.explainError', 'configuration');
      return;
    }
    const mutation = ['save-profile', 'add-current-identity', 'save-authority', 'save-mcp', 'save-auto', 'save-world-model']
      .includes(String(message.type))
      || (message.type === 'action' && ['delete-authority', 'delete-mcp'].includes(String(message.action)));
    const authorityMutation = ['add-current-identity', 'save-authority', 'save-mcp', 'save-auto', 'save-world-model']
      .includes(String(message.type))
      || (message.type === 'action' && ['delete-authority', 'delete-mcp'].includes(String(message.action)));
    if (authorityMutation && this.pendingProposal) {
      this.showErrors([
        `Configuration proposal ${this.pendingProposal.branch} is still awaiting review into ${this.pendingProposal.baseBranch}. `
        + 'Merge it and recheck the approved authority, or discard it and deliberately resume the approved baseline before making another configuration change.'
      ]);
      return;
    }
    // A double click, retained webview, or programmatic postMessage must not fan out writes against
    // one rendered configuration revision. The mutex covers every Configuration Center mutation,
    // including the confirmation interval before an identity/delete save reaches the CLI.
    if (mutation && this.saving) {
      void this.panel.webview.postMessage({ type: 'configuration-save-busy' });
      return;
    }
    if (mutation) {
      this.saving = true;
      try { await this.receiveReady(message); }
      finally {
        this.saving = false;
        if (this.refreshPending) {
          this.refreshPending = false;
          this.storeChanged();
        }
      }
      return;
    }
    await this.receiveReady(message);
  }

  private async receiveReady(message: Record<string, unknown>): Promise<void> {
    const view = this.view(); if (!view) return;
    this.errors = []; this.notice = null;
    if (message.type === 'form-dirty') { this.dirty = message.dirty === true; return; }
    if (message.type === 'resume-approved-baseline') {
      if (!this.pendingProposal) return;
      const branch = this.pendingProposal.branch;
      const resume = 'Resume approved baseline';
      const confirmed = await vscode.window.showWarningMessage(
        `Resume the approved configuration instead of proposal ${branch}?`,
        {
          modal: true,
          detail: 'Use this only after the proposal was deliberately discarded. This does not save or approve any submitted setting; it reloads the current approved authority and enables editing from that revision.'
        },
        resume
      );
      if (confirmed !== resume) return;
      this.reloadInFlight = true;
      try {
        const error = ConfigurationCenterPanel.replyError(await this.onMessage({
          type: 'action', action: 'refresh'
        }));
        if (error) return this.showErrors([error]);
      } finally {
        this.reloadInFlight = false;
      }
      this.pendingProposal = null;
      this.dirty = false;
      this.notice = `Resumed the approved configuration baseline after discarding ${branch}. No configuration change was saved.`;
      return this.render();
    }
    if (message.type === 'reload-dirty') {
      this.reloadInFlight = true;
      try {
        const reply = await this.onMessage({ type: 'action', action: 'refresh' });
        const error = ConfigurationCenterPanel.replyError(reply);
        if (error) return this.showErrors([error]);
        await this.restorePendingProposal();
        this.dirty = false;
        this.refreshPending = false;
        return this.render();
      } finally {
        // Store notifications emitted by refresh are intentionally ignored until the refreshed
        // bytes have either replaced the draft or produced a visible error above.
        this.reloadInFlight = false;
      }
    }
    if (message.type === 'keep-dirty') return;
    if (message.type === 'tab' && (CONFIGURATION_TABS as readonly string[]).includes(String(message.tab))) { this.newAuthority = false; this.newMcp = false; return this.selectTab(message.tab as ConfigurationTab); }
    if (message.type === 'select-authority' && typeof message.key === 'string') { this.authorityKey = message.key; this.newAuthority = false; return this.render(); }
    if (message.type === 'select-mcp' && typeof message.id === 'string') { this.mcpId = message.id; this.newMcp = false; return this.render(); }
    if (message.type === 'save-profile') {
      const error = ConfigurationCenterPanel.replyError(await this.onMessage({
        type: 'profile', name: String(message.name ?? ''), role: String(message.role ?? '')
      }));
      if (error) this.errors = [error]; else this.notice = 'Local profile saved.'; return this.render();
    }
    if (message.type === 'add-current-identity') return this.addCurrentIdentity(
      String(message.target ?? ''),
      message.allowSelfApproval === true,
      message.autoEnrollNewIdentities === true
    );
    if (message.type === 'save-authority') {
      const draft = message as unknown as AuthorityDraft;
      this.errors = validateAuthorityDraft(draft); if (this.errors.length) return this.showErrors(this.errors);
      const snapshot = this.store.current.snapshot!;
      const path = draft.scope === 'story' ? snapshot.definitionPath ?? 'singularity/workflow.yml' : snapshot.portfolioPath ?? 'singularity/portfolio.yml';
      const text = draft.scope === 'story' ? this.renderedTexts.definitionText : this.renderedTexts.portfolioText;
      try {
        const outcome = await this.save(path, updateAuthorityYaml(text, draft), text);
        if (outcome.error) return this.showErrors([outcome.error]);
        this.dirty = false; this.notice = this.savedNotice(`Saved ${draft.label}.`, outcome.disposition); this.authorityKey = `${draft.scope}:${draft.id}`; this.newAuthority = false;
        if (outcome.disposition?.kind === 'proposal') return;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'save-mcp') {
      const draft = message as unknown as McpDraft;
      this.errors = validateMcpDraft(draft); if (this.errors.length) return this.showErrors(this.errors);
      const snapshot = this.store.current.snapshot!;
      try {
        const text = this.renderedTexts.definitionText;
        const outcome = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateMcpYaml(text, draft), text);
        if (outcome.error) return this.showErrors([outcome.error]);
        this.dirty = false; this.notice = this.savedNotice(`Saved ${draft.label}.`, outcome.disposition); this.mcpId = draft.id; this.newMcp = false;
        if (outcome.disposition?.kind === 'proposal') return;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'save-auto') {
      const workTypes = Array.isArray(message.workTypes) ? message.workTypes : [];
      const draft: AutoDraft = {
        enabled: message.enabled === true,
        workTypes: workTypes.map((value) => {
          const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          return {
            id: String(entry.id ?? ''),
            eligibility: String(entry.eligibility ?? '') as AutoDraft['workTypes'][number]['eligibility']
          };
        })
      };
      const snapshot = this.store.current.snapshot!;
      const knownWorkTypes = Object.keys(snapshot.definition?.workTypes ?? {});
      this.errors = validateAutoDraft(draft, knownWorkTypes);
      if (this.errors.length) return this.showErrors(this.errors);
      try {
        const text = this.renderedTexts.definitionText;
        const outcome = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateAutoYaml(text, draft), text);
        if (outcome.error) return this.showErrors([outcome.error]);
        this.dirty = false;
        this.notice = this.savedNotice('Auto policy saved. Review and publish configuration before it applies.', outcome.disposition);
        if (outcome.disposition?.kind === 'proposal') return;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'save-world-model') {
      try {
        const received = message as unknown as WorldModelDraft;
        const prepared = prepareWorldModelDraftForSave(this.renderedTexts.definitionText, received);
        const draft = prepared.draft;
        this.errors = validateWorldModelDraft(draft); if (this.errors.length) return this.showErrors(this.errors);
        const snapshot = this.store.current.snapshot!;
        const text = this.renderedTexts.definitionText;
        const outcome = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateWorldModelYaml(text, draft), text);
        if (outcome.error) return this.showErrors([outcome.error]);
        this.dirty = false; this.notice = this.savedNotice(`${prepared.migratedLegacyCatalog
          ? 'Legacy view names were atomically replaced by the installed exact v4 contract catalog. '
          : ''}World-model settings saved to this checkout only. Publish configuration before repository-level builds use them. An accepted Story retains its pin; use the base repository checkout or a new Story to consume the approved V4 policy.`, outcome.disposition);
        if (outcome.disposition?.kind === 'proposal') return;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'open-path') {
      const error = ConfigurationCenterPanel.replyError(await this.onMessage({
        type: 'open-path', path: String(message.path ?? '')
      }));
      if (error) { this.errors = [error]; return this.render(); }
      return;
    }
    if (message.type === 'open-world-model-ref') {
      const error = ConfigurationCenterPanel.replyError(await this.onMessage({
        type: 'open-world-model-ref', ref: String(message.ref ?? '')
      }));
      if (error) { this.errors = [error]; return this.render(); }
      return;
    }
    if (message.type === 'action') {
      const action = String(message.action ?? '');
      if (action === 'world-model') return this.selectTab('world-model');
      if (action === 'new-authority') { this.newAuthority = true; this.authorityKey = null; return this.selectTab('people'); }
      if (action === 'new-mcp') { this.newMcp = true; this.mcpId = null; return this.selectTab('mcp'); }
      if (action === 'cancel-edit') { this.newAuthority = false; this.newMcp = false; this.authorityKey = null; this.mcpId = null; return this.render(); }
      if (action === 'delete-authority') return this.deleteAuthority();
      if (action === 'delete-mcp') return this.deleteMcp();
      const error = ConfigurationCenterPanel.replyError(await this.onMessage({ type: 'action', action }));
      if (error) this.errors = [error]; return this.render();
    }
  }

  private async addCurrentIdentity(
    target: string, allowSelfApproval: boolean, autoEnrollNewIdentities: boolean
  ): Promise<void> {
    const view = this.view(); const identity = view?.gitIdentity;
    if (!view || !identity) return this.showErrors([
      'No usable Git email or GitHub login was resolved for this repository. Configure git user.name and user.email, refresh, and try again.'
    ]);
    const authorities = target === '*'
      ? view.authorities
      : target === 'story:*'
        ? view.authorities.filter((entry) => entry.scope === 'story')
        : target === 'initiative:*'
          ? view.authorities.filter((entry) => entry.scope === 'initiative')
          : view.authorities.filter((entry) => `${entry.scope}:${entry.id}` === target);
    if (!authorities.length) return this.showErrors(['Choose at least one current approval group.']);
    if (!identity.email && authorities.some((entry) => entry.scope === 'initiative')) {
      return this.showErrors(['Initiative approval groups require a Git email. Configure git user.email, refresh, and try again.']);
    }

    const labels = authorities.map((entry) => `${entry.label} (${entry.scope})`);
    const action = 'Add, commit & push';
    const confirmed = await vscode.window.showWarningMessage(
      `${action} for ${identity.name}?`,
      {
        modal: true,
        detail: [
          `Identity: ${identity.email || identity.githubLogin}`,
          `Approval groups:\n${labels.map((label) => `• ${label}`).join('\n')}`,
          `Self-approval: ${allowSelfApproval ? 'enabled' : 'disabled'}`,
          `Automatic enrollment for new Git identities: ${autoEnrollNewIdentities ? 'enabled' : 'disabled'}`,
          'Existing Story snapshots remain unchanged.'
        ].filter(Boolean).join('\n\n')
      },
      action
    );
    if (confirmed !== action) return;

    try {
      const error = ConfigurationCenterPanel.replyError(await this.onMessage({
        type: 'add-current-identity', target, allowSelfApproval, autoEnrollNewIdentities
      }));
      if (error) return this.showErrors([error]);
    } catch (error) { return this.showErrors([(error as Error).message]); }
    this.dirty = false;
    this.notice = `Approved configuration processed for ${identity.name}. Existing Story snapshots were not changed.`;
    this.render();
  }

  private async deleteAuthority(): Promise<void> {
    const view = this.view(); const selected = view?.authorities.find((entry) => `${entry.scope}:${entry.id}` === this.authorityKey); if (!selected) return;
    const confirmed = await vscode.window.showWarningMessage(`Delete approval authority '${selected.label}'?`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') return;
    const snapshot = this.store.current.snapshot!; const story = selected.scope === 'story';
    const text = story ? this.renderedTexts.definitionText : this.renderedTexts.portfolioText;
    const outcome = await this.save(story ? snapshot.definitionPath ?? 'singularity/workflow.yml' : snapshot.portfolioPath ?? 'singularity/portfolio.yml', updateAuthorityYaml(text, null, selected.id), text);
    if (outcome.error) this.errors = [outcome.error];
    else {
      this.notice = this.savedNotice(`Deleted ${selected.label}.`, outcome.disposition);
      this.authorityKey = null;
      if (outcome.disposition?.kind === 'proposal') return;
    }
    this.render();
  }

  private async deleteMcp(): Promise<void> {
    const view = this.view(); const selected = view?.mcpServers.find((entry) => entry.id === this.mcpId); if (!selected) return;
    const confirmed = await vscode.window.showWarningMessage(`Delete MCP policy '${selected.label}'?`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') return;
    const snapshot = this.store.current.snapshot!;
    const text = this.renderedTexts.definitionText;
    const outcome = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateMcpYaml(text, null, selected.id), text);
    if (outcome.error) this.errors = [outcome.error];
    else {
      this.notice = this.savedNotice(`Deleted ${selected.label}.`, outcome.disposition);
      this.mcpId = null;
      if (outcome.disposition?.kind === 'proposal') return;
    }
    this.render();
  }

  private render(): void {
    // Rendering is proof the retained explorer still has a live consumer. A panel that disappears
    // without a dispose event cannot pin the heavy WMB projection beyond this bounded lease.
    if (this.tab === 'world-model' && this.worldModelLease) {
      try { this.worldModelLease.renew(); }
      catch {
        this.worldModelLease = null;
        void this.ensureWorldModelLease().then(() => this.render());
      }
    }
    this.snapshotRenders.rendered();
    const view = this.view(); const token = nonce();
    if (!view) { this.panel.webview.html = page('Configuration Center', '<p class="empty">Choose a governed workspace to configure it.</p>', contentSecurityPolicy(this.panel.webview, token), token, '', { nav: 'configuration' }); return; }
    this.renderedTexts = this.texts();
    this.renderedConfigurationSource = this.store.current.snapshot?.configurationSource;
    const selectedAuthority = this.newAuthority ? emptyAuthority() : view.authorities.find((entry) => `${entry.scope}:${entry.id}` === this.authorityKey) ?? null;
    const selectedMcp = this.newMcp ? emptyMcp() : view.mcpServers.find((entry) => entry.id === this.mcpId) ?? null;
    this.panel.webview.html = page(
      'Configuration Center',
      configurationCenterHtml(
        view, this.tab, selectedAuthority, selectedMcp, this.notice, this.errors, this.pendingProposal
      ),
      contentSecurityPolicy(this.panel.webview, token), token, CONFIGURATION_CENTER_SCRIPT,
      { nav: 'configuration' }
    );
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.snapshotRenders.dispose();
    this.lease.dispose();
    this.releaseWorldModelLease();
    this.disposables.forEach((item) => item.dispose());
    ConfigurationCenterPanel.current = null;
  }
}
