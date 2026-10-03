/**
 * The journey panel.
 *
 * Security posture, stated because a webview is the one place in an extension where it is easy to be
 * careless: a strict CSP with a per-render nonce, no remote origins, `localResourceRoots` pinned to
 * the extension's own media directory, and every value from the repository HTML-escaped on the way
 * in. Nothing arriving from the page is ever treated as a path or a command — the page can only ask
 * for an action by id, and this file decides what that id means. A postMessage payload is attacker-
 * controlled in principle, and artifact content is written by a model, so neither gets to name a
 * file the extension will open.
 */
import * as vscode from 'vscode';
import { buildJourney, type Journey } from './journey-model.ts';
import { contentSecurityPolicy, escape, navigationTarget, nonce, page, icon } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { registerMessageRouter, stringField } from './messages.ts';
import { decisionTargetText } from '../decisions.ts';
import type { WorkspaceStore } from '../state.ts';
import { deliveryState, isDeliveryKey, pinnedStepActions, type StepActionDeliveryMonitor } from '../step-action-deliveries.ts';
import { deliveriesHtml, type JourneyDeliveries } from './journey-deliveries.ts';

const STATUS_CLASS: Record<string, string> = {
  approved: 'ok',
  awaiting_approval: 'wait',
  in_progress: 'active',
  rejected: 'bad',
  stale: 'warn',
  not_started: 'idle'
};

/**
 * A human label for the next action.
 *
 * The engine hands back a command line. Putting that on a button asks the reader to parse argv to
 * find out what the button does. The verb is the second token, and it is a small closed set, so it
 * can simply be said in words.
 */
const ACTION_VERBS: Record<string, string> = {
  start: 'Start this work item',
  resume: 'Resume this work item',
  agent: 'Run the governed agent',
  prepare: 'Prepare this phase',
  submit: 'Submit for approval',
  approve: 'Approve this phase',
  reject: 'Request changes',
  reopen: 'Reopen this phase',
  finalize: 'Finalize and open the pull request',
  publish: 'Publish this phase',
  define: 'Define this phase',
  sync: 'Sync with the remote',
  next: 'Do the next step'
};

export function actionLabel(nextAction: {
  command: string; argv?: readonly string[]; reason?: string
}): string {
  const tokens = nextAction.argv ?? [];
  // The engine-validated argv is authoritative. Presentation never reparses the shell rendering.
  const verb = tokens.find((token) => /^[a-z][a-z-]*$/.test(token));
  const phase = tokens.find((token, index) => index > 0
    && /^[a-z][a-z-]*$/.test(token) && token !== verb);
  const base = (verb && ACTION_VERBS[verb]) ?? 'Run the next step';
  return verb === 'agent' || verb === 'submit' || verb === 'prepare'
    ? (phase ? `${base} for ${phase}` : base)
    : base;
}

/**
 * The phase rail.
 *
 * This drew wrapped dots with a bare `3/5` beside each one, while the shared design system already
 * carried a numbered rail with connectors and done/current/attention markers — `.phase-rail`, used
 * by the other views. Same information, one vocabulary, and the counter now says what it counts.
 */
const RAIL_STATE: Record<string, string> = {
  approved: 'done',
  awaiting_approval: 'attention',
  rejected: 'attention',
  stale: 'attention',
  in_progress: 'current',
  skipped: 'skipped',
  not_started: ''
};

function railHtml(journey: Journey): string {
  return journey.stages.map((stage, index) => {
    const state = stage.current ? 'current' : (RAIL_STATE[stage.status] ?? '');
    const marker = state === 'done' ? icon('ok', { size: 14 }) : state === 'skipped' ? '–' : String(index + 1);
    const selected = journey.selectedStage?.id === stage.id;
    return `
    <li class="phase-node clickable ${state}${selected ? ' selected' : ''}">
      <button class="phase-select" type="button" data-phase="${escape(stage.id)}"
        aria-pressed="${selected}" aria-label="${escape(stage.label)}: ${escape(String(stage.status).replaceAll('_', ' '))}; ${stage.authored} of ${stage.declared} artifacts">
        <span class="phase-marker">${marker}</span>
        <span class="phase-name">${escape(stage.label)}</span>
        <span class="phase-state">${escape(stage.publicationLabel)} · ${stage.authored}/${stage.declared} artifacts</span>
      </button>
    </li>`;
  }).join('');
}

