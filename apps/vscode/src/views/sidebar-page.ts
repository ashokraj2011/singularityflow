/** Presentation only. Opening, hovering and filtering navigation never read a repository. */
import { brandSymbol, escape, icon, type IconName } from './webview.ts';
import { CALM_PALETTE_STYLE } from './theme.ts';
import type { SidebarNavigation } from './sidebar-navigation-model.ts';

/**
 * The daily jobs, and only those. Every row opens a screen; none of them changes anything.
 * Artifacts, Story Analytics and the explainers live in Work tools, configuration approvals inside
 * Reviews, After install in Help & diagnostics, and Recreate & sync inside Configuration, where it
 * asks before it writes.
 */
export const PRIMARY_NAVIGATION = [
  { id: 'my-work', label: 'My Work', icon: 'home', command: 'singularityFlow.myWork' },
  { id: 'work-start', label: 'Start new work', icon: 'start', command: 'singularityFlow.startWork' },
  { id: 'stories', label: 'Stories', icon: 'story', command: 'singularityFlow.openWorkspaceStories' },
  { id: 'reviews', label: 'Reviews', icon: 'approval', command: 'singularityFlow.openReviews' },
  { id: 'workspace-manage', label: 'Workspaces', icon: 'workspace', command: 'singularityFlow.openWorkspaces' },
  { id: 'configuration-center', label: 'Configuration', icon: 'configuration', command: 'singularityFlow.openConfigurationCenter' }
] as const;
export type PrimaryNavigationId = typeof PRIMARY_NAVIGATION[number]['id'];

/** Whether governed prompts are being recorded here; null while the host is still reading it. */
export type PromptLogState = 'on' | 'off' | 'unavailable' | null;

export interface SidebarPage {
  navigation: SidebarNavigation;
  freshness: string | null;
  loading: boolean;
  pending: number | null;
  active: string | null;
  favorites: ReadonlyArray<{ id: string; label: string; icon: IconName }>;
  menuCollapsed?: boolean;
  /** Omitted when there is no repository to record prompts for. */
  promptLog?: PromptLogState;
}

function link(id: string, label: string, glyph: IconName, active: string | null, badge = ''): string {
  return `<button type="button" class="nav-row" data-action="${escape(id)}"${active === id ? ' aria-current="page"' : ''}>
    ${icon(glyph, { size: 16 })}<span class="nav-label">${escape(label)}</span>${badge}</button>`;
}

/** The state is spelled out next to the switch, so it never rests on colour alone. */
function promptLogSwitch(state: PromptLogState | undefined): string {
  if (state === undefined) return '';
  const on = state === 'on';
  const text = state === null ? 'Checking…' : state === 'unavailable' ? 'Unavailable' : on ? 'On' : 'Off';
  return `<button type="button" class="nav-row prompt-log" role="switch" aria-checked="${on}" data-action="prompt-log-toggle"${state === null ? ' disabled' : ''}>
    ${icon('prompt', { size: 16 })}<span class="nav-label">Prompt log</span><span class="switch-state">${text}</span><span class="switch-track${on ? ' on' : ''}" aria-hidden="true"></span></button>`;
}

