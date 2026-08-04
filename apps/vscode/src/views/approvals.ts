/**
 * The approvals panel.
 *
 * One card per decision, ordered by whose decision it is. A reviewer opening this should be able to
 * answer "is anything waiting for me" without reading anything they cannot act on, so what is theirs
 * comes first and everything else is grouped under a heading that says who is being waited for.
 *
 * Approving still goes through the receipt flow with its typed confirmation — the panel makes the
 * decision easy to find, not easy to make by accident.
 */
import * as vscode from 'vscode';
import { buildApprovals, type Approvals, type PendingApproval } from './approvals-model.ts';
import { contentSecurityPolicy, escape, nonce, page, icon } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';

const STANDING_PILL: Record<string, { className: string; label: string }> = {
  yours: { className: 'ok', label: 'yours to sign' },
  others: { className: 'wait', label: 'with someone else' },
  blocked: { className: 'bad', label: 'cannot proceed' }
};

const KIND_LABEL: Record<string, string> = {
  output: 'Artifact', pack: 'Artifact pack', phase: 'Phase gate'
};

function chainHtml(approval: PendingApproval): string {
  if (!approval.chain.length) {
    return approval.authorities.length
      ? `<p class="muted">${escape(approval.authorities.join(', '))}</p>`
      : '';
  }
  return `<ul class="chain">${approval.chain.map((step) => `
    <li class="${step.satisfied ? 'satisfied' : step.open ? 'open' : ''}">
      ${icon(step.satisfied ? 'ok' : 'wait')} ${escape(step.label)}
      <span class="muted">${step.signatures}/${step.minimum}</span>
    </li>`).join('')}</ul>`;
}

function cardHtml(approval: PendingApproval): string {
  const pill = STANDING_PILL[approval.standing] ?? STANDING_PILL['blocked'];
  return `
  <article class="card ${escape(approval.standing)}">
    <div class="card-head">
      <h3>${escape(approval.label)}</h3>
      <span class="pill ${pill?.className ?? ''}">${escape(pill?.label ?? '')}</span>
      <span class="grow"></span>
      <span class="muted">${escape(KIND_LABEL[approval.kind] ?? approval.kind)}</span>
    </div>
    <p class="muted">${escape(approval.detail)}</p>
    ${approval.sha256 ? `<p><code>${escape(approval.sha256.slice(0, 16))}</code> <span class="muted">the exact bytes being approved</span></p>` : ''}
    ${chainHtml(approval)}
    ${approval.signatures.length
    ? `<p class="muted">Signed by ${approval.signatures.map((signature) => escape(signature.actor)).join(', ')}</p>`
    : ''}
    ${approval.selfApproval
    ? '<p class="muted">You generated this. Approving it will be recorded as not independent.</p>'
    : ''}
    ${approval.reason ? `<p class="muted">${escape(approval.reason)}</p>` : ''}
    <div class="card-foot">
      ${approval.standing === 'yours'
    ? `<button data-approve="${escape(approval.id)}">Approve…</button>
         <button class="secondary" data-reject="${escape(approval.id)}">Reject…</button>`
    : ''}
      ${approval.kind === 'output' || approval.artifactPath
    ? `<button class="link" data-open="${escape(approval.id)}">Open artifact</button>` : ''}
    </div>
  </article>`;
}

function groupHtml(title: string, approvals: PendingApproval[]): string {
  if (!approvals.length) return '';
  return `<section><h2>${icon('approval')}${escape(title)}</h2>${approvals.map(cardHtml).join('')}</section>`;
}

function bodyHtml(approvals: Approvals): string {
  if (approvals.empty) {
    return `<header><h1>${icon('approval', { size: 20 })}Approvals</h1></header>
      <div class="empty"><p>${escape(approvals.empty)}</p></div>`;
  }

  const yours = approvals.pending.filter((approval) => approval.standing === 'yours');
  const others = approvals.pending.filter((approval) => approval.standing === 'others');
  const blocked = approvals.pending.filter((approval) => approval.standing === 'blocked');

  return `
  <header>
    <h1>${icon('approval', { size: 20 })}Approvals</h1>
    <p class="meta">
      ${escape(approvals.initiativeId)} ·
      ${yours.length ? `<strong>${yours.length} waiting for you</strong>` : 'nothing waiting for you'}
      ${approvals.actor ? ` · signing as ${escape(approvals.actor)}` : ' · no Git identity configured'}
    </p>
  </header>

  ${yours.length ? groupHtml('Waiting for you', yours) : ''}
  ${groupHtml('With someone else', others)}
  ${groupHtml('Cannot proceed', blocked)}

  ${approvals.obstacles.length ? `
  <section>
    <h2>${icon('gate')}Before this phase can close</h2>
    <ul class="blockers">${approvals.obstacles.map((obstacle) => `<li>${escape(obstacle)}</li>`).join('')}</ul>
  </section>` : ''}`;
}

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-approve],[data-reject],[data-open]');
    if (!target) return;
    if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.reject) vscode.postMessage({ type: 'reject', id: target.dataset.reject });
    else if (target.dataset.open) vscode.postMessage({ type: 'open', id: target.dataset.open });
  });
`;

export type ApprovalsMessage =
  | { type: 'approve'; approval: PendingApproval }
  | { type: 'reject'; approval: PendingApproval }
  | { type: 'open'; approval: PendingApproval };

export class ApprovalsPanel {
  private static current: ApprovalsPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: ApprovalsMessage) => void
  ) {
    this.panel = panel;
    this.store = store;
    this.subscription = store.onDidChange(() => this.render());

    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as { type?: unknown; id?: unknown };
      if (typeof message?.id !== 'string') return;
      // The page names a card; which approval that is comes from the snapshot, not the page.
      const approval = buildApprovals(this.store.current.snapshot).pending
        .find((candidate) => candidate.id === message.id);
      if (!approval) return;
      if (message.type === 'approve') onMessage({ type: 'approve', approval });
      else if (message.type === 'reject') onMessage({ type: 'reject', approval });
      else if (message.type === 'open') onMessage({ type: 'open', approval });
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: ApprovalsMessage) => void
  ): ApprovalsPanel {
    if (ApprovalsPanel.current) {
      ApprovalsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ApprovalsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.approvals', 'Approvals', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      });
    ApprovalsPanel.current = new ApprovalsPanel(panel, store, onMessage);
    return ApprovalsPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Approvals',
      bodyHtml(buildApprovals(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    ApprovalsPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
