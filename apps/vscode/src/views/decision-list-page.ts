/** The decision list page: each item in plain words, its choices as buttons, and its editable needs. */
import { brandLockup, escape, icon } from './webview.ts';
import type { DecisionItemRow, DecisionListView, DecisionOptionRow } from './decision-list-model.ts';

function needsHtml(item: DecisionItemRow, option: DecisionOptionRow): string {
  const chosen = item.chosen?.option === option.id ? item.chosen : null;
  const fields: string[] = [];
  const { reason, cause, expires } = option.needs;
  if (expires) {
    fields.push(`<label class="field dl-field"><span>Until</span>
      <input type="date" data-field="expires" value="${escape(chosen?.expires ?? expires.default)}" max="${escape(expires.latest)}" required
        aria-label="${escape(`${item.title}: until`)}">
      <small>It needs a decision again after this date; ${escape(expires.latest)} at the latest.</small></label>`);
  }
  if (cause) {
    fields.push(`<label class="field dl-field"><span>What stops the tests</span>
      <textarea data-field="cause" minlength="${cause.minimum}" maxlength="${cause.maximum}" rows="2" required
        aria-label="${escape(`${item.title}: what stops the tests`)}">${escape(chosen?.cause ?? cause.default)}</textarea>
      <small>${cause.minimum} to ${cause.maximum} characters.</small></label>`);
  }
  if (reason) {
    fields.push(`<label class="field dl-field"><span>Reason</span>
      <textarea data-field="reason" minlength="${reason.minimum}" maxlength="${reason.maximum}" rows="3" required
        aria-label="${escape(`${item.title}: reason`)}">${escape(chosen?.reason ?? reason.default)}</textarea>
      <small>Recorded with your name; ${reason.minimum} to ${reason.maximum} characters. The suggested wording is yours to change.</small></label>`);
  }
  if (!fields.length) return '';
  return `<div class="dl-needs" data-needs-for="${escape(option.id)}"${chosen ? '' : ' hidden'}>${fields.join('')}</div>`;
}

function optionHtml(item: DecisionItemRow, option: DecisionOptionRow): string {
  const recommended = option.recommended ? '<span class="pill ok">Recommended</span>' : '';
  if (option.yours) {
    return `<div class="dl-option yours" data-yours="${escape(option.id)}">
      <strong>${escape(option.label)}</strong>${recommended}<small>${escape(option.notChoosable ?? '')} ${escape(option.words)}</small>
      <code>${escape(option.yours.command)}</code>
      <button type="button" class="secondary compact-action" data-copy-item="${escape(item.id)}" data-copy-option="${escape(option.id)}">Copy the command</button>
    </div>`;
  }
  if (!option.choosable) {
    return `<button type="button" class="dl-option" disabled aria-disabled="true">
      <strong>${escape(option.label)}</strong>${recommended}<small>${escape(option.notChoosable ?? '')}</small></button>`;
  }
  const pressed = item.chosen?.option === option.id;
  return `<button type="button" class="dl-option" data-option="${escape(option.id)}" aria-pressed="${pressed}">
    <strong>${escape(option.label)}</strong>${recommended}<small>${escape(option.words)}</small></button>`;
}

function itemHtml(item: DecisionItemRow): string {
  const heading = `<header class="dl-item-head"><span class="dl-id">${escape(item.id)}</span><h2>${escape(item.title)}</h2></header>
    <p class="dl-why">${escape(item.why)}</p>
    <p class="dl-who">${icon('team')}<span>${escape(item.who)}</span></p>`;
  if (!item.allowed) {
    return `<article class="dl-item not-yours" data-item="${escape(item.id)}" data-allowed="false">${heading}
      <div class="dl-share"><span>Share this with them:</span> <code>${escape(item.share ?? '')}</code>
        <button type="button" class="secondary compact-action" data-copy-item="${escape(item.id)}">Copy</button></div>
      <details class="dl-their-options"><summary>Their choices (${item.options.length})</summary><ul>${item.options
        .map((option) => `<li>${escape(option.label)}${option.recommended ? ' (recommended)' : ''}</li>`).join('')}</ul></details>
    </article>`;
  }
  return `<article class="dl-item" data-item="${escape(item.id)}" data-allowed="true">${heading}
    <div class="dl-options" role="group" aria-label="${escape(`Choices for ${item.title}`)}">${item.options.map((option) => optionHtml(item, option)).join('')}</div>
    ${item.options.filter((option) => option.choosable).map((option) => needsHtml(item, option)).join('')}
  </article>`;
}

