/**
 * The single Singularity Flow navigation surface.
 *
 * Native TreeViews are excellent for one hierarchy, but five independent TreeViews make VS Code
 * allocate five headers, five scroll regions and large empty panes. This view keeps the same tested
 * TreeNode read models and commands while presenting them as one compact, branded accordion.
 */
import * as vscode from 'vscode';
import type { TreeNode } from './tree-model.ts';
import { contentSecurityPolicy, escape, icon, ICON_NAMES, nonce, type IconName } from './webview.ts';

export type SidebarSection = 'workspaces' | 'lifecycle' | 'inbox' | 'configuration' | 'help';

interface TreeSource {
  readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined>;
  snapshot(): readonly TreeNode[];
}

const SECTION_META: Record<SidebarSection, {
  label: string; icon: IconName; actions: Array<{ id: string; label: string; icon: IconName }>;
}> = {
  workspaces: {
    label: 'Workspaces', icon: 'workspace', actions: [
      { id: 'workspace-create', label: 'Create workspace', icon: 'workspaceAdd' },
      { id: 'workspace-manage', label: 'Manage workspaces', icon: 'workspaceManage' }
    ]
  },
  lifecycle: {
    label: 'Lifecycle', icon: 'workflow', actions: [
      { id: 'work-start', label: 'Start intake', icon: 'start' },
      { id: 'refresh', label: 'Refresh lifecycle', icon: 'refresh' }
    ]
  },
  inbox: {
    label: 'Inbox', icon: 'inbox', actions: [
      { id: 'inbox-open', label: 'Open inbox', icon: 'inbox' }
    ]
  },
  configuration: {
    label: 'Configuration', icon: 'configuration', actions: [
      { id: 'capability-map', label: 'Map capability', icon: 'capability' },
      { id: 'workflow-design', label: 'Design workflow', icon: 'workflow' },
      { id: 'instruction-design', label: 'Design agents and prompts', icon: 'agent' },
      { id: 'prompt-audit', label: 'Open prompt audit', icon: 'prompt' }
    ]
  },
  help: {
    label: 'Help', icon: 'help', actions: [
      { id: 'help-open', label: 'Open Help Center', icon: 'search' }
    ]
  }
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
  'help-open': 'singularityFlow.openHelp'
};

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
    workspaces: [], lifecycle: [], inbox: [], configuration: [], help: []
  };
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly nodeIndex = new Map<string, TreeNode>();
  private view: vscode.WebviewView | null = null;

  bind(section: SidebarSection, source: TreeSource): void {
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
    const row = `<span class="node-row${actionable ? ' actionable' : ''}"${directAction
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
      || node.id.startsWith('completed-story:') || node.id.startsWith('completed-initiative:')
      ? ' open' : '';
    return `<details class="node depth-${Math.min(depth, 3)}" data-node-state="${escape(key)}"${open}>
      <summary>${row}</summary><div class="children">${children}</div></details>`;
  }

  private renderSection(section: SidebarSection): string {
    const meta = SECTION_META[section];
    const actions = meta.actions.map((action) => `<button class="icon-button" type="button"
      data-action="${escape(action.id)}" aria-label="${escape(action.label)}" title="${escape(action.label)}">
      ${icon(action.icon, { size: 16 })}</button>`).join('');
    const nodes = this.roots[section];
    const content = nodes.length
      ? nodes.map((node, index) => this.renderNode(section, node, [index])).join('')
      : `<div class="empty">Nothing to show yet.</div>`;
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
    this.view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(this.view.webview, token)}">
      <style nonce="${token}">
        :root { color-scheme: light dark; --accent:#2f9e44; --quiet:color-mix(in srgb,var(--accent) 13%,transparent); }
        * { box-sizing:border-box; }
        body { margin:0; padding:0 0 18px; color:var(--vscode-sideBar-foreground); background:var(--vscode-sideBar-background);
          font:var(--vscode-font-size)/1.35 var(--vscode-font-family); }
        button { font:inherit; }
        .brand { display:flex; align-items:center; gap:9px; padding:13px 12px 11px; border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border)); }
        .brand-mark { display:grid; place-items:center; width:27px; height:27px; border-radius:7px; color:white; background:linear-gradient(145deg,#1b7f45,#35a853); box-shadow:inset 0 0 0 1px rgba(255,255,255,.18); }
        .brand-copy { min-width:0; line-height:1.05; }
        .brand-copy small { display:block; color:var(--accent); font-size:9px; font-weight:700; letter-spacing:.16em; text-transform:uppercase; }
        .brand-copy strong { display:block; margin-top:3px; font-size:15px; font-weight:650; letter-spacing:.01em; }
        .brand-status { margin-left:auto; width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px var(--quiet); }
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
        .node-copy { display:flex; flex-direction:column; min-width:0; flex:1; }
        .node-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
        .node-description { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--vscode-descriptionForeground); font-size:11px; }
        .node-open { display:grid; place-items:center; width:25px; height:25px; padding:0; border:0; border-radius:4px; opacity:0; color:var(--accent); background:transparent; }
        button.node-open:hover { opacity:1; background:var(--vscode-toolbar-hoverBackground); }
        .actionable:hover .node-open,.actionable:focus-visible .node-open { opacity:1; }
        .children { margin-left:1px; border-left:1px solid var(--vscode-tree-indentGuidesStroke,transparent); }
        .empty { padding:9px 12px 10px 28px; color:var(--vscode-descriptionForeground); font-size:11px; }
        @media (prefers-reduced-motion:reduce) { * { transition:none!important; } }
      </style></head><body>
      <header class="brand"><span class="brand-mark">${icon('workflow', { size: 20 })}</span>
        <span class="brand-copy"><small>Singularity</small><strong>Flow</strong></span><span class="brand-status" title="Extension ready"></span></header>
      <main>${sections}</main>
      <script nonce="${token}">
        const vscode=acquireVsCodeApi(); const prior=vscode.getState()||{};
        for(const section of document.querySelectorAll('[data-section]')){
          if(Object.prototype.hasOwnProperty.call(prior,section.dataset.section)) section.open=Boolean(prior[section.dataset.section]);
          section.addEventListener('toggle',()=>{const state=vscode.getState()||{};state[section.dataset.section]=section.open;vscode.setState(state);});
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
