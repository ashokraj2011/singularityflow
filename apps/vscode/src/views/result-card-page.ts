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
import { message } from './result-messages.ts';
import type { CardAction, ChecklistRow, HomeAttentionView, ResultCardView } from './result-card-model.ts';

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
.sf-card-greeting { margin: 0; color: var(--vscode-descriptionForeground); }
.sf-faults { display: grid; gap: 8px; }
.sf-fault { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; padding: 10px 12px;
  border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 5px; }
.sf-fault-badge { grid-row: 1 / span 2; align-self: start; color: var(--vscode-editorWarning-foreground);
  font-size: .78em; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.sf-fault-title { font-weight: 600; overflow-wrap: anywhere; }
.sf-fault-summary { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.sf-rail { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 0; padding: 0; list-style: none;
  font-size: .92em; color: var(--vscode-descriptionForeground); }
.sf-rail li { display: flex; align-items: center; gap: 5px; }
.sf-rail-done { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.sf-rail-current { color: var(--vscode-foreground); font-weight: 600; }
.sf-rail-mark { font-variant-numeric: tabular-nums; }
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
.sf-guidance { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--vscode-panel-border);
  border-radius: 6px; background: var(--vscode-sideBar-background); }
.sf-guidance-context { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.sf-guidance-context span { display: grid; gap: 2px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: .85em; }
.sf-guidance-context strong { color: var(--vscode-foreground); overflow-wrap: anywhere; }
.sf-guidance-change { margin: 0; }
.sf-guidance-command { margin: 0; padding: 8px; overflow-x: auto; user-select: text;
  background: var(--vscode-textCodeBlock-background); border-radius: 4px; }
.sf-guidance-list { margin: 6px 0 0; padding-left: 20px; }
.sf-guidance-ready { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.sf-guidance-attention, .sf-guidance-needed, .sf-guidance-unknown { color: var(--vscode-editorWarning-foreground); }
/*
 * The briefing block. Bordered rather than filled, so it does not compete with the preservation
 * statement — that block is the one a refused reader must not miss, and two filled panels on one
 * card make neither of them the emphasis.
 */
.sf-since { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px;
  padding: 10px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.sf-since-text { flex: 1 1 240px; display: flex; flex-direction: column; gap: 3px; }
.sf-since-head { font-weight: 600; display: flex; align-items: center; gap: 6px; }
.sf-since-at { font-weight: 400; color: var(--vscode-descriptionForeground); font-size: .92em; }
.sf-since-summary { color: var(--vscode-descriptionForeground); }
.sf-since-changes { margin: 2px 0 0; padding-left: 18px; color: var(--vscode-foreground); }
/* An unverifiable answer is marked as one, in the colour the rest of the shell uses for unknown. */
.sf-since-incomparable .sf-since-head { color: var(--vscode-editorWarning-foreground); }
.sf-since button { font: inherit; padding: 4px 11px; border-radius: 3px; cursor: pointer; flex: none;
  border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); }
.sf-since button:hover { background: var(--vscode-list-hoverBackground); }
.sf-receipt { display:grid; gap:7px; padding:10px 12px; border:1px solid var(--vscode-panel-border);
  border-radius:4px; background:var(--vscode-sideBar-background); }
.sf-receipt-head { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
.sf-receipt-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; }
.sf-receipt-grid span { display:grid; gap:2px; color:var(--vscode-descriptionForeground); font-size:.84em; }
.sf-receipt-grid strong { color:var(--vscode-foreground); font-weight:500; overflow-wrap:anywhere; }
.sf-flight-plan { display:grid; gap:12px; padding:14px; border:1px solid var(--vscode-panel-border); border-radius:6px; }
.sf-flight-plan h4, .sf-flight-plan p { margin:0; }
.sf-flight-summary { display:flex; flex-wrap:wrap; gap:7px; }
.sf-flight-summary span { padding:3px 8px; border:1px solid var(--vscode-panel-border); border-radius:999px; }
.sf-flight-findings { margin:0; padding:0; list-style:none; display:grid; gap:7px; }
.sf-flight-findings li { display:grid; grid-template-columns:auto 1fr; gap:3px 8px; }
.sf-flight-mark { font-weight:700; }
.sf-flight-mark-proven { color:var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.sf-flight-mark-inferred, .sf-flight-mark-unknown { color:var(--vscode-editorWarning-foreground); }
.sf-flight-detail { color:var(--vscode-descriptionForeground); font-size:.9em; }
.sf-home { display:grid; gap:18px; }
.sf-home-header { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:16px;
  padding-bottom:16px; border-bottom:1px solid var(--vscode-panel-border); }
.sf-home-title { display:grid; gap:4px; }
.sf-home-title h2 { margin:0; font-size:1.7rem; }
.sf-home-title p { margin:0; color:var(--vscode-descriptionForeground); }
.sf-home-context { display:flex; flex-wrap:wrap; gap:7px; justify-content:flex-end; }
.sf-chip { display:inline-flex; align-items:center; min-height:26px; padding:2px 9px; border-radius:999px;
  border:1px solid var(--vscode-panel-border); color:var(--vscode-descriptionForeground); font-size:.86em; }
.sf-chip-local { border-color:var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  color:var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.sf-home-prompt { padding:16px; border:1px solid var(--vscode-focusBorder); border-radius:8px;
  background:var(--vscode-editorWidget-background); display:grid; gap:12px; }
.sf-home-prompt label { font-weight:600; }
.sf-home-prompt-row { display:flex; gap:8px; }
.sf-home-prompt input { flex:1 1 auto; min-width:0; padding:8px 10px; color:var(--vscode-input-foreground);
  background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:4px; }
.sf-home-prompt button, .sf-home-card button { font:inherit; padding:6px 12px; border-radius:4px; cursor:pointer;
  border:1px solid var(--vscode-panel-border); color:var(--vscode-foreground); background:transparent; }
.sf-home-prompt button:hover, .sf-home-card button:hover { background:var(--vscode-list-hoverBackground); }
.sf-home button:focus-visible, .sf-home input:focus-visible, .sf-home summary:focus-visible {
  outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
.sf-home-card button.primary { border-color:transparent; color:var(--vscode-button-foreground);
  background:var(--vscode-button-background); font-weight:600; }
.sf-home-goals { display:flex; flex-wrap:wrap; gap:8px; }
.sf-home-goals button { font:inherit; padding:5px 10px; border-radius:4px; cursor:pointer;
  color:var(--vscode-foreground); background:transparent; border:1px solid var(--vscode-panel-border); }
.sf-home-grid { display:grid; grid-template-columns:minmax(0, 2fr) minmax(260px, 1fr); gap:18px; align-items:start; }
.sf-home-column { display:grid; gap:18px; }
.sf-home-card { display:grid; gap:12px; padding:16px; border:1px solid var(--vscode-panel-border); border-radius:8px;
  background:var(--vscode-editorWidget-background); }
.sf-home-card h3 { margin:0; font-size:1.04rem; }
.sf-home-card p { margin:0; }
.sf-home-muted { color:var(--vscode-descriptionForeground); }
.sf-home-needs { border-left:3px solid var(--vscode-editorWarning-foreground); }
.sf-home-work-head { display:flex; flex-wrap:wrap; gap:8px 12px; justify-content:space-between; }
.sf-home-work-title { font-weight:650; }
.sf-home-list { margin:0; padding:0; list-style:none; display:grid; gap:10px; }
.sf-home-list li { display:grid; gap:3px; padding-bottom:10px; border-bottom:1px solid var(--vscode-panel-border); }
.sf-home-list li:last-child { border-bottom:0; padding-bottom:0; }
.sf-home-item-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.sf-home-privacy { display:flex; align-items:center; gap:6px; color:var(--vscode-testing-iconPassed, var(--vscode-charts-green)); font-size:.88em; }
.sf-home-health { display:flex; align-items:center; gap:8px; }
.sf-home-details { color:var(--vscode-descriptionForeground); }
.sf-home, .sf-home * { overflow-wrap:anywhere; }
@media (max-width: 780px) {
  .sf-home-grid { grid-template-columns:1fr; }
  .sf-home-context { justify-content:flex-start; }
  .sf-home-prompt-row { flex-direction:column; }
}
@media (prefers-reduced-motion: reduce) {
  .sf-home *, .sf-home *::before, .sf-home *::after { scroll-behavior:auto!important; transition:none!important; animation:none!important; }
}
@media (forced-colors: active) {
  .sf-home-card, .sf-home-prompt, .sf-chip { border-color:CanvasText; }
  .sf-home-needs { border-left-color:Highlight; }
  .sf-home-card button.primary { color:HighlightText; background:Highlight; }
}
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

/**
 * The phase rail. `[UXH:REQ-050]`
 *
 * Screen B's `intake ✓ design ✓ implement ● verify ○ release ○`, drawn from the pinned definition.
 * Text marks rather than icons: the rail is a line of type, and it has to stay one line of type at
 * a narrow sidebar width where seven SVGs would wrap into a grid.
 *
 * The `aria-label` carries the state in words for the same reason the checklist rows do — a screen
 * reader given five phase names and no marks hears a list, not a position.
 */
const MARKS = Object.freeze({ done: '✓', current: '●', pending: '○' });

/**
 * One sentence per rest state. `[UXH:REQ-051]` `[INT:REQ-041]`
 *
 * This was a two-branch ternary over a field with three live values, so `complete` and
 * `informational` rendered the same words — "Nothing further is needed" for work that had *finished*
 * and for a briefing that simply had nothing to add. A reader cannot tell those apart, and they are
 * the difference between "you are done" and "there was nothing to say".
 *
 * A record rather than a chain, so the compiler pairs it with `REST_STATES`: adding a state without
 * a sentence is now a visible gap rather than a silent fall-through to the friendliest wording.
 */
const REST_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  blocked: 'There is no step you can take here right now.',
  complete: 'This work is finished; nothing further is needed.',
  informational: 'This is a read. There is nothing to do with it.',
  unavailable: 'This build cannot answer that yet. The terminal equivalent still can.',
  'awaiting-decision': 'This is waiting on a decision only a person can make.'
});

function railHtml(view: ResultCardView): string {
  if (!view.rail.length) return '';
  return `<ul class="sf-rail" aria-label="Phase progress">${view.rail.map((phase) => `<li
    class="sf-rail-${phase.state}"
    aria-label="${escape(`${phase.label}: ${phase.state}`)}"
  ><span class="sf-rail-mark" aria-hidden="true">${MARKS[phase.state] ?? '·'}</span>${escape(phase.label)}</li>`).join('')}</ul>`;
}

function receiptHtml(view: ResultCardView): string {
  const receipt = view.receipt;
  if (!receipt) return '';
  const values = [
    ['Changes', receipt.changes], ['Checks', receipt.checks], ['Approvals', receipt.approvals],
    ['Publication', receipt.publication]
  ];
  return `<section class="sf-receipt" aria-label="Latest evidence receipt">
    <span class="sf-receipt-head"><b>${icon('approval', { size: 14 })} Latest evidence receipt</b>
      <code>${escape(receipt.sha256.slice(0, 12))}</code></span>
    <span>${escape(receipt.workId)} · ${escape(receipt.phase)} · generation ${receipt.generation}</span>
    <span class="sf-receipt-grid">${values.map(([label, value]) => `<span>${escape(label)}<strong>${escape(value)}</strong></span>`).join('')}</span>
  </section>`;
}

/**
 * When the reader last acknowledged, in words they can place.
 *
 * A raw ISO timestamp is precise and unreadable; "3 hours ago" is readable and, at the top of the
 * range, wrong in the direction that matters — a reader told "2 days ago" who left three weeks of
 * commits behind will read the delta as small. Both, then: the relative phrase to orient, the date
 * to check.
 */
function acknowledgedAt(at: string, now: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return at;
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  const relative = minutes < 1 ? 'just now'
    : minutes < 60 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago`
      : minutes < 60 * 24 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'} ago`
        : `${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? '' : 's'} ago`;
  return `${relative} · ${new Date(then).toLocaleString()}`;
}

/**
 * The return briefing. `[DHR:REQ-024]` `[UXH:REQ-020]`
 *
 * The heading is the load-bearing part and comes from the model, which is where the three states
 * are decided. Nothing is derived here — a renderer that inferred "nothing changed" from an empty
 * change list would reintroduce, in markup, exactly the conflation the model exists to prevent:
 * `incomparable` also has an empty list.
 */
function sinceHtml(view: ResultCardView, now: number): string {
  const since = view.since;
  if (!since) return '';
  const when = since.at ? `<span class="sf-since-at">${escape(acknowledgedAt(since.at, now))}</span>` : '';
  /**
   * `statusIdle` for an unknown, the same icon the checklist gives a gate nobody evaluated.
   *
   * One vocabulary for "we did not establish this" across the shell, so a reader who has learned
   * what the dimmed circle means on a refusal card already knows what it means here.
   */
  const glyph = since.state === 'incomparable' ? 'statusIdle' : 'statusCurrent';
  const changes = since.changes.length
    ? `<ul class="sf-since-changes">${since.changes.map((change) => `<li>${escape(change)}</li>`).join('')}</ul>`
    : '';
  /**
   * The button carries a `data-action-id` like every other control on the card.
   *
   * It is not a `next[]` action and the kernel never offered it, so the panel checks it by name
   * before dispatching rather than looking it up in the envelope. One click path for the whole card
   * is worth more than the purity of having only kernel-issued ids in the DOM — a second postMessage
   * shape is a second thing the router must enumerate and a second thing to get wrong.
   */
  const button = since.action
    ? `<button type="button" data-action-id="${escape(since.action.id)}">${escape(since.action.label)}</button>`
    : '';
  return `<section class="sf-since sf-since-${since.state}" aria-label="${escape(since.heading)}">
    <span class="sf-since-text">
      <span class="sf-since-head">${icon(glyph, { size: 14 })}${escape(since.heading)}${when}</span>
      <span class="sf-since-summary">${escape(since.summary)}</span>
      ${changes}
    </span>
    ${button}
  </section>`;
}

function guidanceHtml(view: ResultCardView): string {
  const guidance = view.guidance;
  if (!guidance) return '';
  const context = [
    ['Workspace', guidance.context.workspace],
    ['Work', guidance.context.workId],
    ['Phase', guidance.context.phase]
  ].filter(([, value]) => value);
  const contextHtml = context.length ? `<div class="sf-guidance-context">${context.map(([label, value]) =>
    `<span>${escape(label!)}<strong>${escape(value!)}</strong></span>`).join('')}</div>` : '';
  const effectLabels: Record<string, string> = {
    read: 'Nothing. This is a read-only recommendation.',
    synchronize: 'Synchronizes the retained commit or branch with its configured remote.',
    decision: 'Records governed lifecycle state and publishes the attributed decision.',
    generation: 'May update generated artifacts and governed lifecycle records.',
    mutation: 'May update governed state, Git refs, publication, or an external system.'
  };
  const recommendation = guidance.recommendation ? `
    <p class="sf-guidance-change"><b>This will change:</b> ${escape(effectLabels[guidance.recommendation.effect]
      ?? effectLabels.mutation)}${guidance.recommendation.confirmationRequired
    ? ' Nothing runs until you explicitly authorize the governed action.' : ''}</p>
    <pre class="sf-guidance-command">${escape(guidance.recommendation.command)}</pre>` : '';
  const preflight = guidance.preflight.length ? `<details><summary>Before you continue</summary>
    <ul class="sf-guidance-list">${guidance.preflight.map((entry) => `<li class="sf-guidance-${escape(entry.state)}">
      <b>${escape(entry.id)}</b> — ${escape(entry.detail)}</li>`).join('')}</ul></details>` : '';
  const evidence = guidance.evidence ? `<details><summary>Evidence already captured</summary>
    <ul class="sf-guidance-list">
      <li>Artifacts: ${guidance.evidence.artifacts.recorded}/${guidance.evidence.artifacts.total} recorded</li>
      <li>Checks: ${guidance.evidence.checks.passed} passed, ${guidance.evidence.checks.failed} failed, ${guidance.evidence.checks.total} total</li>
      <li>Approvals: ${guidance.evidence.approvals.approved}/${guidance.evidence.approvals.total} approved</li>
    </ul></details>` : '';
  const inputs = guidance.requiredInputs.length ? `<details><summary>What SFlow still needs from you</summary>
    <ul class="sf-guidance-list">${guidance.requiredInputs.map((entry) => `<li>${escape(entry)}</li>`).join('')}</ul></details>` : '';
  return `<section class="sf-guidance" aria-label="Developer guidance">${contextHtml}${recommendation}${preflight}${evidence}${inputs}</section>`;
}

function faultsHtml(view: ResultCardView): string {
  const unresolved = view.faults.filter((fault) => fault.disposition !== 'resolved');
  if (!unresolved.length) return '';
  return `<section class="sf-faults" aria-label="Faults needing attention">${unresolved.map((fault) => `
    <article class="sf-fault">
      <span class="sf-fault-badge">${escape(fault.severity)}</span>
      <span class="sf-fault-title">${escape(fault.faultId)} · ${escape(fault.type)}${fault.repairId ? ` · ${escape(fault.repairId)}` : ''}</span>
      <span class="sf-fault-summary">${escape(fault.summary)} <button class="link" type="button" data-result-nav="faults">Open details & recovery</button></span>
    </article>`).join('')}</section>`;
}

function flightPlanHtml(view: ResultCardView): string {
  const plan = view.flightPlan;
  if (!plan) return '';
  const mark = (classification: string) => classification === 'proven' ? '✓' : classification === 'inferred' ? '~' : '?';
  const rows = plan.findings.map((finding) => `<li>
    <span class="sf-flight-mark sf-flight-mark-${escape(finding.classification)}">${mark(finding.classification)}</span>
    <span><b>${escape(finding.kind)} · ${escape(finding.subject)}</b>
      <span class="sf-flight-detail">${escape(finding.relationship)} — ${escape(finding.explanation)}</span></span>
  </li>`).join('');
  const unknowns = plan.unknowns.map((finding) => `<li>
    <span class="sf-flight-mark sf-flight-mark-unknown">?</span>
    <span><b>${escape(finding.subject)}</b><span class="sf-flight-detail">Not evaluated — ${escape(finding.explanation)}</span></span>
  </li>`).join('');
  return `<section class="sf-flight-plan" aria-label="Change Flight Plan">
    <span><h4>Change Flight Plan</h4><span class="sf-flight-detail">${escape(plan.planId)} · ${escape(plan.status)} · baseline ${escape(plan.baseline.slice(0, 12))}</span></span>
    <p><b>Intent</b><br>${escape(plan.intent)}</p>
    <div class="sf-flight-summary"><span>✓ ${plan.counts.proven} proven</span><span>~ ${plan.counts.inferred} need confirmation</span><span>? ${plan.counts.unknown} unresolved</span></div>
    ${rows ? `<span><b>Affected</b></span><ul class="sf-flight-findings">${rows}</ul>` : '<p>No affected item was established from the evaluated evidence.</p>'}
    ${unknowns ? `<span><b>Could not evaluate</b></span><ul class="sf-flight-findings">${unknowns}</ul>` : ''}
    <p><b>Recommended starting point</b><br>${escape(plan.recommendedStart)}</p>
  </section>`;
}

function homeAttention(items: readonly HomeAttentionView[], primaryId: string | null): string {
  return `<ul class="sf-home-list">${items.map((item) => {
    const reason = message(item.reasonCode).label;
    const action = item.action ? button(item.action, item.action.id === primaryId ? 'primary' : '') : '';
    return `<li><span class="sf-home-item-head"><b>${escape(item.title)}</b>${action}</span>
      <span class="sf-home-muted">${escape([item.workId, item.phase].filter(Boolean).join(' · ') || reason)}</span>
      <span class="sf-home-muted">${escape(reason)}</span></li>`;
  }).join('')}</ul>`;
}

function homeHtml(view: ResultCardView, now: number): string {
  const home = view.home!;
  const primaryId = home.now?.id ?? null;
  const needs = home.needsUser.length ? `<section class="sf-home-card sf-home-needs">
    <h3>Needs You</h3>${homeAttention(home.needsUser, primaryId)}</section>` : '';
  const nowShownInNeeds = home.needsUser.some((item) => item.action?.id === primaryId);
  const work = home.activeWork ? `<section class="sf-home-card">
    <div class="sf-home-work-head"><span><span class="sf-home-work-title">${escape(home.activeWork.id)}${
      home.activeWork.title ? ` · ${escape(home.activeWork.title)}` : ''}</span><br>
      <span class="sf-home-muted">${escape([home.activeWork.repositoryId, home.activeWork.branch, home.activeWork.phase]
        .filter(Boolean).join(' · '))}</span></span>
      ${home.now && !nowShownInNeeds ? button(home.now, 'primary') : ''}</div>
    ${railHtml(view)}${receiptHtml(view)}${sinceHtml(view, now)}
  </section>` : `<section class="sf-home-card"><h3>No active work here</h3>
    <p class="sf-home-muted">Choose a quick start below. Governed work remains in durable workspace and repository records.</p>
    ${home.now && !nowShownInNeeds ? button(home.now, 'primary') : ''}</section>`;
  const today = home.today ? `<section class="sf-home-card"><span class="sf-home-item-head"><h3>Today</h3>
    <span class="sf-home-privacy">${icon('statusPinned', { size: 14 })} Stored locally · Never pushed</span></span>
    ${(home.today.summaries ?? []).length ? `<ul class="sf-home-list">${home.today.summaries.map((item: any) =>
      `<li><b>${escape(item.workId ? `${item.workId} · ${item.text}` : item.text)}</b></li>`).join('')}</ul>`
    : '<p class="sf-home-muted">No local engineering outcomes were recorded today. This is not an activity or productivity judgment.</p>'}
    ${(home.today.attention ?? []).length ? `<ul class="sf-home-list">${home.today.attention.map((item: any) =>
      `<li><span>${icon('warning', { size: 14 })} ${escape(item.text)}</span></li>`).join('')}</ul>` : ''}
  </section>` : '';
  const yesterday = home.yesterday ? `<section class="sf-home-card"><span class="sf-home-item-head"><h3>Yesterday — where you stopped</h3>
    <span class="sf-home-privacy">${icon('statusPinned', { size: 14 })} Stored locally · Never pushed</span></span>
    ${(home.yesterday.summaries ?? []).length ? `<ul class="sf-home-list">${home.yesterday.summaries.map((item: any) =>
      `<li><b>${escape(item.workId ? `${item.workId} · ${item.text}` : item.text)}</b></li>`).join('')}</ul>`
    : '<p class="sf-home-muted">No bounded outcome summary was recorded for the previous day.</p>'}
    ${(home.yesterday.attention ?? []).length ? `<ul class="sf-home-list">${home.yesterday.attention.map((item: any) =>
      `<li><span>${icon('warning', { size: 14 })} ${escape(item.text)}</span></li>`).join('')}</ul>` : ''}
  </section>` : '';
  const worth = `<section class="sf-home-card"><h3>Worth Checking</h3>${home.worthChecking.length
    ? homeAttention(home.worthChecking, primaryId)
    : '<p class="sf-home-muted">Nothing local needs attention from the evidence read for this Home.</p>'}</section>`;
  const recent = `<section class="sf-home-card"><h3>Recent Work</h3>${home.recent.length
    ? `<ul class="sf-home-list">${home.recent.map((item: any) => `<li><b>${escape(item.id)}</b>
      <span class="sf-home-muted">${escape([item.title, item.phase, item.group].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>`
    : '<p class="sf-home-muted">No other visible governed work was found.</p>'}</section>`;
  const quick = home.promptActions.filter((action) => action.id !== primaryId).slice(0, 4);
  const details = `<details class="sf-home-details"><summary>Binding and sources</summary><pre>${escape(
    `revision: ${home.projectionRevision}\nas of: ${home.asOf}\nhealth: ${home.health.status}\njournal: ${home.health.journal}`)}</pre></details>`;
  return `<section class="sf-home" aria-labelledby="sf-home-title">
    <header class="sf-home-header"><span class="sf-home-title">
      <h2 id="sf-home-title">${home.actor.display ? `Hello, ${escape(home.actor.display)}. ` : ''}My Work</h2>
      <p>One grounded place to orient, continue, decide, and return.</p></span>
      <span class="sf-home-context">
        ${home.context.workspaceLabel ? `<span class="sf-chip">${escape(home.context.workspaceLabel)}</span>` : ''}
        ${home.context.repositoryId ? `<span class="sf-chip">${escape(home.context.repositoryId)}</span>` : ''}
        ${home.context.branch ? `<span class="sf-chip">${escape(home.context.branch)}</span>` : ''}
        <span class="sf-chip">${escape(home.lens)}</span><span class="sf-chip sf-chip-local">Local first</span>
      </span></header>
    <form class="sf-home-prompt" data-home-request><label for="sf-home-request">What is on your mind today?</label>
      <span class="sf-home-prompt-row"><input id="sf-home-request" name="request" maxlength="300"
        placeholder="What if I change this, continue my work, or investigate a failure…" autocomplete="off">
        <button type="submit">Ask SFlow</button></span>
      ${quick.length ? `<span class="sf-home-goals">${quick.map((action) => button(action, '')).join('')}</span>` : ''}
    </form>
    <div class="sf-home-grid"><main class="sf-home-column" aria-label="Current work">${needs}${work}${today}${yesterday}${recent}</main>
      <aside class="sf-home-column" aria-label="Checks and health">${worth}<section class="sf-home-card"><h3>Health</h3>
        <p class="sf-home-health">${icon(home.health.status === 'healthy' ? 'statusSuccess' : 'statusWarning')}
          ${escape(home.health.status === 'healthy' ? 'Current sources are healthy' : 'Some sources are unavailable')}</p>
        <p class="sf-home-muted">Journal: ${escape(home.health.journal)}</p></section></aside></div>
    ${details}
  </section>`;
}

export function resultCardHtml(view: ResultCardView, { now = Date.now() }: { now?: number } = {}): string {
  if (view.home) return homeHtml(view, now);
  /**
   * A headline and a sentence, separated rather than run together.
   *
   * The catalog's convention is `label` as a headline with no full stop and `detail` as a sentence
   * with one, so joining them with a bare space produced "The cross-workspace briefing is
   * unavailable Only this workspace was read." The dash is what `preserved` already used three
   * lines down; using it here makes the three lists agree.
   */
  const why = view.why.length
    ? `<ul class="sf-card-why">${view.why.map((entry) =>
      `<li><b>${escape(entry.label)}</b>${entry.detail ? ` — ${escape(entry.detail)}` : ''}</li>`).join('')}</ul>`
    : '';

  const warnings = view.warnings.length
    ? `<ul class="sf-card-why">${view.warnings.map((entry) =>
      `<li>${icon('statusWarning', { size: 14 })} ${escape(entry.label)}${
        entry.detail ? ` — ${escape(entry.detail)}` : ''}</li>`).join('')}</ul>`
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
    ? `<p class="sf-card-rest">${escape(REST_SENTENCES[view.rest] ?? REST_SENTENCES.informational)}</p>`
    : '';

  const details = `<details><summary>Technical details</summary><pre>${escape(
    Object.entries(view.details).map(([key, value]) => `${key}: ${value}`).join('\n'))}</pre></details>`;

  /**
   * The briefing sits above the reasons, not below the actions.
   *
   * "What changed while you were away" is context for everything under it — the menu order, the
   * reasons, which button leads — and a reader who meets the delta after choosing has already
   * chosen. The old panel put it in the same place, and that part of it was right.
   */
  return `<section class="sf-card sf-card-${view.tone}">
    ${view.replyName ? `<p class="sf-card-greeting">Hello, ${escape(view.replyName)}.</p>` : ''}
    <h3>${icon(view.tone === 'refusal' ? 'statusBlocked' : 'statusCurrent')} ${escape(view.headline)}</h3>
    ${railHtml(view)}${receiptHtml(view)}${sinceHtml(view, now)}${guidanceHtml(view)}${flightPlanHtml(view)}${faultsHtml(view)}${why}${warnings}${gates}${preserved}${actions}${rest}${details}
  </section>`;
}

/**
 * Delegated click handling for every card on a page.
 *
 * One listener on the document rather than one per button: a card is re-rendered whenever its
 * result changes, and per-button listeners are how a re-render silently stops responding.
 */
export const RESULT_CARD_SCRIPT = `
/**
 * The handle every other view's script opens with, and this one did not have.
 *
 * \`VSCODE_API_SCRIPT\` acquires the API once as \`window.__sfVscode\`, because \`acquireVsCodeApi\`
 * may only be called once per document. Referring to a bare \`vscode\` therefore threw a
 * ReferenceError on the first line of the handler — silently, inside a webview, with no output
 * channel entry and no visible change — so **every action button on every result card did
 * nothing**. Rendering was verified by eye and looked right; pressing was not.
 */
const vscode = window.__sfVscode;
document.addEventListener('submit', (event) => {
  const form = event.target instanceof Element ? event.target.closest('[data-home-request]') : null;
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('input[name="request"]');
  const request = input instanceof HTMLInputElement ? input.value.trim() : '';
  if (request) vscode.postMessage({ type: 'home.request', request });
});
document.addEventListener('click', (event) => {
  const navigation = event.target instanceof Element ? event.target.closest('[data-result-nav]') : null;
  if (navigation) {
    const destination = navigation.getAttribute('data-result-nav');
    vscode.postMessage({ type: destination === 'back' ? 'result.back' : destination === 'journal' ? 'result.journal' : destination === 'faults' ? 'result.faults' : 'result.home' });
    return;
  }
  const button = event.target instanceof Element ? event.target.closest('[data-action-id]') : null;
  if (!button) return;
  vscode.postMessage({ type: 'sflow.action', actionId: button.getAttribute('data-action-id') });
});
`;
