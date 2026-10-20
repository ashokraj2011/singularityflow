import { escape, icon } from './webview.ts';
import { filteredPerformanceTraces, PERFORMANCE_CATEGORIES, PERFORMANCE_OUTCOMES, PERFORMANCE_TEMPERATURES,
  type PerformanceFilters, type PerformanceReport, type PerformanceTrace } from './performance-report-model.ts';

const ms = (value: number | null): string => value == null ? 'Unavailable' : value < 1000 ? `${value.toFixed(1)} ms` : `${(value / 1000).toFixed(2)} s`;
const count = (value: number | null | undefined): string => value == null ? 'Unavailable' : value.toLocaleString('en-US');
const card = (title: string, value: string) => `<div class="summary-card"><strong>${escape(value)}</strong><span>${escape(title)}</span></div>`;
const options = (values: readonly string[], selected: string, all: string) =>
  `<option value="">${escape(all)}</option>${values.map(value => `<option value="${escape(value)}"${selected === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}`;

function traceDetails(trace: PerformanceTrace): string {
  const denominator = Math.max(1, trace.durationMs);
  const operationCalls = trace.categories.length && trace.categories.every(row => row.calls != null)
    ? trace.categories.reduce((sum, row) => sum + row.calls!, 0) : null;
  const bars = trace.categories.map(row => `<tr data-category="${row.category}">
    <th scope="row">${PERFORMANCE_CATEGORIES[row.category]}</th>
    <td>${row.wallMs == null ? 'Unavailable' : `<meter min="0" max="${denominator}" value="${Math.min(denominator, row.wallMs)}" aria-label="${PERFORMANCE_CATEGORIES[row.category]} elapsed share">${ms(row.wallMs)}</meter><span>${ms(row.wallMs)}</span>`}</td>
    <td>${count(row.calls)}</td><td>${ms(row.exclusiveServiceMs)}</td>
    <td>${count(row.cacheHits)}</td><td>${count(row.retries)}</td>
    <td title="${count(row.timeouts)} timeouts; ${count(row.cancellations)} cancellations">${count(row.errors)}</td></tr>`).join('');
  const residual = [['Concurrent categories (overlap)', trace.overlapMs], ['Uninstrumented / unattributed', trace.unattributedMs]] as const;
  const residualRows = residual.map(([name, value]) => `<tr class="residual"><th scope="row">${name}</th>
    <td>${value == null ? 'Unavailable' : `<meter min="0" max="${denominator}" value="${Math.min(denominator, value)}" aria-label="${name}">${ms(value)}</meter><span>${ms(value)}</span>`}</td><td colspan="5">Not an operation count</td></tr>`).join('');
  const slow = trace.slowOperations == null
    ? '<p class="muted">Slow-operation details are unavailable in this CLI build. Update the CLI and VS Code to matching builds.</p>'
    : trace.slowOperations.length ? `<div class="table-wrap"><table class="analytics-table"><thead><tr><th>Operation</th><th>Category</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>${trace.slowOperations.map(row => `<tr><td><code>${escape(row.name)}</code></td><td>${PERFORMANCE_CATEGORIES[row.category]}</td><td>${ms(row.durationMs)}</td><td>${escape(row.outcome)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No operation spans were recorded for this command.</p>';
  const host = trace.host ? `<dl class="performance-facts">${[
    ['Host queue', trace.host.queueMs], ['Spawn-call return', trace.host.launchCallMs], ['First bytes', trace.host.firstByteMs],
    ['Child process lifetime', trace.host.processMs], ['Response parsing', trace.host.parseMs], ['Post-close handling', trace.host.postCloseMs]
  ].map(([name, value]) => `<div><dt>${name}</dt><dd>${ms(value as number | null)}</dd></div>`).join('')}</dl>`
    : '<p class="muted">No matching VS Code host observation is available. Pre-Node startup and post-exit UI time cannot be inferred.</p>';
  return `<section aria-labelledby="performance-selected"><div class="performance-selected-heading"><div><p class="eyebrow">Selected command · ${escape(trace.platform)} · ${escape(trace.temperature)}</p><h2 id="performance-selected">${escape(trace.command)}</h2></div><span class="pill ${trace.outcome === 'success' ? 'idle' : 'wait'}">${escape(trace.outcome)}</span></div>
    <p class="meta">${escape(trace.startedAt)}${trace.operationId ? ` · ${escape(trace.operationId)}` : ''}</p>
    <div class="summary-grid performance-metrics">${card('Command elapsed', ms(trace.durationMs))}${card('First feedback', ms(trace.firstFeedbackMs))}${card('Physical Git spawns', count(trace.counters['git.spawns']))}${card('Recorded operation calls', count(operationCalls))}</div>
    <h3>Where the time went</h3><p class="muted">Category elapsed shares + overlap + unattributed time partition the command window. Exclusive service durations may overlap and must not be added to estimate elapsed time. Node time is not CPU time.</p>
    <div class="table-wrap"><table class="analytics-table performance-categories"><thead><tr><th>Category</th><th>Elapsed share</th><th>Calls</th><th>Exclusive service</th><th>Cache hits</th><th>Retries</th><th>Non-success</th></tr></thead><tbody>${bars}${residualRows}</tbody></table></div>
    <h3>Slowest recorded operations</h3><p class="muted">Up to 10 individual operations, longest first. Durations are inclusive, can overlap, and are not a second elapsed-time total.</p>${slow}
    <details><summary>Host timings &amp; measurement coverage</summary>${host}
      <dl class="performance-facts"><div><dt>Coverage</dt><dd>${escape(trace.coverage)}</dd></div><div><dt>Dropped spans</dt><dd>${count(trace.droppedSpans)}</dd></div><div><dt>Recorded spans</dt><dd>${count(trace.spanCount)}</dd></div>
      <div><dt>Process CPU (user / system)</dt><dd>${ms(trace.cpu.userMs)} / ${ms(trace.cpu.systemMs)}</dd></div>
      <div><dt>Process RSS at command end</dt><dd>${trace.memory.rssEndBytes == null ? 'Unavailable' : `${(trace.memory.rssEndBytes / 1048576).toFixed(1)} MiB`}</dd></div></dl>
      <p class="muted">File access covers shared and targeted boundaries, not every read. Remote Git includes credential and local Git work, not just network transfer. Native Copilot internals, tokens and provider cost are unavailable. CPU is process-wide; command persistence occurs outside the measured command window.</p>
      <dl class="performance-ids"><dt>Action ID (correlated commands)</dt><dd><code>${trace.actionId}</code></dd><dt>Invocation ID</dt><dd><code>${trace.invocationId}</code></dd></dl>
    </details></section>`;
}

export interface PerformancePageState {
  repository: string; report: PerformanceReport | null; error: string | null; loading: boolean;
  filters: PerformanceFilters; selectedId: string | null; captureEnabled: boolean;
}
export function performanceReportBody(state: PerformancePageState): string {
  const traces = filteredPerformanceTraces(state.report, state.filters);
  const selected = traces.find(trace => trace.invocationId === state.selectedId) ?? traces[0];
  const commands = [...new Set(state.report?.traces.map(trace => trace.command) ?? [])].sort();
  return `<header><p class="eyebrow">Local diagnostics</p><h1>${icon('impact', { size: 24 })}Performance</h1><p class="meta performance-repository">${escape(state.repository)}</p>
    <p>See network, local Git, model, file and Node costs without rerunning the action.</p></header>
    <div class="performance-toolbar"><span class="pill ${state.captureEnabled ? 'idle' : 'wait'}">Capture ${state.captureEnabled ? 'on' : 'off'}</span><span class="muted">Saved traces stay on this laptop; never shared evidence.</span><span class="grow"></span><button class="secondary" data-action="settings">Trace settings</button><button data-action="refresh"${state.loading ? ' disabled' : ''}>${state.loading ? 'Refreshing…' : 'Refresh'}</button></div>
    ${!state.captureEnabled ? '<p class="notice">To capture a new run, enable <code>singularityFlow.performanceTrace</code> in Trace settings, repeat the original action, then Refresh. Existing records remain available while capture is off.</p>' : ''}
    <form id="performance-filters" class="performance-filters"><label>Command or action ID<input name="search" type="search" maxlength="100" placeholder="Search loaded records" value="${escape(state.filters.search)}"></label>
    <label>Command<select name="command">${options(commands, state.filters.command, 'All commands')}</select></label>
    <label>Outcome<select name="outcome">${options(PERFORMANCE_OUTCOMES, state.filters.outcome, 'All outcomes')}</select></label>
    <label>Request temperature<select name="temperature">${options(PERFORMANCE_TEMPERATURES, state.filters.temperature, 'All / unknown')}</select></label>
    <label>Time range<select name="hours">${[['', 'Any time'], ['1', 'Last hour'], ['24', 'Last 24 hours'], ['168', 'Last 7 days']].map(([value, title]) => `<option value="${value}"${value === state.filters.hours ? ' selected' : ''}>${title}</option>`).join('')}</select></label><div class="performance-filter-actions"><button type="submit" class="secondary">Apply filters</button><button type="button" class="link" data-action="reset">Reset</button></div></form>
    <p class="muted" aria-live="polite">${traces.length} of ${state.report?.traces.length ?? 0} loaded commands. Reads at most 64 recent command summaries within the CLI read budget. Filters apply to this loaded window; refresh does not reconstruct history.</p>
    ${state.report?.warnings.map(warning => `<p class="notice">${escape(warning)}</p>`).join('') ?? ''}
    ${state.error ? `<div role="alert" class="notice bad"><h2>Could not read the performance report</h2><p>${escape(state.error)}</p><p>Saved work was not changed. Check the selected repository and installed CLI, then Refresh.</p></div>`
      : !state.report ? '<div class="empty" role="status">Reading saved performance traces…</div>'
      : !state.report.traces.length ? '<div class="empty"><h2>No saved command traces</h2><p>Enable capture in Trace settings, run a Singularity Flow action, then Refresh. Capture is not retroactive.</p></div>'
      : !selected ? '<div class="empty"><h2>No commands match these filters</h2><p>Reset the filters or refresh after recording another action.</p></div>'
      : `<div class="performance-layout"><nav aria-label="Recorded commands" class="performance-runs">${traces.map(trace => `<button class="performance-run ${selected.invocationId === trace.invocationId ? 'selected' : ''}" data-invocation="${trace.invocationId}" aria-pressed="${selected.invocationId === trace.invocationId}"><strong>${escape(trace.command)} <span>${ms(trace.durationMs)}</span></strong><small>${escape(trace.startedAt)}</small><small>${escape(trace.outcome)} · ${escape(trace.platform)} · ${escape(trace.temperature)}</small></button>`).join('')}</nav>${traceDetails(selected)}</div>`}`;
}

export const PERFORMANCE_REPORT_SCRIPT = `
  const api = window.__sfVscode;
  document.querySelector('#performance-filters').addEventListener('submit', event => {
    event.preventDefault(); api.postMessage({ type: 'filters', filters: Object.fromEntries(new FormData(event.currentTarget)) });
  });
  document.addEventListener('click', event => {
    const run = event.target.closest('[data-invocation]');
    if (run) return api.postMessage({ type: 'select', invocationId: run.dataset.invocation });
    const button = event.target.closest('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'reset') return api.postMessage({ type: 'filters', filters: { search: '', command: '', outcome: '', temperature: '', hours: '' } });
    if (['refresh', 'settings'].includes(button.dataset.action)) api.postMessage({ type: button.dataset.action });
  });
`;
export const PERFORMANCE_REPORT_STYLE = `
  .performance-toolbar,.performance-selected-heading { display:flex; align-items:center; gap:.65rem; flex-wrap:wrap; margin:1rem 0; }
  .performance-repository,.performance-ids dd { overflow-wrap:anywhere; }
  .performance-filters { display:grid; grid-template-columns:2fr repeat(4,minmax(8rem,1fr)); gap:.7rem; margin:1.4rem 0 .7rem; }
  .performance-filters label { display:grid; gap:.35rem; font-size:.85rem; color:var(--sf-dim); }
  .performance-filters input,.performance-filters select { width:100%; min-width:0; box-sizing:border-box; }
  .performance-filter-actions { grid-column:1/-1; display:flex; gap:.7rem; }
  .performance-layout { display:grid; grid-template-columns:minmax(13rem,18rem) minmax(0,1fr); gap:1.5rem; align-items:start; }
  .performance-runs { display:grid; gap:.35rem; max-height:38rem; overflow:auto; }
  .performance-run { display:block; width:100%; text-align:left; background:var(--sf-surface); color:var(--vscode-foreground); border:var(--sf-border); padding:.8rem; }
  .performance-run.selected { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
  .performance-run strong,.performance-run small { display:block; }.performance-run small { color:var(--sf-dim); margin-top:.25rem; font-size:.75rem; }
  .performance-run strong span { float:right; font-weight:400; }.performance-selected-heading { justify-content:space-between; margin-top:0; }.performance-selected-heading h2 { margin:0; }
  .performance-metrics { grid-template-columns:repeat(auto-fit,minmax(8rem,1fr)); }.performance-metrics .summary-card strong { font-size:1.5rem; }
  .performance-categories th { text-align:left; }.performance-categories td:nth-child(2) { min-width:10rem; }.performance-categories td:nth-child(2) span { display:block; font-size:.8rem; }
  .performance-categories meter { display:block; width:100%; height:.65rem; margin-bottom:.25rem; }
  meter::-webkit-meter-bar { background:var(--vscode-input-background); border:0; } meter::-webkit-meter-optimum-value { background:var(--vscode-charts-blue, #3794ff); }
  [data-category="copilot"] meter::-webkit-meter-optimum-value { background:var(--vscode-charts-purple, #b180d7); }
  [data-category="file"] meter::-webkit-meter-optimum-value { background:var(--vscode-charts-green, #89d185); }
  [data-category="waiting"] meter::-webkit-meter-optimum-value,.residual meter::-webkit-meter-optimum-value { background:var(--vscode-charts-yellow, #cca700); }
  .performance-facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(12rem,1fr)); gap:.8rem; margin:1rem 0; }.performance-facts dt { color:var(--sf-dim); font-size:.8rem; }.performance-facts dd,.performance-ids dd { margin:.25rem 0; }
  .notice { padding:.8rem 1rem; background:var(--sf-surface); border-left:3px solid var(--sf-wait); }.notice.bad { border-left-color:var(--sf-bad); }
  @media(max-width:1100px) { .performance-filters { grid-template-columns:repeat(2,minmax(0,1fr)); }.performance-layout { grid-template-columns:minmax(0,1fr); }.performance-runs { max-height:14rem; } }
`;
