import { compareStoryCreation } from '../../../../src/story-presentation.mjs';
import type { Inbox, InboxStory } from './inbox-model.ts';
import { escape, icon } from './webview.ts';

export function storyCategory(story: Pick<InboxStory, 'status'>): string {
  const status = story.status.replaceAll(' ', '_');
  if (['cancelled', 'invalid'].includes(status)) return 'cancelled';
  if (['closed', 'complete', 'completed', 'merged'].includes(status)) return 'completed';
  return 'active';
}

const createdDateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
});

/** Retained Story creation, never the last commit or refresh time. UTC keeps dates unambiguous. */
export function storyCreatedDateHtml(createdAt: string | null | undefined): string {
  const milliseconds = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(milliseconds)) return '<span class="muted">Not recorded</span>';
  const date = new Date(milliseconds);
  const iso = date.toISOString();
  const label = createdDateFormat.format(date);
  return `<time datetime="${escape(iso)}" title="${escape(iso)} (UTC)">${escape(label)}</time>`;
}

const storyColumns = [['title', 'Story'], ['repository', 'Repository'], ['created', 'Created (UTC)'],
  ['creator', 'Creator'], ['phase', 'Phase / progress'], ['status', 'Status']] as const;
export const storyTableHeader = (columns: ReadonlyArray<readonly [string, string]> = storyColumns, prefix = 'story') => columns.map(([key, label]) => `<th scope="col" aria-sort="${key === 'created' ? 'descending' : 'none'}"><button type="button" class="story-sort" id="${prefix}-sort-${key}" data-story-sort="${key}">${label}<span aria-hidden="true" data-sort-indicator>${key === 'created' ? ' ↓' : ' ↕'}</span></button></th>`).join('');

/** Catalog details are read-only. Only the explicitly labelled switch button can attach. */
export function workspaceStoriesHtml(inbox: Inbox, refresh: string): string {
  return `<header><h1>${icon('story')}Stories</h1><p class="meta">Stories discovered in this workspace's mapped repositories.</p>${refresh}</header>
    <section><div class="story-catalog-controls">
      <label>Find a Story<input type="search" id="story-search" placeholder="Title, ID, repository or creator" autocomplete="off"></label>
      <label>Status<select id="story-status"><option value="all">All Stories</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled / invalid</option></select></label>
    </div><p class="muted">Viewing details does not switch your workspace, checkout, or active Story. Switching uses the existing guarded attach flow.</p>
    <p id="story-count" role="status">${inbox.stories.length} ${inbox.stories.length === 1 ? 'Story' : 'Stories'}</p>
    <div class="story-table-scroll" role="region" aria-label="Workspace Stories" tabindex="0"><table class="story-catalog-table" data-story-table="story"><thead><tr>${storyTableHeader()}<th scope="col">Action</th></tr></thead><tbody>
    ${[...inbox.stories].sort(compareStoryCreation).map(story => `<tr data-story-row data-category="${storyCategory(story)}" data-title="${escape(story.title)}" data-repository="${escape(story.repositoryId)}" data-created="${escape(story.createdAt ?? '')}" data-creator="${escape(story.createdBy ?? '')}" data-phase="${escape(story.phase)}" data-status="${escape(story.status)}" data-identity="${escape(`${story.workId}:${story.repositoryId}:${story.repositoryPath}`)}" data-search="${escape([story.workId, story.title, story.repositoryId, story.createdBy].join(' ').toLowerCase())}">
      <td><strong>${escape(story.title)}</strong><div class="muted">${escape(story.workId)}${story.current ? ' · Current Story' : ''}</div>
        <details data-detail-key="${escape(`${story.repositoryId}:${story.workId}`)}"><summary>View details</summary><p>Branch: ${escape(story.branch ?? 'Not reported')}</p><p>${escape(story.repositoryPath || story.repositoryUrl || 'Repository mapping unavailable')}</p><p>${story.materialized ? 'Local checkout available' : 'Materialized only when you switch'}</p></details></td>
      <td>${escape(story.repositoryId)}</td><td>${storyCreatedDateHtml(story.createdAt)}</td><td>${escape(story.createdBy ?? 'Not recorded')}</td><td>${escape(story.phase)}<div class="muted">${escape(story.progress ?? 'Phase totals not reported')}</div></td>
      <td>${escape(story.status)}</td><td><button type="button" class="secondary" data-story="${escape(story.workId)}" data-repository-id="${escape(story.repositoryId)}"${story.attachable ? '' : ' disabled'}>${story.current ? 'Continue Story' : 'Switch to Story'}</button></td>
    </tr>`).join('')}</tbody></table></div>
    <p id="story-empty"${inbox.stories.length ? ' hidden' : ''}>${escape(inbox.empty ?? 'No Stories match. Refresh to check the mapped repositories.')}</p></section>`;
}

