/**
 * Shared webview plumbing: escaping, nonces, the CSP, and the stylesheet.
 *
 * One copy so the security posture cannot drift between panels. A second panel that quietly forgot
 * to escape, or relaxed its CSP, would be exactly the kind of difference nobody notices until it
 * matters — and there is no reason for two panels in the same extension to disagree about this.
 */
import type * as vscode from 'vscode';
import { WORKFLOW_GRAPH_STYLES } from './workflow-graph-svg.ts';
export { icon, ICON_NAMES, type IconName } from './icons.ts';

/** Everything that reaches a page goes through this. */
export function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Not a secret — a CSP nonce only has to be unpredictable per render. */
export function nonce(): string {
  let value = '';
  for (let index = 0; index < 32; index += 1) value += Math.floor(Math.random() * 16).toString(16);
  return value;
}

/**
 * No default source at all, and the only style and script are the ones carrying this render's nonce.
 * Images are limited to the webview's own resource scheme; nothing else is loadable.
 */
export function contentSecurityPolicy(webview: vscode.Webview, token: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${token}'`,
    `script-src 'nonce-${token}'`,
    `img-src ${webview.cspSource}`
  ].join('; ');
}

export const STYLE = `
  /* The editor's own tokens carry the surface — background, foreground, inputs — so a panel reads as
     part of VS Code and stays correct in light, dark and high-contrast. Singularity green is reserved
     for branding, the action that commits, and active progress. Navigation keeps the editor's native
     link colour. Status colours stay close to VS Code's testing palette, which readers already know. */
  :root {
    color-scheme: light dark;
    --sf-space-1: .25rem;
    --sf-space-2: .5rem;
    --sf-space-3: .75rem;
    --sf-space-4: 1rem;
    --sf-space-5: 1.5rem;
    --sf-space-6: 2rem;
    --sf-space-7: 2.5rem;
    --sf-gap: var(--sf-space-4);
    --sf-radius: 6px;
    --sf-border-color: var(--vscode-panel-border, rgba(128,128,128,.28));
    --sf-border: 1px solid var(--sf-border-color);
    --sf-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    --sf-surface-raised: var(--vscode-sideBar-background, var(--sf-surface));
    --sf-shadow: 0 1px 2px rgba(0,0,0,.08), 0 4px 16px rgba(0,0,0,.04);

    --sf-accent: #2e7d32;
    --sf-accent-hover: #256428;
    --sf-accent-quiet: rgba(46,125,50,.12);
    --sf-on-accent: #ffffff;
    --sf-link: var(--vscode-textLink-foreground, #1263c4);

    --sf-ok: var(--vscode-testing-iconPassed, #2e7d32);
    --sf-wait: var(--vscode-testing-iconQueued, #b26a00);
    --sf-bad: var(--vscode-testing-iconFailed, #c62828);
    --sf-dim: var(--vscode-descriptionForeground);
  }
  /* The accent has to clear the background it sits on, and a dark editor is a different background.
     Same hue, lifted so it stays legible rather than turning into a hole in the page. */
  @media (prefers-color-scheme: dark) {
    :root {
      --sf-accent: #3d9a42;
      --sf-accent-hover: #48ad4d;
      --sf-accent-quiet: rgba(61,154,66,.16);
      --sf-on-accent: #06210d;
    }
  }

  /* Icons sit on the baseline of whatever they label and take its colour, including when that is a
     status colour or a disabled button. */
  .ico { vertical-align: -.18em; flex: 0 0 auto; }
  h1 .ico, h2 .ico, h3 .ico { margin-right: .4rem; }
  td .ico, li .ico { margin-right: .35rem; opacity: .85; }
  button .ico { margin-right: .35rem; }
  .brand-lockup {
    display: flex; align-items: center; gap: .45rem; margin: 1rem 0 .35rem;
    color: var(--sf-accent); font-size: .7rem; font-weight: 700; letter-spacing: .16em;
  }
  /* The square placeholder is gone: the lockup now carries the real mark. */
  .brand-mark { flex: none; }
  .brand-words { display: inline-flex; align-items: baseline; gap: .3rem; }
  .brand-lockup span span { font-size: 1rem; letter-spacing: .04em; text-transform: none; }
  @media (forced-colors: active) { .brand-mark { stroke: CanvasText; } }
  .inbox-header { border-bottom: 2px solid var(--sf-accent); padding-bottom: .85rem; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--sf-space-4); margin: 1.25rem 0 1.75rem; }
  .context-banner { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: 1px; padding: 0; overflow: hidden; background: var(--sf-border-color); }
  .context-banner > div { display: grid; gap: .3rem; min-width: 0; padding: .85rem 1rem; background: var(--sf-surface); }
  .context-banner strong, .context-banner code { overflow-wrap: anywhere; }
  .briefing { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .briefing h2 { margin-bottom: 0; }
  .home-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: var(--sf-space-4); }
  button.home-choice { display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: .8rem; align-items: start; min-height: 6rem; padding: 1.25rem; color: var(--vscode-foreground); background: var(--sf-surface); border: var(--sf-border); text-align: left; }
  button.home-choice:hover { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  button.home-choice.primary-choice { border-left: 3px solid var(--sf-accent); background: var(--sf-accent-quiet); }
  .choice-number { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border: var(--sf-border); border-radius: 50%; color: var(--sf-accent); font-weight: 700; }
  .home-choice > span:last-child { display: grid; gap: .35rem; min-width: 0; }
  .home-choice small { color: var(--sf-dim); }
  .home-choice code { width: fit-content; max-width: 100%; overflow-wrap: anywhere; color: var(--sf-dim); }
  .return-phases { display: grid; gap: .55rem; }
  .return-phases details { margin: 0; padding: .8rem 1rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); }
  .return-phases summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; cursor: pointer; color: var(--vscode-foreground); }
  .return-phases summary span { color: var(--sf-dim); font-size: .9rem; }
  .return-phases .artifact-cards, .return-phases p { margin-top: .8rem; }
  .summary-card { display: grid; gap: .15rem; padding: .85rem 1rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); box-shadow: var(--sf-shadow); }
  .summary-card strong { color: var(--sf-accent); font-size: 1.55rem; line-height: 1.1; }
  .summary-card span { color: var(--sf-dim); font-size: .8rem; }
  .summary-card.important { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .analytics-overview { margin-top: 1rem; }
  .analytics-overview .section-heading h2 { margin: .15rem 0; font-size: 1.05rem; }
  .lifecycle-kpis { grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); margin-bottom: 1rem; }
  .lifecycle-kpis .summary-card strong { font-size: 1.35rem; }
  .governance-kpis .summary-card strong { font-size: 1.2rem; }
  .summary-card.governance-warning { border-color: var(--sf-wait); }
  .summary-card.governance-warning strong { color: var(--sf-wait); }
  .phase-rail { display: flex; gap: 0; margin: .9rem 0 1.25rem; padding: 0; list-style: none; overflow-x: auto; }
  .phase-node { position: relative; display: grid; grid-template-columns: 1.55rem minmax(6.5rem, 1fr); grid-template-rows: auto auto; align-items: center; flex: 1 0 8.5rem; gap: .05rem .45rem; padding: .45rem .5rem .45rem 0; }
  .phase-node::after { content: ""; position: absolute; top: 1.2rem; left: 1.55rem; right: 0; height: 1px; background: var(--sf-border-color); z-index: 0; }
  .phase-node:last-child::after { display: none; }
  .phase-marker { position: relative; z-index: 1; display: inline-grid; place-items: center; grid-row: 1 / span 2; width: 1.55rem; height: 1.55rem; border: var(--sf-border); border-radius: 50%; background: var(--vscode-editor-background); color: var(--sf-dim); }
  .phase-node.done .phase-marker { color: var(--sf-on-accent); background: var(--sf-accent); border-color: var(--sf-accent); }
  .phase-node.done::after { height: 2px; background: var(--sf-accent); }
  .phase-node.current .phase-marker { color: var(--vscode-editor-background); border: 2px solid var(--sf-wait); background: var(--sf-wait); animation: sf-phase-pulse 1.8s ease-out infinite; }
  .phase-node.attention .phase-marker { color: var(--sf-bad); border-color: var(--sf-bad); }
  .phase-name { position: relative; z-index: 1; align-self: end; width: fit-content; padding-right: .35rem; background: var(--vscode-editor-background); font-weight: 600; white-space: nowrap; }
  .phase-state { color: var(--sf-dim); font-size: .72rem; white-space: nowrap; }
  @keyframes sf-phase-pulse { 0%, 100% { box-shadow: 0 0 0 0 var(--sf-wait); } 55% { box-shadow: 0 0 0 .42rem transparent; } }
  @media (prefers-reduced-motion: reduce) { .phase-node.current .phase-marker { animation: none; } }
  .phase-node.clickable { display: block; padding: 0 .5rem 0 0; }
  .phase-node.clickable .phase-select { display: grid; grid-template-columns: 1.55rem minmax(6.5rem, 1fr); grid-template-rows: auto auto; align-items: center; width: 100%; min-height: 3.2rem; gap: .05rem .45rem; padding: .45rem 0; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: var(--sf-radius); text-align: left; cursor: pointer; }
  .phase-node.clickable .phase-select:hover { background: var(--vscode-list-hoverBackground); }
  .phase-node.clickable.selected .phase-select { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .phase-node.clickable.selected .phase-name { color: inherit; background: transparent; }
  .phase-node.clickable .phase-select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .phase-detail { padding: 1rem 1.1rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); box-shadow: var(--sf-shadow); }
  .phase-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .phase-detail-heading h2, .phase-detail-heading p { margin: .1rem 0; }
  .journey-artifacts { min-width: 52rem; }
  .journey-artifacts td:first-child { min-width: 15rem; }
  .journey-artifacts td small { display: block; max-width: 30rem; margin-top: .25rem; color: var(--sf-dim); overflow-wrap: anywhere; }
  .artifact-link { color: var(--vscode-textLink-foreground); font: inherit; font-weight: 650; text-align: left; cursor: pointer; text-decoration: underline; text-underline-offset: .16rem; }
  .artifact-link:hover { color: var(--vscode-textLink-activeForeground); }
  .artifact-link:focus-visible { border-radius: 2px; outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .approval-summary { display: flex; flex-wrap: wrap; gap: .6rem; padding: 0; list-style: none; }
  .approval-summary li { display: flex; align-items: flex-start; gap: .45rem; min-width: 13rem; padding: .65rem .75rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--vscode-editor-background); }
  .approval-summary li > span { display: grid; gap: .15rem; }
  .approval-summary small { color: var(--sf-dim); }
  .approval-empty { margin-bottom: .2rem; }
  .analytics-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(25rem, 1fr)); gap: 1rem; align-items: start; }
  .table-wrap { width: 100%; overflow-x: auto; }
  .analytics-table { min-width: 42rem; }
  .analytics-table td:first-child { min-width: 8rem; }
  .analytics-table td strong, .analytics-table td small { display: block; }
  .analytics-table td small { margin-top: .1rem; color: var(--sf-dim); }
  .duration-cell { min-width: 15rem; }
  .duration-bar { display: block; width: 100%; height: 1rem; margin-bottom: .2rem; color: var(--sf-accent); }
  .duration-track { fill: var(--vscode-progressBar-background, rgba(128,128,128,.18)); opacity: .35; }
  .duration-active { fill: var(--sf-accent); }
  .duration-waiting { fill: var(--sf-wait); }
  .analytics-empty { margin-top: 1rem; border: 1px dashed var(--sf-border-color); border-radius: var(--sf-radius); padding: .8rem 1rem; }
  .capability-dashboard { margin-top: 1rem; padding: 1rem; border: var(--sf-border); border-radius: var(--sf-radius); background: linear-gradient(135deg, var(--sf-accent-quiet), transparent 58%); }
  .capability-dashboard h3 { font-size: 1.1rem; margin: .05rem 0; }
  .capability-root-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .7rem; margin-top: 1rem; }
  button.capability-root-card { display: grid; gap: .25rem; padding: .95rem; text-align: left; color: var(--vscode-foreground); background: var(--sf-surface); border: var(--sf-border); border-radius: var(--sf-radius); }
  button.capability-root-card:hover { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .capability-root-card strong { font-size: 1rem; }
  .capability-root-card span:not(.eyebrow) { color: var(--sf-dim); font-size: .78rem; }
  .section-heading { display: flex; align-items: center; gap: .55rem; }
  .section-heading h2 { flex: 1; }
  .count-badge { display: inline-grid; place-items: center; min-width: 1.65rem; height: 1.65rem; padding: 0 .45rem; border-radius: 999px; background: var(--sf-accent-quiet); color: var(--sf-accent); font-weight: 700; }
  .decision-cards, .artifact-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: var(--sf-space-4); }
  .decision-card { border: var(--sf-border); border-left: 3px solid var(--sf-wait); border-radius: var(--sf-radius); padding: 1rem; background: var(--sf-surface); }
  .decision-card h3 { margin: .15rem 0; }
  .review-binding { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .28rem .55rem; margin: .7rem 0; color: var(--sf-dim); font-size: .76rem; }
  .review-binding code { overflow-wrap: anywhere; color: var(--vscode-foreground); }
  .eyebrow { color: var(--sf-accent); font-size: .69rem; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
  button.artifact-card { display: grid; grid-template-columns: 1fr auto; gap: .22rem .7rem; width: 100%; padding: .8rem; text-align: left; color: var(--vscode-foreground); background: var(--sf-surface); border: var(--sf-border); border-radius: var(--sf-radius); }
  button.artifact-card:hover { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .artifact-title { font-weight: 650; min-width: 0; overflow-wrap: anywhere; }
  .artifact-meta { grid-column: 1 / -1; color: var(--sf-dim); font-size: .76rem; }
  .inbox-work { margin-top: 1rem; padding: .85rem 1rem 1rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); }
  .inbox-work > .section-heading h2 { margin: .1rem 0; }
  .inbox-work > .muted { margin: .15rem 0 .5rem; }
  .inbox-phase { border: 0; border-top: 1px solid var(--sf-border-color); margin-top: .7rem; padding-top: .25rem; }
  .inbox-phase .section-heading h3 { display: flex; align-items: center; gap: .45rem; margin: .65rem 0 .45rem; font-size: .82rem; }
  .warning-text { color: var(--sf-wait); }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 2rem 4rem;
    line-height: 1.5;
    max-width: 80rem;
    margin: 0 auto;
  }

  h1 { font-size: 1.55rem; font-weight: 650; margin: 1.35rem 0 .25rem; letter-spacing: -.018em; }
  h2 { display: flex; align-items: center; font-size: .86rem; font-weight: 650;
       letter-spacing: .01em; color: var(--vscode-foreground); margin: 1.55rem 0 .55rem; }
  h3 { font-size: 1rem; font-weight: 600; margin: 1rem 0 .35rem; }
  p { margin: .4rem 0; }
  .meta { color: var(--sf-dim); margin: 0 0 .25rem; }
  .muted { color: var(--sf-dim); }
  .question { color: var(--sf-dim); margin: -.35rem 0 .75rem; }
  .ok-text { color: var(--sf-ok); font-weight: 500; }

  section { border-top: var(--sf-border); padding-top: var(--sf-space-2); padding-bottom: var(--sf-space-4); }
  header, section.next, section.plain { border: 0; }

  /* Cards carry a single decision each, so the eye can move between them without re-reading. */
  .card {
    border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface);
    padding: 1.1rem 1.2rem; margin: .85rem 0; display: grid; gap: .7rem; box-shadow: var(--sf-shadow);
  }
  .card.yours { border-left: 3px solid var(--sf-accent); }
  .card.others { border-left: 3px solid var(--sf-wait); }
  .card.blocked { border-left: 3px solid var(--sf-bad); }
  .card-head { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  .card-head h3 { margin: 0; }
  .card-foot { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }

  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 600; font-size: .74rem;
       letter-spacing: .02em; color: var(--sf-dim);
       border-bottom: var(--sf-border); padding: .35rem .6rem .35rem 0; }
  td { padding: .45rem .6rem .45rem 0; border-bottom: var(--sf-border); vertical-align: top; }
  tr.drift td { background: var(--vscode-inputValidation-warningBackground, transparent); }

  a { color: var(--sf-link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); font-size: .85em;
         background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
         padding: .05rem .35rem; border-radius: 3px; }
  .terminal-command { max-width: 100%; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
    padding: .65rem .75rem; border-radius: var(--sf-radius); background: var(--vscode-textCodeBlock-background); }
  .terminal-command code { padding: 0; background: transparent; }

  /* Enterprise controls are compact and rectangular. Only the consequential action is filled. */
  button {
    display: inline-flex; align-items: center; justify-content: center;
    font-family: inherit; font-size: .85rem; font-weight: 600; letter-spacing: .01em;
    min-height: 2rem; padding: .38rem .85rem; cursor: pointer; border: 1px solid transparent; border-radius: var(--sf-radius);
    background: var(--sf-accent); color: var(--sf-on-accent);
    transition: background-color .15s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  button:hover:not(:disabled) { background: var(--sf-accent-hover); box-shadow: 0 1px 3px rgba(0,0,0,.14); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { opacity: .4; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-button-border, var(--sf-border-color));
  }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--sf-accent-quiet)); border-color: var(--sf-accent); }
  button.link {
    background: none; border-color: transparent; color: var(--sf-link);
    padding: .2rem .1rem; font-weight: 500; border-radius: 4px;
  }
  button.link:hover:not(:disabled) { background: none; text-decoration: underline; }
  button.danger { color: var(--sf-bad); border-color: color-mix(in srgb, var(--sf-bad) 55%, transparent); background: transparent; }
  button.danger:hover:not(:disabled) { background: var(--vscode-inputValidation-errorBackground, transparent); }
  /* Focus is never removed: a governance surface has to be usable from the keyboard. */
  button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible {
    outline: 2px solid var(--vscode-focusBorder, var(--sf-accent)); outline-offset: 2px;
  }
  input[type="text"], input[type="search"], select {
    font-family: inherit; font-size: .9rem; padding: .38rem .6rem; border-radius: var(--sf-radius);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  }
  input[type="text"]:focus, select:focus, textarea:focus { border-color: var(--sf-accent); }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--sf-accent); }
  textarea {
    font: inherit; padding: .35rem .5rem; border-radius: 6px; margin-top: .3rem;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
    max-width: 100%; resize: vertical;
  }
  /* A choice between a few things, each of which needs a sentence to be choosable at all. A radio in
     a row of radios shows only names, and the names are never the difference. */
  .choices { display: grid; gap: .5rem; }
  .choice {
    display: grid; grid-template-columns: auto 1fr; gap: .1rem .55rem; align-items: baseline;
    padding: .6rem .75rem; border: var(--sf-border); border-radius: var(--sf-radius); cursor: pointer;
  }
  .choice:hover { border-color: var(--sf-accent); }
  .choice.chosen { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .choice input { grid-row: 1 / span 3; margin: .2rem 0 0; }
  .choice-label { font-weight: 600; }
  .choice-detail { grid-column: 2; color: var(--sf-dim); font-size: .92em; }
  .choice-detail.phases { margin-top: .25rem; }
  label { display: inline-flex; align-items: center; gap: .5rem; }

  /* Configuration follows the same calm list-detail pattern as GitHub settings: persistent local
     navigation, one task surface, and accent colour only for the current location. */
  .tabs { display: flex; gap: .25rem; margin: 1rem 0; border-bottom: var(--sf-border); }
  button.tab { min-height: 2.25rem; padding: .4rem .75rem; border-radius: var(--sf-radius) var(--sf-radius) 0 0; background: transparent; color: var(--sf-dim); border-bottom: 2px solid transparent; box-shadow: none; }
  button.tab:hover { background: var(--sf-accent-quiet); color: var(--vscode-foreground); box-shadow: none; }
  button.tab.active { color: var(--sf-accent); border-bottom-color: var(--sf-accent); }
  .configuration-shell { display: grid; grid-template-columns: 15rem minmax(0, 1fr); gap: var(--sf-space-6); align-items: start; margin-top: var(--sf-space-5); }
  .configuration-sidebar { position: sticky; top: var(--sf-space-4); border: 0; padding: 0; }
  .configuration-nav { display: grid; gap: var(--sf-space-5); }
  .configuration-nav-group { border: 0; padding: 0; }
  .configuration-nav-group h2 { margin: 0 0 var(--sf-space-2); padding: 0 var(--sf-space-2); color: var(--sf-dim); font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; }
  .configuration-nav-group ul { display: grid; gap: var(--sf-space-1); margin: 0; padding: 0; list-style: none; }
  button.configuration-nav-item { display: grid; grid-template-columns: 1.25rem minmax(0, 1fr); justify-content: stretch; gap: var(--sf-space-2); width: 100%; min-height: 2.25rem; padding: .45rem .55rem; border: 0; border-radius: var(--sf-radius); background: transparent; color: var(--vscode-foreground); text-align: left; font-weight: 500; box-shadow: none; }
  button.configuration-nav-item:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--sf-accent-quiet)); box-shadow: none; }
  button.configuration-nav-item.active { background: var(--sf-accent-quiet); color: var(--sf-accent); font-weight: 650; }
  .configuration-content { min-width: 0; }
  .configuration-content > .plain:first-child, .configuration-content > .notice:first-child + .plain { padding-top: 0; }
  .configuration-overview .section-heading { align-items: flex-start; }
  .configuration-overview .section-heading h2 { margin-bottom: .15rem; }
  .configuration-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: var(--sf-space-4); margin: var(--sf-space-4) 0 var(--sf-space-5); }
  button.configuration-card { display: grid; grid-template-columns: 1.5rem 1fr; grid-template-rows: auto auto; align-items: start; gap: .3rem .75rem; padding: 1.25rem; text-align: left; color: var(--vscode-foreground); background: var(--sf-surface); border-color: var(--sf-border-color); }
  button.configuration-card .ico { grid-row: 1 / span 2; color: var(--sf-accent); }
  button.configuration-card strong { font-size: .92rem; }
  button.configuration-card span:not(.ico) { color: var(--sf-dim); font-size: .84rem; line-height: 1.45; font-weight: 400; }
  .configuration-action-list { display: grid; border: var(--sf-border); border-radius: var(--sf-radius); overflow: hidden; background: var(--sf-surface); }
  button.configuration-action-row { display: grid; grid-template-columns: 1.5rem minmax(0, 1fr) 1rem; gap: var(--sf-space-3); align-items: center; width: 100%; min-height: 4.5rem; padding: var(--sf-space-3) var(--sf-space-4); border: 0; border-bottom: var(--sf-border); border-radius: 0; background: transparent; color: var(--vscode-foreground); text-align: left; box-shadow: none; }
  button.configuration-action-row:last-child { border-bottom: 0; }
  button.configuration-action-row:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, var(--sf-accent-quiet)); box-shadow: none; }
  .configuration-action-row > .ico:first-child { color: var(--sf-accent); }
  .configuration-action-row > span { display: grid; gap: var(--sf-space-1); }
  .configuration-action-row small { color: var(--sf-dim); font-weight: 400; line-height: 1.4; }
  .configuration-advanced-tools { margin-top: var(--sf-space-4); }
  .configuration-advanced-tools > summary { width: fit-content; min-height: 2rem; display: flex; align-items: center; }
  .configuration-advanced-tools[open] > summary { margin-bottom: var(--sf-space-3); }
  .wm-explorer > .section-heading { align-items: flex-start; }
  .wm-explorer > .section-heading h2 { margin: .15rem 0; font-size: 1.15rem; }
  .wm-summary { margin-bottom: var(--sf-space-4); }
  .wm-summary .summary-card strong { font-size: 1.25rem; }
  .wm-provenance { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0 0 var(--sf-space-5); overflow: hidden; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-border-color); }
  .wm-provenance div { display: grid; gap: .2rem; min-width: 0; padding: .65rem .8rem; background: var(--sf-surface); }
  .wm-provenance dt { color: var(--sf-dim); font-size: .72rem; }
  .wm-provenance dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-weight: 600; }
  .wm-catalog-wrap, .wm-matrix-wrap { width: 100%; overflow-x: auto; }
  .wm-catalog { min-width: 46rem; }
  .wm-catalog td small { display: block; color: var(--sf-dim); }
  .wm-state { display: inline-flex; align-items: center; min-height: 1.35rem; padding: .08rem .42rem; border: 1px solid var(--sf-border-color); border-radius: 999px; color: var(--sf-dim); font-size: .7rem; font-weight: 650; white-space: nowrap; }
  .wm-state.ready { border-color: color-mix(in srgb, var(--sf-ok) 55%, transparent); color: var(--sf-ok); }
  .wm-state.missing, .wm-state.off { color: var(--sf-dim); }
  .wm-references { max-width: 18rem; }
  .wm-references summary { width: fit-content; color: var(--sf-link); cursor: pointer; }
  .wm-references ul { margin: .35rem 0 0; padding-left: 1.1rem; color: var(--sf-dim); font-size: .74rem; }
  .wm-coverage { margin-top: var(--sf-space-5); }
  .wm-filter-bar { display: flex; align-items: end; gap: .65rem 1rem; flex-wrap: wrap; margin: .75rem 0; padding: .65rem .75rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); }
  .wm-filter-bar label { display: grid; gap: .2rem; min-width: 12rem; color: var(--sf-dim); font-size: .72rem; }
  .wm-filter-bar select { width: 100%; }
  .wm-map-legend { display: inline-flex; align-items: center; gap: .35rem; margin-left: auto; color: var(--sf-dim); font-size: .72rem; }
  .wm-dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--sf-accent); }
  .wm-dot.overridden { background: var(--sf-wait); }
  .wm-matrix { min-width: max(52rem, 100%); border: var(--sf-border); }
  .wm-matrix th, .wm-matrix td { min-width: 8.5rem; padding: .55rem; border-right: var(--sf-border); }
  .wm-matrix th:first-child, .wm-matrix td:first-child { min-width: 13rem; }
  .wm-matrix th:nth-child(2), .wm-matrix td:nth-child(2) { min-width: 6rem; }
  .wm-matrix td:first-child small { display: block; margin-top: .15rem; color: var(--sf-dim); }
  .wm-matrix tr.wm-disabled { opacity: .66; }
  .wm-phase-use { display: grid; gap: .05rem; margin: .15rem 0; padding: .28rem .4rem; border-left: 2px solid var(--sf-accent); background: var(--sf-accent-quiet); font-size: .72rem; }
  .wm-phase-use.overridden { border-left-color: var(--sf-wait); background: var(--vscode-inputValidation-warningBackground, transparent); }
  .wm-phase-use strong { font-size: .72rem; line-height: 1.3; }
  .wm-phase-use small { color: var(--sf-dim); }
  .wm-none { color: var(--sf-dim); }
  .wm-settings { margin-top: var(--sf-space-6); padding-top: var(--sf-space-3); border-top: var(--sf-border); }
  .wm-settings > summary { font-weight: 650; }
  .configuration-list { display: grid; gap: .4rem; margin: .7rem 0; }
  button.configuration-row { display: grid; grid-template-columns: 1.4rem minmax(10rem, .55fr) 1fr; gap: .55rem; justify-content: start; text-align: left; color: var(--vscode-foreground); background: var(--sf-surface); }
  button.configuration-row small { color: var(--sf-dim); font-weight: 400; }
  .notice { border: var(--sf-border); border-left: 3px solid var(--sf-wait); border-radius: var(--sf-radius); padding: .55rem .75rem; margin: .7rem 0; }
  .notice p { margin: .15rem 0; }
  .notice.ok { border-left-color: var(--sf-ok); }
  .notice.error { border-left-color: var(--sf-bad); }
  .editor-card .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
  .editor-card label.stack, .editor-card .form-grid label { display: grid; align-items: start; gap: .25rem; }
  .editor-card label.span-2 { grid-column: 1 / -1; }
  .editor-card input, .editor-card select, .editor-card textarea { width: 100%; }
  .editor-card small { color: var(--sf-dim); }
  .check-grid { display: flex; flex-wrap: wrap; gap: .55rem 1rem; margin: .7rem 0; }
  label.check { display: flex; align-items: center; gap: .45rem; }
  @media (max-width: 44rem) {
    .configuration-shell { grid-template-columns: 1fr; gap: var(--sf-space-5); }
    .configuration-sidebar { position: static; }
    .configuration-nav { grid-template-columns: 1fr; gap: var(--sf-space-4); }
    .editor-card .form-grid { grid-template-columns: 1fr; }
    .editor-card label.span-2 { grid-column: auto; }
    button.configuration-row { grid-template-columns: 1.4rem 1fr; }
    button.configuration-row small { grid-column: 2; }
    .wm-provenance { grid-template-columns: 1fr; }
    .wm-map-legend { width: 100%; margin-left: 0; }
  }

  /* Forms use a quiet two-column rhythm rather than prose paragraphs containing unrelated controls.
     Stacked labels keep field names and guidance attached at every editor width. */
  .editor-card {
    margin-top: 1rem; padding: 1.1rem 1.2rem 1.25rem;
    border: var(--sf-border); border-radius: var(--sf-radius);
    background: var(--sf-surface); box-shadow: var(--sf-shadow);
  }
  .editor-title { margin-bottom: 1rem; }
  .eyebrow {
    margin: 0 0 .15rem; color: var(--sf-accent); font-size: .7rem; font-weight: 700;
    letter-spacing: .09em; text-transform: uppercase;
  }
  .form-grid {
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem 1.15rem; margin: .8rem 0 1rem;
  }
  .field { display: grid; align-content: start; gap: .35rem; min-width: 0; }
  .field > span { font-size: .78rem; font-weight: 600; color: var(--vscode-foreground); }
  .field > small { color: var(--sf-dim); font-size: .76rem; line-height: 1.4; }
  .field input[type="text"], .field select { width: 100%; min-height: 2.25rem; }
  .span-2 { grid-column: 1 / -1; }
  .relationship-field {
    padding: .8rem; border: 1px solid color-mix(in srgb, var(--sf-accent) 45%, transparent);
    border-radius: var(--sf-radius); background: var(--sf-accent-quiet);
  }
  .subsection { margin-top: 1.25rem; padding-top: .25rem; border-top: var(--sf-border); }
  .metadata-editor { padding-top: 1rem; }
  .metadata-editor .card-head { align-items: flex-start; margin-bottom: .75rem; }
  .metadata-editor .card-head h2 { margin: 0 0 .2rem; }
  .metadata-editor .card-head p { margin: 0; }
  .metadata-list { display: grid; gap: .55rem; }
  .metadata-row { display: grid; grid-template-columns: minmax(10rem, .7fr) minmax(14rem, 1.3fr) 2rem; gap: .6rem; align-items: end; }
  .metadata-row .field { min-width: 0; }
  .metadata-row .icon-button { margin-bottom: 1px; }
  .evidence-source-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:.65rem; margin:1rem 0; }
  button.evidence-source { display:grid; grid-template-columns:2.25rem 1fr; gap:.2rem .65rem; align-items:start; min-height:6.2rem;
    padding:.85rem; text-align:left; color:var(--vscode-foreground); background:var(--sf-surface); border:var(--sf-border); border-radius:var(--sf-radius); }
  button.evidence-source:hover:not(:disabled) { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
  .evidence-source-icon { grid-row:1 / span 2; display:grid; place-items:center; color:var(--sf-accent); }
  .evidence-source strong { font-size:.9rem; }
  .evidence-source span:last-child { color:var(--sf-dim); font-size:.76rem; line-height:1.35; }
  .evidence-list { display:grid; gap:.5rem; margin:.65rem 0 1rem; }
  .evidence-item { display:grid; grid-template-columns:2rem minmax(0,1fr) auto; gap:.65rem; align-items:center; padding:.75rem .8rem;
    border:var(--sf-border); border-radius:var(--sf-radius); background:var(--sf-surface); }
  .evidence-item.detached { opacity:.78; border-style:dashed; }
  .evidence-item-icon { color:var(--sf-accent); }
  .evidence-item p,.evidence-item small { display:block; margin:.1rem 0 0; color:var(--sf-dim); font-size:.75rem; overflow-wrap:anywhere; }
  .evidence-actions { display:flex; gap:.4rem; flex-wrap:wrap; justify-content:flex-end; }
  .evidence-actions .danger { color:var(--sf-bad); }
  .detached-history { margin-top:1.25rem; padding-top:.75rem; border-top:var(--sf-border); }
  @media (max-width: 680px) {
    body { padding-inline: 1rem; }
    .form-grid { grid-template-columns: 1fr; }
    .span-2 { grid-column: auto; }
    .editor-card { padding-inline: .85rem; }
    .metadata-row { grid-template-columns: 1fr 2rem; }
    .metadata-row .field:first-child { grid-column: 1 / -1; }
    .evidence-item { grid-template-columns:2rem minmax(0,1fr); }
    .evidence-actions { grid-column:1 / -1; justify-content:flex-start; }
  }

  .rail { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: .2rem 1.5rem; }
  .stage { display: flex; align-items: center; gap: .5rem; padding: .3rem 0; }
  .stage .dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--sf-dim); flex: 0 0 auto; }
  .stage.ok .dot { background: var(--sf-ok); }
  .stage.wait .dot { background: var(--sf-wait); }
  .stage.active .dot { background: var(--sf-accent); box-shadow: 0 0 0 3px var(--sf-accent-quiet); }
  .stage.bad .dot { background: var(--sf-bad); }
  .stage.current .name { font-weight: 600; }
  .stage .count { color: var(--sf-dim); font-size: .8em; }

  /* Outlined rather than filled. A row of solid badges competes with the one filled button that
     actually does something; these are labels, and should read as labels. */
  .pill { display: inline-flex; align-items: center; gap: .25rem;
          font-size: .72rem; font-weight: 600; letter-spacing: .02em; padding: .08rem .55rem;
          border-radius: 999px; border: 1px solid currentColor; color: var(--sf-dim);
          white-space: nowrap; }
  .pill.ok { color: var(--sf-ok); background: var(--sf-accent-quiet); }
  .pill.wait { color: var(--sf-wait); }
  .pill.bad { color: var(--sf-bad); }

  /* The chain reads left to right, because that is the order the bodies must sign in. */
  .chain { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
  .chain li { display: flex; align-items: center; gap: .4rem; font-size: .82rem; color: var(--sf-dim); }
  .chain li:not(:last-child) { padding-right: .8rem; border-right: 1px solid var(--sf-border-color); }
  .chain li.satisfied { color: var(--sf-ok); }
  .chain li.open { color: var(--vscode-foreground); font-weight: 600; }

  .blockers { margin: .3rem 0; padding-left: 1.15rem; }
  .blockers li { margin: .25rem 0; }
  .sources { padding-left: 1.15rem; }
  .empty { padding: 3.5rem 1rem; color: var(--sf-dim); text-align: center; border: 1px dashed var(--sf-border-color); border-radius: var(--sf-radius); margin-top: 1rem; }
  .remedy { margin: .5rem 0 0; font-size: .9em; color: var(--sf-dim); }

  /* Workflow and artifact studio. Dense enough for configuration work, but each action still has
     one obvious place and keyboard-accessible controls. */
  .designer-tabs { display: flex; gap: .55rem; border: 0; margin: 1.1rem 0; }
  .designer-tabs .tab, .instruction-tabs .tab { display: inline-flex; align-items: center; gap: .4rem; color: var(--sf-dim); background: transparent; border: 1px solid transparent; border-bottom-color: var(--sf-border-color); border-radius: var(--sf-radius) var(--sf-radius) 0 0; }
  .designer-tabs .tab:hover, .instruction-tabs .tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }
  .designer-tabs .tab.active, .instruction-tabs .tab.active { color: var(--vscode-foreground); background: var(--sf-accent-quiet); border-color: var(--sf-border-color); border-bottom: 2px solid var(--sf-accent); }
  .toolbar-row { display: flex; align-items: end; gap: .65rem; flex-wrap: wrap; margin: .65rem 0; }
  .toolbar-row h2 { margin: 0; }
  .field.full { grid-column: 1 / -1; }
  .field.compact { display: grid; min-width: 16rem; }
  .field textarea { width: 100%; box-sizing: border-box; }
  .checkbox-field { grid-template-columns: auto 1fr; align-items: center; align-content: center; }
  .form-actions { display: flex; gap: .6rem; align-items: center; margin-top: 1.15rem; }
  .add-row { display: flex; gap: .55rem; margin-top: .7rem; align-items: center; }
  .add-row select { min-width: 18rem; }
  .empty-state { color: var(--sf-dim); border: 1px dashed var(--sf-dim); border-radius: var(--sf-radius); padding: 1rem; }
  .raw-escape { margin-top: 1rem; }
  .workflow-summary { border: var(--sf-border); border-radius: calc(var(--sf-radius) + 2px); padding: 1rem 1.15rem; background: var(--sf-surface); }
  .workflow-summary h3 { font-size: 1.15rem; margin-top: .1rem; }
  .workflow-rail { display: flex; align-items: center; gap: .45rem; overflow-x: auto; padding: 1rem 0 .75rem; }
  .rail-node { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: .45rem; white-space: nowrap; padding: .45rem .75rem; border: var(--sf-border); border-radius: 999px; background: var(--vscode-editor-background); }
  .rail-node b, .step-number { display: inline-grid; place-items: center; width: 1.55rem; height: 1.55rem; border-radius: 50%; color: var(--sf-on-accent); background: var(--sf-accent); font-size: .75rem; flex: 0 0 auto; }
  .rail-arrow { color: var(--sf-dim); }
  .start-wizard { margin: 0 0 1.5rem; padding: 1rem 1.1rem; border: var(--sf-border); border-left: 3px solid var(--sf-accent); border-radius: var(--sf-radius); background: var(--sf-surface); box-shadow: var(--sf-shadow); }
  .start-wizard-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .start-wizard-heading > div { display: grid; gap: .2rem; }
  .start-wizard-heading .eyebrow { color: var(--sf-accent); font-size: .68rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .start-wizard-rail { display: grid; grid-template-columns: repeat(3, minmax(9rem, 1fr)); gap: 0; margin: 1rem 0 .75rem; padding: 0; list-style: none; }
  .start-wizard-step { position: relative; display: grid; grid-template-columns: 1.8rem minmax(0, 1fr); gap: .55rem; align-items: center; min-width: 0; padding-right: .75rem; }
  .start-wizard-step::after { content: ""; position: absolute; top: .9rem; left: 1.8rem; right: 0; height: 1px; background: var(--sf-border-color); }
  .start-wizard-step:last-child::after { display: none; }
  .start-wizard-marker { position: relative; z-index: 1; display: grid; place-items: center; width: 1.65rem; height: 1.65rem; border: var(--sf-border); border-radius: 50%; color: var(--sf-dim); background: var(--vscode-editor-background); font-size: .72rem; font-weight: 700; }
  .start-wizard-step > span:last-child { display: grid; gap: .12rem; min-width: 0; }
  .start-wizard-step strong, .start-wizard-step small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .start-wizard-step small { color: var(--sf-dim); font-size: .7rem; }
  .start-wizard-step.done .start-wizard-marker { color: var(--sf-on-accent); border-color: var(--sf-accent); background: var(--sf-accent); }
  .start-wizard-step.done::after { height: 2px; background: var(--sf-accent); }
  .start-wizard-step.current .start-wizard-marker { color: var(--sf-on-accent); border-color: var(--sf-wait); background: var(--sf-wait); animation: sf-phase-pulse 1.8s ease-out infinite; }
  .start-wizard-step.current strong { color: var(--vscode-foreground); }
  .start-wizard-step.upcoming { opacity: .72; }
  .start-wizard-context { margin: .25rem 0; color: var(--sf-accent); font-size: .78rem; font-weight: 600; }
  /* The exact command behind a button, for anyone who wants to run or script it. Supporting
     detail — the button says what it does. */
  .command-hint { margin: .4rem 0 0; color: var(--sf-dim); font-size: .78rem; }
  .command-hint code { font-family: var(--vscode-editor-font-family, monospace); user-select: all; }
  /* The one way out of a page. Quiet by design: it is orientation, not an action. */
  .page-nav { display: flex; flex-wrap: wrap; gap: .25rem 1rem; align-items: center;
    margin: 2rem 0 .5rem; padding-top: .9rem; border-top: var(--sf-border); font-size: .82rem; }
  .page-nav .link { padding: 0; color: var(--sf-link); }
  .nav-current { color: var(--sf-dim); font-weight: 600; }
  .sequence-builder { display: grid; gap: .45rem; }
  .sequence-row { display: flex; align-items: center; gap: .65rem; padding: .55rem .65rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--vscode-editor-background); }
  .icon-button { width: 2rem; height: 2rem; min-width: 2rem; min-height: 2rem; padding: 0; border-radius: 5px; background: transparent; border-color: var(--vscode-input-border, rgba(128,128,128,.35)); color: var(--vscode-foreground); }
  .icon-button:hover:not(:disabled) { background: var(--sf-accent-quiet); border-color: var(--sf-accent); }
  .icon-button.danger { color: var(--sf-bad); }
  .template-inventory { margin-top: 1.25rem; }
  .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: .55rem; }
  button.template-tile { display: grid; justify-content: stretch; text-align: left; gap: .2rem; border-radius: var(--sf-radius); background: var(--sf-surface); color: var(--vscode-foreground); border: var(--sf-border); padding: .75rem; }
  button.template-tile:hover { background: var(--sf-accent-quiet); border-color: var(--sf-accent); }
  .template-tile span { color: var(--sf-dim); font-size: .78rem; font-weight: 400; }
  .artifact-studio { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(16rem, .8fr); gap: 1rem; align-items: start; border: 0; }
  .artifact-form { margin-top: 0; }
  .section-canvas { display: grid; gap: .55rem; }
  .section-block { display: grid; grid-template-columns: auto 1fr auto; gap: .65rem; align-items: start; padding: .65rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--vscode-editor-background); }
  .section-block[draggable="true"] { cursor: grab; }
  .section-block[draggable="true"]:active { cursor: grabbing; }
  .drag-handle { color: var(--sf-dim); padding: .45rem .25rem 0; min-width: 2rem; min-height: 2rem; box-sizing: border-box; }
  .section-fields { display: grid; gap: .35rem; min-width: 0; }
  .section-fields input, .section-fields textarea { width: 100%; box-sizing: border-box; }
  .section-actions { display: flex; gap: .25rem; }
  .document-preview { position: sticky; top: 1rem; border: var(--sf-border); border-radius: calc(var(--sf-radius) + 3px); padding: 1.25rem; background: var(--vscode-editor-background); box-shadow: 0 8px 24px rgba(0,0,0,.12); }
  .document-preview h1 { font-size: 1.35rem; border-bottom: var(--sf-border); padding-bottom: .7rem; }
  .document-preview h2 { color: var(--vscode-foreground); font-size: .9rem; text-transform: none; letter-spacing: 0; margin-top: 1rem; }
  .preview-placeholder { min-height: 2.3rem; padding: .55rem; border: 1px dashed var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 5px; color: var(--sf-dim); font-size: .8rem; }
  details { margin-top: 1rem; }
  summary { cursor: pointer; color: var(--sf-link); }
  .markdown-preview { max-height: 20rem; overflow: auto; white-space: pre-wrap; padding: .75rem; background: var(--vscode-textCodeBlock-background); border-radius: var(--sf-radius); }
  .split-layout { display:grid; grid-template-columns:minmax(18rem,30%) 1fr; gap:1rem; align-items:start; }
  .audit-list { display:grid; gap:.4rem; }
  .audit-record { display:grid; gap:.2rem; width:100%; padding:.75rem; text-align:left; color:var(--vscode-foreground); background:var(--sf-surface); border:var(--sf-border); border-radius:var(--sf-radius); }
  .audit-record:hover, .audit-record.selected { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
  button.artifact-card.selected { border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
  .audit-record span, .audit-record small { color:var(--sf-dim); }
  .audit-meta { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:.5rem; }
  .audit-meta div { padding:.6rem; border:var(--sf-border); border-radius:var(--sf-radius); }
  .audit-meta dt { color:var(--sf-dim); font-size:.72rem; }
  .audit-meta dd { margin:.2rem 0 0; font-weight:650; }
  .prompt-content { max-height:62vh; overflow:auto; white-space:pre-wrap; word-break:break-word; border:var(--sf-border); border-radius:var(--sf-radius); padding:1rem; background:var(--vscode-textCodeBlock-background); }
  @media(max-width:800px) { .split-layout { grid-template-columns:1fr; } .audit-meta { grid-template-columns:repeat(2,1fr); } }

  /* Instruction designer: a compact library at left and a generous visual canvas at right. */
  .instruction-tabs { display: flex; gap: .45rem; margin: 1rem 0; overflow-x: auto; }
  .instruction-tabs button span { margin-left: .35rem; opacity: .75; }
  .relationship-strip { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap; padding: .65rem .8rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-accent-quiet); }
  .relationship-strip span { padding: .25rem .5rem; border-radius: 999px; background: var(--vscode-editor-background); font-size: .78rem; }
  .instruction-studio { display: grid; grid-template-columns: minmax(14rem, .72fr) minmax(0, 2fr); gap: 1rem; margin-top: 1rem; align-items: start; border: 0; }
  .instruction-library { position: sticky; top: .75rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); padding: .75rem; max-height: calc(100vh - 2rem); overflow: auto; }
  .library-head { display: flex; align-items: center; gap: .5rem; }
  .library-head > div { flex: 1; }
  .library-head h2 { color: var(--vscode-foreground); font-size: .95rem; text-transform: none; letter-spacing: 0; margin: .1rem 0 .55rem; }
  .instruction-library input[type="search"] { width: 100%; padding: .45rem .6rem; border: var(--sf-border); border-radius: var(--sf-radius); color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
  .instruction-list { display: grid; gap: .35rem; margin-top: .6rem; }
  button.instruction-item { display: grid; justify-content: stretch; gap: .15rem; width: 100%; text-align: left; color: var(--vscode-foreground); background: transparent; border: var(--sf-border); border-radius: var(--sf-radius); padding: .65rem; }
  button.instruction-item:hover, button.instruction-item.selected { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .instruction-item span, .instruction-item small { color: var(--sf-dim); font-weight: 400; font-size: .75rem; }
  .instruction-item small { text-transform: uppercase; letter-spacing: .08em; }
  .instruction-editor { border: var(--sf-border); border-radius: var(--sf-radius); background: var(--sf-surface); padding: 1rem 1.15rem 1.25rem; }
  .instruction-editor h1 { margin-top: .1rem; }
  .instruction-studio.single { grid-template-columns: minmax(0, 1fr); }
  .remote-delivery, .delivery-section { margin-top: 1.15rem; padding-top: 1rem; border-top: var(--sf-border); }
  .remote-delivery h3 { margin: 1rem 0 .25rem; font-size: .92rem; }
  .remote-resource-list { display: grid; gap: .45rem; margin: .55rem 0; }
  .remote-row { display: grid; grid-template-columns: minmax(8rem,.7fr) minmax(15rem,2fr) minmax(10rem,1fr) minmax(8rem,.65fr) auto auto; gap: .5rem; align-items: end; padding: .65rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--vscode-editor-background); }
  .remote-row label, .mapping-row label { display: grid; gap: .25rem; min-width: 0; }
  .remote-row label > span, .mapping-row label > span { color: var(--sf-dim); font-size: .72rem; }
  .remote-row input, .remote-row select, .mapping-row input, .mapping-row select { width: 100%; min-width: 0; }
  .remote-row .remote-optional { display: flex; align-items: center; min-height: 2rem; gap: .35rem; white-space: nowrap; }
  .remote-row .remote-optional input { width: auto; }
  .mapping-table { display: grid; gap: .45rem; margin: .75rem 0; }
  .mapping-row { display: grid; grid-template-columns: minmax(12rem,1fr) auto minmax(12rem,1fr) auto; gap: .65rem; align-items: end; padding: .65rem; border: var(--sf-border); border-radius: var(--sf-radius); }
  .mapping-arrow { align-self: center; color: var(--sf-accent); font-size: 1.1rem; }
  .trust-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(17rem,1fr)); gap: .7rem; margin-top: .75rem; }
  .trust-card { display: grid; align-content: start; gap: .55rem; padding: .8rem; border: var(--sf-border); border-radius: var(--sf-radius); background: var(--vscode-editor-background); }
  .trust-head { display: flex; align-items: start; justify-content: space-between; gap: .6rem; }
  .trust-head > div { display: grid; gap: .15rem; }
  .trust-head small, .trust-card p { color: var(--sf-dim); }
  .status-chip { display: inline-flex; align-items: center; width: fit-content; padding: .18rem .45rem; border: var(--sf-border); border-radius: 999px; color: var(--sf-dim); font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; }
  .status-chip.ready, .status-chip.local-only { color: var(--sf-ok); border-color: var(--sf-ok); }
  .status-chip.unlocked, .status-chip.needs-sync { color: var(--sf-wait); border-color: var(--sf-wait); }
  .status-chip.stale { color: var(--sf-bad); border-color: var(--sf-bad); }
  .resource-status { display: grid; gap: .25rem; margin: 0; padding: 0; list-style: none; }
  .resource-status li { display: flex; justify-content: space-between; gap: .5rem; color: var(--sf-dim); font-size: .75rem; }
  .resource-status li span:first-child { color: var(--vscode-foreground); }
  .choice-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .4rem; }
  .choice { display: flex; align-items: flex-start; gap: .5rem; padding: .5rem .6rem; border: var(--sf-border); border-radius: var(--sf-radius); }
  .choice input { margin-top: .25rem; }
  .choice span { display: grid; }
  .choice small { color: var(--sf-dim); }
  /* Workflow choices use their full card width: identity on row one, ordered phases on row two.
     A step owns its connector so a wrapped line never begins with a detached arrow. */
  .choice.workflow-choice {
    display: grid; grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas: "selector summary" ". phases";
    gap: .35rem .65rem; align-items: start; padding: .7rem .8rem;
  }
  .choice.workflow-choice > input { grid-area: selector; margin-top: .2rem; }
  .choice.workflow-choice > .workflow-copy {
    grid-area: summary; display: flex; align-items: baseline; flex-wrap: wrap; gap: .2rem .7rem;
  }
  .choice.workflow-choice .workflow-description {
    display: inline; color: var(--sf-dim); font-size: .86rem;
  }
  .choice.workflow-choice > .workflow-phases {
    grid-area: phases; display: flex; flex-wrap: wrap; align-items: center;
    gap: .4rem .5rem; min-width: 0; margin-top: .15rem;
  }
  .choice.workflow-choice .workflow-step {
    display: inline-flex; flex: 0 0 auto; align-items: center; gap: .4rem;
  }
  .choice.workflow-choice .workflow-connector {
    display: inline-flex; color: var(--sf-dim);
  }
  .choice.workflow-choice code {
    display: inline-flex; width: auto; padding: .16rem .42rem;
    border: var(--sf-border); border-radius: 4px;
    background: var(--vscode-textCodeBlock-background);
  }
  /* Visual Assurance: dense evidence is grouped into reviewable bands without turning the page
     into a second design system. Tables remain scrollable at narrow editor widths. */
  .assurance-header { display:flex; align-items:flex-start; justify-content:space-between; gap:1rem; }
  .header-actions { display:flex; align-items:center; gap:.55rem; flex-wrap:wrap; }
  .assurance-section { margin-top:1rem; }
  .assurance-summary { grid-template-columns:repeat(4,minmax(8rem,1fr)); }
  .assurance-facts { display:grid; grid-template-columns:repeat(4,minmax(10rem,1fr)); gap:.55rem; margin:.8rem 0 1rem; }
  .assurance-facts > div { display:grid; gap:.2rem; padding:.7rem; border:var(--sf-border); border-radius:var(--sf-radius); }
  .assurance-facts span { color:var(--sf-dim); font-size:.75rem; }
  .subheading { margin-top:1.15rem; }
  .subheading h3 { margin:0; }
  .table-wrap { overflow:auto; border:var(--sf-border); border-radius:var(--sf-radius); }
  .table-wrap table { margin:0; border:0; min-width:56rem; }
  .table-wrap td small, .table-wrap td strong { display:block; }
  .table-wrap td small { color:var(--sf-dim); margin-top:.2rem; }
  .compact-action { min-height:2rem; padding:.28rem .5rem; white-space:nowrap; }
  .profile-grid, .server-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(13rem,1fr)); gap:.55rem; }
  .profile-card, .server-card, .comparison-card { border:var(--sf-border); border-radius:var(--sf-radius); padding:.75rem; background:var(--sf-surface); }
  .profile-card > div, .server-card > div { display:flex; align-items:center; gap:.45rem; }
  .profile-card > span, .profile-card > small, .server-card > small { display:block; color:var(--sf-dim); margin-top:.35rem; }
  .profile-card.ok { border-left:3px solid var(--sf-ok); }
  .profile-card.wait { border-left:3px solid var(--sf-wait); }
  .profile-card.bad { border-left:3px solid var(--sf-bad); }
  .comparison-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(18rem,1fr)); gap:.65rem; margin-top:1rem; }
  .comparison-card.ok { border-top:3px solid var(--sf-ok); }
  .comparison-card.wait { border-top:3px solid var(--sf-wait); }
  .comparison-card.bad { border-top:3px solid var(--sf-bad); }
  .comparison-metric { display:flex; align-items:baseline; gap:.45rem; margin-top:.75rem; }
  .comparison-metric strong { font-size:1.45rem; }
  .comparison-metric span { color:var(--sf-dim); }
  .visual-mode-tabs { display:flex; gap:.35rem; margin:.75rem 0 .55rem; }
  .visual-mode-tabs button { min-height:1.8rem; padding:.25rem .55rem; font-size:.75rem; }
  .visual-mode-tabs button.active { color:var(--sf-accent); border-color:var(--sf-accent); background:var(--sf-accent-quiet); }
  .visual-stage { --reveal:50%; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem; min-height:12rem; }
  .visual-pane { min-width:0; margin:0; border:var(--sf-border); border-radius:var(--sf-radius); overflow:hidden; background:var(--vscode-editorWidget-background); }
  .visual-pane img { display:block; width:100%; height:16rem; object-fit:contain; background:repeating-conic-gradient(rgba(128,128,128,.08) 0 25%,transparent 0 50%) 50%/16px 16px; }
  .visual-pane figcaption { padding:.45rem .55rem; color:var(--sf-dim); font-size:.72rem; }
  .visual-pane.diff { display:none; }
  .visual-stage.overlay { position:relative; display:block; }
  .visual-stage.overlay .visual-pane { width:100%; }
  .visual-stage.overlay .visual-pane.actual { position:absolute; inset:0 0 auto 0; clip-path:inset(0 calc(100% - var(--reveal)) 0 0); border-color:var(--sf-accent); }
  .visual-stage.overlay .visual-pane.actual figcaption { visibility:hidden; }
  .visual-stage.overlay .visual-pane.diff { display:none; }
  .visual-stage.diff { display:block; }
  .visual-stage.diff .visual-pane.expected, .visual-stage.diff .visual-pane.actual { display:none; }
  .visual-stage.diff .visual-pane.diff { display:block; }
  .overlay-control { display:none; grid-column:1 / -1; gap:.25rem; color:var(--sf-dim); font-size:.72rem; }
  .visual-stage.overlay .overlay-control { display:grid; position:relative; margin-top:.55rem; }
  .visual-unavailable { display:grid; place-items:center; align-content:center; gap:.45rem; height:16rem; color:var(--sf-dim); border:1px dashed var(--sf-border-color); }
  .candidate-table { margin-top:.65rem; }
  .candidate-table table { min-width:36rem; }
  .server-card ul { margin:.5rem 0; padding-left:1.15rem; color:var(--sf-dim); font-size:.75rem; }
  .compact-form { margin:.75rem 0; }
  .inline-form { display:flex; gap:.65rem; align-items:end; margin:.8rem 0; }
  .inline-form .field { min-width:18rem; }
  @media(max-width:850px) {
    .assurance-header { display:grid; }
    .assurance-summary, .assurance-facts { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .visual-stage { grid-template-columns:1fr; }
  }
  .composition-map { display: flex; align-items: center; gap: .45rem; flex-wrap: wrap; margin-top: 1rem; padding: .75rem; border-radius: var(--sf-radius); background: var(--sf-accent-quiet); }
  .composition-map strong { width: 100%; }
  .composition-map span { display: inline-flex; align-items: center; gap: .3rem; border: var(--sf-border); border-radius: var(--sf-radius); padding: .3rem .55rem; background: var(--vscode-editor-background); }
  .composition-map i { display: inline-flex; color: var(--sf-dim); font-style: normal; }
  .pack-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .55rem; }
  .pack-meta span { display: grid; gap: .2rem; padding: .65rem; border: var(--sf-border); border-radius: var(--sf-radius); }
  .pack-preview { max-height: 32rem; overflow: auto; white-space: pre-wrap; padding: .9rem; border-radius: var(--sf-radius); background: var(--vscode-textCodeBlock-background); font-family: var(--vscode-editor-font-family); font-size: .8rem; }
  /* Help Center: the manual is large, so navigation stays visible while the selected topic scrolls.
     Search can expand several matching topics without making the left rail jump around. */
  .help-header { position: sticky; top: 0; z-index: 3; padding: .4rem 0 1rem; background: var(--vscode-editor-background); border-bottom: 2px solid var(--sf-accent); }
  .help-header h1 { margin-top: .15rem; }
  .help-search { width: 100%; margin-top: .8rem; padding: .65rem .8rem; border: var(--sf-border); border-radius: var(--sf-radius); color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
  .help-question-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:.55rem; align-items:end; }
  .help-question-form .help-search { margin-top:.8rem; }
  .help-question-examples, .help-answer-choices { display:flex; flex-wrap:wrap; gap:.35rem .65rem; margin-top:.65rem; }
  .help-question-examples button.link { padding:0; font-size:.82rem; }
  .help-answer { margin:1rem 0 1.25rem; padding:1rem 1.15rem; border:var(--sf-border); border-left:3px solid var(--sf-accent); border-radius:var(--sf-radius); background:var(--sf-surface); }
  .help-answer.empty-answer { color:var(--sf-dim); border-left-color:var(--sf-dim); }
  .help-answer.wait { border-left-color:var(--sf-wait); }
  .help-answer.bad { border-left-color:var(--sf-bad); }
  .help-answer h2 { margin:.2rem 0 .55rem; color:var(--vscode-foreground); font-size:1.2rem; text-transform:none; letter-spacing:0; }
  .help-answer-body { max-height:38vh; overflow:auto; padding:.15rem .35rem .15rem 0; }
  .help-citation { color:var(--sf-dim); font-size:.82rem; }
  .help-filter-label { display:grid; color:var(--sf-dim); font-size:.78rem; margin-bottom:1rem; }
  .help-metrics { margin-top:1rem; padding-top:.75rem; border-top:var(--sf-border); }
  .help-layout { display: grid; grid-template-columns: minmax(13rem, .52fr) minmax(0, 1.7fr); gap: 1.25rem; align-items: start; }
  .help-nav { position: sticky; top: 9.5rem; max-height: calc(100vh - 11rem); overflow: auto; padding-right: .35rem; }
  .help-shortcuts, .help-all-topics { display: grid; gap: .3rem; }
  button.help-topic { display: grid; justify-content: stretch; width: 100%; gap: .12rem; padding: .55rem .65rem; text-align: left; border: var(--sf-border); border-radius: 6px; background: transparent; color: var(--vscode-foreground); }
  button.help-topic:hover, button.help-topic.selected { border-color: var(--sf-accent); background: var(--sf-accent-quiet); }
  .help-topic small { color: var(--sf-dim); font-weight: 400; }
  .help-content { min-width: 0; }
  .help-article { display: none; padding-bottom: 3rem; }
  .help-article.selected, .help-article.search-match { display: block; }
  .help-article > h1 { font-size: 1.6rem; border-bottom: var(--sf-border); padding-bottom: .65rem; }
  .help-article h3 { margin-top: 1.4rem; }
  .help-article h4 { margin: 1.1rem 0 .35rem; }
  .help-article ul, .help-article ol { padding-left: 1.4rem; }
  .help-article li { margin: .3rem 0; }
  .help-code { position: relative; margin: .7rem 0; }
  .help-code pre { overflow: auto; padding: .9rem; padding-right: 4.6rem; border-radius: var(--sf-radius); background: var(--vscode-textCodeBlock-background); }
  .help-code .copy-code { position: absolute; top: .45rem; right: .45rem; padding: .22rem .65rem; font-size: .72rem; }
  .help-table-wrap { overflow-x: auto; }
  .help-link { color: var(--sf-link); cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
  }
  @media (forced-colors: active) {
    .card, .summary-card, .editor-card, .decision-card, .workflow-summary { box-shadow: none; }
    button, .pill, .choice, .icon-button { border-color: CanvasText; }
  }
  .help-no-results { margin-top: 2rem; padding: 1rem; border: var(--sf-border); border-radius: var(--sf-radius); }
  input:disabled, select:disabled { opacity: .7; }
  @media (max-width: 820px) {
    .artifact-studio { grid-template-columns: 1fr; }
    .instruction-studio { grid-template-columns: 1fr; }
    .instruction-library { position: static; max-height: 22rem; }
    .remote-row, .mapping-row { grid-template-columns: 1fr; }
    .mapping-arrow { display: none; }
    .document-preview { position: static; }
    .workflow-rail { align-items: stretch; }
    .start-wizard-rail { grid-template-columns: 1fr; gap: .65rem; }
    .start-wizard-step::after { top: 1.65rem; bottom: -.65rem; left: .82rem; right: auto; width: 1px; height: auto; }
    .start-wizard-step.done::after { width: 2px; height: auto; }
    .section-actions { flex-direction: column; }
    .help-layout { grid-template-columns: 1fr; }
    /* Stacked, the topic list sits above the article rather than beside it, so a fixed height makes
       a nested scroll region inside a scrolling page: six of the nine topics end up behind an edge,
       the row at that edge is sliced through the middle, and nothing indicates there is more. It
       reads as a broken list rather than a scrollable one. Sized to its content instead, with the
       shortcuts laid out as a grid so showing all of them costs width rather than height. */
    .help-nav { position: static; max-height: none; overflow: visible; }
    .help-shortcuts, .help-all-topics { grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); }
    .help-header { position: static; }
  }
`;

