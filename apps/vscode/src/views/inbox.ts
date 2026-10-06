/** The business inbox: work needing a decision and every generated artifact. */
import * as vscode from 'vscode';
import {
  buildInbox, type Inbox, type InboxArtifact, type InboxRepositoryBinding, type WorkspaceStoryCatalogRow
} from './inbox-model.ts';
import { buildApprovals, type PendingApproval } from './approvals-model.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { decisionTargetText } from '../decisions.ts';
import type { WorkspaceStore } from '../state.ts';
import { workspaceStoriesHtml, STORY_FILTER_SCRIPT, STORY_CATALOG_STYLE } from './workspace-stories-page.ts';

export type InboxMode = 'inbox' | 'stories' | 'reviews';

const STATUS_CLASS: Record<string, string> = {
  approved: 'ok', awaiting_approval: 'wait', published: 'wait', rejected: 'bad', stale: 'bad'
};

function artifactRows(inbox: Inbox): string {
  if (!inbox.artifacts.length) {
    return '<div class="empty-state">No generated artifacts yet. Declared but unwritten templates are intentionally not counted.</div>';
  }
  return inbox.workItems.map((work) => `
    <section class="inbox-work">
      <div class="section-heading"><h2>${icon(work.source === 'initiative' ? 'initiative' : 'story')}${escape(work.workId)}</h2><span class="count-badge">${work.artifacts.length}</span></div>
      ${work.label && work.label !== work.workId ? `<p class="muted">${escape(work.label)}</p>` : ''}
      ${work.groups.map((group) => `<section class="inbox-phase">
        <div class="section-heading"><h3>${icon('directory')}${escape(group.label)}</h3><span class="count-badge">${group.artifacts.length}</span></div>
        <div class="artifact-cards">${group.artifacts.map((artifact) => `
        <button class="artifact-card" data-artifact="${escape(artifact.id)}">
          <span class="artifact-title">${icon('document')}${escape(artifact.label)}</span>
          <span class="pill ${STATUS_CLASS[artifact.status] ?? 'idle'}">${escape(artifact.status.replace(/_/g, ' '))}</span>
          <span class="artifact-meta">${escape(artifact.kind)}${artifact.generation != null ? ` · generation ${artifact.generation}` : ''}</span>
          <span class="artifact-meta">${artifact.generatedBy ? `by ${escape(artifact.generatedBy)} · ` : ''}<code>${escape((artifact.sha256 ?? '').slice(0, 12))}</code></span>
        </button>`).join('')}</div>
      </section>`).join('')}
    </section>`).join('');
}

function workflowDecisionCard(inbox: Inbox): string {
  const pending = inbox.decision;
  if (!pending) return '';
  return `
    <article class="decision-card">
      <div><span class="eyebrow">decision</span><h3>${escape(pending.label)}</h3></div>
      <p class="muted">${escape(pending.workId)} · after ${escape(pending.afterLabel ?? pending.after)}${pending.reason === 'limit' ? ` · all ${escape(String(pending.maxRounds ?? ''))} rounds are used` : ''}</p>
      <ul class="muted">${pending.options.map((option) => `<li>${escape(option.label)} → ${escape(decisionTargetText(option))}</li>`).join('')}</ul>
      <div class="card-foot"><button data-decide="${escape(pending.workId)}">Choose what happens next</button></div>
    </article>`;
}

function decisionCards(inbox: Inbox): string {
  const decisions = inbox.approvals.pending.filter((approval) => approval.standing === 'yours');
  const waiting = workflowDecisionCard(inbox);
  if (!decisions.length && !waiting) return `<p class="ok-text">${icon('ok')}Nothing is waiting for your decision.</p>`;
  return `<div class="decision-cards">${waiting}${decisions.map((approval) => `
    <article class="decision-card">
      <div><span class="eyebrow">${escape(approval.kind)}</span><h3>${escape(approval.label)}</h3></div>
      <p class="muted">${escape(approval.detail)}</p>
      ${approval.reviewPacketSha256 ? `<div class="review-binding"><span>Review packet</span><code>${escape(approval.reviewPacketSha256)}</code>${approval.submittedSourceCommit ? `<span>Source commit</span><code>${escape(approval.submittedSourceCommit)}</code>` : ''}</div>` : ''}
      ${approval.sha256 ? `<code>${escape(approval.sha256.slice(0, 16))}</code>` : ''}
      ${approval.selfApproval ? '<p class="warning-text">You generated this; approval will not count as independent review.</p>' : ''}
      <div class="card-foot">
        ${approval.kind === 'output' || approval.artifactPath
    ? `<button class="secondary" data-open-approval="${escape(approval.id)}">Open artifact</button>` : ''}
        <button data-approve="${escape(approval.id)}">Review & approve</button>
        <button class="secondary" data-reject="${escape(approval.id)}">Reject</button>
      </div>
    </article>`).join('')}</div>`;
}

