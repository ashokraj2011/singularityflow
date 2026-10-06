/**
 * Quiet workspace styling shared by editor pages and the navigation sidebar.
 * Neutral surfaces, regular sans-serif labels and restrained sage state cues keep the product
 * coherent. The existing brand mark and its colours are deliberately independent of this palette.
 * High contrast keeps the editor's own colours. No setting changes VS Code's theme outside a webview.
 */
/** The same escaping as webview.ts, kept local so the stylesheet module has no import cycle. */
function escape(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const CALM_PALETTE_STYLE = `
  :root {
    --sf-font-mono: var(--vscode-editor-font-family, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace);
    --sf-font-sans: var(--vscode-font-family, system-ui, sans-serif);
    --sf-radius: 8px;
    --sf-bg: var(--vscode-editor-background);
    --sf-sidebar: var(--vscode-sideBar-background, var(--sf-bg));
    --sf-text: var(--vscode-foreground);
    --sf-surface-sunken: var(--vscode-input-background, var(--sf-surface));
    --sf-border-strong: var(--vscode-input-border, var(--sf-border-color));
    --sf-faint: var(--vscode-disabledForeground, var(--sf-dim));
    --sf-accent-strong: var(--sf-accent);
    --sf-accent-line: color-mix(in srgb, var(--sf-accent) 55%, transparent);
    --sf-glow: 0 0 0 1px var(--sf-accent-line);
    --sf-brand: #3d8e10;
  }
  body.vscode-light {
    --sf-bg: #f7f8f9; --sf-sidebar: #f0f2f4; --sf-surface: #ffffff; --sf-surface-raised: #e8ecef; --sf-surface-sunken: #ffffff;
    --sf-border-color: #dfe4e8; --sf-border-strong: #bcc6cf; --sf-border: 1px solid var(--sf-border-color);
    --sf-text: #26313b; --sf-dim: #61707e; --sf-faint: #697785;
    --sf-accent: #426d58; --sf-accent-strong: #426d58; --sf-accent-hover: #365c49;
    --sf-accent-quiet: rgba(66, 109, 88, .08); --sf-accent-line: rgba(66, 109, 88, .4);
    --sf-glow: 0 0 0 1px var(--sf-accent-line);
    --sf-on-accent: #ffffff; --sf-ok: #426d58; --sf-shadow: none;
    --sf-link: #426d58; --sf-wait: #8b620d; --sf-bad: #b83b43;
  }
  body.vscode-dark {
    --sf-bg: #1c2024; --sf-sidebar: #191d21; --sf-surface: #22272c; --sf-surface-raised: #2a3036; --sf-surface-sunken: #22272c;
    --sf-border-color: #30373e; --sf-border-strong: #46515d; --sf-border: 1px solid var(--sf-border-color);
    --sf-text: #d4dbe1; --sf-dim: #9da8b3; --sf-faint: #8995a1;
    --sf-accent: #8fae9f; --sf-accent-strong: #8fae9f; --sf-accent-hover: #a1bdae;
    --sf-accent-quiet: rgba(143, 174, 159, .1); --sf-accent-line: rgba(143, 174, 159, .4);
    --sf-glow: 0 0 0 1px var(--sf-accent-line);
    --sf-on-accent: #18221d; --sf-link: #a5c3b4; --sf-shadow: none;
    --sf-ok: #8fae9f; --sf-wait: #d5b775; --sf-bad: #eb969c;
  }
  body.vscode-high-contrast, body.vscode-high-contrast-light {
    --sf-bg: var(--vscode-editor-background); --sf-surface: var(--vscode-editor-background);
    --sf-surface-raised: var(--vscode-editor-background); --sf-surface-sunken: var(--vscode-input-background);
    --sf-border-color: var(--vscode-contrastBorder, CanvasText); --sf-border-strong: var(--vscode-contrastBorder, CanvasText);
    --sf-sidebar: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --sf-text: var(--vscode-foreground); --sf-dim: var(--vscode-descriptionForeground, CanvasText);
    --sf-accent: var(--vscode-focusBorder, Highlight); --sf-accent-strong: var(--sf-accent);
    --sf-on-accent: var(--vscode-button-foreground, HighlightText);
    --sf-accent-quiet: var(--vscode-list-hoverBackground, Canvas);
    --sf-accent-hover: var(--vscode-button-hoverBackground, Highlight);
    --sf-faint: var(--vscode-disabledForeground, GrayText);
    --sf-link: var(--vscode-textLink-foreground, LinkText);
    --sf-accent-line: var(--vscode-contrastActiveBorder, Highlight); --sf-glow: 0 0 0 1px var(--vscode-contrastActiveBorder, Highlight);
    --sf-shadow: none;
  }
`;

export const THEME_STYLE = `${CALM_PALETTE_STYLE}

  /* Screens with their own stylesheet (result cards, Workflow Studio, the review and explorer pages)
     read VS Code's variables directly. Inside a themed page those variables are the theme's, so every
     screen lands on the same surfaces, hairlines and muted accent; high contrast keeps VS Code's own. */
  body.vscode-dark, body.vscode-light {
    --vscode-editor-background: var(--sf-bg);
    --vscode-editorWidget-background: var(--sf-surface); --vscode-editorWidget-border: var(--sf-border-color);
    --vscode-sideBar-background: var(--sf-surface-raised); --vscode-panel-background: var(--sf-surface);
    --vscode-panel-border: var(--sf-border-color); --vscode-widget-border: var(--sf-border-color);
    --vscode-input-background: var(--sf-surface-sunken); --vscode-input-border: var(--sf-border-strong);
    --vscode-input-foreground: var(--sf-text); --vscode-dropdown-foreground: var(--sf-text);
    --vscode-dropdown-background: var(--sf-surface-sunken); --vscode-dropdown-border: var(--sf-border-strong);
    --vscode-textCodeBlock-background: var(--sf-surface-sunken); --vscode-textPreformat-background: var(--sf-surface-raised);
    --vscode-textBlockQuote-background: var(--sf-surface-raised); --vscode-textBlockQuote-border: var(--sf-accent-line);
    --vscode-button-background: var(--sf-accent); --vscode-button-foreground: var(--sf-on-accent);
    --vscode-button-hoverBackground: var(--sf-accent-hover);
    --vscode-button-secondaryBackground: var(--sf-surface-raised); --vscode-button-secondaryForeground: var(--sf-text);
    --vscode-button-secondaryHoverBackground: var(--sf-accent-quiet);
    --vscode-list-hoverBackground: var(--sf-accent-quiet); --vscode-focusBorder: var(--sf-accent);
    --vscode-foreground: var(--sf-text); --vscode-descriptionForeground: var(--sf-dim);
    --vscode-badge-background: var(--sf-accent); --vscode-badge-foreground: var(--sf-on-accent);
    --vscode-testing-iconPassed: var(--sf-accent); --vscode-charts-green: var(--sf-accent);
  }

  body { background: var(--sf-bg); color: var(--sf-text); }
  .sf-result-nav button, .sf-result-nav span { font-family: var(--sf-font-sans); font-size: .85rem; letter-spacing: normal; text-transform: none; }
  body .sf-result-nav button { border-radius: var(--sf-radius); }
  .page-nav .link { color: var(--sf-dim); text-decoration: none; }
  .page-nav .link:hover, .page-nav .link:focus-visible { color: var(--sf-text); }
  ::selection { background: color-mix(in srgb, var(--sf-accent) 28%, transparent); }
  h1 { font-family: var(--sf-font-sans); font-size: 1.8rem; font-weight: 500; letter-spacing: -.025em; text-transform: none; }
  h2 { font-family: var(--sf-font-sans); font-size: 1.05rem; font-weight: 500; letter-spacing: normal; text-transform: none; color: var(--sf-text); }
  h3 { font-family: var(--sf-font-sans); font-weight: 500; letter-spacing: normal; }
  h1 .ico, h2 .ico, h3 .ico { color: var(--sf-dim); }
  .meta, .muted, .question { color: var(--sf-dim); }
  .eyebrow { font-family: var(--sf-font-sans); color: var(--sf-dim); font-weight: 400; letter-spacing: normal; text-transform: none; }
  .brand-lockup { font-family: var(--sf-font-mono); color: var(--sf-brand); }
  .inbox-header { border-bottom: 1px solid var(--sf-border-color); }
  section { border-top: 1px solid var(--sf-border-color); }
  a, button.link { color: var(--sf-link); }

  /* Panels and cards: one hairline, no drop shadow; state is the border, not the background. */
  .card, .summary-card, .decision-card, .phase-detail, .capability-dashboard, .approval-summary li,
  .return-phases details, button.artifact-card, button.active-story-card, button.home-choice,
  button.capability-root-card, button.configuration-card, button.template-tile, button.evidence-source {
    background: var(--sf-surface); border-color: var(--sf-border-color); border-radius: var(--sf-radius); box-shadow: none;
  }
  button.artifact-card:hover, button.active-story-card:hover:not(:disabled), button.home-choice:hover,
  button.capability-root-card:hover, button.template-tile:hover, button.evidence-source:hover:not(:disabled) {
    border-color: var(--sf-accent-line); background: var(--sf-surface-raised);
  }
  .summary-card strong, .count-badge, .choice-number { font-family: var(--sf-font-sans); }
  .summary-card, .summary-card > * { min-width: 0; }
  /* In a narrow split the phase rail's state lines wrap inside their own phase instead of running into the next. */
  .phase-state { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
  td .pill { white-space: normal; overflow-wrap: anywhere; text-align: left; }
  .summary-card strong, .lifecycle-kpis .summary-card strong, .governance-kpis .summary-card strong, .wm-summary .summary-card strong {
    color: var(--sf-text); font-size: 1.2rem; line-height: 1.2; overflow-wrap: break-word; }
  .summary-card.governance-warning strong, .governance-kpis .summary-card.governance-warning strong { color: var(--sf-wait); }
  .summary-card span { font-family: var(--sf-font-sans); text-transform: none; letter-spacing: normal; font-size: .85rem; }
  .count-badge { border-radius: 2px; border: 1px solid var(--sf-accent-line); }

  /* Tables use readable labels and restrained row separators; code retains monospace. */
  th { font-family: var(--sf-font-sans); font-size: .85rem; letter-spacing: normal; text-transform: none; color: var(--sf-dim); border-bottom-color: var(--sf-border-strong); }
  td { border-bottom-color: var(--sf-border-color); }
  code, kbd { font-family: var(--sf-font-mono); color: var(--sf-text); background: var(--sf-surface-raised);
    border: 1px solid var(--sf-border-color); border-radius: 2px; }
  .terminal-command, .source-preview { background: var(--sf-surface-sunken); border: 1px solid var(--sf-border-color); font-family: var(--sf-font-mono); }

  /* Controls share one compact rhythm; card/row navigation keeps its own layout. */
  button { border-radius: var(--sf-radius); font-weight: 500; letter-spacing: normal; }
  .card-foot, .form-actions, .actions, .button-row, .confirmation-actions {
    display: flex; flex-wrap: wrap; align-items: center; gap: .6rem;
  }
  .card-foot > button, .form-actions > button, .actions > button, .button-row > button, .confirmation-actions > button {
    margin: 0; min-height: 2.25rem; padding: .4rem .85rem;
  }
  strong, b, .artifact-title, .active-story-title, .phase-name { font-weight: 500; }
  .configuration-shell { grid-template-columns: 13rem minmax(0, 1fr); gap: 2rem; }
  .configuration-nav-group h2 { font-size: .85rem; font-weight: 400; letter-spacing: normal; text-transform: none; }
  button.configuration-nav-item { color: var(--sf-dim); font-weight: 400; }
  button.configuration-nav-item.active { color: var(--sf-text); font-weight: 500; }
  .configuration-action-row > .ico:first-child { color: var(--sf-dim); }
  .configuration-caption { font-size: .85rem; margin-top: .6rem; }
  .summary-card { border-color: transparent; padding: 1rem; }
  .summary-card.important { border-color: var(--sf-accent-line); }
  body.vscode-high-contrast .summary-card, body.vscode-high-contrast-light .summary-card { border-color: var(--sf-border-color); }
  @media (max-width: 900px) { .configuration-shell { grid-template-columns: minmax(0, 1fr); gap: 1.25rem; } }
  button.secondary { background: transparent; color: var(--sf-text); border-color: var(--sf-border-strong); }
  button.secondary:hover:not(:disabled) { background: var(--sf-accent-quiet); border-color: var(--sf-accent-line); }
  /* A filled button that cannot act yet is grey, not a dim green that still reads as the next step. */
  button:disabled:not(.secondary):not(.link):not(.tab):not(.icon-button) { background: var(--sf-surface-raised); color: var(--sf-faint);
    border: 1px solid var(--sf-border-color); box-shadow: none; opacity: 1; }
  button.tab { font-family: var(--sf-font-sans); text-transform: none; letter-spacing: normal; font-size: .85rem; }
  button.tab.active { color: var(--sf-accent-strong); border-bottom-color: var(--sf-accent); }
  /* A row of views is navigation, not a row of actions: tabs, never filled buttons. */
  .tabs > button { min-height: 2.1rem; padding: .4rem .8rem; color: var(--sf-dim); background: transparent; border: 0;
    border-bottom: 2px solid transparent; border-radius: 0; box-shadow: none; font-family: var(--sf-font-sans); font-size: .85rem;
    font-weight: 500; letter-spacing: normal; text-transform: none; }
  .tabs > button:hover:not(:disabled) { color: var(--sf-text); background: var(--sf-accent-quiet); box-shadow: none; }
  .tabs > button.active, .tabs > button[aria-selected="true"] { color: var(--sf-accent-strong); background: transparent; border-bottom-color: var(--sf-accent); }
  input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="date"], input[type="url"],
  input[type="email"], input[type="password"], input[type="time"], select, textarea {
    background: var(--sf-surface-sunken); color: var(--sf-text); border: 1px solid var(--sf-border-strong); border-radius: var(--sf-radius);
  }
  input:not([type]):focus, input[type="text"]:focus, input[type="search"]:focus, input[type="number"]:focus, input[type="date"]:focus,
  input[type="url"]:focus, select:focus, textarea:focus { border-color: var(--sf-accent); box-shadow: var(--sf-glow); outline: none; }
  input.mono, textarea.mono { font-family: var(--sf-font-mono); }
  input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--vscode-focusBorder, var(--sf-accent)); outline-offset: 2px; }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--sf-accent); }

  /* Status pills use a restrained outline and a semantic colour. */
  .pill { font-family: var(--sf-font-sans); font-size: .85rem; font-weight: 500; letter-spacing: normal; text-transform: none;
    border: 1px solid var(--sf-border-strong); border-radius: 2px; }
  .pill.ok { color: var(--sf-accent-strong); border-color: var(--sf-accent-line); background: var(--sf-accent-quiet); }
  .pill.wait { border-color: color-mix(in srgb, var(--sf-wait) 55%, transparent); }
  .pill.bad { border-color: color-mix(in srgb, var(--sf-bad) 55%, transparent); }

  /* Choices use a radio, a readable title, a reason and a subtle selected surface. */
  .choices { gap: .75rem; }
  .choice { position: relative; padding: 1rem 1.1rem; border: 1px solid var(--sf-border-color); border-radius: var(--sf-radius);
    background: var(--sf-surface); column-gap: .85rem; transition: border-color .15s ease, box-shadow .15s ease; }
  .choice:hover { border-color: var(--sf-accent-line); }
  .choice.chosen { border-color: var(--sf-accent-line); box-shadow: none; background: var(--sf-accent-quiet); }
  .choice input[type="radio"] { appearance: none; width: 1rem; height: 1rem; margin: .2rem 0 0; border: 1.5px solid var(--sf-faint);
    border-radius: 50%; background: transparent; cursor: pointer; }
  .choice input[type="radio"]:checked { border-color: var(--sf-accent); background: radial-gradient(var(--sf-accent) 0 42%, transparent 48%); }
  .choice-label { display: flex; align-items: center; flex-wrap: wrap; gap: .55rem; font-family: var(--sf-font-sans); font-weight: 500; color: var(--sf-text); }
  .choice-label .ico { color: var(--sf-accent); }
  .choice-detail { line-height: 1.55; }
  /* A radio card is a grid, never a flex row: in a row the radio is the item that gives up width, and
     turns into an oval. Radio, then title and tag; the reason beneath; a footer across the card. */
  .choice > input { flex: none; }
  .choices > .choice:not(.workflow-choice):has(> input[type="radio"]) { display: grid; grid-template-columns: 1rem minmax(0, 1fr);
    align-items: start; gap: .5rem .85rem; }
  .choice > input[type="radio"] { grid-column: 1; grid-row: 1; box-sizing: border-box; width: 1rem; min-width: 1rem; height: 1rem;
    aspect-ratio: 1; margin: .2rem 0 0; }
  .choice > .choice-label { grid-column: 2; display: flex; align-items: center; flex-wrap: wrap; gap: .45rem .6rem; min-width: 0; }
  .choice > .choice-detail { grid-column: 2; display: block; }
  .choice .sf-tag { display: inline-flex; }
  .choice.sf-tracker > .choice-detail { grid-column: 1 / -1; }
  .choice.sf-tracker > .choice-label .sf-title { flex: 1 1 auto; }
  .choice.sf-tracker.chosen > .choice-label::after { content: ""; flex: none; width: .45rem; height: .45rem; border-radius: 50%;
    background: var(--sf-accent); }

  /* The pieces the product's screens share. */
  .field > span:first-child:not(.hint) { font-family: var(--sf-font-sans); font-size: .85rem; font-weight: 500; letter-spacing: normal; text-transform: none;
    color: var(--sf-text); }
  .field > span:first-child:not(.hint) small { font-weight: 500; color: var(--sf-faint); }
  .field-info::after { font-family: var(--vscode-font-family); font-weight: 400; letter-spacing: normal; text-transform: none; }
  .sf-field-row { display: grid; grid-template-columns: minmax(10rem, 1fr) minmax(14rem, 2fr); gap: 1rem; margin: .25rem 0 1.1rem; }
  .sf-field-row:has(> .field:only-child) { grid-template-columns: minmax(0, 1fr); }
  .sf-field-stack { display: grid; gap: 1.1rem; margin: 0 0 1.1rem; }
  .field textarea { font-family: var(--sf-font-sans); font-size: .86rem; line-height: 1.55; }
  .story-description-editor { width: 100%; margin-bottom: 1.1rem; }
  @media (max-width: 640px) { .sf-field-row { grid-template-columns: minmax(0, 1fr); } }
  .sf-hero { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.1rem; align-items: center; margin: 1.7rem 0 1.2rem; }
  .sf-hero h1 { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; margin: 0; }
  .sf-hero p { margin: .35rem 0 0; color: var(--sf-dim); }
  .sf-logo-box { display: grid; place-items: center; min-width: 4.4rem; min-height: 3.4rem; padding: .55rem .75rem;
    font-family: var(--sf-font-sans); font-size: 1.15rem; font-weight: 500; color: var(--sf-accent-strong);
    border: 1px solid var(--sf-accent-line); border-radius: var(--sf-radius); background: var(--sf-accent-quiet); box-shadow: var(--sf-glow); }
  .sf-tag { display: inline-flex; align-items: center; gap: .3rem; padding: .08rem .45rem; font-family: var(--sf-font-sans); font-size: .85rem;
    font-weight: 500; letter-spacing: normal; color: var(--sf-dim); border: 1px solid var(--sf-border-strong); border-radius: 2px;
    background: var(--sf-surface-raised); white-space: nowrap; }
  .sf-tag.accent { color: var(--sf-accent-strong); border-color: var(--sf-accent-line); background: var(--sf-accent-quiet); }
  .sf-tag.status { font-size: .85rem; font-weight: 500; letter-spacing: .1em; text-transform: none; }
  .sf-ribbon { position: absolute; top: -1px; right: 1rem; padding: .18rem .55rem; font-family: var(--sf-font-sans); font-size: .85rem;
    font-weight: 500; letter-spacing: .1em; color: var(--sf-on-accent); background: var(--sf-accent); border-radius: 0 0 3px 3px; }
  .sf-step { display: inline-grid; place-items: center; min-width: 1.55rem; height: 1.3rem; margin-right: .6rem; padding: 0 .25rem;
    font-family: var(--sf-font-sans); font-size: .85rem; font-weight: 500; color: var(--sf-accent-strong);
    border: 1px solid var(--sf-accent-line); border-radius: 2px; background: var(--sf-accent-quiet); }
  .sf-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(24rem, 100%), 1fr)); gap: 1.25rem; align-items: stretch; margin: 1.25rem 0; }
  .sf-panel { min-width: 0; padding: 1.25rem 1.35rem 1.4rem; border: 1px solid var(--sf-border-color); border-radius: var(--sf-radius); background: var(--sf-surface); }
  section.sf-panel { border-top: 1px solid var(--sf-border-color); margin: 1.25rem 0; }
  .sf-panels > .sf-panel { margin: 0; }
  .sf-panel > h2:first-child, .sf-panel-head h2 { margin-top: 0; }
  .sf-panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding-bottom: .85rem; margin-bottom: 1rem; border-bottom: 1px solid var(--sf-border-color); }
  .sf-panel-head h2 { margin-bottom: 0; }
  .sf-panel-head .sf-format { font-family: var(--sf-font-sans); font-size: .85rem; letter-spacing: normal; text-transform: none; color: var(--sf-faint); }
  .sf-lede { margin: -.15rem 0 1rem; color: var(--sf-dim); line-height: 1.5; }
  .sf-kv { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem 1.4rem; margin: 0 0 .9rem; padding: .7rem 1rem;
    border: 1px solid var(--sf-border-color); border-radius: var(--sf-radius); background: var(--sf-surface); font-family: var(--sf-font-sans); font-size: .85rem; }
  .sf-kv div { display: inline-flex; align-items: center; gap: .5rem; min-width: 0; }
  .sf-kv dt { color: var(--sf-faint); letter-spacing: normal; text-transform: none; }
  .sf-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--sf-text); }
  .sf-kv dd.chip { padding: .12rem .5rem; border: 1px solid var(--sf-border-strong); border-radius: 2px; background: var(--sf-surface-raised); }
  .sf-kv dd.chip.accent { color: var(--sf-accent-strong); border-color: var(--sf-accent-line); background: var(--sf-accent-quiet); }
  .sf-note { display: flex; gap: .6rem; margin: .4rem 0 1.4rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--sf-border-color);
    font-family: var(--sf-font-sans); font-size: .85rem; line-height: 1.6; color: var(--sf-dim); }
  .sf-note::before { content: "i"; flex: none; color: var(--sf-accent-strong); font-weight: 500; }
  .choice .sf-card-foot { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 1rem; margin-top: .75rem; padding-top: .7rem;
    border-top: 1px solid var(--sf-border-color); font-family: var(--sf-font-sans); font-size: .85rem; color: var(--sf-faint); }
  .choice.chosen .sf-card-foot span:first-child, .choice.chosen .sf-card-foot span:last-child { color: var(--sf-accent-strong); }
  .page-nav { font-family: var(--sf-font-sans); font-size: .85rem; letter-spacing: normal; border-top: 1px solid var(--sf-border-color); }
  .page-nav .nav-current { color: var(--sf-accent-strong); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: var(--sf-border-strong); border: 2px solid var(--sf-bg); border-radius: 6px; }
  @media (forced-colors: active) {
    .choice.chosen, .sf-logo-box { box-shadow: none; outline: 2px solid Highlight; }
    .sf-ribbon, .sf-step, .sf-tag.accent { forced-color-adjust: auto; border: 1px solid CanvasText; }
  }
  @media (prefers-reduced-motion: reduce) { .choice { transition: none; } }
`;

/** A numbered section title: `01 WHAT SCOPE ARE YOU STARTING?` */
export function stepHeading(step: number, title: string, lede = ''): string {
  return `<h2><span class="sf-step">${String(step).padStart(2, '0')}</span>${escape(title)}</h2>${lede ? `<p class="sf-lede">${escape(lede)}</p>` : ''}`;
}

/** A small mono tag; `accent` for the recommended or active value, `status` for a state word. */
export function tag(text: string, tone: '' | 'accent' | 'status' | 'accent status' = ''): string {
  return `<span class="sf-tag${tone ? ` ${tone}` : ''}">${escape(text)}</span>`;
}

/** The page title: the product mark, the title with its state, and one sentence. */
export function heroHeader({ title, status = '', subtitle = '' }: { title: string; status?: string; subtitle?: string }): string {
  return `<header class="sf-hero"><div class="sf-logo-box" aria-hidden="true">&lt;SF/&gt;</div><div>
    <h1>${escape(title)}${status ? tag(status, 'accent status') : ''}</h1>${subtitle ? `<p>${escape(subtitle)}</p>` : ''}</div></header>`;
}

/** The keys a screen acts on, as a terminal status line: `TARGET_WORKSPACE: [py-sfield]`. */
export function contextStrip(entries: ReadonlyArray<{ key: string; value: string; chip?: boolean; accent?: boolean }>): string {
  const rows = entries.filter((entry) => entry.value).map((entry) => `<div><dt>${escape(entry.key)}:</dt><dd${entry.chip || entry.accent
    ? ` class="chip${entry.accent ? ' accent' : ''}"` : ''}>${escape(entry.value)}</dd></div>`);
  return rows.length ? `<dl class="sf-kv">${rows.join('')}</dl>` : '';
}

/** One line of guidance in the terminal's own voice. */
export function infoNote(text: string): string {
  return `<p class="sf-note">${escape(text)}</p>`;
}
