/** VS Code host for the visual agent, prompt, skill and prompt-pack designer. */
import * as vscode from 'vscode';
import type { RepositorySnapshot } from '../cli/snapshot.ts';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import {
  agentPath, instructionCatalog, parseAgent, parsePrompt, parseSkill, promptPath, renderAgent,
  renderAgentMappings, renderPrompt, renderSkill, skillPath, validateAgent, validateAgentMappingsDraft,
  validatePrompt, validateSkill,
  type AgentDraft, type InstructionCatalog, type InstructionEntry, type InstructionTab,
  type PromptDraft, type SkillDraft
} from './instruction-designer-model.ts';
import {
  instructionDesignerHtml, INSTRUCTION_DESIGNER_SCRIPT, type InstructionDesignerView
} from './instruction-designer-page.ts';
import { RetainedPanelRenderGate } from '../single-flight.ts';
import {
  configurationSavePlan, type ConfigurationSaveDisposition, type ConfigurationSavePlan
} from './configuration-save.ts';

export type InstructionDesignerMessage =
  | ({ type: 'save'; path: string; content: string } & ConfigurationSavePlan)
  | { type: 'agent-action'; action: 'trust' | 'update' | 'sync' | 'refresh'; agentId: string };
export type InstructionDesignerReply = string | null | {
  error: string | null;
  disposition: ConfigurationSaveDisposition;
};

function emptyAgent(): AgentDraft {
  return { id: '', label: '', description: '', phases: [], defaultFor: [], worldModelViews: [], tools: ['read', 'search'], body: '# Agent instructions\n\nDescribe how this agent should reason, what evidence it must use, and what it must produce.', remoteSkills: [], remoteTemplates: [], remoteOutputs: [] };
}
function emptyPrompt(): PromptDraft { return { id: '', body: '# Purpose\n\nDescribe the reusable instruction.' }; }
function emptySkill(): SkillDraft {
  return { id: '', description: '', argumentHint: '[WORK-ID]', disableModelInvocation: false,
    body: '# Run this governed action\n\n1. Inspect the active lifecycle context.\n2. Run the corresponding `singularity-flow` command.\n3. Report artifacts, state changes, and the next valid action.' };
}

