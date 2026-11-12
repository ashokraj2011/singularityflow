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
import { approvalHoldsHtml, contentSecurityPolicy, escape, navigationTarget, nonce, page, icon } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import type { WorkspaceStore } from '../state.ts';
import { RetainedPanelRenderGate } from '../single-flight.ts';
import { approvalStandingFor, type StoryStanding } from './sf-guard-model.ts';
import { approvalPillHtml, SF_GUARD_STYLE, type StoryRead } from './sf-guard-page.ts';
import type { JourneySfGuard } from './journey.ts';

const STANDING_PILL: Record<string, { className: string; label: string }> = {
  yours: { className: 'ok', label: 'yours to sign' },
  others: { className: 'wait', label: 'with someone else' },
  blocked: { className: 'bad', label: 'cannot proceed' }
};

const KIND_LABEL: Record<string, string> = {
  output: 'Artifact', pack: 'Artifact pack', phase: 'Phase sign-off'
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

/** Who signed, each with SF Guard's verdict on their record when the Story pinned it (signed, pre-signing, bypass, not counted). */
function signaturesHtml(approval: PendingApproval, standing: StoryStanding | null): string {
  if (!approval.signatures.length) return '';
  const signed = approval.signatures.map((signature) => {
    const verdict = approval.source === 'story' ? approvalStandingFor(standing, approval.phase, signature.at) : null;
    return `${approvalPillHtml(verdict)}${escape(signature.actor)}`;
  });
  return `<p class="muted">Signed by ${signed.join(', ')}</p>`;
}

function cardHtml(approval: PendingApproval, standing: StoryStanding | null = null): string {
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
    ${approval.afterApproval ? `<p class="callout"><b>After approval:</b> ${escape(approval.afterApproval)}</p>` : ''}
    ${approval.sha256 ? '<p class="muted">The approval binds the exact bytes of this generation.</p>' : ''}
    ${chainHtml(approval)}
    ${signaturesHtml(approval, standing)}
    ${approval.selfApproval
    ? '<p class="muted">You generated this. Approving it will be recorded as not independent.</p>'
    : ''}
    ${approval.reason ? `<p class="muted">${escape(approval.reason)}</p>` : ''}
    <div class="card-foot">
    ${approval.heldBy ? `<p class="muted">${escape(approval.heldBy.headline)}</p>` : ''}
    ${!approval.heldBy && approval.approvalHolds?.length ? approvalHoldsHtml(approval.approvalHolds) : ''}
      ${approval.standing === 'yours'
    ? `${approval.heldBy || approval.decideNext ? `<button data-decide-list="${escape(approval.id)}">Decide what blocks this step</button>`
      : approval.approvalHolds?.length ? '' : `<button data-approve="${escape(approval.id)}">Approve…</button>`}
         <button class="secondary" data-reject="${escape(approval.id)}">Request changes…</button>`
    : ''}
      ${approval.kind === 'output' || approval.artifactPath
    ? `<button class="link" data-open="${escape(approval.id)}">Open artifact</button>` : ''}
    </div>
  </article>`;
}

function groupHtml(title: string, approvals: PendingApproval[], standing: StoryStanding | null = null): string {
  if (!approvals.length) return '';
  return `<section><h2>${icon('approval')}${escape(title)}</h2>${approvals.map((approval) => cardHtml(approval, standing)).join('')}</section>`;
}

export function approvalsBodyHtml(approvals: Approvals, sfGuard: StoryRead | null = null): string {
  const standing = sfGuard && sfGuard !== 'loading' && !('error' in sfGuard) ? sfGuard : null;
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

  ${yours.length ? groupHtml('Waiting for you', yours, standing) : ''}
  ${groupHtml('With someone else', others, standing)}
  ${groupHtml('Cannot proceed', blocked, standing)}

  ${approvals.obstacles.length ? `
  <section>
    <h2>${icon('gate')}Before this phase can close</h2>
    <ul class="blockers">${approvals.obstacles.map((obstacle) => `<li>${escape(obstacle)}</li>`).join('')}</ul>
  </section>` : ''}`;
}

const SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-approve],[data-reject],[data-open],[data-decide-list]');
    if (!target) return;
    if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.decideList) vscode.postMessage({ type: 'decide-list', id: target.dataset.decideList });
    else if (target.dataset.reject) vscode.postMessage({ type: 'reject', id: target.dataset.reject });
    else if (target.dataset.open) vscode.postMessage({ type: 'open', id: target.dataset.open });
  });
