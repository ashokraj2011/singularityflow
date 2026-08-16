/**
 * The result card. `[UXH:REQ-060]`–`[UXH:REQ-065]` `[UXH:AC-003]`
 *
 * Renders a fragment rather than a page, because a card appears inside the home, inside a packet
 * and inside a panel, and a card that could only be a page would be reimplemented in each.
 *
 * The layout is Screen A: headline with the gate count, the deterministic reason, one row per gate
 * with its own fix action, and the preservation sentence last. The order is not decoration. A
 * refused reader wants four things and asks for them in that sequence — what is blocked, why, what
 * is still intact, what is safe next — and the last two are the ones a red error box drops.
 */
import { escape, icon } from './webview.ts';
import type { CardAction, ChecklistRow, ResultCardView } from './result-card-model.ts';

/**
 * Styles for the card only, scoped under `.sf-card`.
 *
 * Kept beside the markup rather than added to the shared `STYLE` block: this is the first surface
 * built on the envelope, and a panel adopting it should be able to take the pair without inheriting
 * a global it cannot see the edges of.
 */
/**
 * Secondary is outlined, primary is filled, and that is not a theme preference. `[UXH:REQ-064]`
 *
 * The first version used `--vscode-button-secondaryBackground` for secondary and
 * `--vscode-button-background` for primary — the documented pair, and correct in the fixture. In
 * the editor's actual theme both resolve to the same green, so all six home actions rendered as
 * identical filled buttons while the envelope carried exactly one `primary`. The rule survived in
 * the data and died in the CSS, which is the failure no contract check can see.
 *
 * Filled-versus-outlined is a contrast a theme cannot collapse: whatever those variables hold, a
 * button with a background and a button without one are different.
 *
 * (This note lives outside the template literal. Inside it, the backticks around a clause anchor
 * close the string — which is how it first got here.)
 */
export const RESULT_CARD_STYLE = `
.sf-card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px;
  background: var(--vscode-editorWidget-background); display: flex; flex-direction: column; gap: 12px; }
.sf-card-refusal { border-left: 3px solid var(--vscode-editorWarning-foreground); }
.sf-card-ceremony { border-left: 3px solid var(--vscode-charts-purple, var(--vscode-textLink-foreground)); }
.sf-card h3 { margin: 0; font-size: 1.02em; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sf-card-why { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.sf-card-why li { color: var(--vscode-descriptionForeground); }
.sf-card-why b { color: var(--vscode-foreground); font-weight: 600; }
.sf-gates { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.sf-gate { display: flex; align-items: center; gap: 8px; padding: 5px 0; }
.sf-gate .ico { flex: none; }
.sf-gate-met .ico { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.sf-gate-unmet .ico { color: var(--vscode-editorWarning-foreground); }
.sf-gate-unknown .ico { color: var(--vscode-descriptionForeground); opacity: .7; }
.sf-gate-label { flex: 1 1 auto; }
.sf-gate-unknown .sf-gate-label { color: var(--vscode-descriptionForeground); }
.sf-gate-detail { display: block; font-size: .9em; color: var(--vscode-descriptionForeground); }
.sf-card-preserved { margin: 0; padding: 10px 12px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); }
.sf-card-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: stretch; }
.sf-card-actions button { font: inherit; padding: 5px 12px; border-radius: 3px; cursor: pointer;
  text-align: left; background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border); }
.sf-card-actions button:hover { background: var(--vscode-list-hoverBackground); }
.sf-card-actions button.primary { font-weight: 600; border-color: transparent;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.sf-card-actions button.primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
.sf-card-actions button.link { background: none; border: none; color: var(--vscode-textLink-foreground); text-decoration: underline; padding: 5px 2px; }
/* Outlined for the same reason: a fix button is never the card's one filled action. */
.sf-gate button { font: inherit; padding: 3px 10px; border-radius: 3px; cursor: pointer; flex: none;
  border: 1px solid var(--vscode-panel-border);
  background: transparent; color: var(--vscode-foreground); }
.sf-gate button:hover { background: var(--vscode-list-hoverBackground); }
.sf-card details { color: var(--vscode-descriptionForeground); }
.sf-card details pre { margin: 6px 0 0; padding: 8px; overflow-x: auto; user-select: text;
  background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
.sf-card-rest { color: var(--vscode-descriptionForeground); font-style: italic; }
`;

