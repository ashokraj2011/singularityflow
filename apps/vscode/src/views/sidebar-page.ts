/** Presentation only. Opening, hovering and filtering navigation never read a repository. */
import { brandSymbol, escape, icon, type IconName } from './webview.ts';
import type { SidebarNavigation } from './sidebar-navigation-model.ts';

export const PRIMARY_NAVIGATION = [
  { id: 'my-work', label: 'My Work', icon: 'home', command: 'singularityFlow.myWork' },
  { id: 'stories', label: 'Stories', icon: 'story', command: 'singularityFlow.openWorkspaceStories' },
  { id: 'story-analytics', label: 'Story Analytics', icon: 'impact', command: 'singularityFlow.openDashboard' },
  { id: 'reviews', label: 'Reviews', icon: 'approval', command: 'singularityFlow.openReviews' },
  { id: 'configuration-approvals', label: 'Configuration approvals', icon: 'merge', command: 'singularityFlow.openConfigurationApprovals' },
  { id: 'workspace-manage', label: 'Workspaces', icon: 'workspace', command: 'singularityFlow.openWorkspaces' },
  { id: 'configuration-center', label: 'Configuration', icon: 'configuration', command: 'singularityFlow.openConfigurationCenter' }
] as const;
export type PrimaryNavigationId = typeof PRIMARY_NAVIGATION[number]['id'];

export interface SidebarPage {
  navigation: SidebarNavigation;
  freshness: string | null;
  loading: boolean;
  pending: number | null;
  active: string | null;
  favorites: ReadonlyArray<{ id: string; label: string; icon: IconName }>;
}

function link(id: string, label: string, glyph: IconName, active: string | null, badge = ''): string {
  return `<button type="button" class="nav-row" data-action="${escape(id)}"${active === id ? ' aria-current="page"' : ''}>
    ${icon(glyph, { size: 16 })}<span class="nav-label">${escape(label)}</span>${badge}</button>`;
}

export function sidebarBody(view: SidebarPage): string {
  const workspace = view.navigation.workspace;
  const subject = view.navigation.subject;
  return `<header class="brand">${brandSymbol(25)}<span>Singularity Flow</span>
    <button type="button" class="profile-button" data-action="persona-manage" aria-label="Profile and shortcut suggestions">${icon('agent', { size: 16 })}</button></header>
    <section class="context" aria-label="Current context">
      <span class="context-label">Workspace</span>
      <button type="button" class="workspace-switch" data-action="workspace-switch">
        <span>${escape(workspace?.name ?? 'Choose a workspace')}</span><span aria-hidden="true">▾</span></button>
      ${workspace?.repository ? `<p class="context-detail">Repository: <span>${escape(workspace.repository)}</span></p>` : ''}
      ${subject ? `<p class="context-detail">${escape(subject.kind)}: <span>${escape(subject.id)}</span></p><p class="context-detail">${escape(subject.phase ?? 'Phase not reported')}</p>` : workspace ? '<p class="context-detail">No confirmed active work</p>' : '<p class="context-detail">Select or create a workspace to begin.</p>'}
      ${view.freshness || view.loading ? `<p class="freshness" role="status">${escape(view.freshness ?? 'Reading workspace state…')}</p>` : ''}
    </section>
    <main>
      <nav aria-label="Singularity Flow">
      ${PRIMARY_NAVIGATION.map((item) => link(item.id, item.label, item.icon, view.active,
        item.id === 'reviews' && view.pending != null && view.pending > 0
          ? `<span class="badge" aria-label="${view.pending} pending phase approvals">${view.pending}</span>` : '')).join('')}
      </nav>
      ${!workspace ? `<div class="setup-hint"><button type="button" class="text-action" data-action="setup-wizard">Set up a workspace</button></div>` : ''}
      <details class="pins" data-state-key="pinned-shortcuts">
        <summary>Pinned shortcuts <span class="pin-count">${view.favorites.length}</span></summary>
        <div class="pin-list">${view.favorites.map((item) => `<div class="pin-row">${link(`favorite:${item.id}`, item.label, item.icon, null)}
          <button type="button" class="unpin" data-remove-favorite="${escape(item.id)}" aria-label="Unpin ${escape(item.label)}">${icon('close', { size: 14 })}</button></div>`).join('')}
          <button type="button" class="text-action" data-action="favorites-manage">Choose shortcuts</button></div>
      </details>
    </main>
    <footer aria-label="Utilities">
      ${link('work-tools', 'Work tools', 'workflow', null)}
      ${link('help-tools', 'Help & diagnostics', 'help', view.active)}
      ${link('activity-tools', 'Activity & logs', 'commit', view.active)}
    </footer>`;
}

