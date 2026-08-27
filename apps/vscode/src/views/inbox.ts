/** The business inbox: work needing a decision and every generated artifact. */
import * as vscode from 'vscode';
import { buildInbox, type Inbox, type InboxArtifact } from './inbox-model.ts';
import { buildApprovals, type PendingApproval } from './approvals-model.ts';
import { contentSecurityPolicy, escape, icon, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import type { WorkspaceStore } from '../state.ts';

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

function decisionCards(inbox: Inbox): string {
  const decisions = inbox.approvals.pending.filter((approval) => approval.standing === 'yours');
  if (!decisions.length) return `<p class="ok-text">${icon('ok')}Nothing is waiting for your decision.</p>`;
  return `<div class="decision-cards">${decisions.map((approval) => `
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

function activeStoryCards(inbox: Inbox): string {
  if (!inbox.activeStories.length) return '';
  return `<section class="active-story-switcher" aria-labelledby="active-stories-heading">
    <div class="section-heading"><div><h2 id="active-stories-heading">${icon('story')}Active Stories</h2>
      <p class="muted">Switching opens the Story's isolated checkout in this window. It does not change another Story.</p></div>
      <span class="count-badge">${inbox.activeStories.length}</span></div>
    <div class="active-story-grid">${inbox.activeStories.map((story) => `
      <button type="button" class="active-story-card${story.current ? ' current' : ''}"
        data-story="${escape(story.workId)}"${story.current ? ' aria-current="page"' : ''}>
        <span class="active-story-title">${icon(story.current ? 'statusCurrent' : 'story')}${escape(story.workId)}</span>
        <span class="active-story-phase">${escape(story.phase)}</span>
        <small>${escape(story.title)}</small>
        <span class="active-story-action">${story.current ? 'Current checkout' : 'Open checkout'}${icon('next')}</span>
      </button>`).join('')}</div>
  </section>`;
}

export function inboxHtml(inbox: Inbox): string {
  if (inbox.empty) return `<div class="brand-lockup"><strong>SINGULARITY</strong><span>FLOW</span></div>
    <header><h1>${icon('approval', { size: 20 })}Inbox</h1></header><div class="empty"><p>${escape(inbox.empty)}</p></div>`;
  const yours = inbox.approvals.pending.filter((approval) => approval.standing === 'yours').length;
  const other = inbox.approvals.pending.length - yours;
  const approved = inbox.artifacts.filter((artifact) => artifact.status === 'approved').length;
  return `
    <div class="brand-lockup"><strong>SINGULARITY</strong><span>FLOW</span></div>
    <header class="inbox-header">
      <div><span class="eyebrow">BUSINESS WORKSPACE</span><h1>${icon('approval', { size: 20 })}Inbox</h1>
      <p class="meta">${escape(inbox.subjectId)}${inbox.subjectLabel && inbox.subjectLabel !== inbox.subjectId ? ` · ${escape(inbox.subjectLabel)}` : ''}</p></div>
    </header>
    <div class="summary-grid">
      <div class="summary-card important"><strong>${yours}</strong><span>Waiting for you</span></div>
      <div class="summary-card"><strong>${inbox.artifacts.length}</strong><span>Generated artifacts</span></div>
      <div class="summary-card"><strong>${approved}</strong><span>Approved</span></div>
      <div class="summary-card"><strong>${other}</strong><span>With other reviewers</span></div>
    </div>
    ${activeStoryCards(inbox)}
    <section><div class="section-heading"><h2>${icon('approval')}Needs your attention</h2><span class="count-badge">${yours}</span></div>${decisionCards(inbox)}</section>
    <section><div class="section-heading"><h2>${icon('document')}Everything generated</h2><span class="count-badge">${inbox.artifacts.length}</span></div>
      <p class="muted">Every existing governed output across every phase. Open any card to inspect the exact committed file.</p>${artifactRows(inbox)}</section>`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-story],[data-artifact],[data-approve],[data-reject],[data-open-approval]');
    if (!target) return;
    if (target.dataset.story) vscode.postMessage({ type: 'attach-story', id: target.dataset.story });
    else if (target.dataset.artifact) vscode.postMessage({ type: 'open-artifact', id: target.dataset.artifact });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.reject) vscode.postMessage({ type: 'reject', id: target.dataset.reject });
    else if (target.dataset.openApproval) vscode.postMessage({ type: 'open-approval', id: target.dataset.openApproval });
  });
`;

export type InboxMessage =
  | { type: 'attach-story'; workId: string }
  | { type: 'open-artifact'; artifact: InboxArtifact }
  | { type: 'approve'; approval: PendingApproval }
  | { type: 'reject'; approval: PendingApproval }
  | { type: 'open-approval'; approval: PendingApproval };

export class InboxPanel {
  private static current: InboxPanel | null = null;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly store: WorkspaceStore,
    onMessage: (message: InboxMessage) => void
  ) {
    this.subscription = store.onDidChange(() => this.render());
    /**
     * The four messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
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
      'attach-story': (message) => {
        const workId = stringField(message, 'id');
        const exists = buildInbox(store.current.snapshot).activeStories.some((item) => item.workId === workId);
        if (workId && exists) onMessage({ type: 'attach-story', workId });
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
      'open-approval': (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'open-approval', approval }); }
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

  static show(context: vscode.ExtensionContext, store: WorkspaceStore, onMessage: (message: InboxMessage) => void): InboxPanel {
    if (InboxPanel.current) {
      InboxPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return InboxPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.inboxPanel', 'Inbox', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    InboxPanel.current = new InboxPanel(panel, store, onMessage);
    return InboxPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page('Inbox', inboxHtml(buildInbox(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  dispose(): void {
    InboxPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
