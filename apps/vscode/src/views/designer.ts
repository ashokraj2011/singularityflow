/**
 * The lifecycle designer panel.
 *
 * Editing lands in ordinary editor tabs rather than in forms here, deliberately. The portfolio's
 * phase definitions are deeply nested — outputs carry paths, templates, consumes edges, approval
 * chains and applicability policies — and a form over that shape would be a worse editor than the
 * editor, while quietly hiding the fields it did not model. What the files cannot do is tell you who
 * is standing on them, which is what this screen adds.
 */
import * as vscode from 'vscode';
import path from 'node:path';
import { designerHtml, DESIGNER_SCRIPT, type DesignerTab } from './designer-page.ts';
import { buildProfiles, buildTemplateUsage, standingOn } from './designer-model.ts';
import { contentSecurityPolicy, nonce, page } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';
import type { RepositorySnapshot } from '../cli/snapshot.ts';

/** The shape every artifact template in this repository already follows. */
function starterTemplate(name: string): string {
  const title = name.replace(/\.md$/, '').replace(/[-_]/g, ' ').replace(/^./, (first) => first.toUpperCase());
  return `<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

${title}: say here what this document is for, and what would make it wrong. A reader who only reads
this paragraph should know whether the rest applies to them.

## What this covers

## Decisions

| # | Decision | Rationale | Owner |
|---|---|---|---|
| D-1 | | | |

## What this deliberately does not cover

The boundary, so it is on the record rather than relitigated.

## Open questions

| Question | Blocks | Owner |
|---|---|---|

## Evidence

{{inputs}}
`;
}

