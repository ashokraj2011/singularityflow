/**
 * The Stories panel: what the Epic decomposed into, grouped by the repository each piece lands in.
 *
 * Reads as a lineage — parent Epic, then child repositories, then the Stories inside them — because
 * that is the relationship the reader is actually navigating. The merge order is shown once at the
 * top rather than repeated per card: it is a property of the whole plan, not of any one Story.
 */
import * as vscode from 'vscode';
import { buildStories, type StoryView, type Stories } from './stories-model.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import type { WorkspaceStore } from '../state.ts';

const STATE_PILL: Record<string, { className: string; label: string }> = {
  planned: { className: '', label: 'planned' },
  seeded: { className: 'wait', label: 'branch created' },
  'in-progress': { className: 'wait', label: 'in progress' },
  complete: { className: 'ok', label: 'complete' },
  merged: { className: 'ok', label: 'merged' },
  blocked: { className: 'bad', label: 'blocked' }
};

function storyHtml(story: StoryView): string {
  const pill = STATE_PILL[story.state] ?? STATE_PILL['planned'];
  const traces = [...story.requirements, ...story.acceptanceCriteria];
  return `
  <article class="card ${story.state === 'blocked' ? 'blocked' : story.state === 'planned' ? '' : 'others'}">
    <div class="card-head">
      <h3>${icon('story')}${escape(story.workId)}</h3>
      <span class="pill ${pill?.className ?? ''}">${escape(pill?.label ?? '')}</span>
      <span class="grow"></span>
      ${story.blocking ? '' : '<span class="muted">non-blocking</span>'}
    </div>
    <p>${escape(story.title)}</p>

    ${traces.length
    ? `<p class="muted">Carries ${traces.map((id) => `<code>${escape(id)}</code>`).join(' ')}</p>`
    : '<p class="muted">No requirement is allocated to this Story.</p>'}

    ${story.dependsOn.length
    ? `<p class="muted">Waits for ${story.dependsOn.map((id) => escape(id)).join(', ')}</p>` : ''}
    ${story.blocks.length
    ? `<p class="muted">${story.blocks.map((id) => escape(id)).join(', ')} ${story.blocks.length === 1 ? 'waits' : 'wait'} for this</p>` : ''}

    ${story.branch
    ? `<p class="muted">
         <code>${escape(story.branch)}</code>
         ${story.head ? (story.atSeed ? ' at seed' : ` at ${escape(story.head.slice(0, 8))}`) : ' never observed'}
         ${story.phase ? ` · ${escape(story.phase)}` : ''}
         ${story.stale ? ' · <span class="pill bad">record stale</span>' : ''}
       </p>`
    : '<p class="muted">Not yet pushed to its repository.</p>'}

    ${story.conformance
    ? `<p class="muted">Conformance ${escape(story.conformance.status)}${story.conformance.treeSha256 ? ` at <code>${escape(story.conformance.treeSha256.slice(0, 8))}</code>` : ''}</p>`
    : ''}

    <div class="card-foot">
      <button class="link" data-spec="${escape(story.planId)}">Open specification</button>
      <button class="link" data-split="${escape(story.planId)}">Split…</button>
    </div>
  </article>`;
}

function bodyHtml(stories: Stories): string {
  if (stories.empty) {
    return `<header><h1>${icon('story', { size: 20 })}Stories</h1>${stories.initiativeId ? `<p class="meta">${escape(stories.initiativeId)}</p>` : ''}</header>
      <div class="empty"><p>${escape(stories.empty)}</p></div>`;
  }

  const repositories = stories.groups.length;
  return `
  <header>
    <h1>${icon('story', { size: 20 })}Stories</h1>
    <p class="meta">
      ${escape(stories.title)} · ${stories.planned} ${stories.planned === 1 ? 'Story' : 'Stories'}
      across ${repositories} ${repositories === 1 ? 'repository' : 'repositories'} ·
      ${stories.materialized ? 'pushed to their repositories' : 'not yet pushed'}
    </p>
  </header>

  ${stories.order.length > 1 ? `
  <section class="plain">
    <h2>${icon('merge')}Merge order</h2>
    <p class="question">Derived from the dependencies the plan declares; this is the sequence the repositories must land in.</p>
    <ul class="chain">${stories.order.map((planId) => `<li>${escape(planId)}</li>`).join('')}</ul>
  </section>` : ''}

  ${stories.materialized ? '' : `
  <section class="plain">
    <p><button data-materialize="all">Push these Stories to their repositories</button></p>
    <p class="muted">Creates a branch in each repository, seeded with the governed Story context.</p>
  </section>`}

  ${stories.groups.map((group) => `
  <section>
    <h2>${icon('repository')}${escape(group.repository)} <span class="muted">&nbsp;${group.stories.length}</span></h2>
    ${group.stories.map(storyHtml).join('')}
  </section>`).join('')}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-spec],[data-split],[data-materialize]');
    if (!target) return;
    if (target.dataset.spec) vscode.postMessage({ type: 'spec', id: target.dataset.spec });
    else if (target.dataset.split) vscode.postMessage({ type: 'split', id: target.dataset.split });
    else if (target.dataset.materialize) vscode.postMessage({ type: 'materialize' });
  });
`;

export type StoriesMessage =
  | { type: 'spec'; story: StoryView }
  | { type: 'split'; story: StoryView }
  | { type: 'materialize' };

export class StoriesPanel {
  private static current: StoriesPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: StoriesMessage) => void
  ) {
    this.panel = panel;
    this.store = store;
    this.subscription = store.onDidChange(() => this.render());

    /**
     * The three messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * The plan lookup stays exactly as it was, and is the part that matters: the page names a
     * Story, and which Story that is comes from the plan rather than from the page.
     */
    const storyFor = (message: InboundMessage) => {
      const id = stringField(message, 'id');
      return id
        ? buildStories(this.store.current.snapshot).groups
          .flatMap((group) => group.stories)
          .find((candidate) => candidate.planId === id) ?? null
        : null;
    };
    const router = registerMessageRouter('singularityFlow.stories', {
      materialize: () => onMessage({ type: 'materialize' }),
      spec: (message) => { const story = storyFor(message); if (story) onMessage({ type: 'spec', story }); },
      split: (message) => { const story = storyFor(message); if (story) onMessage({ type: 'split', story }); }
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // this panel's own message contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);

      router.route(raw);
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: StoriesMessage) => void
  ): StoriesPanel {
    if (StoriesPanel.current) {
      StoriesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return StoriesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.stories', 'Stories', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    StoriesPanel.current = new StoriesPanel(panel, store, onMessage);
    return StoriesPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Stories',
      bodyHtml(buildStories(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    StoriesPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
