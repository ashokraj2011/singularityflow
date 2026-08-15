/**
 * The single Singularity Flow navigation surface.
 *
 * Native TreeViews are excellent for one hierarchy, but five independent TreeViews make VS Code
 * allocate five headers, five scroll regions and large empty panes. This view keeps the same tested
 * TreeNode read models and commands while presenting them as one compact, branded accordion.
 */
import * as vscode from 'vscode';
import type { TreeNode } from './tree-model.ts';
import { brandSymbol, contentSecurityPolicy, escape, icon, ICON_NAMES, nonce, type IconName } from './webview.ts';

export type SidebarSection = 'workspaces' | 'lifecycle' | 'inbox' | 'logs' | 'configuration' | 'help';

interface TreeSource {
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined>;
  snapshot(): readonly TreeNode[];
}

/**
 * `empty` is the sentence a section shows when it has nothing, plus the one action that resolves it.
 *
 * All five sections rendered the same four words — "Nothing to show yet." — with nothing to click.
 * The tree models state the principle exactly right and follow it: an empty view in a governance
 * tool reads as "nothing to do", which is the most expensive thing it could wrongly say. This is
 * that principle applied to the surface that contradicted it.
 */
const SECTION_META: Record<SidebarSection, {
  label: string;
  icon: IconName;
  actions: Array<{ id: string; label: string; icon: IconName }>;
  empty: { text: string; action: string; actionLabel: string };
}> = {
  inbox: {
    label: 'Inbox', icon: 'inbox', actions: [
      { id: 'inbox-open', label: 'Open inbox', icon: 'inbox' },
      { id: 'visual-assurance', label: 'Review visual evidence', icon: 'compare' },
      // Every section reads from the one shared snapshot, so a failed refresh empties them together.
      // Inbox was the only one of the two affected sections with no way to ask for another go.
      { id: 'refresh', label: 'Refresh inbox', icon: 'refresh' }
    ],
    empty: {
      text: 'Nothing is waiting on you. Submitted phases appear here for approval.',
      action: 'inbox-open', actionLabel: 'Open the inbox'
    }
  },
  workspaces: {
    label: 'Workspaces', icon: 'workspace', actions: [
      { id: 'workspace-create', label: 'Create workspace', icon: 'workspaceAdd' },
      { id: 'workspace-manage', label: 'Manage workspaces', icon: 'workspaceManage' }
    ],
    empty: {
      text: 'No workspace is selected. A workspace points at the governed repository whose lifecycle you want to see.',
      action: 'workspace-manage', actionLabel: 'Choose a workspace'
    }
  },
  lifecycle: {
    label: 'Lifecycle', icon: 'workflow', actions: [
      { id: 'work-start', label: 'Start intake', icon: 'start' },
      { id: 'visual-assurance', label: 'Open visual assurance', icon: 'visual' },
      { id: 'refresh', label: 'Refresh lifecycle', icon: 'refresh' }
    ],
    empty: {
      text: 'No work item is in flight in this workspace.',
      action: 'work-start', actionLabel: 'Start intake'
    }
  },
  /**
   * One way in. The four title-bar shortcuts that used to live here — map capability, design
   * workflow, design agents, prompt audit — are all in the Configuration Center, which is what this
   * section now opens. Duplicating them meant the sidebar had to be updated every time the Center
   * grew a tab, and it stopped being.
   */
  configuration: {
    label: 'Configuration', icon: 'configuration', actions: [
      { id: 'configuration-center', label: 'Open Configuration Center', icon: 'configuration' }
    ],
    empty: {
      text: 'No governed configuration is loaded. It lives on the capability’s configuration branch, not on main.',
      action: 'configuration-center', actionLabel: 'Open Configuration Center'
    }
  },
  help: {
    label: 'Help', icon: 'help', actions: [
      { id: 'help-open', label: 'Open Help Center', icon: 'search' },
      // "What did it actually do, and what was sent to the model" is a Help question, not a
      // Configuration one. The prompt audit was reachable only from Configuration, where nobody
      // asking that question would look, and the activity log was not reachable at all.
      { id: 'activity-log', label: 'Open the activity log', icon: 'commit' },
      { id: 'prompt-audit', label: 'Open the prompt audit', icon: 'prompt' }
    ],
    empty: {
      text: 'Guides, the command reference, the activity log, and what was sent to the model.',
      action: 'help-open', actionLabel: 'Open the Help Center'
    }
  },
  logs: {
    label: 'Logs', icon: 'commit', actions: [
      { id: 'logs-open', label: 'Open workspace logs', icon: 'commit' },
      { id: 'logs-refresh', label: 'Refresh workspace logs', icon: 'refresh' }
    ],
    empty: {
      text: 'Open the combined workspace timeline for activity, prompts, Copilot usage, and workspace operations.',
      action: 'logs-open', actionLabel: 'Open workspace logs'
    }
  },
};