export const SIDEBAR_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; overflow:hidden;
    color:var(--vscode-sideBar-foreground,var(--vscode-foreground)); background:var(--vscode-sideBar-background);
    font-family:var(--vscode-font-family,system-ui,sans-serif); font-size:var(--vscode-font-size,13px); }
  button { font:inherit; color:inherit; cursor:pointer; }
  button:disabled { cursor:default; opacity:.6; }
  button:focus-visible,summary:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:-2px; }
  .brand { display:flex; align-items:center; gap:8px; padding:12px; font-weight:600; flex:none; }
  .profile-button,.unpin { display:grid; place-items:center; border:0; background:transparent; border-radius:4px; width:28px; height:28px; flex:none; }
  .profile-button { margin-left:auto; }
  .context { padding:4px 14px 14px; border-bottom:1px solid var(--vscode-panel-border); flex:none; }
  .context-label { display:block; font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:5px; }
  .workspace-switch { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; min-height:34px; padding:6px 8px;
    border:1px solid var(--vscode-dropdown-border,var(--vscode-panel-border)); border-radius:4px; background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground); text-align:left; }
  .workspace-switch>span:first-child { overflow-wrap:anywhere; min-width:0; }
  .context-detail { margin:7px 0 0; font-size:11px; color:var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
  .context-detail span { color:var(--vscode-foreground); }
  .freshness { font-size:11px; margin:8px 0 0; color:var(--vscode-descriptionForeground); }
  main { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:10px 10px 6px; }
  nav { display:flex; flex-direction:column; gap:3px; }
  .nav-row { display:flex; align-items:center; gap:10px; width:100%; min-height:36px; padding:8px; border:0; border-radius:5px; background:transparent; text-align:left; transform-origin:center;
    transition:transform 140ms ease-out,background-color 140ms ease-out; }
  .nav-row .ico { flex:none; }
  .nav-label { flex:1; min-width:0; overflow-wrap:anywhere; }
  .nav-row[aria-current="page"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); box-shadow:inset 2px 0 var(--vscode-focusBorder); }
  .badge,.pin-count { font-size:11px; border-radius:12px; padding:1px 6px; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); }
  .pins { margin-top:16px; padding-top:10px; border-top:1px solid var(--vscode-panel-border); }
  .pins summary { cursor:pointer; padding:7px 8px; color:var(--vscode-descriptionForeground); }
  .pin-count { margin-left:4px; }
  .pin-row { display:flex; align-items:center; }
  .pin-row .nav-row { min-width:0; }
  .pin-list { padding-top:4px; }
  .setup-hint { margin:6px 0; }
  .text-action { border:0; background:transparent; color:var(--vscode-textLink-foreground); padding:8px; text-align:left; }
  footer { flex:none; padding:8px 10px; border-top:1px solid var(--vscode-panel-border); }
  footer .nav-row { font-size:12px; min-height:32px; }
  @media (hover:hover) and (pointer:fine) {
    .nav-row:not(:disabled):hover,.workspace-switch:not(:disabled):hover { transform:scale(1.015); background:var(--vscode-list-hoverBackground); color:var(--vscode-list-hoverForeground,var(--vscode-foreground)); }
    .profile-button:hover,.unpin:hover { background:var(--vscode-list-hoverBackground); }
  }
  @media (prefers-reduced-motion:reduce) { *,*:hover { transition:none!important; animation:none!important; transform:none!important; } }
  @media (forced-colors:active) { .nav-row[aria-current="page"] { outline:1px solid Highlight; } }
  @media (max-height:480px) { body { overflow-y:auto; } main { flex:none; overflow:visible; } }
`;

/** No hover listeners, timers, command strings, or optimistic destination selection. */
export const SIDEBAR_SCRIPT = `
  const vscode=acquireVsCodeApi();
  window.addEventListener('message',event=>{
    if(event.data?.type!=='active-destination')return;
    for(const item of document.querySelectorAll('nav [data-action],footer [data-action]')) {
      if(item.dataset.action===event.data.id)item.setAttribute('aria-current','page');
      else item.removeAttribute('aria-current');
    }
  });
  const saved=vscode.getState()||{};
  const main=document.querySelector('main');
  const persist=()=>{
    const state=vscode.getState()||{};
    state.scroll=main.scrollTop;
    state.focus=document.activeElement?.dataset.action||document.activeElement?.dataset.removeFavorite||null;
    for(const section of document.querySelectorAll('[data-state-key]')) state[section.dataset.stateKey]=section.open;
    vscode.setState(state);
  };
  for(const section of document.querySelectorAll('[data-state-key]')) {
    section.open=Boolean(saved[section.dataset.stateKey]);
    section.addEventListener('toggle',persist);
  }
  main.scrollTop=Number(saved.scroll)||0;
  if(saved.focus) {
    const target=[...document.querySelectorAll('[data-action],[data-remove-favorite]')].find(el=>(el.dataset.action||el.dataset.removeFavorite)===saved.focus);
    target?.focus({preventScroll:true});
  }
  main.addEventListener('scroll',persist,{passive:true});
  document.addEventListener('focusin',persist);
  window.addEventListener('blur',()=>{const state=vscode.getState()||{};state.focus=null;vscode.setState(state);});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button'); if(!button||button.disabled)return;
    if(button.dataset.removeFavorite) vscode.postMessage({type:'favorite-remove',action:button.dataset.removeFavorite});
    else if(button.dataset.action) vscode.postMessage({type:'action',action:button.dataset.action});
  });
  vscode.postMessage({type:'navigation-ready'});
`;
