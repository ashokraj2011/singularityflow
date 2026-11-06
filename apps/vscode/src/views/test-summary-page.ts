/** The Test summary page: totals, each command's test cases, filters and the run picker. [RUN] */
import { brandLockup, escape, icon } from './webview.ts';
import type { CommandTable, TestSummaryView } from './test-summary-model.ts';

function commandHtml(command: CommandTable): string {
  const head = `<header class="ts-command-head"><h2><code>${escape(command.id)}</code></h2>
      <span class="pill ${command.status === 'passed' ? 'ok' : command.status === 'failed' ? 'bad' : command.status === 'blocked' ? 'wait' : ''}">${escape(command.status ?? 'no status')}</span>
      <small class="muted">${escape([command.kind, command.adapter, command.exitCode === null ? null : `exit ${command.exitCode}`,
    command.environment ? `environment ${command.environment}` : null].filter(Boolean).join(' · '))}</small></header>
      ${command.label ? `<p class="muted ts-command-label">${escape(command.label)}</p>` : ''}`;
  const note = command.note ? `<p class="notice ts-note" data-ts-note="${escape(command.id)}">${escape(command.note)}</p>` : '';
  if (!command.perCase) {
    return `<section class="ts-command" data-ts-command="${escape(command.id)}" data-per-case="false">${head}
      ${note || '<p class="notice ts-note">This report gives totals only, so its test cases are not listed.</p>'}</section>`;
  }
  const rows = command.rows.map((entry) => `<tr data-ts-outcome="${escape(entry.outcome)}">
      <td><span class="pill ${entry.outcomePill}">${escape(entry.outcome)}</span></td>
      <td>${entry.suite ? `<small class="muted">${escape(entry.suite)}</small><br>` : ''}${escape(entry.name)}</td>
      <td class="ts-duration">${escape(entry.duration)}</td>
      <td>${entry.file && entry.location
    ? `<button type="button" class="link" data-ts-open="${escape(entry.file)}" data-ts-line="${entry.line ?? 0}">${escape(entry.location)}</button>`
    : '<span class="muted">—</span>'}</td>
      <td>${entry.clauses.length ? entry.clauses.map((clause) => `<code class="ts-tag">${escape(clause)}</code>`).join(' ') : '<span class="muted">untagged</span>'}</td>
    </tr>`).join('');
  const table = command.rows.length
    ? `<table class="ts-cases"><thead><tr><th>Outcome</th><th>Test case</th><th>Duration</th><th>File</th><th>Requirement tags</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">${command.total ? 'No test case here matches the filters.' : 'No test cases were recorded for this command.'}</p>`;
  return `<section class="ts-command" data-ts-command="${escape(command.id)}" data-per-case="true">${head}${note}${table}
    ${command.total !== command.rows.length ? `<p class="muted">${command.rows.length} of ${command.total} shown.</p>` : ''}</section>`;
}

/** A failed run's question: is this the change? A fact for a person, which runs only when they ask. */
function baseHtml(view: TestSummaryView): string {
  if (!view.base.offered) return '';
  const { busy, answer, error } = view.base;
  const lines = (answer?.results ?? []).map((entry) => `<li data-ts-base-result="${escape(entry.commandId)}"><code>${escape(entry.commandId)}</code>${entry.reused ? ' <small class="muted">already run on this base</small>' : ''}<br>${escape(entry.words)}</li>`).join('');
  return `<section class="plain ts-base" data-ts-base>
      <div class="ts-base-head"><strong>Does this also fail without this change?</strong>
        <button type="button" class="secondary compact-action" data-ts-base-run${busy ? ' disabled' : ''}>${icon('start')}${busy ? 'Running on the base commit…' : answer ? 'Ask again' : 'Compare with the base commit'}</button></div>
      <p class="muted">Runs the same commands once on the commit this Story started from, in a throwaway checkout, and keeps the answer. It records no evidence and refuses nothing.</p>
      ${busy ? '<p class="muted" role="status">Running. A full test run on the base commit can take as long as one here.</p>' : ''}
      ${error ? `<p class="notice error" role="alert">${escape(error)}</p>` : ''}
      ${lines ? `<ul class="ts-base-results" role="status">${lines}</ul>` : ''}
    </section>`;
}