export const STORY_CATALOG_STYLE = `
  .story-catalog-controls { display:flex; flex-wrap:wrap; gap:16px; margin:16px 0; }
  .story-catalog-controls label { display:flex; flex-direction:column; gap:6px; }
  .story-catalog-controls label:first-child { flex:1; min-width:180px; }
  .story-catalog-controls input,.story-catalog-controls select { width:100%; margin:0; }
  .story-table-scroll { overflow-x:auto; }
  .story-table-scroll:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:-2px; }
  .story-catalog-table { min-width:760px; }
  .story-sort { display:flex; align-items:center; gap:6px; background:transparent; color:inherit; border:0; border-radius:2px; padding:6px 2px; text-align:left; font:inherit; font-weight:600; white-space:nowrap; }
  .story-sort:hover { background:var(--vscode-list-hoverBackground); }
  .story-sort:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
  [aria-sort="ascending"] .story-sort,[aria-sort="descending"] .story-sort { color:var(--vscode-textLink-foreground); }
  .story-catalog-table td { vertical-align:top; overflow-wrap:anywhere; max-width:320px; }
  .story-catalog-table td:last-child { min-width:135px; }
  .story-catalog-table details p { max-width:300px; overflow-wrap:anywhere; }
`;

/** Shared local table sorting for workspace Stories and intake's existing Story lists. */
export const STORY_SORT_SCRIPT = `
(()=>{const initialize=()=>{for(const scope of document.querySelectorAll('[data-story-table]')){
    if(scope.dataset.storySortReady)return;
    scope.dataset.storySortReady='true';
    const keys=[...scope.querySelectorAll('[data-story-sort]')].map(button=>button.dataset.storySort);
    const previous=vscode.getState()||{}, prefix=scope.dataset.storyTable;
    let sortKey=keys.includes(previous[prefix+'SortKey'])?previous[prefix+'SortKey']:'created';
    let sortDirection=previous[prefix+'SortDirection']==='asc'?'asc':'desc';
    const applySort=()=>{
      const rows=[...scope.querySelectorAll('[data-story-row]')];
      const compare=(left,right)=>{
        const a=sortKey==='created'?Date.parse(left.dataset.created):left.dataset[sortKey]||'';
        const b=sortKey==='created'?Date.parse(right.dataset.created):right.dataset[sortKey]||'';
        const absentA=sortKey==='created'?!Number.isFinite(a):!a;
        const absentB=sortKey==='created'?!Number.isFinite(b):!b;
        if(absentA!==absentB)return absentA?1:-1;
        const delta=absentA?0:sortKey==='created'?a-b:a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});
        return (sortDirection==='asc'?delta:-delta)||left.dataset.identity.localeCompare(right.dataset.identity);
      };
      for(const row of rows.sort(compare))row.parentElement.appendChild(row);
      for(const button of scope.querySelectorAll('[data-story-sort]')){
        const active=button.dataset.storySort===sortKey;
        button.closest('th').setAttribute('aria-sort',active?(sortDirection==='asc'?'ascending':'descending'):'none');
        button.querySelector('[data-sort-indicator]').textContent=active?(sortDirection==='asc'?' ↑':' ↓'):' ↕';
      }
      vscode.setState({...vscode.getState(),[prefix+'SortKey']:sortKey,[prefix+'SortDirection']:sortDirection});
    };
    for(const button of scope.querySelectorAll('[data-story-sort]'))button.addEventListener('click',()=>{
      if(sortKey===button.dataset.storySort)sortDirection=sortDirection==='asc'?'desc':'asc';
      else {sortKey=button.dataset.storySort;sortDirection=sortKey==='created'?'desc':'asc';}
      applySort();
    });
    applySort();
}};window.__sfSortStoryTables=initialize;initialize();})();
`;

/** Sorting/filtering/details and persisted view state stay entirely in the webview. */
export const STORY_FILTER_SCRIPT = STORY_SORT_SCRIPT + `
  const search=document.getElementById('story-search'), filter=document.getElementById('story-status');
  if(search&&filter) {
    const previous=vscode.getState()||{};
    search.value=previous.storySearch||'';
    filter.value=['all','active','completed','cancelled'].includes(previous.storyFilter)?previous.storyFilter:'all';
    const applyFilter=()=>{
      let count=0;
      for(const row of document.querySelectorAll('[data-story-row]')) {
        row.hidden=!(row.dataset.search.includes(search.value.trim().toLowerCase())&&(filter.value==='all'||row.dataset.category===filter.value));
        if(!row.hidden)count++;
      }
      document.getElementById('story-count').textContent=count+(count===1?' Story':' Stories');
      document.getElementById('story-empty').hidden=count!==0;
      vscode.setState({...vscode.getState(),storySearch:search.value,storyFilter:filter.value});
    };
    search.addEventListener('input',applyFilter);filter.addEventListener('change',applyFilter);applyFilter();
    for(const detail of document.querySelectorAll('[data-detail-key]')) {
      detail.open=Boolean(previous.storyDetails?.[detail.dataset.detailKey]);
      detail.addEventListener('toggle',()=>{
        const state=vscode.getState()||{};
        const details={};for(const current of document.querySelectorAll('[data-detail-key]'))if(current.open)details[current.dataset.detailKey]=true;
        vscode.setState({...state,storyDetails:details});
      });
    }
    if(previous.storyFocus==='story-search'||previous.storyFocus==='story-status'||String(previous.storyFocus).startsWith('story-sort-'))document.getElementById(previous.storyFocus)?.focus({preventScroll:true});
    window.scrollTo(0,previous.storyScroll||0);
    window.addEventListener('scroll',()=>vscode.setState({...vscode.getState(),storyScroll:window.scrollY}),{passive:true});
    document.addEventListener('focusin',()=>vscode.setState({...vscode.getState(),storyFocus:document.activeElement?.id||null}));
    window.addEventListener('blur',()=>vscode.setState({...vscode.getState(),storyFocus:null}));
  }
`;