function outcomeHtml(view: DecisionListView): string {
  const outcome = view.outcome;
  if (!outcome) return '';
  const kind = outcome.kind === 'recorded' ? 'ok' : outcome.kind === 'stale' ? 'warning' : 'error';
  const lists = [
    outcome.recorded.length ? `<p><strong>Recorded:</strong></p><ul>${outcome.recorded.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : '',
    outcome.remaining.length ? `<p><strong>${outcome.kind === 'partial' ? 'Not recorded:' : 'Still to decide:'}</strong></p><ul>${outcome.remaining.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''
  ].join('');
  return `<div class="notice ${kind}" data-outcome="${escape(outcome.kind)}" role="status"><p><strong>${escape(outcome.message)}</strong></p>${lists}</div>`;
}

export function decisionListHtml(view: DecisionListView): string {
  if (!view.available) {
    return `<header class="inbox-header">${brandLockup()}<p class="eyebrow">Decide</p><h1>${icon('approval', { size: 24 })}Decisions</h1></header>
      ${view.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(view.error)}</div>` : ''}
      <div class="empty"><p>${view.busy ? 'Reading the decision list…' : 'Select a Story to see what its step is waiting on.'}</p></div>`;
  }
  const items = view.nothingToDecide
    ? `<div class="empty-state dl-empty">${icon('ok')}<strong>Nothing is waiting for a decision.</strong><p>Refresh after someone records a choice, or continue with the step.</p></div>`
    : view.items.map(itemHtml).join('');
  // Review is offered when something here can be recorded; a person's own steps are copied, not reviewed.
  const yours = view.items.some((item) => item.allowed && item.options.some((option) => option.choosable));
  return `<form class="dl-list" data-digest="${escape(view.digest ?? '')}">
    <header class="inbox-header dl-header"><div>${brandLockup()}<p class="eyebrow">Decide · ${escape(view.phaseLabel ?? '')}</p>
      <h1>${icon('approval', { size: 24 })}Decisions · ${escape(view.workId)}</h1><p class="meta">${escape(view.headline)}</p></div>
      <div class="header-actions"><button type="button" class="secondary" data-action="refresh"${view.busy ? ' disabled' : ''}>${icon('refresh')}Refresh</button></div></header>
    ${view.busy ? '<div class="notice warning" role="status">Working… The list refreshes when it finishes.</div>' : ''}
    ${view.notice ? `<div class="notice ok" role="status">${icon('ok')}${escape(view.notice)}</div>` : ''}
    ${outcomeHtml(view)}
    ${view.error ? `<div class="notice error" role="alert">${icon('blocked')}${escape(view.error)}</div>` : ''}
    ${view.unavailable.map((line) => `<div class="notice warning">${icon('warning')}${escape(line)}</div>`).join('')}
    <div class="dl-items">${items}</div>
    ${view.rule ? `<p class="muted dl-rule">${escape(view.rule)}</p>` : ''}
    ${yours ? `<div class="dl-actions"><p class="muted" data-progress aria-live="polite"></p>
      <button type="submit" data-action="review" disabled>${icon('approval')}Review choices</button></div>` : ''}
  </form>`;
}

export const DECISION_LIST_STYLE = `
.dl-items { display:grid; gap:1rem; margin:1rem 0; }
.dl-item { display:grid; gap:.6rem; padding:1rem; border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
.dl-item.not-yours { border-left:4px solid var(--sf-wait); }
.dl-item-head { display:flex; gap:.6rem; align-items:baseline; }
.dl-item-head h2 { margin:0; font-size:1.05rem; overflow-wrap:anywhere; }
.dl-id { font-family:var(--vscode-editor-font-family); color:var(--sf-dim); }
.dl-why, .dl-who { margin:0; }
.dl-who { display:flex; gap:.4rem; align-items:center; color:var(--sf-dim); }
.dl-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr)); gap:.6rem; }
.dl-option { display:grid; grid-template-columns:minmax(0,1fr); justify-content:stretch; gap:.3rem; text-align:left; padding:.7rem .8rem; min-width:0; border:var(--sf-border); border-radius:var(--sf-radius);
  color:var(--vscode-foreground); background:var(--vscode-editor-background); font:inherit; }
