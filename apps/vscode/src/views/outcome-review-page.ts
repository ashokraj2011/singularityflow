/**
 * The outcome review page body and script, kept free of the `vscode` module so tests render it
 * directly. Every status word comes from the engine; the buttons only ask the panel to run commands
 * that already exist, and the panel looks each target up in what it loaded.
 */
import { escape } from './webview.ts';
import { documentReference, type OutcomeCriterion, type OutcomeView } from './outcome-review-model.ts';

const STATUS_WORDS: Record<string, string> = { met: 'done', missing: 'not done yet', pending: 'pending' };

function button(action: string, label: string, data: Record<string, number> = {}, secondary = true): string {
  const attributes = Object.entries(data).map(([name, value]) => ` data-${name}="${value}"`).join('');
  return `<button type="button"${secondary ? ' class="secondary"' : ''} data-outcome="${escape(action)}"${attributes}>${escape(label)}</button>`;
}

function criterionHtml(criterion: OutcomeCriterion, index: number, capture: boolean): string {
  const tests = criterion.tests.map((test) => `<li><strong>${escape(test.outcome ?? 'not run')}</strong> ${escape(test.test ?? test.file ?? '')}</li>`).join('');
  const checks = criterion.checks.filter((check) => check.method !== 'test').map((check) => {
    const at = criterion.checks.indexOf(check);
    return `<li><strong>${escape(check.method)} check ${escape(check.slot)}</strong>: ${escape(STATUS_WORDS[check.status ?? ''] ?? check.status ?? 'unknown')}
      ${check.reference ? ` · compared with <code>${escape(check.reference)}</code>` : ''}
      ${check.suggestedFile ? `<p class="meta">Save the screenshot as <code>${escape(check.suggestedFile)}</code>.</p>` : ''}
      <div class="outcome-actions">
        ${check.reference ? button('reference', documentReference(check.reference) ? `Open ${check.reference}` : 'Open the reference', { criterion: index, check: at }) : ''}
        ${check.suggestedFile && capture ? button('capture', 'Capture the running screen', { criterion: index, check: at }) : ''}
        ${check.suggestedFile ? button('attach', 'Attach a screenshot…', { criterion: index, check: at }) : ''}
        ${check.suggestedFile || check.files?.length ? button('screenshot', 'Open the screenshot', { criterion: index, check: at }) : ''}
        ${check.signOff ? button('sign-off', 'Sign off…', { criterion: index, check: at }, false) : ''}
        ${check.signOff ? button('copy-sign-off', 'Copy the sign-off command', { criterion: index, check: at }) : ''}
      </div></li>`;
  }).join('');
  return `<section class="outcome-criterion"><h3>${escape(criterion.id)} <small>${escape(criterion.result ?? 'unknown')}${criterion.methods ? ` · ${escape(criterion.methods.join(', '))}` : ''}</small></h3>
    ${criterion.text ? `<p>${escape(criterion.text)}</p>` : ''}
    ${tests ? `<h4>Tests</h4><ul>${tests}</ul>` : ''}
    ${checks ? `<h4>Checks a person signs off</h4><ul>${checks}</ul>` : ''}</section>`;
}

/**
 * The page body; `error` replaces it when the review could not be read. `capture` is true when the
 * application runs and this checkout has its own Playwright, so its screen can be captured here.
 */
export function outcomeReviewHtml(view: OutcomeView | null, error: string | null, { capture = false }: { capture?: boolean } = {}): string {
  const header = `<header><h1>Check the outcome</h1>
    <p>Try what this Story delivered, see what proves each acceptance criterion, and what is still open. Optional: nothing here is recorded and no step waits for it.</p>
    ${button('refresh', 'Refresh')}</header>`;
  if (error || !view) return `${header}<p class="notice${error ? ' error' : ''}" role="status">${escape(error ?? 'Reading the outcome…')}</p>`;
  const app = view.application;
  const appHtml = app.status === 'declared' && app.entries?.length
    ? `<ul>${app.entries.map((entry) => `<li><strong>${escape(entry.name)}</strong> at <code>${escape(entry.url)}</code>: ${entry.started ? `running (pid ${escape(String(entry.pid ?? ''))})` : 'not running'}
        ${entry.portTaken ? '<p class="notice warning">Another process already listens at that address. Stop it before starting this one.</p>' : ''}</li>`).join('')}</ul>
      <div class="outcome-actions">${button('start', 'Start the application', {}, false)}</div>`
    : `<p>${escape(app.status === 'none-declared' ? 'No application is declared for this capability.' : app.message ?? 'The application could not be read.')}</p>`;
  const open = view.open;
  const openHtml = open.scopeItems.length || open.blocking.length
    ? `<section><h2>Still open for the Story's end</h2><ul>
        ${open.scopeItems.map((item, index) => `<li><strong>${escape(item.id)}</strong>: ${escape(item.text)} ${button('copy-scope', 'Copy the scope command', { item: index })}</li>`).join('')}
        ${open.blocking.map((finding) => `<li>${escape(finding.message)}</li>`).join('')}
      </ul><div class="outcome-actions">${button('decisions', 'Open the decisions')}</div></section>` : '';
  return `${header}
    <p class="meta">${escape(view.workId)}${view.title ? ` · ${escape(view.title)}` : ''}</p>
    <p><strong>${escape(view.lifecycle ?? 'Lifecycle unknown')}</strong> · ${escape(view.completion ?? 'Completion unknown')}</p>
    <section><h2>Try it</h2>${appHtml}</section>
    <section><h2>Acceptance criteria</h2>${view.criteria.length ? view.criteria.map((criterion, index) => criterionHtml(criterion, index, capture)).join('') : '<p>No acceptance criteria are recorded yet.</p>'}
      <div class="outcome-actions">${button('tests', 'Run the tests')}${button('matrix', 'Open the Evidence Matrix')}</div></section>
    ${openHtml}
    <p class="muted">A screenshot or a passing test is not a sign-off. Sign-offs and decisions stay with the people who own them.</p>`;
}

export const OUTCOME_REVIEW_STYLE = `
.outcome-criterion{border:var(--sf-border);border-radius:var(--sf-radius);padding:var(--sf-space-3);margin:var(--sf-space-3) 0}
.outcome-criterion h3 small{font-weight:normal;color:var(--sf-dim)}.outcome-actions{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.outcome-criterion code,.outcome-criterion p{overflow-wrap:anywhere}`;

export const OUTCOME_REVIEW_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-outcome]') : null;
    if (!target || target.disabled) return;
    const d = target.dataset;
    vscode.postMessage({ type: 'action', action: d.outcome,
      criterion: d.criterion === undefined ? null : Number(d.criterion), check: d.check === undefined ? null : Number(d.check),
      item: d.item === undefined ? null : Number(d.item) });
  });
`;