const ACTION_COMMANDS: Record<string, string> = {
  'workspace-create': 'singularityFlow.createWorkspace',
  'workspace-manage': 'singularityFlow.openWorkspaces',
  'work-start': 'singularityFlow.startWork',
  refresh: 'singularityFlow.refresh',
  'inbox-open': 'singularityFlow.openInbox',
  'capability-map': 'singularityFlow.mapCapability',
  'workflow-design': 'singularityFlow.openDesigner',
  'instruction-design': 'singularityFlow.openInstructionDesigner',
  'prompt-audit': 'singularityFlow.openPromptAudit',
  'visual-assurance': 'singularityFlow.openVisualAssurance',
  'help-open': 'singularityFlow.openHelp',
  'activity-log': 'singularityFlow.openActivityLog',
  'logs-open': 'singularityFlow.openWorkspaceLogs',
  'logs-refresh': 'singularityFlow.refreshWorkspaceLogs',
  'configuration-center': 'singularityFlow.openConfigurationCenter'
};

/** Render order is the key order of SECTION_META above: inbox, workspaces, lifecycle, configuration, help, logs. */
const SECTION_ORDER = Object.freeze(Object.keys(SECTION_META) as SidebarSection[]);
const KNOWN_ICONS = new Set<string>(ICON_NAMES);

function semanticIcon(node: TreeNode): IconName {
  if (node.icon && KNOWN_ICONS.has(node.icon)) return node.icon as IconName;
  if (/success|passed|approved/i.test(node.icon ?? node.description ?? '')) return 'success';
  if (/warning|stale/i.test(node.icon ?? node.description ?? '')) return 'warning';
  if (/blocked|error|rejected|failed/i.test(node.icon ?? node.description ?? '')) return 'blocked';
  if (/waiting|clock|queued|awaiting/i.test(node.icon ?? node.description ?? '')) return 'waiting';
  const byKind: Partial<Record<TreeNode['kind'], IconName>> = {
    initiative: 'initiative', phase: 'phase', pack: 'pack', artifact: 'artifact',
    repository: 'repository', story: 'story', source: 'document', action: 'next', group: 'collection'
  };
  return byKind[node.kind] ?? 'document';
}