/** Wrap a rendered body in the document shell, with the CSP and nonce already applied. */
/**
 * Where else to go from here.
 *
 * Nineteen of the twenty-one full-page views ended with their own content and nothing else: no way
 * onward, no way back, and in an editor tab there is no browser chrome to fall back on. This is one
 * footer, so every page offers the same handful of destinations in the same place.
 *
 * `current` is the page drawing the footer; it is rendered as plain text rather than a button, so a
 * reader can see where they are without being offered a link to it.
 */
export const NAV_DESTINATIONS = Object.freeze({
  journey: 'Journey',
  approvals: 'Approvals',
  configuration: 'Configuration',
  doctor: 'Diagnostics',
  journal: 'Local Journal',
  help: 'Help'
});

export type NavDestination = keyof typeof NAV_DESTINATIONS;

/**
 * What each footer destination means.
 *
 * Exported as data rather than executed here: this module is deliberately free of a runtime `vscode`
 * import so the visual fixtures can render a page without the editor. Panels do the dispatch.
 */
export const NAV_COMMANDS: Readonly<Record<NavDestination, string>> = Object.freeze({
  journey: 'singularityFlow.openJourney',
  approvals: 'singularityFlow.openApprovals',
  configuration: 'singularityFlow.openConfigurationCenter',
  doctor: 'singularityFlow.openDiagnostics',
  journal: 'singularityFlow.openJournal',
  help: 'singularityFlow.openHelp'
});

