/**
 * The "Suggest from run configurations" page. [RUN amendment 3, VS Code]
 *
 * Markup only. Each suggestion shows where it was read from, the command it runs (an argument that
 * looks like it carries a secret is shown as [hidden]), its per-environment arguments, its debug
 * start and the environment variables it uses: names and kinds, and a default only for a flag or
 * endpoint. A secret never has a value here. The page posts the ticks and IDs on "Review"; the host
 * checks them again.
 */
import { brandLockup, escape, icon } from './webview.ts';
import { ENVIRONMENTS_NOTE, maskedArgv, type SuggestionChoice, type SuggestionSet, type Suggestion } from './run-suggestions-model.ts';

export interface SuggestionsPageState {
  capability: string;
  set: SuggestionSet | null;
  selection: SuggestionChoice[];
  problems: { rows: Record<number, string>; general: string | null };
  declaredIds: string[];
  busy: boolean;
  error: string | null;
  notice: string | null;
}

const readiness = (ready: Suggestion['start']['ready']): string => {
  if (!ready) return 'the engine\'s default readiness check';
  const seconds = ready.timeoutMs ? ` within ${Math.round(ready.timeoutMs / 1000)} s` : '';
  return ready.http ? `HTTP ${ready.http} answers below 500${seconds}` : `the output shows ${JSON.stringify(ready.log ?? '')}${seconds}`;
};

const KIND_WORDS: Record<string, string> = {
  secret: 'secret: bound privately on each computer with env bind; never copied',
  endpoint: 'endpoint', flag: 'flag'
};

