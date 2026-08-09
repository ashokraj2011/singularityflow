/** The business inbox: work needing a decision and every generated artifact. */
import * as vscode from 'vscode';
import { buildInbox, type Inbox, type InboxArtifact } from './inbox-model.ts';
import { buildApprovals, type PendingApproval } from './approvals-model.ts';
import { contentSecurityPolicy, escape, nonce, page, icon } from './webview.ts';
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

function bodyHtml(inbox: Inbox): string {
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
    <section><div class="section-heading"><h2>${icon('approval')}Needs your attention</h2><span class="count-badge">${yours}</span></div>${decisionCards(inbox)}</section>
    <section><div class="section-heading"><h2>${icon('document')}Everything generated</h2><span class="count-badge">${inbox.artifacts.length}</span></div>
      <p class="muted">Every existing governed output across every phase. Open any card to inspect the exact committed file.</p>${artifactRows(inbox)}</section>`;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-artifact],[data-approve],[data-reject],[data-open-approval]');
    if (!target) return;
    if (target.dataset.artifact) vscode.postMessage({ type: 'open-artifact', id: target.dataset.artifact });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.reject) vscode.postMessage({ type: 'reject', id: target.dataset.reject });
    else if (target.dataset.openApproval) vscode.postMessage({ type: 'open-approval', id: target.dataset.openApproval });
  });
`;

export type InboxMessage =
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
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as { type?: unknown; id?: unknown };
      if (typeof message.id !== 'string') return;
      if (message.type === 'open-artifact') {
        const artifact = buildInbox(store.current.snapshot).artifacts.find((item) => item.id === message.id);
        if (artifact) onMessage({ type: 'open-artifact', artifact });
        return;
      }
      const approval = buildApprovals(store.current.snapshot).pending.find((item) => item.id === message.id);
      if (!approval) return;
      if (message.type === 'approve') onMessage({ type: 'approve', approval });
      else if (message.type === 'reject') onMessage({ type: 'reject', approval });
      else if (message.type === 'open-approval') onMessage({ type: 'open-approval', approval });
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
    this.panel.webview.html = page('Inbox', bodyHtml(buildInbox(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token), token, SCRIPT);
  }

  dispose(): void {
    InboxPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
