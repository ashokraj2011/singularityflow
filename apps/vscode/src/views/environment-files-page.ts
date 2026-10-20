/**
 * The Environment Files page. [ENVF, docs/SPEC-ENVIRONMENT-FILES-v1.md, VS Code]
 *
 * Markup only. Environment tabs (dev | uat | …) above the files of the selected environment,
 * grouped by repository, then by app (capability or source root). Each file shows its path, whether
 * it is declared for the team or personal, its status, where the real file is kept and its location
 * (a path), its template, and whether Git ignores it in this clone, with the actions its status
 * allows. Above the files: the workspace folder for the environment, Add personal file… and
 * Declare for the team, which shows the engine's environments.yml draft to copy and propose.
 *
 * What a file holds is never on this page: the engine never reports it, and Open edits the real file
 * in VS Code's own editor. Every button posts a message the host checks again.
 */
import { brandLockup, escape, icon } from './webview.ts';
import type { EnvironmentFilesView, FileRow, RepositoryGroup } from './environment-files-model.ts';

const UNTRUSTED_NOTE = 'This workspace is not trusted, so nothing here creates, links or moves a file. Trust it (Manage Workspace Trust) to change files; Open and Reveal still work.';

function actionsHtml(view: EnvironmentFilesView, row: FileRow): string {
  if (!row.actions.length) return '';
  return `<div class="ef-actions">${row.actions.map(({ action, label, changes }, index) => {
    const blocked = view.busy || changes && !view.trusted;
    return `<button type="button" class="${index === 0 ? '' : 'secondary '}compact-action" data-ef-action="${escape(action)}" data-ef-key="${escape(row.key)}"${
      blocked ? ' disabled' : ''}${changes && !view.trusted ? ' title="Trust this workspace to change files"' : ''}>${escape(label)}</button>`;
  }).join('')}</div>`;
}

function fileHtml(view: EnvironmentFilesView, row: FileRow): string {
  const facts = [
    row.template ? `<dt>Template</dt><dd><code>${escape(row.template)}</code></dd>` : '<dt>Template</dt><dd class="muted">None beside it</dd>',
    row.source ? `<dt>Kept in</dt><dd>${escape(row.source)}</dd>` : '',
    row.location ? `<dt>${row.locationLabel}</dt><dd><code class="ef-location">${escape(row.location)}</code></dd>` : '',
    row.excluded ? `<dt>Git</dt><dd>${escape(row.excluded)}</dd>` : ''
  ].join('');
  return `<li class="ef-file" data-ef-file="${escape(row.key)}" data-ef-status="${escape(row.status)}">
    <div class="ef-file-main"><code class="ef-path">${escape(row.path)}</code>
      <span class="pill ${row.tone}" data-ef-badge>${escape(row.statusWords)}</span>
      <span class="pill ef-kind" data-ef-kind="${escape(row.kind)}">${escape(row.kindWords)}</span></div>
    <p class="ef-detail muted">${escape(row.detail)}</p>
    <dl class="ef-facts">${facts}</dl>
    ${actionsHtml(view, row)}
  </li>`;
}

function repositoryHtml(view: EnvironmentFilesView, group: RepositoryGroup): string {
  const count = `${group.total} file${group.total === 1 ? '' : 's'}${group.missing ? ` · ${group.missing} missing` : ''}`;
  return `<section class="ef-repository" data-ef-repository="${escape(group.id)}">
    <h2>${icon(group.id ? 'repository' : 'workspace')}<span>${escape(group.label)}</span> <small class="muted">${escape(count)}</small></h2>
    ${group.apps.map((app) => `<div class="ef-app" data-ef-app="${escape(app.id)}"><h3>${icon('delivery')}${escape(app.label)}</h3>
      <ul class="ef-files">${app.files.map((row) => fileHtml(view, row)).join('')}</ul></div>`).join('')}
  </section>`;
}