function artifactsHtml(journey: Journey): string {
  if (!journey.artifacts.length) return '<p class="muted">This phase declares no artifacts.</p>';
  return `<div class="table-wrap"><table class="journey-artifacts">
    <thead><tr><th>Artifact</th><th>Status</th><th>Approved by</th><th>Approved at</th><th></th></tr></thead>
    <tbody>${journey.artifacts.map((artifact) => `
      <tr>
        <td><a class="artifact-link" href="#" data-open="${escape(artifact.id)}" aria-label="Open ${escape(artifact.label)}">${escape(artifact.label)}</a>${artifact.required ? '' : ' <span class="muted">optional</span>'}
          <small>${escape(artifact.path)}</small></td>
        <td><span class="pill ${artifact.status === 'approved' ? 'ok' : artifact.sha256 ? 'wait' : 'idle'}">${escape(artifact.status.replace(/_/g, ' '))}</span></td>
        <td>${artifact.approvals.length
          ? artifact.approvals.map((approval) => escape(approval.actor)).join('<br>')
          : '<span class="muted">Not approved yet</span>'}</td>
        <td>${artifact.approvals.length
          ? artifact.approvals.map((approval) => escape(approvalTime(approval.at))).join('<br>')
          : '<span class="muted">—</span>'}</td>
        <td>${artifact.approvable ? `<button data-approve="${escape(artifact.id)}">Approve</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

function approvalTime(value: string | null): string {
  if (!value) return 'Time unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function approvalSummaryHtml(journey: Journey): string {
  if (!journey.approvals.length) {
    return '<p class="muted approval-empty">No active approval is recorded for this phase.</p>';
  }
  return `<ul class="approval-summary">${journey.approvals.map((approval) => `
    <li>${icon('ok', { size: 14 })}<span><strong>${escape(approval.actor)}</strong>
      ${approval.authority ? `<small>${escape(approval.authority)}</small>` : ''}
      <small>${escape(approvalTime(approval.at))}</small></span></li>`).join('')}</ul>`;
}

function packsHtml(journey: Journey): string {
  if (!journey.packs.length) return '<p class="muted">This profile declares no artifact packs.</p>';
  return `<table>
    <thead><tr><th>Pack</th><th>Members</th><th>Control plane</th></tr></thead>
    <tbody>${journey.packs.map((pack) => `
      <tr>
        <td>${escape(pack.label)}</td>
        <td>${pack.complete}/${pack.total}</td>
        <td>${pack.waitingOn
          ? `<span class="pill wait">${escape(pack.waitingOn)}</span>`
          : pack.approved ? '<span class="pill ok">signed off</span>' : '<span class="muted">not yet complete</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
}

/** The options of a waiting decision; each button chooses one, after the extension asks why. */
function decisionOptionsHtml(journey: Journey): string {
  const pending = journey.decision;
  if (!pending) return '';
  const options = pending.options.map((option) => `
        <div class="decision-option"><button data-decide="${escape(option.id)}">${escape(option.label)}</button>
          <span class="muted">→ ${escape(decisionTargetText(option))}</span></div>`).join('');
  const anyStep = pending.anyStep ? '<div class="decision-option"><button class="secondary" data-decide="__step__">Another step…</button></div>' : '';
  return `<p class="muted">Decided by ${escape(pending.by.join(', ') || 'the step\'s approvers')}.</p>
      <div class="decision-options" role="group" aria-label="${escape(pending.label)}">${options}${anyStep}</div>`;
}

export function journeyBodyHtml(journey: Journey, deliveries: JourneyDeliveries | null = null): string {
  if (journey.empty) return `<div class="empty"><p>${escape(journey.empty)}</p></div>`;

  const blockers = journey.blockers.length
    ? `<section><h2>${icon('bad')}This phase is not ready</h2><ul class="blockers">${
      journey.blockers.map((blocker) => `<li>${escape(blocker)}</li>`).join('')}</ul></section>`
    : journey.gateEvaluated
      ? `<section><h2>${icon('gate')}Gate</h2><p class="ok-text">${icon('ok')}The phase gate reported no blockers.</p></section>`
      : '';

  const sources = `${journey.sources.length
    ? `<ul class="sources">${journey.sources.map((source) => `
        <li>${escape(source.name)} <code>${escape((source.sha256 ?? '').slice(0, 12))}</code></li>`).join('')}</ul>`
    : '<p class="muted">Nothing is pinned. Requirements have no cited source to rest on.</p>'}
    <p><button data-pin="source">Pin a source</button></p>`;

  const stories = journey.repositories.length
    ? journey.repositories.map((repository) => `
        <div class="repo"><h3>${escape(repository.id)}</h3><ul>${repository.stories.map((story) => `
          <li>${escape(story.id)} — ${escape(story.title)}${story.blocking ? '' : ' <span class="muted">non-blocking</span>'}</li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">No Story plan yet.</p>';

  const initiativeOnly = journey.kind === 'initiative' ? `
    ${blockers}
    <section><h2>${icon('document')}Artifact packs</h2>${packsHtml(journey)}</section>
    <section><h2>${icon('document')}Pinned sources</h2>${sources}</section>
    <section><h2>${icon('story')}Stories</h2>${stories}</section>` : '';

  return `
    <header>
      <p class="eyebrow">${journey.kind === 'story' ? 'Story progress' : 'Epic progress'}</p>
      <h1>${icon(journey.kind === 'story' ? 'story' : 'initiative', { size: 20 })}${escape(journey.title)}</h1>
      <p class="meta">${escape(journey.id)} · ${escape(journey.profile)} ·
        branch ${escape(journey.branch ?? 'unknown')} ·
        ${escape(String(journey.status).replaceAll('_', ' '))}</p>
    </header>

    ${journey.nextAction ? `
    <section class="next">
      <h2>${icon('ok')}Next</h2>
      <p>${escape(journey.nextAction.reason)}</p>
      <!-- The button says what pressing it does; the argv is the supporting detail beneath it. It
           was the other way round, so the only filled button on the page was labelled with a raw
           command line and the readable sentence sat above it doing nothing. -->
      ${journey.nextAction.execution === 'decide' && journey.decision ? decisionOptionsHtml(journey) : journey.nextAction.copyable
    ? `<button data-run="next">${escape(journey.nextAction.label ?? actionLabel(journey.nextAction))}</button>`
    : '<p class="muted">Replace the shown placeholders before continuing.</p>'}
      ${journey.decisionAhead ? `<p class="muted">Then: ${escape(journey.decisionAhead.text)}</p>` : ''}
      <div class="command-hint journey-command-routes">
        <p><b>Shell:</b> <code>${escape(journey.nextAction.command)}</code>
          ${journey.nextAction.copyable
    ? `<button type="button" class="secondary" data-copy-route="${escape(journey.nextAction.command)}">Copy shell</button>` : ''}</p>
        <p><b>Copilot:</b> <code>${escape(journey.nextAction.copilotCommand)}</code>
          ${journey.nextAction.copyable
    ? `<button type="button" class="secondary" data-copy-route="${escape(journey.nextAction.copilotCommand)}">Copy Copilot</button>` : ''}</p>
      </div>
    </section>` : ''}

    <section class="journey-rail"><h2>${icon('epic')}Lifecycle</h2>
      <p class="muted">Select a phase to inspect its governed artifacts and approvals.</p>
      <ol class="phase-rail">${railHtml(journey)}</ol>
    </section>

    <section class="phase-detail" aria-live="polite">
      <div class="phase-detail-heading">
        <div><p class="eyebrow">Selected phase</p><h2>${escape(journey.selectedStage?.label ?? 'Phase details')}</h2></div>
        ${journey.selectedStage?.current ? '<span class="pill wait">Active now</span>' : ''}
      </div>
      ${artifactsHtml(journey)}
      <h3>${icon('approval', { size: 14 })}Phase approvals</h3>
      ${approvalSummaryHtml(journey)}
    </section>

    ${deliveriesHtml(deliveries, journey)}

    ${initiativeOnly}`;
}

/** The page can only name an action and an id. What either means is decided by the extension. */
export const JOURNEY_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-phase],[data-open],[data-approve],[data-run],[data-pin],[data-copy-route],[data-decide],[data-retry],[data-retry-all]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.copyRoute) navigator.clipboard.writeText(target.dataset.copyRoute).catch(() => {});
    else if (target.dataset.retry) { target.disabled = true; vscode.postMessage({ type: 'retryDelivery', key: target.dataset.retry }); }
    else if (target.hasAttribute('data-retry-all')) { target.disabled = true; vscode.postMessage({ type: 'retryDeliveries' }); }
    else if (target.dataset.phase) vscode.postMessage({ type: 'phase', id: target.dataset.phase });
    else if (target.dataset.open) vscode.postMessage({ type: 'open', id: target.dataset.open });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.run) vscode.postMessage({ type: 'run' });
    else if (target.dataset.decide) vscode.postMessage({ type: 'decide', option: target.dataset.decide });
    else if (target.dataset.pin) vscode.postMessage({ type: 'pin' });
  });
`;

export type JourneyMessage =
  | { type: 'open'; outputId: string }
  | { type: 'approve'; outputId: string }
  | { type: 'run' }
  | { type: 'decide'; option: string | null }
  | { type: 'pin' };

function journeySubjectKey(store: WorkspaceStore): string | null {
  const journey = buildJourney(store.current.snapshot);
  if (!journey.id) return null;
  return `${store.current.snapshot?.repository?.root ?? ''}\0${journey.kind}\0${journey.id}`;
}

export class JourneyPanel {
  private static current: JourneyPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private selectedStageId: string | null = null;
  private subjectKey: string | null;
  private readonly deliveries: StepActionDeliveryMonitor | null;

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: JourneyMessage) => void,
    deliveries: StepActionDeliveryMonitor | null = null
  ) {
    this.panel = panel;
    this.store = store;
    this.deliveries = deliveries;
    this.subjectKey = journeySubjectKey(store);
    this.subscription = store.onDidChange(() => {
      const nextSubject = journeySubjectKey(this.store);
      if (nextSubject !== this.subjectKey) this.selectedStageId = null;
      this.subjectKey = nextSubject;
      this.render();
    });
    if (deliveries) this.disposables.push(deliveries.onDidUpdate(() => this.render()) as vscode.Disposable);

    /**
     * The five messages this panel speaks, enumerated. `[UXH:REQ-134]` `[UXH:AC-014]`
     *
     * Was an if-chain with no final else, so a type outside it was dropped in silence —
     * indistinguishable from one that was handled, which is why the bug it hides is a control that
     * appears to do nothing. The keys are now the contract, and an unrecognised type is reported.
     *
     * Per-field coercion is unchanged: `stringField` returns null for anything that is not a
     * non-empty string, exactly as the `typeof … !== 'string'` guard did. The gap being closed is
     * the open type set, not the field checks, which were already careful.
     */
    const router = registerMessageRouter('singularityFlow.journey', {
      phase: (message) => {
        const stageId = stringField(message, 'id');
        const journey = buildJourney(this.store.current.snapshot, stageId);
        if (!stageId || !journey.stages.some((stage) => stage.id === stageId)) return;
        this.selectedStageId = stageId;
        this.render();
      },
      run: () => onMessage({ type: 'run' }),
      decide: (message) => onMessage({ type: 'decide', option: stringField(message, 'option') }),
      pin: () => onMessage({ type: 'pin' }),
      open: (message) => {
        const outputId = stringField(message, 'id');
        // An id is looked up against the snapshot by the receiver, never used as a path.
        if (outputId) onMessage({ type: 'open', outputId });
      },
      approve: (message) => {
        const outputId = stringField(message, 'id');
        if (outputId) onMessage({ type: 'approve', outputId });
      },
      // A key is retried only when this Story listed it; the monitor checks that again.
      retryDelivery: (message) => {
        const key = stringField(message, 'key');
        if (isDeliveryKey(key)) void this.retryDeliveries([key]);
      },
      retryDeliveries: () => {
        const workId = this.store.current.snapshot?.workflow?.workItem?.id;
        const open = workId && this.deliveries
          ? this.deliveries.deliveriesFor(workId).deliveries.filter((delivery) => deliveryState(delivery).retryable).map((delivery) => delivery.key)
          : [];
        void this.retryDeliveries(open);
      }
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // The shared footer is the one way out of a full-page view. Handled here rather than through
      // each panel's own callback contract, because "go to another page" is not this panel's business.
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
    onMessage: (message: JourneyMessage) => void,
    deliveries: StepActionDeliveryMonitor | null = null
  ): JourneyPanel {
    if (JourneyPanel.current) {
      JourneyPanel.current.panel.reveal(vscode.ViewColumn.Active);
      JourneyPanel.current.refreshDeliveries();
      return JourneyPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.journey', 'Work journey', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Nothing outside the extension's own media directory is loadable, and nothing is loaded today.
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    JourneyPanel.current = new JourneyPanel(panel, store, onMessage, deliveries);
    JourneyPanel.current.refreshDeliveries();
    return JourneyPanel.current;
  }

  /** Opening the Journey reads this machine's deliveries fresh, whatever the last read saw. */
  private refreshDeliveries(): void {
    const workId = this.store.current.snapshot?.workflow?.workItem?.id;
    if (this.deliveries && workId && pinnedStepActions(this.store.current.snapshot?.workflow).length) void this.deliveries.refresh(workId);
  }

  private async retryDeliveries(keys: string[]): Promise<void> {
    const workId = this.store.current.snapshot?.workflow?.workItem?.id;
    if (!this.deliveries || !workId || !keys.length) { this.render(); return; }
    try {
      const summary = await this.deliveries.retry(workId, keys);
      void vscode.window.setStatusBarMessage(`$(send) ${summary}`, 6_000);
    } catch (error) {
      void vscode.window.showWarningMessage(`The deliveries were not retried: ${(error as Error).message}`);
    }
    this.render();
  }

  private deliveriesView(): JourneyDeliveries | null {
    const workflow = this.store.current.snapshot?.workflow;
    const workId = workflow?.workItem?.id;
    const pinned = pinnedStepActions(workflow);
    if (!this.deliveries || !workId || !pinned.length) return null;
    return { pinned, ...this.deliveries.deliveriesFor(workId) };
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Journey',
      journeyBodyHtml(buildJourney(this.store.current.snapshot, this.selectedStageId), this.deliveriesView()),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      JOURNEY_SCRIPT,
      { nav: 'journey' }
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (JourneyPanel.current === this) JourneyPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
