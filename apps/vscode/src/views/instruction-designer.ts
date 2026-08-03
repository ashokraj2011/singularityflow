/** VS Code host for the visual agent, prompt, skill and prompt-pack designer. */
import * as vscode from 'vscode';
import type { WorkspaceStore } from '../state.ts';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import {
  agentPath, instructionCatalog, parseAgent, parsePrompt, parseSkill, promptPath, renderAgent,
  renderPrompt, renderSkill, skillPath, validateAgent, validatePrompt, validateSkill,
  type AgentDraft, type InstructionCatalog, type InstructionEntry, type InstructionTab,
  type PromptDraft, type SkillDraft
} from './instruction-designer-model.ts';
import {
  instructionDesignerHtml, INSTRUCTION_DESIGNER_SCRIPT, type InstructionDesignerView
} from './instruction-designer-page.ts';

export type InstructionDesignerMessage = { type: 'save'; path: string; content: string };

function emptyAgent(): AgentDraft {
  return { id: '', label: '', description: '', phases: [], defaultFor: [], worldModelViews: [], tools: ['read', 'search'], body: '# Agent instructions\n\nDescribe how this agent should reason, what evidence it must use, and what it must produce.' };
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
  private readonly disposables: vscode.Disposable[] = [];
  private tab: InstructionTab = 'agents';
  private selectedPath: string | null = null;
  private agent: AgentDraft | null = null;
  private prompt: PromptDraft | null = null;
  private skill: SkillDraft | null = null;
  private errors: string[] = [];
  private notice: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    private readonly onMessage: (message: InstructionDesignerMessage) => Promise<string | null>
  ) {
    this.panel = panel;
    this.subscription = store.onDidChange(() => this.render());
    panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: InstructionDesignerMessage) => Promise<string | null>
  ): InstructionDesignerPanel {
    if (InstructionDesignerPanel.current) {
      InstructionDesignerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return InstructionDesignerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.instructionDesigner', 'Agents, prompts & skills', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    InstructionDesignerPanel.current = new InstructionDesignerPanel(panel, store, onMessage);
    return InstructionDesignerPanel.current;
  }

  private catalog(): InstructionCatalog | null {
    const snapshot = this.store.current.snapshot;
    return snapshot ? instructionCatalog(snapshot) : null;
  }

  private entries(catalog: InstructionCatalog): InstructionEntry[] { return catalog[this.tab]; }

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
  }

  private async save(path: string, content: string): Promise<boolean> {
    const error = await this.onMessage({ type: 'save', path, content });
    if (error) { this.errors = [error]; this.render(); return false; }
    this.selectedPath = path; this.notice = `Saved ${path}`; this.errors = [];
    this.render(); return true;
  }

  private strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const catalog = this.catalog();
    if (!catalog) return;
    if (message.type === 'tab' && ['agents', 'prompts', 'skills', 'packs'].includes(String(message.tab))) {
      this.tab = message.tab as InstructionTab; this.load(this.entries(catalog)[0] ?? null); return this.render();
    }
    if (message.type === 'select' && typeof message.path === 'string') {
      this.load(this.entries(catalog).find((entry) => entry.path === message.path) ?? null); return this.render();
    }
    if (message.type === 'new' && this.tab !== 'packs') {
      this.selectedPath = null; this.errors = []; this.notice = null;
      this.agent = this.tab === 'agents' ? emptyAgent() : null;
      this.prompt = this.tab === 'prompts' ? emptyPrompt() : null;
      this.skill = this.tab === 'skills' ? emptySkill() : null;
      return this.render();
    }
    if (message.type === 'cancel') { this.load(this.entries(catalog)[0] ?? null); return this.render(); }
    if (message.type === 'save-agent') {
      const draft: AgentDraft = { id: String(message.id ?? '').trim(), label: String(message.label ?? '').trim(),
        description: String(message.description ?? '').trim(), phases: this.strings(message.phases),
        defaultFor: this.strings(message.defaultFor), worldModelViews: this.strings(message.worldModelViews),
        tools: this.strings(message.tools), body: String(message.body ?? '') };
      this.agent = draft; this.errors = validateAgent(draft);
      if (!this.errors.length) await this.save(this.selectedPath ?? agentPath(draft.id), renderAgent(draft));
      else this.render();
      return;
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
      if (await this.save(pack.repositoryPath, pack.content)) {
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
      if (await this.save(target, agent.content)) {
        this.load({ ...agent, path: target, scope: 'repository', editable: true });
      }
    }
  }

  private render(): void {
    const catalog = this.catalog();
    if (!catalog) {
      const token = nonce();
      this.panel.webview.html = page('Agents, prompts & skills', '<p class="empty">Open a governed repository to design instructions.</p>', contentSecurityPolicy(this.panel.webview, token), token);
      return;
    }
    const selected = this.selected(catalog);
    if (this.selectedPath === null && !this.agent && !this.prompt && !this.skill && selected) this.load(selected);
    const view: InstructionDesignerView = { tab: this.tab, selected: this.selectedPath ? selected : null,
      agent: this.agent, prompt: this.prompt, skill: this.skill, errors: this.errors, notice: this.notice };
    const token = nonce();
    this.panel.webview.html = page('Agents, prompts & skills', instructionDesignerHtml(catalog, view),
      contentSecurityPolicy(this.panel.webview, token), token, INSTRUCTION_DESIGNER_SCRIPT);
  }

  private dispose(): void {
    this.subscription.dispose(); this.disposables.forEach((item) => item.dispose());
    InstructionDesignerPanel.current = null;
  }
}