function suggestionHtml(suggestion: Suggestion, choice: SuggestionChoice | undefined, problem: string | undefined): string {
  const { start, source } = suggestion;
  const index = String(suggestion.index);
  const keep = choice?.keep ?? false;
  const argumentsRows = Object.entries(start.arguments).map(([environment, list]) =>
    `<tr><td><code>${escape(environment)}</code></td><td><code class="sg-argv">${escape(maskedArgv(list).join(' '))}</code></td></tr>`).join('');
  const names = suggestion.environmentNames.map((name) => `<tr data-sg-name="${escape(name.name)}" data-sg-kind="${escape(name.kind)}">
      <td><code>${escape(name.name)}</code>${name.environment ? ` <small class="muted">(${escape(name.environment)})</small>` : ''}</td><td>${escape(KIND_WORDS[name.kind] ?? name.kind)}</td>
      <td>${name.kind === 'secret' ? '<span class="muted">no value</span>' : name.default === null ? '<span class="muted">none</span>' : `<code>${escape(name.default)}</code>`}</td></tr>`).join('');
  const debug = start.debug
    ? `${start.debug.runtime}${start.debug.port ? ` on 127.0.0.1:${start.debug.port}` : start.debug.runtime === 'dotnet' ? ', attached by process ID' : ''}${start.debug.suspend ? ', waits for the debugger' : ''}`
    : null;
  return `<section class="plain sg-card" data-sg-index="${index}"${suggestion.refusal ? ' data-sg-refused' : ''}>
    <header class="sg-head">
      <label class="sg-keep"><input type="checkbox" data-sg-keep="${index}"${keep ? ' checked' : ''}${suggestion.refusal ? ' disabled' : ''}> Keep</label>
      <label class="field sg-id"><span>Start ID</span><input type="text" data-sg-id="${index}" value="${escape(choice?.id ?? start.id)}" maxlength="64" spellcheck="false" autocomplete="off" aria-label="Start ID"></label>
      <span class="pill">${escape(source.words)}</span>
      ${source.file ? `<button type="button" class="link" data-sg-open="${index}">${escape(source.file)}</button>` : ''}
      ${source.name ? `<span class="muted">${escape(source.name)}</span>` : ''}
    </header>
    ${problem ? `<p class="notice error" role="alert" data-sg-problem="${index}">${icon('blocked')}${escape(problem)}</p>`
    : suggestion.refusal ? `<p class="notice" role="status" data-sg-refusal="${index}">${escape(suggestion.refusal)}</p>` : ''}
    ${suggestion.variants.length ? `<p class="muted sg-variants">One entry from ${suggestion.variants.length} configurations: ${suggestion.variants.map((variant) =>
    `${escape(variant.name ?? variant.file ?? 'a configuration')}${variant.environment ? ` → ${escape(variant.environment)}` : ''}`).join('; ')}</p>` : ''}
    <table class="sg-facts"><tbody>
      <tr><th>Command</th><td><code class="sg-argv">${escape(maskedArgv(start.argv).join(' '))}</code></td></tr>
      ${start.repository ? `<tr><th>Repository</th><td><code>${escape(start.repository)}</code></td></tr>` : ''}
      <tr><th>Working directory</th><td>${escape(start.workingDirectory ?? 'the repository root')}</td></tr>
      <tr><th>Opens at</th><td>${escape(start.url ?? 'no URL')}</td></tr>
      <tr><th>Ready when</th><td>${escape(readiness(start.ready))}</td></tr>
      <tr><th>Environments</th><td>${start.environments.length ? escape(start.environments.join(', ')) + (start.environments.length > 1 ? ` <small class="muted">(${escape(start.environments[0]!)} is the default)</small>` : '') : '<span class="muted">none</span>'}</td></tr>
      ${debug ? `<tr><th>Debug</th><td>${escape(debug)}</td></tr>` : ''}
    </tbody></table>
    ${argumentsRows ? `<h3>Arguments per environment</h3><table class="sg-arguments"><thead><tr><th>Environment</th><th>Appended to the command</th></tr></thead><tbody>${argumentsRows}</tbody></table>` : ''}
    ${names ? `<h3>Environment variables</h3><table class="sg-names"><thead><tr><th>Name</th><th>Kind</th><th>Default</th></tr></thead><tbody>${names}</tbody></table>` : ''}
    ${suggestion.notes.length ? `<ul class="sg-notes">${suggestion.notes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

export function runSuggestionsHtml(state: SuggestionsPageState): string {
  const header = `<header class="inbox-header sg-header"><div>${brandLockup()}<p class="eyebrow">Suggest from run configurations</p>
      <h1>${icon('start', { size: 24 })}Start entries for ${escape(state.capability)}</h1>
      <p class="meta">Read from this repository's IntelliJ, PyCharm, WebStorm, GoLand, Rider and VS Code run configurations, .NET launch settings and project files. Keep the ones you want, name them, then review exactly what is proposed. Nothing is written before that.</p></div>
      <div class="header-actions"><button type="button" class="secondary" data-sg-refresh${state.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>`;
  const messages = `${state.busy ? '<div class="notice" role="status">Reading the run configurations…</div>' : ''}
    ${state.notice ? `<div class="notice ok" role="status">${escape(state.notice)}</div>` : ''}
    ${state.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(state.error)}</div>` : ''}`;
  const set = state.set;
  if (!set) return `${header}${messages}`;
  const choices = new Map(state.selection.map((choice) => [choice.index, choice]));
  const dropped = set.dropped.length ? `<section class="plain"><p class="notice">Not offered, because VS Code cannot write them exactly:</p>
      <ul>${set.dropped.map((line) => `<li>${escape(line)}</li>`).join('')}</ul></section>` : '';
  const cards = set.suggestions.length
    ? set.suggestions.map((suggestion) => suggestionHtml(suggestion, choices.get(suggestion.index), state.problems.rows[suggestion.index])).join('')
    : '<div class="empty"><p>No run configuration or project marker in this repository suggests a start entry.</p></div>';
  const environments = set.environmentsDraft ? `<section class="plain sg-environments">
      <h2>Additions for singularity/environments.yml</h2>
      <pre data-sg-environments>${escape(set.environmentsDraft)}</pre>
      <p><button type="button" class="secondary compact-action" data-sg-copy>Copy</button></p>
      <p class="muted">${escape(ENVIRONMENTS_NOTE)}</p></section>`
    : set.environmentsNote ? `<section class="plain sg-environments"><p class="notice" role="status">${escape(set.environmentsNote)}</p></section>` : '';
  const declared = state.declaredIds.length
    ? `<p class="muted">${escape(set.capability)} already declares: ${state.declaredIds.map((id) => `<code>${escape(id)}</code>`).join(', ')}. Those stay as they are; a kept suggestion needs another ID.</p>` : '';
  const engine = set.notes.length || set.files.skipped.length || set.files.read !== null ? `<section class="plain sg-read">
      ${set.files.read !== null ? `<p class="muted">Read ${set.files.read} file${set.files.read === 1 ? '' : 's'}.</p>` : ''}
      ${set.notes.map((note) => `<p class="notice" role="status">${escape(note)}</p>`).join('')}
      ${set.files.skipped.length ? `<details><summary>${set.files.skipped.length} configuration${set.files.skipped.length === 1 ? '' : 's'} not used</summary><ul>${set.files.skipped
    .map((skipped) => `<li><code>${escape(skipped.file)}</code>: ${escape(skipped.reason)}</li>`).join('')}</ul></details>` : ''}</section>` : '';
  return `${header}${messages}${engine}${dropped}${declared}
    <div class="sg-cards">${cards}</div>
    ${environments}
    ${state.problems.general ? `<p class="notice error" role="alert">${escape(state.problems.general)}</p>` : ''}
    ${set.suggestions.length ? `<p class="sg-actions"><button type="button" data-sg-review${state.busy ? ' disabled' : ''}>Review and propose…</button>
      <small class="muted">The next page shows the exact YAML and the command; nothing changes until you confirm there.</small></p>` : ''}`;
}

export const RUN_SUGGESTIONS_STYLE = `
.sg-card { margin:1rem 0; }
.sg-head { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; }
.sg-head .field { margin:0; }
.sg-id input { width:14rem; font-family:var(--vscode-editor-font-family); }
.sg-facts th { text-align:left; white-space:nowrap; vertical-align:top; padding-right:1rem; }
.sg-argv { overflow-wrap:anywhere; }
.sg-card h3 { margin:.8rem 0 .3rem; font-size:.95rem; }
.sg-environments pre { white-space:pre-wrap; overflow-wrap:anywhere; }
.sg-actions { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; margin:1rem 0; }
`;

/** Click handling; it reads only what the markup above wrote. The host checks every field again. */
export const RUN_SUGGESTIONS_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const selection = () => [...document.querySelectorAll('[data-sg-index]')].map((card) => ({
    index: Number(card.dataset.sgIndex),
    keep: card.querySelector('[data-sg-keep]') ? card.querySelector('[data-sg-keep]').checked === true : false,
    id: card.querySelector('[data-sg-id]') ? card.querySelector('[data-sg-id]').value : ''
  }));
  document.addEventListener('click', (event) => {
    const target = event.target.closest && event.target.closest('[data-sg-review],[data-sg-copy],[data-sg-refresh],[data-sg-open]');
    if (!target || target.disabled) return;
    event.preventDefault();
    if (target.dataset.sgReview !== undefined) api.postMessage({ type: 'suggest.review', selection: selection() });
    else if (target.dataset.sgCopy !== undefined) api.postMessage({ type: 'suggest.copy' });
    else if (target.dataset.sgRefresh !== undefined) api.postMessage({ type: 'suggest.refresh' });
    else api.postMessage({ type: 'suggest.open', index: Number(target.dataset.sgOpen) });
  });
})();
`;