function tabsHtml(view: EnvironmentFilesView): string {
  if (!view.tabs.length) return '';
  return `<div class="ef-tabs" role="tablist" aria-label="Environments">${view.tabs.map((tab) => `<button type="button" role="tab" class="ef-tab" data-ef-environment="${escape(tab.name)}" aria-selected="${tab.selected}"${
    view.busy ? ' disabled' : ''}>${escape(tab.name)} <small class="muted">${tab.total ? `${tab.total}${tab.missing ? ` · ${tab.missing} missing` : ''}` : 'none'}</small></button>`).join('')}</div>`;
}

function workspaceHtml(view: EnvironmentFilesView): string {
  const environment = view.environment;
  const declare = `<button type="button" class="secondary compact-action" data-ef-workspace="suggest"${view.busy ? ' disabled' : ''}>${icon('team')}Declare for the team</button>`;
  // No environment is declared yet: the team's draft is the way to declare one.
  if (!environment) return `<section class="plain ef-workspace"><div class="ef-buttons">${declare}</div></section>`;
  const changing = view.busy || !view.trusted ? ' disabled' : '';
  const folder = view.root.directory
    ? `<code class="ef-location">${escape(view.root.directory)}</code>`
    : view.root.set ? '<span>Set for this workspace.</span>' : '<span class="muted">Not set: each repository keeps its files in its own private store.</span>';
  return `<section class="plain ef-workspace" aria-label="${escape(`For ${environment}`)}">
    <div class="ef-root"><strong>Folder for ${escape(environment)}</strong> ${folder}
      <span class="ef-buttons"><button type="button" class="secondary compact-action" data-ef-workspace="root-set"${changing}>${icon('directory')}Set folder for ${escape(environment)}…</button>
      ${view.root.set ? `<button type="button" class="secondary compact-action" data-ef-workspace="root-clear"${changing}>Clear</button>` : ''}</span></div>
    <div class="ef-buttons"><button type="button" class="secondary compact-action" data-ef-workspace="add"${changing}>${icon('add')}Add personal file…</button>
      ${declare}</div>
  </section>`;
}

function suggestionHtml(view: EnvironmentFilesView): string {
  const suggestion = view.suggestion;
  if (!suggestion) return '';
  const candidates = suggestion.candidates.length
    ? `<ul class="ef-candidates">${suggestion.candidates.map((candidate) => `<li><code>${escape(candidate.path)}</code> <small class="muted">${escape(candidate.environment ?? 'every environment')}${
      candidate.framework ? ` · ${escape(candidate.framework)}` : ''}</small>${candidate.template ? ` <small>template <code>${escape(candidate.template)}</code></small>` : ' <small class="muted">no template yet</small>'}${
      candidate.declared ? ' <span class="pill ok">declared</span>' : ''}${candidate.tracked ? ' <span class="pill bad">tracked in Git</span>' : ''}</li>`).join('')}</ul>`
    : '<p class="muted">The engine found no framework file to suggest in this repository.</p>';
  const additions = suggestion.additions.length
    ? `<ul class="ef-candidates" data-ef-additions>${suggestion.additions.map((entry) => `<li><strong>${escape(entry.environment)}</strong>${
      entry.declared ? '' : ' <small class="muted">(not declared yet: not in the draft)</small>'}: ${entry.paths.map((item) => `<code>${escape(item)}</code>`).join(', ')}</li>`).join('')}</ul>` : '';
  const draft = suggestion.draft && suggestion.valid
    ? `<p>The draft is the whole singularity/environments.yml with these paths added:</p>
      <pre class="ef-draft" data-ef-draft><code>${escape(suggestion.draft)}</code></pre>
      <p class="ef-buttons"><button type="button" class="secondary compact-action" data-ef-workspace="copy-draft">Copy the draft</button></p>`
    : suggestion.draft ? '<p class="notice warning">The engine\'s draft does not pass its own check, so it is not offered for review.</p>'
      : '<p class="muted">There is nothing to add to singularity/environments.yml.</p>';
  const command = suggestion.command
    ? `<p>Propose it for review, with the draft on standard input:</p>
      <p class="ef-command"><code>${escape(suggestion.command)}</code> <button type="button" class="secondary compact-action" data-ef-workspace="copy-command">Copy</button></p>` : '';
  return `<section class="plain ef-team" data-ef-team>
    <h2>${icon('team')}Declare for the team</h2>
    <p>Declared files are exact paths in an environment's <code>localFiles</code> in singularity/environments.yml. The team commits each template, which holds placeholders only; the real files never reach Git.</p>
    ${candidates}${additions}
    ${suggestion.notes.map((note) => `<p class="muted">${escape(note)}</p>`).join('')}
    ${draft}${command}
    <p class="muted">VS Code never writes singularity/environments.yml.</p>
  </section>`;
}