function button(action: CardAction, className: string): string {
  /**
   * `data-action-id`, never an operation name or a handle.
   *
   * The host looks the id up in the result it rendered and dispatches through the executor, which
   * re-resolves the handle. Putting the handle in the DOM would make it reachable from any script
   * that reaches the webview, and putting the operation name there would let a click name something
   * the kernel never offered.
   */
  const title = action.command ? ` title="Terminal equivalent: ${escape(action.command)}"` : '';
  return `<button type="button" class="${className}" data-action-id="${escape(action.id)}"${title}>${escape(action.label)}</button>`;
}

function gateRow(row: ChecklistRow): string {
  const fix = row.action ? button(row.action, 'fix') : '';
  const detail = row.detail ? `<span class="sf-gate-detail">${escape(row.detail)}</span>` : '';
  /**
   * `aria-label` carries the state in words.
   *
   * The icon is `aria-hidden`, so without this a screen reader hears five gate names and no
   * indication that two of them are the reason nothing can be submitted.
   */
  return `<li class="sf-gate sf-gate-${row.state}" aria-label="${escape(`${row.label}: ${row.state}`)}">
    ${icon(row.icon)}
    <span class="sf-gate-label">${escape(row.label)}${detail}</span>
    ${fix}
  </li>`;
}

export function resultCardHtml(view: ResultCardView): string {
  const why = view.why.length
    ? `<ul class="sf-card-why">${view.why.map((entry) =>
      `<li><b>${escape(entry.label)}</b>${entry.detail ? ` ${escape(entry.detail)}` : ''}</li>`).join('')}</ul>`
    : '';

  const warnings = view.warnings.length
    ? `<ul class="sf-card-why">${view.warnings.map((entry) =>
      `<li>${icon('statusWarning', { size: 14 })} ${escape(entry.label)}${entry.detail ? ` ${escape(entry.detail)}` : ''}</li>`).join('')}</ul>`
    : '';

  const gates = view.checklist.length
    ? `<ul class="sf-gates">${view.checklist.map(gateRow).join('')}</ul>`
    : '';

  /**
   * The preservation statement, in the position it earns.
   *
   * Last, in its own block, after the reader has seen what is blocked and what to do. It is the
   * sentence that decides whether they act on the card or go and check their branch, and burying it
   * among the reasons is the same as not saying it.
   */
  const preserved = view.preserved.length
    ? `<p class="sf-card-preserved">${view.preserved.map((entry) =>
      escape([entry.label, entry.detail].filter(Boolean).join(' — '))).join(' ')}</p>`
    : '';

  /**
   * Fix buttons already appear on their rows, so they are not repeated below `[UXH:REQ-064]`.
   * A card with the same action twice makes the reader wonder whether they are different.
   */
  const onRows = new Set(view.checklist.map((row) => row.action?.id).filter(Boolean));
  const footerActions = view.actions.filter((action) => !onRows.has(action.id));
  const actions = footerActions.length
    ? `<div class="sf-card-actions">${footerActions.map((action) =>
      button(action, action.emphasis === 'primary' ? 'primary' : action.emphasis === 'link' ? 'link' : '')).join('')}</div>`
    : '';

  /**
   * A rest state is a real answer and is said out loud `[INT:REQ-041]`.
   *
   * "Nothing is waiting on you" is information. A card that simply ends, with no actions and no
   * statement, is indistinguishable from one that failed to load.
   */
  const rest = !footerActions.length && view.rest
    ? `<p class="sf-card-rest">${escape(view.rest === 'blocked'
      ? 'There is no step you can take here right now.'
      : 'Nothing further is needed.')}</p>`
    : '';

  const details = `<details><summary>Technical details</summary><pre>${escape(
    Object.entries(view.details).map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre></details>`;

  return `<section class="sf-card sf-card-${view.tone}">
    <h3>${icon(view.tone === 'refusal' ? 'statusBlocked' : 'statusCurrent')} ${escape(view.headline)}</h3>
    ${why}${warnings}${gates}${preserved}${actions}${rest}${details}
  </section>`;
}

/**
 * Delegated click handling for every card on a page.
 *
 * One listener on the document rather than one per button: a card is re-rendered whenever its
 * result changes, and per-button listeners are how a re-render silently stops responding.
 */
export const RESULT_CARD_SCRIPT = `
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element ? event.target.closest('[data-action-id]') : null;
  if (!button) return;
  vscode.postMessage({ type: 'sflow.action', actionId: button.getAttribute('data-action-id') });
});
`;