/** The command a `navigate` message asks for, or null when the message is not one. */
export function navigationTarget(raw: unknown): string | null {
  const message = raw as { type?: unknown; to?: unknown };
  if (message?.type !== 'navigate' || typeof message.to !== 'string') return null;
  return Object.hasOwn(NAV_COMMANDS, message.to) ? NAV_COMMANDS[message.to as NavDestination] : null;
}

/** Choosing a workspace is what makes the late-registered destinations exist. */
export const NAV_RESOLVE_COMMAND = 'singularityFlow.openWorkspaces';

export type NavigationPlan =
  | { kind: 'execute'; command: string }
  | { kind: 'unavailable'; message: string; action: string; resolve: string };

/**
 * What to do about a destination, given what is registered right now.
 *
 * Journey, Approvals and Configuration are registered only once a governed repository resolves.
 * Help and Diagnostics are registered before that and can both be opened with no workspace selected,
 * so their footers can offer a destination that does not exist yet — and executing an unregistered
 * command raises VS Code's raw "command 'x' not found", which is the same dead control this footer
 * was added to remove.
 *
 * The decision is separated from the doing so it can be tested without an extension host: `vscode`
 * is an ESM import in navigate.ts, and the CommonJS substitution the host tests use does not reach
 * it. Keeping the judgement here leaves that module a four-line adapter.
 */
