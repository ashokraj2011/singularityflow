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
import type { WorkspaceStore } from '../state.ts';

/** Everything that reaches the page goes through this. */
function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nonce(): string {
  // Not a secret — a CSP nonce only has to be unpredictable per render.
  let value = '';
  for (let index = 0; index < 32; index += 1) value += Math.floor(Math.random() * 16).toString(16);
  return value;
}

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
    ? `<section><h2>This phase is not ready</h2><ul class="blockers">${
      journey.blockers.map((blocker) => `<li>${escape(blocker)}</li>`).join('')}</ul></section>`
    : '<section><h2>Gate</h2><p class="ok-text">Every requirement of this phase is satisfied.</p></section>';

  const sources = journey.sources.length
    ? `<ul class="sources">${journey.sources.map((source) => `
        <li>${escape(source.name)} <code>${escape((source.sha256 ?? '').slice(0, 12))}</code></li>`).join('')}</ul>`
    : '<p class="muted">Nothing is pinned. Requirements have no cited source to rest on.</p>';

  const stories = journey.repositories.length
    ? journey.repositories.map((repository) => `
        <div class="repo"><h3>${escape(repository.id)}</h3><ul>${repository.stories.map((story) => `
          <li>${escape(story.id)} — ${escape(story.title)}${story.blocking ? '' : ' <span class="muted">non-blocking</span>'}</li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">No Story plan yet.</p>';

  return `
    <header>
      <h1>${escape(journey.title)}</h1>
      <p class="meta">${escape(journey.id)} · ${escape(journey.profile)} · branch ${escape(journey.branch ?? 'unknown')} · ${escape(journey.status)}</p>
    </header>

    ${journey.nextAction ? `
    <section class="next">
      <h2>Next</h2>
      <p>${escape(journey.nextAction.reason)}</p>
      <button data-run="next">${escape(journey.nextAction.command)}</button>
    </section>` : ''}

    <section><h2>Lifecycle</h2><ul class="rail">${railHtml(journey)}</ul></section>

    <section>
      <h2>${escape(journey.currentStage?.label ?? 'Current phase')}</h2>
      ${artifactsHtml(journey)}
    </section>

    ${blockers}

    <section><h2>Artifact packs</h2>${packsHtml(journey)}</section>
    <section><h2>Pinned sources</h2>${sources}</section>
    <section><h2>Stories</h2>${stories}</section>`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0 1.2rem 3rem; line-height: 1.5; }
  h1 { font-size: 1.5rem; margin: 1.2rem 0 .2rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em;
       color: var(--vscode-descriptionForeground); margin: 2rem 0 .6rem; }
  h3 { font-size: .95rem; margin: .8rem 0 .3rem; }
  .meta { color: var(--vscode-descriptionForeground); margin: 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .ok-text { color: var(--vscode-testing-iconPassed, #3fb950); }
  section { border-top: 1px solid var(--vscode-panel-border); }
  header, section.next { border: 0; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: .78rem; text-transform: uppercase;
       letter-spacing: .05em; color: var(--vscode-descriptionForeground);
       border-bottom: 1px solid var(--vscode-panel-border); padding: .3rem .5rem .3rem 0; }
  td { padding: .35rem .5rem .35rem 0; border-bottom: 1px solid var(--vscode-panel-border); }
  a { color: var(--vscode-textLink-foreground); }
  code { font-family: var(--vscode-editor-font-family); font-size: .85em; }
  button { font-family: inherit; font-size: .85em; padding: .25rem .7rem; cursor: pointer;
           border: 0; border-radius: 2px;
           background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .rail { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem 1.4rem; }
  .stage { display: flex; align-items: center; gap: .45rem; padding: .25rem 0; }
  .stage .dot { width: .6rem; height: .6rem; border-radius: 50%;
                background: var(--vscode-descriptionForeground); flex: 0 0 auto; }
  .stage.ok .dot { background: var(--vscode-testing-iconPassed, #3fb950); }
  .stage.wait .dot { background: var(--vscode-testing-iconQueued, #d29922); }
  .stage.active .dot { background: var(--vscode-textLink-foreground); }
  .stage.bad .dot { background: var(--vscode-testing-iconFailed, #f85149); }
  .stage.current .name { font-weight: 700; }
  .stage .count { color: var(--vscode-descriptionForeground); font-size: .8em; }
  .pill { font-size: .78em; padding: .1rem .5rem; border-radius: 999px;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill.ok { background: var(--vscode-testing-iconPassed, #3fb950); color: #06210d; }
  .pill.wait { background: var(--vscode-testing-iconQueued, #d29922); color: #241a00; }
  .blockers li { margin: .2rem 0; }
  .sources { padding-left: 1.1rem; }
  .empty { padding: 3rem 0; color: var(--vscode-descriptionForeground); }
`;

function html(journey: Journey, csp: string, token: string): string {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Journey</title>
<style nonce="${token}">${STYLE}</style>
</head><body>
${bodyHtml(journey)}
<script nonce="${token}">
  const vscode = acquireVsCodeApi();
  // The page can only name an action and an id. What either means is decided by the extension.
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-open],[data-approve],[data-run]');
    if (!target) return;
    event.preventDefault();
    if (target.dataset.open) vscode.postMessage({ type: 'open', id: target.dataset.open });
    else if (target.dataset.approve) vscode.postMessage({ type: 'approve', id: target.dataset.approve });
    else if (target.dataset.run) vscode.postMessage({ type: 'run' });
  });
</script>
</body></html>`;
}

export type JourneyMessage =
  | { type: 'open'; outputId: string }
  | { type: 'approve'; outputId: string }
  | { type: 'run' };

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
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${token}'`,
      `script-src 'nonce-${token}'`,
      `img-src ${this.panel.webview.cspSource}`
    ].join('; ');
    this.panel.webview.html = html(buildJourney(this.store.current.snapshot), csp, token);
  }

  dispose(): void {
    JourneyPanel.current = null;
    this.subscription.dispose();
    this.panel.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