function hasAction(node: TreeNode): boolean {
  return Boolean(node.runCommand || node.path || node.packagePath || node.command || node.approve);
}

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly roots: Record<SidebarSection, readonly TreeNode[]> = {
    workspaces: [], lifecycle: [], inbox: [], logs: [], configuration: [], help: []
  };
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly nodeIndex = new Map<string, TreeNode>();
  private readonly bound = new Set<SidebarSection>();
  private view: vscode.WebviewView | null = null;
  private freshness: string | null = null;
  private awaitingFirstRead = false;

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
    this.render();
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
    this.render();
  }

  bind(section: SidebarSection, source: TreeSource): void {
    // Until a section is bound it has no data source at all, which is a different thing from having
    // a source that returned nothing — and the reader deserves to be told which.
    this.bound.add(section);
    this.roots[section] = source.snapshot();
    this.subscriptions.push(source.onDidChangeTreeData(() => {
      this.roots[section] = source.snapshot();
      this.render();
    }));
    this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.subscriptions.push(view.webview.onDidReceiveMessage((message: unknown) => this.receive(message)));
    this.render();
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const value = message as { type?: unknown; action?: unknown; key?: unknown };
    if (value.type === 'action' && typeof value.action === 'string') {
      const command = ACTION_COMMANDS[value.action];
      if (command) void vscode.commands.executeCommand(command);
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

  private renderNode(section: SidebarSection, node: TreeNode, path: number[], depth = 0): string {
    const key = `${section}:${path.join('.')}`;
    this.nodeIndex.set(key, node);
    const description = node.description
      ? `<span class="node-description">${escape(node.description)}</span>` : '';
    const tooltip = escape(node.tooltip ?? [node.label, node.description].filter(Boolean).join(' — '));
    const actionable = hasAction(node);
    const hasChildren = Boolean(node.children?.length);
    const directAction = actionable && !hasChildren;
    const currentPhase = node.contextValue === 'sflow.story.phase.current';
    const row = `<span class="node-row${actionable ? ' actionable' : ''}${currentPhase ? ' current-phase-row' : ''}"${directAction
      ? ` role="button" tabindex="0" data-node="${escape(key)}"` : ''} title="${tooltip}">
        <span class="node-icon">${icon(semanticIcon(node), { size: 16 })}</span>
        <span class="node-copy"><span class="node-label">${escape(node.label)}</span>${description}</span>
        ${actionable ? (hasChildren
          ? `<button class="node-open" type="button" data-open-node="${escape(key)}" aria-label="Open ${escape(node.label)}" title="Open ${escape(node.label)}">${icon('next', { size: 14 })}</button>`
          : `<span class="node-open" aria-hidden="true">${icon('next', { size: 14 })}</span>`) : ''}
      </span>`;
    if (!hasChildren) return `<div class="leaf depth-${Math.min(depth, 3)}">${row}</div>`;
    const children = node.children!.map((child, index) =>
      this.renderNode(section, child, [...path, index], depth + 1)).join('');
    const open = depth === 0 || node.kind === 'initiative' || node.id === 'configuration'
      || node.id === 'story:phase-rail' || currentPhase
      || node.id.startsWith('completed-story:') || node.id.startsWith('completed-initiative:')
      ? ' open' : '';
    return `<details class="node depth-${Math.min(depth, 3)}${currentPhase ? ' current-phase' : ''}" data-node-state="${escape(key)}"${open}>
      <summary>${row}</summary><div class="children">${children}</div></details>`;
  }

  private renderSection(section: SidebarSection): string {
    const meta = SECTION_META[section];
    const actions = meta.actions.map((action) => `<button class="icon-button" type="button"
      data-action="${escape(action.id)}" aria-label="${escape(action.label)}" title="${escape(action.label)}">
      ${icon(action.icon, { size: 16 })}</button>`).join('');
    const nodes = this.roots[section];
    /**
     * Three ways to have nothing, and only one of them means nothing.
     *
     * A section is bound the moment its tree source exists, which is before the first snapshot has
     * landed — so "bound and empty" was being rendered as "Nothing is waiting on you" for the whole
     * of every cold open. That is the exact failure this file's own header calls the most expensive
     * thing the surface could wrongly say, and it said it on the one screen a person sees first.
     *
     * Only the first read gets this treatment. A later refresh over a section already known to be
     * empty leaves the real sentence on screen: the answer is not in doubt, it is being rechecked,
     * and replacing it every time would be a flicker that tells the reader nothing.
     */
    const content = nodes.length
      ? nodes.map((node, index) => this.renderNode(section, node, [index])).join('')
      : this.awaitingFirstRead
        ? `<div class="empty"><p>Reading the repository…</p></div>`
        : this.bound.has(section)
          ? `<div class="empty"><p>${escape(meta.empty.text)}</p>
            <button class="empty-action" type="button" data-action="${escape(meta.empty.action)}">${escape(meta.empty.actionLabel)}</button>
          </div>`
          // Bound but not yet reported, versus never connected: saying "nothing here" while the CLI is
          // still being spawned is a lie the reader has no way to detect.
          : `<div class="empty"><p>Connecting to the Singularity Flow CLI…</p></div>`;
    return `<details class="section" data-section="${section}" open>
      <summary class="section-heading">
        <span class="section-title">${icon(meta.icon, { size: 16 })}<span>${escape(meta.label)}</span></span>
        <span class="section-actions">${actions}</span>
      </summary>
      <div class="section-body">${content}</div>
    </details>`;
  }

  private render(): void {
    if (!this.view) return;
    this.nodeIndex.clear();
    const token = nonce();
    const sections = SECTION_ORDER.map((section) => this.renderSection(section)).join('');
    // The status dot was hard-coded green, so it said "ready" while the CLI was still being found —
    // and said it just as confidently when resolution had failed.
    const ready = SECTION_ORDER.every((section) => this.bound.has(section));
    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(this.view.webview, token)}">
      <style nonce="${token}">
        /* The same accent the full-page views use. The sidebar had its own #2f9e44, which matched
           neither the light nor the dark value in webview.ts, and had no dark or forced-colors
           handling at all — so one product had three greens depending on where you looked. */
        :root { color-scheme: light dark; --accent:#2e7d32; --quiet:color-mix(in srgb,var(--accent) 13%,transparent); }
        @media (prefers-color-scheme: dark) { :root { --accent:#3d9a42; } }
        @media (forced-colors: active) {
          :root { --accent:LinkText; --quiet:transparent; }
          .empty-action,button.node-open { border:1px solid ButtonText; }
        }
        * { box-sizing:border-box; }
        body { margin:0; padding:0 0 18px; color:var(--vscode-sideBar-foreground); background:var(--vscode-sideBar-background);
          font:var(--vscode-font-size)/1.35 var(--vscode-font-family); }
        button { font:inherit; }
        .brand { display:flex; align-items:center; gap:9px; padding:13px 12px 11px; border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border)); }
        /* The mark sits on the sidebar itself, as it does in the brand lockup. It used to be a
           generic workflow glyph reversed out of a green tile, which was a placeholder standing in
           for a logo that did not exist yet. */
        .brand-symbol { flex:none; display:block; }
        .brand-copy { min-width:0; line-height:1.05; }
        .brand-copy small { display:block; color:var(--accent); font-size:9px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; }
        .brand-copy strong { display:block; margin-top:3px; font-size:15px; font-weight:650; letter-spacing:.01em; }
        .brand-status { margin-left:auto; width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px var(--quiet); }
        .brand-status.connecting { background:var(--vscode-descriptionForeground); box-shadow:0 0 0 3px transparent; }
        main { overflow-y:auto; }
        details { margin:0; }
        summary { list-style:none; }
        summary::-webkit-details-marker { display:none; }
        .section { border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border)); }
        .section-heading { display:flex; align-items:center; min-height:37px; padding:0 6px 0 9px; cursor:pointer;
          background:var(--vscode-sideBarSectionHeader-background,var(--vscode-sideBar-background)); }
        .section-heading:before { content:''; width:6px; height:6px; margin:0 9px 0 2px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); transition:transform .14s ease; opacity:.72; }
        .section[open]>.section-heading:before { transform:rotate(45deg) translate(-1px,-1px); }
        .section-title { display:flex; align-items:center; gap:8px; min-width:0; color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-sideBar-foreground)); font-size:12px; font-weight:500; letter-spacing:.005em; }
        .section-title .ico { color:var(--accent); }
        .section-actions { display:flex; gap:1px; margin-left:auto; }
        .icon-button { display:grid; place-items:center; width:30px; height:30px; padding:0; border:0; border-radius:6px;
          color:var(--vscode-icon-foreground); background:transparent; cursor:pointer; }
        .icon-button:hover { color:var(--accent); background:var(--vscode-toolbar-hoverBackground); }
        .icon-button:focus-visible,.actionable:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
        .section-body { padding:4px 6px 7px; }
        .node { display:block; }
        .node>summary { cursor:pointer; }
        .node>summary:before { content:''; float:left; width:5px; height:5px; margin:12px 3px 0 5px; border-right:1px solid currentColor; border-bottom:1px solid currentColor; transform:rotate(-45deg); opacity:.6; }
        .node[open]>summary:before { transform:rotate(45deg); }
        .node-row { display:flex; align-items:flex-start; min-height:31px; gap:7px; padding:6px 5px; border-radius:5px; min-width:0; }
        .node>summary .node-row { margin-left:13px; }
        .leaf .node-row { margin-left:18px; }
        .depth-1 .node-row { padding-left:8px; } .depth-2 .node-row { padding-left:16px; } .depth-3 .node-row { padding-left:24px; }
        .node-row.actionable { cursor:pointer; }
        .node-row.actionable:hover { background:var(--vscode-list-hoverBackground); color:var(--vscode-list-hoverForeground); }
        .node-icon { display:grid; place-items:center; flex:0 0 17px; height:18px; color:var(--vscode-icon-foreground); }
        .current-phase-row { border-left:2px solid var(--accent); background:var(--quiet); }
        .current-phase-row .node-icon { color:var(--accent); animation:sf-current-phase-pulse 1.65s ease-in-out infinite; }
        .current-phase-row .node-label { color:var(--accent); }
        @keyframes sf-current-phase-pulse {
          0%,100% { opacity:.72; filter:drop-shadow(0 0 0 transparent); }
          50% { opacity:1; filter:drop-shadow(0 0 4px var(--accent)); }
        }
        .node-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
        .node-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
        .node-description { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--vscode-descriptionForeground); font-size:11px; }
        .node-open { display:grid; place-items:center; width:25px; height:25px; padding:0; border:0; border-radius:4px; opacity:0; color:var(--accent); background:transparent; }
        button.node-open:hover { opacity:1; background:var(--vscode-toolbar-hoverBackground); }
        .actionable:hover .node-open,.actionable:focus-visible .node-open { opacity:1; }
        /* A focused control at zero opacity is an invisible focus target: keyboard users tabbed onto
           a button they could not see. The row's own :focus-visible covered the row, not the button
           inside it, so the button had to claim its own. */
        button.node-open:focus-visible { opacity:1; outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
        .children { margin-left:1px; border-left:1px solid var(--vscode-tree-indentGuidesStroke,transparent); }
        .empty { padding:9px 12px 12px 28px; color:var(--vscode-descriptionForeground); font-size:11px; }
        .empty p { margin:0 0 8px; max-width:34em; line-height:1.45; }
        .empty-action { padding:4px 10px; border:0; border-radius:3px; cursor:pointer;
          color:var(--vscode-button-foreground); background:var(--vscode-button-background); font-size:11px; }
        .empty-action:hover { background:var(--vscode-button-hoverBackground); }
        .empty-action:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; }
        /* Quiet on purpose. It qualifies what is already on screen; it is not an alert, and a
           sidebar that shouts every time it refreshes is worse than one that is briefly stale. */
        .freshness { display:flex; align-items:center; gap:6px; padding:4px 10px; font-size:11px;
          color:var(--vscode-descriptionForeground); background:var(--quiet); }
        .freshness .ico { flex:none; opacity:.8; }
        @media (prefers-reduced-motion:reduce) { * { transition:none!important; animation:none!important; } }
      </style></head><body>
      <header class="brand">${brandSymbol(30)}
        <span class="brand-copy"><small>Singularity</small><strong>Flow</strong></span>
        <span class="brand-status${ready ? '' : ' connecting'}" role="img"
          aria-label="${ready ? 'Connected' : 'Connecting'}"
          title="${ready ? 'Connected to the Singularity Flow CLI' : 'Connecting to the Singularity Flow CLI…'}"></span></header>
      ${this.freshness ? `<div class="freshness" role="status">${icon('wait', { size: 14 })}<span>${escape(this.freshness)}</span></div>` : ''}
      <main>${sections}</main>
      <script nonce="${token}">
        const vscode=acquireVsCodeApi(); const prior=vscode.getState()||{};
        for(const section of document.querySelectorAll('[data-section]')){
          if(Object.prototype.hasOwnProperty.call(prior,section.dataset.section)) section.open=Boolean(prior[section.dataset.section]);
          section.addEventListener('toggle',()=>{const state=vscode.getState()||{};state[section.dataset.section]=section.open;vscode.setState(state);});
        }
        // Nodes inside a section, on the same terms. Every node already carried data-node-state and
        // nothing read it, so expanding Capabilities lasted until the next redraw — and the sidebar
        // redraws on every change under singularity/, which is often. Only nodes the reader has
        // actually toggled are stored, so this cannot grow without them doing something.
        const nodeKeys=new Set();
        for(const node of document.querySelectorAll('[data-node-state]')){
          const key='node:'+node.dataset.nodeState;
          nodeKeys.add(key);
          if(Object.prototype.hasOwnProperty.call(prior,key)) node.open=Boolean(prior[key]);
          node.addEventListener('toggle',(event)=>{
            // details/toggle does not bubble in every engine, but a nested one that did would
            // otherwise record its ancestor's key against its own state.
            if(event.target!==node) return;
            const state=vscode.getState()||{};
            state[key]=node.open;
            // Drop keys for nodes that no longer exist, so a long session does not accumulate the
            // state of every Story ever expanded.
            for(const stale of Object.keys(state)) if(stale.startsWith('node:')&&!nodeKeys.has(stale)) delete state[stale];
            vscode.setState(state);
          });
        }
        // The whole document is replaced on every refresh, and a refresh happens several times per
        // change under singularity/. Without this, reading the tree while anything was publishing
        // threw the reader back to the top repeatedly.
        const main=document.querySelector('main');
        if(main){
          if(typeof prior.__scroll==='number') main.scrollTop=prior.__scroll;
          let pending=null;
          main.addEventListener('scroll',()=>{
            if(pending) return;
            pending=setTimeout(()=>{pending=null;const state=vscode.getState()||{};state.__scroll=main.scrollTop;vscode.setState(state);},120);
          });
        }
        document.addEventListener('click',(event)=>{
          const action=event.target.closest('[data-action]'); if(action){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'action',action:action.dataset.action});return;}
          const openNode=event.target.closest('[data-open-node]'); if(openNode){event.preventDefault();event.stopPropagation();vscode.postMessage({type:'node',key:openNode.dataset.openNode});return;}
          const node=event.target.closest('[data-node]'); if(node&&!event.target.closest('summary')) vscode.postMessage({type:'node',key:node.dataset.node});
          else if(node&&node.closest('.leaf')) vscode.postMessage({type:'node',key:node.dataset.node});
        });
        document.addEventListener('keydown',(event)=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('[data-node]')){event.preventDefault();vscode.postMessage({type:'node',key:event.target.dataset.node});}});
      </script></body></html>`;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.view = null;
  }
}
