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
import { contentSecurityPolicy, escape, nonce, page, icon } from './webview.ts';
import type { WorkspaceStore } from '../state.ts';

const STATUS_CLASS: Record<string, string> = {
  approved: 'ok',
  awaiting_approval: 'wait',
  in_progress: 'active',
  rejected: 'bad',
  stale: 'warn',
  not_started: 'idle'
};

function railHtml(journey: Journey): string {
  return journey.stages.map((stage) => `
    <li class="stage ${STATUS_CLASS[stage.status] ?? 'idle'}${stage.current ? ' current' : ''}">
      <span class="dot"></span>
      <span class="name">${escape(stage.label)}</span>
      <span class="count">${stage.authored}/${stage.declared}</span>
    </li>`).join('');
}

function artifactsHtml(journey: Journey): string {
  if (!journey.artifacts.length) return '<p class="muted">This phase declares no artifacts.</p>';
  return `<table>
    <thead><tr><th>Artifact</th><th>Status</th><th></th></tr></thead>
    <tbody>${journey.artifacts.map((artifact) => `
      <tr>
        <td><a href="#" data-open="${escape(artifact.id)}">${escape(artifact.label)}</a>${artifact.required ? '' : ' <span class="muted">optional</span>'}</td>
        <td><span class="pill ${artifact.status === 'approved' ? 'ok' : artifact.sha256 ? 'wait' : 'idle'}">${escape(artifact.status.replace(/_/g, ' '))}</span></td>
        <td>${artifact.approvable ? `<button data-approve="${escape(artifact.id)}">Approve</button>` : ''}</td>
      </tr>`).join('')}</tbody></table>`;
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

function bodyHtml(journey: Journey): string {
  if (journey.empty) return `<div class="empty"><p>${escape(journey.empty)}</p></div>`;

  const blockers = journey.blockers.length
    ? `<section><h2>${icon('bad')}This phase is not ready</h2><ul class="blockers">${
      journey.blockers.map((blocker) => `<li>${escape(blocker)}</li>`).join('')}</ul></section>`
    : `<section><h2>${icon('gate')}Gate</h2><p class="ok-text">${icon('ok')}Every requirement of this phase is satisfied.</p></section>`;

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

  return `
    <header>
      <h1>${icon('initiative', { size: 20 })}${escape(journey.title)}</h1>
      <p class="meta">${escape(journey.id)} · ${escape(journey.profile)} · branch ${escape(journey.branch ?? 'unknown')} · ${escape(journey.status)}</p>
    </header>

    ${journey.nextAction ? `
    <section class="next">
      <h2>${icon('ok')}Next</h2>
      <p>${escape(journey.nextAction.reason)}</p>
      <button data-run="next">${escape(journey.nextAction.command)}</button>
    </section>` : ''}

    <section><h2>${icon('epic')}Lifecycle</h2><ul class="rail">${railHtml(journey)}</ul></section>

    <section>
      <h2>${escape(journey.currentStage?.label ?? 'Current phase')}</h2>
      ${artifactsHtml(journey)}
    </section>

    ${blockers}

    <section><h2>${icon('document')}Artifact packs</h2>${packsHtml(journey)}</section>
    <section><h2>${icon('document')}Pinned sources</h2>${sources}</section>
    <section><h2>${icon('story')}Stories</h2>${stories}</section>`;
}

/** The page can only name an action and an id. What either means is decided by the extension. */
const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-open],[data-approve],[data-run],[data-pin]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.open) vscode.postMessage({ type: 'open', id: target.dataset.open });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.run) vscode.postMessage({ type: 'run' });
    else if (target.dataset.pin) vscode.postMessage({ type: 'pin' });
  });
`;

export type JourneyMessage =
  | { type: 'open'; outputId: string }
  | { type: 'approve'; outputId: string }
  | { type: 'run' }
  | { type: 'pin' };

export class JourneyPanel {
  private static current: JourneyPanel | null = null;

  private readonly panel: vscode.WebviewPanel;
  private readonly store: WorkspaceStore;
  private readonly subscription: { dispose(): void };
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    store: WorkspaceStore,
    onMessage: (message: JourneyMessage) => void
  ) {
    this.panel = panel;
    this.store = store;
    this.subscription = store.onDidChange(() => this.render());

    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      // Treated as untrusted input: only the shapes below are recognised, and an id is looked up
      // against the snapshot rather than used as a path.
      const message = raw as { type?: unknown; id?: unknown };
      if (message?.type === 'run') return onMessage({ type: 'run' });
      if (message?.type === 'pin') return onMessage({ type: 'pin' });
      if (typeof message?.id !== 'string') return;
      if (message.type === 'open') return onMessage({ type: 'open', outputId: message.id });
      if (message.type === 'approve') return onMessage({ type: 'approve', outputId: message.id });
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    store: WorkspaceStore,
    onMessage: (message: JourneyMessage) => void
  ): JourneyPanel {
    if (JourneyPanel.current) {
      JourneyPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return JourneyPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('singularityFlow.journey', 'Epic journey', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      // Nothing outside the extension's own media directory is loadable, and nothing is loaded today.
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
    });
    JourneyPanel.current = new JourneyPanel(panel, store, onMessage);
    return JourneyPanel.current;
  }

  private render(): void {
    const token = nonce();
    this.panel.webview.html = page(
      'Journey',
      bodyHtml(buildJourney(this.store.current.snapshot)),
      contentSecurityPolicy(this.panel.webview, token),
      token,
      SCRIPT
    );
  }

  dispose(): void {
    JourneyPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
