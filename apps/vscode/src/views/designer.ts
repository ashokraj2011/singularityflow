/** Governed visual workflow and artifact-template authoring. */
import * as vscode from 'vscode';
import { buildWorkflowGraph } from './workflow-graph-model.ts';
import { renderWorkflowGraph } from './workflow-graph-svg.ts';
import path from 'node:path';
import {
  designerHtml, DESIGNER_SCRIPT, type DesignerTab, type PhaseChoice,
  type PhaseDraftView, type WorkflowDraftView
} from './designer-page.ts';
import { buildProfiles, buildTemplateUsage, standingOn, type Profile } from './designer-model.ts';
import {
  newArtifactDraft, renderArtifactTemplate, sectionFor, validateArtifactDraft,
  SECTION_CATALOG, type ArtifactDraft, type ArtifactSection, type ArtifactSectionKind
} from './artifact-designer-model.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import type { WorkspaceStore } from '../state.ts';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

export type DesignerMessage =
  | { type: 'open'; path: string }
  | { type: 'save'; path: string; content: string }
  | { type: 'run'; command: string[]; title: string };

const GOVERNANCE = new Set(['story', 'initiative']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function governs(value: unknown, fallback: 'story' | 'initiative' = 'initiative'): 'story' | 'initiative' {
  return typeof value === 'string' && GOVERNANCE.has(value) ? value as 'story' | 'initiative' : fallback;
}
function csv(value: string): string[] { return value.split(',').map((entry) => entry.trim()).filter(Boolean); }
function swap<T>(items: T[], left: number, right: number): void {
  const first = items[left]; const second = items[right];
  if (first === undefined || second === undefined) return;
  items[left] = second; items[right] = first;
}

export class DesignerPanel {
  private static current: DesignerPanel | null = null;
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly onMessage: (message: DesignerMessage) => Promise<string | null>;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private tab: DesignerTab = 'phases';
  private profile: string | null = null;
  private filter = 'all';
  private error: string | null = null;
  private workflowDraft: WorkflowDraftView | null = null;
  private phaseDraft: PhaseDraftView | null = null;
  private artifactDraft: ArtifactDraft = newArtifactDraft();
  private artifactErrors: string[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: DesignerMessage) => Promise<string | null>
  ) {
    this.panel = panel;
    this.store = store;
    this.onMessage = onMessage;
    this.subscription = store.onDidChange(() => this.render());
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: DesignerMessage) => Promise<string | null>
  ): DesignerPanel {
    if (DesignerPanel.current) {
      DesignerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return DesignerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.designer', 'Workflows & artifacts', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    DesignerPanel.current = new DesignerPanel(panel, store, onMessage);
    return DesignerPanel.current;
  }

  private profiles(snapshot: RepositorySnapshot | null): Profile[] {
    return snapshot ? buildProfiles(snapshot) : [];
  }

  private currentProfile(snapshot: RepositorySnapshot | null): Profile | null {
    const profiles = this.profiles(snapshot);
    return profiles.find((entry) => entry.id === this.profile) ?? profiles[0] ?? null;
  }

  /** Every phase available to either kind of workflow, including phases no workflow uses yet. */
  private phaseChoices(snapshot: RepositorySnapshot | null): PhaseChoice[] {
    if (!snapshot) return [];
    const definition = snapshot.definition as { phases?: Record<string, { label?: string }> } | undefined;
    const portfolio = snapshot.portfolio as { initiativePhases?: Record<string, { label?: string }> } | undefined;
    return [
      ...Object.entries(definition?.phases ?? {}).map(([id, phase]) => ({ id, label: phase.label ?? id, governs: 'story' as const })),
      ...Object.entries(portfolio?.initiativePhases ?? {}).map(([id, phase]) => ({ id, label: phase.label ?? id, governs: 'initiative' as const }))
    ];
  }

  private resolveTemplate(declared: string): string | null {
    return this.store.current.snapshot?.templates?.find((template) => template.path.endsWith(declared))?.path ?? null;
  }

  private beginWorkflow(isNew: boolean): void {
    const profile = this.currentProfile(this.store.current.snapshot);
    this.phaseDraft = null;
    this.workflowDraft = isNew || !profile ? {
      isNew: true, id: '', label: '', description: '', governs: profile?.governs ?? 'initiative', phases: []
    } : {
      isNew: false, id: profile.id, label: profile.label, description: profile.description,
      governs: profile.governs, phases: profile.phases.map((phase) => ({ id: phase.id, label: phase.label }))
    };
  }

  private phaseDefinition(id: string): PhaseDraftView | null {
    const snapshot = this.store.current.snapshot;
    const preferred = this.currentProfile(snapshot)?.governs;
    const definition = snapshot?.definition as { phases?: Record<string, {
      label?: string; agents?: string[]; worldModel?: { views?: string[] };
    }> } | undefined;
    const portfolio = snapshot?.portfolio as { initiativePhases?: Record<string, {
      label?: string; agents?: string[]; worldModelViews?: string[]; lanes?: string[];
    }> } | undefined;
    const story = definition?.phases?.[id];
    const initiative = portfolio?.initiativePhases?.[id];
    if (preferred === 'story' && story) return { isNew: false, id, label: story.label ?? id, governs: 'story', views: (story.worldModel?.views ?? []).join(', '), agents: (story.agents ?? []).join(', '), lanes: '' };
    if (initiative) return { isNew: false, id, label: initiative.label ?? id, governs: 'initiative', views: (initiative.worldModelViews ?? []).join(', '), agents: (initiative.agents ?? []).join(', '), lanes: (initiative.lanes ?? []).join(', ') };
    if (story) return { isNew: false, id, label: story.label ?? id, governs: 'story', views: (story.worldModel?.views ?? []).join(', '), agents: (story.agents ?? []).join(', '), lanes: '' };
    return null;
  }

  private normalizeSections(raw: unknown): ArtifactSection[] {
    if (!Array.isArray(raw)) return this.artifactDraft.sections;
    return raw.map((entry) => {
      const row = entry as { kind?: unknown; title?: unknown; guidance?: unknown };
      const requested = text(row.kind) as ArtifactSectionKind;
      const kind = SECTION_CATALOG.some((preset) => preset.kind === requested) ? requested : 'narrative';
      return { ...sectionFor(kind), title: text(row.title), guidance: text(row.guidance) };
    });
  }

  private updateArtifact(raw: Record<string, unknown>): void {
    // `governs` is now a direct choice rather than something inferred from a phase key: a template
    // is written for a lifecycle, and which phase uses it is decided in the phase editor.
    if (raw.governs) this.artifactDraft.governs = governs(text(raw.governs));
    this.artifactDraft.outputId = text(raw.outputId) || this.artifactDraft.outputId;
    this.artifactDraft.outputLabel = text(raw.outputLabel) || this.artifactDraft.outputLabel;
    this.artifactDraft.outputPath = text(raw.outputPath) || this.artifactDraft.outputPath;
    this.artifactDraft.fileName = text(raw.fileName) || this.artifactDraft.fileName;
    this.artifactDraft.title = text(raw.title) || this.artifactDraft.title;
    this.artifactDraft.purpose = text(raw.purpose);
    if (raw.sections) this.artifactDraft.sections = this.normalizeSections(raw.sections);
  }

  private updateWorkflow(raw: Record<string, unknown>): void {
    if (!this.workflowDraft) return;
    this.workflowDraft.id = text(raw.id) || this.workflowDraft.id;
    this.workflowDraft.label = text(raw.label);
    this.workflowDraft.description = text(raw.description);
    this.workflowDraft.governs = governs(raw.governs, this.workflowDraft.governs);
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const snapshot = this.store.current.snapshot;

    if (message.type === 'tab' && (message.tab === 'phases' || message.tab === 'templates')) {
      this.tab = message.tab; this.error = null; return this.render();
    }
    if (message.type === 'profile' && typeof message.id === 'string') {
      this.profile = message.id; this.workflowDraft = null; this.phaseDraft = null; return this.render();
    }
    if (message.type === 'filter' && typeof message.value === 'string') {
      this.filter = message.value; return this.render();
    }
    if (message.type === 'open' && typeof message.path === 'string') {
      const known = [snapshot?.portfolioPath ?? 'singularity/portfolio.yml', snapshot?.definitionPath ?? 'singularity/workflow.yml', ...(snapshot?.templates ?? []).map((template) => template.path)];
      if (known.includes(message.path)) await this.onMessage({ type: 'open', path: message.path });
      return;
    }
    if (message.type === 'open-template' && typeof message.template === 'string') {
      const resolved = this.resolveTemplate(message.template);
      if (resolved) await this.onMessage({ type: 'open', path: resolved });
      else this.error = `No file in this repository matches the template '${message.template}'.`;
      return this.render();
    }

    if (message.type === 'begin-workflow') { this.beginWorkflow(false); return this.render(); }
    if (message.type === 'new-workflow') { this.beginWorkflow(true); return this.render(); }
    if (message.type === 'cancel-workflow') { this.workflowDraft = null; return this.render(); }
    if (message.type === 'workflow-governs' && this.workflowDraft) {
      const previous = this.workflowDraft.governs;
      this.updateWorkflow(message);
      this.workflowDraft.governs = governs(message.value, this.workflowDraft.governs);
      if (previous === this.workflowDraft.governs) return;
      this.workflowDraft.phases = [];
      return this.render();
    }
    if (message.type === 'workflow-phase-action' && this.workflowDraft) {
      this.updateWorkflow(message);
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index >= this.workflowDraft.phases.length) return;
      if (message.action === 'remove') this.workflowDraft.phases.splice(index, 1);
      if (message.action === 'up' && index > 0) swap(this.workflowDraft.phases, index - 1, index);
      if (message.action === 'down' && index < this.workflowDraft.phases.length - 1) swap(this.workflowDraft.phases, index + 1, index);
      return this.render();
    }
    if (message.type === 'add-workflow-phase' && this.workflowDraft) {
      this.updateWorkflow(message);
      const phase = this.phaseChoices(snapshot).find((entry) => entry.id === message.phase && entry.governs === this.workflowDraft?.governs);
      if (phase && !this.workflowDraft.phases.some((entry) => entry.id === phase.id)) this.workflowDraft.phases.push({ id: phase.id, label: phase.label });
      return this.render();
    }
    if (message.type === 'save-workflow' && this.workflowDraft) {
      this.updateWorkflow(message);
      if (!ID.test(this.workflowDraft.id)) this.error = 'Workflow ID must be lower-case kebab-case.';
      else if (!this.workflowDraft.label) this.error = 'Give the workflow a display name.';
      else if (!this.workflowDraft.phases.length) this.error = 'A workflow needs at least one phase.';
      else {
        const command = ['workflow', this.workflowDraft.isNew ? 'create' : 'edit', this.workflowDraft.id,
          '--label', this.workflowDraft.label, '--description', this.workflowDraft.description,
          '--phases', this.workflowDraft.phases.map((phase) => phase.id).join(',')];
        if (this.workflowDraft.isNew) command.push('--governs', this.workflowDraft.governs);
        this.error = await this.onMessage({ type: 'run', command, title: `${this.workflowDraft.isNew ? 'Creating' : 'Saving'} ${this.workflowDraft.label}` });
        // A successful save is a review proposal, not approved configuration yet. Keep showing the
        // currently approved workflow until that proposal is merged and refreshed; selecting the
        // proposed ID here made it look as though the newly created workflow had disappeared.
        if (!this.error) this.workflowDraft = null;
      }
      return this.render();
    }

    if (message.type === 'new-phase') {
      this.workflowDraft = null;
      this.phaseDraft = { isNew: true, id: '', label: '', governs: this.currentProfile(snapshot)?.governs ?? 'initiative', views: '', agents: '', lanes: '' };
      return this.render();
    }
    if (message.type === 'edit-phase' && typeof message.phase === 'string') {
      this.workflowDraft = null; this.phaseDraft = this.phaseDefinition(message.phase); return this.render();
    }
    if (message.type === 'cancel-phase') { this.phaseDraft = null; return this.render(); }
    if (message.type === 'save-phase' && this.phaseDraft) {
      this.phaseDraft.id = text(message.id) || this.phaseDraft.id;
      this.phaseDraft.label = text(message.label);
      this.phaseDraft.governs = governs(message.governs, this.phaseDraft.governs);
      this.phaseDraft.views = text(message.views); this.phaseDraft.agents = text(message.agents); this.phaseDraft.lanes = text(message.lanes);
      if (!ID.test(this.phaseDraft.id)) this.error = 'Phase ID must be lower-case kebab-case.';
      else if (!this.phaseDraft.label) this.error = 'Give the phase a display name.';
      else {
        const command = ['workflow', 'phase', this.phaseDraft.isNew ? 'add' : 'edit', this.phaseDraft.id,
          '--label', this.phaseDraft.label, '--views', csv(this.phaseDraft.views).join(','),
          '--agents', csv(this.phaseDraft.agents).join(','), '--governs', this.phaseDraft.governs];
        if (this.phaseDraft.governs === 'initiative') command.push('--lanes', csv(this.phaseDraft.lanes).join(','));
        this.error = await this.onMessage({ type: 'run', command, title: `${this.phaseDraft.isNew ? 'Creating' : 'Saving'} ${this.phaseDraft.label}` });
        if (!this.error) this.phaseDraft = null;
      }
      return this.render();
    }

    /**
     * Attach an existing template to this phase.
     *
     * The wiring the template designer used to do on save, moved to where the decision is: the
     * phase. The command is the same `workflow phase output` the engine already governs, so this is
     * a new route to an existing transaction rather than a second way to change a workflow.
     */
    if (message.type === 'attach-artifact') {
      const phase = text(message.phase);
      const outputId = text(message.outputId);
      const template = text(message.template);
      const missing = [
        phase ? null : 'a phase',
        outputId ? null : 'an artifact ID',
        template ? null : 'a template'
      ].filter(Boolean);
      if (missing.length) {
        this.error = `Attaching an artifact needs ${missing.join(', ')}.`;
        return this.render();
      }
      const templatesRoot = ((snapshot?.definition as { templatesRoot?: string } | undefined)?.templatesRoot)
        ?? 'singularity/templates';
      // The select carries the repository path; the engine wants it relative to the templates root.
      const relative = template.startsWith(`${templatesRoot}/`) ? template.slice(templatesRoot.length + 1) : template;
      const label = text(message.outputLabel) || outputId;
      const command = ['workflow', 'phase', 'output', 'add', phase, outputId,
        '--governs', governs(text(message.governs)), '--label', label,
        '--kind', 'markdown', '--path', text(message.outputPath) || `${outputId}.md`,
        '--template', relative, '--optional', String(message.required === false)];
      this.error = await this.onMessage({ type: 'run', command, title: `Attaching ${label} to ${phase}` });
      if (!this.error) void vscode.window.showInformationMessage(`${label} is now produced by ${phase}.`);
      return this.render();
    }

    if (message.type === 'artifact-governs') {
      this.updateArtifact(message);
      return this.render();
    }
    if (message.type === 'artifact-sections') {
      this.updateArtifact(message);
      const index = Number(message.index);
      if (message.action === 'add') this.artifactDraft.sections.push(sectionFor(text(message.kind) as ArtifactSectionKind));
      if (message.action === 'remove' && Number.isInteger(index)) this.artifactDraft.sections.splice(index, 1);
      if (message.action === 'up' && index > 0) swap(this.artifactDraft.sections, index - 1, index);
      if (message.action === 'down' && index < this.artifactDraft.sections.length - 1) swap(this.artifactDraft.sections, index + 1, index);
      if (message.action === 'move') {
        const to = Number(message.to);
        if (Number.isInteger(index) && Number.isInteger(to) && index !== to && this.artifactDraft.sections[index]) {
          const [moved] = this.artifactDraft.sections.splice(index, 1);
          if (moved) this.artifactDraft.sections.splice(to, 0, moved);
        }
      }
      return this.render();
    }
    if (message.type === 'reset-artifact') {
      this.artifactDraft = newArtifactDraft(); this.artifactErrors = []; this.error = null; return this.render();
    }
    if (message.type === 'save-artifact') {
      this.updateArtifact(message);
      this.artifactErrors = validateArtifactDraft(this.artifactDraft);
      if (this.artifactErrors.length) return this.render();
      const definition = snapshot?.definition as { templatesRoot?: string } | undefined;
      const portfolio = snapshot?.portfolio as { templatesRoot?: string } | undefined;
      const templatesRoot = this.artifactDraft.governs === 'initiative'
        ? portfolio?.templatesRoot ?? definition?.templatesRoot ?? 'singularity/templates'
        : definition?.templatesRoot ?? 'singularity/templates';
      const target = path.posix.join(templatesRoot, this.artifactDraft.fileName);
      if ((snapshot?.templates ?? []).some((template) => template.path === target)) {
        this.artifactErrors = [`${target} already exists. Open it from the library or choose a new template name.`];
        return this.render();
      }
      this.error = await this.onMessage({ type: 'save', path: target, content: renderArtifactTemplate(this.artifactDraft) });
      if (this.error) return this.render();
      /**
       * Saved, and deliberately not wired to anything.
       *
       * This used to run `workflow phase output add` immediately, which is what made a template
       * inseparable from one phase. The message says where the artifact goes next rather than
       * leaving the reader wondering why nothing appeared in a workflow.
       */
      void vscode.window.showInformationMessage(
        `Artifact template saved at ${target}. Attach it to a phase from the phase editor — any phase, and as many as need it.`
      );
      this.artifactDraft = newArtifactDraft(); this.artifactErrors = [];
      return this.render();
    }
  }

  private render(): void {
    const snapshot = this.store.current.snapshot;
    const token = nonce();
    const portfolioPath = snapshot?.portfolioPath ?? 'singularity/portfolio.yml';
    this.panel.webview.html = page('Workflows & artifacts', designerHtml(
      this.tab, this.profiles(snapshot), snapshot ? buildTemplateUsage(snapshot) : [], this.profile,
      this.filter, snapshot ? standingOn(snapshot, portfolioPath) : [], portfolioPath, this.error,
      this.workflowDraft, this.phaseDraft, this.artifactDraft, this.artifactErrors, this.phaseChoices(snapshot),
      // The graph the rail cannot draw. Built from the same snapshot the rest of the page renders,
      // so the diagram and the phase list can never describe different workflows.
      renderWorkflowGraph(buildWorkflowGraph(snapshot, this.profile ?? this.profiles(snapshot)[0]?.id ?? ''), { compact: true }),
      /**
       * The vocabularies the phase editor offers instead of asking blind.
       *
       * Both fields were free text with a placeholder, so the only way to learn a repository's view
       * or agent names was to guess or go read the YAML — and a typo produced a phase referring to a
       * view that does not exist. They stay free text, because a phase may legitimately name a view
       * that has not been built yet; the list is a `datalist`, which suggests without refusing.
       */
      [...new Set((snapshot?.worldModel?.views ?? []).map((view) => view.id))].sort(),
      [...new Set((snapshot?.agents ?? []).map((agent) => agent.id))].sort()
    ), contentSecurityPolicy(this.panel.webview, token), token, DESIGNER_SCRIPT);
  }

  dispose(): void {
    DesignerPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
