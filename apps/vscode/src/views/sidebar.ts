/** Task-oriented navigation. The existing read models and guarded commands remain authoritative. */
import * as vscode from 'vscode';
import type { TreeNode } from './tree-model.ts';
import { contentSecurityPolicy, nonce, type IconName } from './webview.ts';
import { resolveProfilePersona, type ProfilePersona } from './profile-personas.ts';
import type { SidebarNavigation } from './sidebar-navigation-model.ts';
import { MicrotaskCoalescer } from '../single-flight.ts';
import { HELP_COMMANDS, HELP_TOPICS } from './navigator-help.ts';
import { PRIMARY_NAVIGATION, sidebarBody, SIDEBAR_STYLE, SIDEBAR_SCRIPT } from './sidebar-page.ts';

export type SidebarSection = 'favorites' | 'workspaces' | 'lifecycle' | 'inbox' | 'logs' | 'configuration' | 'help';

interface TreeSource {
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined>;
  snapshot(): readonly TreeNode[];
}

const ACTION_COMMANDS: Record<string, string> = {
  ...Object.fromEntries(PRIMARY_NAVIGATION.map(item => [item.id, item.command])),
  'favorites-manage': 'singularityFlow.manageFavorites',
  'persona-manage': 'singularityFlow.choosePersona',
  'my-work': 'singularityFlow.myWork',
  'workspace-create': 'singularityFlow.createWorkspace',
  'setup-wizard': 'singularityFlow.startWizard',
  'workspace-manage': 'singularityFlow.openWorkspaces',
  'workspace-switch': 'singularityFlow.switchWorkspace',
  'local-reset': 'singularityFlow.openLocalReset',
  'work-start': 'singularityFlow.startWork',
  'story-intake': 'singularityFlow.openStoryIntake',
  'adhoc-work': 'singularityFlow.openAdhocWork',
  goals: 'singularityFlow.openGoals',
  'impact-form': 'singularityFlow.impactForm',
  refresh: 'singularityFlow.refresh',
  'inbox-open': 'singularityFlow.openInbox',
  'fault-repairs': 'singularityFlow.openFaultRepairs',
  'capability-map': 'singularityFlow.mapCapability',
  'capability-refresh': 'singularityFlow.refreshCapability',
  'workflow-design': 'singularityFlow.openWorkflowStudio',
  'instruction-design': 'singularityFlow.openInstructionDesigner',
  'prompt-audit': 'singularityFlow.openPromptAudit',
  'visual-assurance': 'singularityFlow.openVisualAssurance',
  'help-open': 'singularityFlow.openHelp',
  journal: 'singularityFlow.openJournal',
  diagnostics: 'singularityFlow.openDiagnostics',
  'activity-log': 'singularityFlow.openActivityLog',
  'logs-open': 'singularityFlow.openWorkspaceLogs',
  'logs-refresh': 'singularityFlow.refreshWorkspaceLogs',
  'configuration-center': 'singularityFlow.openConfigurationCenter',
  'ast-intelligence': 'singularityFlow.configureAstIntelligence',
  'approvals-open': 'singularityFlow.openApprovals',
  'capability-proposals': 'singularityFlow.reviewCapabilityProposals',
  'flow-impact': 'singularityFlow.openFlowImpact',
  'command-center': 'singularityFlow.openCommandCenter',
  'comprehension-center': 'singularityFlow.openComprehensionCenter',
  'change-explorer': 'singularityFlow.openChangeExplorer',
  'code-explainer': 'singularityFlow.openCodeExplainer',
  'code-explanation': 'singularityFlow.openCodeExplanation',
  'repository-knowledge': 'singularityFlow.openRepositoryKnowledge'
};

interface FavoriteMenu {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
  readonly command: string;
}

/**
 * The bounded menu people may personalize.
 *
 * Favorites are navigation, not a second command registry. Every destination names the same
 * contributed command its original menu uses, so pinning cannot create a shortcut around a
 * confirmation, repository check, or lifecycle gate.
 */
