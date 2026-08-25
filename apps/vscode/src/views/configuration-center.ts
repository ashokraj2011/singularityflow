/** First-class VS Code configuration for humans, approvals, MCP, and the other designers. */
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  configurationCenterView, configurationRefreshDecision,
  updateAuthorityYaml, updateMcpYaml, updateWorldModelYaml,
  validateAuthorityDraft, validateMcpDraft, validateWorldModelDraft,
  CONFIGURATION_TABS,
  type AuthorityDraft, type AuthorityView, type ConfigurationTab, type McpDraft, type McpServerView,
  type WorldModelDraft
} from './configuration-center-model.ts';
import { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } from './configuration-center-page.ts';

export type ConfigurationCenterMessage =
  | { type: 'save'; path: string; content: string; expectedSha256: string }
  | { type: 'profile'; name: string; role: string }
  | {
      type: 'add-current-identity'; target: string;
      allowSelfApproval: boolean; autoEnrollNewIdentities: boolean;
    }
  | { type: 'action'; action: string }
  /**
   * Open a repository file the Center listed. Carries the path rather than an action name because
   * the set is data — every template in the catalog — not a fixed vocabulary of commands.
   */
  | { type: 'open-path'; path: string };

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
  private renderedTexts = { definitionText: '', portfolioText: '' };
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly profile: () => { name: string; role: string },
    private readonly onMessage: (message: ConfigurationCenterMessage) => Promise<string | null>
  ) {
    this.subscription = store.onDidChange(() => this.storeChanged());
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.receive(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, profile: () => { name: string; role: string }, onMessage: (message: ConfigurationCenterMessage) => Promise<string | null>, tab: ConfigurationTab = 'overview'): ConfigurationCenterPanel {
    if (ConfigurationCenterPanel.current) {
      ConfigurationCenterPanel.current.tab = tab;
      ConfigurationCenterPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ConfigurationCenterPanel.current.render();
      return ConfigurationCenterPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.configurationCenter', 'Configuration Center', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    ConfigurationCenterPanel.current = new ConfigurationCenterPanel(panel, store, profile, onMessage);
    ConfigurationCenterPanel.current.tab = tab;
    ConfigurationCenterPanel.current.render();
    return ConfigurationCenterPanel.current;
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

  private storeChanged(): void {
    const decision = configurationRefreshDecision(this.dirty, this.renderedTexts, this.texts());
    if (decision === 'render') return this.render();
    if (decision === 'conflict' && !this.saving) void this.panel.webview.postMessage({ type: 'configuration-repository-changed' });
  }

  private expectedSha256(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  private save(path: string, content: string, sourceText: string): Promise<string | null> {
    this.saving = true;
    return this.onMessage({ type: 'save', path, content, expectedSha256: this.expectedSha256(sourceText) })
      .finally(() => { this.saving = false; });
  }

  private showErrors(errors: string[]): void {
    this.errors = errors;
    void this.panel.webview.postMessage({ type: 'configuration-save-error', errors });
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const view = this.view(); if (!view) return;
    this.errors = []; this.notice = null;
    if (message.type === 'form-dirty') { this.dirty = message.dirty === true; return; }
    if (message.type === 'reload-dirty') { this.dirty = false; return this.render(); }
    if (message.type === 'keep-dirty') return;
    if (message.type === 'tab' && (CONFIGURATION_TABS as readonly string[]).includes(String(message.tab))) { this.tab = message.tab as ConfigurationTab; this.newAuthority = false; this.newMcp = false; return this.render(); }
    if (message.type === 'select-authority' && typeof message.key === 'string') { this.authorityKey = message.key; this.newAuthority = false; return this.render(); }
    if (message.type === 'select-mcp' && typeof message.id === 'string') { this.mcpId = message.id; this.newMcp = false; return this.render(); }
    if (message.type === 'save-profile') {
      const error = await this.onMessage({ type: 'profile', name: String(message.name ?? ''), role: String(message.role ?? '') });
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
        const error = await this.save(path, updateAuthorityYaml(text, draft), text);
        if (error) return this.showErrors([error]);
        this.dirty = false; this.notice = `Saved ${draft.label}.`; this.authorityKey = `${draft.scope}:${draft.id}`; this.newAuthority = false;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'save-mcp') {
      const draft = message as unknown as McpDraft;
      this.errors = validateMcpDraft(draft); if (this.errors.length) return this.showErrors(this.errors);
      const snapshot = this.store.current.snapshot!;
      try {
        const text = this.renderedTexts.definitionText;
        const error = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateMcpYaml(text, draft), text);
        if (error) return this.showErrors([error]);
        this.dirty = false; this.notice = `Saved ${draft.label}.`; this.mcpId = draft.id; this.newMcp = false;
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'save-world-model') {
      const draft = message as unknown as WorldModelDraft;
      this.errors = validateWorldModelDraft(draft); if (this.errors.length) return this.showErrors(this.errors);
      const snapshot = this.store.current.snapshot!;
      try {
        const text = this.renderedTexts.definitionText;
        const error = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateWorldModelYaml(text, draft), text);
        if (error) return this.showErrors([error]);
        this.dirty = false; this.notice = 'World-model settings saved.';
      } catch (error) { return this.showErrors([(error as Error).message]); }
      return this.render();
    }
    if (message.type === 'open-path') {
      const error = await this.onMessage({ type: 'open-path', path: String(message.path ?? '') });
      if (error) { this.errors = [error]; return this.render(); }
      return;
    }
    if (message.type === 'action') {
      const action = String(message.action ?? '');
      if (action === 'world-model') { this.tab = 'world-model'; return this.render(); }
      if (action === 'new-authority') { this.tab = 'people'; this.newAuthority = true; this.authorityKey = null; return this.render(); }
      if (action === 'new-mcp') { this.tab = 'mcp'; this.newMcp = true; this.mcpId = null; return this.render(); }
      if (action === 'cancel-edit') { this.newAuthority = false; this.newMcp = false; this.authorityKey = null; this.mcpId = null; return this.render(); }
      if (action === 'delete-authority') return this.deleteAuthority();
      if (action === 'delete-mcp') return this.deleteMcp();
      const error = await this.onMessage({ type: 'action', action }); if (error) this.errors = [error]; return this.render();
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
      const error = await this.onMessage({
        type: 'add-current-identity', target, allowSelfApproval, autoEnrollNewIdentities
      });
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
    const error = await this.save(story ? snapshot.definitionPath ?? 'singularity/workflow.yml' : snapshot.portfolioPath ?? 'singularity/portfolio.yml', updateAuthorityYaml(text, null, selected.id), text);
    if (error) this.errors = [error]; else { this.notice = `Deleted ${selected.label}.`; this.authorityKey = null; } this.render();
  }

  private async deleteMcp(): Promise<void> {
    const view = this.view(); const selected = view?.mcpServers.find((entry) => entry.id === this.mcpId); if (!selected) return;
    const confirmed = await vscode.window.showWarningMessage(`Delete MCP policy '${selected.label}'?`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') return;
    const snapshot = this.store.current.snapshot!;
    const text = this.renderedTexts.definitionText;
    const error = await this.save(snapshot.definitionPath ?? 'singularity/workflow.yml', updateMcpYaml(text, null, selected.id), text);
    if (error) this.errors = [error]; else { this.notice = `Deleted ${selected.label}.`; this.mcpId = null; } this.render();
  }

  private render(): void {
    const view = this.view(); const token = nonce();
    if (!view) { this.panel.webview.html = page('Configuration Center', '<p class="empty">Choose a governed workspace to configure it.</p>', contentSecurityPolicy(this.panel.webview, token), token, '', { nav: 'configuration' }); return; }
    this.renderedTexts = this.texts();
    const selectedAuthority = this.newAuthority ? emptyAuthority() : view.authorities.find((entry) => `${entry.scope}:${entry.id}` === this.authorityKey) ?? null;
    const selectedMcp = this.newMcp ? emptyMcp() : view.mcpServers.find((entry) => entry.id === this.mcpId) ?? null;
    this.panel.webview.html = page('Configuration Center', configurationCenterHtml(view, this.tab, selectedAuthority, selectedMcp, this.notice, this.errors), contentSecurityPolicy(this.panel.webview, token), token, CONFIGURATION_CENTER_SCRIPT, { nav: 'configuration' });
  }

  private dispose(): void { this.subscription.dispose(); this.disposables.forEach((item) => item.dispose()); ConfigurationCenterPanel.current = null; }
}
