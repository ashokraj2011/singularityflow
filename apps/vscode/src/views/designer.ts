/** Governed visual workflow and artifact-template authoring. */
import * as vscode from 'vscode';
import { buildWorkflowGraph } from './workflow-graph-model.ts';
import { renderWorkflowGraph } from './workflow-graph-svg.ts';
import path from 'node:path';
import {
  designerHtml, DESIGNER_SCRIPT, type DesignerTab, type PhaseChoice,
  type PhaseDraftView, type WorkflowDraftView, type WorkflowPortabilityView,
  type WorkflowProposalSummary
} from './designer-page.ts';
import { buildProfiles, buildTemplateUsage, standingOn, type Profile } from './designer-model.ts';
import { workflowLoopIssues } from './workflow-loop-draft.ts';
import {
  newArtifactDraft, renderArtifactTemplate, sectionFor, validateArtifactDraft,
  SECTION_CATALOG, type ArtifactDraft, type ArtifactSection, type ArtifactSectionKind
} from './artifact-designer-model.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import type { WorkspaceStore } from '../state.ts';
import type { RepositorySnapshot } from '../cli/snapshot.ts';
import { RetainedPanelRenderGate } from '../single-flight.ts';

export type DesignerMessage =
  | { type: 'open'; path: string }
  | { type: 'save'; path: string; content: string }
  | { type: 'review-proposal'; branch: string }
  | { type: 'export-workflows'; workflowIds: string[] }
  | { type: 'import-workflows' }
  | { type: 'copy-workflow'; sourceId: string; targetId: string; label: string }
  | { type: 'run'; command: string[]; title: string };