function storyCards(inbox: Inbox): string {
  if (!inbox.stories.length) return '';
  return `<section class="active-story-switcher" aria-labelledby="active-stories-heading">
    <div class="section-heading"><div><h2 id="active-stories-heading">${icon('story')}Workspace Stories</h2>
      <p class="muted">Open a Story's isolated checkout and continue in Copilot. Existing local work is preserved; a remote-only Story materializes its mapped repository first.</p></div>
      <span class="count-badge">${inbox.stories.length}</span></div>
    <div class="active-story-grid">${inbox.stories.map((story) => `
      <button type="button" class="active-story-card${story.current ? ' current' : ''}"
        data-story="${escape(story.workId)}" data-repository-id="${escape(story.repositoryId)}"${story.current ? ' aria-current="page"' : ''}${story.attachable ? '' : ' disabled aria-disabled="true"'}>
        <span class="active-story-title">${icon(story.current ? 'statusCurrent' : 'story')}${escape(story.workId)}</span>
        <span class="active-story-phase">${escape(story.repositoryId)} · ${escape(story.phase)}${story.terminal ? ` · ${escape(story.status)}` : ''}</span>
        <small>${escape(story.title)}</small>
        ${story.attachable
    ? `<span class="active-story-action">${story.current ? 'Continue in Copilot' : story.materialized ? 'Open &amp; continue' : 'Materialize &amp; continue'}${icon('next')}</span>`
    : '<small>Repository mapping is unavailable</small>'}
      </button>`).join('')}</div>
  </section>`;
}

export interface InboxRefreshState {
  refreshing: boolean;
  error: string | null;
}

function refreshStoriesControl({ refreshing, error }: InboxRefreshState): string {
  return `<div class="inbox-refresh">
    <button type="button" class="secondary" data-refresh-stories${refreshing ? ' disabled aria-busy="true"' : ''}>
      ${icon('refresh')}${refreshing ? 'Checking for Stories…' : error ? 'Retry Story refresh' : 'Refresh Stories'}
    </button>
    ${error ? `<p class="warning-text" role="alert">Story list may be incomplete: ${escape(error)}</p>` : ''}
  </div>`;
}