export type DesignerMessage =
  | { type: 'open'; path: string }
  | { type: 'save'; path: string; content: string }
  // Authoring goes through the engine like every other governed write: the panel says what to run,
  // the extension runs it, and the validation that refuses a bad lifecycle is the same validation
  // the CLI uses. The editor does not get its own way past it.
  | { type: 'run'; command: string[]; title: string };

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

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: DesignerMessage) => Promise<string | null>
  ) {
    this.panel = panel;
    this.store = store;
    this.onMessage = onMessage;
    this.subscription = store.onDidChange(() => this.render());
    this.panel.webview.onDidReceiveMessage((raw: unknown) => { void this.receive(raw); }, null, this.disposables);
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
      'singularityFlow.designer', 'Workflow designer', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    DesignerPanel.current = new DesignerPanel(panel, store, onMessage);
    return DesignerPanel.current;
  }

  /** The profile the screen is showing, which is what the authoring actions act on. */
  private currentProfile(snapshot: RepositorySnapshot | null): { id: string; label: string; phases: string[] } | null {
    if (!snapshot) return null;
    const profiles = buildProfiles(snapshot);
    const chosen = profiles.find((entry) => entry.id === this.profile) ?? profiles[0];
    return chosen
      ? { id: chosen.id, label: chosen.label, phases: chosen.phases.map((phase) => phase.id) }
      : null;
  }

  /**
   * Every phase the portfolio defines, not only the ones this profile runs.
   *
   * Choosing from the profile's own phases could only ever remove them; the point of the picker is
   * to reach the ones it does not run yet.
   */
  private everyPhase(snapshot: RepositorySnapshot | null): { id: string; label: string }[] {
    const portfolio = snapshot?.portfolio as {
      initiativePhases?: Record<string, { label?: string }>;
    } | undefined;
    return Object.entries(portfolio?.initiativePhases ?? {})
      .map(([id, phase]) => ({ id, label: phase?.label ?? id }));
  }

  /** The template file a portfolio-declared template name resolves to, or null when unknown. */
  private resolveTemplate(declared: string): string | null {
    const templates = this.store.current.snapshot?.templates ?? [];
    return templates.find((template) => template.path.endsWith(declared))?.path ?? null;
  }

  private async receive(raw: unknown): Promise<void> {
    const message = raw as {
      type?: unknown; tab?: unknown; id?: unknown; value?: unknown;
      path?: unknown; template?: unknown; phase?: unknown; name?: unknown;
    };
    const snapshot = this.store.current.snapshot;

    if (message?.type === 'tab' && (message.tab === 'phases' || message.tab === 'templates')) {
      this.tab = message.tab;
      this.error = null;
      return this.render();
    }
    if (message?.type === 'profile' && typeof message.id === 'string') {
      this.profile = message.id;
      return this.render();
    }
    if (message?.type === 'filter' && typeof message.value === 'string') {
      this.filter = message.value;
      return this.render();
    }

    if (message?.type === 'open' && typeof message.path === 'string') {
      // Only a file this repository already lists. The page names one; it does not introduce one.
      const known = [
        snapshot?.portfolioPath ?? 'singularity/portfolio.yml',
        snapshot?.definitionPath ?? 'singularity/workflow.yml',
        ...(snapshot?.templates ?? []).map((template) => template.path)
      ];
      if (!known.includes(message.path)) return;
      await this.onMessage({ type: 'open', path: message.path });
      return;
    }

    if (message?.type === 'open-template' && typeof message.template === 'string') {
      const resolved = this.resolveTemplate(message.template);
      if (resolved) await this.onMessage({ type: 'open', path: resolved });
      else this.error = `No file in this repository matches the template '${message.template}'.`;
      return this.render();
    }

    // Choosing which phases a profile runs is genuinely a pick-and-order problem, which is what a
    // QuickPick is for. The alternative — a text field of comma-separated ids — asks somebody to
    // remember the identifiers of things this screen is already showing them.
    if (message?.type === 'reorder-phases') {
      const profile = this.currentProfile(snapshot);
      if (!profile) return;
      const every = this.everyPhase(snapshot);
      const picked = await vscode.window.showQuickPick(
        every.map((phase) => ({
          label: phase.label,
          description: phase.id,
          picked: profile.phases.includes(phase.id)
        })),
        { canPickMany: true, title: `Which phases does ${profile.label} run?`,
          placeHolder: 'Chosen in the order you pick them' });
      if (!picked?.length) return;
      this.error = await this.onMessage({
        type: 'run',
        command: ['workflow', 'edit', profile.id, '--phases', picked.map((entry) => entry.description).join(',')],
        title: `Changing ${profile.label}`
      });
      return this.render();
    }

    if (message?.type === 'new-profile') {
      const id = await vscode.window.showInputBox({
        title: 'New profile', prompt: 'Identifier, lower-case kebab-case', placeHolder: 'discovery-first'
      });
      if (!id?.trim()) return;
      const every = this.everyPhase(snapshot);
      const picked = await vscode.window.showQuickPick(
        every.map((phase) => ({ label: phase.label, description: phase.id })),
        { canPickMany: true, title: `Which phases does ${id.trim()} run?`,
          placeHolder: 'Chosen in the order you pick them' });
      if (!picked?.length) return;
      this.error = await this.onMessage({
        type: 'run',
        command: ['workflow', 'create', id.trim(), '--phases', picked.map((entry) => entry.description).join(',')],
        title: `Creating ${id.trim()}`
      });
      return this.render();
    }

    if (message?.type === 'new-phase') {
      const id = await vscode.window.showInputBox({
        title: 'New phase', prompt: 'Identifier, lower-case kebab-case', placeHolder: 'market-validation'
      });
      if (!id?.trim()) return;
      const label = await vscode.window.showInputBox({
        title: 'New phase', prompt: 'What this stage is called', value: id.trim()
      });
      this.error = await this.onMessage({
        type: 'run',
        command: ['workflow', 'phase', 'add', id.trim(), ...(label?.trim() ? ['--label', label.trim()] : [])],
        title: `Creating ${id.trim()}`
      });
      // Said here as well as by the CLI: a new phase runs nowhere until a profile lists it, and
      // somebody who just created one from this screen is about to wonder where it went.
      if (!this.error) {
        void vscode.window.showInformationMessage(
          `Phase ${id.trim()} created. It runs nowhere until a workflow lists it — use "Change which phases this workflow runs".`);
      }
      return this.render();
    }

    if (message?.type === 'edit-phase' && typeof message.phase === 'string') {
      // The phase is defined in the portfolio; opening it there is the honest answer, since a form
      // over the nested output shape would hide the fields it did not model.
      await this.onMessage({ type: 'open', path: snapshot?.portfolioPath ?? 'singularity/portfolio.yml' });
      return;
    }

    if (message?.type === 'create-template' && typeof message.name === 'string') {
      const name = message.name.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) {
        this.error = 'A template file name may contain letters, numbers, dots, underscores and hyphens, and must end in .md.';
        return this.render();
      }
      const referenced = buildTemplateUsage(snapshot ?? ({} as never))
        .find((template) => template.usedBy.length);
      if (!referenced) {
        this.error = 'No phase output points at a template yet, so there is nowhere obvious to put a new one. '
          + 'Add one beside an existing initiative template and reference it from portfolio.yml.';
        return this.render();
      }
      const root = referenced.path.split('/').slice(0, -1).join('/');
      const target = path.posix.join(root, name);
      if ((snapshot?.templates ?? []).some((template) => template.path === target)) {
        this.error = `${target} already exists.`;
        return this.render();
      }
      this.error = await this.onMessage({ type: 'save', path: target, content: starterTemplate(name) });
      if (!this.error) await this.onMessage({ type: 'open', path: target });
      return this.render();
    }
  }

  private render(): void {
    const snapshot = this.store.current.snapshot;
    const token = nonce();
    const portfolioPath = snapshot?.portfolioPath ?? 'singularity/portfolio.yml';
    this.panel.webview.html = page(
      'Workflow designer',
      designerHtml(
        this.tab,
        snapshot ? buildProfiles(snapshot) : [],
        snapshot ? buildTemplateUsage(snapshot) : [],
        this.profile,
        this.filter,
        snapshot ? standingOn(snapshot, portfolioPath) : [],
        portfolioPath,
        this.error
      ),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      DESIGNER_SCRIPT
    );
  }

  dispose(): void {
    DesignerPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