export function navigationPlan(command: string, available: readonly string[]): NavigationPlan {
  if (available.includes(command)) return { kind: 'execute', command };
  return {
    kind: 'unavailable',
    message: 'That view needs a governed repository. Choose a workspace and it will be available.',
    action: 'Choose a workspace',
    resolve: NAV_RESOLVE_COMMAND
  };
}

export function footerNav(current: NavDestination | null = null): string {
  const links = (Object.entries(NAV_DESTINATIONS) as Array<[NavDestination, string]>)
    .map(([id, label]) => (id === current
      ? `<span class="nav-current" aria-current="page">${escape(label)}</span>`
      : `<button class="link" type="button" data-nav="${id}">${escape(label)}</button>`))
    .join('');
  return `<nav class="page-nav" aria-label="Singularity Flow views">${links}</nav>`;
}

/**
 * The click handler the footer needs.
 *
 * Emitted in its own script element after a page's own script. Keeping it separate is deliberate:
 * a runtime error in a screen-specific widget must not disconnect the shared navigation controls.
 */
export const NAV_SCRIPT = `
  document.addEventListener('click', (event) => {
    const target = event.target.closest('.page-nav [data-nav]');
    if (target) window.__sfVscode.postMessage({ type: 'navigate', to: target.dataset.nav });
  });
`;