`;

export type ApprovalsMessage =
  | { type: 'approve'; approval: PendingApproval }
  | { type: 'reject'; approval: PendingApproval }
  | { type: 'open'; approval: PendingApproval }
  | { type: 'decide-list'; approval: PendingApproval };

export class ApprovalsPanel {
  private static current: ApprovalsPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly snapshotRenders: RetainedPanelRenderGate;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: ApprovalsMessage) => void,
    private readonly lease: { dispose(): void },
    private readonly sfGuard: JourneySfGuard | null = null
  ) {
    this.panel = panel;
    this.store = store;
    if (sfGuard) this.disposables.push(sfGuard.onDidChange(() => this.render()) as vscode.Disposable);
    this.snapshotRenders = new RetainedPanelRenderGate(
      () => this.panel.visible !== false,
      () => this.render(),
      ['repository', 'lifecycle', 'configuration']
    );
    let unavailable = Boolean(store.current.error || store.current.stale);
    this.subscription = store.onDidChange((state, change) => {
      const next = Boolean(state.error || state.stale);
      const availabilityChanged = next !== unavailable;
      unavailable = next;
      // A fresh not-modified receipt still clears a cached/error notice. Content-slice equality
      // must not leave the view permanently saying it is waiting for repository confirmation.
      this.snapshotRenders.changed(availabilityChanged ? 'availability' : change.kind, change.changedSlices);
    });

    /**
     * The three messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * The id lookup is unchanged and is the security-carrying part: the page names a card, and
     * which approval that is comes from the snapshot rather than from the page. What is added is
     * the closed set — an unrecognised type is reported instead of falling off the end of the chain.
     */
    const approvalFor = (message: InboundMessage) => {
      if (this.store.current.error || this.store.current.stale) return null;
      const id = stringField(message, 'id');
      return id
        ? buildApprovals(this.store.current.snapshot).pending.find((candidate) => candidate.id === id) ?? null
        : null;
    };
    const router = registerMessageRouter('singularityFlow.approvals', {
      approve: (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'approve', approval }); },
      reject: (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'reject', approval }); },
      open: (message) => { const approval = approvalFor(message); if (approval) onMessage({ type: 'open', approval }); },
      'decide-list': (message) => { const approval = approvalFor(message); if (approval?.heldBy || approval?.decideNext) onMessage({ type: 'decide-list', approval }); }
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // each panel's own callback contract, because "go to another page" is not this panel's business.
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      router.route(raw);
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState?.(({ webviewPanel }) => {
      this.snapshotRenders.visibilityChanged(webviewPanel.visible !== false);
    }, null, this.disposables);
    this.render();
  }

  static async show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: ApprovalsMessage) => void,
    sfGuard: JourneySfGuard | null = null
  ): Promise<ApprovalsPanel> {
    if (ApprovalsPanel.current) {
      ApprovalsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return ApprovalsPanel.current;
    }
    const lease = await store.acquireSlices(['configuration']);
    const raced = ApprovalsPanel.current as ApprovalsPanel | null;
    if (raced) {
      lease.dispose();
      raced.panel.reveal(vscode.ViewColumn.Active);
      return raced;
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        'singularityFlow.approvals', 'Approvals', vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
        });
      ApprovalsPanel.current = new ApprovalsPanel(panel, store, onMessage, lease, sfGuard);
    } catch (error) {
      lease.dispose();
      throw error;
    }
    return ApprovalsPanel.current;
  }

  private render(): void {
    this.snapshotRenders.rendered();
    const token = nonce();
    const state = this.store.current;
    const body = state.error
      ? `<header><h1>${icon('approval', { size: 20 })}Approvals</h1></header>
        <div role="alert"><h2>Approvals could not be read</h2><pre>${escape(state.error.message)}</pre>
        <p>The current approval state is unavailable; no approval action is offered.</p></div>`
      : state.stale
        ? `<header><h1>${icon('approval', { size: 20 })}Approvals</h1></header>
          <p>Confirming the current repository before showing approval actions…</p>`
        : approvalsBodyHtml(buildApprovals(state.snapshot), this.sfGuard?.standing(state.snapshot?.workflow) ?? null);
    this.panel.webview.html = page(
      'Approvals',
      body,
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT,
      { nav: 'approvals', styles: SF_GUARD_STYLE }
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ApprovalsPanel.current = null;
    this.subscription.dispose();
    this.snapshotRenders.dispose();
    this.lease.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