export const FAVORITE_MENUS: readonly FavoriteMenu[] = Object.freeze([
  { id: 'my-work', label: 'My Work', description: 'current work and next actions', icon: 'home', command: ACTION_COMMANDS['my-work']! },
  { id: 'command-center', label: 'Command Center', description: 'governed execution processes and requests', icon: 'workflow', command: ACTION_COMMANDS['command-center']! },
  { id: 'change-explorer', label: 'Explain changes', description: 'the current changes, why they were made, and what they touch', icon: 'code', command: ACTION_COMMANDS['change-explorer']! },
  { id: 'code-explainer', label: 'Code Explainer', description: 'changed functions, their callers, callees and tests, as an interactive graph', icon: 'code', command: ACTION_COMMANDS['code-explainer']! },
  { id: 'code-explanation', label: 'Code explanation', description: 'why each changed hunk is there', icon: 'code', command: ACTION_COMMANDS['code-explanation']! },
  { id: 'repository-knowledge', label: 'Repository knowledge', description: 'rules, journeys, tests and gaps read from the code', icon: 'book', command: ACTION_COMMANDS['repository-knowledge']! },
  { id: 'comprehension-center', label: 'Comprehension Center', description: 'exact change regions, causes, unknowns, and replay', icon: 'code', command: ACTION_COMMANDS['comprehension-center']! },
  { id: 'work-start', label: 'Start intake', description: 'begin governed work', icon: 'start', command: ACTION_COMMANDS['work-start']! },
  { id: 'story-intake', label: 'View Story intake details', description: 'saved inputs, selected base and recorded setup', icon: 'book', command: ACTION_COMMANDS['story-intake']! },
  { id: 'adhoc-work', label: 'Ad hoc work', description: 'land bounded work without a Story', icon: 'commit', command: ACTION_COMMANDS['adhoc-work']! },
  { id: 'inbox-open', label: 'Inbox', description: 'work waiting on you', icon: 'inbox', command: ACTION_COMMANDS['inbox-open']! },
  { id: 'approvals-open', label: 'Approvals', description: 'governed decisions', icon: 'approval', command: ACTION_COMMANDS['approvals-open']! },
  { id: 'configuration-approvals', label: 'Configuration approvals', description: 'review and activate workflow, agent and test-configuration proposals', icon: 'merge', command: ACTION_COMMANDS['configuration-approvals']! },
  { id: 'workspace-manage', label: 'Workspaces', description: 'choose and manage workspaces', icon: 'workspace', command: ACTION_COMMANDS['workspace-manage']! },
  { id: 'after-install', label: 'After install', description: 'guided build check, safe repository upgrade and workspace refresh', icon: 'configuration', command: ACTION_COMMANDS['after-install']! },
  { id: 'setup-wizard', label: 'Guided start', description: 'capability → workspace → first work item', icon: 'start', command: ACTION_COMMANDS['setup-wizard']! },
  { id: 'goals', label: 'Goals', description: 'outcomes linked to governed work', icon: 'impact', command: ACTION_COMMANDS.goals! },
  { id: 'fault-repairs', label: 'Faults & Repairs', description: 'diagnose and recover safely', icon: 'warning', command: ACTION_COMMANDS['fault-repairs']! },
  { id: 'journal', label: 'Local Journal', description: 'private local work history', icon: 'book', command: ACTION_COMMANDS.journal! },
  { id: 'diagnostics', label: 'Diagnostics', description: 'repository and schema health', icon: 'statusCurrent', command: ACTION_COMMANDS.diagnostics! },
  { id: 'local-reset', label: 'Local Data & Reset', description: 'preview local cleanup', icon: 'remove', command: ACTION_COMMANDS['local-reset']! },
  { id: 'configuration-center', label: 'Configuration Center', description: 'governed product configuration', icon: 'configuration', command: ACTION_COMMANDS['configuration-center']! },
  { id: 'ast-intelligence', label: 'AST intelligence', description: 'structural policy, assurance and cache', icon: 'worldModel', command: ACTION_COMMANDS['ast-intelligence']! },
  { id: 'capability-map', label: 'Map a capability', description: 'capability ownership and repositories', icon: 'capability', command: ACTION_COMMANDS['capability-map']! },
  { id: 'visual-assurance', label: 'Visual assurance', description: 'design and comparison evidence', icon: 'visual', command: ACTION_COMMANDS['visual-assurance']! },
  { id: 'impact-form', label: 'Change Flight Plan', description: 'preview and explain a proposed change', icon: 'compare', command: ACTION_COMMANDS['impact-form']! },
  { id: 'flow-impact', label: 'Flow impact', description: 'studies and reports', icon: 'impact', command: ACTION_COMMANDS['flow-impact']! },
  { id: 'logs-open', label: 'Workspace logs', description: 'combined workspace timeline', icon: 'commit', command: ACTION_COMMANDS['logs-open']! },
  { id: 'activity-log', label: 'Activity log', description: 'governed activity', icon: 'commit', command: ACTION_COMMANDS['activity-log']! },
  { id: 'prompt-audit', label: 'Prompt audit', description: 'what was sent to models', icon: 'prompt', command: ACTION_COMMANDS['prompt-audit']! },
  { id: 'help-open', label: 'Help Center', description: 'offline guides and commands', icon: 'help', command: ACTION_COMMANDS['help-open']! }
]);

