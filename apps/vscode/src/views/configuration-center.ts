/** First-class VS Code configuration for humans, approvals, MCP, and the other designers. */
import * as vscode from 'vscode';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import {
  configurationCenterView, updateAuthorityYaml, updateMcpYaml, validateAuthorityDraft, validateMcpDraft,
  type AuthorityDraft, type AuthorityScope, type AuthorityView, type ConfigurationTab, type McpDraft, type McpServerView
} from './configuration-center-model.ts';
import { configurationCenterHtml, CONFIGURATION_CENTER_SCRIPT } from './configuration-center-page.ts';

export type ConfigurationCenterMessage =
  | { type: 'save'; path: string; content: string }
  | { type: 'profile'; name: string; role: string }
  | { type: 'action'; action: string };

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
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly profile: () => { name: string; role: string },
    private readonly onMessage: (message: ConfigurationCenterMessage) => Promise<string | null>
  ) {
    this.subscription = store.onDidChange(() => this.render());
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void vscode.commands.executeCommand(navigation);
      void this.receive(raw);
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

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const view = this.view(); if (!view) return;
    this.errors = []; this.notice = null;
    if (message.type === 'tab' && ['overview', 'people', 'mcp'].includes(String(message.tab))) { this.tab = message.tab as ConfigurationTab; this.newAuthority = false; this.newMcp = false; return this.render(); }
    if (message.type === 'select-authority' && typeof message.key === 'string') { this.authorityKey = message.key; this.newAuthority = false; return this.render(); }
    if (message.type === 'select-mcp' && typeof message.id === 'string') { this.mcpId = message.id; this.newMcp = false; return this.render(); }
    if (message.type === 'save-profile') {
      const error = await this.onMessage({ type: 'profile', name: String(message.name ?? ''), role: String(message.role ?? '') });
      if (error) this.errors = [error]; else this.notice = 'Local profile saved.'; return this.render();
    }
    if (message.type === 'save-authority') {
      const draft = message as unknown as AuthorityDraft;
      this.errors = validateAuthorityDraft(draft); if (this.errors.length) return this.render();
      const snapshot = this.store.current.snapshot!;
      const path = draft.scope === 'story' ? snapshot.definitionPath ?? 'singularity/workflow.yml' : snapshot.portfolioPath ?? 'singularity/portfolio.yml';
      const text = draft.scope === 'story' ? String(snapshot.definitionText ?? '') : String(snapshot.portfolioText ?? '');
      try {
        const error = await this.onMessage({ type: 'save', path, content: updateAuthorityYaml(text, draft) });
        if (error) this.errors = [error]; else { this.notice = `Saved ${draft.label}.`; this.authorityKey = `${draft.scope}:${draft.id}`; this.newAuthority = false; }
      } catch (error) { this.errors = [(error as Error).message]; }
      return this.render();
    }
    if (message.type === 'save-mcp') {
      const draft = message as unknown as McpDraft;
      this.errors = validateMcpDraft(draft); if (this.errors.length) return this.render();
      const snapshot = this.store.current.snapshot!;
      try {
        const error = await this.onMessage({ type: 'save', path: snapshot.definitionPath ?? 'singularity/workflow.yml', content: updateMcpYaml(String(snapshot.definitionText ?? ''), draft) });
        if (error) this.errors = [error]; else { this.notice = `Saved ${draft.label}.`; this.mcpId = draft.id; this.newMcp = false; }
      } catch (error) { this.errors = [(error as Error).message]; }
      return this.render();
    }
    if (message.type === 'action') {
      const action = String(message.action ?? '');
      if (action === 'new-authority') { this.tab = 'people'; this.newAuthority = true; this.authorityKey = null; return this.render(); }
      if (action === 'new-mcp') { this.tab = 'mcp'; this.newMcp = true; this.mcpId = null; return this.render(); }
      if (action === 'cancel-edit') { this.newAuthority = false; this.newMcp = false; this.authorityKey = null; this.mcpId = null; return this.render(); }
      if (action === 'delete-authority') return this.deleteAuthority();
      if (action === 'delete-mcp') return this.deleteMcp();
      const error = await this.onMessage({ type: 'action', action }); if (error) this.errors = [error]; return this.render();
    }
  }

  private async deleteAuthority(): Promise<void> {
    const view = this.view(); const selected = view?.authorities.find((entry) => `${entry.scope}:${entry.id}` === this.authorityKey); if (!selected) return;
    const confirmed = await vscode.window.showWarningMessage(`Delete approval authority '${selected.label}'?`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') return;
    const snapshot = this.store.current.snapshot!; const story = selected.scope === 'story';
    const error = await this.onMessage({ type: 'save', path: story ? snapshot.definitionPath ?? 'singularity/workflow.yml' : snapshot.portfolioPath ?? 'singularity/portfolio.yml', content: updateAuthorityYaml(String(story ? snapshot.definitionText ?? '' : snapshot.portfolioText ?? ''), null, selected.id) });
    if (error) this.errors = [error]; else { this.notice = `Deleted ${selected.label}.`; this.authorityKey = null; } this.render();
  }

  private async deleteMcp(): Promise<void> {
    const view = this.view(); const selected = view?.mcpServers.find((entry) => entry.id === this.mcpId); if (!selected) return;
    const confirmed = await vscode.window.showWarningMessage(`Delete MCP policy '${selected.label}'?`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') return;
    const snapshot = this.store.current.snapshot!;
    const error = await this.onMessage({ type: 'save', path: snapshot.definitionPath ?? 'singularity/workflow.yml', content: updateMcpYaml(String(snapshot.definitionText ?? ''), null, selected.id) });
    if (error) this.errors = [error]; else { this.notice = `Deleted ${selected.label}.`; this.mcpId = null; } this.render();
  }

  private render(): void {
    const view = this.view(); const token = nonce();
    if (!view) { this.panel.webview.html = page('Configuration Center', '<p class="empty">Choose a governed workspace to configure it.</p>', contentSecurityPolicy(this.panel.webview, token), token, '', { nav: 'configuration' }); return; }
    const selectedAuthority = this.newAuthority ? emptyAuthority() : view.authorities.find((entry) => `${entry.scope}:${entry.id}` === this.authorityKey) ?? null;
    const selectedMcp = this.newMcp ? emptyMcp() : view.mcpServers.find((entry) => entry.id === this.mcpId) ?? null;
    this.panel.webview.html = page('Configuration Center', configurationCenterHtml(view, this.tab, selectedAuthority, selectedMcp, this.notice, this.errors), contentSecurityPolicy(this.panel.webview, token), token, CONFIGURATION_CENTER_SCRIPT, { nav: 'configuration' });
  }

  private dispose(): void { this.subscription.dispose(); this.disposables.forEach((item) => item.dispose()); ConfigurationCenterPanel.current = null; }
}
