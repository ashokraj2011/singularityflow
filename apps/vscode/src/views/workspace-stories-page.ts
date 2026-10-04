import type { Inbox, InboxStory } from './inbox-model.ts';
import { escape, icon } from './webview.ts';

export function storyCategory(story: Pick<InboxStory, 'status'>): string {
  const status = story.status.replaceAll(' ', '_');
  if (['cancelled', 'invalid'].includes(status)) return 'cancelled';
  if (['closed', 'complete', 'completed', 'merged'].includes(status)) return 'completed';
  return 'active';
}

/** Catalog details are read-only. Only the explicitly labelled switch button can attach. */
export function workspaceStoriesHtml(inbox: Inbox, refresh: string): string {
  return `<header><h1>${icon('story')}Stories</h1><p class="meta">Stories discovered in this workspace's mapped repositories.</p>${refresh}</header>
    <section><div class="field-grid">
      <label>Find a Story<input type="search" id="story-search" placeholder="Title, ID or repository" autocomplete="off"></label>
      <label>Status<select id="story-status"><option value="all">All Stories</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled / invalid</option></select></label>
    </div><p class="muted">Viewing details does not switch your workspace, checkout, or active Story. Switching uses the existing guarded attach flow.</p>
    <p id="story-count" role="status">${inbox.stories.length} Stories</p>
    <table><thead><tr><th>Story</th><th>Repository</th><th>Phase / progress</th><th>Status</th><th>Action</th></tr></thead><tbody>
    ${inbox.stories.map(story => `<tr data-story-row data-category="${storyCategory(story)}" data-search="${escape([story.workId, story.title, story.repositoryId].join(' ').toLowerCase())}">
      <td><strong>${escape(story.title)}</strong><div class="muted">${escape(story.workId)}${story.current ? ' · Current Story' : ''}</div>
        <details data-detail-key="${escape(`${story.repositoryId}:${story.workId}`)}"><summary>View details</summary><p>Branch: ${escape(story.branch ?? 'Not reported')}</p><p>${escape(story.repositoryPath || story.repositoryUrl || 'Repository mapping unavailable')}</p><p>${story.materialized ? 'Local checkout available' : 'Materialized only when you switch'}</p></details></td>
      <td>${escape(story.repositoryId)}</td><td>${escape(story.phase)}<div class="muted">${escape(story.progress ?? 'Phase totals not reported')}</div></td>
      <td>${escape(story.status)}</td><td><button type="button" class="secondary" data-story="${escape(story.workId)}" data-repository-id="${escape(story.repositoryId)}"${story.attachable ? '' : ' disabled'}>${story.current ? 'Continue Story' : 'Switch to Story'}</button></td>
    </tr>`).join('')}</tbody></table>
    <p id="story-empty"${inbox.stories.length ? ' hidden' : ''}>${escape(inbox.empty ?? 'No Stories match. Refresh to check the mapped repositories.')}</p></section>`;
}

/** Filtering/details and persisted view state stay entirely in the webview. */
export const STORY_FILTER_SCRIPT = `
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
      document.getElementById('story-count').textContent=count+' Stories';
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
    if(previous.storyFocus==='story-search'||previous.storyFocus==='story-status')document.getElementById(previous.storyFocus)?.focus({preventScroll:true});
    window.scrollTo(0,previous.storyScroll||0);
    window.addEventListener('scroll',()=>vscode.setState({...vscode.getState(),storyScroll:window.scrollY}),{passive:true});
    document.addEventListener('focusin',()=>vscode.setState({...vscode.getState(),storyFocus:document.activeElement?.id||null}));
    window.addEventListener('blur',()=>vscode.setState({...vscode.getState(),storyFocus:null}));
  }
`;