export function inboxHtml(inbox: Inbox, refresh: InboxRefreshState = { refreshing: false, error: null }): string {
  if (inbox.empty) return `<div class="brand-lockup"><strong>SINGULARITY</strong><span>FLOW</span></div>
    <header class="inbox-header"><h1>${icon('approval', { size: 20 })}Inbox</h1>${refreshStoriesControl(refresh)}</header>
    <div class="empty"><p>${refresh.error ? 'No Stories are confirmed yet. Use Refresh Stories to retry discovery.' : escape(inbox.empty)}</p></div>`;
  const yours = inbox.approvals.pending.filter((approval) => approval.standing === 'yours').length;
  const other = inbox.approvals.pending.length - yours;
  const approved = inbox.artifacts.filter((artifact) => artifact.status === 'approved').length;
  return `
    <div class="brand-lockup"><strong>SINGULARITY</strong><span>FLOW</span></div>
    <header class="inbox-header">
      <div><span class="eyebrow">BUSINESS WORKSPACE</span><h1>${icon('approval', { size: 20 })}Inbox</h1>
      <p class="meta">${escape(inbox.subjectId)}${inbox.subjectLabel && inbox.subjectLabel !== inbox.subjectId ? ` · ${escape(inbox.subjectLabel)}` : ''}</p></div>
      ${refreshStoriesControl(refresh)}
    </header>
    <div class="summary-grid">
      <div class="summary-card important"><strong>${yours}</strong><span>Waiting for you</span></div>
      <div class="summary-card"><strong>${inbox.artifacts.length}</strong><span>Generated artifacts</span></div>
      <div class="summary-card"><strong>${approved}</strong><span>Approved</span></div>
      <div class="summary-card"><strong>${other}</strong><span>With other reviewers</span></div>
    </div>
    ${storyCards(inbox)}
    <section><div class="section-heading"><h2>${icon('approval')}Needs your attention</h2><span class="count-badge">${yours}</span></div>${decisionCards(inbox)}</section>
    <section><div class="section-heading"><h2>${icon('document')}Everything generated</h2><span class="count-badge">${inbox.artifacts.length}</span></div>
      <p class="muted">Every existing governed output across every phase. Open any card to inspect the exact committed file.</p>${artifactRows(inbox)}</section>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-refresh-stories],[data-story],[data-artifact],[data-approve],[data-reject],[data-open-approval],[data-decide]');
    if (!target) return;
    if (target.hasAttribute('data-refresh-stories')) vscode.postMessage({ type: 'refresh-stories' });
    else if (target.dataset.story) vscode.postMessage({
      type: 'attach-story', id: target.dataset.story, repositoryId: target.dataset.repositoryId || ''
    });
    else if (target.dataset.artifact) vscode.postMessage({ type: 'open-artifact', id: target.dataset.artifact });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.reject) vscode.postMessage({ type: 'reject', id: target.dataset.reject });
    else if (target.dataset.openApproval) vscode.postMessage({ type: 'open-approval', id: target.dataset.openApproval });
    else if (target.dataset.decide) vscode.postMessage({ type: 'decide', id: target.dataset.decide });
  });
  document.addEventListener('click',event=>{
    const target=event.target.closest('[data-review-route]');
    if(target)vscode.postMessage({type:'review-route',route:target.dataset.reviewRoute});
  });
  const reviewFilter=document.getElementById('review-filter');
  if(reviewFilter) {
    reviewFilter.value=vscode.getState()?.reviewFilter||'all';
    const update=()=>{
      for(const group of document.querySelectorAll('[data-review-group]'))group.hidden=reviewFilter.value!=='all'&&group.dataset.reviewGroup!==reviewFilter.value;
      vscode.setState({...vscode.getState(),reviewFilter:reviewFilter.value});
    };
    reviewFilter.addEventListener('change',update);update();
  }
  ${STORY_FILTER_SCRIPT}
`;

export type InboxMessage =
  | { type: 'refresh-stories' }
  | { type: 'attach-story'; workId: string; repositoryId: string }
  | { type: 'open-artifact'; artifact: InboxArtifact }
  | { type: 'approve'; approval: PendingApproval }
  | { type: 'reject'; approval: PendingApproval }
  | { type: 'open-approval'; approval: PendingApproval }
  | { type: 'decide'; workId: string };

export class InboxPanel {
  private static current = new Map<InboxMode, InboxPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly storyCatalog: () => readonly WorkspaceStoryCatalogRow[];
  private readonly repositoryPath: () => string | null;
  private readonly catalogIssue: () => string | null;
  private readonly repositoryBinding: () => InboxRepositoryBinding | null;
  private readonly mode: InboxMode;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private refreshingStories = false;
  private refreshError: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: InboxMessage) => Promise<void> | void,
    storyCatalog: () => readonly WorkspaceStoryCatalogRow[],
    repositoryPath: () => string | null,
    catalogIssue: () => string | null,
    repositoryBinding: () => InboxRepositoryBinding | null,
    mode: InboxMode = 'inbox'
  ) {
    this.panel = panel;
    this.mode = mode;
    this.store = store;
    this.storyCatalog = storyCatalog;
    this.repositoryPath = repositoryPath;
    this.catalogIssue = catalogIssue;
    this.repositoryBinding = repositoryBinding;
    // The Inbox does not display the shared snapshot spinner. Replacing its entire webview for a
    // loading-only event is expensive and discards the user's scroll/focus for no content change.
    this.subscription = store.onDidChange((_state, change) => {
      if (change.kind !== 'loading') this.render();
    });
    /**
     * The messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * Both lookups are unchanged: the page names an id and the snapshot says which artifact or
     * approval that is. Note they are *different* collections keyed by the same field name — an id
     * that names an artifact must not reach an approval — which the enumerated map makes explicit
     * where the chain expressed it as an early `return`.
     */
    const approvalFor = (message: InboundMessage) => {
      const id = stringField(message, 'id');
      return id ? buildApprovals(store.current.snapshot).pending.find((item) => item.id === id) ?? null : null;
    };
    const router = registerMessageRouter('singularityFlow.inbox', {
      'review-route': (message) => {
        const commands: Record<string, string> = {
          proposals: 'singularityFlow.reviewCapabilityProposals', visual: 'singularityFlow.openVisualAssurance',
          'workflow-proposals': 'singularityFlow.openConfigurationApprovals',
          approvals: 'singularityFlow.openApprovals'
        };
        const route = stringField(message, 'route');
        if (route && commands[route]) void navigateTo(commands[route]!);
      },
      'refresh-stories': () => {
        if (this.refreshingStories) return;
        this.refreshingStories = true;
        this.refreshError = null;
        this.render();
        void Promise.resolve().then(() => onMessage({ type: 'refresh-stories' })).then(() => {
          if (this.disposed) return;
          this.refreshingStories = false;
          this.render();
        }).catch((error: unknown) => {
          if (this.disposed) return;
          this.refreshingStories = false;
          this.refreshError = error instanceof Error ? error.message : String(error);
          this.render();
        });
      },
      'attach-story': (message) => {
        const workId = stringField(message, 'id');
        const repositoryId = typeof message.repositoryId === 'string' ? message.repositoryId : '';
        const exists = this.currentInbox().stories.some((item) =>
          item.workId === workId && item.repositoryId === repositoryId && item.attachable);
        if (workId && exists) onMessage({ type: 'attach-story', workId, repositoryId });
      },
      'open-artifact': (message) => {
        const id = stringField(message, 'id');
        const artifact = id
          ? buildInbox(store.current.snapshot).artifacts.find((item) => item.id === id)
          : null;
        if (artifact) onMessage({ type: 'open-artifact', artifact });
      },
      approve: (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'approve', approval }); },
      reject: (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'reject', approval }); },
      'open-approval': (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'open-approval', approval }); },
      decide: (message) => {
        const workId = stringField(message, 'id');
        if (workId && this.currentInbox().decision?.workId === workId) onMessage({ type: 'decide', workId });
      }
    });
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);

      router.route(raw);
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: InboxMessage) => Promise<void> | void,
    storyCatalog: () => readonly WorkspaceStoryCatalogRow[] = () => [],
    repositoryPath: () => string | null = () => null,
    catalogIssue: () => string | null = () => null,
    repositoryBinding: () => InboxRepositoryBinding | null = () => null,
    mode: InboxMode = 'inbox'
  ): InboxPanel {
    const existing = InboxPanel.current.get(mode);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return existing;
    }
    const title = mode === 'stories' ? 'Stories' : mode === 'reviews' ? 'Reviews' : 'Inbox';
    const viewType = mode === 'stories' ? 'singularityFlow.workspaceStories' : mode === 'reviews' ? 'singularityFlow.reviews' : 'singularityFlow.inboxPanel';
    const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    const current = new InboxPanel(panel, store, onMessage, storyCatalog, repositoryPath, catalogIssue, repositoryBinding, mode);
    InboxPanel.current.set(mode, current);
    return current;
  }

  static refreshCurrent(): void {
    // This method is called after catalog discovery, including automatic runs. A newly confirmed
    // complete catalog clears an older explicit-refresh error even if the user did not click Retry.
    for (const current of InboxPanel.current.values()) {
      if (!current.catalogIssue()) current.refreshError = null;
      current.render();
    }
  }

  private currentInbox(): Inbox {
    return buildInbox(this.store.current.snapshot, this.storyCatalog(), this.repositoryPath() ?? '', this.repositoryBinding());
  }

  private render(): void {
    const token = nonce();
    const state = this.store.current;
    const refresh = {
      refreshing: this.refreshingStories,
      error: this.refreshError ?? this.catalogIssue()
    };
    const inbox = this.currentInbox();
    const title = this.mode === 'stories' ? 'Stories' : this.mode === 'reviews' ? 'Reviews' : 'Inbox';
    const warning = state.error ? `<p role="alert" class="warning-text">${escape(state.error.message)}</p>`
      : state.stale ? '<p role="status" class="warning-text">Showing last known state. Refresh before making a decision.</p>'
      : !state.snapshot ? '<p role="status">Reading workspace state…</p>' : '';
    const body = this.mode === 'stories' ? workspaceStoriesHtml(inbox, refreshStoriesControl(refresh))
      : this.mode === 'reviews' ? `<header><h1>${icon('approval')}Reviews</h1><p class="meta">Decisions and evidence. No action is approved simply by opening this screen.</p></header>
        <label>Review category<select id="review-filter"><option value="all">All categories</option><option value="phases">Phase approvals &amp; workflow decisions</option><option value="proposals">Configuration &amp; capability changes</option><option value="visual">Visual evidence</option></select></label>
        <section data-review-group="phases"><h2>Phase approvals &amp; decisions</h2>${state.snapshot && !state.error && !state.stale && (!state.snapshot.included || state.snapshot.included.includes('lifecycle')) ? decisionCards(inbox) : '<p>Current approval state is not confirmed.</p>'}<button class="secondary" data-review-route="approvals">Open all phase reviews</button></section>
        <section data-review-group="proposals"><h2>Configuration &amp; capability changes</h2><p class="muted">Open the appropriate proposal queue to check its current state. Proposals are not counted as pending until checked. Activating shared configuration does not automatically amend an existing Story.</p><button class="secondary" data-review-route="workflow-proposals">Workflow &amp; test configuration approvals</button><button class="secondary" data-review-route="proposals">Setup &amp; capability proposals</button></section>
        <section data-review-group="visual"><h2>Visual evidence</h2><p class="muted">Inspect screenshots and comparison evidence for the current work.</p><button class="secondary" data-review-route="visual">Review visual evidence</button></section>`
      : inboxHtml(inbox, refresh);
    const styles = this.mode === 'stories' ? `<style nonce="${token}">${STORY_CATALOG_STYLE}</style>` : '';
    this.panel.webview.html = page(title, styles + warning + body,
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (InboxPanel.current.get(this.mode) === this) InboxPanel.current.delete(this.mode);
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