export function testSummaryHtml(view: TestSummaryView): string {
  const header = `<header class="inbox-header ts-header"><div>${brandLockup()}<p class="eyebrow">Test summary</p>
      <h1>${icon('phase', { size: 24 })}${escape(view.title)}</h1><p class="meta">${escape(view.scope)}</p></div>
      <div class="header-actions"><button type="button" class="secondary" data-ts-refresh${view.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>`;
  const messages = `${view.busy ? '<div class="notice" role="status">Reading the test summary…</div>' : ''}
    ${view.notice ? `<div class="notice ok" role="status">${escape(view.notice)}</div>` : ''}
    ${view.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(view.error)}</div>` : ''}`;
  if (!view.available) {
    return `${header}${messages}<div class="empty"><p>${view.busy ? 'Reading…' : 'No test run has been recorded here yet.'}</p></div>`;
  }
  const run = view.run;
  const picker = view.runs.length ? `<label class="field ts-runs"><span>Run</span><select data-ts-run aria-label="Run">${view.runs
    .map((option) => `<option value="${escape(option.id)}"${option.selected ? ' selected' : ''}${option.title ? ` title="${escape(option.title)}"` : ''}>${escape(option.label)}</option>`)
    .join('')}</select></label>` : '';
  const runHtml = run ? `<section class="plain ts-run" data-evidence-class="${escape(run.evidenceClass)}">
      ${picker}
      <p><span class="pill ${run.evidenceClass === 'local-preview' ? 'wait' : 'ok'}">${escape(run.classLabel)}</span>
        ${run.environment ? `<span class="pill">environment ${escape(run.environment)}</span>` : ''}
        <code>${escape(run.id)}</code></p>
      ${run.label ? `<p class="ts-label">${escape(run.label)}</p>` : ''}
      ${run.countsNote ? `<p class="notice ts-counts" data-counts-for-step="false">${escape(run.countsNote)}</p>` : ''}
      <p class="muted">${escape([run.startedAt, run.commit ? `commit ${run.commit.slice(0, 12)}` : null,
    run.uncommittedChanges ? 'with uncommitted changes' : null, run.ranBy ? `ran by ${run.ranBy}` : null].filter(Boolean).join(' · '))}</p>
    </section>` : picker;
  const totals = view.totals ? `<div class="summary-grid ts-totals">
      <div class="summary-card important"><strong>${view.totals.discovered}</strong><span>discovered</span></div>
      <div class="summary-card"><strong>${view.totals.passed}</strong><span>passed</span></div>
      <div class="summary-card${view.totals.failed ? ' important' : ''}"><strong>${view.totals.failed}</strong><span>failed</span></div>
      <div class="summary-card"><strong>${view.totals.skipped}</strong><span>skipped</span></div>
      <div class="summary-card"><strong>${view.totals.flaky}</strong><span>flaky</span></div>
      <div class="summary-card"><strong>${view.untagged}</strong><span>untagged</span></div>
    </div>` : '';
  const filters = `<div class="ts-filters" role="group" aria-label="Filters">
      <label><input type="checkbox" data-ts-filter="failedOnly"${view.filters.failedOnly ? ' checked' : ''}> Failed only</label>
      <label><input type="checkbox" data-ts-filter="untagged"${view.filters.untagged ? ' checked' : ''}> Untagged only</label>
      <span class="muted">${view.shown} of ${view.total} test cases shown.</span></div>`;
  return `${header}${messages}${runHtml}${totals}${baseHtml(view)}
    ${view.truncated ? `<p class="notice ts-truncated">The list stops at 5,000 test cases; the totals above count every one. Open a command's own report for the rest.</p>` : ''}
    ${filters}
    <div class="ts-commands">${view.commands.map(commandHtml).join('') || '<p class="muted">No commands ran.</p>'}</div>`;
}

export const TEST_SUMMARY_STYLE = `
.ts-run { margin:1rem 0; }
.ts-run p { margin:.35rem 0; }
.ts-runs { max-width:40rem; }
.ts-filters { display:flex; flex-wrap:wrap; gap:1rem; align-items:center; margin:1rem 0; }
.ts-command { margin:1.2rem 0; }
.ts-command-head { display:flex; flex-wrap:wrap; gap:.6rem; align-items:baseline; }
.ts-command-head h2 { margin:0; font-size:1.05rem; }
.ts-cases td { vertical-align:top; overflow-wrap:anywhere; }
.ts-duration { white-space:nowrap; }
.ts-tag { margin-right:.25rem; }
.ts-base { margin:1rem 0; }
.ts-base-head { display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; }
.ts-base-results { margin:.5rem 0 0; padding-left:1.1rem; }
.ts-base-results li { margin:.35rem 0; }
`;

export const TEST_SUMMARY_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const filters = () => {
    const value = {};
    for (const box of document.querySelectorAll('[data-ts-filter]')) value[box.dataset.tsFilter] = box.checked;
    return value;
  };
  document.addEventListener('click', (event) => {
    const open = event.target.closest('[data-ts-open]');
    if (open) { api.postMessage({ type: 'summary.open', file: open.dataset.tsOpen, line: Number(open.dataset.tsLine || 0) }); return; }
    if (event.target.closest('[data-ts-base-run]')) { api.postMessage({ type: 'summary.base' }); return; }
    if (event.target.closest('[data-ts-refresh]')) api.postMessage({ type: 'summary.refresh' });
  });
  document.addEventListener('change', (event) => {
    if (event.target.closest('[data-ts-filter]')) { api.postMessage({ type: 'summary.filter', ...filters() }); return; }
    const run = event.target.closest('[data-ts-run]');
    if (run) api.postMessage({ type: 'summary.run', run: run.value });
  });
})();
`;