export class InstructionDesignerPanel {
  private static current: InstructionDesignerPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscription: { dispose(): void };
  private readonly snapshotRenders: RetainedPanelRenderGate;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private tab: InstructionTab = 'agents';
  private selectedPath: string | null = null;
  private agent: AgentDraft | null = null;
  private prompt: PromptDraft | null = null;
  private skill: SkillDraft | null = null;
  private errors: string[] = [];
  private notice: string | null = null;
  private sourcePath: string | null = null;
  private sourceText = '';
  private sourceConfiguration: RepositorySnapshot['configurationSource'] = undefined;
  private mappingSourceText = '';
  private mappingSourceConfiguration: RepositorySnapshot['configurationSource'] = undefined;
  private pendingProposalPath: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly onMessage: (message: InstructionDesignerMessage) => Promise<InstructionDesignerReply>,
    private readonly lease: { dispose(): void }
  ) {
    this.panel = panel;
    this.snapshotRenders = new RetainedPanelRenderGate(
      () => this.panel.visible !== false,
      () => this.render(),
      ['configuration']
    );
    this.subscription = store.onDidChange((_state, change) =>
      this.snapshotRenders.changed(change.kind, change.changedSlices));
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.receive(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState?.(({ webviewPanel }) => {
      this.snapshotRenders.visibilityChanged(webviewPanel.visible !== false);
    }, null, this.disposables);
    this.render();
  }

  static async show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: InstructionDesignerMessage) => Promise<InstructionDesignerReply>
  ): Promise<InstructionDesignerPanel> {
    if (InstructionDesignerPanel.current) {
      InstructionDesignerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return InstructionDesignerPanel.current;
    }
    const lease = await store.acquireSlices(['configuration']);
    const raced = InstructionDesignerPanel.current as InstructionDesignerPanel | null;
    if (raced) {
      lease.dispose();
      raced.panel.reveal(vscode.ViewColumn.Active);
      return raced;
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        'singularityFlow.instructionDesigner', 'Agents, prompts & skills', vscode.ViewColumn.Active,
        // Pinned like every other panel. Omitting it falls back to the extension root plus every
        // workspace folder, which widens what `webview.cspSource` can address — one copy of the
        // posture, not one copy per panel that remembers.
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        }
      );
      InstructionDesignerPanel.current = new InstructionDesignerPanel(panel, store, onMessage, lease);
    } catch (error) {
      lease.dispose();
      throw error;
    }
    return InstructionDesignerPanel.current;
  }

  private catalog(): InstructionCatalog | null {
    const snapshot = this.store.current.snapshot;
    return snapshot ? instructionCatalog(snapshot) : null;
  }

  private entries(catalog: InstructionCatalog): InstructionEntry[] {
    return this.tab === 'delivery' ? catalog.agents : catalog[this.tab];
  }

  private selected(catalog: InstructionCatalog): InstructionEntry | null {
    const entries = this.entries(catalog);
    return entries.find((entry) => entry.path === this.selectedPath) ?? entries[0] ?? null;
  }

  private load(entry: InstructionEntry | null): void {
    this.selectedPath = entry?.path ?? null;
    this.errors = []; this.notice = null;
    this.agent = this.tab === 'agents' && entry ? parseAgent(entry.content, entry.id) : null;
    this.prompt = this.tab === 'prompts' && entry ? parsePrompt(entry.content, entry.id) : null;
    this.skill = this.tab === 'skills' && entry ? parseSkill(entry.content, entry.id) : null;
    this.sourcePath = entry?.path ?? null;
    this.sourceText = entry?.content ?? '';
    this.sourceConfiguration = this.store.current.snapshot?.configurationSource;
    this.pendingProposalPath = null;
  }

  private async save(
    path: string,
    content: string,
    baselineText = this.sourcePath === path ? this.sourceText : '',
    baselineConfiguration = this.sourceConfiguration
  ): Promise<boolean> {
    if (this.pendingProposalPath === path) {
      this.errors = [`${path} already has an unmerged review proposal. Review or merge it, then refresh before creating another proposal.`];
      this.render();
      return false;
    }
    const plan = configurationSavePlan(baselineConfiguration, path, baselineText);
    if (!plan.writable) {
      this.errors = [plan.blockedReason ?? 'The approved configuration authority is read-only.'];
      this.render();
      return false;
    }
    const reply = await this.onMessage({ type: 'save', path, content, ...plan });
    const error = typeof reply === 'string' ? reply : reply?.error ?? null;
    if (error) { this.errors = [error]; this.render(); return false; }
    const disposition = typeof reply === 'object' && reply ? reply.disposition
      : plan.proposal ? {
          kind: 'proposal' as const, branch: '', baseBranch: 'sflow/config',
          proposalCommit: '', files: []
        }
        : { kind: 'local' as const };
    if (disposition.kind === 'proposal') {
      // The proposal lives on its own branch. Keeping those proposed bytes as the next CAS baseline
      // would pair them with the still-approved authority digest and guarantee a confusing retry
      // failure. Hold the rendered draft for review, but require a refresh before another save.
      this.pendingProposalPath = path;
    } else if (disposition.kind === 'local') {
      this.sourcePath = path; this.sourceText = content;
      this.sourceConfiguration = this.store.current.snapshot?.configurationSource;
    }
    this.selectedPath = path;
    this.notice = disposition.kind === 'proposal'
      ? `Created governed review proposal${disposition.branch ? ` ${disposition.branch}` : ''} for ${path}. Merge it into ${disposition.baseBranch}, then refresh workspace configuration.`
      : disposition.kind === 'unchanged'
        ? `The approved authority already contains the requested ${path} content; no proposal was required.`
        : `Saved ${path} as a local configuration draft.`;
    this.errors = [];
    this.render(); return true;
  }

  private strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const catalog = this.catalog();
    if (!catalog) return;
    if (message.type === 'tab' && ['agents', 'delivery', 'prompts', 'skills', 'packs'].includes(String(message.tab))) {
      this.tab = message.tab as InstructionTab;
      if (this.tab === 'delivery') {
        this.load(null);
        this.mappingSourceText = catalog.mappingContent;
        this.mappingSourceConfiguration = this.store.current.snapshot?.configurationSource;
      } else this.load(this.entries(catalog)[0] ?? null);
      return this.render();
    }
    if (message.type === 'select' && typeof message.path === 'string') {
      this.load(this.entries(catalog).find((entry) => entry.path === message.path) ?? null); return this.render();
    }
    if (message.type === 'new' && this.tab !== 'packs') {
      this.selectedPath = null; this.errors = []; this.notice = null;
      this.agent = this.tab === 'agents' ? emptyAgent() : null;
      this.prompt = this.tab === 'prompts' ? emptyPrompt() : null;
      this.skill = this.tab === 'skills' ? emptySkill() : null;
      this.sourcePath = null; this.sourceText = '';
      this.sourceConfiguration = this.store.current.snapshot?.configurationSource;
      return this.render();
    }
    if (message.type === 'cancel') { this.load(this.entries(catalog)[0] ?? null); return this.render(); }
    if (message.type === 'save-agent') {
      const draft: AgentDraft = { id: String(message.id ?? '').trim(), label: String(message.label ?? '').trim(),
        description: String(message.description ?? '').trim(), phases: this.strings(message.phases),
        defaultFor: this.strings(message.defaultFor), worldModelViews: this.strings(message.worldModelViews),
        tools: this.strings(message.tools), body: String(message.body ?? ''),
        remoteSkills: Array.isArray(message.remoteSkills) ? message.remoteSkills as AgentDraft['remoteSkills'] : [],
        remoteTemplates: Array.isArray(message.remoteTemplates) ? message.remoteTemplates as AgentDraft['remoteTemplates'] : [],
        remoteOutputs: Array.isArray(message.remoteOutputs) ? message.remoteOutputs as AgentDraft['remoteOutputs'] : [] };
      this.agent = draft; this.errors = validateAgent(draft);
      if (!this.errors.length) await this.save(this.selectedPath ?? agentPath(draft.id), renderAgent(draft));
      else this.render();
      return;
    }
    if (message.type === 'save-mappings') {
      const rows = Array.isArray(message.rows) ? message.rows.map((row) => ({
        copilotAgent: String((row as Record<string, unknown>).copilotAgent ?? '').trim(),
        agentId: String((row as Record<string, unknown>).agentId ?? '').trim()
      })) : [];
      this.errors = validateAgentMappingsDraft(rows, catalog.agents.map((entry) => entry.id));
      if (!this.errors.length) {
        const content = renderAgentMappings(rows);
        if (await this.save(catalog.mappingPath, content, this.mappingSourceText, this.mappingSourceConfiguration)) {
          this.mappingSourceText = content;
          this.mappingSourceConfiguration = this.store.current.snapshot?.configurationSource;
        }
      }
      else this.render();
      return;
    }
    if (message.type === 'agent-action' && typeof message.agentId === 'string'
      && ['trust', 'update', 'sync', 'refresh'].includes(String(message.action))) {
      const reply = await this.onMessage({ type: 'agent-action', action: message.action as 'trust' | 'update' | 'sync' | 'refresh', agentId: message.agentId });
      const error = typeof reply === 'string' ? reply : reply?.error ?? null;
      this.errors = error ? [error] : [];
      if (!error && message.action === 'refresh') {
        const refreshed = this.catalog();
        if (refreshed) {
          if (this.tab === 'delivery') {
            this.load(null);
            this.mappingSourceText = refreshed.mappingContent;
            this.mappingSourceConfiguration = this.store.current.snapshot?.configurationSource;
          } else {
            const current = this.selectedPath
              ? this.entries(refreshed).find((entry) => entry.path === this.selectedPath) ?? null
              : this.entries(refreshed)[0] ?? null;
            this.load(current);
          }
        }
      }
      this.notice = error ? null : message.action === 'refresh' ? 'Approved instructions reloaded.' : `${message.agentId}: ${message.action} started.`;
      this.render(); return;
    }
    if (message.type === 'save-prompt') {
      const draft: PromptDraft = { id: String(message.id ?? '').trim(), body: String(message.body ?? '') };
      this.prompt = draft; this.errors = validatePrompt(draft);
      if (!this.errors.length) await this.save(this.selectedPath ?? promptPath(draft.id), renderPrompt(draft));
      else this.render();
      return;
    }
    if (message.type === 'save-skill') {
      const draft: SkillDraft = { id: String(message.id ?? '').trim(), description: String(message.description ?? '').trim(),
        argumentHint: String(message.argumentHint ?? '').trim(), disableModelInvocation: Boolean(message.disableModelInvocation),
        body: String(message.body ?? '') };
      this.skill = draft; this.errors = validateSkill(draft);
      if (!this.errors.length) await this.save(this.selectedPath ?? skillPath(draft.id), renderSkill(draft));
      else this.render();
      return;
    }
    if (message.type === 'copy-pack' && typeof message.path === 'string') {
      const pack = catalog.packs.find((entry) => entry.path === message.path);
      if (!pack?.repositoryPath) return;
      if (catalog.skills.some((entry) => entry.path === pack.repositoryPath)) {
        this.errors = [`${pack.repositoryPath} already exists. Edit the repository skill instead.`]; return this.render();
      }
      if (await this.save(pack.repositoryPath, pack.content, '', this.store.current.snapshot?.configurationSource)) {
        this.tab = 'skills'; this.load({ ...pack, path: pack.repositoryPath, scope: 'repository', editable: true });
      }
    }
    if (message.type === 'copy-agent' && typeof message.path === 'string') {
      const agent = catalog.agents.find((entry) => entry.path === message.path && entry.scope === 'packaged');
      if (!agent) return;
      const target = agentPath(agent.id);
      if (catalog.agents.some((entry) => entry.path === target && entry.scope === 'repository')) {
        this.errors = [`${target} already exists. Edit the repository agent instead.`]; return this.render();
      }
      if (await this.save(target, agent.content, '', this.store.current.snapshot?.configurationSource)) {
        this.load({ ...agent, path: target, scope: 'repository', editable: true });
      }
    }
  }

  private render(): void {
    this.snapshotRenders.rendered();
    const catalog = this.catalog();
    if (!catalog) {
      const token = nonce();
      this.panel.webview.html = page('Agents, prompts & skills', '<p class="empty">Open a governed repository to design instructions.</p>', contentSecurityPolicy(this.panel.webview, token), token);
      return;
    }
    const selected = this.selected(catalog);
    if (this.tab !== 'delivery' && this.selectedPath === null && !this.agent && !this.prompt && !this.skill && selected) this.load(selected);
    const savePlan = configurationSavePlan(
      this.store.current.snapshot?.configurationSource,
      this.sourcePath ?? catalog.mappingPath,
      this.sourcePath ? this.sourceText : this.mappingSourceText
    );
    const view: InstructionDesignerView = { tab: this.tab, selected: this.selectedPath ? selected : null,
      agent: this.agent, prompt: this.prompt, skill: this.skill, errors: this.errors, notice: this.notice,
      configurationBlockedReason: savePlan.writable ? null : savePlan.blockedReason ?? 'The approved configuration authority is read-only.' };
    const token = nonce();
    this.panel.webview.html = page('Agents, prompts & skills', instructionDesignerHtml(catalog, view),
      contentSecurityPolicy(this.panel.webview, token), token, INSTRUCTION_DESIGNER_SCRIPT);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose(); this.disposables.forEach((item) => item.dispose());
    this.snapshotRenders.dispose();
    this.lease.dispose();
    InstructionDesignerPanel.current = null;
  }
}