const FAVORITES_KEY = 'singularityFlow.navigationFavorites.v2';
const LEGACY_FAVORITES_KEY = 'singularityFlow.navigationFavorites.v1';
const FAVORITE_BY_ID = new Map(FAVORITE_MENUS.map((menu) => [menu.id, menu]));

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly roots: Record<SidebarSection, readonly TreeNode[]> = {
    favorites: [], workspaces: [], lifecycle: [], inbox: [], logs: [], configuration: [], help: []
  };
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly nodeIndex = new Map<string, TreeNode>();
  private readonly bound = new Set<SidebarSection>();
  /** The source feeding each bound section, readable back through `sourceFor`. */
  private readonly sources: Partial<Record<SidebarSection, TreeSource>> = {};
  private view: vscode.WebviewView | null = null;
  private freshness: string | null = null;
  private awaitingFirstRead = false;
  private navigation: SidebarNavigation = { workspace: null, next: null };
  private pendingApprovals: number | null = null;
  private activeDestination: string | null = null;
  private renderedBody: string | null = null;
  private favoriteIds: string[];
  private favoritesCustomized: boolean;
  /** Three tree providers publish one snapshot synchronously; replace the document once, not thrice. */
  private readonly renders = new MicrotaskCoalescer(() => this.render());

  constructor(
    private readonly state: Pick<vscode.Memento, 'get' | 'update'>,
    private readonly profile: () => { name?: string; role?: string } = () => ({}),
    private readonly onRender: () => void = () => {}
  ) {
    // A missing preference is a first visit; an empty array is an intentional choice. Keeping those
    // distinct lets the sidebar be useful immediately without resurrecting favorites somebody
    // explicitly removed.
    const stored = state.get<unknown>(FAVORITES_KEY);
    const legacy = stored === undefined ? state.get<unknown>(LEGACY_FAVORITES_KEY) : undefined;
    const saved = Array.isArray(stored)
      ? stored
      : Array.isArray(legacy) ? [...legacy, 'capability-map'] : null;
    this.favoritesCustomized = saved !== null;
    this.favoriteIds = saved
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string' && FAVORITE_BY_ID.has(id)))]
      : this.personaFavoriteIds();
    // Existing installations receive this important entry once. Subsequent choices use v2, so a
    // person can still unpin it and that explicit choice will survive reloads and persona changes.
    if (Array.isArray(legacy) && !Array.isArray(stored)) void state.update(FAVORITES_KEY, this.favoriteIds);
    this.bound.add('favorites');
    this.refreshFavorites();
  }

  private persona(): ProfilePersona {
    return resolveProfilePersona(this.profile().role);
  }

  private personaFavoriteIds(): string[] {
    return this.persona().menuIds.filter((id) => FAVORITE_BY_ID.has(id));
  }

  /** Re-render machine-local guidance when the VS Code profile changes. */
  profileChanged(): void {
    if (!this.favoritesCustomized) this.favoriteIds = this.personaFavoriteIds();
    this.refreshFavorites();
  }

  private refreshFavorites(): void {
    this.roots.favorites = this.favoriteIds.flatMap((id) => {
      const menu = FAVORITE_BY_ID.get(id);
      return menu ? [{
        kind: 'action' as const,
        id: `favorite:${menu.id}`,
        label: menu.label,
        description: menu.description,
        icon: menu.icon,
        runCommand: menu.command
      }] : [];
    });
    this.renders.request();
  }

  async manageFavorites(): Promise<void> {
    const persona = this.persona();
    const preferred = new Map(persona.menuIds.map((id, index) => [id, index]));
    const menus = [...FAVORITE_MENUS].sort((left, right) =>
      (preferred.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (preferred.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    const chosen = await vscode.window.showQuickPick(menus.map((menu) => ({
      label: menu.label,
      description: menu.description,
      detail: preferred.has(menu.id) ? `Recommended for ${persona.label}` : undefined,
      picked: this.favoriteIds.includes(menu.id),
      menuId: menu.id
    })), {
      title: 'Choose favorite Singularity Flow menus',
      placeHolder: `Select pinned shortcuts · ${persona.label} suggestions appear first`,
      canPickMany: true,
      ignoreFocusOut: true
    });
    if (chosen === undefined) return;
    const selections = Array.isArray(chosen) ? chosen : [chosen];
    const previous = new Set(this.favoriteIds);
    this.favoritesCustomized = true;
    this.favoriteIds = selections.map((item) => item.menuId).filter((id) => FAVORITE_BY_ID.has(id));
    await this.state.update(FAVORITES_KEY, this.favoriteIds);
    this.refreshFavorites();
    const added = this.favoriteIds.filter((id) => !previous.has(id))
      .map((id) => FAVORITE_BY_ID.get(id)?.label).filter((label): label is string => Boolean(label));
    if (added.length === 1) void vscode.window.showInformationMessage(`${added[0]} added to Favorites.`);
    else if (added.length > 1) void vscode.window.showInformationMessage(`${added.length} menus added to Favorites.`);
  }

  private async removeFavorite(id: string): Promise<void> {
    if (!FAVORITE_BY_ID.has(id) || !this.favoriteIds.includes(id)) return;
    this.favoritesCustomized = true;
    this.favoriteIds = this.favoriteIds.filter((candidate) => candidate !== id);
    await this.state.update(FAVORITES_KEY, this.favoriteIds);
    this.refreshFavorites();
  }

  /**
   * Say when what is on screen is not confirmed.
   *
   * The sidebar now opens on the previous session's snapshot rather than waiting, which is only
   * honest if it admits the state is unconfirmed while the real read is in flight. Governance state
   * that is quietly out of date is the one failure mode worth spending a line of UI on.
   */
  setFreshness(text: string | null): void {
    if (this.freshness === text) return;
    this.freshness = text;
    this.renders.request();
  }

  /**
   * Whether a first snapshot has yet to arrive — a refresh in flight with nothing behind it.
   *
   * Deliberately narrower than the store's `loading`, which is also true for every later refresh.
   * The caller passes `loading && !snapshot`, because that is the only condition under which an
   * empty section is unknown rather than known-empty.
   */
  setAwaitingFirstRead(value: boolean): void {
    if (this.awaitingFirstRead === value) return;
    this.awaitingFirstRead = value;
    this.renders.request();
  }

  /** Machine-wide workspace selection and a conservative, snapshot-backed next action. */
  setNavigation(navigation: SidebarNavigation): void {
    if (JSON.stringify(this.navigation) === JSON.stringify(navigation)) return;
    this.navigation = navigation;
    this.renders.request();
  }

  setPendingApprovals(count: number | null): void {
    const normalized = count === null ? null : Number.isSafeInteger(count) && count > 0 ? count : 0;
    if (normalized === this.pendingApprovals) return;
    this.pendingApprovals = normalized;
    this.renders.request();
  }

  bind(section: SidebarSection, source: TreeSource): void {
    // Until a section is bound it has no data source at all, which is a different thing from having
    // a source that returned nothing — and the reader deserves to be told which.
    this.bound.add(section);
    this.sources[section] = source;
    this.roots[section] = source.snapshot();
    this.subscriptions.push(source.onDidChangeTreeData(() => {
      this.roots[section] = source.snapshot();
      this.renders.request();
    }));
    this.renders.request();
  }

  /**
   * What is feeding a section, or null when nothing is.
   *
   * The natural inverse of `bind`, and the seam the host tests needed once the five contributed
   * tree views were removed. Those views were gated on a context key set nowhere, so they had never
   * rendered — but eight tests reached their providers through `createTreeView`, which is why the
   * dead surface survived: removing it read as a regression. The providers were always the same
   * objects this sidebar renders; only the route to them was through something nobody could see.
   */
  sourceFor(section: SidebarSection): TreeSource | null {
    return this.sources[section] ?? null;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.renderedBody = null;
    view.webview.options = { enableScripts: true };
    this.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)));
    // First paint is deliberately immediate. Any setup notifications already queued are included
    // in this paint and invalidated, while later provider bursts use the coalesced path above.
    this.renders.flush();
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const value = message as { type?: unknown; action?: unknown; key?: unknown; topic?: unknown; command?: unknown };
    if (value.type === 'navigation-ready') {
      // Tab changes can arrive while the webview is being replaced; replay the current marker.
      void this.view?.webview.postMessage({ type: 'active-destination', id: this.activeDestination });
      return;
    }
    if (value.type === 'help-topic' && typeof value.topic === 'string' && HELP_TOPICS.has(value.topic)) {
      void vscode.commands.executeCommand('singularityFlow.explainTopic', { id: `help:topic:${value.topic}` });
      return;
    }
    if (value.type === 'help-copy' && typeof value.command === 'string' && HELP_COMMANDS.has(value.command)) {
      void vscode.env.clipboard.writeText(value.command)
        .then(() => vscode.window.setStatusBarMessage(`Copied: ${value.command}`, 3000));
      return;
    }
    if (value.type === 'favorite-remove' && typeof value.action === 'string') {
      void this.removeFavorite(value.action);
      return;
    }
    if (value.type === 'action' && typeof value.action === 'string') {
      if (['work-tools', 'help-tools', 'activity-tools', 'understand-changes'].includes(value.action)) {
        void this.openTools(value.action);
        return;
      }
      const favorite = value.action.startsWith('favorite:') ? value.action.slice('favorite:'.length) : null;
      const command = favorite && this.favoriteIds.includes(favorite)
        ? FAVORITE_BY_ID.get(favorite)?.command : ACTION_COMMANDS[value.action];
      if (command) void vscode.commands.executeCommand(command);
      return;
    }
    if (value.type === 'workspace' && typeof value.key === 'string') {
      const node = this.nodeIndex.get(value.key);
      if (!node?.id.startsWith('workspace:')) return;
      if (value.action === 'select' && node.runCommand === 'singularityFlow.switchWorkspace') {
        void vscode.commands.executeCommand('singularityFlow.switchWorkspace', node);
      } else if (value.action === 'open' && node.contextValue?.startsWith('sflow.workspace.active')) {
        // Older selections may already be active in SFlow while another native folder is open.
        // Keep a direct repair route instead of hiding selection behind the active Details row.
        void vscode.commands.executeCommand('singularityFlow.switchWorkspace', node);
      } else if (value.action === 'details') {
        void vscode.commands.executeCommand('singularityFlow.openWorkspaces', node);
      }
      return;
    }
    if (value.type !== 'node' || typeof value.key !== 'string') return;
    const node = this.nodeIndex.get(value.key);
    if (!node) return;
    if (node.runCommand?.startsWith('singularityFlow.')) {
      void vscode.commands.executeCommand(node.runCommand, node);
    } else if (node.path || node.packagePath) {
      void vscode.commands.executeCommand('singularityFlow.openArtifact', node);
    } else if (node.approve) {
      void vscode.commands.executeCommand('singularityFlow.approve', node);
    } else if (node.command) {
      void vscode.commands.executeCommand('singularityFlow.runAction', node);
    }
  }

  /** Called from editor tab events, never optimistically from a navigation click. */
  setActiveDestination(id: string | null): void {
    if (id === this.activeDestination) return;
    this.activeDestination = id;
    // Keep focus and scroll intact when an editor tab changes.
    if (this.view) void this.view.webview.postMessage({ type: 'active-destination', id });
  }

  private async openTools(group: string): Promise<void> {
    const groups: Record<string, { title: string; ids: string[] }> = {
      'work-tools': { title: 'Work tools', ids: ['current-work-actions', 'story-intake', 'work-start', 'adhoc-work', 'goals', 'impact-form', 'understand-changes', 'epic-stories', 'command-center', 'flow-impact'] },
      'understand-changes': { title: 'Understand changes', ids: ['change-explorer', 'code-explainer', 'repository-knowledge', 'code-explanation', 'comprehension-center'] },
      'help-tools': { title: 'Help & diagnostics', ids: ['help-open', 'diagnostics', 'fault-repairs', 'local-reset'] },
      'activity-tools': { title: 'Activity & logs', ids: ['logs-open', 'activity-log', 'prompt-audit', 'journal'] }
    };
    const selected = groups[group];
    if (!selected) return;
    const menus = selected.ids.flatMap(id => {
      if (id === 'current-work-actions') return [{ label: 'Current work actions & artifacts', description: 'Progress, evidence, phase actions and lifecycle maintenance', id }];
      if (id === 'understand-changes') return [{ label: 'Understand changes', description: 'Explorer, explanations and comprehension', id }];
      if (id === 'epic-stories') return [{ label: 'Epic Story plan', description: 'Decomposition, dependencies and materialization', id }];
      const menu = FAVORITE_BY_ID.get(id);
      return menu ? [{ label: menu.label, description: menu.description, id }] : [];
    });
    const chosen = await vscode.window.showQuickPick(menus, { title: selected.title, matchOnDescription: true });
    if (!chosen || !selected.ids.includes(chosen.id)) return;
    if (chosen.id === 'current-work-actions') {
      const source = this.roots.lifecycle;
      const actions: Array<{ label: string; description: string; node: TreeNode }> = [];
      const visit = (nodes: readonly TreeNode[], parent = '') => {
        for (const node of nodes) {
          if (node.runCommand || node.command || node.path || node.packagePath || node.approve) {
            actions.push({ label: node.label, description: parent, node });
          }
          if (node.children) visit(node.children, node.label);
        }
      };
      visit(source);
      const action = await vscode.window.showQuickPick(actions, { title: 'Current work actions & artifacts', matchOnDescription: true });
      if (action && actions.includes(action) && source === this.roots.lifecycle) {
        this.nodeIndex.set('current-work-action', action.node);
        this.receive({ type: 'node', key: 'current-work-action' });
      }
      return;
    }
    if (chosen.id === 'understand-changes') return this.openTools(chosen.id);
    if (chosen.id === 'epic-stories') { await vscode.commands.executeCommand('singularityFlow.openStories'); return; }
    const menu = FAVORITE_BY_ID.get(chosen.id);
    if (menu) await vscode.commands.executeCommand(menu.command);
  }

  private render(): void {
    if (!this.view) return;
    this.nodeIndex.clear();
    this.roots.favorites.forEach((node, index) => this.nodeIndex.set(`favorites:${index}`, node));
    const body = sidebarBody({
        navigation: this.navigation, freshness: this.freshness, loading: this.awaitingFirstRead,
        active: this.activeDestination, pending: this.pendingApprovals,
        favorites: this.favoriteIds.flatMap(id => {
          const menu = FAVORITE_BY_ID.get(id);
          return menu ? [{ id, label: menu.label, icon: menu.icon }] : [];
        })
      });
    if (body === this.renderedBody) return;
    this.renderedBody = body;
    const token = nonce();
    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(this.view.webview, token)}">
      <style nonce="${token}">${SIDEBAR_STYLE}</style></head><body>${body}
      <script nonce="${token}">${SIDEBAR_SCRIPT}</script></body></html>`;
    this.onRender();
  }

  dispose(): void {
    this.renders.dispose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = null;
  }
}