export function sidebarBody(view: SidebarPage): string {
  const workspace = view.navigation.workspace;
  const subject = view.navigation.subject;
  const next = view.navigation.next;
  return `<header class="brand">${brandSymbol(25)}<span>Singularity Flow</span>
    <button type="button" class="profile-button" data-action="persona-manage" aria-label="Profile and shortcut suggestions">${icon('agent', { size: 16 })}</button></header>
    <section class="context" aria-label="Current context">
      <span class="context-label">Workspace</span>
      <button type="button" class="workspace-switch" data-action="workspace-switch">
        <span>${escape(workspace?.name ?? 'Choose a workspace')}</span><span aria-hidden="true">▾</span></button>
      ${workspace?.repository ? `<p class="context-detail">Repository: <span>${escape(workspace.repository)}</span></p>` : ''}
      ${subject ? `<p class="context-detail">${escape(subject.kind)}: <span>${escape(subject.id)}</span></p><p class="context-detail">Phase: <span>${escape(subject.phase ?? 'none current')}</span></p>` : workspace ? '<p class="context-detail">No work in progress</p>' : '<p class="context-detail">Select or create a workspace to begin.</p>'}
      ${subject?.kind === 'Story' ? '<button type="button" class="text-action" data-action="story-intake">View intake details</button>' : ''}
      ${view.freshness || view.loading ? `<p class="freshness" role="status">${escape(view.freshness ?? 'Reading workspace state…')}</p>` : ''}
      ${next ? `<button type="button" class="next-step" data-action="${escape(next.actionId)}" data-focus-key="next-step">
        <span class="next-label">${escape(next.label)}</span><span class="next-detail">${escape(next.description)}</span></button>` : ''}
    </section>
    <main>
      <details class="main-menu" data-main-menu${view.menuCollapsed ? '' : ' open'}>
      <summary data-focus-key="main-menu">Main menu</summary>
      <nav aria-label="Singularity Flow">
      ${PRIMARY_NAVIGATION.map((item) => link(item.id, item.label, item.icon, view.active,
        item.id === 'reviews' && view.pending != null && view.pending > 0
          ? `<span class="badge" aria-label="${view.pending} pending phase approvals">${view.pending}</span>` : '')).join('')}
      ${promptLogSwitch(view.promptLog)}
      </nav>
      </details>
      ${!workspace && !next ? `<div class="setup-hint"><button type="button" class="text-action" data-action="setup-wizard">Set up a workspace</button></div>` : ''}
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

export const SIDEBAR_STYLE = `${CALM_PALETTE_STYLE}
  :root { color-scheme: light dark; }
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:flex; flex-direction:column; overflow:hidden;
    color:var(--sf-text); background:var(--sf-sidebar);
    font-family:var(--vscode-font-family,system-ui,sans-serif); font-size:var(--vscode-font-size,13px); }
  button { font:inherit; color:inherit; cursor:pointer; }
  button:disabled { cursor:default; opacity:.6; }
  button:focus-visible,summary:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:-2px; }
  .brand { display:flex; align-items:center; gap:8px; padding:16px 14px; font-weight:500; flex:none; }
  .profile-button,.unpin { display:grid; place-items:center; border:0; background:transparent; border-radius:4px; width:28px; height:28px; flex:none; }
  .profile-button { margin-left:auto; }
  .context { padding:4px 14px 16px; border-bottom:1px solid var(--sf-border-color); flex:none; }
  .context-label { display:block; font-size:12px; color:var(--sf-dim); margin-bottom:7px; }
  .workspace-switch { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; min-height:34px; padding:6px 8px;
    border:1px solid var(--sf-border-color); border-radius:var(--sf-radius); background:var(--sf-surface); color:var(--sf-text); text-align:left; }
  .workspace-switch>span:first-child { overflow-wrap:anywhere; min-width:0; }
  .context-detail { margin:7px 0 0; font-size:12px; color:var(--sf-dim); overflow-wrap:anywhere; }
  .context-detail span { color:var(--sf-text); }
  .freshness { font-size:11px; margin:8px 0 0; color:var(--vscode-descriptionForeground); }
  .next-step { display:flex; flex-direction:column; align-items:flex-start; gap:2px; width:100%; margin-top:12px; padding:8px 10px; border:0; border-radius:var(--sf-radius);
    background:var(--vscode-button-background); color:var(--vscode-button-foreground); text-align:left; }
  .next-label { font-weight:600; overflow-wrap:anywhere; }
  .next-detail { font-size:12px; opacity:.9; overflow-wrap:anywhere; }
  main { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; padding:14px 12px 8px; }
  .main-menu>summary { cursor:pointer; min-height:32px; padding:7px 8px; border-radius:var(--sf-radius); color:var(--sf-dim); font-size:12px; }
  .main-menu nav { padding-top:6px; }
  nav { display:flex; flex-direction:column; gap:4px; }
  .nav-row { display:flex; align-items:center; gap:10px; width:100%; min-height:40px; padding:8px 10px; border:0; border-radius:var(--sf-radius); background:transparent; color:var(--sf-dim); text-align:left; transform-origin:center;
    transition:transform 140ms ease-out,background-color 140ms ease-out; }
  .nav-row .ico { flex:none; }
  .nav-label { flex:1; min-width:0; overflow-wrap:anywhere; }
  .nav-row[aria-current="page"] { background:var(--sf-surface-raised); color:var(--sf-text); font-weight:500; box-shadow:inset 2px 0 var(--sf-accent); }
  .nav-row[aria-current="page"] .ico { color:var(--sf-accent); }
  .badge,.pin-count { font-size:11px; border-radius:12px; padding:1px 6px; background:var(--sf-surface-raised); color:var(--sf-text); }
  .switch-state { font-size:12px; color:var(--sf-dim); }
  .switch-track { flex:none; position:relative; width:28px; height:16px; border-radius:8px; border:1px solid var(--sf-border-color); background:var(--sf-surface-raised); }
  .switch-track::after { content:''; position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%; background:var(--sf-dim); transition:transform 140ms ease-out; }
  .switch-track.on { border-color:var(--sf-accent); background:var(--sf-accent); }
  .switch-track.on::after { transform:translateX(12px); background:var(--sf-sidebar); }
  .prompt-log[aria-checked="true"] .switch-state { color:var(--sf-text); }
  .pins { margin-top:18px; padding-top:12px; border-top:1px solid var(--sf-border-color); }
  .pins summary { cursor:pointer; padding:7px 8px; color:var(--sf-dim); }
  .pin-count { margin-left:4px; }
  .pin-row { display:flex; align-items:center; }
  .pin-row .nav-row { min-width:0; }
  .pin-list { padding-top:4px; }
  .setup-hint { margin:6px 0; }
  .text-action { border:0; background:transparent; color:var(--vscode-textLink-foreground); padding:8px; text-align:left; }
  footer { flex:none; padding:10px 12px; border-top:1px solid var(--sf-border-color); }
  footer .nav-row { font-size:12px; min-height:32px; }
  @media (hover:hover) and (pointer:fine) {
    .nav-row:not(:disabled):hover,.workspace-switch:not(:disabled):hover { transform:scale(1.015); background:var(--sf-surface-raised); color:var(--sf-text); }
    .next-step:hover { background:var(--vscode-button-hoverBackground,var(--vscode-button-background)); }
    .profile-button:hover,.unpin:hover { background:var(--sf-surface-raised); }
    .main-menu>summary:hover { background:var(--sf-surface-raised); color:var(--sf-text); }
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
  const menu=document.querySelector('[data-main-menu]');
  const persist=()=>{
    const state=vscode.getState()||{};
    state.scroll=main.scrollTop;
    state.focus=document.activeElement?.dataset.action||document.activeElement?.dataset.removeFavorite||document.activeElement?.dataset.focusKey||null;
    for(const section of document.querySelectorAll('[data-state-key]')) state[section.dataset.stateKey]=section.open;
    vscode.setState(state);
  };
  // The host renders the durable menu preference; webview state must not override it.
  menu.addEventListener('toggle',()=>{
    persist();
    vscode.postMessage({type:'menu-collapse',collapsed:!menu.open});
  });
  for(const section of document.querySelectorAll('[data-state-key]')) {
    if(typeof saved[section.dataset.stateKey]==='boolean')section.open=saved[section.dataset.stateKey];
    section.addEventListener('toggle',persist);
  }
  main.scrollTop=Number(saved.scroll)||0;
  if(saved.focus) {
    let target=[...document.querySelectorAll('[data-action],[data-remove-favorite],[data-focus-key]')].find(el=>(el.dataset.action||el.dataset.removeFavorite||el.dataset.focusKey)===saved.focus);
    const closed=target?.closest('details:not([open])');
    if(closed&&target.tagName!=='SUMMARY')target=closed.querySelector('summary');
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