/** Acquire VS Code's single-use webview API once, before page and shared navigation scripts. */
export const VSCODE_API_SCRIPT = `
  window.__sfVscode ??= acquireVsCodeApi();
`;

/**
 * Compose a full-page view.
 *
 * The footer is added here rather than by each page, because the defect it fixes was every page
 * having to remember. Nineteen of twenty-one views ended with their own content and no way onward,
 * and an editor tab has no browser chrome to fall back on — so "remember to add navigation" was
 * exactly the instruction that did not scale. Now a page cannot be built without it.
 *
 * `nav` names the destination this page *is*, so it renders as text rather than a link to itself.
 * Pages that are not one of the five destinations pass nothing and get all five as links.
 * `nav: false` is the deliberate opt-out, for a page with no editor to navigate — the offline
 * visual fixtures, where a dead button would be misleading.
 */
export function page(
  title: string,
  body: string,
  csp: string,
  token: string,
  script = '',
  { nav = null }: { nav?: NavDestination | null | false } = {}
): string {
  const footer = nav === false ? '' : footerNav(nav);
  const scripts = (script || nav !== false)
    ? [VSCODE_API_SCRIPT, script, nav === false ? '' : NAV_SCRIPT]
      .filter((source) => source.trim().length > 0)
      .map((source) => `<script nonce="${token}">${source}</script>`)
      .join('\n')
    : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escape(title)}</title>