export function environmentFilesHtml(view: EnvironmentFilesView): string {
  const scope = (value: 'repository' | 'workspace', label: string) =>
    `<button type="button" class="secondary compact-action" data-ef-scope="${value}" aria-pressed="${view.scope === value}"${view.busy ? ' disabled' : ''}>${label}</button>`;
  const header = `<header class="inbox-header ef-header"><div>${brandLockup()}<p class="eyebrow">Run &amp; test</p>
      <h1>${icon('document', { size: 24 })}Environment files</h1>
      <p class="meta">The files each environment's settings are read from, on this computer. Singularity Flow keeps the real files outside the checkout and out of Git. This page shows where they are, never what they hold; Open edits the real file in an editor tab.</p></div>
      <div class="header-actions"><span class="ef-scope" role="group" aria-label="Which repositories">${scope('repository', 'This repository')}${scope('workspace', 'Whole workspace')}</span>
        <button type="button" class="secondary" data-ef-refresh${view.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>`;
  const notices = [
    view.busy ? '<div class="notice warning" role="status">Working… The list refreshes when it finishes.</div>' : '',
    view.notice ? `<div class="notice ok" role="status">${icon('ok')}${escape(view.notice)}</div>` : '',
    view.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(view.error)}</div>` : '',
    !view.trusted ? `<div class="notice warning" data-ef-untrusted>${icon('warning')}${escape(UNTRUSTED_NOTE)}</div>` : '',
    view.dropped ? `<div class="notice warning">${icon('warning')}${view.dropped} entr${view.dropped === 1 ? 'y is' : 'ies are'} not shown because the engine's answer for ${view.dropped === 1 ? 'it' : 'them'} is incomplete.</div>` : ''
  ].join('');
  if (view.unsupported) {
    return `<div class="ef-page">${header}${notices}<div class="empty-state ef-empty">${icon('info')}<strong>This Singularity Flow has no environment files commands.</strong>
      <p>Update Singularity Flow, then refresh.</p></div></div>`;
  }
  if (!view.available) {
    return `<div class="ef-page">${header}${notices}<div class="empty-state ef-empty"><p>${view.busy ? 'Reading the environment files…' : 'The environment files could not be read. Refresh to try again.'}</p></div></div>`;
  }
  const files = view.repositories.length
    ? view.repositories.map((group) => repositoryHtml(view, group)).join('')
    : `<div class="empty-state ef-empty" data-ef-none>${icon('document')}<strong>${view.environment ? `No environment files for ${escape(view.environment)}.` : 'No environment files.'}</strong>
      <p>${view.empty
        ? 'An exact path in an environment\'s localFiles in singularity/environments.yml is a file Singularity Flow creates and places for each run. Declare for the team drafts them from what the frameworks here read; Add personal file… adds one only you use.'
        : 'Choose another environment, or add a personal file for this one.'}</p></div>`;
  return `<div class="ef-page" data-ef-current="${escape(view.environment ?? '')}">${header}${notices}${tabsHtml(view)}${workspaceHtml(view)}
    <div class="ef-groups">${files}</div>${suggestionHtml(view)}</div>`;
}