button.dl-option:not([disabled]) { cursor:pointer; }
button.dl-option:not([disabled]):hover { border-color:var(--sf-accent); }
.dl-option[aria-pressed="true"] { border:2px solid var(--sf-accent); background:var(--sf-accent-quiet); }
.dl-option[disabled] { opacity:.62; }
.dl-option > * { justify-self:start; text-align:left; }
.dl-option small { color:var(--sf-dim); overflow-wrap:anywhere; }
.dl-option .pill { justify-self:start; }
.dl-option.yours code { overflow-wrap:anywhere; white-space:pre-wrap; }
.dl-needs { display:grid; gap:.6rem; padding:.7rem .8rem; border-left:3px solid var(--sf-accent); }
.dl-needs[hidden] { display:none; }
.dl-field { display:grid; gap:.3rem; }
.dl-field textarea, .dl-field input { width:100%; padding:.45rem .55rem; color:var(--vscode-input-foreground); background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--sf-border-color)); border-radius:3px; font:inherit; }
.dl-field textarea { resize:vertical; }
.dl-field small { color:var(--sf-dim); }
.dl-share { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; }
.dl-share code { overflow-wrap:anywhere; }
.dl-rule { margin:.5rem 0 1rem; }
.dl-actions { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:.6rem; align-items:center; padding:.6rem 0;
  border-top:var(--sf-border); background:var(--vscode-editor-background); }
.dl-actions p { flex:1 1 16rem; margin:0; }
`;

export const DECISION_LIST_SCRIPT = `
(() => {
  const api = window.__sfVscode;
  const form = document.querySelector('.dl-list');
  if (!form) return;
  const review = form.querySelector('[data-action="review"]');
  const progress = form.querySelector('[data-progress]');
  const items = () => Array.from(form.querySelectorAll('.dl-item[data-allowed="true"]'));
  const pressed = (item) => item.querySelector('[data-option][aria-pressed="true"]');
  function show(item) {
    const chosen = pressed(item);
    for (const block of item.querySelectorAll('[data-needs-for]')) block.hidden = !chosen || block.dataset.needsFor !== chosen.dataset.option;
  }
  function choices() {
    return items().flatMap((item) => {
      const chosen = pressed(item);
      if (!chosen) return [];
      const choice = { item: item.dataset.item, option: chosen.dataset.option };
      const block = item.querySelector('[data-needs-for="' + chosen.dataset.option + '"]');
      for (const field of block ? block.querySelectorAll('[data-field]') : []) choice[field.dataset.field] = field.value;
      return [choice];
    });
  }
  function sync() {
    const count = choices().length;
    if (review) review.disabled = count === 0;
    if (progress) progress.textContent = count
      ? count + ' chosen. Review them before anything is recorded.'
      : 'Choose an option for an item, then review your choices. Nothing is recorded until you confirm.';
  }
  form.addEventListener('click', (event) => {
    const option = event.target.closest('[data-option]');
    if (option && !option.disabled) {
      const item = option.closest('.dl-item');
      const was = option.getAttribute('aria-pressed') === 'true';
      for (const other of item.querySelectorAll('[data-option]')) other.setAttribute('aria-pressed', 'false');
      option.setAttribute('aria-pressed', String(!was));
      show(item); sync();
      return;
    }
    const copy = event.target.closest('[data-copy-item]');
    if (copy) { api.postMessage({ type: 'decisions.copy', item: copy.dataset.copyItem, option: copy.dataset.copyOption || '' }); return; }
    const action = event.target.closest('[data-action="refresh"]');
    if (action) api.postMessage({ type: 'decisions.refresh' });
  });
  form.addEventListener('input', sync);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const chosen = choices();
    if (!chosen.length) return;
    if (review) review.disabled = true;
    api.postMessage({ type: 'decisions.review', digest: form.dataset.digest, choices: chosen });
  });
  for (const item of items()) show(item);
  sync();
})();
`;