const GOVERNANCE = new Set(['story', 'initiative']);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function governs(value: unknown, fallback: 'story' | 'initiative' = 'story'): 'story' | 'initiative' {
  return typeof value === 'string' && GOVERNANCE.has(value) ? value as 'story' | 'initiative' : fallback;
}
function csv(value: string): string[] { return value.split(',').map((entry) => entry.trim()).filter(Boolean); }
function profileKey(profile: Pick<Profile, 'governs' | 'id'>): string {
  return `${profile.governs}:${profile.id}`;
}
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
  private readonly loadProposals: () => Promise<WorkflowProposalSummary[]>;
  private readonly subscription: { dispose(): void };
  private readonly snapshotRenders: RetainedPanelRenderGate;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private tab: DesignerTab = 'phases';
  private profile: string | null = null;
  private filter = 'all';
  private error: string | null = null;
  private workflowDraft: WorkflowDraftView | null = null;
  private phaseDraft: PhaseDraftView | null = null;
  private artifactDraft: ArtifactDraft = newArtifactDraft();
  private artifactErrors: string[] = [];
  private workflowProposals: WorkflowProposalSummary[] = [];
  private proposalsLoaded = false;
  private proposalsError: string | null = null;
  private workflowPortability: WorkflowPortabilityView = {
    mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
  };

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: DesignerMessage) => Promise<string | null>,
    loadProposals: () => Promise<WorkflowProposalSummary[]>,
    private readonly lease: { dispose(): void }
  ) {
    this.panel = panel;
    this.store = store;
    this.onMessage = onMessage;
    this.loadProposals = loadProposals;
    this.snapshotRenders = new RetainedPanelRenderGate(
      () => this.panel.visible !== false,
      () => this.render(),
      ['configuration']
    );
    this.subscription = store.onDidChange((_state, change) =>
      this.snapshotRenders.changed(change.kind, change.changedSlices));
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
 void this.receive(raw); }, null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState?.(({ webviewPanel }) => {
      this.snapshotRenders.visibilityChanged(webviewPanel.visible !== false);
    }, null, this.disposables);
    this.render();
    void this.refreshProposals();
  }

  static async show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: DesignerMessage) => Promise<string | null>,
    loadProposals: () => Promise<WorkflowProposalSummary[]>
  ): Promise<DesignerPanel> {
    if (DesignerPanel.current) {
      DesignerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void DesignerPanel.current.refreshProposals();
      return DesignerPanel.current;
    }
    const lease = await store.acquireSlices(['configuration']);
    const raced = DesignerPanel.current as DesignerPanel | null;
    if (raced) {
      lease.dispose();
      raced.panel.reveal(vscode.ViewColumn.Active);
      void raced.refreshProposals();
      return raced;
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        'singularityFlow.designer', 'Workflows & artifacts', vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        });
      DesignerPanel.current = new DesignerPanel(panel, store, onMessage, loadProposals, lease);
    } catch (error) {
      lease.dispose();
      throw error;
    }
    return DesignerPanel.current;
  }

  private async refreshProposals(): Promise<void> {
    this.proposalsLoaded = false;
    this.proposalsError = null;
    this.render();
    try {
      this.workflowProposals = await this.loadProposals();
    } catch (error) {
      this.workflowProposals = [];
      this.proposalsError = (error as Error).message;
    } finally {
      this.proposalsLoaded = true;
      this.render();
    }
  }

  private profiles(snapshot: RepositorySnapshot | null): Profile[] {
    return snapshot ? buildProfiles(snapshot) : [];
  }

  private currentProfile(snapshot: RepositorySnapshot | null): Profile | null {
    const profiles = this.profiles(snapshot);
    return profiles.find((entry) => profileKey(entry) === this.profile)
      ?? profiles.find((entry) => entry.id === this.profile) ?? profiles[0] ?? null;
  }

  /** Every phase available to either kind of workflow, including phases no workflow uses yet. */
  private phaseChoices(snapshot: RepositorySnapshot | null): PhaseChoice[] {
    if (!snapshot) return [];
    const definition = snapshot.definition as { phases?: Record<string, {
      label?: string; artifact?: { kind?: string }; defaultTemplate?: string;
      inputs?: Array<string | { phase?: string }>;
      approval?: { authorities?: string[]; minimum?: number };
      worldModel?: { views?: string[] }; generation?: { task?: string };
    }> } | undefined;
    const portfolio = snapshot.portfolio as { initiativePhases?: Record<string, {
      label?: string; worldModelViews?: string[]; bundleApproval?: { authorities?: string[]; minimum?: number };
    }> } | undefined;
    return [
      ...Object.entries(definition?.phases ?? {}).map(([id, phase]) => ({
        id, label: phase.label ?? id, governs: 'story' as const,
        artifactKind: phase.artifact?.kind, template: phase.defaultTemplate,
        inputs: (phase.inputs ?? []).map((input) => typeof input === 'string' ? input : input.phase ?? '').filter(Boolean),
        authorities: phase.approval?.authorities ?? [], minimumApprovals: phase.approval?.minimum ?? 1,
        views: phase.worldModel?.views ?? [], task: phase.generation?.task ?? 'none'
      })),
      ...Object.entries(portfolio?.initiativePhases ?? {}).map(([id, phase]) => ({
        id, label: phase.label ?? id, governs: 'initiative' as const,
        authorities: phase.bundleApproval?.authorities ?? [], minimumApprovals: phase.bundleApproval?.minimum ?? 1,
        views: phase.worldModelViews ?? []
      }))
    ];
  }

  private resolveTemplate(declared: string): string | null {
    return this.store.current.snapshot?.templates?.find((template) => template.path.endsWith(declared))?.path ?? null;
  }

  private beginWorkflow(isNew: boolean): void {
    const profile = this.currentProfile(this.store.current.snapshot);
    this.phaseDraft = null;
    this.workflowPortability = {
      mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
    };
    this.workflowDraft = isNew || !profile ? {
      isNew: true, id: '', label: '', description: '', governs: profile?.governs ?? 'story', phases: [],
      reworkLoops: [],
      plannedClaimsMode: 'required', clausePhases: '', claimOwners: '', optOutReason: ''
    } : {
      isNew: false, id: profile.id, label: profile.label, description: profile.description,
      governs: profile.governs, phases: profile.phases.map((phase) => ({ id: phase.id, label: phase.label })),
      reworkLoops: (profile.reworkLoops ?? []).map((loop) => ({ ...loop })),
      plannedClaimsMode: profile.plannedClaims?.mode === 'opt-out' ? 'opt-out' : 'required',
      clausePhases: (profile.plannedClaims?.clausePhases ?? []).join(', '),
      claimOwners: Object.entries(profile.plannedClaims?.owners ?? {}).map(([code, clause]) => `${code}=${clause}`).join(', '),
      optOutReason: profile.plannedClaims?.reason ?? ''
    };
  }

  private phaseDefinition(id: string): PhaseDraftView | null {
    const snapshot = this.store.current.snapshot;
    const preferred = this.currentProfile(snapshot)?.governs;
    const definition = snapshot?.definition as { phases?: Record<string, {
      label?: string; agents?: string[]; worldModel?: { views?: string[] };
      generation?: { task?: 'code' | 'analyze' | 'none' };
      approval?: { authorities?: string[]; minimum?: number };
    }> } | undefined;
    const portfolio = snapshot?.portfolio as { initiativePhases?: Record<string, {
      label?: string; agents?: string[]; worldModelViews?: string[]; lanes?: string[];
      bundleApproval?: { authorities?: string[]; minimum?: number };
    }> } | undefined;
    const story = definition?.phases?.[id];
    const initiative = portfolio?.initiativePhases?.[id];
    if (preferred === 'story' && story) return { isNew: false, id, label: story.label ?? id, governs: 'story', views: (story.worldModel?.views ?? []).join(', '), agents: (story.agents ?? []).join(', '), lanes: '', task: story.generation?.task, approvalAuthorities: (story.approval?.authorities ?? []).join(', '), approvalMinimum: story.approval?.minimum ?? 1 };
    if (initiative) return { isNew: false, id, label: initiative.label ?? id, governs: 'initiative', views: (initiative.worldModelViews ?? []).join(', '), agents: (initiative.agents ?? []).join(', '), lanes: (initiative.lanes ?? []).join(', '), approvalAuthorities: (initiative.bundleApproval?.authorities ?? []).join(', '), approvalMinimum: initiative.bundleApproval?.minimum ?? 1 };
    if (story) return { isNew: false, id, label: story.label ?? id, governs: 'story', views: (story.worldModel?.views ?? []).join(', '), agents: (story.agents ?? []).join(', '), lanes: '', task: story.generation?.task, approvalAuthorities: (story.approval?.authorities ?? []).join(', '), approvalMinimum: story.approval?.minimum ?? 1 };
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
    if (raw.plannedClaimsMode === 'required' || raw.plannedClaimsMode === 'opt-out') this.workflowDraft.plannedClaimsMode = raw.plannedClaimsMode;
    this.workflowDraft.clausePhases = text(raw.clausePhases);
    this.workflowDraft.claimOwners = text(raw.claimOwners);
    this.workflowDraft.optOutReason = text(raw.optOutReason);
    if (Array.isArray(raw.reworkLoops)) {
      this.workflowDraft.reworkLoops = raw.reworkLoops.map((value) => {
        const loop = value && typeof value === 'object' ? value as Record<string, unknown> : {};
        return {
          from: text(loop.from), to: text(loop.to), maxAttempts: Number(loop.maxAttempts),
          ...(text(loop.resetOnPhase) ? { resetOnPhase: text(loop.resetOnPhase) } : {})
        };
      });
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const message = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const snapshot = this.store.current.snapshot;

    if (message.type === 'tab' && (message.tab === 'phases' || message.tab === 'templates')) {
      this.tab = message.tab; this.error = null; return this.render();
    }
    if (message.type === 'profile' && typeof message.id === 'string') {
      this.profile = message.id; this.workflowDraft = null; this.phaseDraft = null;
      this.workflowPortability = {
        mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
      };
      return this.render();
    }
    if (message.type === 'filter' && typeof message.value === 'string') {
      this.filter = message.value; return this.render();
    }
    if (message.type === 'refresh-proposals') return void this.refreshProposals();
    if (message.type === 'review-proposal' && typeof message.branch === 'string') {
      if (!this.workflowProposals.some((proposal) => proposal.branch === message.branch)) return;
      this.error = await this.onMessage({ type: 'review-proposal', branch: message.branch });
      await this.refreshProposals();
      return;
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

    if (message.type === 'open-workflow-export') {
      const profile = this.currentProfile(snapshot);
      this.workflowDraft = null;
      this.phaseDraft = null;
      this.error = null;
      this.workflowPortability = {
        mode: 'export', selectedWorkflowIds: profile ? [`${profile.governs}:${profile.id}`] : [],
        copySourceId: null, copyTargetId: '', copyLabel: ''
      };
      return this.render();
    }
    if (message.type === 'open-workflow-copy') {
      const profile = this.currentProfile(snapshot);
      if (!profile) return;
      this.workflowDraft = null;
      this.phaseDraft = null;
      this.error = null;
      this.workflowPortability = {
        mode: 'copy', selectedWorkflowIds: [], copySourceId: profileKey(profile),
        copyTargetId: `${profile.id}-copy`, copyLabel: `${profile.label} copy`
      };
      return this.render();
    }
    if (message.type === 'cancel-workflow-portability') {
      this.workflowPortability = {
        mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
      };
      this.error = null;
      return this.render();
    }
    if (message.type === 'export-workflows') {
      const available = new Set(this.profiles(snapshot).map((profile) => `${profile.governs}:${profile.id}`));
      const workflowIds = Array.isArray(message.workflowIds)
        ? [...new Set(message.workflowIds.map(text).filter((id) => available.has(id)))] : [];
      this.workflowPortability = { ...this.workflowPortability, selectedWorkflowIds: workflowIds };
      if (!workflowIds.length) {
        this.error = 'Choose at least one workflow to export.';
        return this.render();
      }
      this.error = await this.onMessage({ type: 'export-workflows', workflowIds });
      if (!this.error) {
        this.workflowPortability = {
          mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
        };
      }
      return this.render();
    }
    if (message.type === 'import-workflows') {
      this.error = await this.onMessage({ type: 'import-workflows' });
      if (!this.error) {
        this.workflowPortability = {
          mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
        };
        await this.refreshProposals();
      }
      return this.render();
    }
    if (message.type === 'copy-workflow') {
      const sourceId = text(message.sourceId);
      const targetId = text(message.targetId);
      const label = text(message.label);
      const profiles = this.profiles(snapshot);
      this.workflowPortability = { ...this.workflowPortability, copyTargetId: targetId, copyLabel: label };
      if (sourceId !== this.workflowPortability.copySourceId
          || !profiles.some((profile) => profileKey(profile) === sourceId)) {
        this.error = 'Choose an existing source workflow before duplicating it.';
      } else if (!ID.test(targetId)) {
        this.error = 'New workflow ID must be lower-case kebab-case.';
      } else if (profiles.some((profile) => profile.id === targetId)) {
        this.error = `Workflow '${targetId}' already exists.`;
      } else if (!label) {
        this.error = 'Give the duplicated workflow a display name.';
      } else {
        this.error = await this.onMessage({ type: 'copy-workflow', sourceId, targetId, label });
        if (!this.error) {
          this.workflowPortability = {
            mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
          };
          await this.refreshProposals();
          return;
        }
      }
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
      this.workflowDraft.reworkLoops = [];
      return this.render();
    }
    if (message.type === 'workflow-claims' && this.workflowDraft) {
      this.updateWorkflow(message);
      return this.render();
    }
    if (message.type === 'workflow-loops' && this.workflowDraft?.governs === 'story') {
      this.updateWorkflow(message);
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
    if (message.type === 'add-workflow-loop' && this.workflowDraft?.governs === 'story') {
      this.updateWorkflow(message);
      this.workflowDraft.reworkLoops.push({ from: '', to: '', maxAttempts: 3 });
      return this.render();
    }
    if (message.type === 'remove-workflow-loop' && this.workflowDraft?.governs === 'story') {
      this.updateWorkflow(message);
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index >= this.workflowDraft.reworkLoops.length) return;
      this.workflowDraft.reworkLoops.splice(index, 1);
      return this.render();
    }
    if (message.type === 'save-workflow' && this.workflowDraft) {
      this.updateWorkflow(message);
      const draft = this.workflowDraft;
      const chosen = this.phaseChoices(snapshot).filter((phase) =>
        phase.governs === draft.governs && draft.phases.some((entry) => entry.id === phase.id));
      const eligible = new Set(chosen.filter((phase) =>
        ['requirements', 'implementation-spec'].includes(phase.artifactKind ?? '')).map((phase) => phase.id));
      const clausePhases = csv(draft.clausePhases ?? '');
      const ownerEntries = csv(draft.claimOwners ?? '');
      const loopIssues = draft.governs === 'story'
        ? workflowLoopIssues(draft.phases.map((phase) => phase.id), draft.reworkLoops) : [];
      const invalidClause = clausePhases.find((id) => !eligible.has(id));
      const invalidOwner = ownerEntries.find((entry) => {
        const match = entry.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)=([a-z0-9]+(?:-[a-z0-9]+)*)$/);
        return !match || !chosen.some((phase) => phase.id === match[1] && phase.task === 'code') || !eligible.has(match[2] ?? '');
      });
      if (!ID.test(this.workflowDraft.id)) this.error = 'Workflow ID must be lower-case kebab-case.';
      else if (!this.workflowDraft.label) this.error = 'Give the workflow a display name.';
      else if (!this.workflowDraft.phases.length) this.error = 'A workflow needs at least one phase.';
      else if (loopIssues.length) this.error = loopIssues[0] ?? 'Correct the rework loop before saving.';
      else if (draft.governs === 'story' && draft.plannedClaimsMode !== 'opt-out' && !eligible.size) {
        this.error = 'This Story has no clause-capable phase. Add a phase with a requirements or implementation-spec artifact, or choose a reviewed opt-out.';
      }
      else if (draft.governs === 'story' && draft.plannedClaimsMode === 'opt-out' && !draft.optOutReason) {
        this.error = 'An explicit planned-claims opt-out needs a reviewed reason.';
      } else if (draft.governs === 'story' && draft.plannedClaimsMode !== 'opt-out' && invalidClause) {
        this.error = `Phase '${invalidClause}' cannot carry clauses. Eligible phases in this workflow: ${[...eligible].join(', ') || 'none'}.`;
      } else if (draft.governs === 'story' && draft.plannedClaimsMode !== 'opt-out' && invalidOwner) {
        this.error = `Claim owner '${invalidOwner}' must be a selected code phase=eligible clause phase pair.`;
      }
      else {
        const command = ['workflow', this.workflowDraft.isNew ? 'create' : 'edit', this.workflowDraft.id,
          '--label', this.workflowDraft.label, '--description', this.workflowDraft.description,
          '--phases', this.workflowDraft.phases.map((phase) => phase.id).join(',')];
        if (this.workflowDraft.isNew) command.push('--governs', this.workflowDraft.governs);
        if (draft.governs === 'story') {
          if (!draft.isNew && draft.reworkLoops.length === 0) command.push('--clear-loops');
          for (const loop of draft.reworkLoops) command.push('--loop',
            `${loop.from}:${loop.to}:${loop.maxAttempts}${loop.resetOnPhase ? `:${loop.resetOnPhase}` : ''}`);
          command.push('--planned-claims', draft.plannedClaimsMode === 'opt-out' ? 'opt-out' : 'required');
          if (draft.plannedClaimsMode === 'opt-out') command.push('--opt-out-reason', draft.optOutReason ?? '');
          else {
            if (clausePhases.length) command.push('--clause-phases', clausePhases.join(','));
            if (ownerEntries.length) command.push('--claim-owners', ownerEntries.join(','));
          }
        }
        this.error = await this.onMessage({ type: 'run', command, title: `${this.workflowDraft.isNew ? 'Creating' : 'Saving'} ${this.workflowDraft.label}` });
        // A lead-governed save is a review proposal, while local authority writes uncommitted
        // configuration. Reload either way; selecting a proposal ID before it is approved made
        // the workflow look as though it had disappeared.
        if (!this.error) {
          this.workflowDraft = null;
          await this.refreshProposals();
          return;
        }
      }
      return this.render();
    }

    if (message.type === 'new-phase') {
      this.workflowDraft = null;
      this.workflowPortability = {
        mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
      };
      this.phaseDraft = { isNew: true, id: '', label: '', governs: this.currentProfile(snapshot)?.governs ?? 'story', views: '', agents: '', lanes: '', task: 'none', approvalAuthorities: '', approvalMinimum: 1 };
      return this.render();
    }
    if (message.type === 'edit-phase' && typeof message.phase === 'string') {
      this.workflowDraft = null;
      this.workflowPortability = {
        mode: null, selectedWorkflowIds: [], copySourceId: null, copyTargetId: '', copyLabel: ''
      };
      this.phaseDraft = this.phaseDefinition(message.phase); return this.render();
    }
    if (message.type === 'cancel-phase') { this.phaseDraft = null; return this.render(); }
    if (message.type === 'save-phase' && this.phaseDraft) {
      this.phaseDraft.id = text(message.id) || this.phaseDraft.id;
      this.phaseDraft.label = text(message.label);
      this.phaseDraft.governs = governs(message.governs, this.phaseDraft.governs);
      this.phaseDraft.views = text(message.views); this.phaseDraft.agents = text(message.agents); this.phaseDraft.lanes = text(message.lanes);
      this.phaseDraft.task = message.task === 'code' || message.task === 'analyze' || message.task === 'none'
        ? message.task : undefined;
      this.phaseDraft.approvalAuthorities = text(message.authorities);
      this.phaseDraft.approvalMinimum = Number(message.minimum);
      const knownAuthorities = new Set([
        ...Object.keys((snapshot?.definition as { approvalAuthorities?: Record<string, unknown> } | undefined)?.approvalAuthorities ?? {}),
        ...Object.keys((snapshot?.portfolio as { approvalAuthorities?: Record<string, unknown> } | undefined)?.approvalAuthorities ?? {})
      ]);
      const invalidAuthority = csv(this.phaseDraft.approvalAuthorities).find((id) => !knownAuthorities.has(id));
      if (!ID.test(this.phaseDraft.id)) this.error = 'Phase ID must be lower-case kebab-case.';
      else if (!this.phaseDraft.label) this.error = 'Give the phase a display name.';
      else if (!csv(this.phaseDraft.approvalAuthorities).length) this.error = 'Choose at least one configured approval authority for this phase.';
      else if (!Number.isInteger(this.phaseDraft.approvalMinimum) || this.phaseDraft.approvalMinimum < 1) this.error = 'Minimum approvals must be a positive whole number.';
      else if (invalidAuthority) this.error = `Approval group '${invalidAuthority}' is not configured in this repository.`;
      else if (this.phaseDraft.isNew && this.phaseDraft.governs === 'story' && !csv(this.phaseDraft.agents).length) {
        this.error = 'Choose a governed agent for this new Story phase. Its Agent Markdown must exist before the phase is saved.';
      }
      else {
        const command = ['workflow', 'phase', this.phaseDraft.isNew ? 'add' : 'edit', this.phaseDraft.id,
          '--label', this.phaseDraft.label, '--views', csv(this.phaseDraft.views).join(','),
          '--agents', csv(this.phaseDraft.agents).join(','), '--governs', this.phaseDraft.governs,
          '--authorities', csv(this.phaseDraft.approvalAuthorities).join(','), '--minimum', String(this.phaseDraft.approvalMinimum)];
        if (this.phaseDraft.governs === 'story' && this.phaseDraft.task) command.push('--task', this.phaseDraft.task);
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
    this.snapshotRenders.rendered();
    const snapshot = this.store.current.snapshot;
    const token = nonce();
    const portfolioPath = snapshot?.portfolioPath ?? 'singularity/portfolio.yml';
    const currentProfile = this.currentProfile(snapshot);
    const currentProfileKey = currentProfile ? profileKey(currentProfile) : null;
    this.panel.webview.html = page('Workflows & artifacts', designerHtml(
      this.tab, this.profiles(snapshot), snapshot ? buildTemplateUsage(snapshot) : [], currentProfileKey,
      this.filter, snapshot ? standingOn(snapshot, portfolioPath) : [], portfolioPath, this.error,
      this.workflowDraft, this.phaseDraft, this.artifactDraft, this.artifactErrors, this.phaseChoices(snapshot),
      // The graph the rail cannot draw. Built from the same snapshot the rest of the page renders,
      // so the diagram and the phase list can never describe different workflows.
      renderWorkflowGraph(buildWorkflowGraph(
        snapshot, currentProfile?.governs === 'story' ? currentProfile.id : ''
      ), { compact: true }),
      /**
       * The vocabularies the phase editor offers instead of asking blind.
       *
       * Both fields were free text with a placeholder, so the only way to learn a repository's view
       * or agent names was to guess or go read the YAML — and a typo produced a phase referring to a
       * view that does not exist. They stay free text, because a phase may legitimately name a view
       * that has not been built yet; the list is a `datalist`, which suggests without refusing.
       */
      [...new Set((snapshot?.worldModel?.views ?? []).map((view) => view.id))].sort(),
      [...new Set((snapshot?.agents ?? []).map((agent) => agent.id))].sort(),
      this.workflowProposals, this.proposalsLoaded, this.proposalsError,
      [...new Set([
        ...Object.keys((snapshot?.definition as { approvalAuthorities?: Record<string, unknown> } | undefined)?.approvalAuthorities ?? {}),
        ...Object.keys((snapshot?.portfolio as { approvalAuthorities?: Record<string, unknown> } | undefined)?.approvalAuthorities ?? {})
      ])].sort(),
      this.workflowPortability
    ), contentSecurityPolicy(this.panel.webview, token), token, DESIGNER_SCRIPT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    DesignerPanel.current = null;
    this.subscription.dispose();
    this.snapshotRenders.dispose();
    this.lease.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