export const ENVIRONMENT_FILES_STYLE = `
.ef-scope { display:inline-flex; gap:.25rem; }
.ef-scope button[aria-pressed="true"] { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
.ef-tabs { display:flex; flex-wrap:wrap; gap:.25rem; margin:1rem 0 .75rem; border-bottom:var(--sf-border); }
.ef-tab { padding:.4rem .8rem; border:0; border-bottom:2px solid transparent; border-radius:0; color:var(--vscode-foreground); background:transparent; font:inherit; cursor:pointer; }
.ef-tab[aria-selected="true"] { border-bottom-color:var(--sf-accent); font-weight:600; }
.ef-tab small { font-weight:400; }
.ef-workspace { display:flex; flex-wrap:wrap; gap:.6rem 1.2rem; align-items:center; justify-content:space-between; }
.ef-root { display:flex; flex-wrap:wrap; gap:.4rem .6rem; align-items:center; min-width:0; }
.ef-buttons { display:inline-flex; flex-wrap:wrap; gap:.4rem; align-items:center; margin:0; }
.ef-location { overflow-wrap:anywhere; }
.ef-repository { margin:1.2rem 0; }
.ef-repository h2 { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; margin:0 0 .4rem; font-size:1.05rem; }
.ef-app h3 { display:flex; gap:.4rem; align-items:center; margin:.8rem 0 .4rem; font-size:.95rem; overflow-wrap:anywhere; }
.ef-files { display:grid; gap:.6rem; margin:0; padding:0; list-style:none; }
.ef-file { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.35rem 1rem; padding:.7rem .8rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
.ef-file > * { grid-column:1; min-width:0; }
.ef-file[data-ef-status="missing"] { border-left:4px solid var(--sf-bad); }
.ef-file[data-ef-status="unmanaged"] { border-left:4px solid var(--sf-wait); }
.ef-file-main { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.ef-path { font-weight:600; overflow-wrap:anywhere; }
.ef-detail { margin:0; }
.ef-facts { display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.2rem .8rem; margin:0; }
.ef-facts dt { color:var(--sf-dim); }
.ef-facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.ef-file > .ef-actions { grid-column:2; grid-row:1 / span 3; display:flex; flex-direction:column; align-items:stretch; gap:.4rem; }
.ef-team { margin-top:1.2rem; }
.ef-team h2 { display:flex; gap:.4rem; align-items:center; font-size:1.05rem; }
.ef-candidates { margin:.4rem 0; padding-left:1.2rem; }
.ef-candidates code, .ef-command code { overflow-wrap:anywhere; }
.ef-draft { margin:.6rem 0; padding:.6rem .8rem; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--vscode-textCodeBlock-background, var(--sf-surface)); }
.ef-empty { margin:1rem 0; }
@media (max-width: 640px) {
  .ef-header .header-actions { flex-wrap:wrap; }
  .ef-workspace { flex-direction:column; align-items:stretch; }
  .ef-file { grid-template-columns:minmax(0,1fr); }
  .ef-file > .ef-actions { grid-column:1; grid-row:auto; flex-direction:row; flex-wrap:wrap; }
  .ef-facts { grid-template-columns:minmax(0,1fr); }
  .ef-facts dt { margin-top:.2rem; }
}
`;

/**
 * Click handling. It reads only the data attributes the markup above wrote and posts them; the host
 * finds the file again in what it read last and checks the action against the file's status.
 */
export const ENVIRONMENT_FILES_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target.closest && event.target.closest('[data-ef-action],[data-ef-workspace],[data-ef-environment],[data-ef-scope],[data-ef-refresh]');
    if (!target || target.disabled) return;
    event.preventDefault();
    if (target.dataset.efAction) api.postMessage({ type: 'envFiles.action', action: target.dataset.efAction, key: target.dataset.efKey || '' });
    else if (target.dataset.efWorkspace) api.postMessage({ type: 'envFiles.workspace', action: target.dataset.efWorkspace });
    else if (target.dataset.efEnvironment) api.postMessage({ type: 'envFiles.environment', environment: target.dataset.efEnvironment });
    else if (target.dataset.efScope) api.postMessage({ type: 'envFiles.scope', scope: target.dataset.efScope });
    else api.postMessage({ type: 'envFiles.refresh' });
  });
})();
`;