<style nonce="${token}">${STYLE}${WORKFLOW_GRAPH_STYLES}</style>
</head><body>
${body}
${footer}
${scripts}
</body></html>`;
}

/**
 * The product lockup: the mark, then the wordmark.
 *
 * One helper because there were fourteen inline copies and four different casings of the same two
 * words — `SINGULARITY FLOW`, `SINGULARITY Flow`, `Singularity Flow`, and a bare `Flow`. The brand
 * lockup settles it: small-caps SINGULARITY above a full-weight Flow.
 *
 * The mark is drawn in `currentColor` rather than the brand gradient. `media/lockup.svg` carries the
 * gradient on its own dark card, which is right for a README and wrong inside an editor that may be
 * in a light or high-contrast theme — a dark plate would sit in the header like a sticker. The
 * geometry is the same curve; only the paint defers to the theme.
 */
export function brandLockup({ compact = false } = {}): string {
  return `<div class="brand-lockup">${brandMark(compact ? 16 : 20)}<span class="brand-words">SINGULARITY <span>Flow</span></span></div>`;
}

/**
 * The mark in the brand's own green, for the one place that is product chrome rather than document
 * content: the sidebar header.
 *
 * `brandMark` defers to `currentColor` because it sits inside prose whose colour the theme owns.
 * This is the logo, in the gradient the brand assets use — the same three stops as
 * `media/brand.svg`. The gradient id is suffixed per call: two of these in one document with the
 * same id would leave the second referring to the first's definition, and a mark that renders in a
 * sibling's colour is the kind of bug nobody thinks to look for.
 */
export function brandSymbol(size = 30, id = 'sf-brand-flow'): string {
  return `<svg class="brand-symbol" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    role="img" aria-label="Singularity Flow" stroke-linecap="round" stroke-linejoin="round">
    <defs><linearGradient id="${id}" x1="5" y1="20" x2="20" y2="4" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#419458"/><stop offset="0.52" stop-color="#5CAE5F"/><stop offset="1" stop-color="#83CC6D"/>
    </linearGradient></defs>
    <path stroke="url(#${id})" stroke-width="2.1" d="M14.85 4.18C12.18 3.72 11.28 5.34 11.02 8.36L10.48 14.78C10.18 18.32 9.10 20.10 6.82 20.10C6.04 20.10 5.42 19.78 5.02 19.18"/>
    <g stroke="url(#${id})" stroke-width="0.85"><circle cx="17.18" cy="4.28" r="1.08"/><circle cx="19.78" cy="4.28" r="1.08"/><circle cx="12.62" cy="19.78" r="1.42"/></g>
  </svg>`;
}

/** The mark alone, at whatever size the surface needs. */
export function brandMark(size = 20): string {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true"
    stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <path stroke-width="2.1" d="M14.85 4.18C12.18 3.72 11.28 5.34 11.02 8.36L10.48 14.78C10.18 18.32 9.10 20.10 6.82 20.10C6.04 20.10 5.42 19.78 5.02 19.18"/>
    <g stroke-width="0.85"><circle cx="17.18" cy="4.28" r="1.08"/><circle cx="19.78" cy="4.28" r="1.08"/><circle cx="12.62" cy="19.78" r="1.42"/></g>
  </svg>`;
}
